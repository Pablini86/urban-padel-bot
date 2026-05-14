const TENANT_ID = process.env.PLAYTOMIC_TENANT_ID

function getMexicoDate(daysAhead = 0) {
  const now = new Date()
  const mexicoOffset = -6 * 60
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000
  const mexicoMs = utcMs + mexicoOffset * 60000
  const mexicoDate = new Date(mexicoMs)
  mexicoDate.setDate(mexicoDate.getDate() + daysAhead)
  return mexicoDate
}

async function fetchDay(dateStr) {
  const params = new URLSearchParams({
    tenant_id: TENANT_ID,
    sport_id: 'PADEL',
    date: dateStr
  })

  const res = await fetch(`https://playtomic.com/api/clubs/availability?${params}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'application/json',
      'Referer': 'https://playtomic.com'
    }
  })

  if (!res.ok) return []
  const data = await res.json()

  // Recolectar todos los slots únicos, filtrar madrugada (antes de 7am)
  const allSlots = new Set()
  for (const resource of (Array.isArray(data) ? data : [])) {
    for (const slot of (resource.slots || [])) {
      if (slot.start_time) {
        const hour = parseInt(slot.start_time.slice(0, 2))
        if (hour >= 7) allSlots.add(slot.start_time.slice(0, 5))
      }
    }
  }

  return [...allSlots].sort()
}

export async function getAvailability(daysAhead = 1) {
  if (!TENANT_ID) return 'ERROR: PLAYTOMIC_TENANT_ID no configurado'

  const lines = []

  for (let i = 0; i <= daysAhead; i++) {
    const date = getMexicoDate(i)
    const dateStr = date.toISOString().slice(0, 10)
    const dayLabel = i === 0 ? 'HOY' : 'MAÑANA'
    const dayStr = date.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })

    try {
      const slots = await fetchDay(dateStr)
      console.log(`[Playtomic] ${dayLabel} slots:`, slots)

      if (slots.length === 0) {
        lines.push(`${dayLabel} (${dayStr}): SIN DISPONIBILIDAD`)
      } else {
        lines.push(`${dayLabel} (${dayStr}): ${slots.join(', ')}`)
      }
    } catch (err) {
      console.error(`[Playtomic] error ${dayLabel}:`, err)
      lines.push(`${dayLabel} (${dayStr}): ERROR AL CONSULTAR`)
    }
  }

  const result = lines.join('\n')
  console.log('[Playtomic] resultado final:\n', result)
  return result
}
