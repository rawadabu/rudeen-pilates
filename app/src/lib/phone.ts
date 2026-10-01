/** Normalize an Israeli phone number to E.164 (+972...). Returns null if invalid. */
export function normalizePhone(raw: string): string | null {
  const s = raw.replace(/[\s-]/g, '')
  if (/^\+972\d{8,9}$/.test(s)) return s
  if (/^972\d{8,9}$/.test(s)) return '+' + s
  if (/^0\d{8,9}$/.test(s)) return '+972' + s.slice(1)
  return null
}

/** +972501234567 → 050-1234567 for display; leaves other formats as-is */
export function displayPhone(e164: string): string {
  const m = /^\+?972(\d{2})(\d{7})$/.exec(e164.replace(/[\s-]/g, ''))
  if (m) return `0${m[1]}-${m[2]}`
  return e164
}
