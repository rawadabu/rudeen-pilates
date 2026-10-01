import { useCallback, useEffect, useMemo, useState } from 'react'
import { Icon } from '../components/Icon'
import { Logo } from '../components/Logo'
import { OtpPanel } from '../components/OtpPanel'
import { PushCard } from '../components/PushCard'
import { Sheet } from '../components/Sheet'
import {
  Empty, ErrLine, Field, PrimaryBtn, RetryBox, SectionTitle, fmtShort, inputStyle, longDate,
} from '../components/ui'
import { DICT, errMsg, type Dict, type Lang } from '../i18n'
import { api } from '../lib/api'
import { dateOf, hhmm, iso, toISODate, weekLabel } from '../lib/dates'
import { displayPhone, normalizePhone } from '../lib/phone'
import { currentEndpoint, forgetNativeEndpoint } from '../lib/push'
import { C } from '../lib/theme'
import type { AuthUser, ClassRow, Client, HealthForm, Notification, Pack, Plan, Profile, PurchaseRequest, RosterRow, RpcResult, StudioInfo, TemplateDraft } from '../lib/types'
import { HealthMarker, HealthView } from '../health/HealthForm'

type Tab = 'sched' | 'clients' | 'shop' | 'rem'

const HEALTH_READONLY: Record<Lang, string> = {
  he: 'מולא על ידי המתאמנת באפליקציה — לקריאה בלבד. עדכון נעשה רק על ידה.',
  ar: 'عبّأته المتدربة بالتطبيق — للقراءة فقط. التحديث بس من طرفها.',
}
type Toast = { msg: string; kind: 'ok' | 'bad' }


export function AdminApp() {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('lang') as Lang) || 'he')
  const t = DICT[lang]
  useEffect(() => {
    localStorage.setItem('lang', lang)
    document.documentElement.lang = lang
  }, [lang])

  const [user, setUser] = useState<AuthUser | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [authReady, setAuthReady] = useState(false)

  const [tab, setTab] = useState<Tab>('sched')
  const [week, setWeek] = useState(0)
  const [classes, setClasses] = useState<ClassRow[]>([])
  const [roster, setRoster] = useState<RosterRow[]>([])
  const [rem, setRem] = useState<RosterRow[]>([])
  const [clients, setClients] = useState<Client[]>([])
  const [requests, setRequests] = useState<PurchaseRequest[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [info, setInfo] = useState<StudioInfo | null>(null)
  const [announcements, setAnnouncements] = useState<Notification[]>([])
  const [weekErr, setWeekErr] = useState(false)
  const [remErr, setRemErr] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)

  const [openClass, setOpenClass] = useState<string | null>(null)
  const [grantFor, setGrantFor] = useState<Client | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [weekOpen, setWeekOpen] = useState(false)
  const [newClientOpen, setNewClientOpen] = useState(false)
  const [openReq, setOpenReq] = useState<PurchaseRequest | null>(null)
  const [editPlan, setEditPlan] = useState<Plan | 'new' | null>(null)
  const [healthFor, setHealthFor] = useState<{ userId: string; name: string } | null>(null)
  const [healthForm, setHealthForm] = useState<HealthForm | null | 'loading'>(null)

  const say = useCallback((msg: string, kind: Toast['kind'] = 'ok') => {
    setToast({ msg, kind })
    window.setTimeout(() => setToast(null), 4000)
  }, [])

  useEffect(() => {
    api.getUser().then((u) => {
      setUser(u)
      setAuthReady(true)
    })
    return api.onAuthChange((u) => {
      setUser(u)
      setAuthReady(true)
    })
  }, [])

  useEffect(() => {
    if (!user) return setProfile(null)
    api.getMyProfile().then(setProfile).catch(() => setProfile(null))
  }, [user])

  const isAdmin = !!profile?.is_admin
  const fromISO = toISODate(dateOf(week, 0))
  const toISO = toISODate(dateOf(week, 6))
  const today = toISODate(new Date())
  const tomorrow = toISODate(dateOf(0, new Date().getDay() + 1))

  // Deliberately three independent loads: one failing tab must not blank the
  // other two (a shared Promise.all took the whole dashboard down in ARD).
  const loadWeek = useCallback(async () => {
    if (!isAdmin) return
    try {
      const [c, r] = await Promise.all([api.fetchClasses(fromISO, toISO), api.fetchRoster(fromISO, toISO)])
      setClasses(c)
      setRoster(r)
      setWeekErr(false)
    } catch {
      setWeekErr(true)
    }
  }, [isAdmin, fromISO, toISO])

  const loadRem = useCallback(async () => {
    if (!isAdmin) return
    try {
      setRem(await api.fetchRoster(today, tomorrow))
      setRemErr(false)
    } catch {
      setRemErr(true)
    }
  }, [isAdmin, today, tomorrow])

  const loadClients = useCallback(async () => {
    if (!isAdmin) return
    try {
      setClients(await api.fetchClients())
    } catch {
      /* keep previous list */
    }
  }, [isAdmin])

  const loadShop = useCallback(() => {
    if (!isAdmin) return
    api.fetchPurchaseRequests().then(setRequests).catch(() => {})
    api.fetchPlans().then(setPlans).catch(() => {})
    api.fetchStudioInfo().then(setInfo).catch(() => {})
    api.fetchAnnouncements().then(setAnnouncements).catch(() => {})
  }, [isAdmin])

  const refreshAll = useCallback(() => {
    loadWeek()
    loadRem()
    loadClients()
    loadShop()
  }, [loadWeek, loadRem, loadClients, loadShop])

  useEffect(() => {
    loadWeek()
  }, [loadWeek])
  useEffect(() => {
    loadRem()
    loadClients()
    loadShop()
  }, [loadRem, loadClients, loadShop])

  useEffect(() => {
    if (!isAdmin) return
    const onVis = () => document.visibilityState === 'visible' && refreshAll()
    document.addEventListener('visibilitychange', onVis)
    const unsub = api.subscribeChanges(refreshAll)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      unsub()
    }
  }, [isAdmin, refreshAll])

  useEffect(() => {
    if (!healthFor) return
    setHealthForm('loading')
    api.adminFetchHealthForm(healthFor.userId).then(setHealthForm).catch(() => setHealthForm(null))
  }, [healthFor])

  const byClass = useMemo(() => {
    const m = new Map<string, RosterRow[]>()
    roster.forEach((r) => m.set(r.class_id, [...(m.get(r.class_id) ?? []), r]))
    return m
  }, [roster])

  const openRows = openClass ? (byClass.get(openClass) ?? []) : []
  const openRow = classes.find((c) => c.id === openClass) ?? null

  // ---- gates
  if (!authReady) {
    return <Shell t={t} lang={lang} setLang={setLang}><Empty text={t.loading} /></Shell>
  }
  if (!user) {
    return (
      <Shell t={t} lang={lang} setLang={setLang}>
        <AdminLogin t={t} onDone={async () => setProfile(await api.getMyProfile().catch(() => null))} />
      </Shell>
    )
  }
  if (profile && !isAdmin) {
    return (
      <Shell t={t} lang={lang} setLang={setLang}>
        <div style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: 22, textAlign: 'center' }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.ink, marginBottom: 6 }}>{t.adminNoAccess}</div>
          <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 16 }}>{t.adminNoAccessSub}</div>
          <button
            onClick={async () => {
              const ep = await currentEndpoint().catch(() => null)
              if (ep) api.deletePushSubscription(ep).catch(() => {})
              forgetNativeEndpoint()
              await api.signOut()
              setUser(null)
            }}
            style={{ border: '1px solid ' + C.line, background: 'none', color: C.ink, borderRadius: 10, padding: '9px 20px', fontSize: 13, cursor: 'pointer' }}
          >
            {t.logout}
          </button>
        </div>
      </Shell>
    )
  }
  if (!profile) return <Shell t={t} lang={lang} setLang={setLang}><Empty text={t.loading} /></Shell>

  // ---- stats
  const todayCount = classes.filter((c) => c.class_date === today).length
  const weekBooked = roster.filter((r) => r.status !== 'no_show').length
  const fullCount = classes.filter((c) => c.is_full).length

  const days = [0, 1, 2, 3, 4, 5, 6]
    .map((d) => toISODate(dateOf(week, d)))
    .filter((iso2) => classes.some((c) => c.class_date === iso2))
  const pendingCount = requests.filter((r) => r.status === 'pending').length

  return (
    <Shell t={t} lang={lang} setLang={setLang} nav={{ tab, setTab, pending: pendingCount }}>
      {tab === 'sched' && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
            <Stat label={t.stToday} value={todayCount} />
            <Stat label={t.stWeek} value={weekBooked} />
            <Stat label={t.stFullCls} value={fullCount} />
          </div>

          <PushCard t={t} lang={lang} title={t.notifTitle} hint={t.notifHint} say={say} />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '4px 0 10px' }}>
            <NavBtn dir="prev" disabled={week <= -1} onClick={() => setWeek(week - 1)} />
            <div style={{ fontSize: 14.5, fontWeight: 600, color: C.ink }}>{weekLabel(t.months, week)}</div>
            <NavBtn dir="next" disabled={week >= 4} onClick={() => setWeek(week + 1)} />
          </div>

          {weekErr ? (
            <RetryBox t={t} onRetry={loadWeek} />
          ) : days.length === 0 ? (
            <Empty text={t.noClasses} />
          ) : (
            days.map((d) => (
              <div key={d} style={{ marginBottom: 16 }}>
                <SectionTitle text={longDate(t, d)} />
                {classes
                  .filter((c) => c.class_date === d)
                  .map((c) => {
                    const rows = byClass.get(c.id) ?? []
                    return (
                      <button
                        key={c.id}
                        onClick={() => setOpenClass(c.id)}
                        style={{
                          width: '100%', textAlign: 'start', background: C.card,
                          border: '1px solid ' + (c.is_full ? C.accent : C.line), borderRadius: 12,
                          padding: 13, marginBottom: 8, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', gap: 12,
                        }}
                      >
                        <div style={{ fontSize: 17, fontWeight: 600, color: C.ink, minWidth: 52, fontVariantNumeric: 'tabular-nums' }}>
                          {iso(hhmm(c.start_time))}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, color: C.ink }}>{c.label || t.classDefault}</div>
                          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {rows.length === 0
                              ? t.rosterEmpty
                              : rows.map((r) => r.attendee_name || '—').join(' · ')}
                          </div>
                        </div>
                        <div
                          style={{
                            background: c.is_full ? C.accent : C.accentSoft, color: c.is_full ? '#fff' : C.accentDark,
                            borderRadius: 10, padding: '5px 11px', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap',
                          }}
                        >
                          {t.rosterCount.replace('{n}', iso(c.taken)).replace('{m}', iso(c.capacity))}
                        </div>
                      </button>
                    )
                  })}
              </div>
            ))
          )}

          <button
            onClick={() => setAddOpen(true)}
            style={{
              width: '100%', border: '1px dashed ' + C.line, background: 'none', color: C.accent,
              borderRadius: 12, padding: 14, fontSize: 13.5, cursor: 'pointer', marginTop: 4,
            }}
          >
            + {t.addClassBtn}
          </button>
          <button
            onClick={() => setWeekOpen(true)}
            style={{
              width: '100%', border: '1px solid ' + C.line, background: C.card, color: C.ink,
              borderRadius: 12, padding: 13, fontSize: 13.5, cursor: 'pointer', marginTop: 8,
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}
          >
            <Icon name="calendar_month" size={19} />
            {t.weekBtn}
          </button>
        </>
      )}

      {tab === 'clients' && (
        <ClientsTab t={t} lang={lang} clients={clients} requests={requests} onPick={setGrantFor} onOpenRequest={setOpenReq} onNew={() => setNewClientOpen(true)} />
      )}

      {tab === 'shop' && (
        <ShopAdminTab t={t} plans={plans} requests={requests} info={info} say={say} onEdit={setEditPlan} onSaved={loadShop} />
      )}

      {tab === 'rem' && (
        <>
          <AnnouncementsPanel t={t} items={announcements} say={say} onChanged={loadShop} />
          {remErr ? <RetryBox t={t} onRetry={loadRem} /> : (
            <RemindersTab t={t} rows={rem} today={today} onSent={(id) => {
              setRem((rs) => rs.map((r) => (r.booking_id === id ? { ...r, reminder_sent_at: new Date().toISOString() } : r)))
            }} />
          )}
        </>
      )}

      <Sheet closeLabel={t.close}
        open={!!openClass}
        onClose={() => setOpenClass(null)}
        title={openRow ? `${longDate(t, openRow.class_date)} · ${iso(hhmm(openRow.start_time))}` : t.rosterTitle}
      >
        {openRow && (
          <RosterSheet
            key={openRow.id}
            t={t}
            lang={lang}
            c={openRow}
            rows={openRows}
            clients={clients}
            say={say}
            onHealth={(userId, name) => setHealthFor({ userId, name })}
            onDone={() => {
              loadWeek()
              loadRem()
              loadClients()
            }}
            onClosed={() => setOpenClass(null)}
          />
        )}
      </Sheet>

      <Sheet closeLabel={t.close} open={!!grantFor} onClose={() => setGrantFor(null)} title={t.grantTitle}>
        {grantFor && (
          <GrantSheet
            t={t}
            client={grantFor}
            plans={plans}
            say={say}
            onHealth={() => setHealthFor({ userId: grantFor.id, name: grantFor.full_name || displayPhone(grantFor.phone) })}
            onDone={() => {
              setGrantFor(null)
              loadClients()
            }}
          />
        )}
      </Sheet>

      <Sheet closeLabel={t.close} open={weekOpen} onClose={() => setWeekOpen(false)} title={t.weekBtn}>
        {weekOpen && (
          <WeekSheet
            t={t}
            say={say}
            onDone={() => {
              setWeekOpen(false)
              loadWeek()
              loadRem()
            }}
          />
        )}
      </Sheet>

      <Sheet closeLabel={t.close} open={newClientOpen} onClose={() => setNewClientOpen(false)} title={t.newClientBtn}>
        {newClientOpen && (
          <NewClientSheet
            t={t}
            onDone={async (userId, existed, draft) => {
              setNewClientOpen(false)
              say(existed ? t.newClientExists : t.newClientOk)
              const list = await api.fetchClients().catch(() => clients)
              setClients(list)
              // straight on to giving her a pack
              setGrantFor(list.find((c) => c.id === userId) ?? {
                id: userId, full_name: draft.name, phone: draft.phone, is_admin: false,
                active_remaining: 0, next_expiry: null, health_flags: null, health_form_at: null,
              })
            }}
          />
        )}
      </Sheet>

      <Sheet closeLabel={t.close} open={addOpen} onClose={() => setAddOpen(false)} title={t.addClassBtn}>
        <AddClassSheet
          t={t}
          say={say}
          onDone={() => {
            setAddOpen(false)
            loadWeek()
          }}
        />
      </Sheet>

      <Sheet closeLabel={t.close} open={!!openReq} onClose={() => setOpenReq(null)} title={t.reqTitle}>
        {openReq && (
          <RequestSheet
            t={t}
            r={openReq}
            say={say}
            onDone={() => {
              setOpenReq(null)
              loadShop()
              loadClients()
            }}
          />
        )}
      </Sheet>

      <Sheet
        closeLabel={t.close}
        open={!!editPlan}
        onClose={() => setEditPlan(null)}
        title={editPlan === 'new' ? t.planAdd : t.planEdit}
      >
        {editPlan && (
          <PlanEditSheet
            t={t}
            plan={editPlan === 'new' ? null : editPlan}
            say={say}
            onDone={() => {
              setEditPlan(null)
              loadShop()
            }}
          />
        )}
      </Sheet>

      <Sheet closeLabel={t.close} open={!!healthFor} onClose={() => setHealthFor(null)} title={t.adminHealthTitle}>
        {healthFor && (
          <div style={{ paddingBottom: 8 }}>
            <div style={{ fontSize: 15, fontWeight: 600, color: C.ink, marginBottom: 8 }}>{healthFor.name}</div>
            {healthForm === 'loading' ? (
              <Empty text={t.healthLoading} />
            ) : healthForm ? (
              <>
                <HealthView lang={lang} form={healthForm} />
                <div style={{ fontSize: 11.5, color: C.muted, lineHeight: 1.5, marginTop: 10 }}>{HEALTH_READONLY[lang]}</div>
              </>
            ) : (
              <Empty text={t.healthNone} />
            )}
          </div>
        )}
      </Sheet>

      {toast && (
        <div
          style={{
            position: 'fixed', bottom: 'calc(84px + env(safe-area-inset-bottom))', left: 16, right: 16, zIndex: 70,
            background: toast.kind === 'ok' ? C.ok : C.warn, color: '#fff', borderRadius: 12,
            padding: '12px 14px', fontSize: 13.5, textAlign: 'center', boxShadow: '0 8px 24px rgba(0,0,0,.18)',
          }}
        >
          {toast.msg}
        </div>
      )}
    </Shell>
  )
}

// ---------------------------------------------------------------- shell

function Shell({
  t, lang, setLang, nav, children,
}: {
  t: Dict
  lang: Lang
  setLang: (l: Lang) => void
  nav?: { tab: Tab; setTab: (v: Tab) => void; pending?: number }
  children: React.ReactNode
}) {
  const items: [Tab, string, string][] = [
    ['sched', 'calendar_month', t.navSched],
    ['clients', 'card_membership', t.navClients],
    ['shop', 'shopping_bag', t.navShop],
    ['rem', 'notifications_active', t.navRem],
  ]
  return (
    <div style={{ minHeight: '100vh', background: C.bg, direction: 'rtl' }}>
      <div className="safe-top" style={{ background: C.ink }}>
        <div style={{ maxWidth: 620, margin: '0 auto', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
            <Logo height={30} tone="light" />
            <div style={{ fontSize: 12, color: C.disabled, borderInlineStart: '1px solid rgba(255,255,255,.2)', paddingInlineStart: 12 }}>
              {t.adminTitle}
            </div>
          </div>
          <button
            onClick={() => setLang(lang === 'he' ? 'ar' : 'he')}
            style={{ border: '1px solid rgba(255,255,255,.25)', background: 'none', color: C.card, borderRadius: 10, padding: '5px 11px', fontSize: 12, cursor: 'pointer' }}
          >
            {t.langBtn}
          </button>
          <a href="#/" style={{ color: C.accentSoft, display: 'flex' }} aria-label={t.toClient}>
            <Icon name="logout" size={20} />
          </a>
        </div>
      </div>

      {api.demo && (
        <div style={{ background: C.warnSoft, color: C.warn, fontSize: 12, padding: '8px 18px', textAlign: 'center' }}>
          {t.demoNote}
        </div>
      )}

      <div style={{ maxWidth: 620, margin: '0 auto', padding: '14px 16px 104px' }}>{children}</div>

      {nav && (
        <div
          style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, background: C.card,
            borderTop: '1px solid ' + C.line, zIndex: 40,
            paddingBottom: 'calc(6px + env(safe-area-inset-bottom))',
          }}
        >
          <div style={{ maxWidth: 620, margin: '0 auto', display: 'flex' }}>
            {items.map(([id, icon, label]) => (
              <button
                key={id}
                onClick={() => nav.setTab(id)}
                style={{
                  flex: 1, border: 'none', background: 'none', cursor: 'pointer', padding: '8px 0 4px',
                  color: nav.tab === id ? C.accent : C.muted, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', gap: 2,
                }}
              >
                <span style={{ position: 'relative', display: 'flex' }}>
                  <Icon name={icon} size={23} fill={nav.tab === id} />
                  {id === 'clients' && !!nav.pending && (
                    <span
                      style={{
                        position: 'absolute', top: -4, insetInlineEnd: -9, background: C.warn, color: '#fff',
                        borderRadius: 10, fontSize: 9.5, fontWeight: 600, padding: '1px 5px', lineHeight: 1.4,
                      }}
                    >
                      {nav.pending}
                    </span>
                  )}
                </span>
                <span style={{ fontSize: 11, fontWeight: nav.tab === id ? 600 : 400 }}>{label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ flex: 1, background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: '12px 10px', textAlign: 'center' }}>
      <div style={{ fontSize: 22, fontWeight: 600, color: C.ink }}>{iso(value)}</div>
      <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{label}</div>
    </div>
  )
}

function NavBtn({ dir, disabled, onClick }: { dir: 'prev' | 'next'; disabled: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={dir}
      style={{
        border: '1px solid ' + C.line, background: C.card, borderRadius: 10, width: 36, height: 36,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: disabled ? C.disabled : C.ink, cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <Icon name={dir === 'prev' ? 'chevron_right' : 'chevron_left'} size={22} />
    </button>
  )
}

// ---------------------------------------------------------------- login

function AdminLogin({ t, onDone }: { t: Dict; onDone: () => void }) {
  const [step, setStep] = useState<'phone' | 'otp'>('phone')
  const [raw, setRaw] = useState('')
  const [e164, setE164] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  if (step === 'otp') {
    return (
      <div style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12 }}>
        <OtpPanel
          t={t}
          phoneDisplay={displayPhone(e164)}
          busy={busy}
          onBack={() => setStep('phone')}
          onVerify={async (token) => {
            setBusy(true)
            const r = await api.verifyOtp(e164, token)
            setBusy(false)
            if (!r.ok) return errMsg(t, r.error)
            onDone()
            return null
          }}
          onResend={async () => {
            const r = await api.sendOtp(e164)
            return r.ok ? null : errMsg(t, r.error)
          }}
        />
      </div>
    )
  }

  const send = async () => {
    const p = normalizePhone(raw)
    if (!p) return setErr(t.errors.invalid_phone)
    setErr(null)
    setBusy(true)
    const r = await api.sendOtp(p)
    setBusy(false)
    if (!r.ok) return setErr(errMsg(t, r.error))
    setE164(p)
    setStep('otp')
  }

  return (
    <div style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: 18 }}>
      <div style={{ fontSize: 18, fontWeight: 600, color: C.ink, marginBottom: 4 }}>{t.adminLoginTitle}</div>
      <div style={{ fontSize: 13, color: C.muted, marginBottom: 14 }}>{t.loginSub}</div>
      <Field label={t.fPhone}>
        <input
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          placeholder={t.phonePh}
          inputMode="tel"
          dir="ltr"
          autoFocus
          style={inputStyle}
        />
      </Field>
      {err && <ErrLine text={err} />}
      <PrimaryBtn label={busy ? t.loading : t.sendCode} disabled={busy} onClick={send} />
    </div>
  )
}

// ---------------------------------------------------------------- roster

function RosterSheet({
  t, lang, c, rows, clients, say, onDone, onClosed, onHealth,
}: {
  t: Dict
  lang: Lang
  c: ClassRow
  rows: RosterRow[]
  clients: Client[]
  say: (m: string, k?: 'ok' | 'bad') => void
  onDone: () => void
  onClosed: () => void
  onHealth: (userId: string, name: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [removeFor, setRemoveFor] = useState<string | null>(null)
  const [cancelArmed, setCancelArmed] = useState(false)
  const [guestOpen, setGuestOpen] = useState(false)
  const [gName, setGName] = useState('')
  const [gPhone, setGPhone] = useState('')
  const [gErr, setGErr] = useState<string | null>(null)
  // edit this class
  const [editOpen, setEditOpen] = useState(false)
  const [eDate, setEDate] = useState(c.class_date)
  const [eTime, setETime] = useState(hhmm(c.start_time))
  const [eDur, setEDur] = useState(String(c.duration_min))
  const [eCap, setECap] = useState(String(c.capacity))
  const [eLabel, setELabel] = useState(c.label ?? '')
  const [eErr, setEErr] = useState<string | null>(null)
  // book a registered client
  const [clientOpen, setClientOpen] = useState(false)
  const [cq, setCq] = useState('')

  const run = async (fn: () => Promise<RpcResult>, okMsg?: string) => {
    setBusy(true)
    const r = await fn()
    setBusy(false)
    if (!r.ok) return say(errMsg(t, r.error, r), 'bad')
    if (okMsg) say(okMsg)
    onDone()
  }

  const saveEdit = async () => {
    const dur = Number(eDur)
    const cap = Number(eCap)
    if (!eDate || !/^\d{2}:\d{2}$/.test(eTime)) return setEErr(t.errors.invalid_input)
    if (!Number.isInteger(dur) || dur < 15 || dur > 180) return setEErr(t.errors.invalid_duration)
    if (!Number.isInteger(cap) || cap < 1 || cap > 30) return setEErr(t.errors.invalid_capacity)
    setEErr(null)
    setBusy(true)
    const r = await api.updateClass(c.id, eDate, eTime, dur, cap, eLabel.trim() || null)
    setBusy(false)
    if (!r.ok) return setEErr(errMsg(t, r.error, r))
    setEditOpen(false)
    say(r.moved ? t.classMovedOk.replace('{n}', iso(r.notified ?? 0)) : t.classUpdatedOk)
    onDone()
  }

  const inClass = new Set(rows.map((r) => r.user_id).filter(Boolean))
  const pickable = clients
    .filter((x) => !inClass.has(x.id))
    .filter((x) => {
      const s2 = cq.trim()
      if (!s2) return true
      return (x.full_name ?? '').includes(s2) || x.phone.includes(s2.replace(/[\s-]/g, ''))
    })
    .slice(0, 8)

  const addGuest = async () => {
    if (gName.trim().length < 2) return setGErr(t.errors.invalid_name)
    const phone = gPhone.trim() ? normalizePhone(gPhone) : null
    if (gPhone.trim() && !phone) return setGErr(t.errors.invalid_phone)
    setGErr(null)
    setBusy(true)
    const r = await api.bookGuest(c.id, gName.trim(), phone, null)
    setBusy(false)
    if (!r.ok) return setGErr(errMsg(t, r.error))
    setGName('')
    setGPhone('')
    setGuestOpen(false)
    say(t.guestAdded)
    onDone()
  }

  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ fontSize: 12.5, color: C.muted, marginBottom: 12 }}>
        {(c.label || t.classDefault) + ' · ' + t.rosterCount.replace('{n}', iso(rows.length)).replace('{m}', iso(c.capacity))}
      </div>

      {rows.length === 0 ? (
        <Empty text={t.rosterEmpty} />
      ) : (
        rows.map((r) => (
          <div key={r.booking_id} style={{ border: '1px solid ' + C.line, borderRadius: 12, padding: 12, marginBottom: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, color: C.ink }}>
                  {r.attendee_name || '—'}
                  {r.is_manual && <span style={{ fontSize: 11, color: C.gold, marginInlineStart: 6 }}>✎</span>}
                </div>
                {r.attendee_phone && (
                  <a
                    href={'tel:' + r.attendee_phone}
                    style={{ fontSize: 12, color: C.accent, textDecoration: 'none', direction: 'ltr', display: 'inline-block' }}
                  >
                    {displayPhone(r.attendee_phone)}
                  </a>
                )}
              </div>
              {!r.is_manual && r.user_id && (
                <HealthMarker lang={lang} flags={r.health_flags} formAt={r.health_form_at} onClick={() => onHealth(r.user_id!, r.attendee_name || '—')} />
              )}
              <StatusChip t={t} status={r.status} />
            </div>

            <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap' }}>
              <MiniBtn
                label={t.attended}
                active={r.status === 'attended'}
                onClick={() => run(() => api.setAttendance(r.booking_id, r.status === 'attended' ? 'booked' : 'attended'))}
                disabled={busy}
              />
              <MiniBtn
                label={t.noShow}
                active={r.status === 'no_show'}
                onClick={() => run(() => api.setAttendance(r.booking_id, r.status === 'no_show' ? 'booked' : 'no_show'))}
                disabled={busy}
              />
              <MiniBtn
                label={t.removeBtn}
                tone="warn"
                onClick={() => setRemoveFor(removeFor === r.booking_id ? null : r.booking_id)}
                disabled={busy}
              />
            </div>

            {removeFor === r.booking_id && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button
                  onClick={() => run(() => api.adminCancelBooking(r.booking_id, true))}
                  disabled={busy}
                  style={{ flex: 1, border: '1px solid ' + C.accent, background: C.accentSoft, color: C.accentDark, borderRadius: 10, padding: '9px 0', fontSize: 12.5, cursor: 'pointer' }}
                >
                  {t.removeRefund}
                </button>
                <button
                  onClick={() => run(() => api.adminCancelBooking(r.booking_id, false))}
                  disabled={busy}
                  style={{ flex: 1, border: '1px solid ' + C.warn, background: C.warnSoft, color: C.warn, borderRadius: 10, padding: '9px 0', fontSize: 12.5, cursor: 'pointer' }}
                >
                  {t.removeNoRefund}
                </button>
              </div>
            )}
          </div>
        ))
      )}

      {clientOpen ? (
        <div style={{ border: '1px solid ' + C.line, borderRadius: 12, padding: 12, marginTop: 10 }}>
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginBottom: 10 }}>{t.addClientHint}</div>
          <input value={cq} onChange={(e) => setCq(e.target.value)} placeholder={t.clientsSearch} style={{ ...inputStyle, marginBottom: 8 }} autoFocus />
          {pickable.length === 0 ? (
            <div style={{ fontSize: 12.5, color: C.muted, padding: '6px 2px' }}>{t.addClientNone}</div>
          ) : (
            pickable.map((x) => (
              <button
                key={x.id}
                onClick={() => run(() => api.bookClient(c.id, x.id), t.clientBookedOk).then(() => setClientOpen(false))}
                disabled={busy}
                style={{
                  width: '100%', textAlign: 'start', background: C.card, border: '1px solid ' + C.line, borderRadius: 10,
                  padding: '9px 12px', marginBottom: 6, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
                }}
              >
                <span style={{ flex: 1, fontSize: 13.5, color: C.ink }}>{x.full_name || displayPhone(x.phone)}</span>
                <span style={{ fontSize: 11.5, color: x.active_remaining > 0 ? C.muted : C.warn }}>
                  {x.active_remaining > 0 ? iso(x.active_remaining) : t.balanceNone}
                </span>
              </button>
            ))
          )}
        </div>
      ) : (
        <button
          onClick={() => setClientOpen(true)}
          disabled={c.is_full}
          style={{
            width: '100%', border: '1px dashed ' + C.line, background: 'none',
            color: c.is_full ? C.muted : C.accent, borderRadius: 12, padding: 12, fontSize: 13,
            cursor: c.is_full ? 'default' : 'pointer', marginTop: 10,
          }}
        >
          + {t.addClient}
        </button>
      )}

      {guestOpen ? (
        <div style={{ border: '1px solid ' + C.line, borderRadius: 12, padding: 12, marginTop: 10 }}>
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginBottom: 10 }}>{t.addGuestHint}</div>
          <Field label={t.guestName}>
            <input value={gName} onChange={(e) => setGName(e.target.value)} style={inputStyle} autoFocus />
          </Field>
          <Field label={t.guestPhone + ' ' + t.optional}>
            <input value={gPhone} onChange={(e) => setGPhone(e.target.value)} placeholder={t.phonePh} inputMode="tel" dir="ltr" style={inputStyle} />
          </Field>
          {gErr && <ErrLine text={gErr} />}
          <PrimaryBtn label={busy ? t.loading : t.addGuestSave} disabled={busy} onClick={addGuest} />
        </div>
      ) : (
        <button
          onClick={() => setGuestOpen(true)}
          disabled={c.is_full}
          style={{
            width: '100%', border: '1px dashed ' + C.line, background: 'none',
            color: c.is_full ? C.muted : C.accent, borderRadius: 12, padding: 12, fontSize: 13,
            cursor: c.is_full ? 'default' : 'pointer', marginTop: 10,
          }}
        >
          + {t.addGuest}
        </button>
      )}

      {editOpen ? (
        <div style={{ border: '1px solid ' + C.line, borderRadius: 12, padding: 12, marginTop: 16 }}>
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginBottom: 10 }}>{t.editClassHint}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Field label={t.addClassDate}>
                <input type="date" value={eDate} onChange={(e) => setEDate(e.target.value)} dir="ltr" style={inputStyle} />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label={t.addClassTime}>
                <input type="time" value={eTime} onChange={(e) => setETime(e.target.value)} dir="ltr" style={inputStyle} />
              </Field>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <Field label={t.addClassLen}>
                <input value={eDur} onChange={(e) => setEDur(e.target.value.replace(/\D/g, ''))} inputMode="numeric" dir="ltr" style={inputStyle} />
              </Field>
            </div>
            <div style={{ flex: 1 }}>
              <Field label={t.addClassCap}>
                <input value={eCap} onChange={(e) => setECap(e.target.value.replace(/\D/g, ''))} inputMode="numeric" dir="ltr" style={inputStyle} />
              </Field>
            </div>
          </div>
          <Field label={t.addClassLabel}>
            <input value={eLabel} onChange={(e) => setELabel(e.target.value)} style={inputStyle} />
          </Field>
          {eErr && <ErrLine text={eErr} />}
          <PrimaryBtn label={busy ? t.loading : t.editClassSave} disabled={busy} onClick={saveEdit} />
        </div>
      ) : (
        <button
          onClick={() => setEditOpen(true)}
          style={{
            width: '100%', marginTop: 16, border: '1px solid ' + C.line, background: C.card, color: C.ink,
            borderRadius: 12, padding: 12, fontSize: 13, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}
        >
          <Icon name="edit" size={17} />
          {t.editClassBtn}
        </button>
      )}

      <button
        onClick={() => {
          if (!cancelArmed) {
            setCancelArmed(true)
            window.setTimeout(() => setCancelArmed(false), 5000)
            return
          }
          run(() => api.cancelClass(c.id), t.classCancelledOk).then(onClosed)
        }}
        disabled={busy}
        style={{
          width: '100%', marginTop: 8, border: '1px solid ' + C.warn,
          background: cancelArmed ? C.warnSoft : 'none', color: C.warn, borderRadius: 12,
          padding: 12, fontSize: 13, cursor: 'pointer', fontWeight: cancelArmed ? 600 : 400,
        }}
      >
        {cancelArmed ? t.cancelClassConfirm : t.cancelClassBtn}
      </button>
    </div>
  )
}

function StatusChip({ t, status }: { t: Dict; status: RosterRow['status'] }) {
  if (status === 'booked') return null
  const ok = status === 'attended'
  return (
    <span
      style={{
        background: ok ? C.okSoft : C.warnSoft, color: ok ? C.ok : C.warn,
        borderRadius: 10, padding: '4px 10px', fontSize: 11.5, whiteSpace: 'nowrap',
      }}
    >
      {ok ? t.attended : t.noShow}
    </span>
  )
}

function MiniBtn({
  label, onClick, active, tone, disabled,
}: {
  label: string; onClick: () => void; active?: boolean; tone?: 'warn'; disabled?: boolean
}) {
  const color = tone === 'warn' ? C.warn : active ? '#fff' : C.ink
  const bg = tone === 'warn' ? 'none' : active ? C.accent : 'none'
  const border = tone === 'warn' ? C.warn : active ? C.accent : C.line
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        border: '1px solid ' + border, background: bg, color, borderRadius: 10,
        padding: '7px 13px', fontSize: 12.5, cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {label}
    </button>
  )
}

// ---------------------------------------------------------------- clients

function ClientsTab({
  t, lang, clients, requests, onPick, onOpenRequest, onNew,
}: {
  t: Dict
  lang: Lang
  clients: Client[]
  requests: PurchaseRequest[]
  onPick: (c: Client) => void
  onOpenRequest: (r: PurchaseRequest) => void
  onNew: () => void
}) {
  const pending = requests.filter((r) => r.status === 'pending')
  const [q, setQ] = useState('')
  const list = clients.filter((c) => {
    const s = q.trim()
    if (!s) return true
    return (c.full_name ?? '').includes(s) || c.phone.includes(s.replace(/[\s-]/g, ''))
  })
  return (
    <>
      {pending.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <SectionTitle text={t.reqTitle + ' · ' + t.pendingBadge.replace('{n}', iso(pending.length))} />
          {pending.map((r) => (
            <button
              key={r.id}
              onClick={() => onOpenRequest(r)}
              style={{
                width: '100%', textAlign: 'start', background: C.card, border: '1px solid ' + C.warn,
                borderRadius: 12, padding: 13, marginBottom: 8, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 10,
              }}
            >
              <Icon name="shopping_bag" size={22} color={C.ink} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14.5, color: C.ink }}>
                  {r.client_name || (r.client_phone ? displayPhone(r.client_phone) : '—')}
                </div>
                <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                  {r.plan_name} · {iso(r.price_ils)} ₪ · {fmtWhen(r.created_at)}
                </div>
              </div>
              <Icon name="chevron_left" size={20} color={C.muted} />
            </button>
          ))}
        </div>
      )}

      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>{t.clientsSub}</div>
      <button
        onClick={onNew}
        style={{
          width: '100%', border: '1px dashed ' + C.line, background: 'none', color: C.accent,
          borderRadius: 12, padding: 12, fontSize: 13.5, cursor: 'pointer', marginBottom: 10,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        }}
      >
        <Icon name="person_add" size={18} />
        {t.newClientBtn}
      </button>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t.clientsSearch}
        style={{ ...inputStyle, marginBottom: 12 }}
      />
      {list.length === 0 ? (
        <Empty text={t.clientsEmpty} />
      ) : (
        list.map((c) => (
          <button
            key={c.id}
            onClick={() => onPick(c)}
            style={{
              width: '100%', textAlign: 'start', background: C.card, border: '1px solid ' + C.line,
              borderRadius: 12, padding: 13, marginBottom: 8, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 10,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14.5, color: C.ink }}>{c.full_name || displayPhone(c.phone)}</div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                {c.active_remaining > 0 && c.next_expiry
                  ? t.balanceLine.replace('{n}', iso(c.active_remaining)).replace('{d}', iso(fmtShort(c.next_expiry)))
                  : t.balanceNone}
              </div>
            </div>
            <HealthMarker lang={lang} flags={c.health_flags} formAt={c.health_form_at} />
            <div
              style={{
                background: c.active_remaining > 0 ? C.accentSoft : C.bg,
                color: c.active_remaining > 0 ? C.accentDark : C.muted,
                borderRadius: 10, padding: '5px 12px', fontSize: 13, fontWeight: 600,
              }}
            >
              {iso(c.active_remaining)}
            </div>
          </button>
        ))
      )}
    </>
  )
}

function GrantSheet({
  t, client, plans, say, onDone, onHealth,
}: {
  t: Dict; client: Client; plans: Plan[]; say: (m: string, k?: 'ok' | 'bad') => void; onDone: () => void; onHealth: () => void
}) {
  const [sessions, setSessions] = useState('8')
  const [months, setMonths] = useState('1')
  const [price, setPrice] = useState('300')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [history, setHistory] = useState<Pack[]>([])

  useEffect(() => {
    api.fetchClientPacks(client.id).then(setHistory).catch(() => setHistory([]))
  }, [client.id])

  const save = async () => {
    const s = Number(sessions)
    const m = Number(months)
    if (!Number.isInteger(s) || s < 1) return setErr(t.errors.invalid_sessions)
    if (!Number.isInteger(m) || m < 1) return setErr(t.errors.invalid_months)
    setErr(null)
    setBusy(true)
    const r = await api.grantPack(client.id, s, m, price.trim() ? Number(price) : null, note.trim() || null)
    setBusy(false)
    if (!r.ok) return setErr(errMsg(t, r.error))
    say(t.grantOk)
    onDone()
  }

  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ fontSize: 14.5, color: C.ink, marginBottom: 2 }}>{client.full_name || displayPhone(client.phone)}</div>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, direction: 'ltr', textAlign: 'start' }}>
        {displayPhone(client.phone)}
      </div>
      <button
        onClick={onHealth}
        style={{ width: '100%', marginBottom: 14, border: '1px solid ' + C.line, background: C.card, color: C.ink, borderRadius: 10, padding: '9px 12px', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'start' }}
      >
        <Icon name="health_and_safety" size={20} color={client.health_form_at ? (client.health_flags?.length ? C.warn : C.ok) : C.disabled} fill={!!client.health_form_at} />
        <span style={{ flex: 1 }}>{t.adminHealthTitle}</span>
        <span style={{ fontSize: 12, color: client.health_form_at ? (client.health_flags?.length ? C.warn : C.muted) : C.disabled }}>
          {!client.health_form_at ? t.healthNone : client.health_flags?.length ? t.healthAttention : t.healthClean}
        </span>
        <Icon name="chevron_left" size={18} color={C.muted} />
      </button>

      <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>{t.grantPresets}</div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {plans.filter((p) => p.active).map((p) => {
          const on = Number(price) === p.price_ils && Number(sessions) === p.sessions
          return (
            <button
              key={p.id}
              onClick={() => {
                setSessions(String(p.sessions))
                setMonths(String(p.valid_months))
                setPrice(String(p.price_ils))
                setNote(p.name)
              }}
              style={{
                border: '1px solid ' + (on ? C.accent : C.line),
                background: on ? C.accentSoft : 'none',
                color: C.ink, borderRadius: 12, padding: '8px 12px', fontSize: 12.5, cursor: 'pointer',
              }}
            >
              {iso(p.price_ils)} ₪ · {iso(p.sessions)}
            </button>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <Field label={t.grantSessions}>
            <input value={sessions} onChange={(e) => setSessions(e.target.value.replace(/\D/g, ''))} inputMode="numeric" dir="ltr" style={inputStyle} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label={t.grantMonths}>
            <input value={months} onChange={(e) => setMonths(e.target.value.replace(/\D/g, ''))} inputMode="numeric" dir="ltr" style={inputStyle} />
          </Field>
        </div>
      </div>
      <Field label={t.grantPrice + ' ' + t.optional}>
        <input value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))} inputMode="numeric" dir="ltr" style={inputStyle} />
      </Field>
      <Field label={t.grantNote + ' ' + t.optional}>
        <input value={note} onChange={(e) => setNote(e.target.value)} style={inputStyle} />
      </Field>
      {err && <ErrLine text={err} />}
      <PrimaryBtn label={busy ? t.loading : t.grantSave} disabled={busy} onClick={save} />

      {history.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <SectionTitle text={t.packHistory} />
          {history.map((p) => (
            <div
              key={p.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, border: '1px solid ' + C.line,
                borderRadius: 12, padding: '10px 12px', marginBottom: 6,
              }}
            >
              <div style={{ flex: 1, fontSize: 12.5, color: p.is_active ? C.ink : C.muted }}>
                {t.balanceLine.replace('{n}', iso(p.remaining)).replace('{d}', iso(fmtShort(p.valid_until)))}
              </div>
              <div style={{ fontSize: 11.5, color: C.muted }}>
                {iso(p.sessions_total)}
                {p.price_ils != null && ' · ' + iso(p.price_ils) + ' ₪'}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- add class

function AddClassSheet({ t, say, onDone }: { t: Dict; say: (m: string, k?: 'ok' | 'bad') => void; onDone: () => void }) {
  const [date, setDate] = useState(toISODate(new Date()))
  const [time, setTime] = useState('18:00')
  const [cap, setCap] = useState('8')
  const [dur, setDur] = useState('55')
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    if (!date || !/^\d{2}:\d{2}$/.test(time)) return setErr(t.errors.invalid_input)
    const d = Number(dur)
    if (!Number.isInteger(d) || d < 15 || d > 180) return setErr(t.errors.invalid_duration)
    setErr(null)
    setBusy(true)
    const r = await api.addClass(date, time, cap.trim() ? Number(cap) : null, label.trim() || null, d)
    setBusy(false)
    if (!r.ok) return setErr(errMsg(t, r.error, r))
    say(t.classAdded)
    onDone()
  }

  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>{t.addClassHint}</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <Field label={t.addClassDate}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} dir="ltr" style={inputStyle} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label={t.addClassTime}>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)} dir="ltr" style={inputStyle} />
          </Field>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <Field label={t.addClassCap}>
            <input value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, ''))} inputMode="numeric" dir="ltr" style={inputStyle} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label={t.addClassLen}>
            <input value={dur} onChange={(e) => setDur(e.target.value.replace(/\D/g, ''))} inputMode="numeric" dir="ltr" style={inputStyle} />
          </Field>
        </div>
        <div style={{ flex: 2 }}>
          <Field label={t.addClassLabel + ' ' + t.optional}>
            <input value={label} onChange={(e) => setLabel(e.target.value)} style={inputStyle} />
          </Field>
        </div>
      </div>
      {err && <ErrLine text={err} />}
      <PrimaryBtn label={busy ? t.loading : t.addClassSave} disabled={busy} onClick={save} />
    </div>
  )
}

// ---------------------------------------------------------------- weekly schedule

type Slot = { time: string; duration: number; capacity: number; label: string }
const slotMin = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))

/** The standing week (class_template), Sunday → Saturday. Saving replaces it
 *  and moves the coming weeks onto it; a class somebody booked never changes
 *  or disappears by itself (see resync_classes in patch v1.5). */
function WeekSheet({ t, say, onDone }: { t: Dict; say: (m: string, k?: 'ok' | 'bad') => void; onDone: () => void }) {
  const [days, setDays] = useState<Record<number, Slot[]> | null>(null)
  const [loadErr, setLoadErr] = useState(false)
  /** the day whose form is open, and the slot being edited there (null = adding) */
  const [form, setForm] = useState<{ d: number; editing: string | null } | null>(null)
  const [draft, setDraft] = useState<Slot>({ time: '18:00', duration: 55, capacity: 8, label: 'Reformer' })
  const [err, setErr] = useState<string | null>(null)
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.fetchTemplate()
      .then((rows) => {
        const m: Record<number, Slot[]> = {}
        for (let d = 0; d < 7; d++) m[d] = []
        rows.forEach((r) => m[r.weekday]?.push({ time: hhmm(r.start_time), duration: r.duration_min, capacity: r.capacity, label: r.label ?? '' }))
        setDays(m)
      })
      .catch(() => setLoadErr(true))
  }, [])

  if (loadErr) return <Empty text={t.errors.network} />
  if (!days) return <Empty text={t.loading} />

  const labels = [...new Set(['Reformer', 'Mat', ...Object.values(days).flat().map((x) => x.label).filter(Boolean)])]
  const total = Object.values(days).reduce((n, a) => n + a.length, 0)

  const openForm = (d: number, slot: Slot | null) => {
    setErr(null)
    setForm({ d, editing: slot?.time ?? null })
    setDraft(slot ? { ...slot } : { time: '18:00', duration: 55, capacity: 8, label: labels[0] ?? '' })
  }
  const commit = () => {
    if (!form) return
    const { d, editing } = form
    if (!/^\d{2}:\d{2}$/.test(draft.time)) return setErr(t.errors.invalid_input)
    if (!Number.isInteger(draft.duration) || draft.duration < 15 || draft.duration > 180) return setErr(t.errors.invalid_duration)
    if (!Number.isInteger(draft.capacity) || draft.capacity < 1 || draft.capacity > 30) return setErr(t.errors.invalid_capacity)
    const others = days[d].filter((x) => x.time !== editing)
    if (others.some((x) => x.time === draft.time)) return setErr(t.weekDup)
    const clash = others.find((x) =>
      slotMin(x.time) < slotMin(draft.time) + draft.duration && slotMin(draft.time) < slotMin(x.time) + x.duration)
    if (clash) return setErr(errMsg(t, 'overlaps_class', { time: clash.time }))
    setArmed(false)
    setDays({ ...days, [d]: [...others, { ...draft, label: draft.label.trim() }].sort((a, b) => a.time.localeCompare(b.time)) })
    setForm(null)
  }
  const remove = (d: number, time: string) => {
    setArmed(false)
    setDays({ ...days, [d]: days[d].filter((x) => x.time !== time) })
    if (form?.d === d && form.editing === time) setForm(null)
  }
  const save = async () => {
    if (!armed) {
      setArmed(true)
      return
    }
    setBusy(true)
    setErr(null)
    const rows: TemplateDraft[] = Object.entries(days).flatMap(([d, arr]) =>
      arr.map((x) => ({ weekday: Number(d), time: x.time, duration: x.duration, capacity: x.capacity, label: x.label || null })),
    )
    const r = await api.saveTemplate(rows)
    setBusy(false)
    setArmed(false)
    if (!r.ok) return setErr(errMsg(t, r.error, r))
    let msg = t.weekSaved
      .replace('{a}', iso(r.added ?? 0)).replace('{r}', iso(r.removed ?? 0)).replace('{u}', iso(r.updated ?? 0))
    if (r.kept_booked) msg += ' ' + t.weekKept.replace('{k}', iso(r.kept_booked))
    say(msg)
    onDone()
  }

  const num = (v: string) => Number(v.replace(/\D/g, '') || '0')

  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>{t.weekSub}</div>
      {[0, 1, 2, 3, 4, 5, 6].map((d) => (
        <div key={d} style={{ border: '1px solid ' + C.line, borderRadius: 12, padding: '10px 12px', marginBottom: 8, background: C.card }}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: days[d].length || form?.d === d ? 8 : 0 }}>
            <div style={{ flex: 1, fontSize: 14, fontWeight: 600, color: C.ink }}>{t.daysFull[d]}</div>
            {!days[d].length && form?.d !== d && <span style={{ fontSize: 12, color: C.muted, marginInlineEnd: 8 }}>{t.weekClosed}</span>}
            {form?.d !== d && (
              <button
                onClick={() => openForm(d, null)}
                style={{ border: '1px solid ' + C.line, background: 'none', color: C.accent, borderRadius: 10, padding: '5px 10px', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}
              >
                <Icon name="add" size={15} />
                {t.weekAdd}
              </button>
            )}
          </div>
          {days[d].map((x) => (
            <div key={x.time} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid ' + C.line }}>
              <button
                onClick={() => openForm(d, x)}
                style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, border: 'none', background: 'none', padding: 0, cursor: 'pointer', textAlign: 'start', color: C.ink }}
              >
                <span style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums', minWidth: 46 }}>{iso(x.time)}</span>
                <span style={{ fontSize: 13.5 }}>{x.label || t.classDefault}</span>
                <span style={{ fontSize: 11.5, color: C.muted, marginInlineStart: 'auto' }}>
                  {t.minutes.replace('{n}', iso(x.duration))} · {t.weekSpots.replace('{n}', iso(x.capacity))}
                </span>
              </button>
              <button
                onClick={() => remove(d, x.time)}
                aria-label={'× ' + x.time}
                style={{ border: 'none', background: 'none', color: C.muted, cursor: 'pointer', display: 'flex', padding: 2 }}
              >
                <Icon name="close" size={18} />
              </button>
            </div>
          ))}
          {form?.d === d && (
            <div style={{ borderTop: days[d].length ? '1px solid ' + C.line : 'none', paddingTop: 10 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                {labels.map((l) => (
                  <button
                    key={l}
                    onClick={() => setDraft({ ...draft, label: l })}
                    style={{
                      border: '1px solid ' + (draft.label === l ? C.accent : C.line), background: draft.label === l ? C.accentSoft : 'none',
                      color: C.ink, borderRadius: 10, padding: '6px 11px', fontSize: 12.5, cursor: 'pointer',
                    }}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <div style={{ flex: 1.3 }}>
                  <Field label={t.addClassTime}>
                    <input type="time" value={draft.time} onChange={(e) => setDraft({ ...draft, time: e.target.value })} dir="ltr" style={inputStyle} />
                  </Field>
                </div>
                <div style={{ flex: 1 }}>
                  <Field label={t.addClassLen}>
                    <input value={String(draft.duration)} onChange={(e) => setDraft({ ...draft, duration: num(e.target.value) })} inputMode="numeric" dir="ltr" style={inputStyle} />
                  </Field>
                </div>
                <div style={{ flex: 1 }}>
                  <Field label={t.addClassCap}>
                    <input value={String(draft.capacity)} onChange={(e) => setDraft({ ...draft, capacity: num(e.target.value) })} inputMode="numeric" dir="ltr" style={inputStyle} />
                  </Field>
                </div>
              </div>
              <Field label={t.addClassLabel}>
                <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} style={inputStyle} />
              </Field>
              {err && <ErrLine text={err} />}
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={commit}
                  style={{ flex: 2, border: 'none', background: C.accent, color: '#fff', borderRadius: 10, padding: '10px 0', fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}
                >
                  {form.editing ? t.editClassSave : t.weekAdd}
                </button>
                <button
                  onClick={() => setForm(null)}
                  style={{ flex: 1, border: '1px solid ' + C.line, background: 'none', color: C.ink, borderRadius: 10, padding: '10px 0', fontSize: 13, cursor: 'pointer' }}
                >
                  {t.close}
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
      <div style={{ fontSize: 12.5, fontWeight: 600, color: C.ink, margin: '6px 2px 10px' }}>{t.weekCount.replace('{n}', iso(total))}</div>
      {err && !form && <ErrLine text={err} />}
      <PrimaryBtn label={busy ? t.loading : armed ? t.weekConfirm : t.weekSave} disabled={busy || !!form} onClick={save} />
    </div>
  )
}

// ---------------------------------------------------------------- new client

/** A client the studio adds by hand (signed up at the desk, or over the
 *  phone). Creates a real account keyed on her phone, so when she later signs
 *  in with that number she finds her pack and classes. */
function NewClientSheet({
  t, onDone,
}: {
  t: Dict
  onDone: (userId: string, existed: boolean, draft: { name: string; phone: string }) => void
}) {
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    if (name.trim().length < 2) return setErr(t.errors.invalid_name)
    const e164 = normalizePhone(phone)
    if (!e164) return setErr(t.errors.invalid_phone)
    setErr(null)
    setBusy(true)
    const r = await api.createClient(name.trim(), e164)
    setBusy(false)
    if (r.ok && r.user_id) return onDone(r.user_id, false, { name: name.trim(), phone: e164 })
    if (r.error === 'client_exists' && r.user_id) return onDone(r.user_id, true, { name: name.trim(), phone: e164 })
    setErr(errMsg(t, r.error, r))
  }

  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>{t.newClientHint}</div>
      <Field label={t.newClientName}>
        <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} autoFocus />
      </Field>
      <Field label={t.newClientPhone}>
        <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={t.phonePh} inputMode="tel" dir="ltr" style={inputStyle} />
      </Field>
      {err && <ErrLine text={err} />}
      <PrimaryBtn label={busy ? t.loading : t.newClientSave} disabled={busy} onClick={save} />
    </div>
  )
}

// ---------------------------------------------------------------- reminders

function RemindersTab({
  t, rows, today, onSent,
}: {
  t: Dict; rows: RosterRow[]; today: string; onSent: (bookingId: string) => void
}) {
  const live = rows.filter((r) => r.status !== 'no_show')
  const todayRows = live.filter((r) => r.class_date === today)
  const tomorrowRows = live.filter((r) => r.class_date !== today)

  return (
    <>
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginBottom: 14 }}>{t.remSub}</div>
      {live.length === 0 ? (
        <Empty text={t.remEmpty} />
      ) : (
        <>
          {todayRows.length > 0 && <SectionTitle text={t.sectionToday} />}
          {todayRows.map((r) => (
            <ReminderRow key={r.booking_id} t={t} r={r} onSent={onSent} />
          ))}
          {tomorrowRows.length > 0 && <SectionTitle text={t.sectionTomorrow} />}
          {tomorrowRows.map((r) => (
            <ReminderRow key={r.booking_id} t={t} r={r} onSent={onSent} />
          ))}
        </>
      )}
    </>
  )
}

function ReminderRow({ t, r, onSent }: { t: Dict; r: RosterRow; onSent: (id: string) => void }) {
  const sent = !!r.reminder_sent_at
  // Composed here, never in SQL: a raw-concatenated wa.me query loses
  // everything after the first '#', and demo mode would hide it.
  const text = t.waReminder
    .replace('{d}', longDate(t, r.class_date))
    .replace('{t}', hhmm(r.start_time))
  const href = r.attendee_phone
    ? `https://wa.me/${r.attendee_phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`
    : null

  return (
    <div
      style={{
        background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: 12,
        marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10,
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600, color: C.ink, minWidth: 46, fontVariantNumeric: 'tabular-nums' }}>
        {iso(hhmm(r.start_time))}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, color: C.ink }}>{r.attendee_name || '—'}</div>
        <div style={{ fontSize: 11.5, color: sent ? C.ok : C.muted, marginTop: 2 }}>
          {r.attendee_phone ? (sent ? '✓ ' + t.waBtn : (r.label || t.classDefault)) : t.noPhone}
        </div>
      </div>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          onClick={() => {
            // fire-and-forget: awaiting first gets the tab popup-blocked on iOS
            api.markReminderSent(r.booking_id)
            onSent(r.booking_id)
          }}
          style={{
            background: sent ? 'none' : C.accent, border: '1px solid ' + (sent ? C.line : C.accent),
            color: sent ? C.muted : '#fff', borderRadius: 10, padding: '8px 14px',
            fontSize: 12.5, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap',
          }}
        >
          {sent ? t.resendBtn : t.waBtn}
        </a>
      ) : (
        <span style={{ fontSize: 11.5, color: C.muted }}>{t.noPhone}</span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- shop (admin)

/** "8.9 14:02" in the admin's local time */
function fmtWhen(isoTs: string): string {
  const d = new Date(isoTs)
  return `${d.getDate()}.${d.getMonth() + 1} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function ReqChip({ t, status }: { t: Dict; status: PurchaseRequest['status'] }) {
  const map = {
    pending: { bg: C.accentSoft, fg: C.ink, label: t.reqPending },
    approved: { bg: C.okSoft, fg: C.ok, label: t.reqApproved },
    declined: { bg: C.warnSoft, fg: C.warn, label: t.reqDeclined },
    cancelled: { bg: C.bg, fg: C.muted, label: t.reqCancelled },
  }[status]
  return (
    <span style={{ background: map.bg, color: map.fg, borderRadius: 10, padding: '4px 10px', fontSize: 11.5, whiteSpace: 'nowrap' }}>
      {map.label}
    </span>
  )
}

function RequestSheet({
  t, r, say, onDone,
}: {
  t: Dict; r: PurchaseRequest; say: (m: string, k?: 'ok' | 'bad') => void; onDone: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [declineArmed, setDeclineArmed] = useState(false)
  const [note, setNote] = useState('')

  const decide = async (approve: boolean) => {
    if (!approve && !declineArmed) {
      setDeclineArmed(true)
      window.setTimeout(() => setDeclineArmed(false), 5000)
      return
    }
    setBusy(true)
    const res = await api.decidePurchase(r.id, approve, note.trim() || null)
    setBusy(false)
    if (!res.ok) return say(errMsg(t, res.error), 'bad')
    say(approve ? t.reqApprovedOk : t.reqDeclinedOk, approve ? 'ok' : 'bad')
    onDone()
  }

  const name = r.client_name || (r.client_phone ? displayPhone(r.client_phone) : '—')
  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ fontSize: 17, fontWeight: 600, color: C.ink }}>{name}</div>
      {r.client_phone && (
        <a
          href={'tel:' + r.client_phone}
          style={{ fontSize: 12.5, color: C.accent, textDecoration: 'none', direction: 'ltr', display: 'inline-block', marginTop: 2 }}
        >
          {displayPhone(r.client_phone)}
        </a>
      )}

      <div style={{ background: C.accentSoft, borderRadius: 12, padding: '12px 14px', margin: '14px 0 12px' }}>
        <div style={{ fontSize: 14.5, color: C.ink }}>{r.plan_name}</div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
          {r.sessions === 1 ? t.planSessionOne : t.planSessions.replace('{n}', iso(r.sessions))}
          {' · '}
          {r.valid_months === 1 ? t.planValidityOne : t.planValidity.replace('{n}', iso(r.valid_months))}
          {' · '}
          {fmtWhen(r.created_at)}
        </div>
        <div style={{ fontSize: 24, fontWeight: 600, color: C.ink, marginTop: 6, fontVariantNumeric: 'tabular-nums' }}>{iso(r.price_ils)} ₪</div>
        {r.client_note && (
          <div style={{ fontSize: 12.5, color: C.ink, marginTop: 8, borderTop: '1px solid ' + C.line, paddingTop: 8 }}>
            “{r.client_note}”
          </div>
        )}
      </div>

      <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>{t.reqHint}</div>

      <Field label={t.grantNote + ' ' + t.optional}>
        <input value={note} onChange={(e) => setNote(e.target.value)} style={inputStyle} />
      </Field>

      <PrimaryBtn label={busy ? t.loading : t.reqApprove} disabled={busy} onClick={() => decide(true)} />
      <button
        onClick={() => decide(false)}
        disabled={busy}
        style={{
          width: '100%', marginTop: 10, border: '1px solid ' + C.warn, background: declineArmed ? C.warnSoft : 'none',
          color: C.warn, borderRadius: 10, padding: 11, fontSize: 13, cursor: 'pointer', fontWeight: declineArmed ? 600 : 400,
        }}
      >
        {declineArmed ? t.reqDeclineConfirm : t.reqDecline}
      </button>
    </div>
  )
}

function ShopAdminTab({
  t, plans, requests, info, say, onEdit, onSaved,
}: {
  t: Dict
  plans: Plan[]
  requests: PurchaseRequest[]
  info: StudioInfo | null
  say: (m: string, k?: 'ok' | 'bad') => void
  onEdit: (p: Plan | 'new') => void
  onSaved: () => void
}) {
  const [wa, setWa] = useState('')
  const [waBusy, setWaBusy] = useState(false)
  const [waErr, setWaErr] = useState<string | null>(null)
  useEffect(() => {
    setWa(info?.whatsapp_phone ? displayPhone(info.whatsapp_phone) : '')
  }, [info?.whatsapp_phone])

  const saveWa = async () => {
    const p = wa.trim() ? normalizePhone(wa) : null
    if (wa.trim() && !p) return setWaErr(t.errors.invalid_phone)
    setWaErr(null)
    setWaBusy(true)
    const r = await api.saveStudioWhatsapp(p)
    setWaBusy(false)
    if (!r.ok) return say(errMsg(t, r.error), 'bad')
    say(t.waSaved)
    onSaved()
  }

  const history = requests.filter((r) => r.status !== 'pending').slice(0, 10)

  return (
    <>
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>{t.plansSub}</div>

      {plans.length === 0 ? (
        <Empty text={t.shopEmpty} />
      ) : (
        plans.map((p) => (
          <button
            key={p.id}
            onClick={() => onEdit(p)}
            style={{
              width: '100%', textAlign: 'start', background: C.card, border: '1px solid ' + C.line,
              borderRadius: 12, padding: 13, marginBottom: 8, cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 12, opacity: p.active ? 1 : 0.75,
            }}
          >
            <span className="wordmark" style={{ fontSize: 26, fontWeight: 300, color: C.ink, minWidth: 34, textAlign: 'center' }}>
              {p.sessions}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14.5, color: C.ink, display: 'flex', alignItems: 'center', gap: 8 }}>
                {p.name}
                {!p.active && (
                  <span style={{ background: C.bg, color: C.muted, borderRadius: 10, padding: '2px 8px', fontSize: 11 }}>{t.planHidden}</span>
                )}
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                {p.valid_months === 1 ? t.planValidityOne : t.planValidity.replace('{n}', iso(p.valid_months))}
                {p.payment_url && ' · ' + t.payLink}
              </div>
            </div>
            <div style={{ fontSize: 16, fontWeight: 600, color: C.ink, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {iso(p.price_ils)} ₪
            </div>
          </button>
        ))
      )}

      <button
        onClick={() => onEdit('new')}
        style={{
          width: '100%', border: '1px dashed ' + C.line, background: 'none', color: C.accent,
          borderRadius: 12, padding: 14, fontSize: 13.5, cursor: 'pointer', marginTop: 4,
        }}
      >
        + {t.planAdd}
      </button>

      <div style={{ marginTop: 22 }}>
        <SectionTitle text={t.waSettingTitle} />
        <div style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: 14 }}>
          <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginBottom: 10 }}>{t.waSettingHint}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={wa}
              onChange={(e) => setWa(e.target.value)}
              placeholder={t.phonePh}
              inputMode="tel"
              dir="ltr"
              style={{ ...inputStyle, flex: 1 }}
            />
            <button
              onClick={saveWa}
              disabled={waBusy}
              style={{ border: 'none', background: C.accent, color: '#fff', borderRadius: 10, padding: '0 16px', fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}
            >
              {waBusy ? t.loading : t.save}
            </button>
          </div>
          {waErr && <div style={{ marginTop: 8 }}><ErrLine text={waErr} /></div>}
        </div>
      </div>

      {history.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <SectionTitle text={t.reqHistory} />
          {history.map((r) => (
            <div
              key={r.id}
              style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: '10px 14px', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 10 }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: C.ink }}>
                  {r.client_name || (r.client_phone ? displayPhone(r.client_phone) : '—')}
                </div>
                <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                  {r.plan_name} · {iso(r.price_ils)} ₪ · {fmtWhen(r.decided_at ?? r.created_at)}
                </div>
              </div>
              <ReqChip t={t} status={r.status} />
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function PlanEditSheet({
  t, plan, say, onDone,
}: {
  t: Dict; plan: Plan | null; say: (m: string, k?: 'ok' | 'bad') => void; onDone: () => void
}) {
  const [name, setName] = useState(plan?.name ?? '')
  const [desc, setDesc] = useState(plan?.description ?? '')
  const [sessions, setSessions] = useState(String(plan?.sessions ?? 8))
  const [months, setMonths] = useState(String(plan?.valid_months ?? 1))
  const [price, setPrice] = useState(plan ? String(plan.price_ils) : '')
  const [url, setUrl] = useState(plan?.payment_url ?? '')
  const [active, setActive] = useState(plan?.active ?? true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const save = async () => {
    const sNum = Number(sessions)
    const mNum = Number(months)
    const pNum = Number(price)
    if (name.trim().length < 2) return setErr(t.errors.invalid_name)
    if (!Number.isInteger(sNum) || sNum < 1 || sNum > 60) return setErr(t.errors.invalid_sessions)
    if (!Number.isInteger(mNum) || mNum < 1 || mNum > 12) return setErr(t.errors.invalid_months)
    if (!price.trim() || !Number.isFinite(pNum) || pNum < 0) return setErr(t.errors.invalid_price)
    if (url.trim() && !/^https?:\/\//i.test(url.trim())) return setErr(t.errors.invalid_input)
    setErr(null)
    setBusy(true)
    const r = await api.savePlan({
      id: plan?.id,
      sort_order: plan?.sort_order,
      name: name.trim(),
      description: desc.trim() || null,
      sessions: sNum,
      valid_months: mNum,
      price_ils: pNum,
      payment_url: url.trim() || null,
      active,
    })
    setBusy(false)
    if (!r.ok) return setErr(errMsg(t, r.error))
    say(t.planSaved)
    onDone()
  }

  return (
    <div style={{ paddingBottom: 8 }}>
      <Field label={t.planName}>
        <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} autoFocus={!plan} />
      </Field>
      <Field label={t.planDesc + ' ' + t.optional}>
        <input value={desc} onChange={(e) => setDesc(e.target.value)} style={inputStyle} />
      </Field>
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <Field label={t.grantSessions}>
            <input value={sessions} onChange={(e) => setSessions(e.target.value.replace(/\D/g, ''))} inputMode="numeric" dir="ltr" style={inputStyle} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label={t.grantMonths}>
            <input value={months} onChange={(e) => setMonths(e.target.value.replace(/\D/g, ''))} inputMode="numeric" dir="ltr" style={inputStyle} />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label={t.planPrice}>
            <input value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ''))} inputMode="decimal" dir="ltr" style={inputStyle} />
          </Field>
        </div>
      </div>
      <Field label={t.planPayUrl + ' ' + t.optional}>
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" inputMode="url" dir="ltr" style={inputStyle} />
      </Field>

      <button
        onClick={() => setActive((v) => !v)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, border: '1px solid ' + C.line, background: C.card,
          borderRadius: 10, padding: '10px 12px', width: '100%', cursor: 'pointer', marginBottom: 14, textAlign: 'start',
        }}
      >
        <Icon name={active ? 'toggle_on' : 'toggle_off'} size={30} color={active ? C.ink : C.disabled} fill={active} />
        <span style={{ fontSize: 13.5, color: C.ink }}>{active ? t.planActive : t.planHidden}</span>
      </button>

      {err && <ErrLine text={err} />}
      <PrimaryBtn label={busy ? t.loading : t.save} disabled={busy} onClick={save} />
    </div>
  )
}

// ---------------------------------------------------------------- announcements

function AnnouncementsPanel({
  t, items, say, onChanged,
}: {
  t: Dict; items: Notification[]; say: (m: string, k?: 'ok' | 'bad') => void; onChanged: () => void
}) {
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)

  const send = async () => {
    if (title.trim().length < 2) return setErr(t.errors.invalid_input)
    setErr(null)
    setBusy(true)
    const r = await api.sendAnnouncement(title.trim(), body.trim())
    setBusy(false)
    if (!r.ok) return setErr(errMsg(t, r.error))
    setTitle('')
    setBody('')
    setOpen(false)
    say(t.annSent)
    onChanged()
  }

  const del = async (id: string) => {
    if (armed !== id) {
      setArmed(id)
      window.setTimeout(() => setArmed((v) => (v === id ? null : v)), 5000)
      return
    }
    setArmed(null)
    const r = await api.deleteNotification(id)
    if (!r.ok) return say(errMsg(t, r.error), 'bad')
    say(t.annDeleted)
    onChanged()
  }

  const past = items.slice(0, 5)

  return (
    <div style={{ marginBottom: 22 }}>
      <SectionTitle text={t.annTitle} />
      <div style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: 14 }}>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginBottom: open ? 12 : 0 }}>{t.annHint}</div>
        {open ? (
          <>
            <Field label={t.annTitleField}>
              <input value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} autoFocus />
            </Field>
            <Field label={t.annBody + ' ' + t.optional}>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={3}
                style={{ ...inputStyle, resize: 'vertical', lineHeight: 1.5 }}
              />
            </Field>
            {err && <ErrLine text={err} />}
            <PrimaryBtn label={busy ? t.loading : t.annSend} disabled={busy} onClick={send} />
          </>
        ) : (
          <button
            onClick={() => setOpen(true)}
            style={{
              width: '100%', marginTop: 10, border: '1px dashed ' + C.line, background: 'none', color: C.accent,
              borderRadius: 10, padding: 11, fontSize: 13.5, cursor: 'pointer',
            }}
          >
            + {t.annTitle}
          </button>
        )}
      </div>

      {past.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <SectionTitle text={t.annPast} />
          {past.map((n) => {
            const d = n.data as { title?: string; body?: string }
            return (
              <div
                key={n.id}
                style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: '10px 14px', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 10 }}
              >
                <Icon name="campaign" size={20} color={C.muted} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, color: C.ink }}>{d.title}</div>
                  {d.body && (
                    <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.body}</div>
                  )}
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{fmtWhen(n.created_at)}</div>
                </div>
                <button
                  onClick={() => del(n.id)}
                  style={{
                    border: '1px solid ' + (armed === n.id ? C.warn : C.line), background: armed === n.id ? C.warnSoft : 'none',
                    color: armed === n.id ? C.warn : C.muted, borderRadius: 10, padding: '6px 10px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
                  }}
                >
                  {armed === n.id ? t.annDeleteConfirm : t.annDelete}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
