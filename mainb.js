// main.queue.single-session.js — versión Baileys (reemplazo de whatsapp-web.js)
// Mantiene cola FIFO, endpoints y soporte de flows. Reintenta reconexión al desconectarse.

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys')

const express = require('express')
const multer  = require('multer')
const fs      = require('fs')
const mime    = require('mime-types')
const QRCode  = require('qrcode')
const qrcodeTerminal = require('qrcode-terminal')
const crypto  = require('crypto')
const path    = require('path')
const mustache = require('mustache')
const axios   = require('axios')
const { HttpsProxyAgent } = require('https-proxy-agent');
const agent = new HttpsProxyAgent(process.env.HTTPS_PROXY);

// pino no es necesario sin makeInMemoryStore

const upload = multer({ dest: 'uploads/' })
const app    = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

const SESSION_ID = process.env.SESSION_ID || 'default'
const PORT       = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005

console.log('🟢 Iniciando main.js (Baileys) — pid:', process.pid)
console.log('🔧 SESSION_ID:', SESSION_ID)

process.on('unhandledRejection', (reason, p) => console.error('Unhandled Rejection:', p, reason))
process.on('uncaughtException',  (err)         => console.error('Uncaught Exception:', err))

// ─── Estado global ──────────────────────────────────────────────────────────
let sock         = null   // socket Baileys activo
let clientReady  = false
let restarting   = false
let reconnecting = false
let reconnectAttempts = 0
const qrStore    = new Map()

// Mapas para el mecanismo esperar/respuesta
const esperas    = new Map()   // chatId  → idMensaje
const respuestas = new Map()   // idMensaje → message object normalizado
const resolvers  = new Map()   // idMensaje → [resolve, ...]
const timeouts   = new Map()   // idMensaje → timeoutId

// Flows activos
const activeFlows = new Map()

// ─── Persistencia SQLite ──────────────────────────────────────────────────────
// npm install better-sqlite3
const Database = require('better-sqlite3')
const db = new Database(path.join(__dirname, `messages_${SESSION_ID}.db`))

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id        TEXT NOT NULL,
    jid       TEXT NOT NULL,
    from_me   INTEGER NOT NULL DEFAULT 0,
    ack       INTEGER NOT NULL DEFAULT 0,
    timestamp INTEGER NOT NULL,
    body      TEXT,
    raw       TEXT NOT NULL,
    PRIMARY KEY (id, jid)
  );
  CREATE INDEX IF NOT EXISTS idx_jid ON messages(jid);
`)

const stmtUpsert = db.prepare(`
  INSERT INTO messages (id, jid, from_me, ack, timestamp, body, raw)
  VALUES (@id, @jid, @from_me, @ack, @timestamp, @body, @raw)
  ON CONFLICT(id, jid) DO UPDATE SET ack = excluded.ack, raw = excluded.raw
`)

const stmtGetById    = db.prepare(`SELECT * FROM messages WHERE id = ? AND jid = ? LIMIT 1`)
const stmtGetByMsgId = db.prepare(`SELECT * FROM messages WHERE id = ? LIMIT 1`)  // fallback sin jid
const stmtGetByJid   = db.prepare(`SELECT * FROM messages WHERE jid = ? AND from_me = 1 ORDER BY timestamp DESC LIMIT 100`)
const stmtUpdateAck  = db.prepare(`UPDATE messages SET ack = ? WHERE id = ?`)     // actualiza por id sin importar jid

/**
 * Normaliza JIDs de WhatsApp: quita el sufijo :XX@ (devices) y unifica @lid → @s.whatsapp.net
 * Ejemplos:
 *   "5493412345678:40@s.whatsapp.net" → "5493412345678@s.whatsapp.net"
 *   "90014125920268@lid"              → "90014125920268@lid"  (se guarda tal cual, pero updateAck busca solo por id)
 */
function normalizeJid(jid) {
  if (!jid) return jid
  // Quitar device suffix: "number:device@domain" → "number@domain"
  return jid.replace(/:\d+@/, '@')
}

function storeMessage(jid, msg) {
  if (!jid || !msg?.key?.id) return
  try {
    const body = msg.message?.conversation
               || msg.message?.extendedTextMessage?.text
               || msg.message?.imageMessage?.caption
               || msg.message?.videoMessage?.caption
               || ''
    stmtUpsert.run({
      id:        msg.key.id,
      jid:       normalizeJid(jid),
      from_me:   msg.key.fromMe ? 1 : 0,
      ack:       msg.status ?? 1,
      timestamp: Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000),
      body,
      raw:       JSON.stringify(msg),
    })
  } catch (e) {
    console.error('[storeMessage] error:', e.message)
  }
}

function getStoredMessage(jid, id) {
  try {
    // Primero intentar con jid normalizado
    const row = stmtGetById.get(id, normalizeJid(jid)) || stmtGetByMsgId.get(id)
    if (!row) return null
    return JSON.parse(row.raw)
  } catch (e) {
    console.error('[getStoredMessage] error:', e.message)
    return null
  }
}

function getStoredMessagesByJid(jid) {
  try {
    return stmtGetByJid.all(normalizeJid(jid)).map(row => JSON.parse(row.raw))
  } catch (e) {
    console.error('[getStoredMessagesByJid] error:', e.message)
    return []
  }
}

// Actualizar ACK — busca solo por id para no depender del JID (@lid vs @s.whatsapp.net)
function updateAck(id, jid, ack) {
  try {
    const changes = stmtUpdateAck.run(ack, id).changes
    if (changes === 0) {
      console.warn(`[updateAck] no se encontró mensaje id=${id} (jid=${jid})`)
    } else {
      console.log(`[updateAck] id=${id} → ack=${ack}`)
    }
  } catch (e) {
    console.error('[updateAck] error:', e.message)
  }
}

// ─── Cola FIFO ───────────────────────────────────────────────────────────────
const sendQueue = []
let processingQueue = false
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

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
      if (sendQueue.length > 0) {
        console.log('[queue] waiting 90 seconds...')
        await sleep(90 * 1000)
      }
    } catch (err) {
      item.reject(err)
      console.error('[queue] task failed:', err)
    }
  }

  processingQueue = false
  console.log('[queue] processQueue empty')
}

function waitForClientReady(timeout = 120000) {
  if (sock && clientReady) return Promise.resolve()
  return new Promise((resolve, reject) => {
    console.log('[waitForClientReady] esperando ready...')
    const timer = setTimeout(() => {
      reject(new Error('Timeout esperando client ready'))
    }, timeout)

    const interval = setInterval(() => {
      if (sock && clientReady) {
        clearInterval(interval)
        clearTimeout(timer)
        resolve()
      }
    }, 500)
  })
}

// ─── Helpers de JID / número ─────────────────────────────────────────────────
/**
 * Convierte número (ej: "5493412345678") a JID de WhatsApp ("5493412345678@s.whatsapp.net")
 */
function toJid(numero) {
  // Limpia cualquier sufijo que ya venga
  const clean = numero.replace(/[^0-9]/g, '')
  return `${clean}@s.whatsapp.net`
}

/**
 * Verifica si un número tiene WhatsApp usando onWhatsApp de Baileys.
 * Devuelve el JID real (puede ser @s.whatsapp.net o @lid) o null si no existe.
 */
async function getRegisteredJid(numero) {
  try {
    const [result] = await sock.onWhatsApp(numero)
    if (result && result.exists) return result.jid
    return null
  } catch (e) {
    console.warn('[getRegisteredJid] error:', e.message)
    return null
  }
}

// ─── Normalización de mensajes ────────────────────────────────────────────────
/**
 * Convierte un mensaje de Baileys al formato simplificado que usan
 * los resolvers / waitResponse (similar al objeto Message de wwjs).
 */
function normalizeBaileysMessage(msg) {
  const key       = msg.key || {}
  const msgId     = key.id || ''
  const fromJid   = key.remoteJid || ''
  const fromMe    = key.fromMe || false
  const body      = msg.message?.conversation
               || msg.message?.extendedTextMessage?.text
               || msg.message?.imageMessage?.caption
               || msg.message?.videoMessage?.caption
               || ''
  const ts        = msg.messageTimestamp
                  ? Number(msg.messageTimestamp)
                  : Math.floor(Date.now() / 1000)
  const fromUser  = fromJid.split('@')[0]
  const toUser    = fromMe
                  ? fromJid.split('@')[0]
                  : (sock?.user?.id?.split(':')[0] || '')

  return {
    id:        { id: msgId, fromMe },
    body,
    timestamp: ts,
    from:      fromJid,
    to:        fromMe ? fromJid : `${sock?.user?.id?.split(':')[0]}@s.whatsapp.net`,
    _data: {
      from: { user: fromMe ? (sock?.user?.id?.split(':')[0] || '') : fromUser },
      to:   { user: fromMe ? fromUser : (sock?.user?.id?.split(':')[0] || '') },
    },
    ack: msg.status ?? 1,
    _raw: msg,
  }
}

function formatFechaFromMessage(message) {
  const ts = message.timestamp || Math.floor(Date.now() / 1000)
  return new Date(ts * 1000).toLocaleString('sv-SE', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour12: false,
  }).replace(' ', 'T')
}

// ─── Envío de mensajes (wrappers sobre Baileys) ───────────────────────────────
/**
 * Envía un texto y devuelve un objeto normalizado compatible con el resto del código.
 */
async function sendText(jid, text) {
  const sent = await sock.sendMessage(jid, { text }, { timestamp: new Date() })
  const norm = normalizeBaileysMessage({ ...sent, key: { ...sent.key, remoteJid: jid } })
  storeMessage(jid, { ...sent, key: { ...sent.key, remoteJid: jid } })
  return norm
}

/**
 * Envía un archivo (base64) y devuelve un objeto normalizado.
 */
async function sendFile(jid, base64Data, mimeType, filename, caption = '') {
  const buffer = Buffer.from(base64Data, 'base64')
  let content
  if (mimeType.startsWith('image/')) {
    content = { image: buffer, caption, fileName: filename }
  } else if (mimeType.startsWith('video/')) {
    content = { video: buffer, caption, fileName: filename }
  } else if (mimeType.startsWith('audio/')) {
    content = { audio: buffer, mimetype: mimeType, fileName: filename }
  } else {
    content = { document: buffer, mimetype: mimeType, fileName: filename, caption }
  }
  const sent = await sock.sendMessage(jid, content)
  storeMessage(jid, { ...sent, key: { ...sent.key, remoteJid: jid } })
  return normalizeBaileysMessage({ ...sent, key: { ...sent.key, remoteJid: jid } })
}

// ─── Reconnect ───────────────────────────────────────────────────────────────
function attemptReconnect(sessionId) {
  if (reconnecting) return
  reconnecting = true
  reconnectAttempts = 0

  const tryOnce = async () => {
    reconnectAttempts++
    const waitMs = Math.min(30000, 2000 * reconnectAttempts)
    console.log(`🔁 Intento de reconexión #${reconnectAttempts} en ${waitMs}ms`)

    setTimeout(async () => {
      try {
        clientReady = false
        if (sock) {
          try { sock.end(undefined) } catch (e) { console.warn('sock.end error:', e.message) }
          sock = null
        }
        await initBaileys(sessionId)
        reconnecting = false
        reconnectAttempts = 0
      } catch (err) {
        console.error('Error durante reconexión:', err)
        if (reconnectAttempts < 10) tryOnce()
        else { console.error('🔻 Superados intentos de reconexión'); reconnecting = false }
      }
    }, waitMs)
  }

  tryOnce()
}

function restartProcess(reason) {
  if (restarting) return
  restarting = true
  console.error('♻ Reiniciando proceso:', reason)
  setTimeout(() => process.exit(1), 1000)
}

// ─── Inicialización Baileys ───────────────────────────────────────────────────
async function initBaileys(sessionId) {
  console.log(`🟡 Iniciando Baileys para sessionId=${sessionId}`)

  const authDir = path.join(__dirname, `.auth_${sessionId}`)
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()
  console.log(`ℹ️  Baileys version WA: ${version.join('.')}`)

  sock = makeWASocket({
    version,
    auth: state,
    agent,
    printQRInTerminal: false,
    logger: { level: 'silent', trace(){}, debug(){}, info(){}, warn: console.warn.bind(console), error: console.error.bind(console), child(){ return this } },
    browser: ['Chrome (Linux)', 'Chrome', '120.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.log(`📷 [${sessionId}] QR recibido`)
      try {
        qrcodeTerminal.generate(qr, { small: true })
        const qrDir = path.join(__dirname, 'qr')
        if (!fs.existsSync(qrDir)) fs.mkdirSync(qrDir, { recursive: true })
        const pngPath = path.join(qrDir, `${sessionId}.png`)
        await QRCode.toFile(pngPath, qr)
        const dataUrl = await QRCode.toDataURL(qr)
        qrStore.set(sessionId, dataUrl)
        console.log(`✅ QR guardado en ${pngPath}`)
      } catch (err) {
        console.error('❌ Error generando QR:', err)
      }
    }

    if (connection === 'open') {
      console.log(`✅ Cliente ${sessionId} conectado (open)`)
      clientReady = true
      reconnecting = false
      reconnectAttempts = 0
    }

    if (connection === 'close') {
      clientReady = false
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
            "http://localhost:4000/flow",
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
        const idMensajeEsperado = esperas.get(chatId) || esperas.get(numero)

        if (idMensajeEsperado) {

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
        }
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
setInterval(async () => {
  console.log('🕐 Chequeando estado de WhatsApp...')
  try {
    if (!sock || !clientReady) {
      console.warn('❌ Cliente NO ready')
      restartProcess('clientReady=false')
      return
    }
    // En Baileys no hay getState(), verificamos con readyState del WS
    const wsState = sock.ws?.readyState   // 1 = OPEN
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

// ─── Flows ───────────────────────────────────────────────────────────────────
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
    console.log("WEB",webhook)
    if (!webhook) return;
    console.log("SEND WEBHOOK")
    console.log(webhook)
    try {
        await axios.post(webhook, {
            session: SESSION_ID,
            ...data
        });
    } catch (e) {
        console.error("[webhook]", e.message);
    }
}


async function processFlowForChat(flowJson, numero, webhook, id) {

    const flowName = flowJson.id || "flow";
    const ctx = { vars: {} };

    // Puede venir un número o un JID
    const chatId = numero.includes("@")
        ? numero
        : toJid(numero);

    let nodeId = flowJson.start;

    activeFlows.set(chatId, {
        flowName,
        flowJson,
        nodeId,
        vars: ctx.vars,
        webhook,
        running: true,
    });

    try {

        while (nodeId) {

            const node = flowJson.nodes[nodeId];

            if (!node)
                throw new Error(`Nodo inexistente: ${nodeId}`);

            const text = mustache.render(
                node.template || "",
                ctx.vars
            );

            console.log("NODO", nodeId);
            console.log(node);

            // ============================================================
            // MESSAGE
            // ============================================================
            if (node.type === "message") {

                const sent = await enqueue(() => sendText(chatId, text));

                await sendWebhook(webhook, {
                    event: "outgoing_node",
                    flow: flowName,
                    nodeId,
                    id,
                    numero: chatId,
                    messageId: sent.id.id,
                    text,
                    vars: ctx.vars
                });

                const nextMap = node.next || {};

                nodeId =
                    nextMap.any ||
                    nextMap.default ||
                    null;

                if (activeFlows.has(chatId)) {
                    const af = activeFlows.get(chatId);
                    af.nodeId = nodeId;
                    af.vars = ctx.vars;
                    activeFlows.set(chatId, af);
                }

                continue;
            }

            // ============================================================
            // INPUT
            // ============================================================
            if (node.type === "input") {

                const sent = await enqueue(() => sendText(chatId, text));

                await sendWebhook(webhook, {
                    event: "input",
                    flow: flowName,
                    nodeId,
                    id,
                    numero: chatId,
                    messageId: sent.id.id,
                    text,
                    vars: ctx.vars
                });

                const incoming = await waitResponse(chatId, sent);

                if (!incoming) {
                    throw new Error(
                        `Timeout esperando respuesta en ${nodeId}`
                    );
                }

                const value = (incoming.body || "")
                    .toString()
                    .trim();

                ctx.vars.last_input = value;

                if (node.save) {
                    ctx.vars[node.save] = value;
                }

                await sendWebhook(webhook, {
                    event: "incoming_message",
                    flow: flowName,
                    nodeId,
                    id,
                    numero: chatId,
                    message: value,
                    vars: ctx.vars
                });

                const nextMap = node.next || {};

                nodeId =
                    nextMap.any ||
                    nextMap.default ||
                    Object.values(nextMap)[0] ||
                    null;

                if (activeFlows.has(chatId)) {
                    const af = activeFlows.get(chatId);
                    af.nodeId = nodeId;
                    af.vars = ctx.vars;
                    activeFlows.set(chatId, af);
                }

                continue;
            }

            // ============================================================
            // ROUTER
            // ============================================================
            if (node.type === "router") {

                const value = (ctx.vars.last_input || "")
                    .toString()
                    .trim()
                    .toLowerCase();

                let target = null;
                const routes = node.routes || {};

                for (const key of Object.keys(routes)) {
                    if (key.toLowerCase() === value) {
                        target = routes[key];
                        break;
                    }
                }

                if (!target) {
                    target = node.default || null;
                }

                if (!target) {
                    throw new Error(
                        `Router sin ruta para "${ctx.vars.last_input}"`
                    );
                }

                nodeId = target;

                if (activeFlows.has(chatId)) {
                    const af = activeFlows.get(chatId);
                    af.nodeId = nodeId;
                    af.vars = ctx.vars;
                    activeFlows.set(chatId, af);
                }

                continue;
            }

            // ============================================================
            // SCRIPT
            // ============================================================
            if (node.type === "script") {

                let result = {
                    next: "error"
                };

                if (node.url) {

                    try {

                        const resp = await axios.post(node.url, {
                            vars: ctx.vars,
                            numero: chatId,
                            flow: flowName,
                            nodeId
                        });

                        result = resp.data;

                    } catch (e) {

                        console.error(
                            `[script-url:${node.url}]`,
                            e.message
                        );

                    }

                } else if (node.script) {

                    try {

                        const scriptPath = path.join(
                            __dirname,
                            "scripts",
                            `${node.script}.js`
                        );

                        delete require.cache[
                            require.resolve(scriptPath)
                        ];

                        const script = require(scriptPath);

                        result = await script.run(
                            ctx.vars,
                            chatId
                        );

                    } catch (e) {

                        console.error(
                            `[script:${node.script}]`,
                            e
                        );

                    }

                } else {

                    console.warn(
                        `Nodo ${nodeId} no tiene script ni url`
                    );

                }

                if (result.vars) {
                    Object.assign(ctx.vars, result.vars);
                }

                await sendWebhook(webhook, {
                    event: "script_result",
                    flow: flowName,
                    nodeId,
                    id,
                    numero: chatId,
                    next: result.next,
                    vars: ctx.vars
                });

                const nextMap = node.next || {};

                nodeId =
                    nextMap[result.next] ||
                    nextMap.default ||
                    null;

                if (!nodeId) {

                    throw new Error(
                        `El script devolvió "${result.next}" pero no existe una transición`
                    );

                }

                if (activeFlows.has(chatId)) {
                    const af = activeFlows.get(chatId);
                    af.nodeId = nodeId;
                    af.vars = ctx.vars;
                    activeFlows.set(chatId, af);
                }

                continue;
            }

            console.warn(
                `Tipo de nodo desconocido: ${node.type}`
            );

            break;
        }

        await sendWebhook(webhook, {
            event: "flow_finished",
            flow: flowName,
            id,
            numero: chatId,
            vars: ctx.vars
        });

        return {
            ok: true,
            vars: ctx.vars
        };

    } catch (err) {

        console.error("[FLOW ERROR]", err);

        await sendWebhook(webhook, {
            event: "error",
            flow: flowName,
            id,
            numero: chatId,
            vars: ctx.vars,
            error: err.message
        });

        return {
            ok: false,
            error: err.message
        };

    } finally {

        activeFlows.delete(chatId);

    }
}





function generateId20() {
  return crypto.randomBytes(15).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

// ─── Endpoints ───────────────────────────────────────────────────────────────
app.get('/qr', async (req, res) => {
  try {
    const qrDir  = path.join(__dirname, 'qr')
    const pngPath = path.join(qrDir, `${SESSION_ID}.png`)
    if (fs.existsSync(pngPath)) return res.sendFile(path.resolve(pngPath))
    return res.status(400).json({ error: 'QR no encontrado para la sesión configurada' })
  } catch (err) {
    console.error('Error en /qr:', err)
    return res.status(500).json({ error: 'Error interno al servir QR' })
  }
})

app.get('/status', async (req, res) => {
  try {
    if (!sock) return res.status(400).json({ error: `Client for session '${SESSION_ID}' not found` })

    const wsState = sock.ws?.readyState
    const state   = wsState === 1 ? 'CONNECTED' : 'DISCONNECTED'
    const user    = sock.user || null

    return res.json({
      session: SESSION_ID,
      state,
      me: user ? { wid: user.id?.split(':')[0], pushName: user.name } : null,
    })
  } catch (error) {
    console.error('Error in /status:', error)
    return res.status(500).json({ error: 'Internal server error' })
  }
})

app.post('/start_flow', upload.none(), async (req, res) => {
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

app.post('/enviar-mensaje', upload.none(), async (req, res) => {
  const { numero, texto } = req.body
  if (!numero || !texto) return res.status(400).json({ code: -1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({ code: -2, error: 'Número inválido' })

  try {
    if (!clientReady) return res.status(503).json({ code: -4, error: 'Client not ready.' })

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

app.post('/enviar-archivo', upload.single('archivo'), async (req, res) => {
  const { numero, texto = '' } = req.body
  const filePath    = req.file?.path
  const originalName = req.file?.originalname
  if (!numero || !filePath) return res.status(400).json({ code: -1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({ code: -2, error: 'Número inválido' })

  try {
    if (!clientReady) return res.status(503).json({ code: -4, error: 'Client not ready' })

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

app.post('/enviar-ubicacion', upload.none(), async (req, res) => {
  const { numero, lat, lon } = req.body
  if (!numero || !lat || !lon) return res.status(400).json({ code: -1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({ code: -2, error: 'Número inválido' })

  try {
    if (!clientReady) return res.status(503).json({ code: -4, error: 'Client not ready' })

    const jid = await getRegisteredJid(numero)
    if (!jid) return res.status(422).json({ code: -3, error: 'Número sin whatsapp' })

    const result = await enqueue(async () => {
      // Baileys soporta mensajes de ubicación nativos
      const sent = await sock.sendMessage(jid, {
        location: { degreesLatitude: parseFloat(lat), degreesLongitude: parseFloat(lon) },
      })
      return normalizeBaileysMessage({ ...sent, key: { ...sent.key, remoteJid: jid } })
    })
    const fechaLocal = formatFechaFromMessage(result)
    res.json({ code: 0, id: result.id.id, status: 'OK', from: result._data.from.user, to: result._data.to.user, time: fechaLocal, session: SESSION_ID })
  } catch (err) {
    console.error('❌ Error al enviar ubicación:', err)
    attemptReconnect(SESSION_ID)
    res.status(500).json({ code: -5, error: 'Falló el envío' })
  }
})

app.post('/esperar', upload.none(), async (req, res) => {
  const { numero, texto } = req.body
  if (!numero || !texto) return res.status(400).json({ code: -1, error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(400).json({ code: -2, error: 'Número inválido' })

  const jid = toJid(numero)

  try {
    if (!clientReady) return res.status(503).json({ code: -4, error: 'Client not ready' })

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

app.get('/respuesta', async (req, res) => {
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

app.get(['/estado/:id/:numero', '/estado'], async (req, res) => {
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

app.get('/get_mensajes/:numero', async (req, res) => {
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

// ─── Arranque ─────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor escuchando en http://0.0.0.0:${PORT}`)
})

initBaileys(SESSION_ID).catch(err => {
  console.error('Error en initBaileys inicial:', err)
})