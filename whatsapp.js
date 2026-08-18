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

export async function sendWhatsApp(to, text) {
  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`

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
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: headerImageUrl } }] })
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
// caracteres (límite de WhatsApp).
export async function sendWhatsAppButtons(to, text, buttons) {
  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`

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
      interactive: {
        type: 'button',
        body: { text },
        action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) }
      }
    })
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp API error: ${err}`)
  }

  return res.json()
}
