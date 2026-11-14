# Rudeen Pilates — setup

Two roles only: **admin** (the studio owner) and **client** (whoever trains).
There is no separate instructor account.

## 1. Create the Supabase project

1. https://supabase.com → New project. Pick a region close to Israel
   (`eu-central-1` is fine). Save the database password somewhere.
2. **Shortcut for a new, empty project:** SQL Editor → paste **all** of
   `supabase_install_all.sql` → Run, once. It is the seven files below joined
   in order, and the rest of this step is then already done.

   SQL Editor → paste **all** of `supabase_setup.sql` → Run.
   It creates the schema, the row-level security, the booking RPCs, a starter
   timetable and a daily cron that keeps five weeks of classes generated.
   Then paste **all** of `supabase_patch_v1_1.sql` → Run (plans catalogue and
   purchase requests — the מוצרים tab), then `supabase_patch_v1_2.sql` → Run
   (notification center), then `supabase_patch_v1_3.sql` (push devices), then
   `supabase_patch_v1_4.sql` (health questionnaire + signed declaration), then
   `supabase_patch_v1_5.sql` (the studio edits its own timetable, single
   classes, and adds clients by hand), then `supabase_patch_v1_6.sql`
   (purchase requests switched off, and the reminder an hour before class),
   then `supabase_patch_v1_7.sql` (cancel a whole day), then
   `supabase_patch_v1_8.sql` (a second reminder, half an hour before class),
   then `supabase_patch_v1_9.sql` (the admin sees who has notifications on),
   then `supabase_patch_v1_10.sql` (fix or remove a subscription).
   Run them once each, in that order; re-running a patch is harmless.
3. Deploy the `admin-create-client` edge function — it is what the admin's
   **מתאמנת חדשה** button calls (creating an account needs the service role,
   which never reaches the browser):

   ```bash
   npx supabase functions deploy admin-create-client
   ```

   Nothing to configure: Supabase gives every function its URL and keys.
   Without it, the button says the function is missing; everything else works.
4. Set the real timetable **from the app**: admin → לוח → **לוח שבועי קבוע**.
   The setup file seeds Sunday / Tuesday / Thursday at 08:00, 18:00, 19:15
   (capacity 8) as a starting point. Saving the weekly schedule moves the
   coming five weeks onto it; a class somebody already booked never changes
   or disappears by itself — edit or cancel it from its own sheet.

## 2. Phone login (Twilio Verify)

Supabase Auth → Sign In / Providers → **Phone**, enable it, and pick
**Twilio Verify** — *not* plain Twilio.

In Twilio: Verify → Services → **Create Verify Service**, then enable the
**SMS** channel on it. You need three values:

| Supabase field | Twilio value |
|---|---|
| Twilio Account SID | `AC…` from the console home |
| Twilio Auth Token | the token beside it |
| Twilio Message Service SID | the Verify **Service SID**, `VA…` |

Gotchas that cost real hours on the previous studio app:

- A **Messaging Service SID (`MG…`) is the wrong value** — the provider returns
  error 21212 and the app just says "sending failed".
- A **trial** Twilio account cannot text Israeli numbers (error 21608). Upgrade,
  or add the number under Verified Caller IDs for testing.
- If the Verify service has SMS disabled you get 60223 — enable the channel.
- To test without spending money: Supabase Auth → Phone → **test OTPs**, e.g.
  `972501234567 = 123456`. **Delete every test number before real launch.**

## 3. Make yourself an admin

Easiest: list the admin phones in `supabase_admins.sql` and run it in the SQL
Editor. Listed numbers become admins right away if they already signed in, or
the moment they first sign in. Re-run it after adding a number.

Or by hand — sign in once through the app (this creates the profile row), then:

```sql
update public.profiles set is_admin = true
 where phone in ('+972501234567', '972501234567');
```

Match both formats — Supabase stores the phone without the leading `+`.

`is_admin` is deliberately **not** writable through the API: the profiles
UPDATE grant is column-scoped to `full_name`, so a client cannot PATCH
themselves into an admin. Promoting someone is always a SQL statement.

## 4. Point the app at the project

`app/.env.local` (never commit it, never hardcode these in source):

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon public key>
VITE_PUBLIC_URL=https://<your-domain>
```

With those blank the app runs in **demo mode** against an in-memory backend —
useful for showing the studio how it works before any of this exists. The demo
OTP code is `123456`.

## 5. Deploy

```bash
cd app && npm install && npm run build
npx vercel --prod
```

Set the same three env vars in the Vercel dashboard. It is a PWA: on iPhone the
studio should open the link in Safari and **Add to Home Screen**.

## 6. Optional — push notifications (admin and clients)

One edge function, `supabase/functions/push`, delivers everything: new
booking / cancellation / purchase request to the admins; to the clients, every
row of `notifications` (pack opened, class cancelled or moved, announcements)
and **two reminders before each class they booked, an hour before and half
an hour before** — over web push, APNs and FCM.

Web (site / installed PWA). There is no CLI on the studio's Mac, so this is
the dashboard route:

1. Make a VAPID key pair (`npx web-push generate-vapid-keys`) and paste the two
   halves into the function source (`VAPID_PUBLIC` / `VAPID_PRIVATE`) — in the
   copy you paste into the dashboard, never in the repository. Baked into the
   source on purpose: keys pasted into the dashboard secret editor came back
   corrupted and every push returned 403.
2. Supabase → Edge Functions → **Deploy a new function → Via Editor**. Name it
   exactly `push` (the name becomes the address and cannot be changed later),
   paste the whole file, deploy.
3. On the function's **Details** tab turn **Verify JWT** off. The database
   calls it with the webhook secret only, and the function checks that itself.
4. Edge Functions → **Secrets** → add `WEBHOOK_SECRET` = any long random
   string.
5. SQL Editor → run `supabase_push_setup.sql` with its two placeholders filled
   in (the project reference and the same secret). Its last statement pings the
   function; a few seconds later
   `select status_code, content::text from net._http_response order by created desc limit 1;`
   should show 200 and `{"ok":true,"transports":{"web":"ok",...}}`
   (401 = Verify JWT still on, 403 = secrets differ, 404 = wrong function name).
6. Put the **public** half in `.env.local` as `VITE_VAPID_PUBLIC_KEY` and in
   Vercel, then redeploy the site. Public and private must be halves of the
   same pair. Until this is set the "turn on notifications" card stays hidden.
7. Each person turns notifications on once, on their own phone: the card on
   the home screen / account tab. On iPhone the site must first be added to the
   Home Screen (Safari → Share → Add to Home Screen) and opened from there.

Nobody can be made to allow notifications — the phone asks its owner, and
Apple rejects an app that refuses to work without them. What the app does
instead (v1.9):

- **asks right after a booking** ("a reminder before the class?"), at most once
  a day, while that device has them off;
- for someone who once tapped "Don't Allow" (the iPhone never asks again):
  an **Open Settings** button that goes to the app's page in the phone's
  Settings, and the registration finishes by itself when they come back;
- in the admin, **מנויים** shows a bell per client (on / off), a count, and a
  "without notifications" filter, so the studio knows whom to ask in person.
  On = that client allowed notifications on at least one device. It cannot
  tell that someone later switched them off in the phone's Settings; a deleted
  app drops out by itself on the next send.

The reminders: `send_class_reminders()` (patch v1.6, second window in v1.8)
runs every 5 minutes by cron and picks every booking whose class starts in
50–60 minutes (the hour reminder) or in 20–30 minutes (the half-hour one), each
once. A class on a round time gets them exactly 60 and 30 minutes before.
Someone who booked in the last 15 minutes is skipped, so a booking made inside
the last hour gets only the half-hour one, or none. Check it with
`select * from cron.job_run_details order by start_time desc limit 5;` and
`select count(push_reminded_at) hour, count(push_reminded_30_at) half from bookings;`.
After changing the function file, deploy it before running a patch that
relies on it (v1.8: an older function still delivers the half-hour reminder,
but with the "in an hour" wording).

Native (the store app): APNs and FCM secrets — see `NATIVE_GUIDE.md`.

## What the studio does day to day

- **Client pays** → admin opens **מנויים**, taps them, picks a package
  (300 ₪ → 8 sessions is a preset) → the credits appear in their app instantly.
  This is the only way a subscription opens (patch v1.6): clients see the
  plans and prices but can no longer send a purchase request — people asked,
  got the subscription and did not pay. To allow requests again:
  `update public.studio_settings set purchase_requests_enabled = true;`
- **A subscription opened wrong** (price, number of sessions, end date) →
  מנויים → the client → under **מנויים קיימים** tap the subscription → fix
  the fields → **שמירת התיקון**. Opened by mistake → **מחיקת המנוי** (tap
  twice). The form at the top of that sheet only ever opens a NEW
  subscription: pressing it again to "correct" one adds another (patch
  v1.10 added the fix/remove view because a client ended up with 18
  sessions that way). The sessions cannot go below what the client already
  used, and a subscription somebody trained on cannot be removed — lower
  its sessions or shorten it instead. The client is not notified of a fix.
- **Client books** a class from the schedule — picks a day, then a time; one
  tap, one credit.
- **Timetable** → לוח → **לוח שבועי קבוע**: add, change or remove the weekly
  classes (time, type, length, capacity). Two classes can never overlap — one
  room. **One class only** (a holiday, a substitute hour) → tap it → **עריכת
  השיעור**; moving it notifies everyone booked, and the weekly schedule stops
  managing that one class.
- **Cancelling** → one class: tap it → **ביטול השיעור** (tap twice). A whole
  day (the trainer is ill, a holiday) → **ביטול היום** next to the day's title
  in לוח (patch v1.7): a sheet lists what will go, one tap confirms. Either
  way everyone booked gets the session back and a notice on their phone.
  The whole-day button only touches classes that have not started yet, so a
  morning that already took place stays as it was. The end date of a
  subscription does not move.
- **Client added by hand** → מנויים → **מתאמנת חדשה** (name + phone) → give
  her a pack → book her from a class sheet with **הוספת מתאמנת רשומה** (spends
  a credit, like the app). When she later signs in with that phone, it is the
  same account. A walk-in with no pack is still **הוספת נרשם/ת ידנית**.
- **Client cancels** more than 12 hours ahead → credit returns. Later than that
  → the session is spent. The window lives in
  `studio_settings.cancel_cutoff_hours`.
- **Credits expire** one month after they are granted. Unused sessions are lost;
  that is the deliberate rule, not a bug.
- **New client** → after the phone code and name, the app asks for the
  **health questionnaire + signed declaration** (the studio's own text, in the
  client's language). Booking is refused by the database until it exists.
  Clients can view or re-submit it from החשבון; every submission is kept.
  Admin sees a marker per client (מנויים) and per attendee (roster): grey =
  missing, green = no findings, red with a count = things to know (pain,
  spine, injury, pregnancy, medication, doctor's restriction…). Tap it for the
  full read-only form. This is health data: only the client and admins can
  read it, and it is deleted with the account.
- **Client wants to buy** → מוצרים tab in their app → picks a plan → sends a
  purchase request (optionally taps the Bit link or the WhatsApp button). The
  admin sees it at the top of מנויים with a badge, and **אישור ופתיחת המנוי**
  opens the pack from the plan's numbers in one tap — approve only once the
  money has actually arrived. Declining leaves the client a "לא אושר" status.
- **Editing the price list** → admin מוצרים tab: name, sessions, validity,
  price, optional payment link, shown/hidden. Existing packs and past requests
  keep the numbers they were sold at.
- **Telling everyone something** (holiday closure, timetable change, offer) →
  תזכורות tab → הודעה לכל המתאמנים. It lands in every client's notification
  center (bell in their header). Personal notifications are automatic: pack
  opened, request approved/declined, class cancelled, removed from a class.
- **Someone books by phone or Instagram** → admin opens the class →
  הוספת נרשם/ת ידנית. No account, no credit deducted.
- **Reminders** → the תזכורות tab lists today and tomorrow with a WhatsApp
  button per attendee.
