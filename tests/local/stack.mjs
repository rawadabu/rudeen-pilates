// The local test copy: a complete Supabase in Docker on this computer
// (Postgres, the API, sign-in), started from supabase/config.toml. It is the
// same software the live project runs, so what is checked here — real roles,
// real row-level security, real sign-in, the real extensions — is what the
// in-memory tests in ../db can only imitate.
//
// It never touches the live project: the addresses are 127.0.0.1, the keys
// are the Supabase CLI's public local defaults, and load.mjs refuses to leave
// any address of the live project inside the copy.
import { spawnSync } from 'node:child_process'
import { ROOT } from '../lib/harness.mjs'

// Pinned: a release at least a week old when it was chosen (2026-11-15).
const CLI = ['--yes', 'supabase@2.122.1']
// Not needed for these tests; leaving them out makes the start quick and light.
const EXCLUDE = 'realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,edge-runtime,logflare,vector,supavisor'

const run = (args, { timeout = 600_000 } = {}) => {
  const r = spawnSync('npx', [...CLI, ...args, '--workdir', ROOT], { encoding: 'utf8', timeout, env: { ...process.env, DO_NOT_TRACK: '1' } })
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
/** null when Docker is there, otherwise why the local copy cannot run */
export function dockerMissing() {
  const r = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8', timeout: 20_000 })
  return r.status === 0 ? null : 'Docker is not running (start Docker or Colima, then try again)'
}
/** { apiUrl, dbUrl, anonKey, serviceKey } of the running copy, or null when it is not running */
export function status() {
  const r = run(['status', '-o', 'json'], { timeout: 60_000 })
  const m = r.out.match(/\{[\s\S]*\}/)
  if (!r.ok || !m) return null
  try {
    const s = JSON.parse(m[0])
    if (!/^http:\/\/127\.0\.0\.1:/.test(s.API_URL ?? '') || !/@127\.0\.0\.1:/.test(s.DB_URL ?? '')) return null   // local or nothing
    return { apiUrl: s.API_URL, dbUrl: s.DB_URL, anonKey: s.ANON_KEY, serviceKey: s.SERVICE_ROLE_KEY }
  } catch { return null }
}
/** Starts the copy if it is not running. The first start downloads the images (a few minutes). */
export function up() {
  let s = status()
  if (s) return s
  const r = run(['start', '-x', EXCLUDE])
  s = status()
  if (!s) throw new Error('the local copy did not start:\n' + r.out.split('\n').filter((l) => !/Pull|Download|Digest|new version|recommend/.test(l)).slice(-12).join('\n'))
  return s
}
/** An empty database again, exactly as a new Supabase project has it (about 25 seconds). */
export function reset() {
  const r = run(['db', 'reset'])
  if (!r.ok) throw new Error('could not reset the local copy:\n' + r.out.split('\n').slice(-12).join('\n'))
}
/** Stops the copy and throws its data away. */
export function down() {
  return run(['stop', '--no-backup'], { timeout: 120_000 }).ok
}
