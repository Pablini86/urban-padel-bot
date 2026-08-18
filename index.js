import express from 'express'
import { handleIncoming, conversations } from './bot.js'
import { initDashboard } from './dashboard/server.js'
import { normalizeMxPhone } from './phone.js'
import { getActiveSurveyContact } from './db.js'
import { handleSurveyReply } from './encuesta.js'

// El bot de WhatsApp vive en el mismo proceso que el dashboard: un error suelto
// en cualquier lado no debe tumbar la línea de atención en vivo.
process.on('unhandledRejection', err => console.error('[Proceso] Rejection sin atrapar:', err))
process.on('uncaughtException', err => console.error('[Proceso] Excepción sin atrapar:', err))

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
  if (!message) return

  // Además de texto libre, aceptamos respuestas de botones de las preguntas de
  // la encuesta (message.type === 'interactive') — sin esto, cualquier click en
  // un botón de campaña se pierde en silencio.
  let text = null
  if (message.type === 'text') text = message.text.body
  else if (message.type === 'interactive' && message.interactive?.button_reply) text = message.interactive.button_reply.title
  if (text === null) return

  const from = normalizeMxPhone(message.from)
  const name = value.contacts?.[0]?.profile?.name || 'Cliente'
  console.log(`[${name}] ${from}: ${text}`)
  try {
    // Si este teléfono está a media encuesta de una campaña, esa conversación la
    // maneja encuesta.js — nunca la contesta Claude.
    const surveyContact = await getActiveSurveyContact(from)
    if (surveyContact) {
      await handleSurveyReply(surveyContact, from, name, text)
    } else {
      await handleIncoming(from, name, text)
    }
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
