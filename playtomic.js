const CLIENT_ID = process.env.PLAYTOMIC_CLIENT_ID
const CLIENT_SECRET = process.env.PLAYTOMIC_CLIENT_SECRET
const TENANT_ID = process.env.PLAYTOMIC_TENANT_ID

let accessToken = null
let tokenExpiry = 0

async function getToken() {
  if (accessToken && Date.now() < tokenExpiry) return accessToken

  const res = await fetch('https://api.playtomic.io/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Token error: ${err}`)
  }

  const data = await res.json()
  accessToken = data.access_token
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000
  console.log('[Playtomic] Token obtenido, expira en', data.expires_in, 'seg')
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

      // Obtener reservas del día para saber qué está ocupado
      const from = `${dateStr}T00:00:00Z`
      const to = `${dateStr}T23:59:59Z`

      const params = new URLSearchParams({
        tenant_id: TENANT_ID,
        from,
        to,
        size: 200
      })

      const res = await fetch(`https://api.playtomic.io/v1/bookings?${params}`, {
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
        const startTime = booking.start_time || booking.startTime || booking.start_date
        if (startTime) {
          // Convertir UTC a hora México
          const d = new Date(startTime)
          const mexicoMs = d.getTime() + (-6 * 60 * 60000) - d.getTimezoneOffset() * 60000
          const mxDate = new Date(mexicoMs)
          const h = mxDate.getHours().toString().padStart(2, '0')
          const m = mxDate.getMinutes().toString().padStart(2, '0')
          occupied.add(`${h}:${m}`)
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
