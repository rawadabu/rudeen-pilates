// supabase_install_all.sql promises to be exactly supabase_setup.sql followed
// by every patch, in order. A patch that was never appended to it would give a
// new studio a different database from the live one. This compares the two.
import { test } from 'node:test'
import { fresh, patchFiles } from '../lib/harness.mjs'
import { checks } from '../lib/checks.mjs'

const SHAPE = {
  functions: `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as k, md5(p.prosrc) as v
                from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`,
  columns: `select table_name || '.' || column_name as k, data_type || ' ' || is_nullable || ' ' || coalesce(column_default, '') as v
              from information_schema.columns where table_schema = 'public' order by 1`,
  views: `select viewname as k, md5(definition) as v from pg_views where schemaname = 'public' order by 1`,
  policies: `select tablename || ': ' || policyname as k, cmd || ' ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') as v
               from pg_policies where schemaname = 'public' order by 1`,
  triggers: `select event_object_table || ': ' || trigger_name || ' ' || event_manipulation as k, action_statement as v
               from information_schema.triggers where trigger_schema = 'public' order by 1`,
  jobs: `select jobname as k, schedule || ' ' || command as v from cron.job order by 1`,
}

test('the one-paste install equals setup + every patch in order', async () => {
  const { ok, finish } = checks()
  // with the push setup on top of both, so its triggers are compared too
  const a = await fresh({ sql: 'install', push: true, empty: false })
  const b = await fresh({ sql: 'patches', push: true, empty: false })
  ok(`patch files found, in order (${patchFiles().length})`, patchFiles().length >= 10 && patchFiles().at(-1) !== 'supabase_patch_v1_9.sql', patchFiles().join(' '))
  for (const [what, sql] of Object.entries(SHAPE)) {
    const [x, y] = [await a.q(sql), await b.q(sql)]
    const mx = new Map(x.map((r) => [r.k, r.v])), my = new Map(y.map((r) => [r.k, r.v]))
    const diff = [...new Set([...mx.keys(), ...my.keys()])].filter((k) => mx.get(k) !== my.get(k))
      .map((k) => `${k}: ${!mx.has(k) ? 'missing from install_all' : !my.has(k) ? 'only in install_all' : 'differs'}`)
    ok(`${what}: identical (${x.length})`, x.length > 0 && diff.length === 0, diff.join(' | '))
  }
  await a.db.close(); await b.db.close()
  finish()
})

test('every patch can be run twice', async () => {
  const { ok, finish } = checks()
  const { db } = await fresh({ sql: 'patches', push: true, empty: false })
  const { read, strip, pushSetupSql } = await import('../lib/harness.mjs')
  for (const f of patchFiles()) {
    let err = null
    try { await db.exec(strip(read(f))) } catch (e) { err = e.message }
    ok(`${f} runs a second time`, err === null, err)
  }
  // After everything was re-run from v1.1 up, the newest definitions must be back in place.
  const src = async (fn) => (await db.query(`select prosrc from pg_proc where proname = $1 and pronamespace = 'public'::regnamespace`, [fn])).rows[0]?.prosrc ?? ''
  ok('after the re-run the reminder job is the two-reminder version', (await src('send_class_reminders')).includes('push_reminded_30_at'))
  ok('after the re-run cancelling a class goes through cancel_class_refund', (await src('admin_cancel_class')).includes('cancel_class_refund'))
  let err = null
  try { await db.exec(pushSetupSql()) } catch (e) { err = e.message }
  ok('the push setup runs a second time', err === null, err)
  await db.close()
  finish()
})
