# Decisions

Decisions about **how this repo is built and installed** — the choices that are
not visible in any one file and that a reader would otherwise have to
reverse-engineer from a commit message.

This file exists because the alternative, repeatedly, has been a gap. A reader
finds a workaround, cannot tell whether the obvious structural fix was
considered or simply missed, and either re-litigates it from scratch or applies
it without knowing what was already weighed against it. A decision recorded with
its reasoning and its expiry condition costs one page and removes that.

Findings live in [`AUDIT.md`](AUDIT.md); system structure lives in
[`ARCHITECTURE.md`](ARCHITECTURE.md). This file holds only decisions, and each
entry says what would change the answer. **An entry whose condition has been met
is out of date — take it back up rather than treating it as settled.**

---

## ADR-0001 — Keep pnpm's isolated `node-linker`; declare the offending packages by hand

**Date:** 2026-09-30
**Status:** Accepted, with an expiry condition (below)
**Finding:** [AUDIT L19](AUDIT.md) — third instance
**Scope:** the whole workspace's install layout (`apps/mobile`, `apps/supervisor-web`, `services/api`, `shared`)

### The problem

There is no `.npmrc`, so pnpm uses its default **isolated** linker:
`apps/mobile/node_modules` contains that package's **direct** dependencies only.
Anything transitive lives in `Projects/node_modules/.pnpm/`, reachable through
the dependency graph but not by a bare Node resolution walk from the app
directory. Any tool that resolves a package *from the app directory* therefore
fails on a transitive dependency, while `pnpm install`, `lint`, `typecheck` and
the full test suite all pass.

Three instances so far — two podspec/Xcode build phases, then
`babel-preset-expo`, which `babel.config.js` names and Babel resolves relative to
the config file's own directory. The third was invisible for months because
`eas build` bundles on Expo's servers; only `eas update`, which bundles locally,
exercised the path.

### Options considered

| | Option | Cost | Risk |
|---|---|---|---|
| **(a)** | Declare each offending package directly, pinned | One line per instance; no layout change anywhere | Recurs per instance. Pins are hand-maintained, so they can drift from the SDK |
| **(b)** | `node-linker=hoisted` in a root `.npmrc` | Full reinstall; re-verify CI, the API Docker build and a native build | Hoisting makes **undeclared** packages resolvable, so it can hide a missing declaration until something installs differently |
| **(c)** | `public-hoist-pattern` for Babel presets only | Same full reinstall and native re-verification as (b) | Covers only Babel presets — the next podspec or Xcode phase still breaks |

### Decision: (a), plus a CI guard

**(b) was the recommendation and was declined.** It is the documented remedy for
this class, it is what most React Native + pnpm monorepos run, and it would
converge the local layout with the hoisted layout `ARCHITECTURE.md §2` records
Render as apparently already using. Two things decided against it:

1. **Its stated risk is this project's actual failure pattern.** Hoisting makes
   undeclared packages resolvable, hiding a missing declaration until something
   installs differently. This repo has repeatedly produced bugs that worked in one
   place and failed silently in another — that is the specific disease. (b) trades
   a visible one-line problem for an invisible one, which is the wrong direction
   even when the invisible problem is rarer.
2. **It was not verified, and it would have to be.** (b)'s real gate is a green
   `eas build` run deliberately as verification — a committed `.npmrc` is
   uploaded with the project, so EAS's own `pnpm install` reads it, which means
   (b) changes the **cloud** install layout, not just the local one. That build
   is **available**; it costs roughly half an hour that nobody has spent. So this
   is not a blocker, and it is not a reason the decision could not go the other
   way — it is a cost that has to be paid before (b) is anything more than a bet,
   and on this branch it was not paid. Reason 1 is why it was not worth paying
   today; it stands on its own and does not depend on this at all.

**(c) was rejected outright** as the worst trade of the three: it carries (b)'s
full reinstall-and-reverify cost for a fraction of its coverage, and a glob
pattern is harder to reason about later than either extreme.

**The addition that fixes (a)'s weakness.** (a)'s real defect is not the
repetition — it is that a hand-maintained pin can drift from the SDK silently. If
`expo`'s own constraint moves and ours does not, two copies of the preset land in
the graph and the one declared in `apps/mobile` wins the bare resolution, so the
app transforms with the wrong preset **without erroring**.
`Projects/scripts/assert-babel-preset-expo.mjs` runs as the second step of
`scripts/ci.sh` and asserts:

1. the range declared in `apps/mobile/package.json` is identical to
   `expo`'s own `dependencies["babel-preset-expo"]`;
2. the preset resolves from `apps/mobile` — the exact resolution Babel performs;
3. the installed version satisfies `expo`'s range.

All three failure modes were confirmed to fail red before the guard was accepted.
That converts the risk from silent to noisy, which was the condition for choosing
(a) at all.

The guard deliberately imports no `semver`: `semver` is itself unresolvable from
the workspace root for the same linker reason, so adding it to run this check
would be a fourth instance of the problem being policed. It implements `~`, `^`
and exact ranges, and **fails loudly on any range shape it does not recognise**
rather than guessing.

### What would change the answer

**The trigger is a fourth L19 instance.** Three instances made hoisting worth
considering; a fourth is the point at which the recurring cost of per-instance
workarounds exceeds the one-time cost of verifying a layout change. That is the
real boundary, and it is the one to act on.

Deliberately **not** "once the gates are available" — they already are. All three
consumers of the install layout are runnable today:

| gate | status |
|---|---|
| `eas build` | runnable — `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` are all present in the EAS `production` environment (the token as a secret) |
| full `./scripts/ci.sh` with Postgres and Redis | runnable — both are service containers in CI, and `docker run` locally |
| `services/api` Docker build | runnable — the root `Dockerfile` |

They are **unspent, not unavailable**. So "when we can verify it" is not a
condition; it never was. The condition is when the recurring cost justifies
spending that verification, and one more instance of this fault is that point.

When it is taken up, those three gates are what it must pass. If it lands, the
three direct dependencies in AUDIT L19's table become redundant, and
`assert-babel-preset-expo.mjs` and its `ci.sh` step should be deleted in the same
commit, so no workaround outlives its reason.

### Verification actually performed

- `require.resolve('babel-preset-expo')` from `apps/mobile`: `MODULE_NOT_FOUND`
  before, resolves after — and to the **same** store copy `expo` already uses, so
  no second copy entered the graph.
- Babel run against the app's real `babel.config.js`: `Cannot find module
  'babel-preset-expo'` before, transforms after.
- `APP_ENV=production eas update` **actually run**, not reasoned about: exported
  both platforms, uploaded, published at runtime version `1.0.0`.
- The guard's three failure modes each confirmed red, then green again.
- **Not verified:** the EAS *build* path. Locally, Xcode 26.6 is present but
  CocoaPods is not installed and there is no `ios/`, so the native install layout
  was not exercised. A **cloud** `eas build` was available and was not run — that
  is a cost not paid, not an impossibility. This change adds a devDependency and
  moves nothing else in the graph, which is the narrowest possible blast radius
  for that path, but it is unexercised, not proven.

### A containment note worth keeping

The update above was published to a **throwaway branch with no channel mapping**,
not to `production`. At the time of this decision a STORE-distribution production
build existed (appVersion `1.0.0`, runtime version policy `appVersion`), the
`production` channel was live and unpaused with catch-all branch logic, and
branch `production` had **zero** updates. Publishing to `production` to prove a
toolchain fix would therefore have shipped the first-ever OTA update — carrying
six unreviewed mobile commits — to a store binary. The bundling path is what was
under test, and an unmapped branch exercises it identically while being
undeliverable. **Verify update tooling on an unmapped branch; ship to
`production` as its own deliberate step.**

---

## ADR-0002 — Force the light appearance in JS on every surface iOS themes itself

**Date:** 2026-10-01
**Status:** Accepted, with an expiry condition (below)
**Finding:** device pass items 1 and 4 — two symptoms, one cause
**Scope:** every iOS-rendered control in `apps/mobile` (native stack headers, `UIDatePicker`, uncoloured `ActivityIndicator`, unpainted screen backgrounds)

### The problem

`app.config.ts:47` declares `userInterfaceStyle: "automatic"`, which tells iOS the
app supports both appearances. `constants/colors.ts` is a single fixed **light**
palette. There is no dark counterpart — and the shape that would hold one is
already there and half-filled: `Colors.light` is a five-key sub-object with no
`Colors.dark` beside it, the remains of a template that assumed both.

So anything **we** paint is light, and anything **iOS** paints follows the phone's
system setting. In dark appearance the two meet on the same screen:

| surface | what iOS drew | what we drew on it | result |
|---|---|---|---|
| `UIDatePicker` (`crew/[siteId].tsx`) | near-white wheel text | `Colors.surface` card, `#FFFFFF` | white on white; only the selection band visible — reported as "the picker is empty" |
| `UINavigationBar`, 10 screens | near-black bar | `headerTintColor: Colors.primary`, navy | navy chevron on near-black; present, tappable, invisible — reported as "the back button does nothing" |
| `ActivityIndicator`, no `color` | appearance-adaptive grey, near-white | `Colors.background` | invisible spinner |
| screen content view, no `backgroundColor` (`+not-found.tsx`) | near-black | unstyled `<Text>`, default black | black on near-black |

Two of these were reported from a device as separate bugs. They are one bug with
four faces, and the fourth was found by enumeration rather than by a user.

### Options considered

| | Option | Cost | Risk |
|---|---|---|---|
| **(a)** | Explicit light-appearance props on each affected surface, in JS | One prop or style per surface; ships OTA today | Recurs per new surface. Nothing enforces it — the next `DateTimePicker` added without `themeVariant` has the bug again |
| **(b)** | `userInterfaceStyle: "light"` in `app.config.ts` | A native rebuild and a store submission; cannot ship OTA | None to the UI — it is the correct declaration of what the app actually supports. The cost is entirely in the release path |
| **(c)** | Add a real dark palette to `Colors` and honour the system setting | Every colour in the app decided twice, plus a theme context, plus re-checking every screen in both appearances | Large. A half-finished dark palette is worse than none: it produces exactly the mixed-appearance screens above, which is how this bug exists |

### Decision: (a) now, (b) at the next native build, and keep (a) afterwards

**(b) is the durable fix and is the honest declaration** — this app has one
palette, so claiming to support both appearances is false. It is not available
today: `userInterfaceStyle` becomes `UIUserInterfaceStyle` in `Info.plist`, which
is native configuration. There is no `ios/` directory in the repo (it is generated
by prebuild), the distributed build is a store binary, and `eas update` ships only
the JS bundle — so (b) cannot reach the phone that reported these bugs without a
new build and a submission. The two symptoms are live now.

**(a) ships today and is kept permanently.** When (b) lands the explicit props
become redundant in the sense that nothing should contradict them — and they stay
anyway. A component that states the appearance it needs is correct under any
app-level setting, including one changed by someone who does not know these four
surfaces exist. Explicit beats inherited. **Do not remove them as cleanup when the
native flip lands.**

**(c) is not refused on merit, only on sequence.** It is the right end state for a
product used outdoors at dusk. It is also the only option that cannot be done
halfway, and this ADR exists because of what halfway looks like.

The fourth column of the table above is the real argument for doing both: (a) fixes
the four known surfaces, (b) fixes the one nobody has found yet.

### What would change the answer

**The condition is a dark palette existing in `Colors` — a `Colors.dark` beside
`Colors.light`, with a counterpart for every token the app actually uses, not the
five in the template stub.** On the day that exists, this entry is out of date in
both directions:

- `userInterfaceStyle` should go back to `"automatic"`, because the app would then
  genuinely support both.
- The explicit props in (a) become wrong rather than merely redundant — a
  `themeVariant="light"` picker on a dark screen is this same bug with the colours
  swapped. They must be revisited, not deleted en masse: each one says *"match the
  light palette this screen is painted in"*, and under a theme system the right
  value is whatever the theme resolves to.

A secondary trigger, weaker but worth naming: **a fifth affected surface found in
the wild.** Four were found by enumerating what iOS themes natively, and the
enumeration below records what was checked and cleared. A fifth would mean the
enumeration was incomplete, which is an argument for (c) sooner rather than for
another per-surface prop.

### Verification actually performed

- The cause was read, not inferred: `app.config.ts:47` and the whole of
  `constants/colors.ts`, which has no `dark` key at any level.
- **Every surface iOS themes natively was enumerated**, not just the two reported.
  Affected and fixed: the `crew` `DateTimePicker`; the native stack header on all ten
  screens that show one — the nine `headerShown: true` entries in `_layout.tsx`
  plus `+not-found`, which gets its header from `Stack.Screen options` and so
  inherits the same root `screenOptions`; the uncoloured `ActivityIndicator` in
  `inspections/[siteId].tsx`; `+not-found.tsx`'s background and title. Checked and
  **not** affected: `Alert`, `ActionSheetIOS` and the share sheet (system-rendered
  end to end, so internally consistent); all 79 `TextInput`s (each resolves an
  explicit `color` through its style array — the seven styles without one are
  modifiers composed over a base that sets it, checked individually); the single
  `RefreshControl` (`tintColor` set); both tab bars. No `MapView`, `Switch`,
  `SegmentedControl` or user-facing `WebView` exists.
- `keyboardAppearance` is unset everywhere and deliberately left so. A
  system-themed keyboard is legible in either appearance, and it is the one surface
  where following the phone is right rather than merely tolerated.
- **Not verified: any of it on a device, in either appearance.** This is the whole
  of the gap. The nav-bar diagnosis is a HYPOTHESIS — the phone's appearance mode
  during the device pass was not recorded, and "white digits on white with only the
  selection band visible" is strong evidence for dark but it is inference. The
  device checklist is written to kill the hypothesis if it is wrong: in **light**
  appearance the chevron should already have worked before this change, so if it is
  visible and still dead, the cause is something else and this entry's item 4
  reasoning is void. The fix stands either way; the diagnosis does not.
- **Not verified: the native flip.** `userInterfaceStyle: "light"` has not been
  built, because doing so requires the build this decision defers.

### A containment note worth keeping

`StatusBar style="light"` in `app/_layout.tsx` is the part of this that was broken
in **light** appearance, not dark — white status-bar glyphs over a system-default
light navigation bar, on ten screens, every day, for anyone who never turns dark
mode on. It was invisible as a bug because it reads as low contrast rather than as
breakage, and because the global declaration and the per-screen headers were
written at different times and never compared.

The lesson is narrower than the appearance one: **a global declaration about
chrome is a claim about every screen, and it is only true if every screen was
checked against it.** Painting the headers navy is what makes that claim true
here; it is not a styling preference.
