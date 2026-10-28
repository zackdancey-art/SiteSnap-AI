# Workstream 7 — Consent, terms, and the native build (L60)

Branch `feat/consent-and-native`, four commits off `ee7e093`.

| | |
|---|---|
| **Deploys needed** | **API** + **portal** + **`eas update`** + **a native build you run** |
| **Safe to deploy separately?** | **Yes — and it is designed to be.** See *Deploys* below. |
| **Migration** | 035, additive, idempotent. One new table, three nullable columns. |
| **Skipped tests** | 9 new DB-gated tests, skipped here and only here. Reason below, and it is not a good one. |

---

## ⚠️ READ THIS FIRST — the location permission removal

**This is the decision in the whole workstream I would most expect you to want back, and it is built to be cheap to reverse.**

`app.config.ts` no longer declares location permissions. Removed from four places:

- `ios.infoPlist.NSLocationWhenInUseUsageDescription`
- `android.permissions` — `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION`
- the `"expo-location"` plugin entry, which declared **the same iOS purpose string a second time** via `locationWhenInUsePermission`
- the `LOCATION_WHEN_IN_USE_PURPOSE` constant that the first and third shared

**Why.** `requestPermissionAndStart`, `startTracking` and `setLocationTrackingEnabled` have no callers anywhere in the client. There is no switch, no setting, no screen. So what the declarations did was tell App Store review that SiteSnap collects location — for a feature no user can turn on. That is a review risk taken on behalf of nothing.

**How to put it back.** The removed text is preserved **verbatim, as a comment block at the top of `app.config.ts`**, not deleted. Reversing is uncommenting one block and three lines. It needs a native rebuild to take effect **in either direction** — nothing here reaches a device through `eas update`. If you want it back, say so and it is a one-commit change.

`expo-location` **stays in `package.json` deliberately.** Expo autolinking reads dependencies, not the `plugins` array, so the surviving import in `lib/location-tracking.ts` still compiles and the app still boots. Removing the dependency too would be a second, larger change and would make the reversal expensive, which is the opposite of the point.

### What the guard actually proves, and what it does not

`lib/native-permission-audit.ts` + `.test.ts` (24 tests in that file's suite, 8 of them new) keep the declarations from coming back by accident.

Two requirements here conflict: preserving the removed lines as comments means **every string a grep-based check would search for is still in the file.** So the auditor parses `app.config.ts` with the TypeScript compiler API instead. Comments are *trivia* to `ts.createSourceFile`, so a commented-out declaration is structurally invisible to it. That property is **asserted, not assumed** — one fixture declares the permissions for real and is found, an identical fixture with every line commented is not found, and **both assertions come out of the same parse**, so the second cannot pass by the auditor having silently stopped finding anything at all.

The sweep is whole-tree rather than path-based, so reshaping the config cannot make the audit quietly report "no declarations" — that is the failure mode that would leave the test green while the permissions came back. A plugin entry it cannot read statically lands in an `unresolved` array which the test asserts is empty, so an unreadable declaration fails the build rather than being skipped.

**Now the limit, stated plainly: this is a static reading of the config source. It is not a prebuild.** There is no simulator, no device, no Xcode and no reachable `expo prebuild` in this environment, so **nothing here proves what the generated `Info.plist` and `AndroidManifest.xml` actually contain.** That caveat is written at the top of the module so nobody reads the green tick as more than it is. **Please check the generated files by eye on the first build** — that is the only verification that exists for the thing that actually ships.

---

## What else is in here: consent at signup

Signup collected no record of anyone agreeing to the Terms of Service or the Privacy Policy. The documents existed, were published, were linked in the app — and nothing recorded that a given person had been shown them, or when.

**Three stages, and the order is load-bearing.** Consent is read at **stage 1** (`POST /auth/register`), parked on the `auth_pending_registrations` row, and written to the ledger at **stage 3** (`POST /auth/register/verify`), the step that creates the account.

- **The timestamp stored is stage 1's** — the moment the boxes were ticked — not stage 3's, which is after an SMS round trip and can be minutes later. There is a test for the difference.
- **The clock is the server's.** The version string is evidence of what the client *displayed*, which only the client knows. The time is evidence *against* the client, and a device clock is not evidence at all. A client-supplied `acceptedAt` is ignored; there is a test that sends `1999-01-01` and asserts it did not land.
- **Parsing happens before any OTP quota is spent**, so a malformed consent gets a 400 without burning an SMS or the sender's rate-limit budget.
- **The consent write is ordered before `createUser`.** If recording fails, no account exists and the person retries. Reversed, a failure would leave an account with no record of agreement — the exact state this work exists to remove.

### A ledger, not columns

`user_consents` is append-only, one row per document per acceptance. Columns on `auth_users` would record only the most recent acceptance, and "when did this person accept the version current in March" would be unanswerable. Four decisions are written out in migration 035; in brief:

- **No `company_id` and no RLS, deliberately.** An invited signup's `company_id` is `""` at the moment the row is written, so an RLS policy keyed on it would make **every invited user's consent invisible to their employer — silently, matching zero rows, with no error.** That is the failure mode migration 025 documents. The route scopes by the authenticated caller's own email and only by email. There is a DB test asserting the table is **not** `relforcerowsecurity`, with `project_entries` queried the same way as the control, so a `pg_class` query that returned false for everything cannot read as "deliberately not forced".
- **Not unique on `(user_email, document, version)`.** Signing up again after deletion is a legitimate second acceptance; a unique index would turn it into a `23505` **on the last step of signup**.
- **Overwrite, not `COALESCE`, on the pending-row conflict.** A restarted signup is a fresh act of consent and the new timestamp is the true one.
- **🚩 No foreign key to `auth_users`, so consent records survive account deletion.** A cascade would destroy the evidence that a deleted account holder ever agreed. **This is a legal question, not an engineering one, and I have built the version that keeps the evidence because that is the reversible direction — deleting rows later is possible, recovering deleted ones is not.** Tell me if it should be the other way.

`initAuthSchema` was **deliberately not extended** with `user_consents`. It is the legacy pre-migrations bootstrapper and already omits migration 029's columns; adding to it would imply it is still a parallel definition of the schema. (This is more evidence for the open question of whether the four remaining `init*Schema` functions should be retired.)

### 🚩 Absent consent is a PASS — and tightening it is one line

A request with **no consent fields at all** is accepted and recorded as no consent (`NULL`, meaning *"this signup predates the control"*, not *"refused"*).

Shipped mobile and portal builds call `/auth/register` today without these fields. The API deploys from `main` on merge; the client builds ship on your schedule. Enforcing server-side would **400 every signup in the world for the length of that window — days, not minutes.** The clients are what enforce consent (the button is disabled until the box is ticked, which is also what App Store review sees); the API records it.

**The tightening is one line** — make `absent` return an error in `utils/signupConsent.ts`. **The condition is: both client builds shipped and old builds out of use.** It is flagged here rather than left in a comment to be found.

A **partial** consent is *not* treated as absent — accepting the terms while saying nothing about the privacy policy is a client defect, and the cost of guessing is a legal record saying somebody agreed to something they were never shown. That is a 400, and it cannot affect an old client, which sends neither field.

Acceptance is a literal `true` or the string `"true"`, **not truthiness.** `"false"` is a non-empty string, and a form-encoded body is exactly the kind that sends strings — so an unticked checkbox serialised by a careless client would read as consent under `Boolean()`. Proved red on revert, below.

### No hand-written table name, in the store or the test

`USER_CONSENTS_TABLE` is exported from `authStore.ts` and interpolated into the store's three statements and the test's five. The test therefore cannot assert against a table the store has stopped writing to. This is the `deleted_at` lesson applied to a test rather than only to product code. Interpolation is safe here because it is a module constant, not a request value — every value in those statements is a bound parameter.

---

## Every route, and the client line that calls it

Block B: a route with tests and no caller is not built.

| Route | Called from |
|---|---|
| `POST /auth/register` (`routes/auth.ts:269`) | **Portal** — `lib/api.ts:183` in `registerStart` (`:171`), called from `app/signup/page.tsx:104` in `handleDetails` (`:84`) |
| `POST /auth/register/initiate` (`routes/auth.ts:270`, same handler) | **Mobile** — `app/signup.tsx:155` in `handleStartRegistration` (`:120`), wired to the button at `:492` |
| `POST /auth/register/verify` (`routes/auth.ts:397`) | **Mobile** — `app/signup.tsx:281`. **Portal** — `lib/api.ts:193` in `registerVerify` (`:190`), called from `app/signup/page.tsx:149` in `handleSmsCode` (`:144`) |
| **`GET /auth/consents`** (`routes/auth.ts:699`) — **new** | **Mobile** — `app/settings/data-privacy.tsx:42`, in the `useEffect` at `:38` |

`GET /auth/consents` is the one new route, and it had no caller until `data-privacy.tsx` got one. The screen distinguishes **three** states, because they are not the same state:

- **loading** → a spinner. Telling somebody there is no record of their acceptance *while the request is still in flight* would be the screen asserting something it does not know.
- **no record** → a sentence saying SiteSnap began keeping that record after this account was created. It does **not** say "you have not accepted these" — every account that exists accepted them when it was created. **The record is missing, not the agreement.**
- **records** → one line per document, newest acceptance per document.

A failed request falls back to the no-record message rather than an error, and an expired session is left to the app's existing session handling instead of being reported as a consent problem.

The display logic lives in `lib/consent-summary.ts` because **nothing in this environment can screenshot a React Native screen**, so a unit test is the only verification available for what the text says. The date formatter takes an optional `timeZone` — not speculative generality, but the only way the tests can pin a formatted string: an instant is a different calendar date in different zones, so a test asserting `"4 October 2026"` against the machine's local zone **passes in Auckland and fails in CI's UTC**. The default remains the device's own zone, and there is a test that the zone is honoured in three of them.

### One tick box, not two

Both clients present **one** checkbox for both documents. Two boxes would present a choice that does not exist — there is no account you can have by agreeing to one — and a half-ticked pair would produce exactly the partial consent the API refuses. **The API still records the two documents separately,** because they have separate versions and are separately editable.

The submit button is disabled until it is ticked **and** the handler refuses to proceed without it. A disabled button is a presentation decision and somebody will restyle it; the guard is the part that holds.

### Why the portal's version is a constant and not shared

Every shared home was tried and none works:

- `@sitesnap/shared` emits **`.d.ts` only** (`"main": "dist/index.d.ts"`) — it cannot carry a runtime value.
- `docs/legal/` is outside `Projects/` and is **not in the Docker image**.
- importing the mobile constants module is banned by `no-restricted-imports`, correctly.

So `apps/supervisor-web/lib/legal-versions.ts` holds the two strings, and the portal **links to the hosted documents** rather than gaining a fourth copy of their text — the fourth copies it used to have were removed as **AUDIT A6** and are not coming back.

What keeps that constant honest is a new `ci.sh` step. `assert_legal_version_constant` reads the `Last updated:` line out of `docs/legal/*.md` with an **anchored** match (so the header prose that mentions that line in passing is not what gets read), **fails loudly if the extraction comes back empty** — it will not report a pass having read nothing — and compares the constant against the canonical string, printing both on a mismatch plus the consequence: *a portal signup would record a version the person was not shown.* It is a separate check rather than a fourth `PRIVACY_COPIES` entry because the census compares word streams of whole documents and the constant copies one *line*; the census is unaffected, as the constant carries none of its marker phrases.

---

## Red on revert — five proofs, with the actual output

### A — the iOS purpose string. Revert: restore `NSLocationWhenInUseUsageDescription` to `ios.infoPlist`.

```
not ok 18 - the audit found the config's declarations, and all of them
  expected: 8
  actual: 9
  name: 'AssertionError'
not ok 19 - no iOS location purpose string is declared, and the camera one still is
  expected: true
  actual: false
  name: 'AssertionError'
# tests 121
# pass 119
# fail 2
```

Test 18 is the measured-population pin catching the count, 19 is the specific assertion. **119 others stayed green** — including test 20 (Android), 21 (plugin), 22 (a real declaration is still found) and 23 (a commented one still is not), which is what proves these two tests are the only things defending it.

### B — the plugin entry. Revert: restore `"expo-location"` with `locationWhenInUsePermission` to `plugins`.

```
not ok 18 - the audit found the config's declarations, and all of them
  expected: 7
  actual: 8
not ok 21 - the expo-location plugin is not configured, and expo-notifications is
  expected: true
  actual: false
# tests 121
# pass 119
# fail 2
```

Note tests 19 and 20 **stayed green** here: the plugin's second declaration of the iOS string is caught by its own assertion, not by the `infoPlist` one. That is the duplication the workstream called out, and the two paths are independently guarded.

### C — the Android permissions. Revert: restore `ACCESS_FINE_LOCATION` and `ACCESS_COARSE_LOCATION`.

```
not ok 18 - the audit found the config's declarations, and all of them
  expected: 4
  actual: 5
not ok 20 - no Android location permission is declared, and CAMERA still is
  expected: true
  actual: false
# tests 121
# pass 119
# fail 2
```

### D — truthiness. Revert: `isAccepted` → `return Boolean(value);`

```
not ok 217 - only a literal true or the string "true" is an acceptance
    + 'accepted'
    - 'invalid'
  name: 'AssertionError'
# pass 199
# fail 1
```

With `Boolean()`, a body carrying `acceptedTerms: "false"` parses as **accepted**. One test red, **199 green.**

### E — partial consent. Revert: return `{ kind: "absent" }` where the 400 is raised.

```
not ok 216 - a partial consent is a refusal, not an absence
    + 'absent'
    - 'invalid'
not ok 217 - only a literal true or the string "true" is an acceptance
    + 'absent'
    - 'invalid'
# pass 198
# fail 2
```

Two red here, and the second is **honest collateral, not a flaky test**: the same revert also stops `"false"` being refused, because an unticked box with versions present is itself a partial consent. **198 others green.**

All five files were restored and `diff`ed byte-identical afterwards, and the suites re-confirmed green at **128 / 0 skipped** (mobile) and **200 pass / 19 expected skips** (API).

### 🚩 The DB-gated proofs could not be run at all

**There is no Postgres, no Docker and no `psql` in this environment, so `test:db` cannot run here — not for this branch and not for any of the previous eight.** The nine tests in `routes/signup-consent-db.test.ts` **have never been executed.** They compile, they are selected by the gated runner, and the in-memory run accounts for all nine as skips — and that is the entire extent of what is verified about them locally. **CI is the first place they will run; treat a green CI on this PR as the real result and read the DB suite's output specifically.**

Those nine tests are also the only coverage of three things no store can show: that the `document` CHECK actually refuses a third value, that a refused signup leaves **no** `auth_pending_registrations` row (a 400 response does not say whether a row was left behind), and that `user_consents` is outside RLS. Every negative assertion in them carries a positive control on the same endpoint in the same test.

---

## Counters, and a merge hazard

| counter | was | now | where |
|---|---|---|---|
| `EXPECTED_DB_SUITES` | 11 | **12** | `services/api/scripts/run-tests.sh:56` |
| in-memory expected skips | 18 | **19** | derived from the sum at `:251`, not written twice |
| `EXPECTED_TEST_FILES` (mobile) | 15 | **17** | `apps/mobile/scripts/run-tests.sh:33` |
| `EXPECTED_TESTS` (mobile) | 113 | **128** | `apps/mobile/scripts/run-tests.sh:34` |

Both mobile numbers were read out of a **deliberately failed run** (`ERROR: found 17 test file(s), expected 16`, then `ERROR: 128 test(s) passed, expected 121`), never counted by hand.

**⚠️ `EXPECTED_DB_SUITES` carries the same silent-merge hazard as `EXPECTED_ROUTES`, and this branch is what made me go and prove it.**

Four branches now set it to the identical literal `12` — this one, `feat/clients-sites-entries`, `feat/timesheets-approval` and `feat/whs-checklists`. Git does not conflict on identical content, so it merges cleanly to a wrong number:

```
$ git merge-tree --write-tree --name-only \
    origin/feat/clients-sites-entries origin/feat/timesheets-approval | grep CONFLICT
CONFLICT (content): Merge conflict in Projects/apps/mobile/lib/permissions.test.ts
CONFLICT (content): Merge conflict in Projects/apps/mobile/lib/permissions.ts
CONFLICT (content): Merge conflict in Projects/apps/mobile/scripts/run-tests.sh
CONFLICT (content): Merge conflict in Projects/apps/supervisor-web/app/sites/[id]/page.tsx
CONFLICT (content): Merge conflict in Projects/apps/supervisor-web/lib/useRole.ts

$ T=$(git merge-tree --write-tree origin/feat/clients-sites-entries \
        origin/feat/timesheets-approval | head -1)
$ git show "${T}:Projects/services/api/scripts/run-tests.sh" | grep '^EXPECTED_DB_SUITES='
EXPECTED_DB_SUITES=12
```

The api harness is **not** in the conflict list. Two branches, one new DB suite each, real population 13, file says 12, nothing asked for a decision. **Every one of those four branches after the first needs the number raised by hand in the merge commit.**

`MERGE-ORDER-COUNTERS.md` was re-measured in full for this (fifth measurement, all eight branches) and the fourth measurement's claim that `EXPECTED_DB_SUITES` conflicts has been corrected there. This branch adds no route and no `ScreenHeader`, so it leaves `EXPECTED_ROUTES` and `EXPECTED_SCREEN_HEADER` at 33 and 11 and is not a party to that pair.

### New eslint exemption

`Projects/.eslintrc.js` gains `services/api/src/routes/signup-consent-db.test.ts` to the `no-restricted-imports` exemption list, by **exact filename**, with the three schema-level reads it needs written into the config beside it. Every *product* write in that file goes through `authStore`; the direct pool is used only for the `pg_class` and CHECK-constraint reads. `user_consents` has no `company_id`, so there is no tenant context for `withTenant` to set.

---

## Deploys

| what | needs |
|---|---|
| consent recording, the ledger, migration 035, `GET /auth/consents` | **API** |
| portal signup tick box + version constant + CI guard | **portal** |
| mobile signup tick box, the data-privacy consent panel | **`eas update`** (JS only) |
| **the location permission removal** | **native build — you run it** |

**The split is safe, and this is the one workstream where that is a design property rather than a hope.**

- **API first is safe**: absent consent is a pass, so old clients keep working unchanged. This is exactly why that decision was made.
- **Clients before API would 400** on the four new fields — so **deploy the API first.** It auto-deploys from `main` on merge, which gives you the right order for free.
- `GET /auth/consents` against an API without migration 035 would 500, so the `eas update` carrying the data-privacy panel should follow the API deploy. The panel degrades to the no-record message on failure rather than showing an error, so the blast radius of getting that order wrong is one paragraph of wrong-but-harmless copy on one settings screen.
- **The native build is independent of all three.** It carries only the permission removal; nothing in the consent work needs it.

---

## Ready for `eas build`

Everything in this workstream that can be verified from here has been. The native config change is committed, the audit test guards it, and the generated `Info.plist` / `AndroidManifest.xml` want checking by eye on the first build because nothing here can check them for you.

**I have not started a build and will not. It is yours to run.**

🤖 Generated with [Claude Code](https://claude.com/claude-code)
