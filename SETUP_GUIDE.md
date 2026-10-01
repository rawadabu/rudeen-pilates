# Rudeen Pilates — setup

Two roles only: **admin** (the studio owner) and **client** (whoever trains).
There is no separate instructor account.

## 1. Create the Supabase project

1. https://supabase.com → New project. Pick a region close to Israel
   (`eu-central-1` is fine). Save the database password somewhere.
2. **Shortcut for a new, empty project:** SQL Editor → paste **all** of
   `supabase_install_all.sql` → Run, once. It is the six files below joined
   in order, and the rest of this step is then already done.

   SQL Editor → paste **all** of `supabase_setup.sql` → Run.
   It creates the schema, the row-level security, the booking RPCs, a starter
   timetable and a daily cron that keeps five weeks of classes generated.
   Then paste **all** of `supabase_patch_v1_1.sql` → Run (plans catalogue and
   purchase requests — the מוצרים tab), then `supabase_patch_v1_2.sql` → Run
   (notification center), then `supabase_patch_v1_3.sql` (push devices), then
   `supabase_patch_v1_4.sql` (health questionnaire + signed declaration), then
   `supabase_patch_v1_5.sql` (the studio edits its own timetable, single
   classes, and adds clients by hand).
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
booking / cancellation / purchase request to the admins, and every row of
`notifications` (pack opened, request approved, class cancelled, announcements)
to the clients — over web push, APNs and FCM.

Web (site / installed PWA):
```bash
npx web-push generate-vapid-keys
```
1. Paste the pair into `supabase/functions/push/index.ts` (`VAPID_PUBLIC` /
   `VAPID_PRIVATE`) — baked into the source on purpose; keys pasted into the
   dashboard secret editor came back corrupted and every push returned 403.
2. Put the **public** half in `.env.local` as `VITE_VAPID_PUBLIC_KEY` and in
   Vercel. Public and private must be halves of the same pair.
3. `npx supabase functions deploy push`, add a `WEBHOOK_SECRET` function
   secret (any long random string), run `supabase_push_setup.sql` with the
   three placeholders filled in.
4. `curl -X POST https://<ref>.supabase.co/functions/v1/push -H 'x-webhook-secret: <secret>' -H 'Content-Type: application/json' -d '{"ping":true}'`
   → `{"ok":true,"transports":{...}}` tells you which transports are live.

Native (the store app): APNs and FCM secrets — see `NATIVE_GUIDE.md`.

## What the studio does day to day

- **Client pays** → admin opens **מנויים**, taps them, picks a package
  (300 ₪ → 8 sessions is a preset) → the credits appear in their app instantly.
- **Client books** a class from the schedule — picks a day, then a time; one
  tap, one credit.
- **Timetable** → לוח → **לוח שבועי קבוע**: add, change or remove the weekly
  classes (time, type, length, capacity). Two classes can never overlap — one
  room. **One class only** (a holiday, a substitute hour) → tap it → **עריכת
  השיעור**; moving it notifies everyone booked, and the weekly schedule stops
  managing that one class.
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
