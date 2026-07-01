// messageUtils.js — Normalización de mensajes Baileys al formato simplificado usado en toda la app.

const { state } = require('./state')

/**
 * Convierte un mensaje de Baileys al formato simplificado que usan
 * los resolvers / waitResponse (similar al objeto Message de wwjs).
 */
function normalizeBaileysMessage(msg) {
  const key   = msg.key || {}
  const msgId = key.id || ''

  const jid =
    key.remoteJidAlt ||
    key.remoteJid ||
    key.participantAlt ||
    ''

  const fromMe = key.fromMe || false

  const body =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ''

  const ts = msg.messageTimestamp
    ? Number(msg.messageTimestamp)
    : Math.floor(Date.now() / 1000)

  const number = jid.split('@')[0]

  const myId =
    state.sock?.user?.id?.split(':')[0] || ''

  return {
    id: { id: msgId, fromMe },
    body,
    timestamp: ts,

    from: jid,

    to: fromMe
      ? jid
      : `${myId}@s.whatsapp.net`,

    _data: {
      from: {
        user: fromMe ? myId : number
      },
      to: {
        user: fromMe ? number : myId
      }
    },

    ack: msg.status ?? 1,
    _raw: msg
  }
}

function formatFechaFromMessage(message) {
  const ts = message.timestamp || Math.floor(Date.now() / 1000)
  return new Date(ts * 1000).toLocaleString('sv-SE', {
    timeZone: 'America/Argentina/Buenos_Aires',
    hour12: false,
  }).replace(' ', 'T')
}

module.exports = {
  normalizeBaileysMessage,
  formatFechaFromMessage,
}