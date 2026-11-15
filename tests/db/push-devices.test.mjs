// v1.9 — the admin's client list says who has notifications on. The device
// rows themselves stay private: only a number leaves the table.
import { test } from 'node:test'
import { fresh } from '../lib/harness.mjs'
import { checks } from '../lib/checks.mjs'

test('who has notifications on: a number per client, for the admin', async () => {
  const { ok, finish } = checks()
  const { db, q, one, as, mkUser, priv } = await fresh()
  const cols = (await q("select column_name c from information_schema.columns where table_schema = 'public' and table_name = 'client_directory' order by ordinal_position")).map((r) => r.c)
  ok('the client list ends with push_devices and kept its older columns', cols.at(-1) === 'push_devices' && ['id', 'full_name', 'phone', 'is_admin', 'active_remaining', 'next_expiry', 'health_flags', 'health_form_at'].every((c) => cols.includes(c)), cols.join())
  ok('the view runs with the caller\'s rights', (await one("select coalesce(reloptions::text, '') o from pg_class where relname = 'client_directory'")).o.includes('security_invoker=on'))
  const admin = await mkUser('+972500000001', { admin: true }), a = await mkUser('+972500000002'), b = await mkUser('+972500000003'), c = await mkUser('+972500000004')
  const dev = (uid, endpoint, kind) => db.query(`insert into public.push_subscriptions (user_id, endpoint, kind, p256dh, auth, lang) values ($1, $2, $3, null, null, 'ar')`, [uid, endpoint, kind])
  await dev(a, 'apns:tokenA1', 'apns'); await dev(a, 'https://web.example/a', 'web'); await dev(b, 'apns:tokenB', 'apns')
  const cnt = async (uid) => (await one('select public.push_device_count($1) n', [uid])).n

  await as(admin)
  ok('admin: A has 2 devices, B 1, C none', await cnt(a) === 2 && await cnt(b) === 1 && await cnt(c) === 0, `${await cnt(a)} ${await cnt(b)} ${await cnt(c)}`)
  const list = await q('select id, push_devices from public.client_directory')
  const of = (uid) => list.find((r) => r.id === uid)?.push_devices
  ok('admin: the client list carries the same numbers', of(a) === 2 && of(b) === 1 && of(c) === 0 && of(admin) === 0, JSON.stringify(list.map((r) => r.push_devices)))
  await as(a)
  ok('a client: her own number, no answer about anybody else', await cnt(a) === 2 && await cnt(b) === null && await cnt(admin) === null, `${await cnt(a)} ${await cnt(b)}`)
  await as(null)
  ok('signed out: no answer', await cnt(a) === null && await cnt(null) === null)
  ok('visitors cannot call it at all; signed-in users can', await priv('anon', 'public.push_device_count(uuid)') === false && await priv('authenticated', 'public.push_device_count(uuid)') === true)
  const src = (await one("select prosrc from pg_proc where proname = 'push_device_count'")).prosrc
  ok('only a count leaves the device table', /count\(\*\)/.test(src) && !/endpoint|p256dh/.test(src), src)
  await as(a); await db.query(`delete from public.push_subscriptions where endpoint = 'apns:tokenA1'`)
  await as(admin)
  ok('a device removed: the number drops', await cnt(a) === 1)
  await db.close()
  finish()
})
