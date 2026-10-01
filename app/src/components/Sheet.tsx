import type { ReactNode } from 'react'
import { C } from '../lib/theme'
import { Icon } from './Icon'

/** Bottom sheet. Backdrop closes; the panel stops propagation so an inner tap
 *  never closes it. Bottom padding uses calc() — a bare env() set through a
 *  React inline style is dropped by WebKit. */
export function Sheet({
  open,
  onClose,
  title,
  closeLabel,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  /** accessible name for the close button — pass t.close */
  closeLabel: string
  children: ReactNode
}) {
  if (!open) return null
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: C.scrim, zIndex: 60,
        display: 'flex', alignItems: 'flex-end',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: C.card, width: '100%', borderRadius: '20px 20px 0 0',
          maxHeight: '88vh', overflowY: 'auto', animation: 'sheetUp .26s ease',
          paddingBottom: 'calc(24px + env(safe-area-inset-bottom))',
        }}
      >
        <div
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '16px 18px 10px', position: 'sticky', top: 0, background: C.card,
          }}
        >
          <div style={{ fontSize: 17, fontWeight: 600, color: C.ink }}>{title}</div>
          <button
            onClick={onClose}
            aria-label={closeLabel}
            style={{ border: 'none', background: 'none', color: C.muted, cursor: 'pointer', padding: 4, display: 'flex' }}
          >
            <Icon name="close" size={22} />
          </button>
        </div>
        <div style={{ padding: '0 18px' }}>{children}</div>
      </div>
    </div>
  )
}
