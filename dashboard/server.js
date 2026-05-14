import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { sendWhatsApp } from '../whatsapp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const router = express.Router()

// Usuarios autorizados
const USERS = {
  'castellanosmt@gmail.com': { name: 'Teresa Castellanos', password: 'urban2025' },
  'pablolc20111@gmail.com': { name: 'Pablo Lemus', password: 'urban2025' },
  'contacto@urbanpadellife.com': { name: 'Urban Pádel', password: 'urban2025' }
}

// Almacén de conversaciones en memoria (se comparte con bot.js)
export let dashboardIO = null
export const humanControl = new Set() // números donde humano tomó control

export function initDashboard(app, conversations) {
  const httpServer = createServer(app)
  dashboardIO = new Server(httpServer, { cors: { origin: '*' } })

  // Sesiones simples en memoria
  const sessions = new Map()

  // Servir archivos estáticos del dashboard
  app.use('/dashboard/static', express.static(join(__dirname, 'public')))

  // Login
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

  // Middleware de auth
  function auth(req, res, next) {
    const token = req.headers['x-token']
    if (token && sessions.has(token)) {
      req.user = sessions.get(token)
      next()
    } else {
      res.status(401).json({ error: 'No autorizado' })
    }
  }

  // API: listar conversaciones
  app.get('/dashboard/api/conversations', auth, (req, res) => {
    const list = []
    for (const [phone, messages] of conversations.entries()) {
      const last = messages[messages.length - 1]
      list.push({
        phone,
        lastMessage: last?.content || '',
        lastRole: last?.role || 'user',
        count: messages.length,
        humanControl: humanControl.has(phone),
        updatedAt: Date.now()
      })
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    res.json(list)
  })

  // API: mensajes de una conversación
  app.get('/dashboard/api/conversations/:phone', auth, (req, res) => {
    const msgs = conversations.get(req.params.phone) || []
    res.json({ phone: req.params.phone, messages: msgs, humanControl: humanControl.has(req.params.phone) })
  })

  // API: tomar/soltar control
  app.post('/dashboard/api/conversations/:phone/control', auth, express.json(), (req, res) => {
    const { phone } = req.params
    const { take } = req.body
    if (take) {
      humanControl.add(phone)
    } else {
      humanControl.delete(phone)
    }
    dashboardIO.emit('control_changed', { phone, humanControl: take, agent: req.user.name })
    res.json({ ok: true })
  })

  // API: enviar mensaje como agente
  app.post('/dashboard/api/conversations/:phone/send', auth, express.json(), async (req, res) => {
    const { phone } = req.params
    const { message } = req.body
    try {
      await sendWhatsApp(phone, message)
      const msgs = conversations.get(phone) || []
      msgs.push({ role: 'assistant', content: `[${req.user.name}]: ${message}` })
      conversations.set(phone, msgs)
      dashboardIO.emit('new_message', { phone, role: 'assistant', content: message, agent: req.user.name })
      res.json({ ok: true })
    } catch (err) {
      res.status(500).json({ error: err.message })
    }
  })

  // Servir dashboard HTML
  app.get('/dashboard', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'))
  })

  app.get('/dashboard/*', (req, res) => {
    res.sendFile(join(__dirname, 'public', 'index.html'))
  })

  // Socket.io auth
  dashboardIO.use((socket, next) => {
    const token = socket.handshake.auth.token
    if (token && sessions.has(token)) {
      socket.user = sessions.get(token)
      next()
    } else {
      next(new Error('No autorizado'))
    }
  })

  dashboardIO.on('connection', (socket) => {
    console.log(`[Dashboard] ${socket.user.name} conectado`)
    socket.on('disconnect', () => {
      console.log(`[Dashboard] ${socket.user.name} desconectado`)
    })
  })

  return httpServer
}
