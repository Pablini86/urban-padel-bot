const CLIENT_ID = process.env.PLAYTOMIC_CLIENT_ID
const CLIENT_SECRET = process.env.PLAYTOMIC_CLIENT_SECRET
const TENANT_ID = process.env.PLAYTOMIC_TENANT_ID

let accessToken = null
let tokenExpiry = 0

async function getToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken

  const res = await fetch('https://thirdparty.playtomic.io/api/v1/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      secret: CLIENT_SECRET
    })
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Token error: ${err}`)
  }

  const data = await res.json()
  accessToken = data.token
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000
  console.log('[Playtomic] Token obtenido OK')
  return accessToken
}

function getMexicoDate(daysAhead = 0) {
  const now = new Date()
  const mexicoOffset = -6 * 60
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000
  const mexicoMs = utcMs + mexicoOffset * 60000
  const mexicoDate = new Date(mexicoMs)
  mexicoDate.setDate(mexicoDate.getDate() + daysAhead)
  return mexicoDate
}

// Cache para no exceder 1 llamada por minuto
let cache = {}

export async function getAvailability(daysAhead = 1) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.warn('[Playtomic] Credenciales no configuradas')
    return null
  }

  const lines = []

  for (let i = 0; i <= daysAhead; i++) {
    const date = getMexicoDate(i)
    const dateStr = date.toISOString().slice(0, 10)
    const dayLabel = i === 0 ? 'HOY' : 'MAÑANA'
    const dayStr = date.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })
    const cacheKey = `${dateStr}`
    const now = Date.now()

    // Usar cache si tiene menos de 60 segundos
    if (cache[cacheKey] && (now - cache[cacheKey].ts) < 60000) {
      console.log(`[Playtomic] Usando cache para ${dateStr}`)
      lines.push(`${dayLabel} (${dayStr}): ${cache[cacheKey].slots}`)
      continue
    }

    try {
      const token = await getToken()

      const params = new URLSearchParams({
        tenant_id: TENANT_ID,
        start_booking_date: `${dateStr}T00:00:00`,
        end_booking_date: `${dateStr}T23:59:59`,
        sport_id: 'PADEL',
        size: 200
      })

      const res = await fetch(`https://thirdparty.playtomic.io/api/v1/bookings?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      })

      console.log(`[Playtomic API oficial] ${dateStr} status:`, res.status)

      if (!res.ok) {
        const err = await res.text()
        console.error('[Playtomic] Error:', err)
        lines.push(`${dayLabel} (${dayStr}): ERROR AL CONSULTAR`)
        continue
      }

      const bookings = await res.json()
      console.log(`[Playtomic] Reservas ${dateStr}:`, JSON.stringify(bookings).slice(0, 500))

      // Extraer horarios OCUPADOS
      const occupied = new Set()
      const bookingList = Array.isArray(bookings) ? bookings : bookings.content || bookings.data || []

      for (const booking of bookingList) {
        if (booking.is_canceled) continue
        const startTime = booking.booking_start_date
        if (startTime) {
          // Convertir UTC a hora México (UTC-6)
          const d = new Date(startTime)
          const mxMs = d.getTime() + (-6 * 60 * 60000)
          const mxDate = new Date(mxMs)
          const h = mxDate.getUTCHours().toString().padStart(2, '0')
          const m = mxDate.getUTCMinutes().toString().padStart(2, '0')
          // Marcar todo el bloque como ocupado según duración
          const durationMs = booking.duration / 1000 // microseconds to ms
          const slots = Math.ceil(durationMs / (30 * 60 * 1000))
          for (let s = 0; s < slots; s++) {
            const slotMs = mxMs + s * 30 * 60 * 1000
            const sd = new Date(slotMs)
            const sh = sd.getUTCHours().toString().padStart(2, '0')
            const sm = sd.getUTCMinutes().toString().padStart(2, '0')
            occupied.add(`${sh}:${sm}`)
          }
        }
      }

      console.log(`[Playtomic] Ocupados ${dateStr}:`, [...occupied])

      // Generar slots disponibles (7am-10:30pm cada 30 min) menos los ocupados
      const available = []
      for (let h = 7; h <= 22; h++) {
        for (const min of ['00', '30']) {
          if (h === 22 && min === '30') continue
          const slot = `${h.toString().padStart(2, '0')}:${min}`
          if (!occupied.has(slot)) available.push(slot)
        }
      }

      const slotsStr = available.length > 0 ? available.join(', ') : 'SIN DISPONIBILIDAD'
      cache[cacheKey] = { slots: slotsStr, ts: now }
      lines.push(`${dayLabel} (${dayStr}): ${slotsStr}`)

    } catch (err) {
      console.error(`[Playtomic] Error ${dateStr}:`, err.message)
      lines.push(`${dayLabel} (${dayStr}): ERROR AL CONSULTAR`)
    }
  }

  const result = lines.join('\n')
  console.log('[Playtomic] Resultado:\n', result)
  return result
}
