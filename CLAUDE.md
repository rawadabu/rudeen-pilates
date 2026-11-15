# Rudeen Pilates — rules for whoever works in this repo, person or agent

A booking app for a Pilates studio. Clients hold a subscription (a pack of
sessions), book classes and get reminders; the studio runs the timetable and
the subscriptions from an admin screen. Hebrew and Arabic, right to left.
**Real clients use it every day.**

## Where things are

- `app/` — the app: Vite + React 19 + TypeScript, with Capacitor shells for
  iOS and Android. `src/client/` is the client app, `src/admin/` the admin,
  `src/lib/api.ts` the real backend (Supabase), `src/lib/demo.ts` an in-memory
  demo backend with the same interface, `src/i18n.ts` every text in he + ar.
- `supabase_setup.sql` + `supabase_patch_v1_N.sql` — the database, one patch
  per version. `supabase_install_all.sql` is setup + every patch, for a new
  project. `supabase_push_setup.sql` wires push (two placeholders).
- `supabase/functions/push/` — the edge function that sends every
  notification (web push, Apple, Android).
- `tests/` — the checks. Read `tests/README.md`.
- `supabase/config.toml` — the local test copy of the database (a real
  Supabase in Docker on this computer, started by `tests/local`). It is not
  the live project and holds no key of it.
- `RELEASE.md` — how a change reaches the clients. Follow it step by step.
- `SETUP_GUIDE.md`, `NATIVE_GUIDE.md` — how the live project was set up, and
  the studio's day-to-day.

## What is live

- Website: https://rudeen-pilates.vercel.app — deployed with the Vercel CLI
  from `app/`. Pushing to GitHub does **not** deploy it.
- Database: Supabase project `mmlzqwaskejxotnzocmf`.
- iPhone app: on the App Store, bundle `com.rudeen.pilates`, built by
  Codemagic from GitHub `rawadabu/rudeen-pilates` (workflow `ios`). It carries
  its own copy of the code: a website deploy does not change it.

## Hard rules

1. **Never let a test or a preview touch the live database.** `npm run dev`
   with the normal env talks to LIVE. For any screen work use demo mode
   (`VITE_SUPABASE_URL=demo`); the screen tests start it themselves.
2. **Never sign in on the live site**, as admin or as anyone. Look at live only
   from outside: `npm run live` in `tests/`.
3. **Secrets.** Do not read `.env*` files. Never ask for, paste, store or
   print the Supabase secret key, the database password or the Apple `.p8`
   key. The owner's filled push files live in `~/Desktop/rudeen-push-setup/`:
   never commit, upload or print them. The one secret a tool may use is the
   webhook secret in that folder, and only for the ping in
   `tests/live/check.mjs`.
4. The repo copy of `supabase/functions/push/index.ts` keeps
   `REPLACE_ME_PUBLIC` / `REPLACE_ME_PRIVATE`. Real keys exist only in the
   copy the owner pastes into the Supabase dashboard.
5. **Database changes** are a new `supabase_patch_v1_N.sql`: safe to run
   twice, and appended to `supabase_install_all.sql` (a test compares them).
   Never edit an old patch. No tool has database access: the owner runs the
   SQL in the Supabase SQL Editor.
6. **New database functions** end with
   `revoke execute on function … from public, anon;` and, if the app calls
   them, `grant execute … to authenticated;`. `revoke … from anon` alone does
   not close a function (`tests/db/visitors.test.mjs` explains and guards it).
7. **Class times are studio time.** Use `public.studio_now()` /
   `public.studio_today()` for anything about classes, never `now()` or
   `current_date` (the server runs on UTC).
8. **Nothing goes out without the owner's word, each time:** pushing to
   GitHub, deploying the website, anything in Supabase, the App Store. A
   yes for one release is not a yes for the next.
9. **Git.** Commits are by `rawadabu
   <73743660+rawadabu@users.noreply.github.com>`. This local repo has no
   remote and its history is not GitHub's; pushing goes through
   `scripts/push-to-github.sh` (dry run by default), never `git push`, never
   force. `app/.env.example` is not pushed.

## How to work here

- A change comes with its test. Run `npm test` in `tests/` before saying
  something works, and say plainly what no test could check (a real iPhone,
  the live database).
- Every text exists in Hebrew and Arabic in `src/i18n.ts`. Hebrew uses the
  plural, gender-neutral forms already there; Arabic is the colloquial
  Levantine already there. Write counts as "label: number", not as plural
  phrases ("1 classes" happened). The decline button on a prompt reads
  «غير موافق».
- Phone first, 390 px wide. Tap targets at least 44 px. In a sheet, nothing
  may lie on top of the main button (a "booked" toast once covered it).
- The order of a release matters: database first, then the website, then the
  store build. The app must keep working when the database is one patch
  behind (see how `fetchClients` copes with a missing column).

## Mistakes already made here

- **One Apple token per batch.** Signing a token per phone got 4 of 6 iPhones
  refused ("429 TooManyProviderTokenUpdates"). The token cache holds the
  promise, not the result. `tests/push-function` guards it.
- **Same notification tag = silent replacement** on the web. Two reminders for
  one booking need two tags.
- **The open-subscription form only opens new ones.** Pressing it again to
  "correct" a price gave a client 18 sessions. Corrections go through
  `admin_update_pack` / `admin_delete_pack`.
- **`revoke … from anon` was taken for "closed".** Eighteen admin and account
  functions stayed callable by anybody with the site's public key for months,
  held back only by the check inside each one (patch v1.11).
- **Test tools kept in a temp folder were wiped.** Tests live in `tests/`.
- **A headless browser reports the page hidden** after a few seconds: screen
  tests use `awayAndBack()` instead of a bare `visibilitychange` event.
- **The demo backend signs every phone in as the same person**, so per-client
  notices cannot be checked on the demo screens. The database tests cover them.
- **A pasted command with a placeholder file name was run as is**
  (`AuthKey_XXXXXXXXXX.p8`). Give the owner commands that work unedited.

## Known gaps

- Patch v1.11 closes the older admin and account functions to signed-out
  visitors. It only takes effect once the owner runs it; `npm run live` in
  `tests/` says whether it is in. After it, a call without a session is
  refused by the database before the function runs, and the app shows its
  generic "network" message for that rare case (an expired session) instead
  of "sign in".
- **An open question for the owner:** a session can be used to book a class
  that takes place after the subscription's end date, as long as the booking
  is made before it ends (`book_class` looks at whether the subscription is
  valid today, not on the day of the class). With a five-week timetable that
  stretches a one-month subscription by up to five weeks. Seen in the local
  copy on 2026-11-15; not changed, because it may be intended.
- Never checked on a real iPhone: the "Open Settings" button
  (`app-settings:`), and the wording of the half-hour reminder as delivered.
- The form that opens a subscription starts at 8 sessions / ₪300, which is
  not one of the studio's packages.
