# Rudeen Pilates — booking app

React 19 + Vite + TypeScript, RTL Hebrew/Arabic, no UI library. Backend is
Supabase (`../supabase_setup.sql`); see `../SETUP_GUIDE.md` to stand one up.

```bash
npm install
npm run dev        # http://localhost:5174
```

- Client app: `/` — welcome (sign up / sign in) → home · לוח · מוצרים · חשבון
- Admin dashboard: `/#/admin` (gated on `profiles.is_admin`) — לוח · מנויים · מוצרים · תזכורות

**Demo mode:** with `.env.local` empty the whole app runs against an in-memory
backend (`src/lib/demo.ts`) seeded with four weeks of classes, eight clients and
live packs. The OTP code is `123456`. Fill in the env vars and restart — no code
changes.

## The model

| Thing | Rule |
|---|---|
| Credit pack | admin grants N sessions after payment; valid one month from that day |
| Expiry | unused sessions are lost at `valid_until`; there is no rollover |
| Booking | costs one credit, taken from the pack that **expires soonest** |
| Cancel | earlier than `cancel_cutoff_hours` (12) refunds the credit, later burns it |
| Capacity | per class, default 8; enforced inside the RPC under `SELECT … FOR UPDATE` |
| Guest booking | admin-only, no account, `consumes_credit = false` |

**Buying stays outside the app.** A client sends a *purchase request* for a
plan; the admin approves after the money arrives (Bit / cash) and the approval
opens the pack. Plan fields are snapshotted onto the request, so repricing a
plan never rewrites what someone was sold. Payment links on a plan are optional
and open in a new tab — no card data ever touches this app.

**Notifications store `kind` + `data`, never prose.** `admin_grant_pack`,
`admin_decide_purchase`, `admin_cancel_class` and `admin_cancel_booking` call
`notify_user(...)` with structured data; `notifText()` in `ClientApp.tsx` turns
it into Hebrew or Arabic at render time, so a Hebrew-speaking admin's action
reads correctly to an Arabic-speaking client. Only announcements carry free
text (written once, shown as is). Reminders for today/tomorrow and the
"expiring soon" item are derived on the client and never stored.

`remaining` is never stored. It is
`sessions_total - count(bookings where consumes_credit)`, computed by the
`pack_balance` view, so a balance cannot drift from the bookings that spent it.

## How it maps to the backend

| App action | Supabase call |
|---|---|
| Send code | `auth.signInWithOtp({ phone })` (Twilio Verify) |
| Verify | `auth.verifyOtp({ phone, token, type: 'sms' })` |
| Schedule | `from('class_availability')` — aggregate counts only, readable by `anon` |
| My credits | `from('pack_balance').eq('user_id', me)` |
| Book | `rpc('book_class', { p_class_id })` |
| Cancel | `rpc('cancel_my_booking', { p_booking_id })` |
| Admin roster | `from('class_roster')` — names and phones, `security_invoker = on` |
| Clients + balances | `from('client_directory')` |
| Grant a pack | `rpc('admin_grant_pack', …)` |
| Attendance | `rpc('admin_set_attendance', …)` |
| Weekly schedule | `from('class_template').eq('active', true)`; save = `rpc('admin_save_template', { p_rows })` → `resync_classes()` (v1.5) |
| Edit one class | `rpc('admin_update_class', …)` — moving it notifies the booked (`class_moved`), marks it `detached` |
| Book a client (admin) | `rpc('admin_book_client', { p_class_id, p_user_id })` — spends her credit, no health gate |
| New client (admin) | `functions.invoke('admin-create-client', { full_name, phone })` — service-role `auth.admin.createUser`, phone-confirmed |
| Plans catalogue | `from('plans')` — active rows readable by anyone, admins see hidden ones too |
| Ask to buy | `rpc('request_purchase', { p_plan_id, p_note })` → `purchase_requests` row |
| Approve / decline | `rpc('admin_decide_purchase', { p_id, p_approve, p_note })` — approval inserts the `credit_packs` row in the same transaction |
| Health declaration | `rpc('submit_health_form', …)` → immutable `health_forms` row + `profiles.health_form_at`; `book_class` returns `health_form_required` until one exists |
| Notifications | `from('notifications')` — announcements (`user_id null`) + mine; `profiles.notifications_seen_at` is the read marker |
| Push device | `rpc('save_push_subscription', …)` — web VAPID keys or `'<apns|fcm>:<token>'`; removed on sign-out |
| Announcement | admin `insert` into `notifications` (RLS: admin, `user_id null`, kind `announcement`) |
| Live updates | realtime on `classes` + `bookings` + `purchase_requests` + `plans` + `notifications`, plus refetch on tab focus |

Every RPC returns `{ ok, error? }` JSON rather than raising, and every error
code has an he/ar message in `src/i18n.ts`: `class_full`, `no_credits`,
`already_booked`, `class_past`, `class_cancelled`, `not_admin`, `invalid_*`,
plus the OTP and network fallbacks.

## Design decisions worth keeping

- **A seat is taken by any booking that is not cancelled** — not by
  `status = 'booked'`. Marking attendance moves the row to `attended` /
  `no_show`; counting only `booked` would free the seat after the fact, drop the
  person from the roster, and disarm the one-booking-per-class unique index.
- **The timetable lives in `class_template`, in data.** Nothing in the frontend
  maps over a hardcoded list of days or times — both apps render whatever
  classes exist. That is what makes a one-off extra class actually appear.
- **The WhatsApp reminder is composed in the frontend**, never concatenated in
  SQL: a raw `wa.me` query truncates at the first `#`, and demo mode encodes
  correctly so testing would hide it.
- **`markReminderSent` is fire-and-forget** on tap. Awaiting it before
  navigating gets the WhatsApp tab popup-blocked on iOS Safari. The chip records
  "opened WhatsApp", so the button never disappears — it becomes "send again".
- **Account deletion anonymises**, keeping the studio's attendance history, and
  is scoped to *future* classes. An unscoped version cancels everything the
  person ever attended.
- **Safe areas:** `viewport-fit=cover` in index.html is what makes `env()`
  non-zero; a *bare* `env()` in a React inline style is dropped by WebKit, so
  use `calc(6px + env(...))` or the `.safe-top` class.

## Native app

`ios/` and `android/` are Capacitor projects wrapping `dist/` — see
`../NATIVE_GUIDE.md` for accounts, APNs/FCM secrets and store notes.
`npm run ios` / `npm run android` build, sync and open the IDE.

Things that only bite in the native shell:
- **No web push in a WKWebView.** `lib/push.ts` registers a native token there
  (`@capacitor/push-notifications`) and a VAPID subscription on the web; the
  `push` edge function sends over APNs / FCM / web-push by row `kind`.
- **`window.location.origin` is `capacitor://localhost`.** Any customer-facing
  link must be absolute; `VITE_PUBLIC_URL` exists for that.
- Safe areas: `viewport-fit=cover`, `.safe-top` on headers, `calc()` insets on
  the bottom nav — a bare `env()` in a React inline style is dropped by WebKit.
  `App.tsx` sets the status-bar glyph colour per route.
- Do NOT run `@capacitor/assets generate` without `--ios --android` — the PWA
  pass overwrites `public/manifest.webmanifest`.

## Layout

```
src/
  App.tsx              hash routing: #/admin → admin, everything else → client
  client/ClientApp.tsx schedule · my classes · account
  admin/AdminApp.tsx   לוח · מנויים · תזכורות
  components/          Icon, Logo, OtpPanel, Sheet, ui (shared primitives)
  lib/
    api.ts             Supabase implementation of the Api interface
    demo.ts            in-memory implementation of the same interface
    types.ts           domain types + the Api contract both must satisfy
    dates.ts phone.ts push.ts theme.ts supabase.ts
  i18n.ts              he + ar dictionaries, parallel key order
```

`api.ts` ends with `export const api: Api = isConfigured ? realApi : demoApi`,
so TypeScript refuses to build if the two implementations drift apart.

## Brand

The palette is derived from the RUDEEN wordmark — thin geometric black type on
warm cream — and lives only in `src/lib/theme.ts`. There is no hue accent:
primary actions and selected states are ink, emphasis is weight, semantic
green/terracotta is reserved for ok/warn. Never type a hex outside `theme.ts`.

**Logo files:** `public/logo.png` (ink) and `public/logo-light.png` (cream) are
the studio's wordmark cut out of the scanned PDF — paper keyed to transparent,
ink recoloured to `C.ink`. `Logo.tsx` picks by tone; a typographic fallback in
Jost renders only if a file 404s. To re-cut from a new scan: render the PDF
with `qlmanage -t -s 1400`, threshold luminance (paper ≈ 236, ink ≈ 40),
ignore the scan's dark frame, crop to the ink bounds with 3% padding.

`public/icon-*.png` are the wordmark centred on cream (82% width; 62% for the
maskable variant). `assets/logo.png` / `logo-dark.png` feed
`npx @capacitor/assets generate --ios --android …` for the store icons and
splash — run it with the `--ios --android` flags only and check
`manifest.webmanifest` afterwards; the tool rewrites it when `--pwa` is on.

## Health questionnaire (v1.4)

`src/health/text.ts` holds the studio's questionnaire verbatim in Arabic and
translated to Hebrew; `src/health/HealthForm.tsx` renders it (9 sections,
yes/no chips, multi-select with an exclusive "none", 0–10 pain scale, finger
signature on a canvas, the four declaration paragraphs, consent checkbox).
Answers are stored as **codes** in `health_forms.answers` (jsonb) so the admin
reads any form in her own language; `flags` is computed from the answers
(`computeFlags`) and drives the roster/client markers. Submissions are
immutable — "update" inserts a new row, the latest wins. Only the owner and
admins can select; nobody can update or delete; rows cascade with the profile.
`book_class` refuses with `health_form_required` when no form exists, so the
gate holds even if the UI is bypassed.

## Timetable rules (v1.5)

- The standing week is `class_template`, edited in the app (לוח → **לוח שבועי
  קבוע**). Rows are matched on weekday + time: a removed slot is switched off
  (`active = false`), never deleted, so the classes it made keep their link.
- Every generated class remembers its slot (`classes.template_id`). The
  generator checks that link, not just date + time — so a class moved by hand
  from 18:00 to 18:30 does not get a fresh 18:00 twin, and a cancelled one is
  not re-created.
- `resync_classes()` (on save and nightly via `generate_classes()`) touches
  only future, not-hand-edited classes: unbooked ones follow the template
  (deleted, cancelled if they have history, or updated); **anything booked keeps
  its details** and is reported as `kept_booked`.
- One room: no two open classes overlap (`class_overlap()`), enforced in the
  weekly editor, `admin_add_class`, `admin_update_class` and the generator.

## Schedule rules for customers

- Two levels: a **vertical list of the open days** (days that still have a class
  to pick; tags היום / מחר, רשומים when booked in, מלא when every class left is
  full), and tapping a day opens **that day's times on their own screen** (back
  arrow returns to the list at the same scroll). Classes that already started are
  not shown. No week strip, no accordion.
- A class shows **open or full — never numbers**. Occupancy (`taken`,
  `spots_left`, `capacity`) stays in the API for the admin grid but is not
  rendered anywhere a client can see it.

## Layout

```
src/
  App.tsx              hash routing: #/admin → admin, everything else → client
  client/ClientApp.tsx schedule · my classes · account
  admin/AdminApp.tsx   לוח · מנויים · תזכורות
  components/          Icon, Logo, OtpPanel, Sheet, ui (shared primitives)
  lib/
    api.ts             Supabase implementation of the Api interface
    demo.ts            in-memory implementation of the same interface
    types.ts           domain types + the Api contract both must satisfy
    dates.ts phone.ts push.ts theme.ts supabase.ts
  i18n.ts              he + ar dictionaries, parallel key order
```

`api.ts` ends with `export const api: Api = isConfigured ? realApi : demoApi`,
so TypeScript refuses to build if the two implementations drift apart.

## Brand

The palette is derived from the RUDEEN wordmark — thin geometric black type on
warm cream — and lives only in `src/lib/theme.ts`. There is no hue accent:
primary actions and selected states are ink, emphasis is weight, semantic
green/terracotta is reserved for ok/warn. Never type a hex outside `theme.ts`.

**Logo file:** drop the studio's artwork at `public/logo.png` and both headers
pick it up (`Logo.tsx`). Until then a typographic fallback in Jost renders, so
the app never shows a broken image. The supplied PNG has a cream background,
so it is blended into the header (`multiply` on light, `invert + screen` on the
dark admin header) — a transparent PNG/SVG makes both blends no-ops and is the
better file to ask for.

`public/icon-*.png` are an "R / PILATES" monogram rendered from
`public/icon.svg` via macOS Quick Look (`qlmanage -t -s 512 -o . icon.svg`,
then `sips -z 192 192`). Regenerate from the SVG if the palette changes; keep
the filenames so `manifest.webmanifest` stays valid.
