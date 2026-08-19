// El webhook de WhatsApp entrega los números de México como 52 + 1 + 10 dígitos
// (13 dígitos, sin '+'), aunque Meta ya no exige ese '1' extra al escribirlos.
// Cualquier otra fuente (CSV, formularios) normalmente los trae sin ese '1'.
// Todo el sistema guarda y busca por el formato de 13 dígitos para que un
// contacto importado y uno que llega por WhatsApp sean siempre el mismo registro.
export function normalizeMxPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '')
  if (digits.length === 12 && digits.startsWith('52')) return '521' + digits.slice(2)
  // Número local de 10 dígitos (como lo escribiría alguien a mano en un formulario)
  if (digits.length === 10) return '521' + digits
  return digits
}
