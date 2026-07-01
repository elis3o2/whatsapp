// flowEngine.js — Motor de flows: espera de respuestas (input), webhooks y ejecución de nodos.

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

// Flows activos
const activeFlows = new Map()

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

async function sendWebhook(webhook, data) {
  console.log('WEB', webhook)
  if (!webhook) return
  console.log('SEND WEBHOOK')
  console.log(webhook)
  try {
    await axios.post(webhook, {
      session: SESSION_ID,
      ...data,
    })
  } catch (e) {
    console.error('[webhook]', e.message)
  }
}

/**
 * Maneja un mensaje entrante para resolver una "espera" activa (input flows).
 * Llamado desde el handler de messages.upsert.
 */
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

async function processFlowForChat(flowJson, numero, webhook, id) {

  const flowName = flowJson.id || 'flow'
  const ctx = { vars: {} }

  // Puede venir un número o un JID
  const chatId = numero.includes('@')
    ? numero
    : toJid(numero)

  let nodeId = flowJson.start

  activeFlows.set(chatId, {
    flowName,
    flowJson,
    nodeId,
    vars: ctx.vars,
    webhook,
    running: true,
  })

  try {

    while (nodeId) {

      const node = flowJson.nodes[nodeId]

      if (!node)
        throw new Error(`Nodo inexistente: ${nodeId}`)

      const text = mustache.render(
        node.template || '',
        ctx.vars
      )

      console.log('NODO', nodeId)
      console.log(node)

      // ============================================================
      // MESSAGE
      // ============================================================
      if (node.type === 'message') {

        const sent = await enqueue(() => sendText(chatId, text))

        await sendWebhook(webhook, {
          event: 'outgoing_node',
          flow: flowName,
          nodeId,
          id,
          numero: chatId,
          messageId: sent.id.id,
          text,
          vars: ctx.vars,
        })

        const nextMap = node.next || {}

        nodeId =
          nextMap.any ||
          nextMap.default ||
          null

        if (activeFlows.has(chatId)) {
          const af = activeFlows.get(chatId)
          af.nodeId = nodeId
          af.vars = ctx.vars
          activeFlows.set(chatId, af)
        }

        continue
      }

      // ============================================================
      // INPUT
      // ============================================================
      if (node.type === 'input') {

        const sent = await enqueue(() => sendText(chatId, text))

        await sendWebhook(webhook, {
          event: 'input',
          flow: flowName,
          nodeId,
          id,
          numero: chatId,
          messageId: sent.id.id,
          text,
          vars: ctx.vars,
        })

        const incoming = await waitResponse(chatId, sent)

        if (!incoming) {
          throw new Error(
            `Timeout esperando respuesta en ${nodeId}`
          )
        }

        const value = (incoming.body || '')
          .toString()
          .trim()

        ctx.vars.last_input = value

        if (node.save) {
          ctx.vars[node.save] = value
        }

        await sendWebhook(webhook, {
          event: 'incoming_message',
          flow: flowName,
          nodeId,
          id,
          numero: chatId,
          message: value,
          vars: ctx.vars,
        })

        const nextMap = node.next || {}

        nodeId =
          nextMap.any ||
          nextMap.default ||
          Object.values(nextMap)[0] ||
          null

        if (activeFlows.has(chatId)) {
          const af = activeFlows.get(chatId)
          af.nodeId = nodeId
          af.vars = ctx.vars
          activeFlows.set(chatId, af)
        }

        continue
      }

      // ============================================================
      // ROUTER
      // ============================================================
      if (node.type === 'router') {

        const value = (ctx.vars.last_input || '')
          .toString()
          .trim()
          .toLowerCase()

        let target = null
        const routes = node.routes || {}

        for (const key of Object.keys(routes)) {
          if (key.toLowerCase() === value) {
            target = routes[key]
            break
          }
        }

        if (!target) {
          target = node.default || null
        }

        if (!target) {
          throw new Error(
            `Router sin ruta para "${ctx.vars.last_input}"`
          )
        }

        nodeId = target

        if (activeFlows.has(chatId)) {
          const af = activeFlows.get(chatId)
          af.nodeId = nodeId
          af.vars = ctx.vars
          activeFlows.set(chatId, af)
        }

        continue
      }

      // ============================================================
      // SCRIPT
      // ============================================================
      if (node.type === 'script') {

        let result = {
          next: 'error',
        }

        if (node.url) {

          try {

            const resp = await axios.post(node.url, {
              vars: ctx.vars,
              numero: chatId,
              flow: flowName,
              nodeId,
            })

            result = resp.data

          } catch (e) {

            console.error(
              `[script-url:${node.url}]`,
              e.message
            )

          }

        } else if (node.script) {

          try {

            const scriptPath = path.join(
              __dirname,
              'scripts',
              `${node.script}.js`
            )

            delete require.cache[
              require.resolve(scriptPath)
            ]

            const script = require(scriptPath)

            result = await script.run(
              ctx.vars,
              chatId
            )
            console.log('RESULTADO SCRIPT:', result)

          } catch (e) {

            console.error(
              `[script:${node.script}]`,
              e
            )

          }

        } else {

          console.warn(
            `Nodo ${nodeId} no tiene script ni url`
          )

        }

        if (result.vars) {
          Object.assign(ctx.vars, result.vars)
        }

        await sendWebhook(webhook, {
          event: 'script_result',
          flow: flowName,
          nodeId,
          id,
          numero: chatId,
          next: result.next,
          vars: ctx.vars,
        })

        const nextMap = node.next || {}

        nodeId =
          nextMap[result.next] ||
          nextMap.default ||
          null

        if (!nodeId) {

          throw new Error(
            `El script devolvió "${result.next}" pero no existe una transición`
          )

        }

        if (activeFlows.has(chatId)) {
          const af = activeFlows.get(chatId)
          af.nodeId = nodeId
          af.vars = ctx.vars
          activeFlows.set(chatId, af)
        }

        continue
      }

      console.warn(
        `Tipo de nodo desconocido: ${node.type}`
      )

      break
    }

    await sendWebhook(webhook, {
      event: 'flow_finished',
      flow: flowName,
      id,
      numero: chatId,
      vars: ctx.vars,
    })

    return {
      ok: true,
      vars: ctx.vars,
    }

  } catch (err) {

    console.error('[FLOW ERROR]', err)

    await sendWebhook(webhook, {
      event: 'error',
      flow: flowName,
      id,
      numero: chatId,
      vars: ctx.vars,
      error: err.message,
    })

    return {
      ok: false,
      error: err.message,
    }

  } finally {

    activeFlows.delete(chatId)

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