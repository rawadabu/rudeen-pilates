// v1.10 — the studio can correct a subscription or remove one opened by
// mistake. Before this, "correcting" by pressing the open form again opened
// one more each time: a client ended up with 5 + 8 + 5 = 18 sessions.
import { test } from 'node:test'
import { fresh } from '../lib/harness.mjs'
import { checks } from '../lib/checks.mjs'

test('fix or remove a subscription', async () => {
  const { ok, finish } = checks()
  const { db, one, as, mkUser, cls, rpc, priv, at } = await fresh()
  await at('2026-11-14 12:00')
  const admin = await mkUser('+972500000001', { admin: true }), a = await mkUser('+972500000002'), b = await mkUser('+972500000003')
  const total = async (uid) => (await one('select coalesce(sum(remaining), 0)::int n from public.pack_balance where user_id = $1 and is_active', [uid])).n

  // the real story: three presses of the open form = three subscriptions
  await as(admin)
  const grant = async (uid, n, price) => (await rpc('admin_grant_pack', uid, n, 1, price, null)).pack_id
  const p1 = await grant(a, 5, 300), p2 = await grant(a, 8, 350), p3 = await grant(a, 5, 300)
  ok('before: three subscriptions, 18 sessions', await total(a) === 18, await total(a))
  const notes0 = (await one("select count(*)::int n from public.notifications where kind = 'pack_granted'")).n
  await db.exec('delete from net.calls')

  await as(a)
  let r = await rpc('admin_update_pack', p1, 8, '2026-12-13', 350, null)
  ok('a client cannot correct a subscription', r.ok === false && r.error === 'not_admin', JSON.stringify(r))
  r = await rpc('admin_delete_pack', p3)
  ok('a client cannot remove one', r.ok === false && r.error === 'not_admin', JSON.stringify(r))
  await as(null)
  r = await rpc('admin_delete_pack', p3)
  ok('signed out cannot either', r.error === 'not_admin')
  const U = 'public.admin_update_pack(uuid, int, date, numeric, text)', X = 'public.admin_delete_pack(uuid)'
  ok('visitors cannot call the two functions; signed-in users reach them', !(await priv('anon', U)) && !(await priv('anon', X)) && await priv('authenticated', U) && await priv('authenticated', X))
  ok('pack_used is for the database only', !(await priv('anon', 'public.pack_used(uuid)')) && !(await priv('authenticated', 'public.pack_used(uuid)')))
  ok('the refused calls changed nothing', await total(a) === 18)

  await as(admin)
  r = await rpc('admin_delete_pack', p1)
  ok('remove a subscription opened by mistake', r.ok === true, JSON.stringify(r))
  r = await rpc('admin_delete_pack', p3)
  ok('remove the second one: 8 sessions left', r.ok === true && await total(a) === 8, `${JSON.stringify(r)} total ${await total(a)}`)
  r = await rpc('admin_delete_pack', p3)
  ok('removing it again: not found', r.ok === false && r.error === 'pack_not_found', JSON.stringify(r))
  r = await rpc('admin_update_pack', p2, 8, '2026-12-13', 300, '  cash  ')
  let row = await one('select sessions_total, valid_until::text u, price_ils::float p, note from public.credit_packs where id = $1', [p2])
  ok('correct the price 350 -> 300, the note is trimmed', r.ok === true && row.sessions_total === 8 && row.p === 300 && row.note === 'cash' && row.u === '2026-12-13', JSON.stringify(row))
  r = await rpc('admin_update_pack', p2, 10, '2027-01-15', null, null)
  row = await one('select sessions_total, valid_until::text u, price_ils, note from public.credit_packs where id = $1', [p2])
  ok('more sessions, a later end date, price and note cleared', r.ok === true && row.sessions_total === 10 && row.u === '2027-01-15' && row.price_ils === null && row.note === null && await total(a) === 10, JSON.stringify(row))
  ok('a correction tells the client nothing (no notice, no push)', (await one("select count(*)::int n from public.notifications where kind = 'pack_granted'")).n === notes0 && (await one('select count(*)::int n from net.calls')).n === 0)

  for (const [name, args, err] of [
    ['0 sessions', [p2, 0, '2026-12-13', null], 'invalid_sessions'], ['61 sessions', [p2, 61, '2026-12-13', null], 'invalid_sessions'],
    ['no date', [p2, 8, null, null], 'invalid_date'], ['end before the start', [p2, 8, '2026-11-01', null], 'invalid_date'],
    ['negative price', [p2, 8, '2026-12-13', -5], 'invalid_price'], ['absurd price', [p2, 8, '2026-12-13', 1000000], 'invalid_price'],
    ['unknown subscription', ['00000000-0000-0000-0000-000000000000', 8, '2026-12-13', null], 'pack_not_found'],
  ]) {
    r = await rpc('admin_update_pack', ...args, null)
    ok(`refused: ${name}`, r.ok === false && r.error === err, JSON.stringify(r))
  }
  row = await one('select sessions_total, valid_until::text u from public.credit_packs where id = $1', [p2])
  ok('refused input changed nothing', row.sessions_total === 10 && row.u === '2027-01-15', JSON.stringify(row))

  // a subscription that is in use
  const c1 = await cls('2026-11-16', '18:00'), c2 = await cls('2026-11-17', '18:00'), c3 = await cls('2026-11-18', '18:00')
  await as(a)
  const b1 = await rpc('book_class', c1), b2 = await rpc('book_class', c2), b3 = await rpc('book_class', c3)
  ok('the client books three classes on it', b1.ok && b2.ok && b3.ok && await total(a) === 7, JSON.stringify([b1, b2, b3]))
  r = await rpc('cancel_my_booking', b3.booking_id)
  ok('and cancels one early: the session comes back', r.ok === true && r.refunded === true && await total(a) === 8, JSON.stringify(r))
  await as(admin)
  r = await rpc('admin_update_pack', p2, 1, '2027-01-15', null, null)
  ok('sessions cannot go below what was used (2)', r.ok === false && r.error === 'sessions_below_used' && r.taken === 2, JSON.stringify(r))
  r = await rpc('admin_update_pack', p2, 2, '2027-01-15', null, null)
  ok('down to exactly what was used is allowed: 0 left', r.ok === true && await total(a) === 0, `${JSON.stringify(r)} ${await total(a)}`)
  r = await rpc('admin_delete_pack', p2)
  ok('a used subscription cannot be removed', r.ok === false && r.error === 'pack_in_use' && r.taken === 2, JSON.stringify(r))
  ok('her two bookings still stand, on their subscription', (await one("select count(*)::int n from public.bookings where pack_id = $1 and status = 'booked' and consumes_credit", [p2])).n === 2)

  const p4 = await grant(b, 4, 200)
  await as(b); const bb = await rpc('book_class', c1)
  await rpc('cancel_my_booking', bb.booking_id)
  await as(admin); r = await rpc('admin_delete_pack', p4)
  const hist = await one('select status, pack_id, consumes_credit from public.bookings where id = $1', [bb.booking_id])
  ok('one with only a handed-back booking can go; the cancelled booking stays as history', r.ok === true && hist.status === 'cancelled' && hist.pack_id === null && hist.consumes_credit === false, `${JSON.stringify(r)} ${JSON.stringify(hist)}`)
  ok('the other client is untouched', await total(a) === 0 && (await one('select count(*)::int n from public.credit_packs where user_id = $1', [a])).n === 1)
  await db.close()
  finish()
})
