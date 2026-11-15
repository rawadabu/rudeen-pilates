// Drives the app's screens the way a person would, on the LOCAL DEMO only:
// it starts the app with VITE_SUPABASE_URL=demo (in-memory sample data, no
// database) and a headless Chrome sized like a phone. Before every flow it
// asks the app itself whether it is on the demo backend and stops if not —
// these tests must never touch the live database.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { ROOT } from '../lib/harness.mjs'

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const SHOTS = fileURLToPath(new URL('../.shots/', import.meta.url))
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const chromeMissing = () => (existsSync(CHROME) ? null : `Chrome not found at ${CHROME} (set CHROME=/path/to/chrome)`)
const freePort = () => new Promise((res) => { const s = createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)) }) })

export async function demo() {
  // --- the app, in demo mode
  const port = await freePort()
  const site = `http://localhost:${port}`
  const vite = spawn(ROOT + 'app/node_modules/.bin/vite', ['--port', String(port), '--strictPort'], {
    cwd: ROOT + 'app', stdio: 'ignore',
    env: { ...process.env, VITE_SUPABASE_URL: 'demo', VITE_SUPABASE_ANON_KEY: '', VITE_VAPID_PUBLIC_KEY: '' },
  })
  let up = false
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(site)).ok } catch { await sleep(250) } }
  if (!up) { vite.kill(); throw new Error('the demo app did not start') }

  // --- a phone-sized headless Chrome
  const dbg = await freePort()
  const profile = `${tmpdir()}/rudeen-ui-test-${dbg}`
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdio: 'ignore' })
  let ws
  for (let i = 0; i < 80 && !ws; i++) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === 'page')
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl)
    } catch { await sleep(250) }
  }
  const stop = () => { try { ws?.close() } catch {} chrome.kill(); vite.kill(); try { rmSync(profile, { recursive: true, force: true }) } catch {} }
  if (!ws) { stop(); throw new Error('Chrome did not start') }
  await new Promise((r) => ws.addEventListener('open', r))
  let id = 0
  const pending = new Map(), errors = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result ?? m.error); pending.delete(m.id) }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description?.slice(0, 200) ?? 'exception')
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push('console.error: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
  })
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
  /** runs code in the page; `return x` gives x back */
  const js = async (code) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(String(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)).slice(0, 600))
    return r.result?.value
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true })
  await send('Page.enable'); await send('Runtime.enable')

  let inject = null
  /** Opens a screen signed in as the demo admin (who is also a client with a subscription).
   *  pushFake: what the phone answers about notifications (dev server only, see app/src/lib/push.ts). */
  const open = async (hash = '#/', { lang = 'he', pushFake = null, health = false } = {}) => {
    if (inject) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: inject })
    inject = (await send('Page.addScriptToEvaluateOnNewDocument', { source:
      `${pushFake ? `window.__pushFake = ${JSON.stringify(pushFake)};` : ''} try { localStorage.setItem('lang', ${JSON.stringify(lang)}); localStorage.removeItem('push_ask_at') } catch {}` })).identifier
    await send('Page.navigate', { url: 'about:blank' }); await sleep(150)
    await send('Page.navigate', { url: site + '/' + hash }); await sleep(2000)
    const isDemo = await js(`const m = await import('/src/lib/api.ts'); const s = await import('/src/lib/supabase.ts'); return m.api.demo === true && s.supabase === null`)
    if (!isDemo) { stop(); throw new Error('NOT the demo backend — refusing to run screen tests against a real database') }
    const signIn = `await m.api.sendOtp(P); await m.api.verifyOtp(P, '123456');`
    await js(`const m = await import('/src/lib/api.ts'); const P = '+972503337328'; ${signIn}
      ${health ? `await m.api.submitHealthForm({ lang: 'ar', answers: {}, flags: [], consentName: 'Demo', signaturePng: 'data:image/png;base64,iVBORw0KGgo=' }); await m.api.signOut(); ${signIn}` : ''}`)
    await sleep(1200)
  }
  /** an expression for "the buttons whose text contains txt" */
  const btn = (txt) => `[...document.querySelectorAll('button')].filter((b) => b.innerText.includes(${JSON.stringify(txt)}))`
  const click = async (txt, { last = false, wait = 500 } = {}) => {
    const n = await js(`const b = ${btn(txt)}; if (!b.length) return 0; b[${last ? 'b.length - 1' : 0}].click(); return b.length`)
    await sleep(wait)
    return n
  }
  const count = (txt) => js(`return ${btn(txt)}.length`)
  /** the page's text, without the invisible direction marks the app puts around numbers */
  const text = async () => (await js(`return document.body.innerText`)).replace(/[⁦⁩]/g, '')
  /** bottom navigation: the tab whose label ends with `label` */
  const nav = async (label) => { await js(`const b = [...document.querySelectorAll('button')].filter((x) => x.innerText.trim().endsWith(${JSON.stringify(label)})); b[b.length - 1].click()`); await sleep(500) }
  /** The person leaves the app (to the phone's Settings, another app) and comes
   *  back. A headless page reports itself hidden after a few seconds, so the
   *  visibility is set explicitly instead of trusting the browser's own state. */
  const awayAndBack = async (whileAway = '') => {
    const set = (v) => `Object.defineProperty(document, 'visibilityState', { get: () => '${v}', configurable: true }); document.dispatchEvent(new Event('visibilitychange'));`
    await js(set('hidden')); await sleep(150)
    await js(`${whileAway}; ${set('visible')}`); await sleep(900)
  }
  const shot = async (name) => {
    mkdirSync(SHOTS, { recursive: true })
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(SHOTS + name, Buffer.from(r.data, 'base64'))
  }
  return { site, open, js, btn, click, count, text, nav, awayAndBack, shot, errors, stop }
}
