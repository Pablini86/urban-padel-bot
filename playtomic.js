const TENANT_ID = process.env.PLAYTOMIC_TENANT_ID

// Zona horaria de Guadalajara (UTC-6)
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
  if (!TENANT_ID) return null

  const results = []

  for (let i = 0; i <= daysAhead; i++) {
    const date = getMexicoDate(i)
    const dateStr = date.toISOString().slice(0, 10)

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

      if (!res.ok) continue

      const data = await res.json()
      const resources = Array.isArray(data) ? data : []
      if (resources.length === 0) continue

      const dayLabel = i === 0 ? 'Hoy' : 'Mañana'
      const dayStr = date.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })
      results.push(`*${dayLabel} - ${dayStr}*`)

      // Solo 6 canchas, ordenadas
      const courts = resources.slice(0, 6)

      courts.forEach((resource, idx) => {
        const slots = resource.slots || []
        const uniqueHours = [...new Set(
          slots
            .filter(s => parseInt(s.start_time?.split(':')[0] || '0') >= 14)
            .map(s => s.start_time?.slice(0, 5))
        )].sort()

        if (uniqueHours.length > 0) {
          results.push(`  Cancha ${idx + 1}: ${uniqueHours.join(', ')}`)
        } else {
          results.push(`  Cancha ${idx + 1}: Sin disponibilidad por la tarde`)
        }
      })

      // Precio del primer slot disponible
      const firstPrice = resources[0]?.slots?.[0]?.price
      if (firstPrice) results.push(`  💰 Desde: ${firstPrice}`)
      results.push(`  👉 https://playtomic.com/es/clubs/urban-padel-life`)

    } catch (err) {
      console.error(`Error Playtomic día ${i}:`, err)
    }
  }

  return results.length > 0
    ? results.join('\n')
    : `No encontré disponibilidad. Reserva en:\nhttps://playtomic.com/es/clubs/urban-padel-life`
}
