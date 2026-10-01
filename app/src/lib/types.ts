export type AuthUser = { id: string; phone: string }
export type Profile = {
  full_name: string | null
  is_admin: boolean
  phone: string
  /** everything created after this is "new" in the notification center */
  notifications_seen_at: string | null
  /** when the latest health declaration was submitted; null = must fill before booking */
  health_form_at: string | null
}

export type YesNo = boolean | null

/** Answers to the health questionnaire. Codes, not labels — the admin reads
 *  them in her language regardless of the language the client filled in. */
export type HealthAnswers = {
  full_name: string
  birth_date: string
  phone: string
  exercises_regularly: YesNo
  has_pain: YesNo
  pain_areas: string[]
  pain_other: string
  pain_level: number | null
  pain_since: string
  spine_conditions: string[]
  spine_details: string
  has_injury: YesNo
  injury_type: string
  injury_area: string
  injury_when: string
  injury_limits: YesNo
  joint_issues: string[]
  joint_other: string
  conditions: string[]
  conditions_other: string
  conditions_details: string
  pregnant: YesNo
  postpartum_12m: YesNo
  birth_date_approx: string
  pregnancy_complications: YesNo
  pregnancy_details: string
  medication: YesNo
  medication_details: string
  doctor_restriction: YesNo
  doctor_details: string
  other_info: YesNo
  other_details: string
}

/** One immutable submission of the questionnaire + signed declaration */
export type HealthForm = {
  id: string
  user_id: string
  form_version: number
  lang: 'he' | 'ar'
  answers: HealthAnswers
  flags: string[]
  consent_name: string
  signature_png: string | null
  submitted_at: string
}

/** Row of class_availability. Aggregate counts only — no attendee is ever
 *  named here, which is why the view is safe to read before signing in. */
export type ClassRow = {
  id: string
  class_date: string // YYYY-MM-DD
  start_time: string // HH:MM:SS
  duration_min: number
  label: string | null
  capacity: number
  taken: number
  spots_left: number
  is_full: boolean
}

/** A pack of sessions the client bought. `remaining` is derived in SQL from the
 *  bookings ledger, so it can never drift from what was actually spent. */
export type Pack = {
  id: string
  sessions_total: number
  remaining: number
  valid_from: string
  valid_until: string
  is_active: boolean
  price_ils: number | null
  note: string | null
}

export type MyBooking = {
  id: string
  class_id: string
  class_date: string
  start_time: string
  duration_min: number
  label: string | null
}

/** Row of class_roster — admin only */
export type RosterRow = {
  booking_id: string
  class_id: string
  class_date: string
  start_time: string
  label: string | null
  attendee_name: string | null
  attendee_phone: string | null
  status: 'booked' | 'attended' | 'no_show'
  note: string | null
  confirm_token: string
  reminder_sent_at: string | null
  customer_response: 'yes' | 'no' | null
  is_manual: boolean
  user_id: string | null
  health_flags: string[] | null
  health_form_at: string | null
}

export type Client = {
  id: string
  full_name: string | null
  phone: string
  is_admin: boolean
  active_remaining: number
  next_expiry: string | null
  health_flags: string[] | null
  health_form_at: string | null
}

export type RpcResult = {
  ok: boolean
  error?: string
  refunded?: boolean
  cutoff_hours?: number
  spots_left?: number
  booking_id?: string
  request_id?: string
  pack_id?: string
  form_id?: string
  class_id?: string
  /** admin-create-client: the new (or already existing) client */
  user_id?: string
  /** overlaps_class / slots_overlap: start time of the class in the way */
  time?: string
  /** capacity_below_booked: how many are booked */
  taken?: number
  /** admin_update_class */
  moved?: boolean
  notified?: number
  /** admin_save_template: what the resync did to the coming weeks */
  added?: number
  removed?: number
  updated?: number
  kept_booked?: number
}

/** One standing weekly slot (class_template). weekday 0 = Sunday. */
export type TemplateRow = {
  id: string
  weekday: number
  start_time: string // HH:MM:SS
  duration_min: number
  capacity: number
  label: string | null
}

/** A weekly slot as the editor sends it to admin_save_template */
export type TemplateDraft = { weekday: number; time: string; duration: number; capacity: number; label: string | null }

/** Something the studio sells. Snapshotted onto a request when a client asks
 *  for it, so editing a plan never rewrites history. */
export type Plan = {
  id: string
  name: string
  description: string | null
  sessions: number
  valid_months: number
  price_ils: number
  payment_url: string | null
  sort_order: number
  active: boolean
}

export type RequestStatus = 'pending' | 'approved' | 'declined' | 'cancelled'

export type PurchaseRequest = {
  id: string
  user_id: string
  plan_id: string | null
  plan_name: string
  sessions: number
  valid_months: number
  price_ils: number
  status: RequestStatus
  client_note: string | null
  admin_note: string | null
  created_at: string
  decided_at: string | null
  /** present on the admin board only */
  client_name?: string | null
  client_phone?: string | null
}

export type NotificationKind =
  | 'announcement' | 'purchase_approved' | 'purchase_declined'
  | 'class_cancelled' | 'booking_removed' | 'pack_granted' | 'class_moved'

/** A row of `notifications`. `user_id === null` is a studio-wide announcement.
 *  Text is rendered client-side from kind + data, so it follows the reader's
 *  language instead of the admin's. */
export type Notification = {
  id: string
  user_id: string | null
  kind: NotificationKind
  data: Record<string, unknown>
  created_at: string
}

/** One registered device. Web rows carry VAPID keys; native rows carry the
 *  token inside `endpoint` as '<kind>:<token>'. */
export type PushSub = {
  endpoint: string
  kind: 'web' | 'apns' | 'fcm'
  p256dh: string | null
  auth: string | null
}

export type StudioInfo = {
  cancel_cutoff_hours: number
  whatsapp_phone: string | null
}

export type Unsubscribe = () => void

export interface Api {
  demo: boolean

  // --- auth
  getUser(): Promise<AuthUser | null>
  onAuthChange(cb: (u: AuthUser | null) => void): Unsubscribe
  sendOtp(phoneE164: string): Promise<{ ok: boolean; error?: string }>
  verifyOtp(phoneE164: string, token: string): Promise<{ ok: boolean; error?: string }>
  signOut(): Promise<void>
  getMyProfile(): Promise<Profile | null>
  setMyName(fullName: string): Promise<void>
  deleteMyAccount(): Promise<RpcResult>

  // --- client
  fetchClasses(fromISO: string, toISO: string): Promise<ClassRow[]>
  fetchMyPacks(): Promise<Pack[]>
  fetchMyBookings(): Promise<MyBooking[]>
  bookClass(classId: string): Promise<RpcResult>
  cancelMyBooking(bookingId: string): Promise<RpcResult>

  // --- admin
  fetchRoster(fromISO: string, toISO: string): Promise<RosterRow[]>
  fetchClients(): Promise<Client[]>
  grantPack(userId: string, sessions: number, months: number, price: number | null, note: string | null): Promise<RpcResult>
  fetchClientPacks(userId: string): Promise<Pack[]>
  addClass(dateISO: string, time: string, capacity: number | null, label: string | null, duration?: number): Promise<RpcResult>
  /** Change one class: date, time, length, capacity, type. Booked clients are told when it moves. */
  updateClass(classId: string, dateISO: string, time: string, duration: number, capacity: number, label: string | null): Promise<RpcResult>
  /** The standing week (active slots only) */
  fetchTemplate(): Promise<TemplateRow[]>
  /** Replace the standing week and move the coming weeks onto it */
  saveTemplate(rows: TemplateDraft[]): Promise<RpcResult>
  /** Create a client account by name + phone (she never signed up) */
  createClient(fullName: string, phoneE164: string): Promise<RpcResult>
  /** Book an existing client into a class, spending a credit from her pack */
  bookClient(classId: string, userId: string): Promise<RpcResult>
  cancelClass(classId: string): Promise<RpcResult>
  adminCancelBooking(bookingId: string, refund: boolean): Promise<RpcResult>
  bookGuest(classId: string, name: string, phone: string | null, note: string | null): Promise<RpcResult>
  setAttendance(bookingId: string, status: 'booked' | 'attended' | 'no_show'): Promise<RpcResult>
  markReminderSent(bookingId: string): Promise<void>

  // --- shop (client)
  fetchStudioInfo(): Promise<StudioInfo>
  /** Active plans for clients; admins also receive inactive ones (RLS decides). */
  fetchPlans(): Promise<Plan[]>
  fetchMyRequests(): Promise<PurchaseRequest[]>
  requestPurchase(planId: string, note: string | null): Promise<RpcResult>
  cancelPurchaseRequest(requestId: string): Promise<RpcResult>

  // --- shop (admin)
  fetchPurchaseRequests(): Promise<PurchaseRequest[]>
  decidePurchase(requestId: string, approve: boolean, note: string | null): Promise<RpcResult>
  savePlan(plan: Omit<Plan, 'id' | 'sort_order'> & { id?: string; sort_order?: number }): Promise<RpcResult>
  saveStudioWhatsapp(phoneE164: string | null): Promise<RpcResult>

  // --- health declaration
  getMyHealthForm(): Promise<HealthForm | null>
  submitHealthForm(input: {
    answers: HealthAnswers; flags: string[]; consentName: string; signaturePng: string; lang: 'he' | 'ar'
  }): Promise<RpcResult>
  adminFetchHealthForm(userId: string): Promise<HealthForm | null>

  // --- notifications
  /** Mine + announcements, newest first */
  fetchNotifications(): Promise<Notification[]>
  markNotificationsSeen(): Promise<void>
  fetchAnnouncements(): Promise<Notification[]>
  sendAnnouncement(title: string, body: string): Promise<RpcResult>
  deleteNotification(id: string): Promise<RpcResult>

  // --- shared
  subscribeChanges(cb: () => void): Unsubscribe
  savePushSubscription(sub: PushSub, lang: 'he' | 'ar'): Promise<boolean>
  deletePushSubscription(endpoint: string): Promise<void>
}
