const CLIENT_ID = process.env.PLAYTOMIC_CLIENT_ID
const CLIENT_SECRET = process.env.PLAYTOMIC_CLIENT_SECRET
const TENANT_ID = process.env.PLAYTOMIC_TENANT_ID

let accessToken = null
let tokenExpiry = 0
let cache = {}


async function getToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken

  const res = await fetch('https://thirdparty.playtomic.io/api/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, secret: CLIENT_SECRET })
  })

  if (!res.ok) throw new Error(`Token error: ${res.status}`)
  const data = await res.json()
  accessToken = data.token
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000
  console.log('[Playtomic] Token OK')
  return accessToken
}

function getMexicoDate(daysAhead = 0) {
  const now = new Date()
  const mxMs = now.getTime() + now.getTimezoneOffset() * 60000 + (-6 * 60 * 60000)
  const mxDate = new Date(mxMs)
  mxDate.setDate(mxDate.getDate() + daysAhead)
  return mxDate
}

// Convierte fecha UTC de Playtomic a hora México (UTC-6)
function utcToMexico(utcStr) {
  // Playtomic devuelve sin Z pero son UTC
  const d = new Date(utcStr.includes('Z') ? utcStr : utcStr + 'Z')
  return new Date(d.getTime() - 6 * 60 * 60 * 1000)
}

export async function getAvailability(daysAhead = 1) {
  if (!CLIENT_ID || !CLIENT_SECRET || !TENANT_ID) {
    console.warn('[Playtomic] Variables de entorno faltantes')
    return null
  }

  const lines = []

  for (let i = 0; i <= daysAhead; i++) {
    const date = getMexicoDate(i)
    const dateStr = date.toISOString().slice(0, 10)
    const dayLabel = i === 0 ? 'HOY' : 'MAÑANA'
    const dayStr = date.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })
    const cacheKey = dateStr
    const now = Date.now()

    if (cache[cacheKey] && (now - cache[cacheKey].ts) < 60000) {
      lines.push(`${dayLabel} (${dayStr}): ${cache[cacheKey].result}`)
      continue
    }

    try {
      const token = await getToken()

      // Consultar desde medianoche hasta las 6am del día siguiente (UTC)
      // para capturar reservas nocturnas (ej. 19:00-23:00 México = 01:00-05:00 UTC siguiente día)
      const nextDateStr = new Date(date.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

      const params = new URLSearchParams({
        tenant_id: TENANT_ID,
        start_booking_date: `${dateStr}T00:00:00`,
        end_booking_date: `${nextDateStr}T06:00:00`,
        sport_id: 'PADEL',
        size: 200
      })

      const res = await fetch(`https://thirdparty.playtomic.io/api/v1/bookings?${params}`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        }
      })

      if (!res.ok) {
        console.error(`[Playtomic] ${dateStr} error ${res.status}:`, await res.text())
        lines.push(`${dayLabel} (${dayStr}): ERROR AL CONSULTAR`)
        continue
      }

      const bookings = await res.json()
      const bookingList = Array.isArray(bookings) ? bookings : bookings.data || []
      console.log(`[Playtomic] ${dateStr}: ${bookingList.length} reservas`)

      // Mapear cancha -> slots ocupados
      const courtOccupied = {} // { resource_id: Set of occupied 30-min slots }

      for (const b of bookingList) {
        if (b.is_canceled) continue

        const start = utcToMexico(b.booking_start_date)
        const end = utcToMexico(b.booking_end_date)
        const courtId = b.resource_id

        if (!courtOccupied[courtId]) courtOccupied[courtId] = new Set()

        // Marcar cada slot de 30 min como ocupado
        let current = new Date(start)
        while (current < end) {
          // Usar UTC hours porque ya restamos 6h, la fecha está desplazada
          const h = current.getUTCHours().toString().padStart(2, '0')
          const m = current.getUTCMinutes().toString().padStart(2, '0')
          courtOccupied[courtId].add(`${h}:${m}`)
          current = new Date(current.getTime() + 30 * 60 * 1000)
        }
      }

      // Canchas del club
      const courts = ['Cancha 1','Cancha 2','Cancha 3','Cancha 4','Cancha 5','Cancha 6']
      const courtIds = bookingList
        .filter(b => !b.is_canceled)
        .reduce((acc, b) => {
          if (b.resource_name) acc[b.resource_name.trim()] = b.resource_id
          return acc
        }, {})

      // Calcular slots disponibles por cancha (7am - 10:30pm)
      const allSlots = []
      for (let h = 7; h <= 22; h++) {
        for (const min of [0, 30]) {
          if (h === 22 && min === 30) continue
          allSlots.push(`${h.toString().padStart(2,'0')}:${min.toString().padStart(2,'0')}`)
        }
      }

      // Un slot está disponible si AL MENOS UNA cancha lo tiene libre
      const availableSlots = allSlots.filter(slot => {
        return courts.some(courtName => {
          const cId = courtIds[courtName]
          if (!cId) return true // cancha sin reservas = disponible
          return !courtOccupied[cId]?.has(slot)
        })
      })

      console.log(`[Playtomic] ${dateStr} disponibles:`, availableSlots)

      const result = availableSlots.length > 0
        ? availableSlots.join(', ')
        : 'SIN DISPONIBILIDAD'

      cache[cacheKey] = { result, ts: now }
      lines.push(`${dayLabel} (${dayStr}): ${result}`)

    } catch (err) {
      console.error(`[Playtomic] Error ${dateStr}:`, err.message)
      lines.push(`${dayLabel} (${dayStr}): ERROR AL CONSULTAR`)
    }
  }

  return lines.join('\n')
}
