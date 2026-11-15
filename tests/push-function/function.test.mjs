// The REAL edge function file (supabase/functions/push/index.ts), run under
// Node with its outside world stubbed: the two imports (web push library,
// Supabase client), Deno.env / Deno.serve, and fetch (Apple). Nothing leaves
// this machine. It checks who gets what, the wording, and the Apple token rule.
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { ROOT } from '../lib/harness.mjs'
import { checks } from '../lib/checks.mjs'

const FILE = ROOT + 'supabase/functions/push/index.ts'
const ts = createRequire(ROOT + 'app/')('typescript')
const b64u = (buf) => Buffer.from(buf).toString('base64url')

/** Loads the function with throwaway keys, so its own key handling runs for real. */
async function load({ apns = true } = {}) {
  const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const vapidPub = b64u(await crypto.subtle.exportKey('raw', vapid.publicKey))
  const vapidPriv = (await crypto.subtle.exportKey('jwk', vapid.privateKey)).d
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', key.privateKey)).toString('base64')
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`

  let src = readFileSync(FILE, 'utf8')
  const imports = src.match(/^import .*$/gm) ?? []
  const placeholders = src.includes("'REPLACE_ME_PUBLIC'") && src.includes("'REPLACE_ME_PRIVATE'")
  src = src.replace(/^import .*$/gm, '').replace("'REPLACE_ME_PUBLIC'", JSON.stringify(vapidPub)).replace("'REPLACE_ME_PRIVATE'", JSON.stringify(vapidPriv))
  const out = ts.transpileModule(src, { compilerOptions: { target: 'ES2022', module: 'ESNext' }, reportDiagnostics: true })

  const env = { WEBHOOK_SECRET: 's3cret', SUPABASE_URL: 'http://db', SUPABASE_SERVICE_ROLE_KEY: 'k',
    ...(apns ? { APNS_KEY_P8: pem, APNS_TEAM_ID: 'TEAM123456', APNS_KEY_ID: 'KEY1234567', APNS_BUNDLE_ID: 'com.rudeen.pilates' } : {}) }
  const tables = {
    bookings: [
      { id: 'b1', user_id: 'u1', class_id: 'c1', status: 'booked', guest_name: null },
      { id: 'b2', user_id: 'u1', class_id: 'c1', status: 'cancelled', guest_name: null },
      { id: 'b3', user_id: 'u1', class_id: 'c2', status: 'booked', guest_name: null },
    ],
    classes: [{ id: 'c1', class_date: '2026-11-16', start_time: '18:00:00', label: 'Reformer', status: 'open' }, { id: 'c2', class_date: '2026-11-16', start_time: '19:15:00', label: null, status: 'cancelled' }],
    profiles: [{ id: 'u1', full_name: 'Client One', phone: '+972500000002' }],
    notifications: [{ id: 'n1', user_id: null, kind: 'announcement', data: { title: 'Holiday hours', body: 'Closed on Friday' } }],
    push_subscriptions: [
      { id: 's1', user_id: 'u1', endpoint: 'https://web.example/abc', kind: 'web', p256dh: 'x', auth: 'y', lang: 'he' },
      { id: 's2', user_id: 'u1', endpoint: 'apns:devicetoken1', kind: 'apns', p256dh: null, auth: null, lang: 'ar' },
      ...[2, 3, 4, 5, 6].map((i) => ({ id: 's' + (i + 1), user_id: 'u' + i, endpoint: 'apns:devicetoken' + i, kind: 'apns', p256dh: null, auth: null, lang: 'he' })),
    ],
  }
  const createClient = () => ({ from(table) {
    let rows = tables[table].slice()
    const q = {
      select: () => q, limit: () => q, delete: () => q,
      eq: (c, v) => { rows = rows.filter((r) => r[c] === v); return q },
      in: (c, vs) => { rows = rows.filter((r) => vs.includes(r[c])); return q },
      single: async () => ({ data: rows[0] ?? null }),
      then: (res, rej) => Promise.resolve({ data: rows }).then(res, rej),
    }
    return q
  } })
  const state = { sent: [], appleStatus: 200, appleBody: '' }
  const webpush = {
    importVapidKeys: async () => ({}),
    ApplicationServer: { new: async () => ({ subscribe: (sub) => ({ pushTextMessage: async (text) => { state.sent.push({ kind: 'web', to: sub.endpoint, msg: JSON.parse(text) }) } }) }) },
  }
  const fetchStub = async (url, init) => {
    state.sent.push({ kind: 'apns', to: String(url), headers: init.headers, msg: JSON.parse(init.body) })
    return new Response(state.appleBody, { status: state.appleStatus })
  }
  let handler = null
  const Deno = { env: { get: (k) => env[k] }, serve: (h) => { handler = h } }
  new Function('Deno', 'webpush', 'createClient', 'fetch', out.outputText)(Deno, webpush, createClient, fetchStub)
  const call = async (body, secret = 's3cret') => {
    state.sent = []
    const res = await handler(new Request('http://fn/push', { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-secret': secret }, body: JSON.stringify(body) }))
    return { status: res.status, json: await res.json(), sent: state.sent }
  }
  return { call, state, imports, placeholders, diagnostics: out.diagnostics ?? [], hasHandler: typeof handler === 'function' }
}
const web = (x) => x.sent.find((s) => s.kind === 'web')
const ap = (x) => x.sent.find((s) => s.kind === 'apns')

test('the function file: loads, guards its door, answers a ping', async () => {
  const { ok, finish } = checks()
  const f = await load()
  ok('exactly the two imports the harness replaces', f.imports.length === 2, f.imports.length)
  ok('the repo copy carries placeholders, never real notification keys', f.placeholders)
  ok('no syntax errors', f.diagnostics.length === 0, JSON.stringify(f.diagnostics.map((d) => d.messageText)))
  ok('it registered its handler', f.hasHandler)
  let r = await f.call({ ping: true }, 'wrong')
  ok('wrong secret: 403, nothing sent', r.status === 403 && r.sent.length === 0, JSON.stringify(r.json))
  r = await f.call({ ping: true })
  ok('ping: web ok, apns ok, android not configured, nothing sent', r.json.transports?.web === 'ok' && r.json.transports?.apns === 'ok' && /not_configured/.test(r.json.transports?.fcm) && r.sent.length === 0, JSON.stringify(r.json))
  r = await f.call({ event: 'something_else' })
  ok('unknown event: 400, nothing sent', r.status === 400 && r.sent.length === 0, JSON.stringify(r.json))
  const g = await load({ apns: false })
  r = await g.call({ ping: true })
  ok('without the Apple secrets the ping says so', /apns_not_configured/.test(r.json.transports?.apns), JSON.stringify(r.json))
  r = await g.call({ event: 'class_reminder', booking_id: 'b1' })
  ok('and a send skips the iPhone instead of failing', r.status === 200 && r.json.sent === 1 && r.json.skipped?.apns === 1 && !r.json.errors, JSON.stringify(r.json))
  finish()
})

test('class reminders: an hour before and half an hour before', async () => {
  const { ok, finish } = checks()
  const { call } = await load()
  for (const [label, body] of [['no minutes (older database)', { event: 'class_reminder', booking_id: 'b1' }], ['minutes: 60', { event: 'class_reminder', booking_id: 'b1', minutes: 60 }]]) {
    const r = await call(body)
    ok(`hour reminder, ${label}: to her 2 devices only`, r.status === 200 && r.json.sent === 2 && r.sent.length === 2 && !r.json.errors, JSON.stringify(r.json))
    ok(`hour reminder, ${label}: Hebrew phone says "in an hour"`, web(r)?.msg.title === 'תזכורת: שיעור בעוד שעה ⏰' && web(r)?.msg.body === 'היום בשעה 18:00 · Reformer' && web(r)?.msg.tag === 'reminder-b1', JSON.stringify(web(r)?.msg))
    ok(`hour reminder, ${label}: Arabic iPhone says "in an hour"`, ap(r)?.msg.aps.alert.title === 'تذكير: الحصة بعد ساعة ⏰' && ap(r)?.headers['apns-collapse-id'] === 'reminder-b1' && ap(r)?.headers['apns-topic'] === 'com.rudeen.pilates', JSON.stringify(ap(r)?.msg))
  }
  let r = await call({ event: 'class_reminder', booking_id: 'b1', minutes: 30 })
  ok('half-hour reminder: to her 2 devices only', r.status === 200 && r.json.sent === 2 && r.sent.length === 2 && !r.json.errors, JSON.stringify(r.json))
  ok('half-hour: Hebrew phone says "in half an hour", same time and class', web(r)?.msg.title === 'תזכורת: שיעור בעוד חצי שעה ⏰' && web(r)?.msg.body === 'היום בשעה 18:00 · Reformer', JSON.stringify(web(r)?.msg))
  ok('half-hour: Arabic iPhone says "in half an hour", with sound', ap(r)?.msg.aps.alert.title === 'تذكير: الحصة بعد نص ساعة ⏰' && ap(r)?.msg.aps.alert.body === 'اليوم الساعة 18:00 · Reformer' && ap(r)?.msg.aps.sound === 'default', JSON.stringify(ap(r)?.msg))
  ok('half-hour: its own tag, so it does not silently replace the hour one', web(r)?.msg.tag === 'reminder30-b1' && ap(r)?.headers['apns-collapse-id'] === 'reminder30-b1', JSON.stringify([web(r)?.msg.tag, ap(r)?.headers['apns-collapse-id']]))
  r = await call({ event: 'class_reminder', booking_id: 'b1', minutes: '30' })
  ok('minutes as the text "30" also means half an hour', web(r)?.msg.title === 'תזכורת: שיעור בעוד חצי שעה ⏰', JSON.stringify(web(r)?.msg))
  r = await call({ event: 'class_reminder', booking_id: 'b2', minutes: 30 })
  ok('cancelled booking: nothing sent', r.json.skipped === 'not_booked' && r.sent.length === 0, JSON.stringify(r.json))
  r = await call({ event: 'class_reminder', booking_id: 'b3', minutes: 30 })
  ok('cancelled class: nothing sent', r.json.skipped === 'class_not_open' && r.sent.length === 0, JSON.stringify(r.json))
  r = await call({ event: 'class_reminder', minutes: 30 })
  ok('no booking id: 400', r.status === 400 && r.sent.length === 0, JSON.stringify(r.json))
  finish()
})

test('an announcement to several iPhones uses ONE Apple token', async () => {
  // Apple accepts one new token per connection every 20 minutes. Signing one
  // per phone got "429 TooManyProviderTokenUpdates" for 4 of 6 iPhones.
  const { ok, finish } = checks()
  const { call } = await load()
  const r = await call({ event: 'notification', notification_id: 'n1' })
  const iphones = r.sent.filter((s) => s.kind === 'apns')
  ok('it goes to everybody: 6 iPhones and 1 browser', r.status === 200 && r.json.sent === 7 && iphones.length === 6 && !r.json.errors, JSON.stringify(r.json))
  ok('all 6 iPhones in the batch carry the same token', new Set(iphones.map((s) => s.headers.authorization)).size === 1, new Set(iphones.map((s) => s.headers.authorization)).size)
  ok('the text is the announcement\'s own', iphones[0]?.msg.aps.alert.title === 'Holiday hours' && iphones[0]?.msg.aps.alert.body === 'Closed on Friday', JSON.stringify(iphones[0]?.msg))
  const again = await call({ event: 'class_reminder', booking_id: 'b1' })
  ok('a later send in the same run reuses that token', ap(again)?.headers.authorization === iphones[0].headers.authorization)
  finish()
})

test('Apple refusing a send is reported, and a dead phone is forgotten', async () => {
  const { ok, finish } = checks()
  const { call, state } = await load()
  state.appleStatus = 429; state.appleBody = '{"reason":"TooManyProviderTokenUpdates"}'
  let r = await call({ event: 'class_reminder', booking_id: 'b1' })
  ok('a refusal shows up as an error, the browser still gets it', r.json.sent === 1 && (r.json.errors ?? []).some((e) => /apns 429/.test(e)), JSON.stringify(r.json))
  state.appleStatus = 410; state.appleBody = '{"reason":"Unregistered"}'
  r = await call({ event: 'class_reminder', booking_id: 'b1' })
  ok('an app that was deleted is pruned, not an error', r.json.sent === 1 && r.json.pruned === 1 && !r.json.errors, JSON.stringify(r.json))
  finish()
})
