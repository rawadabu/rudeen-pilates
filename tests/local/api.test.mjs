// The app's main flows against the LOCAL TEST COPY: a real Supabase (database,
// API, sign-in) in Docker on this computer, loaded with this repo's SQL. A
// visitor, two clients and the admin act through the same library the app
// uses and sign in the way the app does. This is where real roles, real
// row-level security and the real extensions are checked; ../db imitates them.
import { test, before, after } from 'node:test'
import { dockerMissing, up, reset, down } from './stack.mjs'
import { load, isEmpty } from './load.mjs'
import { visitor, signIn, answer, PHONES } from './people.mjs'
import { checks } from '../lib/checks.mjs'

const noDocker = dockerMissing()
let s, db, applied
before(async () => {
  // Not a skip: a run that could not start must not read as a pass.
  if (noDocker) throw new Error(`${noDocker}. The local copy did not run, so nothing was checked.`)
  s = up()
  if (!(await isEmpty(s))) reset()   // a copy left running from an earlier look-around: start clean
  ;({ db, applied } = await load(s))
}, { timeout: 900_000 })
after(async () => {
  await db?.end()
  if (!noDocker && !process.env.KEEP_LOCAL) down()   // KEEP_LOCAL=1 leaves it running, to look around
})

test('the SQL loads into a real Supabase database as it did into live', async () => {
  const { ok, finish } = checks()
  const one = async (q) => (await db.query(q)).rows[0]
  ok(`setup, ${applied.length - 2} patches and the push setup were applied, in order`, applied[0] === 'supabase_setup.sql' && applied.at(-1) === 'supabase_push_setup.sql' && applied.length >= 13, applied.join(' '))
  ok('it is the real thing: Postgres 17 with pg_cron and pg_net installed', /^17\./.test((await one('show server_version')).server_version) && (await one("select count(*)::int n from pg_extension where extname in ('pg_cron', 'pg_net')")).n === 2)
  const jobs = (await db.query('select jobname, schedule from cron.job order by 1')).rows.map((j) => `${j.jobname} ${j.schedule}`).join(' | ')
  ok('the two scheduled jobs are registered with the real scheduler', jobs === 'class-reminders */5 * * * * | roll-classes-daily 0 3 * * *', jobs)
  const open = (await db.query("select proname from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute') order by 1")).rows.map((r) => r.proname).join()
  ok('with Supabase\'s real default rights, a visitor can call only the five functions left open on purpose', open === 'handle_new_user,is_admin,push_webhook,studio_now,studio_today', open)
  ok('the seeded timetable was generated', (await one('select count(*)::int n from public.classes')).n > 10)
  ok('no function in the copy points at a real Supabase project', (await one("select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and prosrc ~ 'supabase\\.co'")).n === 0)
  finish()
})

test('a visitor, two clients and the admin, through the real API', async () => {
  const { ok, finish } = checks()
  const ZERO = '00000000-0000-0000-0000-000000000000'

  // ---- a visitor: only the site's public key
  const v = visitor(s)
  const timetable = (await v.from('class_availability').select('id, class_date, start_time').order('class_date', { ascending: false }).order('start_time')).data ?? []
  ok('visitor: sees the timetable, the plans and the studio settings', timetable.length > 10 && (await v.from('plans').select('name')).data?.length > 0 && (await v.from('studio_settings').select('cancel_cutoff_hours')).data?.[0]?.cancel_cutoff_hours === 12)
  ok('visitor: sees no profile, booking, subscription or notification', (await Promise.all(['profiles', 'bookings', 'credit_packs', 'notifications', 'push_subscriptions', 'health_forms'].map(async (t) => (await v.from(t).select('*')).data?.length ?? -1))).every((n) => n === 0))
  ok('visitor: the client list is closed', answer(await v.from('client_directory').select('id')).refused === '42501')
  const refused = async (c, fn, args) => answer(await c.rpc(fn, args)).refused
  ok('visitor: booking, admin actions and the internal functions are refused by the API (42501)',
    await refused(v, 'book_class', { p_class_id: ZERO }) === '42501' && await refused(v, 'admin_grant_pack', { p_user_id: ZERO, p_sessions: 1 }) === '42501'
    && await refused(v, 'admin_cancel_day', { p_date: '2030-01-01' }) === '42501' && await refused(v, 'push_send', { p_body: {} }) === '42501' && await refused(v, 'send_class_reminders') === '42501')

  // ---- sign in the way the app does (a code by SMS; here the test code)
  const A = await signIn(s, PHONES.a), B = await signIn(s, PHONES.b), ADMIN = await signIn(s, PHONES.admin)
  await db.query('update public.profiles set is_admin = true where id = $1', [ADMIN.id])   // as supabase_admins.sql does on live
  const profiles = (await db.query('select phone, is_admin from public.profiles order by phone')).rows
  ok('signing in for the first time creates the profile', profiles.length === 3 && profiles.filter((p) => p.is_admin).length === 1, JSON.stringify(profiles))
  ok('a client sees her own profile only', (await A.client.from('profiles').select('phone')).data?.length === 1)

  // ---- client A
  const cls = timetable[0]   // the furthest day in the timetable
  let r = answer(await A.client.rpc('book_class', { p_class_id: cls.id }))
  ok('A cannot book before the health declaration', r.ok === false && r.error === 'health_form_required', JSON.stringify(r))
  r = answer(await A.client.rpc('submit_health_form', { p_answers: {}, p_flags: [], p_consent_name: 'Client A', p_signature_png: 'data:image/png;base64,iVBORw0KGgo=', p_lang: 'ar' }))
  ok('A signs the health declaration', r.ok === true, JSON.stringify(r))
  r = answer(await A.client.rpc('book_class', { p_class_id: cls.id }))
  ok('A cannot book without a subscription', r.ok === false && r.error === 'no_credits', JSON.stringify(r))
  r = answer(await A.client.rpc('admin_grant_pack', { p_user_id: A.id, p_sessions: 8, p_months: 1, p_price: 300, p_note: null }))
  ok('A cannot open herself a subscription (the function answers not_admin)', r.ok === false && r.error === 'not_admin', JSON.stringify(r))

  // ---- the admin
  r = answer(await ADMIN.client.rpc('admin_grant_pack', { p_user_id: A.id, p_sessions: 8, p_months: 1, p_price: 300, p_note: null }))
  ok('admin opens A a subscription of 8', r.ok === true && !!r.pack_id, JSON.stringify(r))
  r = answer(await A.client.rpc('book_class', { p_class_id: cls.id }))
  ok('A books a class', r.ok === true && !!r.booking_id, JSON.stringify(r))
  ok('A sees 7 of 8 left, and her booking', (await A.client.from('pack_balance').select('remaining')).data?.[0]?.remaining === 7 && (await A.client.from('bookings').select('status')).data?.length === 1)
  ok('B sees none of A\'s subscription, booking or notices', (await B.client.from('pack_balance').select('id')).data?.length === 0 && (await B.client.from('bookings').select('id')).data?.length === 0 && (await B.client.from('notifications').select('id')).data?.length === 0)
  const own = (await A.client.from('client_directory').select('phone')).data ?? []
  ok('a client who asks for the client list gets only herself', own.length === 1 && own[0].phone.endsWith('500000002'), JSON.stringify(own))

  r = answer(await A.client.rpc('save_push_subscription', { p_endpoint: 'apns:local-test-token', p_kind: 'apns', p_p256dh: null, p_auth: null, p_lang: 'ar' }))
  ok('A turns notifications on', r.ok === true, JSON.stringify(r))
  const list = (await ADMIN.client.from('client_directory').select('phone, is_admin, active_remaining, push_devices').order('phone')).data ?? []
  ok('admin: the client list shows everybody, A with 7 sessions and notifications on', list.length === 3 && list.find((c) => c.phone.endsWith('500000002'))?.active_remaining === 7 && list.find((c) => c.phone.endsWith('500000002'))?.push_devices === 1 && list.find((c) => c.phone.endsWith('500000003'))?.push_devices === 0, JSON.stringify(list))
  ok('B cannot ask how many phones A has', (await B.client.rpc('push_device_count', { p_user: A.id })).data === null)

  r = answer(await A.client.rpc('admin_cancel_day', { p_date: cls.class_date }))
  ok('A cannot cancel a day (not_admin)', r.ok === false && r.error === 'not_admin', JSON.stringify(r))
  r = answer(await ADMIN.client.rpc('admin_cancel_day', { p_date: cls.class_date }))
  ok('admin cancels that day: A\'s booking is handed back', r.ok === true && r.classes >= 1 && r.bookings === 1, JSON.stringify(r))
  ok('A has 8 again and was told', (await A.client.from('pack_balance').select('remaining')).data?.[0]?.remaining === 8 && ((await A.client.from('notifications').select('kind')).data ?? []).some((n) => n.kind === 'class_cancelled'))
  ok('the day is gone from the timetable a visitor sees', ((await v.from('class_availability').select('id').eq('class_date', cls.class_date)).data ?? []).length === 0)

  // ---- things no signed-in user may do either
  ok('even signed in, nobody runs the reminder job or the push sender by hand', await refused(A.client, 'send_class_reminders') === '42501' && await refused(ADMIN.client, 'push_send', { p_body: {} }) === '42501' && await refused(ADMIN.client, 'cancel_class_refund', { p_class_id: ZERO }) === '42501')
  ok('the database itself can (as the scheduler does)', (await db.query('select public.send_class_reminders() n')).rows[0].n === 0)
  ok('the triggers handed their pushes to the real pg_net (aimed at a dead local address)', (await db.query('select ((select count(*) from net.http_request_queue) + (select count(*) from net._http_response))::int n')).rows[0].n >= 2)
  finish()
})
