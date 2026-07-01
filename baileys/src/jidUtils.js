// jidUtils.js — Helpers de JID / número de WhatsApp.

const { state } = require('./state')

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
    const [result] = await state.sock.onWhatsApp(numero)
    if (result && result.exists) return result.jid
    return null
  } catch (e) {
    console.warn('[getRegisteredJid] error:', e.message)
    return null
  }
}

module.exports = {
  normalizeJid,
  toJid,
  getRegisteredJid,
}