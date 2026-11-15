# Tests

One command checks everything that can be checked without a phone and without the live database:

```bash
cd tests
npm install        # once
npm test
```

| Part | Command | What it proves |
|---|---|---|
| Database | `npm run test:db` | The real SQL files, loaded into an in-memory Postgres (PGlite): booking rules, cancelling a class or a day, the two reminders, subscriptions, who may call what. Also that `supabase_install_all.sql` equals setup + every patch, and that every patch can be run twice. |
| Push function | `npm run test:fn` | The real `supabase/functions/push/index.ts` with its outside world stubbed: who gets a notification, the wording in Hebrew and Arabic, one Apple token per batch. Nothing is sent. |
| App | `npm run test:app` | Type check and production build of `app/`. |
| Screens | `npm run test:ui` | Walks the real screens in a headless phone-size Chrome, on the **demo** backend only (it starts the app with `VITE_SUPABASE_URL=demo` and stops if the app is not on demo data). Screenshots land in `tests/.shots/`. Needs Google Chrome (`CHROME=/path` to point elsewhere). |
| Live, read-only | `npm run live` | Not part of `npm test`. Looks at the live site and database from outside, as a visitor: the site is up, the functions a release added exist and are closed. `npm run live -- "some text"` also checks that text is in the live build. |

## What no test here can tell

- Anything on a real iPhone: the permission prompt, the "Open Settings" button, a notification really appearing. Check on TestFlight.
- The live database itself. The tests build their own copy from the same SQL files; whether a patch was actually run on live is what `npm run live` is for.
- Per-client notices on the demo screens: the demo signs every phone in as the same person. The database tests cover them.

## Adding a test

- A database rule → a `db/*.test.mjs` file. `lib/harness.mjs` gives a fresh database, users, subscriptions, classes, a movable studio clock (`at('12:25')`) and `net.calls` (everything that would have been pushed).
- A screen → a `ui/*.test.mjs` file using `ui/demo.mjs`. Prefer days in next week, so the result does not depend on the time of day.
- Checks go through `checks()` from `lib/checks.mjs`: every check is listed, and the test fails at the end with all the failed ones.
- A new database function that visitors must not call: `revoke execute … from public, anon`. `db/visitors.test.mjs` fails if a new function is reachable by visitors.
