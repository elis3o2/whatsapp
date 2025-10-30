// main.queue.js (versión con cola y endpoint de QR)
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js')
const express = require('express')
const multer = require('multer')
const fs = require('fs')
const mime = require('mime-types')
const QRCode = require('qrcode')
const qrcodeTerminal = require('qrcode-terminal')

const upload = multer({ dest: 'uploads/' })
const app = express()

app.use(express.json())
app.use(express.urlencoded({ extended: true }))

const sessionIds = ['numero1', 'numero2']
let currentSessionIndex = 0
let client = null
let clientReady = false

const esperas = new Map()
const respuestas = new Map()
const resolvers = new Map()
const timeouts = new Map()

// Almacenamos el último QR en base64 para poder servirlo por HTTP desde otra máquina.
const qrStore = new Map() // sessionId => dataUrl

// --------------------------- LOGS GLOBALES ---------------------------
console.log('🟢 Iniciando main.queue.js — pid:', process.pid)

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
    sendQueue.push({ taskFn, resolve, reject })
    processQueue().catch(err => console.error('Error en processQueue:', err))
  })
}

async function processQueue() {
  if (processingQueue) return
  processingQueue = true
  while (sendQueue.length > 0) {
    const item = sendQueue.shift()
    try {
      // cada tarea espera a que el cliente esté listo
      await waitForClientReady()
      const result = await item.taskFn()
      item.resolve(result)
    } catch (err) {
      item.reject(err)
    }
  }
  processingQueue = false
}

// Espera hasta que client esté listo (o falla tras timeout)
function waitForClientReady(timeout = 60000) {
  if (client && clientReady) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onReady = () => {
      clear()
      resolve()
    }
    const onTimeout = () => {
      cleanup()
      reject(new Error('Timeout esperando client.ready'))
    }

    function cleanup() {
      client?.off('ready', onReady)
    }
    function clear() {
      cleanup()
      if (timer) clearTimeout(timer)
    }

    client?.once('ready', onReady)
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
    console.log(`📷 [${sessionId}] Evento QR recibido. Generando terminal + archivo...`)
    try {
      qrcodeTerminal.generate(qr, { small: true })
      // Guardar archivo PNG local
      await QRCode.toFile(`./qr-${sessionId}.png`, qr)
      // Guardar dataURL en memoria para servir por HTTP
      const dataUrl = await QRCode.toDataURL(qr)
      qrStore.set(sessionId, dataUrl)
      // Además guardar un txt con dataURL por si se necesita
      fs.writeFileSync(`./qr-${sessionId}.txt`, dataUrl)
      console.log(`✅ QR guardado como qr-${sessionId}.png y en memoria (qrStore).`)
    } catch (err) {
      console.error(`❌ Error generando QR para ${sessionId}:`, err)
    }
  })

  newClient.on('loading_screen', (percent, message) => {
    console.log(`[${sessionId}] loading_screen ${percent}% — ${message}`)
  })

  newClient.on('ready', () => {
    console.log(`✅ Cliente ${sessionId} listo`)
    // marcar cliente listo globalmente si este es el cliente actual
    if (sessionIds[currentSessionIndex] === sessionId) {
      clientReady = true
    }
  })

  newClient.on('auth_failure', (msg) => {
    console.error(`❌ Fallo de autenticación para ${sessionId}:`, msg || '(sin msg)')
  })

  newClient.on('disconnected', reason => {
    console.warn(`⚠️ ${sessionId} desconectado: ${reason}`)
    clientReady = false
    failover()
  })

  newClient.on('message', async (message) => {
    // log liviano para no spamear todo el tiempo
    console.log(`[${sessionId}] mensaje de ${message.from}: ${String(message.body || '').slice(0,100)}`)
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

  clientReady = false
  currentSessionIndex = (currentSessionIndex + 1) % sessionIds.length
  const newSession = sessionIds[currentSessionIndex]
  console.log(`🔄 Cambiando a la sesión: ${newSession}`)
  client = createClient(newSession)

  try {
    client.initialize()
  } catch (e) {
    console.error('Error al initialize en failover:', e)
  }
}

// --------------------------- INICIALIZACIÓN ---------------------------
let serverListening = false

// Primero iniciamos el servidor para que esté aceptando conexiones ANTES de que aparezcan los QR.
if (!serverListening) {
  serverListening = true
  app.listen(3005, '0.0.0.0', () => {
    console.log('🚀 Servidor escuchando en http://0.0.0.0:3005')
  })
}

console.log('➡️ Creando cliente inicial...')
client = createClient(sessionIds[currentSessionIndex])

console.log('➡️ Inicializando cliente (initialize)...')
try {
  client.initialize()
} catch (e) {
  console.error('Error al client.initialize():', e)
}

client.once('ready', () => {
  console.log('✅ Evento ready recibido (main). Cliente inicial listo')
})

// ---------------------- ENDPOINTS ----------------------
// Endpoint para obtener QR (por sessionId)
app.get('/qr/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId
  const pngPath = `./qr-${sessionId}.png`
  if (fs.existsSync(pngPath)) {
    return res.sendFile(require('path').resolve(pngPath))
  }

  if (qrStore.has(sessionId)) {
    // devolvemos la dataURL en JSON
    return res.json({ dataUrl: qrStore.get(sessionId) })
  }

  return res.status(404).json({ error: 'QR no encontrado para esa sesión' })
})

// Endpoint para obtener QR de la sesión actual
app.get('/qr_current', async (req, res) => {
  const sessionId = sessionIds[currentSessionIndex]
  return app._router.handle(req, res, () => {}, '/qr/' + sessionId) // redirect internamente
})

// Helper para formatear fecha
function formatFechaFromMessage(message) {
  const fechaLocal = new Date(message.timestamp * 1000).toLocaleString('sv-SE', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour12: false
  }).replace(' ', 'T')
  return fechaLocal
}

app.post('/enviar-mensaje', upload.none(), async (req, res) => {
  const { numero, texto } = req.body
  if (!numero || !texto) return res.status(400).json({ error: 'Faltan datos' })

  if (numero.length !== 13) {
    return res.status(404).json({ error: 'Número inválido' })
  }

  const chatId = `${numero}@c.us`

  try {
    const result = await enqueue(async () => {
      const message = await client.sendMessage(chatId, texto)
      return message
    })

    const fechaLocal = formatFechaFromMessage(result)
    res.json({ id: result.id.id, ack: result.ack, from: result._data.from.user, to: result._data.to.user, time: fechaLocal })
  }
  catch (err) {
    console.error('❌ Error al enviar mensaje (queued):', err)
    failover()
    res.status(500).json({ error: 'Falló el envío del mensaje' })
  }
})

// Enviar archivo
app.post('/enviar-archivo', upload.single('archivo'), async (req, res) => {
  const { numero, texto = '' } = req.body
  const filePath = req.file?.path
  const originalName = req.file?.originalname

  if (!numero || !filePath) return res.status(400).json({ error: 'Faltan datos' })

  try {
    const result = await enqueue(async () => {
      const mimeType = mime.lookup(originalName) || 'application/octet-stream'
      const base64 = fs.readFileSync(filePath, 'base64')
      const media = new MessageMedia(mimeType, base64, originalName)
      const message = await client.sendMessage(`${numero}@c.us`, media, { caption: texto })
      return message
    })

    // borrar archivo temporal
    try { fs.unlinkSync(filePath) } catch (e) { /* ignore */ }

    const fechaLocal = formatFechaFromMessage(result)
    res.json({ id: result.id.id, status: 'OK', from: result._data.from.user, to: result._data.to.user, time: fechaLocal })
  } catch (err) {
    try { fs.unlinkSync(filePath) } catch (e) { /* ignore */ }
    console.error('❌ Error al enviar archivo (queued):', err)
    failover()
    res.status(500).json({ error: 'Falló el envío del archivo' })
  }
})

// Enviar ubicación
app.post('/enviar-ubicacion', upload.none(), async (req, res) => {
  const { numero, lat, lon } = req.body
  if (!numero || !lat || !lon) return res.status(400).json({ error: 'Faltan datos' })

  try {
    const result = await enqueue(async () => {
      let location = `https://maps.google.com/maps?q=${lat},${lon}&z=17&hl=en`
      const message = await client.sendMessage(`${numero}@c.us`, location)
      return message
    })

    const fechaLocal = formatFechaFromMessage(result)
    res.json({ id: result.id.id, status: 'OK', from: result._data.from.user, to: result._data.to.user, time: fechaLocal })
  } catch (err) {
    console.error('❌ Error al enviar ubicación (queued):', err)
    failover()
    res.status(500).json({ error: 'Falló el envío de la ubicación' })
  }
})

// Confirmación (/esperar) mantiene la lógica pero el envío queda en cola
app.post('/esperar', upload.none(), async (req, res) => {
  const { numero, texto } = req.body
  if (!numero || !texto) return res.status(400).json({ error: 'Faltan datos' })

  const chatId = `${numero}@c.us`

  try {
    const message = await enqueue(async () => {
      return await client.sendMessage(chatId, texto)
    })

    const idMensaje = message.id.id

    // Guardar la espera
    esperas.set(chatId, idMensaje)

    // Inicializar lista de resolvers si no existe
    resolvers.set(idMensaje, [])

    // Iniciar timeout para liberar si nadie responde
    const timeoutId = setTimeout(() => {
      if (esperas.get(chatId) === idMensaje && !respuestas.has(idMensaje)) {
        esperas.delete(chatId)

        // Resolver a todos los que estaban esperando con null
        resolvers.get(idMensaje)?.forEach(r => r(null))
        resolvers.delete(idMensaje)
      }

      timeouts.delete(idMensaje)
    }, 300000) // 5 minutos

    timeouts.set(idMensaje, timeoutId)

    const fechaLocal = formatFechaFromMessage(message)
    // Devolver ID para poder consultar luego
    res.json({ id: message.id.id, ack: message.ack, from: message._data.from.user, to: message._data.to.user, time: fechaLocal })
  } catch (err) {
    console.error('❌ Error al enviar mensaje (esperar):', err)
    res.status(500).json({ error: 'Falló el envío del mensaje' })
  }
})

app.get('/respuesta/:idMensaje', async (req, res) => {
  const idMensaje = req.params.idMensaje
  if (respuestas.has(idMensaje)) {
    const message = respuestas.get(idMensaje)
    const fechaLocal = formatFechaFromMessage(message)
    return res.json({
      id: message.id.id,
      message: message.body,
      from: message._data.from.user,
      to: message._data.to.user,
      time: fechaLocal
    })
  }

  // Verificamos si se está esperando respuesta
  const estaEsperando = Array.from(esperas.entries()).some(([, v]) => v === idMensaje)

  if (!estaEsperando) {
    return res.status(404).json({ error: 'Respuesta no encontrada' })
  }

  // Esperamos respuesta o timeout
  const respuesta = await new Promise(resolve => {
    resolvers.get(idMensaje).push(resolve)
  })

  if (!respuesta) {
    return res.status(404).json({ error: 'Tiempo agotado' })
  }

  const { message } = respuesta
  const fechaLocal = formatFechaFromMessage(message)

  return res.json({
    id: message.id.id,
    message: message.body,
    from: message.from,
    to: message.to,
    time: fechaLocal
  })
})

app.get('/estado', async (req, res) => {
  const id = req.query.id;
  const numero = req.query.numero;

  if (!numero || !id) return res.status(400).json({ error: 'Faltan datos' })
  
  if (numero.length !== 13) {
    return res.status(404).json({ error: 'Número inválido' })
  }
  
  const chat = await client.getChatById(`${numero}@c.us`);


  const messages = await chat.fetchMessages({ limit: 50, fromMe: true });

  const message = messages.find(m => m.id.id === id);

  if(!message){
    return res.status(404).json({ error: 'Mensaje no encontrado' })
  }

  else{
    const fechaLocal = formatFechaFromMessage(message)
      res.json({ id: message.id.id, ack:message.ack,   from: message.from, to: message.to,time: fechaLocal })
  }
});

app.get('/get_mensajes/:numero', async (req, res) => {
  const numero =  req.params.numero

  if (!numero) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  try {
    const chat = await client.getChatById(`${numero}@c.us`);

    // Trae los mensajes posteriores al ID
    const mensajes = await chat.fetchMessages({
      limit: 20
    });

    console.log(mensajes);

    res.json(mensajes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener mensajes' });
  }
});

// export para tests
module.exports = { app }
