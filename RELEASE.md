# Releasing a change

Three places can run different versions at the same moment: the database,
the website, and the iPhone app from the App Store. Always release in that
order, and keep each step working with the one after it still on the old
version.

Every step marked **owner** needs the owner's go-ahead for this release.
"The owner said yes last time" does not count.

## 1. Before anything leaves this machine

```bash
cd tests && npm test
```

All four parts must pass (database, push function, app build, screens). If a
change has no test, write one first. Then commit locally.

If the change touches the database (a new patch, or anything about who may
read or call what), also run the local copy — a real Supabase on this
computer, loaded with the same SQL:

```bash
npm run test:local
```

Say plainly what the tests could not check: anything on a real iPhone, and
the live database.

## 2. Database — only if there is a new `supabase_patch_v1_N.sql`

1. The patch is safe to run twice and is appended to
   `supabase_install_all.sql` (`npm run test:db` checks both).
2. Add the functions and columns it creates to `tests/live/check.mjs`.
3. **owner**: copy it and run it in Supabase → SQL Editor.

   ```bash
   pbcopy < supabase_patch_v1_N.sql
   ```

4. Confirm from outside that it is in:

   ```bash
   cd tests && npm run live
   ```

   A function that exists and is closed answers a visitor with `42501`. One
   that was never created answers `PGRST202`.

Never deploy a website that needs a patch before the patch is confirmed.

## 3. Push function — only if `supabase/functions/push/index.ts` changed

The repo copy carries placeholders instead of the notification keys. The
owner's filled copy is `~/Desktop/rudeen-push-setup/1 - push function.ts`.

1. Make the same change in the filled copy. Compare the two files: the only
   lines that may differ are `VAPID_PUBLIC` and `VAPID_PRIVATE`. Never print
   those two lines.
2. **owner**: copy the filled file, then Supabase → Edge Functions → `push` →
   Code → select all, paste, Deploy. "Verify JWT" stays off.

   ```bash
   pbcopy < ~/Desktop/rudeen-push-setup/"1 - push function.ts"
   ```

3. `npm run live` pings it: website and iPhone channels must say ok.
4. If a database patch relies on the new function, deploy the function
   **before** running the patch.

From outside there is no way to tell which version of the function is
deployed. Ask the owner to confirm they pressed Deploy.

## 4. GitHub — **owner**

```bash
scripts/push-to-github.sh          # shows what would go, pushes nothing
scripts/push-to-github.sh --push   # after the owner says so
```

It replays the new local commits onto a fresh clone of GitHub under the
noreply identity, checks that no key or env file is going out, and pushes
fast-forward. Pushing does not deploy the website. It is what Codemagic
builds the iPhone app from.

## 5. Website — **owner**

```bash
cd app && npx --yes vercel --prod --yes
cd ../tests && npm run live -- "a text that only the new version has"
```

The second command confirms the live site serves the new build. Do not sign
in on the live site to check; tell the owner what to try and what a wrong
press would do to real clients (cancelling a day really cancels it).

## 6. iPhone app — **owner**, only for changes inside `app/`

1. Once a version is live in the App Store, Apple refuses new builds for it:
   raise `MARKETING_VERSION` in `app/ios/App/App.xcodeproj/project.pbxproj`
   (two lines) and push that first.
2. Codemagic → Start new build → branch `main` → workflow "iOS — TestFlight".
3. On TestFlight, check what no test here can: notifications arrive, the
   wording of reminders, the "Open Settings" button.
4. App Store Connect → new version → pick the build → submit for review.

Database and push-function changes reach iPhone users without a new build.
Screen changes do not.

## 7. After

- Tell the owner what is live where (database, website, App Store), and what
  was not verified.
- If the studio's routine changed, update "What the studio does day to day"
  in `SETUP_GUIDE.md`.
- If something went wrong on the way, add one line to "Mistakes already made
  here" in `CLAUDE.md`.
