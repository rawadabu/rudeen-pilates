import { useState } from 'react'
import type { Dict } from '../i18n'
import { api } from '../lib/api'
import { C } from '../lib/theme'
import { Icon } from './Icon'

/** 6-digit OTP entry, shared by the booking flow and the admin login. */
export function OtpPanel({
  t,
  phoneDisplay,
  busy,
  onVerify,
  onResend,
  onBack,
}: {
  t: Dict
  phoneDisplay: string
  busy: boolean
  /** Returns a localized error message, or null on success */
  onVerify: (token: string) => Promise<string | null>
  /** Returns a localized error message, or null on success */
  onResend: () => Promise<string | null>
  onBack: () => void
}) {
  const [token, setToken] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [resent, setResent] = useState(false)

  const canVerify = /^\d{6}$/.test(token) && !busy

  const verify = async () => {
    if (!canVerify) return
    setErr(null)
    const e = await onVerify(token)
    if (e) setErr(e)
  }

  const resend = async () => {
    setErr(null)
    setResent(false)
    const e = await onResend()
    if (e) setErr(e)
    else setResent(true)
  }

  return (
    <div style={{ padding: '20px 20px 40px', animation: 'fadeUp .35s ease' }}>
      <button
        onClick={onBack}
        style={{ display: 'flex', alignItems: 'center', gap: 4, border: 'none', background: 'none', color: C.muted, fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 14 }}
      >
        <Icon name="arrow_forward" size={18} />
        {t.otpChange}
      </button>
      <div style={{ fontSize: 24, fontWeight: 600, color: C.ink, marginBottom: 6 }}>{t.otpTitle}</div>
      <div style={{ fontSize: 13.5, color: C.muted, marginBottom: 18, lineHeight: 1.6 }}>
        {t.otpSub.replace('{p}', '⁦' + phoneDisplay + '⁩')}
      </div>
      <input
        value={token}
        onChange={(e) => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') verify()
        }}
        placeholder="••••••"
        inputMode="numeric"
        autoComplete="one-time-code"
        dir="ltr"
        autoFocus
        style={{
          width: '100%', border: '1.5px solid ' + (err ? C.warn : C.disabled), background: C.card,
          borderRadius: 12, padding: '14px', fontSize: 24, color: C.ink, textAlign: 'center',
          letterSpacing: 12, fontVariantNumeric: 'tabular-nums',
        }}
      />
      {api.demo && (
        <div style={{ marginTop: 8, fontSize: 12, color: C.muted, textAlign: 'center' }}>{t.otpDemoHint}</div>
      )}
      {err && <div style={{ marginTop: 10, fontSize: 12.5, color: C.warn, textAlign: 'center' }}>{err}</div>}
      {resent && !err && (
        <div style={{ marginTop: 10, fontSize: 12.5, color: C.ok, textAlign: 'center' }}>{t.otpResent}</div>
      )}
      <button
        onClick={verify}
        disabled={!canVerify}
        style={{
          marginTop: 16, width: '100%', border: 'none', background: canVerify ? C.accent : C.disabled,
          color: C.card, borderRadius: 10, padding: 16, fontSize: 16, fontWeight: 600,
          cursor: canVerify ? 'pointer' : 'default', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}
      >
        {busy ? t.loading : t.otpVerify}
        <Icon name="arrow_back" size={20} />
      </button>
      <button
        onClick={resend}
        disabled={busy}
        style={{ marginTop: 12, width: '100%', border: 'none', background: 'none', color: C.accent, fontSize: 13.5, fontWeight: 500, cursor: 'pointer' }}
      >
        {t.otpResend}
      </button>
    </div>
  )
}
