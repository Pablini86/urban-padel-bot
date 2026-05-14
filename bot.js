import Anthropic from '@anthropic-ai/sdk'
import { getAvailability } from './playtomic.js'
import { sendWhatsApp } from './whatsapp.js'

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
const conversations = new Map()

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

REGLAS DE CONVERSACIÓN:
1. Si preguntan por disponibilidad sin especificar turno, pregunta primero: "¿Mañana en la mañana o en la tarde?"
2. Cuando tengas la disponibilidad de Playtomic, muestra solo los HORARIOS disponibles (ej: "hay de 3pm a 9pm") — no menciones el número de cancha a menos que pregunten específicamente
3. Si no sabes algo o es una situación complicada, manda al contacto del club: +52 33 3486 8183
4. Respuestas cortas, máximo 4-5 líneas
5. No uses listas con viñetas ni asteriscos para dar formato — escribe en texto normal
6. No inventes información que no esté aquí
7. La zona horaria es Guadalajara (CDT, UTC-6)`

export async function handleIncoming(from, name, userMessage) {
  if (!conversations.has(from)) conversations.set(from, [])
  const history = conversations.get(from)

  history.push({ role: 'user', content: userMessage })
  if (history.length > 12) history.splice(0, history.length - 12)

  const askingAvailability = /dispon|cancha|hora|reserv|jugar|cuando|slot|turno|libre|mañana|hoy|tarde|mañana|noche/i.test(userMessage)
  const specifiedTime = /mañana|tarde|noche|am|pm|[0-9]+:[0-9]+/i.test(userMessage)

  let contextExtra = ''
  if (askingAvailability && specifiedTime) {
    try {
      const availability = await getAvailability(1)
      if (availability) {
        contextExtra = `\n\nDISPONIBILIDAD ACTUAL EN PLAYTOMIC (usa esto para responder, no lo copies tal cual, redáctalo natural):\n${availability}`
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
  console.log(`[Bot -> ${name}]: ${reply}`)
}
