// Patch v1.11 closes the older admin and account functions to visitors.
// It changes who may CALL a function and nothing else, so the proof is a
// before / after: the same database with and without the patch, and the app's
// three kinds of caller acting through their real database roles —
//   a visitor            role anon           (holds only the site's public key)
//   a signed-in client   role authenticated  (their own account)
//   the studio's admin   role authenticated  (an account marked is_admin)
import { test } from 'node:test'
import { fresh, read, strip } from '../lib/harness.mjs'
import { checks } from '../lib/checks.mjs'

const ADMIN_FNS = ['admin_add_class', 'admin_book_client', 'admin_book_guest', 'admin_cancel_booking', 'admin_cancel_class',
  'admin_decide_purchase', 'admin_grant_pack', 'admin_save_template', 'admin_set_attendance', 'admin_update_class']
const ACCOUNT_FNS = ['book_class', 'cancel_my_booking', 'cancel_purchase_request', 'delete_my_account', 'delete_push_subscription',
  'request_purchase', 'save_push_subscription', 'submit_health_form']
const CLOSED = [...ADMIN_FNS, ...ACCOUNT_FNS].sort()

const rights = (q, role) => q(`select p.proname n, has_function_privilege($1, p.oid, 'execute') x from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`, [role])
const relations = (q) => q(`select c.relname n from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v') order by 1`)

test('v1.11 changes only who may call the older functions', async () => {
  const { ok, finish } = checks()
  const before = await fresh({ sql: 'patches', upTo: 'v1_10' }), after = await fresh({ sql: 'patches' })
  for (const role of ['authenticated', 'service_role']) {
    const [a, b] = [await rights(before.q, role), await rights(after.q, role)]
    const lost = a.filter((f) => f.x && !b.find((g) => g.n === f.n)?.x).map((f) => f.n)
    ok(`${role}: can call everything it could before (${b.filter((f) => f.x).length} functions)`, lost.length === 0, 'lost: ' + lost.join(', '))
    const gained = b.filter((f) => f.x && !a.find((g) => g.n === f.n)?.x).map((f) => f.n)
    ok(`${role}: and nothing it could not`, gained.length === 0, 'gained: ' + gained.join(', '))
  }
  const [a, b] = [await rights(before.q, 'anon'), await rights(after.q, 'anon')]
  const closedNow = a.filter((f) => f.x && !b.find((g) => g.n === f.n)?.x).map((f) => f.n).sort()
  ok('visitors: lost exactly the 10 admin and 8 account functions', JSON.stringify(closedNow) === JSON.stringify(CLOSED), closedNow.join(', '))
  ok('visitors: gained nothing', b.filter((f) => f.x && !a.find((g) => g.n === f.n)?.x).length === 0)
  ok('visitors: 5 functions left, the helpers and the trigger functions', b.filter((f) => f.x).map((f) => f.n).sort().join() === 'handle_new_user,is_admin,push_webhook,studio_now,studio_today', b.filter((f) => f.x).map((f) => f.n).join())

  // what each kind of caller can READ must be exactly what it was
  for (const db of [before, after]) {
    db.admin = await db.mkUser('+972500000001', { admin: true }); db.client = await db.mkUser('+972500000002')
  }
  for (const [who, role, key] of [['a visitor', 'anon', null], ['a signed-in client', 'authenticated', 'client'], ['the admin', 'authenticated', 'admin']]) {
    const read = async (db) => db.asRole(role, key ? db[key] : null, async () => {
      const out = []
      for (const r of await relations(db.q)) if (await db.canRead(r.n)) out.push(r.n)
      return out
    })
    const [x, y] = [await read(before), await read(after)]
    ok(`${who} can read the same tables and views as before (${y.length})`, JSON.stringify(x) === JSON.stringify(y) && y.length > 0, `before ${x.join()} | after ${y.join()}`)
  }
  await before.db.close(); await after.db.close()
  finish()
})

test('after v1.11: a visitor is refused by the database, clients and the admin work as before', async () => {
  const { ok, finish } = checks()
  const { db, q, one, mkUser, pack, left, cls, rpc, asRole, canRead, code, at } = await fresh({ sql: 'patches' })
  await at('2026-11-16 10:00')
  const admin = await mkUser('+972500000001', { admin: true }), client = await mkUser('+972500000002')
  const pk = await pack(client, 8), c1 = await cls('2026-11-18', '18:00')
  const plan = (await one("insert into public.plans (name, sessions, valid_months, price_ils) values ('8', 8, 1, 300) returning id")).id

  // --- a visitor
  await asRole('anon', null, async () => {
    ok('visitor: still sees the timetable and the plans', await canRead('class_availability') && await canRead('plans') && await canRead('studio_settings'))
    ok('visitor: booking is refused before the function runs (42501)', await code(() => rpc('book_class', c1)) === '42501')
    ok('visitor: an admin action is refused the same way', await code(() => rpc('admin_grant_pack', client, 8, 1, 300, null)) === '42501' && await code(() => rpc('admin_cancel_class', c1)) === '42501')
    const errs = []
    for (const f of await q(`select p.proname n, (select string_agg('null::' || format_type(t, null), ', ' order by o) from unnest(p.proargtypes) with ordinality as x(t, o)) a
        from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1)`, [CLOSED])) {
      const c = await code(() => db.query(`select public.${f.n}(${f.a ?? ''})`))
      if (c !== '42501') errs.push(`${f.n}: ${c}`)
    }
    ok('visitor: every one of the 18 closed functions answers 42501', errs.length === 0, errs.join(' | '))
    ok('visitor: is_admin() still answers, and says no', (await one('select public.is_admin() v')).v === false)
  })
  ok('nothing was written by the visitor', (await one('select count(*)::int n from public.bookings')).n === 0 && (await one('select count(*)::int n from public.credit_packs')).n === 1)

  // --- a signed-in client, through her real role
  const booking = await asRole('authenticated', client, async () => {
    const r = await rpc('book_class', c1)
    ok('client: books a class', r.ok === true && !!r.booking_id, JSON.stringify(r))
    ok('client: sees her own subscription and booking', await canRead('pack_balance') && (await one('select count(*)::int n from public.bookings')).n === 1)
    const a = await rpc('admin_grant_pack', client, 8, 1, 300, null)
    ok('client: an admin action reaches the function and is refused there (not_admin)', a.ok === false && a.error === 'not_admin', JSON.stringify(a))
    const s = await rpc('save_push_subscription', 'apns:tok', 'apns', null, null, 'ar')
    ok('client: registers her phone for notifications', s.ok === true, JSON.stringify(s))
    const p = await rpc('request_purchase', plan, null)
    ok('client: a purchase request is answered by the function (off by the studio\'s choice)', p.ok === false && p.error === 'requests_disabled', JSON.stringify(p))
    return r.booking_id
  })
  ok('the booking used one session', await left(pk) === 7, await left(pk))
  await asRole('authenticated', client, async () => {
    const r = await rpc('cancel_my_booking', booking)
    ok('client: cancels it (two days ahead: the session comes back)', r.ok === true && r.refunded === true, JSON.stringify(r))
  })

  // --- the admin, through the same role with an admin account
  await asRole('authenticated', admin, async () => {
    const g = await rpc('admin_grant_pack', client, 5, 1, 300, null)
    ok('admin: opens a subscription', g.ok === true && !!g.pack_id, JSON.stringify(g))
    const a = await rpc('admin_add_class', '2026-11-20', '09:00', 8, 'Mat', 55)
    ok('admin: adds a class', a.ok === true, JSON.stringify(a))
    const b = await rpc('admin_book_client', c1, client)
    ok('admin: books a client into a class', b.ok === true, JSON.stringify(b))
    const x = await rpc('admin_cancel_class', c1)
    ok('admin: cancels the class, the session goes back', x.ok === true && x.refunded === 1, JSON.stringify(x))
    ok('admin: reads the client list', await canRead('client_directory') && (await q('select id from public.client_directory')).length === 2)
  })
  await db.close()
  finish()
})

test('the patch gives signed-in callers the right itself, not through a default', async () => {
  // Supabase grants every new function to the API roles by default, so on live
  // the patch's own `grant … to authenticated, service_role` changes nothing.
  // On a project without that default those roles reached the functions only
  // through PUBLIC — which the patch removes. Then the grant is what keeps the
  // app working. This builds that project and checks it.
  const { ok, finish } = checks()
  const db = await fresh({ sql: 'patches', upTo: 'v1_10' })
  await db.db.exec('revoke execute on all functions in schema public from authenticated, service_role')
  const can = async (role) => (await rights(db.q, role)).filter((f) => f.x && CLOSED.includes(f.n)).map((f) => f.n).sort()
  ok('before the patch: signed-in callers reach these functions only through PUBLIC', (await can('authenticated')).length === CLOSED.length && (await can('anon')).length === CLOSED.length)
  await db.db.exec(strip(read('supabase_patch_v1_11.sql')))
  ok('after the patch: visitors reach none of them', (await can('anon')).length === 0, (await can('anon')).join())
  ok('signed-in callers still reach all of them', JSON.stringify(await can('authenticated')) === JSON.stringify(CLOSED), (await can('authenticated')).join())
  ok('and so does the server-side key', JSON.stringify(await can('service_role')) === JSON.stringify(CLOSED), (await can('service_role')).join())
  await db.db.close()
  finish()
})
