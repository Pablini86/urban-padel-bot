import express from 'express'
import { handleIncoming, conversations } from './bot.js'
import { initDashboard } from './dashboard/server.js'

const app = express()
app.use(express.json())

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode']
  const token = req.query['hub.verify_token']
  const challenge = req.query['hub.challenge']
  if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
    res.status(200).send(challenge)
  } else {
    res.sendStatus(403)
  }
})

app.post('/webhook', async (req, res) => {
  res.sendStatus(200)
  const entry = req.body.entry?.[0]
  const change = entry?.changes?.[0]
  const value = change?.value
  const message = value?.messages?.[0]
  if (!message || message.type !== 'text') return
  const from = message.from
  const text = message.text.body
  const name = value.contacts?.[0]?.profile?.name || 'Cliente'
  console.log(`[${name}] ${from}: ${text}`)
  try {
    await handleIncoming(from, name, text)
  } catch (err) {
    console.error('Error procesando mensaje:', err)
  }
})

app.get('/', (req, res) => res.send('Urban Padel Bot corriendo'))

const PORT = process.env.PORT || 3000

// initDashboard es async, hay que esperarla
;(async () => {
  const httpServer = await initDashboard(app, conversations)
  httpServer.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`))
})()
