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

function buildComponents({ bodyText, variableExamples, buttons }) {
  const components = []

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

export async function submitTemplateToMeta({ name, language, category, bodyText, variableExamples, buttons }) {
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
      components: buildComponents({ bodyText, variableExamples, buttons })
    })
  })

  const data = await safeJson(res)
  if (!res.ok) {
    const detail = data?.error?.error_user_msg || data?.error?.message || JSON.stringify(data)
    throw new Error(`Meta rechazó la plantilla: ${detail}`)
  }
  // Meta responde { id, status: 'PENDING', category }
  return { metaTemplateId: data.id, status: (data.status || 'PENDING').toLowerCase() }
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
