let businessInfoCache = null
let businessInfoCacheAt = 0

// Nombre y número verificados del negocio en Meta — solo cambian si alguien
// los reconfigura en WhatsApp Manager, así que se cachean 1h para no golpear
// la Graph API en cada carga del dashboard.
export async function getWhatsAppBusinessInfo() {
  if (businessInfoCache && Date.now() - businessInfoCacheAt < 3600_000) return businessInfoCache
  if (!process.env.PHONE_NUMBER_ID || !process.env.WHATSAPP_TOKEN) return null
  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}?fields=display_phone_number,verified_name`
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } })
  if (!res.ok) return null
  const data = await res.json()
  businessInfoCache = { phoneNumber: data.display_phone_number, businessName: data.verified_name }
  businessInfoCacheAt = Date.now()
  return businessInfoCache
}

// Si viene imageId (ver uploadWhatsAppMedia) se manda como mensaje de imagen con
// el texto de caption, en vez de un mensaje de texto plano — usado por los pasos
// de la encuesta (Flujo) que tienen foto propia.
export async function sendWhatsApp(to, text, imageId) {
  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(imageId ? {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: { id: imageId, caption: text }
    } : {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text, preview_url: false }
    })
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp API error: ${err}`)
  }

  return res.json()
}

// Sube una foto al endpoint normal de medios (distinto de la Resumable Upload
// API que usan las plantillas) y regresa un media id que dura para mandar
// mensajes normales. Se usa para las fotos de los pasos de la encuesta editables
// desde el dashboard (Flujo), que no son plantillas de Meta.
export async function uploadWhatsAppMedia(buffer, mimeType) {
  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/media`
  const form = new FormData()
  form.append('messaging_product', 'whatsapp')
  form.append('type', mimeType)
  form.append('file', new Blob([buffer], { type: mimeType }), 'imagen.jpg')

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` },
    body: form
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp API error subiendo imagen: ${err}`)
  }

  const data = await res.json()
  return data.id
}

// header_image_url (de templates o de survey_steps) siempre se guarda ya como
// data URI recortada — nunca una URL pública real que Meta pueda ir a buscar —
// así que para mandarla hay que subirla primero con uploadWhatsAppMedia y usar
// el media id (`image.id`), no `image.link`. Cacheada por el string del data URI
// para no volver a subir la misma foto en cada envío del mismo paso/plantilla;
// se pierde en cada redeploy, lo cual está bien porque simplemente se vuelve a
// subir en el siguiente envío.
const mediaIdCache = new Map()

export async function resolveMediaId(dataUri) {
  if (!dataUri) return null
  if (mediaIdCache.has(dataUri)) return mediaIdCache.get(dataUri)
  const match = /^data:(.+?);base64,(.+)$/.exec(dataUri)
  if (!match) return null
  const id = await uploadWhatsAppMedia(Buffer.from(match[2], 'base64'), match[1])
  mediaIdCache.set(dataUri, id)
  return id
}

// Manda una plantilla aprobada por Meta (único tipo de mensaje permitido para
// iniciar conversación con alguien fuera de la ventana de 24h). Para botones de
// respuesta rápida ESTÁTICOS (definidos al crear la plantilla, como los de la
// encuesta) Meta no necesita un componente "button" en el envío — ya vienen
// horneados en la plantilla aprobada; solo hace falta mandar las variables del
// body (y del header, si la plantilla tiene imagen).
export async function sendWhatsAppTemplate(to, { name, language, bodyParams, headerImageUrl }) {
  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`
  const components = []
  if (headerImageUrl) {
    const imageId = await resolveMediaId(headerImageUrl)
    if (imageId) components.push({ type: 'header', parameters: [{ type: 'image', image: { id: imageId } }] })
  }
  if (bodyParams?.length) {
    components.push({ type: 'body', parameters: bodyParams.map(text => ({ type: 'text', text: String(text) })) })
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: { name, language: { code: language || 'es_MX' }, components }
    })
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp API error: ${err}`)
  }

  return res.json()
}

// Mensaje con botones de respuesta rápida "dinámicos" (los definimos nosotros al
// mandarlo, no vienen de una plantilla aprobada) — solo funciona dentro de la
// ventana de 24h después de que el cliente escribió, que es exactamente el caso
// de las preguntas de seguimiento de la encuesta. Máximo 3 botones, título <=20
// caracteres (límite de WhatsApp). imageId (ver uploadWhatsAppMedia) es opcional
// y agrega la foto como header del mensaje interactivo.
export async function sendWhatsAppButtons(to, text, buttons, imageId) {
  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`

  const interactive = {
    type: 'button',
    body: { text },
    action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) }
  }
  if (imageId) interactive.header = { type: 'image', image: { id: imageId } }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'interactive',
      interactive
    })
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp API error: ${err}`)
  }

  return res.json()
}
