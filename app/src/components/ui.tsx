import type { CSSProperties, ReactNode } from 'react'
import type { Dict } from '../i18n'
import { iso } from '../lib/dates'
import { C } from '../lib/theme'

/** Shared primitives — both apps render the same form rows, empty states and
 *  date strings, and a second copy is a second palette waiting to drift. */

export const inputStyle: CSSProperties = {
  width: '100%', border: '1.5px solid ' + C.disabled, background: '#fff', borderRadius: 12,
  padding: '12px 14px', fontSize: 15, color: C.ink,
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  )
}

export function ErrLine({ text }: { text: string }) {
  return <div style={{ fontSize: 12.5, color: C.warn, marginBottom: 10 }}>{text}</div>
}

export function PrimaryBtn({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%', border: 'none', background: disabled ? C.disabled : C.accent, color: '#fff',
        borderRadius: 10, padding: 14, fontSize: 15, fontWeight: 600,
        cursor: disabled ? 'default' : 'pointer', marginTop: 4,
      }}
    >
      {label}
    </button>
  )
}

export function SectionTitle({ text }: { text: string }) {
  return <div style={{ fontSize: 13, fontWeight: 600, color: C.muted, margin: '6px 2px 8px' }}>{text}</div>
}

export function Empty({ text }: { text: string }) {
  return (
    <div style={{ background: C.card, border: '1px dashed ' + C.line, borderRadius: 12, padding: '26px 14px', textAlign: 'center', color: C.muted, fontSize: 13 }}>
      {text}
    </div>
  )
}

export function RetryBox({ t, onRetry }: { t: Dict; onRetry: () => void }) {
  return (
    <div style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: 20, textAlign: 'center' }}>
      <div style={{ fontSize: 13, color: C.warn, marginBottom: 10 }}>{t.errors.network}</div>
      <button
        onClick={onRetry}
        style={{ border: '1px solid ' + C.accent, background: 'none', color: C.accent, borderRadius: 10, padding: '8px 18px', fontSize: 13, cursor: 'pointer' }}
      >
        {t.retry}
      </button>
    </div>
  )
}

/** "2026-09-14" -> "14.9" */
export function fmtShort(dateISO: string): string {
  const [, m, d] = dateISO.split('-')
  return `${Number(d)}.${Number(m)}`
}

export function longDate(t: Dict, dateISO: string): string {
  const [y, m, d] = dateISO.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return `${t.daysFull[dt.getDay()]} · ${iso(d)} ${t.months[m - 1]}`
}
