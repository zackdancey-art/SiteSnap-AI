# Workstream 8 — Debt, and the two structural answers

Fifteen commits on `feat/debt-and-cost-out`, based on `ee7e093`. Three deliverables:
the triage of everything still open, the cost-out owed since Phase 2 (**picked and built**),
and the four uncovered cookie-transport routes from L104.

**Read section 6 before merging anything.** This branch collides silently with
workstream 0 on one finding, and workstream 0 fails its own CI pin today. Neither
is visible as a git conflict.

---

## 1. Routes touched, and the client file and line that calls each

Block B: a route with tests and no caller counts as not built. Two routes changed
behaviour on this branch. Both have a shipping caller, verified by grep rather than
by memory:

| route | changed how | client caller |
|---|---|---|
| `POST /api/inspections/:id/signatures/:sigId/void` | gained `requireAtLeast("manager")` ([inspections.ts:250](Projects/services/api/src/routes/inspections.ts#L250)) | [apps/mobile/app/inspections/[siteId].tsx:834](Projects/apps/mobile/app/inspections/%5BsiteId%5D.tsx#L834), in `handleConfirmVoid` |
| `POST /api/auth/login` | an unknown email now answers `401 invalid_credentials`, not `404 Account not found` ([auth.ts](Projects/services/api/src/routes/auth.ts)) | [apps/mobile/lib/auth-context.tsx:165](Projects/apps/mobile/lib/auth-context.tsx#L165) and [apps/supervisor-web/lib/api.ts:209](Projects/apps/supervisor-web/lib/api.ts#L209) |

The void route also gained a **client-side** gate in the same commit, so the control
is not merely refused server-side but absent for crew:
`[siteId].tsx` imports `canVoidSignature` from [lib/permissions.ts](Projects/apps/mobile/lib/permissions.ts)
and renders the void control under `sig.status === "active" && mayVoidSignature`.
The error path routes through `describeFailure` (AUDIT L73) so that a 403 reaching a
stale client — a `user` rehydrated from storage, or a demotion mid-session — reports
"you may not do this" rather than "it broke". **Hiding is not enforcing; the route
gate is the enforcement and the hidden control is the courtesy.**

### A correction to commit `4b45c3c`'s own message

That commit's message names the login caller **"signIn"**. It is `login`, at
`auth-context.tsx:165`. The message also lists a third call site that this branch
subsequently deleted (the shadow `lib/auth.tsx` provider, removed in `243c4b2` for
F13). Both are wrong in the committed message and correct here; I am not amending a
pushed-adjacent commit to fix prose.

### The four L104 routes carry no route change

`345193d` adds assertions only. The helper change they test was already in `main`.
Routes asserted: `POST /api/auth/login`, `POST /api/auth/refresh`,
`POST /api/auth/revoke-all`, `POST /api/invites/accept`. Their callers are the portal's
cookie transport — [apps/supervisor-web/lib/api.ts](Projects/apps/supervisor-web/lib/api.ts),
which is the only client that uses cookies at all.

---

## 2. The triage — [docs/DEBT-TRIAGE.md](docs/DEBT-TRIAGE.md), 510 lines

Spec: *everything open in `docs/AUDIT.md` not covered by workstreams 1–7, and everything
`docs/HALF-BUILT-MECHANISMS.md` turned up, triaged into fixed-here, queued, or
not-worth-doing-with-a-reason.*

### Read this part first: the triage shipped wrong once, and the correction is the substance

Commit `05a68ee` pushed this document with **60 rows** and a pasted
`MISSING: []  EXTRA: []  VERDICT: PASS`. That check was green over an incomplete
population. **Eighteen open findings had no row:**
`H2 H3 L1 L3 L4 L5 L45 L50 L51 L85 L86 L103 M1 M2 M3 M4 M5 M6`.

The cause was one assumption in the derivation, which the document had even
flagged as *"the one judgement call"*: the population was built from each
finding's bold status label, and **no label was treated as outside the
population**. Two ways that was false:

- **Whole classes carry no label at all.** `M1`–`M7` (the Stage 0 AI audit) have
  a `**Fix:**` and no disposition. So do `H2`, `H3` and `L1`–`L5` from the
  earliest audit. 46 of the 121 findings carry no status signal; the old
  derivation added five of them back by hand.
- **Three labels open with the word "Fixed" and have an open clause in the same
  sentence** — `L45`, `L50`, `L51`. A label-prefix read scores those closed.
  That is `L25`, this document's own finding about dispositions that reassure,
  happening inside the document that records it.

It surfaced sideways, from workstream 9. The portal dashboard counts its metric
cards client-side from `/projects/bootstrap`, whose three list calls take
`limit = 200`. The audit entry for that mechanism is **L98**, verdict "Not
fixed" — and L98 had no row here. L98 proved legitimately outside the population
(workstream 4 pushed the range into the `WHERE` clause), but the question it
forced had an answer, and the answer was eighteen.

**All eighteen are now rowed with measured evidence**, the bucket headings are
corrected, and the correction is written **into the document** rather than
silently patched — §6 carries both failed runs.

### The check is now a committed script, not a heredoc

[`Projects/scripts/assert-triage-covers-open-findings.py`](Projects/scripts/assert-triage-covers-open-findings.py)
(286 lines) replaces the ad-hoc heredoc that produced the wrong population. It is
re-runnable, so the next session cannot re-derive a population in prose. It fails
on three conditions, not one:

1. an open finding with no row (`MISSING`);
2. **a finding with no status signal and no row** (`unknown_unrowed`) — the door
   the eighteen walked through;
3. a `— N` bucket heading that disagrees with its counted rows.

Two fixes to the script itself are worth naming, because both were load-bearing:

- The ID regex was `[CHLF]`, which **silently dropped the entire `M` class** —
  it reported 121 findings as 114. A population regex that drops a severity class
  is the same defect as a hand-written count.
- The row counter matched any backticked ID *anywhere* in the file, so an ID
  merely **named in a paragraph** satisfied the coverage check. It now reads only
  the first cell of lines starting with `|`.

**One row per mechanism, not per finding ID.** A finding with two separable halves gets
one row, in the bucket of its *unfinished* half, with the finished half stated on that
row. Otherwise the arithmetic rewards splitting: C1, L11, L13, L31, L32, L37, L46, L49,
L60/F1 and L100 each have a closed half and an open one, and counting each twice would
let a bucket total grow without a single thing being decided.

Buckets, measured: **9 fixed here, 53 queued (15 owner-blocked, 14 precondition,
24 unreached), 16 not worth doing** — 78 rows, 80 distinct IDs, no ID in two rows.
`QUEUED-OWNER` is a labelled sub-kind of queued rather than a fourth bucket — a queue
that mixes "I will do this next" with "I cannot do this" is how the cost-out went
missing from three reports.

The passing run, verbatim:

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

`ADJUDICATED` holds the 20 findings that are outside the population **with the
measurement that puts them there**, not with an assurance — e.g. `M7` closed by
`d9235e8` (`routes/health.ts:45,74`), `L98` by workstream 4, `L84` because its own
first line reads "Not a defect". Both red-on-revert proofs are in §4.9 below.

### ⚠️ `H2` is HIGH, is data loss, and is not fixed here

`apps/mobile/lib/offline-queue.ts:3` declares `QueuedOpType` as
`"addEntry" | "updateEntry" | "deleteEntry" | "addSite" | "deleteSite"` — **no diary
op of any kind.** So a diary saved offline is rolled back and lost. That is data
loss, not a UX gap, and it was invisible for this entire run because its audit
section carries no status label.

I triaged it rather than fixed it, and that is a judgement call I am flagging
rather than burying: workstream 8's spec is to *triage* into fixed-here / queued /
not-worth, and H2 is the offline queue's ordering problem (`L38`) appearing in a
second place — fixing it properly is the offline-queue work, not a debt-branch
patch. **It is the most serious thing in this document that is not already
someone's decision.** If any single row here gets promoted to its own branch, it
is this one.

Three other rows worth reading before anyone acts on the list:

- **F6** — `/auth/me` has no product caller **and must not be deleted**: it is the probe
  eight suites use to establish the app is up. Recorded so nobody deletes the probe to
  satisfy a rule about callers.
- **C1** — provenance on generated diaries is *the most valuable single item left in the
  audit*, and that is exactly why it is not being squeezed into a debt branch. Listed
  with a reason rather than queued, so it is not read as an hour of work.
- **H5** — **I did not verify this.** `scripts/ci.sh` runs lint, typecheck and tests but
  not `next build`, so I cannot say whether the portal still builds. Recorded as almost
  certainly stale, needing one `pnpm -C Projects --filter sitesnap-supervisor-web run build`
  to confirm. That is the honest state rather than a claim.

The script is deliberately **not** wired into `Projects/scripts/ci.sh`. Doing so
would fail the build the moment a new audit finding lands without a triage row,
which is a new gate nobody asked for. **Your call whether to turn it on** — it is
one line in `ci.sh`.

---

## 3. The cost-out — [docs/COST-OUT-STORE-DIVERGENCE.md](docs/COST-OUT-STORE-DIVERGENCE.md), 222 lines

**Picked: option A. Built on this branch** (`ba48f07`), as `pnpm -C Projects --filter services-api run test:all-db`.

The load-bearing argument:

> **B makes the two stores agree by deleting the one that is wrong about things, and the
> one that is wrong about things is the one that ships.** Of the seven defects, three are
> defects in the SQL itself. B never executes SQL. It cannot see them, and no amount of
> thinning the fake changes that.

Scored against the seven defects that have hidden in this gap: **A catches 6 of 7
outright and the seventh (L90) only if something asserts it. B catches 4 of 7 — and
those four (L87, L88, L89a, L89b) are exactly the four `storage/recordScope.ts` has
already closed structurally**, with one frozen table driving both the in-memory
predicate and the SQL generator. So the comparison is not 6 against 4: of the three B
cannot reach — L65, L90, L102 — two are tenancy defects that reached production, and all
three are defects in SQL B structurally never runs.

B's idea is not wrong. It has already been spent where it pays, and what remains is the
part it cannot reach.

Costs, measured where measurable:

| | A | B |
|---|---|---|
| to build | 57 lines of `run-tests.sh` + 1 of `package.json`. **Done, an hour.** | 11 store modules, 97 `if (!useDatabase())` branches, **903 lines**; largest `projectsStore` 29/389 and `authStore` 27/253 |
| prerequisite | none — it reuses the same files against a different store | the 29 files that reset state via `*ForTests()` must be rewritten in step, because a test asserting a rule the fake no longer enforces does not fail, it **passes differently** |
| to keep | wall clock, and nothing to maintain — new suites are included automatically | a permanent, silent, hand-maintained obligation, which is the exact failure mode being priced |

**Two figures are labelled UNMEASURED rather than estimated:** what A costs to get green
(35 of 46 files have never executed a line of this project's SQL, and the first run is
expected to be red), and its CI wall clock. There is no Postgres, no Docker and no `psql`
in this environment, so the happy path has not run once. Anyone quoting a number for it
would be inventing one. For scale only: the in-memory run is **12.1s for 46 files in
parallel**, which says nothing useful about the sequential Postgres case.

**A's limit, stated in its own section:** A catches divergence, not absence. L90 is the
example — nothing asserted that a crew member cannot read a colleague's pay, so no store
could have failed the assertion. L90 was found by reading, and that is the only way it
could have been found.

### `test:all-db` is deliberately NOT wired into `scripts/ci.sh` — flagged

Its first run is expected to be red, and gating every open pull request on failures that
have nothing to do with any of them is not something to do unannounced. The reason is in
a comment in the script so a future session does not read the absence as an oversight.
§6 of the document is the four-step sequence to turn it on; it needs the owner only at
step 1, **a throwaway Postgres — not Neon-with-data, not staging**, because it runs the
migrations and the suites delete rows wholesale.

The mode refuses to pass vacuously in both directions: it fails without
`TEST_DATABASE_URL` (so it cannot quietly measure the in-memory store it exists to
displace), and its expected-skip count is **derived** from the two existing counters
(`EXPECTED_REDIS_TESTS + EXPECTED_LIVE_OPENAI_TESTS`) rather than written as a third
number.

---

## 4. Red-on-revert, with the failing output

Seven proofs. Each: revert the line, run, paste the failure, restore, confirm the others
stayed green. The "others stayed green" column is what proves the new test is the only
thing defending the behaviour.

### 4.1 The void gate (L91/F9) — API, 3 of 233

Reverted `requireAtLeast("manager")` at `inspections.ts:250`:

```
not ok 173 - crew are refused at the gate, a manager gets past it, and crew keep the rest of the router
  error: |-
    crew were allowed to void a signature: {"error":"Signature not found."}
    404 !== 403
not ok 174 - the gate is a rank, so viewer is refused as well and owner passes as well
not ok 175 - the gate runs before the payload check, so a crew member learns nothing from a malformed body

# tests 233   # pass 212   # fail 3   # skipped 18
```

Restored: `# tests 233  # pass 215  # fail 0  # skipped 18`. **212 passed either way; the
18 skips did not move.**

Note the shape of the failure: crew got **404, not 200**. Without the gate the request
reached the store and was refused only because that fixture's signature id did not
resolve — which is precisely why the test asserts `403` rather than "not 200". A refusal
that happens by accident is not a refusal.

### 4.2 The void gate — mobile, 2 of 114

Reverted `canVoidSignature` in `lib/permissions.ts`:

```
not ok 30 - crew are the only operational role refused nothing else — every predicate here is an exception
not ok 32 - voiding a signature is manager+, and signing one is not
  error: |-
    Expected values to be strictly equal:
    true !== false

# tests 114   # pass 112   # fail 2   # skipped 0
```

Restored: `# tests 114  # pass 114  # fail 0`.

### 4.3 L18, login's account-existence oracle — 1 of 233

Reverted the 401 in `routes/auth.ts`:

```
not ok 74 - an unknown account and a wrong password are answered identically, and a right one still works
  error: |-
    an unknown account did not answer 401: {"error":"Account not found. Please sign up first."}
    404 !== 401
```

```
# tests 233   # pass 214   # fail 1   # skipped 18
```

Restored: `215 pass / 0 fail`. The test carries its positive control in the same test —
*"and a right one still works"* — because asserting only that two wrong answers match is
satisfied perfectly by a login route that refuses everybody.

### 4.4–4.7 The four L104 cookie-transport routes — one failure each

`revert-l104.sh` reverts one `setSessionCookie` call at a time, runs the suite, restores,
and asserts `git diff` is empty afterwards:

```
## REVERTED: login  (routes/auth.ts:537)
not ok 142 - login sends a session cookie that authenticates on its own, and a forged one does not
not ok 139 - a password change replaces the portal's cookie, and the cookie that made the change stops working
not ok 144 - revoke-all signs the portal's other tabs out and replaces the acting cookie
not ok 145 - accepting an invitation refreshes a cookie caller's credential and leaves a bearer caller's alone
  error: 'login sent no sitesnap.session cookie, so a portal caller never receives the credential it minted — set-cookie was []'
# tests 227  # pass 205  # fail 4  # skipped 18

## REVERTED: refresh  (routes/auth.ts:799)
not ok 143 - refresh renews the portal's cookie, which is the portal's only recovery from an expired session
# tests 227  # pass 208  # fail 1  # skipped 18

## REVERTED: revokeall  (routes/auth.ts:942)
not ok 144 - revoke-all signs the portal's other tabs out and replaces the acting cookie
# tests 227  # pass 208  # fail 1  # skipped 18

## REVERTED: accept  (routes/projects.ts:609)
not ok 145 - accepting an invitation refreshes a cookie caller's credential and leaves a bearer caller's alone
# tests 227  # pass 208  # fail 1  # skipped 18

=== git diff after restore (must be empty) ===
DONE
```

Reverting **login** fails four tests, not one, because three later tests depend on a
cookie login actually issues. That is a dependency the suite had and nothing reported.

**The transport assertion has its own revert**, because the negative half of
`invites/accept` (a *bearer* caller must get no cookie) needs its own control:

```
## REVERTED: the authTransport check at projects.ts:608
not ok 145 - accepting an invitation refreshes a cookie caller's credential and leaves a bearer caller's alone
  error: 'accept set a session cookie for a bearer caller, leaving the device holding two credentials: ["sitesnap.session=<JWT ELIDED>; Max-Age=2592000; Path=/; Expires=…; HttpOnly; SameSite=Lax"]'
# tests 227  # pass 208  # fail 1  # skipped 18
```

*(The failure output contains a test-mode JWT. It is elided here and must stay elided in
any copy of this text — the same rule as the production session cookie that appeared in
an earlier Playwright log.)*

### 4.8 The two counters that defend themselves

The SQL schema audit (`979a0f5`), reverted by restoring the `deleted_at` predicate that
started this:

```
not ok 201 - every resolvable SQL reference in the API names a declared column
  error: |-
    SQL references a column the migrations do not declare
    + [ 'storage/projectsStore.ts:1727 project_sites.deleted_at' ]
    - []
# tests 223  # pass 204  # fail 1  # skipped 18
```

That is **L99's exact mechanism reproduced on demand** — a `deleted_at` literal on a
table with no such column, which meant site progress had never once worked in
production. Restored: `205 pass / 0 fail`. 23 tables, 255 columns, 122 DML statements,
603 resolved references, 2 declined and both inspected. It needs no database, so it
gates every PR today.

The disposable-domain denylist, truncated to one entry:

```
not ok 211 - the denylist still holds every entry it was built with, not just the one other tests probe
  error: |-
    the disposable-domain denylist has 1 entries, expected 144. If this is a deliberate
    edit to the list, re-measure and update EXPECTED_DOMAIN_COUNT in the same commit. If
    it is not, the denylist has lost entries and signup is accepting throwaway addresses
    it used to refuse.
    1 !== 144
# tests 230  # pass 211  # fail 1  # skipped 18
```

---

### 4.9 The triage-coverage check — both doors reverted separately

The check has two independent ways to catch a missing row, so both were reverted
on their own. Full text of both proofs is in §6 of the document; the failing
output, abridged to the verdict lines:

**Proof 1 — a finding with no status label** (`H2`'s row deleted). The shape of
all eighteen:

```
VERDICT: FAIL -- 1 finding(s) with no status signal and no row; a bucket heading disagrees with its row count
exit=1
```

That revert **passed against the first version of the script**: `MISSING` came
back `(none)`, because `H2` carries no label and so never entered the population
at all — only the bucket arithmetic caught it, and only because I had not also
corrected the heading. That is the hole reproduced on demand, and it is why
`unknown_unrowed` is now a hard failure in its own right rather than an
informational list.

**Proof 2 — a labelled, half-open finding, with the bucket heading corrected so
the arithmetic check stays green and only the ID diff can catch it** (`L51`):

```
bucket headings:     all match their row counts
MISSING (open, uncovered, no row):
  L51
VERDICT: FAIL -- 1 open finding(s) unrowed
exit=1
```

The green `bucket headings` line is the "others stayed green" half: the
arithmetic check is demonstrably not what caught this one. Both lines restored,
check back to `VERDICT: PASS` at exit 0.

**Proof 3 — no revert needed.** The committed script run against this document
*as it actually shipped* at `05a68ee`:

```
IDs in a table row:  62

NO SIGNAL AND NO ROW (15) -- each needs a row, a workstream, or an ADJUDICATED entry with its measurement:
  H2 H3 L1 L103 L3 L4 L5 L85 L86 M1 M2 M3 M4 M5 M6

MISSING (open, uncovered, no row):
  L45 L50 L51

VERDICT: FAIL -- 15 finding(s) with no status signal and no row; 3 open finding(s) unrowed
exit=1
```

15 + 3 = **the eighteen**, split exactly along the two causes. Nothing was
reverted to produce that: it is the state that was pushed, failing the check that
should have been there. This is the proof that matters; proofs 1 and 2 exist only
to isolate each door separately.

Gate on the branch tip: `typecheck` 0, `lint --max-warnings=0` 0, API 215 passed
/ 18 expected skips, mobile 114 passed / 0 skipped.

## 5. Pinned counters changed — all measured, none hand-written

| counter | file | from | to | why |
|---|---|---|---|---|
| `EXPECTED_WORKFLOWS` | `scripts/assert-workflow-runners-pinned.sh:40` | 3 | **2** | `deploy-api.yml` deleted (F3) |
| `EXPECTED_PINNED` | same, `:84` | 4 | **3** | same deletion; `build-mobile.yml` has 2 `runs-on:`, `ci.yml` 1 |
| `EXPECTED_REFUSALS` | `routes/crew-permissions-db.test.ts:135` | 15 | **16** | the void route joined the refusal population |
| `EXPECTED_TESTS` (mobile) | `apps/mobile/scripts/run-tests.sh:37` | 113 | **114** | `canVoidSignature` test |

**Did not move:** `EXPECTED_DB_SUITES=11`, `EXPECTED_REDIS_TESTS=4`,
`EXPECTED_LIVE_OPENAI_TESTS=3`, the derived **18** in-memory skips, and mobile's
`EXPECTED_TEST_FILES=15`.

`EXPECTED_PINNED`'s *comment* was also corrected in `43eb8c9`: it named the two files the
wrong way round. The number was right. **A wrong explanation on a right number is how the
number survives the day its population changes.**

The mobile pin records how it was obtained, which is the rule:

```sh
# 114, not 113: lib/permissions.test.ts gained the canVoidSignature test
# (AUDIT L91). Measured, not incremented -- the run that set this number
# reported `# tests 114` with the pin still at 113 and failed on it.
EXPECTED_TESTS=114
```

---

## 6. ⚠️ MERGE-ORDER WARNINGS — read before merging anything

Found by `git merge-tree`, not by review. Reading my own diffs would not have shown
either, and one of them produces **no git conflict at all**.

### 6.1 F3 collides SILENTLY with workstream 0, and the silent result is wrong

Workstream 0's `54c1321` **renamed** `deploy-api.yml` → `api-post-merge-checks.yml` and
rewrote it. This branch's `b4b43ae` **deleted** it. Both sides delete the old path, so git
reports no conflict — the merge succeeds, workstream 0's file survives, and this branch's
`EXPECTED_WORKFLOWS=2` then reads against four workflow files and **fails CI**.

Worse than the counter: workstream 0's rewritten workflow **keeps the bug F3 was about**.

```
$ git show origin/fix/workstream-0-safety:.github/workflows/api-post-merge-checks.yml \
    | grep -nE '^[[:space:]]*run:.*pnpm'
73:        run: pnpm --filter ./shared run build:types
76:        run: pnpm --filter ./services/api run typecheck
79:        run: pnpm --filter ./services/api run test
```

Those are **path** filters. pnpm reads a bare relative path as a name pattern, matches no
projects, and **exits 0** — the workflow reports green having run nothing, which is the
entire finding. I was about to hand F3 to workstream 0 as I did F4; this measurement
reversed that.

**Check 5**, added to `assert-ci-single-definition.sh` in `b4b43ae`, fails on exactly
this file. The class-level guard doing its job against a branch written three workstreams
earlier is the best evidence I have that the guard was worth adding.

**Recommendation — a recommendation, because merging is yours:** take this branch's
deletion, drop workstream 0's rename. If a post-merge check is wanted it should call
`./scripts/ci.sh` like `ci.yml` does — at which point it is a second definition of the
gate and check 5 refuses it, which is the argument for not having it.

### 6.2 Workstream 0 fails its own pin today, independent of this branch

```
$ git ls-tree --name-only origin/fix/workstream-0-safety .github/workflows/ | wc -l
4
$ git show origin/fix/workstream-0-safety:Projects/scripts/assert-workflow-runners-pinned.sh \
    | grep EXPECTED_WORKFLOWS=
EXPECTED_WORKFLOWS=3
```

`assert-workflow-runners-pinned.sh` counts the directory with `find -maxdepth 1` *before*
asserting anything — the vacuity guard — so four files against a pin of three is a hard
CI failure on that branch as it stands. **It needs one line changed on workstream 0
before it merges.** I have not touched it: editing another pushed branch from this one is
not mine to do.

### 6.3 F4 was fixed twice. Resolved, by giving it back

`app/settings/page.tsx` was fixed on both branches with different wording. Workstream 0's
is better — it additionally ties the copy to ADR-0005 via `SIGN_OUT_SCOPE_NOTICE` on the
sign-out path. `1b37f89` on this branch restores that file to its `origin/main` content
byte-exact, so the conflict is gone and **F4 ships once, from workstream 0**.

### 6.4 The other two overlaps are benign

`routes/auth.ts` (workstream 0's sign-out work, this branch's L18 login fix — different
handlers) and `sessions-and-tokens{,-db}.test.ts` (workstream 0's logout tests against
this branch's `applyMigrations` hoist and cookie-transport tests). Both resolve by taking
both sides.

---

## 7. Two corrections to the project record

**`ee7e093` is not workstream 0.** It is `Merge pull request #64 from
zackdancey-art/feat/sessions-and-tokens`. An earlier session's summary recorded workstream
0 as merged; it is not:

```
$ git merge-base --is-ancestor origin/fix/workstream-0-safety origin/main; echo $?
1
```

**Workstream 0 is pushed and unmerged**, 7 commits. Everything in §6 follows from that.

**`docs/ARCHITECTURE.md` carries two measurably false claims** (§5 of the triage). `F12`'s
and `F3`'s commits corrected the `build.js` and workflow rows; these two remain, and that
file is the orchestrator's to edit:

- line 19 says "18 ordered `.sql` migrations (001→018)". There are **31**, ending
  `031_normalise_invite_emails.sql`.
- line 22 says "There is **no CLAUDE.md** in the repo". `wc -c CLAUDE.md` → **26088**. A
  file every agent is instructed to read in full, described as absent.

---

## 8. Flagged decisions, made without asking

- **`test:all-db` built but not wired into `ci.sh`.** §3 above. The four-step sequence to
  turn it on is in the document; step 1 needs a throwaway database and is yours.
- **F3 kept as a deletion rather than handed to workstream 0.** §6.1. Decided on the
  measurement, against my first instinct.
- **Two DB-gated additions have never run.** `crew-permissions-db.test.ts`'s sixteenth
  refusal and the `sessions-and-tokens-db` migration hoist execute for the first time in
  CI. There is no Postgres here. New tests touching permissions default to DB-gated per
  the standing rule, and the cost-out did not overturn it.
- **In-memory placement departures.** `void-signature-gate.test.ts` and
  `disposableDomains.test.ts` are in-memory, not DB-gated. Both are pure logic with no
  store involved — a rank comparison in middleware, and the length of a frozen array. The
  *data* half of the void gate is already covered DB-gated via `EXPECTED_REFUSALS`.
- **L18 has a real product cost.** A genuinely new person who mistypes nothing and simply
  has no account is no longer told to sign up; they get "invalid credentials" like
  everybody else. That is the point of the finding — the old message was an
  account-existence oracle for an anonymous caller — but it is a deliberate worsening of
  one honest case, not a free win.
- **`docs/ARCHITECTURE.md` edited** (4 lines, F12 and F3 rows). CLAUDE.md §8 bars
  *subagents* from editing it and permits the orchestrator; flagging it because the two
  remaining false claims in §7 are left for you rather than fixed here.

---

## 9. Deploys

| deploy | needed | contents |
|---|---|---|
| **API** | yes | L18 login 401, the void-route gate, the dead-gate deletions (F7), the SQL schema audit, the all-db mode |
| **portal** | yes | `app/locations/page.tsx` and `lib/useRole.ts` (F1/F4 strings — see below), nothing behavioural |
| **`eas update`** | yes | the mobile void gate and the shadow-provider deletion. **JS-only** |
| **native build** | **no** | no `app.config.ts`, no `eas.json`, no native module, no `ios/` or `android/` in any commit |

**Is the split safe?** Yes, and API-first is the safe order.

- **API alone is safe.** The void gate refuses crew server-side; an un-updated mobile
  client draws the button and gets a 403, which `describeFailure` already reports
  correctly — that handling is in this branch's mobile commit but the *old* client's
  generic "Failed to void signature." is also acceptable, not a crash. The L18 change
  makes a login error message less specific; no client parses that string (both callers
  read `status` and `error.error`).
- **Portal alone is safe** — two strings.
- **`eas update` alone is safe but pointless**: it only hides a control the API would
  refuse anyway.

**No "only safe if all three ship together" case on this branch.**

---

## 10. Skipped tests

**None added.** The in-memory run reports exactly 18 skips, unchanged, all three counters
untouched: 11 DB-gated suites + 4 Redis + 3 live-OpenAI, each of which runs for real under
`test:db` / `test:redis` / `test:openai`.

---

## 11. Verification run on the branch tip

```
pnpm -C Projects run typecheck                      → exit 0
pnpm -C Projects run lint --max-warnings=0          → exit 0
pnpm -C Projects --filter services-api run test     → 233 tests / 215 pass / 0 fail / 18 skip
pnpm -C Projects --filter apps-mobile run test      → 114 tests / 114 pass / 0 fail / 0 skip
```

The DB-gated suite **cannot run in this environment** — no Postgres, no Docker, no `psql`.
`test:db` and the eleven gated suites first execute in CI, which is also where the two new
DB-gated assertions first run.

---

## 12. What this branch does not contain

Workstream 8's third bullet is complete (the four L104 routes). Still open and queued
rather than built, each with a row and a reason in the triage: C1's provenance half, the
`script-src` nonce migration, L49's remaining 16 hydration call sites, L50's four dead
Display controls, L51's tap-target sizing, L46's server half.

**Do not merge. Do not deploy anything.**

🤖 Generated with [Claude Code](https://claude.com/claude-code)
