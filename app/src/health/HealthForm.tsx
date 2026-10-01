import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../components/Icon'
import { ErrLine, Field, PrimaryBtn, inputStyle } from '../components/ui'
import { errMsg, type Dict, type Lang } from '../i18n'
import { api } from '../lib/api'
import { iso } from '../lib/dates'
import { displayPhone } from '../lib/phone'
import { C } from '../lib/theme'
import type { HealthAnswers, HealthForm, Profile, YesNo } from '../lib/types'
import { AREA_ORDER, COND_ORDER, HEALTH, JOINT_ORDER, SPINE_ORDER } from './text'

// ---------------------------------------------------------------- data

export function emptyAnswers(name: string, phone: string): HealthAnswers {
  return {
    full_name: name, birth_date: '', phone, exercises_regularly: null,
    has_pain: null, pain_areas: [], pain_other: '', pain_level: null, pain_since: '',
    spine_conditions: [], spine_details: '',
    has_injury: null, injury_type: '', injury_area: '', injury_when: '', injury_limits: null,
    joint_issues: [], joint_other: '',
    conditions: [], conditions_other: '', conditions_details: '',
    pregnant: null, postpartum_12m: null, birth_date_approx: '', pregnancy_complications: null, pregnancy_details: '',
    medication: null, medication_details: '', doctor_restriction: null, doctor_details: '',
    other_info: null, other_details: '',
  }
}

const real = (arr: string[]) => arr.some((x) => x !== 'none')

/** What the trainer should glance at before the class — a summary for the
 *  roster marker, derived from the answers, never typed by hand. */
export function computeFlags(a: HealthAnswers): string[] {
  const f: string[] = []
  if (a.has_pain) f.push('pain')
  if (real(a.spine_conditions)) f.push('spine')
  if (a.has_injury) f.push('injury')
  if (real(a.joint_issues)) f.push('joints')
  if (real(a.conditions)) f.push('conditions')
  if (a.pregnant) f.push('pregnant')
  if (a.postpartum_12m) f.push('postpartum')
  if (a.medication) f.push('medication')
  if (a.doctor_restriction) f.push('doctor_restriction')
  if (a.other_info) f.push('other')
  return f
}

/** "12.4.1992" from an ISO date */
function fmtDate(s: string | null | undefined): string {
  if (!s) return ''
  const [y, m, d] = s.slice(0, 10).split('-').map(Number)
  return d && m && y ? iso(`${d}.${m}.${y}`) : s
}

// ---------------------------------------------------------------- small controls

function Chip({ on, label, onClick, tone }: { on: boolean; label: string; onClick: () => void; tone?: 'warn' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      style={{
        border: '1px solid ' + (on ? (tone === 'warn' ? C.warn : C.ink) : C.line),
        background: on ? (tone === 'warn' ? C.warnSoft : C.ink) : C.card,
        color: on ? (tone === 'warn' ? C.warn : C.card) : C.ink,
        borderRadius: 10, padding: '9px 14px', fontSize: 13.5, cursor: 'pointer', textAlign: 'start',
      }}
    >
      {label}
    </button>
  )
}

function YesNoRow({ label, value, onChange, h, noLabel }: { label: string; value: YesNo; onChange: (v: boolean) => void; h: (typeof HEALTH)['he']; noLabel?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.5, marginBottom: 8 }}>{label}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Chip on={value === false} label={noLabel ?? h.no} onClick={() => onChange(false)} />
        <Chip on={value === true} label={h.yes} onClick={() => onChange(true)} />
      </div>
    </div>
  )
}

/** Multi-select; 'none' is exclusive with everything else */
function Checks({ options, order, values, onChange }: { options: Record<string, string>; order: string[]; values: string[]; onChange: (v: string[]) => void }) {
  const toggle = (code: string) => {
    if (code === 'none') return onChange(values.includes('none') ? [] : ['none'])
    const next = values.filter((x) => x !== 'none')
    onChange(next.includes(code) ? next.filter((x) => x !== code) : [...next, code])
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {order.map((code) => (
        <Chip key={code} on={values.includes(code)} label={options[code]} onClick={() => toggle(code)} />
      ))}
    </div>
  )
}

function PainScale({ value, onChange }: { value: number | null; onChange: (v: number) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} dir="ltr">
      {Array.from({ length: 11 }, (_, n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          aria-pressed={value === n}
          style={{
            width: 34, height: 34, borderRadius: 10, border: '1px solid ' + (value === n ? C.ink : C.line),
            background: value === n ? C.ink : C.card, color: value === n ? C.card : C.ink,
            fontSize: 13.5, fontWeight: 600, cursor: 'pointer', fontVariantNumeric: 'tabular-nums',
          }}
        >
          {n}
        </button>
      ))}
    </div>
  )
}

/** Finger signature. Canvas is sized to its CSS box × DPR once; a resize
 *  after drawing would blank it, so the pad keeps a fixed height. */
function SignaturePad({ hint, clearLabel, onChange }: { hint: string; clearLabel: string; onChange: (dataUrl: string | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    const c = ref.current!
    const dpr = window.devicePixelRatio || 1
    const rect = c.getBoundingClientRect()
    c.width = Math.round(rect.width * dpr)
    c.height = Math.round(rect.height * dpr)
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.lineWidth = 2.2
    g.lineCap = 'round'
    g.lineJoin = 'round'
    g.strokeStyle = C.ink
  }, [])

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = ref.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    ref.current!.setPointerCapture(e.pointerId)
    drawing.current = true
    last.current = pos(e)
  }
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return
    const g = ref.current!.getContext('2d')!
    const p = pos(e)
    g.beginPath()
    g.moveTo(last.current.x, last.current.y)
    g.lineTo(p.x, p.y)
    g.stroke()
    last.current = p
    if (!dirty) setDirty(true)
  }
  const up = () => {
    if (!drawing.current) return
    drawing.current = false
    last.current = null
    onChange(ref.current!.toDataURL('image/png'))
  }
  const clear = () => {
    const c = ref.current!
    const g = c.getContext('2d')!
    g.save()
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, c.width, c.height)
    g.restore()
    setDirty(false)
    onChange(null)
  }

  return (
    <div style={{ position: 'relative' }}>
      <canvas
        ref={ref}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onPointerLeave={up}
        style={{ width: '100%', height: 150, display: 'block', background: '#fff', border: '1.5px solid ' + C.disabled, borderRadius: 12, touchAction: 'none' }}
      />
      {!dirty && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.disabled, fontSize: 13, pointerEvents: 'none' }}>
          {hint}
        </div>
      )}
      <div style={{ position: 'absolute', bottom: 6, insetInlineStart: 8, borderBottom: '1px solid ' + C.line, width: '60%', pointerEvents: 'none' }} />
      <button
        type="button"
        onClick={clear}
        style={{ position: 'absolute', top: 6, insetInlineEnd: 6, border: '1px solid ' + C.line, background: C.card, color: C.muted, borderRadius: 10, padding: '4px 10px', fontSize: 11.5, cursor: 'pointer' }}
      >
        {clearLabel}
      </button>
    </div>
  )
}

function Section({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <div style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: '14px 14px 6px', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ width: 26, height: 26, borderRadius: 10, background: C.accentSoft, color: C.ink, fontSize: 12.5, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{iso(n)}</span>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{title}</div>
      </div>
      {children}
    </div>
  )
}

function Q({ children }: { children: ReactNode }) {
  return <div style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.5, marginBottom: 8 }}>{children}</div>
}

// ---------------------------------------------------------------- the form

export function HealthFormScreen({
  t, lang, profile, onDone,
}: {
  t: Dict
  lang: Lang
  profile: Profile
  onDone: (form: HealthForm) => void
}) {
  const h = HEALTH[lang]
  const [a, setA] = useState<HealthAnswers>(() => emptyAnswers(profile.full_name ?? '', displayPhone(profile.phone)))
  const [consentName, setConsentName] = useState(profile.full_name ?? '')
  const [signature, setSignature] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const set = <K extends keyof HealthAnswers>(k: K, v: HealthAnswers[K]) => setA((p) => ({ ...p, [k]: v }))

  const submit = async () => {
    if (a.full_name.trim().length < 2) return setErr(h.errors.name)
    if (!a.birth_date) return setErr(h.errors.birth)
    const yn: YesNo[] = [a.exercises_regularly, a.has_pain, a.has_injury, a.pregnant, a.postpartum_12m, a.medication, a.doctor_restriction, a.other_info]
    if (yn.some((v) => v === null) || !a.spine_conditions.length || !a.joint_issues.length || !a.conditions.length) return setErr(h.errors.answerAll)
    if (a.has_pain && a.pain_level === null) return setErr(h.errors.painLevel)
    if (consentName.trim().length < 2) return setErr(h.errors.name)
    if (!signature) return setErr(h.errors.signature)
    if (!checked) return setErr(h.errors.check)
    setErr(null)
    setBusy(true)
    const answers: HealthAnswers = { ...a, full_name: a.full_name.trim() }
    const flags = computeFlags(answers)
    const r = await api.submitHealthForm({ answers, flags, consentName: consentName.trim(), signaturePng: signature, lang })
    setBusy(false)
    if (!r.ok) return setErr(errMsg(t, r.error))
    onDone({
      id: r.form_id ?? 'local', user_id: '', form_version: 1, lang, answers, flags,
      consent_name: consentName.trim(), signature_png: signature, submitted_at: new Date().toISOString(),
    })
  }

  const today = new Date()

  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ fontSize: 19, fontWeight: 600, color: C.ink, lineHeight: 1.35, marginBottom: 6 }}>{h.title}</div>
      <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 16 }}>{h.intro}</div>

      <Section n={1} title={h.s1.title}>
        <Field label={h.s1.fullName}>
          <input value={a.full_name} onChange={(e) => set('full_name', e.target.value)} style={inputStyle} />
        </Field>
        <Field label={h.s1.birthDate}>
          <input type="date" value={a.birth_date} max={today.toISOString().slice(0, 10)} onChange={(e) => set('birth_date', e.target.value)} dir="ltr" style={inputStyle} />
        </Field>
        <Field label={h.s1.phone}>
          <input value={a.phone} readOnly dir="ltr" style={{ ...inputStyle, background: C.bg, color: C.muted }} />
        </Field>
        <YesNoRow label={h.s1.exercises} value={a.exercises_regularly} onChange={(v) => set('exercises_regularly', v)} h={h} />
      </Section>

      <Section n={2} title={h.s2.title}>
        <YesNoRow label={h.s2.q} value={a.has_pain} onChange={(v) => set('has_pain', v)} h={h} noLabel={h.s2.noPain} />
        {a.has_pain && (
          <>
            <Q>{h.s2.areasQ}</Q>
            <div style={{ marginBottom: 12 }}>
              <Checks options={h.s2.areas} order={AREA_ORDER} values={a.pain_areas} onChange={(v) => set('pain_areas', v)} />
            </div>
            {a.pain_areas.includes('other') && (
              <Field label={h.s2.areas.other}>
                <input value={a.pain_other} onChange={(e) => set('pain_other', e.target.value)} style={inputStyle} />
              </Field>
            )}
            <Q>{h.s2.level}</Q>
            <div style={{ marginBottom: 12 }}>
              <PainScale value={a.pain_level} onChange={(v) => set('pain_level', v)} />
            </div>
            <Field label={h.s2.since}>
              <input value={a.pain_since} onChange={(e) => set('pain_since', e.target.value)} style={inputStyle} />
            </Field>
          </>
        )}
      </Section>

      <Section n={3} title={h.s3.title}>
        <Q>{h.s3.q}</Q>
        <div style={{ marginBottom: 12 }}>
          <Checks options={h.s3.options} order={SPINE_ORDER} values={a.spine_conditions} onChange={(v) => set('spine_conditions', v)} />
        </div>
        {real(a.spine_conditions) && (
          <Field label={h.s3.details + ' ' + t.optional}>
            <input value={a.spine_details} onChange={(e) => set('spine_details', e.target.value)} style={inputStyle} />
          </Field>
        )}
      </Section>

      <Section n={4} title={h.s4.title}>
        <YesNoRow label={h.s4.q} value={a.has_injury} onChange={(v) => set('has_injury', v)} h={h} />
        {a.has_injury && (
          <>
            <Field label={h.s4.type}>
              <input value={a.injury_type} onChange={(e) => set('injury_type', e.target.value)} style={inputStyle} />
            </Field>
            <Field label={h.s4.area}>
              <input value={a.injury_area} onChange={(e) => set('injury_area', e.target.value)} style={inputStyle} />
            </Field>
            <Field label={h.s4.when}>
              <input value={a.injury_when} onChange={(e) => set('injury_when', e.target.value)} style={inputStyle} />
            </Field>
            <YesNoRow label={h.s4.limits} value={a.injury_limits} onChange={(v) => set('injury_limits', v)} h={h} />
          </>
        )}
      </Section>

      <Section n={5} title={h.s5.title}>
        <Q>{h.s5.q}</Q>
        <div style={{ marginBottom: 12 }}>
          <Checks options={h.s5.options} order={JOINT_ORDER} values={a.joint_issues} onChange={(v) => set('joint_issues', v)} />
        </div>
        {a.joint_issues.includes('other') && (
          <Field label={h.other}>
            <input value={a.joint_other} onChange={(e) => set('joint_other', e.target.value)} style={inputStyle} />
          </Field>
        )}
      </Section>

      <Section n={6} title={h.s6.title}>
        <Q>{h.s6.q}</Q>
        <div style={{ marginBottom: 12 }}>
          <Checks options={h.s6.options} order={COND_ORDER} values={a.conditions} onChange={(v) => set('conditions', v)} />
        </div>
        {a.conditions.includes('other') && (
          <Field label={h.s6.options.other}>
            <input value={a.conditions_other} onChange={(e) => set('conditions_other', e.target.value)} style={inputStyle} />
          </Field>
        )}
        {real(a.conditions) && (
          <Field label={h.s6.details}>
            <input value={a.conditions_details} onChange={(e) => set('conditions_details', e.target.value)} style={inputStyle} />
          </Field>
        )}
      </Section>

      <Section n={7} title={h.s7.title}>
        <YesNoRow label={h.s7.pregnant} value={a.pregnant} onChange={(v) => set('pregnant', v)} h={h} />
        <YesNoRow label={h.s7.postpartum} value={a.postpartum_12m} onChange={(v) => set('postpartum_12m', v)} h={h} />
        {a.postpartum_12m && (
          <Field label={h.s7.birthApprox}>
            <input type="date" value={a.birth_date_approx} onChange={(e) => set('birth_date_approx', e.target.value)} dir="ltr" style={inputStyle} />
          </Field>
        )}
        {(a.pregnant || a.postpartum_12m) && (
          <>
            <YesNoRow label={h.s7.complications} value={a.pregnancy_complications} onChange={(v) => set('pregnancy_complications', v)} h={h} />
            {a.pregnancy_complications && (
              <Field label={h.details}>
                <input value={a.pregnancy_details} onChange={(e) => set('pregnancy_details', e.target.value)} style={inputStyle} />
              </Field>
            )}
          </>
        )}
      </Section>

      <Section n={8} title={h.s8.title}>
        <YesNoRow label={h.s8.meds} value={a.medication} onChange={(v) => set('medication', v)} h={h} />
        {a.medication && (
          <Field label={h.details}>
            <input value={a.medication_details} onChange={(e) => set('medication_details', e.target.value)} style={inputStyle} />
          </Field>
        )}
        <YesNoRow label={h.s8.doctor} value={a.doctor_restriction} onChange={(v) => set('doctor_restriction', v)} h={h} />
        {a.doctor_restriction && (
          <Field label={h.ifYes}>
            <input value={a.doctor_details} onChange={(e) => set('doctor_details', e.target.value)} style={inputStyle} />
          </Field>
        )}
      </Section>

      <Section n={9} title={h.s9.title}>
        <YesNoRow label={h.s9.q} value={a.other_info} onChange={(v) => set('other_info', v)} h={h} />
        {a.other_info && (
          <Field label={h.details}>
            <textarea value={a.other_details} onChange={(e) => set('other_details', e.target.value)} rows={3} style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }} />
          </Field>
        )}
      </Section>

      {/* declaration */}
      <div style={{ background: C.accentSoft, border: '1px solid ' + C.line, borderRadius: 12, padding: 14, marginBottom: 10 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.ink, marginBottom: 10 }}>{h.consent.title}</div>
        {h.consent.p.map((p, i) => (
          <div key={i} style={{ fontSize: 13, color: C.ink, lineHeight: 1.65, marginBottom: 8 }}>{p}</div>
        ))}
        <div style={{ height: 6 }} />
        <Field label={h.consent.name}>
          <input value={consentName} onChange={(e) => setConsentName(e.target.value)} style={inputStyle} />
        </Field>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 5 }}>{h.consent.signature}</div>
        <div style={{ marginBottom: 12 }}>
          <SignaturePad hint={h.consent.signHint} clearLabel={h.consent.clear} onChange={setSignature} />
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 12 }}>
          {h.consent.date}: {iso(`${today.getDate()}.${today.getMonth() + 1}.${today.getFullYear()}`)}
        </div>
        <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 6 }}>
          <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ width: 20, height: 20, marginTop: 2, accentColor: C.ink }} />
          <span style={{ fontSize: 13.5, color: C.ink, lineHeight: 1.55 }}>{h.consent.check}</span>
        </label>
      </div>

      {err && <ErrLine text={err} />}
      <PrimaryBtn label={busy ? t.loading : h.consent.submit} disabled={busy} onClick={submit} />
    </div>
  )
}

// ---------------------------------------------------------------- read-only view (client + admin)

function Row({ k, v }: { k: string; v: ReactNode }) {
  if (v === '' || v === null || v === undefined) return null
  return (
    <div style={{ display: 'flex', gap: 10, fontSize: 13, lineHeight: 1.5, padding: '5px 0', borderBottom: '1px solid ' + C.line }}>
      <div style={{ color: C.muted, flex: '0 0 42%' }}>{k}</div>
      <div style={{ color: C.ink, flex: 1 }}>{v}</div>
    </div>
  )
}

export function HealthView({ lang, form, name }: { lang: Lang; form: HealthForm; name?: string | null }) {
  const h = HEALTH[lang]
  const a = form.answers
  const yn = (v: YesNo) => (v === null ? '—' : v ? h.yes : h.no)
  const labels = (opts: Record<string, string>, codes: string[], otherText?: string) =>
    codes.length === 0 ? '—' : codes.map((c) => (c === 'other' && otherText ? `${opts[c]}: ${otherText}` : opts[c] ?? c)).join(' · ')

  const block = (title: string, rows: ReactNode) => (
    <div style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: '10px 14px', marginBottom: 8 }}>
      <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink, marginBottom: 4 }}>{title}</div>
      {rows}
    </div>
  )

  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {form.flags.length === 0 ? (
          <span style={{ background: C.okSoft, color: C.ok, borderRadius: 10, padding: '5px 10px', fontSize: 12, fontWeight: 600 }}>{h.view.noFlags}</span>
        ) : (
          form.flags.map((f) => (
            <span key={f} style={{ background: C.warnSoft, color: C.warn, borderRadius: 10, padding: '5px 10px', fontSize: 12, fontWeight: 600 }}>{h.flags[f] ?? f}</span>
          ))
        )}
      </div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
        {h.view.submitted.replace('{d}', fmtDate(form.submitted_at))}
        {name ? ' · ' + name : ''}
      </div>

      {block(h.s1.title, <>
        <Row k={h.s1.fullName} v={a.full_name} />
        <Row k={h.s1.birthDate} v={fmtDate(a.birth_date)} />
        <Row k={h.s1.phone} v={<span dir="ltr">{a.phone}</span>} />
        <Row k={h.s1.exercises} v={yn(a.exercises_regularly)} />
      </>)}
      {block(h.s2.title, a.has_pain ? <>
        <Row k={h.s2.areasQ} v={labels(h.s2.areas, a.pain_areas, a.pain_other)} />
        <Row k={h.s2.level} v={a.pain_level === null ? '—' : iso(a.pain_level) + ' / 10'} />
        <Row k={h.s2.since} v={a.pain_since} />
      </> : <Row k={h.s2.q} v={a.has_pain === null ? '—' : h.s2.noPain} />)}
      {block(h.s3.title, <>
        <Row k={h.s3.q} v={labels(h.s3.options, a.spine_conditions)} />
        <Row k={h.s3.details} v={a.spine_details} />
      </>)}
      {block(h.s4.title, a.has_injury ? <>
        <Row k={h.s4.type} v={a.injury_type} />
        <Row k={h.s4.area} v={a.injury_area} />
        <Row k={h.s4.when} v={a.injury_when} />
        <Row k={h.s4.limits} v={yn(a.injury_limits)} />
      </> : <Row k={h.s4.q} v={yn(a.has_injury)} />)}
      {block(h.s5.title, <Row k={h.s5.q} v={labels(h.s5.options, a.joint_issues, a.joint_other)} />)}
      {block(h.s6.title, <>
        <Row k={h.s6.q} v={labels(h.s6.options, a.conditions, a.conditions_other)} />
        <Row k={h.details} v={a.conditions_details} />
      </>)}
      {block(h.s7.title, <>
        <Row k={h.s7.pregnant} v={yn(a.pregnant)} />
        <Row k={h.s7.postpartum} v={yn(a.postpartum_12m) + (a.postpartum_12m && a.birth_date_approx ? ' · ' + fmtDate(a.birth_date_approx) : '')} />
        {(a.pregnant || a.postpartum_12m) && <Row k={h.s7.complications} v={yn(a.pregnancy_complications) + (a.pregnancy_details ? ' · ' + a.pregnancy_details : '')} />}
      </>)}
      {block(h.s8.title, <>
        <Row k={h.s8.meds} v={yn(a.medication) + (a.medication_details ? ' · ' + a.medication_details : '')} />
        <Row k={h.s8.doctor} v={yn(a.doctor_restriction) + (a.doctor_details ? ' · ' + a.doctor_details : '')} />
      </>)}
      {block(h.s9.title, <Row k={h.s9.q} v={a.other_info ? a.other_details || h.yes : yn(a.other_info)} />)}

      <div style={{ background: C.accentSoft, border: '1px solid ' + C.line, borderRadius: 12, padding: 14 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink, marginBottom: 6 }}>{h.consent.title}</div>
        <div style={{ fontSize: 12.5, color: C.ink, lineHeight: 1.5, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
          <Icon name="check_circle" size={16} color={C.ok} fill />
          {h.view.declared} · {h.view.signedBy.replace('{n}', form.consent_name)}
        </div>
        {form.signature_png && (
          <img src={form.signature_png} alt="" style={{ width: '100%', maxHeight: 120, objectFit: 'contain', background: '#fff', border: '1px solid ' + C.line, borderRadius: 10 }} />
        )}
      </div>
    </div>
  )
}

/** Marker for admin lists: missing / clean / needs attention (with count) */
export function HealthMarker({ lang, flags, formAt, onClick }: { lang: Lang; flags: string[] | null | undefined; formAt: string | null | undefined; onClick?: () => void }) {
  const h = HEALTH[lang]
  const state = !formAt ? 'missing' : flags && flags.length ? 'flags' : 'clean'
  const color = state === 'missing' ? C.disabled : state === 'flags' ? C.warn : C.ok
  const title = state === 'missing' ? h.view.missing : state === 'flags' ? `${h.view.flags}: ${flags!.map((f) => h.flags[f] ?? f).join(', ')}` : h.view.noFlags
  const body = (
    <>
      <Icon name={state === 'missing' ? 'assignment_late' : state === 'flags' ? 'health_and_safety' : 'verified'} size={20} color={color} fill={state === 'flags'} />
      {state === 'flags' && <span style={{ fontSize: 11.5, fontWeight: 600 }}>{iso(flags!.length)}</span>}
    </>
  )
  const look: React.CSSProperties = { border: 'none', background: 'none', padding: 4, display: 'flex', alignItems: 'center', gap: 3, color }
  // Without an action it is only a marker — and often sits inside a row that
  // is itself a button, where a nested <button> is invalid HTML.
  if (!onClick) return <span role="img" title={title} aria-label={title} style={look}>{body}</span>
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      title={title}
      aria-label={title}
      style={{ ...look, cursor: 'pointer' }}
    >
      {body}
    </button>
  )
}
