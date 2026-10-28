# Debt triage — workstream 8

Everything still open in `docs/AUDIT.md` that workstreams 1–7 did not cover, plus
everything `docs/HALF-BUILT-MECHANISMS.md` turned up, in exactly one bucket each.

This document decides. It does not survey. Where a bucket is "queued" or "not
worth doing", the reason is on the row, and a row with a reason that amounts to
"later" is a row I should have decided.

---

## How the population was derived, and why it cannot pass vacuously

Every assertion in this repository's history that took the form "nothing is
open" has been satisfied by reading nothing (AUDIT L36, `docs/VACUITY-AUDIT.md`
M7, and the four workflow assertions that count their own population first). A
triage is the same shape: "everything is triaged" is perfectly true of an empty
list. So the population is counted before it is bucketed, and the buckets are
summed against that count.

**This section is a correction, and the thing it corrects is the reason the
document exists.** Its first version derived the population from each finding's
bold `**Disposition:**` / `**Status:**` label and treated *no label* as *outside
the population*, with five no-label findings added back by hand. That assumption
is false, and it hid **eighteen open findings** — including `H2`, a data-loss
path on the offline diary save, and the entire `M1`–`M6` class from the Stage 0
AI audit, not one of which carries a label at all.

It also hid three findings that *do* carry a label, which is the worse half:
`L45`, `L50` and `L51` each open with the word **Fixed** and each has an open
second clause in the same sentence — "Tap-target sizing is open as a separate,
visible change", "The Display section and the API URL field are open", "What
cannot be checked from here". A reader skimming for a verdict reads the first
clause. That is `L25`, this document's own finding about dispositions that
reassure, happening inside the document that records it.

So the derivation is no longer prose. It is
[`Projects/scripts/assert-triage-covers-open-findings.py`](../Projects/scripts/assert-triage-covers-open-findings.py),
which parses `docs/AUDIT.md`, reads `docs/HALF-BUILT-MECHANISMS.md` from the ref
that carries it, measures workstream coverage from the commit messages on the
nine workstream branches, diffs the result against the IDs rowed in **this
file**, and exits non-zero while any open, uncovered finding has no row. Three
things it does that the prose version did not:

1. **Any** open signal anywhere in a finding makes it open, even beside a closing
   one. That is the `L45`/`L50`/`L51` shape above.
2. It prints the findings whose status it **cannot** determine, rather than
   assuming them closed. That list was 25 entries; each was read once, and the
   fifteen that were open are now rows.
3. Findings it excludes are excluded **by name with the measurement that settles
   it**, in the script's `ADJUDICATED` table — "closed on a branch that is merged
   into main", "the literal the finding names is gone from the file". Twenty
   entries, each re-checked on every run, and the script reports any that name a
   finding which no longer exists.

The ID pattern also had to widen to `[CHLMFX]`: the original `[CHLF]` silently
skipped **M1–M7** entirely, reporting 114 findings where there are 121. A
population regex that drops a whole severity class is the same defect as a
hand-written count, and it is why the number above is now printed by a command.

What the script measures, on this branch tip:

```
audit findings:      121
half-built findings: 12
by status:           CLOSED=39  OPEN=48  UNKNOWN=46

open:                48
of those, covered by workstreams 0-7: 18
population (open, uncovered):         28
```

**The population is 78 rows carrying 80 distinct IDs** — the 60 this document
first claimed, plus the eighteen it missed. Two rows name two IDs because two
IDs are one mechanism. Every row carries exactly one bucket, and the bucket
totals are re-counted from this file's own tables in §6.

**A finding with two separable halves gets one row, in the bucket of its
*unfinished* half**, with the finished half stated on that row. Otherwise the
arithmetic rewards splitting: C1, L11, L13, L31, L32, L37, L46, L49, L60/F1 and
L100 all have a closed half and an open one, and counting each twice would let a
bucket total grow without a single thing being decided. Two rows name two IDs
because two IDs are one mechanism — `L60`/`F1` (location tracking) and
`L91`/`F9` (the void gate).

**The population is 60.** Every row below carries exactly one bucket, and the
bucket totals are re-counted from this file's own tables at the bottom. If that
check does not sum to 60, this document is wrong and should be read as such.

A note on the third bucket's name. The brief asked for fixed-here, queued, or
not-worth-doing-with-a-reason. Fifteen rows are queued **behind a decision that
is not mine to make** — the data-touching ones, the ones that spend money or
turn on a device, the one holding a live credential. They are queued, not a
fourth bucket; the table marks them `QUEUED-OWNER` so they can be read off in
one grep, because a queue that mixes "I will do this next" with "I cannot do
this" is how the cost-out went missing from three reports.

---

## 1. Fixed here — 9

Each is a commit on `feat/debt-and-cost-out`. SHAs are from
`git rev-list --reverse origin/main..HEAD`, not from recollection.

| ID | what it was | commit | note |
|---|---|---|---|
| `L18` | `POST /auth/login` answered an unregistered email with 404 "Account not found. Please sign up first." and a wrong password with 401 — a user-enumeration oracle any anonymous caller could read | `4b45c3c` | Red-on-revert: restoring the 404 branch failed **1 of 233**, 214 passing, 18 skips unchanged. The suite had been *holding the oracle in place*: `integration.test.ts` carried `test("login with wrong password returns 401")` which used an unregistered email and asserted **404**. Both the response and the **work** were equalised — an unknown email now verifies against a well-formed unmatchable scrypt hash, because skipping the derivation leaves a timing oracle behind the fixed body. |
| `L91`/`F9` | `POST /inspections/:id/signatures/:sigId/void` carried `FIELD_ACCESS` — identity, not rank — so any crew member with a login could retract any signature in their company | `5ca9bda` | Decided manager+ in Phase 2 and never built; measured absent on `origin/main` and on both inspection-touching branches. Three proofs, below. |
| `L104` | the cookie transport is written by five routes and was asserted by none; workstream 7 took change-password, leaving login, refresh, revoke-all and accept | `345193d` | Five red-on-revert proofs, one per route. |
| `F13` | a second `AuthProvider`/`useAuth` pair in `apps/mobile/lib/auth.tsx`, under the **live module's exact export names** and the **same AsyncStorage key**, kept alive by a Next.js-shaped `app/_app.tsx` that nothing imports | `243c4b2` | Found by doing the route→caller check for L18 properly: a third `/api/auth/login` reference turned up in a file I had no reason to open. A mis-import between the two would have **half-worked** rather than failed, because both write `sitesnap.token`. 84 lines deleted. |
| `F12` | `Projects/scripts/build.js`, 563 lines, named in `docs/ARCHITECTURE.md`, dead since the first commit | `c543f18` | |
| `F3` | a workflow named "Deploy API", triggered on every push to `main`, that deployed nothing and whose two green checks named "Typecheck" and "Tests" ran nothing | `b4b43ae` | Both used `pnpm --filter ./services/api`; a bare relative path is a **name** pattern to pnpm, so it matched no projects and pnpm exited 0. Deleted, and **check 5** added to `assert-ci-single-definition.sh` so the class cannot return. See the merge-order warning in §4 — workstream 0 answered this finding differently and its answer keeps the bug. |
| `F7` | thirteen exported symbols with no callers, three reading as safety mechanisms | `d23c4ca` | Four dead gates deleted; the fifth, `disposableDomainCount`, was given the caller it was written for rather than deleted, with a 133-line test. |
| `F4` | "Sign out everywhere" worked after Phase 2 while the portal still told the user it did not | `b1e9daa`, then **reverted** in `commit-l` | Fixed **twice**, differently, on two unmerged branches of mine. Workstream 0's `f4a54e9` owns it and is the better version — it also ties the copy to `SIGN_OUT_SCOPE_NOTICE` and ADR-0005. This branch restored `app/settings/page.tsx` to its `origin/main` content exactly. Counted as fixed-here because the triage decision is real work with a real commit; the *fix* ships from workstream 0. |
| `L8` | `createStoredPhoto` duplicated across two screens | — | **Measured already closed, and `docs/AUDIT.md`'s `OPEN` marker is stale.** One definition at `apps/mobile/lib/photo-capture.ts:112`, two importers. Nothing to build; the record is what needed correcting, and `docs/AUDIT.md` is the orchestrator's to edit. |

### The three proofs for L91

There is no Postgres on this machine, so the authoritative refusal — a DB row —
cannot be run here. Three layers were produced instead, weakest last.

**API, red-on-revert.** Reverting to the pre-change state failed **exactly 3 of
233**, with **212 passing either way** and the 18 skips unchanged. The store
answering a crew member, in its own words:

```
not ok 173 - crew are refused at the gate, a manager gets past it, and crew keep the rest of the router
  error: |-
    crew were allowed to void a signature: {"error":"Signature not found."}
    404 !== 403
not ok 174 - the gate is a rank, so viewer is refused as well and owner passes as well
  error: |-
    a viewer was allowed to void a signature: {"error":"Signature not found."}
    404 !== 403
not ok 175 - the gate runs before the payload check, so a crew member learns nothing from a malformed body
  error: |-
    the payload check ran before the gate: {"error":"Invalid void payload.","details":{"formErrors":[],"fieldErrors":{"reason":["Required"]}}}
    400 !== 403
```

Restored byte-exact; the other 212 stayed green, which is the half that proves
the new test is the only thing defending the gate. The revert also removed
`requireAtLeast` from the `:4` import, because leaving it unused would have
produced a compile error rather than a test failure — `git diff --stat` on the
restore reported 20 insertions and 0 deletions, the docblock alone.

**Mobile, red-on-revert.** Reverting `canVoidSignature` to `Boolean(companyRole)`
— the rule the screen actually used — failed **2 of 114**:

```
not ok 30 - crew are refused the four manager+ actions and nothing else
  error: 'canVoidSignature must refuse crew: true !== false'
not ok 32 - voiding a signature is manager+, and signing one is not
  error: 'true !== false'
```

**The DB row is authoritative and unrun.** `crew-permissions-db.test.ts` gained a
sixteenth refusal probe, inside the existing table so `EXPECTED_DB_SUITES` stays
11 and the skip count stays 18. It first executes in CI. A real inspection and a
real signature are seeded **as the crew member** — crew do the inspecting and
crew sign what they inspected; it is the retraction that AUDIT L91 moved to
manager+ — because the loop asserts a 2xx owner control on the same route, which
a nonexistent signature id would have broken.

---

## 2. Queued — 53

Ordered by what is holding each one, not by severity. `QUEUED-OWNER` means the
next step is a decision I was told not to make or cannot make from here.

### Blocked on a decision that is not mine — 15

| ID | what it is | bucket | what is actually needed |
|---|---|---|---|
| `L11` (legacy half) | `migrations/001` defines `sections` and `safety_checklist` (non-`_json`) that nothing reads and that sit at their NOT NULL default | QUEUED-OWNER | A column drop rewrites a table on a compliance-evidence product. The standing instruction is that incomplete records are not deleted, backfilled or cleaned up without the owner deciding, and a destructive migration is one of the two stop conditions. Built up to; not built. |
| `L24` | orphaned upload objects and rows with no sweep | QUEUED-OWNER | Same reason, one step worse: a reconciliation sweep decides what to delete. The finding's own disposition already requires it to **report what it would delete before deleting anything**. Needs an owner-run dry run first. |
| `L20` | incident push goes to the reporter, not to supervisors | QUEUED-OWNER | "Supervisor" is ambiguous: the app carries both the deprecated legacy `role` and the current company roles, and `CLAUDE.md` §3 forbids new logic keyed on the legacy one. The likely intent is every `owner` and `manager` in the actor's company with a registered token, through `withTenant` — but that is a notification-policy decision with a privacy edge, and it cannot be verified end to end until `L21` lands. |
| `L21` | push is half-built: the server sends, no client can receive | QUEUED-OWNER | Needs a device and a native build. Workstream 7 ends at "ready for `eas build`" by instruction, and no build starts without the owner being told first. |
| `L31` (DSN half) | `EXPO_PUBLIC_SENTRY_DSN` is set in the API's `.env` and empty where the client reads it | QUEUED-OWNER | A live credential the owner is relocating themselves. Not read, not moved, not printed. The two halves that were ours are already done. |
| `L32` (behaviour half) | camera GPS is extracted and persisted; the disclosure was corrected, the behaviour was not | QUEUED-OWNER | A product decision about metadata at the shutter, ranked 4th in `docs/STAGE-1-3-REVIEW.md` Part 8. |
| `L33` | no code path can delete a stored object | QUEUED-OWNER | Deliberately not built, and that remains right: the photographs it would delete are the evidence the product exists to retain. This is a retention policy, not a delete button. |
| `L40` | an `eas update` from a developer machine silently overrides the production build | QUEUED-OWNER | A process and credentials matter (who may publish to the production channel), not a code change. |
| `L61` | nothing in this project can look at the mobile app | QUEUED-OWNER | Costed and presented; needs the owner to buy a device lane or accept the boundary. It is why `L7`, `L21` and `L27` cannot close. |
| `L72` | one `@types/react` leaves the portal compiling React 19 types against React 18 | QUEUED-OWNER | Open **and accepted** (ADR-0004). Reversing it is the React 19 upgrade for `apps/supervisor-web`. |
| `L80` | `projectsStore.canManageSite:1191` admits a crew or viewer who personally created a site | QUEUED-OWNER | Two definitions of "may manage this site". Narrowing it changes who can act on sites created before `POST /projects/sites` became manager+, which is a live-data permission change. |
| `L13` (staging half) | `eas.json` staging targets `api-staging.getsitesnapai.com`, deliberately not attached | QUEUED-OWNER | There is no staging environment; attaching the host would point it at nothing. Blocked on infrastructure that does not exist. |
| `F2` | a complete, tenant-isolated, test-covered template subsystem no client can reach, carrying an Australian WHS compliance default | QUEUED-OWNER | Three `/entry-templates` routes. Either wire a client or delete them; deleting a WHS default is a product call. This is Block B's rule applied to code that already exists: tests and no caller is not built. |
| `L5` | in-memory rate limiting and revocation on a single instance; `ioredis` support already exists behind `REDIS_URL` | QUEUED-OWNER | The finding's own disposition is "No action now" and it is still right — but only while the instance count is 1, and **the instance count is the owner's to state**. The standing instruction is that I do not guess it in the code or the docs. The day it becomes 2, every rate limit and every revocation becomes per-instance and a revoked token keeps working on the other one. This is the queue entry for that fact, not for a code change. |
| `L45` (verification half) | the portal sends no photographs to the diary generator — fixed 4 October 2026; what the fix cannot show is that the output is visibly better | QUEUED-OWNER | Needs a live generation against a real site with photographs, compared with a diary generated before the commit. That is a billable OpenAI call against production data, and `test:openai` is opt-in and deliberately out of CI for exactly that reason. The owner runs it or decides it does not need running. The code half is closed. |

### Blocked on work with a named precondition — 14

| ID | what it is | precondition |
|---|---|---|
| `L39` | the server accepts an entry photograph with a `file://` uri and no storage key | The finding's own disposition says do **not** add the server assertion before the fixed client is deployed, or it rejects entries queued by the old one. Sequenced after the next `eas update` reaches devices. |
| `L37` (per-entry half) | the sync indicator is global; the question a person asks is "has *this* entry arrived" | Workstream 3 took the global half. The per-entry half is mobile UI and wants the device lane (`L61`). |
| `L38` | only `addSite` and `addEntry` are queued; an offline edit or delete fails silently | The queue needs ordering guarantees before it can carry mutations. Scope with the offline-first architecture, not alone. |
| `L34` | email and SMS verification codes are stored in plaintext; the scrypt cost factor is implicit | Hash them when the auth path is next touched, making the scrypt parameters explicit in the same commit. I touched `routes/auth.ts` this window for L18 and deliberately did **not** bundle this: a verification-code storage change needs its own red-on-revert and its own DB-gated test, and the L18 diff is the one a reviewer must be able to read in isolation. |
| `L14` | company-member invites mint a token nobody delivers | Needs a delivery step, a decision on where the invitee lands, and a `COMPANY_INVITE_WEB_URL` separate from `INVITE_URL` (which must stay `sitesnap://invite`). Real feature work. |
| `L16` | company-level settings need a companies-scoped home | A new JSONB column, an owner/manager-gated `PATCH`, and a resolution rule. Migration work, so it waits for a window where a migration is the point. |
| `L46` (server half) | invite emails are stored as typed while registration lowercases | The real fix is both schemas lowercasing at the boundary. Partially fixed on `fix/offline-photo-sync`; migration 031 normalised existing rows. The server half is a small, testable change that wants a DB-gated test, so it is queued rather than guessed. |
| `L49` (remaining half) | portal hydration mismatches — React #418/#423/#425 | Half closed. Sixteen hydration call sites remain. Mechanical, large, and unverifiable without a browser, which this environment does not have. |
| `L17` | "channel unconfigured in production" is structurally unreachable in tests | Needs an isolated `NODE_ENV=production` harness: that flag also switches `isProd` across `routes/auth.ts` and binds `getPgPool()` to `DATABASE_URL` rather than `TEST_DATABASE_URL`. A harness, not a flag flip. |
| `L12` | two schema sources of truth | **Narrowed, not closed, this window.** `979a0f5` added `storage/sqlSchemaAudit.ts` + 292 lines of test, which checks every SQL column reference in the stores against the schema the migrations declare — so a store-vs-schema drift now fails CI instead of 500ing in production. The consolidation itself (one additive migration for `project_diaries.{sections_json, safety_checklist_json}`, then delete the inline `CREATE`/`ADD COLUMN` from five stores and remove the schema-init calls from boot) is still open and is migration work. |
| `L4` (nonce half) | the portal had no CSP at all — fixed; what ships now is `script-src 'self' 'unsafe-inline' 'unsafe-eval'` | `next.config.mjs:53`. `unsafe-inline` in `script-src` is most of what a CSP is for, so the header is a frame-ancestors and referrer control today rather than an XSS control. The fix is the nonce migration, which needs a browser to verify and pairs with the queued `L48` (`img-src` omits the API origin). Both are blocked on the same missing thing. |
| `L85` | the portal's diary Approve button swallows its own failure — `catch (e) { console.error(e); }` | Phase 1b made the common case unreachable by not rendering the button for crew or viewer, which is avoidance rather than a fix: an expired session, a diary deleted by someone else and a 500 all still land in the silent branch. The finding states its own precondition — the fix is L73's shape, and converting one button inside a permissions change would leave the reports page half converted. Sequenced with L73's remaining call sites, alongside `L43` and `L42`. |
| `L103` (client halves) | the accept route now mints a replacement credential and sets the cookie, and **neither client declares it** | Server side is closed and merged: `setSessionCookie` appears twice in `main`'s `routes/projects.ts`. The portal's `AcceptedInvite` type (`lib/api.ts:189-195`) still has **no `token` field**, so a replacement in the body is discarded by the type as well as the code, and mobile still self-corrects via `refreshToken()` — a second endpoint, not the one the route offers. Mobile's half ships only on an `eas update`, and the portal's is verifiable only in a browser. Both are the blocked thing, not the work. |
| `M2` | structured output uses `json_object`, not a schema; grounding lives as prose in the prompt | `routes/ai.ts:552`, unchanged. `json_schema` with `strict: true` would delete the parse-failure fallback class outright and make the normalization layer a real grounding boundary. The finding names its own precondition — it "pairs naturally with the C1 prompt-versioning work" — and C1's provenance half is the one item in this document explicitly held for its own workstream. Doing the schema first would mean touching the same response shape twice. |

### Portal and mobile work with no blocker but no caller yet — 24

| ID | what it is | why queued rather than done |
|---|---|---|
| `L9` | media is company-scoped but not crew-scoped | `uploads` has no `site_id`, so crew-scoping means adding the column and backfilling it from the earliest referencing record — a data-touching backfill. The cross-tenant boundary (H7) is closed; this is the residual. Borders on QUEUED-OWNER and is listed here because the first step (add a nullable column) is not destructive. |
| `L7` | the `site/[id]` left-edge action bar may swallow the iOS pop-swipe | Cannot be confirmed or refuted from code. Needs a device (`L61`). The visible `BackButton` fully mitigates. |
| `L15` | restore the Settings → About "Documentation" row once guides exist | Content work: two real setup flows, supervisor and crew, on a `/docs` route. Deliberately deferred to be written properly. |
| `L19` | pnpm's isolated `node-linker` breaks tooling that resolves a transitive dependency | Open and deliberately deferred, with a stated trigger: **a fourth instance** is the point at which per-instance workarounds cost more than `node-linker=hoisted`. Three so far. The trigger is the queue entry. |
| `L22` | `babel.config.js` lists `expo-router/babel`, a no-op removed in SDK 50 | A one-line deletion that changes what every bundle produces, so it wants its own before/after bundle comparison. It is also native/build config, which is workstream 7's territory by instruction, and workstream 7 is closed. |
| `L27` | `flex: 1` resolves `flexBasis` to zero, so a flexed child of an auto-height parent collapses | One instance fixed and measured. Recorded as a mechanism so the next person finds it rather than rediscovering it. Remaining instances need the device lane. |
| `L42` | the portal signs photographs in one request capped at 50 paths | Portal work, no blocker. Behind the dashboard-parity workstream. |
| `L43` | the portal's signing failure is swallowed by `.catch(console.error)` | Same family as L73/L85 — the swallowed-failure habit. Portal work. |
| `L44` | the signing effect can wedge: its re-entrancy guard is read but not in its dependency array | Note that `react-hooks/exhaustive-deps` is **off** at `Projects/.eslintrc.js:102`, which is why the linter is silent here. Portal work. |
| `L48` | the portal's CSP omits the API origin from `img-src`, so every photograph is blocked | Portal work, and it pairs with the queued `script-src` nonce migration. Both want a browser to verify, which is not available here. |
| `L54` | the API answers a disallowed `Origin` with 500 | A CORS rejection should not be an internal error. Small, testable, and genuinely just not reached yet. |
| `L63` | exported diary and inspection HTML carries its own undocumented 14-colour palette | Branding work. This is workstream 9's population. |
| `L64` | `CLAUDE.md`'s procedure for enumerating RLS-forced tables reports 11 of 15 | The documented `grep` under-reports because some tables are forced by a later migration than the one that creates them. `CLAUDE.md` already tells the reader to prefer the live `pg_class` query. Correcting the procedure is a `CLAUDE.md` edit and wants the owner's eye since it is the file every agent reads first. |
| `L71` | the file-backed dev store does not persist companies | Dev-only. Real friction, no production surface. |
| `H2` | **an offline diary save is rolled back and lost — data loss, not a UX gap** | Measured, not inferred: `apps/mobile/lib/offline-queue.ts:3` declares `QueuedOpType` as `"addEntry" | "updateEntry" | "deleteEntry" | "addSite" | "deleteSite"` — **no diary op of any kind**. So `addDiary` and `updateDiary` have no `isNetworkError` branch to take and roll the record out of state and cache on any failure. Generation succeeds on a weak connection, the save fails seconds later, and the specific generated document is gone; regenerating at temperature 0.3 produces a *different* report than the one the user may already have read, exported or approved. Against the product's own rule that captured data is never lost, a signed-off report is captured data. **This is the most serious thing in this document that is not already someone's decision**, and it was invisible for the whole run because its section carries no status label. Not fixed here: it is the offline queue's ordering problem (`L38`) in a second place, and a mutation queue wants its own window and its own red-on-revert, not a corner of a debt branch. |
| `H3` (remaining half) | zero tests on both clients, and a suite that failed on live Twilio quota | Two of three halves are closed and measured: `notificationService.ts` carries a `NODE_ENV === "test"` guard (H3a), and mobile now runs **114 tests across 15 files**. What is left is `apps/supervisor-web`, which has **no test script and no test file on `main`** — `feat/photo-viewer` adds the first four, so this row closes when that branch merges — and the finding's higher-value half, extracting the queue-drain and rollback logic out of `data-context.tsx` into pure functions. That extraction is the same work as `H2` and should land with it. |
| `L1` (shim half) | dead code and a misleading dependency | Three of the four deletions shipped in `d9235e8` (`aiService.ts`'s `AIServiceSync`, mobile's `ApiClient`, the superseded `utils/logger.ts`), `requireRole` is gone from `middleware/auth.ts`, and the `@tanstack/react-query` half was already corrected in the finding itself as **not** dead. What remains is two no-op shims at `apps/supervisor-web/lib/api.ts:70,73` — `saveToken` is `/* no-op — cookie is set by API */` and `clearToken` forwards to `clearLocalSession` — plus the legacy role mapping in `utils/authToken.ts`. The finding asked for a removal date rather than a removal; naming the two lines is that date. Minutes of work, behind anything with a user on the other end. |
| `L3` | the API contract doc documents a surface that no longer exists | The original complaint (≈15 of ≈55 endpoints, legacy roles) was fixed by regenerating it — and regeneration is a point-in-time act with nothing holding it. `Projects/docs/api-contracts.md:3` says **"Generated from commit: `cc63dc2`"**, and `git rev-list --count cc63dc2..origin/main -- Projects/services/api/src/routes/` returns **53**. It documents 77 endpoints against 67 distinct route path literals. It is also stale by this branch: it still records `/auth/login` answering `404: user not found`, which `4b45c3c` deliberately removed as a user-enumeration oracle. The fix is not another regeneration — it is a generation step with a drift check, the shape `assert-ci-single-definition.sh` already uses. Until then a wrong contract doc is worse than none, which is the finding's own wording. |
| `L50` (remaining half) | the portal's Live Map settings were all three dead — fixed for the Live Map, and the **Display section and the API URL field are open as the same finding** | The finding says so in its own disposition: same page, same mechanism, different section. Controls that are written to `localStorage`, re-displayed on load and read by nothing. Portal work, no blocker; it sits behind the dashboard-parity work because it is the same page. |
| `L51` (remaining half) | below 640px the portal had no navigation at all — nine layout defects fixed, **tap-target sizing open and a rendered check still owed** | Both remainders are in the finding's own disposition. Tap-target sizing is deliberately separate because it is the one change that resizes a control, which the layout brief excluded. The rendered check at 375px and 768px is the harder half: verification there was code-and-build, and this environment has no browser, so nobody has yet *looked* at the thing that was repaired. That is the device/browser lane (`L61`), which is why this cannot simply be picked up. |
| `L86` | the diary gate allowlists `draft`, so crew can move an **approved** diary back to draft | **The owner's decision has been made and this is the unbuilt half**: revert-to-draft is open to the author and manager+. The finding left it ungated deliberately and asked; the answer came; nothing was built. The gate is still `requireManagerToAttestDiaryStatus` on both `POST /projects/diaries` and `PATCH /projects/diaries/:id` (`routes/projects.ts:322,344`), and it permits `status: "draft"` for anybody. The change the finding names is one asymmetry, not a redesign — allow `draft` on POST only, refuse any `status` on PATCH — but as written that also removes the author's own route back, so the decided version needs the author check the decision names. It wants a DB-gated test with both controls and a red-on-revert, because it stands between a user and a refusal. |
| `M1` | prompt injection via field notes and captions reaches a formal client-facing record | Unchanged, and measurably so: the only match for "never invent" or "untrusted" in `routes/ai.ts` is line 406, a **code comment about the fallback** — which is precisely what the finding said when it was written. The system prompt still demands detail and never forbids invention, and entry notes are embedded verbatim. The fix is one paragraph of prompt text, so it is small; it is here rather than fixed-here because a prompt change with no eval harness (`M6`) cannot be shown to have helped rather than drifted the output, and the two should land together. |
| `M3` | no streaming and no progress; worst case is a 90-second blind spinner | `routes/ai.ts:380` still sends `detail: "auto"`. The finding's own pragmatic fix is two cheap parts — `detail: "low"` for images, which cuts vision tokens roughly fourfold and is usually sufficient for PPE and plant recognition, and staged client-side progress text keyed off request phases. Neither is blocked. It is behind `H2`/`M4` because a user who retries a blind spinner double-spends the rate budget, and duplicate submission is `M4`'s defect, not this one. |
| `M4` | queued offline entries can duplicate on ambiguous failure — no idempotency key | Measured absent on both sides: zero matches for `idempotency` in `apps/mobile/lib/data-context.tsx` or `services/api/src/routes/projects.ts`. If a drained POST succeeds and the response is lost — which mobile networks do — the op stays queued and re-POSTs, and the server mints a fresh `uuidv7` each time, so the formal record gains a duplicate entry. Same family as `H2` and `L38`: it is the offline queue's correctness, and all three want one window. The client-generated id or an `Idempotency-Key` header is small; the upsert on the server is the part that needs the DB-gated test. |

---

## 3. Not worth doing, with the reason — 16

| ID | what it is | why not |
|---|---|---|
| `L23` | `pnpm store` retains an orphaned `babel-preset-expo@54.0.10` | `pnpm store prune` clears it. It is machine-local with **no repo diff**, so it cannot be reviewed, cannot be verified by anyone else, and cannot regress in a way the repo would notice. It is not debt; it is a cache. The owner can run it or not. |
| `L55` | two rounds of fixes were verified by reading artefacts rather than by running them | Recorded as a standing method change, and it **is** the method of this run: red-on-revert with pasted output, measured counts, positive controls on every negative assertion. There is nothing left to build. Keeping it open as a work item implies an artefact is owed when what was owed was a habit. |
| `L62` | `rules-of-hooks` buys nothing against the missing-dependency class | Already recorded as an accepted coverage boundary. Turning on `exhaustive-deps` across both clients is a large mechanical churn with a known false-positive rate, and the one live instance it would have caught (`L44`) is queued on its own row. The boundary is the decision. |
| `L82` | `companyRouter.use(requireAuth)` is pathless, like L66 | Harmless, and the two reasons are arrangement rather than property: `companyRouter` is mounted **last**, and the middleware is `requireAuth` rather than a rank gate. Scoping it to a path is one line — but the change is to router mounting in a tenancy-sensitive file, and a one-line change there is worth less than the risk of making it without the L66-shaped test and a DB-gated run. Recorded as latent, not fixed. If `routes/index.ts` ever grows a router after `companyRouter`, this becomes L66 again, and that is the trigger. |
| `L83` | the portal's `useRole()` resolves an absent `companyRole` to `viewer` | A fail-open default in a permission helper reads badly, and it is in fact the conservative choice: `viewer` is the second-lowest rank and grants nothing operational. The one place it mattered — `canSeeSupervisorDashboard` — deliberately reads the **raw** value, so the dashboard decision does not inherit the default. Changing the default to "no role" would log out every session stored by a build predating the field. The current behaviour is correct; the finding is a reading of it. |
| `F5` (residual) | signing out did not end the session | Closed by workstream 0 on both halves. The residual recorded here is that **zero tests referenced `/auth/logout`, `DELETE /auth/account`, `PATCH /auth/profile` or `POST /auth/reset-password`** — and workstream 0 added the logout tests. The remaining three routes are covered by the `all-db` mode's population check rather than by three new suites: see `docs/COST-OUT-STORE-DIVERGENCE.md`. |
| `F6` | no shipping client ever calls `/auth/me` or `/projects/summary`, while eight test files use `/auth/me` as a liveness probe | This is Block B's rule pointing at itself. `/auth/me` has no client caller **and should not be deleted**: it is the probe eight suites use to establish that the app is up before asserting anything, which is a legitimate use even though it is not a product one. `/projects/summary` is the real uncalled route and belongs to workstream 9's dashboard parity, where it either gets a caller or goes. Recorded so that nobody deletes the probe to satisfy a rule about product callers. |
| `F8` | `@sitesnap/shared` is built by CI, referenced as a project by both clients and the API, and imported by nothing | 12 exports, 9 unreferenced, and `AuthTokenPayload` is `{sub, exp?}` while the real payload carries seven fields — a type that would be **wrong** if anybody adopted it. Deleting the package means touching three `tsconfig` project-reference graphs and the `ci.sh:323` build step, and adopting it means correcting the drifted types first. Neither is worth doing to a package whose only cost today is one build step; the honest disposition is that the type drift makes it a liability to adopt, and that is recorded rather than fixed. |
| `F10` | the pre-commit gate exists only on this machine — untracked, no `core.hooksPath`, no husky | Deliberate, and tracking it would be a mistake. `CLAUDE.md` §10 is explicit that **CI is the gate** and that `Projects/scripts/ci.sh` is the single definition of "the build passes", with `assert-ci-single-definition.sh` failing the build if a second definition appears. A committed hook running `typecheck`/`lint` is exactly that second definition, and it would drift. The hook is a local convenience; its absence on another machine costs that machine a slower CI round trip and nothing else. |
| `F11` | pushing a `v*.*.*` tag ran `eas build` then `eas submit` with no human step | Workstream 0 split submission out into `submit-mobile.yml`, so a tag no longer submits. Whether `EXPO_TOKEN` is a repository secret — which is what decided whether the original path could ever have fired — is **unverifiable from here**: `gh` is not installed and must not be installed. Recorded as unverifiable rather than left as if it were open work. |
| `C1` (provenance half) | a saved diary records no generator, model, prompt version or warning, and `response.usage` is never read | Not "not worth doing" as a feature — it is the most valuable single item left in `docs/AUDIT.md`, and that is exactly why it is not being squeezed into a debt branch. It is a schema change (an additive provenance column), an API response-shape change, and a client change in both clients, with the fallback badge the finding asks for. It needs its own workstream, its own migration number, and its own red-on-revert. Listed here with a reason rather than queued, so it is not read as something the next window could pick up in an hour. |
| `L60`/`F1` | location tracking is unreachable dead code, while the app ships three location purpose strings, and the portal told managers to switch it on in a mobile row that does not exist | Two halves, one row. The **copy half is fixed**: workstream 7 removed the native L60 surface, and `b1e9daa` here rewrote `app/locations/page.tsx` to say sharing is unavailable rather than sending a manager to look for a switch that was never built — on a privacy feature, that reading is an accusation against the worker. The **feature half** is what puts this row in this bucket. Building it is a privacy feature requiring consent UI, a native permission flow, a device to test on, and a product decision about tracking workers. The purpose strings without the feature were the defect; that is closed. Building it is a product, not a debt item. |
| `L100` (residual) | one counter cannot mean both "this token is revoked" and "this token's claims are stale" | The behavioural half was **decided and implemented** on `feat/sessions-and-tokens`: `token_generation` on the row, read by `requireAuth` on every request. The residual is that the same counter is incremented by a revoke-all *and* by a role change, so a demoted crew member is signed out mid-shift with capture still queued offline. That is not a defect any more — it is the owner's decision, taken deliberately: **sign-out stays account-wide**, recorded as ADR-0005 on workstream 0. Separating the two meanings needs a second column and a migration, which the decision declined. The finding's own words for what is left are "a comment, not behaviour", and the ADR is a better home for it than a comment. |
| `H5` | `supervisor-web` `next build` was broken on `main` | Marked `held (user decision)` with the fix located in the eslint config. The portal has been deployed repeatedly since. **I did not verify this** — `Projects/scripts/ci.sh` runs lint, typecheck and tests but not `next build`, and running a production build of the portal was outside this branch's scope. Recorded as almost certainly stale, needing one `pnpm -C Projects --filter sitesnap-supervisor-web run build` to confirm, which is the honest state rather than a claim. |
| `M5` (cost half) | token and cost blindness on the one paid API | **The measurement half is closed and the finding's "Where" clause is now false**: `routes/ai.ts:660-661` reads `response.usage.input_tokens` / `output_tokens` and `tokenUsage` is persisted and returned (`:600,721,796`). What is left is the finding's secondary ask — a rough per-request cost estimate from the configured model's prices. That is a hardcoded price table for a model set by the `OPENAI_MODEL` environment variable, so it would be wrong the first time the model changes and wrong silently, which is the `L25` class again. Tokens are the durable number and they are now recorded; the dollar figure belongs in the OpenAI dashboard, which already has it. Not worth building a price table the repo cannot keep true. |
| `M6` | LLM output quality has no regression harness | Not built, and the finding's own specification is the reason it stays that way for now: it asks for an eval that "calls the real API when `OPENAI_API_KEY` is present", run manually before a prompt change, **explicitly not in CI**. That is `test:openai`, which already exists, is already opt-in, already makes real billable calls, and already covers the request-shape contract the mock cannot. The gap between what exists and what the finding asks for is the fixture set and the grounding assertions — real work, and work whose value is entirely in being run by hand before a prompt change by someone who can read the output. Building the harness without that habit produces a script nobody runs. It is recorded here with its reason rather than queued, because queueing it implies the next window could land it, and what it actually needs is `M1`'s prompt change to be in flight at the same time. |

---

## 4. Merge-order warnings — read before merging anything

Two of my own branches answer the same finding twice. Both were found by
measurement, not by review:

```
git merge-tree $(git merge-base origin/fix/workstream-0-safety HEAD) \
    origin/fix/workstream-0-safety HEAD
```

reported **`changed in both`** for four files.

**F4 — resolved, by giving it back.** `app/settings/page.tsx` is fixed on both
branches with different wording. Workstream 0's is better. `commit-l` on this
branch restores the file to its `origin/main` content exactly, so the conflict
is gone and F4 ships once.

**F3 — not resolved, and this is the loud one.** Workstream 0's `54c1321`
**renamed** `deploy-api.yml` to `api-post-merge-checks.yml` and rewrote it.
This branch's `b4b43ae` **deleted** it. Git sees both sides delete the old path
and reports no conflict, so the merge is silent and the result is wrong:
workstream 0's file survives, and this branch's `EXPECTED_WORKFLOWS=2` then
reads against four workflow files and fails CI.

Worse than the counter. Workstream 0's rewritten workflow **keeps the bug F3 was
about**:

```
$ git show origin/fix/workstream-0-safety:.github/workflows/api-post-merge-checks.yml \
    | grep -nE '^[[:space:]]*run:.*pnpm'
73:        run: pnpm --filter ./shared run build:types
76:        run: pnpm --filter ./services/api run typecheck
79:        run: pnpm --filter ./services/api run test
```

Those are still **path** filters. pnpm reads a bare relative path as a name
pattern, matches no projects, and exits 0 — the workflow reports green having run
nothing, which is the entire finding. **Check 5**, added to
`assert-ci-single-definition.sh` in `b4b43ae`, fails on exactly this file, which
is the class-level guard doing its job against a branch written three workstreams
earlier.

**Recommendation, stated as a recommendation because merging is the owner's:**
take this branch's deletion and drop workstream 0's rename. If the post-merge
check is wanted, it should call `./scripts/ci.sh` like `ci.yml` does, and then it
is a second definition of the gate and check 5 refuses it — which is the argument
for not having it.

**Separately, workstream 0's branch fails its own pin today.** It has four
workflow files and still pins three:

```
$ git ls-tree --name-only origin/fix/workstream-0-safety .github/workflows/ | wc -l
4
$ git show origin/fix/workstream-0-safety:Projects/scripts/assert-workflow-runners-pinned.sh \
    | grep EXPECTED_WORKFLOWS=
EXPECTED_WORKFLOWS=3
```

`assert-workflow-runners-pinned.sh` counts the directory with
`find -maxdepth 1` before asserting anything — the vacuity guard — so this is a
hard failure of workstream 0's CI, independent of this branch. It needs one line
changed on that branch before it merges. I have not touched it: editing another
pushed branch from this one is not mine to do.

**The other two `changed in both` files are ordinary sibling overlap** and
resolve by taking both sides: `routes/auth.ts` (workstream 0's sign-out work and
this branch's L18 login fix, different handlers) and
`sessions-and-tokens{,-db}.test.ts` (workstream 0's logout tests against this
branch's `applyMigrations` hoist and cookie-transport tests).

---

## 5. Two claims in `docs/ARCHITECTURE.md` that are measurably false

Both were found by following the document to code that was not there. `F12`'s
commit corrected the `build.js` row and `F3`'s corrected the workflows row;
these two remain, and `docs/ARCHITECTURE.md` is the orchestrator's to edit.

**Line 19** — "18 ordered `.sql` migrations (001→018)":

```
$ ls Projects/services/api/src/storage/migrations/*.sql | wc -l
31
$ ls Projects/services/api/src/storage/migrations/ | tail -1
031_normalise_invite_emails.sql
```

Thirty-one, not eighteen. This matters more than a stale number: `CLAUDE.md` §4
exists because migration numbers drift and a wrong one corrupts the boot
sequence, and the architecture document is where a new agent looks first.

**Line 22** — "There is **no CLAUDE.md** in the repo. Root `README.md` is one
line (`# SiteSnap-AI`)":

```
$ wc -c CLAUDE.md
26088 CLAUDE.md
```

A 26,088-byte file that every agent is instructed to read in full, described by
the architecture document as absent.

---

## 6. Bucket arithmetic

| bucket | rows |
|---|---|
| fixed here | 9 |
| queued — blocked on an owner decision (`QUEUED-OWNER`) | 15 |
| queued — blocked on work with a named precondition | 14 |
| queued — no blocker, not yet reached | 24 |
| not worth doing, with the reason | 16 |
| **total** | **78** |

Queued totals 53. 9 + 53 + 16 = 78 rows, carrying 80 distinct IDs, because two
rows name two IDs each — `L60`/`F1` (location tracking) and `L91`/`F9` (the void
gate) — per the one-row-per-mechanism convention above.

The population is not re-derived here in prose, because deriving it in prose is
the defect this section now records twice. It is printed by
`Projects/scripts/assert-triage-covers-open-findings.py`, which parses the tables
in **this** file and diffs them against `docs/AUDIT.md` and
`docs/HALF-BUILT-MECHANISMS.md`:

```
audit findings:      121
half-built findings: 12
by status:           CLOSED=39  OPEN=48  UNKNOWN=46

open:                48
of those, covered by workstreams 0-7: 18
population (open, uncovered):         28
bucket headings:     all match their row counts
IDs in a table row:  80

no status signal (46) -- printed in full by the script, elided here

MISSING (open, uncovered, no row):
  (none)

adjudicated out of the population: 20 (each with its measurement, see ADJUDICATED above)

VERDICT: PASS
```

### The two runs that did not pass, and why both are recorded rather than fixed quietly

**First run — two errors that cancelled in the total.** `L100` had no row at
all, and `F1` appeared in two buckets: the copy half under fixed-here and the
feature half under not-worth-doing. One missing and one doubled summed to the
same sixty, so the total was green over a wrong list. That is the argument for
checking the rows rather than the sum.

**Second run — eighteen missing rows behind a green check.** The first version of
this document shipped with `MISSING: []  EXTRA: []  VERDICT: PASS` pasted into
this section, and it was lying, because the *population* it diffed against was
itself derived by hand. The check compared the rows to a list built from status
labels, so a finding carrying no label was absent from both sides and could not
be reported missing. Eighteen were: `H2` `H3` `L1` `L3` `L4` `L5` `L45` `L50`
`L51` `L85` `L86` `L103` `M1` `M2` `M3` `M4` `M5` `M6`.

It surfaced by accident, from the wrong direction. Workstream 9's population
work found the portal dashboard counting its metric cards client-side from
`/projects/bootstrap`, whose three list calls take `limit = 200` — so the cards
are silently wrong past 200 records. Looking up the audit entry for that
mechanism found **L98**, verdict "Not fixed", and then found that L98 had no row
in this document. L98 turned out to be legitimately outside the population
(workstream 4 pushed the range into the `WHERE` clause and `ADJUDICATED` now
records that with the commit), but the question it forced — *how many other open
findings have no row?* — had an answer, and the answer was eighteen.

Both failures are the same failure at different depths. The first was a wrong
list under a correct check. The second was a wrong check: a count derived in
prose, pasted as output, and read as a measurement for the life of a branch.
That is the owner's standing rule — **any pinned count is measured, never
hand-written** — applied to the one number in this document that was not. The
script is the fix; this section is the record. It is deliberately **not** wired
into `Projects/scripts/ci.sh`, because doing so would fail the build the moment a
new audit finding lands without a triage row, and that is a gate nobody asked
for. The owner decides whether to turn it on.

### Red-on-revert, both doors

The check has two independent ways to catch a missing row, so both were reverted
separately. The rule is the owner's: revert the line, run it, paste the failure,
restore it, and confirm the rest stayed green.

**Proof 1 — a finding with no status label.** `H2`'s row deleted. This is the
one that mattered, because it is the exact shape of the eighteen: a finding the
old derivation could not see.

```
=== PROOF 1: delete H2's row (a finding with NO status label) ===
H2 row removed
bucket headings:     1 heading disagrees with its row count
  Portal and mobile work with no blocker but no caller yet: heading says 24, rows count 23
IDs in a table row:  79

no status signal (46) -- printed in full by the script, elided here
  H2 is in this group and has no row

MISSING (open, uncovered, no row):
  (none)

VERDICT: FAIL -- 1 finding(s) with no status signal and no row; a bucket heading disagrees with its row count
exit=1
```

Note the `MISSING: (none)` in that output. **The first version of the script
passed this revert.** `H2` carries no status label, so it never entered
`population`, so the ID diff had nothing to report — only the bucket arithmetic
caught it, and only because I had not also corrected the heading. That is the
hole the eighteen hid in, reproduced on demand. The fix was to make
`unknown_unrowed` a hard failure in its own right: a finding leaves this document
by exactly three doors — it gets a row, a workstream covers it, or `ADJUDICATED`
names it with the measurement that closes it. *"Its section has no status label"*
is not a door. The output above is from the corrected script.

**Proof 2 — a labelled, half-open finding, with the heading corrected so only
the ID diff can catch it.** `L51`'s row deleted *and* the bucket heading
decremented to 23, which leaves the arithmetic check green on purpose. That is
the "others stayed green" half: the bucket check is demonstrably not what caught
this one.

```
=== PROOF 2: delete L51's row (a labelled, half-open finding) and fix the heading so only the ID check can catch it ===
L51 row removed and heading decremented to 23
bucket headings:     all match their row counts
IDs in a table row:  79

MISSING (open, uncovered, no row):
  L51
    L51: Fixed for the nine layout defects above. Tap-target sizing is open as a separate,

VERDICT: FAIL -- 1 open finding(s) unrowed
exit=1
```

**Proof 3 — the real one, needing no revert at all.** Run the committed script
against this document *as it was actually committed* at `05a68ee`:

```
$ git show 05a68ee:docs/DEBT-TRIAGE.md > docs/DEBT-TRIAGE.md
$ python3 Projects/scripts/assert-triage-covers-open-findings.py

IDs in a table row:  62

NO SIGNAL AND NO ROW (15) -- each needs a row, a workstream, or an ADJUDICATED entry with its measurement:
  H2 H3 L1 L103 L3 L4 L5 L85 L86 M1 M2 M3 M4 M5 M6

MISSING (open, uncovered, no row):
  L45 L50 L51
    L45: Fixed, 4 October 2026. What cannot be checked from here: that the model's output is visibl
    L50: Fixed for the Live Map. The three controls now govern the page they describe, the
    L51: Fixed for the nine layout defects above. Tap-target sizing is open as a separate,

VERDICT: FAIL -- 15 finding(s) with no status signal and no row; 3 open finding(s) unrowed
exit=1
```

15 + 3 = **the eighteen**, split exactly along the two causes: fifteen that
carry no status label at all, and three whose label opens with the word
*"Fixed"* and carries an open clause in the same sentence. No line was reverted
to produce this — it is the state that shipped, failing the check that should
have been there. Proofs 1 and 2 above exist because a single-row revert isolates
each door; this one is the evidence that both doors were open at once in a
pushed commit.

`L51` is also the finding whose label opens with the word **Fixed** and carries
an open clause in the same sentence, so this proof exercises `classify`'s
any-open-signal-wins rule at the same time as the ID diff.

Both lines restored, the check back to `VERDICT: PASS` at exit 0, and the full
output of that passing run is the block above in this section.
