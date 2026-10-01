/** Weeks the client can browse ahead. Must stay <= studio_settings.weeks_ahead,
 *  or the furthest week renders empty because no classes were generated yet. */
export const WEEKS_AHEAD = 4

/** Sunday 00:00 of the current week (Israeli weeks start on Sunday) */
export function baseSunday(): Date {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  const d = new Date(now)
  d.setDate(d.getDate() - d.getDay())
  return d
}

/** Date of day `d` (0=Sun..6=Sat) in week `w` (0 = current week) */
export function dateOf(w: number, d: number): Date {
  const dt = new Date(baseSunday())
  dt.setDate(dt.getDate() + w * 7 + d)
  return dt
}

export function isPastDay(w: number, d: number): boolean {
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  return dateOf(w, d) < now
}

/** Local YYYY-MM-DD. Never toISOString — that shifts the day in UTC. */
export function toISODate(dt: Date): string {
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const d = String(dt.getDate()).padStart(2, '0')
  return `${dt.getFullYear()}-${m}-${d}`
}

export function slotDateTime(dateISO: string, time: string): Date {
  const [y, mo, d] = dateISO.split('-').map(Number)
  const [h, mi] = time.split(':').map(Number)
  return new Date(y, mo - 1, d, h, mi, 0, 0)
}

/** "18:00:00" -> "18:00" */
export function hhmm(t: string): string {
  return t.slice(0, 5)
}

/** Digits inside RTL text need explicit isolation or they render reversed */
export const iso = (v: string | number) => '⁦' + v + '⁩'

export function weekLabel(months: string[], w: number): string {
  const a = dateOf(w, 0)
  const b = dateOf(w, 6)
  return a.getMonth() === b.getMonth()
    ? iso(a.getDate() + '–' + b.getDate()) + ' ' + months[a.getMonth()]
    : iso(a.getDate()) + ' ' + months[a.getMonth()] + ' – ' + iso(b.getDate()) + ' ' + months[b.getMonth()]
}

/** Days until a date (studio-local), for credit-expiry warnings */
export function daysUntil(dateISO: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const [y, m, d] = dateISO.split('-').map(Number)
  return Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86400000)
}
