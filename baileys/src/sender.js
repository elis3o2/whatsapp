// sender.js — Wrappers de envío sobre el socket Baileys (texto, archivos, ubicación).

const { state } = require('./state')
const { normalizeBaileysMessage } = require('./messageUtils')
const { storeMessage } = require('./messageStore')

/**
 * Envía un texto y devuelve un objeto normalizado compatible con el resto del código.
 */
async function sendText(jid, text) {
  const sent = await state.sock.sendMessage(jid, { text }, { timestamp: new Date() })
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
  const sent = await state.sock.sendMessage(jid, content)
  storeMessage(jid, { ...sent, key: { ...sent.key, remoteJid: jid } })
  return normalizeBaileysMessage({ ...sent, key: { ...sent.key, remoteJid: jid } })
}

/**
 * Envía una ubicación nativa de WhatsApp.
 */
async function sendLocation(jid, lat, lon) {
  const sent = await state.sock.sendMessage(jid, {
    location: { degreesLatitude: parseFloat(lat), degreesLongitude: parseFloat(lon) },
  })
  storeMessage(jid, { ...sent, key: { ...sent.key, remoteJid: jid } })
  return normalizeBaileysMessage({ ...sent, key: { ...sent.key, remoteJid: jid } })
}

module.exports = {
  sendText,
  sendFile,
  sendLocation,
}