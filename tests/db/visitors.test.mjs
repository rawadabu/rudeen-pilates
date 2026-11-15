// What somebody who is NOT signed in can reach in the database.
//
// `revoke execute … from anon` does not close a function: Postgres also grants
// every function to PUBLIC, and a visitor is part of PUBLIC. Functions must end
// with `revoke execute … from public, anon`. Patch v1.11 did that for the
// older ones, which until then were reachable and only refused the caller
// from inside (tests/db/hardening.test.mjs keeps the before / after).
//
// This pins what is left: (1) the list of functions a visitor can call does
// not grow by accident — a new function must be closed; (2) every function on
// that list gives a signed-out caller nothing and changes nothing.
import { test } from 'node:test'
import { fresh } from '../lib/harness.mjs'
import { checks } from '../lib/checks.mjs'

// Reachable by a visitor, and why that is right.
const SELF_GUARDED = {
  // the row-level rules and the views call these, so every role that reads a table needs them
  is_admin: 'value', studio_now: 'value', studio_today: 'value',
  // trigger functions: Postgres refuses a direct call
  handle_new_user: 'trigger', push_webhook: 'trigger',
}

test('visitors: what a signed-out caller can reach, and that it gets them nothing', async () => {
  const { ok, finish } = checks()
  const { db, q, one, as, mkUser, pack, cls, book } = await fresh()
  // some real rows, so "nothing changed" means something
  const a = await mkUser('+972500000002'), pa = await pack(a)
  await book(await cls('2030-01-01', '18:00'), a, pa)

  const fns = await q(`select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon,
      (select string_agg('null::' || format_type(t, null), ', ' order by o) from unnest(p.proargtypes) with ordinality as x(t, o)) as nulls
    from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)
  const open = fns.filter((f) => f.anon).map((f) => f.proname)
  const extra = open.filter((n) => !(n in SELF_GUARDED)), gone = Object.keys(SELF_GUARDED).filter((n) => !open.includes(n))
  ok('no NEW function is reachable by visitors (close it: revoke execute … from public, anon)', extra.length === 0, extra.join(', '))
  ok('the list in this test is up to date', gone.length === 0, 'no longer reachable, remove from the list: ' + gone.join(', '))
  ok(`functions closed to visitors: ${fns.length - open.length} of ${fns.length}`, fns.length - open.length >= 30)

  await as(null)
  const snapshot = async () => JSON.stringify(await one(`select (select count(*) from public.bookings)::int b, (select count(*) from public.classes)::int c,
    (select count(*) from public.credit_packs)::int p, (select count(*) from public.purchase_requests)::int r, (select count(*) from public.push_subscriptions)::int s,
    (select count(*) from public.health_forms)::int h, (select count(*) from public.profiles)::int u, (select count(*) from public.notifications)::int n,
    (select string_agg(status, ',' order by id) from public.bookings) st`))
  const before = await snapshot()
  for (const f of fns.filter((x) => x.anon)) {
    const want = SELF_GUARDED[f.proname]
    let got
    try { got = (await one(`select public.${f.proname}(${f.nulls ?? ''}) v`)).v } catch (e) { got = { thrown: e.message } }
    if (want === 'trigger') ok(`${f.proname}: cannot be called directly`, /only be called as triggers/.test(got?.thrown ?? ''), JSON.stringify(got))
    else if (want === 'value') ok(`${f.proname}: gives away nothing`, f.proname === 'is_admin' ? got === false : got != null && !got?.thrown, JSON.stringify(got))
    else if (want === null) ok(`${f.proname}: does nothing for a visitor`, got?.ok === true, JSON.stringify(got))
    else ok(`${f.proname}: refuses a visitor (${want})`, got?.ok === false && got?.error === want, JSON.stringify(got))
  }
  ok('after all those calls, no row was added, removed or changed', before === await snapshot())
  await db.close()
  finish()
})
