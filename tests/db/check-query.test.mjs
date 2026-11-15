// supabase_check_reminders.sql — the read-only query the studio pastes into
// the SQL Editor when a reminder did not arrive. It must run, read well, show
// no names or phone numbers, and change nothing.
import { test } from 'node:test'
import { fresh, read } from '../lib/harness.mjs'
import { checks } from '../lib/checks.mjs'

test('the "why did a reminder not arrive" check', async () => {
  const { ok, finish } = checks()
  const { db, q, one, mkUser, pack, book, guest } = await fresh()
  const check = read('supabase_check_reminders.sql')
  let rows = await q(check)
  const val = (w) => rows.filter((r) => r.what === w).map((r) => r.value)
  ok('runs on a database with no activity', rows.length >= 7, JSON.stringify(rows))
  ok('job: scheduled and active', val('reminder job')[0] === '*/5 * * * * · active', val('reminder job')[0])
  ok('function: two reminders', val('reminder function')[0] === 'two reminders (v1.8)', val('reminder function')[0])
  ok('nothing sent yet', val('1h reminders sent')[0] === '0 · last never' && val('30m reminders sent')[0] === '0 · last never')

  const a = await mkUser('+972500000002'), b = await mkUser('+972500000003'), late = await mkUser('+972500000004')
  const pa = await pack(a), pb = await pack(b), pl = await pack(late)
  const cls = async (mins) => (await one(`insert into public.classes (class_date, start_time, capacity) select (public.studio_now() + make_interval(mins => $1))::date, date_trunc('minute', public.studio_now() + make_interval(mins => $1))::time, 8 returning id`, [mins])).id
  const c = await cls(55), past = await cls(-300)
  await book(c, a, pa); await book(c, b, pb); await book(c, late, pl, { ageMin: 1 }); await guest(c)
  await book(past, a, pa, { status: 'attended', ageMin: 2880 }); await guest(past, 'Guest2')
  await db.query(`insert into public.push_subscriptions (user_id, endpoint, kind, lang) values ($1, 'apns:tok', 'apns', 'ar'), ($1, 'https://w/x', 'web', 'ar')`, [a])
  const n = (await one('select public.send_class_reminders() n')).n
  await db.exec(`insert into cron.job_run_details (jobid, status, return_message, start_time) select jobid, 'succeeded', '1 row', now() from cron.job where jobname = 'class-reminders';
    insert into cron.job_run_details (jobid, status, return_message, start_time) select jobid, 'failed', 'ERROR: something broke', now() - interval '5 minutes' from cron.job where jobname = 'class-reminders';
    insert into net._http_response (id, status_code, content) values (1, 200, '{"sent":1,"pruned":0}');
    insert into net._http_response (id, status_code, content, error_msg, created) values (2, null, null, 'Timeout was reached', now() - interval '1 minute');`)
  rows = await q(check)
  ok('reminders handed over: 2 (the one who just booked is skipped)', n === 2, n)
  ok('upcoming class: acct 3 · hand 1 · phone 1 · late 1 · 1h 2 · 30m 0', val('class').some((v) => /acct 3 · hand 1 · phone 1 · late 1 · 1h 2 · 30m 0$/.test(v)), JSON.stringify(val('class')))
  ok('a past class with an attended booking still counts as an account booking', val('class').some((v) => /acct 1 · hand 1 · phone 1 · late 0 · 1h 0 · 30m 0$/.test(v)), JSON.stringify(val('class')))
  ok('each reminder is listed with that person\'s phones', val('reminder').length === 2 && val('reminder').some((v) => v.endsWith('phones 2 (apns, web)')) && val('reminder').some((v) => v.endsWith('phones 0')), JSON.stringify(val('reminder')))
  ok('job runs newest first, a failure is visible', val('job run')[0].includes('succeeded') && val('job run')[1].includes('failed') && val('job runs, last 24 hours')[0] === '2 runs · 1 not succeeded')
  ok('push answers newest first, a timeout is readable', val('push answer')[0].includes('200') && val('push answer')[1].includes('no answer · Timeout'))
  ok('rows are short enough to read in the editor', rows.filter((r) => !['push answer', 'job run'].includes(r.what)).every((r) => r.value.length <= 78), Math.max(...rows.map((r) => r.value.length)))
  ok('no phone numbers or names in the result', !rows.some((r) => /\+9725|Guest/.test(r.value)))
  const snap = async () => JSON.stringify(await q('select id, status, push_reminded_at, push_reminded_30_at from public.bookings order by id'))
  const before = await snap(); await q(check)
  ok('running the check changes nothing', before === await snap())
  await db.close()
  finish()
})
