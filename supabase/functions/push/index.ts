// Supabase Edge Function `push`: delivers every notification the app sends —
// to admins (new booking / cancellation / purchase request) and to clients
// (rows of `notifications`) — over three transports:
//   web   Web Push / VAPID          (browser, installed PWA)
//   apns  Apple Push (HTTP/2 + JWT) (the iOS app)
//   fcm   Firebase Cloud Messaging  (the Android app)
//
// Secrets (Edge Functions → Secrets):
//   WEBHOOK_SECRET          shared with the DB trigger (supabase_push_setup.sql)
//   APNS_TEAM_ID, APNS_KEY_ID, APNS_BUNDLE_ID, APNS_KEY_P8 (or APNS_KEY_P8_B64)
//   APNS_SANDBOX            'true' | 'false' | unset (= try production, then sandbox)
//   FCM_SERVICE_ACCOUNT     the Firebase service-account JSON (or FCM_SERVICE_ACCOUNT_B64)
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.
// A transport whose secrets are missing is skipped and reported, never fatal.
//
// npm:web-push crashes the Deno edge runtime — use this JSR package.
import * as webpush from 'jsr:@negrel/webpush@0.3.0'
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

type Lang = 'he' | 'ar'
type Kind = 'web' | 'apns' | 'fcm'
type Sub = { id: string; user_id: string; endpoint: string; kind: Kind; p256dh: string | null; auth: string | null; lang: Lang }
type Msg = { title: string; body: string; url: string; tag: string }
type Ev = 'booking_created' | 'booking_cancelled' | 'purchase_request' | 'notification' | 'unknown'

// ⚠️ REPLACE BOTH before deploying — `npx web-push generate-vapid-keys`.
// Baked into the source on purpose: keys pasted into the dashboard's secret
// editor arrived corrupted and every push came back 403 from FCM. The public
// half MUST equal VITE_VAPID_PUBLIC_KEY in the frontend bundle.
const VAPID_PUBLIC = 'REPLACE_ME_PUBLIC'
const VAPID_PRIVATE = 'REPLACE_ME_PRIVATE'
const CONTACT = 'mailto:studio@example.com'

// ---------------------------------------------------------------- copy
// Mirrors src/i18n.ts. Rows carry kind + data only; text is built here in the
// language each device registered with.
const T: Record<Lang, Record<string, string> & { days: string[] }> = {
  he: {
    days: ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'],
    someone: 'מתאמן/ת', classDefault: 'פילאטיס', at: 'בשעה',
    bookingCreated: 'הרשמה חדשה 🎉', bookingCancelled: 'ביטול הרשמה ❌', spotReopened: 'המקום נפתח מחדש',
    purchase: 'בקשת רכישה 🛍️',
    nPurchaseApproved: 'המנוי נפתח 🎉', nPurchaseDeclined: 'הבקשה לא אושרה',
    nPackGranted: 'נפתח לכם מנוי', nPackBody: '{plan} · {n} שיעורים · בתוקף עד {d}',
    nDeclinedBody: '{plan} — לפרטים דברו עם הסטודיו.',
    nClassCancelled: 'שיעור בוטל', nClassCancelledBody: '{d} בשעה {t} · השיעור הוחזר למנוי',
    nRemoved: 'הוסרתם מהשיעור', nRemovedRefund: 'השיעור הוחזר למנוי', nRemovedNoRefund: 'השיעור לא הוחזר למנוי',
    nClassMoved: 'השיעור הוזז', nClassMovedBody: 'עכשיו {d} בשעה {t} (במקום {was})',
  },
  ar: {
    days: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
    someone: 'متدرب/ة', classDefault: 'بيلاتس', at: 'الساعة',
    bookingCreated: 'تسجيل جديد 🎉', bookingCancelled: 'إلغاء تسجيل ❌', spotReopened: 'المكان انفتح من جديد',
    purchase: 'طلب شراء 🛍️',
    nPurchaseApproved: 'انفتح الاشتراك 🎉', nPurchaseDeclined: 'ما تمّت الموافقة على الطلب',
    nPackGranted: 'انفتح لكن اشتراك', nPackBody: '{plan} · {n} حصص · ساري لتاريخ {d}',
    nDeclinedBody: '{plan} — للتفاصيل احكوا مع الستوديو.',
    nClassCancelled: 'انلغت حصة', nClassCancelledBody: '{d} الساعة {t} · الحصة رجعت للاشتراك',
    nRemoved: 'انشطبتوا من الحصة', nRemovedRefund: 'الحصة رجعت للاشتراك', nRemovedNoRefund: 'الحصة ما رجعت للاشتراك',
    nClassMoved: 'تغيّر موعد الحصة', nClassMovedBody: 'هلّق {d} الساعة {t} (بدل {was})',
  },
}

function fmtDate(lang: Lang, iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  return `${T[lang].days[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}`
}
function fmtShort(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${Number(d)}.${Number(m)}`
}
const hhmm = (t: string) => String(t).slice(0, 5)

// ---------------------------------------------------------------- utils
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
function b64uToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}
function bytesToB64u(b: Uint8Array): string {
  let s = ''
  for (const c of b) s += String.fromCharCode(c)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const strToB64u = (s: string) => bytesToB64u(new TextEncoder().encode(s))
function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const raw = atob(b64)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}
/** Reads NAME, or NAME_B64 (base64 of the value) — multi-line keys survive the
 *  dashboard's secret editor only in base64. */
function secret(name: string): string | undefined {
  const plain = Deno.env.get(name)
  if (plain) return plain
  const b64 = Deno.env.get(name + '_B64')
  if (!b64) return undefined
  try {
    return new TextDecoder().decode(b64uToBytes(b64.replace(/\s+/g, '')))
  } catch {
    return undefined
  }
}
async function signJwt(header: Record<string, unknown>, claims: Record<string, unknown>, key: CryptoKey, alg: 'ES256' | 'RS256'): Promise<string> {
  const input = `${strToB64u(JSON.stringify(header))}.${strToB64u(JSON.stringify(claims))}`
  const params = alg === 'ES256'
    ? { name: 'ECDSA', hash: 'SHA-256' } as EcdsaParams
    : { name: 'RSASSA-PKCS1-v1_5' }
  const sig = await crypto.subtle.sign(params, key, new TextEncoder().encode(input))
  return `${input}.${bytesToB64u(new Uint8Array(sig))}`
}

// ---------------------------------------------------------------- transport: web
function vapidJwks(pubB64u: string, privB64u: string) {
  const pub = b64uToBytes(pubB64u)
  if (pub.length !== 65 || pub[0] !== 4) throw new Error('VAPID_PUBLIC is not an uncompressed P-256 point')
  const x = bytesToB64u(pub.slice(1, 33))
  const y = bytesToB64u(pub.slice(33, 65))
  return {
    publicKey: { kty: 'EC', crv: 'P-256', x, y, ext: true, key_ops: ['verify'] } as JsonWebKey,
    privateKey: { kty: 'EC', crv: 'P-256', x, y, d: privB64u, ext: true, key_ops: ['sign'] } as JsonWebKey,
  }
}
let appServer: webpush.ApplicationServer | null = null
async function webServer(): Promise<webpush.ApplicationServer> {
  if (appServer) return appServer
  const vapidKeys = await webpush.importVapidKeys(vapidJwks(VAPID_PUBLIC, VAPID_PRIVATE), { extractable: false })
  appServer = await webpush.ApplicationServer.new({ contactInformation: CONTACT, vapidKeys })
  return appServer
}
async function sendWeb(sub: Sub, msg: Msg): Promise<'sent' | 'dead'> {
  const server = await webServer()
  try {
    const subscriber = server.subscribe({
      endpoint: sub.endpoint, expirationTime: null,
      keys: { p256dh: sub.p256dh ?? '', auth: sub.auth ?? '' },
    })
    await subscriber.pushTextMessage(JSON.stringify(msg), {})
    return 'sent'
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status
    if (status === 404 || status === 410) return 'dead'
    throw err
  }
}

// ---------------------------------------------------------------- transport: apns
let apnsJwtCache: { token: string; at: number } | null = null
async function apnsJwt(): Promise<string> {
  if (apnsJwtCache && Date.now() - apnsJwtCache.at < 50 * 60_000) return apnsJwtCache.token
  const pem = secret('APNS_KEY_P8')
  const teamId = Deno.env.get('APNS_TEAM_ID')
  const keyId = Deno.env.get('APNS_KEY_ID')
  if (!pem || !teamId || !keyId) throw new Error('apns_not_configured')
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
  const token = await signJwt({ alg: 'ES256', kid: keyId }, { iss: teamId, iat: Math.floor(Date.now() / 1000) }, key, 'ES256')
  apnsJwtCache = { token, at: Date.now() }
  return token
}
async function sendApns(sub: Sub, msg: Msg): Promise<'sent' | 'dead'> {
  const bundleId = Deno.env.get('APNS_BUNDLE_ID')
  if (!bundleId) throw new Error('apns_not_configured')
  const token = sub.endpoint.slice('apns:'.length)
  const mode = Deno.env.get('APNS_SANDBOX')
  // Xcode builds register with the sandbox, TestFlight/App Store with
  // production. Unset = try production first, fall back to sandbox.
  const hosts = mode === 'true' ? ['api.sandbox.push.apple.com']
    : mode === 'false' ? ['api.push.apple.com']
    : ['api.push.apple.com', 'api.sandbox.push.apple.com']
  const jwt = await apnsJwt()
  let lastText = ''
  for (const host of hosts) {
    const res = await fetch(`https://${host}/3/device/${token}`, {
      method: 'POST',
      headers: {
        authorization: `bearer ${jwt}`,
        'apns-topic': bundleId,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-collapse-id': msg.tag.slice(0, 64),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ aps: { alert: { title: msg.title, body: msg.body }, sound: 'default' }, url: msg.url }),
    })
    if (res.ok) return 'sent'
    lastText = await res.text()
    if (res.status === 410 || /Unregistered|DeviceTokenNotForTopic/.test(lastText)) return 'dead'
    if (!/BadDeviceToken/.test(lastText)) throw new Error(`apns ${res.status} ${lastText.slice(0, 120)}`)
    // BadDeviceToken: wrong environment for this token — try the other host
  }
  return 'dead'
}

// ---------------------------------------------------------------- transport: fcm
let fcmCache: { token: string; projectId: string; at: number } | null = null
async function fcmAuth(): Promise<{ token: string; projectId: string }> {
  if (fcmCache && Date.now() - fcmCache.at < 50 * 60_000) return fcmCache
  const raw = secret('FCM_SERVICE_ACCOUNT')
  if (!raw) throw new Error('fcm_not_configured')
  const sa = JSON.parse(raw) as { client_email: string; private_key: string; project_id: string }
  const key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
  const iat = Math.floor(Date.now() / 1000)
  const jwt = await signJwt({ alg: 'RS256', typ: 'JWT' }, {
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600,
  }, key, 'RS256')
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`,
  })
  if (!res.ok) throw new Error(`fcm oauth ${res.status} ${(await res.text()).slice(0, 120)}`)
  const { access_token } = await res.json()
  fcmCache = { token: access_token, projectId: sa.project_id, at: Date.now() }
  return fcmCache
}
async function sendFcm(sub: Sub, msg: Msg): Promise<'sent' | 'dead'> {
  const { token, projectId } = await fcmAuth()
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: sub.endpoint.slice('fcm:'.length),
        notification: { title: msg.title, body: msg.body },
        data: { url: msg.url, tag: msg.tag },
        android: { priority: 'HIGH', notification: { tag: msg.tag } },
      },
    }),
  })
  if (res.ok) return 'sent'
  const text = await res.text()
  if (res.status === 404 || /UNREGISTERED/.test(text) || (/INVALID_ARGUMENT/.test(text) && /token/i.test(text))) return 'dead'
  throw new Error(`fcm ${res.status} ${text.slice(0, 120)}`)
}

// ---------------------------------------------------------------- fan-out
async function deliver(db: SupabaseClient, subs: Sub[], msgFor: (lang: Lang) => Msg) {
  const cache: Partial<Record<Lang, Msg>> = {}
  const msg = (lang: Lang) => (cache[lang] ??= msgFor(lang === 'ar' ? 'ar' : 'he'))
  let sent = 0
  const dead: string[] = []
  const errors: string[] = []
  const skipped: Record<string, number> = {}
  await Promise.all(subs.map(async (s) => {
    try {
      const r = s.kind === 'web' ? await sendWeb(s, msg(s.lang))
        : s.kind === 'apns' ? await sendApns(s, msg(s.lang))
        : await sendFcm(s, msg(s.lang))
      if (r === 'sent') sent++
      else dead.push(s.endpoint)
    } catch (err) {
      const m = String(err)
      if (/not_configured/.test(m)) skipped[s.kind] = (skipped[s.kind] ?? 0) + 1
      else errors.push(`${s.kind}: ${m.slice(0, 140)}`)
    }
  }))
  if (dead.length) await db.from('push_subscriptions').delete().in('endpoint', dead)
  return { sent, pruned: dead.length, skipped: Object.keys(skipped).length ? skipped : undefined, errors: errors.length ? errors : undefined }
}

const SUB_COLS = 'id, user_id, endpoint, kind, p256dh, auth, lang'
async function adminSubs(db: SupabaseClient): Promise<Sub[]> {
  const { data } = await db.from('push_subscriptions').select(`${SUB_COLS}, profiles!inner(is_admin)`).eq('profiles.is_admin', true)
  return (data ?? []) as unknown as Sub[]
}
async function userSubs(db: SupabaseClient, userId: string): Promise<Sub[]> {
  const { data } = await db.from('push_subscriptions').select(SUB_COLS).eq('user_id', userId)
  return (data ?? []) as Sub[]
}
async function allSubs(db: SupabaseClient): Promise<Sub[]> {
  const { data } = await db.from('push_subscriptions').select(SUB_COLS).limit(5000)
  return (data ?? []) as Sub[]
}

// ---------------------------------------------------------------- events
function resolveEvent(raw: unknown): Ev {
  // Explicit allow-list — MUST NOT fail open. An unknown event once fell
  // through to the celebratory "new booking" copy in the previous studio app.
  if (raw === undefined || raw === null) return 'booking_created'
  return raw === 'booking_cancelled' || raw === 'purchase_request' || raw === 'notification' || raw === 'booking_created'
    ? raw as Ev : 'unknown'
}

Deno.serve(async (req) => {
  const missing = ['WEBHOOK_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !Deno.env.get(k))
  if (missing.length) return json({ error: 'missing_secrets', missing }, 500)
  if (req.headers.get('x-webhook-secret') !== Deno.env.get('WEBHOOK_SECRET')) return json({ error: 'forbidden' }, 403)

  let body: Record<string, string | boolean | undefined>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'bad_request' }, 400)
  }

  // `{"ping":true}` reports which transports are configured, no sends
  if (body.ping) {
    const report: Record<string, string> = {}
    try { await webServer(); report.web = 'ok' } catch (e) { report.web = String(e).slice(0, 80) }
    try { await apnsJwt(); report.apns = Deno.env.get('APNS_BUNDLE_ID') ? 'ok' : 'missing APNS_BUNDLE_ID' } catch (e) { report.apns = String(e).slice(0, 80) }
    try { await fcmAuth(); report.fcm = 'ok' } catch (e) { report.fcm = String(e).slice(0, 80) }
    return json({ ok: true, transports: report })
  }

  const event = resolveEvent(body.event)
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

  if (event === 'notification') {
    const id = body.notification_id as string | undefined
    if (!id) return json({ error: 'missing notification_id' }, 400)
    const { data: n } = await db.from('notifications').select('user_id, kind, data').eq('id', id).single()
    if (!n) return json({ error: 'notification_not_found' }, 404)
    const d = (n.data ?? {}) as Record<string, string | number | boolean | null>
    const str = (k: string) => (d[k] == null ? '' : String(d[k]))
    const subs = n.user_id ? await userSubs(db, n.user_id) : await allSubs(db)
    const url = '/#/notifications'
    const tag = `notif-${id}`
    return json(await deliver(db, subs, (lang) => {
      const t = T[lang]
      const pack = () => t.nPackBody.replace('{plan}', str('plan_name') || str('note') || t.classDefault)
        .replace('{n}', str('sessions')).replace('{d}', d.valid_until ? fmtShort(str('valid_until')) : '—')
      switch (n.kind) {
        case 'announcement': return { title: str('title'), body: str('body'), url, tag }
        case 'purchase_approved': return { title: t.nPurchaseApproved, body: pack(), url, tag }
        case 'purchase_declined': return { title: t.nPurchaseDeclined, body: t.nDeclinedBody.replace('{plan}', str('plan_name')), url, tag }
        case 'pack_granted': return { title: t.nPackGranted, body: pack(), url, tag }
        case 'class_cancelled': return {
          title: t.nClassCancelled,
          body: t.nClassCancelledBody.replace('{d}', fmtDate(lang, str('class_date'))).replace('{t}', hhmm(str('start_time'))), url, tag,
        }
        case 'booking_removed': return {
          title: t.nRemoved,
          body: `${fmtDate(lang, str('class_date'))} · ${hhmm(str('start_time'))} · ${d.refunded ? t.nRemovedRefund : t.nRemovedNoRefund}`, url, tag,
        }
        case 'class_moved': return {
          title: t.nClassMoved,
          body: t.nClassMovedBody.replace('{d}', fmtDate(lang, str('class_date'))).replace('{t}', hhmm(str('start_time')))
            .replace('{was}', `${fmtDate(lang, str('old_date'))} ${hhmm(str('old_time'))}`), url, tag,
        }
        default: return { title: str('title') || t.classDefault, body: str('body'), url, tag }
      }
    }))
  }

  if (event === 'purchase_request') {
    const id = body.request_id as string | undefined
    if (!id) return json({ error: 'missing request_id' }, 400)
    const { data: r } = await db.from('purchase_requests').select('user_id, plan_name, price_ils').eq('id', id).single()
    if (!r) return json({ error: 'request_not_found' }, 404)
    const { data: buyer } = await db.from('profiles').select('full_name, phone').eq('id', r.user_id).single()
    return json(await deliver(db, await adminSubs(db), (lang) => ({
      title: T[lang].purchase,
      body: `${buyer?.full_name || buyer?.phone || T[lang].someone} · ${r.plan_name} · ${Number(r.price_ils)} ₪`,
      url: '/#/admin', tag: `purchase-${id}`,
    })))
  }

  if (event === 'booking_created' || event === 'booking_cancelled') {
    const id = body.booking_id as string | undefined
    if (!id) return json({ error: 'missing booking_id' }, 400)
    const { data: b } = await db.from('bookings').select('user_id, class_id, guest_name').eq('id', id).single()
    if (!b) return json({ error: 'booking_not_found' }, 404)
    const [{ data: client }, { data: cls }] = await Promise.all([
      b.user_id ? db.from('profiles').select('full_name, phone').eq('id', b.user_id).single() : Promise.resolve({ data: null }),
      db.from('classes').select('class_date, start_time, label').eq('id', b.class_id).single(),
    ])
    return json(await deliver(db, await adminSubs(db), (lang) => {
      const t = T[lang]
      const who = client?.full_name || client?.phone || b.guest_name || t.someone
      const when = cls ? `${fmtDate(lang, cls.class_date)} · ${hhmm(cls.start_time)}` : ''
      const head = `${who} · ${cls?.label || t.classDefault} · ${when}`
      return event === 'booking_created'
        ? { title: t.bookingCreated, body: head, url: '/#/admin', tag: `booking-${id}-created` }
        : { title: t.bookingCancelled, body: `${head}\n${t.spotReopened}`, url: '/#/admin', tag: `booking-${id}-cancelled` }
    }))
  }

  // unknown: neutral, never celebratory
  return json({ ok: false, error: 'unknown_event' }, 400)
})
