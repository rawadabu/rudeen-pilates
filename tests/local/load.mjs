// Loads this repo's SQL into the local copy the way it was loaded into live:
// supabase_setup.sql, then every patch in order, then the push setup — as the
// role the Supabase SQL Editor uses (postgres).
import pg from 'pg'
import { read, patchFiles } from '../lib/harness.mjs'

/** Anything in the SQL that points at a real Supabase project is redirected to
 *  a dead local address, so a trigger in the copy can never call the live
 *  push function. */
const DEAD = 'http://127.0.0.1:9'
const local = (sql) => sql.replaceAll(/https:\/\/[A-Za-z0-9<>_-]+\.supabase\.co/g, DEAD)

/** True when the copy's database is as a new Supabase project has it (nothing of ours in it yet). */
export async function isEmpty(s) {
  const db = new pg.Client({ connectionString: s.dbUrl })
  await db.connect()
  try {
    return (await db.query(`select (select count(*) from pg_tables where schemaname = 'public')::int + (select count(*) from auth.users)::int as n`)).rows[0].n === 0
  } finally { await db.end() }
}

/** s = what stack.up() returned. Resolves once the SQL is in AND the API has noticed it. */
export async function load(s, { upTo = null, push = true } = {}) {
  if (!/@127\.0\.0\.1:/.test(s.dbUrl) || !/^http:\/\/127\.0\.0\.1:/.test(s.apiUrl)) throw new Error('refusing to load into anything but the local copy')
  const db = new pg.Client({ connectionString: s.dbUrl })
  await db.connect()
  const applied = []
  const apply = async (name, sql) => {
    try { await db.query(local(sql)); applied.push(name) } catch (e) { await db.end(); throw new Error(`${name} failed in the local copy: ${e.message}`) }
  }
  await apply('supabase_setup.sql', read('supabase_setup.sql'))
  for (const f of patchFiles()) {
    await apply(f, read(f))
    if (upTo && f === `supabase_patch_${upTo}.sql`) break
  }
  if (push) await apply('supabase_push_setup.sql', read('supabase_push_setup.sql').replaceAll('<WEBHOOK_SECRET>', 'local-test-secret'))
  const leak = (await db.query(`select count(*)::int n from pg_proc where pronamespace = 'public'::regnamespace and prosrc ~ 'supabase\\.co'`)).rows[0].n
  if (leak) { await db.end(); throw new Error('a function in the local copy still points at a real Supabase project') }
  await apiCaughtUp(db, s)
  return { db, applied }
}

/** The API keeps its own picture of the database and refreshes it a moment
 *  after being told to. A test that starts before that sees "no such table".
 *  So: add a marker function, wait until the API can call it, remove it. */
export async function apiCaughtUp(db, s) {
  const marker = '_copy_ready_' + Date.now()
  await db.query(`create function public.${marker}() returns int language sql as 'select 1'; notify pgrst, 'reload schema'`)
  let seen = false
  for (let i = 0; i < 120 && !seen; i++) {
    const r = await fetch(`${s.apiUrl}/rest/v1/rpc/${marker}`, { method: 'POST', headers: { apikey: s.anonKey, 'content-type': 'application/json' }, body: '{}' }).catch(() => null)
    seen = !!r && r.status === 200
    if (!seen) await new Promise((res) => setTimeout(res, 250))
  }
  await db.query(`drop function public.${marker}(); notify pgrst, 'reload schema'`)
  if (!seen) throw new Error('the local API did not pick up the loaded database')
}
