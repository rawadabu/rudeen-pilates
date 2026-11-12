/** One shared answer to "are notifications on, on this device?" — the home
 *  card, the sheet after a booking and the account tab all read it, so turning
 *  them on in one place updates the others. Re-checked every time the app
 *  comes back to the front. */
import { useEffect, useSyncExternalStore } from 'react'
import { api } from './api'
import { canOpenSettings, enablePush, getPushState, type PushState } from './push'

export type PushView = { state: PushState | 'loading'; busy: boolean }
type Lang = 'he' | 'ar'

let view: PushView = { state: 'loading', busy: false }
let lang: Lang = 'he'
let started = false
const subs = new Set<() => void>()
const set = (patch: Partial<PushView>) => {
  view = { ...view, ...patch }
  subs.forEach((f) => f())
}

/** The current answer, outside React (e.g. right after a booking). */
export const pushNow = (): PushView => view

export async function refreshPush(): Promise<PushState> {
  const s = await getPushState().catch(() => 'unsupported' as PushState)
  set({ state: s })
  return s
}

/** Asks the phone for permission, registers this device and saves it.
 *  'refused' = the person said no (or the phone cannot); 'network' = the
 *  device is registered but saving it failed. */
export async function turnOnPush(l: Lang): Promise<'on' | 'refused' | 'network'> {
  if (view.busy) return 'refused'
  set({ busy: true })
  const sub = await enablePush().catch(() => null)
  if (!sub) {
    set({ busy: false })
    await refreshPush()
    return 'refused'
  }
  const ok = await api.savePushSubscription(sub, l).catch(() => false)
  set({ busy: false })
  if (!ok) return 'network'
  set({ state: 'on' })
  return 'on'
}

async function onResume() {
  const was = view.state
  const now = await refreshPush()
  // Back from the phone's Settings with notifications switched on there:
  // finish the registration, the person should not have to tap again.
  if (was === 'denied' && now === 'off' && canOpenSettings()) turnOnPush(lang)
}

function start() {
  if (started) return
  started = true
  refreshPush()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') onResume()
  })
}

const subscribe = (f: () => void) => {
  subs.add(f)
  return () => subs.delete(f)
}

export function usePush(l: Lang): PushView {
  useEffect(() => {
    lang = l
    start()
  }, [l])
  return useSyncExternalStore(subscribe, pushNow)
}
