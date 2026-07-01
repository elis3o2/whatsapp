// state.js — Estado global compartido entre módulos.
// Se expone como objeto mutable para que todos los módulos vean los mismos valores
// incluso cuando `sock` se reemplaza en cada reconexión.

const SESSION_ID = process.env.SESSION_ID || 'default'
const PORT       = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005

const state = {
  sock:         null,   // socket Baileys activo
  clientReady:  false,
  restarting:   false,
  reconnecting: false,
  reconnectAttempts: 0,
  qrStore:      new Map(),
}

module.exports = {
  state,
  SESSION_ID,
  PORT,
}