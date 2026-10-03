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
**Status:** Accepted, with an expiry condition (below). **(b) landed 2026-10-03 —
see "(b) landed" below.**
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

### (b) landed — 2026-10-03

`app.config.ts` now declares `userInterfaceStyle: "light"`.

| | |
|---|---|
| Commit | `f98c425` on `feat/invite-universal-links` |
| App version | `1.0.0` (from `apps/mobile/package.json`, which `app.config.ts` reads) |
| iOS build number | **to be recorded** — `appVersionSource: "remote"` with `ios.autoIncrement: true`, so EAS assigns it at build time. `eas build:list --platform ios --limit 1` prints it once the build finishes |

The build number is deliberately left blank rather than guessed. The commit is the
durable identifier anyway: it says exactly which source produced the binary, which
a build number does not.

**It travelled with the Universal Links entitlement** (ADR-0003) rather than in a
build of its own. Both are native-only changes that cannot ship over `eas update`,
and the release path — a store build plus Apple review — is the expensive part. One
build carrying two native changes is one trip through it.

**(a) was not touched.** The explicit `headerStyle` / `headerTintColor` /
`themeVariant` props are all still in place, per the decision above: *do not remove
them as cleanup when the native flip lands.* They are also the insurance that makes
this flip safe to make before it has been seen on a device — if `"light"` somehow
does not take effect, the per-surface props still render the app correctly, because
that is the state it has been shipping in since 2026-10-01.

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
- **Not verified on a device: the native flip.** As of 2026-10-03 the declaration
  is made and the *resolved* config was read back rather than trusted — `expo config
  --type public --json` reports `userInterfaceStyle: "light"`, so the value survives
  the config function and reaches prebuild. What that does **not** establish is the
  thing that matters: nobody has yet put the resulting binary on a phone set to dark
  appearance and looked at the four surfaces in the table above. Until someone has,
  the diagnosis in this entry remains a hypothesis that the fix happens to be
  compatible with, exactly as the bullet above says.

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

---

## ADR-0003 — Claim `www.getsitesnapai.com` for invitation links, and only that host

**Date:** 2026-10-03
**Status:** Accepted, partially inert until three by-hand steps are done (below)
**Finding:** Stage 0 invitation review — the invitation link cannot work for the
only people who ever receive one
**Scope:** `apps/mobile/app.config.ts` (`ios.associatedDomains`),
`website/.well-known/apple-app-site-association`, `website/invite/index.html`, and
the `INVITE_URL` environment variable on the API deployment

### The problem

`services/api/src/services/notificationService.ts:297` builds the invitation link as:

```ts
const inviteUrl = `${process.env.INVITE_URL || "sitesnap://invite"}?token=${payload.token}`;
```

`INVITE_URL` is unset, so every invitation email that has ever been sent contains a
`sitesnap://` custom-scheme URL. **A custom scheme resolves to nothing on a device
that does not already have the app installed** — and that describes every person an
invitation is for. The recipient of a crew invitation is, by definition, someone who
is not yet using SiteSnap.

So the product's only onboarding path for anyone other than the account owner ends
in a link that does nothing, and the failure is silent on the recipient's side and
invisible on ours: the email is delivered, the send is recorded as successful, and
the invitation simply is never accepted. There is nothing in Sentry to find,
because nothing errors.

### Options considered

| | Option | Cost | Risk |
|---|---|---|---|
| **(a)** | Universal Links on an `https` host, plus a web page at the same URL for the not-installed case | A native rebuild (entitlement), a static file, a page, and one environment variable | The AASA mechanism fails silently when misconfigured — see below. Mitigated by making each step separately verifiable |
| **(b)** | Keep the custom scheme and tell people in the email to install first | Zero | This is the status quo with better wording. The link is still dead, and the token still arrives by a route the recipient cannot use |
| **(c)** | Accept the invitation in the browser instead | A real web auth flow for crew, who have no web product; a second implementation of token redemption next to `acceptSiteInvite` | Two code paths for the one security-critical operation in the invitation flow. Out of all proportion to the problem |
| **(d)** | Claim both the apex and `www` | None extra in the app | **Cannot work** — the apex cannot serve the file. See the first measurement below |

### Decision: (a), pinned to `www`, iOS only

`ios.associatedDomains: ["applinks:www.getsitesnapai.com"]`, with
`/.well-known/apple-app-site-association` on that host and a real page at `/invite`.

**`www`, not the apex, and this is measured rather than preferred.**
`getsitesnapai.com` returns a 301 on every path, `/.well-known/` included, and
**Apple does not follow redirects when fetching the AASA file.** An
`applinks:getsitesnapai.com` entitlement would have built, signed, installed and
passed review, and then silently never activated — the single worst failure shape
available here, because everything upstream of it looks correct. Option (d) is not
a worse trade-off than (a); it is a non-fix that resembles one.

**`components`, not the legacy `paths` array.** `expo-build-properties` sets
`ios.deploymentTarget: "16.4"`, and `components` has been supported since iOS 13,
so there is no device in the installed base that needs `paths`. `components` also
expresses the thing `paths` cannot: `"?": { "token": "?*" }` requires a non-empty
token, so a bare `/invite` link stays in the browser and shows the page instead of
opening the app with nothing to redeem.

**iOS only.** Android App Links would need `/.well-known/assetlinks.json`, an
`android.intentFilters` block with `autoVerify`, and the SHA-256 fingerprint of the
signing key. There is no Android build to verify any of it against, and an unverified
App Link is the same silent non-activation as the apex case. Deliberately omitted
rather than overlooked.

**The custom scheme is kept, not replaced.** `app/+native-intent.tsx` matches
`sitesnap://invite?token=` (via `hostname`) and `https://…/invite?token=` (via
`pathname`) in the same branch, so both forms resolve to the same in-app route.
Existing emails in people's inboxes keep working exactly as well as they did, and
the landing page offers the `sitesnap://` form as a manual fallback for the case
where a Universal Link does not fire — opened from inside an app that strips them,
for instance.

### This decision accepts a new exposure, deliberately

Moving the link from `sitesnap://` to `https://` puts the invitation token in the
query string of a request to a web server. **The token now appears in Render's and
Cloudflare's access logs**, where previously it existed only in the email. That is a
real, new place for a credential to sit, and it is the price of the feature.

It is accepted because the token is weak by construction and strongly bound:

- 64 hex characters from `crypto.randomBytes(32)` — 256 bits, so guessing is not the
  threat; only disclosure is.
- **Redeemable only by the invited address.** Both acceptance paths compare
  `invited_email` against the authenticated caller and return `wrong_user` otherwise
  (`projectsStore.ts`, in-memory and DB). A token read out of a log is useless to
  anyone who cannot also authenticate as that specific email address.
- **Single-use and expiring.** The DB path claims it with
  `DELETE FROM site_invites WHERE token=$1 AND expires_at > NOW() RETURNING *` — one
  statement, so concurrent attempts cannot both win — and `expires_at` is set to
  `Date.now() + 7 days` at both creation sites. A `wrong_user` rejection rolls back,
  so a failed attempt does not burn a legitimate invitation.

The page reduces what it can and does not pretend to reduce the rest:
`referrer: no-referrer` so the token cannot leak in a `Referer` header,
`robots: noindex` so a token-bearing URL never enters a search index, **zero
third-party resources** so no outside host is even told the URL was visited, and a
`history.replaceState` that drops the token from the address bar and the history
entry once it has been read. **None of that touches the server log**, which is why
it is written down here instead of being treated as solved.

### Three steps this decision does not complete

The entitlement is **inert, not broken**, until all of these are done. Each is
separately verifiable, which is the mitigation for (a)'s silent-failure risk:

1. **The website redeploys** with `.well-known/apple-app-site-association` and
   `invite/index.html`. Verify: `curl -sI
   https://www.getsitesnapai.com/.well-known/apple-app-site-association` returns 200
   with **zero redirects**.
2. **`INVITE_URL` is set** to `https://www.getsitesnapai.com/invite` on the API
   service. Until then `notificationService.ts` keeps using its `sitesnap://`
   fallback and new emails still carry an unusable link — the app change alone
   changes nothing for a single recipient.
3. **A build carrying the entitlement is installed.** Verify against Apple rather
   than against ourselves: `curl
   https://app-site-association.cdn-apple.com/a/v1/www.getsitesnapai.com` returns
   404 today and returns the parsed JSON once Apple's CDN has fetched and accepted
   the file. That is the only check that proves Apple agrees, as opposed to proving
   the file exists.

### What would change the answer

- **The app is published on the public App Store.** It is not today —
  `https://apps.apple.com/app/id6813701040` returns 404 and the iTunes lookup API
  returns `resultCount: 0` for both the default store and `country=nz` — so the
  landing page tells people to ask for a TestFlight invitation instead of showing a
  "Download on the App Store" button that would be a dead link. `website/invite/index.html`
  carries the exact replacement markup in a comment next to the copy it replaces.
- **An Android build exists.** Then `assetlinks.json` and `android.intentFilters`
  with `autoVerify` become the matching work, and the signing-key fingerprint has to
  come from the build that will actually ship.
- **The marketing site moves, or the apex starts serving content rather than
  redirecting.** The entitlement names one host. If that host changes, the
  entitlement changes, and that is a native rebuild — not a config tweak.
- **Deferred deep linking is wanted** (install the app and have the invitation apply
  itself without returning to the email). That needs state the token does not have
  and a service we do not run. The current design asks the person to tap the email
  link a second time after installing, which works and costs nothing.

### Verification actually performed

Measurements, with what they returned:

- `curl -sI https://www.getsitesnapai.com/.well-known/apple-app-site-association` →
  **404, `content_type: text/plain`, `num_redirects: 0`**. The path is reachable and
  unredirected on `www`; only the file is missing. This is what makes step 1 a
  deploy rather than a host investigation.
- The apex 301s on every path including `/.well-known/`, which is the whole argument
  for pinning to `www` and against option (d).
- **Content-Type is probably not a blocker, and this was checked rather than
  assumed.** The file has no extension, so a static host's MIME lookup decides. Four
  production AASA files: `www.airbnb.com` → `application/json`, `www.dropbox.com` →
  `application/json; charset=utf-8`, **`www.apple.com` → `application/octet-stream`**,
  `www.notion.so` → `application/octet-stream`. Apple's own deployment serves
  `octet-stream` and Universal Links demonstrably work for it, so Apple's fetcher
  tolerates it. If step 3's CDN check fails anyway, a `Content-Type:
  application/json` header rule on the static site is the first thing to try.
- `python3 -m json.tool` parses the AASA file; it has no BOM (`od -c` on the first
  bytes) and is not caught by `.gitignore` (`git check-ignore`).
- The landing page was **parsed, not eyeballed**: `html.parser` reports two intact
  comments, all three element ids the script needs, and **zero external `href`/`src`
  in the live DOM** — the App Store URL exists only inside a comment, which is the
  claim that mattered. The inline script was run against a stubbed DOM in four cases
  (token present, absent, empty, and needing percent-encoding); each asserted both
  what should appear and what should not, so no case passes vacuously.
- Invite tokens are `crypto.randomBytes(32).toString("hex")` — hex only, so no `+`
  or `/` that a query-string parse would mangle on the way to the `sitesnap://`
  fallback link.
- **Not verified: anything involving Apple.** No build exists yet, so the
  entitlement has never been installed, the AASA has never been fetched by Apple's
  CDN, and no link has ever been tapped on a device. Steps 1-3 above are the
  verification, and until they are done this entry records an intention that
  compiles.

### A containment note worth keeping

Every mistake available in this feature has the same shape: **it installs cleanly
and silently never activates.** A wrong host, a redirect in front of the file, a
missing `INVITE_URL`, an unverified Android App Link — none of them error, none of
them appear in Sentry, and all of them look exactly like success from the side that
ships them. The only honest checks are the ones that ask the other party: Apple's
CDN for whether it accepted the file, and a tapped link on a real device for whether
the entitlement works.

The apex finding generalises past this feature. A hostname's DNS and redirect
behaviour is not infrastructure trivia sitting underneath the feature — here it
*is* the feature's correctness, and it was decided by a 301 that nobody would have
thought to look at. Reasoning about the layer you care about, from a measurement of
a different layer, is how both of this week's near-misses happened.
