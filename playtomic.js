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

export async function getAvailability(daysAhead = 1) {
  if (!TENANT_ID) return 'ERROR: PLAYTOMIC_TENANT_ID no configurado'

  const allResults = []

  for (let i = 0; i <= daysAhead; i++) {
    const date = getMexicoDate(i)
    const dateStr = date.toISOString().slice(0, 10)
    const dayLabel = i === 0 ? 'Hoy' : 'Mañana'
    const dayStr = date.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })

    const params = new URLSearchParams({
      tenant_id: TENANT_ID,
      sport_id: 'PADEL',
      date: dateStr
    })

    try {
      const res = await fetch(`https://playtomic.com/api/clubs/availability?${params}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Referer': 'https://playtomic.com'
        }
      })

      console.log(`[Playtomic] día ${i} status:`, res.status)

      if (!res.ok) {
        allResults.push(`${dayLabel} (${dayStr}): SIN DISPONIBILIDAD (error API)`)
        continue
      }

      const data = await res.json()
      console.log(`[Playtomic] día ${i} data:`, JSON.stringify(data).slice(0, 400))

      const resources = Array.isArray(data) ? data.slice(0, 6) : []

      // Recolectar todos los slots únicos de todas las canchas
      const allSlots = new Set()
      for (const resource of resources) {
        for (const slot of (resource.slots || [])) {
          if (slot.start_time) allSlots.add(slot.start_time.slice(0, 5))
        }
      }

      const sortedSlots = [...allSlots].sort()

      if (sortedSlots.length === 0) {
        allResults.push(`${dayLabel} (${dayStr}): NO HAY DISPONIBILIDAD`)
      } else {
        allResults.push(`${dayLabel} (${dayStr}): ${sortedSlots.join(', ')}`)
        const firstPrice = resources[0]?.slots?.[0]?.price
        if (firstPrice) allResults.push(`Precio desde: ${firstPrice}`)
      }

    } catch (err) {
      console.error(`[Playtomic] error día ${i}:`, err)
      allResults.push(`${dayLabel} (${dayStr}): ERROR AL CONSULTAR`)
    }
  }

  return allResults.join('\n')
}
