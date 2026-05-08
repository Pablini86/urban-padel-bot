// ID de tu club en Playtomic — encuéntralo en la URL de tu club en playtomic.io
const TENANT_ID = process.env.PLAYTOMIC_TENANT_ID

const PLAYTOMIC_URL = 'https://playtomic.io'

export async function getAvailability(daysAhead = 1) {
  if (!TENANT_ID) {
    console.warn('PLAYTOMIC_TENANT_ID no configurado')
    return null
  }

  // Consultar disponibilidad para hoy y mañana
  const results = []

  for (let i = 0; i <= daysAhead; i++) {
    const date = new Date()
    date.setDate(date.getDate() + i)

    const startMin = new Date(date)
    startMin.setHours(7, 0, 0, 0)

    const startMax = new Date(date)
    startMax.setHours(23, 0, 0, 0)

    const params = new URLSearchParams({
      sport_id: 'PADEL',
      tenant_id: TENANT_ID,
      start_min: startMin.toISOString().slice(0, 19),
      start_max: startMax.toISOString().slice(0, 19)
    })

    try {
      const res = await fetch(`https://api.playtomic.io/v1/availability?${params}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'X-Requested-With': 'com.playtomic.app'
        }
      })

      if (!res.ok) continue

      const slots = await res.json()

      if (slots && slots.length > 0) {
        const dayLabel = i === 0 ? 'Hoy' : 'Mañana'
        const dateStr = date.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' })

        // Agrupar slots por cancha
        const byCourt = {}
        for (const slot of slots) {
          const court = slot.resource_name || slot.court_name || 'Cancha'
          if (!byCourt[court]) byCourt[court] = []
          const time = new Date(slot.start_time).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' })
          byCourt[court].push(time)
        }

        results.push(`${dayLabel} (${dateStr}):`)
        for (const [court, times] of Object.entries(byCourt)) {
          results.push(`  ${court}: ${times.slice(0, 5).join(', ')}${times.length > 5 ? '...' : ''}`)
        }
        results.push(`  Reservar: ${PLAYTOMIC_URL}/clubs/${TENANT_ID}`)
      }
    } catch (err) {
      console.error(`Error consultando disponibilidad día ${i}:`, err)
    }
  }

  return results.length > 0 ? results.join('\n') : 'No encontré disponibilidad en las próximas horas. Prueba en playtomic.io directamente.'
}
