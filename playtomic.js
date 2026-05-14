const TENANT_ID = process.env.PLAYTOMIC_TENANT_ID

export async function getAvailability(daysAhead = 1) {
  if (!TENANT_ID) return null

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

      if (!res.ok) continue

      const data = await res.json()
      // data es array de recursos, cada uno con .slots[]
      const resources = Array.isArray(data) ? data : []

      if (resources.length === 0) continue

      const dayLabel = i === 0 ? 'Hoy' : 'Mañana'
      const dayStr = date.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })
      results.push(`*${dayLabel} - ${dayStr}*`)

      for (const resource of resources) {
        const slots = resource.slots || []
        // Filtrar tarde: 14:00 en adelante
        const afternoon = slots.filter(s => {
          const hour = parseInt(s.start_time?.split(':')[0] || '0')
          return hour >= 14
        })

        // Agrupar por hora única (puede haber 60/90/120 min para misma hora)
        const uniqueHours = [...new Set(afternoon.map(s => s.start_time?.slice(0, 5)))]

        if (uniqueHours.length > 0) {
          const courtNum = resources.indexOf(resource) + 1
          results.push(`  Cancha ${courtNum}: ${uniqueHours.join(', ')}`)
          // Mostrar precio del primer slot
          if (afternoon[0]?.price) {
            results.push(`  Precio desde: ${afternoon[0].price}`)
          }
        }
      }

      results.push(`  👉 Reservar: https://playtomic.com/es/clubs/urban-padel-life`)

    } catch (err) {
      console.error(`Error Playtomic día ${i}:`, err)
    }
  }

  return results.length > 0
    ? results.join('\n')
    : `No encontré disponibilidad por la tarde. Revisa en:\nhttps://playtomic.com/es/clubs/urban-padel-life`
}
