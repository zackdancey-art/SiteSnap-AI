# Review — turning hand sweeps into tests

Branch `test/hand-sweeps-as-tests`, off `main` at `cbe6f2d`. 9 October 2026.

The governing instruction was: where a sweep done by hand can be an invariant, write the
invariant; where it cannot, say why. An invariant over a class stops the next instance. A unit
test over one behaviour stops a regression and nothing else.

---

## What was built

**1. The screen-header registration invariant** — `lib/screen-header-audit.ts` + `.test.ts`.
Discovers which screens render `<ScreenHeader>` by parsing the real `app/` tree with the
TypeScript compiler, resolves each route's `headerShown` through registration, `screenOptions`
and nested-navigator inheritance, and fails naming the screen and which half of the rule broke.
Replaces a 39-file hand sweep. 12 tests.

**2. The annotation palette floor** — `lib/colour-distance.ts`, `lib/annotation-palette.ts`,
`lib/annotation-palette.test.ts`. The palette was extracted out of `PhotoAnnotator.tsx` (which
imports React Native, so no test could reach it) and now carries a worst-case ΔE floor against
three reference backgrounds, a pairwise confusability floor, and a membership check on the
default. 8 tests.

**3. `eslint-plugin-react-hooks`** — installed, `rules-of-hooks` enforced on the two React
packages, plus `scripts/assert-hooks-lint-active.sh` to prove the rule actually fires.

**4. The CI runner pin** — all four jobs across three workflows pinned to `ubuntu-24.04` before
`ubuntu-latest` starts migrating to Ubuntu 26.04 on 19 October, action majors bumped off the
deprecated Node 20 runtime, plus `scripts/assert-workflow-runners-pinned.sh` so the fifth
workflow cannot float again.

Both new assert scripts are wired into `scripts/ci.sh`, which is the single definition of the
gate.

---

## Could any of these pass while the thing it checks is broken?

The instruction was to assume a fifth vacuous check was in here until shown otherwise. One thing
was found, and it is a coverage boundary rather than a vacuum — but the honest framing is that
**the screen-header test's name promises more than it delivers**, which is the same failure mode
as the four that came before, one step earlier in the chain.

### The real boundary: item 1 cannot see a hand-rolled header

The invariant is "every screen rendering `ScreenHeader` must have the native header hidden". It
discovers its population by looking for the `<ScreenHeader>` **element**. A screen that paints its
own header inline is invisible to it — and there is one in the tree today: `(tabs)/supervisor`
renders a bespoke inline header and mentions `ScreenHeader` only in a doc comment. So the test
never discovers it, and a screen that hand-rolls a header *and* shows the native one would be a
double header the invariant cannot report.

Two things make this a boundary rather than a hole. The one live instance is benign —
`(tabs)/supervisor` sits inside the tab navigator, which resolves to `headerShown: false` on both
branches, so there is no second header. And the narrower rule is enforced rigorously: the test
asserts `rendersScreenHeader` finds the element and not the word, precisely so the doc-comment
mention cannot be mistaken for a render. But the boundary is real, and the test's title does not
state it.

### What each test rests on

| | asserts a population | positive control | red-on-revert |
|---|---|---|---|
| Screen-header invariant | 33 routes, 11 `ScreenHeader`, 9 native-header, 2 layouts, and the navigator-component set exactly | 5 synthetic fixtures, both rule halves | 3 tests fail naming `settings/offline-sync` |
| Palette floor | 4 colours, 3 backgrounds, 12 measurements, 6 pairs | navy fails contrast, orange fails pairwise, both measured | both directions, with the predicted asymmetry |
| Hooks lint | 2 packages verified | a file that genuinely breaks the rule, required to be reported by name | glob rot and dropped rules, both leave `pnpm run lint` green |
| Workflow pins | 3 workflows, 4 pinned runners | the pinned-runner count is itself the control on the floating-runner pattern | floated runner, reverted action major, unreviewed new workflow |

Limits worth knowing:

- **Pinned counts are a human checkpoint, not a proof.** Every population guard can be satisfied
  by raising the number without looking. That is the intended friction and the known limit of it.
- **The palette's three reference backgrounds are chosen hex values, not samples from real
  photographs.** The test proves separation against three points. A colour could clear all three
  and still be lost on wet asphalt or against high-vis orange. It is a floor, not a proof of
  legibility; buying more than that means measuring real photographs.
- **The palette test covers the palette.** Confirmed single-definition: `AnnotatedImage.tsx` and
  `export-utils.ts` both read the colour off the stroke and carry no copy, so the test covers the
  product rather than a third of it. But see L63 — `export-utils.ts` duplicates fourteen *other*
  colour values, so "the export looks like the app" is true for the strokes and false for
  everything around them.
- **The workflow check's action-major list is hand-maintained.** A new action introduced on a
  retired major is not covered until someone adds it. That is the L36 shape with extra steps, and
  it is the weakest of the four.
- **`rules-of-hooks` passing means nothing about the defect class that actually ships here.** See
  L62.

### One place where the first rationale was wrong

`assert-hooks-lint-active.sh` originally justified itself partly on "dropping
`plugins: ["react-hooks"]` from an override breaks the rule". That was asserted, then tested, and
it is false — eslint 8 merges `plugins` from every config block into one registry, so the other
override keeps the prefix resolvable. The mutation did **not** go red. The comment was corrected
to say so, and two mutations that do go red were found instead. Recorded because the check would
otherwise have carried a confident, wrong claim about what it protects.

---

## What was found that nobody asked for

**`lib/export-utils.ts` has its own undocumented palette — AUDIT L63.** The file that generates
the exported diary PDF, which is the compliance artefact this product exists to produce, does not
import `@/constants/colors` at all. It carries 28 hex literals, 14 distinct: five are frozen
copies of real tokens that will silently diverge the first time a token changes, and nine exist
nowhere in the token file — a second navy-and-grey scale governed by nothing. This is the A6/L36
legal-drift shape in a place nobody had looked.

It was found while costing a "no raw hex outside the token file" check for the sweep list, and the
way it was nearly missed is the instructive part: the first grep required a quote (`"#......"`)
and reported 4 files and 1 stray. The export templates write colour inside CSS strings as
`color:#6F8095`, unquoted. The quote-independent count is 8 files. **A check written on the first
pattern would have passed while missing the whole finding** — the fifth vacuous check, caught
before it was built rather than after.

**Node 20 is still the build's Node** in all three workflows, past its support window since April
2026. Flagged, not changed — bumping the build's Node is a behaviour change and not what this
branch is for.

**The RLS enumeration procedure in CLAUDE.md undercounts by four — AUDIT L64.**

---

## What was skipped, and why

- **`exhaustive-deps` was not fixed.** 18 warnings, over the threshold at which the instruction
  said to disable rather than mass-rewrite. A dependency array is not a lint fix: on these screens
  adding a dependency changes when a network request fires. Eighteen at once in a branch about
  tests would be eighteen untested behaviour changes.
- **No genuine `rules-of-hooks` violation was fixed, because there were none.** All 99 initial hits
  were in `services/api`, where `useDatabase()` and `useS3Storage()` are plain predicates the
  plugin mistakes for hooks on the strength of their names.
- **Every sweep-list candidate was listed and none built**, as instructed.
- **The runner pin could not be verified from a real workflow run on this branch.** `ci.yml`
  triggers on `pull_request` and on push to `main`/`master` only, so pushing a feature branch
  starts no run. The readback command and the "before" value are in the PR body; it must be run
  once the PR is open.

---

## New AUDIT entries

- **L62** — `rules-of-hooks` buys nothing against the missing-dependency class. L44's note says the
  plugin would have caught it; that is true of the plugin and false of this configuration, because
  the shape is an `exhaustive-deps` finding and that rule is off. Verified by reconstructing L44's
  original shape and linting it both ways.
- **L63** — the export template's undocumented 14-colour palette, above.
- **L64** — CLAUDE.md §3's `grep` for RLS-forced tables leads to 11 of 15. Migration 025 applies
  RLS to `site_members`, `material_deliveries`, `crew_timecards` and `inspections` through a
  dynamic `DO` loop, so those four names never appear beside the `FORCE` keyword. Undercounting is
  the dangerous direction: an agent that believes `crew_timecards` is unprotected has no reason to
  route through `withTenant`, and the result fails closed with no error at the call site.

---

## Where the instructions turned out not to match the code

- **`(tabs)/supervisor` does not render `ScreenHeader`.** The instruction asked for it not to be
  flagged. It is not flagged because it is never discovered — the only mention is a doc comment.
  The outcome is right for the wrong reason, which is why the boundary is written up above.
- **The native-header population is nine, not seven.** `create-site`, `new-entry`, `profile`,
  `export-diaries`, `backup-data`, `privacy-policy`, `terms-of-service`, `help-support`,
  `supervisor-dashboard`.
- **The RLS undercount is about tables, not files.** The `grep -l` named in CLAUDE.md returns files
  and does find migration 025. The undercount appears at the next step, reading table names out of
  those files.
- **L44 is already fixed.** Its disposition still reads Open, but the effect was converted to a ref
  in earlier work. Its claim about what the plugin would have caught is the part that is still
  wrong, which is L62.
