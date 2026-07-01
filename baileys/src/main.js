// main.js — Entrypoint. Arma la app Express, monta las rutas y arranca Baileys.

const express = require('express')

const { SESSION_ID, PORT } = require('./state')
const { initBaileys, startHealthCheck } = require('./baileysClient')
const routes = require('./routes')

console.log('🟢 Iniciando main.js (Baileys) — pid:', process.pid)
console.log('🔧 SESSION_ID:', SESSION_ID)

process.on('unhandledRejection', (reason, p) => console.error('Unhandled Rejection:', p, reason))
process.on('uncaughtException',  (err)         => console.error('Uncaught Exception:', err))

const app = express()
app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(routes)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Servidor escuchando en http://0.0.0.0:${PORT}`)
})

startHealthCheck(SESSION_ID)

initBaileys(SESSION_ID).catch(err => {
  console.error('Error en initBaileys inicial:', err)
})