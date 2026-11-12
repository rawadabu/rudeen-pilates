import { useEffect } from 'react'
import type { Dict, Lang } from '../i18n'
import { canOpenSettings, isNative, openNotificationSettings } from '../lib/push'
import { turnOnPush, usePush } from '../lib/pushStore'
import { C } from '../lib/theme'
import { Icon } from './Icon'
import { Sheet } from './Sheet'
import { PrimaryBtn } from './ui'

/** "Turn on notifications" card. Hides itself once this device is registered.
 *  v1.9: somebody who once refused gets a button to the phone's Settings (the
 *  iPhone never asks a second time). */
export function PushCard({
  t, lang, title, hint, say,
}: {
  t: Dict; lang: Lang; title: string; hint: string; say: (m: string, k?: 'ok' | 'bad') => void
}) {
  const { state, busy } = usePush(lang)

  if (state === 'on' || state === 'loading' || state === 'unconfigured') return null

  const enable = async () => {
    const r = await turnOnPush(lang)
    if (r === 'network') say(t.errors.network, 'bad')
    else if (r === 'on') say(t.notifOn)
  }

  const toSettings = state === 'denied' && canOpenSettings()
  const sub =
    state === 'denied' ? (toSettings || isNative ? t.notifDeniedApp : t.notifDenied)
    : state === 'unsupported' ? (isNative ? hint : t.notifIosHint)
    : hint

  const btn = {
    border: 'none', background: C.accent, color: '#fff', borderRadius: 10, padding: '8px 14px',
    fontSize: 12.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
  } as const

  return (
    <div style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: 13, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
      <Icon name={state === 'denied' ? 'notifications_off' : 'notifications'} size={22} color={state === 'denied' ? C.warn : C.accent} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, color: C.ink }}>{title}</div>
        <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2, lineHeight: 1.5 }}>{sub}</div>
      </div>
      {state === 'off' && (
        <button onClick={enable} disabled={busy} style={btn}>
          {busy ? t.loading : t.notifEnable}
        </button>
      )}
      {toSettings && (
        <button onClick={openNotificationSettings} style={btn}>
          {t.notifOpenSettings}
        </button>
      )}
    </div>
  )
}

/** v1.9 — asked right after a booking, the moment a reminder matters. One big
 *  button; for somebody who refused before, the way to the phone's Settings
 *  and what to tap there. Closes itself when notifications come on (here, or
 *  in Settings and back). */
export function PushAskSheet({
  t, lang, open, onClose, say, done,
}: {
  t: Dict; lang: Lang; open: boolean; onClose: () => void; say: (m: string, k?: 'ok' | 'bad') => void
  /** what just succeeded ("you are booked"), shown at the top instead of a toast */
  done?: string
}) {
  const { state, busy } = usePush(lang)

  useEffect(() => {
    if (open && state === 'on') onClose()
  }, [open, state, onClose])

  const denied = state === 'denied'
  const toSettings = denied && canOpenSettings()

  const enable = async () => {
    const r = await turnOnPush(lang)
    if (r === 'network') say(t.errors.network, 'bad')
    else if (r === 'on') say(t.notifOn)
    // refused: the sheet stays and now shows the way through Settings
  }

  return (
    <Sheet closeLabel={t.close} open={open} onClose={onClose} title={denied ? t.pushAskDeniedTitle : t.pushAskTitle}>
      <div style={{ textAlign: 'center', padding: '6px 4px 14px' }}>
        {done && (
          <div
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6, background: C.okSoft, color: C.ok,
              borderRadius: 999, padding: '6px 14px', fontSize: 13, fontWeight: 600, marginBottom: 16,
            }}
          >
            <Icon name="check_circle" size={17} />
            {done}
          </div>
        )}
        <div
          style={{
            width: 64, height: 64, borderRadius: 32, margin: '0 auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: denied ? C.warnSoft : C.accentSoft,
          }}
        >
          <Icon name={denied ? 'notifications_off' : 'notifications_active'} size={32} color={denied ? C.warn : C.accent} />
        </div>
        <div style={{ fontSize: 14, color: C.ink, lineHeight: 1.65, marginTop: 12 }}>{denied ? t.pushAskDenied : t.pushAskBody}</div>
        {toSettings && <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginTop: 8 }}>{t.pushAskSteps}</div>}
      </div>
      {denied ? (
        toSettings && <PrimaryBtn label={t.notifOpenSettings} onClick={openNotificationSettings} />
      ) : (
        <PrimaryBtn label={busy ? t.loading : t.pushAskYes} disabled={busy} onClick={enable} />
      )}
      <button
        onClick={onClose}
        style={{ width: '100%', marginTop: 8, border: 'none', background: 'none', color: C.muted, borderRadius: 10, padding: 12, fontSize: 13.5, cursor: 'pointer' }}
      >
        {t.pushAskLater}
      </button>
    </Sheet>
  )
}
