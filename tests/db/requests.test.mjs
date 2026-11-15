// v1.6 — clients cannot ask for a subscription in the app: the studio opens
// every subscription itself after payment. A switch in studio_settings.
import { test } from 'node:test'
import { fresh } from '../lib/harness.mjs'
import { checks } from '../lib/checks.mjs'

test('purchase requests are off unless the studio turns them on', async () => {
  const { ok, finish } = checks()
  const { db, one, as, mkUser, rpc } = await fresh()
  ok('off by default', (await one('select purchase_requests_enabled v from public.studio_settings')).v === false)
  const u = await mkUser('+972521112233')
  const plan = (await one("insert into public.plans (name, sessions, valid_months, price_ils) values ('8', 8, 1, 300) returning id")).id
  await as(u)
  let r = await rpc('request_purchase', plan, null)
  ok('a request is refused while off', r.ok === false && r.error === 'requests_disabled', JSON.stringify(r))
  ok('and nothing is written', (await one('select count(*)::int n from public.purchase_requests')).n === 0)
  await db.exec('update public.studio_settings set purchase_requests_enabled = true')
  r = await rpc('request_purchase', plan, null)
  ok('it works once the studio turns it on', r.ok === true, JSON.stringify(r))
  r = await rpc('request_purchase', plan, null)
  ok('a second one for the same plan is "pending"', r.error === 'request_pending', JSON.stringify(r))
  await db.exec('update public.studio_settings set purchase_requests_enabled = false')
  await as(null)
  r = await rpc('request_purchase', plan, null)
  ok('signed out is refused before anything else', r.error === 'not_authenticated', JSON.stringify(r))
  await db.close()
  finish()
})
