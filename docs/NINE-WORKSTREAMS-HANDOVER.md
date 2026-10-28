# Nine workstreams — handover

Written for the repo owner, to be read before merging anything. Generated at the
end of an unattended run against `origin/main` = `ee7e093`.

Everything below was measured at the time of writing with the command named
beside it. Where I could not measure something, it says so instead of implying a
result.

**Local `main` is stale** — `63b5fe3`, behind `origin/main` at `ee7e093`. Every
figure in this document is measured against `origin/main`, not against local
`main`, because the two disagree. Worth a `git checkout main && git pull` before
you start, or the compare views will mislead you.

---

## 1. The branch table

Eleven branches for ten workstreams. All eleven are **pushed with nothing
unpushed**, and all eleven are based **exactly on `origin/main`** — none is
stacked on another.

Measured with `git rev-list --count origin/main..<branch>`, `git rev-list
--count origin/<branch>..<branch>` for the unpushed figure, and `git merge-base
origin/main <branch>` for the base.

| WS | branch | pushed | commits | needs deployed |
|---|---|---|---|---|
| 0 | `fix/workstream-0-safety` | yes, 0 unpushed | 7 | API, portal, `eas update` |
| 1 | `feat/clients-sites-entries` | yes, 0 unpushed | 16 | API (+ migration 032), portal, `eas update` |
| 2a | `feat/timesheets-approval` | yes, 0 unpushed | 9 | API (+ migration 033), portal, `eas update` |
| 2b | `feat/whs-checklists` | yes, 0 unpushed | 3 | API, `eas update` |
| 3 | `feat/storage-ceiling` | yes, 0 unpushed | 3 | API, `eas update` |
| 4 | `feat/report-periods` | yes, 0 unpushed | 5 | API, portal, `eas update` |
| 5 | `feat/photo-viewer` | yes, 0 unpushed | 5 | portal, `eas update` (no API change at all) |
| 6 | `feat/bin-retention` | yes, 0 unpushed | 6 | API (+ migration 034), `eas update` |
| 7 | `feat/consent-and-native` | yes, 0 unpushed | 4 | API (+ migration 035), portal, `eas update`, **and a native build — yours to run** |
| 8 | `feat/debt-and-cost-out` | yes, 0 unpushed | 17 | API, portal, `eas update` |
| 9 | `feat/branding-and-dashboard-parity` | yes, 0 unpushed | 5 | API, portal, `eas update` |

**A twelfth branch holds this document.** `docs/nine-workstreams-handover`,
based on `origin/main` — this file plus `docs/pr-bodies/` (workstreams 5 to 9),
no code, no deploy. It is separate because the
instruction was one branch per workstream and this is not a workstream; keeping
it off `feat/branding-and-dashboard-parity` keeps that PR to its own concerns.
Merge it, or don't — nothing depends on it.

The deploy column is **derived from the changed paths**, not from memory:
`git diff --name-only origin/main...<branch>` counted against
`Projects/services/api/`, `Projects/apps/supervisor-web/`,
`Projects/apps/mobile/` and the native-config set. It is therefore conservative —
it says a surface *changed*, not that the change is user-visible there.

### Workstream 2 shipped as two branches, which deviates from your instruction

You asked for **one branch and one PR per workstream.** Workstream 2 is two:
`feat/timesheets-approval` (9) and `feat/whs-checklists` (3). They are
independent — different routes, different tables, no shared files — and splitting
them meant each could be pushed as it finished rather than held. It is still a
deviation from an explicit instruction, so you are deciding about two PRs there,
not one. Nothing else in the nine is split.

### Four migrations, 032–035, one per branch

| migration | branch | what it touches |
|---|---|---|
| `032_clients.sql` | WS 1 | `CREATE TABLE clients`; `ALTER TABLE project_sites` adding `client_id` |
| `033_timecard_approval.sql` | WS 2a | four `ALTER TABLE crew_timecards` column adds, one index |
| `034_project_sites_soft_delete.sql` | WS 6 | `ALTER TABLE project_sites` adding `deleted_at`, one index |
| `035_signup_consent.sql` | WS 7 | three `ALTER TABLE auth_pending_registrations`; `CREATE TABLE user_consents` |

**The numbers do not collide and the order between them does not matter.**
`migrate.ts` applies every `.sql` file not already in `schema_migrations`, in
sorted filename order, skipping applied ones (`migrate.ts:32-41`) — so merging
034 before 033 simply applies 033 at the following boot. I checked they are
order-independent rather than assuming it: 032 and 034 both alter
`project_sites`, but **different columns** (`client_id` vs `deleted_at`), and
each add is guarded. Nothing here drops or rewrites a row.

---

## 2. The merge order

**Three groups. Inside a group, any order. Between groups, follow the order.**

### Group A — merge first, on its own

1. **`fix/workstream-0-safety`**

It is the safety workstream and it is the one branch with a known conflict
against another (see below). Merging it first makes that conflict visible once,
in one place, rather than in whichever branch happens to go second.

**It needed a one-line fix before it merges, and that fix is now ON the branch.**
Commit `5a99eb3` raises `EXPECTED_WORKFLOWS` from 3 to 4. Measured first, read
from the branch rather than from memory:

```
git ls-tree -r --name-only fix/workstream-0-safety -- .github/workflows
  -> api-post-merge-checks.yml
     build-mobile.yml
     ci.yml
     submit-mobile.yml               (4 files)
```

All four pin a dated runner (`api-post-merge-checks.yml:39`,
`submit-mobile.yml:35`, `ci.yml:19`, `build-mobile.yml:46`), all `ubuntu-24.04`,
so `EXPECTED_PINNED` stays at 4 and is deliberately left untouched — see §6.

Red-on-revert, run on the branch. With the pin at 3 the script exits 1:

```
assert-workflow-runners-pinned: found 4 workflows, expected 3:
    ../.github/workflows/api-post-merge-checks.yml
    ../.github/workflows/build-mobile.yml
    ../.github/workflows/ci.yml
    ../.github/workflows/submit-mobile.yml
```

and with the fix it exits 0:

```
assert-workflow-runners-pinned: 4 workflows, 4 pinned runners, no retired action majors
```

**This is the one pin in the batch that is red TODAY, before any merge.** It was
red on the branch from the moment workstream 0 added `submit-mobile.yml`, and
that branch's own CI should have caught it.

### Group B — ORDER NOW FIXED, and this is a change from the first draft

2. `feat/clients-sites-entries` (WS 1)
3. `feat/timesheets-approval` (WS 2a)
4. `feat/whs-checklists` (WS 2b)
5. `feat/storage-ceiling` (WS 3)
6. `feat/report-periods` (WS 4)
7. `feat/photo-viewer` (WS 5)
8. `feat/bin-retention` (WS 6)
9. `feat/consent-and-native` (WS 7)

This section used to say "any order". **It no longer is**, and the reason is the
pinned-count back-port rather than anything about the code.

Each of these PRs now carries the pinned count that is correct *for its own
position in this list* — `EXPECTED_DB_SUITES` and the two mobile pins are
equality checks on a shared line, and the value that is right at position 4 is
wrong at position 6. Swap two of these PRs and both of them fail `validate`
after their update cycle, on a number, for no reason connected to their change.
The per-position values are in §6.

Their code is still independent — none of the eight depends on another to be
correct, their migrations are order-independent, and nothing here is a code
dependency. It is only the numbers. But the numbers are a required check.

### Group C — merge last, in this order

10. **`feat/branding-and-dashboard-parity`** (WS 9)
11. **`feat/debt-and-cost-out`** (WS 8)

**This is the reverse of the first draft**, which had WS 8 at 10 and WS 9 at 11
on the grounds that WS 8 is the larger rebase. Two later findings overrule that:

- **The client-compatibility audit.** WS 8 is the only one of the eleven that is
  not safe to have on the API while the old mobile bundle and old portal are
  still live: its void-signature field gate changes what an already-shipped
  client is permitted to send. Everything else in the batch is additive from a
  client's point of view. So WS 8 merges last and takes its own `eas update`
  before the rest of the batch is published.
- **Two pins reach their final value in Group C**, and they reach it in this
  order. `EXPECTED_TEST_FILES` becomes 26 on WS 9 (position 10) — WS 9 adds the
  last two mobile test files. `EXPECTED_TESTS` becomes 207 on WS 8 (position 11)
  — WS 8 adds the 207th test and no file. Reversing them makes both wrong.

WS 9 still touches the most screens on both clients, so expect its update cycle
to be the one with real textual conflicts; see §7 for the three it already had
against WS 1.

### F3, the one conflict that was a decision — now decided, and pre-resolved

**`feat/debt-and-cost-out` deletes a workflow that `fix/workstream-0-safety`
renames.** Your ruling: **keep workstream 0's renamed workflow, drop workstream
8's deletion of it.** That is recorded here because the mechanics are not
obvious.

Git sees this as **rename/delete**. The merge base has
`.github/workflows/deploy-api.yml`; WS 0 renames it to
`api-post-merge-checks.yml`; WS 8 deletes it. Whichever merges second, git
stops and says so. With WS 8 at position 11 the conflict appears exactly once,
in WS 8's update cycle, and the resolution is one command — keep the renamed
file, accept that the old path is gone:

```
git checkout --ours  .github/workflows/api-post-merge-checks.yml   # keep WS0's
git rm --cached      .github/workflows/deploy-api.yml 2>/dev/null  # already gone
```

**I deliberately did not pre-resolve this one on the branch,** and that is a
reversal of what I was going to do. Reverting WS 8's deletion would have made
the merge clean, but it would also have put the vacuous workflow back on WS 8's
own tree — where WS 8's own new guard, `assert-ci-single-definition.sh` check 5,
correctly refuses it. Measured, not reasoned; with the file restored:

```
FAIL: deploy-api.yml runs pnpm gate steps of its own:
    51:        run: pnpm --filter ./shared run build:types
    54:        run: pnpm --filter ./services/api run typecheck
    57:        run: pnpm --filter ./services/api run test
```

And the union's resolution does not cover that red, because the exemption that
makes the union green is keyed to the *renamed* filename. So the branch stays as
it is: green on its own guards, with one pre-decided conflict in cycle 11.

**The pins are a separate matter and they ARE pre-resolved.** WS 8 lowered
`EXPECTED_WORKFLOWS` to 2 and `EXPECTED_PINNED` to 3, both correct for a tree
with two workflow files. Those two lines are left alone — see §6 row 7 and 8 for
why they are the one place in this batch where the *incoming* value wins.

---

## 3. What you have to do yourself

In order. Each step is a thing to do, not a checklist to look up.

1. **Pull `main`.** Local `main` is 1 merge behind `origin/main`; the compare
   links in the PR bodies are all against `origin/main`.

2. **Decide the F3 conflict** (section 2). Read the F3 paragraph in
   `feat/debt-and-cost-out`'s PR body and the rename paragraph in
   `fix/workstream-0-safety`'s, then pick deletion or rename. Nothing else in
   either branch depends on the answer.

3. **Fix `EXPECTED_WORKFLOWS` on `fix/workstream-0-safety`** — raise `3` to `4`
   at `Projects/scripts/assert-workflow-runners-pinned.sh:40`, after checking
   that `api-post-merge-checks.yml` and `submit-mobile.yml` pin their runners
   rather than floating them. Evidence in section 2. Do it before opening its PR
   or CI will go red on it.

4. **Open the eleven PRs in the browser.** `gh` is not installed and I did not
   install it. The bodies for **workstreams 5 to 9 are in `docs/pr-bodies/` on
   this branch**, each with its compare URL at the top — they were written to a
   session-scoped temporary directory that does not survive the session, so they
   are committed here instead. That is a decision you did not ask for; the
   commit message explains it and deleting the directory is one commit.
   **Workstreams 0 to 4's bodies are only in the earlier session output** — I
   did not keep copies of those.

5. **Merge in the group order in section 2,** letting CI go green on each PR
   before the next. **Green CI is the only evidence that any DB-gated test in
   these branches passes** — see section 5.

6. **After the API has auto-deployed from `main`, check
   `GET /api/health/ready`.** It returns `{ migrations: { applied, expected } }`
   and 503s while `applied < expected`. With all eleven merged, `applied` should
   have advanced by four (032–035). If it 503s, the API is up but a migration
   has not applied — read the boot log before doing anything else.

7. **Deploy the portal once,** after all eleven are merged, rather than per
   workstream. You said you are not running the publish-and-verify cycle once
   per workstream.

8. **Publish one `eas update`,** after the portal.

9. **Then the device pass. Sign in as an owner on a device** and open the
   supervisor dashboard. Confirm four cards — Active Sites, Total Entries,
   Approved Diaries, Pending Review — and that the figures are not 200 when you
   have more than 200 of something. If a card shows an em dash and the line
   "The server sent totals this app version cannot read", the `eas update` went
   out ahead of the API deploy; deploy the API and reopen.

10. **Sign in as a crew member on a device.** Confirm the supervisor dashboard
    is not reachable at all — no tab, no card, no link to it. Then confirm you
    can still open a site, add an entry and see your own timesheet, so the
    hiding has not taken anything else with it.

11. **Sign in as a crew member in the portal browser.** Confirm the Dashboard
    link is absent from the sidebar, and that typing `/dashboard` in the address
    bar shows a refusal card and leaves the sidebar rendered — a wrong turn, not
    a dead end, and **you are not signed out.**

12. **Sign in as a viewer in the portal browser** (this is the behaviour that
    changed for them). Confirm you land on `/sites` rather than `/dashboard`,
    that the Dashboard link is gone from the sidebar, and that everything else a
    viewer could reach still works.

13. **Open a site you did not create, as a crew member, and try to edit an entry
    somebody else wrote.** Confirm you get a refusal and that **you are not
    signed out by it.** This is the one I most want measured on a device,
    because a refusal that signs the user out is the failure mode these
    workstreams were most able to introduce and least able to detect.

14. **Open a finished site on both surfaces side by side.** It must read
    **"Complete"** in accent orange on both. If one says "Completed" or renders
    grey, the shared status module did not reach that screen.

15. **Hold a site and check both surfaces again** — **"On Hold"** on both, not
    "ON-HOLD".

16. ~~**Tell me the Render instance count**~~ — **done: one instance.** Manual
    scaling 1, autoscaling off and behind a plan the service is not on. AUDIT
    L102's eviction half is now closed unconditionally rather than left
    conditional, the shared invalidation queued for Phase 7 is not needed, and
    the one residual is recorded: a zero-downtime deploy runs the draining and
    the new instance together for about a minute, so the cross-instance window
    exists during a deploy only. If the service ever moves to a plan with
    autoscaling, that is the condition that reopens it.

17. **Workstream 7's native work: run the `eas build` yourself.** That branch
    ends at "ready for `eas build`" by instruction. I made no native config
    change outside it, there is no `ios/` or `android/` folder in any commit,
    and I did not start a build. Settings → About must show the build under test
    before any result from it counts.

18. **Then the App Store steps**, which need your credentials and are yours
    end to end.

---

## 4. What I did not build, and why

- **The API routes behind the supervisor dashboard did not move to manager+.**
  `GET /projects/summary` is still `requireAtLeast("viewer")`. Your decision
  aligned the dashboard to manager+ on both surfaces; I implemented that as a
  screen decision and said so in every place it is implemented, because moving
  the route is a wider change — the rank table in `crew-permissions-db.test.ts`,
  two access tests and the load-test's route list — and it is a real refusal
  rather than a hidden control. **So today a viewer who calls that route
  directly still gets the numbers.** That is the honest description and it is in
  WS 9's PR body as an open question for you.

- **`GET /projects/reports/supervisor` was left in place although nothing calls
  it.** Found while checking callers for WS 9: `grep -rn "reports/supervisor"
  Projects/apps` returns comments only, and both clients build their report HTML
  locally. By your own last-six-inches rule it counts as not built, and it has
  assertions in three API test files, so the suite reads as though it were in
  service. Deleting a route is not reversible the way the rest of this work is,
  and it predates these workstreams, so it is a question rather than a change.

- **No structural check on the 80/50 approval-health thresholds.** Cosmetic
  drift does not meet the bar that justified the other checks — it does not
  stand between a user and a refusal, a sign-out or data loss.

- **No test runner for `apps/supervisor-web`.** It has none, and adding one
  means adding a dependency, which I was told not to do without being told to.
  The portal's share of WS 9 is defended by a structural check
  (`assert-dashboard-rank.mjs`) instead, which is weaker than a test and is
  described as such in its own header.

- **Nothing hit stop condition 2.** No migration on any branch drops or rewrites
  data, nothing deletes production rows, and no schema change is
  non-rollbackable. All four migrations are additive and guarded. I did not
  delete, backfill or clean up any record, and there is no backfill proposed.

- **Carried debt untouched, each with a triage row:** the `script-src` nonce
  migration (L4); L49's remaining 16 hydration call sites; C1's provenance half;
  L50's Display controls; L51's tap-target sizing; L46's server half; H2's
  offline diary-save data loss; L63's three pinned screens.

- **The `unhandledRejection` handler is unchanged, deliberately.** You are
  watching Sentry for a week before deciding whether it exits. That is recorded
  in the code so a future session does not tidy it.

---

## 5. What I could not verify without you

- **`test:db` has never run.** There is no Postgres, no Docker and no `psql` in
  this environment. Every DB-gated test added across these workstreams —
  including WS 9's two in `store-roundtrip.test.ts` — has **never been
  executed.** Green CI on each PR is the first and only evidence that they pass.
  The in-memory suite's 18 skips are all environment gates and each runs for
  real in CI.

- **Nothing was seen rendered, on either surface.** No simulator, no device, no
  browser, no Playwright. Every screen change across these branches is
  typechecked, linted and unit-tested where unit-testable, and **looked at by
  nobody.** Card layout, text wrapping, tap targets and both refusal cards are
  unverified in the only sense that matters.

- **No production check of any kind.** I ran nothing against the live API or the
  production database. Anything I say about the deployed system would be
  inference, so this document says nothing about it.

- ~~**The Render instance count** (L5)~~ — **answered: one.** Closed out in
  AUDIT L102 and in `docs/PHASE-2-REVIEW.md`, which had carried the
  "revocation is not instant across instances" caveat; that caveat now applies
  to a deploy's instance overlap and to nothing else.

- **`EXPO_TOKEN` is NOT set as a repository secret** (F11) — answered, and it
  changes the reading of the submit workflow rather than closing a question.
  The tag-triggered submit could never have fired: no token, no submission.
  Disarming it was still right, and this is why — a workflow that cannot
  authenticate fails at the point of submission, not at the point of being
  triggered, so the arming was a live trigger on a job that would have failed
  loudly on the first tag someone pushed. The branch that disarmed it does not
  depend on the secret's absence and does not need rewriting.

- **`main`'s ruleset, confirmed by the owner:** the check `validate` is
  required, and branches must be up to date before merging. This is why the
  pinned-count corrections are back-ported onto the individual feature branches
  rather than left on the rehearsal branch — each of the eleven PRs is updated
  onto the new `main` and re-runs CI before it can merge, so a correction that
  lives only on a throwaway branch would make every one of those ten
  update-and-wait cycles come back red.

- **Phase 2 deployed live on 18 October at 12:21pm**, per the owner. Recorded
  because the Phase 2 review's claims are about code, not about a deployment,
  and this is the date they became true of the running system.

- **Still awaiting you, unchanged:** L61–L64; L80; React 19 for
  `apps/supervisor-web` (L72 / ADR-0004);
  whether to remove the three `/entry-templates` routes (F2);
  whether consent records survive account deletion; whether server-side consent
  enforcement turns on once both clients ship; whether `all-db` turns on in
  `ci.sh`; whether the triage check turns on in `ci.sh`; whether
  `build-mobile.yml`'s pre-release typecheck consolidates into `ci.sh`; whether
  exported documents should track the design tokens; and whether "Complete" or
  "Completed" is the word for a finished site — I took "Complete", the word
  already shown to clients, and the structural check will not let one surface
  move without the other.

- **Client share links were not started.** You said not to until the legal
  review has happened, and you have not said it has.

---

## 6. Every pinned count, measured across the union

**Method.** Every number below was obtained by counting the thing on the merged
tree, never by adding up the branches. The two differ, and where they differ the
branch sum is the wrong answer — six branches each raised `EXPECTED_DB_SUITES`
from 11 to 12, so the naive reading of the merge is 12 and the truth is 20.

**Population.** 34 hand-pinned counts on the union, plus one derived. I am not
reconciling that against the audit's figure of 29: three of the files holding
these pins did not exist when that number was written
(`native-permission-audit.test.ts`, `supervisor-web/scripts/run-tests.sh`,
`sqlSchemaAudit.test.ts`), so the two counts are over different populations.

**One label to ignore.** My rehearsal commit `0d47628` calls this "eleven
numbers across six files". Count the rows below rather than the label: it is 13
changed pins (8 equalities, 5 floors) in six files, plus one single-branch change
that needs nothing done to it.

### 6a. The counts the union changes

`main` is `origin/main` = `ee7e093`. "Carried by" is the branch that now holds
the correction, with its commit.

| # | pin | file:line | main | value on each branch that changed it | **union (correct)** | carried by |
|---|---|---|---|---|---|---|
| 1 | `EXPECTED_DB_SUITES` | `services/api/scripts/run-tests.sh:68` | 11 | WS1 12 · WS2a 12 · WS2b 12 · WS4 14 · WS6 13 · WS7 12 | **20** | WS2a→13 `ab1cb99`, WS2b→14 `10f5a57`, WS4→17 `797dbb0`, WS6→19 `f254fe9`, **WS7→20 (final) `e376ee2`** |
| 2 | `EXPECTED_TEST_FILES` (mobile) | `apps/mobile/scripts/run-tests.sh:33` | 15 | WS1 16 · WS2b 16 · WS3 17 · WS4 16 · WS5 16 · WS6 16 · WS7 17 · WS9 17 | **26** | WS2b→17 `10f5a57`, WS3→19 `aba1451`, WS4→20 `797dbb0`, WS5→21 `8958345`, WS6→22 `f254fe9`, WS7→24 `e376ee2`, **WS9→26 (final) `515c89a`** |
| 3 | `EXPECTED_TESTS` (mobile) | `apps/mobile/scripts/run-tests.sh:34` | 113 | WS1 123 · WS2a 118 · WS2b 119 · WS3 137 · WS4 121 · WS5 126 · WS6 116 · WS7 128 · WS8 114 · WS9 122 | **207** | WS2a→128, WS2b→134, WS3→158, WS4→166, WS5→179, WS6→182, WS7→197, WS9→206, **WS8→207 (final) `8925414`** |
| 4 | `EXPECTED_ROUTES` | `apps/mobile/lib/screen-header-audit.test.ts:42` | 33 | WS1 34 · WS6 34 | **35** | WS6→35 `f254fe9` |
| 5 | `EXPECTED_SCREEN_HEADER` | `apps/mobile/lib/screen-header-audit.test.ts:43` | 11 | WS1 12 · WS6 12 | **13** | WS6→13 `f254fe9` |
| 6 | `EXPECTED_WORKFLOWS` | `Projects/scripts/assert-workflow-runners-pinned.sh:40` | 3 | WS0 left it at 3 against its own 4 files · WS8 2 | **4** | WS0→4 `5a99eb3` (**red today**) |
| 7 | `EXPECTED_PINNED` | `Projects/scripts/assert-workflow-runners-pinned.sh:84` | 4 | WS8 3 | **4** | nobody — main is already correct |
| 8 | `EXPECTED_UNRESOLVED` | `services/api/src/storage/sqlSchemaAudit.test.ts:104` | file absent | WS8 `{subquery:1, interpolated-table:1}` | **`{subquery:2, no-table:2, interpolated-table:26}`** | WS8 `8925414` |
| 9 | `EXPECTED_DML_STATEMENTS` (floor) | `…/sqlSchemaAudit.test.ts:73` | file absent | WS8 122 | **159** | WS8 `8925414` |
| 10 | `EXPECTED_RESOLVED_REFS` (floor) | `…/sqlSchemaAudit.test.ts:74` | file absent | WS8 603 | **618** | WS8 `8925414` |
| 11 | `EXPECTED_TABLES` (floor) | `…/sqlSchemaAudit.test.ts:75` | file absent | WS8 23 | **25** | WS8 `8925414` |
| 12 | `EXPECTED_COLUMNS` (floor) | `…/sqlSchemaAudit.test.ts:76` | file absent | WS8 255 | **281** | WS8 `8925414` |
| 13 | `predicates.length >= N` (floor) | `apps/mobile/lib/permissions.test.ts:148` | line absent | WS1 8 | **11** | **NO BRANCH CAN CARRY IT — see 6d** |
| — | `EXPECTED_REFUSALS` | `services/api/src/routes/crew-permissions-db.test.ts:136` | 15 | WS8 16 | **16** | already correct on WS8; one branch touched it, no conflict possible |
| — | `EXPECTED_SKIPS` | `services/api/scripts/run-tests.sh:310` | derived | — | **derived** | nobody. It is computed from `EXPECTED_DB_SUITES`, so it cannot go stale — the only pin in the repo with that property, and the reason the in-memory run fails on a *skip* count before it fails on a suite count |

### 6b. What the per-position values mean, and the conflict rule

Main requires `validate` and requires branches to be up to date, so each PR will
be updated onto the new main and re-run before it can merge. The value each
branch carries is the value its **updated** tree will measure, not the value its
branch measures today.

Two consequences, both deliberate:

- **Every corrected PR is red until the PRs ahead of it have merged and it has
  been updated.** That is inherent to an equality pin on a shared line. It is the
  signal the pin exists for, and the ruleset's update-and-wait cycle is what
  clears it. The alternative — a value correct on the branch and wrong on main —
  is the failure mode that produced `EXPECTED_WRITE_STEPS = 13` against a
  sequence of 14.
- **On each update cycle the changed pin lines conflict**, because both sides
  moved off the merge base. **The resolution is to keep the branch's number**: it
  is always the higher one, since the cumulative value only ever rises. Lines a
  branch does *not* change are left untouched on purpose, so they inherit main's
  value with no conflict at all.

**The one exception is rows 6 and 7.** `EXPECTED_WORKFLOWS` and
`EXPECTED_PINNED` go *down* on WS 8, because WS 8 removes a workflow file that
the F3 ruling puts back. There the incoming value wins: take main's **4 and 4**,
not WS 8's 2 and 3. It is the only place in the batch where "keep the branch's
number" is the wrong rule, which is why it is called out twice in this document.

### 6c. The counts the union leaves correct — measured, not assumed

Twenty pins need nothing. Scanned across all twelve branches and the merged
tree, every one of these holds the same value on the union as on the branch that
owns it:

| pin | file | value | why it survives |
|---|---|---|---|
| `EXPECTED_PALETTE_SIZE` 4, `EXPECTED_BACKGROUNDS` 3 | `mobile/lib/annotation-palette.test.ts` | unchanged on all twelve | no branch adds a palette colour |
| `EXPECTED_CANVAS_HEIGHT` 160 | `mobile/lib/dev-signature-probe.tsx` | unchanged on all twelve | — |
| `EXPECTED_NATIVE_HEADER` 9, `EXPECTED_LAYOUTS` 2 | `mobile/lib/screen-header-audit.test.ts` | unchanged on all twelve | re-measured on the union; the two new screens both use the shared header, which is why rows 4 and 5 moved and these did not |
| `EXPECTED_NOTIFY_SITES` 8, `EXPECTED_THROW_SITES` 4 | `mobile/lib/session-routing-audit.test.ts` | unchanged on all twelve | no branch adds a session-notice or throw site |
| `EXPECTED_INFO_PLIST_KEYS` 8, `EXPECTED_ANDROID_PERMISSIONS` 4, `EXPECTED_PLUGINS` 7 | `mobile/lib/native-permission-audit.test.ts` | new file, WS7 only | WS7 is the only branch permitted to touch native config, so it is also the only branch that can move these |
| `EXPECTED_TEST_FILES` 4, `EXPECTED_TESTS` 36 | `apps/supervisor-web/scripts/run-tests.sh` | new file, WS5 only | no other branch adds a portal test |
| `EXPECTED_REDIS_TESTS` 4, `EXPECTED_LIVE_OPENAI_TESTS` 3 | `services/api/scripts/run-tests.sh` | unchanged on all twelve | both suites are untouched by the batch |
| `EXPECTED_DOMAIN_COUNT` 144 | `services/api/src/utils/disposableDomains.test.ts` | new file, WS8 only | — |
| `EXPECTED_READS` 15, `EXPECTED_WRITE_STEPS` 14, `EXPECTED_FIELD_PROBES` 4, `EXPECTED_PARITY_KINDS` 5, `EXPECTED_OWNERSHIP_PROBES` 20 | `services/api/src/routes/crew-permissions-db.test.ts` | unchanged on all twelve | **and that is itself a finding — see the coverage gap below** |

**The crew pins are right for the wrong reason.** Those five are unchanged on
every branch because nobody added a row to the crew rank table, not because the
crew surface did not grow. WS 1 adds `/clients`, WS 2a adds timesheet approval,
WS 6 adds `/bin` and `/restore` — and there is no row for any of them. The pins
are honest measurements of a table that stopped keeping up. Not fixed here; it is
new test coverage, not a merge resolution, and it belongs in a commit of its own.

### 6d. The counts no branch touched, which the union invalidates anyway

This is the category you asked for by name: the ones that go red, or go quietly
useless, on a merge nobody expected to be risky.

**Red, and no branch's CI could have seen it:**

- **`EXPECTED_PINNED`, row 7.** WS 8's lowering to 3 **auto-merged with no
  conflict**, because WS 0 renamed a workflow without touching the pin line. The
  merged tree therefore pinned 3 against four workflow files holding four jobs.
  WS 8 was right about its own tree; WS 0 never edited the line; neither CI run
  could report it. This is the purest instance in the batch of a semantic
  conflict hiding inside a clean textual merge.
- **`EXPECTED_ROUTES` and `EXPECTED_SCREEN_HEADER`, rows 4 and 5.** WS 1 and
  WS 6 each added one screen and each independently wrote `34` and `12`.
  **Identical edits auto-merge** — git reported no conflict at all — so the union
  carries a pin that looks deliberate, was written twice, and is wrong by exactly
  one. The union has 35 route files and 13 header usages.
- **`EXPECTED_DB_SUITES`, row 1.** Six branches each raised it against main
  rather than against each other, so the last merge leaves 12 behind and the
  truth is 20. `EXPECTED_SKIPS` derives from it, so the in-memory run fails first
  with `27 skip(s), expected 19` — a skip count, not a suite count, which is a
  confusing first symptom to debug if you do not know to expect it.

**Not red, which is worse, because nothing will ever tell you:**

- **The four `>=` floors in `sqlSchemaAudit.test.ts`** (rows 9–12). The union did
  not turn one of them red, and that is the reason they needed re-measuring. The
  slack had grown to **37 statements, 15 column references, 2 tables and 26
  columns**. The assertion above them is `violations == []`; the floors exist so
  a zero-violation run over a collapsed corpus cannot read as a pass. 26 columns
  of slack is 26 columns that could stop being parsed, with this test still green.
- **`files.length >= 14` in `services/api/src/routes/async-route-errors.test.ts:276`.**
  Same shape, not in the table above because no branch changed the line and the
  union only adds route files. It is now further below its population than it was
  written to be. Flagged, not raised — raising it needs the measurement on the
  merged tree and it belongs with the floors, not with the merge.
- **`predicates.length >= 8` in `apps/mobile/lib/permissions.test.ts:148`** —
  below, in full, because it is the one correction that has nowhere to live.

### 6e. The one correction that cannot live on any of the eleven branches

**`predicates.length >= 8` should be 11 on the union, and there is no branch I
can put that on.**

- The line exists **only** on `feat/clients-sites-entries` (WS 1). WS 1 wrote the
  derivation that replaced a hand-written predicate list, and `8` is exactly
  WS 1's own count, so it is correct there and the line is absent everywhere else.
- WS 1 merges **second**. Raising it to 11 on WS 1 makes WS 1 red from position 2
  until position 11, through nine update cycles, for a floor.
- WS 8 contributes the eleventh predicate (`canVoidSignature`, AUDIT L91) but has
  **no such line to edit** — `permissions.test.ts` on WS 8 has the `predicates`
  array and the loop and no count assertion at all. Adding one there would
  duplicate WS 1's after the merge.

Because it is a `>=` floor it never goes red. It simply sits three predicates
short of its population, silently, from the moment WS 8 merges. **It needs a
one-line commit after the batch lands** — or a manual raise during WS 8's update
cycle, which is the only moment both the line and the eleventh predicate exist on
the same tree.

**A withdrawal, while this floor is in front of you.** My rehearsal commit
`0d47628` says of it: *"The permissions floor said 8 against main's 6 —
unreachably high, so it was ALSO wrong on main and on five other branches, and
would have failed there if anyone had run it."* **That is wrong and I withdraw
it.** The line exists on no branch but WS 1. Main is not red and never was. The
correction — 11 on the union — is unchanged; the claim about main is not.

---

## 7. The merge-conflict result

**ALL ELEVEN CODE POSITIONS ARE MERGED. `main` is `e00b8f8`. 7a through 7c are
the rehearsal record and are left as written; §7d is the as-merged result and is
the authority — read it first, and read it before relying on any row above.**

**The counts in 7a were re-derived on 28 October 2026 and six of the twelve were
wrong. Read 7a-note before relying on a row.**

The rehearsal: a local throwaway branch `rehearsal/merge-all` off
`origin/main` = `ee7e093`, twelve branches merged into it in the Group A → B → C
order, **never pushed, nothing merged to main**. Gates on the finished tree:
typecheck 0, `lint --max-warnings=0` 0, API 322 tests (295 pass / 0 fail / 27
skip), mobile 26 files / 207 tests / 0 skip, portal 4 files / 36 tests,
`ci.sh --no-db --no-redis` 0.

### 7a. Textual conflicts — git stopped, I resolved them

| merge | branch | conflicts | what collided, and the resolution |
|---|---|---|---|
| 1 | WS0 `fix/workstream-0-safety` | 0 | first merge off main |
| 2 | WS1 `feat/clients-sites-entries` | 0 | no overlap with WS0 |
| 3 | WS2a `feat/timesheets-approval` | 6 **[c]** | Four additive-shape: WS1 and WS2a each added a different predicate, export, import or test at the same place — both sides kept. The fifth was **not** additive: both branches independently replaced the same hand-written predicate array in `permissions.test.ts` with a derived one, so a union would have declared `predicates` twice. Kept WS1's (floor + `includes` control), dropped WS2a's (`length > 0` only). Plus the mobile pin collision, 16/123 against 15/118. |
| 4 | WS2b `feat/whs-checklists` | 3 **[c]** | `.eslintrc.js`: both branches added a different DB test file to the same no-bare-pool allowlist, each with its own justification comment — both kept. Mobile pins, 123 against 119. **`EXPECTED_TEST_FILES` did not conflict, and that is the noteworthy part**: both sides read 16, for different sets of files. |
| 5 | WS3 `feat/storage-ceiling` | 1 **[v]** | the mobile pins again |
| 6 | WS4 `feat/report-periods` | 3 **[v]** | `tsconfig.test.json`: both branches appended a module+test pair to the end of the `files` array. Both kept — **and the comma after the previous last entry had to be put back by hand.** A JSON array's last element has no trailing comma, so two branches appending always collide and a naive union is invalid JSON, which `tsc` reports as a parse error rather than as a missing test. Plus two pins. |
| 7 | WS5 `feat/photo-viewer` | 3 **[v]** | `lib/api.ts`: WS1 expanded `Site` (clientId + the filing note), WS5 expanded `EntryPhoto` (eleven fields the API already sends); the types are adjacent so one hunk carried both. Resolution: our `Site`, their `EntryPhoto`. `sites/[id]/page.tsx` import block, now carrying four workstreams — `Fragment` (WS1) and `useCallback` (WS5) both needed from react. Plus the mobile pin. |
| 8 | WS6 `feat/bin-retention` | 12 **[c]** | Mostly additive: two allowlist entries, two `Stack.Screen` rows, two provider methods, two interfaces sharing a doc opener, four row/mapper columns, two in-memory filters on one chain. **`listEntries` needed its two rewrites combined** — WS4's `range` parameter and WS6's `onLiveSite()` — which git had split across one conflict and one auto-merge. `deliveriesStore.ts`: both sides deleted `initDeliveriesSchema`, only WS6 left a note saying why; kept the note. Three semantic ones in the same merge, below. |
| 9 | WS7 `feat/consent-and-native` | 5 **[c]** | all additive: eslintrc allowlist, `ci.sh` step block, `tsconfig` `files[]` comma, mobile pins |
| 10 | WS9 `feat/branding-and-dashboard-parity` | 4 **[c]** | `mobile/app/(tabs)/index.tsx`: adjacent imports, WS1's site-grouping and WS9's siteStatus, both kept — no `scfg` equivalent here, the phone had no local status table to delete. `mobile/tsconfig.test.json`: the `files` array again, WS1/WS2b/WS4/WS7's eight entries and WS9's four — union with the trailing-comma fix, 57 entries, all unique, **verified by parse**. Mobile pin, 16/123 vs 17/122. Three semantic ones in `supervisor-web/app/sites/page.tsx`, below. |
| 11 | WS8 `feat/debt-and-cost-out` | 7 **[c]** | **F3, rename/delete + modify/delete, WS0 × WS8** — resolved as instructed: keep WS0's renamed workflow, drop WS8's deletion. `permissions.ts`: textual union, WS1/WS2a's three predicates plus WS8's `canVoidSignature`, sharing a `/**` opener and a `return isManagerOrAbove(companyRole);}` tail; module now exports 11 `can*` predicates. `permissions.test.ts` hunk 1: WS1's clients test and WS8's *"voiding a signature is manager+, and signing one is not"* test, both kept. `sessions-and-tokens-db.test.ts` and `uploads-media-isolation.test.ts`: adjacent import lines, both kept. Mobile pin, 16/123 vs 15/114. One semantic one, below. |
| 12 | `docs/nine-workstreams-handover` | 0 **[?]** | docs only, order-independent |

**[c]** corrected on 28 October 2026 · **[v]** re-derived and verified unchanged ·
**[?]** not derivable yet. The count is of conflicting **files**, against the base
that row's branch will actually merge into. Every row's working is in 7a-note below;
the prose in each cell is as written at the rehearsal and has not been edited.

**The repeat offenders, in order of how often they collided:** the two mobile
pins in `apps/mobile/scripts/run-tests.sh` (**nine of the twelve merges**),
`tsconfig.test.json`'s `files` array (three), the `.eslintrc.js` allowlist
(three), and `permissions.test.ts`'s predicate array (three, in three different
shapes).

### 7a-note. The counts above were wrong, and how they were re-derived — 28 October 2026

**Why this note exists.** The merge sequence started on 27 October and the first
two PRs to carry conflicts, 3 and 4, both arrived with a different number of
conflicting files than 7a predicted. Once is a slip; twice is a reason to stop
trusting the column, so every remaining row was re-derived from the repository
rather than re-read from this table. **Six of the twelve rows were wrong.** The
*resolutions* in those rows have held up — both merges applied the recorded
resolution unchanged — so what drifted is the arithmetic, not the judgement.

**Method, so it can be repeated.** `git merge-tree --write-tree --name-only
<base> <branch tip>` prints the conflicting paths without touching the working
tree or creating a commit. Run twice per row: once against today's `origin/main`
(what GitHub's Update branch button is looking at right now) and once against
the base the branch will actually see at its turn.

**What makes the second number knowable in advance.** Each merge so far has
landed the rehearsal's own resolution, so `main` reproduces the rehearsal trunk
exactly. Measured, not assumed:

- after PR 3, `git diff 638731d origin/main` is **empty** — the whole tree, not
  just the conflicting files;
- the merge pushed for PR 4, `47f50d4`, has a tree **identical** to the
  rehearsal's `85e366f` (`git diff 47f50d4 85e366f` empty).

So "`main` after PR *N*" = the rehearsal trunk after merge *N*, and the trunk
commits on `rehearsal/merge-all-2` stand in for a future `main` — **for as long
as that equality keeps being true, which is re-checked at every merge.** The
other half of the stand-in: every remaining branch tip is byte-identical to the
second parent of its rehearsal merge (`git rev-parse origin/<branch>` against
`<merge>^2`, all seven **SAME**), so no branch has moved since the rehearsal.

| PR | branch | 7a said | vs `main` today | vs the base it will see | why it differs |
|---|---|---|---|---|---|
| 3 | `feat/timesheets-approval` | 5 | — merged | **6** | **bookkeeping.** The row described the mobile pin collision in a trailing sentence, outside the count. |
| 4 | `feat/whs-checklists` | 2 | 3 | **3** | **the back-port.** `10f5a57` moved this branch from `EXPECTED_TEST_FILES=16` to 17; 16 is what the trunk read, so before the back-port the line was identical on both sides and did not conflict. The row's reasoning was true when written. |
| 5 | `feat/storage-ceiling` | 1 | 1 | **1** | nothing — **verified unchanged.** |
| 6 | `feat/report-periods` | 3 | 2 | **3** | nothing — **verified unchanged.** The third file (`tsconfig.test.json`) is invisible against today's `main`: it needs PR 5's entries in the `files` array to collide with. |
| 7 | `feat/photo-viewer` | 3 | 3 | **3** | nothing — **verified unchanged.** |
| 8 | `feat/bin-retention` | 11 files / 21 hunks | 11 | **12** | **the back-port.** `f254fe9` raised `EXPECTED_ROUTES` and `EXPECTED_SCREEN_HEADER`, so `screen-header-audit.test.ts` now collides where it did not before. The old 11 is exactly the pre-back-port set, `deliveriesStore.ts` included. **Note the trap in the count:** against today's `main` it is also 11, but a *different* 11 — `screen-header-audit.test.ts` in, `deliveriesStore.ts` out. A count alone would have hidden the substitution. |
| 9 | `feat/consent-and-native` | 4 | 4 | **5** | **bookkeeping.** The row named four — eslintrc, `ci.sh`, `tsconfig`, "mobile pins" — and left out `services/api/scripts/run-tests.sh`, which conflicts pre-back-port too. |
| 10 | `feat/branding-and-dashboard-parity` | 3 + | 3 | **4** | **bookkeeping, via the notation.** `sites/page.tsx` is both a textual conflict and the home of three semantic ones; it was counted in 7b only, and the bare `+` carried that. |
| 11 | `feat/debt-and-cost-out` | 6 | 6 | **7** | **bookkeeping.** `assert-workflow-runners-pinned.sh` was recorded as semantic conflict 15 and not in the textual count — understandably, since the `EXPECTED_PINNED` line inside it auto-merged; but the file also has a real conflict hunk on `EXPECTED_WORKFLOWS`. Both things are true of one file. |
| 12 | `docs/nine-workstreams-handover` | 0 | 0 | **not derivable — see below** | the branch tip keeps moving. |

**So: the back-port caused two of the six, and bookkeeping the other four.** No
row changed because a branch moved; nothing drifted underneath this work. The
two back-port rows are the back-port doing its job — putting the
position-measured pin on the branch is what creates the collision, and a
collision on a pinned count is the mechanism that forces it to be re-measured at
the merge rather than inherited.

**The consequence for how the remaining PRs get updated.** GitHub's Update
branch button cannot resolve a textual conflict; it refuses. Every remaining PR
except 12 has at least one — the mobile pins alone guarantee it — so **PRs 5, 6,
7 and 9 will refuse too, not only the 8, 10 and 11 already earmarked for a local
merge.** Seven of the eight remaining come locally; PR 12 is the only one the
button can take.

**Which rows are NOT derivable yet, and what they will be measured against.**
The second column is exact today. The third is a prediction, and these are the
terms it rests on:

1. **PR 5 is firm.** Its base is `main` after PR 4, and the tree that lands
   there is already pushed and already checked identical to `85e366f`.
2. **PRs 6 through 11 are conditional.** Each is measured against the rehearsal
   trunk *after* the merges in between, so the number holds only if every PR
   ahead of it lands with the rehearsal's resolution. The check is one command
   per merge — `git diff <trunk at N-1> origin/main` must be empty before the
   merge, and it is run and reported every time. If it is ever non-empty, every
   row below that point is re-derived before anything is resolved.
3. **PR 12 cannot be derived at all yet, and not because of the code.** The docs
   branch is where the AUDIT entries from this sequence are being filed, so its
   tip moves between now and its turn — L108 and this note are both on it
   already. It will be measured against `main` after PR 11, with whatever tip
   the branch has then. The one thing checked in advance: no code branch touches
   the files the docs branch touches. PR 11 is the only remaining branch with
   any `docs/` change at all (`ARCHITECTURE.md`, `COST-OUT-STORE-DIVERGENCE.md`,
   `DEBT-TRIAGE.md`), and the docs branch touches none of those three.

**Where a count stops being enough, and I stop.** A conflict on a file in the
predicted set is resolved as recorded. **A conflict on a file NOT in that set is
a stop**, reported rather than resolved on judgement, because the recorded
resolution cannot cover a collision the rehearsal never saw. Three files in the
predicted sets deserve the same caution for the opposite reason — they are
invisible against today's `main` and only appear once the merges ahead land, so
the first time I see them will be at the merge itself:
`tsconfig.test.json` (PRs 6, 9 and 10), `deliveriesStore.ts` (PR 8) and
`uploads-media-isolation.test.ts` (PR 11). Each has a recorded resolution in 7a
or 7b; none has been seen against a real base outside the rehearsal.

### 7b. Semantic conflicts — git merged cleanly and the result was wrong

**This is the list you asked for separately, and it is the answer to the
question eleven independently-green branches cannot be tested for.** Every one
of these is green on both parent branches, red or wrong on the merge, and in
every case git reported **no conflict at all**.

**Found by running the gates** (`744a5aa`, `eca4781`, `5611c35`):

1. **`crewStore.ts`, WS2a × WS6 — lint.** WS2a rewrote `updateTimecard` and added
   `setTimecardApproval`, writing `deleted_at IS NULL` and `SET deleted_at = NOW()`
   by hand. WS6 added an eslint ban on exactly that text (AUDIT L99), covering
   `services/api/**`. Each green alone; the union fails lint. **Resolution:**
   WS2a's new SQL converted to `liveOnly(TIMECARDS_TABLE)` and
   `softDeleteAssignment(TIMECARDS_TABLE)`.
2. **`crewStore.ts` `deleteTimecard`, WS2a × WS6 — silent loss.** Both branches
   rewrote the same function: WS2a added the approval lock, WS6 routed the soft
   delete through the helpers. Git aligned them on a shared tail, so taking
   *either* side silently dropped the other's rewrite. **Resolution:** both
   applied.
3. **`projectsStore.ts` `SiteRecord`, WS1 × WS6 — documentation that became
   false.** WS1 documented, in prose, that a site is HARD deleted and that
   `project_sites` has no `deleted_at` column in any migration. Migration 034 on
   WS6 adds it. **Resolution:** kept `clientId`, deleted the paragraph, took
   WS6's `deletedAt`.
4. **`supervisor-web/app/sites/page.tsx`, WS1 × WS9 — a call to a deleted
   function.** WS9 deleted the file's local `STATUS_CFG` table and its `scfg()`
   wrapper for `siteStatusCfg` from `lib/siteStatus`, **and that deletion
   auto-merged with no conflict.** WS1 had meanwhile moved the single
   `scfg(site.status)` call site into a new `renderCard`, which lands inside a
   conflict hunk — so keeping "ours" leaves a call to a function the merge
   deleted. Neither branch's typecheck could see it: on WS1 `scfg` exists, on
   WS9 the call site does not. **This is the only one of the twelve merges where
   a plausible resolution typechecks on neither parent.** **Resolution:** rewrote
   the call to `siteStatusCfg`.
5. **The status-chip tally, same file, WS1 × WS9.** WS1 counted over a
   `?clientId=` pool with literal keys (`on_hold`); WS9 recounted canonically
   with the key `"on-hold"` and recorded that the literal version **had always
   reported 0**. **Resolution:** WS9's vocabulary, WS1's pool — either side alone
   is a regression of the other's feature.
6. **The filter predicate, same file, WS1 × WS9.** WS1 widened search to the
   canonical client name and added the client filter; WS9 replaced the status
   comparison with `matchesSiteStatusFilter`. A union would declare
   `matchSearch` and `matchStatus` twice. **Resolution:** WS1's block with WS9's
   one line.
7. **`permissions.test.ts` hunk 0, WS1 × WS8 — a hand-written seven.** WS8
   hand-wrote a seven-element predicate array; WS1 derived the array from the
   module's exports. **Resolution:** kept WS1's derivation, dropped WS8's list —
   a hand-written seven on a module that now exports eleven is exactly the decay
   the derivation was written to stop.
8. **`assert-workflow-runners-pinned.sh`, WS0 × WS8 — the pin that auto-merged.**
   Covered as §6d's first entry: WS8's `EXPECTED_WORKFLOWS=2` auto-merged
   because WS0 renamed a workflow without touching the pin line, leaving the
   merged tree pinning 2 against a directory of 4.

**Found by the guards the branches themselves added** (`fca1ba3`, `a3509a2`) —
four of these exist *because* the batch added the guard and the thing it guards
on different branches:

9. **`sqlSchemaAudit.ts`, WS8 × WS9 (+WS1) — `filter` missing from `SQL_WORDS`.**
   WS9 added four `COUNT(*) FILTER (WHERE …)` aggregates in `projectsStore`, WS1
   one in `backfill-clients.ts`. WS8's auditor tests its function-call escape
   with a `(` **immediately** after the identifier; SQL:2003 puts a space there,
   so `FILTER` parsed as an unqualified column and **every aggregate filter in
   the codebase reported as an unresolved reference** — five spurious findings.
   **Resolution:** `filter` added to `SQL_WORDS`.
10. **`store-ddl-guard.test.ts`, WS2b × WS8 — two `DDL_EXEMPT` entries.**
    `testMigrations.ts` creates the `schema_migrations` ledger and
    `sqlSchemaAudit.ts` carries CREATE/ALTER in its grammar rather than in a
    query. **Resolution:** both exempted; the guard verifies an exempt file still
    contains DDL, so neither entry can go stale.
11. **`store-ddl-guard.test.ts`, WS2b × WS6 — the documentation of a fix failed
    the test for the fix.** WS6 deleted `initDeliveriesSchema` and left a comment
    naming it twice where it used to be; WS2b's guard scanned raw source with
    `code.includes(name)`. **Resolution:** the deleted-init scan now reads
    `stripComments(source)`. Worth remembering for every other guard that greps
    source.
12. **`api-post-merge-checks.yml` + `assert-ci-single-definition.sh`, WS0 × WS8 —
    direct fallout of the F3 ruling.** `ci.sh` check 5 is new on WS8, which had
    **deleted the only file it targets**, so its exemption list needed no entry
    and the check passed there having swept nothing. The ruling puts the file
    back under its new name. **Resolution:** two halves — the workflow's three
    `pnpm --filter ./shared` / `./services/api` **path** filters fixed to package
    names (`@sitesnap/shared`, `services-api`), because a path filter matches no
    package in this workspace and the workflow had been reporting a green tick on
    main having run no typecheck and no tests; and `api-post-merge-checks.yml`
    added to `EXEMPT_GATE_WORKFLOWS` with its reason. **Open for you, flagged not
    decided:** whether that workflow's gate steps should consolidate into
    `ci.sh` rather than be exempted — the same question already open for
    `build-mobile.yml`'s pre-release typecheck.

    **WITHDRAWN, 27 October 2026 — the first half of this item was wrong and the
    workflow needed no change.** The claim was that
    `pnpm --filter ./shared run build:types` and the two `./services/api` filters
    match no package, so the workflow had been reporting green having run nothing.
    It is false. A relative-path filter resolves against `process.cwd()`, and that
    workflow sets `defaults: run: working-directory: Projects` — line 42 on the
    merged tree, line 17 when it was written — so every step runs with cwd inside
    the workspace and the filters resolve. Measured both ways, 27 October 2026:

    ```
    $ cd Projects && pnpm --filter ./shared exec node -e '…'
    filter resolved: /Users/zackdancey/Dev/SiteSnap/Projects/shared

    $ pnpm -C Projects --filter ./shared exec node -e '…'
    No projects matched the filters in "/Users/zackdancey/Dev/SiteSnap/Projects"
    ```

    The second line is the one I generalised from, and `-C` is the mistake in it:
    `-C` changes where pnpm looks for the workspace, not the process's cwd, so the
    filter had nothing to resolve against. The workflow does not use `-C`.

    **Introduced `986becd`, 25 June 2026** — the same commit added the three
    filters (lines 48, 51, 54) *and* the `working-directory: Projects` default
    (line 17), so they have resolved from the day they were written. **main has
    never been unverified by this workflow: zero days.** The workflow was left
    exactly as it is on workstream 0 — its three path filters still read
    `./shared` and `./services/api`, verified with
    `git show fix/workstream-0-safety:.github/workflows/api-post-merge-checks.yml`
    — and the withdrawal is recorded where the wrong claim was actually written:
    `b5dbbf5` on **workstream 8**, in the comment justifying `ci.sh` check 5.
    Only the second half of this item was carried: `api-post-merge-checks.yml` in
    `EXEMPT_GATE_WORKFLOWS`, which is still needed and is still on workstream 8.

    What survives is the adjacent hazard, which is true and is not this: **`pnpm
    --filter <relative path>` EXITS 0 when it matches nothing.** Any step of this
    shape is one `working-directory` edit away from passing while running nothing,
    and pnpm will not say so. Proposed as its own AUDIT entry if you want it
    filed; it is a hazard in the tooling rather than a defect in this repository.
13. **`sqlSchemaAudit.test.ts`, WS6 × WS8 — lint, and lint only.** The union
    reported 3 errors, all the soft-delete column ban. The file is new on WS8;
    the ban is new on WS6. One branch has the rule and not the file, the other
    the file and not the rule. **Typecheck on the union is green — lint is the
    only gate that sees it.** The three literals are a fixture carrying the exact
    L99 shape, fed to the auditor so the test can assert the auditor reports it;
    rewriting them through `liveOnly()` would leave the test with nothing to
    detect. **Resolution:** an exemption scoped to that one filename, with the
    dynamic-pool ban re-listed inside it rather than dropped. Both controls
    measured: a `deleted_at` template literal added to `crewStore.ts` still
    errors, so the exemption did not leak; a dynamic import of
    `../storage/postgres` inside the exempted file still errors, so the override
    kept the pool ban. Both probes reverted, lint back to 0.

### 7c. The semantic resolutions are NOT yet on any branch

**Read this before you open PR 1.** The thirteen resolutions above exist only as
commits on the unpushed `rehearsal/merge-all`. The pinned counts have been
back-ported — the resolutions have not. Each needs to land on the branch that
owns the file, and until it does, the merge that creates the collision will go
red (or, for 2, 4 and 11, go quietly wrong).

| # | resolution | belongs on | why that branch |
|---|---|---|---|
| 1, 2 | `crewStore.ts` through `liveOnly`/`softDeleteAssignment`; `deleteTimecard` both rewrites | **WS2a** `feat/timesheets-approval` | it owns the hand-written SQL that WS6's new rule bans |
| 3 | `SiteRecord` prose deleted, `deletedAt` kept | **WS6** `feat/bin-retention` | its migration 034 is what makes WS1's paragraph false |
| 4, 5, 6 | `sites/page.tsx` — `siteStatusCfg` call, WS9 vocabulary + WS1 pool, WS1 block + WS9 line | **WS9** `feat/branding-and-dashboard-parity` | WS9 is the branch that deletes `scfg`, and it merges at position 10, before WS8 |
| 7 | `permissions.test.ts` — drop WS8's hand-written array | **WS8** `feat/debt-and-cost-out` | it is WS8's array to drop |
| 8 | `EXPECTED_WORKFLOWS` / `EXPECTED_PINNED` | **done** — WS0 `5a99eb3`; WS8's lowering loses at the merge | see §6b's exception |
| 9 | `filter` in `SQL_WORDS` | **WS8** `feat/debt-and-cost-out` | WS8 owns the auditor |
| 10, 11 | two `DDL_EXEMPT` entries; `stripComments(source)` | **WS2b** `feat/whs-checklists` | WS2b owns the guard |
| 12 | package-name filters + the exemption entry | **split**: the workflow on **WS0**, the exemption on **WS8** | each half belongs to the branch that owns the file |
| 13 | the scoped lint exemption | **WS8** `feat/debt-and-cost-out` | WS8 owns the fixture file |

**APPLIED, 27 October 2026, and the table above is superseded by §9.** You gave
the word; the back-port went on in the same one-commit-per-branch shape as the
pins, and the rehearsal was then re-run from scratch on the back-ported branches.
That rehearsal is what sorted the thirteen into **5 carryable, 7 merge-time and 1
withdrawn** — a different split from the mapping in this table, because seven of
these resolutions cannot exist on a branch at all. §9 has the measured result,
the per-item classification and the two further semantic conflicts the second
rehearsal found.

### 7d. As merged — all eleven landed, and where the result deviated from the rehearsal

**This subsection is the authority on what happened. 7a, 7a-note, 7b and 7c above
are the rehearsal record and are deliberately left as written.** The sequence is
complete: PRs #65 through #75 are merged, positions 1 through 11, and `main` is at
`e00b8f8`. PR 12 (this document) is position 12 and is the only one outstanding.

**The prediction held where it could be checked.** Every row's resolution applied
as recorded, and the trunk-equality check that 7a-note made the whole prediction
conditional on — `git diff <trunk at N-1> origin/main` empty before each merge —
never once came back non-empty. The strongest form of that: at position 11,
`main`'s tree came back **byte-identical** to the branch tip's tree
(`e00b8f8^{tree}` = `e833c3e4…`, the same tree the merge commit `14e93d1`
produced), so GitHub's squash-free merge introduced no drift anywhere in the
eleven-merge sequence.

**Gates on `main` as merged**, measured at position 11 rather than inherited:

```
./scripts/ci.sh --no-db --no-redis   exit 0
mobile  run-tests.sh                 26 files, 207 tests, 207 pass, 0 fail, 0 skip
API     run-tests.sh (in-memory)     68 files, 323 tests, 296 pass, 0 fail, 27 skip
```

The 27 skips are still the pinned value exactly — `EXPECTED_DB_SUITES` 20 +
`EXPECTED_REDIS_TESTS` 4 + `EXPECTED_LIVE_OPENAI_TESTS` 3 — and the mobile pins
matched **untouched**, which was the part of the pin plan that could not be
checked any other way.

**The one arithmetic difference from §9a, and it reconciles exactly.** The second
rehearsal measured the API in-memory suite at 322 tests / 295 pass; as merged it is
323 / 296, with skips unchanged at 27. That is **+1 test, +1 pass, +0 skips**, and
it is entirely PR 8's deviation below: `routes/integration.test.ts` gained exactly
one `test(...)` — *"a binned site refuses a new entry, and a live one accepts it"* —
and the DB-gated half of that same commit added assertions to an existing test
rather than a new one, so no skip count moved. No other position changed a count.

#### The four positions that deviated

Four of the eleven landed with something the rehearsal had not recorded. None was
a resolution applied differently from the record; all four were things found *at*
the merge, by running the gates or by reading the tree the merge produced.

| position | PR | deviation | commit | kind |
|---|---|---|---|---|
| 8 | #72 `feat/bin-retention` | `createEntry` had no site-liveness check on either store path | `598fff1` | **a defect found mid-merge, fixed** |
| 9 | #73 `feat/consent-and-native` | `app.config.ts` named a guard file that does not exist | `ffeb68e` | **a comment that was false** |
| 10 | #74 `feat/branding-and-dashboard-parity` | the fourth conflict was real, and had a fourth hunk the rehearsal never saw | `bedb91e` | **a conflict under-recorded** |
| 11 | #75 `feat/debt-and-cost-out` | four merge-time corrections, git flagged none of them | `14e93d1` | **pins and guards invalidated by the union** |

**Position 8 — a silent data loss, found because the merge made me read
`createEntry`.** `createEntry` accepted a POST against a **binned** site on both
store paths, inserted the row and answered **201**; because `listEntries` filters
through `onLiveSite()` on Postgres and `!…deletedAt` in memory, that row was never
readable again. The caller was told the entry was saved and it was gone. The route
that reaches this in practice is the offline replay — `apps/mobile/lib/offline-drain.ts:201`
drains the queue onto `POST /projects/entries` and each 201 dequeues one entry as
delivered — so **a site binned while a phone was out of signal consumed the day's
work silently.** `createEntry` now returns null when the actor's company has no
live site with that id (binned, another company's and nonexistent all answer
alike, so an invisible site is not distinguishable from an absent one) and the
route answers 404, matching its two sibling handlers. The check is liveness and
tenancy only and deliberately **not** `canManageSite`: filing against a site is not
managing it, and a role check there would stop a crew member diarising the site
they are standing on. The client needed no change — a 404 is a server refusal, so
offline-drain's `markOpFailed` branch (AUDIT L30) keeps the op, dead-letters it
with its status and shows it as unsynced. Red-on-revert was run on the in-memory
half, the half this environment can run: removing the two-line guard gives
`not ok 98 … expected: 404, actual: 201` with **268 others still green**, so the
new test is the only thing defending it. The Postgres half is carried by CI, and
`routes/site-bin-db.test.ts` asserts the 404 **and** that `project_entries` holds
no row — the listing is deliberately not what is checked, because a 201 plus a
hidden row satisfies any assertion about the listing.

**Position 9 — a pointer to a test that does not exist.** The L60 removal block in
`app.config.ts` said it was *"Guarded by `lib/app-config-permissions.test.ts`"*.
There is no such file. The guard is real and does everything the comment claims —
it parses `app.config.ts` with comments stripped first, so the commented-out
location declarations preserved at the top cannot satisfy it, and it refuses to
report a pass if the file is missing, implausibly short or uninterpretable — but it
is named `lib/native-permission-audit.test.ts`. Worth its own commit because of
what the wrong name costs later: the removal deliberately leaves those
declarations in place as comments, so a future reader who goes looking for the
thing stopping them being uncommented back in, finds nothing at the named path, and
concludes the guard was deleted, is one step from restoring an App Store review
rejection. **A pointer to a nonexistent test is worse than no pointer.**
Comment-only; no behaviour change and no pin moved.

**Position 10 — the fourth conflict, and a fourth hunk.** 7a-note predicted 4 and
was right; what deviated is the composition. §7a's row counted three and carried a
bare `+`, because `supervisor-web/app/sites/page.tsx` was recorded in 7b as the
home of three *semantic* conflicts and not also as a textual one. It is both. At
the merge it came in as **four hunks resolved line by line**, and the fourth is one
the rehearsal never recorded: the card JSX, where the unconflicted tail git aligned
below the marker (`group.data.map(renderCard)`) belongs to main's side, so taking
HEAD there orphans it — **confirmed as a TS17002 unterminated-JSX error, not a
silent one.** Three of the four typecheck on neither parent. Also measured in both
directions rather than reasoned about: with only the branch's import block
`groupSitesByClient`/`shouldShowGroupHeadings` are undefined, with only main's six
names are. The mobile `app/(tabs)/index.tsx` import union is the same shape
mirrored. `tsconfig.test.json` was 53 + 4 = **57** entries, verified by set
difference in both directions rather than by count. And the merge confirmed PR 8's
`createEntry` guard survived the auto-merge of `projectsStore.ts` intact, including
its transactional `liveOnly("project_sites")` predicate.

**Position 11 — four corrections, none of them flagged by git.** Seven textual
conflicts, and separately four things the union invalidated silently. In short, with
full provenance in `14e93d1`: (1) **`EXPECTED_PINNED` 3 → 4** — not a conflict, and
now filed as a hazard class in its own right, **AUDIT L112**; (2) **two
`DDL_EXEMPT` entries** for `sqlSchemaAudit.ts` and `testMigrations.ts`, in a
main-only file absent from the branch so it never conflicted, verified by running
the guard's own walk against the merged tree — 2 offenders before, 0 after, 67 files
walked; (3) an **`.eslintrc.js` exemption for `sqlSchemaAudit.test.ts` in its own
block** with `DYNAMIC_POOL_IMPORT_BAN` re-listed inside it, because an overrides
block replaces a rule's options wholesale rather than merging them — joining the
soft-delete registry list would have set `no-restricted-syntax` to `"off"` and
dropped the pool ban for that file with no sign of it, proven with an identical
dynamic-import probe under both configs (**0 errors lumped, 1 scoped**); (4) the
**`permissions.test.ts` floor comment**, where both parents wrote the floor as "the
count at the time of writing", 7 on one side and 8 on the other, a sentence that
stops being true the moment two branches of predicates land together — measured at
**11** on the merged tree and deliberately left reading `>= 8`, because a floor
raised here goes red on every sibling branch not yet carrying all eleven.

A fifth thing was found at position 11 and is not a merge correction: verifying a
deletion premise against the **merged** tree rather than the branch — the practice
L112 argues for — showed `isAtLeast` had zero real callers, so the deletion held,
but surfaced a `useRole.ts` doc comment still naming it. Fixed in `c85d5ae`, after
the merge commit.

#### What this leaves owing

Three floors are loose on `main` and are queued as **one** post-merge commit, held
back until this batch is fully landed because raising any of them on a branch goes
red on its siblings. Measured on `main` at position 11:

| floor | reads | measured | where |
|---|---|---|---|
| `predicates.length` | `>= 8` | **11** | `apps/mobile/lib/permissions.test.ts:135` |
| `files.length` | `>= 40` | **67** | `services/api/src/storage/store-ddl-guard.test.ts:110` |
| `files.length` | `>= 14` | **15** | `services/api/src/routes/async-route-errors.test.ts:276` |

The argument for raising them rather than leaving them is **AUDIT L112**, which is
the `EXPECTED_PINNED` instance generalised: a floor cannot distinguish "the
population is as I measured it" from "the population has changed and I am no longer
measuring anything", and it was an equality check — not a floor — that caught the
one stale pin this batch produced.

---

## 8. The PR open order, with a compare URL each

**The repository is `zackdancey-art/SiteSnap-AI`, not `SiteSnap`.** An earlier
note of mine had the wrong path; these URLs are built from `git remote -v`.

Open them in this order, merge them in this order, and update each one onto main
before merging it — main requires `validate` and requires branches to be up to
date, so this is ten update-and-wait cycles. Each PR carries its own pinned-count
correction (§6), so each cycle should come back green on the counts.

1. **WS0 — `fix/workstream-0-safety`** · deploys: none (CI only)
   https://github.com/zackdancey-art/SiteSnap-AI/compare/main...fix/workstream-0-safety
   *Out of order:* it is the safety workstream and the F3 counterparty. Merged
   later, the F3 rename/delete lands against whichever branch happens to go
   second instead of against WS8 at the end, where it is expected. Its
   `EXPECTED_WORKFLOWS` fix is the one pin that is red on the branch today.

2. **WS1 — `feat/clients-sites-entries`** · deploys: **API**, **portal**, **`eas update`**
   https://github.com/zackdancey-art/SiteSnap-AI/compare/main...feat/clients-sites-entries
   *Out of order:* it is the only branch whose pins need no change at all
   (12 / 16 / 123 / 34 / 12 and the `>= 8` floor are all exactly right at
   position 2). Move it and every one of those six numbers becomes wrong, and
   four of them are equalities.

3. **WS2a — `feat/timesheets-approval`** · deploys: **API**, **`eas update`**
   https://github.com/zackdancey-art/SiteSnap-AI/compare/main...feat/timesheets-approval
   *Out of order:* carries `EXPECTED_DB_SUITES=13` and `EXPECTED_TESTS=128`,
   both correct only at position 3. It is also semantic conflict 1 and 2's owner
   — its hand-written `deleted_at` SQL is banned by WS6's rule, so it must merge
   **before** WS6 or the lint failure arrives with WS6 instead of being fixable
   here.

4. **WS2b — `feat/whs-checklists`** · deploys: **API**, **`eas update`**
   https://github.com/zackdancey-art/SiteSnap-AI/compare/main...feat/whs-checklists
   *Out of order:* carries 14 / 17 / 134, correct only at position 4. It also
   owns the DDL guard that semantic conflicts 10 and 11 fix, so it should precede
   the branches whose files those entries name.

5. **WS3 — `feat/storage-ceiling`** · deploys: **API**, **`eas update`**
   https://github.com/zackdancey-art/SiteSnap-AI/compare/main...feat/storage-ceiling
   *Out of order:* carries 19 / 158 and leaves `EXPECTED_DB_SUITES` untouched so
   it inherits 14 from position 4. Merged before WS2b it inherits the wrong
   number without conflicting — the silent case.

6. **WS4 — `feat/report-periods`** · deploys: **API**, **portal**, **`eas update`**
   https://github.com/zackdancey-art/SiteSnap-AI/compare/main...feat/report-periods
   *Out of order:* carries 17 / 20 / 166, correct only at position 6. Note for
   the body: **WS4's dateless entries are now excluded from reports where they
   previously appeared in all of them** — a behaviour change, not a bug, and
   worth stating before it is noticed in a report.

7. **WS5 — `feat/photo-viewer`** · deploys: **API**, **portal**, **`eas update`**
   https://github.com/zackdancey-art/SiteSnap-AI/compare/main...feat/photo-viewer
   *Out of order:* carries 21 / 179. It is the only branch with
   `apps/supervisor-web/scripts/run-tests.sh`, whose 4 / 36 are correct at every
   position — so the portal pins are not what constrains it, the mobile pins are.

8. **WS6 — `feat/bin-retention`** · deploys: **API**, **portal**, **`eas update`**
   https://github.com/zackdancey-art/SiteSnap-AI/compare/main...feat/bin-retention
   *Out of order:* carries five corrections (19 / 22 / 182 / 35 / 13), the most
   of any PR. It must merge **after** WS2a (semantic 1) and **after** WS1
   (semantic 3, its migration 034 is what falsifies WS1's prose). Note for the
   body: **`createEntry` accepts an entry onto a binned site** — no live-site
   guard, only the FK — which is this branch's own gap, found during the
   rehearsal and not fixed in it.

9. **WS7 — `feat/consent-and-native`** · deploys: **API**, **`eas update`**, **native build**
   https://github.com/zackdancey-art/SiteSnap-AI/compare/main...feat/consent-and-native
   *Out of order:* **this is where `EXPECTED_DB_SUITES` reaches its final 20.**
   It must sit after WS1, WS2a, WS2b, WS4 and WS6 — the five other branches that
   add gated suites — and at position 9 it does. Move it earlier and the count is
   wrong on every merge after it. It is also the only branch permitted to touch
   native config, and it ends at "ready for `eas build`": the build is yours.

10. **WS9 — `feat/branding-and-dashboard-parity`** · deploys: **API**, **portal**, **`eas update`**
    https://github.com/zackdancey-art/SiteSnap-AI/compare/main...feat/branding-and-dashboard-parity
    *Out of order:* **this is where `EXPECTED_TEST_FILES` reaches its final 26.**
    It also touches the most screens on both clients and owns semantic conflicts
    4, 5 and 6 against WS1 — including the only one in the batch where a
    plausible resolution typechecks on neither parent. Expect its update cycle to
    be the one with real work in it.

11. **WS8 — `feat/debt-and-cost-out`** · deploys: **API**, **`eas update`** (its own, before the rest of the batch)
    https://github.com/zackdancey-art/SiteSnap-AI/compare/main...feat/debt-and-cost-out
    *Out of order:* two reasons, and both are hard. **It is the only one of the
    eleven that is not safe to run on the API while the old clients are live** —
    its void-signature field gate changes what an already-shipped client may
    send — so it merges last and takes its own OTA. And **`EXPECTED_TESTS`
    reaches its final 207 here**, along with `EXPECTED_UNRESOLVED` and the four
    floors, none of which is correct on any smaller tree. This is also where the
    F3 rename/delete conflict appears; §2 has the resolution.

— **`docs/nine-workstreams-handover`** · deploys: none
   https://github.com/zackdancey-art/SiteSnap-AI/compare/main...docs/nine-workstreams-handover
   Docs only, order-independent, merge whenever. It carries this document and
   AUDIT L105 and L106.

### What is folded into which PR

Every pinned-count correction from §6 is already on the branch it belongs to —
one commit per branch, nothing left on the rehearsal branch. In full:

| PR | branch | pin commit | correction |
|---|---|---|---|
| 1 | `fix/workstream-0-safety` | `5a99eb3` | `EXPECTED_WORKFLOWS` 3 → 4 |
| 2 | `feat/clients-sites-entries` | — | **none needed** |
| 3 | `feat/timesheets-approval` | `ab1cb99` | DB 12 → 13; TESTS 118 → 128 |
| 4 | `feat/whs-checklists` | `10f5a57` | DB 12 → 14; FILES 16 → 17; TESTS 119 → 134 |
| 5 | `feat/storage-ceiling` | `aba1451` | FILES 17 → 19; TESTS 137 → 158 |
| 6 | `feat/report-periods` | `797dbb0` | DB 14 → 17; FILES 16 → 20; TESTS 121 → 166 |
| 7 | `feat/photo-viewer` | `8958345` | FILES 16 → 21; TESTS 126 → 179 |
| 8 | `feat/bin-retention` | `f254fe9` | DB 13 → 19; FILES 16 → 22; TESTS 116 → 182; ROUTES 34 → 35; SCREEN_HEADER 12 → 13 |
| 9 | `feat/consent-and-native` | `e376ee2` | DB 12 → **20, final** ; FILES 17 → 24; TESTS 128 → 197 |
| 10 | `feat/branding-and-dashboard-parity` | `515c89a` | FILES 17 → **26, final** ; TESTS 122 → 206 |
| 11 | `feat/debt-and-cost-out` | `8925414` | TESTS 114 → **207, final** ; the four floors → 159 / 618 / 25 / 281; `EXPECTED_UNRESOLVED` → `{2, 2, 26}` |
| — | `docs/nine-workstreams-handover` | `76ec8bb` | AUDIT L105, L106 |

**Not folded into any PR, and it cannot be:** the predicate floor in
`apps/mobile/lib/permissions.test.ts`. §6e has the reasoning and the one-line
commit it needs after the batch. **Corrected 27 October 2026:** the floor on
workstream 8 is now `>= 7`, measured on that branch, not the `>= 8` this line
said — and the post-merge value is **11**, measured on the merged tree
(`grep -c '^export function can' lib/permissions.ts` = 11). A second floor joins
it: `files.length >= 14` in `routes/async-route-errors.test.ts` against **15**
route files on the union. Both are floors, so both merged clean and both stayed
green while no longer saying what they were written to say; both are in the
rehearsal's single pin commit (`f03552b`).

### Rehearsal item 3 — the four migrations together — was NOT run

032–035 have not been applied in sequence against a seeded database, and I did
not run them. **There is no Postgres on this machine, no Docker and no container
runtime** — `psql`, `pg_ctl`, `docker`, `podman`, `colima` and `nerdctl` are all
absent, and the DB-gated suite cannot run locally for the same reason. That is
also why all 20 gated suites, `test:redis` and `test:openai` are unverified here.

What I did instead, which is not the same thing and is not offered as a
substitute: read all four migration files in full, confirmed each is additive and
idempotent (`IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`), confirmed the four
version numbers are unused on every branch, and confirmed from
`migrate.ts:32-41` that files are filtered to `.sql`, `.sort()`ed by filename and
applied in that order with an `appliedVersions()` skip — so **merge order cannot
change migration order**, and 032 before 033 before 034 before 035 is what any
tree produces. 032 and 034 both `ALTER project_sites` and they add different
columns, which remains a reason they should work rather than evidence that they
do.

**ANSWERED 27 October 2026 — CI already covers this, and no disposable database
is needed before PR 1.** The DB-gated suites apply the migrations **themselves,
from scratch, against an empty database**: `ci.yml` declares a `postgres:16`
service (`POSTGRES_DB: sitesnap_test`) provisioned fresh per job, and the suites
call `applyMigrations`, which reads
`path.join(process.cwd(), "src", "storage", "migrations")`, filters to `.sql`,
`.sort()`s, and runs each unapplied file in its own BEGIN/COMMIT against a
`schema_migrations` ledger it creates first. Nothing is pre-seeded and no schema
is restored, so every gated run applies **every** migration in filename order on
a clean database. By **PR 9** (`feat/consent-and-native`, which carries 035) main
holds 032, 033 and 034 as well, so that PR's CI is the first run that applies all
four together — and it is automatic. Each earlier PR also proves its own
migration against everything before it.

**The one residual, stated plainly.** The database is empty, so this covers a
migration that cannot apply to an empty schema and does **not** cover one that
would fail against existing rows — a `NOT NULL` without a default on a populated
table, a unique index over data that already violates it. All four were read for
that shape and none has it: 032 and 035 create tables, 033 and 034 add nullable
columns and indexes with `IF NOT EXISTS`. Production is the only populated
database, and migrations run there at boot from `migrate.ts`.

---

## 9. The second rehearsal — run on the back-ported branches, 27 October 2026

**As merged: 9a-9e are the rehearsal record, left as written. §9f settles what
they predicted correctly and what they did not.**

The thirteen resolutions in §7b are now on their owning branches, and the
rehearsal was re-run **from scratch** on a new throwaway branch to prove the
merged tree comes out green with the resolutions *carried* rather than applied by
hand. Base `ee7e093` (`origin/main`), branch `rehearsal/merge-all-2`, all twelve
merged `--no-ff` in Group A → B → C order, F3 resolved as ruled: **workstream 0's
renamed workflow kept, workstream 8's deletion of it dropped.**

### 9a. The result

```
typecheck                        exit 0
lint --max-warnings=0            exit 0
mobile suite                     26 files, # pass 207, # fail 0, # skipped 0
API in-memory suite              # tests 322, # pass 295, # fail 0, # skipped 27
portal suite                     4 files, # pass 36, # fail 0
ci.sh --no-db --no-redis         exit 0, 16 structural + gate steps
```

The 27 API skips are the gated suites and are the pinned value exactly:
`EXPECTED_DB_SUITES` 20 + `EXPECTED_REDIS_TESTS` 4 + `EXPECTED_LIVE_OPENAI_TESTS`
3. The mobile pins matched **without being touched** — 26 files and 207 tests, the
position-dependent values back-ported onto workstreams 10 and 11 — which is the
part of the pin plan that could not be checked any other way.

### 9b. The thirteen, sorted by where they can live

**5 carryable, 7 merge-time, 1 withdrawn.** This differs from §7c's mapping, and
the difference is the finding: §7c assumed every resolution could be back-ported
to the branch that owns the file. Seven cannot, because the resolution does not
typecheck, does not lint or does not exist on either parent alone.

| # | where it lives now | commit | why |
|---|---|---|---|
| 3 | **carried**, workstream 1 | `69b40d1` | the false paragraph is workstream 1's own prose; it can retire it unilaterally |
| 7 | **carried**, workstream 8 | `30a70da` | workstream 8 owns the hand-written array and can replace it with the derivation |
| 9 | **carried**, workstream 8 | `30a70da` | `filter` in `SQL_WORDS` is a one-word addition to workstream 8's own auditor |
| 11 | **carried**, workstream 2b | `4a01363` | `stripComments(source)` is a fix to workstream 2b's own guard |
| 12B | **carried**, workstream 8 | `30a70da` | the `EXEMPT_GATE_WORKFLOWS` entry is inert until the merge, by basename |
| 1, 2 | **merge-time**, at the workstream 6 merge | `4ab63b9` | both branches rewrote `deleteTimecard`; the union is neither side, and workstream 2a cannot write `liveOnly()` because `storage/softDelete.ts` does not exist there |
| 4, 5, 6 | **merge-time**, at the workstream 9 merge | `2c6afa7` | the `siteStatusCfg` call typechecks on neither parent; the tally and the filter predicate each need one branch's vocabulary inside the other's feature |
| 10 | **merge-time**, at the workstream 8 merge | `057c845` | the guard verifies an exempt file still contains DDL, so an exemption naming a file workstream 2b has not got would fail on workstream 2b |
| 13 | **merge-time**, at the workstream 8 merge | in `e51761b` | the eslint override must re-list the dynamic-pool ban it switches off, and that ban is not in workstream 6's rule set in the same shape |
| 12A | **withdrawn** | `b5dbbf5` | the premise was false — see §7b item 12 |
| 8 | **already on workstream 0** | `5a99eb3` | pinned before this pass; `EXPECTED_PINNED` needed one post-merge line, below |

### 9c. Two more semantic conflicts, found by this rehearsal

Both are the same shape as §7b's "found by the guards the branches added": a guard
on one branch, the thing it guards on another, green on both.

14. **`store-ddl-guard.test.ts`, workstream 2b × workstream 8 — the API suite.**
    `storage/testMigrations.ts` creates the `schema_migrations` ledger and
    `storage/sqlSchemaAudit.ts` carries `/CREATE TABLE …/gi` and `/ALTER TABLE …/gi`
    in its grammar. The union: `# pass 294 # fail 1`, offenders
    `['storage/sqlSchemaAudit.ts (create table)', 'storage/testMigrations.ts (CREATE TABLE)']`.
    **Resolution:** both in `DDL_EXEMPT` with their reasons (`057c845`); the suite
    returns to `# pass 295 # fail 0`. This is §7b item 10 again — the same two
    files, re-applied at the merge because they cannot be exempted on workstream 2b.
15. **`EXPECTED_PINNED`, workstream 0 × workstream 8 — a pin that auto-merged
    AGAIN, one line below the one §6d already names.** `EXPECTED_WORKFLOWS` was
    back-ported to 4 on workstream 0 and conflicted at the merge, so it was
    resolved by hand; `EXPECTED_PINNED` sat outside the conflict hunk and merged
    cleanly from workstream 8 at **3**, because that branch had deleted
    `deploy-api.yml`. F3 puts the file back, so the union has four pinned jobs:
    `FAIL: matched 4 pinned 'runs-on:' lines, expected 3`, `ci.sh` exit 1.
    **Resolution:** 4, measured (`057c845`). The lesson is the one §6d states and
    this is its second instance: back-porting a pin fixes the line you edited and
    leaves the line next to it to merge silently.

### 9d. The pins the union still invalidated

Three, and all three are **post-merge by construction** — no branch can hold the
measured value:

| pin | was | measured on the union | why no branch can write it |
|---|---|---|---|
| `EXPECTED_PINNED` | 3 | **4** | workstream 8 says 3 because it deleted the workflow F3 restores |
| `predicates.length >=` | 8 | **11** | every branch that touched `lib/permissions.ts` measured fewer; 7 on workstream 8, 8 was the highest honest floor available |
| `files.length >=` | 14 | **15** | `routes/clients.ts` is workstream 1's; the floor is in a file no branch's work touches |

The second and third are **floors**, so both merged clean and both stayed green.
That is what makes them worth naming: a floor does not go red when the population
grows past it, it just stops saying what it was written to say — the
`EXPECTED_WRITE_STEPS = 13` shape, reading green against a sequence of 14. One
commit, `f03552b`, with the measurements in the message.

### 9e. One thing to expect when you open PR 11

**`feat/debt-and-cost-out`'s own CI will be red, and it is not a new defect.**
`storage/sqlSchemaAudit.test.js` reads 8 pass / 3 fail on that branch
(`examined 124 DML statements, expected at least 159`; `parsed 23 tables, expected
at least 25`; and the declined-set test), because its four floors and
`EXPECTED_UNRESOLVED` are **measured for the union** — that is the position-
dependent pin rule applied to a test's own thresholds, and §8's table records the
values. Proved pre-existing rather than caused by the back-port: the same 8/3 with
that branch's earlier version of the file swapped in. On the union all three pass,
which the rehearsal's `# fail 0` is. So update PR 11 onto main **before** reading
its checks; main requires branches to be up to date anyway, and that update is
what makes them green.

### 9f. As merged — what the second rehearsal predicted correctly, and what it did not

**9a through 9e are the rehearsal record, left as written. This is the outcome.**
All eleven code positions are merged (#65–#75); `main` is `e00b8f8`. §7d carries
the full as-merged account and the four deviating positions; this subsection
settles only what §9 itself claimed.

**9a's figures, against the merged reality:**

| 9a measured on `rehearsal/merge-all-2` | as merged on `main` | |
|---|---|---|
| typecheck exit 0 | exit 0 | held |
| `lint --max-warnings=0` exit 0 | exit 0 | held |
| mobile 26 files, 207 pass, 0 fail, 0 skip | 26 files, 207 pass, 0 fail, 0 skip | **exact** |
| API 322 tests, 295 pass, 0 fail, 27 skip | **323 tests, 296 pass**, 0 fail, 27 skip | **+1/+1**, reconciled in §7d |
| `ci.sh --no-db --no-redis` exit 0 | exit 0 | held |

The portal suite's 4 files / 36 tests were not re-measured separately at position
11; `ci.sh` covers them and it exits 0. The +1 is PR 8's single new in-memory test
and nothing else — §7d does the arithmetic.

**9b's classification held completely.** The five carryable resolutions carried;
the seven merge-time ones were applied at the merges they were predicted for, each
at the position §9b names; 12A stayed withdrawn. No resolution had to be moved
between the two categories at the merge, and none was applied differently from the
record. This is the claim §9 existed to test — that a resolution which does not
typecheck, does not lint, or does not exist on either parent **cannot** be
back-ported and must be made at the merge — and it survived eleven merges.

**9c's two additions held, and item 15 is now a filed hazard class.** Item 14 (the
two `DDL_EXEMPT` entries) recurred exactly as predicted at the position-11 merge
and was re-applied there, because it cannot be exempted on workstream 2b. Item 15
(`EXPECTED_PINNED` auto-merging at 3) recurred too, and is the subject of **AUDIT
L112** — filed as a class rather than as a third instance, with the three-way merge
reproduced on the blobs to show that `EXPECTED_WORKFLOWS` conflicted and
`EXPECTED_PINNED` eleven lines below it did not, for no reason other than whether
`main` had independently edited the same line.

**9d was right about the mechanism and right to name it.** All three pins listed
there were invalidated by the union, exactly as described: `EXPECTED_PINNED` went
red and was corrected to 4; the two floors merged clean and **stayed green**, which
is what 9d said made them worth naming. They are still green and still loose on
`main` — 11 against a floor of 8, 15 against 14, and a third at 67 against 40 that
9d did not list. All three are queued as one commit. 9d's `EXPECTED_WRITE_STEPS = 13`
comparison is the right one and is now the standing argument in L112.

**9e's prediction about PR 11's CI was correct and the remedy worked.** That
branch's own checks were red before the merge commit, by construction, on pins
measured for the union. Updating it onto `main` first is what made them green, and
nothing about that redness turned out to be a defect.

**One thing 9 did not anticipate at all.** Every deviation in §7d was found at the
merge rather than predicted by either rehearsal, and three of the four were found
by *reading code the merge forced me to open* rather than by a gate going red —
PR 8's silent 201, PR 9's pointer to a nonexistent test, and PR 11's `useRole.ts`
comment naming a function the same commit deleted. The rehearsals were built to
predict conflicts and pins, and they did that well. They were not capable of
predicting these, because in each case both parents were green and the merged tree
was green too. The practice that actually caught them is the one L112 recommends:
**verify every premise against the merged tree rather than against either parent**,
including premises that have nothing to do with the conflict in front of you.

---

Do not merge. Do not use `gh`. Do not deploy anything.
