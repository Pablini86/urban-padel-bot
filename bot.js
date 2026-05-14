import Anthropic from '@anthropic-ai/sdk'
import { getAvailability } from './playtomic.js'
import { sendWhatsApp } from './whatsapp.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// Memoria de conversación por usuario (en RAM, simple para empezar)
const conversations = new Map()

const SYSTEM_PROMPT = `Eres el asistente virtual de Urban Padel, un club de pádel ubicado en Guadalajara, México.

Tu personalidad es amable, eficiente y con buen humor deportivo.

INFORMACIÓN DEL CLUB:
- Nombre: Urban Padel
- Horario: Lunes a domingo, 7:00am a 11:00pm
- Deportes: Pádel
- Las reservas se hacen a través de Playtomic

CÓMO MANEJAR RESERVAS:
- Cuando alguien pregunte por disponibilidad, responde que vas a consultar y usa la función check_availability
- Después de mostrar disponibilidad, ofrece el link directo de Playtomic para que reserven
- NO puedes crear reservas directamente, solo consultar disponibilidad y mandar el link

REGLAS DE RESPUESTA:
- Responde siempre en español
- Sé conciso (máximo 3-4 líneas por mensaje)
- Usa un tono amigable y deportivo
- Si no sabes algo específico del club, di que lo pueden preguntar directamente llamando al club
- No inventes precios ni información que no tengas

PREGUNTAS FRECUENTES QUE PUEDES RESPONDER:
- Horarios: 7am a 11pm todos los días
- Reservas: por Playtomic (te mando el link)
- Ubicación: pide al usuario que confirme si necesitas dar direcciones específicas`

export async function handleIncoming(from, name, userMessage) {
  // Obtener o crear historial de conversación
  if (!conversations.has(from)) {
    conversations.set(from, [])
  }
  const history = conversations.get(from)

  // Agregar mensaje del usuario al historial
  history.push({ role: 'user', content: userMessage })

  // Mantener solo los últimos 10 mensajes para no pasarse del contexto
  if (history.length > 10) history.splice(0, history.length - 10)

  // Detectar si el usuario pregunta por disponibilidad
  const askingAvailability = /dispon|cancha|hora|reserv|jugar|cuando|slot/i.test(userMessage)

  let contextExtra = ''
  if (askingAvailability) {
    try {
      const availability = await getAvailability()
      if (availability) {
        contextExtra = `\n\nDISPONIBILIDAD ACTUAL EN PLAYTOMIC (usa esta info para responder):\n${availability}`
      }
    } catch (err) {
      console.error('Error consultando Playtomic:', err)
    }
  }

  // Llamar a Claude con el historial completo
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    system: SYSTEM_PROMPT + contextExtra,
    messages: history
  })

  const reply = response.content[0].text

  // Guardar respuesta en historial
  history.push({ role: 'assistant', content: reply })

  // Enviar respuesta por WhatsApp
  await sendWhatsApp(from, reply)

  console.log(`[Bot -> ${name}]: ${reply}`)
}
