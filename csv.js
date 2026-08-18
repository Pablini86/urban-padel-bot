// Parser CSV mínimo (RFC4180: comillas, comas y saltos de línea dentro de campos
// entrecomillados) sin dependencias externas — suficiente para los CSV que se
// importan a mano desde el dashboard, no pretende cubrir todos los casos raros.
export function parseCsv(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  const s = text.replace(/\r\n/g, '\n')
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += c; i++; continue
    }
    if (c === '"') { inQuotes = true; i++; continue }
    if (c === ',') { row.push(field); field = ''; i++; continue }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += c; i++
  }
  if (field.length || row.length) { row.push(field); rows.push(row) }
  if (!rows.length) return []

  const headers = rows[0].map(h => h.trim())
  return rows.slice(1)
    .filter(r => r.some(v => v.trim() !== ''))
    .map(r => Object.fromEntries(headers.map((h, idx) => [h, (r[idx] ?? '').trim()])))
}
