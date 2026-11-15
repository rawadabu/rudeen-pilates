// The project's real SQL files, loaded into PGlite (Postgres compiled to
// WebAssembly, in memory). The Supabase pieces the SQL leans on are stubbed:
// auth.users / auth.uid(), the API roles, pg_cron, pg_net.
//   - auth.uid() is whoever the test says: await as(userId)
//   - every net.http_post lands in net.calls (what would have been sent)
//   - the studio clock can be pinned and moved: await clock(db); await at('12:00')
import { PGlite } from '@electric-sql/pglite'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))
export const read = (f) => readFileSync(ROOT + f, 'utf8')
/** pg_cron / pg_net are stubbed below, so their "create extension" lines are dropped */
export const strip = (s) => s.replace(/^create extension if not exists (pg_cron|pg_net)[^;]*;\s*$/gm, '-- (extension stubbed)')
/** supabase_patch_v1_1.sql … in version order (v1_10 after v1_9) */
export const patchFiles = () =>
  readdirSync(ROOT).filter((f) => /^supabase_patch_v\d+_\d+\.sql$/.test(f))
    .sort((a, b) => { const n = (f) => f.match(/v(\d+)_(\d+)/).slice(1).map(Number); const [x, y] = [n(a), n(b)]; return x[0] - y[0] || x[1] - y[1] })

export const STUBS = `
  create role anon; create role authenticated; create role service_role;
  -- As on Supabase: the three API roles may use the schema, and every table,
  -- function and sequence created in it is granted to them by default. Row
  -- level security and the patches' own revoke / grant lines decide the rest.
  -- This is what lets a test really act as a visitor: set role anon.
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), phone text, raw_user_meta_data jsonb default '{}'::jsonb, created_at timestamptz default now());
  create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  create function auth.role() returns text language sql stable as $$ select 'authenticated' $$;
  grant usage on schema auth to anon, authenticated, service_role;
  create schema cron;
  create table cron.job (jobid bigserial, jobname text primary key, schedule text, command text, active boolean default true);
  create table cron.job_run_details (jobid bigint, runid bigserial, status text, return_message text, start_time timestamptz, end_time timestamptz);
  create function cron.schedule(n text, s text, c text) returns bigint language plpgsql as $$ begin
    insert into cron.job (jobname, schedule, command) values (n, s, c) on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command; return 1; end $$;
  create function cron.unschedule(n text) returns boolean language plpgsql as $$ begin
    delete from cron.job where jobname = n; if not found then raise exception 'could not find valid entry for job'; end if; return true; end $$;
  create publication supabase_realtime;
  create schema net;
  create table net.calls (id bigserial primary key, url text, headers jsonb, body jsonb);
  create table net._http_response (id bigint, status_code int, content_type text, headers jsonb, content text, timed_out boolean, error_msg text, created timestamptz default now());
  create function net.http_post(url text, headers jsonb default '{}'::jsonb, body jsonb default '{}'::jsonb) returns bigint language plpgsql as $$
    declare v bigint; begin insert into net.calls (url, headers, body) values (url, headers, body) returning id into v; return v; end $$;
`
export const pushSetupSql = () =>
  strip(read('supabase_push_setup.sql')).replaceAll('<PROJECT_REF>', 'testref').replaceAll('<WEBHOOK_SECRET>', 'testsecret')

/** A database as a new studio gets it: the one-paste install file, and (unless
 *  push: false) the push setup on top. sql: 'install' | 'patches' (setup + every patch in order). */
export async function fresh({ push = true, sql = 'install', empty = true, upTo = null } = {}) {
  const db = new PGlite()
  await db.exec(STUBS)
  if (sql === 'install') await db.exec(strip(read('supabase_install_all.sql')))
  else {
    await db.exec(strip(read('supabase_setup.sql')))
    // upTo: stop after that patch (e.g. 'v1_10'), to compare a database before and after a later one
    for (const f of patchFiles()) {
      await db.exec(strip(read(f)))
      if (upTo && f === `supabase_patch_${upTo}.sql`) break
    }
  }
  if (push) await db.exec(pushSetupSql())
  const q = async (text, params) => (await db.query(text, params)).rows
  const one = async (text, params) => (await q(text, params))[0]
  // the install seeds a sample week; most tests want an empty timetable
  if (empty) await db.exec('delete from public.bookings; delete from public.classes; delete from public.class_template; delete from net.calls;')

  const as = (id) => db.exec(`select set_config('test.uid', '${id ?? ''}', false)`)
  const mkUser = async (phone, { admin = false, health = true } = {}) => {
    const id = (await one('insert into auth.users (phone) values ($1) returning id', [phone])).id
    if (admin) await db.query('update public.profiles set is_admin = true where id = $1', [id])
    if (health) await db.query("insert into public.health_forms (user_id, answers, consent_name) values ($1, '{}'::jsonb, 'test')", [id])
    return id
  }
  /** a subscription that is valid around the studio's "today" */
  const pack = async (uid, total = 20) => (await one(
    `insert into public.credit_packs (user_id, sessions_total, valid_from, valid_until)
     values ($1, $2, public.studio_today() - 5, public.studio_today() + 20) returning id`, [uid, total])).id
  const left = async (packId) => (await one('select remaining from public.pack_balance where id = $1', [packId])).remaining
  const cls = async (date, time, status = 'open') => (await one(
    'insert into public.classes (class_date, start_time, capacity, status) values ($1, $2, 8, $3) returning id', [date, time, status])).id
  /** a booking written straight into the table (ageMin = how long ago it was made) */
  const book = async (classId, uid, packId, { status = 'booked', ageMin = 120 } = {}) => (await one(
    `insert into public.bookings (class_id, user_id, pack_id, status, consumes_credit, created_at)
     values ($1, $2, $3, $4, $5, now() - make_interval(mins => $6)) returning id`,
    [classId, uid, packId, status, status !== 'cancelled', ageMin])).id
  const guest = async (classId, name = 'Guest') => (await one(
    'insert into public.bookings (class_id, guest_name, consumes_credit) values ($1, $2, false) returning id', [classId, name])).id
  const rpc = async (fn, ...args) => (await one(`select public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(', ')}) r`, args)).r
  const priv = async (role, signature) => (await one(`select has_function_privilege($1, $2, 'execute') p`, [role, signature])).p
  const sent = async (event) => (await one("select count(*)::int n from net.calls where body->>'event' = $1", [event])).n
  /** pin the studio clock: at('2026-11-12 12:00') or, after the first call, at('12:25') */
  let day = null
  const at = async (when) => {
    if (day === null) {
      await db.exec(`
        create or replace function public.studio_now() returns timestamp language sql stable as $$ select current_setting('test.now')::timestamp $$;
        create or replace function public.studio_today() returns date language sql stable as $$ select current_setting('test.now')::timestamp::date $$;`)
    }
    if (when.length > 5) day = when.slice(0, 10)
    await db.exec(`select set_config('test.now', '${when.length > 5 ? when : day + ' ' + when}:00', false)`)
  }
  /** Run fn as a database role, the way the API does: 'anon' = a visitor,
   *  'authenticated' = somebody signed in (uid = who). Row-level security and
   *  function grants apply for real. Back to the test's own role afterwards. */
  const asRole = async (role, uid, fn) => {
    await as(uid)
    await db.exec(`set role ${role}`)
    try { return await fn() } finally { await db.exec('reset role'); await as(null) }
  }
  /** true if that role can read the table / view right now (empty is fine) */
  const canRead = async (rel) => { try { await db.query(`select 1 from public.${rel} limit 1`); return true } catch { return false } }
  /** the error code of a call, or null if it went through: code(() => rpc(...)) */
  const code = async (fn) => { try { await fn(); return null } catch (e) { return e.code ?? e.message } }
  return { db, q, one, as, mkUser, pack, left, cls, book, guest, rpc, priv, sent, at, asRole, canRead, code }
}
