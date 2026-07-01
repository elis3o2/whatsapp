// routes.js — Endpoints HTTP de la API.

const express = require('express')
const multer  = require('multer')
const fs      = require('fs')
const path    = require('path')
const mime    = require('mime-types')
const crypto  = require('crypto')

const { state, SESSION_ID } = require('./state')
const { getRegisteredJid } = require('./jidUtils')
const { db, getStoredMessage, getStoredMessagesByJid } = require('./messageStore')
const { normalizeBaileysMessage, formatFechaFromMessage } = require('./messageUtils')
const { enqueue } = require('./queue')
const { sendText, sendFile, sendLocation } = require('./sender')
const { attemptReconnect } = require('./baileysClient')
const {
  esperas,
  respuestas,
  resolvers,
  timeouts,
  loadFlowByName,
  processFlowForChat,
} = require('./flowEngine')

const upload = multer({ dest: '../uploads/' })
const router = express.Router()

function generateId20() {
  return crypto.randomBytes(15).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

router.get('/qr', async (req, res) => {
  try {
    path.join(__dirname, '..', 'qr')
    const pngPath = path.join(qrDir, `${SESSION_ID}.png`)
    if (fs.existsSync(pngPath)) return res.sendFile(path.resolve(pngPath))
    return res.status(400).json({ error: 'QR no encontrado para la sesión configurada' })
  } catch (err) {
    console.error('Error en /qr:', err)
    return res.status(500).json({ error: 'Error interno al servir QR' })
  }
})

router.get('/status', async (req, res) => {
  try {
    if (!state.sock) return res.status(400).json({ error: `Client for session '${SESSION_ID}' not found` })

    const wsState = state.sock.ws?.readyState
    const status   = wsState === 1 ? 'CONNECTED' : 'DISCONNECTED'
    const user    = state.sock.user || null

    return res.json({
      session: SESSION_ID,
      state: status,
      me: user ? { wid: user.id?.split(':')[0], pushName: user.name } : null,
    })
  } catch (error) {
    console.error('Error in /status:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

router.post('/start_flow', upload.none(), async (req, res) => {
  const { flowName, numero, endpoint } = req.body
  if (!flowName || !numero || !endpoint) return res.status(400).json({ error: 'Faltan datos: flowName, numero, endpoint' })
  if (numero.length !== 13) return res.status(400).json({ error: 'Número inválido' })

  const jid = await getRegisteredJid(numero)
  if (!jid) return res.status(422).json({ error: 'Número sin whatsapp' })

  try {
    let flowJson
    try { flowJson = loadFlowByName(flowName) }
    catch (e) { return res.status(400).json({ error: 'Flow no encontrado o inválido: ' + e.message }) }
    const id = generateId20()
    processFlowForChat(flowJson, numero, endpoint, id)
    return res.json({ status: 'started', flow: flowJson.id || flowName, to: numero, id, session: SESSION_ID })
  } catch (err) {
    console.error('❌ Error en /start_flow:', err)
    return res.status(500).json({ error: 'Error interno' })
  }
})

router.post('/enviar-mensaje', upload.none(), async (req, res) => {
  const { numero, texto } = req.body
  if (!numero || !texto) return res.status(400).json({ code: -1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({ code: -2, error: 'Número inválido' })

  try {
    if (!state.clientReady) return res.status(503).json({ code: -4, error: 'Client not ready.' })

    const jid = await getRegisteredJid(numero)
    if (!jid) return res.status(422).json({ code: -3, error: 'Número sin whatsapp' })

    const result = await enqueue(async () => sendText(jid, texto))
    const fechaLocal = formatFechaFromMessage(result)
    res.json({ code: 0, id: result.id.id, ack: result.ack, from: result._data.from.user, to: result._data.to.user, time: fechaLocal, session: SESSION_ID })
  } catch (err) {
    console.error('❌ Error al enviar mensaje:', err)
    attemptReconnect(SESSION_ID)
    res.status(500).json({ code: -5, error: 'Falló el envío' })
  }
})

router.post('/enviar-archivo', upload.single('archivo'), async (req, res) => {
  const { numero, texto = '' } = req.body
  const filePath    = req.file?.path
  const originalName = req.file?.originalname
  if (!numero || !filePath) return res.status(400).json({ code: -1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({ code: -2, error: 'Número inválido' })

  try {
    if (!state.clientReady) return res.status(503).json({ code: -4, error: 'Client not ready' })

    const jid = await getRegisteredJid(numero)
    if (!jid) return res.status(422).json({ code: -3, error: 'Número sin whatsapp' })

    const result = await enqueue(async () => {
      const mimeType = mime.lookup(originalName) || 'application/octet-stream'
      const base64   = fs.readFileSync(filePath, 'base64')
      return await sendFile(jid, base64, mimeType, originalName, texto)
    })
    try { fs.unlinkSync(filePath) } catch (e) {}
    const fechaLocal = formatFechaFromMessage(result)
    res.json({ id: result.id.id, status: 'OK', from: result._data.from.user, to: result._data.to.user, time: fechaLocal, session: SESSION_ID })
  } catch (err) {
    try { fs.unlinkSync(filePath) } catch (e) {}
    console.error('❌ Error al enviar archivo:', err)
    attemptReconnect(SESSION_ID)
    res.status(500).json({ code: -5, error: 'Falló el envío' })
  }
})

router.post('/enviar-ubicacion', upload.none(), async (req, res) => {
  const { numero, lat, lon } = req.body
  if (!numero || !lat || !lon) return res.status(400).json({ code: -1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({ code: -2, error: 'Número inválido' })

  try {
    if (!state.clientReady) return res.status(503).json({ code: -4, error: 'Client not ready' })

    const jid = await getRegisteredJid(numero)
    if (!jid) return res.status(422).json({ code: -3, error: 'Número sin whatsapp' })

    const result = await enqueue(async () => sendLocation(jid, lat, lon))
    const fechaLocal = formatFechaFromMessage(result)
    res.json({ code: 0, id: result.id.id, status: 'OK', from: result._data.from.user, to: result._data.to.user, time: fechaLocal, session: SESSION_ID })
  } catch (err) {
    console.error('❌ Error al enviar ubicación:', err)
    attemptReconnect(SESSION_ID)
    res.status(500).json({ code: -5, error: 'Falló el envío' })
  }
})

router.post('/esperar', upload.none(), async (req, res) => {
  const { numero, texto } = req.body
  if (!numero || !texto) return res.status(400).json({ code: -1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({ code: -2, error: 'Número inválido' })

  try {
    if (!state.clientReady) return res.status(503).json({ code: -4, error: 'Client not ready' })

    const registeredJid = await getRegisteredJid(numero)
    if (!registeredJid) return res.status(422).json({ code: -3, error: 'Número sin whatsapp' })

    const message = await enqueue(async () => sendText(registeredJid, texto))
    const idMensaje = message.id.id
    const chatId    = registeredJid

    esperas.set(chatId, idMensaje)
    resolvers.set(idMensaje, [])

    const timeoutId = setTimeout(() => {
      if (esperas.get(chatId) === idMensaje) {
        esperas.delete(chatId)
        esperas.delete(numero)
        resolvers.get(idMensaje)?.forEach(r => r(null))
        resolvers.delete(idMensaje)
      }
      timeouts.delete(idMensaje)
    }, 300000)
    timeouts.set(idMensaje, timeoutId)

    const fechaLocal = formatFechaFromMessage(message)
    res.json({ code: 0, id: message.id.id, ack: message.ack, from: message._data.from.user, to: message._data.to.user, time: fechaLocal, session: SESSION_ID })
  } catch (err) {
    console.error('❌ Error en /esperar:', err)
    res.status(500).json({ code: -5, error: 'Falló el envío' })
  }
})

router.get('/respuesta', async (req, res) => {
  const idMensaje = req.query.idMensaje || req.params.idMensaje
  if (!idMensaje) return res.status(400).json({ error: 'Falta idMensaje' })

  if (respuestas.has(idMensaje)) {
    const message    = respuestas.get(idMensaje)
    const fechaLocal = formatFechaFromMessage(message)
    return res.json({ id: message.id.id, message: message.body, from: message._data.from.user, to: message._data.to.user, time: fechaLocal, session: SESSION_ID })
  }

  const estaEsperando = Array.from(esperas.values()).some(v => v === idMensaje)
  if (!estaEsperando) return res.status(404).json({ error: 'Respuesta no encontrada' })

  const respuesta = await new Promise(resolve => {
    const list = resolvers.get(idMensaje) || []
    list.push(resolve)
    resolvers.set(idMensaje, list)
  })
  if (!respuesta) return res.status(404).json({ error: 'Tiempo agotado' })
  const { message } = respuesta
  const fechaLocal  = formatFechaFromMessage(message)
  return res.json({ id: message.id.id, message: message.body, from: message._data.from.user, to: message._data.to.user, time: fechaLocal, session: SESSION_ID })
})

router.get(['/estado/:id/:numero', '/estado'], async (req, res) => {
  const id     = req.params.id     || req.query.messageId || req.query.id
  const numero = req.params.numero || req.query.numero
  if (!numero || !id) return res.status(400).json({ code: -1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({ code: -2, error: 'Número inválido' })

  const jid = await getRegisteredJid(numero)
  if (!jid) return res.status(422).json({ code: -3, error: 'Número sin whatsapp' })

  try {
    const msg = getStoredMessage(jid, id)
    if (!msg) return res.status(400).json({ code: -4, error: 'Mensaje no encontrado' })

    // Leer ack actualizado directo de la DB (puede haber sido actualizado por messages.update)
    const row = db.prepare('SELECT ack FROM messages WHERE id = ? AND jid = ? LIMIT 1').get(id, jid)
    const norm       = normalizeBaileysMessage({ ...msg, key: { ...msg.key, remoteJid: jid } })
    if (row) norm.ack = row.ack
    const fechaLocal = formatFechaFromMessage(norm)
    res.json({ code: 0, id: norm.id.id, ack: norm.ack, from: norm.from, to: norm.to, time: fechaLocal, session: SESSION_ID })
  } catch (e) {
    console.error('Error en /estado:', e)
    res.status(500).json({ code: -5, error: 'Error interno' })
  }
})

router.get('/get_mensajes/:numero', async (req, res) => {
  const { numero } = req.params
  if (!numero) return res.status(400).json({ code: -1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({ code: -2, error: 'Número inválido' })

  const jid = await getRegisteredJid(numero)
  if (!jid) return res.status(422).json({ code: -3, error: 'Número sin whatsapp' })

  try {
    const msgs = getStoredMessagesByJid(jid).map(msg =>
      normalizeBaileysMessage({ ...msg, key: { ...msg.key, remoteJid: jid } })
    )
    res.json(msgs)
  } catch (e) {
    console.error('Error en /get_mensajes:', e)
    res.status(500).json({ code: -5, error: 'Error al obtener mensajes' })
  }
})

module.exports = router