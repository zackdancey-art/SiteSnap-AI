# Workstream 9 — Branding and dashboard parity

Branch: `feat/branding-and-dashboard-parity` → `main`
Commits: `b723180`, `a4c21d2`, `c12c381`, `a2e51e9`, `3957f32` (off
`origin/main` = `ee7e093`)

**Open it here:**
<https://github.com/zackdancey-art/SiteSnap-AI/compare/main...feat/branding-and-dashboard-parity>

Four concerns. Concern 1 was the portal half of the assigned work; concern 2 was
found while building it and is the most user-visible defect on the branch;
concern 3 is AUDIT L63; **concern 4 is the assigned bullet itself — the mobile
dashboard reaching parity with the portal's, and the manager+ gating on both
surfaces.**

---

## 1. The dashboard was reporting two hundred of everything — AUDIT L98

`GET /projects/summary` answered by loading three lists and measuring them:

```ts
const [sites, entries, diaries] = await Promise.all([
  listSites(actor), listEntries(actor), listDiaries(actor),
]);
res.json({ sites: sites.length, entries: entries.length, … });
```

`listSites`/`listEntries`/`listDiaries` are declared `(actor, …, limit = 200,
offset = 0)`, and none of those three calls passes a limit. So a company with
five thousand entries was told it had two hundred — a plausible number, which
is why nobody reported it for the life of the product. The portal dashboard had
the same defect independently, measuring `bootstrap.sites.length` and friends
off `/projects/bootstrap`, which also passes no limits.

The derived figures were worse than the raw ones. An approval rate of
`approved / diaries.length` is the rate across the most recent two hundred
diaries, and it was rendered as the rate across all of them, with a progress bar
and a red/amber/green colour behind it.

**The fix counts in SQL.** `getPortfolioCounts(actor)` in
`storage/projectsStore.ts` issues three `COUNT(*)` queries inside one
`withTenant` transaction and returns eight integers. L98's disposition rules out
the alternative explicitly — *"the right fix … removes the cap as a concept
instead of raising the number. Raising 200 to some larger number would hide the
same defect for longer, which is what happened the first time."* — so there is
no limit to pass and no page to forget.

Two things in it are deliberate and worth a reviewer's eye:

- **The visibility predicate is the same helper the lists call, not a copy.**
  The clause comes from `readVisibilitySql(actor, kind, params)`, and the
  in-memory branch asks `canReadRow`, its twin. Today both return whole-company
  for sites, entries and diaries (only `timesheet` is a `personal-record`), so
  the clause is `null` and contributes nothing. It is wired anyway, because a
  count with looser scoping than the list it summarises is a leak that presents
  as a number — "47 timesheets" shown to someone entitled to read three. If
  `readVisibility` ever narrows one of these kinds, the count narrows on the
  same commit instead of becoming the one place that still reports the whole
  company.
- **The response is additive.** `activeSites`, `completedSites` and
  `onHoldSites` are new; every previously-returned key keeps its name and
  meaning. Nothing that read the old shape has to change.

**The dashboard shows an em dash when the count has not arrived, rather than
falling back to the bootstrap arrays.** Falling back is the tempting option and
it is the wrong one — it would restore exactly the silently-wrong number this
change removes, on the one path nobody tests. A missing number is visibly
missing; a capped one is not. One exception, and it is not a lapse: the Site
Portfolio section header is `{metrics?.sites ?? data.sites.length}`, because the
table underneath it literally renders `data.sites`, so when the count is
unavailable the header counts what is on screen. When the count *is* available
and exceeds the table, the header adds "showing N" instead of pretending the
table is complete.

### Caller — the point of Block B

Before this workstream `/projects/summary` **had no client caller at all**, in
either app. That is why nobody ever saw it report two hundred of five thousand.
It now has one:

| Route | Guard | Called from |
|---|---|---|
| `GET /api/projects/summary` | `requireAtLeast("viewer")` | `apps/supervisor-web/lib/api.ts:239` `fetchPortfolioSummary` → `apps/supervisor-web/lib/usePortfolioSummary.ts:51` → `apps/supervisor-web/app/dashboard/page.tsx:75`, rendering the four metric cards at `:180-183` |

`usePortfolioSummary(enabled)` takes an `enabled` flag because the route is
viewer+ and a hook cannot be called conditionally; passing
`canSeeSupervisorDashboard` (which is `!isCrew`) keeps the client's request and
the server's gate admitting the same population, instead of firing a request
known to 403 on every crew load. **The flag withholds the request, not the
refusal** — removing it would waste a round trip and log a 403, not expose a
number.

No other route on this branch is touched. Concerns 2 and 3 add and change **no
routes at all**.

---

## 2. Found while building: one character made three user-visible defects

Not in the assignment. Found because concern 1 needed the site-status
vocabulary and the portal's copy disagreed with the API's.

`SiteSchema` in `routes/projects.ts:54` is the authority on what can be
written: `z.enum(["active", "completed", "on-hold"])`. The portal had
**`on_hold`**, with an underscore, in two separately pasted copies of a status
config. Measured consequences:

1. An on-hold site rendered as a grey **"Inactive"** badge on the dashboard —
   the config lookup missed and fell through to the fallback key.
2. The Sites page **"On Hold" tab counted 0 forever**, for every company, since
   the tally compared against the literal `"on_hold"`.
3. **Selecting that tab returned an empty list**, for the same reason.

And a fourth, from a different line: the site detail page printed the raw value
`on-hold` in its Status row, where every other surface shows a label.

**Why nothing caught it.** `Site.status` is typed `string` at the wire
boundary, so no compiler links the five declarations. The mobile client's copy
is correct, so each client was internally consistent and the disagreement was
only visible across them. And no API test renders a site status — the API's
tests assert on JSON, not on badges.

**The fix is one module**, `apps/supervisor-web/lib/siteStatus.ts`, keyed on the
API's values. It makes the *reading* total rather than narrowing the wire type,
and the reasoning is recorded in the file: narrowing `Site.status` to a union
would be a claim about every row ever written, and this product predates the zod
enum — the fallback key `inactive` exists in the original config and is **not**
in the API's enum, which is evidence that out-of-enum rows have existed. So the
wire type stays loose and `canonicalSiteStatus` is total. `on_hold` is kept as
an accepted *alias* so that a real underscore row, if one exists, cannot
regress; `inactive` is deliberately absent from the filter tabs, because it is
the label for a value we failed to understand, not a status the product sets,
and a tab for it would invite filtering by that.

**Pinned by `scripts/assert-site-status-vocabulary.mjs`, wired into `ci.sh`.**
The portal has no test runner, so the guard is a structural check in the
`assert-*` family CI already runs — which is also how L63 frames this whole
defect class ("the shape of A6 and L36"). It reads five declarations of site
status and four of diary status out of source and requires agreement:

```
site status:  "active", "completed", "on-hold" — all 5 declarations agree.
diary status: "approved", "draft" — all 4 API/mobile declarations agree.
portal fallback, not writable by the API: "inactive"
```

Three properties of that script that a reviewer should check rather than take
on trust:

- **Every extractor fails loudly on a miss.** Two empty sets compare equal,
  which is how a check passes having read nothing.
- **The portal is read from the RIGHT-hand side of its alias map.** The left is
  deliberately wider (it holds `on_hold` on purpose), so reading the left would
  make the check pass on exactly the defect it exists to catch. Two distinct
  failures are reported: *uncovered* (the API can write a status the portal
  cannot render) and *undeclared* (the portal has a value the API cannot write
  and that is not the declared fallback).
- **It says what it does NOT cover.** The portal is not covered for *diary*
  status, because it compares `d.status === "approved"` inline in five files
  with no single module to read. That is stated in the script. Claiming coverage
  a check does not have is how the last green check came to mean nothing.

### One honest caveat on this concern

`getPortfolioCounts` contains hand-written status literals in its SQL
predicates — `COUNT(*) FILTER (WHERE status = 'active')` and three more. That is
the shape the standing rule warns about. It is there because **`@sitesnap/shared`
emits `.d.ts` only** (`"main": "dist/index.d.ts"`), so it cannot carry a runtime
constant, and there is no existing shared runtime vocabulary module to import
from the API. What makes the literals non-drifting is the structural check
above, which extracts them from the SQL and compares them against `SiteSchema`'s
zod enum — scoped to the single statement containing `FROM project_sites`, since
`getPortfolioCounts` queries three tables and `project_diaries` has its own
`status` vocabulary. If a shared runtime constants package is wanted, that is a
larger change than this branch and I did not make it.

---

## 3. The exported document's palette had no governance — AUDIT L63

`apps/mobile/lib/export-utils.ts` builds the HTML that becomes the exported
diary and inspection PDF — the document this product exists to produce, and the
copy a client or a regulator reads — and it did not import
`@/constants/colors` at all.

L63's measurement reproduces exactly: **28 hex literals, 14 distinct.** Five
duplicate a design token by value (`#0f2b46`, `#ffffff`, `#fcd34d`, `#fef3c7`,
`#92400e`); **nine exist nowhere in the token file** (`#eef2f7`, `#143a5b`,
`#f6f8fb`, `#dde5ef`, `#6f8095`, `#e3eaf2`, `#31455d`, `#e6edf5`, `#edf1f7`) —
a second navy-and-grey scale, governed by nothing and invisible to any decision
made about the app's palette.

### The decision, which is a judgement call and is flagged as one

The obvious fix is `heroStart: Colors.primary`. **I did not do that, and the
opposite choice is yours to make in one line per colour.**

L63's disposition says plainly that *"changing export colours changes
already-exported evidence"*. Importing the token means the next change to the
app's navy silently restyles every document produced after it, including
re-exports of records signed under the old appearance. A compliance artefact
that quietly follows the app's branding is not a property anybody asked for, and
the asymmetry is one-directional: documents already on a client's device are
beyond the reach of any check we write.

What L63 actually objects to is the **silence** — *"change the token and the app
moves while every future export keeps the old value, with nothing reporting the
disagreement."* So the values stay frozen and deliberately independent, and the
disagreement is made loud. Both halves of that reasoning are in the module's doc
comment so the next reader does not re-derive it.

**→ Owner decision, carried forward: should exported documents track the design
tokens rather than keeping frozen copies?** If yes, it is `text: Colors.primary`
and four siblings, and the drift check below becomes trivially true instead of
load-bearing.

### Not one byte of any export changes

The 14 colours moved to `constants/exportPalette.ts`, split into `TOKEN_TWINS`
(the five, each naming its twin) and `PRINT_ONLY` (the nine, with why they are
not folded into the tokens: they are print values for a white page, the app's
scale is for a backlit screen, and `heroEnd` `#143a5b` is **not**
`Colors.primaryLight` `#1a3d5c` — the two were picked independently per medium,
so merging them would be a visual change to the evidence). Names are by role,
not by hue: `#6f8095` is `mutedLabel`, not `grey500`, because the nine have no
scale to belong to and naming them as if they did would invent a second design
system by accident.

Values are kept **lowercase**, as they already appear in the CSS, rather than
matching the uppercase tokens. CSS hex is case-insensitive so nothing renders
differently either way, but this keeps the generated HTML byte-identical, which
is the one form of "no change" that needs no argument.

Proven two ways rather than asserted:

- **Before** substituting, every one of the 28 sites was confirmed to lie inside
  a template literal (unescaped-backtick parity scan: 136 backticks, balanced).
  This mattered. `${EXPORT_PALETTE.x}` inside a quoted string is silently
  literal text and raises **no type error**, so a single site outside a template
  would have shipped the string `"${EXPORT_PALETTE.text}"` into a client's PDF.
- **After** substituting, the 28 placeholders were expanded back to their values
  and the result diffed against the saved pre-change file: identical, modulo the
  one added import line.

### Pinned by `scripts/assert-export-palette.mjs`, wired into `ci.sh`

Two checks. **Drift:** each twin must still equal its named token, compared
case-insensitively, with the mapping *read from the palette module* rather than
written in the script — so a renamed colour cannot leave the check comparing a
name nothing uses. **Census:** `export-utils.ts` must contain zero raw hex, and
the other mobile files containing any must be exactly the six enumerated, at
exactly the counts measured today.

The pattern is **quote-independent**, which is the whole point. L63 records that
its own first measurement was wrong: a grep for `"#......"`, requiring the
quote, reported 4 files, because the export CSS writes `color:#6f8095` with no
quote; the real figure is 8. *"A check written on the first pattern would have
passed while missing the entire finding."* This one matches the hex itself,
never a quote. The census measured 6 files outside the two colour modules,
which with `colors.ts` and `export-utils.ts` is L63's stated 8 exactly.

There is also a **positive control**: a file that interpolates fewer than 20
palette values fails even with zero raw hex. "No raw hex" in a file that has
stopped colouring the document is not a pass, and an empty hex count and an
empty palette count read identically in a report.

The census allows what it allows **with a reason**, not by omission:

| file | raw hex | why allowed |
|---|---|---|
| `apps/mobile/lib/annotation-palette.test.ts` | 14 | a test *about* colours; the literals are its fixtures and assertions |
| `apps/mobile/lib/colour-distance.ts` | 1 | a worked example in a doc comment, not a rendered colour |
| `apps/mobile/app.config.ts` | 3 | native splash/icon background — Expo config, deliberately untouched |
| `apps/mobile/app/inspections/[siteId].tsx` | 7 | **L63 debt, pinned not fixed** |
| `apps/mobile/app/crew/[siteId].tsx` | 2 | **L63 debt, pinned not fixed** |
| `apps/mobile/app/_layout.tsx` | 1 | **L63 debt, pinned not fixed** |

**Those three screens are real debt and are pinned, not fixed.** They are screen
styles, where importing `Colors` **is** the right fix — which makes them a
different change from the export templates, where it is not. Fixing them in the
same commit would have mixed a change that must not alter rendering with one
that deliberately does. They now have a count that fails if anyone adds to them.
`app.config.ts` is left strictly alone: native config, out of scope outside
workstream 7.

**What the check does not prove**, stated in the file: nothing about documents
already exported; nothing about whether the nine print-only colours are *right*;
and nothing about `rgba()`, `hsl()`, named CSS colours, or a colour built by
string concatenation. Hex is what L63 measured and hex is what is pinned; a
wider pattern would need its own measurement rather than an assumption.

---

## 4. The assigned bullet: the manager dashboard on mobile matches the portal's

> "I said this when I first saw the mobile portal view and it has not happened.
> Same cards, same figures, same gating — manager+ only, invisible to crew."

Commits `a2e51e9` (mobile parity + one status vocabulary) and `3957f32` (the
manager+ gating). Four gaps were measured against the portal's dashboard, and
gating is the fifth item, handled separately because it changes the portal.

### Gap 1 — there were no cards

The whole of the mobile dashboard's numbers was one sentence:

```
`${activeSites} active sites · ${entries.length} entries · ${diaries.length} diaries.`
```

It now renders the portal's four cards — same labels, same order, same icons —
Active Sites, Total Entries, Approved Diaries, Pending Review, plus the portal's
approval-health bar with the same 80/50 thresholds.

### Gap 2 — the figures were wrong, not merely sparse

That sentence counted the **arrays from `/projects/bootstrap`**, which is L98
again on the surface concern 1 did not touch: `listSites`/`listEntries`/
`listDiaries` default to `limit = 200` and `getScopedBootstrap` passes no limits,
so a company with 5,000 entries read "200 entries" on the mobile dashboard
exactly as it did on the portal's. Mobile now calls `GET /api/projects/summary`,
which counts in SQL.

**There is deliberately no fallback to the bootstrap arrays.** A capped number
presented as a total is the defect; a smaller wrong number is not a degraded
total, it is a different claim. When the totals cannot be read the cards show an
em dash and a line of text saying so.

### Gap 3 — `site.status.toUpperCase()`

A held site read **ON-HOLD** on mobile against **On Hold** on the portal.

### Gap 4 — a finished site had a different word *and* a different colour

`app/(tabs)/index.tsx` carried a pair of ad-hoc ternaries whose fallback colour
was `Colors.textTertiary`, the grey reserved for a status it does not recognise.
So a completed site read grey **"Completed"** on mobile and accent-orange
**"Complete"** on the portal. Same site, two surfaces, two words, two colours.

Gaps 3 and 4 are now one decision in `apps/mobile/lib/siteStatus.ts`, the twin of
`apps/supervisor-web/lib/siteStatus.ts`. **It cannot be one shared module:**
`@sitesnap/shared` is `"main": "dist/index.d.ts"` and emits types only, so it
cannot carry a runtime constant. The two copies are held together structurally
instead — `assert-site-status-vocabulary.mjs` now compares **six** declarations
and, new on this commit, **the labels per key**, which is what turns gap 4 into a
build failure instead of a code-review note.

**Which word won: "Complete", the portal's**, because it is the word already
shown to clients in exported documents. That is a judgement call, it is in the
list below, and reversing it is a one-line change in each client — the check
refuses to let only one surface move.

### The gating, which is the half that touches the portal

Mobile was already manager+ via `isManagerOrAbove()`. The portal was viewer+:
`canSeeSupervisorDashboard()` was `!isCrew(companyRole)`, which admits a viewer
and admits anything it does not recognise. It is now `DASHBOARD_ROLES =
["manager", "owner"]`, and `Sidebar.tsx`'s Dashboard entry moved from
`hiddenFromCrew` to `managerOnly` so a viewer does not keep a link to a screen
that now refuses them.

**This is a screen withheld, not data withheld, and the code says so in every
place it is implemented.** `GET /projects/summary` is `requireAtLeast("viewer")`
and is unchanged, so a viewer who calls it directly still receives the numbers.
Calling this a permission change would be false by the repo's own rule that
hiding a control is not a permission. Moving that route to manager+ would make
it a real refusal; it touches the rank table in `crew-permissions-db.test.ts`,
two access tests and the load-test's route list, so **it is your call and it is
in the open-questions list, not taken here.**

**An absent role is now refused, which is a change.** `companyRole` is optional
on `User`, and `!isCrew(role)` failed *open* on it — a session whose role had not
loaded saw the dashboard. The explicit list fails closed. Left alone that is a
silent regression into "you don't have access", which is both wrong and
unactionable, so `isUnknownRole()` was added and the dashboard shows a second,
different refusal for that case: *"Sign in again to see this"*, saying the saved
session does not carry a role and that signing out and back in will settle it.

### Caller — the point of Block B

```
GET /api/projects/summary  <-  Projects/apps/mobile/lib/usePortfolioSummary.ts:59
                           reached from  Projects/apps/mobile/app/supervisor-dashboard.tsx:121
```

This is that route's **second** caller; the first is the portal's
`lib/api.ts:240`. No route was added, touched or re-ranked on either commit.

**A correction I owe you while checking that.** I have described this screen as
having two routes behind it, on the strength of the rank table at
`routes/projects.ts:148`. That is wrong about the second one.
**`GET /projects/reports/supervisor` (`projects.ts:364`) has no caller in either
shipping client.** `grep -rn "reports/supervisor" Projects/apps` returns only
comments — three of which I had just written — and both clients build their
report HTML locally instead: mobile's export button calls
`buildDiariesReportHtml(diaries, sites, …)` from bootstrap data. By your own
rule that route "counts as not built", and it carries tests in
`crew-permissions-db.test.ts`, `company-rbac.test.ts` and
`invite-accept-access.test.ts` — the route-with-tests-and-no-caller shape the
rule exists to catch. **I have not touched it.** Deleting a route is not
reversible the way the rest of this branch is, and it predates this workstream.
It is in the open-questions list. The four comments that named it were corrected
to name only `/projects/summary`, in the same commit.

### The payload is parsed, not cast

`derivePortfolioMetrics()` requires all eight fields to be finite numbers and
returns `null` otherwise; the hook turns `null` into a visible message. Mobile is
the one client that can be **newer than its server** — `eas update` is batched
separately from the API deploy, by your own instruction — so a cast here renders
"undefined" to a manager standing on a site.

### Tests, pins and proofs for this concern

**Nine new tests, in-memory, and that is the correct gate for them.** These are
pure logic with no store involved: a parse function and a frozen label map. The
standing rule sends anything touching permissions, tenancy, ownership or data to
the DB-gated suite; none of these touch a store. The gating half has no test at
all on the portal and that is addressed below.

Both new modules **and** both new test files were appended to
`tsconfig.test.json`'s explicit `files` array. That array is a list, not a glob,
on purpose — a module not listed silently never compiles and never runs.

**The pins were measured, not written.** `run-tests.sh` `EXPECTED_TEST_FILES`
15 → **17** and `EXPECTED_TESTS` 113 → **122**, both taken from the runner's own
refusal to pass:

```
found 17 test file(s), expected 15
```
```
122 test(s) passed, expected 113
```

**Every negative assertion carries a positive control in the same test.** The
missing-field loop and the not-a-summary list each end by asserting
`derivePortfolioMetrics(FULL)` still returns metrics, so neither passes if the
function has been deleted outright.

#### Red on revert — four more, run and restored

**A — mobile's label for a finished site changed to `"Completed"`:**

```
assert-site-status-vocabulary: FAIL
  the two clients print different words for "completed".
    portal: "Complete"  mobile: "Completed"
exit 1
```

**B — mobile's `"on-hold"` config entry deleted:**

```
assert-site-status-vocabulary: FAIL
  only one client has a label for "on-hold".
    portal: "On Hold"  mobile: (none)
exit 1
```

**C — mobile stops accepting the `on_hold` spelling. This one passed first
time, and that was a defect in my own check, not a pass.** It compared only the
canonical values the alias maps reduce *to*, while its own failure message
claimed to compare *"the set of statuses they accept"*. Fixed by extracting the
alias **keys** as a separate set and comparing both, each naming what it checks.
Re-run:

```
assert-site-status-vocabulary: FAIL
  the two clients do not agree on the spellings they accept.
    portal only: "on_hold"
exit 1
```

**D — `isPortfolioSummary()` weakened to `return value !== null && value !== undefined`:**

```
not ok 60 - a summary missing any field derives nothing at all
not ok 61 - anything that is not a summary of numbers derives nothing
# tests 122
# pass 120
# fail 2
```

The other 120 stayed green, which is what shows these two tests are the only
thing defending the parse.

#### The measurement that justified a new check, and the proof after it

`apps/supervisor-web` has **no test program at all**, and adding a runner means
adding a dependency, which is not mine to do. So before writing anything I
measured what the existing gates would catch. **Reverting `DASHBOARD_ROLES` to
include `"viewer"` — undoing your decision on the portal — left all of this
green:**

```
portal typecheck                      exit 0
mobile suite                          122 pass / 0 fail / 0 skipped
assert-site-status-vocabulary          exit 0
lint --max-warnings=0                 silent
```

Nothing in the repo defended it. `scripts/assert-dashboard-rank.mjs` now does:
it reads `DASHBOARD_ROLES` out of the portal and the roles named inside
`isManagerOrAbove()` in mobile, asserts the two sets are equal, that each admits
both manager and owner, and that neither admits crew or viewer. It carries two
anti-vacuity checks of its own — each client's predicate must actually reference
the list or function the script read, so deleting a predicate and leaving the
list behind fails rather than passes.

**F — the same revert, after the check was wired into `ci.sh`:**

```
assert-dashboard-rank: FAIL
  the two clients do not agree on who may see the supervisor dashboard.
    portal only: "viewer"
exit 1
```

and typecheck, lint, the 122-test mobile suite and the status check **all stayed
green on that same revert** — which is what shows this check is the only thing
holding the decision in place. Restored, it prints:

```
supervisor dashboard: "manager", "owner" — both clients agree, and refuse "crew" and "viewer".
```

**What it does not prove, recorded in its own header so a future session does not
over-read it:** nothing about the API. It compares two clients to each other, not
either client to the server.

### What I did not build here, and why

**A structural check pinning the 80/50 approval-health thresholds across both
surfaces.** A colour threshold drifting is cosmetic — it does not stand between a
user and a refusal, a sign-out or data loss — so it does not meet the bar that
justified the other three checks. The mobile side *is* tested
(`APPROVAL_TONE_THRESHOLDS` read back, asserted frozen, boundaries asserted at
80 and 50 and either side) and the module records that both places have to move
together.

### What I could not verify

**Nothing on this concern was seen rendered.** There is no simulator and no
browser here, so the four-card grid, its wrap at `flexBasis: "46%"`, the health
bar and both refusal cards are typechecked and unit-tested but have not been
looked at. A device and browser pass is yours; it is in the final report as a
numbered step.

---

## Tests

### New, DB-gated — and **not executed locally**

Two tests added to `storage/store-roundtrip.test.ts`. This environment has **no
Postgres and no Docker/psql**, so the DB-gated suite cannot run here at all.
**They have not been executed. CI is the first place they run, and green CI on
this PR is the only evidence that they pass.** Saying otherwise would be
inventing a result.

They are DB-gated because the defect **is** the SQL `LIMIT` — the in-memory
store has no limit to be wrong about, so an in-memory test of L98 would pass
against the unfixed code.

1. `getPortfolioCounts counts past the list's limit, and stays inside the company`
   - Seeds a fresh company with **201** entries (the cap is 200).
   - **Control that makes the assertion mean something:** asserts
     `listEntries(a).length === 200` first. If someone "fixes" L98 by raising
     the limit instead of counting in SQL, that line fails and says so by name.
   - Then asserts `getPortfolioCounts(a).entries === 201`.
   - **Both controls, same function, same test:** B counts its own 3 (positive),
     B does not count A's 201 (negative), A does not count B's 3 (negative).
   - Status breakdown checked against a known shape: 1 site, 1 active, 0
     completed, 0 on-hold.
2. `getPortfolioCounts' diary breakdown splits approved from draft` — 2 approved
   + 1 draft, and a company with no entries counts **zero**, not the other
   companies' rows.

Both use a **company unique per run**. Every other test in that file uses the
fixed `rt-company` with `ON CONFLICT DO NOTHING`, so rows accumulate across runs
against a persistent `TEST_DATABASE_URL`; an absolute count on a shared company
would pass once and then drift. These are exact, not lower bounds.

They live in `store-roundtrip.test.ts` rather than a twelfth DB suite on
purpose: `applyMigrations` is currently copied into all eleven DB suites, and
workstream 8 hoists those eleven into one shared helper. A twelfth copy would
leave that hoist silently incomplete and its pinned count of eleven wrong.
**`EXPECTED_DB_SUITES` is therefore unchanged at 11, correctly** — this adds
tests to an existing gated suite, not a new suite.

### Red on revert — three, run and restored

Required for anything security-relevant or standing between a user and a
refusal; these are the structural checks, run against deliberately broken trees.

**A — a design token moved away from its twin** (`warningBorder` `#FCD34D` →
`#FBBF24`):

```
  - the export palette has drifted from the design token.
    EXPORT_PALETTE.noticeBorder = #fcd34d
    Colors.warningBorder = #FBBF24
```

**B — a raw hex literal put back in the export template:**

```
  - apps/mobile/lib/export-utils.ts contains 1 raw hex literal(s):
    #eef2f7 (line 119)
```

**C — a new raw hex added to one of the pinned screens:**

```
  - apps/mobile/app/_layout.tsx has 2 raw hex literal(s), expected 1.
    Allowed because: L63 debt, pinned not fixed
```

After each: the line was restored, the check returned exit 0, **the other checks
and both test suites stayed green** — which is what proves the new check is the
only thing defending it — `git status` confirmed no probe was left behind, and
`export-utils.ts` was re-verified byte-equivalent after the restore.

For concern 2, the site-status check was proved from both sides. The first
attempt **fired the wrong branch** and that is reported rather than dressed up:
reverting the portal's canonical `on-hold` to `on_hold` produced the
*undeclared* message, not the *uncovered* one, because the `"onhold"` alias
still routed to the canonical value. The *uncovered* branch was then proved
separately by adding `"archived"` to the zod enum, so both branches are
demonstrated rather than assumed.

### Measured gate on the branch tip (`3957f32`)

Re-run after the last commit, not carried forward from an earlier one:

| gate | result |
|---|---|
| `pnpm -C Projects run typecheck` | exit 0 — all three projects `Done` |
| `pnpm -C Projects run lint --max-warnings=0` | exit 0, silent |
| mobile `pnpm --filter apps-mobile run test` | **122 tests / 122 pass / 0 fail / 0 skipped**, against the harness's pinned `EXPECTED_TEST_FILES=17`, `EXPECTED_TESTS=122` — both raised from a measurement on this branch |
| API `pnpm --filter services-api run test` | **212 tests / 194 pass / 0 fail / 18 skipped** |
| `node ./scripts/assert-site-status-vocabulary.mjs` | exit 0 — 6 declarations agree, labels identical on both clients |
| `node ./scripts/assert-dashboard-rank.mjs` | exit 0 — `"manager"`, `"owner"`, both clients agree, both refuse `"crew"` and `"viewer"` |
| `node ./scripts/assert-export-palette.mjs` | exit 0 |
| `test:db` | **could not run — no Postgres in this environment** |

Both structural checks were also run from `Projects/` as `ci.sh` invokes them,
because the first version of the site-status script resolved its paths against
cwd and `ENOENT`-ed; it is now anchored to the script's own directory.
`assert-ci-single-definition.sh` was re-run after both `ci.sh` edits and still
passes.

**The 18 API skips, per the no-unexplained-skips rule:** all 18 are the
environment gates, each of which runs for real in CI — 11 DB-gated suites
(`TEST_DATABASE_URL`), 4 Redis tests (`REDIS_TEST_URL`), 3 live-OpenAI tests
(`OPENAI_LIVE_TEST_KEY`, opt-in and deliberately not in CI). The harness checks
that count from both sides and fails on a selector that matches nothing.
`EXPECTED_SKIPS` is derived from the three pinned counters, not written down —
no pinned count on this branch is hand-written.

**The mobile pin was verified, not trusted.** My inherited notes said
`EXPECTED_TESTS=114`; the actual pin on this branch is **113**, compared with
`-ne` at `scripts/run-tests.sh:109`, and 113 ran. The 114 came from a different
branch that raised it.

---

## Deploys

| component | needed | why |
|---|---|---|
| **API** | **yes** | `getPortfolioCounts` + the rewritten `/projects/summary` handler (concern 1) |
| **portal** | **yes** | concern 1's metric cards, `lib/siteStatus.ts` and all three portal screens, **plus concern 4's manager+ gating in `useRole.ts`, `Sidebar.tsx` and `dashboard/page.tsx`** |
| **`eas update`** | **yes** | concern 3's export palette, **plus concern 4's whole mobile dashboard** — all plain JS in the bundle |
| **native build** | **no** | no native module, no permission, no `app.config.ts` change, nothing outside the JS bundle |

**The gating is portal-only and JS-only.** Nothing in concern 4's portal half
reaches the API, so a viewer keeps every API entitlement they had; what changes
is which screens the portal offers them.

### Is the split safe? Yes, in the order you already deploy in — but read this

API auto-deploys from `main` on merge; the portal deploy and `eas update` are
batched by you afterwards. **That order is the safe one and it is the order this
needs.**

- **API before portal — safe.** The new response keys are additive, so the
  currently-deployed portal keeps working unchanged: it is not reading
  `activeSites` yet.
- **Portal before API — NOT safe, and would be visible.** The dashboard reads
  `totals.activeSites` and `totals.completedSites`; against an API without them
  those are `undefined` and the Active Sites card renders a blank rather than
  the em dash, because `metrics` is non-null (the request succeeded) while the
  fields are missing. This cannot happen in your normal flow, since the API
  deploys first on merge. **It is only a hazard if you deploy the portal from
  this branch without merging it.**
- **`eas update` — concern 3's half is independent and behaviourally a no-op.**
  It touches no route and no API contract, and the generated HTML is
  byte-identical, so that part can ship in any order.
- **`eas update` before the API deploy — safe, but it degrades visibly, and
  that is deliberate.** Concern 4's mobile dashboard reads the same eight
  summary fields the portal does. Against an API that predates concern 1 the
  parse rejects the payload and the cards show an em dash plus *"The server sent
  totals this app version cannot read."* rather than blanks or `undefined`. This
  is the one client that can be newer than its server, since you batch
  `eas update` separately by instruction, which is why the payload is parsed
  rather than cast. **In your normal flow it cannot happen:** merge deploys the
  API first.
- **The mobile dashboard needs the API deploy to show real numbers at all.** If
  you ship `eas update` from this branch without merging it, managers get the
  message above instead of a dashboard. Merge first.

So: **nothing here requires all three to ship together.** Merge → API deploys →
portal whenever suits you → `eas update` whenever suits you.

---

## Judgement calls made without asking, flagged per the standing rule

These are mine, not approved by anyone, and each is reversible:

1. **Exported colours stay frozen rather than importing `Colors`** (concern 3,
   above). The opposite choice is one line per colour and is explicitly yours.
2. **Both new structural checks are wired into `ci.sh`.** They are mechanical
   cross-package invariants of exactly the kind
   `assert-single-react-types.mjs` already enforces there — unlike the
   triage check from an earlier workstream, whose wiring I left to you because
   it encodes a policy rather than a fact. If you disagree, each is two lines to
   remove.
3. **The three L63 screens are pinned, not fixed** (counts in the census table
   above), on the reasoning that importing `Colors` is the right fix for them
   and the wrong fix for the export templates, so they are a separate change.
4. **The `on_hold` fix was taken in this workstream** rather than filed. It is
   three user-visible defects on screens this workstream was already changing,
   and the shared module concern 1 needed is the same module that fixes it.
5. **`Site.status` stays `string` at the wire boundary**, with the reading made
   total instead. Reasoning in `lib/siteStatus.ts`; the short version is that
   the portal's own fallback key `inactive` is not in the API's enum, which is
   evidence that out-of-enum rows have existed.
6. **"Complete" won over "Completed"** as the word for a finished site, because
   it is the word already shown to clients in exported documents. One line in
   each client to reverse, and the check will not let only one of them move.
7. **A second, different refusal card for an unreadable session**
   (`isUnknownRole`). The minimal change would have been to let an absent role
   fall into "you don't have access", which is wrong and unactionable. Reversing
   it means deleting one branch in `app/dashboard/page.tsx` and one export in
   `lib/useRole.ts`.
8. **The sidebar's two flags are allowed to disagree** — `hiddenFromCrew` for
   Team, `managerOnly` for Dashboard — because they mirror two different things
   (an API rank and a screen decision) and a single flag name would lie about
   one of them. The comment says which is which.
9. **No structural check on the 80/50 approval thresholds**, on the reasoning in
   concern 4: cosmetic drift does not meet the bar that justified the other
   checks. Two lines to add if you disagree.
10. **`GET /projects/reports/supervisor` was left in place** despite having no
    client caller. Deleting a route is not reversible the way everything else on
    this branch is, and it predates this workstream, so it is a question below
    rather than a change here.
11. **The mobile dashboard shows an em dash and a message when the totals cannot
    be read, rather than falling back to the bootstrap counts.** The fallback
    would silently restore the exact defect concern 1 fixed.
12. **Concern 4 shipped as two commits rather than one**, split at the surface
    boundary — mobile parity, then the portal gating — because the two need
    different deploys and you may want to take one without the other.

## New AUDIT entries — proposed, not written

I have not edited `docs/AUDIT.md` on this branch. Two findings surfaced that
belong there, and the numbering is yours:

1. **`GET /projects/reports/supervisor` has no client caller.** Evidence in
   concern 4: `grep -rn "reports/supervisor" Projects/apps` returns comments
   only, and both clients build their report HTML locally. It is covered by
   assertions in three API test files, so the suite reads as if it were in
   service. Either a client should call it or it should go.
2. **L98 had a second surface.** The finding as written covers the portal
   dashboard. The identical capped-count defect was live on the mobile
   dashboard through `/projects/bootstrap`, and is fixed by concern 4. Worth
   recording against L98 so the finding is not closed on the portal alone.

## Still open — your call, and not taken here

- **Should `GET /projects/summary` move to manager+ as well,** to put a real
  refusal behind the dashboard decision instead of a hidden screen? It touches
  the rank table in `crew-permissions-db.test.ts`, two access tests and the
  load-test's route list. Until it moves, the honest description of concern 4's
  gating is "a screen withheld", and that is how the code and this PR describe
  it.
- **Should `GET /projects/reports/supervisor` be deleted?** It has no caller in
  either client (evidence in concern 4) and three test files assert on it.
- **"Complete" or "Completed"** for a finished site, if you disagree with 6.

## Still open, unchanged by this branch

The `script-src` nonce migration (L4); L49's remaining 16 hydration call sites;
C1's provenance half; L50's Display controls; L51's tap-target sizing; L46's
server half; H2's offline diary-save data loss. All have triage rows.

Do not merge on my say-so. **Green CI on this PR is the only evidence that the
two new DB-gated tests pass** — they have never been executed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
