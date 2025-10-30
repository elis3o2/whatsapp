const { Client, LocalAuth, MessageMedia, List } = require('whatsapp-web.js')
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

const sessionIds = ['numero1', 'numero2']
let currentSessionIndex = 0
let client = null

const esperas = new Map()       // chatId -> idMensaje
const respuestas = new Map()    // idMensaje ->  message
const resolvers = new Map()     // idMensaje -> [resolve1, resolve2]
const timeouts = new Map()      // idMensaje -> TimeoutID



// 🔁 Función para iniciar una sesión
const createClient = (sessionId) => {
  const newClient = new Client({
    authStrategy: new LocalAuth({ clientId: sessionId }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  })

  newClient.on('qr', (qr) => {
    console.log(`📷 Escaneá el QR para ${sessionId}`)
    qrcodeTerminal.generate(qr, { small: true })

    QRCode.toFile(`./qr-${sessionId}.png`, qr, {
      color: { dark: '#000', light: '#FFF' }
    }, err => {
      if (err) console.error(`❌ Error al guardar QR de ${sessionId}:`, err)
      else console.log(`✅ QR guardado como qr-${sessionId}.png`)
    })
  })

  newClient.on('ready', () => {
    console.log(`✅ Cliente ${sessionId} listo`)
  })

  newClient.on('auth_failure', () => {
    console.error(`❌ Fallo de autenticación para ${sessionId}`)
  })

  newClient.on('disconnected', reason => {
    console.warn(`⚠️ ${sessionId} desconectado: ${reason}`)
    failover()
  })

  newClient.on('message', async (message) => {
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

// 🔁 Manejo de cambio de sesión por error
const failover = () => {
  if (client) client.destroy()
  currentSessionIndex = (currentSessionIndex + 1) % sessionIds.length
  const newSession = sessionIds[currentSessionIndex]
  console.log(`🔄 Cambiando a la sesión: ${newSession}`)
  client = createClient(newSession)
  client.initialize()

  // Iniciar servidor web una vez que esté listo
  client.on('ready', () => {
    app.listen(3005, '0.0.0.0',() => {
      console.log('🚀 Servidor escuchando en http://localhost:3005')
    })
  })
}

// Inicializar primera sesión
client = createClient(sessionIds[currentSessionIndex])
client.initialize()

// Iniciar servidor web una vez que esté listo
client.on('ready', () => {
  app.listen(3005, '0.0.0.0', () => {
    console.log('🚀 Servidor escuchando en http://localhost:3005')
  })
})

// ---------------------- ENDPOINTS ----------------------
app.post('/enviar-mensaje', upload.none(), async (req, res) => {
  const { numero, texto } = req.body
  if (!numero || !texto) return res.status(400).json({ error: 'Faltan datos' })

  if (numero.length !== 13) {
    return res.status(404).json({ error: 'Número inválido' });
  }

  const chatId = `${numero}@c.us`

  try {
    const message = await client.sendMessage(chatId, texto)
    const fechaLocal = new Date(message.timestamp * 1000).toLocaleString('sv-SE', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour12: false
    }).replace(' ', 'T')

    res.json({ 
      id: message.id.id, 
      ack: message.ack, 
      from: message._data.from.user, 
      to: message._data.to.user, 
      time: fechaLocal 
    })
  } 
  catch (err) {
    console.error('❌ Error al enviar mensaje:', err)
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
    const mimeType = mime.lookup(originalName) || 'application/octet-stream'
    const base64 = fs.readFileSync(filePath, 'base64')
    const media = new MessageMedia(mimeType, base64, originalName)

    const message = await client.sendMessage(`${numero}@c.us`, media, { caption: texto })
    fs.unlinkSync(filePath)
    const fechaLocal = new Date(message.timestamp * 1000).toLocaleString('sv-SE', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour12: false
    }).replace(' ', 'T')
    res.json({ id: message.id.id, status: 'OK', from: message._data.from.user, to: message._data.to.user, time: fechaLocal })
  } catch (err) {
    fs.unlinkSync(filePath)
    console.error('❌ Error al enviar archivo:', err)
    failover()
    res.status(500).json({ error: 'Falló el envío del mensaje' })
  }
})

// Enviar ubicación
app.post('/enviar-ubicacion', upload.none(), async (req, res) => {
  const { numero, lat, lon } = req.body
  if (!numero || !lat || !lon) return res.status(400).json({ error: 'Faltan datos' })

  try {
    let location = `https://maps.google.com/maps?q=${lat},${lon}&z=17&hl=en`
    const message = await client.sendMessage(`${numero}@c.us`, location)
    const fechaLocal = new Date(message.timestamp * 1000).toLocaleString('sv-SE', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour12: false
    }).replace(' ', 'T')
    res.json({ id: message.id.id, status: 'OK', from: message._data.from.user, to: message._data.to.user, time: fechaLocal })
  } catch (err) {
    console.error('❌ Error al enviar ubicación:', err)
    failover()
    res.status(500).json({ error: 'Falló el envío de la ubicación' })
  }
})

// Confirmación
app.post('/esperar', upload.none(), async (req, res) => {
  const { numero, texto } = req.body
  if (!numero || !texto) return res.status(400).json({ error: 'Faltan datos' })

  const chatId = `${numero}@c.us`

  try {
    const message = await client.sendMessage(chatId, texto)
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

    const fechaLocal = new Date(message.timestamp * 1000).toLocaleString('sv-SE', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour12: false
    }).replace(' ', 'T')
    // Devolver ID para poder consultar luego
    res.json({ id: message.id.id, ack: message.ack, from: message._data.from.user, to: message._data.to.user, time: fechaLocal })
  } catch (err) {
    console.error('❌ Error al enviar mensaje:', err)
    res.status(500).json({ error: 'Falló el envío del mensaje' })
  }
})



app.get('/respuesta/:idMensaje', async (req, res) => {
  const idMensaje = req.params.idMensaje
  if (respuestas.has(idMensaje)) {
    const message = respuestas.get(idMensaje)
    const fechaLocal = new Date(message.timestamp * 1000).toLocaleString('sv-SE', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour12: false
    }).replace(' ', 'T')
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
  // Esperar asincrónicamente a que llegue o expire
  const respuesta = await new Promise(resolve => {
    resolvers.get(idMensaje).push(resolve)
  })


  if (!respuesta) {
    return res.status(404).json({ error: 'Tiempo agotado' })
  }

  const { message } = respuesta
  const fechaLocal = new Date(message.timestamp * 1000).toLocaleString('sv-SE', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour12: false
  }).replace(' ', 'T')
  
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
    return res.status(404).json({ error: 'Número inválido' });
  }
  
  const chat = await client.getChatById(`${numero}@c.us`);


  const messages = await chat.fetchMessages({ limit: 20, fromMe: true });

  const message = messages.find(m => m.id.id === id);

  if(!message){
    return res.status(404).json({ error: 'Mensaje no encontrado' })
  }

  else{
    const fechaLocal = new Date(message.timestamp * 1000).toLocaleString('sv-SE', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour12: false
    }).replace(' ', 'T')
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
