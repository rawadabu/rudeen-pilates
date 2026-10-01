import { supabase, isConfigured } from './supabase'
import { demoApi } from './demo'
import { toISODate } from './dates'
import type {
  Api, AuthUser, ClassRow, Client, HealthForm, MyBooking, Notification, Pack, Plan, Profile, PurchaseRequest, PushSub, RosterRow, RpcResult, StudioInfo, TemplateRow,
} from './types'

function toAuthUser(u: { id: string; phone?: string | null } | null | undefined): AuthUser | null {
  return u ? { id: u.id, phone: u.phone ?? '' } : null
}

async function uid(): Promise<string | null> {
  const { data } = await supabase!.auth.getSession()
  return data.session?.user.id ?? null
}

const realApi: Api = {
  demo: false,

  // ---------- auth ----------
  async getUser() {
    const { data } = await supabase!.auth.getSession()
    return toAuthUser(data.session?.user)
  },

  onAuthChange(cb) {
    const { data } = supabase!.auth.onAuthStateChange((_e, s) => cb(toAuthUser(s?.user)))
    return () => data.subscription.unsubscribe()
  },

  async sendOtp(phoneE164) {
    const { error } = await supabase!.auth.signInWithOtp({ phone: phoneE164 })
    if (!error) return { ok: true }
    // A send failure is a provider/config problem, never a "wrong code"
    return { ok: false, error: error.status === 429 ? 'otp_rate_limit' : 'otp_send_failed' }
  },

  async verifyOtp(phoneE164, token) {
    const { error } = await supabase!.auth.verifyOtp({ phone: phoneE164, token, type: 'sms' })
    if (error) return { ok: false, error: error.status === 429 ? 'otp_rate_limit' : 'otp_wrong' }
    return { ok: true }
  },

  async signOut() {
    await supabase!.auth.signOut()
  },

  async getMyProfile() {
    const id = await uid()
    if (!id) return null
    const { data, error } = await supabase!
      .from('profiles').select('full_name, is_admin, phone, notifications_seen_at, health_form_at').eq('id', id).maybeSingle()
    if (error || !data) return null
    return data as Profile
  },

  async setMyName(fullName) {
    const id = await uid()
    if (!id || !fullName.trim()) return
    await supabase!.from('profiles').update({ full_name: fullName.trim() }).eq('id', id)
  },

  async deleteMyAccount() {
    const { data, error } = await supabase!.rpc('delete_my_account')
    if (error) return { ok: false, error: 'network' }
    await supabase!.auth.signOut()
    return data as RpcResult
  },

  // ---------- client ----------
  async fetchClasses(fromISO, toISO) {
    const { data, error } = await supabase!
      .from('class_availability')
      .select('id, class_date, start_time, duration_min, label, capacity, taken, spots_left, is_full')
      .gte('class_date', fromISO).lte('class_date', toISO)
      .order('class_date').order('start_time')
    if (error) throw error
    return (data ?? []) as ClassRow[]
  },

  async fetchMyPacks() {
    const id = await uid()
    if (!id) return []
    // .eq matters: an admin can read every pack through RLS
    const { data, error } = await supabase!
      .from('pack_balance')
      .select('id, sessions_total, remaining, valid_from, valid_until, is_active, price_ils, note')
      .eq('user_id', id).order('valid_until', { ascending: false })
    if (error) throw error
    return (data ?? []) as Pack[]
  },

  async fetchMyBookings() {
    const id = await uid()
    if (!id) return []
    const { data, error } = await supabase!
      .from('bookings')
      .select('id, class_id, classes!inner(class_date, start_time, duration_min, label)')
      .eq('user_id', id).eq('status', 'booked')
      .gte('classes.class_date', toISODate(new Date()))
    if (error) throw error
    return (data ?? []).map((r) => {
      const row = r as unknown as {
        id: string; class_id: string
        classes: { class_date: string; start_time: string; duration_min: number; label: string | null }
      }
      return {
        id: row.id,
        class_id: row.class_id,
        class_date: row.classes.class_date,
        start_time: row.classes.start_time,
        duration_min: row.classes.duration_min,
        label: row.classes.label,
      } satisfies MyBooking
    }).sort((a, b) => (a.class_date + a.start_time).localeCompare(b.class_date + b.start_time))
  },

  async bookClass(classId) {
    const { data, error } = await supabase!.rpc('book_class', { p_class_id: classId })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  async cancelMyBooking(bookingId) {
    const { data, error } = await supabase!.rpc('cancel_my_booking', { p_booking_id: bookingId })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  // ---------- admin ----------
  async fetchRoster(fromISO, toISO) {
    const { data, error } = await supabase!
      .from('class_roster')
      .select('booking_id, class_id, class_date, start_time, label, attendee_name, attendee_phone, status, note, confirm_token, reminder_sent_at, customer_response, is_manual, user_id, health_flags, health_form_at')
      .gte('class_date', fromISO).lte('class_date', toISO)
      .order('class_date').order('start_time')
    if (error) throw error
    return (data ?? []) as RosterRow[]
  },

  async fetchClients() {
    const { data, error } = await supabase!
      .from('client_directory')
      .select('id, full_name, phone, is_admin, active_remaining, next_expiry, health_flags, health_form_at')
      .order('full_name', { nullsFirst: false })
    if (error) throw error
    return (data ?? []) as Client[]
  },

  async fetchClientPacks(userId) {
    const { data, error } = await supabase!
      .from('pack_balance')
      .select('id, sessions_total, remaining, valid_from, valid_until, is_active, price_ils, note')
      .eq('user_id', userId).order('valid_until', { ascending: false })
    if (error) throw error
    return (data ?? []) as Pack[]
  },

  async grantPack(userId, sessions, months, price, note) {
    const { data, error } = await supabase!.rpc('admin_grant_pack', {
      p_user_id: userId, p_sessions: sessions, p_months: months, p_price: price, p_note: note,
    })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  async addClass(dateISO, time, capacity, label, duration) {
    const { data, error } = await supabase!.rpc('admin_add_class', {
      p_date: dateISO, p_time: time, p_capacity: capacity, p_label: label, p_duration: duration ?? 55,
    })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  async updateClass(classId, dateISO, time, duration, capacity, label) {
    const { data, error } = await supabase!.rpc('admin_update_class', {
      p_class_id: classId, p_date: dateISO, p_time: time, p_duration: duration, p_capacity: capacity, p_label: label,
    })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  async fetchTemplate() {
    const { data, error } = await supabase!
      .from('class_template')
      .select('id, weekday, start_time, duration_min, capacity, label')
      .eq('active', true)
      .order('weekday').order('start_time')
    if (error) throw error
    return (data ?? []) as TemplateRow[]
  },

  async saveTemplate(rows) {
    const { data, error } = await supabase!.rpc('admin_save_template', { p_rows: rows })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  async createClient(fullName, phoneE164) {
    // An auth account can only be made with the service role: edge function.
    const { data, error } = await supabase!.functions.invoke('admin-create-client', {
      body: { full_name: fullName, phone: phoneE164 },
    })
    if (error) {
      const res = (error as { context?: Response }).context
      if (res?.status === 404) return { ok: false, error: 'function_missing' }
      try {
        const body = await res?.json()
        if (body && typeof body.error === 'string') return body as RpcResult
      } catch {
        /* not JSON */
      }
      return { ok: false, error: 'network' }
    }
    return data as RpcResult
  },

  async bookClient(classId, userId) {
    const { data, error } = await supabase!.rpc('admin_book_client', { p_class_id: classId, p_user_id: userId })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  async cancelClass(classId) {
    const { data, error } = await supabase!.rpc('admin_cancel_class', { p_class_id: classId })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  async adminCancelBooking(bookingId, refund) {
    const { data, error } = await supabase!.rpc('admin_cancel_booking', {
      p_booking_id: bookingId, p_refund: refund,
    })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  async bookGuest(classId, name, phone, note) {
    const { data, error } = await supabase!.rpc('admin_book_guest', {
      p_class_id: classId, p_name: name, p_phone: phone, p_note: note,
    })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  async setAttendance(bookingId, status) {
    const { data, error } = await supabase!.rpc('admin_set_attendance', {
      p_booking_id: bookingId, p_status: status,
    })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  async markReminderSent(bookingId) {
    // The "bookings admin update" policy already gates this on is_admin()
    await supabase!.from('bookings')
      .update({ reminder_sent_at: new Date().toISOString() }).eq('id', bookingId)
  },

  // ---------- shop ----------
  async fetchStudioInfo() {
    const { data, error } = await supabase!
      .from('studio_settings').select('cancel_cutoff_hours, whatsapp_phone').single()
    if (error || !data) throw error ?? new Error('no settings')
    return data as StudioInfo
  },

  async fetchPlans() {
    const { data, error } = await supabase!
      .from('plans')
      .select('id, name, description, sessions, valid_months, price_ils, payment_url, sort_order, active')
      .order('sort_order').order('created_at')
    if (error) throw error
    return (data ?? []).map((p) => ({ ...p, price_ils: Number(p.price_ils) })) as Plan[]
  },

  async fetchMyRequests() {
    const id = await uid()
    if (!id) return []
    const { data, error } = await supabase!
      .from('purchase_requests')
      .select('id, user_id, plan_id, plan_name, sessions, valid_months, price_ils, status, client_note, admin_note, created_at, decided_at')
      .eq('user_id', id).order('created_at', { ascending: false })
    if (error) throw error
    return (data ?? []).map((r) => ({ ...r, price_ils: Number(r.price_ils) })) as PurchaseRequest[]
  },

  async requestPurchase(planId, note) {
    const { data, error } = await supabase!.rpc('request_purchase', { p_plan_id: planId, p_note: note })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  async cancelPurchaseRequest(requestId) {
    const { data, error } = await supabase!.rpc('cancel_purchase_request', { p_id: requestId })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  async fetchPurchaseRequests() {
    const { data, error } = await supabase!
      .from('purchase_board').select('*').order('created_at', { ascending: false }).limit(200)
    if (error) throw error
    return (data ?? []).map((r) => ({ ...r, price_ils: Number(r.price_ils) })) as PurchaseRequest[]
  },

  async decidePurchase(requestId, approve, note) {
    const { data, error } = await supabase!.rpc('admin_decide_purchase', {
      p_id: requestId, p_approve: approve, p_note: note,
    })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  async savePlan(plan) {
    // RLS "plans admin write" gates this; no RPC needed for a plain row edit
    const row = { ...plan, price_ils: plan.price_ils }
    const { error } = plan.id
      ? await supabase!.from('plans').update(row).eq('id', plan.id)
      : await supabase!.from('plans').insert(row)
    return error ? { ok: false, error: 'network' } : { ok: true }
  },

  async saveStudioWhatsapp(phoneE164) {
    const { error } = await supabase!.from('studio_settings').update({ whatsapp_phone: phoneE164 }).eq('id', true)
    return error ? { ok: false, error: 'network' } : { ok: true }
  },

  // ---------- health declaration ----------
  async getMyHealthForm() {
    const id = await uid()
    if (!id) return null
    const { data, error } = await supabase!
      .from('health_forms')
      .select('id, user_id, form_version, lang, answers, flags, consent_name, signature_png, submitted_at')
      .eq('user_id', id).order('submitted_at', { ascending: false }).limit(1)
    if (error || !data?.length) return null
    return data[0] as HealthForm
  },

  async submitHealthForm(input) {
    const { data, error } = await supabase!.rpc('submit_health_form', {
      p_answers: input.answers, p_flags: input.flags, p_consent_name: input.consentName,
      p_signature_png: input.signaturePng, p_lang: input.lang,
    })
    if (error) return { ok: false, error: 'network' }
    return data as RpcResult
  },

  async adminFetchHealthForm(userId) {
    const { data, error } = await supabase!
      .from('health_forms')
      .select('id, user_id, form_version, lang, answers, flags, consent_name, signature_png, submitted_at')
      .eq('user_id', userId).order('submitted_at', { ascending: false }).limit(1)
    if (error || !data?.length) return null
    return data[0] as HealthForm
  },

  // ---------- notifications ----------
  async fetchNotifications() {
    const id = await uid()
    if (!id) return []
    // an admin can read everyone's rows through RLS — this is the *client*
    // inbox, so keep it to announcements + mine
    const { data, error } = await supabase!
      .from('notifications')
      .select('id, user_id, kind, data, created_at')
      .or(`user_id.is.null,user_id.eq.${id}`)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw error
    return (data ?? []) as Notification[]
  },

  async markNotificationsSeen() {
    const id = await uid()
    if (!id) return
    await supabase!.from('profiles').update({ notifications_seen_at: new Date().toISOString() }).eq('id', id)
  },

  async fetchAnnouncements() {
    const { data, error } = await supabase!
      .from('notifications')
      .select('id, user_id, kind, data, created_at')
      .is('user_id', null)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw error
    return (data ?? []) as Notification[]
  },

  async sendAnnouncement(title, body) {
    // RLS "announcements admin insert" gates this
    const { error } = await supabase!
      .from('notifications')
      .insert({ user_id: null, kind: 'announcement', data: { title, body } })
    return error ? { ok: false, error: 'network' } : { ok: true }
  },

  async deleteNotification(id) {
    const { error } = await supabase!.from('notifications').delete().eq('id', id)
    return error ? { ok: false, error: 'network' } : { ok: true }
  },

  // ---------- shared ----------
  subscribeChanges(cb) {
    const ch = supabase!
      .channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'classes' }, cb)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, cb)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'purchase_requests' }, cb)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'plans' }, cb)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, cb)
      .subscribe()
    return () => { supabase!.removeChannel(ch) }
  },

  async savePushSubscription(sub: PushSub, lang) {
    // RPC, not upsert: a device changes hands, and RLS would refuse to move
    // another user's row to the person signed in now
    const { data, error } = await supabase!.rpc('save_push_subscription', {
      p_endpoint: sub.endpoint, p_kind: sub.kind, p_p256dh: sub.p256dh, p_auth: sub.auth, p_lang: lang,
    })
    return !error && (data as RpcResult | null)?.ok === true
  },

  async deletePushSubscription(endpoint) {
    await supabase!.rpc('delete_push_subscription', { p_endpoint: endpoint })
  },
}

export const api: Api = isConfigured ? realApi : demoApi
