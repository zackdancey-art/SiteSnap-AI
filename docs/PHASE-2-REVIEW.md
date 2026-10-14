# Phase 2 — Sessions and Tokens — review

Branch `feat/sessions-and-tokens`, twelve commits off `main` (`ec55862`). 15 October 2026.

Covers AUDIT **L74** (`/auth/refresh` sat behind `requireAuth`, so an expired token could not
refresh itself and the route served nobody), **L75** (`/auth/revoke-all` minted a new token and
invalidated nothing), **L76** (a 7-day TTL read once at module load with no renewal path).

---

## The model, as built

**The token proves who you are. The record decides what you may do.**

That sentence is the owner's, taken 15 October 2026, and it is written at the definition of
`token_generation` in `storage/authStore.ts` and again at `loadSessionIdentity`. It resolves a
contradiction in the design I was given approval to build, which is recorded as **L100**:

- `token_generation` means **exactly one thing** — *this token is revoked*. A password change and
  `/auth/revoke-all` increment it. `setUserCompany` and `setUserCompanyRole` **do not**.
- Authority — `companyId`, `companyRole`, `role` — comes from the user row that `requireAuth` is
  already reading. The claims are a cache of it and **the record always wins**.

What follows, and is asserted rather than asserted-about:

- A demotion or a removal takes effect within the identity cache window
  (`SESSION_IDENTITY_TTL_MS = 60_000`, `storage/authStore.ts:321`) with **no sign-out and no
  interruption**. The person keeps working; their authority changes under them.
- A stale claim never needs to 401, because it is never consulted for a decision.
- `/auth/refresh` works for exactly the tokens it exists to serve.
- Revocation stays absolute — refused on every route **including refresh**.

**The failure mode this entry exists to prevent:** a future session notices that the token already
carries `companyRole`, and "optimises away" the comparison against the record. That silently
restores a stale-authority window. The comparison is not redundant; it is the mechanism.

### The divergence from the approved design, stated plainly

The approved wording was "demotion and removal increment the generation". Building it produced
**nine failing tests, eight of which were the claim-stale case**, and two real journeys that break:

1. An invitee accepting an invitation has their company set, which revokes the token they are
   holding — they land back on the login screen mid-flow.
2. A crew member demoted mid-shift is signed out with capture queued offline.

One counter cannot mean both "revoked" and "stale" — the first must refuse, the second must not.
The owner chose **option 2 with the repair variant** and dictated the model above. The check the
owner asked me to use rather than report: under option 2 those eight tests pass again **without
being edited**. They were not edited. The ninth was a genuine assertion of the old model and was
rewritten.

### "Repair in place" — real on the portal, deliberately inert on mobile

`/auth/refresh` and `change-password` hand back a replacement token, and the portal's `Set-Cookie`
lands, so the repair is real there. On mobile it is **correctness-neutral and deliberately so**: the
client has no way to pick up a re-minted token without the response header the owner declined, and
it does not need one, because the stale claim is never used for a decision. Said here rather than
left as a half-mechanism that looks broken to the next reader.

---

## What was built, per commit

| Commit | What it does |
|---|---|
| `3087ee6` | `auth_users.token_generation` becomes part of the user record: read on load, incremented by `revokeAllSessions`, both store paths. |
| `5c57e12` | `createAuthToken` **requires** `tokenGeneration` (no default — a caller that forgets it does not compile), and `verifyAuthTokenForRefresh` accepts a token up to `REFRESH_GRACE_SECONDS` past `exp`. |
| `ac51e59` | The session cookie moves to `utils/sessionCookie.ts`, so the middleware can set it and `COOKIE_MAX_AGE_MS` has one definition. |
| `c463d37` | `requireAuth` checks the generation on **every** authenticated request, and an unreachable user store answers **503 `session_unavailable`**, never 401. |
| `8de9899` | Authority comes from the user row. `setUserCompany`/`setUserCompanyRole` stop incrementing. This is the option-2 commit. |
| `76b8d05` | Seeds the `auth_users` row that `api-flow.e2e.test.ts` and `uploads-media-isolation.test.ts` were authenticating without. Nobody asked for this; see below. |
| `17efa8e` | The three findings: refresh works on an expired token, revoke-all revokes, a password change leaves the acting device signed in. |
| `7710b16` | Mobile adopts the token `change-password` hands back. |
| `5a64ec8` | The portal reads the `code` on a 401 instead of signing you out for any 401 at all. |
| `2313237` | `sessions-and-tokens.test.ts` and `sessions-and-tokens-db.test.ts` — the same five tests on both store paths; `EXPECTED_DB_SUITES` 10 → 11. |
| `23dc9fa` | CLAUDE.md §5 said six DB suites and thirteen skips. It is eleven and eighteen. |

**`3087ee6`'s subject line — "changing a claim ends the sessions" — is now false.** `8de9899`
superseded it four commits later. `git commit --amend` is not available to me in this environment,
so it is corrected here and in the PR body rather than rewritten.

### Timings, derived rather than configured

`TOKEN_TTL_SECONDS` is still `AUTH_TOKEN_TTL_SECONDS` defaulting to seven days, still read once at
module load (`utils/authToken.ts:31`) — and that no longer matters, because a working refresh is
what L76 actually needed. `REFRESH_GRACE_SECONDS = max(0, SESSION_MAX_IDLE_SECONDS - TOKEN_TTL_SECONDS)`
(`authToken.ts:66`), where the idle ceiling comes from `COOKIE_MAX_AGE_MS` **imported** from
`sessionCookie.ts`, not copied. So an idle user is signed out between 23 and 30 days, depending on
where in the token's life they stopped, and the two numbers cannot drift apart.

---

## Verification

### Green

Full in-memory API suite, `scripts/run-tests.sh`:

```
# tests 211
# pass 193
# fail 0
# skipped 18
run-tests.sh: 18 skip(s), as expected — each runs for real under test:db / test:redis / test:openai
```

The eleven DB-gated suites were **measured, not counted**:
`/usr/bin/grep -rl '!process.env.TEST_DATABASE_URL' dist | wc -l` → `11`.

### Red-on-revert — six guards, each one measured

I backed the three source files up, reverted one guard at a time with an
`assert s.count(old) == 1` guard on each patch, rebuilt, and ran the one test file. **No revert
failed a test that does not own it.** Actual output, token strings elided:

```
R1  requireAuth's generation check removed
not ok 1 - revoke-all ends another device's session, and the acting device keeps working
    the other device must be signed out: {"user":{"email":"sessions-owner@example.test","name":"Session Owner","role":"admin","companyId":"sessions-co","companyRole":"owner"}}
    200 !== 401
not ok 3 - a password change signs out every other device and leaves this one signed in
    a password change must sign out every other device
    200 !== 401
# pass 3 / # fail 2

R2  refresh's generation check removed
not ok 2 - revocation reaches /auth/refresh, the one route that could have exempted itself
    a revoked token refreshed itself: {"token":"<elided — a token signed with the test secret>","user":{…}}
    200 !== 401
# pass 4 / # fail 1

R3  req.auth taken from the claims again
not ok 5 - authority comes from the user row, so the token's claims can neither grant nor remove it
    a stale owner claim was honoured: {"members":[{"email":"sessions-crew@example.test","name":"Session Crew","companyRole":"crew"},{"email":"sessions-owner@example.test","name":"Session Owner","companyRole":"owner"}]}
    200 !== 403
# pass 4 / # fail 1

R4  revoke-all stops calling revokeAllSessions
not ok 1 - revoke-all ends another device's session, and the acting device keeps working
    200 !== 401
not ok 2 - revocation reaches /auth/refresh, the one route that could have exempted itself
    200 !== 401
# pass 3 / # fail 2

R5  refresh uses the strict verifier
not ok 4 - a token that has just expired can refresh; one past the idle window cannot
    refresh refused a just-expired token: {"error":"Your session has expired. Please sign in again.","code":"session_expired"}
    401 !== 200
# pass 4 / # fail 1

R6  change-password stops returning a token
not ok 3 - a password change signs out every other device and leaves this one signed in
    change-password must hand back a replacement token — the increment revokes the caller's own credential
    expected: true
# pass 4 / # fail 1
```

The elision is deliberate: R2's and R4's raw output embeds a complete signed token. It is signed
with a test secret and is worthless, but credential-shaped strings do not go into `docs/` or a PR
body.

### Both controls on every assertion

Every one of the five tests carries its positive control **in the same test** as its refusal. A
refusal test alone passes equally well against a route that has been deleted — which is how M7
shipped a `/uploads/sign` that denied everyone with 126 tests green. Test 4 additionally carries a
vacuity guard: `assert.ok(refreshGraceSeconds > 0, …)`, because if the grace ever derived to zero
the test would pass by asserting nothing.

### What a stolen token buys, before and after

| | Before | After |
|---|---|---|
| Lifetime of a stolen token | Up to 7 days, unconditionally | Until the next generation increment, then nothing |
| Owner changes their password | Stolen token keeps working for up to 7 days | Refused on the next request, everywhere |
| Owner uses "sign out everywhere" | Stolen token keeps working — the route minted a token and invalidated nothing | Refused on the next request, everywhere |
| Can the thief refresh it to extend? | The route was unreachable, so no — but nor could the legitimate user | No: refresh checks the generation, and it is the one route that could have exempted itself |
| Thief holds a token claiming `companyRole: "owner"` for a demoted account | Honoured — authority came from the claims | Refused within 60 seconds; the claim is never consulted for a decision |

Caveat, stated rather than glossed: revocation is **not instant across instances**. One instance
increments the column and clears only its own cache, so another instance can honour the previous
generation for up to `SESSION_IDENTITY_TTL_MS` (60 seconds). The owner has said he will report the
Render instance count; I have not guessed it in the code or in this document.

---

## What I found that nobody asked for

**L100 — the design contradiction itself.** The phase prompt named a stop condition: "a finding that
changes what should be built". This was one, it stopped, and the owner's decision is recorded
verbatim in AUDIT so the next session does not re-optimise it.

**L101 — a test asserted that removing a site member removes site visibility.** It does not, and
never did. `projectsStore.listSites` returns every site in the company to every role including crew,
deliberately — site membership is not the read gate, company membership is. The assertion was green
only because its re-query used a token that resolved to the removed member's own empty solo company.
Repaired (a before/after on `GET /projects/sites/:id/members`, plus an explicit assertion that
visibility stays company-scoped) rather than deleted. This is the L87 shape, in the test file next
door to L87's fix.

**Two suites were authenticating as users who had no `auth_users` row** —
`api-flow.e2e.test.ts` and `uploads-media-isolation.test.ts`. They minted tokens directly and never
created the account. That was harmless while `requireAuth` only verified a signature, and became a
hard failure the moment it reads the record. Fixed by seeding the row (`76b8d05`), not by exempting
the route. Worth knowing on its own: the tests were asserting against a user the API did not have.

**CLAUDE.md §5's counters were stale** — six suites and thirteen skips, against a real eleven and
eighteen. A long-carried recorded finding that previous sessions left alone. I changed it on my own
initiative because my own commit is what made the number eleven, and I added a pointer to the
authoritative file (`services/api/scripts/run-tests.sh`) plus a last-checked date, so the prose
cannot silently drift again. Separate commit, NO DEPLOY.

---

## What was not done, and why

**No migration, and the phase prompt expected one.** `012_token_generation.sql` already exists,
landed in June, and is applied in production; existing rows default to `0`. There was nothing to
add. The DB-half test asserts the column exists **and is of type `integer`** before any assertion
depends on its value — because a missing column reads as `undefined`, and `undefined < 1` is false,
which is a revoked token waved through with every test green. That is the L11 shape and it is the
reason the assertion is there rather than assumed.

**The 503 `session_unavailable` path is code-read only.** Neither store can be made to fail its
identity read from inside the harness without faking the pool, and faking it would assert the fake.
Stated in `c463d37`'s commit message and stated again here. It is the one behaviour in this branch
with no test behind it.

**The mobile response header was declined by the owner, and stays declined.** See "repair in place"
above.

**The `unhandledRejection` handler is unchanged, deliberately.** The owner's plan, recorded here so
no future session changes it on its own initiative: **watch Sentry for a week now that 41 routes are
wrapped by `asyncSafeRouter`, and make the handler exit only if that week is clean.** Do not change
it before then.

**Neither divergence resolution was built.** The owner asked for the numbers and will choose. They
are below.

---

## New AUDIT entries

- **L100** — one counter cannot mean both "this token is revoked" and "this token's claims are
  stale". DECISION (owner's) + MEDIUM. Carries the nine measured failures, the two broken journeys,
  the owner's statement verbatim, and the "optimise away" failure mode. Also records as OPEN that
  `apps/mobile/lib/data-context.tsx`'s `acceptInvite` doc comment now states a false premise.
- **L101** — removing a site member is not a site-visibility control. MEDIUM (test integrity).

Dispositions rewritten to FIXED: **L74**, **L75**, **L76**.

---

## Deploy classification

| Commit | Classification |
|---|---|
| `3087ee6` `5c57e12` `ac51e59` `c463d37` `8de9899` `17efa8e` | **API deploy** |
| `7710b16` | **JS-only — `eas update`** |
| `5a64ec8` | **Portal deploy** |
| `76b8d05` `2313237` `23dc9fa` | **No deploy** (tests, lint config, docs) |

### The ordering matters, and in one direction only

**Ship the `eas update` before the API deploy.** After the API deploy, a password change increments
the generation, which revokes the caller's own credential — that is correct and intended. A mobile
build that does not yet adopt the replacement token the route hands back will therefore sign the
person out the moment they change their password. `7710b16` is what adopts it. Portal first or
alongside, for the same class of reason. Nothing in the branch requires a native rebuild; no native
config was touched.

---

## The cost-out: two honest resolutions to the store divergence

Neither is built. These are the numbers.

### The six, named

So that "the six" is not a number without referents, the six recorded instances of the in-memory
store and the Postgres store answering the same question differently are: **L65** (invite-accept
attached nobody to a company on Postgres), **L87** (an in-memory `site_members` escape hatch the SQL
did not have), **L88** (`updateSiteProgress` refused every crew member in memory and allowed every
crew member in Postgres), **L89 twice** (`updateIncident` and `updateInspection` — the in-memory
twins checked authorship, the SQL did not), and **L99** (a predicate naming a column that does not
exist; the in-memory path answered a plausible 404 while Postgres hung).

### Measured inputs

| | |
|---|---|
| Test files | 45 |
| Lines of test code | 11,846 |
| Tests | 211 (193 run in memory, 18 gated) |
| DB-gated suites today | 11 (measured by selector) |
| `if (!useDatabase())` branches | **97**, across 11 stores |
| Lines of store code | 7,532 |
| In-memory maps/stores declared | 18 |
| In-memory suite, parallel | **11.99s** |
| In-memory suite, `--test-concurrency=1` | **38.08s** (3.2×) |
| Test files calling a store reset helper | **26** of 45 |
| Postgres in CI | already there — `postgres:16` service, `.github/workflows/ci.yml:28-38` |

Per-store branch counts: authStore 27, projectsStore 29, inspectionStore 10, deliveriesStore 6,
incidentStore 5, pushStore 5, crewStore 4, templateStore 4, signatureStore 3, locationStore 2,
uploadsStore 2.

### Resolution A — run the whole suite against Postgres in CI

**Cost to do.** No new infrastructure: the `postgres:16` service container already runs on every
CI job, with a `pg_isready` health check. The work is the **26 test files that call
`resetAuthStoreForTests` or `resetProjectStoreForTests`**. In DB mode those helpers `DELETE` every
row in `auth_users` and `companies`, which on a shared database is 26 files racing to truncate each
other. Two ways out, and the choice is the whole cost:

- *Namespace per file* — the pattern the 11 DB suites already use (a `runId`, suffixed company and
  emails, explicit cleanup in `after`). Applied to 26 files. This is the dominant cost: roughly
  2–4 days, and it touches almost every test in the package, which is its own risk — a careless
  rewrite weakens assertions silently, which is the exact failure class this is meant to fix.
- *Serialise the suite* — measured: 11.99s → 38.08s. That 38s is a **floor, not an estimate**,
  because it is the in-memory store; with a socket round trip per query the real figure is
  multiples of it.

Either way, the `applyMigrations` boilerplate currently copy-pasted into 11 files becomes 45, which
argues for hoisting it into `test-setup.ts` — more work, but work worth having.

**Cost to keep.** CI time on the API package goes from ~12s to minutes, on every push. Every new
test has to be written namespace-clean, and nothing enforces that. A flaky database blocks every
PR instead of 11 suites. And the 97 in-memory branches **still exist**, still compile, still able to
diverge — they just stop being what the suite measures. Nothing prevents a new in-memory-only test.

**What it would have caught of the six: all six.** Every one is "the SQL does something the map
does not", and A runs the SQL.

### Resolution B — reduce the in-memory store to a fake too thin to diverge

**Cost to do.** Delete the 97 branches across 11 stores and the 18 maps; the fake becomes one dumb
row-store, with every scope and authorization rule living in the shared module that already exists
for exactly this (`storage/recordScope.ts`). It is the larger single edit — 7,532 lines of store
code is the surface — but it is one edit, in one layer, by one person, rather than 26 test files.

**Cost to keep.** Essentially nothing. CI stays at 12s. Divergence becomes *structurally*
impossible for the fake, because there is no second implementation to diverge.

**What it would have caught of the six: none, by execution.** B never runs SQL. What B does is
destroy the **false green**: five of the six (L65, L87, L88, and L89 twice) were hidden behind a
test that passed on logic only the map had. Under B those tests would have gone red — or been
unwritable — at the moment they were authored, putting the defect in front of a human then instead
of in production. **L99 it would not have touched at all**: a predicate naming a non-existent column
has no in-memory twin to flatter it, and only A reaches it.

So the honest framing: A buys real coverage of production's behaviour and costs CI time and a risky
mass rewrite. B buys the removal of a lying signal and costs nothing to keep, but replaces a false
green with an honest absence of coverage — the 11 DB suites remain the only thing that touches SQL.

### The seventh instance, which has not happened: `token_generation`

This is the number I would weigh most heavily, and it is not like the six.

Each of the six was one feature answering wrongly. `token_generation` is read by
`loadSessionIdentity` on **every authenticated request on every route**. `authStore` carries 27 of
the 97 branches — the largest share of any store. A divergence here does not break a feature; it
breaks a **security control while reporting success**: the generation check passes against the map
and no-ops against Postgres, so revocation silently does nothing in production — a revoked token
accepted everywhere, "sign out everywhere" a lie, a password change not ending any session — with
all five new tests green. That is L11's shape (`undefined < 1` is false) applied to the whole API
surface instead of one table.

It is why the five tests were written twice, in two files, with the duplication deliberate; why the
DB half asserts the column's existence and type before anything depends on its value; and why the
in-memory half is explicitly labelled as the runnable half rather than the authoritative one. The
six cost features. The seventh would cost the thing the phase was built to deliver, and it would
cost it quietly.

---

## What cannot be verified without you

1. **The DB-gated suite has never run on this machine and cannot.** There is no Postgres, no Docker,
   no podman and no `psql` here. `sessions-and-tokens-db.test.ts` is 386 lines of assertions that
   have never executed. CI's `postgres:16` service is where they run for the first time, and that is
   a statement about CI, not about my machine.
2. **The 503 `session_unavailable` path** — code-read only, for the reason given above.
3. **The Render instance count**, which sets how long the 60-second cache window actually means
   across instances. You said you would tell me; I have not guessed it in the code or the docs.
4. **Whether `AUTH_TOKEN_SECRET`'s value changed in the Render dashboard around the Phase 1
   deploy** — still open from an earlier phase, and it bears on this one, because every stored token
   is unacceptable if it did.
5. **The two real journeys in L100** — invitee acceptance and a mid-shift demotion — are argued from
   the code and from nine measured test failures. I have not driven either on a device, and I am not
   describing the invitation flow as working on the strength of code I have read.

---

*Co-Authored-By: Claude Opus 5*
