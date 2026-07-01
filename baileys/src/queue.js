// queue.js — Cola FIFO para serializar envíos hacia WhatsApp.

const { state } = require('./state')

const sendQueue = []
let processingQueue = false
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

function waitForClientReady(timeout = 120000) {
  if (state.sock && state.clientReady) return Promise.resolve()
  return new Promise((resolve, reject) => {
    console.log('[waitForClientReady] esperando ready...')
    const timer = setTimeout(() => {
      reject(new Error('Timeout esperando client ready'))
    }, timeout)

    const interval = setInterval(() => {
      if (state.sock && state.clientReady) {
        clearInterval(interval)
        clearTimeout(timer)
        resolve()
      }
    }, 500)
  })
}

async function processQueue() {
  if (processingQueue) return
  processingQueue = true
  console.log('[queue] processQueue starting')

  while (sendQueue.length > 0) {
    const item = sendQueue.shift()
    console.log('[queue] processing task, remaining:', sendQueue.length)
    try {
      await waitForClientReady()
      const result = await item.taskFn()
      item.resolve(result)
      console.log('[queue] task finished')
      if (sendQueue.length > 0) {
        console.log('[queue] waiting 90 seconds...')
        await sleep(90 * 1000)
      }
    } catch (err) {
      item.reject(err)
      console.error('[queue] task failed:', err)
    }
  }

  processingQueue = false
  console.log('[queue] processQueue empty')
}

async function enqueue(taskFn) {
  return new Promise((resolve, reject) => {
    console.log('[queue] enqueue, length before:', sendQueue.length)
    sendQueue.push({ taskFn, resolve, reject })
    processQueue().catch(err => console.error('Error en processQueue:', err))
  })
}

module.exports = {
  enqueue,
  waitForClientReady,
}