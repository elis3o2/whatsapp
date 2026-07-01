// baileysClient.js — Inicialización del socket Baileys, reconexión y listeners de eventos.

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys')

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const QRCode = require('qrcode')
const qrcodeTerminal = require('qrcode-terminal')
const { HttpsProxyAgent } = require('https-proxy-agent')

const { state } = require('./state')
const { storeMessage, updateAck, getStoredMessage } = require('./messageStore')
const { normalizeBaileysMessage } = require('./messageUtils')
const { loadFlowByName, processFlowForChat, resolveIncomingForWait } = require('./flowEngine')

const agent = new HttpsProxyAgent(process.env.HTTPS_PROXY)

function restartProcess(reason) {
  if (state.restarting) return
  state.restarting = true
  console.error('♻ Reiniciando proceso:', reason)
  setTimeout(() => process.exit(1), 1000)
}

function attemptReconnect(sessionId) {
  if (state.reconnecting) return
  state.reconnecting = true
  state.reconnectAttempts = 0

  const tryOnce = async () => {
    state.reconnectAttempts++
    const waitMs = Math.min(30000, 2000 * state.reconnectAttempts)
    console.log(`🔁 Intento de reconexión #${state.reconnectAttempts} en ${waitMs}ms`)

    setTimeout(async () => {
      try {
        state.clientReady = false
        if (state.sock) {
          try { state.sock.end(undefined) } catch (e) { console.warn('sock.end error:', e.message) }
          state.sock = null
        }
        await initBaileys(sessionId)
        state.reconnecting = false
        state.reconnectAttempts = 0
      } catch (err) {
        console.error('Error durante reconexión:', err)
        if (state.reconnectAttempts < 10) tryOnce()
        else { console.error('🔻 Superados intentos de reconexión'); state.reconnecting = false }
      }
    }, waitMs)
  }

  tryOnce()
}

async function initBaileys(sessionId) {
  console.log(`🟡 Iniciando Baileys para sessionId=${sessionId}`)

  const authDir = path.join(__dirname, '..', `.auth_${sessionId}`)
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true })

  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()
  console.log(`ℹ️  Baileys version WA: ${version.join('.')}`)

  const sock = makeWASocket({
    version,
    auth: authState,
    agent,
    printQRInTerminal: false,
    logger: { level: 'silent', trace(){}, debug(){}, info(){}, warn: console.warn.bind(console), error: console.error.bind(console), child(){ return this } },
    browser: ['Chrome (Linux)', 'Chrome', '120.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  })

  state.sock = sock

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log(`📷 [${sessionId}] QR recibido`)
      try {
        qrcodeTerminal.generate(qr, { small: true })
        const qrDir = path.join(__dirname, '..', 'qr')
        if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true })
        const pngPath = path.join(qrDir, `${sessionId}.png`)
        await QRCode.toFile(pngPath, qr)
        const dataUrl = await QRCode.toDataURL(qr)
        state.qrStore.set(sessionId, dataUrl)
        console.log(`✅ QR guardado en ${pngPath}`)
      } catch (err) {
        console.error('❌ Error generando QR:', err)
      }
    }

    if (connection === 'open') {
      console.log(`✅ Cliente ${sessionId} conectado (open)`)
      state.clientReady = true
      state.reconnecting = false
      state.reconnectAttempts = 0
    }

    if (connection === 'close') {
      state.clientReady = false
      const code   = lastDisconnect?.error?.output?.statusCode
      const reason = DisconnectReason[code] || code
      console.warn(`⚠️ Conexión cerrada: ${reason} (${code})`)
      if (code === DisconnectReason.loggedOut) {
        console.error('❌ Sesión cerrada (loggedOut). Escaneá el QR nuevamente.')
        try { fs.rmSync(authDir, { recursive: true, force: true }) } catch (e) {}
      }
      attemptReconnect(sessionId)
    }
  })

  // ── Mensajes entrantes + persistencia ─────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {

    for (const msg of messages) {
      const jid = msg.key?.remoteJid
      if (jid) storeMessage(jid, msg)
    }

    if (type !== 'notify') return

    for (const msg of messages) {

      if (msg.key.fromMe) continue

      const norm = normalizeBaileysMessage(msg)
      const chatId = msg.key.remoteJid || ''
      const numero = chatId.split('@')[0]
      const texto = (norm.body || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase()

      // ─────────────────────────────────────────────
      // 🟢 TRIGGER FLOW POR MENSAJE ESPECIAL
      // ─────────────────────────────────────────────
      if (texto === '¡hola! este es mi primer mensaje.') {

        try {

          // 2. Cargar flow
          const flow = loadFlowByName('nuevo-paciente')

          // 3. Ejecutar flow
          await processFlowForChat(
            flow,
            chatId,              // 👈 importante: Baileys usa jid directo
            'http://localhost:3000/recibir-datos',
            crypto.randomUUID()
          )

          return

        } catch (e) {
          console.error('Error iniciando flow:', e)
        }
      }

      // ─────────────────────────────────────────────
      // Resolver esperas (input flows)
      // ─────────────────────────────────────────────
      resolveIncomingForWait(chatId, numero, norm)
    }
  })

  // ── ACK / recibo de entrega y lectura ──────────────────────────────────────
  // message-receipt.update llega cuando el destinatario recibe o lee el mensaje
  sock.ev.on('message-receipt.update', (updates) => {
    for (const { key, receipt } of updates) {
      const jid = key.remoteJid
      if (!jid || !key.id) continue
      // receipt.receiptTimestamp → leído; receipt.readTimestamp → idem en algunos clientes
      const ack = receipt.readTimestamp ? 3
        : receipt.receiptTimestamp ? 2
        : 1
      updateAck(key.id, jid, ack)
    }
  })

  // messages.update llega cuando WhatsApp actualiza el status de un mensaje propio
  sock.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      const jid = key.remoteJid
      if (!jid || !key.id) continue
      if (update.status !== undefined) {
        updateAck(key.id, jid, update.status)
        // Actualizar también el raw almacenado
        const existing = getStoredMessage(jid, key.id)
        if (existing) {
          existing.status = update.status
          storeMessage(jid, existing)
        }
      }
    }
  })
}

// ─── Chequeo periódico ────────────────────────────────────────────────────────
function startHealthCheck(sessionId) {
  setInterval(async () => {
    console.log('🕐 Chequeando estado de WhatsApp...')
    try {
      if (!state.sock || !state.clientReady) {
        console.warn('❌ Cliente NO ready')
        restartProcess('clientReady=false')
        return
      }
      // En Baileys no hay getState(), verificamos con readyState del WS
      const wsState = state.sock.ws?.readyState   // 1 = OPEN
      if (wsState !== 1) {
        console.warn('❌ WebSocket no está OPEN:', wsState)
        restartProcess(`wsState=${wsState}`)
        return
      }
      console.log('✅ WhatsApp OK')
    } catch (err) {
      console.error('❌ Error chequeando estado:', err.message)
      restartProcess(err.message)
    }
  }, 60 * 60 * 1000)
}

module.exports = {
  initBaileys,
  attemptReconnect,
  restartProcess,
  startHealthCheck,
}