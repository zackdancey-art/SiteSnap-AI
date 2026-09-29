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
