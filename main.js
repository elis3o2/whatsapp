// main.queue.single-session.js — versión para UNA sesión (SESSION_ID desde env)
// Mantiene cola FIFO, endpoints y soporte de flows. Reintenta reconexión al desconectarse.
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js')
const express = require('express')
const multer = require('multer')
const fs = require('fs')
const mime = require('mime-types')
const QRCode = require('qrcode')
const qrcodeTerminal = require('qrcode-terminal')
const util = require('util')
const crypto = require('crypto')

/* dependencias para flow y webhook */
const path = require('path')
const mustache = require('mustache')
const axios = require('axios')

const upload = multer({ dest: 'uploads/' })
const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Tomar SESSION_ID de env (indicarlo al lanzar el contenedor)
const SESSION_ID = process.env.SESSION_ID || 'default'

let client = null
let clientReady = false
let restarting = false
const esperas = new Map()
const respuestas = new Map()
const resolvers = new Map()
const timeouts = new Map()
const activeFlows = new Map()
const qrStore = new Map()

console.log('🟢 Iniciando main.js — pid:', process.pid)
console.log('🔧 SESSION_ID:', SESSION_ID)

process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at Promise', p, 'reason:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err)
})

// --------------------------- COLA SIMPLE (FIFO) ---------------------------
const sendQueue = []
let processingQueue = false

async function enqueue(taskFn) {
  return new Promise((resolve, reject) => {
    console.log('[queue] enqueue, length before:', sendQueue.length)
    sendQueue.push({ taskFn, resolve, reject })
    processQueue().catch(err => console.error('Error en processQueue:', err))
  })
}

async function processQueue() {
  if (processingQueue) return
  processingQueue = true
  console.log('[queue] processQueue starting')
  while (sendQueue.length > 0) {
    const item = sendQueue.shift()
    console.log('[queue] processing task, remaining:', sendQueue.length)
    try {
      await waitForClientReady()
      const result = await item.taskFn()
      item.resolve(result)
      console.log('[queue] task finished')
    } catch (err) {
      item.reject(err)
      console.error('[queue] task failed:', err)
    }
  }
  processingQueue = false
  console.log('[queue] processQueue empty')
}

function waitForClientReady(timeout = 120000) {
  if (client && clientReady) return Promise.resolve()
  return new Promise((resolve, reject) => {
    console.log('[waitForClientReady] clientReady?', clientReady, 'client?', !!client)
    const onReady = () => {
      clear()
      console.log('[waitForClientReady] ready event fired')
      resolve()
    }
    const onTimeout = () => {
      cleanup()
      console.error('[waitForClientReady] timeout waiting for client.ready')
      reject(new Error('Timeout esperando client.ready'))
    }

    function cleanup() {
      try { client?.off('ready', onReady) } catch(e){}
    }
    function clear() {
      cleanup()
      if (timer) clearTimeout(timer)
    }

    if (client) client.once('ready', onReady)
    const timer = setTimeout(onTimeout, timeout)
  })
}

// --------------------------- CREAR CLIENTE ---------------------------
const createClient = (sessionId) => {
  console.log(`🟡 Creando cliente para sessionId=${sessionId}`)
  const newClient = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  })

  newClient.on('qr', async (qr) => {
    const sid = sessionId
    console.log(`📷 [${sid}] Evento QR recibido. Generando terminal + archivo...`)
    try {
      // imprimir en terminal
      qrcodeTerminal.generate(qr, { small: true })
      // asegurar carpeta ./qr
      const qrDir = path.join(__dirname, 'qr')
      if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true })
      // ruta PNG: ./qr/<SESSION_ID>.png
      const pngPath = path.join(qrDir, `${sid}.png`)
      await QRCode.toFile(pngPath, qr)
      // guardar también en memoria como dataURL (clave: SESSION_ID)
      const dataUrl = await QRCode.toDataURL(qr)
      qrStore.set(sid, dataUrl)

      console.log(`✅ QR guardado en ${pngPath} y en memoria (qrStore). Servir en /qr (sesión: ${sid})`)
    } catch (err) {
      console.error(`❌ Error generando QR para ${sid}:`, err)
    }
  })

  newClient.on('authenticated', (session) => {
    console.log(`🔐 [${sessionId}] Evento authenticated (session guardada).`)
    try {
      if (!session) {
        console.warn(`⚠️ [${sessionId}] Evento 'authenticated' recibido SIN datos de session.`)
        return
      }
      let sessionStr
      try { sessionStr = JSON.stringify(session) } catch (jsonErr) {
        console.warn(`⚠️ [${sessionId}] JSON.stringify falló, usando util.inspect como fallback:`, jsonErr)
        sessionStr = util.inspect(session, { depth: null })
      }

      const sessionPath = `./session-${sessionId}.json`
      const sessionDir = require('path').dirname(sessionPath)
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true })
      fs.writeFileSync(sessionPath, sessionStr, 'utf8')
      console.log(`🔁 session-${sessionId}.json escrita`)
    } catch (e) {
      console.error('Error guardando session file:', e)
    }
  })

  newClient.on('loading_screen', (percent, message) => {
    console.log(`[${sessionId}] loading_screen ${percent}% — ${message}`)
  })

  newClient.on('ready', () => {
    console.log(`✅ Cliente ${sessionId} listo (ready)`)
    clientReady = true
  })

  newClient.on('auth_failure', (msg) => {
    console.error(`❌ Fallo de autenticación para ${sessionId}:`, msg || '(sin msg)')
  })

  newClient.on('disconnected', async reason => {
    console.warn(`⚠️ ${sessionId} desconectado: ${reason}`)
    clientReady = false

    try {
      await newClient.destroy()
    } catch (e) {
      console.warn('destroy error:', e)
    }

    attemptReconnect(sessionId)
  })


  newClient.on('message', async (message) => {
    console.log(`[${sessionId}] mensaje de ${message.from}: ${String(message.body || '').slice(0,100)}`)
  //  const contact = await message.getContact();
  //  const chatId = contact.number
  //  console.log("LLEGO MENSAJE ", message)
  //  console.log("ESPERAS: " , esperas)
  //  console.log("CHAT Id", chatId)
  //  if (esperas.has(chatId)) {
  //    console.log("POSITVO")
  //    const idMensaje = esperas.get(chatId)
  //    respuestas.set(idMensaje, message)
  //    esperas.delete(chatId)
  //    if (resolvers.has(idMensaje)) {
  //      resolvers.get(idMensaje).forEach(r => r({ message }))
  //      resolvers.delete(idMensaje)
  //    }
  //    if (timeouts.has(idMensaje)) {
  //      clearTimeout(timeouts.get(idMensaje))
  //      timeouts.delete(idMensaje)
  //    }
  //  }
  })

  newClient.on('change_state', (state) => {
    console.log(`[${sessionId}] state changed:`, state)
  })

  return newClient
}

// --------------------------- RECONNECT STRATEGY ---------------------------
let reconnecting = false
let reconnectAttempts = 0

function attemptReconnect(sessionId) {
  if (reconnecting) return
  reconnecting = true
  reconnectAttempts = 0

  const tryOnce = async () => {
    reconnectAttempts++
    const waitMs = Math.min(30000, 2000 * reconnectAttempts) // backoff cap 30s
    console.log(`🔁 Intento de reconexión #${reconnectAttempts} en ${waitMs}ms`)

    setTimeout(async () => {
      try {
        console.log('🔴 Destruyendo cliente antiguo (si existe)')
        if (client) {
          try { await client.destroy() } catch(e){ console.warn('destroy error:', e) }
          client = null
        }

        console.log('🔄 Creando nuevo cliente y inicializando...')
        client = createClient(sessionId)
        try { await client.initialize() } catch(e){ console.error('initialize error:', e) }

        // esperamos hasta 20s a que llegue ready
        try {
          await waitForClientReady(20000)
          console.log('✅ Reconectado correctamente')
          reconnecting = false
          reconnectAttempts = 0
        } catch (e) {
          console.warn('⚠️ Reconexión fallida:', e.message || e)
          if (reconnectAttempts < 10) {
            tryOnce()
          } else {
            console.error('🔻 Superados intentos de reconexión')
            reconnecting = false
          }
        }
      } catch (err) {
        console.error('Error durante intento de reconexión:', err)
        reconnecting = false
      }
    }, waitMs)
  }

  tryOnce()
}


function restartProcess(reason) {
  if (restarting) return
  restarting = true

  console.error('♻ Reiniciando proceso:', reason)

  setTimeout(() => {
    process.exit(1) // PM2 reinicia
  }, 1000)
}


setInterval(async () => {
  console.log('🕐 Chequeando estado de WhatsApp...')

  try {
    if (!clientReady) {
      console.warn('❌ Cliente NO ready')
      restartProcess('clientReady=false')
      return
    }

    // Check real contra WhatsApp Web
    const state = await client.getState()

    if (state !== 'CONNECTED') {
      console.warn('❌ Estado inválido:', state)
      restartProcess(`state=${state}`)
      return
    }

    console.log('✅ WhatsApp OK')

  } catch (err) {
    console.error('❌ Error chequeando estado:', err.message)

    restartProcess(err.message)
    
  }

}, 60 * 60 * 1000) // 1 hora


// --------------------------- INICIALIZACIÓN ---------------------------
let serverListening = false
if (!serverListening) {
  serverListening = true
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor escuchando en http://0.0.0.0:${PORT}`)
  })
}

console.log('➡️ Creando cliente inicial...')
client = createClient(SESSION_ID)

console.log('➡️ Inicializando cliente (initialize)...')
try {
  client.initialize()
} catch (e) {
  console.error('Error al client.initialize():', e)
  // Si initialize falla aquí, dejamos que attemptReconnect lo maneje cuando ocurra disconnect/auth_failure
}

client.once('ready', () => {
  console.log('✅ Evento ready recibido (main). Cliente inicial listo')
})

// ---------------------- HELPERS Y ENDPOINTS ----------------------
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

async function waitResponse(numero, sent) {
  const idMensaje = sent.id.id
  
  esperas.set(numero, idMensaje)
  resolvers.set(idMensaje, [])

  const timeoutId = setTimeout(() => {
    if (esperas.get(numero) === idMensaje && !respuestas.has(idMensaje)) {
      esperas.delete(chatId)
      resolvers.get(idMensaje)?.forEach(r => r(null))
      resolvers.delete(idMensaje)
    }
    timeouts.delete(idMensaje)
  }, 8640000)
  timeouts.set(idMensaje, timeoutId)

  const respuesta = await new Promise(resolve => {
    resolvers.get(idMensaje).push(resolve)
  })

  if (!respuesta) return null
  return respuesta.message
}

async function processFlowForChat(flowJson, numero, webhook, id) {
  const flowName = flowJson.id || 'flow'
  const ctx = { vars: {} }
  const chatId = `${numero}@c.us`
  let nodeId = flowJson.start
  activeFlows.set(numero, { flowName, flowJson, nodeId, vars: ctx.vars, webhook, running: true })

  try {
    while (nodeId) {
      const node = flowJson.nodes[nodeId]
      if (!node) throw new Error('Nodo inexistente: ' + nodeId)
      const text = mustache.render(node.template || '', ctx.vars || {})

      if (node.type === 'message') {
        const sent = await enqueue(async () => { return await client.sendMessage(chatId, text, {
        sendSeen: false
    }); })
        const fechaLocalSent = formatFechaFromMessage(sent)
        if (webhook) {
          axios.post(webhook, { event: 'outgoing_node', flow: flowName, time: fechaLocalSent, id: sent.id.id, nodeId, from: sent._data.from.user, to: sent._data.to.user, id: id, session: SESSION_ID }).catch(()=>{})
        }
        const nextMap = node.next || {}
        const nextNode = nextMap.default || nextMap.any || null
        if (nextNode) { nodeId = nextNode; const af = activeFlows.get(numero) || {}; af.nodeId = nodeId; af.vars = ctx.vars; activeFlows.set(chatId, af); continue } else { nodeId = null; break }

      } else if (node.type === 'input') {
        const sent = await enqueue(async () => { return await client.sendMessage(chatId, text, {
        sendSeen: false
    }); })
        const fechaLocalSent = formatFechaFromMessage(sent)
        if (webhook) axios.post(webhook, { event: 'input', flow: flowName, id: sent.id.id, from: sent._data.from.user, to: sent._data.to.user, time: fechaLocalSent, nodeId, id: id, session: SESSION_ID }).catch(()=>{})
        const incoming = await waitResponse(numero, sent)
        if (!incoming) { if (webhook) axios.post(webhook, { event: 'error', flow: flowName, nodeId, id: id, error: 'timeout or no response' }).catch(()=>{}); throw new Error('Timeout esperando respuesta en nodo: ' + nodeId) }
        ctx.vars.last_input = (incoming.body || incoming).toString().trim()
        const fechaLocalIncoming = formatFechaFromMessage(incoming)
        if (webhook) axios.post(webhook, { event: 'incoming_message', flow: flowName, id: incoming.id.id, from: incoming.from, to: incoming.to, time: fechaLocalIncoming, message: ctx.vars.last_input, id: id, session: SESSION_ID }).catch(()=>{})
        const nextMap = node.next || {}
        const nextNode = nextMap.any || nextMap.default || Object.values(nextMap)[0]
        if (nextNode) { nodeId = nextNode; const af = activeFlows.get(numero) || {}; af.nodeId = nodeId; af.vars = ctx.vars; activeFlows.set(chatId, af); continue } else { nodeId = null; break }

      } else if (node.type === 'router') {
        const rawLast = (ctx.vars.last_input || '').toString().trim();
        const normalize = (s) => { if (!s && s !== '') return ''; try { return s.toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim() } catch (e) { return s.toString().toLowerCase().replace(/[\u00C0-\u017F]/g, '').trim() } }
        const routes = node.routes || {}
        let target = null
        const normalizedLast = normalize(rawLast.toLowerCase())
        for (const key of Object.keys(routes)) { if (normalize(key) === normalizedLast) { target = routes[key]; break } }
        if (!target) { if (routes[rawLast]) target = routes[rawLast]; else if (routes[rawLast.toLowerCase()]) target = routes[rawLast.toLowerCase()]; else target = node.default || null }
        if (!target) throw new Error('Router sin target definido para input: ' + rawLast)
        nodeId = target
        const af = activeFlows.get(numero) || {}
        af.nodeId = nodeId; af.vars = ctx.vars; activeFlows.set(numero, af)
        continue
      } else {
        await enqueue(async () => await client.sendMessage(chatId, text, {
        sendSeen: false
    }))
        nodeId = null
        break
      }
    }

    if (webhook) axios.post(webhook, { event: 'flow_finished', flow: flowName, id: id, numero, session: SESSION_ID }).catch(()=>{})
    return { ok: true }
  } catch (err) {
    console.error('[processFlowForChat] error:', err)
    if (webhook) axios.post(webhook, { event: 'error', flow: flowName, numero, id: id, session: SESSION_ID, error: String(err?.message || err) }, ).catch(()=>{})
    return { ok: false, error: String(err?.message || err) }
  } finally {
    activeFlows.delete(numero)
  }
}

function generateId20() { return crypto.randomBytes(15).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '') }

// ---------------------- ENDPOINTS ----------------------
app.get('/qr', async (req, res) => {
  try {
    const sid = SESSION_ID // siempre usamos la variable global
    const qrDir = path.join(__dirname, 'qr')
    const pngPath = path.join(qrDir, `${sid}.png`)

    // Si existe el archivo PNG, servirlo directamente
    if (fs.existsSync(pngPath)) {
      return res.sendFile(require('path').resolve(pngPath))
    }
    return res.status(400).json({ error: 'QR no encontrado para la sesión configurada' })
  
  } catch (err) {
    console.error('Error en /qr:', err)
    return res.status(500).json({ error: 'Error interno al servir QR' })
  }
})

app.get('/status', async (req, res) => {
    try {

        if (!client) {
            return res.status(400).json({
                error: `Client for global session '${SESSION_ID}' not found`
            });
        }
        let state;
        try {
            state = await client.getState();  
        } catch (err) {
            state = "DISCONNECTED";
        }

        const info = client.info || null;
        return res.json({
            session: SESSION_ID,
            state,
            me: info ? {
                wid: info.wid.user,
                pushName: info.pushname
            } : null
        });
    } catch (error) {
        console.error("Error in /status:", error);
        return res.status(500).json({ error: "Internal server error" });
    }
});




app.post('/start_flow', upload.none(), async (req, res) => {
  const { flowName, numero, endpoint } = req.body
  if (!flowName || !numero || !endpoint) return res.status(400).json({ error: 'Faltan datos: flowName, numero, endpoint' })
  if (numero.length !== 13) return res.status(400).json({ error: 'Número inválido' })
  const chatId = `${numero}@c.us`

  const isRegistered = await client.isRegisteredUser(chatId)
  if (!isRegistered) return res.status(422).json({ error: 'Número sin whatsapp' })

  try {

    let flowJson
    try { flowJson = loadFlowByName(flowName) } catch (e) { return res.status(400).json({ error: 'Flow no encontrado o inválido: ' + e.message }) }
    const id = generateId20()
    processFlowForChat(flowJson, numero, endpoint, id)
    return res.json({ status: 'started', flow: flowJson.id || flowName, to: numero, id: id, session: SESSION_ID })
  } catch (err) {
    console.error('❌ Error en /start_flow:', err)
    return res.status(500).json({ error: 'Error interno' })
  }
})

// (resto de endpoints: enviar-mensaje, enviar-archivo, esperar, respuesta/:idMensaje, estado, get_mensajes/:numero)
// Para mantener la respuesta corta en este archivo, se asume que se copian tal cual desde tu versión original.
// --- Aquí incluí las funciones principales arriba; si querés que copie todo tal cual, lo hago.

function formatFechaFromMessage(message) {
  const fechaLocal = new Date(message.timestamp * 1000).toLocaleString('sv-SE', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour12: false
  }).replace(' ', 'T')
  return fechaLocal
}

// Incluyo los endpoints core (enviar-mensaje, enviar-archivo, enviar-ubicacion, esperar, respuesta, estado, get_mensajes) exactamente como estaban.

app.post('/enviar-mensaje', upload.none(), async (req, res) => {
  const { numero, texto } = req.body
  if (!numero || !texto) return res.status(400).json({code: -1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({code: -2, error: 'Número inválido' })
  const chatId = `${numero}@c.us`

  try {
    if (!clientReady) {
      console.warn('[enviar-mensaje] client not ready, rejecting with 503')
      return res.status(503).json({code: -4, error: 'Client not ready.' })
    }

    const isRegistered = await client.isRegisteredUser(chatId)
    if (!isRegistered) return res.status(422).json({ code: -3, error: 'Número sin whatsapp' })

    const result = await enqueue(async () => {
      const message = await client.sendMessage(chatId, texto,  {
        sendSeen: false
    });
      return message
    })

    const fechaLocal = formatFechaFromMessage(result)
    res.json({code:0, id: result.id.id, ack: result.ack, from: result._data.from.user, to: result._data.to.user, time: fechaLocal, session: SESSION_ID })
  }
  catch (err) {
    console.error('❌ Error al enviar mensaje (queued):', err)
    // Intentamos reconectar
    attemptReconnect(SESSION_ID)
    res.status(500).json({code:-5, error: 'Falló el envío' })
  }
})

app.post('/enviar-archivo', upload.single('archivo'), async (req, res) => {
  const { numero, texto = '' } = req.body
  const filePath = req.file?.path
  const originalName = req.file?.originalname
  if (!numero || !filePath) return res.status(400).json({code: -1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({code: -2, error: 'Número inválido' })
  try {
    if (!clientReady) return res.status(503).json({code:-4, error: 'Client not ready' })
    
    const isRegistered = await client.isRegisteredUser(`${numero}@c.us`)
    if (!isRegistered) return res.status(422).json({code: -3, error: 'Número sin whatsapp' })
    
    const result = await enqueue(async () => {
      const mimeType = mime.lookup(originalName) || 'application/octet-stream'
      const base64 = fs.readFileSync(filePath, 'base64')
      const media = new MessageMedia(mimeType, base64, originalName)
      const message = await client.sendMessage(`${numero}@c.us`, media, { caption: texto, sendSeen: false })
      return message
    })
    try { fs.unlinkSync(filePath) } catch (e) { }
    const fechaLocal = formatFechaFromMessage(result)
    res.json({ id: result.id.id, status: 'OK', from: result._data.from.user, to: result._data.to.user, time: fechaLocal, session: SESSION_ID })
  } catch (err) {
    try { fs.unlinkSync(filePath) } catch (e) { }
    console.error('❌ Error al enviar archivo (queued):', err)
    attemptReconnect(SESSION_ID)
    res.status(500).json({code: -5, error: 'Falló el envío' })
  }
})

app.post('/enviar-ubicacion', upload.none(), async (req, res) => {
  const { numero, lat, lon } = req.body
  if (!numero || !lat || !lon) return res.status(400).json({code: -1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({code: -2, error: 'Número inválido' })

  try {
    if (!clientReady) return res.status(503).json({code: -4, error: 'Client not ready' })
    
    const isRegistered = await client.isRegisteredUser(`${numero}@c.us`)
    if (!isRegistered) return res.status(422).json({code: -3, error: 'Número sin whatsapp' })

    const result = await enqueue(async () => {
      let location = `https://maps.google.com/maps?q=${lat},${lon}&z=17&hl=en`
      const message = await client.sendMessage(`${numero}@c.us`, location, {
        sendSeen: false
    });
      return message
    })
    const fechaLocal = formatFechaFromMessage(result)
    res.json({ code:0, id: result.id.id, status: 'OK', from: result._data.from.user, to: result._data.to.user, time: fechaLocal, session: SESSION_ID })
  } catch (err) {
    console.error('❌ Error al enviar ubicación (queued):', err)
    attemptReconnect(SESSION_ID)
    res.status(500).json({code:-5, error: 'Falló el envío' })
  }
})

app.post('/esperar', upload.none(), async (req, res) => {
  const { numero, texto } = req.body
  if (!numero || !texto) return res.status(400).json({ code:-1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({code: -2, error: 'Número inválido' })
  const chatId = `${numero}@c.us`
  
  try {
    if (!clientReady) return res.status(503).json({code:-4, error: 'Client not ready' })
    
    const isRegistered = await client.isRegisteredUser(chatId)
    if (!isRegistered) return res.status(422).json({code: -3, error: 'Número sin whatsapp' })
    
    const message = await enqueue(async () => { return await client.sendMessage(chatId, texto, {
        sendSeen: false
    }); })
    
    const idMensaje = message.id.id
    esperas.set(chatId, idMensaje)
    resolvers.set(idMensaje, [])
    const timeoutId = setTimeout(() => {
      if (esperas.get(chatId) === idMensaje && !respuestas.has(idMensaje)) {
        esperas.delete(chatId)
        resolvers.get(idMensaje)?.forEach(r => r(null))
        resolvers.delete(idMensaje)
      }
      timeouts.delete(idMensaje)
    }, 300000)
    timeouts.set(idMensaje, timeoutId)
    const fechaLocal = formatFechaFromMessage(message)
    res.json({code:0, id: message.id.id, ack: message.ack, from: message._data.from.user, to: message._data.to.user, time: fechaLocal, session: SESSION_ID })
  } catch (err) {
    console.error('❌ Error al enviar mensaje (esperar):', err)
    res.status(500).json({code:-5, error: 'Falló el envío' })
  }
})

app.get('/respuesta', async (req, res) => {
  const idMensaje = req.params.idMensaje
  if (respuestas.has(idMensaje)) {
    const message = respuestas.get(idMensaje)
    const fechaLocal = formatFechaFromMessage(message)
    return res.json({ id: message.id.id, message: message.body, from: message._data.from.user, to: message._data.to.user, time: fechaLocal, session: SESSION_ID })
  }
  
  const estaEsperando = Array.from(esperas.entries()).some(([, v]) => v === idMensaje)
  if (!estaEsperando) return res.status(404).json({ error: 'Respuesta no encontrada' })
  
    const respuesta = await new Promise(resolve => { resolvers.get(idMensaje).push(resolve) })
  if (!respuesta) return res.status(404).json({ error: 'Tiempo agotado' })
  const { message } = respuesta
  const fechaLocal = formatFechaFromMessage(message)
  return res.json({ id: message.id.id, message: message.body, from: message.from, to: message.to, time: fechaLocal, session: SESSION_ID })
})

app.get('/estado/:id/:numero', async (req, res) => {
  const { id, numero } = req.params;
  if (!numero || !id) {
    return res.status(400).json({ code: -1, error: 'Faltan datos' });
  }
  if (numero.length !== 13) {
    return res.status(400).json({ code: -2, error: 'Número inválido' });
  }

  // Verificar registro usando getNumberId en lugar de isRegisteredUser
  // (más robusto ante el cambio @lid)
  let contactId;
  try {
    contactId = await client.getNumberId(numero);
    if (!contactId) {
      return res.status(422).json({ code: -3, error: 'Número sin whatsapp' });
    }
  } catch (e) {
    return res.status(422).json({ code: -3, error: 'Número sin whatsapp' });
  }

  // Construir el serialized ID del mensaje (fromMe = true)
  // Formato: true_NUMERO@c.us_MSGID  ó  true_NUMERO@lid_MSGID
  const serializedId = `true_${contactId._serialized}_${id}`;

  let message;
  try {
    message = await client.getMessageById(serializedId);
  } catch (e) {
    message = null;
  }

  if (!message) {
    // Fallback: buscar vía fetchMessages si getMessageById falla
    // (útil si el mensaje está fuera del caché de WhatsApp Web)
    try {
      const chat = await client.getChatById(contactId._serialized);
      const messages = await chat.fetchMessages({ limit: 50, fromMe: true });
      message = messages.find(m => m.id.id === id) || null;
    } catch (e) {
      message = null;
    }
  }

  if (!message) {
    return res.status(400).json({ code: -4, error: 'Mensaje no encontrado' });
  }

  const fechaLocal = formatFechaFromMessage(message);
  res.json({code: 0, id: message.id.id, ack: message.ack, from: message.from, to: message.to, time: fechaLocal, session: SESSION_ID});
});

app.get('/get_mensajes', async (req, res) => {
  const numero = req.params.numero
  if (!numero) return res.status(400).json({code:-1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({code: -2, error: 'Número inválido' })
  const isRegistered = await client.isRegisteredUser(`${numero}@c.us`)
  if (!isRegistered) return res.status(422).json({code: -3, error: 'Número sin whatsapp' })
  try {
    const chat = await client.getChatById(`${numero}@c.us`)
    const mensajes = await chat.fetchMessages({ limit: 20 })
    console.log(mensajes)
    res.json(mensajes)
  } catch (err) {
    console.error(err)
    res.status(500).json({ code:-5, error: 'Error al obtener mensajes' })
  }
})

module.exports = { app }
