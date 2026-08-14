import Anthropic from '@anthropic-ai/sdk'
import { getAvailability } from './playtomic.js'
import { sendWhatsApp } from './whatsapp.js'
import { saveMessage, upsertContact, addLabelIfMissing, getActiveAutomations, incrementAutomationTrigger } from './db.js'
import { dashboardIO, humanControl } from './dashboard/server.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
export const conversations = new Map()

const SYSTEM_PROMPT = `Eres el asistente virtual de Urban Pádel Life, un club de pádel en Guadalajara, México.

Tu tono es amable, directo y casual — como un amigo que conoce bien el club. Sin listas de menú, sin asteriscos, sin formato raro. Escribe como si fuera WhatsApp normal.

INFORMACIÓN DEL CLUB:
- Nombre: Urban Pádel Life Las Rosas
- Dirección: Av. de las Rosas 171-B, Chapalita, Guadalajara
- Horario: todos los días 7:00am a 11:00pm
- Canchas: 6 canchas de pádel
- Reservas: por Playtomic → https://playtomic.com/es/clubs/urban-padel-life
- Contacto general: +52 33 3486 8183

PRECIOS DE RENTA DE CANCHA:
- Desde $680 MXN por hora (varía según horario y duración)

EQUIPAMIENTO:
- Renta de pala: $100 MXN
- Pelotas: no se rentan, se venden en $160 MXN el cilindro de 3

CLASES Y ACADEMIA:
Clases particulares (Academia Deportiva):
- Clase particular (1 jugador): $700 MXN (incluye pala)
- Clase para 2 jugadores: $800 MXN (incluye palas)
- Clase para 3 jugadores: $1,000 MXN (incluye palas)
- Clase para 4 jugadores: $1,200 MXN (incluye palas)

Clínica para niños ($1,200 MXN mensuales, horario 4:00 - 5:00pm):
- Lunes y miércoles: Intermedio/Avanzado (10-15 años)
- Martes y jueves: Básico (5-9 años)

Para agendar clases, contactar a los profesores directamente:
- Gustavo Shraidt: +52 644 173 0434
- Carlos Peregrina: +52 33 1250 0725
- Edgar Huerta: +52 33 3390 8396

ROUND ROBIN:
La asignación de canchas en torneos round robin la manejan los profes, contactarlos directamente.

SNACK BAR:
Sí hay snack bar con hamburguesas, hot dogs, paninis, cervezas nacionales.

ESTACIONAMIENTO:
Hay estacionamiento con vigilancia, cuota de recuperación de $25 MXN con sello del club.

TERRAZA CON ASADOR:
Contamos con terraza con asador disponible para renta. Para cotizaciones contactar directamente al club: +52 33 3486 8183.

REGLAS DE CONVERSACIÓN:
1. Cuando alguien diga que quiere reservar o jugar, NO mandes el link de inmediato. Primero pregunta para cuándo (qué día) y a qué hora, de forma natural.
2. Solo después de tener el día y turno (mañana/tarde), consulta disponibilidad y muestra los horarios disponibles.
3. Una vez que el cliente elige horario, entonces sí manda el link de Playtomic para que complete la reserva.
4. Si preguntan disponibilidad sin especificar turno, pregunta: "¿En la mañana o en la tarde?"
5. Muestra solo los HORARIOS disponibles, no el número de cancha a menos que pregunten.
6. Si no sabes algo, manda al contacto del club: +52 33 3486 8183
7. Respuestas cortas y naturales, máximo 4-5 líneas, sin listas ni asteriscos.
8. NUNCA inventes disponibilidad. Si no tienes datos reales de Playtomic en este mensaje, di que vas a consultar o manda al cliente directamente a Playtomic.
9. La zona horaria es Guadalajara (CDT, UTC-6)
10. Cuando alguien diga una hora sin AM/PM, usa el contexto: si ya hablaron de tarde/noche, asume PM. Nunca confundas 9pm con 9am.
11. La disponibilidad viene en formato "HH:MM (Cancha X, Cancha Y)" — cuando pregunten qué cancha hay a cierta hora, responde con las canchas específicas de ese slot.
12. Si preguntan directamente si eres un bot, una IA o un robot, contesta que sí con toda naturalidad. Nunca lo niegues ni evadas la pregunta.`

const WANTS_HUMAN_RE = /hablar\s+con\s+(un\w*\s+)?(humano|persona|alguien|agente|asesor)|persona\s+real|atenci[oó]n\s+humana|quiero\s+un\s+humano|p[aá]same\s+con|comun[ií]\w*\s+con\s+(alguien|un\w*)/i

export async function handleIncoming(from, name, userMessage) {
  if (!conversations.has(from)) conversations.set(from, [])
  const history = conversations.get(from)
  const isFirstMessage = history.length === 0

  // Guardar contacto y mensaje en DB
  try {
    await upsertContact(from, name)
    await saveMessage(from, 'user', userMessage)
  } catch (e) { console.error('[DB] Error guardando mensaje:', e.message) }

  history.push({ role: 'user', content: userMessage })
  if (history.length > 12) history.splice(0, history.length - 12)

  // Notificar al dashboard
  if (dashboardIO) dashboardIO.emit('new_message', { phone: from, role: 'user', content: userMessage, name })

  // Si un humano tiene el control, no responder con bot
  if (humanControl.has(from)) {
    console.log(`[Bot] ${from} está en control humano, no respondo`)
    return
  }

  // Reglas de palabra clave configuradas en el panel — si una coincide, responde
  // directo con el texto fijo y no llega a gastar una llamada a Claude.
  try {
    const matched = await matchAutomation(userMessage)
    if (matched) {
      history.push({ role: 'assistant', content: matched.reply_text })
      await sendWhatsApp(from, matched.reply_text)
      try { await saveMessage(from, 'assistant', matched.reply_text) } catch (e) {}
      if (dashboardIO) dashboardIO.emit('new_message', { phone: from, role: 'assistant', content: matched.reply_text })
      incrementAutomationTrigger(matched.id).catch(() => {})
      console.log(`[Bot -> ${name}] (automatización "${matched.name}"): ${matched.reply_text}`)
      return
    }
  } catch (e) { console.error('[DB] Error revisando automatizaciones:', e.message) }

  // Detectar si pide hablar con una persona y avisar al equipo (etiqueta + notificación al dashboard)
  const wantsHuman = WANTS_HUMAN_RE.test(userMessage)
  if (wantsHuman) {
    try { await addLabelIfMissing(from, 'Necesita humano') } catch (e) { console.error('[DB] Error etiquetando:', e.message) }
    if (dashboardIO) dashboardIO.emit('needs_human', { phone: from, name })
  }

  const fullContext = history.map(m => m.content).join(' ').toLowerCase()
  const wantsAvailability = /dispon|reserv|jugar|cancha|horario|slot|libre/.test(fullContext)

  let contextExtra = ''
  if (isFirstMessage) {
    contextExtra += `\n\nINSTRUCCIÓN: Este es el primer mensaje de este contacto. Antes de responder su pregunta, acláralo en una frase breve y natural (no siempre la misma) que eres el asistente virtual con inteligencia artificial de Urban Pádel Life, no una persona.`
  }
  if (wantsHuman) {
    contextExtra += `\n\nINSTRUCCIÓN: El cliente pidió hablar con una persona. Ya se le avisó al equipo del club y alguien lo va a contactar. Acláraselo brevemente y sigue ayudando en lo que puedas mientras tanto con la información que tienes.`
  }
  if (wantsAvailability) {
    try {
      const availability = await getAvailability(1)
      if (availability) {
        contextExtra += `\n\nDISPONIBILIDAD REAL DE PLAYTOMIC (consultada ahora mismo):
${availability}

INSTRUCCIÓN CRÍTICA SOBRE DISPONIBILIDAD: 
- Los horarios listados son los que Playtomic reporta como posiblemente disponibles, pero la disponibilidad final se confirma al entrar a Playtomic.
- SOLO menciona horarios entre 07:00 y 23:30 que aparezcan en la lista.
- Nunca menciones horarios de madrugada (00:00 a 06:00).
- Cuando el cliente elija un horario, dile: "Te mando el link para que lo confirmes en Playtomic, ahí ves la disponibilidad exacta" — nunca garantices que está disponible.`
      }
    } catch (err) {
      console.error('Error Playtomic:', err)
    }
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 350,
    system: SYSTEM_PROMPT + contextExtra,
    messages: history
  })

  const reply = response.content[0].text
  history.push({ role: 'assistant', content: reply })

  await sendWhatsApp(from, reply)

  // Guardar respuesta del bot en DB
  try { await saveMessage(from, 'assistant', reply) } catch (e) {}

  // Notificar al dashboard la respuesta del bot
  if (dashboardIO) dashboardIO.emit('new_message', { phone: from, role: 'assistant', content: reply })

  console.log(`[Bot -> ${name}]: ${reply}`)
}

// Quita acentos para que "cuánto" y "cuanto" hagan match igual — en WhatsApp la
// mitad de la gente escribe con acentos y la otra mitad no.
function normalize(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

// Busca la primera automatización activa cuya palabra clave aparezca en el mensaje.
async function matchAutomation(userMessage) {
  const rules = await getActiveAutomations()
  if (!rules.length) return null
  const text = normalize(userMessage)
  return rules.find(r => r.keywords.some(k => text.includes(normalize(k)))) || null
}
