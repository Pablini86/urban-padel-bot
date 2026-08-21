import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import sharp from 'sharp'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { sendWhatsApp, getWhatsAppBusinessInfo } from '../whatsapp.js'
import { submitTemplateToMeta, editTemplateOnMeta, checkTemplateStatus, uploadTemplateHeaderImage } from '../meta-templates.js'
import { parseCsv } from '../csv.js'
import { normalizeMxPhone } from '../phone.js'
import { sendClaimedBatch } from '../encuesta.js'
import {
  initDB, upsertContact, updateContact, getContact, markConversationOpened,
  getAllContacts, getAllLabels, setContactLabels, createLabel, importContacts,
  createContact, setContactOptIn, deleteContact, getContactCampaigns,
  saveMessage, getMessages, getRecentConversations,
  createTemplate, getTemplates, getTemplate, setTemplateSubmitted, setTemplateError, setTemplateStatus, deleteTemplate,
  updateTemplateContent,
  createCampaign, getCampaigns, getCampaign, getCampaignContacts, getCampaignStats,
  addAudienceFromLabel, countLabelAudience, claimPendingCampaignContacts,
  getAutomations, createAutomation, updateAutomation, setAutomationActive, deleteAutomation,
  getSurveySteps, updateSurveyStep
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

  // Ficha de un contacto: datos + a qué campañas pertenece y en qué paso va cada
  // una. Ojo: a propósito NO usa /conversations/:phone (esa marca la conversación
  // como 'abierto', lo cual está bien al abrir un chat pero no al solo ver la ficha
  // desde la lista de Contactos).
  app.get('/dashboard/api/contacts/:phone', auth, ah(async (req, res) => {
    const contact = await getContact(req.params.phone)
    if (!contact) return res.status(404).json({ error: 'No existe ese contacto' })
    const campaigns = await getContactCampaigns(req.params.phone)
    res.json({ ...contact, campaigns })
  }))

  // Alta manual de un contacto (ej. para armar una audiencia chica de prueba
  // antes de mandarle una campaña real a toda la base).
  app.post('/dashboard/api/contacts', auth, express.json(), ah(async (req, res) => {
    const { phone, name, optIn, labelIds } = req.body
    const normalized = normalizeMxPhone(phone)
    if (normalized.length !== 13) {
      return res.status(400).json({ error: 'El teléfono debe ser un celular mexicano válido (10 dígitos, ej. 33 1234 5678)' })
    }
    const contact = await createContact({ phone: normalized, name, optIn: !!optIn, labelIds })
    res.json(contact)
  }))

  app.post('/dashboard/api/contacts/:phone/opt-in', auth, express.json(), ah(async (req, res) => {
    await setContactOptIn(req.params.phone, !!req.body.optIn)
    res.json({ ok: true })
  }))

  app.delete('/dashboard/api/contacts/:phone', auth, ah(async (req, res) => {
    await deleteContact(req.params.phone)
    res.json({ ok: true })
  }))

  // Importa contactos desde un CSV (ej. base de una campaña), les pone una etiqueta
  // para poder segmentarlos después, y opcionalmente los marca como opt-in. Necesita
  // una columna de teléfono; el resto de las columnas quedan como variables para
  // personalizar plantillas (ver addAudienceFromLabel en db.js).
  app.post('/dashboard/api/contacts/import', auth, express.json({ limit: '2mb' }), ah(async (req, res) => {
    const { csv, labelName, labelColor, confirmOptIn } = req.body
    if (!csv?.trim()) return res.status(400).json({ error: 'Falta el archivo CSV' })
    if (!labelName?.trim()) return res.status(400).json({ error: 'Falta la etiqueta para segmentar estos contactos' })

    const records = parseCsv(csv)
    if (!records.length) return res.status(400).json({ error: 'El CSV no tiene filas' })

    const headers = Object.keys(records[0])
    const phoneKey = headers.find(h => /^(telefono|tel[eé]fono|phone|celular)$/i.test(h))
    if (!phoneKey) return res.status(400).json({ error: 'El CSV necesita una columna de teléfono (telefono o phone)' })
    const nameKey = headers.find(h => /^(nombre_corto|nombre|name)$/i.test(h))

    const rows = records.map(r => {
      const vars = {}
      for (const h of headers) {
        if (h === phoneKey || h === nameKey) continue
        if (r[h]) vars[h] = r[h]
      }
      return { phone: normalizeMxPhone(r[phoneKey]), name: nameKey ? r[nameKey] : null, vars }
    }).filter(r => r.phone)

    if (!rows.length) return res.status(400).json({ error: 'Ninguna fila tuvo un teléfono válido' })

    const { imported, label } = await importContacts(rows, {
      labelName: labelName.trim(), labelColor, markOptedIn: !!confirmOptIn
    })
    res.json({ imported, total: records.length, label })
  }))

  // Estado de la conexión de WhatsApp: nombre/número verificados en Meta (vía
  // Graph API, cacheado) y qué credenciales están configuradas en Railway. Los
  // valores nunca salen completos del servidor — solo si están configurados y
  // sus últimos 4 caracteres, para que el equipo pueda confirmar cuál token
  // está activo sin poder copiarlo desde el dashboard (ver [[urban_padel_bot_context]]).
  const maskCredential = v => v ? { configured: true, last4: v.slice(-4) } : { configured: false }
  app.get('/dashboard/api/whatsapp-status', auth, ah(async (req, res) => {
    const info = await getWhatsAppBusinessInfo().catch(() => null)
    res.json({
      businessName: info?.businessName || null,
      phoneNumber: info?.phoneNumber || null,
      credentials: {
        WHATSAPP_TOKEN: maskCredential(process.env.WHATSAPP_TOKEN),
        PHONE_NUMBER_ID: maskCredential(process.env.PHONE_NUMBER_ID),
        WABA_ID: maskCredential(process.env.WABA_ID),
        WHATSAPP_APP_ID: maskCredential(process.env.WHATSAPP_APP_ID),
        WHATSAPP_MGMT_TOKEN: maskCredential(process.env.WHATSAPP_MGMT_TOKEN),
      }
    })
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

  // Formato horizontal recomendado por Meta para header images (1.91:1, mismo
  // ratio que usa el link preview) — Pablo pidió que las fotos "queden chicas y
  // horizontales" en vez de tener que recortarlas él a mano antes de subirlas.
  const HEADER_IMG_WIDTH = 1125
  const HEADER_IMG_HEIGHT = 600

  // Descarga o decodifica la imagen de header antes de mandarla a Meta. Acepta
  // una URL externa (headerImageUrl) o un archivo ya convertido a data URI en el
  // navegador (headerImageBase64) — lo que haya puesto el agente en el formulario.
  // Cualquiera de las dos se recorta/redimensiona sola al formato horizontal de
  // WhatsApp con sharp ("cover", sin deformar), así el preview que se guarda ya
  // es exactamente la imagen que se manda a Meta.
  async function resolveHeaderImage({ headerImageUrl, headerImageBase64 }) {
    let rawBuffer
    if (headerImageBase64) {
      const match = /^data:(.+?);base64,(.+)$/.exec(headerImageBase64)
      if (!match) throw new Error('La imagen subida no tiene un formato válido')
      rawBuffer = Buffer.from(match[2], 'base64')
    } else if (headerImageUrl) {
      const imgRes = await fetch(headerImageUrl)
      if (!imgRes.ok) throw new Error(`No se pudo descargar la imagen de la URL (HTTP ${imgRes.status})`)
      rawBuffer = Buffer.from(await imgRes.arrayBuffer())
    } else {
      return null
    }

    let buffer
    try {
      buffer = await sharp(rawBuffer)
        .resize(HEADER_IMG_WIDTH, HEADER_IMG_HEIGHT, { fit: 'cover', position: 'attention' })
        .jpeg({ quality: 85 })
        .toBuffer()
    } catch (err) {
      throw new Error('No se pudo procesar la imagen — prueba con otra foto (JPG o PNG)')
    }
    const mimeType = 'image/jpeg'
    const displayUrl = `data:${mimeType};base64,${buffer.toString('base64')}`
    return { buffer, mimeType, displayUrl }
  }

  // Meta exige minúsculas, números y guion bajo únicamente — el formulario ya
  // normaliza el nombre mientras el usuario escribe, esto es la última barrera.
  const TEMPLATE_NAME_RE = /^[a-z0-9_]+$/
  const TEMPLATE_CATEGORIES = ['UTILITY', 'MARKETING']

  // Revisa que las variables {{1}}, {{2}}... del texto sean consecutivas desde 1
  // (Meta rechaza los saltos) y que traigan el mismo número de ejemplos, porque
  // sin eso Meta también rechaza la plantilla — mejor detectarlo aquí que esperar
  // el rebote de Meta con un mensaje críptico.
  function validatePlaceholders(bodyText, exampleList) {
    const nums = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]))
    const unique = [...new Set(nums)].sort((a, b) => a - b)
    if (unique.length && !unique.every((n, i) => n === i + 1)) {
      return `Las variables del mensaje deben ir en orden desde {{1}} sin saltos (encontré: ${unique.map(n => `{{${n}}}`).join(', ')})`
    }
    if (unique.length !== exampleList.length) {
      return `El mensaje usa ${unique.length} variable(s) pero se dieron ${exampleList.length} ejemplo(s) — deben ser el mismo número`
    }
    return null
  }

  // Límite alto porque headerImageBase64 puede traer una foto completa como data URI.
  app.post('/dashboard/api/templates', auth, express.json({ limit: '10mb' }), ah(async (req, res) => {
    const { name, bodyPreview, variables, buttons, examples, category, headerImageUrl, headerImageBase64 } = req.body
    if (!name?.trim()) return res.status(400).json({ error: 'Falta el nombre de la plantilla' })
    if (!TEMPLATE_NAME_RE.test(name.trim())) {
      return res.status(400).json({ error: 'El nombre solo puede tener minúsculas, números y guion bajo (sin espacios ni acentos)' })
    }
    if (!bodyPreview?.trim()) return res.status(400).json({ error: 'Falta el texto del mensaje' })
    const variableList = (variables || '').split('|').map(v => v.trim()).filter(Boolean)
    const buttonList = (buttons || '').split('|').map(v => v.trim()).filter(Boolean)
    const exampleList = (examples || '').split('|').map(v => v.trim()).filter(Boolean)
    const templateCategory = TEMPLATE_CATEGORIES.includes(category) ? category : 'UTILITY'

    const placeholderError = validatePlaceholders(bodyPreview.trim(), exampleList)
    if (placeholderError) return res.status(400).json({ error: placeholderError })

    let image = null
    try {
      image = await resolveHeaderImage({ headerImageUrl, headerImageBase64 })
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }

    const template = await createTemplate({
      name: name.trim(), language: 'es_MX', category: templateCategory,
      bodyPreview: bodyPreview.trim(), variables: variableList, buttons: buttonList,
      headerImageUrl: image?.displayUrl
    })

    try {
      let headerHandle = null
      if (image) headerHandle = await uploadTemplateHeaderImage(image)
      const { metaTemplateId, status, category: metaCategory } = await submitTemplateToMeta({
        name: name.trim(), language: 'es_MX', category: templateCategory,
        bodyText: bodyPreview.trim(), variableExamples: exampleList, buttons: buttonList, headerHandle
      })
      await setTemplateSubmitted(template.id, { metaTemplateId, status, category: metaCategory })
    } catch (err) {
      await setTemplateError(template.id, err.message)
    }

    res.json(await getTemplate(template.id))
  }))

  // Edita el texto/botones/imagen de una plantilla YA mandada a Meta — mismo
  // nombre e idioma (Meta no permite cambiarlos), Meta la vuelve a mandar a
  // revisión pero la versión aprobada sigue enviándose mientras tanto, así que
  // esto no interrumpe una campaña en curso.
  app.put('/dashboard/api/templates/:id', auth, express.json({ limit: '10mb' }), ah(async (req, res) => {
    const template = await getTemplate(req.params.id)
    if (!template) return res.status(404).json({ error: 'No existe esa plantilla' })
    if (!template.meta_template_id) return res.status(400).json({ error: 'Esta plantilla nunca se mandó a Meta — bórrala y créala de nuevo' })

    const { bodyPreview, variables, buttons, examples, headerImageUrl, headerImageBase64 } = req.body
    if (!bodyPreview?.trim()) return res.status(400).json({ error: 'Falta el texto del mensaje' })
    const variableList = (variables || '').split('|').map(v => v.trim()).filter(Boolean)
    const buttonList = (buttons || '').split('|').map(v => v.trim()).filter(Boolean)
    const exampleList = (examples || '').split('|').map(v => v.trim()).filter(Boolean)

    const placeholderError = validatePlaceholders(bodyPreview.trim(), exampleList)
    if (placeholderError) return res.status(400).json({ error: placeholderError })

    // Si no se sube una imagen nueva en el formulario de edición, hay que
    // re-mandar la que ya tenía — Meta trata los componentes que no vienen en
    // la edición como quitados, así que omitir el header lo borraría del todo.
    let imageInput = { headerImageUrl, headerImageBase64 }
    if (!headerImageUrl && !headerImageBase64 && template.header_image_url) {
      imageInput = template.header_image_url.startsWith('data:')
        ? { headerImageBase64: template.header_image_url }
        : { headerImageUrl: template.header_image_url }
    }

    let image = null
    try {
      image = await resolveHeaderImage(imageInput)
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }

    await updateTemplateContent(template.id, {
      bodyPreview: bodyPreview.trim(), variables: variableList, buttons: buttonList,
      headerImageUrl: image?.displayUrl || null
    })

    try {
      let headerHandle = null
      if (image) headerHandle = await uploadTemplateHeaderImage(image)
      const { status } = await editTemplateOnMeta(template.meta_template_id, {
        bodyText: bodyPreview.trim(), variableExamples: exampleList, buttons: buttonList, headerHandle
      })
      await setTemplateStatus(template.id, { status, rejectedReason: null })
    } catch (err) {
      // El texto ya se guardó localmente aunque Meta rechace la edición — así
      // no se pierde lo escrito y se puede reintentar sin volver a capturarlo.
      return res.status(502).json({ error: err.message })
    }

    res.json(await getTemplate(template.id))
  }))

  // Borra una plantilla que nunca se aprobó / falló al mandarse. Si ya tiene una
  // campaña creada, deleteTemplate() truena con un mensaje legible en vez del 500 genérico.
  app.delete('/dashboard/api/templates/:id', auth, ah(async (req, res) => {
    const template = await getTemplate(req.params.id)
    if (!template) return res.status(404).json({ error: 'No existe esa plantilla' })
    try {
      await deleteTemplate(req.params.id)
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }
    res.json({ ok: true })
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

  // Mensajes de la encuesta post-curso — ver comentario de la tabla survey_steps
  // en db.js. El primer mensaje (con la pregunta de NPS) NO está aquí: vive en
  // la plantilla aprobada por Meta, se edita creando una plantilla nueva.
  app.get('/dashboard/api/survey-steps', auth, ah(async (req, res) => {
    res.json(await getSurveySteps())
  }))

  // Límite alto por la misma razón que en /templates: imageBase64 puede traer
  // una foto completa como data URI.
  app.put('/dashboard/api/survey-steps/:step', auth, express.json({ limit: '10mb' }), ah(async (req, res) => {
    const { text, options, imageUrl, imageBase64 } = req.body
    if (!text?.trim()) return res.status(400).json({ error: 'Falta el texto del mensaje' })

    let image = null
    try {
      image = await resolveHeaderImage({ headerImageUrl: imageUrl, headerImageBase64: imageBase64 })
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }

    const updated = await updateSurveyStep(req.params.step, { text: text.trim(), options, imageUrl: image?.displayUrl })
    if (!updated) return res.status(404).json({ error: 'No existe ese paso' })
    res.json(updated)
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

  // Manda el siguiente lote de la campaña (hasta daily_cap contactos). Reclama
  // los contactos "pendiente" de forma atómica antes de responder — así, si le
  // dan doble clic, el segundo clic ya no encuentra nada que reclamar. El envío
  // real corre en segundo plano (20-25 contactos a 2-3s cada uno tarda minuto y
  // medio, muy lento para esperar en la misma petición).
  app.post('/dashboard/api/campaigns/:id/send-batch', auth, ah(async (req, res) => {
    const campaign = await getCampaign(req.params.id)
    if (!campaign) return res.status(404).json({ error: 'No existe esa campaña' })
    if (campaign.template_approval_status !== 'approved') {
      return res.status(400).json({
        error: `La plantilla todavía no está aprobada por Meta (estado actual: ${campaign.template_approval_status || 'sin enviar'})`
      })
    }
    const claimed = await claimPendingCampaignContacts(campaign.id, campaign.daily_cap)
    if (!claimed.length) return res.json({ claimed: 0, message: 'No hay contactos pendientes por mandar' })
    sendClaimedBatch(claimed, campaign).catch(err => console.error('[Campaña] Error mandando lote:', err))
    res.json({ claimed: claimed.length })
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
