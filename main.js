// main-queue.js (versión modificada: servidor primero, QR accesible por red)
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js')
const express = require('express')
const multer = require('multer')
const fs = require('fs')
const mime = require('mime-types')
const QRCode = require('qrcode')
const qrcodeTerminal = require('qrcode-terminal')
const path = require('path')
const cors = require('cors')

const upload = multer({ dest: 'uploads/' })
const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cors()) // permite peticiones desde otras máquinas si hace falta

// --- CONFIG -----------------------------------------------------------------
const sessionIds = ['numero1', 'numero2']   // ajustá según necesites
let currentSessionIndex = 0
let client = null

// Mapas para el endpoint esperar / respuesta
const esperas = new Map()
const respuestas = new Map()
const resolvers = new Map()
const timeouts = new Map()

// Guardar el último QR (Data URL) por sessionId para servirlo rápidamente
const qrStore = new Map()

// --------------------------- LOGS GLOBALES ---------------------------
console.log('🟢 Iniciando main.js (con colas) — pid:', process.pid)

process.on('unhandledRejection', (reason, p) => {
  console.error('Unhandled Rejection at Promise', p, 'reason:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err)
})

// --------------------------- TASK QUEUE (SERIAL) ---------------------------
class TaskQueue {
  constructor() {
    this.queue = []
    this.processing = false
  }

  enqueue(fn, { timeoutMs = 30000 } = {}) {
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject, timeoutMs }
      this.queue.push(job)
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

const sendQueue = new TaskQueue()

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

  // QR: guardamos DataURL en memoria y también escribimos png para compatibilidad
  newClient.on('qr', async (qr) => {
    console.log(`📷 [${sessionId}] Evento QR recibido. Generando terminal + archivo + dataURL...`)
    qrcodeTerminal.generate(qr, { small: true })

    try {
      // Data URL (base64 png)
      const dataUrl = await QRCode.toDataURL(qr)
      qrStore.set(sessionId, dataUrl)

      // También guardamos como png en disco (para /qr/:sessionId si prefieres archivo)
      const base64Data = dataUrl.split(',')[1]
      const filePath = path.join(__dirname, `qr-${sessionId}.png`)
      fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'))
      console.log(`✅ QR guardado como qr-${sessionId}.png y en memoria`)
    } catch (err) {
      console.error(`❌ Error generando/salvando QR para ${sessionId}:`, err)
    }
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

  // ya no intento bindear el puerto aquí (serverListener controla eso al inicio)
}

// --------------------------- INICIALIZACIÓN ---------------------------
let serverListening = false
const PORT = 3005
const HOST = '0.0.0.0'

// Iniciamos primero el servidor para que el QR sea accesible desde otras máquinas
if (!serverListening) {
  app.listen(PORT, HOST, () => {
    serverListening = true
    console.log(`🚀 Servidor escuchando en http://${HOST}:${PORT}`)
    // una vez que el servidor esté arriba, inicializamos el cliente
    try {
      console.log('➡️ Creando cliente inicial...')
      client = createClient(sessionIds[currentSessionIndex])

      console.log('➡️ Inicializando cliente (initialize)...')
      client.initialize()
    } catch (e) {
      console.error('Error al client.initialize():', e)
    }
  })
}

// ---------------------- HELPERS ------------------------------------------------
function formatFechaLocalFromTs(ts) {
  return new Date(ts * 1000).toLocaleString('sv-SE', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour12: false
  }).replace(' ', 'T')
}

async function enqueueSendOperation(fn, opts = {}) {
  try {
    return await sendQueue.enqueue(async () => {
      if (!client) throw new Error('Cliente no inicializado')
      return await fn()
    }, opts)
  } catch (err) {
    console.error('Error en operación encolada:', err)
    try { failover() } catch(e){ console.error('Failover fallo:', e) }
    throw err
  }
}

function safeUnlinkSync(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p) } catch (e) { console.warn('safeUnlink error', e) }
}

// ---------------------- ENDPOINTS (igual que antes, con /qr y un viewer) ------------------------------

// ... (mismos endpoints que ya tenías: /enviar-mensaje, /enviar-archivo, /enviar-ubicacion,
// /esperar, /respuesta/:idMensaje, /estado, /get_mensajes/:numero, /health)
// Para ahorrar espacio no los repito aquí; mantén exactamente los handlers que tenías.
// Asegurate de copiar los handlers previos entre este comentario y el endpoint QR abajo.

// Servir archivo PNG del QR (si existe)
app.get('/qr/:sessionId', (req, res) => {
  const { sessionId } = req.params
  const filePath = path.join(__dirname, `qr-${sessionId}.png`)
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath)
  } else {
    res.status(404).send('QR no encontrado')
  }
})

// Viewer amigable para escanear desde otra máquina (muestra la imagen embebida)
app.get('/qr-view/:sessionId', (req, res) => {
  const { sessionId } = req.params
  const dataUrl = qrStore.get(sessionId)
  if (dataUrl) {
    const html = `
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8"/>
          <title>QR - ${sessionId}</title>
          <style>
            body { font-family: Arial, sans-serif; display:flex; flex-direction:column; align-items:center; justify-content:center; height:100vh; gap:10px; }
            .card { padding:16px; border-radius:8px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); text-align:center; }
            img { width: 320px; height: 320px; object-fit:contain; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>QR para ${sessionId}</h2>
            <p>Escaneá este QR con WhatsApp Web (o la app que corresponda).</p>
            <img src="${dataUrl}" alt="QR"/>
            <p><small>Actualiza la página si el QR caduca (se regenerará en el servidor).</small></p>
          </div>
        </body>
      </html>
    `
    res.set('Content-Type', 'text/html')
    res.send(html)
  } else {
    res.status(404).send('QR no disponible aún. Esperá a que se genere y recargá esta URL.')
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
