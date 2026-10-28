# The store-divergence cost-out

**Owed since Phase 2, dropped from three reports, settled here.** Recorded 26 October 2026 on
`feat/debt-and-cost-out` (workstream 8).

The question, as asked:

> Running the whole suite against Postgres in CI, versus reducing the in-memory store to a fake thin
> enough that it cannot diverge. What each costs to do, what each costs to keep, and what each would
> have caught of the seven defects that have hidden in that gap. Then pick one and build it, saying
> which and why.

**The answer is A, and it is built.** `pnpm run test:all-db` is in
`services/api/scripts/run-tests.sh` as of this branch. It is deliberately not wired into CI yet; the
last section says what has to happen before it is, and that is one line when it does.

This document exists because the recommendation rests on one argument that is easy to lose, so it is
stated first and then defended:

> **B makes the two stores agree by deleting the one that is wrong about things, and the one that is
> wrong about things is the one that ships.** Of the seven defects, three are defects in the SQL
> itself. B never executes SQL. It cannot see them, and no amount of thinning the fake changes that.

---

## 1. The two options, as specified

**Option A — run the whole suite against Postgres.** Every test file, including the 35 that have
only ever run against the in-memory store, executed with `TEST_DATABASE_URL` set so each store takes
its Postgres branch. The in-memory store stays in the tree for dev, but for the length of that CI job
it is unreachable.

**Option B — reduce the in-memory store to a fake too thin to diverge.** Strip the in-memory branches
back to naive maps with no predicates, no authorization logic and no business rules, so there is
nothing in them that *can* disagree with the SQL, and let the tests assert behaviour only where the
fake is trivially faithful.

---

## 2. What each costs to do — measured where measurable, and labelled where not

### Option A

| input | figure | how it was obtained |
|---|---|---|
| test files in the suite | **46** | `find Projects/services/api/src -name '*.test.ts' \| wc -l` |
| of those, already DB-gated | **11** | `grep -rl '!process.env.TEST_DATABASE_URL' --include='*.test.ts'` |
| files that would run against Postgres for the first time | **35** | 46 − 11 |
| files holding shared global state between tests | **29** | `grep -rl 'ForTests()' --include='*.test.ts'` |
| the mechanism itself | **57 lines** of `run-tests.sh`, one line of `package.json` | `git show` on this branch's third commit |

**Cost to build the mechanism: done, and it was an hour.** That is the whole of what option A costs
to *write*. The script selects every file instead of the guarded subset, refuses to run without
`TEST_DATABASE_URL` (so it cannot pass vacuously against the in-memory store it is meant to
displace), and derives its expected-skip count from the two counters already in the file rather than
writing a third.

**Cost to get it green: UNMEASURED, and that is the honest answer.** Its first run against a real
database is expected to be red, because 35 of these files have never executed a line of this
project's SQL. The size of that failure list cannot be known from here — there is no Postgres in this
environment, so the happy path has not run once. Anyone quoting a figure for it would be inventing
one. What *is* known is the shape of the work: each failure is either a real divergence (fix the
store), a test asserting an in-memory artefact (fix the test, as L87 and L101 both were), or a
fixture that needs tenant context (wrap it in `withTenant`). None of those three is research.

**Cost in CI wall clock: UNMEASURED.** The mode runs `--test-concurrency=1`, so 46 files run
sequentially against one database. The only timing I can measure here is the in-memory run — **12.1
seconds for 46 files in parallel** — and that number says nothing useful about the sequential
Postgres case. The Phase 2 cost-out priced the alternative to sequential execution (namespacing
twenty-six files so they can share a database concurrently) at two to four days. Sequential execution
buys that out with wall clock, which CI has and which the namespacing work does not give back.

### Option B

| input | figure | how it was obtained |
|---|---|---|
| store modules with a dual path | **11** | script over `src/storage/*.ts` |
| `if (!useDatabase())` branches | **97** | same |
| lines of in-memory branch code to be reduced | **903** | same, counting each branch to its matching brace |
| the two largest | `projectsStore.ts` 29 branches / 389 lines; `authStore.ts` 27 / 253 | same |

**Cost to build: larger than A by an order of magnitude, and it is the kind of large that does not
decompose.** 903 lines across 97 branches is not a mechanical trim. Each branch has to be read
against its SQL twin to decide what is business rule (must survive, which means it must survive
*identically*, which is the divergence being eliminated) and what is incidental (can go). Phase 2
sized this and it is the reason this cost-out was owed rather than answered.

**And it has a prerequisite A does not.** Thinning a branch is only safe if the tests standing on it
are rewritten at the same time, because a test asserting a rule the fake no longer enforces does not
fail — it passes, differently. 29 of 46 files reset store state through `*ForTests()` helpers, which
is the surface area of that rewrite.

---

## 3. What each costs to keep

**A: nothing to maintain.** The mode is a file selector and a derived counter. It owns no behaviour.
When a suite is added it is included automatically — no list to update, which is the opposite of the
three pinned counters this script already carries and the merge traps they produce.

What A costs to keep is *wall clock*, forever, and the discipline not to add a second definition of
the gate (`scripts/assert-ci-single-definition.sh` already enforces that).

**B: a permanent, silent, hand-maintained obligation — which is the exact failure mode being
priced.** A fake that must stay behaviourally faithful to SQL it does not execute is a second
implementation under another name. Every future store change has to be mirrored into it by hand, and
nothing reports the disagreement. That is the sentence that describes all seven defects below. **B
does not remove the divergence class; it renames it and promises to be careful.**

There is one exception, and it is worth naming because it is the strongest thing that can be said for
B: where the shared rule can be made *data* rather than code, B's idea works completely.
`storage/recordScope.ts` is exactly that — one frozen table (`RECORD_CLASS`, `SITE_SCOPED`) drives
both the in-memory predicate (`canEditRow`, `canReadRow`) and the SQL generator
(`editOwnershipSql`, `readVisibilitySql`), so the authorization-divergence class is closed
structurally and not by anybody remembering. **That is B, applied to the subset where it is sound,
and it is already in `main`.** The argument below is not that B's idea is wrong. It is that B's idea
has already been spent where it pays, and what remains is the part it cannot reach.

---

## 4. The seven defects, scored against both options

The seven instances of the shape (`docs/AUDIT.md` calls it "L65's shape"; L102's heading numbers it
the seventh):

| # | finding | what diverged | **A catches?** | **B catches?** |
|---|---|---|---|---|
| 1 | **L65** — `acceptSiteInvite` attached nobody to a company on Postgres and reported success | the SQL was wrong; the in-memory path was right | **YES** — the existing accept tests, executed against Postgres, fail on the read-back | **NO** — the fake attaches correctly, exactly as the in-memory store already did. The defect is in SQL B never runs |
| 2 | **L87** — the in-memory store had a `site_members` escape hatch Postgres did not, and a test was passing on it while asserting a cross-company read | the in-memory path was wrong | **YES** — the test flips the moment it runs against a store without the hatch | **YES** — the hatch is precisely the kind of extra rule a thin fake would not have |
| 3 | **L88** — `updateSiteProgress` refused every crew member in memory and allowed every crew member in Postgres | both paths had a rule; the rules differed | **YES** — the in-memory assertion fails against Postgres | **YES** — with no rule in the fake, the only rule left is the SQL's, so there is nothing to disagree |
| 4 | **L89a** — `incidentStore.updateIncident`: authorship checked in memory, absent in SQL | SQL missing a rule | **YES** | **YES** |
| 5 | **L89b** — `inspectionStore.updateInspection`: same | SQL missing a rule | **YES** | **YES** |
| 6 | **L90** — the timesheet query ORed in `site_members`, so a crew member could read a colleague's pay | SQL had a rule nothing in memory had | **ONLY IF ASSERTED** — see the limit below | **NO** — a rule present only in the SQL is invisible to a fake, by construction |
| 7 | **L102** — the Postgres accept path stamps `auth_users` without evicting the cached identity; the in-memory path evicts | the SQL path skipped a step | **YES** — an accept test that re-reads the identity fails against Postgres within the 60-second TTL | **NO** — the fake's write and the cache eviction are the same code path; nothing to catch |

**Tally: A catches 6 of 7 outright and the seventh conditionally. B catches 4 of 7 — and those four
(L87, L88, L89a, L89b) are the four already closed structurally by `recordScope.ts`.**

So the honest comparison is not 6 against 4. It is: *of the three B cannot catch — L65, L90, L102 —
two are CRITICAL/HIGH tenancy defects that reached production, and all three are defects in SQL that
B structurally never executes.* Against that, B's four are the ones a frozen shared table has already
taken care of.

### A's limit, stated plainly

**A catches divergence, not absence.** It executes the SQL, so it finds every place the SQL disagrees
with an assertion that exists. It finds nothing where no assertion exists at all — L90 is the example:
no test asserted that a crew member cannot read a colleague's timesheet, so no store could have
failed one. L90 was found by reading, and that is the only way it could have been found.

This matters because it bounds what turning A on is allowed to buy politically. A does not mean the
stores are now proven; it means a specific, repeatedly-fatal class of lie is no longer free. The
companion defences are not optional and are not replaced by it:

- **`storage/recordScope.ts`** — one frozen table drives both predicates, so authorization cannot
  diverge even in a test nobody wrote.
- **`storage/sqlSchemaAudit.test.ts`** (this branch) — every SQL column reference in the API is
  checked against the schema the migrations declare, statically. This is the L99 class: a predicate
  naming a column no table has. 23 tables, 255 columns, 122 DML statements, 603 resolved references,
  2 declined and both inspected. It needs no database, which is why it can run in the in-memory job
  and gate every PR today.
- **`storage/store-roundtrip.test.ts`** — the real full-column INSERT against a boot-migrated
  Postgres. The only thing that catches a `CREATE TABLE IF NOT EXISTS` no-op column (L11), which no
  static audit can.

A is the fourth of these, not a replacement for the other three.

---

## 5. The decision

**Option A. Built on this branch.**

Three reasons, in order of weight:

1. **B cannot see the majority of the harm.** Three of the seven — including the CRITICAL that
   explains why no crew account had ever existed (L65) — are defects in SQL. An option whose entire
   mechanism is "stop having a second implementation to disagree with" is silent about the first
   implementation being wrong on its own.
2. **B's reachable half is already closed.** `recordScope.ts` took the four B would have caught, and
   took them more cheaply and more permanently than a 903-line rewrite would have: a frozen table
   cannot drift, where a thin fake can be thickened one convenient branch at a time.
3. **A is an hour of work and no ongoing obligation; B is a long rewrite with a permanent one.** The
   cost asymmetry runs the same direction as the coverage asymmetry, which is rare enough to be worth
   saying out loud.

**What was deliberately not done:** the in-memory store was not deleted, and no in-memory test was
converted. A does not require either — it reuses the same files against a different store, which is
the entire reason it is cheap. The in-memory job stays in CI as well, because the two disagreeing is
the signal (the standing argument in the header of `routes/sessions-and-tokens.test.ts`), and a
single combined job would hide which store failed.

---

## 6. What has to happen before it gates CI

`test:all-db` is in `package.json` and `run-tests.sh` and is **not** in `scripts/ci.sh`. The reason is
in a comment in the script, so a future session does not read the absence as an oversight:

> Its first run against a real database is expected to be RED — the in-memory suites have never been
> executed against Postgres, so every place the two stores disagree surfaces at once. Gating CI on it
> before that list is known and worked through would block every open pull request on failures that
> have nothing to do with any of them.

The sequence, and it needs the owner only at step 1:

1. **Run it once against a throwaway Postgres.** `TEST_DATABASE_URL=postgres://… pnpm -C Projects
   --filter services-api run test:all-db`. Not Neon-with-data, not staging: it runs the migrations
   and the suites delete rows wholesale. This cannot be done from this environment — there is no
   Postgres, no Docker and no `psql` here, which is why the first-run list is unmeasured above.
2. **Triage the failures** into the three buckets named in §2 (real divergence / test asserting an
   in-memory artefact / fixture needing tenant context). Each is a small, local fix.
3. **Turn it on in `Projects/scripts/ci.sh`** — one line, next to the existing `test:db` invocation,
   and `scripts/ci.sh` is the single definition of "the build passes" so nothing else needs editing.
4. **Then, and only then, consider deleting `test:db`** as a separate mode. It becomes a strict subset
   of `test:all-db`. Keeping both costs one more CI job; deleting it loses the ability to run the
   gated suites alone when iterating. Not a decision worth taking in advance.

**Open question for the owner, recorded rather than guessed:** whether to turn it on in `ci.sh` once
step 2 is clear, or to leave it as a hand-run gate before releases. The argument for CI is that a
hand-run gate is the same promise-to-be-careful this document spent §3 arguing against. The argument
against is wall clock on every PR, which is unmeasured until step 1 runs.
