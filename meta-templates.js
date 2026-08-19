// Envía y consulta plantillas de mensaje directamente en la API de Meta,
// para no depender de que alguien entre a WhatsApp Manager a mano.
// Requiere permisos distintos a los de mandar mensajes normales:
// WABA_ID (WhatsApp Business Account ID) + WHATSAPP_MGMT_TOKEN con el
// permiso whatsapp_business_management.

const API = 'https://graph.facebook.com/v19.0'

// Meta debería responder siempre JSON, pero una respuesta inesperada (bloqueo
// de red, página de error genérica, etc.) no debe tronar con un error críptico.
async function safeJson(res) {
  const text = await res.text()
  try { return JSON.parse(text) }
  catch { return { error: { message: `Respuesta no válida de Meta (HTTP ${res.status}): ${text.slice(0, 200)}` } } }
}

function buildComponents({ bodyText, variableExamples, buttons, headerHandle }) {
  const components = []

  if (headerHandle) {
    components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: [headerHandle] } })
  }

  const body = { type: 'BODY', text: bodyText }
  if (variableExamples?.length) {
    body.example = { body_text: [variableExamples] }
  }
  components.push(body)

  if (buttons?.length) {
    components.push({
      type: 'BUTTONS',
      buttons: buttons.map(text => ({ type: 'QUICK_REPLY', text }))
    })
  }

  return components
}

// Sube una imagen de muestra para el header de una plantilla usando la Resumable
// Upload API de Meta (distinta del endpoint normal de /media para mandar mensajes).
// Requiere WHATSAPP_APP_ID (el ID de la app de Meta, no el WABA_ID) porque la sesión
// de subida se crea contra el nodo de la app, no contra la cuenta de WhatsApp.
export async function uploadTemplateHeaderImage({ buffer, mimeType }) {
  const appId = process.env.WHATSAPP_APP_ID
  const token = process.env.WHATSAPP_MGMT_TOKEN
  if (!appId) throw new Error('Falta WHATSAPP_APP_ID en las variables de entorno (ID de la app de Meta, no el WABA_ID)')
  if (!token) throw new Error('Falta WHATSAPP_MGMT_TOKEN')

  const sessionRes = await fetch(
    `${API}/${appId}/uploads?file_length=${buffer.length}&file_type=${encodeURIComponent(mimeType)}&access_token=${encodeURIComponent(token)}`,
    { method: 'POST' }
  )
  const session = await safeJson(sessionRes)
  if (!sessionRes.ok || !session.id) {
    const detail = session?.error?.error_user_msg || session?.error?.message || JSON.stringify(session)
    throw new Error(`No se pudo iniciar la subida de la imagen a Meta: ${detail}`)
  }

  const uploadRes = await fetch(`${API}/${session.id}`, {
    method: 'POST',
    headers: {
      'Authorization': `OAuth ${token}`,
      'file_offset': '0',
      'Content-Type': 'application/octet-stream'
    },
    body: buffer
  })
  const upload = await safeJson(uploadRes)
  if (!uploadRes.ok || !upload.h) {
    const detail = upload?.error?.error_user_msg || upload?.error?.message || JSON.stringify(upload)
    throw new Error(`Meta rechazó la imagen: ${detail}`)
  }
  return upload.h
}

export async function submitTemplateToMeta({ name, language, category, bodyText, variableExamples, buttons, headerHandle }) {
  const wabaId = process.env.WABA_ID
  const token = process.env.WHATSAPP_MGMT_TOKEN
  if (!wabaId || !token) {
    throw new Error('Faltan WABA_ID o WHATSAPP_MGMT_TOKEN en las variables de entorno')
  }

  const res = await fetch(`${API}/${wabaId}/message_templates`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name,
      language: language || 'es_MX',
      category: category || 'UTILITY',
      components: buildComponents({ bodyText, variableExamples, buttons, headerHandle })
    })
  })

  const data = await safeJson(res)
  if (!res.ok) {
    const detail = data?.error?.error_user_msg || data?.error?.message || JSON.stringify(data)
    throw new Error(`Meta rechazó la plantilla: ${detail}`)
  }
  // Meta responde { id, status: 'PENDING', category } — la category que regresa
  // es la que Meta realmente asignó, que puede no ser la que pedimos.
  return { metaTemplateId: data.id, status: (data.status || 'PENDING').toLowerCase(), category: data.category || category }
}

// Edita el contenido de una plantilla YA aprobada, en vez de crear una nueva con
// otro nombre. Nombre e idioma son inmutables — solo se puede cambiar el
// contenido (texto/botones/header). Meta manda la edición a revisión, pero la
// versión aprobada anterior se sigue usando para enviar mensajes mientras tanto,
// así que esto no interrumpe una campaña en curso.
export async function editTemplateOnMeta(metaTemplateId, { bodyText, variableExamples, buttons, headerHandle }) {
  const token = process.env.WHATSAPP_MGMT_TOKEN
  if (!token) throw new Error('Falta WHATSAPP_MGMT_TOKEN')

  const res = await fetch(`${API}/${metaTemplateId}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      components: buildComponents({ bodyText, variableExamples, buttons, headerHandle })
    })
  })

  const data = await safeJson(res)
  if (!res.ok || data.success === false) {
    const detail = data?.error?.error_user_msg || data?.error?.message || JSON.stringify(data)
    throw new Error(`Meta rechazó la edición de la plantilla: ${detail}`)
  }
  return { status: 'pendiente' }
}

export async function checkTemplateStatus(metaTemplateId) {
  const token = process.env.WHATSAPP_MGMT_TOKEN
  if (!token) throw new Error('Falta WHATSAPP_MGMT_TOKEN')

  const res = await fetch(`${API}/${metaTemplateId}?fields=status,rejected_reason`, {
    headers: { 'Authorization': `Bearer ${token}` }
  })
  const data = await safeJson(res)
  if (!res.ok) {
    throw new Error(data?.error?.message || 'Error consultando estado en Meta')
  }
  return { status: (data.status || '').toLowerCase(), rejectedReason: data.rejected_reason || null }
}
