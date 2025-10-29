// main-queue.js
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js')
const express = require('express')
const multer = require('multer')
const fs = require('fs')
const mime = require('mime-types')
const QRCode = require('qrcode')
const qrcodeTerminal = require('qrcode-terminal')
const path = require('path')

const upload = multer({ dest: 'uploads/' })
const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// --- CONFIG -----------------------------------------------------------------
const sessionIds = ['numero1', 'numero2']   // ajustá según necesites
let currentSessionIndex = 0
let client = null

// Mapas para el endpoint esperar / respuesta (mantengo tu lógica)
const esperas = new Map()
const respuestas = new Map()
const resolvers = new Map()
const timeouts = new Map()

// --------------------------- LOGS GLOBALES ---------------------------
console.log('🟢 Iniciando main.js (con colas) — pid:', process.pid)

process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at Promise', p, 'reason:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err)
})

// --------------------------- TASK QUEUE (SERIAL) ---------------------------
// Cola simple en memoria que ejecuta tareas de una en una.
// Cada "job" debe ser una función async que retorne un valor o lance error.
class TaskQueue {
  constructor() {
    this.queue = []
    this.processing = false
  }

  enqueue(fn, { timeoutMs = 30000 } = {}) {
    // fn es async function () => { ... }
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject, timeoutMs, timer: null }
      this.queue.push(job)
      // iniciar procesamiento (si no está en curso)
      this._process().catch(err => {
        console.error('Error en task queue processing loop:', err)
      })
    })
  }

  async _process() {
    if (this.processing) return
    this.processing = true
    while (this.queue.length) {
      const job = this.queue.shift()
      try {
        // envolver ejecución con timeout si se pide
        const result = await this._runWithTimeout(job.fn, job.timeoutMs)
        job.resolve(result)
      } catch (err) {
        job.reject(err)
      }
    }
    this.processing = false
  }

  _runWithTimeout(fn, ms) {
    return new Promise((resolve, reject) => {
      let finished = false
      const timer = setTimeout(() => {
        if (finished) return
        finished = true
        reject(new Error(`Job timed out after ${ms}ms`))
      }, ms)

      fn().then(r => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        resolve(r)
      }).catch(e => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        reject(e)
      })
    })
  }
}

// Cola global para operaciones que tocan al cliente (envíos)
const sendQueue = new TaskQueue()

// --------------------------- CREAR CLIENTE ---------------------------
const createClient = (sessionId) => {
  console.log(`🟡 Creando cliente para sessionId=${sessionId}`)
  const newClient = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }), // considerá dataPath si querés controlar carpeta
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  })

  newClient.on('qr', (qr) => {
    console.log(`📷 [${sessionId}] Evento QR recibido. Generando terminal + archivo...`)
    qrcodeTerminal.generate(qr, { small: true })
    QRCode.toFile(`./qr-${sessionId}.png`, qr, {}, err => {
      if (err) console.error(`❌ Error al guardar QR de ${sessionId}:`, err)
      else console.log(`✅ QR guardado como qr-${sessionId}.png`)
    })
  })

  newClient.on('loading_screen', (percent, message) => {
    console.log(`[${sessionId}] loading_screen ${percent}% — ${message}`)
  })

  newClient.on('ready', () => {
    console.log(`✅ Cliente ${sessionId} listo`)
  })

  newClient.on('auth_failure', (msg) => {
    console.error(`❌ Fallo de autenticación para ${sessionId}:`, msg || '(sin msg)')
  })

  newClient.on('disconnected', reason => {
    console.warn(`⚠️ ${sessionId} desconectado: ${reason}`)
    failover()
  })

  newClient.on('message', async (message) => {
    console.log(`[${sessionId}] mensaje de ${message.from}: ${message.body?.slice(0,100)}`)
    const chatId = message.from
    if (esperas.has(chatId)) {
      const idMensaje = esperas.get(chatId)
      respuestas.set(idMensaje, message)
      esperas.delete(chatId)
      if (resolvers.has(idMensaje)) {
        resolvers.get(idMensaje).forEach(r => r({ message }))
        resolvers.delete(idMensaje)
      }
      if (timeouts.has(idMensaje)) {
        clearTimeout(timeouts.get(idMensaje))
        timeouts.delete(idMensaje)
      }
    }
  })

  return newClient
}

// --------------------------- FAILOVER ---------------------------
const failover = () => {
  console.log('🔁 Ejecutando failover...')
  try {
    if (client) {
      console.log('🔴 Destruyendo cliente actual...')
      client.destroy().catch(e => console.error('Error al destroy client:', e))
    }
  } catch (e) {
    console.error('Error en destroy:', e)
  }

  currentSessionIndex = (currentSessionIndex + 1) % sessionIds.length
  const newSession = sessionIds[currentSessionIndex]
  console.log(`🔄 Cambiando a la sesión: ${newSession}`)
  client = createClient(newSession)

  try {
    client.initialize()
  } catch (e) {
    console.error('Error al initialize en failover:', e)
  }

  client.once('ready', () => {
    try {
      if (!serverListening) {
        serverListening = true
        app.listen(3005, '0.0.0.0', () => {
          console.log('🚀 Servidor escuchando en http://localhost:3005')
        })
      } else {
        console.log('Servidor ya estaba escuchando — no intento bindear otra vez')
      }
    } catch (e) {
      console.error('Error al iniciar express en failover:', e)
    }
  })
}

// --------------------------- INICIALIZACIÓN ---------------------------
let serverListening = false

console.log('➡️ Creando cliente inicial...')
client = createClient(sessionIds[currentSessionIndex])

console.log('➡️ Inicializando cliente (initialize)...')
try {
  client.initialize()
} catch (e) {
  console.error('Error al client.initialize():', e)
}

client.once('ready', () => {
  console.log('✅ Evento ready recibido (main). Inicializando servidor Express...')
  if (!serverListening) {
    serverListening = true
    app.listen(3005, '0.0.0.0', () => {
      console.log('🚀 Servidor escuchando en http://localhost:3005')
    })
  } else {
    console.log('Servidor ya estaba escuchando')
  }
})

// ---------------------- HELPERS ------------------------------------------------
function formatFechaLocalFromTs(ts) {
  return new Date(ts * 1000).toLocaleString('sv-SE', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour12: false
  }).replace(' ', 'T')
}

// wrapper que encola una función que hace client.sendMessage (o similar)
async function enqueueSendOperation(fn, opts = {}) {
  // fn: async () => { ... } — debe ejecutar client.* y retornar lo que necesites
  try {
    return await sendQueue.enqueue(async () => {
      // chequeo rápido que client esté listo
      if (!client) throw new Error('Cliente no inicializado')
      return await fn()
    }, opts)
  } catch (err) {
    // en error crítico intentamos failover para recuperar sesión
    console.error('Error en operación encolada:', err)
    try { failover() } catch(e){ console.error('Failover fallo:', e) }
    throw err
  }
}

// safe unlink (evita crash si no existe)
function safeUnlinkSync(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p) } catch (e) { console.warn('safeUnlink error', e) }
}

// ---------------------- ENDPOINTS (usando colas) ------------------------------

// ENVIAR MENSAJE (texto)
app.post('/enviar-mensaje', upload.none(), async (req, res) => {
  const { numero, texto } = req.body
  if (!numero || !texto) return res.status(400).json({ error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(404).json({ error: 'Número inválido' })

  const chatId = `${numero}@c.us`

  // preparamos la tarea que se ejecutará EN LA COLA
  const task = async () => {
    const message = await client.sendMessage(chatId, texto)
    return {
      id: message.id.id,
      ack: message.ack,
      from: message._data.from?.user,
      to: message._data.to?.user,
      time: formatFechaLocalFromTs(message.timestamp)
    }
  }

  try {
    const resultado = await enqueueSendOperation(task, { timeoutMs: 45000 })
    return res.json(resultado)
  } catch (err) {
    console.error('❌ Error al enviar mensaje (encolado):', err)
    return res.status(500).json({ error: 'Falló el envío del mensaje' })
  }
})

// ENVIAR ARCHIVO (multipart form)
app.post('/enviar-archivo', upload.single('archivo'), async (req, res) => {
  const { numero, texto = '' } = req.body
  const filePath = req.file?.path
  const originalName = req.file?.originalname

  if (!numero || !filePath) {
    safeUnlinkSync(filePath)
    return res.status(400).json({ error: 'Faltan datos' })
  }
  if (numero.length !== 13) {
    safeUnlinkSync(filePath)
    return res.status(404).json({ error: 'Número inválido' })
  }

  // Leemos el archivo y generamos MessageMedia fuera de la cola (no bloquea cliente)
  let media
  try {
    const mimeType = mime.lookup(originalName) || 'application/octet-stream'
    const base64 = fs.readFileSync(filePath, 'base64')
    media = new MessageMedia(mimeType, base64, originalName)
  } catch (err) {
    safeUnlinkSync(filePath)
    console.error('❌ Error leyendo archivo:', err)
    return res.status(500).json({ error: 'Error al procesar archivo' })
  }

  const chatId = `${numero}@c.us`

  const task = async () => {
    const message = await client.sendMessage(chatId, media, { caption: texto })
    return {
      id: message.id.id,
      status: 'OK',
      from: message._data.from?.user,
      to: message._data.to?.user,
      time: formatFechaLocalFromTs(message.timestamp)
    }
  }

  try {
    const resultado = await enqueueSendOperation(task, { timeoutMs: 120000 })
    safeUnlinkSync(filePath)
    return res.json(resultado)
  } catch (err) {
    safeUnlinkSync(filePath)
    console.error('❌ Error al enviar archivo (encolado):', err)
    return res.status(500).json({ error: 'Falló el envío del archivo' })
  }
})

// ENVIAR UBICACIÓN
app.post('/enviar-ubicacion', upload.none(), async (req, res) => {
  const { numero, lat, lon } = req.body
  if (!numero || !lat || !lon) return res.status(400).json({ error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(404).json({ error: 'Número inválido' })

  const chatId = `${numero}@c.us`
  const location = `https://maps.google.com/maps?q=${lat},${lon}&z=17&hl=en`

  const task = async () => {
    const message = await client.sendMessage(chatId, location)
    return {
      id: message.id.id,
      status: 'OK',
      from: message._data.from?.user,
      to: message._data.to?.user,
      time: formatFechaLocalFromTs(message.timestamp)
    }
  }

  try {
    const resultado = await enqueueSendOperation(task, { timeoutMs: 45000 })
    return res.json(resultado)
  } catch (err) {
    console.error('❌ Error al enviar ubicación (encolado):', err)
    return res.status(500).json({ error: 'Falló el envío de la ubicación' })
  }
})

// ESPERAR (envía un mensaje y registra la espera; NO bloquea la cola esperando la respuesta)
app.post('/esperar', upload.none(), async (req, res) => {
  const { numero, texto } = req.body
  if (!numero || !texto) return res.status(400).json({ error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(404).json({ error: 'Número inválido' })

  const chatId = `${numero}@c.us`

  // La tarea que envía el mensaje va encolada, pero la espera por la respuesta NO debe bloquear la cola.
  const task = async () => {
    const message = await client.sendMessage(chatId, texto)
    return message
  }

  try {
    const message = await enqueueSendOperation(task, { timeoutMs: 45000 })
    const idMensaje = message.id?.id || (message.id && message.id._serialized) || null

    // Guardar la espera y preparar resolvers/timeouts — esto NO está en la cola.
    if (idMensaje) {
      esperas.set(chatId, idMensaje)
      resolvers.set(idMensaje, [])

      const timeoutId = setTimeout(() => {
        if (esperas.get(chatId) === idMensaje && !respuestas.has(idMensaje)) {
          esperas.delete(chatId)
          resolvers.get(idMensaje)?.forEach(r => r(null))
          resolvers.delete(idMensaje)
        }
        timeouts.delete(idMensaje)
      }, 300000) // 5 minutos

      timeouts.set(idMensaje, timeoutId)
    }

    const fechaLocal = formatFechaLocalFromTs(message.timestamp)
    return res.json({ id: idMensaje, ack: message.ack, from: message._data.from?.user, to: message._data.to?.user, time: fechaLocal })
  } catch (err) {
    console.error('❌ Error en /esperar (encolado):', err)
    return res.status(500).json({ error: 'Falló el envío del mensaje' })
  }
})

// RESPUESTA: consulta si hay respuesta (mantengo tu lógica)
app.get('/respuesta/:idMensaje', async (req, res) => {
  const idMensaje = req.params.idMensaje
  if (respuestas.has(idMensaje)) {
    const message = respuestas.get(idMensaje)
    const fechaLocal = formatFechaLocalFromTs(message.timestamp)
    return res.json({
      id: message.id.id,
      message: message.body,
      from: message._data.from?.user,
      to: message._data.to?.user,
      time: fechaLocal
    })
  }

  const estaEsperando = Array.from(esperas.entries()).some(([, v]) => v === idMensaje)

  if (!estaEsperando) {
    return res.status(404).json({ error: 'Respuesta no encontrada' })
  }

  // Esperamos respuesta o timeout (esto usa tu sistema de resolvers)
  const respuesta = await new Promise(resolve => {
    resolvers.get(idMensaje).push(resolve)
  })

  if (!respuesta) {
    return res.status(404).json({ error: 'Tiempo agotado' })
  }

  const { message } = respuesta
  const fechaLocal = formatFechaLocalFromTs(message.timestamp)
  return res.json({
    id: message.id.id,
    message: message.body,
    from: message.from,
    to: message.to,
    time: fechaLocal
  })
})

// ESTADO: consulta ack/time via fetchMessages (lecturas, no encoladas)
app.get('/estado', async (req, res) => {
  const id = req.query.id
  const numero = req.query.numero

  if (!numero || !id) return res.status(400).json({ error: 'Faltan datos' })
  if (numero.length !== 13) return res.status(404).json({ error: 'Número inválido' })

  try {
    const chat = await client.getChatById(`${numero}@c.us`)
    const messages = await chat.fetchMessages({ limit: 50, fromMe: true })
    const message = messages.find(m => m.id.id === id)

    if (!message) return res.status(404).json({ error: 'Mensaje no encontrado' })

    const fechaLocal = formatFechaLocalFromTs(message.timestamp)
    return res.json({ id: message.id.id, ack: message.ack, from: message.from, to: message.to, time: fechaLocal })
  } catch (err) {
    console.error('❌ Error en /estado:', err)
    return res.status(500).json({ error: 'Error al consultar estado' })
  }
})

// GET_MENSAJES: lecturas (no encoladas)
app.get('/get_mensajes/:numero', async (req, res) => {
  const numero = req.params.numero
  if (!numero) return res.status(400).json({ error: 'Faltan datos' })

  try {
    const chat = await client.getChatById(`${numero}@c.us`)
    const mensajes = await chat.fetchMessages({ limit: 20 })
    return res.json(mensajes)
  } catch (err) {
    console.error('❌ Error en /get_mensajes:', err)
    return res.status(500).json({ error: 'Error al obtener mensajes' })
  }
})

// HEALTH (útil para nginx/monitoring)
app.get('/health', (req, res) => {
  if (client && client.info && client.info.wid) {
    return res.json({ status: 'ok', client: client.info.wid._serialized })
  } else {
    return res.json({ status: 'starting' })
  }
})

// Servir archivos QR por navegador
app.get('/qr/:sessionId', (req, res) => {
  const { sessionId } = req.params
  const filePath = path.join(__dirname, `qr-${sessionId}.png`)
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath)
  } else {
    res.status(404).send('QR no encontrado')
  }
})

// ---------------------- CIERRE GRACIOSO -------------------------------
process.on('SIGINT', async () => {
  console.log('SIGINT recibido — cerrando...')
  try {
    if (client) await client.destroy()
  } catch (e) { console.error('Error al destruir client:', e) }
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('SIGTERM recibido — cerrando...')
  try {
    if (client) await client.destroy()
  } catch (e) { console.error('Error al destruir client:', e) }
  process.exit(0)
})
