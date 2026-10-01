import { useEffect, useState } from 'react'
import type { Dict, Lang } from '../i18n'
import { api } from '../lib/api'
import { enablePush, getPushState, isNative, type PushState } from '../lib/push'
import { C } from '../lib/theme'
import { Icon } from './Icon'

/** "Turn on notifications" card. Hides itself once this device is registered. */
export function PushCard({
  t, lang, title, hint, say,
}: {
  t: Dict; lang: Lang; title: string; hint: string; say: (m: string, k?: 'ok' | 'bad') => void
}) {
  const [state, setState] = useState<PushState | 'loading'>('loading')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    getPushState().then(setState).catch(() => setState('unsupported'))
  }, [])

  if (state === 'on' || state === 'loading' || state === 'unconfigured') return null

  const enable = async () => {
    setBusy(true)
    const sub = await enablePush().catch(() => null)
    if (!sub) {
      setBusy(false)
      setState(await getPushState().catch(() => 'off' as PushState))
      return
    }
    const ok = await api.savePushSubscription(sub, lang)
    setBusy(false)
    if (!ok) return say(t.errors.network, 'bad')
    setState('on')
    say(t.notifOn)
  }

  const sub =
    state === 'denied' ? t.notifDenied
    : state === 'unsupported' ? (isNative ? hint : t.notifIosHint)
    : hint

  return (
    <div style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: 13, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
      <Icon name="notifications" size={22} color={C.accent} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13.5, color: C.ink }}>{title}</div>
        <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2, lineHeight: 1.5 }}>{sub}</div>
      </div>
      {state === 'off' && (
        <button
          onClick={enable}
          disabled={busy}
          style={{ border: 'none', background: C.accent, color: '#fff', borderRadius: 10, padding: '8px 14px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          {busy ? t.loading : t.notifEnable}
        </button>
      )}
    </div>
  )
}
