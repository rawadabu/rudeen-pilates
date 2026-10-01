import { WEEKS_AHEAD, dateOf, slotDateTime, toISODate } from './dates'
import type { Api, AuthUser, ClassRow, Client, HealthAnswers, HealthForm, MyBooking, Notification, Pack, Plan, PurchaseRequest, RosterRow } from './types'

/** In-memory stand-in for Supabase, active only when .env.local has no
 *  credentials. It mirrors the real rules — capacity, credit spend, and the
 *  early/late cancellation refund — so the UI can be exercised without a
 *  backend. OTP code is 123456. */

const CUTOFF_HOURS = 12
const TEMPLATE: [number, string, string][] = [
  [0, '08:00', 'Reformer'], [0, '18:00', 'Reformer'], [0, '19:15', 'Mat'],
  [2, '08:00', 'Reformer'], [2, '18:00', 'Reformer'], [2, '19:15', 'Mat'],
  [4, '08:00', 'Reformer'], [4, '18:00', 'Reformer'], [4, '19:15', 'Mat'],
]

type DClass = {
  id: string; date: string; time: string; duration: number
  capacity: number; label: string | null; status: 'open' | 'cancelled'
  /** the weekly slot that made it (null = one-off); detached = edited by hand */
  templateId: string | null; detached: boolean
}
type DSlot = { id: string; weekday: number; time: string; duration: number; capacity: number; label: string | null; active: boolean }
let template: DSlot[] = TEMPLATE.map(([wd, time, label]) => ({
  id: `t-${wd}-${time}`, weekday: wd, time, duration: 55, capacity: 8, label, active: true,
}))
type DBooking = {
  id: string; classId: string; userId: string | null; packId: string | null
  guestName: string | null; guestPhone: string | null
  status: 'booked' | 'cancelled' | 'attended' | 'no_show'
  consumesCredit: boolean; note: string | null; confirmToken: string
  reminderSentAt: string | null; customerResponse: 'yes' | 'no' | null
}
type DPack = {
  id: string; userId: string; total: number; from: string; until: string
  price: number | null; note: string | null
}
type DProfile = { id: string; name: string | null; phone: string; isAdmin: boolean; seenAt?: string | null }

const healthForms = new Map<string, HealthForm>()   // latest per user

function blankAnswers(name: string, phone: string): HealthAnswers {
  return {
    full_name: name, birth_date: '1992-04-12', phone, exercises_regularly: true,
    has_pain: false, pain_areas: [], pain_other: '', pain_level: null, pain_since: '',
    spine_conditions: ['none'], spine_details: '', has_injury: false, injury_type: '', injury_area: '', injury_when: '', injury_limits: null,
    joint_issues: ['none'], joint_other: '', conditions: ['none'], conditions_other: '', conditions_details: '',
    pregnant: false, postpartum_12m: false, birth_date_approx: '', pregnancy_complications: null, pregnancy_details: '',
    medication: false, medication_details: '', doctor_restriction: false, doctor_details: '', other_info: false, other_details: '',
  }
}
const BLANK_SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
type DRequest = PurchaseRequest

const classes = new Map<string, DClass>()
const bookings: DBooking[] = []
const packs: DPack[] = []
const plans: Plan[] = [
  { id: 'pl-1', name: 'שיעור בודד', description: null, sessions: 1, valid_months: 1, price_ils: 65, payment_url: null, sort_order: 1, active: true },
  { id: 'pl-4', name: 'כרטיסייה 4 שיעורים', description: null, sessions: 4, valid_months: 1, price_ils: 160, payment_url: null, sort_order: 2, active: true },
  { id: 'pl-8', name: 'כרטיסייה 8 שיעורים', description: 'הכרטיסייה הפופולרית — שני שיעורים בשבוע.', sessions: 8, valid_months: 1, price_ils: 300, payment_url: 'https://www.bitpay.co.il/', sort_order: 3, active: true },
  { id: 'pl-12', name: 'כרטיסייה 12 שיעורים', description: null, sessions: 12, valid_months: 1, price_ils: 420, payment_url: null, sort_order: 4, active: true },
  { id: 'pl-36', name: 'חבילה ל-3 חודשים', description: '12 שיעורים בחודש, 36 בסך הכול.', sessions: 36, valid_months: 3, price_ils: 1150, payment_url: null, sort_order: 5, active: false },
]
const requests: DRequest[] = []
const notifs: Notification[] = []
let studioWhatsapp: string | null = '+972503337328'
const profiles: DProfile[] = [
  { id: 'demo-user', name: 'רואד אבו סאלח', phone: '+972503337328', isAdmin: true },
  { id: 'demo-c1', name: 'נועה לוי', phone: '+972521112233', isAdmin: false },
  { id: 'demo-c2', name: 'ريم شمس', phone: '+972524445566', isAdmin: false },
  { id: 'demo-c3', name: 'מאיה כהן', phone: '+972527778899', isAdmin: false },
  { id: 'demo-c4', name: 'שירה ברק', phone: '+972523334455', isAdmin: false },
  { id: 'demo-c5', name: 'هدى خطيب', phone: '+972526667788', isAdmin: false },
  { id: 'demo-c6', name: 'טל אבידן', phone: '+972529990011', isAdmin: false },
  { id: 'demo-c7', name: 'ليان حداد', phone: '+972522223344', isAdmin: false },
  { id: 'demo-c8', name: 'רונית שגב', phone: '+972528881122', isAdmin: false },
]

let seeded = false
let user: AuthUser | null = null
let pendingPhone: string | null = null
const authListeners = new Set<(u: AuthUser | null) => void>()
const changeListeners = new Set<() => void>()
const notifyAuth = () => authListeners.forEach((cb) => cb(user))
const notifyChange = () => changeListeners.forEach((cb) => cb())

function seed() {
  if (seeded) return
  seeded = true
  const today = toISODate(new Date())

  for (let w = 0; w < WEEKS_AHEAD; w++) {
    for (const [wd, time, label] of TEMPLATE) {
      const date = toISODate(dateOf(w, wd))
      classes.set(`${date}|${time}`, {
        id: `c-${date}-${time}`, date, time, duration: 55,
        capacity: 8, label, status: 'open', templateId: `t-${wd}-${time}`, detached: false,
      })
    }
  }

  // active packs: the demo user plus two clients, and one already exhausted
  packs.push(
    { id: 'p-demo-user', userId: 'demo-user', total: 8, from: today, until: plusMonths(today, 1), price: 300, note: null },
    { id: 'p-demo-c1', userId: 'demo-c1', total: 12, from: today, until: plusMonths(today, 1), price: 420, note: null },
    { id: 'p-demo-c2', userId: 'demo-c2', total: 8, from: today, until: plusMonths(today, 1), price: 300, note: null },
    { id: 'p-demo-c3', userId: 'demo-c3', total: 4, from: today, until: plusMonths(today, 1), price: 160, note: 'ניסיון' },
  )
  for (const p of profiles.slice(4)) {
    packs.push({ id: 'p-' + p.id, userId: p.id, total: 8, from: today, until: plusMonths(today, 1), price: 300, note: null })
  }

  // one purchase request already waiting, so the admin board is not empty
  requests.push(mkRequest('demo-c4', plans[2], 'שילמתי בביט הבוקר 🙏'))

  // health declarations on file for three clients — one with findings
  const noa = blankAnswers('נועה לוי', '+972521112233')
  noa.has_pain = true; noa.pain_areas = ['lower_back']; noa.pain_level = 4; noa.pain_since = 'כחודשיים'
  noa.postpartum_12m = true; noa.birth_date_approx = '2026-03-02'
  healthForms.set('demo-c1', { id: 'hf-1', user_id: 'demo-c1', form_version: 1, lang: 'he', answers: noa, flags: ['pain', 'postpartum'], consent_name: 'נועה לוי', signature_png: BLANK_SIG, submitted_at: new Date(Date.now() - 5 * 86400000).toISOString() })
  healthForms.set('demo-c2', { id: 'hf-2', user_id: 'demo-c2', form_version: 1, lang: 'ar', answers: blankAnswers('ريم شمس', '+972524445566'), flags: [], consent_name: 'ريم شمس', signature_png: BLANK_SIG, submitted_at: new Date(Date.now() - 9 * 86400000).toISOString() })
  healthForms.set('demo-c3', { id: 'hf-3', user_id: 'demo-c3', form_version: 1, lang: 'he', answers: blankAnswers('מאיה כהן', '+972527778899'), flags: [], consent_name: 'מאיה כהן', signature_png: BLANK_SIG, submitted_at: new Date(Date.now() - 20 * 86400000).toISOString() })

  // one announcement from "two hours ago", so the bell has something to show
  const ann = mkNotif(null, 'announcement', {
    title: 'שעות פעילות בחגים',
    body: 'בערב החג ובחג הסטודיו סגור. הלוח הרגיל חוזר ביום שלמחרת — נתראה על המזרן 🤍',
  })
  ann.created_at = new Date(Date.now() - 2 * 3600000).toISOString()

  // A few classes start partly filled so capacity is visible immediately —
  // but never past what the seeded pack holds, or a balance goes negative,
  // which the real book_class RPC would have refused.
  const clientsOnly = profiles.filter((p) => !p.isAdmin)
  const budget = new Map(clientsOnly.map((p) => [p.id, packs.find((x) => x.userId === p.id)!.total - 2]))
  let n = 0
  for (const c of [...classes.values()].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))) {
    const want = Math.min((n * 3) % (clientsOnly.length + 1), c.capacity)
    let placed = 0
    for (let i = 0; i < clientsOnly.length && placed < want; i++) {
      const who = clientsOnly[(n + i) % clientsOnly.length]
      const left = budget.get(who.id) ?? 0
      if (left <= 0) continue
      budget.set(who.id, left - 1)
      bookings.push(mkBooking(c.id, who.id, 'p-' + who.id, null, null))
      placed++
    }
    n++
  }
}

function plusMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(y, m - 1 + months, d)
  dt.setDate(dt.getDate() - 1)
  return toISODate(dt)
}

let idSeq = 0
function mkNotif(userId: string | null, kind: Notification['kind'], data: Record<string, unknown>): Notification {
  idSeq++
  const n: Notification = { id: `n-${idSeq}`, user_id: userId, kind, data, created_at: new Date().toISOString() }
  notifs.push(n)
  return n
}
function mkRequest(userId: string, plan: Plan, note: string | null): DRequest {
  idSeq++
  return {
    id: `r-${idSeq}`, user_id: userId, plan_id: plan.id, plan_name: plan.name,
    sessions: plan.sessions, valid_months: plan.valid_months, price_ils: plan.price_ils,
    status: 'pending', client_note: note, admin_note: null,
    created_at: new Date().toISOString(), decided_at: null,
  }
}
function mkBooking(
  classId: string, userId: string | null, packId: string | null,
  guestName: string | null, guestPhone: string | null,
): DBooking {
  idSeq++
  return {
    id: `b-${idSeq}`, classId, userId, packId, guestName, guestPhone,
    status: 'booked', consumesCredit: !!packId, note: null,
    confirmToken: `tok-${idSeq}`, reminderSentAt: null, customerResponse: null,
  }
}

// mirrors the SQL: a seat is taken unless the booking was cancelled
const takenIn = (classId: string) => bookings.filter((b) => b.classId === classId && b.status !== 'cancelled').length
const spent = (packId: string) => bookings.filter((b) => b.packId === packId && b.consumesCredit).length
const remainingOf = (p: DPack) => p.total - spent(p.id)
const isActive = (p: DPack) => {
  const today = toISODate(new Date())
  return p.from <= today && p.until >= today
}
const profileOf = (id: string | null) => profiles.find((p) => p.id === id) ?? null
const classOf = (id: string) => [...classes.values()].find((c) => c.id === id) ?? null
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
/** v1.5 one-room rule: start time of an open class on the date that overlaps */
function overlapIn(date: string, time: string, duration: number, excludeId: string | null): string | null {
  for (const c of classes.values()) {
    if (c.date !== date || c.status !== 'open' || c.id === excludeId) continue
    if (toMin(c.time) < toMin(time) + duration && toMin(time) < toMin(c.time) + c.duration) return c.time
  }
  return null
}
/** mirrors resync_classes(): keep the coming weeks on the template */
function resync() {
  const now = new Date()
  let added = 0, removed = 0, updated = 0, kept = 0
  for (const [key, c] of [...classes.entries()]) {
    if (!c.templateId || c.detached || c.status !== 'open' || slotDateTime(c.date, c.time) <= now) continue
    const t = template.find((x) => x.id === c.templateId)
    const rows = bookings.filter((b) => b.classId === c.id)
    const live = rows.some((b) => b.status !== 'cancelled')
    if (!t || !t.active) {
      if (!rows.length) { classes.delete(key); removed++ }
      else if (!live) { c.status = 'cancelled'; removed++ }
      else { c.detached = true; kept++ }
      continue
    }
    if (c.duration !== t.duration || c.capacity !== t.capacity || c.label !== t.label) {
      if (live) kept++
      else { c.duration = t.duration; c.capacity = t.capacity; c.label = t.label; updated++ }
    }
  }
  for (let w = 0; w < WEEKS_AHEAD; w++) {
    for (let d = 0; d < 7; d++) {
      const date = toISODate(dateOf(w, d))
      for (const t of template.filter((x) => x.active && x.weekday === d).sort((a, b) => a.time.localeCompare(b.time))) {
        if (slotDateTime(date, t.time) <= now) continue
        if ([...classes.values()].some((c) => c.templateId === t.id && c.date === date)) continue
        if (classes.has(`${date}|${t.time}`) || overlapIn(date, t.time, t.duration, null)) continue
        classes.set(`${date}|${t.time}`, {
          id: `c-${date}-${t.time}`, date, time: t.time, duration: t.duration, capacity: t.capacity,
          label: t.label, status: 'open', templateId: t.id, detached: false,
        })
        added++
      }
    }
  }
  return { added, removed, updated, kept_booked: kept }
}
const packToApi = (p: DPack): Pack => ({
  id: p.id, sessions_total: p.total, remaining: remainingOf(p),
  valid_from: p.from, valid_until: p.until, is_active: isActive(p),
  price_ils: p.price, note: p.note,
})

export const demoApi: Api = {
  demo: true,

  async getUser() { return user },
  onAuthChange(cb) { authListeners.add(cb); return () => authListeners.delete(cb) },
  async sendOtp(phoneE164) { pendingPhone = phoneE164; return { ok: true } },
  async verifyOtp(phoneE164, token) {
    if (token !== '123456') return { ok: false, error: 'otp_wrong' }
    user = { id: 'demo-user', phone: phoneE164 || pendingPhone || '' }
    notifyAuth()
    return { ok: true }
  },
  async signOut() { user = null; notifyAuth() },
  async getMyProfile() {
    if (!user) return null
    const p = profileOf(user.id)!
    return { full_name: p.name, is_admin: p.isAdmin, phone: p.phone, notifications_seen_at: p.seenAt ?? null, health_form_at: healthForms.get(p.id)?.submitted_at ?? null }
  },
  async setMyName(fullName) {
    const p = profileOf(user?.id ?? null)
    if (p) p.name = fullName.trim()
  },
  async deleteMyAccount() {
    if (!user) return { ok: false, error: 'not_authenticated' }
    const now = new Date()
    for (const b of bookings) {
      if (b.userId !== user.id || b.status !== 'booked') continue
      const c = classOf(b.classId)
      if (c && slotDateTime(c.date, c.time) >= now) { b.status = 'cancelled'; b.consumesCredit = false }
      b.userId = null
    }
    user = null
    notifyAuth(); notifyChange()
    return { ok: true }
  },

  // ---------- client ----------
  async fetchClasses(fromISO, toISO) {
    seed()
    return [...classes.values()]
      .filter((c) => c.status === 'open' && c.date >= fromISO && c.date <= toISO)
      .map((c): ClassRow => {
        const taken = takenIn(c.id)
        return {
          id: c.id, class_date: c.date, start_time: c.time + ':00', duration_min: c.duration,
          label: c.label, capacity: c.capacity, taken,
          spots_left: Math.max(c.capacity - taken, 0), is_full: taken >= c.capacity,
        }
      })
      .sort((a, b) => (a.class_date + a.start_time).localeCompare(b.class_date + b.start_time))
  },

  async fetchMyPacks() {
    seed()
    if (!user) return []
    return packs.filter((p) => p.userId === user!.id)
      .map(packToApi)
      .sort((a, b) => b.valid_until.localeCompare(a.valid_until))
  },

  async fetchMyBookings() {
    seed()
    if (!user) return []
    const today = toISODate(new Date())
    return bookings
      .filter((b) => b.userId === user!.id && b.status === 'booked')
      .map((b) => { const c = classOf(b.classId)!; return { b, c } })
      .filter(({ c }) => c && c.date >= today)
      .map(({ b, c }): MyBooking => ({
        id: b.id, class_id: c.id, class_date: c.date,
        start_time: c.time + ':00', duration_min: c.duration, label: c.label,
      }))
      .sort((a, b) => (a.class_date + a.start_time).localeCompare(b.class_date + b.start_time))
  },

  async bookClass(classId) {
    seed()
    if (!user) return { ok: false, error: 'not_authenticated' }
    if (!healthForms.has(user.id)) return { ok: false, error: 'health_form_required' }
    const c = classOf(classId)
    if (!c) return { ok: false, error: 'class_not_found' }
    if (c.status !== 'open') return { ok: false, error: 'class_cancelled' }
    if (slotDateTime(c.date, c.time) < new Date()) return { ok: false, error: 'class_past' }
    if (bookings.some((b) => b.classId === classId && b.userId === user!.id && b.status !== 'cancelled')) {
      return { ok: false, error: 'already_booked' }
    }
    const taken = takenIn(classId)
    if (taken >= c.capacity) return { ok: false, error: 'class_full' }

    const pack = packs
      .filter((p) => p.userId === user!.id && isActive(p) && remainingOf(p) > 0)
      .sort((a, b) => a.until.localeCompare(b.until))[0]
    if (!pack) return { ok: false, error: 'no_credits' }

    const b = mkBooking(classId, user.id, pack.id, null, null)
    bookings.push(b)
    notifyChange()
    return { ok: true, booking_id: b.id, spots_left: c.capacity - taken - 1 }
  },

  async cancelMyBooking(bookingId) {
    seed()
    const b = bookings.find((x) => x.id === bookingId && x.userId === user?.id && x.status === 'booked')
    if (!b) return { ok: false, error: 'not_found_or_not_yours' }
    const c = classOf(b.classId)!
    const early = slotDateTime(c.date, c.time).getTime() - CUTOFF_HOURS * 3600000 > Date.now()
    b.status = 'cancelled'
    b.consumesCredit = !early
    notifyChange()
    return { ok: true, refunded: early, cutoff_hours: CUTOFF_HOURS }
  },

  // ---------- admin ----------
  async fetchRoster(fromISO, toISO) {
    seed()
    return bookings
      .filter((b) => b.status === 'booked' || b.status === 'attended' || b.status === 'no_show')
      .map((b) => ({ b, c: classOf(b.classId)! }))
      .filter(({ c }) => c && c.date >= fromISO && c.date <= toISO)
      .map(({ b, c }): RosterRow => {
        const p = profileOf(b.userId)
        return {
          booking_id: b.id, class_id: c.id, class_date: c.date, start_time: c.time + ':00',
          label: c.label,
          attendee_name: p?.name ?? b.guestName,
          attendee_phone: p?.phone ?? b.guestPhone,
          status: b.status as RosterRow['status'], note: b.note,
          confirm_token: b.confirmToken, reminder_sent_at: b.reminderSentAt,
          customer_response: b.customerResponse, is_manual: b.userId === null,
          user_id: b.userId,
          health_flags: b.userId ? healthForms.get(b.userId)?.flags ?? null : null,
          health_form_at: b.userId ? healthForms.get(b.userId)?.submitted_at ?? null : null,
        }
      })
      .sort((a, b) => (a.class_date + a.start_time).localeCompare(b.class_date + b.start_time))
  },

  async fetchClients() {
    seed()
    return profiles.map((p): Client => {
      const active = packs.filter((x) => x.userId === p.id && isActive(x) && remainingOf(x) > 0)
      return {
        id: p.id, full_name: p.name, phone: p.phone, is_admin: p.isAdmin,
        active_remaining: active.reduce((s, x) => s + remainingOf(x), 0),
        next_expiry: active.sort((a, b) => a.until.localeCompare(b.until))[0]?.until ?? null,
        health_flags: healthForms.get(p.id)?.flags ?? null,
        health_form_at: healthForms.get(p.id)?.submitted_at ?? null,
      }
    })
  },

  async fetchClientPacks(userId) {
    seed()
    return packs.filter((p) => p.userId === userId).map(packToApi)
      .sort((a, b) => b.valid_until.localeCompare(a.valid_until))
  },

  async grantPack(userId, sessions, months, price, note) {
    seed()
    if (!profileOf(userId)) return { ok: false, error: 'client_not_found' }
    if (sessions < 1 || sessions > 60) return { ok: false, error: 'invalid_sessions' }
    const from = toISODate(new Date())
    idSeq++
    const until = plusMonths(from, months)
    packs.push({ id: `p-${idSeq}`, userId, total: sessions, from, until, price, note })
    mkNotif(userId, 'pack_granted', { sessions, valid_until: until, note })
    notifyChange()
    return { ok: true }
  },

  async addClass(dateISO, time, capacity, label, duration) {
    seed()
    const key = `${dateISO}|${time}`
    const dur = duration ?? 55
    if (dateISO < toISODate(new Date())) return { ok: false, error: 'date_in_past' }
    if (dur < 15 || dur > 180) return { ok: false, error: 'invalid_duration' }
    if (classes.get(key)?.status === 'open') return { ok: false, error: 'class_exists' }
    const clash = overlapIn(dateISO, time, dur, null)
    if (clash) return { ok: false, error: 'overlaps_class', time: clash }
    classes.set(key, {
      id: `c-${dateISO}-${time}`, date: dateISO, time, duration: dur,
      capacity: capacity ?? 8, label, status: 'open', templateId: null, detached: false,
    })
    notifyChange()
    return { ok: true }
  },

  async updateClass(classId, dateISO, time, duration, capacity, label) {
    seed()
    const entry = [...classes.entries()].find(([, c]) => c.id === classId)
    if (!entry) return { ok: false, error: 'class_not_found' }
    const [key, c] = entry
    if (c.status !== 'open') return { ok: false, error: 'class_cancelled' }
    if (slotDateTime(c.date, c.time) <= new Date()) return { ok: false, error: 'class_past' }
    if (slotDateTime(dateISO, time) <= new Date()) return { ok: false, error: 'date_in_past' }
    if (duration < 15 || duration > 180) return { ok: false, error: 'invalid_duration' }
    if (capacity < 1 || capacity > 30) return { ok: false, error: 'invalid_capacity' }
    const taken = takenIn(classId)
    if (capacity < taken) return { ok: false, error: 'capacity_below_booked', taken }
    const newKey = `${dateISO}|${time}`
    if (newKey !== key && classes.has(newKey)) return { ok: false, error: 'class_exists' }
    const clash = overlapIn(dateISO, time, duration, classId)
    if (clash) return { ok: false, error: 'overlaps_class', time: clash }
    const moved = newKey !== key
    const old = { date: c.date, time: c.time }
    Object.assign(c, { date: dateISO, time, duration, capacity, label: label?.trim() || null, detached: c.detached || !!c.templateId })
    if (moved) {
      classes.delete(key)
      classes.set(newKey, c)
    }
    let notified = 0
    if (moved) {
      for (const b of bookings.filter((x) => x.classId === classId && x.status === 'booked' && x.userId)) {
        mkNotif(b.userId, 'class_moved', {
          old_date: old.date, old_time: old.time + ':00', class_date: dateISO, start_time: time + ':00', label: c.label,
        })
        notified++
      }
    }
    notifyChange()
    return { ok: true, moved, notified }
  },

  async fetchTemplate() {
    return template
      .filter((x) => x.active)
      .sort((a, b) => a.weekday - b.weekday || a.time.localeCompare(b.time))
      .map((x) => ({ id: x.id, weekday: x.weekday, start_time: x.time + ':00', duration_min: x.duration, capacity: x.capacity, label: x.label }))
  },

  async saveTemplate(rows) {
    seed()
    for (const a of rows) {
      const clash = rows.find((b) => b !== a && b.weekday === a.weekday && a.time < b.time && toMin(b.time) < toMin(a.time) + a.duration)
      if (clash) return { ok: false, error: 'slots_overlap', time: clash.time }
    }
    for (const t of template) t.active = rows.some((r) => r.weekday === t.weekday && r.time === t.time)
    for (const r of rows) {
      const t = template.find((x) => x.weekday === r.weekday && x.time === r.time)
      if (t) Object.assign(t, { duration: r.duration, capacity: r.capacity, label: r.label, active: true })
      else template.push({ id: `t-${r.weekday}-${r.time}`, weekday: r.weekday, time: r.time, duration: r.duration, capacity: r.capacity, label: r.label, active: true })
    }
    const res = resync()
    notifyChange()
    return { ok: true, ...res }
  },

  async createClient(fullName, phoneE164) {
    seed()
    if (fullName.trim().length < 2) return { ok: false, error: 'invalid_name' }
    const existing = profiles.find((p) => p.phone === phoneE164)
    if (existing) return { ok: false, error: 'client_exists', user_id: existing.id }
    idSeq++
    const id = `demo-new-${idSeq}`
    profiles.push({ id, name: fullName.trim(), phone: phoneE164, isAdmin: false })
    notifyChange()
    return { ok: true, user_id: id }
  },

  async bookClient(classId, userId) {
    seed()
    if (!profileOf(userId)) return { ok: false, error: 'client_not_found' }
    const c = classOf(classId)
    if (!c) return { ok: false, error: 'class_not_found' }
    if (c.status !== 'open') return { ok: false, error: 'class_cancelled' }
    if (slotDateTime(c.date, c.time) < new Date()) return { ok: false, error: 'class_past' }
    if (bookings.some((b) => b.classId === classId && b.userId === userId && b.status !== 'cancelled')) {
      return { ok: false, error: 'already_booked' }
    }
    if (takenIn(classId) >= c.capacity) return { ok: false, error: 'class_full' }
    const pack = packs
      .filter((p) => p.userId === userId && isActive(p) && remainingOf(p) > 0)
      .sort((a, b) => a.until.localeCompare(b.until))[0]
    if (!pack) return { ok: false, error: 'no_credits' }
    const b = mkBooking(classId, userId, pack.id, null, null)
    bookings.push(b)
    notifyChange()
    return { ok: true, booking_id: b.id }
  },

  async cancelClass(classId) {
    seed()
    const c = classOf(classId)
    if (!c) return { ok: false, error: 'class_not_found' }
    let n = 0
    for (const b of bookings) {
      if (b.classId === classId && b.status === 'booked') {
        b.status = 'cancelled'; b.consumesCredit = false; n++
        if (b.userId) mkNotif(b.userId, 'class_cancelled', { class_date: c.date, start_time: c.time + ':00', label: c.label, refunded: true })
      }
    }
    c.status = 'cancelled'
    notifyChange()
    return { ok: true, refunded: n > 0 }
  },

  async adminCancelBooking(bookingId, refund) {
    seed()
    const b = bookings.find((x) => x.id === bookingId && x.status !== 'cancelled')
    if (!b) return { ok: false, error: 'not_found_or_not_yours' }
    b.status = 'cancelled'; b.consumesCredit = !refund
    const c = classOf(b.classId)
    if (b.userId && c) mkNotif(b.userId, 'booking_removed', { class_date: c.date, start_time: c.time + ':00', label: c.label, refunded: refund })
    notifyChange()
    return { ok: true, refunded: refund }
  },

  async bookGuest(classId, name, phone, note) {
    seed()
    const c = classOf(classId)
    if (!c) return { ok: false, error: 'class_not_found' }
    if (name.trim().length < 2) return { ok: false, error: 'invalid_name' }
    if (takenIn(classId) >= c.capacity) return { ok: false, error: 'class_full' }
    const b = mkBooking(classId, null, null, name.trim(), phone)
    b.note = note
    b.consumesCredit = false
    bookings.push(b)
    notifyChange()
    return { ok: true }
  },

  async setAttendance(bookingId, status) {
    seed()
    const b = bookings.find((x) => x.id === bookingId && x.status !== 'cancelled')
    if (!b) return { ok: false, error: 'not_found_or_not_yours' }
    b.status = status
    notifyChange()
    return { ok: true }
  },

  async markReminderSent(bookingId) {
    const b = bookings.find((x) => x.id === bookingId)
    if (b) { b.reminderSentAt = new Date().toISOString(); notifyChange() }
  },

  // ---------- shop ----------
  async fetchStudioInfo() { return { cancel_cutoff_hours: CUTOFF_HOURS, whatsapp_phone: studioWhatsapp } },

  async fetchPlans() {
    seed()
    const admin = !!profileOf(user?.id ?? null)?.isAdmin
    return plans.filter((p) => admin || p.active).sort((a, b) => a.sort_order - b.sort_order)
  },

  async fetchMyRequests() {
    seed()
    if (!user) return []
    return requests.filter((r) => r.user_id === user!.id).slice().reverse()
  },

  async requestPurchase(planId, note) {
    seed()
    if (!user) return { ok: false, error: 'not_authenticated' }
    const plan = plans.find((p) => p.id === planId && p.active)
    if (!plan) return { ok: false, error: 'plan_not_found' }
    if (requests.some((r) => r.user_id === user!.id && r.plan_id === planId && r.status === 'pending')) {
      return { ok: false, error: 'request_pending' }
    }
    const r = mkRequest(user.id, plan, note)
    requests.push(r)
    notifyChange()
    return { ok: true, request_id: r.id }
  },

  async cancelPurchaseRequest(requestId) {
    const r = requests.find((x) => x.id === requestId && x.user_id === user?.id && x.status === 'pending')
    if (!r) return { ok: false, error: 'not_found_or_not_yours' }
    r.status = 'cancelled'; r.decided_at = new Date().toISOString()
    notifyChange()
    return { ok: true }
  },

  async fetchPurchaseRequests() {
    seed()
    return requests.slice().reverse().map((r) => {
      const p = profileOf(r.user_id)
      return { ...r, client_name: p?.name ?? null, client_phone: p?.phone ?? null }
    })
  },

  async decidePurchase(requestId, approve, note) {
    seed()
    const r = requests.find((x) => x.id === requestId)
    if (!r) return { ok: false, error: 'request_not_found' }
    if (r.status !== 'pending') return { ok: false, error: 'request_not_pending' }
    let packId: string | undefined
    if (approve) {
      const from = toISODate(new Date())
      idSeq++
      packId = `p-${idSeq}`
      packs.push({ id: packId, userId: r.user_id, total: r.sessions, from, until: plusMonths(from, r.valid_months), price: r.price_ils, note: r.plan_name })
    }
    r.status = approve ? 'approved' : 'declined'
    r.decided_at = new Date().toISOString()
    r.admin_note = note
    mkNotif(r.user_id, approve ? 'purchase_approved' : 'purchase_declined', {
      plan_name: r.plan_name, sessions: r.sessions,
      valid_until: approve ? packs[packs.length - 1].until : null, admin_note: note,
    })
    notifyChange()
    return { ok: true, pack_id: packId }
  },

  async savePlan(plan) {
    seed()
    if (plan.id) {
      const i = plans.findIndex((p) => p.id === plan.id)
      if (i < 0) return { ok: false, error: 'plan_not_found' }
      plans[i] = { ...plans[i], ...plan, id: plan.id }
    } else {
      idSeq++
      plans.push({ ...plan, id: `pl-${idSeq}`, sort_order: plan.sort_order ?? plans.length + 1 })
    }
    notifyChange()
    return { ok: true }
  },

  async saveStudioWhatsapp(phoneE164) {
    studioWhatsapp = phoneE164
    notifyChange()
    return { ok: true }
  },

  // ---------- health declaration ----------
  async getMyHealthForm() {
    seed()
    return user ? healthForms.get(user.id) ?? null : null
  },
  async submitHealthForm(input) {
    seed()
    if (!user) return { ok: false, error: 'not_authenticated' }
    if (input.consentName.trim().length < 2) return { ok: false, error: 'invalid_name' }
    if (!input.signaturePng.startsWith('data:image/png;base64,')) return { ok: false, error: 'invalid_input' }
    idSeq++
    const form: HealthForm = {
      id: `hf-${idSeq}`, user_id: user.id, form_version: 1, lang: input.lang, answers: input.answers,
      flags: input.flags, consent_name: input.consentName.trim(), signature_png: input.signaturePng,
      submitted_at: new Date().toISOString(),
    }
    healthForms.set(user.id, form)
    notifyChange()
    return { ok: true, form_id: form.id }
  },
  async adminFetchHealthForm(userId) {
    seed()
    return healthForms.get(userId) ?? null
  },

  // ---------- notifications ----------
  async fetchNotifications() {
    seed()
    if (!user) return []
    return notifs.filter((n) => n.user_id === null || n.user_id === user!.id)
      .slice().sort((a, b) => b.created_at.localeCompare(a.created_at))
  },
  async markNotificationsSeen() {
    const p = profileOf(user?.id ?? null)
    if (p) p.seenAt = new Date().toISOString()
  },
  async fetchAnnouncements() {
    seed()
    return notifs.filter((n) => n.user_id === null).slice().sort((a, b) => b.created_at.localeCompare(a.created_at))
  },
  async sendAnnouncement(title, body) {
    seed()
    mkNotif(null, 'announcement', { title, body })
    notifyChange()
    return { ok: true }
  },
  async deleteNotification(id) {
    const i = notifs.findIndex((n) => n.id === id)
    if (i >= 0) notifs.splice(i, 1)
    notifyChange()
    return { ok: true }
  },

  // ---------- shared ----------
  subscribeChanges(cb) { changeListeners.add(cb); return () => changeListeners.delete(cb) },
  async savePushSubscription() { return true },
  async deletePushSubscription() {},
}
