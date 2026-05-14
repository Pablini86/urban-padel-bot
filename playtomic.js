const TENANT_ID = process.env.PLAYTOMIC_TENANT_ID

export async function getAvailability(daysAhead = 1) {
  if (!TENANT_ID) {
    console.warn('PLAYTOMIC_TENANT_ID no configurado')
    return null
  }

  const results = []

  for (let i = 0; i <= daysAhead; i++) {
    const date = new Date()
    date.setDate(date.getDate() + i)
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

      console.log(`Playtomic status día ${i}:`, res.status)

      if (!res.ok) {
        const err = await res.text()
        console.error(`Playtomic error día ${i}:`, err)
        continue
      }

      const data = await res.json()
      console.log(`Playtomic data día ${i}:`, JSON.stringify(data).slice(0, 300))

      const slots = Array.isArray(data) ? data : data.slots || data.availability || []

      if (slots.length > 0) {
        const dayLabel = i === 0 ? 'Hoy' : 'Mañana'
        const dayStr = date.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })

        const byCourt = {}
        for (const slot of slots) {
          const court = slot.resource_name || slot.court_name || slot.name || 'Cancha'
          if (!byCourt[court]) byCourt[court] = []
          const time = slot.start_time || slot.time || slot.hour || ''
          if (time) {
            const t = new Date(time)
            const label = isNaN(t) ? time : t.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
            byCourt[court].push(label)
          }
        }

        results.push(`${dayLabel} (${dayStr}):`)
        for (const [court, times] of Object.entries(byCourt)) {
          results.push(`  ${court}: ${times.slice(0, 6).join(', ')}`)
        }
        results.push(`  👉 Reservar: https://playtomic.com/es/clubs/urban-padel-life`)
      }
    } catch (err) {
      console.error(`Error consultando Playtomic día ${i}:`, err)
    }
  }

  return results.length > 0
    ? results.join('\n')
    : `No encontré disponibilidad. Reserva directamente en:\nhttps://playtomic.com/es/clubs/urban-padel-life`
}
