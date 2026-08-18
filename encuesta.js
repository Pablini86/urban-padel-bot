// Motor de la encuesta de satisfacción del curso de verano. Reutiliza el sistema
// genérico de campañas (campaigns/campaign_contacts/campaign_responses) en vez de
// las tablas encuesta_contactos/encuesta_respuestas de spec_encuesta_curso_verano.md
// — los nombres de pregunta/paso vienen de ahí, pero "inicio" y "p1_nps" se
// colapsaron en uno solo porque la plantilla aprobada ya trae la pregunta de NPS
// (y sus botones) en el mismo mensaje que la saluda.
import { sendWhatsAppTemplate, sendWhatsAppButtons, sendWhatsApp } from './whatsapp.js'
import {
  getCampaign, markContactSent, markContactFailed, advanceCampaignContact,
  saveCampaignResponse, addOptOut, saveMessage, upsertContact
} from './db.js'
import { dashboardIO, humanControl } from './dashboard/server.js'

const OPT_OUT_RE = /\bbaja\b|\bstop\b|no me escriban|dar de baja/i
const P2_OPTIONS = ['Sí', 'Aún no sé', 'No']
const P4_OPTIONS = ['Sí, mándame info', 'Ahorita no']
const NPS_LABEL_TO_NUM = { '0-6': 6, '7-8': 7, '9-10': 9 }

// Se pierde si el proceso se reinicia (Railway redeploy a media encuesta) — no
// pasa nada, peor caso alguien recibe la pregunta repetida una vez de más.
const retryCount = new Map()

const sleep = ms => new Promise(r => setTimeout(r, ms))
const rateLimitDelay = () => 2000 + Math.random() * 1000

function personalizarHijo(vars) {
  const numHijos = Number(vars?.num_hijos)
  return numHijos === 1 && vars?.hijo_nombre_corto ? vars.hijo_nombre_corto : 'tus hijos'
}

function parseNps(text) {
  const t = text.trim()
  if (NPS_LABEL_TO_NUM[t] != null) return NPS_LABEL_TO_NUM[t]
  const n = Number(t)
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : null
}

function matchOption(text, options) {
  const t = text.trim().toLowerCase()
  return options.find(o => o.toLowerCase() === t) || null
}

// El interceptor del webhook llama esto ANTES de bot.js/Claude — a diferencia de
// handleIncoming, aquí nadie más guarda el mensaje en `messages` ni avisa al
// dashboard, así que hay que hacerlo aquí en los dos sentidos o las 40
// conversaciones de la encuesta se ven vacías en el panel.
async function logInbound(phone, name, text) {
  try { await upsertContact(phone, name); await saveMessage(phone, 'user', text) } catch (e) {}
  if (dashboardIO) dashboardIO.emit('new_message', { phone, role: 'user', content: text, name })
}

async function logOutbound(phone, text) {
  try { await saveMessage(phone, 'assistant', text) } catch (e) {}
  if (dashboardIO) dashboardIO.emit('new_message', { phone, role: 'assistant', content: text })
}

// Manda la plantilla a contactos ya reclamados (ver claimPendingCampaignContacts
// en db.js, que es lo que evita el doble envío) espaciando 2-3s entre cada uno.
// Un fallo en un contacto no detiene el resto del lote.
export async function sendClaimedBatch(claimed, campaign) {
  for (const contact of claimed) {
    try {
      const nombreCorto = contact.vars?.nombre_corto || 'ahí'
      const hijoCorto = personalizarHijo(contact.vars)
      const result = await sendWhatsAppTemplate(contact.phone, {
        name: campaign.template_name,
        language: campaign.template_language,
        bodyParams: [nombreCorto, hijoCorto],
        headerImageUrl: campaign.header_image_url
      })
      await markContactSent(contact.id, result?.messages?.[0]?.id || null)
      await logOutbound(contact.phone, `[Plantilla ${campaign.template_name}] Hola ${nombreCorto}, gracias por confiarnos el verano de ${hijoCorto} en Urban Pádel Life...`)
    } catch (err) {
      console.error(`[Encuesta] Error mandando a ${contact.phone}:`, err.message)
      await markContactFailed(contact.id).catch(() => {})
    }
    await sleep(rateLimitDelay())
  }
}

// Llamado por el interceptor del webhook cuando `contact` (de
// getActiveSurveyContact) indica que este teléfono está a media encuesta.
export async function handleSurveyReply(contact, phone, name, text) {
  await logInbound(phone, name, text)

  if (OPT_OUT_RE.test(text)) {
    await addOptOut(phone)
    await advanceCampaignContact(contact.id, { estado: 'opt_out' })
    const bye = 'Listo, no te vamos a volver a escribir para campañas. Si necesitas algo del club, aquí seguimos.'
    await sendWhatsApp(phone, bye)
    await logOutbound(phone, bye)
    return
  }

  if (humanControl.has(phone)) {
    console.log(`[Encuesta] ${phone} está en control humano, no avanzo el flujo automático`)
    return
  }

  const retryKey = `${phone}:${contact.paso_actual}`
  const alreadyRetried = (retryCount.get(retryKey) || 0) >= 1

  switch (contact.paso_actual) {
    case 'p1_nps': {
      const num = parseNps(text)
      if (num === null && !alreadyRetried) {
        retryCount.set(retryKey, 1)
        const q = 'No agarré tu respuesta — del 0 al 10, ¿qué tan probable es que nos recomiendes con otras familias?'
        await sendWhatsAppButtons(phone, q, [{ id: '0-6', title: '0-6' }, { id: '7-8', title: '7-8' }, { id: '9-10', title: '9-10' }])
        await logOutbound(phone, q)
        return
      }
      retryCount.delete(retryKey)
      await saveCampaignResponse({ campaignContactId: contact.id, pregunta: 'nps', valor: num === null ? 'sin_respuesta' : text, valorNum: num })

      const hijoCorto = personalizarHijo(contact.vars)
      const intro = num !== null && num >= 9 ? '¡Nos alegra muchísimo! ' : num !== null && num <= 6 ? 'Gracias por la honestidad, nos sirve mucho. ' : ''
      const q = `${intro}¿Inscribirías a ${hijoCorto} el próximo verano?`
      await sendWhatsAppButtons(phone, q, [{ id: 'si', title: 'Sí' }, { id: 'aun_no_se', title: 'Aún no sé' }, { id: 'no', title: 'No' }])
      await logOutbound(phone, q)
      await advanceCampaignContact(contact.id, { pasoActual: 'p2_reinscribe', estado: 'en_curso' })
      return
    }

    case 'p2_reinscribe': {
      const match = matchOption(text, P2_OPTIONS)
      if (!match && !alreadyRetried) {
        retryCount.set(retryKey, 1)
        const hijoCorto = personalizarHijo(contact.vars)
        const q = `No te entendí — ¿inscribirías a ${hijoCorto} el próximo verano?`
        await sendWhatsAppButtons(phone, q, [{ id: 'si', title: 'Sí' }, { id: 'aun_no_se', title: 'Aún no sé' }, { id: 'no', title: 'No' }])
        await logOutbound(phone, q)
        return
      }
      retryCount.delete(retryKey)
      await saveCampaignResponse({ campaignContactId: contact.id, pregunta: 'reinscribe', valor: match || 'sin_respuesta' })

      const q = 'Última: ¿algo que podamos mejorar para la próxima edición?'
      await sendWhatsApp(phone, q)
      await logOutbound(phone, q)
      await advanceCampaignContact(contact.id, { pasoActual: 'p3_mejora' })
      return
    }

    case 'p3_mejora': {
      // Pregunta abierta — cualquier texto cuenta como respuesta, no hay reintento.
      await saveCampaignResponse({ campaignContactId: contact.id, pregunta: 'mejora', valor: text })

      const q = 'Gracias. Una cosa más: tenemos clínica infantil de pádel todo el año, grupos por edad y con los mismos profes del curso. ¿Te paso info y horarios?'
      await sendWhatsAppButtons(phone, q, [{ id: 'clinica_si', title: 'Sí, mándame info' }, { id: 'clinica_no', title: 'Ahorita no' }])
      await logOutbound(phone, q)
      await advanceCampaignContact(contact.id, { pasoActual: 'p4_clinica' })
      return
    }

    case 'p4_clinica': {
      const match = matchOption(text, P4_OPTIONS)
      if (!match && !alreadyRetried) {
        retryCount.set(retryKey, 1)
        const q = 'No te entendí — ¿te paso info y horarios de la clínica infantil?'
        await sendWhatsAppButtons(phone, q, [{ id: 'clinica_si', title: 'Sí, mándame info' }, { id: 'clinica_no', title: 'Ahorita no' }])
        await logOutbound(phone, q)
        return
      }
      retryCount.delete(retryKey)
      await saveCampaignResponse({ campaignContactId: contact.id, pregunta: 'clinica', valor: match || 'sin_respuesta' })

      const wantsClinic = (match || '').toLowerCase().startsWith('sí')
      const closing = wantsClinic
        ? 'Perfecto, en breve un profe te contacta para acomodarlo en el grupo de su edad. Cualquier duda, aquí estamos.'
        : 'Gracias por tu tiempo. Si algún día quieres info de la clínica, escríbenos por aquí.'
      await sendWhatsApp(phone, closing)
      await logOutbound(phone, closing)
      await advanceCampaignContact(contact.id, { pasoActual: 'cierre', estado: 'completado' })
      return
    }

    default:
      console.log(`[Encuesta] ${phone} en paso desconocido "${contact.paso_actual}", ignorando`)
  }
}
