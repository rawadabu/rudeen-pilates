import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../components/Icon'
import { Logo } from '../components/Logo'
import { OtpPanel } from '../components/OtpPanel'
import { PushCard } from '../components/PushCard'
import { Sheet } from '../components/Sheet'
import { Empty, ErrLine, Field, PrimaryBtn, RetryBox, SectionTitle, fmtShort, inputStyle, longDate } from '../components/ui'
import { DICT, errMsg, type Dict, type Lang } from '../i18n'
import { api } from '../lib/api'
import { WEEKS_AHEAD, dateOf, daysUntil, hhmm, iso, slotDateTime, toISODate } from '../lib/dates'
import { displayPhone, normalizePhone } from '../lib/phone'
import { currentEndpoint, forgetNativeEndpoint } from '../lib/push'
import { C } from '../lib/theme'
import type { AuthUser, ClassRow, HealthForm, MyBooking, Notification, Pack, Plan, Profile, PurchaseRequest, StudioInfo } from '../lib/types'
import { HealthFormScreen, HealthView } from '../health/HealthForm'

type Tab = 'home' | 'sched' | 'shop' | 'me'
/** 'my', 'notif' and 'health' are sub-screens, not nav slots */
type Screen = Tab | 'my' | 'notif' | 'health'
type AuthMode = 'signin' | 'signup'
type Toast = { msg: string; kind: 'ok' | 'bad' }

export function ClientApp() {
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('lang') as Lang) || 'he')
  const t = DICT[lang]
  useEffect(() => {
    localStorage.setItem('lang', lang)
    document.documentElement.lang = lang
  }, [lang])
  const toggleLang = () => setLang(lang === 'he' ? 'ar' : 'he')

  const [screen, setScreen] = useState<Screen>('home')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [guestBrowse, setGuestBrowse] = useState(false)

  const [classes, setClasses] = useState<ClassRow[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [info, setInfo] = useState<StudioInfo | null>(null)
  const [packs, setPacks] = useState<Pack[]>([])
  const [mine, setMine] = useState<MyBooking[]>([])
  const [requests, setRequests] = useState<PurchaseRequest[]>([])
  const [notifs, setNotifs] = useState<Notification[]>([])
  /** seen-at as it was when the center was opened: rows stay marked "new" for that visit */
  const [notifOpenSeen, setNotifOpenSeen] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthForm | null>(null)
  const [healthMode, setHealthMode] = useState<'view' | 'edit'>('edit')

  /** The schedule is two levels: the list of open days, then one day's
   *  times. pickedDay = the day whose times are showing (null = the list). */
  const [pickedDay, setPickedDay] = useState<string | null>(null)
  const listScroll = useRef(0)
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState(false)
  const [toast, setToast] = useState<Toast | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [armed, setArmed] = useState<string | null>(null)
  const [loginOpen, setLoginOpen] = useState(false)
  const [loginMode, setLoginMode] = useState<AuthMode>('signin')
  const [pendingClass, setPendingClass] = useState<string | null>(null)
  const [openPlan, setOpenPlan] = useState<Plan | null>(null)

  const fromISO = toISODate(dateOf(0, 0))
  const toISO = toISODate(dateOf(WEEKS_AHEAD - 1, 6))

  const say = useCallback((msg: string, kind: Toast['kind'] = 'ok') => {
    setToast({ msg, kind })
    window.setTimeout(() => setToast(null), 4000)
  }, [])

  // --- auth
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
    if (!user) {
      setProfile(null)
      setPacks([])
      setMine([])
      setRequests([])
      setNotifs([])
      setHealth(null)
      return
    }
    api.getMyProfile().then(setProfile).catch(() => setProfile(null))
  }, [user])

  // --- data
  const loadPublic = useCallback(async () => {
    // Three independent fetches: a broken catalogue must not blank the
    // schedule, which is the one thing that works signed out.
    try {
      setClasses(await api.fetchClasses(fromISO, toISO))
      setLoadErr(false)
    } catch {
      setLoadErr(true)
    } finally {
      setLoading(false)
    }
    api.fetchPlans().then(setPlans).catch(() => {})
    api.fetchStudioInfo().then(setInfo).catch(() => {})
  }, [fromISO, toISO])

  const loadMine = useCallback(async () => {
    if (!user) return
    try {
      const [p, b, r, n, hf] = await Promise.all([
        api.fetchMyPacks(), api.fetchMyBookings(), api.fetchMyRequests(), api.fetchNotifications(),
        api.getMyHealthForm().catch(() => null),
      ])
      setPacks(p)
      setMine(b)
      setRequests(r)
      setNotifs(n)
      setHealth(hf)
    } catch {
      /* keep whatever we had */
    }
  }, [user])

  useEffect(() => {
    loadPublic()
  }, [loadPublic])
  useEffect(() => {
    loadMine()
  }, [loadMine])

  useEffect(() => {
    const refresh = () => {
      loadPublic()
      loadMine()
    }
    const onVis = () => document.visibilityState === 'visible' && refresh()
    document.addEventListener('visibilitychange', onVis)
    const unsub = api.subscribeChanges(refresh)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      unsub()
    }
  }, [loadPublic, loadMine])

  const bookedIds = useMemo(() => new Set(mine.map((b) => b.class_id)), [mine])
  const activePacks = useMemo(() => packs.filter((p) => p.is_active), [packs])
  const remaining = activePacks.reduce((s, p) => s + p.remaining, 0)
  const nextExpiry = activePacks
    .filter((p) => p.remaining > 0)
    .map((p) => p.valid_until)
    .sort()[0]
  // when nothing is active, the most recent pack tells the client when it ended
  const lastExpiry = packs.map((p) => p.valid_until).sort().reverse()[0]
  const cutoff = info?.cancel_cutoff_hours ?? 12
  const seenAt = profile?.notifications_seen_at ?? null
  // the declaration is a condition of training — no form, no booking
  const needsHealth = !!user && !!profile && !profile.health_form_at && !health
  const unread = notifs.filter((n) => !seenAt || n.created_at > seenAt).length
  const expiringIn = nextExpiry ? daysUntil(nextExpiry) : null

  /** A day's classes that have not started yet, in time order — the only
   *  ones worth showing on a screen for picking a time. */
  const upcomingOn = useCallback(
    (dateISO: string) => {
      const now = new Date()
      return classes
        .filter((c) => c.class_date === dateISO && slotDateTime(c.class_date, c.start_time) > now)
        .sort((a, b) => a.start_time.localeCompare(b.start_time))
    },
    [classes],
  )
  // Days that still have a class to pick, oldest first. Once a day's last
  // class has started the day leaves the list.
  const days = useMemo(() => {
    const now = new Date()
    const set = new Set<string>()
    classes.forEach((c) => {
      if (slotDateTime(c.class_date, c.start_time) > now) set.add(c.class_date)
    })
    return [...set].sort()
  }, [classes])
  /** What the day row says before it is opened: booked in, or nothing left
   *  but full classes. Open vs full only — never how many spots. */
  const dayTag = useCallback(
    (dateISO: string): 'booked' | 'full' | null => {
      const list = upcomingOn(dateISO)
      if (list.some((c) => bookedIds.has(c.id))) return 'booked'
      if (list.length > 0 && list.every((c) => c.is_full)) return 'full'
      return null
    },
    [upcomingOn, bookedIds],
  )
  const openDayTimes = (dateISO: string) => {
    listScroll.current = window.scrollY
    setPickedDay(dateISO)
    window.scrollTo({ top: 0 })
  }
  const backToDays = () => {
    setPickedDay(null)
    // back to where the list was, not the top
    requestAnimationFrame(() => window.scrollTo({ top: listScroll.current }))
  }
  const goSched = () => {
    setPickedDay(null)
    setScreen('sched')
  }

  // --- actions
  const openLogin = (mode: AuthMode) => {
    setLoginMode(mode)
    setLoginOpen(true)
  }

  const book = async (c: ClassRow) => {
    if (!user) {
      setPendingClass(c.id)
      openLogin('signin')
      return
    }
    if (needsHealth) {
      setPendingClass(c.id)
      setHealthMode('edit')
      setScreen('health')
      say(t.healthRequiredHint)
      return
    }
    setBusyId(c.id)
    const r = await api.bookClass(c.id)
    setBusyId(null)
    if (!r.ok) return say(errMsg(t, r.error), 'bad')
    say(t.bookedOk)
    loadPublic()
    loadMine()
  }

  const cancel = async (b: MyBooking) => {
    if (armed !== b.id) {
      setArmed(b.id)
      window.setTimeout(() => setArmed((v) => (v === b.id ? null : v)), 4000)
      return
    }
    setArmed(null)
    setBusyId(b.id)
    const r = await api.cancelMyBooking(b.id)
    setBusyId(null)
    if (!r.ok) return say(errMsg(t, r.error), 'bad')
    say(r.refunded ? t.cancelledRefund : t.cancelledNoRefund, r.refunded ? 'ok' : 'bad')
    loadPublic()
    loadMine()
  }

  const requestPlan = async (plan: Plan, note: string | null) => {
    if (!user) {
      openLogin('signin')
      return false
    }
    setBusyId(plan.id)
    const r = await api.requestPurchase(plan.id, note)
    setBusyId(null)
    if (!r.ok) {
      say(errMsg(t, r.error), 'bad')
      return false
    }
    say(t.requestSent)
    loadMine()
    return true
  }

  const cancelRequest = async (r: PurchaseRequest) => {
    setBusyId(r.id)
    const res = await api.cancelPurchaseRequest(r.id)
    setBusyId(null)
    if (!res.ok) return say(errMsg(t, res.error), 'bad')
    say(t.reqCancelledOk)
    loadMine()
  }

  /** The class the visitor tapped before signing in / filling the form */
  const bookPendingOrHome = async () => {
    if (pendingClass) {
      const c = classes.find((x) => x.id === pendingClass)
      setPendingClass(null)
      // back on the day they picked it from, now signed in
      setPickedDay(c ? c.class_date : null)
      setScreen('sched')
      if (c) {
        const r = await api.bookClass(c.id)
        if (!r.ok) say(errMsg(t, r.error), 'bad')
        else say(t.bookedOk)
        loadPublic()
        loadMine()
      }
    } else {
      setScreen('home')
    }
  }

  const afterLogin = async () => {
    const p = await api.getMyProfile().catch(() => null)
    setProfile(p)
    if (!p?.full_name) return // the sheet stays open on its name step
    setLoginOpen(false)
    setGuestBrowse(false)
    // registration is not complete until the health declaration is signed
    if (!p.health_form_at) {
      setHealthMode('edit')
      setScreen('health')
      return
    }
    await bookPendingOrHome()
  }

  const openNotifs = () => {
    setNotifOpenSeen(seenAt)
    setScreen('notif')
    // clear the badge now; the rows keep their "new" dot for this visit
    const now = new Date().toISOString()
    setProfile((p) => (p ? { ...p, notifications_seen_at: now } : p))
    api.markNotificationsSeen().catch(() => {})
  }

  const onHealthDone = async (form: HealthForm) => {
    setHealth(form)
    setProfile((p) => (p ? { ...p, health_form_at: form.submitted_at } : p))
    say(t.healthSaved)
    await bookPendingOrHome()
  }

  // a push tap (or a shared link) lands on #/notifications: open the center
  useEffect(() => {
    if (!user || window.location.hash !== '#/notifications') return
    history.replaceState(null, '', window.location.pathname)
    openNotifs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, notifs.length])

  const signOut = async () => {
    // this phone stops receiving this account's pushes
    const ep = await currentEndpoint().catch(() => null)
    if (ep) api.deletePushSubscription(ep).catch(() => {})
    forgetNativeEndpoint()
    await api.signOut()
    setUser(null)
    setGuestBrowse(false)
    setScreen('home')
  }

  const loginSheet = (
    <Sheet
      closeLabel={t.close}
      open={loginOpen}
      onClose={() => {
        setLoginOpen(false)
        setPendingClass(null)
      }}
      title={profile && !profile.full_name ? t.fName : loginMode === 'signup' ? t.signUpTitle : t.loginTitle}
    >
      <LoginFlow
        t={t}
        mode={loginMode}
        profile={profile}
        onDone={afterLogin}
        onName={(n) => setProfile((p) => (p ? { ...p, full_name: n } : p))}
      />
    </Sheet>
  )

  const toastEl = toast && (
    <div
      style={{
        position: 'fixed', bottom: 'calc(84px + env(safe-area-inset-bottom))', left: 16, right: 16, zIndex: 70,
        background: toast.kind === 'ok' ? C.ok : C.warn, color: '#fff', borderRadius: 12,
        padding: '12px 14px', fontSize: 13.5, textAlign: 'center', boxShadow: '0 8px 24px rgba(0,0,0,.18)',
        animation: 'fadeUp .25s ease',
      }}
    >
      {toast.msg}
    </div>
  )

  // ---- gates
  if (!authReady) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Logo height={44} />
      </div>
    )
  }

  if (!user && !guestBrowse) {
    return (
      <div style={{ minHeight: '100vh', background: C.bg, direction: 'rtl' }}>
        <Welcome
          t={t}
          onSignUp={() => openLogin('signup')}
          onSignIn={() => openLogin('signin')}
          onBrowse={() => {
            setGuestBrowse(true)
            goSched()
          }}
          onLang={toggleLang}
        />
        {loginSheet}
        {toastEl}
      </div>
    )
  }

  const name = profile?.full_name || displayPhone(user?.phone ?? '')

  return (
    <div style={{ minHeight: '100vh', background: C.bg, direction: 'rtl' }}>
      <Header t={t} onLang={toggleLang} unread={user ? unread : null} onBell={openNotifs} />

      {api.demo && (
        <div style={{ background: C.warnSoft, color: C.warn, fontSize: 12, padding: '8px 18px', textAlign: 'center' }}>
          {t.demoNote}
        </div>
      )}

      <div style={{ maxWidth: 560, margin: '0 auto', padding: '14px 16px 104px' }}>
        {screen === 'home' && (
          user ? (
            <HomeTab
              t={t}
              name={name}
              remaining={remaining}
              until={nextExpiry}
              lastExpiry={lastExpiry}
              upcoming={mine.length}
              pendingRequests={requests.filter((r) => r.status === 'pending').length}
              updates={notifs.filter((n) => !seenAt || n.created_at > seenAt).slice(0, 2)}
              needsHealth={needsHealth}
              onHealth={() => {
                setHealthMode('edit')
                setScreen('health')
              }}
              onBook={goSched}
              onMine={() => setScreen('my')}
              onShop={() => setScreen('shop')}
              onNotifs={openNotifs}
            />
          ) : (
            <GuestCard t={t} onLogin={() => openLogin('signin')} />
          )
        )}

        {screen === 'sched' && (
          <>
            {pickedDay && <BackBar t={t} title={longDate(t, pickedDay)} onBack={backToDays} />}
            {user ? (
              <CreditsCard t={t} remaining={remaining} until={nextExpiry} lastExpiry={lastExpiry} onShop={() => setScreen('shop')} compact />
            ) : (
              <GuestCard t={t} onLogin={() => openLogin('signin')} />
            )}

            {pickedDay ? (
              // level 2: the picked day's times
              upcomingOn(pickedDay).length === 0 ? (
                <Empty text={t.noTimesLeft} />
              ) : (
                upcomingOn(pickedDay).map((c) => (
                  <ClassCard key={c.id} t={t} c={c} booked={bookedIds.has(c.id)} busy={busyId === c.id} onBook={() => book(c)} />
                ))
              )
            ) : loading ? (
              <Empty text={t.loading} />
            ) : loadErr ? (
              <RetryBox t={t} onRetry={loadPublic} />
            ) : days.length === 0 ? (
              <Empty text={t.noDays} />
            ) : (
              // level 1: the open days
              <DayList t={t} days={days} tagOf={dayTag} onPick={openDayTimes} />
            )}
          </>
        )}

        {screen === 'my' && (
          <>
            <BackBar t={t} title={t.myTitle} onBack={() => setScreen('home')} />
            <MyList t={t} user={user} mine={mine} armed={armed} busyId={busyId} cutoff={cutoff} onCancel={cancel} onLogin={() => openLogin('signin')} />
          </>
        )}

        {screen === 'health' && user && profile && (
          <>
            <BackBar t={t} title={t.healthRow} onBack={() => setScreen(pendingClass ? 'sched' : 'home')} />
            {healthMode === 'view' && health ? (
              <>
                <HealthView lang={lang} form={health} />
                <button
                  onClick={() => setHealthMode('edit')}
                  style={{ width: '100%', marginTop: 12, border: '1px solid ' + C.line, background: C.card, color: C.ink, borderRadius: 10, padding: 12, fontSize: 13.5, cursor: 'pointer' }}
                >
                  {t.healthUpdate}
                </button>
              </>
            ) : (
              <HealthFormScreen t={t} lang={lang} profile={profile} onDone={onHealthDone} />
            )}
          </>
        )}

        {screen === 'notif' && (
          <>
            <BackBar t={t} title={t.notifCenter} onBack={() => setScreen('home')} />
            <PushCard t={t} lang={lang} title={t.clientNotifTitle} hint={t.clientNotifHint} say={say} />
            <NotifCenter t={t} items={notifs} seenAt={notifOpenSeen} mine={mine} expiringIn={expiringIn} />
          </>
        )}

        {screen === 'shop' && (
          user ? (
            <ShopTab
              t={t}
              plans={plans.filter((p) => p.active)}
              requests={requests}
              busyId={busyId}
              onOpen={setOpenPlan}
              onCancelRequest={cancelRequest}
            />
          ) : (
            <GuestCard t={t} onLogin={() => openLogin('signin')} />
          )
        )}

        {screen === 'me' && user && (
          <PushCard t={t} lang={lang} title={t.clientNotifTitle} hint={t.clientNotifHint} say={say} />
        )}
        {screen === 'me' && (
          <MeTab
            t={t}
            user={user}
            profile={profile}
            packs={packs}
            onLang={toggleLang}
            onLogin={() => openLogin('signin')}
            health={health}
            onHealth={(mode) => {
              setHealthMode(mode)
              setScreen('health')
            }}
            onSignOut={signOut}
            onDeleted={() => {
              setUser(null)
              setGuestBrowse(false)
              setScreen('home')
              say(t.deleteAccountDone)
            }}
            say={say}
          />
        )}
      </div>

      <BottomNav
        t={t}
        tab={screen === 'my' || screen === 'notif' ? 'home' : screen === 'health' ? 'me' : screen}
        setTab={(v) => (v === 'sched' ? goSched() : setScreen(v))}
      />

      {loginSheet}

      <Sheet closeLabel={t.close} open={!!openPlan} onClose={() => setOpenPlan(null)} title={openPlan?.name ?? ''}>
        {openPlan && (
          <PlanSheet
            t={t}
            plan={openPlan}
            info={info}
            alreadyPending={requests.some((r) => r.plan_id === openPlan.id && r.status === 'pending')}
            busy={busyId === openPlan.id}
            onRequest={async (note) => {
              const ok = await requestPlan(openPlan, note)
              if (ok) setOpenPlan(null)
            }}
          />
        )}
      </Sheet>

      {toastEl}
    </div>
  )
}

// ---------------------------------------------------------------- welcome

function Welcome({
  t, onSignUp, onSignIn, onBrowse, onLang,
}: {
  t: Dict; onSignUp: () => void; onSignIn: () => void; onBrowse: () => void; onLang: () => void
}) {
  return (
    <div
      className="safe-top"
      style={{
        minHeight: '100vh', maxWidth: 560, margin: '0 auto', display: 'flex', flexDirection: 'column',
        padding: '0 22px calc(28px + env(safe-area-inset-bottom))',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingTop: 14 }}>
        <button
          onClick={onLang}
          style={{ border: '1px solid ' + C.line, background: 'none', color: C.muted, borderRadius: 10, padding: '6px 12px', fontSize: 12.5, cursor: 'pointer' }}
        >
          {t.langBtn}
        </button>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', position: 'relative' }}>
        {/* watermark monogram — decorative, hidden from AT */}
        <svg aria-hidden viewBox="0 0 200 200" style={{ position: 'absolute', width: 300, height: 300, opacity: 0.55, pointerEvents: 'none' }}>
          <text x="100" y="150" textAnchor="middle" className="wordmark" fontSize="170" fontWeight="300" fill={C.accentSoft}>R</text>
        </svg>
        <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14 }}>
          <Logo height={64} />
          <div style={{ width: 28, height: 1, background: C.line, margin: '6px 0' }} />
          <div style={{ fontSize: 22, fontWeight: 600, color: C.ink }}>{t.welcomeTitle}</div>
          <div style={{ fontSize: 13.5, color: C.muted, lineHeight: 1.7, maxWidth: 320 }}>{t.welcomeSub}</div>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <PrimaryBtn label={t.signUp} onClick={onSignUp} />
        <button
          onClick={onSignIn}
          style={{
            width: '100%', border: '1px solid ' + C.ink, background: 'none', color: C.ink,
            borderRadius: 10, padding: 13, fontSize: 15, fontWeight: 600, cursor: 'pointer',
          }}
        >
          {t.haveAccount}
        </button>
        <button
          onClick={onBrowse}
          style={{ border: 'none', background: 'none', color: C.muted, fontSize: 12.5, cursor: 'pointer', padding: '10px 0 0', textDecoration: 'underline', textUnderlineOffset: 3 }}
        >
          {t.browseSchedule}
        </button>
        {api.demo && (
          <div style={{ fontSize: 11.5, color: C.warn, textAlign: 'center', marginTop: 6 }}>{t.demoNote}</div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- home

function greeting(t: Dict): string {
  const h = new Date().getHours()
  if (h >= 5 && h < 12) return t.greetMorning
  if (h < 17) return t.greetNoon
  return t.greetEvening
}

function HomeTab({
  t, name, remaining, until, lastExpiry, upcoming, pendingRequests, updates, needsHealth, onHealth, onBook, onMine, onShop, onNotifs,
}: {
  t: Dict
  name: string
  remaining: number
  until: string | undefined
  lastExpiry: string | undefined
  upcoming: number
  pendingRequests: number
  updates: Notification[]
  needsHealth: boolean
  onHealth: () => void
  onBook: () => void
  onMine: () => void
  onShop: () => void
  onNotifs: () => void
}) {
  return (
    <>
      <div style={{ padding: '10px 2px 18px' }}>
        <div style={{ fontSize: 26, fontWeight: 600, color: C.ink, lineHeight: 1.2 }}>{greeting(t)},</div>
        <div style={{ fontSize: 17, color: C.muted, marginTop: 4 }}>{name}</div>
      </div>

      {needsHealth && (
        <button
          onClick={onHealth}
          style={{
            width: '100%', textAlign: 'start', background: C.warnSoft, border: '1px solid ' + C.warn, borderRadius: 12,
            padding: '14px 16px', marginBottom: 14, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12,
          }}
        >
          <Icon name="health_and_safety" size={26} color={C.warn} fill />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14.5, fontWeight: 600, color: C.ink }}>{t.healthCardTitle}</div>
            <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.5, marginTop: 2 }}>{t.healthCardBody}</div>
          </div>
          <span style={{ background: C.warn, color: '#fff', borderRadius: 10, padding: '8px 12px', fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }}>{t.healthCardCta}</span>
        </button>
      )}

      <CreditsCard t={t} remaining={remaining} until={until} lastExpiry={lastExpiry} onShop={onShop} />

      <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
        <Tile icon="calendar_month" label={t.homeBook} sub={t.schedSub} onClick={onBook} primary />
        <Tile
          icon="event_available"
          label={t.myTitle}
          sub={upcoming === 0 ? t.myEmpty : upcoming === 1 ? t.homeUpcomingOne : t.homeUpcoming.replace('{n}', iso(upcoming))}
          onClick={onMine}
        />
      </div>

      {updates.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 2px 8px' }}>
            <SectionTitle text={t.homeUpdates} />
            <button
              onClick={onNotifs}
              style={{ border: 'none', background: 'none', color: C.muted, fontSize: 12, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}
            >
              {t.allNotifs}
            </button>
          </div>
          {updates.map((n) => {
            const x = notifText(t, n)
            return (
              <button
                key={n.id}
                onClick={onNotifs}
                style={{
                  width: '100%', textAlign: 'start', background: C.card, border: '1px solid ' + C.line,
                  borderRadius: 12, padding: '11px 14px', marginBottom: 8, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 10,
                }}
              >
                <Icon name={x.icon} size={20} color={C.ink} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: C.ink, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.title}</div>
                  {x.body && (
                    <div style={{ fontSize: 12, color: C.muted, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.body}</div>
                  )}
                </div>
                <span style={{ width: 8, height: 8, borderRadius: 10, background: C.warn, flex: 'none' }} />
              </button>
            )
          })}
        </div>
      )}

      {pendingRequests > 0 && (
        <button
          onClick={onShop}
          style={{
            width: '100%', marginTop: 14, textAlign: 'start', background: C.card, border: '1px solid ' + C.line,
            borderRadius: 12, padding: '12px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10,
          }}
        >
          <Icon name="hourglass_top" size={20} color={C.muted} />
          <div style={{ flex: 1, fontSize: 13, color: C.ink }}>
            {t.myRequests} · {t.reqPending}
          </div>
          <Icon name="chevron_left" size={20} color={C.muted} />
        </button>
      )}
    </>
  )
}

function Tile({
  icon, label, sub, onClick, primary,
}: {
  icon: string; label: string; sub?: string; onClick: () => void; primary?: boolean
}) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, minWidth: 0, textAlign: 'start', cursor: 'pointer',
        background: primary ? C.ink : C.card, border: '1px solid ' + (primary ? C.ink : C.line),
        color: primary ? C.card : C.ink, borderRadius: 12, padding: '18px 14px 14px',
        display: 'flex', flexDirection: 'column', gap: 10, minHeight: 128,
      }}
    >
      <Icon name={icon} size={26} color={primary ? C.card : C.ink} />
      <div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{label}</div>
        {sub && (
          <div style={{ fontSize: 11.5, marginTop: 3, color: primary ? C.disabled : C.muted, lineHeight: 1.5 }}>{sub}</div>
        )}
      </div>
    </button>
  )
}

function BackBar({ t, title, onBack }: { t: Dict; title: string; onBack: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <button
        onClick={onBack}
        aria-label={t.back}
        style={{ border: '1px solid ' + C.line, background: C.card, borderRadius: 10, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.ink, cursor: 'pointer' }}
      >
        <Icon name="arrow_forward" size={20} />
      </button>
      <div style={{ fontSize: 17, fontWeight: 600, color: C.ink }}>{title}</div>
    </div>
  )
}

// ---------------------------------------------------------------- shop

function ShopTab({
  t, plans, requests, busyId, onOpen, onCancelRequest,
}: {
  t: Dict
  plans: Plan[]
  requests: PurchaseRequest[]
  busyId: string | null
  onOpen: (p: Plan) => void
  onCancelRequest: (r: PurchaseRequest) => void
}) {
  const recent = requests.slice(0, 5)
  return (
    <>
      <div style={{ padding: '4px 2px 14px' }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: C.ink }}>{t.shopTitle}</div>
        <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginTop: 4 }}>{t.shopSub}</div>
      </div>

      {recent.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          <SectionTitle text={t.myRequests} />
          {recent.map((r) => (
            <div
              key={r.id}
              style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: '10px 14px', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: C.ink }}>{r.plan_name}</div>
                <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>{iso(r.price_ils)} ₪ · {iso(fmtShort(r.created_at.slice(0, 10)))}</div>
              </div>
              <StatusChip t={t} status={r.status} />
              {r.status === 'pending' && (
                <button
                  onClick={() => onCancelRequest(r)}
                  disabled={busyId === r.id}
                  aria-label={t.reqCancel}
                  title={t.reqCancel}
                  style={{ border: 'none', background: 'none', color: C.muted, cursor: 'pointer', padding: 4, display: 'flex' }}
                >
                  <Icon name="close" size={18} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {plans.length === 0 ? (
        <Empty text={t.shopEmpty} />
      ) : (
        plans.map((p) => (
          <button
            key={p.id}
            onClick={() => onOpen(p)}
            style={{
              width: '100%', textAlign: 'start', background: C.card, border: '1px solid ' + C.line,
              borderRadius: 12, padding: 0, marginBottom: 10, cursor: 'pointer', display: 'flex', alignItems: 'stretch', overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: 92, background: C.accentSoft, display: 'flex', flexDirection: 'column',
                alignItems: 'center', justifyContent: 'center', padding: '14px 6px',
              }}
            >
              <span className="wordmark" style={{ fontSize: 38, fontWeight: 300, color: C.ink, lineHeight: 1 }}>{p.sessions}</span>
              <span style={{ fontSize: 10.5, color: C.muted, marginTop: 4 }}>{p.sessions === 1 ? t.planSessionOne : t.planSessions.replace('{n}', '').trim()}</span>
            </div>
            <div style={{ flex: 1, padding: '14px 14px', minWidth: 0 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: C.ink }}>{p.name}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
                {p.valid_months === 1 ? t.planValidityOne : t.planValidity.replace('{n}', iso(p.valid_months))}
                {p.sessions > 1 && ' · ' + t.planPerSession.replace('{n}', iso(Math.round(p.price_ils / p.sessions)))}
              </div>
              <div style={{ fontSize: 20, fontWeight: 600, color: C.ink, marginTop: 8, fontVariantNumeric: 'tabular-nums' }}>
                {iso(p.price_ils)} ₪
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', paddingInlineEnd: 10, color: C.muted }}>
              <Icon name="chevron_left" size={22} />
            </div>
          </button>
        ))
      )}
    </>
  )
}

function StatusChip({ t, status }: { t: Dict; status: PurchaseRequest['status'] }) {
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

function PlanSheet({
  t, plan, info, alreadyPending, busy, onRequest,
}: {
  t: Dict
  plan: Plan
  info: StudioInfo | null
  alreadyPending: boolean
  busy: boolean
  onRequest: (note: string | null) => void
}) {
  const [note, setNote] = useState('')
  const waHref = info?.whatsapp_phone
    ? `https://wa.me/${info.whatsapp_phone.replace(/\D/g, '')}?text=${encodeURIComponent(
        t.waPurchaseMsg.replace('{plan}', plan.name).replace('{p}', String(plan.price_ils)),
      )}`
    : null

  return (
    <div style={{ paddingBottom: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
        <div style={{ fontSize: 28, fontWeight: 600, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>{iso(plan.price_ils)} ₪</div>
        <div style={{ fontSize: 12.5, color: C.muted }}>
          {plan.sessions === 1 ? t.planSessionOne : t.planSessions.replace('{n}', iso(plan.sessions))}
          {' · '}
          {plan.valid_months === 1 ? t.planValidityOne : t.planValidity.replace('{n}', iso(plan.valid_months))}
        </div>
      </div>
      {plan.description && (
        <div style={{ fontSize: 13, color: C.ink, lineHeight: 1.6, marginBottom: 10 }}>{plan.description}</div>
      )}
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginBottom: 14 }}>{t.shopSub}</div>

      <Field label={t.requestNoteLabel + ' ' + t.optional}>
        <input value={note} onChange={(e) => setNote(e.target.value)} style={inputStyle} />
      </Field>

      <PrimaryBtn
        label={busy ? t.loading : alreadyPending ? t.reqPending : t.requestBtn}
        disabled={busy || alreadyPending}
        onClick={() => onRequest(note.trim() || null)}
      />

      {(plan.payment_url || waHref) && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {plan.payment_url && (
            <a
              href={plan.payment_url}
              target="_blank"
              rel="noreferrer"
              style={{ flex: 1, textAlign: 'center', border: '1px solid ' + C.ink, color: C.ink, borderRadius: 10, padding: 11, fontSize: 13.5, fontWeight: 600, textDecoration: 'none' }}
            >
              {t.payLink}
            </a>
          )}
          {waHref && (
            <a
              href={waHref}
              target="_blank"
              rel="noreferrer"
              style={{ flex: 1, textAlign: 'center', border: '1px solid ' + C.line, color: C.ink, borderRadius: 10, padding: 11, fontSize: 13.5, textDecoration: 'none' }}
            >
              {t.waStudio}
            </a>
          )}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- pieces

function Header({
  t, onLang, unread, onBell,
}: {
  t: Dict; onLang: () => void; unread: number | null; onBell: () => void
}) {
  return (
    <div className="safe-top" style={{ background: C.bg, borderBottom: '1px solid ' + C.line }}>
      <div
        style={{
          maxWidth: 560, margin: '0 auto', padding: '14px 16px 12px',
          display: 'flex', alignItems: 'center', gap: 10,
        }}
      >
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
          <Logo height={40} />
          <div style={{ fontSize: 11.5, color: C.muted, letterSpacing: 0.2 }}>{t.tag}</div>
        </div>
        {unread !== null && (
          <button
            onClick={onBell}
            aria-label={t.notifCenter}
            style={{
              position: 'relative', border: '1px solid ' + C.line, background: C.card, color: C.ink,
              borderRadius: 10, width: 34, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}
          >
            <Icon name="notifications" size={20} />
            {unread > 0 && (
              <span
                style={{
                  position: 'absolute', top: -5, insetInlineEnd: -5, minWidth: 16, height: 16, padding: '0 4px',
                  background: C.warn, color: '#fff', borderRadius: 10, fontSize: 10, fontWeight: 600,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                }}
              >
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
        )}
        <button
          onClick={onLang}
          style={{
            border: '1px solid ' + C.line, background: 'none', color: C.muted, borderRadius: 10,
            padding: '6px 12px', fontSize: 12.5, cursor: 'pointer',
          }}
        >
          {t.langBtn}
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- notifications

type NotifView = { icon: string; title: string; body: string | null }

/** Text for a stored notification, in the reader's language. The row carries
 *  only kind + data; nothing here comes from the admin's language. */
function notifText(t: Dict, n: Notification): NotifView {
  const d = n.data as Record<string, string | number | boolean | null | undefined>
  const str = (k: string) => (d[k] == null ? '' : String(d[k]))
  const when = () => (d.class_date ? longDate(t, str('class_date')) : '') 
  const at = () => (d.start_time ? iso(hhmm(str('start_time'))) : '')
  const packBody = () =>
    t.nPackBody
      .replace('{plan}', str('plan_name') || str('note') || t.classDefault)
      .replace('{n}', iso(str('sessions')))
      .replace('{d}', d.valid_until ? iso(fmtShort(str('valid_until'))) : '—')
  switch (n.kind) {
    case 'announcement':
      return { icon: 'campaign', title: str('title'), body: str('body') || null }
    case 'purchase_approved':
      return { icon: 'card_membership', title: t.nPurchaseApproved, body: packBody() }
    case 'purchase_declined':
      return {
        icon: 'shopping_bag', title: t.nPurchaseDeclined,
        body: t.nDeclinedBody.replace('{plan}', str('plan_name')) + (d.admin_note ? ' “' + str('admin_note') + '”' : ''),
      }
    case 'pack_granted':
      return { icon: 'card_membership', title: t.nPackGranted, body: packBody() }
    case 'class_cancelled':
      return { icon: 'event_busy', title: t.nClassCancelled, body: t.nClassCancelledBody.replace('{d}', when()).replace('{t}', at()) }
    case 'booking_removed':
      return {
        icon: 'person_remove', title: t.nRemoved,
        body: `${when()} · ${at()} · ${d.refunded ? t.nRemovedRefund : t.nRemovedNoRefund}`,
      }
    case 'class_moved': {
      const was = (d.old_date ? longDate(t, str('old_date')) : '') + (d.old_time ? ' · ' + iso(hhmm(str('old_time'))) : '')
      return {
        icon: 'event_repeat', title: t.nClassMoved,
        body: t.nClassMovedBody.replace('{d}', when()).replace('{t}', at()).replace('{was}', was),
      }
    }
  }
}

function timeAgo(t: Dict, isoTs: string): string {
  const then = new Date(isoTs)
  const mins = Math.round((Date.now() - then.getTime()) / 60000)
  if (mins < 1) return t.timeNow
  if (mins < 60) return t.timeAgoMin.replace('{n}', iso(mins))
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  if (then >= today) return t.timeAgoHours.replace('{n}', iso(Math.round(mins / 60)))
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)
  if (then >= yesterday) return t.timeYesterday
  return iso(fmtShort(toISODate(then)))
}

function NotifCenter({
  t, items, seenAt, mine, expiringIn,
}: {
  t: Dict; items: Notification[]; seenAt: string | null; mine: MyBooking[]; expiringIn: number | null
}) {
  // Derived reminders — nothing is stored for these; they exist while true.
  const today = toISODate(new Date())
  const tomorrow = toISODate(dateOf(0, new Date().getDay() + 1))
  const virtual: (NotifView & { key: string })[] = []
  mine
    .filter((b) => b.class_date === today || b.class_date === tomorrow)
    .forEach((b) =>
      virtual.push({
        key: 'v-' + b.id, icon: 'schedule',
        title: b.class_date === today ? t.nReminderToday : t.nReminderTomorrow,
        body: `${iso(hhmm(b.start_time))} · ${b.label || t.classDefault}`,
      }),
    )
  if (expiringIn !== null && expiringIn >= 0 && expiringIn <= 7) {
    virtual.push({
      key: 'v-exp', icon: 'hourglass_bottom',
      title: expiringIn === 0 ? t.creditsExpiresToday : t.creditsExpiring.replace('{n}', iso(expiringIn)),
      body: t.creditsBuyHint,
    })
  }

  if (virtual.length === 0 && items.length === 0) return <Empty text={t.notifEmpty} />

  return (
    <>
      {virtual.map((v) => (
        <NotifRow key={v.key} view={v} time={t.sectionToday} isNew={false} accent />
      ))}
      {items.map((n) => (
        <NotifRow key={n.id} view={notifText(t, n)} time={timeAgo(t, n.created_at)} isNew={!seenAt || n.created_at > seenAt} />
      ))}
    </>
  )
}

function NotifRow({ view, time, isNew, accent }: { view: NotifView; time: string; isNew: boolean; accent?: boolean }) {
  return (
    <div
      style={{
        background: accent ? C.accentSoft : C.card, border: '1px solid ' + C.line, borderRadius: 12,
        padding: '12px 14px', marginBottom: 8, display: 'flex', alignItems: 'flex-start', gap: 12,
      }}
    >
      <div
        style={{
          width: 36, height: 36, borderRadius: 10, background: accent ? C.card : C.accentSoft,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none',
        }}
      >
        <Icon name={view.icon} size={20} color={C.ink} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <div style={{ flex: 1, fontSize: 14, fontWeight: isNew ? 600 : 500, color: C.ink }}>{view.title}</div>
          <div style={{ fontSize: 11, color: C.muted, whiteSpace: 'nowrap' }}>{time}</div>
        </div>
        {view.body && <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.55, marginTop: 3 }}>{view.body}</div>}
      </div>
      {isNew && <span style={{ width: 8, height: 8, borderRadius: 10, background: C.warn, flex: 'none', marginTop: 6 }} />}
    </div>
  )
}

function CreditsCard({
  t, remaining, until, lastExpiry, onShop, compact,
}: {
  t: Dict; remaining: number; until: string | undefined; lastExpiry: string | undefined; onShop: () => void; compact?: boolean
}) {
  const left = until ? daysUntil(until) : null
  const soon = left !== null && left <= 7
  const expired = remaining === 0 && !!lastExpiry && daysUntil(lastExpiry) < 0
  return (
    <div
      style={{
        background: remaining > 0 ? C.accentSoft : C.card, border: '1px solid ' + C.line,
        borderRadius: 12, padding: compact ? '12px 14px' : 16, marginBottom: 14,
        display: 'flex', alignItems: 'center', gap: 12,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>{t.creditsTitle}</div>
        <div style={{ fontSize: compact ? 17 : 22, fontWeight: 600, color: C.ink }}>
          {remaining === 0 ? t.creditsNone : remaining === 1 ? t.creditsOne : t.creditsLeft.replace('{n}', iso(remaining))}
        </div>
        {until && (
          <div style={{ fontSize: 12.5, color: soon ? C.warn : C.muted, marginTop: 6 }}>
            {left !== null && left <= 0
              ? t.creditsExpiresToday
              : soon
                ? t.creditsExpiring.replace('{n}', iso(left!))
                : t.creditsUntil.replace('{d}', iso(fmtShort(until)))}
          </div>
        )}
        {expired && lastExpiry && (
          <div style={{ fontSize: 12.5, color: C.warn, marginTop: 6 }}>{t.creditsExpired.replace('{d}', iso(fmtShort(lastExpiry)))}</div>
        )}
      </div>
      {remaining === 0 && (
        <button
          onClick={onShop}
          style={{ border: 'none', background: C.ink, color: C.card, borderRadius: 10, padding: '10px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          {t.buyCta}
        </button>
      )}
    </div>
  )
}

function GuestCard({ t, onLogin }: { t: Dict; onLogin: () => void }) {
  return (
    <div style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: 16, marginBottom: 14 }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: C.ink, marginBottom: 4 }}>{t.schedTitle}</div>
      <div style={{ fontSize: 12.5, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>{t.guestHint}</div>
      <button
        onClick={onLogin}
        style={{
          border: 'none', background: C.accent, color: '#fff', borderRadius: 10,
          padding: '10px 20px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
        }}
      >
        {t.signInCta}
      </button>
    </div>
  )
}

/** Vertical accordion of upcoming days. One day open at a time; the rest
 *  show only their date — no class count, no availability hint. */
/** Level 1 of the schedule: the days that still have a class, as a vertical
 *  list. Tapping one opens that day's times on their own screen. */
function DayList({
  t, days, tagOf, onPick,
}: {
  t: Dict
  days: string[]
  tagOf: (dateISO: string) => 'booked' | 'full' | null
  onPick: (dateISO: string) => void
}) {
  const today = toISODate(new Date())
  const tm = new Date()
  tm.setDate(tm.getDate() + 1)
  const tomorrow = toISODate(tm)
  let lastMonth = -1
  const chip: React.CSSProperties = { fontSize: 11, fontWeight: 600, borderRadius: 10, padding: '3px 8px', whiteSpace: 'nowrap' }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ fontSize: 12.5, color: C.muted, margin: '0 2px' }}>{t.pickDayHint}</div>
      {days.map((dateISO) => {
        const [y, m, d] = dateISO.split('-').map(Number)
        const dt = new Date(y, m - 1, d)
        const monthHeader = dt.getMonth() !== lastMonth
        lastMonth = dt.getMonth()
        const when = dateISO === today ? t.sectionToday : dateISO === tomorrow ? t.sectionTomorrow : null
        const tag = tagOf(dateISO)
        return (
          <div key={dateISO}>
            {monthHeader && (
              <div style={{ fontSize: 12, fontWeight: 600, color: C.muted, margin: '10px 2px 6px', letterSpacing: 0.3 }}>
                {t.months[dt.getMonth()]}
              </div>
            )}
            <button
              onClick={() => onPick(dateISO)}
              style={{
                width: '100%', textAlign: 'start', background: C.card, border: '1px solid ' + (tag === 'booked' ? C.accent : C.line),
                borderRadius: 12, padding: '13px 14px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, color: C.ink,
              }}
            >
              <div style={{ fontSize: 22, fontWeight: 600, minWidth: 34, fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>{iso(d)}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14.5, fontWeight: 600 }}>{t.daysFull[dt.getDay()]}</div>
                <div style={{ fontSize: 11.5, color: C.muted }}>{iso(d)} {t.months[dt.getMonth()]}</div>
              </div>
              {when && <span style={{ ...chip, border: '1px solid ' + C.line }}>{when}</span>}
              {tag === 'booked' && <span style={{ ...chip, background: C.accentSoft, color: C.accentDark }}>{t.dayBookedTag}</span>}
              {tag === 'full' && <span style={{ ...chip, color: C.warn, border: '1px solid ' + C.line }}>{t.full}</span>}
              <Icon name="chevron_left" size={22} color={C.muted} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

function ClassCard({
  t, c, booked, busy, onBook,
}: {
  t: Dict; c: ClassRow; booked: boolean; busy: boolean; onBook: () => void
}) {
  const past = slotDateTime(c.class_date, c.start_time) < new Date()
  const disabled = past || busy || (c.is_full && !booked)

  return (
    <div
      style={{
        background: C.card, border: '1px solid ' + (booked ? C.accent : C.line), borderRadius: 12,
        padding: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 12,
      }}
    >
      <div style={{ textAlign: 'center', minWidth: 58 }}>
        <div style={{ fontSize: 19, fontWeight: 600, color: past ? C.muted : C.ink, fontVariantNumeric: 'tabular-nums' }}>
          {iso(hhmm(c.start_time))}
        </div>
        <div style={{ fontSize: 11, color: C.muted }}>{t.minutes.replace('{n}', iso(c.duration_min))}</div>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14.5, fontWeight: 500, color: past ? C.muted : C.ink }}>{c.label || t.classDefault}</div>
        {/* deliberately no "N spots left · X of Y": the studio does not
            publish occupancy — a class is open, or it is full */}
        {c.is_full && !booked && !past && (
          <div style={{ fontSize: 12, color: C.warn, marginTop: 2 }}>{t.full}</div>
        )}
      </div>

      {booked ? (
        <div
          style={{
            background: C.accentSoft, color: C.accentDark, borderRadius: 10, padding: '8px 14px',
            fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap',
          }}
        >
          {t.booked}
        </div>
      ) : (
        <button
          onClick={onBook}
          disabled={disabled}
          style={{
            border: 'none', background: disabled ? C.disabled : C.accent, color: '#fff', borderRadius: 10,
            padding: '10px 16px', fontSize: 13.5, fontWeight: 600, whiteSpace: 'nowrap',
            cursor: disabled ? 'default' : 'pointer',
          }}
        >
          {busy ? '…' : past ? t.past : c.is_full ? t.full : t.bookBtn}
        </button>
      )}
    </div>
  )
}

function MyList({
  t, user, mine, armed, busyId, cutoff, onCancel, onLogin,
}: {
  t: Dict
  user: AuthUser | null
  mine: MyBooking[]
  armed: string | null
  busyId: string | null
  cutoff: number
  onCancel: (b: MyBooking) => void
  onLogin: () => void
}) {
  if (!user) return <GuestCard t={t} onLogin={onLogin} />
  return (
    <>
      {mine.length === 0 ? (
        <Empty text={t.myEmpty} />
      ) : (
        mine.map((b) => (
          <div
            key={b.id}
            style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: 14, marginBottom: 10 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ textAlign: 'center', minWidth: 58 }}>
                <div style={{ fontSize: 19, fontWeight: 600, color: C.ink, fontVariantNumeric: 'tabular-nums' }}>
                  {iso(hhmm(b.start_time))}
                </div>
                <div style={{ fontSize: 11, color: C.muted }}>{t.minutes.replace('{n}', iso(b.duration_min))}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14.5, fontWeight: 500, color: C.ink }}>{b.label || t.classDefault}</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{longDate(t, b.class_date)}</div>
              </div>
            </div>
            <button
              onClick={() => onCancel(b)}
              disabled={busyId === b.id}
              style={{
                marginTop: 12, width: '100%', border: '1px solid ' + (armed === b.id ? C.warn : C.line),
                background: armed === b.id ? C.warnSoft : 'none', color: armed === b.id ? C.warn : C.muted,
                borderRadius: 10, padding: '9px 0', fontSize: 13, cursor: 'pointer', fontWeight: armed === b.id ? 600 : 400,
              }}
            >
              {busyId === b.id ? t.loading : armed === b.id ? t.cancelConfirm : t.cancelBtn}
            </button>
          </div>
        ))
      )}
      <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, padding: '4px 2px' }}>
        {t.cancelPolicy.replace('{n}', iso(cutoff))}
      </div>
    </>
  )
}

function MeTab({
  t, user, profile, packs, onLang, onLogin, health, onHealth, onSignOut, onDeleted, say,
}: {
  t: Dict
  user: AuthUser | null
  profile: Profile | null
  packs: Pack[]
  onLang: () => void
  onLogin: () => void
  health: HealthForm | null
  onHealth: (mode: 'view' | 'edit') => void
  onSignOut: () => void
  onDeleted: () => void
  say: (m: string, k?: 'ok' | 'bad') => void
}) {
  const [delArmed, setDelArmed] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!user) return <GuestCard t={t} onLogin={onLogin} />

  const del = async () => {
    if (!delArmed) {
      setDelArmed(true)
      window.setTimeout(() => setDelArmed(false), 5000)
      return
    }
    setBusy(true)
    const r = await api.deleteMyAccount()
    setBusy(false)
    if (!r.ok) return say(errMsg(t, r.error), 'bad')
    onDeleted()
  }

  return (
    <>
      <div style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <div style={{ fontSize: 18, fontWeight: 600, color: C.ink }}>
          {profile?.full_name || t.welcome.replace('{n}', '')}
        </div>
        <div style={{ fontSize: 13, color: C.muted, marginTop: 3, direction: 'ltr', textAlign: 'right' }}>
          {displayPhone(profile?.phone || user.phone)}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button
            onClick={onLang}
            style={{ flex: 1, border: '1px solid ' + C.line, background: 'none', color: C.ink, borderRadius: 10, padding: '9px 0', fontSize: 13, cursor: 'pointer' }}
          >
            {t.langBtn}
          </button>
          <button
            onClick={onSignOut}
            style={{ flex: 1, border: '1px solid ' + C.line, background: 'none', color: C.ink, borderRadius: 10, padding: '9px 0', fontSize: 13, cursor: 'pointer' }}
          >
            {t.logout}
          </button>
        </div>
      </div>

      <div style={{ background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: '12px 14px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10 }}>
        <Icon name="health_and_safety" size={22} color={health ? (health.flags.length ? C.warn : C.ok) : C.warn} fill={!!health} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, color: C.ink }}>{t.healthRow}</div>
          <div style={{ fontSize: 11.5, color: health ? C.muted : C.warn, marginTop: 2 }}>
            {health ? t.healthSubmittedOn.replace('{d}', iso(fmtShort(health.submitted_at.slice(0, 10)))) : t.healthMissing}
          </div>
        </div>
        {health ? (
          <>
            <button onClick={() => onHealth('view')} style={{ border: '1px solid ' + C.line, background: 'none', color: C.ink, borderRadius: 10, padding: '7px 12px', fontSize: 12.5, cursor: 'pointer' }}>{t.healthView}</button>
            <button onClick={() => onHealth('edit')} style={{ border: '1px solid ' + C.line, background: 'none', color: C.muted, borderRadius: 10, padding: '7px 12px', fontSize: 12.5, cursor: 'pointer' }}>{t.healthUpdate}</button>
          </>
        ) : (
          <button onClick={() => onHealth('edit')} style={{ border: 'none', background: C.warn, color: '#fff', borderRadius: 10, padding: '8px 12px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>{t.healthCardCta}</button>
        )}
      </div>

      {packs.length > 0 && (
        <>
          <SectionTitle text={t.creditsTitle} />
          {packs.map((p) => (
            <div
              key={p.id}
              style={{
                background: C.card, border: '1px solid ' + C.line, borderRadius: 12, padding: '12px 14px',
                marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10,
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, color: p.is_active ? C.ink : C.muted }}>
                  {t.balanceLine.replace('{n}', iso(p.remaining)).replace('{d}', iso(fmtShort(p.valid_until)))}
                </div>
                <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                  {p.note ? p.note + ' · ' : ''}{iso(p.sessions_total)} · {iso(fmtShort(p.valid_from))}
                  {p.price_ils != null && ' · ' + iso(p.price_ils) + ' ₪'}
                </div>
              </div>
              {p.is_active && p.remaining > 0 && (
                <span style={{ background: C.accentSoft, color: C.accentDark, borderRadius: 10, padding: '4px 10px', fontSize: 11.5 }}>
                  {iso(p.remaining)}
                </span>
              )}
            </div>
          ))}
        </>
      )}

      <div style={{ marginTop: 22, padding: '14px 2px', borderTop: '1px solid ' + C.line }}>
        <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.6, marginBottom: 10 }}>{t.deleteAccountWarn}</div>
        <button
          onClick={del}
          disabled={busy}
          style={{
            width: '100%', border: '1px solid ' + C.warn, background: delArmed ? C.warnSoft : 'none',
            color: C.warn, borderRadius: 10, padding: '10px 0', fontSize: 13, cursor: 'pointer',
            fontWeight: delArmed ? 600 : 400,
          }}
        >
          {busy ? t.loading : delArmed ? t.deleteAccountConfirm : t.deleteAccount}
        </button>
      </div>
      <div style={{ textAlign: 'center', marginTop: 18 }}>
        <a href="#/admin" style={{ fontSize: 11.5, color: C.muted, textDecoration: 'none' }}>
          {t.adminLink}
        </a>
      </div>
    </>
  )
}

function LoginFlow({
  t, mode, profile, onDone, onName,
}: {
  t: Dict
  mode: AuthMode
  profile: Profile | null
  onDone: () => void
  onName: (n: string) => void
}) {
  const [step, setStep] = useState<'phone' | 'otp'>('phone')
  const [raw, setRaw] = useState('')
  const [e164, setE164] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [name, setName] = useState('')

  // signed in but nameless — the roster would otherwise show a blank row
  if (profile && !profile.full_name) {
    const save = async () => {
      if (name.trim().length < 2) return setErr(t.errors.invalid_name)
      setBusy(true)
      await api.setMyName(name.trim())
      setBusy(false)
      onName(name.trim())
      onDone()
    }
    return (
      <div style={{ paddingBottom: 10 }}>
        <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>{t.namePrompt}</div>
        <Field label={t.fName}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.fNamePh}
            autoFocus
            style={inputStyle}
          />
        </Field>
        {err && <ErrLine text={err} />}
        <PrimaryBtn label={busy ? t.loading : t.saveName} disabled={busy} onClick={save} />
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

  if (step === 'otp') {
    return (
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
    )
  }

  return (
    <div style={{ paddingBottom: 10 }}>
      <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>
        {mode === 'signup' ? t.signUpSub : t.loginSub}
      </div>
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

function BottomNav({ t, tab, setTab }: { t: Dict; tab: Tab; setTab: (v: Tab) => void }) {
  const items: [Tab, string, string][] = [
    ['home', 'home', t.navHome],
    ['sched', 'calendar_month', t.navSched],
    ['shop', 'shopping_bag', t.navShop],
    ['me', 'person', t.navMe],
  ]
  return (
    <div
      style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, background: C.card,
        borderTop: '1px solid ' + C.line, zIndex: 40,
        paddingBottom: 'calc(6px + env(safe-area-inset-bottom))',
      }}
    >
      <div style={{ maxWidth: 560, margin: '0 auto', display: 'flex' }}>
        {items.map(([id, icon, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              flex: 1, border: 'none', background: 'none', cursor: 'pointer', padding: '8px 0 4px',
              color: tab === id ? C.accent : C.muted, display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: 2,
            }}
          >
            <Icon name={icon} size={23} fill={tab === id} />
            <span style={{ fontSize: 11, fontWeight: tab === id ? 600 : 400 }}>{label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
