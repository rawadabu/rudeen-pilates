// v1.6 + v1.8 — two push reminders before a class: an hour before and half an
// hour before. A job runs every 5 minutes; each booking gets each reminder once.
// The test moves the studio clock through an hour.
import { test } from 'node:test'
import { fresh } from '../lib/harness.mjs'
import { checks } from '../lib/checks.mjs'

const D = '2026-11-12'

test('an hour before and half an hour before, once each', async () => {
  const { ok, finish } = checks()
  const { db, q, one, mkUser, pack, cls, book, guest, priv, at } = await fresh()
  await at(`${D} 12:00`)
  const a = await mkUser('+972500000002'), b = await mkUser('+972500000003'), c = await mkUser('+972500000004')
  const pa = await pack(a), pb = await pack(b), pc = await pack(c)
  const c1215 = await cls(D, '12:15'), c1225 = await cls(D, '12:25'), c1230 = await cls(D, '12:30', 'cancelled'), c1255 = await cls(D, '12:55'), c1310 = await cls(D, '13:10')
  const x1215 = await book(c1215, a, pa)                       // 15 min away: too late for both
  const x1225 = await book(c1225, a, pa)                       // 25 min away: half-hour reminder
  const x1230 = await book(c1230, a, pa)                       // the class is cancelled
  const xA = await book(c1255, a, pa), xB = await book(c1255, b, pb)   // 55 min away: hour reminder
  const xC = await book(c1255, c, pc, { ageMin: 1 })           // booked a minute ago
  const xGone = await book(c1255, c, pc, { status: 'cancelled' })
  await guest(c1255)
  const x1310 = await book(c1310, a, pa)                       // 70 min away: not yet
  await db.exec('delete from net.calls')   // the "new booking" pushes the inserts above fired

  const run = async () => (await one('select public.send_class_reminders() n')).n
  const calls = async () => (await q("select body->>'booking_id' id, (body->>'minutes')::int mins from net.calls where body->>'event' = 'class_reminder' order by id")).map((x) => `${x.id}:${x.mins}`)
  const key = (id, m) => `${id}:${m}`
  const flags = async (id) => { const r = await one('select push_reminded_at is not null h, push_reminded_30_at is not null m from public.bookings where id = $1', [id]); return `${r.h ? 'H' : '-'}${r.m ? 'M' : '-'}` }

  let n = await run(), got = await calls()
  ok('12:00 — three reminders', n === 3 && got.length === 3, `${n} ${JSON.stringify(got)}`)
  ok('12:00 — the 12:55 class: A and B get the hour reminder', got.includes(key(xA, 60)) && got.includes(key(xB, 60)))
  ok('12:00 — the 12:25 class: A gets the half-hour reminder', got.includes(key(x1225, 30)))
  ok('12:00 — marked in the right column each', await flags(xA) === 'H-' && await flags(xB) === 'H-' && await flags(x1225) === '-M', `${await flags(xA)} ${await flags(xB)} ${await flags(x1225)}`)
  ok('12:00 — nothing for: 15 min away, 70 min away, cancelled class, cancelled booking, just booked, guest', [x1215, x1310, x1230, xGone, xC].every((id) => !got.some((g) => g.startsWith(id))))
  ok('12:00 — running again sends nothing', await run() === 0 && (await calls()).length === 3)

  await at('12:05'); n = await run()
  ok('12:05 — nothing new', n === 0 && (await calls()).length === 3, n)
  await at('12:10'); n = await run(); got = await calls()
  ok('12:10 — the 13:10 class gets its hour reminder, exactly 60 minutes before', n === 1 && got.includes(key(x1310, 60)), `${n} ${JSON.stringify(got.slice(3))}`)

  await db.query(`update public.bookings set created_at = now() - interval '40 minutes' where id = $1`, [xC])
  await at('12:25'); n = await run(); got = await calls()
  ok('12:25 — the 12:55 class: A, B and C get the half-hour reminder, exactly 30 minutes before', n === 3 && [xA, xB, xC].every((id) => got.includes(key(id, 30))), `${n} ${JSON.stringify(got.slice(4))}`)
  ok('12:25 — A and B have both; C only the half-hour one (she booked inside the hour)', await flags(xA) === 'HM' && await flags(xB) === 'HM' && await flags(xC) === '-M', `${await flags(xA)} ${await flags(xB)} ${await flags(xC)}`)
  await at('12:30'); n = await run()
  ok('12:30 — nothing new (second look at the same window)', n === 0, n)
  await at('12:40'); n = await run(); got = await calls()
  ok('12:40 — the 13:10 class gets its half-hour reminder', n === 1 && got.includes(key(x1310, 30)) && await flags(x1310) === 'HM', `${n} ${JSON.stringify(got.slice(7))}`)
  for (const t of ['12:45', '12:50', '12:55', '13:00', '13:05', '13:10', '13:15']) { await at(t); await run() }
  got = await calls()
  ok('the rest of the hour: nothing more', got.length === 8, JSON.stringify(got))
  ok('no booking ever got the same reminder twice', new Set(got).size === got.length)
  ok('every call carries minutes 60 or 30', got.every((g) => /^[0-9a-f-]{36}:(60|30)$/.test(g)), JSON.stringify(got))

  // a class cancelled between the two reminders
  await db.exec('delete from net.calls')
  await at('15:00'); const c1600 = await cls(D, '16:00'); const xLate = await book(c1600, b, pb)
  await db.exec('delete from net.calls')
  n = await run()
  ok('15:00 — hour reminder for the 16:00 class', n === 1 && (await calls()).includes(key(xLate, 60)))
  await db.query(`update public.classes set status = 'cancelled' where id = $1`, [c1600])
  await at('15:30'); n = await run()
  ok('15:30 — the class was cancelled in between: no half-hour reminder', n === 0 && (await calls()).length === 1, n)

  ok('visitors and signed-in users cannot run the job', await priv('anon', 'public.send_class_reminders()') === false && await priv('authenticated', 'public.send_class_reminders()') === false)
  ok('one job, every 5 minutes', (await q("select schedule from cron.job where jobname = 'class-reminders'")).map((x) => x.schedule).join() === '*/5 * * * *')
  await db.close()
  finish()
})

test('without the push setup the job sends nothing and marks nothing', async () => {
  const { ok, finish } = checks()
  const { db, one, mkUser, pack, cls, book, at } = await fresh({ push: false })
  await at(`${D} 12:00`)
  const a = await mkUser('+972500000002'), pa = await pack(a)
  const x = await book(await cls(D, '12:55'), a, pa)
  ok('0 sent, nothing marked', (await one('select public.send_class_reminders() n')).n === 0
    && (await one('select count(*)::int n from net.calls')).n === 0
    && (await one('select push_reminded_at v from public.bookings where id = $1', [x])).v === null)
  await db.close()
  finish()
})
