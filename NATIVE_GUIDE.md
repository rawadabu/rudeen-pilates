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

## Cloud builds (Codemagic): no Xcode or Android Studio needed

`codemagic.yaml` at the repo root defines three workflows that run on
Codemagic's Macs, building from the GitHub repo:

- **android-test**: an APK to install on an Android phone. Needs steps 1–2 only.
- **android-release**: a signed `.aab` for Google Play. Also needs step 3.
- **ios**: a signed build uploaded to TestFlight. Also needs step 4.

Codemagic builds whatever is on GitHub, so upload every change there first.

1. codemagic.io → sign up with GitHub → **Add application** → GitHub →
   `rudeen-pilates`. It picks up `codemagic.yaml` by itself.
2. The app → **Environment variables** → a group named exactly **`supabase`**
   with `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the `sb_publishable_…`
   key) and `VITE_PUBLIC_URL` = `https://rudeen-pilates.vercel.app`. These are
   the public values the website already ships to every browser.
3. **Android upload key** (once you have the Play account). Make it yourself, so
   the passwords never leave you:

   ```bash
   keytool -genkeypair -v -keystore rudeen-upload.jks -alias rudeen -keyalg RSA -keysize 2048 -validity 10000
   ```

   Codemagic → Team settings → **Code signing identities → Android keystores**
   → upload it with the reference name **`rudeen_upload`**, its passwords and
   the alias `rudeen`. Keep the `.jks` and the passwords in a password manager;
   never in the repo (`.gitignore` blocks `*.jks`). Google Play App Signing holds
   the real signing key; this is only the upload key, which Google can reset.
4. **iOS** (needs the Apple Developer Program):
   1. developer.apple.com → Certificates, IDs & Profiles → **Identifiers → +** →
      App IDs → bundle ID `com.rudeen.pilates`, tick **Push Notifications**.
   2. App Store Connect → Apps → **+ New App**: iOS, "Rudeen Pilates", bundle ID
      `com.rudeen.pilates`, SKU `rudeen-pilates`.
   3. App Store Connect → Users and Access → **Integrations → App Store Connect
      API** → generate a key with **App Manager** access. The `.p8` downloads
      only once; note the Issuer ID and Key ID.
   4. Codemagic → Team settings → **Integrations → Developer Portal → Manage
      keys** → add it named **`Rudeen ASC key`** (the yaml refers to that name).
      Codemagic then creates the certificate and provisioning profile itself.
5. **Start new build** → pick the workflow. The APK / AAB / IPA download from
   the build page; the iOS workflow also lands in TestFlight. The build number
   comes from Codemagic's build counter, so every upload is newer. The version
   people see (1.0, 1.1, …) does not: once a version is live in the App Store,
   Apple refuses new builds for it, so raise `MARKETING_VERSION` in
   `app/ios/App/App.xcodeproj/project.pbxproj` (two lines) before the next
   release. 1.0 = first release; 1.1 = requests off + class reminders (v1.6).

Free plan: 500 macOS build minutes a month; one build here takes ~5–15.

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
