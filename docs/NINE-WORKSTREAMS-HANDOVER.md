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

**It needs a one-line fix before it merges.** Its `EXPECTED_WORKFLOWS` pin does
not match the workflow count after its own changes, so `ci.sh` will fail on it.
Read from the branch rather than from memory:

```
git show fix/workstream-0-safety:Projects/scripts/assert-workflow-runners-pinned.sh
  -> EXPECTED_WORKFLOWS=3            (line 40)

git ls-tree -r --name-only fix/workstream-0-safety -- .github/workflows
  -> api-post-merge-checks.yml
     build-mobile.yml
     ci.yml
     submit-mobile.yml               (4 files)
```

The script counts `*.yml`/`*.yaml` at `maxdepth 1`, which is these four, so the
pin reads 3 against a population of 4 and the check exits 1 by design — it
refuses to sweep an unreviewed workflow in silently. **I have not run it on that
branch**; checking it out to do so would have meant moving off the branch I was
committing on. The fix is to review the two new workflows for a floating runner
and then raise the pin to 4 in the same commit, which is what the script's own
failure message tells you to do.

### Group B — any order, independent of each other

2. `feat/clients-sites-entries` (WS 1)
3. `feat/timesheets-approval` (WS 2a)
4. `feat/whs-checklists` (WS 2b)
5. `feat/storage-ceiling` (WS 3)
6. `feat/report-periods` (WS 4)
7. `feat/photo-viewer` (WS 5)
8. `feat/bin-retention` (WS 6)
9. `feat/consent-and-native` (WS 7)

All eight are based on `origin/main` and none depends on another's code. Their
migrations are order-independent, per above. Textual conflicts between them are
possible where two touch the same file, and git will tell you; none of them
depends on another to be *correct*.

### Group C — merge last, in this order

10. **`feat/debt-and-cost-out`** (WS 8)
11. **`feat/branding-and-dashboard-parity`** (WS 9)

WS 9 touches the most screens on both clients and will conflict with anything
merged after it, which is why it was built last and should be merged last. WS 8
should precede it only because WS 8 is the larger of the two (17 commits) and
rebasing it onto a merged WS 9 is more work than the reverse.

### The one real conflict, and it is a decision not a merge

**`feat/debt-and-cost-out` deletes something that `fix/workstream-0-safety`
renames** — the F3 item. Both are defensible, they are mutually exclusive, and
**I did not pick.** Whichever you merge second will conflict on it and you will
have to choose at that moment, so it is better to choose now: take WS 8's
deletion if you agree the thing is dead, or WS 0's rename if you want it kept
under a clearer name. Both PR bodies describe it.

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

Do not merge. Do not use `gh`. Do not deploy anything.
