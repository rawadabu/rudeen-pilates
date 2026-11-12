/** Push registration — Web Push (VAPID) in a browser / installed PWA, native
 *  APNs / FCM tokens inside the Capacitor app. Callers never see which. */
import { Capacitor } from '@capacitor/core'
import { PushNotifications } from '@capacitor/push-notifications'
import type { PushSub } from './types'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined
const NATIVE_KEY = 'push_endpoint'

export const isNative = Capacitor.isNativePlatform()
/** 'unconfigured' = web build without VITE_VAPID_PUBLIC_KEY: nothing to offer */
export type PushState = 'unconfigured' | 'unsupported' | 'denied' | 'off' | 'on'

/** Dev server only: preview the states that otherwise need a real iPhone, e.g.
 *  in the console: window.__pushFake = { state: 'denied', ios: true }.
 *  import.meta.env.DEV is false in a production build, so none of it ships. */
type Fake = { state: PushState; ios?: boolean; grant?: boolean }
const fake = (): Fake | null =>
  import.meta.env.DEV ? ((window as unknown as { __pushFake?: Fake }).__pushFake ?? null) : null

/** Can this device jump to its own notification settings? The iPhone app only. */
export function canOpenSettings(): boolean {
  const f = fake()
  if (f) return !!f.ios
  return isNative && Capacitor.getPlatform() === 'ios'
}

/** iPhone app: opens this app's page in the phone's Settings, where
 *  Notifications is. Once someone tapped "Don't Allow", iOS never asks again —
 *  this is the only way back. No plugin: Capacitor hands every address that is
 *  not the app's own to iOS (WebViewDelegationHandler → UIApplication.open),
 *  and `app-settings:` is iOS's own address for that page. */
export function openNotificationSettings(): void {
  if (fake()) {
    console.info('[push] dev preview: would open app-settings:')
    return
  }
  if (canOpenSettings()) window.location.href = 'app-settings:'
}

export function pushSupported(): boolean {
  if (isNative) return true
  return !!VAPID_PUBLIC_KEY && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export async function registerSW(): Promise<ServiceWorkerRegistration | null> {
  // no service workers inside the native shell (capacitor:// scheme)
  if (isNative || !('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register('/sw.js')
  } catch {
    return null
  }
}

/** Native only: tapping a notification opens the screen it points at. */
export function initNativePush(): void {
  if (!isNative) return
  PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    const url = (action.notification.data as { url?: string } | undefined)?.url
    if (typeof url === 'string' && url.includes('#')) window.location.hash = url.slice(url.indexOf('#'))
  })
}

export async function getPushState(): Promise<PushState> {
  const f = fake()
  if (f) return f.state
  if (isNative) {
    const p = await PushNotifications.checkPermissions()
    if (p.receive === 'denied') return 'denied'
    return localStorage.getItem(NATIVE_KEY) ? 'on' : 'off'
  }
  if (!VAPID_PUBLIC_KEY) return 'unconfigured'
  if (!pushSupported()) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = reg ? await reg.pushManager.getSubscription() : null
  return sub ? 'on' : 'off'
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64)
  const arr = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i)
  return arr
}

/** Asks permission and registers. Returns null if refused/unsupported. */
export async function enablePush(): Promise<PushSub | null> {
  const f = fake()
  if (f) {
    f.state = f.grant ? 'on' : 'denied'
    return f.grant ? { endpoint: 'apns:dev-preview', kind: 'apns', p256dh: null, auth: null } : null
  }
  if (isNative) {
    const perm = await PushNotifications.requestPermissions()
    if (perm.receive !== 'granted') return null
    await PushNotifications.removeAllListeners()
    initNativePush()
    const token = await new Promise<string | null>((resolve) => {
      const timer = window.setTimeout(() => resolve(null), 15000)
      PushNotifications.addListener('registration', (t) => {
        window.clearTimeout(timer)
        resolve(t.value)
      })
      PushNotifications.addListener('registrationError', () => {
        window.clearTimeout(timer)
        resolve(null)
      })
      PushNotifications.register()
    })
    if (!token) return null
    const kind = Capacitor.getPlatform() === 'ios' ? 'apns' : 'fcm'
    const endpoint = `${kind}:${token}`
    localStorage.setItem(NATIVE_KEY, endpoint)
    return { endpoint, kind, p256dh: null, auth: null }
  }

  if (!pushSupported()) return null
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return null
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerSW())
  if (!reg) return null
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY!) as BufferSource,
  })
  const j = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } }
  if (!j.endpoint || !j.keys) return null
  return { endpoint: j.endpoint, kind: 'web', p256dh: j.keys.p256dh, auth: j.keys.auth }
}

/** This device's registration key, for removal on sign-out. */
export async function currentEndpoint(): Promise<string | null> {
  if (isNative) return localStorage.getItem(NATIVE_KEY)
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = reg ? await reg.pushManager.getSubscription() : null
  return sub?.endpoint ?? null
}

export function forgetNativeEndpoint(): void {
  localStorage.removeItem(NATIVE_KEY)
}
