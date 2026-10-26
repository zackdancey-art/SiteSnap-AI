# Workstream 6 — Bin and retention

Branch `feat/bin-retention`, four commits on top of the two already on it. Soft delete with restore, and a purge that has never been run against anything.

**Nothing irreversible was executed.** No migration in this PR rewrites or drops a row; migration 034 adds a nullable column. The purge script has never been invoked — not against production, not against a test database, not at all. There is no Postgres in the environment this was built in, so it could not have been, and the one thing I would have had to stop for never arose.

---

## Finding first: the purge could never have purged anything

The first version of `scripts/purge-deleted-rows.ts` opened a bare `new Pool(...)` and issued its counts and its `DELETE`s on it. That is wrong in a way that produces no error.

All five soft-deletable tables are `FORCE ROW LEVEL SECURITY`:

| table | migration |
|---|---|
| `incidents` | 019 |
| `project_sites` | 022 |
| `material_deliveries` | 025 |
| `crew_timecards` | 025 |
| `inspections` | 025 |

Each with a policy of `company_id = current_setting('app.company_id', true)`. `FORCE` subjects the table owner, and the API connects as the owner. On a connection with no `app.company_id` set, `current_setting(..., true)` returns NULL, `company_id = NULL` matches no rows, and Postgres raises nothing.

So the script would have counted **zero eligible rows for ever**, printed `Nothing is eligible.`, and exited 0. A purge that reports success and has never once been capable of deleting a row — and, worse, one whose entire job is to act on that count. Every gate below it would have read correct. The dry run would have looked like a clean bin.

This is AUDIT L99 in a new place: a hand-built predicate that silently matches nothing. The difference is that L99 cost months of broken site progress, and this would have cost a retention promise that was never kept while reporting that it was.

**Migration 025 names this exact trap in its own comments, about its own backfill.** It was written down, in the right file, and I still wrote the bug.

### How it was found, and how it was not

Not by running it. By reading migrations 019, 022 and 025 to write the PR body's table of which tables are RLS-forced, and noticing that the list I was about to publish was a list of tables my own script could not see.

### The fix, and the thing I deliberately did not do

The script now enumerates `companies` — the tenant root, migration 014, the one operational table with no RLS — and does both passes with `app.company_id` set per company, via the same `set_config(..., is_local => true)` that `storage/tenant.ts` uses.

Because that setting is **transaction-scoped rather than statement-scoped**, one transaction still spans every company with the tenant reset between them. The all-or-nothing guarantee the operator is promised survives being scoped; it is not degraded into a per-company commit.

It does **not** lift `FORCE` to read across companies. CLAUDE.md §10 and migrations 024 and 025 establish that as a legitimate move for a migration that needs a cross-company read, and I considered it. Two reasons not to, here:

- `ALTER TABLE ... NO FORCE ROW LEVEL SECURITY` takes an ACCESS EXCLUSIVE lock on a hot production table.
- A hand-run destructive script is the worst place in the codebase to put the power to disable tenant isolation. If it is in the file, it is one `--help`-reading mistake from being used.

Scoping per company also bounds the blast radius of any bug in it to one tenant.

It does not use `withTenant()` itself, because `withTenant` reaches `DATABASE_URL` through `getPgPool()`, and gate 1 forbids this script from ever reading `DATABASE_URL`.

### The limitation I am stating rather than engineering around

A row whose `company_id` is NULL — orphaned, which migration 025 leaves possible on purpose — matches no company's policy, is invisible to every pass, and is therefore **never purged**. It cannot even be counted, because counting it would itself need `FORCE` lifted.

That fails safe, and the script's header says so. It is **reported, not repaired**: this is a compliance-evidence product and what happens to an orphaned record is your decision, not a script's. Consistent with the standing instruction not to delete, backfill or clean up these records.

---

## The same defect a second time, in my own test — caught by the lint rule

Four reads in the new DB-gated suite `routes/site-bin-db.test.ts` were written as bare `pool.query` against `project_sites` and `project_entries`. Both are FORCE RLS (migration 022). All four would have matched zero rows.

Two of them would have **failed**, which is survivable — a red test gets fixed.

The third is the one that matters. The partition test asserts that `liveOnly` and `deletedOnly` together account for every `project_sites` row. With both reads returning nothing it would have evaluated `0 + 0 === 0` and **passed**. A vacuous assertion, in the suite guarding the only destructive feature in the phase, reporting the guarantee as checked.

There is no Postgres here, so nothing would have run it and nothing would have disagreed. What found it was `eslint`:

```
Projects/services/api/src/routes/site-bin-db.test.ts
  49:1  error  '../storage/postgres' import is restricted from being used by a pattern. Import a store
               from storage/ instead of the raw pool. getPgPool() bypasses withTenant(), so the query
               runs without app.company_id and RLS fails closed — zero rows on read, WITH CHECK
               violation on insert, no error at the call site. If you genuinely need an untenanted
               connection (migrations, shutdown, health probes), add the file to the exemption list in
               .eslintrc.js and say why  no-restricted-imports

✖ 1 problem (1 error, 0 warnings)
```

The rule's message describes the failure mode I had just written, in the words I needed to read. **That is the argument for the rule existing**, and it is why the exemption I then added is a paragraph and not a filename on a list — the next person to reach for a bare pool read in a test is its audience.

Every tenanted read in that file now goes through `withTenant` via one local helper, and the partition test gained a control asserting the table held at least three rows when it was measured, so the `0 + 0 === 0` shape cannot come back silently.

Four reads stay on the bare pool deliberately, and the exemption says why: `applyMigrations`; four `information_schema` queries (which prove `deleted_at` exists with the right type and nullability, **and that it does not exist** on the tables the registry calls hard-deleted); and two reads of `auth_users`, which carries no RLS and is therefore the one table that can supply the tenant for all the others.

---

## Finding: the cascade was already defeating the soft delete that existed

Nine tables cascade from `project_sites` with `ON DELETE CASCADE`:

`project_entries`, `project_diaries`, `project_templates`, `site_members`, `site_invites`, `crew_timecards`, `incidents`, `inspections`, `material_deliveries`

Four of those — `crew_timecards`, `incidents`, `inspections`, `material_deliveries` — have carried their own `deleted_at` since their `CREATE TABLE` in migrations 009 and 010, because they hold compliance evidence and evidence a user can erase is not evidence.

The cascade went around it. A manager deleting a site destroyed every timesheet, incident, inspection and delivery under it, past the soft delete that was there to prevent exactly that. The soft delete on those four tables protected them from being deleted individually and not at all from being deleted collectively.

**So the bin is not only a new feature; it closes a hole in a guarantee that was already claimed.** A site in the bin cascades nothing, because nothing is deleted yet.

---

## Finding: the dependency on workstream 1 is a file conflict, not a schema one

Workstream 6 "depends on workstream 1, because both touch soft-delete columns on the same tables." Checked: **workstream 1 adds no soft-delete column.** Migration 032 adds clients and the `project_sites.client_id` reference; it does not touch `deleted_at`.

The real dependency is a **merge conflict in three files** — `storage/projectsStore.ts`, `routes/projects.ts` and `apps/mobile/lib/types.ts` — both branches edit the same functions and the same type. Merge workstream 1 first and this rebases cleanly; merge this first and workstream 1 conflicts in the same three places. Recorded in `MERGE-ORDER-COUNTERS.md`.

---

## Finding: the 30-vs-90-day retention question was already closed

`BIN_RETENTION_DAYS = 90`. `docs/AUDIT.md:769` records "Deleted account data is permanently purged within 30 days" — which looks like a contradiction. It is not: that line is a *finding* about a published promise with no mechanism behind it, and `:886` records that those four promises were **"all of them now rewritten rather than fixed."**

Verified rather than assumed. Grepping both clients for "30 days", excluding cookie/session/`maxAge` hits, returns nothing:

```
/usr/bin/grep -rn '30 days' Projects/apps/mobile Projects/apps/supervisor-web --include='*.ts' --include='*.tsx'
→ (no shipping copy; only session/cookie lifetimes)
```

So no shipping text contradicts 90, and the number is free to be whatever the retention policy says. **If the published policy should say 90, that is a website change and it is not in these nine workstreams — flagging it rather than editing it.**

---

## What was built

### `storage/softDelete.ts` — the registry, extended

The registry itself landed in the two earlier commits on this branch (`15b9dce`, `585363f`): the set of soft-deletable tables declared once as a const tuple, `SoftDeletableTable` derived from it, every predicate helper taking that type so `liveOnly("project_entries")` is a compile error, the column name appearing exactly once, a DB-gated test asserting the set equals the schema **in both directions**, and an eslint rule banning the literal `deleted_at` in SQL anywhere else.

That is the answer to *"make the set of soft-deletable tables explicit and derive the predicate from it, so the next hand-written literal is impossible rather than merely unlikely."* It is impossible in three independent ways: it will not type-check, it will not lint, and the schema test disagrees with it.

This PR adds the three things the bin and the purge need from the same place:

- `BIN_RETENTION_DAYS = 90` — one constant, so what the bin tells a person and what the purge acts on cannot drift
- `purgeEligible(table)` — the interval built from that constant, never written out
- `daysInBin(deletedAt, now)` — for display, in the API rather than in two clients

### The routes

| route | gate | what changed |
|---|---|---|
| `DELETE /projects/sites/:id` | manager+ (unchanged) | sets `deleted_at`, cascades nothing. Still `DELETE`, still 404s when it does nothing, so no client has to change to keep working. Response gains `binned: true` and `retentionDays`; `ok: true` is kept for callers that only check that |
| `GET /projects/sites/bin` | `requireAtLeast("manager")` | **new.** lists what is in the bin with `daysInBin` and the retention period |
| `POST /projects/sites/:id/restore` | `requireAtLeast("manager")` | **new.** takes one back out |

The 404 on restore deliberately covers both "no such site" and "that site is not in the bin". Distinguishing them would tell a caller which site ids exist in another company.

Both new routes are manager+ to match who may bin a site in the first place — the same people can undo it, and nobody else can see what is in there.

### Every read that should stop showing a binned site

`listSites`, `canManageSite`, `updateSiteProgress`, the dashboard join, `listEntries` and `listDiaries`.

The entries and diaries filters use the `onLiveSite()` correlated `EXISTS` rather than a column of their own, because those tables have no `deleted_at`. Without it, binning a site would leave its entries in the field app's feed belonging to a site that is no longer listed, with no way to open or restore them — worse than either state alone.

**Account deletion and `resetProjectStoreForTests` still hard delete, by design.** One is the deletion the law requires to be real; the other is a test fixture.

### The purge, and its five gates

In order:

1. `PURGE_DATABASE_URL` must be set. **`DATABASE_URL` is never read**, at all, by this file.
2. It refuses if the two are equal.
3. It requires `PURGE_I_UNDERSTAND_THIS_DESTROYS_RECORDS=yes` — spelled out; `y`, `YES`, `true` and `1` are all refused, and the test loops them.
4. It is a dry run unless `--execute`.
5. `--execute` requires `--expect=<n>` matching the number the dry run just measured, live, in the same transaction.

Two more that are not numbered because they are structural:

- The counting pass runs under `BEGIN READ ONLY`. The measurement phase of a destructive script cannot write, and the guard test asserts the first statement is exactly that string.
- An empty `companies` table is a **refusal, not a zero**. With no tenant to scope by, every count reads zero whatever the bin holds, and reporting that as "nothing to purge" would be reporting a measurement it never took.

### `PURGE_ORDER` is declared, not inherited

Deleting a `project_sites` row cascades to the four child tables that are themselves soft-deletable. If the parent went first, the cascade would destroy rows a later statement was counted on to match, `deleted` would come up short of `measured`, and the run would roll back. Children before parents is load-bearing.

`SOFT_DELETABLE_TABLES` is alphabetical and *happens* to satisfy that today. That is not a reason to depend on it — it is the same class of invisible dependency as the hand-written literal. `PURGE_ORDER` states the order, and is asserted **at module load** to be a permutation of the registry ending in `project_sites`, so adding a sixth table without placing it fails loudly rather than deleting in the wrong order quietly.

---

## Block B — the last six inches

Every route, and the client file and line that calls it.

| route | called from | reached from |
|---|---|---|
| `GET /projects/sites/bin` | `apps/mobile/lib/data-context.tsx` — `listBinnedSites()` | `apps/mobile/app/settings/site-bin.tsx`, on focus |
| `POST /projects/sites/:id/restore` | `apps/mobile/lib/data-context.tsx` — `restoreSite(id)` | `apps/mobile/app/settings/site-bin.tsx`, the Restore button |
| `DELETE /projects/sites/:id` | `apps/mobile/lib/data-context.tsx` — `deleteSite(id)` (pre-existing) | `apps/mobile/app/site/[id].tsx`, the delete dialogue |

The bin screen is reached from `apps/mobile/app/(tabs)/settings.tsx`, behind `canSeeSiteBin` — manager+, matching both routes exactly. That match is why it is a function in `lib/permissions.ts` and not a condition in the screen: **a Settings row leading to a screen that can only 403 is worse than no row**, because the person reads it as the feature being broken rather than as not theirs.

`permissions.test.ts` cross-checks `canSeeSiteBin` against `canDeleteSite` for every role, so the client gate and the server gate cannot drift apart without a test failing.

### The one thing here with no caller, on purpose

`scripts/purge-deleted-rows.ts`. A route with tests and no caller counts as not built; a destructive script with no caller is the requirement. `scripts/purge-script-is-unreachable.test.ts` is what keeps it that way — it fails the build if any API source file, any compiled module in `dist/`, any `package.json` script, the `Dockerfile`, a workflow step or a repo script so much as names the module.

A comment claiming "hand-run only" survives exactly one person adding a convenience script. A test does not.

---

## Red-on-revert proofs

Four, each with the failing output as it was printed, and each restore verified byte-identical with `shasum -a 256 -c` before the next one started.

### A — the tenant must be set before every statement against an RLS-forced table

This is the proof for the headline finding. Replaced `await setTenant(client, companyId);` in `countEligible` with `void companyId;`.

```
not ok 176 - the tenant is set before every statement that touches an RLS-forced table
  ---
  duration_ms: 0.919833
  location: '.../dist/scripts/purge-script-is-unreachable.test.js:219:22'
  failureType: 'testCodeFailure'
  error: "statement ran with no tenant set, so RLS would match zero rows: SELECT COUNT(*) AS n FROM crew_timecards WHERE deleted_at < NOW() - INTERVAL '90 days'"
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: true
  actual: false
  operator: '=='
  ...
# tests 233
# pass 212
# fail 1
# skipped 20
```

One failure, 212 still passing. The failure message names the statement that would have matched zero rows, which is the information whoever breaks this next will need.

Restored: `purge-deleted-rows.ts: OK`.

### B — nothing may import the purge script

Added `import "../scripts/purge-deleted-rows";` to `storage/softDelete.test.ts`. A **bare side-effect import** on purpose: that is the shape someone reaches for when they want a module's top-level behaviour, and it is the shape that would most plausibly arrive by accident.

```
not ok 170 - nothing in the API source imports the purge script except this test
  ---
  error: |-
    something now imports purge-deleted-rows.ts. It destroys compliance records and is meant to be
    reachable only by a person typing its name. If this import is deliberate, the script's header doc
    and this test both have to change in the same commit.
    + actual - expected

    + [
    +   'Projects/services/api/src/storage/softDelete.test.ts'
    + ]
    - []
  operator: 'deepStrictEqual'

not ok 171 - no compiled module that ships reaches the purge script, and the build does compile it
  ---
  error: |-
    a compiled module that ships now requires the purge script, so the running server can reach code
    that destroys compliance records. Nothing but this test may.
    + actual - expected

    + [
    +   'storage/softDelete.test.js'
    + ]
    - []
  operator: 'deepStrictEqual'
  ...
# tests 233
# pass 211
# fail 2
# skipped 20
```

Both halves fired — the source-tree check and the compiled-output check — which is what I wanted, because they fail for different reasons and one could rot without the other.

**This proof found a real gap before it ran.** The source-tree pattern required `from`, so the bare side-effect import would have gone past it unseen. Tightened to `(?:from|import|require)\s*\(?\s*"[^"]*<module>"` first; the proof then confirmed the tightened version catches it. The proof I ran to check the test was the proof that the test had a hole.

Restored (see the restoration note below): sha `OK`, `git diff --stat` empty.

### C — the client-side bin gate

`canSeeSiteBin` → `return true`.

```
not ok 32 - the three exceptions refuse crew and allow the roles that own them
  ---
  location: '.../apps/mobile/dist-test/lib/permissions.test.js:68:22'
  error: |-
    Expected values to be strictly equal:

    true !== false

  expected: false
  actual: true
  operator: 'strictEqual'
  ...
# tests 116
# pass 115
# fail 1
# skipped 0
```

**That output is why the assertions now carry messages.** `true !== false` tells whoever broke it nothing — not which role, not which permission, not whether the gate moved or the test did. All four `canSeeSiteBin` assertions gained a message naming what the API does, and the suite re-ran 116/116.

Restored: `permissions.ts: OK`.

### D — the purge ordering guard

Removed the parent-last clause from `assertPurgeOrderCoversRegistry`.

```
not ok 179 - the purge order is exactly the registry, reordered, with the parent last
  ---
  error: 'Missing expected exception.'
  code: 'ERR_ASSERTION'
  operator: 'throws'
  ...
# tests 233
# pass 212
# fail 1
# skipped 20
```

Restored: `purge-deleted-rows.ts: OK`.

### A note on proof B's restoration, because it went wrong

The restore deleted one line too many. The injection used `sed -i '' '1i\'` (one line in); the restore used `sed -i '' '1,2d'` (two lines out), which took the injected import **and the `/**` opening the file's doc comment**. `git diff` reported `1 deletion(-)` and that is what caught it. Re-inserted the `/**`, then verified both ways — `shasum -a 256 -c` returned `OK` and `git diff --stat` was empty — before running proof C.

Recording it because the proof programme is only worth anything if the restores are real, and "I restored it" is an assertion where `shasum -c` is a measurement.

### Earlier on this branch

Two more red-on-revert proofs were taken in the earlier window for the registry commits, and are in the branch's history rather than this window's logs:

- Reinstating a hand-written `deleted_at` literal in `routes/async-route-errors.test.ts` → `no-restricted-syntax` error quoting L99 in full, exit 1.
- The **pre-034 state is itself the proof** for the schema half: before migration 034, test 194 of the soft-delete schema suite failed because `project_sites` was in the registry without having the column. The test disagreed with the schema in the direction that catches an un-migrated registry entry.

---

## Three positive controls that failed first, which is the point of having them

Not reverts — these fired on the first run of the new guard test, and all three were the test's fault rather than the code's. Recording them because a control that has never been seen to fail is not known to be load-bearing.

1. **The softDelete-importer control.** Asserted ≥5 files import `storage/softDelete`; matched 4. The pattern was `/from "[^"]*storage\/softDelete"/`, and 7 of the 11 importers live *in* `src/storage/` and write `"./softDelete"`. Fixed to match the module basename.
2. **The server-reachability control.** Looked for `require(".*routes/` in `dist/server.js`; `server.js` requires the **barrel**, `require("./routes")`, so reachability is transitive and cannot be read off the entry point. Rewritten to walk all of `dist/`.
3. **`storage/softDelete.js` flagged as a caller.** tsc does not strip doc comments, so `softDelete.ts`'s sentence *"See scripts/purge-deleted-rows.ts"* was carried into `dist/` and matched a substring search. Fixed to match an actual `require("…")` call shape — a comment pointing at the script is exactly what should be there.

---

## What is not defended by a test, said plainly

**The DB-gated suite in this PR has never been executed.** There is no Postgres and no Docker in this environment, so `routes/site-bin-db.test.ts` — 13th in the gated set — has only ever registered as a skip. Its assertions rest on static reasoning about the migrations plus the lint rule that caught the RLS mistake. **CI is the first thing that will run it**, against the `postgres:16` service container in `Projects/scripts/ci.sh`. If it is wrong, that is where it shows.

I am stating this rather than letting "13 DB suites" read as "13 DB suites passed". The 20 in-memory skips are reconciled below precisely so the difference is visible.

The purge's actual deletion behaviour against a real database is likewise unverified by execution, by design — it is the stop-condition-2 feature and running it is not mine to do.

---

## The guard test is in-memory, against the standing default

New tests default to DB-gated and this one is not, deliberately.

Every assertion in `purge-script-is-unreachable.test.ts` is pure logic, static parsing of the repository, or a fake client recording a call sequence. None of it touches a store. The two properties that matter — **tenant-before-every-statement** and **children-before-parents** — are orderings, and a fake client proves an ordering exactly and completely.

A Postgres connection would add nothing, and would make the one test guarding a destructive script depend on the one environment that cannot run it. The test's header says this, in those terms, so the next reader does not "fix" it by gating it.

If the full-suite-against-Postgres cost-out in workstream 8 changes the default, this file is unaffected either way.

---

## Gate

Measured, on the branch tip, after the last restore.

```
pnpm -C Projects run typecheck                     → exit 0  (4 packages; shared skipped as 4-of-5)
pnpm -C Projects run lint --max-warnings=0         → exit 0
pnpm -C Projects --filter apps-mobile run test     → exit 0
pnpm -C Projects --filter services-api run test    → exit 0
```

API, in-memory:

```
run-tests.sh: in-memory suite — 49 file(s)
# tests 233
# pass 213
# fail 0
# skipped 20
run-tests.sh: 20 skip(s), as expected — each runs for real under test:db / test:redis / test:openai
```

Mobile:

```
run-tests.sh: 116 test(s) passed, 0 skipped
```

**No skipped test without an explanation.** All 20 reconcile to the three gated counters, enumerated from the run rather than asserted:

| group | count | why skipped |
|---|---|---|
| `TEST_DATABASE_URL` suites | **13** | no Postgres in this environment; run in CI |
| `REDIS_TEST_URL` tests | 4 | no Redis |
| `OPENAI_LIVE_TEST_KEY` tests | 3 | opt-in, billable, deliberately not in CI |

13 + 4 + 3 = 20. `EXPECTED_DB_SUITES` moves **12 → 13** in the same commit as the suite that needs it, which is the point of the counter. `ok 150 - the bin (skipped: set TEST_DATABASE_URL)` is the new one.

### Pinned counters, all measured

| counter | file | value |
|---|---|---|
| `EXPECTED_DB_SUITES` | `services/api/scripts/run-tests.sh` | **13** (was 12 on this branch, 11 on `origin/main`) |
| `EXPECTED_TEST_FILES` | `apps/mobile/scripts/run-tests.sh` | **16** |
| `EXPECTED_TESTS` | `apps/mobile/scripts/run-tests.sh` | **116** |
| `EXPECTED_ROUTES` | `apps/mobile/lib/screen-header-audit.test.ts` | **34** |
| `EXPECTED_SCREEN_HEADER` | `apps/mobile/lib/screen-header-audit.test.ts` | **12** |

Every one read off a run, not incremented by hand. `EXPECTED_NATIVE_HEADER` (9) and `EXPECTED_LAYOUTS` (2) are unchanged, and the new screen uses `ScreenHeader`, which is why.

There is **no in-memory total-test pin** in the API harness — the memory-mode expectation is derived as the sum of the three gated counters — so the new in-memory suite correctly needs no counter change.

### Flakes

The two rate-limit suites that are flaky under load (`rate-limit-abuse.test.js`, `rate-limit-redis-connecting.test.js`) **did not fire in any of this window's runs**, proof runs included. Not asserting they are fixed; recording that they were not the reason for anything above.

---

## Deploys this needs

**API** and **`eas update`**. No portal deploy. No native build.

Per item:

| item | deploy | native rebuild? |
|---|---|---|
| migration 034 (`project_sites.deleted_at`) | API — runs at boot | no |
| the three routes | API | no |
| the live-only read filters | API | no |
| the bin screen, the Settings row, the dialogue copy | `eas update` | **no** — JS-only, no `app.json`, no plugin, no `infoPlist` change |
| the purge script | **none.** it ships compiled into `dist/` and nothing can reach it | no |

### The portal needs no deploy, and verified rather than assumed

The portal issues no `DELETE` at all and references no bin or restore route:

```
/usr/bin/grep -rn 'method: *"DELETE"' Projects/apps/supervisor-web --include='*.ts' --include='*.tsx'
→ (nothing)
```

It reads `/api/projects/bootstrap`, which calls `getScopedBootstrap` → `listSites` / `listEntries` / `listDiaries` (`storage/projectsStore.ts:945`), **all three of which now filter binned sites.** So the portal stops showing a binned site and its entries on the API deploy alone, with no portal code change. That is the correct behaviour and it arrives for free.

### The split is safe **in one direction only** — API first

**API before `eas update` is safe.** An older mobile build calls `DELETE` and gets the bin behaviour; the route still returns `ok: true` and still 404s when it does nothing, so nothing breaks. The one wrong note is the old delete dialogue saying the records are removed when they are kept — inaccurate, in the reassuring direction, and corrected by the update.

**`eas update` before the API is broken.** The bin screen would call `GET /projects/sites/bin` against an API that does not have it, get a 404, and show its error state. A manager would open "Deleted Sites" and read a failure.

So: **API first, then `eas update`.** They do not have to ship together, and there is no window in which anything is lost — but the order is not interchangeable. Worth saying loudly because the batching convention is "portal deploy and `eas update` batched by the owner", and this is the case where the batch must land *after* the API rather than alongside it.

---

## Decisions I made that you might want back

- **90 days** for `BIN_RETENTION_DAYS`. Reasoning above; it contradicts no shipping copy. If the published policy should match it, that is a website change outside these workstreams.
- **The purge is wired to nothing, and a test enforces that.** If you ever want it on a scheduler, the test is what you change first — deliberately, so that wiring it is a decision in a diff and not a side effect. It is a one-line change plus an honest edit to two doc comments.
- **Restore is manager+, matching delete.** Not author-or-manager like L86's revert-to-draft, because binning a site is not authored work.
- **Restore's 404 does not distinguish "not found" from "not in the bin."** Tenancy, not UX.
- **`CLAUDE.md` was not updated.** It still carries `EXPECTED_DB_SUITES=11` and "18 skips" as reader orientation, with a dated note saying the script is the authority. Three branches now move that number and whichever merges last would be the only one left correct; it belongs in one commit after the merges, not in four conflicting ones. Flagged rather than done.

## Still open, for you

- Whether the purge should ever run on a schedule, and if so what wakes it.
- What happens to a row with a NULL `company_id`. The script reports them and purges nothing; it needs your decision, not a default.
- Whether the published retention copy should be made to say 90.

---

Do not merge. No `gh` was used. Nothing was deployed. The purge has never been executed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
