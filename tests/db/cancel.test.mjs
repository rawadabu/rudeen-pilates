// v1.7 — the studio cancels one class, or a whole day (the trainer is ill).
// Everyone booked gets the session back and one notice; classes that already
// started are left alone; the trainer is not pushed about her own cancellation.
import { test } from 'node:test'
import { fresh } from '../lib/harness.mjs'
import { checks } from '../lib/checks.mjs'

const D = '2026-11-12', D1 = '2026-11-13', D2 = '2026-11-14'

for (const push of [true, false]) {
  test(`cancel a class and a whole day (${push ? 'push set up' : 'no push'})`, async () => {
    const { ok, finish } = checks()
    const { db, q, one, as, mkUser, pack, left, cls, book, guest, rpc, priv, sent, at } = await fresh({ push })
    await at(`${D} 12:00`)
    const admin = await mkUser('+972500000001', { admin: true }), a = await mkUser('+972500000002'), b = await mkUser('+972500000003')
    const pa = await pack(a, 8), pb = await pack(b, 4)
    const c0900 = await cls(D, '09:00'), c1255 = await cls(D, '12:55'), c1300 = await cls(D, '13:00'), c1800 = await cls(D, '18:00'), c2000 = await cls(D, '20:00')
    const cOld = await cls(D, '16:00', 'cancelled'), cNext = await cls(D1, '10:00'), cLater = await cls(D2, '10:00')
    const b0900 = await book(c0900, a, pa)
    await book(c1255, b, pb)
    await book(c1300, a, pa); await book(c1300, b, pb)
    await book(c1800, a, pa); await guest(c1800)
    await book(cOld, a, pa, { status: 'cancelled' })
    await book(cNext, b, pb)
    const bLaterA = await book(cLater, a, pa), bLaterB = await book(cLater, b, pb)
    ok('before: A has 4 of 8 left, B has 0 of 4', await left(pa) === 4 && await left(pb) === 0, `${await left(pa)} / ${await left(pb)}`)

    ok('visitors cannot call admin_cancel_day; signed-in users reach it', await priv('anon', 'public.admin_cancel_day(date)') === false && await priv('authenticated', 'public.admin_cancel_day(date)') === true)
    ok('only the database calls cancel_class_refund', await priv('anon', 'public.cancel_class_refund(uuid)') === false && await priv('authenticated', 'public.cancel_class_refund(uuid)') === false)
    await as(a)
    let r = await rpc('admin_cancel_day', D)
    ok('a client is refused', r.ok === false && r.error === 'not_admin', JSON.stringify(r))
    await as(null)
    r = await rpc('admin_cancel_day', D)
    ok('signed out is refused', r.ok === false && r.error === 'not_admin', JSON.stringify(r))
    ok('the refused calls changed nothing', (await one("select count(*)::int n from public.classes where status = 'cancelled'")).n === 1)

    await db.exec('delete from net.calls')
    await as(admin)
    r = await rpc('admin_cancel_day', D)
    ok('the day: 4 classes not started, 5 bookings handed back', r.ok === true && r.classes === 4 && r.bookings === 5, JSON.stringify(r))
    const st = async (id) => (await one('select status from public.classes where id = $1', [id])).status
    ok('12:55, 13:00, 18:00 and 20:00 are cancelled', (await Promise.all([c1255, c1300, c1800, c2000].map(st))).every((s) => s === 'cancelled'))
    ok('09:00 had started: still open, its booking and its session stay', await st(c0900) === 'open' && (await one('select status from public.bookings where id = $1', [b0900])).status === 'booked')
    ok('other days are untouched', await st(cNext) === 'open' && await st(cLater) === 'open' && (await one("select count(*)::int n from public.bookings where class_id in ($1, $2) and status = 'booked'", [cNext, cLater])).n === 3)
    ok('A: 4 -> 6 (two back, 09:00 stays used)', await left(pa) === 6, await left(pa))
    ok('B: 0 -> 2', await left(pb) === 2, await left(pb))
    const notes = await q("select user_id, data from public.notifications where kind = 'class_cancelled'")
    ok('one notice per cancelled booking of a client (A 2, B 2), none for the guest', notes.length === 4 && notes.filter((n) => n.user_id === a).length === 2 && notes.filter((n) => n.user_id === b).length === 2 && notes.every((n) => n.data.refunded === true), JSON.stringify(notes.map((n) => n.data)))
    ok('each notice names its own class time', notes.map((n) => n.data.start_time).sort().join() === '12:55:00,13:00:00,13:00:00,18:00:00', notes.map((n) => n.data.start_time).sort().join())
    if (push) {
      ok('push: 4 to the clients', await sent('notification') === 4, await sent('notification'))
      ok('push: none to the trainer about her own cancellation', await sent('booking_cancelled') === 0, await sent('booking_cancelled'))
      ok('no reminder goes out for the cancelled 12:55 class', (await one('select public.send_class_reminders() n')).n === 0 && await sent('class_reminder') === 0)
    } else {
      ok('without push nothing is called', (await one('select count(*)::int n from net.calls')).n === 0)
    }

    r = await rpc('admin_cancel_day', D)
    ok('a second press: nothing left to cancel, balances unchanged', r.ok === false && r.error === 'no_classes_to_cancel' && await left(pa) === 6 && await left(pb) === 2, JSON.stringify(r))
    r = await rpc('admin_cancel_day', '2026-11-11')
    ok('a past day: nothing to cancel', r.error === 'no_classes_to_cancel', JSON.stringify(r))
    r = await rpc('admin_cancel_day', null)
    ok('no date: refused', r.error === 'invalid_input', JSON.stringify(r))
    await as(a)
    r = await rpc('book_class', c1800)
    ok('a cancelled class cannot be booked', r.ok === false, JSON.stringify(r))

    // one class, the older button
    await db.exec('delete from net.calls'); await as(admin)
    r = await rpc('admin_cancel_class', cNext)
    ok('cancel one class: 1 handed back', r.ok === true && r.refunded === 1 && await left(pb) === 3 && await st(cNext) === 'cancelled', JSON.stringify(r))
    r = await rpc('admin_cancel_class', '00000000-0000-0000-0000-000000000000')
    ok('unknown class: class_not_found', r.ok === false && r.error === 'class_not_found', JSON.stringify(r))
    r = await rpc('admin_cancel_class', cNext)
    ok('the same class twice: nothing more handed back', r.ok === true && r.refunded === 0 && await left(pb) === 3, JSON.stringify(r))
    await as(a)
    r = await rpc('admin_cancel_class', cLater)
    ok('a client cannot cancel a class', r.ok === false && r.error === 'not_admin', JSON.stringify(r))
    if (push) {
      ok('one class: 1 push to the client, none to the trainer', await sent('notification') === 1 && await sent('booking_cancelled') === 0, `${await sent('notification')} / ${await sent('booking_cancelled')}`)
      // a client cancelling, and the trainer removing one person, still tell the trainer
      await db.exec('delete from net.calls'); await as(a)
      r = await rpc('cancel_my_booking', bLaterA)
      ok('a client cancels her own booking', r.ok === true, JSON.stringify(r))
      ok('the trainer is still told when a client cancels', await sent('booking_cancelled') === 1, await sent('booking_cancelled'))
      await db.exec('delete from net.calls'); await as(admin)
      r = await rpc('admin_cancel_booking', bLaterB, true)
      ok('removing one person from an open class still tells the trainer', r.ok === true && await sent('booking_cancelled') === 1, JSON.stringify(r))
    }
    await db.close()
    finish()
  })
}

test('the 12-hour rule when a client cancels', async () => {
  const { ok, finish } = checks()
  const { db, one, as, mkUser, pack, left, cls, book, rpc, at } = await fresh()
  await at(`${D} 11:00`)
  const a = await mkUser('+972500000002'), pa = await pack(a, 8)
  ok('the studio setting is 12 hours', (await one('select cancel_cutoff_hours h from public.studio_settings')).h === 12)
  const soon = await cls(D, '18:00'), far = await cls(D1, '18:00')
  const b1 = await book(soon, a, pa, { ageMin: 2 }), b2 = await book(far, a, pa, { ageMin: 2 })
  ok('two bookings: 6 of 8 left', await left(pa) === 6, await left(pa))
  await as(a)
  let r = await rpc('cancel_my_booking', b1)
  ok('class in 7 hours, cancelled 2 minutes after booking: the session is lost', r.ok === true && r.refunded === false && await left(pa) === 6, `${JSON.stringify(r)} left ${await left(pa)}`)
  r = await rpc('cancel_my_booking', b2)
  ok('class tomorrow evening: the session comes back', r.ok === true && r.refunded === true && await left(pa) === 7, `${JSON.stringify(r)} left ${await left(pa)}`)
  await db.close()
  finish()
})
