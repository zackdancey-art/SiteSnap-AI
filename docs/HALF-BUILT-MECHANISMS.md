# Audit — Half-Built Mechanisms

> Read-only pass. Measured against the tree at `e0c606e` (Phase 2's branch head). While this
> was being written, Phase 2 merged as PR #64 and `origin/main` moved to `ee7e093`, whose tree
> is byte-identical to the one audited (`fe3ce588` for both) — so every statement below is a
> statement about `main`. No code was changed. This document is the only artefact.
>
> The question this pass exists to answer: **how many more mechanisms are there that a
> reasonable reader would believe the product has, and does not?**

---

## 1. Method — the lenses, named

Eleven lenses. Each is a different question, and each finds a set the others do not.
Where a lens produced a number, the number is in §3.

| # | Lens | The question it asks | How it was run |
|---|---|---|---|
| 1 | **Migration-column deadness** | Is every column declared by a migration read or written by production TypeScript? | Parsed all 31 migrations for `CREATE TABLE` column lines and `ALTER TABLE … ADD COLUMN`, built 247 `(table, column)` pairs, searched each as both `snake_case` and `camelCase` across production `.ts`/`.tsx`, separately across `*.test.ts`. Column present in tests only is a finding, not a pass. |
| 2 | **SQL identifier vs declared schema** | Does any SQL string name a column that no migration creates? (the `project_sites.deleted_at` shape) | Extracted identifiers from SQL template literals across 102 API files, differenced against the declared set from lens 1. |
| 3 | **Exported symbols with no caller** | Is every exported function/const/type referenced from outside its own file? | Enumerated 583 exported symbols across 256 `.ts`/`.tsx` files; word-boundary search of the rest of the tree; then a same-file-only re-check to drop symbols used locally; then a production-vs-test split, because test-only is the interesting case. |
| 4 | **Route → client** | For every route the API declares, which shipping client calls it? | Parsed 85 route declarations from `services/api/src/routes/*.ts`; searched each route's static path prefix across `apps/mobile`, `apps/supervisor-web`, `shared`, `website` with `node_modules`, `dist`, `.next`, `.expo`, `ios`, `android` excluded; separately across the API test corpus and `load-test.ts`. |
| 5 | **Route gating** | Does each route carry the gate its risk implies, or only the router-level one? | Read `routes/index.ts` mount order and each router's own `use()` lines, then each route's inline middleware; compared against `ROLE_RANK` and the store function's own actor checks. |
| 6 | **Numeric windows and thresholds** | Is any window too narrow (or wide) to do the job its name claims? (the 1-hour-in-168 shape) | Enumerated every `*_MS`, `*_SECONDS`, `TTL`, `MAX_AGE`, `WINDOW`, `INTERVAL` constant in the API and mobile, and compared each against the other number it has to be consistent with. |
| 7 | **Hand-pinned counts** | Is every pinned expectation still equal to what it counts, and does its script actually run? | Enumerated all 29 `EXPECTED_*` constants; recounted the population each pins; traced each script to a caller in `ci.sh` or a `package.json` script. |
| 8 | **Duplicated configuration** | Is any setting declared twice, with the two copies free to diverge? | Compared `app.config.ts` `infoPlist`/plugin blocks, the Android manifest permissions, `eas.json` profiles, and the two tsconfig project-reference graphs. |
| 9 | **Silently swallowed errors** | Does any failure path degrade without saying so? | Searched 196 production files for `catch` blocks whose body neither rethrows nor reports, and read each one. |
| 10 | **Tests over dead things** | Does a passing test assert that an unreachable mechanism works? | Intersected the lens-3 and lens-4 dead sets with the test corpus. **This is the lens the owner named as mattering most, so it was run as its own pass rather than as a column on the others.** |
| 11 | **Documents against the tree** | Does `website/`, `.github/`, `docs/legal/` or `docs/ARCHITECTURE.md` claim something the code does not do? | Read all four and checked each factual claim against the tree. |

---

## 2. What this method cannot see

The most useful section, so it comes before the findings.

**The two mechanisms that motivated this audit would have been found by exactly one lens each, and three of the eleven lenses would have missed both.**

1. **A number that is wrong only in relation to another number.** `token_generation` dead for nineteen migrations was findable by lens 1. The 1-hour refresh window inside a 168-hour token was findable *only* by lens 6, and lens 6 is the one lens here that cannot be automated — it required reading one constant and holding it against a second constant in a different file. I ran it by enumerating constants and pairing them by hand. **I can state with confidence that I looked at every named constant; I cannot state that I found every pair that should have been compared.** Two constants that ought to agree, in packages I did not think to pair, are invisible to this pass. This is the single largest blind spot.

2. **A mechanism that is wired end to end and wrong in its logic.** Every lens here is a reachability or consistency lens. Nothing in this pass executes the product. A function with callers, a route with a client, a column that is read and written, and a window of a sensible size can still compute the wrong answer, and this audit would call it healthy. Example of the shape: the AI narrative report is fully wired and I have no evidence either way about whether its output is faithful to the entries it summarises.

3. **Dynamic reachability.** Lenses 3 and 4 are static text searches. A route called through a computed string, a function reached through a registry or a React component map, or a column read through `SELECT *` and passed around as an opaque row, reads as dead to me and is not. I mitigated this on the column lens by searching `camelCase` as well as `snake_case`, and on the route lens by also searching the test corpus and `load-test.ts` so test-only reach is visible rather than silently counted as a client. I did not mitigate it for React component indirection.

4. **Anything outside the repository.** Four things that bear directly on findings below live in dashboards I cannot read: whether `EXPO_TOKEN` is set as a GitHub secret (§4, F11), what Render's deploy hook is actually configured to do (F3), which environment variables are set in production (so every `readIntEnv` default below may not be the live value), and what the App Store privacy declaration says about location. Where a finding depends on one of these, it says so.

5. **The database as it exists.** There is no Postgres in this environment, so the eleven DB-gated suites cannot run here and no finding below is informed by production data. Lens 1 reads what migrations *declare*, not what the live schema *is*. If a column was added by hand in a console, I cannot see it.

6. **History beyond `git log -S`.** Where I say "how it got that way", that is reconstructed from commit history. Two findings below have no history to explain them because they date to the initial commit `b2a51ba`, which imported an already-built tree.

7. **One class I deliberately did not chase: copy.** I read the legal documents, the website and the portal's user-facing strings, but I did not systematically diff every string in the product against the behaviour it describes. F4 below was found by accident while confirming something else, which means the class is populated and I have sampled it rather than measured it. **If you want one more pass after this, make it that one.**

---

## 3. Populations — so this does not pass vacuously

### Files examined

| Package | Files in scope | of which tests | Notes |
|---|---|---|---|
| `Projects/services/api/src` | 133 | 45 | plus 31 migrations and 6 scripts |
| `Projects/apps/mobile` | 123 | 15 | `ios/`, `android/`, `dist/`, `dist-test/`, `.expo/` excluded |
| `Projects/apps/supervisor-web` | 41 | 0 | `.next/` excluded; **no test files exist in this package at all** |
| `Projects/shared` | 4 | 0 | |
| `Projects/scripts` | 6 | 0 | |
| `website` | 4 | 0 | |
| `.github/workflows` | 3 | 0 | |
| `docs` | 44 | — | read for lens 11 |

Derived populations: 583 exported symbols across 256 `.ts`/`.tsx` files; 247 declared `(table, column)` pairs; 85 route declarations; 29 `EXPECTED_*` pinned counts; 12 exported symbols in `@sitesnap/shared`.

### Findings per taxonomy row — including the zeros

| Shape | Found | Where |
|---|---|---|
| A schema column nobody reads or writes | **0** | 2 of 247 columns are unread by code, both on `company_backfill_conflicts` (migration 016) — a forensic table meant to be read by a human with SQL. Rejected, see §5. |
| A mechanism wired with a window too narrow to fire | **0** | Every window paired and checked. See §5 for the five pairs and why each is sound. Caveat in §2.1: I cannot prove I paired everything. |
| A recovery path unreachable by the thing it recovers | **0** | `/auth/refresh` is ungated at `routes/auth.ts:737` — L74 is closed. No other recovery path has the shape. |
| An exported function with no callers | **5 findings, 13 symbols** | F7 (nine dead API/mobile exports), F8 (the whole `@sitesnap/shared` surface), F1 (the location enable path), plus `isAtLeast` in `useRole.ts` and `requireRole`. |
| A route built, gated, and never called by any client | **2 findings, 10 routes** | F2 (six template routes), F6 (`/auth/me`, `/projects/summary`). Plus three health/debug routes, rejected. |
| A type or schema declared and never referenced | **1 finding** | F8 — `CreateEntrySchema`, `PhotoRefSchema`, `DiaryEntryDraftSchema` and six more. |
| A route with no gate of any kind | **1, previously recorded** | F9 — signature void, AUDIT L91. No new instances. |
| A predicate that admits more than its name says | **0 live** | The fail-open `?? "viewer"` survives at `useRole.ts:116`, but its only fail-open consumer, `isAtLeast`, has no callers; `isOwner`/`isManager` fail closed. Recorded in F7. |
| The same setting declared twice with different values | **0 divergent** | iOS location purpose string is now one constant; the duplicated Android location permissions are identical in value (Phase 7, already scheduled). |
| A check that cannot catch the thing it is named for | **1** | F10 — the pre-commit gate exists only in this clone. `assert-hooks-lint-active.sh` is the counter-example and is the model: see §5. |
| A pinned count written by hand and never measured | **0** | All 29 recounted. `EXPECTED_WRITE_STEPS` is 14 against 14; workflows 3 against 3; pinned runners 4 against 4; mobile test files 15 against 15; DB suites 11 against 11. |
| An endpoint that does the opposite of its name | **1** | F5 — `/auth/logout`. `/auth/revoke-all` now does what it says (L75 closed). |
| A column referenced in SQL that does not exist | **0** | Lens 2 produced 12 candidates; all 12 were my own false positives (`information_schema` columns, `schema_migrations`, SQL row-type aliases). Zero real. |
| A degradation that happens silently | **0 new** | 11 swallowed `catch` blocks found, each read, each either reports to Sentry, logs loudly, or is a documented best-effort. |
| A fail-open default in a permission decision | **0 live** | See the predicate row above. |

### Candidates considered and rejected: 31

Counted and itemised in §5. The rejections are the evidence this pass had reach.

---

## 4. Findings, ordered by the gap between assumption and truth

Twelve findings. The flag column marks the gap as a **security**, **privacy**, **compliance** or
**evidence-integrity** property; those are gathered again in §6.

---

### F1 — Location tracking cannot be switched on, and the portal tells managers where to switch it on `PRIVACY` `COMPLIANCE`

**Where.** `Projects/apps/mobile/lib/location-service.ts`; `Projects/apps/mobile/app/_layout.tsx:294`;
`Projects/apps/supervisor-web/app/locations/page.tsx:192`; `Projects/apps/supervisor-web/components/Sidebar.tsx:31`;
`Projects/apps/mobile/app.config.ts:141`; migration `020_worker_locations_create_and_rls.sql`.

**Reader assumption:** workers turn on location sharing in the mobile app, and the portal's Live Map shows where they are.
**What it actually does:** nothing can ever turn it on, so the Live Map is permanently empty for every company.

**Detail.** `setLocationTrackingEnabled` is the *only* writer of the `sitesnap.locationTracking`
AsyncStorage key, and it has zero callers. `requestPermissionAndStart`, which would call it, also has
zero callers. `resumeTrackingIfEnabled` *is* reached — `app/_layout.tsx:294` calls it on every launch —
and it reads that key, finds it unset, and returns. So the feature is not dead code: it is a live
code path that runs on every app start and is structurally incapable of starting.

This is a correction to the earlier record. AUDIT L60 lists `requestPermissionAndStart`,
`startTracking` and `setLocationTrackingEnabled` as having no callers, which is right, but the
module is not wholly unreferenced and the entry point does execute.

**What compounds it beyond L60,** and is the reason this is first:

- **The portal makes a false factual statement to a manager.** `locations/page.tsx:192` renders
  *"Workers enable tracking in the mobile app under Settings → Location Tracking."* There is no such
  row. `app/(tabs)/settings.tsx` has exactly seven rows — Account, Data & Privacy, Offline Sync
  (conditional), Support, About, Sign Out, Delete Account. A manager who reads that sentence will
  conclude their crew have not complied, not that the product cannot do it.
- **"Live Map" is a permanent item in the portal's left-hand navigation.** It is not behind a flag.
- **The iOS purpose string is declared** (`NSLocationWhenInUseUsageDescription`, `app.config.ts:141`),
  which is what App Store review reads as "this app collects location".
- **The server half is complete and correct** — `worker_locations` with RLS, `POST /location/update`,
  `GET /location/workers`, the router gated at `/location`. Only the switch is missing.

**How it got that way.** The server, schema and portal screen were built; the one mobile UI row that
writes the flag was not. The service module itself is complete, including a deliberate
`notifySessionExpired()` on a 401 with a comment reasoning about a phone that has been tracking for a
week — written by someone who had thought the feature through to its edge cases.

**Does anything test it?** The server half, yes — `worker_locations` tenant isolation is asserted.
**Does a test assert it works end to end?** No. Nothing tests that a worker can enable tracking,
because nothing can.

**Not flagged as a privacy breach, and why.** `docs/legal/privacy-policy.md:96` is scrupulously
honest about exactly this: *"There is no screen anywhere in the app that turns it on, so it is off,
it cannot be switched on by you or by us through the app, and nothing is being collected by it today."*
The legal document is the one place in the product that tells the truth here. The privacy flag is
for the App Store declaration, which I cannot read.

---

### F2 — A complete, tenant-isolated, test-covered template subsystem that no client can reach, carrying an Australian WHS compliance dataset `COMPLIANCE`

**Where.** `Projects/services/api/src/routes/templates.ts:8-150` (the `WHS_CHECKLISTS` constant),
`:116`, `:120`, `:126`, `:136`, `:148`; `Projects/services/api/src/storage/templateStore.ts`;
migration `010_deliveries_templates_signatures.sql` (`entry_templates`), `021_rls_push_tokens_entry_templates.sql`.

**Reader assumption:** the app ships Safe Work Australia pre-start and hazard checklists, and crews save reusable entry templates.
**What it actually does:** six routes with no caller in any shipping client; the checklists are unreachable; the app's templates come from a different table through a different store.

**Detail.** There are **two parallel template stacks**:

| | reached by | store | table | tests |
|---|---|---|---|---|
| `GET/POST/PATCH/DELETE /projects/templates` | `apps/mobile/lib/data-context.tsx:628` | `projectsStore.ts:994+` | `diary_templates` | yes |
| `GET/POST/DELETE /entry-templates` | **nothing** | `templateStore.ts` | `entry_templates` | **yes** |

`GET /whs-checklists` and `/whs-checklists/:id` serve a hand-written dataset of pre-start and hazard
checklists citing AS/NZS 1891 and AS/NZS 3000 by name. Zero clients. A reader of the route list, or
of the marketing claim that the product helps with WHS compliance, would believe a crew can open a
pre-start checklist. They cannot.

**How it got that way.** `entry_templates` predates `diary_templates`; migration 010 created it, and
the newer per-site template work landed on `projectsStore` instead of being migrated onto it. The old
stack was then *carried forward through the RLS programme* — migration 021 converted it, and the
comment in that migration names `templateStore` as "fully converted alongside this migration".
Nobody noticed that the thing being carefully secured had no users.

**Does anything test it?** Yes, and **this is the worst case in this report.**
`storage/company-id-writes.test.ts:49` is titled *"createTemplate (templateStore, entry-templates):
returned record.companyId matches the acting user's company (H6 regression)"* and it passes. The
crew-permission suite also probes the `/entry-templates` paths.
**Does a test assert it works?** Yes — a tenant-isolation test and a permission test both assert
that an unreachable subsystem behaves correctly. This is precisely the shape named in the brief:
a half-built mechanism with a passing test over it. Three of them, on the same dead stack.

**Also:** `initTemplateSchema` (`templateStore.ts:39`) has zero callers. The table exists only
because migration 010 creates it. Same for `initPushSchema` and `initDeliveriesSchema` — three of
the five `init*Schema` functions are never called; `server.ts:206-207` calls only the two auth and
project ones. Harmless today, because the migrations are authoritative, but a reader of
`server.ts` would conclude the boot sequence initialises the schema it needs, and it initialises
two fifths of it.

---

### F3 — A workflow named "Deploy API", triggered on every push to `main`, that deploys nothing `EVIDENCE-INTEGRITY`

**Where.** `.github/workflows/deploy-api.yml`. Live steps: lines 23–57. Lines 59–88 are commented out.

**Reader assumption:** a green "Deploy API" check on `main` means the API was built, tested and deployed.
**What it actually does:** installs, typechecks and tests. Every build, push and deploy step is a comment with `REGION`/`PROJECT`/`REPO` placeholders.

**Detail.** The workflow name and its `on.push.branches: [main, master]` trigger are the whole
problem. A green check next to a merge commit reads as a deployment receipt. It is a second test run.
Conversely a **red** "Deploy API" does not stop anything, because the real deploy is Render's own
git hook, which is outside the repository and outside this workflow's control. So the check cannot
gate the thing it is named for, in either direction.

**How it got that way.** The commented block is a Google Cloud Run example, left as a template for
"adapt for ECR, GHCR, etc." Hosting went to Render instead, and the workflow was never renamed or
removed.

**Does anything test it?** No. **Does anything assert it deploys?** No — and nothing could.
`Projects/scripts/assert-workflow-runners-pinned.sh` asserts all four `runs-on:` lines are pinned
(verified: 4 of 4, and `EXPECTED_WORKFLOWS=3` against 3 files), which is a real check on this file —
it just has nothing to say about whether the file does its job.

**Why it is this high.** This is the one finding whose gap is about *your own picture of the
deployment path* rather than a user's picture of a feature. In December, on a site, the question
"is the API running the code I merged?" is answered by Render, and this workflow will show green
either way.

---

### F4 — "Sign out everywhere" now works, and the portal tells the user it does not `SECURITY`

**Where.** `Projects/apps/supervisor-web/app/settings/page.tsx:308-309`.

**Reader assumption (reading the dialog):** rotating the token is a slow-acting measure; other devices keep working for up to a week.
**What it actually does:** every other session is refused on its very next request.

**Detail.** The confirm reads *"This will rotate your session token. Existing tokens expire within 7
days. Continue?"* and the success alert reads *"Session token rotated. Other sessions will expire at
their natural TTL."* Both describe the pre-Phase-2 world. Since Phase 2, `POST /auth/revoke-all`
increments `auth_users.token_generation` (`authStore.ts:405-412`) and `requireAuth` refuses any token
behind the row at `middleware/auth.ts:193` — before the cookie-repair path at `:247`, so a stale
cookie cannot be rescued either. The docblock at `routes/auth.ts:915-920` states this correctly.

**This is the inverse of L75 and that is why it matters.** L75 was an endpoint that revoked nothing
while its name promised revocation. This is an endpoint that revokes everything while its own UI
promises it will not. The product-level consequence is the same class of harm: a manager with a lost
phone reads the dialog, concludes the lost phone keeps working for a week, and goes looking for
another remedy — or does not act at all.

**How it got that way.** The copy was written to be honest about a mechanism that did not work. Phase
2 fixed the mechanism and did not revisit the copy. One-line fix in two strings; deliberately not made.

**Does anything test it?** The mechanism, yes — `sessions-and-tokens-db.test.ts` covers the generation
gate. **Does a test assert the copy?** No. There are **zero test files in `apps/supervisor-web`**,
so no portal string is asserted anywhere.

---

### F5 — Signing out does not end the session `SECURITY` *(borderline — see the argument against)*

**Where.** `Projects/services/api/src/routes/auth.ts:947` (`POST /auth/logout` → `clearSessionCookie` only);
`Projects/apps/mobile/lib/auth-context.tsx:280-291`; `Projects/apps/supervisor-web/lib/api.ts:256-259`.

**Reader assumption:** "Sign Out" ends the session on that device.
**What it actually does:** on mobile it deletes the token from AsyncStorage and never contacts the server; the credential stays valid for the remainder of its TTL. On the portal it clears the cookie, which is effective for that browser, and does not invalidate the token value.

**Detail.** `logout()` on mobile is three `AsyncStorage.removeItem` calls and three `setState` calls.
No network request. The mobile app never calls `/auth/logout` at all — the only caller is the portal.
`/auth/logout` itself is four lines: clear the cookie, return `{ok:true}`. It does not bump
`token_generation`, which is the one thing that would actually invalidate the credential.

**Why borderline.** This is the ordinary consequence of a stateless bearer token, `revoke-all` is the
documented remedy and it now works, and a token that was never exfiltrated is not at risk from being
forgotten locally. I include it because the brief says to, and because the gap between "Sign Out" and
"the credential on this device still authenticates for up to seven days" is one a reasonable reader
would not predict — particularly on a shared or borrowed site phone, which is a realistic
construction scenario.

**Does anything test it?** **No. Zero test files reference `/auth/logout`.** Nor
`DELETE /auth/account`, `PATCH /auth/profile`, or `POST /auth/reset-password` — four routes, one of
which permanently deletes a user's data, with no test coverage of any kind.
**Does a test assert it works?** No, for all four.

---

### F6 — No shipping client ever asks the server whether the session is still alive, while eight test files use that very route as their liveness probe `SECURITY`

**Where.** `Projects/services/api/src/routes/auth.ts:557` (`GET /auth/me`);
`Projects/services/api/src/routes/projects.ts:184` (`GET /projects/summary`).

**Reader assumption:** the clients check with the server who they are signed in as.
**What it actually does:** neither client calls either route. The portal's identity comes from `localStorage` (`lib/api.ts:55`), the app's from AsyncStorage. Both learn a session has died only when some unrelated call happens to 401.

**Detail.** `/auth/me` is referenced by **eight** API test files and by the portal's role
documentation, and by no shipping client code. `/projects/summary` is referenced by one test file and
no client. The only non-test references to either are in the file described in F7a below.

The practical consequence, and why this is a security row rather than a tidiness row: there is no
point in either client at which "is this session still valid?" is asked directly. Phase 2's
generation gate and the sliding refresh both work, and the user discovers their effect through
whichever feature screen they happen to open next. The test suite, by contrast, has a clean, direct,
well-asserted probe — so the suite's picture of session liveness is better than the product's.

**Does anything test it?** Heavily — eight files. **Does a test assert it works?** Yes.
This is the second instance of the shape in F2: thorough assertions over a route no user traverses.

---

### F7 — Thirteen exported symbols with no callers, three of which read as safety mechanisms

**Where and what.** All verified as definition-site-plus-compiled-`.d.ts` only; zero production
callers, zero test callers.

| Symbol | Where | What a reader would assume | What it is |
|---|---|---|---|
| `jsonErrorHandler` | `utils/errors.ts:13` | Express error handling is uniform and returns JSON | Never installed on the app. Error shape is whatever each route's own `catch` returns. **The closest thing to a safety mechanism in this list.** |
| `requireRole` | `middleware/auth.ts:347` | A role gate available to routes | `@deprecated`, zero callers. Harmless but it is a *gate* sitting in the middleware file a reviewer reads to understand gating. |
| `isElevatedRole` / `ELEVATED_ROLES` | `utils/authToken.ts:92` | The elevated-role test | Typed `role is "supervisor" \| "admin"` — **a role model that no longer exists.** The live model is `crew/viewer/manager/owner` (`ROLE_RANK`). A fossil that still typechecks. |
| `isAtLeast` | `apps/supervisor-web/lib/useRole.ts:119` | The portal's rank comparison | Zero callers. **This is where L83's fail-open `?? "viewer"` still lives**: an unrecognised role resolves to rank 1. Because it has no callers, the fail-open is not live; `isOwner`/`isManager`, which are used, fail closed. |
| `initTemplateSchema`, `initPushSchema`, `initDeliveriesSchema` | `templateStore.ts:39`, `pushStore.ts:21`, `deliveriesStore.ts:51` | Boot initialises the schema | Three of five never called. See F2. |
| `saveToken`, `clearToken` | mobile | Token persistence helpers | Zero callers; `auth-context.tsx` writes AsyncStorage directly. |
| `clearQueue`, `peekPendingQueue` | mobile offline queue | Queue inspection/reset | Zero callers. |
| `buildDiariesText` | `apps/mobile/lib/export-utils.ts:491` | A diary export format | Zero callers. |
| `disposableDomainCount` | `utils/disposableDomains.ts:180` | A measurable guard on the blocklist | Zero callers — so the blocklist's size is never asserted. Compare `assert-hooks-lint-active.sh`, which does exactly this for a different invariant and is run by CI. |

**7a. And one file that is a whole dead client.** `Projects/apps/supervisor-web/index.html` — 210
lines, tracked since the initial commit `b2a51ba`, referenced by nothing, not served by the Next App
Router (which serves only `public/`). It is the original single-file supervisor dashboard: it has its
own sign-in form with an *"API Base URL"* text input, posts the password to whatever host is typed
there, and says *"Sign in with a supervisor or admin account"* — the same vanished role model as
`isElevatedRole`. It is the sole non-test caller of `/auth/me`, `/projects/summary` and
`/projects/reports/supervisor`. `styles.css` beside it is its stylesheet; the real app uses
`app/globals.css`.
**Unsure flag:** I verified nothing in the repo references it and that the App Router does not serve
root-level HTML. I did **not** verify the hosting provider's own configuration, so I cannot state
that it is unreachable in production — only that nothing in the repository reaches it. If it is
served, a working login form that posts credentials to a user-supplied host is a finding of a
different order, which is why I am naming the limit of what I checked.

---

### F8 — `@sitesnap/shared` is built by CI, referenced as a project by both clients and the API, and imported by nothing

**Where.** `Projects/shared/` (4 files, 12 exported symbols); `Projects/scripts/ci.sh:323`;
`Projects/services/api/tsconfig.json:19`; `Projects/apps/mobile/tsconfig.json:12`;
`docs/ARCHITECTURE.md:17`.

**Reader assumption:** the app, the portal and the API share one validated contract — `CreateEntrySchema` validates an entry on both sides of the wire.
**What it actually does:** zero files in the monorepo import `@sitesnap/shared`. The API defines its own Zod schemas inline in each route. `CreateEntrySchema` validates nothing, anywhere.

**Detail.** Of 12 exported symbols, 9 have no reference of any kind and the other 3 (`ID`, `Site`,
`Entry`) match only coincidental same-named identifiers elsewhere. The only two mentions of the
package name in the entire tree are comments explaining why it *isn't* used:
`apps/supervisor-web/lib/api.ts:92` (*"@sitesnap/shared emits types only, so they are kept in step"*)
and `lib/phone.ts:7` (*"@sitesnap/shared is types-only. Its tsconfig sets emitDeclarationOnly"*).
Both describe hand-duplicating the values instead.

`AuthTokenPayload` in `shared/types/index.ts:27` is `{ sub, exp? }`. The real token payload is
`{ email, fullName, role, companyId, companyRole, tokenGeneration, exp }`. A reader who trusted the
shared type would be wrong about what a SiteSnap token contains.

**How it got that way.** The package dates to the initial commit. `emitDeclarationOnly` means it
cannot export runtime values such as Zod schemas, so the Zod schemas in it were unusable from the
day they were written, and both clients worked around it by duplication rather than by fixing the
tsconfig.

**Does anything test it?** No — zero test files in the package.
**Does a test assert it works?** No. But `ci.sh:323` **builds** it on every run, which is the
closest thing to an assertion: CI proves the dead contract still compiles.

---

### F9 — Voiding an inspection signature needs only a login `EVIDENCE-INTEGRITY` *(previously recorded: AUDIT L91, awaiting your decision)*

**Where.** `Projects/services/api/src/routes/inspections.ts:230`; `storage/signatureStore.ts:210`.

**Reader assumption:** voiding a signature on a compliance record is a privileged act.
**What it actually does:** any authenticated member of the company can void any active signature in it. `FIELD_ACCESS` is `[requireAuth]` and nothing more; `voidSignature` checks `company_id` and `status`, never role.

**Restated here rather than left to L91** because it is the clearest evidence-integrity instance in
the repository and because of what the tests do: `storage/signature-store.test.ts:172` asserts voiding
is one-way, `:199` asserts a cross-tenant void is refused, and `signature-roundtrip.test.ts:241`
asserts the round trip. **A test asserts that voiding works.** No test asserts that a crew member
cannot do it, because there is nothing to assert. The suite's completeness around this route is
exactly what would persuade a reviewer it was thought through.

---

### F10 — The pre-commit gate exists only on this machine

**Where.** `.git/hooks/pre-commit` (untracked, by nature). No `core.hooksPath`, no `husky`, no
`prepare` script, nothing tracked that installs it.

**Reader assumption:** commits are gated by typecheck and lint, and commits to `main` by the test suite.
**What it actually does:** that is true in this clone only. Any fresh clone — another machine, a contractor, CI — has no hook, and the branch-aware "tests only on main" design means `main` in a fresh clone is the *least* gated branch.

CI is the backstop and the hook's own comment says so (*"CI is the backstop for feature branches"*),
so the exposure is bounded. Low gap, included because it is a check whose coverage is a property of
the filesystem rather than of the repository.

---

### F11 — Pushing a `v*.*.*` tag submits to both app stores *(unverifiable from here)*

**Where.** `.github/workflows/build-mobile.yml:23-25`, `:63-69`, `:71-92`.

**Reader assumption:** tagging a release is a bookkeeping act.
**What it actually does:** `git push --tags` with a `v1.2.3`-shaped tag runs `eas build --profile production --platform all --non-interactive` and then, on success, `eas submit --profile production --platform all --non-interactive` — a store submission with no human step.

**Unverifiable:** whether `EXPO_TOKEN` is set as a repository secret. If it is not, a tag push fails
red and submits nothing. If it is, a tag push submits. I cannot read repository secrets and am not
using `gh`. **This is worth five seconds in the GitHub settings page before December**, because the
two outcomes are very different and the trigger is a gesture people make casually.

Separately, the `submit` job runs `eas submit` from `Projects/apps/mobile` with no `pnpm install`
step, so it has no `node_modules` with which to evaluate `app.config.ts`. I expect it would fail
rather than submit, which would be a second reason the mechanism does not do what its shape implies —
but I have not run it and am not claiming it.

---

### F12 — `Projects/scripts/build.js`: 563 lines named in the architecture document, dead since the first commit

**Where.** `Projects/scripts/build.js`; `docs/ARCHITECTURE.md:18` (*"`Projects/scripts` | `build.js` helper"*).

**Reader assumption:** the repo has a build helper that is part of the build.
**What it actually does:** nothing references it — no `package.json` script, no workflow, no `ci.sh` line. It spawns Metro directly and dates to `b2a51ba`.

Lowest gap of the twelve, and included for one specific reason: it was *already* dead when
`ARCHITECTURE.md` described it as a helper, so that row of that table has never been true. The rest
of `ARCHITECTURE.md`'s staleness (18 migrations against 31, *"There is no CLAUDE.md in the repo"*
against a CLAUDE.md that exists, a one-line root README against 149 lines) is **not** a finding: its
header pins it to commit `cc63dc2` as a Phase 1 discovery snapshot, which is an honest frame. The
`build.js` row is the one claim the pin does not excuse.

---

## 5. Candidates considered and rejected — 31

These are the evidence that the lenses had reach. Grouped by lens.

**Lens 1, columns (3 rejected).** `company_backfill_conflicts.chosen_company_id` and
`.conflict_company_ids` (migration 016) are read by no code — a forensic record of the company
backfill, intended for a human with SQL; rejected because it promises nothing to a product reader.
`auth_users.token_generation` re-checked and is now fully live.

**Lens 2, phantom columns (12 rejected).** All twelve were my own false positives: `information_schema`
column names, `schema_migrations` internals, and SQL row-type aliases (`approved_diaries`, `is_local`)
that my extractor mistook for columns. Each was resolved by reading the migration. Zero real.

**Lens 3, exports (4 rejected).** `FIELD_ACCESS` — reached, and the 25-line docblock at
`middleware/auth.ts:288-315` is the model answer for an honest gate (*"A check that cannot fail is
worse than no check, because it looks like protection in review and in a diff"*).
`assert-test-packages.sh` — reached via root `pnpm test` at `ci.sh:338`.
`assert-hooks-lint-active.sh` — reached at `ci.sh:106`, and it is a genuine positive control: it
writes a file that really violates `react-hooks/rules-of-hooks`, requires the rule to be reported
**by name**, and asserts its own population (`EXPECTED=2`) so an empty loop cannot pass. This is the
anti-pattern of everything in §4.
`PhotoRefSchema` — dead, but scheduled in Phase 7, so excluded by the brief.

**Lens 4, routes (3 rejected).** `GET /health/client-ip` and `GET /health/ready` — infrastructure,
called by Render and by a human; `/health/ready` is additionally the authoritative state probe.
`GET /debug-sentry` — `NODE_ENV`-gated and cannot answer in production.

**Lens 5, gating (2 rejected).** `routes/uploads.ts` has no router-level gate by design (the
signed-media route accepts `Bearer` *or* `?sig=&exp=`, `uploads.ts:120`). `companyRouter.use(requireAuth)`
at `routes/company.ts:18` is pathless but harmless because that router owns its mount — recorded as L82.

**Lens 6, windows (5 rejected).** The 30-day cookie against the 7-day token — now derived from one
number (`REFRESH_GRACE_SECONDS = SESSION_MAX_IDLE_SECONDS - TOKEN_TTL_SECONDS`, `authToken.ts:66`),
so they cannot diverge; sign-out lands between 23 and 30 days, documented at `:40`.
`SESSION_IDENTITY_TTL_MS` 60s with a 5-minute stale grace — read against the generation gate and
sound. The location `INTERVAL_MS` of 5 minutes agrees with the privacy policy's stated "every five
minutes". `SIGNED_URL_TTL_SECONDS` of 2 hours — checked for the failure mode where a long-lived
artefact embeds a short-lived URL; it does not happen, the only producer is the upload response
(`uploads.ts:105`) and the read route also accepts a bearer token, so an authenticated client never
depends on the signature. `readIntEnv`'s empty-string handling (`utils/env.ts`) is the fix for exactly
the class of bug where `FOO=` silently becomes a zero-length window.

**Lens 7, pinned counts (0 rejected, all 29 verified).** Listed in §3.

**Lens 8, duplicated config (2 rejected).** The iOS location purpose string is now a single constant
used by both `infoPlist` and the plugin. The duplicated Android location permissions are identical in
value and already scheduled in Phase 7.

**Lens 9, swallowed errors (11 rejected).** Each read individually. The rate limiter's fallback to
in-memory is now loud and reports to Sentry. The mobile location `catch` blocks `console.warn` and are
the documented "nobody is watching" case, which still reports session expiry upward. Media storage
cannot degrade silently because production boot throws on a missing provider (`server.ts:44-72`).
The remaining eight are documented best-effort paths.

**Lens 11, documents (2 rejected).** `website/` — four files, no forms, no external scripts, six
record types all client-wired, `mailto:` only; every claim checked against the tree.
`docs/legal/` — the location disclosure at `privacy-policy.md:96` is more honest than the product
(see F1), and the erasure disclosure at `:203-207` matches the code: `deleteUserAccount` hard-deletes
`auth_users` and the cascade carries everything the policy lists, while the policy explicitly says
the `uploads` rows and every stored file survive — which is true, because `uploads` (migration 023)
has no foreign key.

---

## 6. The dangerous subclass, gathered

Where the gap is a security, privacy, compliance or evidence-integrity property:

| | Finding | Property | Does a test assert it works? |
|---|---|---|---|
| 1 | **F2** — the `/entry-templates` + WHS stack | compliance | **Yes — three tests assert an unreachable subsystem is correct.** |
| 2 | **F9** — signature void needs only a login | evidence integrity | **Yes — the store tests assert voiding works.** |
| 3 | **F1** — location cannot be enabled, portal says where to enable it | privacy, compliance | Server half yes; end to end no. |
| 4 | **F3** — "Deploy API" deploys nothing | evidence integrity (of your deploy record) | No, and nothing could. |
| 5 | **F4** — revoke-all works, the UI says it does not | security | Mechanism yes; copy no (no portal tests exist). |
| 6 | **F6** — no client asks whether the session is alive | security | **Yes — eight test files assert the probe no client uses.** |
| 7 | **F5** — sign-out is local only | security | No. Zero tests on `/auth/logout`, `/auth/account`, `/auth/profile`, `/auth/reset-password`. |

**Four of the seven have passing tests over the dead or ungated thing.** That is the pattern the
brief predicted and it is the single most important sentence in this report. The suite is not
measuring what is reachable; it is measuring what was written.

---

## 7. Also left unfixed, per this audit's own rule

- **AUDIT L104** — four of the five `Set-Cookie` routes are still unasserted: login
  (`routes/auth.ts:537`), refresh (`:799`), revoke-all (`:942`), and `/projects/invites/accept`
  (`routes/projects.ts:609`, which writes a cookie only when `authTransport === "cookie"`).
  change-password (`:893`) is now covered.
- **A correction to my own record.** I had noted the docblock at
  `routes/sessions-and-tokens.test.ts:126-128` as making a false claim, because it says a bare
  `"sitesnap.session"` literal in `middleware/auth.ts` is what made the name worth centralising, and
  the only literal in the tree today is `utils/sessionCookie.ts:25`. The docblock is **correct**:
  `git log -S'"sitesnap.session"' -- …/middleware/auth.ts` returns `301b46f` (introduced it) and
  `ac51e59` (*"the session cookie lives in one module"*, removed it). Nothing to fix. Recorded here
  because it is a clean example of §2's point: a present-tense grep cannot refute a past-tense claim,
  and three of these eleven lenses are present-tense greps.

---

## 8. Where this pass stopped

Complete, by package and by lens, with these edges:

- **All eleven lenses ran over all seven packages.** No package was left unswept and no taxonomy row
  was left unexamined.
- **Lens 6 (numeric windows) is complete in enumeration and incomplete in pairing.** Every named
  constant was listed; the pairing of constants that ought to agree was done by judgement. §2.1.
- **Lens 11 (documents) covers `website/`, `.github/`, `docs/legal/` and `ARCHITECTURE.md`.** It does
  **not** cover a systematic diff of every user-facing string in the two clients against its
  behaviour. F4 came out of that unswept area by accident, which means it is populated. **That is
  the next pass.**
- **Nothing was executed.** No test run, no DB, no device. Every statement above is from the tree at
  `e0c606e` and from `git log`.

---

## 9. The verdict

**No. Not in four places that matter, and the reason is consistent enough to be worth more than the
list.**

What exists is better engineered than most of what I read. The gating docblocks reason about why a
check that cannot fail is worse than no check. `readIntEnv` exists because someone worked out that
`FOO=` becomes zero. `assert-hooks-lint-active.sh` writes a real violation and demands the rule be
reported by name. The privacy policy tells users that location tracking exists and cannot be turned
on, which is a sentence almost nobody writes. The person who built this repeatedly saw one layer
deeper than the task required.

**And the failure is always the same shape: the last six inches.** The server, the schema, the RLS
policy, the route, the gate and the tests get built. The one switch, the one client call, the one
string, the one uncommented line does not. `token_generation` was nineteen migrations from a column
to a mechanism. Location tracking is a server, a table with row-level security, a portal screen, a
navigation entry, an App Store purpose string and a privacy disclosure — missing one settings row.
`/entry-templates` was carried through the entire RLS programme without anyone asking who calls it.
"Deploy API" is a complete pipeline with the last four steps commented out.

**So the specific gap between the SiteSnap you would describe to a builder and the one that exists:**

1. **You would say the product can show you where your crew are.** It cannot, for anybody, ever, and
   the portal blames the crew for it.
2. **You would say there are WHS checklists.** There are, in a constant, behind a route with no
   caller, citing AS/NZS standards nobody can read in the app.
3. **You would say merging to `main` deploys the API through CI.** Render deploys it; the green check
   named "Deploy API" is a second test run and cannot stop a bad deploy.
4. **You would say app and API share one validated contract.** They share a package that both of them
   have comments explaining why they do not use.

**And the thing I would want you to take from this above the four items.** Ask what the test suite is
for. Four of the seven dangerous-subclass findings have passing tests over the dead or ungated thing —
a tenant-isolation test on an unreachable store, a one-way-void test on an ungated route, eight files
asserting a liveness probe no client calls. The suite is a faithful record of what was *written*, and
it is being read as a record of what *works*. That is why these survived: each one was already green.
Until a test can tell the difference between "this function is correct" and "a user can reach this
function", a green suite is weak evidence that the product does what you believe, and this audit is
the kind of thing that has to be run by hand instead.

Two numbers worth holding on to. `apps/supervisor-web` has **41 files and zero tests** — every portal
string, including F4's, is unasserted. And **85 routes, 10 with no client, 4 of the most consequential
with no test at all** (`/auth/logout`, `DELETE /auth/account`, `PATCH /auth/profile`,
`POST /auth/reset-password`) — one of which permanently deletes a person's data.

The product is closer to working than this report makes it sound. It is further from *being known to
work* than the green suite makes it look.
