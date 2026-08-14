import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { sendWhatsApp } from '../whatsapp.js'
import { submitTemplateToMeta, checkTemplateStatus, uploadTemplateHeaderImage } from '../meta-templates.js'
import {
  initDB, upsertContact, updateContact, getContact, markConversationOpened,
  getAllContacts, getAllLabels, setContactLabels, createLabel,
  saveMessage, getMessages, getRecentConversations,
  createTemplate, getTemplates, getTemplate, setTemplateSubmitted, setTemplateError, setTemplateStatus,
  createCampaign, getCampaigns, getCampaign, getCampaignContacts, getCampaignStats,
  addAudienceFromLabel, countLabelAudience,
  getAutomations, createAutomation, updateAutomation, setAutomationActive, deleteAutomation
} from '../db.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Mismo password para las 3 cuentas, tomado de la variable de entorno DASHBOARD_PASSWORD
const USER_NAMES = {
  'castellanosmt@gmail.com': 'Teresa Castellanos',
  'pablolc20111@gmail.com': 'Pablo Lemus',
  'contacto@urbanpadellife.com': 'Urban Pádel'
}

export let dashboardIO = null
export const humanControl = new Set()

export async function initDashboard(app, conversations) {
  if (!process.env.DASHBOARD_PASSWORD) {
    console.warn('[Dashboard] ADVERTENCIA: falta DASHBOARD_PASSWORD, nadie podrá iniciar sesión')
  }
  await initDB()

  const httpServer = createServer(app)
  dashboardIO = new Server(httpServer, { cors: { origin: '*' } })
  const sessions = new Map()

  // Envuelve rutas async: si truena una promesa, la pasa a next(err) en vez de
  // dejar que reviente como unhandled rejection y tumbe TODO el proceso (el bot
  // de WhatsApp vive en el mismo proceso que este dashboard).
  const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

  app.use('/dashboard/static', express.static(join(__dirname, 'public')))

  app.post('/dashboard/login', express.json(), (req, res) => {
    const { email, password } = req.body
    const name = USER_NAMES[email]
    if (name && password && password === process.env.DASHBOARD_PASSWORD) {
      const token = Math.random().toString(36).slice(2) + Date.now()
      sessions.set(token, { email, name })
      res.json({ ok: true, token, name })
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
  app.get('/dashboard/api/conversations', auth, ah(async (req, res) => {
    const { label, status } = req.query
    let convs = await getRecentConversations()
    if (label) convs = convs.filter(c => c.labels?.some(l => l.name === label))
    if (status) convs = convs.filter(c => c.status === status)
    const result = convs.map(c => ({
      ...c,
      humanControl: humanControl.has(c.phone)
    }))
    res.json(result)
  }))

  // Mensajes de conversación
  app.get('/dashboard/api/conversations/:phone', auth, ah(async (req, res) => {
    await markConversationOpened(req.params.phone)
    const msgs = await getMessages(req.params.phone)
    const contact = await getContact(req.params.phone)
    res.json({
      phone: req.params.phone,
      messages: msgs,
      contact,
      humanControl: humanControl.has(req.params.phone)
    })
  }))

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
  app.get('/dashboard/api/contacts', auth, ah(async (req, res) => {
    res.json(await getAllContacts())
  }))

  app.put('/dashboard/api/contacts/:phone', auth, express.json(), ah(async (req, res) => {
    await updateContact(req.params.phone, req.body)
    res.json({ ok: true })
  }))

  app.post('/dashboard/api/contacts/:phone/labels', auth, express.json(), ah(async (req, res) => {
    await setContactLabels(req.params.phone, req.body.labelIds)
    res.json({ ok: true })
  }))

  // Etiquetas
  app.get('/dashboard/api/labels', auth, ah(async (req, res) => {
    res.json(await getAllLabels())
  }))

  app.post('/dashboard/api/labels', auth, express.json(), ah(async (req, res) => {
    const { name, color } = req.body
    if (!name?.trim() || !color) return res.status(400).json({ error: 'Falta nombre o color' })
    const label = await createLabel(name.trim(), color)
    res.json(label)
  }))

  // Plantillas de WhatsApp — se registran aquí y de una vez se mandan a revisión de Meta
  app.get('/dashboard/api/templates', auth, ah(async (req, res) => {
    res.json(await getTemplates())
  }))

  // Descarga o decodifica la imagen de header antes de mandarla a Meta. Acepta
  // una URL externa (headerImageUrl) o un archivo ya convertido a data URI en el
  // navegador (headerImageBase64) — lo que haya puesto el agente en el formulario.
  async function resolveHeaderImage({ headerImageUrl, headerImageBase64 }) {
    if (headerImageBase64) {
      const match = /^data:(.+?);base64,(.+)$/.exec(headerImageBase64)
      if (!match) throw new Error('La imagen subida no tiene un formato válido')
      return { buffer: Buffer.from(match[2], 'base64'), mimeType: match[1], displayUrl: headerImageBase64 }
    }
    if (headerImageUrl) {
      const imgRes = await fetch(headerImageUrl)
      if (!imgRes.ok) throw new Error(`No se pudo descargar la imagen de la URL (HTTP ${imgRes.status})`)
      const mimeType = imgRes.headers.get('content-type') || 'image/jpeg'
      const buffer = Buffer.from(await imgRes.arrayBuffer())
      return { buffer, mimeType, displayUrl: headerImageUrl }
    }
    return null
  }

  // Límite alto porque headerImageBase64 puede traer una foto completa como data URI.
  app.post('/dashboard/api/templates', auth, express.json({ limit: '10mb' }), ah(async (req, res) => {
    const { name, bodyPreview, variables, buttons, examples, headerImageUrl, headerImageBase64 } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Falta el nombre de la plantilla' })
    if (!bodyPreview?.trim()) return res.status(400).json({ error: 'Falta el texto del mensaje' })
    const variableList = (variables || '').split(',').map(v => v.trim()).filter(Boolean)
    const buttonList = (buttons || '').split(',').map(v => v.trim()).filter(Boolean)
    const exampleList = (examples || '').split(',').map(v => v.trim()).filter(Boolean)

    let image = null
    try {
      image = await resolveHeaderImage({ headerImageUrl, headerImageBase64 })
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }

    const template = await createTemplate({
      name: name.trim(), language: 'es_MX', category: 'UTILITY',
      bodyPreview: bodyPreview.trim(), variables: variableList, buttons: buttonList,
      headerImageUrl: image?.displayUrl
    })

    try {
      let headerHandle = null
      if (image) headerHandle = await uploadTemplateHeaderImage(image)
      const { metaTemplateId, status } = await submitTemplateToMeta({
        name: name.trim(), language: 'es_MX', category: 'UTILITY',
        bodyText: bodyPreview.trim(), variableExamples: exampleList, buttons: buttonList, headerHandle
      })
      await setTemplateSubmitted(template.id, { metaTemplateId, status })
    } catch (err) {
      await setTemplateError(template.id, err.message)
    }

    res.json(await getTemplate(template.id))
  }))

  // Vuelve a preguntarle a Meta si ya aprobó/rechazó una plantilla
  app.post('/dashboard/api/templates/:id/refresh-status', auth, ah(async (req, res) => {
    const template = await getTemplate(req.params.id)
    if (!template) return res.status(404).json({ error: 'No existe esa plantilla' })
    if (!template.meta_template_id) return res.status(400).json({ error: 'Esta plantilla nunca se mandó a Meta' })
    try {
      const { status, rejectedReason } = await checkTemplateStatus(template.meta_template_id)
      await setTemplateStatus(template.id, { status, rejectedReason })
    } catch (err) {
      return res.status(502).json({ error: err.message })
    }
    res.json(await getTemplate(template.id))
  }))

  // Automatizaciones — reglas de palabra clave que responden solas, antes que Claude
  app.get('/dashboard/api/automations', auth, ah(async (req, res) => {
    res.json(await getAutomations())
  }))

  app.post('/dashboard/api/automations', auth, express.json(), ah(async (req, res) => {
    const { name, keywords, replyText } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Falta el nombre de la automatización' })
    const keywordList = (keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
    if (!keywordList.length) return res.status(400).json({ error: 'Falta al menos una palabra clave' })
    if (!replyText?.trim()) return res.status(400).json({ error: 'Falta el texto de la respuesta' })
    res.json(await createAutomation({ name: name.trim(), keywords: keywordList, replyText: replyText.trim() }))
  }))

  app.put('/dashboard/api/automations/:id', auth, express.json(), ah(async (req, res) => {
    const { name, keywords, replyText } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Falta el nombre de la automatización' })
    const keywordList = (keywords || '').split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
    if (!keywordList.length) return res.status(400).json({ error: 'Falta al menos una palabra clave' })
    if (!replyText?.trim()) return res.status(400).json({ error: 'Falta el texto de la respuesta' })
    const updated = await updateAutomation(req.params.id, { name: name.trim(), keywords: keywordList, replyText: replyText.trim() })
    if (!updated) return res.status(404).json({ error: 'No existe esa automatización' })
    res.json(updated)
  }))

  app.post('/dashboard/api/automations/:id/active', auth, express.json(), ah(async (req, res) => {
    const updated = await setAutomationActive(req.params.id, !!req.body.active)
    if (!updated) return res.status(404).json({ error: 'No existe esa automatización' })
    res.json(updated)
  }))

  app.delete('/dashboard/api/automations/:id', auth, ah(async (req, res) => {
    await deleteAutomation(req.params.id)
    res.json({ ok: true })
  }))

  // Campañas
  app.get('/dashboard/api/campaigns', auth, ah(async (req, res) => {
    res.json(await getCampaigns())
  }))

  app.post('/dashboard/api/campaigns', auth, express.json(), ah(async (req, res) => {
    const { name, templateId, audienceLabel, dailyCap } = req.body
    if (!name?.trim() || !templateId) return res.status(400).json({ error: 'Falta el nombre o la plantilla' })
    const campaign = await createCampaign({ name: name.trim(), templateId, audienceLabel, dailyCap })
    if (audienceLabel) await addAudienceFromLabel(campaign.id, audienceLabel)
    res.json(campaign)
  }))

  app.get('/dashboard/api/campaigns/:id', auth, ah(async (req, res) => {
    const campaign = await getCampaign(req.params.id)
    if (!campaign) return res.status(404).json({ error: 'No existe esa campaña' })
    const stats = await getCampaignStats(req.params.id)
    const contacts = await getCampaignContacts(req.params.id)
    res.json({ ...campaign, stats, contacts })
  }))

  // Vista previa: cuántos contactos tiene una etiqueta antes de crear la campaña
  app.get('/dashboard/api/audience-preview', auth, ah(async (req, res) => {
    const { label } = req.query
    if (!label) return res.json({ count: 0 })
    res.json({ count: await countLabelAudience(label) })
  }))

  app.get('/dashboard', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')))
  app.get('/dashboard/*', (req, res) => res.sendFile(join(__dirname, 'public', 'index.html')))

  // Red de seguridad: cualquier error que llegue hasta aquí responde 500 en vez
  // de tumbar el proceso (que también sirve el webhook de WhatsApp).
  app.use((err, req, res, next) => {
    console.error('[Dashboard] Error en ruta:', err)
    if (res.headersSent) return next(err)
    res.status(500).json({ error: 'Error interno' })
  })

  dashboardIO.use((socket, next) => {
    const token = socket.handshake.auth.token
    sessions.has(token) ? (socket.user = sessions.get(token), next()) : next(new Error('No autorizado'))
  })

  dashboardIO.on('connection', socket => {
    console.log(`[Dashboard] ${socket.user.name} conectado`)
  })

  return httpServer
}
