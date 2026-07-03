// flowEngine.js — Motor de flows con pila de ejecución para concatenar subflows.

const fs       = require('fs')
const path     = require('path')
const axios    = require('axios')
const mustache = require('mustache')

const { SESSION_ID } = require('./state')
const { toJid }   = require('./jidUtils')
const { enqueue } = require('./queue')
const { sendText } = require('./sender')

// Mapas para el mecanismo esperar/respuesta
const esperas    = new Map()   // chatId  → idMensaje
const respuestas = new Map()   // idMensaje → message object normalizado
const resolvers  = new Map()   // idMensaje → [resolve, ...]
const timeouts   = new Map()   // idMensaje → timeoutId

// ─── Pila de flows activos ────────────────────────────────────────────────────
// activeFlows: Map<chatId, ExecutionContext[]>
// Cada entrada es un array que actúa como pila (LIFO).
// Cuando se invoca un subflow se hace push; cuando termina, pop.
// Si la pila queda vacía se elimina la entrada del mapa.
const activeFlows = new Map()

class ExecutionContext {
  constructor({ flowName, flowJson, nodeId, vars, webhook, id }) {
    this.flowName = flowName
    this.flowJson = flowJson
    this.nodeId   = nodeId
    this.vars     = vars
    this.webhook  = webhook
    this.id       = id
  }
}

function getStack(chatId) {
  if (!activeFlows.has(chatId)) activeFlows.set(chatId, [])
  return activeFlows.get(chatId)
}

function currentContext(chatId) {
  const stack = getStack(chatId)
  return stack[stack.length - 1] || null
}

function pushContext(chatId, ctx) {
  getStack(chatId).push(ctx)
}

function popContext(chatId) {
  const stack = getStack(chatId)
  const ctx   = stack.pop()
  if (stack.length === 0) activeFlows.delete(chatId)
  return ctx
}

// ─── Carga de flow desde disco ────────────────────────────────────────────────
function loadFlowByName(flowName) {
  const fileA = path.join(__dirname, 'flows', `${flowName}.json`)
  const fileB = path.join(__dirname, 'flows', flowName)
  let chosen = null
  if (fs.existsSync(fileA)) chosen = fileA
  else if (fs.existsSync(fileB)) chosen = fileB
  else throw new Error('Flow no encontrado: ' + flowName)
  const raw = fs.readFileSync(chosen, 'utf8')
  try { return JSON.parse(raw) } catch (e) { throw new Error('Flow JSON inválido: ' + e.message) }
}

// ─── Espera de respuesta del usuario ─────────────────────────────────────────
async function waitResponse(chatId, sent, timeoutMs = 300000) {
  const idMensaje = sent.id.id

  esperas.set(chatId, idMensaje)
  resolvers.set(idMensaje, [])

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      esperas.delete(chatId)
      resolvers.delete(idMensaje)
      reject(new Error('Timeout esperando respuesta'))
    }, timeoutMs)

    resolvers.get(idMensaje).push((msg) => {
      clearTimeout(timeout)
      resolve(msg?.message || null)
    })
  })
}

// ─── Webhook ──────────────────────────────────────────────────────────────────
async function sendWebhook(webhook, data) {
  if (!webhook) return
  try {
    await axios.post(webhook, { session: SESSION_ID, ...data })
  } catch (e) {
    console.error('[webhook]', e.message)
  }
}

// ─── Resolver espera desde handler de mensajes entrantes ─────────────────────
function resolveIncomingForWait(chatId, numero, norm) {
  const idMensajeEsperado = esperas.get(chatId) || esperas.get(numero)
  if (!idMensajeEsperado) return false

  esperas.delete(chatId)
  esperas.delete(numero)

  const list = resolvers.get(idMensajeEsperado) || []
  respuestas.set(idMensajeEsperado, norm)

  const tid = timeouts.get(idMensajeEsperado)
  if (tid) {
    clearTimeout(tid)
    timeouts.delete(idMensajeEsperado)
  }

  list.forEach(r => r({ message: norm }))
  resolvers.delete(idMensajeEsperado)
  return true
}

// ─── Motor de ejecución de un flow ───────────────────────────────────────────
/**
 * Ejecuta un flow para un chat dado.
 * Soporta anidamiento: si un nodo es de tipo "flow", invoca processFlowForChat
 * recursivamente (push en la pila) y al terminar retoma el flow padre (pop).
 *
 * Las vars se propagan hacia el subflow y los resultados vuelven al padre
 * mediante ctx.vars al hacer pop.
 */
async function processFlowForChat(flowJson, numero, webhook, id, parentVars = {}) {

  const flowName = flowJson.id || 'flow'

  const chatId = numero.includes('@') ? numero : toJid(numero)

  const ctx = new ExecutionContext({
    flowName,
    flowJson,
    nodeId: flowJson.start,
    vars:   { ...parentVars },   // hereda vars del padre (o vacío si es raíz)
    webhook,
    id,
  })

  pushContext(chatId, ctx)

  try {

    while (ctx.nodeId) {

      const node = flowJson.nodes[ctx.nodeId]

      if (!node) throw new Error(`Nodo inexistente: ${ctx.nodeId}`)

      const text = mustache.render(node.template || '', ctx.vars)

      console.log('NODO', ctx.nodeId, node)
      console.log("VARS", ctx.vars)
      // ============================================================
      // MESSAGE
      // ============================================================
      if (node.type === 'message') {

        const sent = await enqueue(() => sendText(chatId, text))

        await sendWebhook(webhook, {
          event: 'outgoing_node', flow: flowName, nodeId: ctx.nodeId,
          id, numero: chatId, messageId: sent.id.id, text, vars: ctx.vars,
        })

        const nextMap = node.next || {}
        ctx.nodeId = nextMap.any || nextMap.default || null
        continue
      }

      // ============================================================
      // INPUT
      // ============================================================
      if (node.type === 'input') {

        const sent = await enqueue(() => sendText(chatId, text))

        await sendWebhook(webhook, {
          event: 'input', flow: flowName, nodeId: ctx.nodeId,
          id, numero: chatId, messageId: sent.id.id, text, vars: ctx.vars,
        })

        const incoming = await waitResponse(chatId, sent)

        if (!incoming) throw new Error(`Timeout esperando respuesta en ${ctx.nodeId}`)

        const value = (incoming.body || '').toString().trim()

        ctx.vars.last_input = value
        if (node.save) ctx.vars[node.save] = value

        await sendWebhook(webhook, {
          event: 'incoming_message', flow: flowName, nodeId: ctx.nodeId,
          id, numero: chatId, message: value, vars: ctx.vars,
        })

        const nextMap = node.next || {}
        ctx.nodeId = nextMap.any || nextMap.default || Object.values(nextMap)[0] || null
        continue
      }

      // ============================================================
      // ROUTER
      // ============================================================
      if (node.type === 'router') {

        const value  = (ctx.vars.last_input || '').toString().trim().toLowerCase()
        const routes = node.routes || {}
        let target   = null

        for (const key of Object.keys(routes)) {
          if (key.toLowerCase() === value) { target = routes[key]; break }
        }

        if (!target) target = node.default || null

        if (!target) throw new Error(`Router sin ruta para "${ctx.vars.last_input}"`)

        ctx.nodeId = target
        continue
      }

      // ============================================================
      // SCRIPT
      // ============================================================
      if (node.type === 'script') {

        let result = { next: 'error' }

        if (node.url) {

          try {
            const resp = await axios.post(node.url, {
              vars: ctx.vars, numero: chatId, flow: flowName, nodeId: ctx.nodeId,
            })
            result = resp.data
          } catch (e) {
            console.error(`[script-url:${node.url}]`, e.message)
          }

        } else if (node.script) {

          try {
            const scriptPath = path.join(__dirname, 'scripts', `${node.script}.js`)
            delete require.cache[require.resolve(scriptPath)]
            const script = require(scriptPath)
            result = await script.run(ctx.vars, chatId)
          } catch (e) {
            console.error(`[script:${node.script}]`, e)
          }

        } else {
          console.warn(`Nodo ${ctx.nodeId} no tiene script ni url`)
        }

        if (result.vars) Object.assign(ctx.vars, result.vars)

        await sendWebhook(webhook, {
          event: 'script_result', flow: flowName, nodeId: ctx.nodeId,
          id, numero: chatId, next: result.next, vars: ctx.vars,
        })

        const nextMap = node.next || {}
        ctx.nodeId = nextMap[result.next] || nextMap.default || null

        if (!ctx.nodeId) throw new Error(`El script devolvió "${result.next}" pero no existe una transición`)

        continue
      }

      // ============================================================
      // FLOW  —  subflow: pausa este flow, ejecuta otro y retoma
      // ============================================================
      if (node.type === 'flow') {

        if (!node.flow) throw new Error(`Nodo ${ctx.nodeId} tipo "flow" sin campo "flow"`)

        const subFlowJson = loadFlowByName(node.flow)

        await sendWebhook(webhook, {
          event: 'subflow_start', flow: flowName, nodeId: ctx.nodeId,
          subflow: node.flow, id, numero: chatId, vars: ctx.vars,
        })

        // Ejecuta el subflow pasando las vars actuales como contexto inicial
        const subResult = await processFlowForChat(
          subFlowJson,
          chatId,
          webhook,
          id,
          ctx.vars,           // el subflow hereda las vars del padre
        )

        // Las vars del subflow vuelven al padre
        if (subResult.vars) Object.assign(ctx.vars, subResult.vars)

        await sendWebhook(webhook, {
          event: 'subflow_end', flow: flowName, nodeId: ctx.nodeId,
          subflow: node.flow, id, numero: chatId, vars: ctx.vars,
        })

        const nextMap = node.next || {}
        ctx.nodeId = nextMap.any || nextMap.default || null
        continue
      }

      // ============================================================
      console.warn(`Tipo de nodo desconocido: ${node.type}`)
      break
    }

    await sendWebhook(webhook, {
      event: 'flow_finished', flow: flowName, id, numero: chatId, vars: ctx.vars,
    })

    return { ok: true, vars: ctx.vars }

  } catch (err) {

    console.error('[FLOW ERROR]', err)

    await sendWebhook(webhook, {
      event: 'error', flow: flowName, id, numero: chatId,
      vars: ctx.vars, error: err.message,
    })

    return { ok: false, error: err.message }

  } finally {

    popContext(chatId)   // siempre saca este contexto de la pila

  }
}

module.exports = {
  esperas,
  respuestas,
  resolvers,
  timeouts,
  activeFlows,
  loadFlowByName,
  waitResponse,
  sendWebhook,
  resolveIncomingForWait,
  processFlowForChat,
}