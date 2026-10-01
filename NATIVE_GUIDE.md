# Rudeen Pilates — the store app (iOS + Android)

`app/ios` and `app/android` are Capacitor projects wrapping the built web app.
Same code, same Supabase backend; the difference is how notifications reach
the phone (native push instead of web push) and how updates ship (store review
instead of `vercel --prod`).

**Keep the admin dashboard on the web URL.** Web push works there, deploys take
30 seconds, and nothing about the store cadence has to slow the studio down.
The store app is for clients.

## What is already wired

- `capacitor.config.ts` — `com.rudeen.pilates`, bundled assets (not a remote
  URL — Apple rejects thin website wrappers), foreground notification banners.
- iOS: `AppDelegate.swift` forwards the APNs token to the push plugin;
  `App.entitlements` (`aps-environment`), `UIBackgroundModes: remote-notification`,
  entitlements linked in the Xcode project. **No Firebase on iOS.**
- Android: the Capacitor template applies the Firebase plugin only when
  `android/app/google-services.json` exists, so the project builds before
  Firebase is set up.
- Icons + splash generated from `assets/logo.png` / `logo-dark.png`
  (`npx @capacitor/assets generate --ios --android`; **never** without those
  two flags — the PWA flag overwrites `public/manifest.webmanifest`).
- In the app: the "התראות לטלפון" card (notification center + account tab)
  registers this device; sign-out removes it, so a shared phone never gets the
  previous account's pushes. Tapping a push opens the notification center.

## Build & run

```bash
cd app
npm run ios       # build → sync → open Xcode
npm run android   # build → sync → open Android Studio
```

Requirements on the Mac: **Xcode** (full app, then `sudo xcode-select -s
/Applications/Xcode.app`) and **Android Studio**. Neither is installed on this
machine right now — `xcode-select` points at the command-line tools.

## Accounts you need (once)

| | Cost | Gives you |
|---|---|---|
| Apple Developer Program | $99 / year | App Store, TestFlight, APNs key |
| Google Play Console | $25 once | Play Store. A *personal* account must run a closed test with 12 testers for 14 days before production |
| Firebase project (free) | — | FCM for Android push (`google-services.json` + a service-account JSON) |

## Push setup — iOS (APNs, direct)

1. developer.apple.com → Certificates, Identifiers & Profiles → **Keys** →
   `+` → name it, tick **Apple Push Notifications service (APNs)** → download
   the `.p8` **once** (it cannot be downloaded again). Note the **Key ID** and
   your **Team ID** (top-right of the portal).
2. In Xcode: target App → Signing & Capabilities → **+ Capability → Push
   Notifications**, and **Background Modes → Remote notifications**. (The
   files are already there; this registers the capability on the App ID.)
3. Supabase → Edge Functions → Secrets:
   ```
   APNS_TEAM_ID=XXXXXXXXXX
   APNS_KEY_ID=YYYYYYYYYY
   APNS_BUNDLE_ID=com.rudeen.pilates
   APNS_KEY_P8_B64=<base64 of the .p8 file: base64 -i AuthKey_YYYY.p8 | tr -d '\n'>
   ```
   Base64 because the dashboard's secret editor mangles multi-line values.
   Leave `APNS_SANDBOX` unset: Xcode builds register with Apple's sandbox,
   TestFlight/App Store builds with production, and the function tries
   production first then sandbox automatically.

## Push setup — Android (FCM)

1. console.firebase.google.com → new project → add an **Android app** with
   package `com.rudeen.pilates` → download `google-services.json` →
   put it at `app/android/app/google-services.json`.
2. Project settings → **Service accounts** → *Generate new private key* →
   Supabase secret `FCM_SERVICE_ACCOUNT_B64=<base64 of that JSON>`.

## Deploy the function and the triggers

```bash
cd /Users/rawada/rawad-projects/pilates-app
npx supabase functions deploy push
```
Then run `supabase_push_setup.sql` (placeholders filled) and check what is
configured:
```bash
curl -X POST https://<ref>.supabase.co/functions/v1/push \
  -H 'x-webhook-secret: <secret>' -H 'Content-Type: application/json' -d '{"ping":true}'
# → {"ok":true,"transports":{"web":"ok","apns":"ok","fcm":"ok"}}
```
A transport that is not configured is skipped and reported — it never blocks
the others.

## Web push (site / PWA) — still there

`npx web-push generate-vapid-keys` → paste into
`supabase/functions/push/index.ts` (`VAPID_PUBLIC` / `VAPID_PRIVATE`) and set
`VITE_VAPID_PUBLIC_KEY` in `.env.local` + Vercel. Without the env var the
"turn on notifications" card simply does not render on the web.

## Store submission notes

- **Payments**: the app never charges anyone — clients send a *request*, pay
  the studio by Bit/cash, and a plan may carry an external payment link. This is
  a real-world service consumed outside the app (Apple guideline 3.1.3(e)), not
  a digital good, so no in-app purchase is required. Keep it that way.
- **Account deletion** is built in (חשבון → מחיקת החשבון) — Apple requires it.
- **Sign-in** is phone OTP; Apple's "Sign in with Apple" rule applies only when
  third-party social logins are offered, which they are not.
- Screenshots: 6.7" and 6.1" iPhone, plus iPad only if you tick iPad support
  (untick it — the layout is phone-first).
- Every client-app change = new build → TestFlight → review (usually 1–2
  days). Web fixes still go live in 30 seconds at rudeen-pilates.vercel.app.
