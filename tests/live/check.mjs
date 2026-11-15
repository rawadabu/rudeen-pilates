// Read-only look at the LIVE site and database from outside, as a visitor
// would see them. It signs in as nobody and changes nothing. Use it after a
// release:   npm run live            (or: npm run live -- "text that must be on the site" …)
//
// What it can tell:
//   - the site is up and which build it serves; optional texts are in that build
//   - each database function a release added exists AND is closed to visitors
//     (a visitor's call is answered "42501 permission denied"; a function that
//     was never created answers "PGRST202 not found")
//   - the push function is up and refuses a caller without the secret
// What it cannot tell: anything only an admin sees, and whether a phone
// really shows a notification.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const SITE = 'https://rudeen-pilates.vercel.app'
const DB = 'https://mmlzqwaskejxotnzocmf.supabase.co'
const ZERO = '00000000-0000-0000-0000-000000000000'
// Older functions (before v1.6) are reachable by a visitor and refuse the caller
// themselves; see tests/db/visitors.test.mjs. function, a well-formed call, the answer a visitor gets
const SELF_GUARDED = [
  ['request_purchase', { p_plan_id: ZERO, p_note: null }, 'not_authenticated'],
  ['admin_cancel_class', { p_class_id: ZERO }, 'not_admin'],
  ['admin_grant_pack', { p_user_id: ZERO, p_sessions: 1 }, 'not_admin'],
  ['book_class', { p_class_id: ZERO }, 'not_authenticated'],
]
// function, a well-formed call, the patch that added it
const CLOSED = [
  ['send_class_reminders', {}, 'v1.6 / v1.8'],
  ['push_send', { p_body: {} }, 'push setup'],
  ['admin_cancel_day', { p_date: '2020-01-01' }, 'v1.7'],
  ['cancel_class_refund', { p_class_id: ZERO }, 'v1.7'],
  ['push_device_count', { p_user: ZERO }, 'v1.9'],
  ['admin_update_pack', { p_pack_id: ZERO, p_sessions: 8, p_valid_until: '2020-01-01' }, 'v1.10'],
  ['admin_delete_pack', { p_pack_id: ZERO }, 'v1.10'],
  ['pack_used', { p_pack_id: ZERO }, 'v1.10'],
]
let bad = 0
const line = (good, what, detail = '') => { if (!good) bad++; console.log(`${good ? '  ok  ' : ' FAIL '} ${what}${detail ? ' — ' + detail : ''}`) }

// ---- the site
const page = await fetch(SITE)
const html = await page.text()
const bundlePath = html.match(/\/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0]
line(page.ok && !!bundlePath, 'site is up', `HTTP ${page.status}, build ${bundlePath ?? '?'}`)
const bundle = bundlePath ? await (await fetch(SITE + bundlePath)).text() : ''
const key = bundle.match(/sb_publishable_[A-Za-z0-9_-]{20,}/)?.[0]   // the public key every visitor's browser gets; never printed
line(!!key, 'the build is connected to the database')
line(!bundle.includes('__pushFake'), 'the dev-only preview switch is not in the build')
for (const text of process.argv.slice(2)) line(bundle.includes(text), `the build contains "${text}"`)

// ---- the database, as a visitor
const visitor = { apikey: key ?? '', 'content-type': 'application/json' }
for (const [fn, args, answer] of SELF_GUARDED) {
  const r = await (await fetch(`${DB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: visitor, body: JSON.stringify(args) })).json().catch(() => ({}))
  line(r.ok === false && r.error === answer, `${fn} exists and refuses a visitor itself`, r.ok === false ? r.error : `${r.code ?? ''} ${String(r.message ?? JSON.stringify(r)).slice(0, 90)}`)
}
for (const [fn, args, since] of CLOSED) {
  const r = await (await fetch(`${DB}/rest/v1/rpc/${fn}`, { method: 'POST', headers: visitor, body: JSON.stringify(args) })).json().catch(() => ({}))
  line(r.code === '42501', `${fn} exists and is closed to visitors`, r.code === '42501' ? since : `${since}: ${r.code ?? ''} ${String(r.message ?? JSON.stringify(r)).slice(0, 90)}`)
}
const col = async (table, column) => (await fetch(`${DB}/rest/v1/${table}?select=${column}&limit=1`, { headers: visitor })).json().catch(() => ({}))
let c = await col('bookings', 'push_reminded_30_at')
line(Array.isArray(c) && c.length === 0, 'bookings has the half-hour reminder column, and visitors see no rows', Array.isArray(c) ? 'v1.8' : `${c.code} ${c.message}`)
c = await col('client_directory', 'push_devices')
line(c.code === '42501', 'the client list has push_devices and is closed to visitors', c.code === '42501' ? 'v1.9' : `${c.code ?? ''} ${c.message ?? JSON.stringify(c).slice(0, 60)}`)
const settings = await (await fetch(`${DB}/rest/v1/studio_settings?select=cancel_cutoff_hours,purchase_requests_enabled`, { headers: visitor })).json().catch(() => [])
line(Array.isArray(settings) && settings.length === 1, 'studio settings', Array.isArray(settings) && settings[0]
  ? `cancel window ${settings[0].cancel_cutoff_hours} h, purchase requests ${settings[0].purchase_requests_enabled ? 'ON' : 'off'}` : JSON.stringify(settings).slice(0, 80))

// ---- the push function
const ping = (secret) => fetch(`${DB}/functions/v1/push`, { method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { 'x-webhook-secret': secret } : {}) }, body: '{"ping": true}' })
const noSecret = await ping(null)
line(noSecret.status === 403, 'the push function is up and refuses a caller without the secret', `HTTP ${noSecret.status}`)
// Optional: with the studio's own secret file on this machine, ask which channels are configured. Sends nothing to anybody.
const secretFile = process.env.RUDEEN_WEBHOOK_SECRET_FILE ?? `${homedir()}/Desktop/rudeen-push-setup/3 - webhook secret.txt`
if (existsSync(secretFile)) {
  const r = await (await ping(readFileSync(secretFile, 'utf8').trim())).json().catch(() => ({}))
  const t = r.transports ?? {}
  line(t.web === 'ok' && t.apns === 'ok', 'push channels', `website ${t.web ?? '?'}, iPhone ${t.apns ?? '?'}, Android ${/not_configured/.test(t.fcm ?? '') ? 'not set up' : t.fcm ?? '?'}`)
} else console.log('  --   push channels not checked (no secret file on this machine)')

console.log(bad ? `\n${bad} problem(s)` : '\nall good')
process.exit(bad ? 1 : 0)
