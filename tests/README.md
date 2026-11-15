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
| Local copy | `npm run test:local` | Not part of `npm test` (it needs Docker and takes about half a minute). Starts a complete Supabase on this computer — the real database, API and sign-in — loads this repo's SQL into it the way it was loaded into live, and acts as a visitor, two clients and the admin through the real API. This is where real roles, real row-level security, real sign-in and the real extensions are checked; the database tests above only imitate them. It stops and wipes the copy when done (`KEEP_LOCAL=1` leaves it running; `npm run local:down` stops it). `npm run test:all` runs everything. |
| Live, read-only | `npm run live` | Not part of `npm test`. Looks at the live site and database from outside, as a visitor: the site is up, the functions a release added exist and are closed. `npm run live -- "some text"` also checks that text is in the live build. |

## What no test here can tell

- Anything on a real iPhone: the permission prompt, the "Open Settings" button, a notification really appearing. Check on TestFlight.
- The live database itself. The tests build their own copy from the same SQL files; whether a patch was actually run on live is what `npm run live` is for.
- Per-client notices on the demo screens: the demo signs every phone in as the same person. The database tests cover them.

## The local copy

`supabase/config.toml` describes it; `tests/local/stack.mjs` starts and stops it with a pinned version of the Supabase CLI (through `npx`, nothing to install). It listens on 127.0.0.1 only, uses the CLI's public local keys, and never touches the live project: the loader redirects every address of a real Supabase project in the SQL to a dead local one and refuses to continue if any is left.

Sign-in works as on live, by phone, but no SMS is sent: the test numbers in `supabase/config.toml` always get the code 123456.

The first start downloads the Docker images (a few minutes, once). After that a full run takes about half a minute.

## Adding a test

- A database rule → a `db/*.test.mjs` file. `lib/harness.mjs` gives a fresh database, users, subscriptions, classes, a movable studio clock (`at('12:25')`) and `net.calls` (everything that would have been pushed).
- Something only the real API can show (who may read or call what, sign-in, a patch that needs a real extension) → `local/*.test.mjs`. `local/people.mjs` gives a visitor and signed-in callers; `answer()` turns a call's result into either the function's own answer or `{ refused: code }`.
- A screen → a `ui/*.test.mjs` file using `ui/demo.mjs`. Prefer days in next week, so the result does not depend on the time of day.
- Checks go through `checks()` from `lib/checks.mjs`: every check is listed, and the test fails at the end with all the failed ones.
- A new database function that visitors must not call: `revoke execute … from public, anon`. `db/visitors.test.mjs` fails if a new function is reachable by visitors.
