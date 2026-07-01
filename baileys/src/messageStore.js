// messageStore.js — Persistencia de mensajes (SQLite) y manejo de ACKs.

const {
  db,
  stmtUpsert,
  stmtGetById,
  stmtGetByMsgId,
  stmtGetByJid,
  stmtUpdateAck,
} = require('./db')

const { normalizeJid } = require('./jidUtils')

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

module.exports = {
  db,
  storeMessage,
  getStoredMessage,
  getStoredMessagesByJid,
  updateAck,
}