import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { sendWhatsApp } from '../whatsapp.js'
import {
  initDB, upsertContact, updateContact, getContact,
  getAllContacts, getAllLabels, setContactLabels,
  saveMessage, getMessages, getRecentConversations
} from '../db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const USERS = {
  'castellanosmt@gmail.com': { name: 'Teresa Castellanos', password: 'urban2025' },
  'pablolc20111@gmail.com': { name: 'Pablo Lemus', password: 'urban2025' },
  'contacto@urbanpadellife.com': { name: 'Urban Pádel', password: 'urban2025' }
}

export let dashboardIO = null
export const humanControl = new Set()

export async function initDashboard(app, conversations) {
  await initDB()

  const httpServer = createServer(app)
  dashboardIO = new Server(httpServer, { cors: { origin: '*' } })
  const sessions = new Map()

  app.use('/dashboard/static', express.static(join(__dirname, 'public')))

  app.post('/dashboard/login', express.json(), (req, res) => {
    const { email, password } = req.body
    const user = USERS[email]
    if (user && user.password === password) {
      const token = Math.random().toString(36).slice(2) + Date.now()
      sessions.set(token, { email, name: user.name })
      res.json({ ok: true, token, name: user.name })
    } else {
      res.status(401).json({ ok: false, error: 'Credenciales incorrectas' })
    }
  })

  function auth(req, res, next) {
    const token = req.headers['x-token']
    if (token && sessions.has(token)) {
      req.user = sessions.get(token)
      next()
    } else {
      res.status(401).json({ error: 'No autorizado' })
    }
  }

  // Conversaciones recientes
  app.get('/dashboard/api/conversations', auth, async (req, res) => {
    const { label } = req.query
    let convs = await getRecentConversations()
    if (label) convs = convs.filter(c => c.labels?.some(l => l.name === label))
    const result = convs.map(c => ({
      ...c,
      humanControl: humanControl.has(c.phone)
    }))
    res.json(result)
  })

  // Mensajes de conversación
  app.get('/dashboard/api/conversations/:phone', auth, async (req, res) => {
    const msgs = await getMessages(req.params.phone)
    const contact = await getContact(req.params.phone)
    res.json({
      phone: req.params.phone,
      messages: msgs,
      contact,
      humanControl: humanControl.has(req.params.phone)
    })
  })

  // Control humano
  app.post('/dashboard/api/conversations/:phone/control', auth, express.json(), (req, res) => {
    const { phone } = req.params
    const { take } = req.body
    take ? humanControl.add(phone) : humanControl.delete(phone)
    dashboardIO.emit('control_changed', { phone, humanControl: take, agent: req.user.name })
    res.json({ ok: true })
  })

  // Enviar mensaje
  app.post('/dashboard/api/conversations/:phone/send', auth, express.json(), async (req, res) => {
    const { phone } = req.params
    const { message } = req.body
    try {
      await sendWhatsApp(phone, message)
      await saveMessage(phone, 'assistant', message, req.user.name)
      dashboardIO.emit('new_message', { phone, role: 'assistant', content: message, agent: req.user.name })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Contactos
  app.get('/dashboard/api/contacts', auth, async (req, res) => {
    res.json(await getAllContacts())
  })

  app.put('/dashboard/api/contacts/:phone', auth, express.json(), async (req, res) => {
    await updateContact(req.params.phone, req.body)
    res.json({ ok: true })
  })

  app.post('/dashboard/api/contacts/:phone/labels', auth, express.json(), async (req, res) => {
    await setContactLabels(req.params.phone, req.body.labelIds)
    res.json({ ok: true })
  })

  // Etiquetas
  app.get('/dashboard/api/labels', auth, async (req, res) => {
    res.json(await getAllLabels())
  })

  app.get('/dashboard', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')))
  app.get('/dashboard/*', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')))

  dashboardIO.use((socket, next) => {
    const token = socket.handshake.auth.token
    sessions.has(token) ? (socket.user = sessions.get(token), next()) : next(new Error('No autorizado'))
  })

  dashboardIO.on('connection', socket => {
    console.log(`[Dashboard] ${socket.user.name} conectado`)
  })

  return httpServer
}
