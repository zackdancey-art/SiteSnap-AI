# Stage 0 — Consolidated Analysis

**What this is.** The diagnostic report produced before any of the Phase 2–4 work was branched, written or committed. It is the factual basis the Stage 3 legal documents are drafted from, which is why it is in the repository rather than in a terminal scrollback that cannot be cited later.

| | |
|---|---|
| **Reported** | 3 October 2026 |
| **Published to `docs/`** | 3 October 2026, on `feat/invite-universal-links` |
| **Method** | Measured, not reasoned. Every claim below states how it was verified and what the command returned. Where something could not be verified, it says so — part 6 is the list |
| **Status** | A record of what was true when measured. It is **not** maintained. Where a stage has since changed the answer, the change is noted inline rather than silently applied |

**One finding in this report was wrong and has been corrected: the hosting region.** The original asserted Oregon, USA. It is **Singapore**. The correction is recorded in place, in [0A2](#a2--where-each-lives-and-in-which-country), with the mechanism — because the mechanism is the transferable part and the wrong answer is not. Briefly: *a measurement of the wrong layer, not a bad measurement.* The original wording is struck through rather than deleted wherever it appeared, so that the error and its correction travel together.

**Three of the by-hand items in part 5 have since been answered**, and are annotated there: the host (item 1), the Postgres region (item 4), and `store: false` (item 11).

---

# 0A — The five UI items

## Item 1 — the dev client points at production

**File:** [api-base-url.ts](../Projects/apps/mobile/lib/api-base-url.ts), with the value coming from `Projects/apps/mobile/.env` (gitignored, `Projects/.gitignore:5: **/.env`).

**Cause, read from the code.** `resolveApiBaseUrl()` resolves in order `EXPO_PUBLIC_API_BASE_URL` → `EXPO_PUBLIC_API_URL` → `Constants.expoConfig.extra.apiUrl`. The guards run in one direction only:

```ts
if (!__DEV__) { /* throw on missing URL */ }
if (!__DEV__ && (isLocalhostUrl(candidate) || isLanUrl(candidate))) { /* throw */ }
```

Every guard protects **production from dev values**. Nothing protects **dev from production values**. A `__DEV__` run with `EXPO_PUBLIC_API_URL=https://sitesap-ai.onrender.com` is accepted silently.

**One correction to your statement of the problem, and it narrows it.** The EAS `development` profile in [eas.json](../Projects/apps/mobile/eas.json) already sets `EXPO_PUBLIC_API_URL: "http://localhost:4000"`. So an EAS-built dev client is already safe. The exposure is exclusively your local `.env` driving `expo start` / `expo run:ios`.

**Proposed fix.** Add the mirror-image guard in `api-base-url.ts`: under `__DEV__`, a non-local URL is refused unless `EXPO_PUBLIC_ALLOW_PROD_API=1` is explicitly set, and the dev default becomes `http://localhost:4000`. Commit a `Projects/apps/mobile/.env.example` documenting both. This cannot break production (`__DEV__ === false` there, so the branch is unreachable) and cannot break EAS (all four profiles set the URL explicitly). `logResolvedApiBaseUrlOnce()` already runs at boot in [_layout.tsx](../Projects/apps/mobile/app/_layout.tsx) — it gains a loud warning when the opt-in is active. The lever is in code rather than in `.env` precisely because `.env` is gitignored and no commit can reach it.

**JS-only.**

## Item 2 — the back chevron does nothing

**Files:** [terms-of-service.tsx](../Projects/apps/mobile/app/terms-of-service.tsx), [privacy-policy.tsx](../Projects/apps/mobile/app/privacy-policy.tsx), [_layout.tsx:180-186](../Projects/apps/mobile/app/_layout.tsx#L180-L186).

**I have not found the defect by reading, and I am not going to guess.** Here is what reading did establish, because it narrows the instrument considerably.

Both screens are **bare `ScrollView`s**. Neither renders a `ScreenHeader`, a `BackButton`, or a `Stack.Screen` override. The chevron you are tapping is therefore the **native `UINavigationBar` back button**, drawn by `@react-navigation/native-stack` and configured only by the root `screenOptions` (`headerBackTitle: "Back"`, `headerTintColor: Colors.white`).

Eliminated by reading, with the evidence:

| Candidate | Verdict | Evidence |
|---|---|---|
| Double registration | **No** | `grep -o 'name="[^"]*"' _layout.tsx \| uniq -c` — every route name appears exactly once (30 registrations, no duplicates) |
| Custom `headerLeft` intercepting | **No** | Zero occurrences of `headerLeft` or `headerBackVisible` in `app/` or `components/` |
| A `beforeRemove` / `preventRemove` guard | **No** | Zero occurrences of `beforeRemove`, `preventRemove`, `usePreventRemove`, `gestureEnabled` anywhere in the mobile app |
| A touch-capturing view over the chevron | **No** | The native header is outside the JS view tree on these screens; the screen's own tree starts at the `ScrollView` below it |
| Empty history | **Unlikely** | `headerBackVisible` is unset, so native-stack renders a back button only when the stack has depth ≥ 2. A *visible* chevron is evidence of depth. This is inference from the library's default, not proof |
| `router.push` resolving elsewhere | **No** | You are on the screen, so the push resolved |

**The structural fact reading did turn up, and it changes the scope of the item.** There are two distinct back-button mechanisms in this app, and they share no code:

- **Pattern A — native header chevron.** Six pushed screens registered `headerShown: true` with no body header: `export-diaries`, `backup-data`, `privacy-policy`, `terms-of-service`, `help-support`, `supervisor-dashboard`.
- **Pattern B — JS `Pressable`.** Everything else: `headerShown: false` plus `ScreenHeader` → [BackButton.tsx](../Projects/apps/mobile/components/BackButton.tsx) → `goBackSafe()` → `router.canGoBack() ? router.back() : router.replace(homeFallback)`.

The screen that pushes you to Terms of Service — [settings/data-privacy.tsx](../Projects/apps/mobile/app/settings/data-privacy.tsx) — is Pattern B. So **a fix proven on one pattern says nothing about the other**, and "every screen reached the same way" means the six Pattern-A screens, not all twenty-odd pushed screens. That is worth knowing before you accept any fix here.

**Proposed instrument.** Generalising the Phase 1 probe is cheap and I recommend it:

1. `EXPO_PUBLIC_NAV_PROBE=<route>` in `_layout.tsx`, same `__DEV__` + env-var gate and same `router.push()` shape as the existing `EXPO_PUBLIC_SIGNATURE_PROBE` block at [_layout.tsx:44-60](../Projects/apps/mobile/app/_layout.tsx#L44-L60). Required because `expo-dev-launcher` claims `sitesnap://`, so `simctl openurl` cannot reach expo-router.
2. A `__DEV__`-gated listener on the navigation container's `__unsafe_action__` and `state` events, logging every dispatched action alongside the resulting route stack.

That second piece is the whole point: it captures **whether a `GO_BACK` action is dispatched at all**, which is the single bit that splits the hypothesis space in half. No action dispatched → the press never reaches JS (native hit-test, appearance, or something in the header itself). Action dispatched but the stack unchanged → the pop is swallowed (wrong navigator, or a re-push). Either answer is a mechanism, not a guess.

Run matrix: all six Pattern-A screens plus three Pattern-B controls, on the iPhone 17 Pro simulator (`F3C7E44D-3753-43F3-9E1E-AB1CC07691F8`), with item 1's guard already landed so nothing touches your live database.

**The honest bound, stated now rather than after.** `__DEV__` is false on your TestFlight binary. If the defect is release-only, this instrument will come back clean, and I will tell you that rather than offer a third hypothesis. What I would then need from you is a `preview`-profile build installed on your phone.

**JS-only** — both the probe and anything in the plausible fix space.

## Item 3 — the negative-span timesheet

**Files:** [crew/[siteId].tsx](../Projects/apps/mobile/app/crew/[siteId].tsx) (client), [routes/crew.ts](../Projects/services/api/src/routes/crew.ts) (server), `migrations/026_crew_timecards_time_columns.sql` (schema).

**Q1 — where is it validated on save?** Nowhere. `handleAdd` (lines 205-224) validates exactly one thing:

```ts
if (!workerName.trim()) { /* the only guard */ }
```

No format check, no ordering check, no net-duration check.

**Q2 — what does the duration calculation do?**

```ts
function calcHours(start: string, end: string, breakMin: number) {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const totalMin = (eh * 60 + em) - (sh * 60 + sm) - (breakMin || 0);
  const total = Math.max(0, totalMin / 60);
  ...
}
```

Your screenshot reproduces exactly: `(6×60+20) − (7×60+5) − 45 = 380 − 425 − 45 = −90` minutes, clamped by `Math.max(0, …)` to `0.0h` regular and `0.0h` overtime. The clamp is what converts a nonsensical entry into a plausible-looking payroll row.

**Q3 — does the server accept it? Yes. A client-only fix is cosmetic.**

```ts
startTime: z.string().optional(),
endTime: z.string().optional(),
hoursRegular: z.number().min(0).max(24),
```

`startTime` and `endTime` are arbitrary optional strings — no `HH:MM` format check and no relationship between them. `hoursRegular` has `min(0)`, so `0` is a valid submission. `POST /crew/timecards` safeParses and inserts.

**Q4 — is there a second bug underneath? There are three.**

- **The finish field does not initialise from the start value.** Lines 153-155: `useState("07:00")`, `useState("15:30")`, `useState("30")` — both times are independent hardcoded literals.
- **`prefillFromLast` (195-200) copies the previous row's start and end times.** So one bad row propagates into the next entry.
- **The hours chip is unconditionally success-green** (597-599): `hoursChip: { backgroundColor: Colors.success + "18" }`, `hoursChipText: { color: Colors.success }`. There is no zero state and no invalid state — `0.0h` renders in the identical green as `8.0h`. That is the green in your screenshot, and it is the reason the row reads as fine.
- On AM/PM: the picker is `mode="time"` with a spinner display, and `hhmmToDate` (82-87) builds a `Date` at today's H:M. The AM/PM wheel is unconstrained — a picker opened for "finish" can land on AM, and nothing anywhere requires finish to be after start.

**Q5 — existing rows, and how to find them.** `crew_timecards` is **FORCE ROW LEVEL SECURITY** (applied by migration 025 through a dynamic `DO` loop over `['site_members','material_deliveries','crew_timecards','inspections']` — note that the `grep -l "FORCE ROW LEVEL SECURITY"` procedure in `CLAUDE.md` misses all four of those, which is a separate finding below). So a bare query returns **zero rows even as the database owner**. Run this in the Render psql shell, read-only, both statements together. **Substitute the owner's account email for `<owner email>` on the first line** — `company_id` is `'company_' || md5(owner_email)`, so the literal has to be the real address for the query to return anything, and leaving it parameterised here keeps the tenant-key derivation out of a document that may be handed to a customer:

```sql
SET app.company_id = 'company_' || md5('<owner email>');

SELECT id, date, worker_name, start_time, end_time, break_minutes,
       hours_regular, hours_overtime, deleted_at,
       (split_part(end_time,':',1)::int * 60 + split_part(end_time,':',2)::int)
     - (split_part(start_time,':',1)::int * 60 + split_part(start_time,':',2)::int)
     - COALESCE(break_minutes,0) AS net_minutes
FROM crew_timecards
WHERE start_time IS NOT NULL AND end_time IS NOT NULL
  AND start_time ~ '^[0-9]{1,2}:[0-9]{2}$' AND end_time ~ '^[0-9]{1,2}:[0-9]{2}$'
  AND (split_part(end_time,':',1)::int * 60 + split_part(end_time,':',2)::int)
    - (split_part(start_time,':',1)::int * 60 + split_part(start_time,':',2)::int)
    - COALESCE(break_minutes,0) <= 0
ORDER BY date DESC;
```

It is arithmetic rather than a lexical `end_time <= start_time` comparison, so it is correct whether or not the stored values are zero-padded. **No migration, no `UPDATE`, no `DELETE`** — I am not writing one and this does not alter anything.

**Overnight shifts: not supported today.** `calcHours` is plain subtraction with no day rollover, and the result clamps to zero. An overnight shift entered today already records `0.0h`. So rejecting `end <= start` breaks nothing that currently works, and I am not building overnight support here.

**Proposed fix.** Server first, because that is the authoritative half: a Zod `.refine()` on `TimecardSchema` requiring `HH:MM` on both fields and a positive net duration, returning a 400 that names the offending field. Client: the same rule in `handleAdd` with the message on the finish field; the finish default derived from start; `prefillFromLast` declining a prefill that would fail the rule; and the chip styled conditionally so zero hours is not green. Test: one `node:test` case in `routes/crew.test.ts` asserting the 400 **with the positive control in the same test** (a valid card → 201), per `CLAUDE.md` §6.

**JS-only on mobile. No migration.** The server half is an ordinary API deploy.

## Item 4 — swipe-to-dismiss on New Entry

**How New Entry is presented today**, which is what you asked first: [_layout.tsx:126-132](../Projects/apps/mobile/app/_layout.tsx#L126-L132) registers it as

```tsx
<Stack.Screen name="new-entry" options={{ title: "New Entry", presentation: "modal", headerShown: true }} />
```

A **native iOS modal (page sheet)**. So the swipe-down gesture is **already active and already discards**. This is not a presentation change and not a new gesture handler — it is a guard on a gesture that exists and currently loses data.

**What is lost.** The draft auto-save in [new-entry.tsx](../Projects/apps/mobile/app/new-entry.tsx) is debounced 1.5s, applies to new entries only, and restores `date / weather / locationAddress / crewCount / notes`. Its own comment at lines 215-216 says *"Restore fields without photos (photos aren't persisted in draft)"*. So a swipe dismiss loses **every photo and every photo caption**, plus anything typed inside the debounce window. That is the data-loss bug, and the draft save is what disguises it.

**Nothing guards it.** Zero occurrences of `beforeRemove`, `preventRemove`, `usePreventRemove` or `gestureEnabled` in the entire mobile app.

**The save-in-flight race is real today.** `saveProgress` / `saving` (463-464) and the synchronous `savingRef` (467, 498-499, 506) from the double-save fix are both in place, and a full-screen `<Modal visible={saving} transparent>` renders at line 957 with "Keep the app open until this finishes." But **an iOS `<Modal>` is a separate native window** — it does not block the page sheet's dismiss gesture on the window beneath it. So a swipe mid-save is currently possible, and it is exactly the race you asked me not to open. It is already open.

**Proposed fix, and the evidence that it is JS-only.** `usePreventRemove(saving || isDirty, callback)` from `@react-navigation/native`. The decisive evidence is in the installed source, not the docs — `@react-navigation/native-stack@7.14.2`:

```js
// lib/module/views/NativeStackView.native.js
:180   const isRemovePrevented = preventedRoutes[route.key]?.preventRemove;
:285   preventNativeDismiss: isRemovePrevented   // iOS
```

React Navigation wires `preventRemove` straight onto the native screen's `preventNativeDismiss` prop, which is already compiled into your installed binary. `onNativeDismissCancelled` is present for the cancelled-gesture bookkeeping. When `saving` is true the callback shows nothing dismissible, so **the gesture cannot interrupt a save**; when dirty-but-idle it shows "Discard this entry?" with *Discard* and *Keep editing*. When neither, the swipe passes through untouched. The header's existing way out routes through the same callback, which is arguably an improvement rather than a regression.

**Finding, not scope.** `create-site` and `profile` are registered as modals with exactly the same shape and exactly the same unguarded gesture. I am reporting that, not widening the item.

**JS-only, no rebuild.**

## Item 5 — the supervisor dashboard

**File:** [supervisor-dashboard.tsx](../Projects/apps/mobile/app/supervisor-dashboard.tsx), with the duplicate title originating at [_layout.tsx:190-195](../Projects/apps/mobile/app/_layout.tsx#L190-L195).

Causes for each of your five named problems:

1. **"Dashboard" twice.** The native header title is `title: "Dashboard"` (`_layout.tsx:193`); the first child of the `ScrollView` is `<Text style={styles.heading}>Dashboard</Text>`. The ~40pt is the header height plus the content's 16pt padding.
2. **"2 Total Entries" and "2 entries".** `<Metric label="Total Entries" value={entries.length} />` in the grid, and `{siteEntryCount} entries • {siteDiaryCount} diaries` on the site card. Same number, two vocabularies, one screen.
3. **Two of four cards structurally zero.** `approvedDiaries = diaries.filter(d => d.status === "approved").length`; `draftDiaries = diaries.length - approvedDiaries`. With no diaries both are `0`, and they will stay `0` until you generate one. The grid reserves half its area for a state the product hasn't reached.
4. **The export button is the loudest thing.** `styles.actionButton` is `backgroundColor: Colors.accent`, height 46, full width — the only accent-filled element on the screen.
5. **No sense of when.** Nothing on the screen reads a date. Sites render in whatever order `useData()` returns.

**An unasked-for defect in the same file, and it is more serious than any of the five.** Lines 22-32 return early for the non-supervisor case, **before** `const metrics = useMemo(…)` at line 34. That is a conditional hook: a render where `canSeeSupervisor` is false calls one fewer hook than a render where it is true. `useAuth()` resolves asynchronously, so the owner path is precisely `null → owner` — false then true — and React throws *"Rendered more hooks than during the previous render."* Whether it fires today depends on whether the first render ever observes `user == null`, which depends on auth-context hydration order. It is latent, not theoretical.

**And the commit gate cannot catch it.** [.eslintrc.js:23](../Projects/.eslintrc.js#L23) declares `plugins: ["@typescript-eslint", "import"]`. `eslint-plugin-react-hooks` is **not installed** (`ls Projects/node_modules/.pnpm/eslint-plugin-react-hooks*` → no matches), and `pnpm -C Projects exec eslint apps/mobile/app/supervisor-dashboard.tsx` **exits 0**. Every conditional-hook bug in this repo passes typecheck and lint silently. That is a repo-wide finding, not a dashboard one.

**Proposed layout, in words.** Nothing below needs data the screen does not already hold, so this cannot drift into the parity work.

- **Delete the in-body `<Text>Dashboard</Text>`.** Keep the native header title. One line removed; problem 1 gone.
- **Replace the 2×2 grid with one honest summary sentence** under the subheading, built from the same values: *"1 active site · 2 entries · no diaries yet."* Problems 2 and 3 both dissolve — each count appears once, and a zero reads as a sentence rather than as an empty card. With one site and two entries it reads as a product with one site and two entries.
- **The site list becomes the body**, immediately under that sentence, with the "Sites" section title removed — the screen *is* the site list, so the label is noise. Each card keeps name, status, client, address, and gains the recency answer: **"Last entry 2 days ago"**, or "No entries yet", derived from `max(entry.date)` over that site's entries — already in `entries`.
- **Sort the list by most-recent entry, descending.** That is the real fix for problem 5: recency becomes the *ordering*, not another widget.
- **The export button moves to the bottom as a secondary action** — outlined, `Colors.border` with `Colors.primary` text. It keeps its tap target and stops shouting. (The alternative, a header text action, adds an affordance to maintain for no gain.)
- **"Approved Diaries" and "Draft Diaries" leave the first screen.** If that distinction earns its place, it earns it on the diary screen where the word "diary" already has context.
- **Fix the hook order**: compute `canSeeSupervisor`, call every hook unconditionally, and return the restricted view after them.

No new hex; `Colors.border`, `Colors.primary`, `Colors.textSecondary` only.

**JS-only.**

> ## The 0A conclusion the build order turns on
> **All five Stage 1 items are JS-only. Not one needs a native rebuild.** One build suffices, and your non-sequential ordering survives.

---

# 0B — Invitations and the native configuration

## Q1 — confirm the diagnosis from the code

Confirmed, and **the fix is smaller than you think**. [notificationService.ts:297](../Projects/services/api/src/services/notificationService.ts#L297):

```ts
const inviteUrl = `${process.env.INVITE_URL || "sitesnap://invite"}?token=${payload.token}`;
```

Used at line 303 (plain-text fallback) and line 312 (`ctaButton`). So the `sitesnap://` scheme is a **fallback default for an environment variable that already exists**. Setting `INVITE_URL` on the Render API service changes both the button and the fallback link with **zero code and zero deploy**.

## Q2 — does the app handle the link when it does open?

**Yes, and this also needs no code change.** [+native-intent.tsx](../Projects/apps/mobile/app/+native-intent.tsx) already normalises and routes invites:

```ts
const normalized = rawPath.startsWith("http://") || rawPath.startsWith("https://") || rawPath.startsWith("sitesnap://")
  ? rawPath : `sitesnap://${rawPath.replace(/^\/+/, "")}`;
const url = new URL(normalized);
const pathname = url.pathname.replace(/^\/+/, "");
const isInvite = hostname === "invite" || pathname === "invite";
if (isInvite) return token ? `/invite?token=${encodeURIComponent(token)}` : "/invite";
```

For `https://www.getsitesnapai.com/invite?token=X`, the `https://` branch passes the URL through unchanged, `pathname` resolves to `"invite"`, and the match succeeds via the **pathname** arm. [invite.tsx](../Projects/apps/mobile/app/invite.tsx) exists and is registered (`headerShown: false`). Whoever wrote `redirectSystemPath` handled both hostname and pathname forms, which is exactly what universal links need.

**So Stage 2 is: entitlement + AASA file + the `INVITE_URL` value + a landing page. No mobile JS.**

**How to test it on your phone**, once the build is installed: put the URL in a Note or a Message to yourself and **tap it there**. Do not type it into Safari's address bar — Safari deliberately bypasses universal links for directly-typed URLs. A long-press on the link showing "Open in SiteSnap" is the positive confirmation that the AASA was fetched and cached.

## Q3 — the recommendation, and the one place your expectation is wrong

Your expectation is right in substance and wrong in one detail — the detail that would have made the whole feature silently fail.

**The apex `getsitesnapai.com` 301-redirects every path to `www`, and Apple does not follow redirects when fetching the AASA.** Measured:

```
apex /.well-known/apple-app-site-association   301 redirect=https://www.getsitesnapai.com/.well-known/...
apex /invite?token=abc                          301 redirect=https://www.getsitesnapai.com/invite?token=abc
www  /.well-known/apple-app-site-association   404 ctype=text/plain
www  /invite?token=abc                          404 ctype=text/plain
```

Had we used `https://getsitesnapai.com/invite?token=…` as you proposed, the entitlement would have installed, the file would have been published, and universal links would simply never have activated — with no error anywhere to explain it.

**The four sentences, corrected:** The invitation email links to `https://www.getsitesnapai.com/invite?token=…`, set through the existing `INVITE_URL` environment variable. An `apple-app-site-association` file is served from **`www.getsitesnapai.com`** — the host in the link, with no redirect in front of it. The app declares `associatedDomains: ["applinks:www.getsitesnapai.com"]`, which requires one native build. When the app is not installed, that URL serves a real page explaining what SiteSnap is and how to install it, with the token preserved in the address so the install-then-tap path still works.

## Q4 — what breaks for Android

Nothing breaks; the https link **degrades** rather than failing. [app.config.ts](../Projects/apps/mobile/app.config.ts) declares `scheme: "sitesnap"` and `package: "nz.getsitesnapai.app"`, with **no `intentFilters`**. So on Android the https URL opens in the browser and lands on the `/invite` page — which is the correct behaviour for a product with no Android build shipped. Full Android App Links would need `/.well-known/assetlinks.json` plus an `android.intentFilters` entry with `autoVerify: true`. That is **out of scope for this build** (iOS-only), and the old `sitesnap://` scheme keeps working on Android unchanged because the fallback in `notificationService.ts` is only a default, not a removal.

## Q5 — where the AASA file lives, and the Team ID

The marketing site is the repo's `website/` directory served statically, and `www.getsitesnapai.com` is **byte-identical to it** (md5 match, verified). 404s are plain static responses with no framework in front. So:

**Commit `website/.well-known/apple-app-site-association`**, which publishes at `https://www.getsitesnapai.com/.well-known/apple-app-site-association` on the next static deploy. Contents:

```json
{
  "applinks": {
    "details": [
      { "appID": "3FALF4GK4D.nz.getsitesnapai.app", "paths": ["/invite", "/invite?*"] }
    ]
  }
}
```

**Team ID confirmed — you do not need to supply it.** [eas.json](../Projects/apps/mobile/eas.json) carries `"appleTeamId": "3FALF4GK4D"` under `submit.production.ios`, and `app.config.ts:69` carries `bundleIdentifier: "nz.getsitesnapai.app"`. `appID` is the concatenation.

**One by-hand item.** Render serves extensionless files with a content type I cannot predict (the 404 came back `text/plain`). Apple wants `application/json`. That needs a header rule in the Render static-site dashboard for `/.well-known/*`, and it is verifiable with one `curl -I` after deploy. There is no repo-side way to do it — there is no `render.yaml`, `_headers`, `netlify.toml` or `vercel.json` anywhere in the repo, so the static site is dashboard-configured.

## Token handling — single-use, expiry, and leakage

**Confirmed in code, unchanged by Stage 2.** [projectsStore.ts:1167](../Projects/services/api/src/storage/projectsStore.ts#L1167): `generateInviteToken()` = `crypto.randomBytes(32).toString("hex")` — 64 hex characters, 256 bits. `createSiteInvites` sets `expires_at = now + 7 days`. `acceptSiteInvite` consumes it atomically:

```sql
DELETE FROM site_invites WHERE token = $1 AND expires_at > NOW() RETURNING *
```

A single statement — **only one concurrent request can claim a token**. Stage 2 changes the URL the token travels in, not the token, its expiry, or its consumption.

**Leakage surface, and this is a Stage 3 input.** Three exposures, one of them real today:

1. **Referrer.** The `/invite` landing page must carry `<meta name="referrer" content="no-referrer">` and must not load any third-party resource. The current `website/index.html` loads zero external scripts and has no analytics, so this is a constraint to preserve rather than a problem to fix.
2. **Analytics query strings.** None exist. Nothing to leak into.
3. **Server logs — this one is live.** [middleware/logger.ts](../Projects/services/api/src/middleware/logger.ts) is five lines and logs `:url` on **every** request:
   ```ts
   export const httpLogger = morgan(":method :url :status :res[content-length] - :response-time ms reqid=:reqid");
   ```
   So `GET /api/invites/accept?token=…` would write the full token into Render's persistent logs. It already writes member emails from `/api/company/members/:email/role`, push tokens from `DELETE /push/tokens/:token`, and the `?sig=&exp=` signed-media credentials. **Stage 2 should land the token in the request body or a path segment with a redacting log format, not in a query string** — otherwise the feature we build ships a credential into a log file. I'll treat that as part of Stage 2 rather than a separate finding.

## The native configuration, settled

Two edits to `Projects/apps/mobile/app.config.ts`, both known now:

```ts
userInterfaceStyle: "light",            // was "automatic" (line 47)
ios: {
  bundleIdentifier: "nz.getsitesnapai.app",
  associatedDomains: ["applinks:www.getsitesnapai.com"],   // new
}
```

`associatedDomains` compiles to the `com.apple.developer.associated-domains` entitlement; `userInterfaceStyle: "light"` writes `UIUserInterfaceStyle: Light` into `Info.plist`. Both are prebuild-time changes, both land in one build. `ios/` remains absent — nothing here creates it, and I will not `git add -f` it. The explicit per-component `headerStyle` / `headerTintColor` / `themeVariant` props all stay; the comment in `_layout.tsx` already records that intent and ADR-0002's expiry condition (a real `Colors.dark`) is unaffected.

---

# 0C — The data-flow audit

## A1 — every personal-information field, by source

| Source | Fields | Notes |
|---|---|---|
| **Account / company** | email, full name, phone, role, company name, `password_hash` (scrypt), bearer token | `auth_users`. `company_id = 'company_' \|\| md5(owner_email)` — **derived from the email, so the tenant id is a hashed identifier, not an opaque one** |
| **Pending registration** | email, full name, role, company name, phone, **plaintext `email_code` and `sms_code`** | `auth_pending_registrations`. Identity fields are packed into a column literally named `password_hash`: `` `${passwordHash}::${fullName}::${role}::${companyName ?? ""}` `` ([auth.ts:207-217](../Projects/services/api/src/routes/auth.ts#L207-L217)). OTP codes are `TEXT NOT NULL` in cleartext (`001_initial_schema.sql:16-26`) |
| **Crew members** | `site_invites`: invitee email, inviting user, token, expiry. `site_members`: member email, role. `crew_timecards`: `worker_name` as free text | **This is the one you flagged, and it is worse than invited-but-not-consented.** `worker_name` on a timecard is free text — a named person can have employment records in this system **without ever being invited, without an account, and without any identifier they could use to ask about it** |
| **Timesheets** | worker name, date, start/finish, break minutes, regular hours, overtime, trade, notes | `crew_timecards`. Hours by named person by day — employment data, and in a wage dispute, evidence |
| **Photographs** | the image itself, caption, EXIF status **unverified**, S3 key, uploader email, `company_id`, timestamp | `uploads` + S3. Also cached **raw base64** on the device in `sitesnap.photoPayloads` |
| **Location** | latitude, longitude, accuracy, `user_email`, `userName`, timestamp, 5-minute interval while foregrounded | `worker_locations` via `POST /api/location/update` |
| **Signatures** | handwritten signature path data, `view_box`, signer name, role, `signed_at`, `content_hash`, snapshot | `inspection_signatures`. **See the jurisdiction note below** |
| **Incidents** | injured-party name, description, severity, witness free text, photos | `incidents` |
| **Free text** | entry notes, hourly notes, diary narrative, captions, delivery notes, inspection findings | Unbounded. Everything an unbounded text field can contain, it does |
| **Telemetry** | API Sentry: traces, messages, stack frames. Mobile Sentry: `attachScreenshot: true` | See the Sentry note below |

**Things I found that were not on your list:**

- **Emergency contact.** Stored on the device in `sitesnap.profile`.
- **Push tokens.** `push_tokens`, per-device, per-user — a durable device identifier.
- **Device storage holds everything, unencrypted.** The bearer token, `sitesnap.user`, `sitesnap.profile` (including the emergency contact), raw base64 photo payloads, caches, the offline queue and drafts are all in plain **AsyncStorage**. There are **zero uses of `expo-secure-store` anywhere in the app**. On iOS the app container is protected by the device passcode, which is real but is not the same as Keychain storage, and it is a disclosable fact.
- **The bearer token is signed, not encrypted** — a base64url JSON payload carrying email and full name, 7-day TTL. Anyone holding the string can read the email and name without the secret.
- **URL logs.** Per 0B above, `morgan :url` persists emails, push tokens and signed-media credentials.
- **`scrypt` cost factor is never specified** — `promisify(crypto.scrypt)` with a 16-byte salt and `keylen: 64`, format `scrypt$<salt>$<hex>`, compared with `timingSafeEqual`. Node's defaults apply (N=16384), which is on the low side of current guidance. Worth knowing; not worth a migration.

**On signatures and jurisdiction, checked rather than assumed.** Neither the New Zealand Privacy Act 2020 nor the Australian Privacy Act 1988 defines a handwritten signature as a distinct "sensitive information" category — the Australian definition is a closed list (health, racial or ethnic origin, political opinions, religious beliefs, sexual orientation, criminal record, biometric information and biometric templates), and a signature image is not on it. **But** a signature captured as stroke-path data for identity attestation is squarely "personal information" in both, is widely treated as identity-verification data, and in this schema it is additionally bound to a safety inspection — so it travels with safety data about a named person. The honest position for Stage 3 is: not a special legal category, but treated with the same care, and the reason is stated rather than implied. I checked the statutory definitions, not a secondary summary.

**Mobile Sentry is configured but dead.** [_layout.tsx:20-40](../Projects/apps/mobile/app/_layout.tsx#L20-L40) sets `attachScreenshot: true`, `enableNativeFramesTracking: true`, `sendDefaultPii: false`, and a `beforeSend` that deletes only `authorization` and `cookie`. The whole block is gated on `if (sentryDsn)` and **nothing in the repo supplies a DSN**. That matches your backlog note. Two consequences: no mobile crash data is reaching you, and `attachScreenshot: true` means **the moment a DSN is supplied, screenshots of site photos and timesheets start leaving the device** — so that is a decision to make deliberately, not a config to switch on.

## A2 — where each lives, and in which country

| Store | Location | How verified |
|---|---|---|
| **Render Postgres** | **Singapore** | Render dashboard, read by the owner. Corroborated here by co-location timing — see the correction below |
| **Render web services (API, static site)** | **Singapore** | Co-located with the database: `/api/health/ready` costs **+1.8 ms** over `/api/health` for two sequential queries, which is intra-datacentre. Cross-region would cost 300–430 ms from here. See the correction below |
| **S3 `sitesnapai-media`** | `ap-southeast-2` — Sydney, Australia | Bucket config |
| **S3 `sitesnapai-bucket`** (older) | `us-east-1` — N. Virginia, USA | Bucket config |
| **Render Key Value** | **Not in use at all** | `rateLimiter.backend === "memory"` in production → `REDIS_URL` is unset. No emails, phones or IPs are persisted as Redis keys. This also confirms your backlog's "Redis unreachable" |
| **Device** | The user's phone, plain AsyncStorage, no SecureStore | Code |
| **Persistent logs** | Render, Singapore | Code + the region finding above |
| **OpenAI** | United States | Default API tier, no data-residency agreement |

> ### Correction — the region is Singapore. This report's original answer was wrong.
>
> **What this section said first, struck through so the error and its correction travel together:**
>
> > ~~Every Render service chains to `gcp-us-west1-1.origin.onrender.com` — **Oregon, USA**. The S3 half is correct; the Render half is not.~~
>
> That is withdrawn. The owner read the Render dashboard: **Singapore**. The claim already published to users in [settings/data-privacy.tsx](../Projects/apps/mobile/app/settings/data-privacy.tsx) —
>
> > *"The app and database run in Render's Singapore region. Site photos and files are held in Amazon S3 in Sydney (ap-southeast-2)."*
>
> — is **correct on both halves and needs no fix.** It was this report that was wrong, not the app.
>
> #### The mechanism, which is the part worth keeping
>
> **This was a measurement of the wrong layer, not a bad measurement.** The DNS lookup was real and repeatable; `gcp-us-west1-1.origin.onrender.com` genuinely is the CNAME target. But it is the CNAME target of the **ingress** tier. **A hostname's DNS resolution describes where traffic *enters* a provider's network, never where the workload runs.** The instance sat 200 ms behind the name I measured.
>
> The signal that should have caught it was already in the response headers and went unread: `server: cloudflare`, `cf-ray: …-AKL`, `x-render-origin-server: Render`, and TLS terminating **18 ms** from a machine in New Zealand — an Auckland PoP, which no Oregon origin can produce.
>
> **The measurement that settles it**, taken after the correction, as round-trip latency from this machine in New Zealand (minimum of 6–8 samples, computed as `time_connect − time_namelookup` so that DNS lookup is excluded from every reading — an earlier version of this script used bare `time_connect` and contaminated all of them):
>
> ```
> Calibration against in-region AWS endpoints:
>   SYDNEY      ap-southeast-2     44.0 ms
>   OREGON      us-west-2         166.4 ms
>   N. VIRGINIA us-east-1         210.2 ms
>   SINGAPORE   ap-southeast-1    215.5 ms
>
> Measured edge → origin → edge:
>   api.getsitesnapai.com         218.2 ms    ← Oregon predicts ~166 ms
>   sitesap-ai.onrender.com       217.8 ms    ← same, bypassing Cloudflare
>
> Co-location test:
>   /api/health        (no DB)                220.5 ms
>   /api/health/ready  (2 sequential queries) 222.3 ms   → +1.8 ms
> ```
>
> Two things follow. **The timing excludes Oregon by ~50 ms**, far outside the noise of a minimum-of-eight. And **+1.8 ms for two sequential database round trips is intra-datacentre** — cross-region would cost 300–430 ms — so the API and the database are co-located, which carries the dashboard's authority over the *database* region across to the *web service* region.
>
> What the timing cannot do, stated plainly: it cannot separate Singapore (215 ms) from Render's Virginia (210 ms), which are 5 ms apart from here. The dashboard reading is what distinguishes them; the timing corroborates it and kills Oregon.
>
> #### The consequence for Stage 3
>
> The cross-border story is **New Zealand → Singapore**, not New Zealand → United States. Under **IPP 12** of the Privacy Act 2020, disclosing personal information to a foreign person requires reasonable belief that comparable safeguards apply. Singapore has no New Zealand adequacy finding either, so IPP 12 still has to be satisfied on contractual grounds rather than waved away — but it is a materially different and smaller disclosure than the one the original error implied, and Stage 3 must describe the Singapore path.
>
> **United States exposure is therefore exactly two paths, not the whole platform.** This is the narrowing the correction buys, and Stage 3 should disclose these two and no more:
>
> | Path | What goes there | Status |
> |---|---|---|
> | **1. OpenAI** | Site notes, entry text, captions and the photographs sent for vision analysis — one call site, [routes/ai.ts:638](../Projects/services/api/src/routes/ai.ts#L638) | Live on every AI diary generation. Retained as Responses API Application State for **at least 30 days by default**; `store: false` is the one-line change that removes this (part 5, item 11 — since approved) |
> | **2. The legacy S3 bucket `sitesnapai-bucket`** | Older site photographs, in `us-east-1` (N. Virginia) | Historical. The current bucket `sitesnapai-media` is `ap-southeast-2` (Sydney). Nothing in this codebase ever deletes an S3 object, so whatever is in the legacy bucket is still there |
>
> Everything else — the API, the database, the persistent logs, the static site and the current media bucket — stays inside Singapore and Sydney.

## A3 — third parties

**OpenAI — the one that matters most, and the terms are worse than assumed.**

There is exactly one LLM call site, [routes/ai.ts:638](../Projects/services/api/src/routes/ai.ts#L638), `client.responses.create(…)`.

**What is transmitted, with no stripping and no redaction.** `buildVisionInputs` (348-385) sends up to **12 photographs** plus, per photo, `{ imageRef, entryDate, entryLocation, photoTimestamp, userCaption, instruction }`. `structuredPayload` (610-628) sends the `site` object **wholesale**, plus per entry: `date, locationAddress, weather, crewCount, notes, photoCount, photoCaptions`. I looked for a redaction or stripping step on this path and there is none. So site addresses, free-text notes that can name people, and photographs that can contain faces all leave New Zealand for a US API verbatim.

**What OpenAI's terms actually say.** I could not reach `openai.com/policies/api-data-usage-policies/` or `/enterprise-privacy/` — both return **HTTP 403** to WebFetch and to curl with a browser user-agent. I fetched `https://platform.openai.com/docs/guides/your-data` (HTTP 200) and read the retention text directly:

> *"Except as noted below, the Responses API has a 30 day Application State retention period by default, or when the `store` parameter is set to `true`. In those cases, response data will be stored for at least 30 days."*

Plus abuse-monitoring logs retained up to 30 days by default, and no training on API data since 2023-03-01 unless explicitly opted in.

> **This corrects an assumption I was carrying and you may be too.** The retention is **"by default, _or_ when `store` is `true`"** — not *only* when `store` is true. **`store` is never passed anywhere in this codebase.** So SiteSnap's site notes, photo captions and photographs are retained by OpenAI for at least 30 days by default, on top of up-to-30-day abuse logs. Zero Data Retention forces `store: false` and requires OpenAI approval; data residency requires sales approval plus a Modified Retention amendment. **Passing `store: false` explicitly is a one-line change that materially shortens what Stage 3 has to disclose.** It appears in 0D part 2 as an audit finding that changes what gets built.

**The rest:** Resend (transactional email — recipient addresses and invite tokens), Twilio (SMS — phone numbers and OTP codes), AWS S3 (photographs), Render (hosting, database, logs), Sentry (API only; the mobile DSN is unset). All US-headquartered. No analytics, no advertising, no tracking SDK — `website/index.html` loads **zero** external scripts, which is a genuinely good fact Stage 3 can state plainly.

## A4 — retention and deletion: what the machinery actually does

You asked for what it does rather than what it was intended to do. The answer has three layers and two of them don't do what the app says.

**1. Operational records: deletion is a flag.** `incidents`, `crew_timecards`, `inspections` and `material_deliveries` all delete by `UPDATE … SET deleted_at = NOW()`, and all reads filter `deleted_at IS NULL`. The row never leaves the database.

**2. Account deletion: a real DELETE, and more thorough than I initially credited.** [authStore.ts:846-860](../Projects/services/api/src/storage/authStore.ts#L846-L860):

```ts
await getPgPool().query(`DELETE FROM auth_pending_registrations WHERE email = $1`, [email]);
await getPgPool().query(`DELETE FROM auth_users WHERE email = $1`, [email]);
```

Two statements, and **the cascade does the real work**. Every table with `REFERENCES auth_users(email) ON DELETE CASCADE`: `auth_password_reset_tokens`, `project_sites`, `project_entries`, `project_diaries`, `project_templates`, `entry_templates`, `push_tokens`, `crew_timecards`, `incidents`, `inspection_templates`, `inspections` (→ `inspection_signatures` via its own cascade), `material_deliveries`, `site_invites.invited_by`, `site_members.member_email`, `worker_locations.user_email`. Fifteen tables. **Signatures are erasable** — the immutability trigger in `024_incident_inspection_signatures.sql:106-145` is `BEFORE UPDATE` only, so a DELETE cascades through it cleanly.

**3. Three real gaps, and they make the app's message false.**

- **`uploads` has no foreign key to `auth_users`.** `023_uploads_ownership.sql` defines `(id, filename, company_id NOT NULL, owner_email, created_at)` with no FK. Upload rows survive account deletion.
- **No S3 object is ever deleted. By anything.** There are **zero `DeleteObject` calls anywhere in `Projects/services/api/src`**. Not on record delete, not on account delete, not on a retention job. Every photograph ever uploaded is still in the bucket.
- **`companies` is retained by design** — [projectsStore.ts:984](../Projects/services/api/src/storage/projectsStore.ts#L984) says so in a comment: *"by-design under the soft-cancel + 7-year record-retention model."* And `deleteAllUserProjectData` deletes only four tables, deliberately leaving rows under a *former* company.

**So this response string is false:**

```ts
// routes/auth.ts:664-677
{ ok: true, message: "Account and all associated data have been permanently deleted." }
```

**4. "Then permanently purged" is not implemented.** The app publishes:

> *"Deleting a record removes it from your app straight away. A copy is kept for 7 years to meet construction and WorkSafe record-keeping requirements, then permanently purged."*

The first two clauses are true. The third describes nothing. **There is no scheduled job of any kind in the API** — zero `setInterval`, zero cron, no worker process. There is no `retain_until` column and no purge path for operational data. The only purge function in the codebase, `purgeExpiredAuthRecords()` ([authStore.ts:819](../Projects/services/api/src/storage/authStore.ts#L819)), handles expired auth tokens and pending registrations only, and is called **opportunistically from a request handler** ([auth.ts:186](../Projects/services/api/src/routes/auth.ts#L186)) rather than on a schedule. If nobody registers, it never runs.

**5. The orphaned S3 object in L24 — refuted, and the refutation is in your own notes.** You asked me to confirm or refute that the dev client pointing at production explains probe row `1790717610354-7870983cd172d`. **Refute.** [docs/AUDIT.md:471](AUDIT.md#L471) already records its origin:

> *"**One audit probe object.** `uploads/1790717610354-7870983cd172d-probe.jpg`, 201 B, written while verifying the signed-media path during the H9 work. **The S3 object was deleted on 2026-10-01** … **Its `uploads` row was deliberately left in place** — id `1790717610354-7870983cd172d`."*

Line 477 explains why the row was not hand-deleted: `uploads` is FORCE-RLS'd and a bare `DELETE FROM uploads` is a silent zero-row no-op. So that row is a deliberate artefact of the H9 verification, not dev-client contamination. The `.env`→production finding remains real and serious on its own merits; it simply is not the explanation for this row. **Whether any *other* dev-origin data reached production is answerable only against the production database, which I cannot and will not reach.**

## A5 — the honest gaps

> You said this is the most important section, and that the honest answer is probably "the founder can see everything." It is, and it is more than that.

1. **You can see everything, and nothing records that you looked.** You hold the Render dashboard, the database credentials, the S3 keys and the OpenAI key. There is no admin audit log, no access log on reads, and no separation between operating the service and reading its contents. Every photograph, every timesheet, every signature and every incident is readable by one person, and that read leaves no trace. **This is a disclosable fact, and Stage 3 should state it in a sentence rather than engineer around it.**
2. **There is no working way for anyone to request their data.** [backup-data.tsx](../Projects/apps/mobile/app/backup-data.tsx) looks like a data export and is not one. It is `JSON.stringify({ exportedAt, sites, entries, diaries })` taken from the **device cache** and handed to `shareOrDownloadText`. It omits timesheets, incidents, inspections, signatures, locations, photographs and the account record, and it reads from the device rather than the server. Under IPP 6 (access) that is not an access mechanism. Honest answer for Stage 3: requests are handled by emailing you, by hand.
3. **Crew members have no route in and no route out.** A person named on a timecard has no account, may have had no invitation, and has no identifier they could use to ask what is held about them. The only path is through the contractor who entered them. Stage 3 must say that plainly — it is the single hardest thing in the policy and it cannot be worded around.
4. **Photographs outlive the account that uploaded them.** Per A4: no S3 deletion exists. Deleting your account removes fifteen tables' worth of rows and leaves every image file in Sydney.
5. **Location tracking has an opt-in that cannot be reached.** In [location-service.ts](../Projects/apps/mobile/lib/location-service.ts), `requestPermissionAndStart`, `setLocationTrackingEnabled` and `isLocationTrackingEnabled` have **no callers outside that file** — only `resumeTrackingIfEnabled` is imported, at `_layout.tsx:15`, and it runs at every boot. So the consent surface does not exist in the UI while the resume path does. Nothing is being collected today (the flag can never be set to true through the app), but the shape is wrong, and Stage 3 cannot describe a consent flow that has no screen.
6. **The device is the softest store.** Bearer token, profile including emergency contact, and raw base64 photographs, all in plain AsyncStorage with zero `SecureStore` usage.
7. **No breach-notification process exists.** The Privacy Act 2020 requires notifying the Privacy Commissioner and affected individuals of a notifiable privacy breach. There is no monitoring that would detect one — the mobile Sentry DSN is unset and there are no read-access logs.
8. **No data processing agreement with any sub-processor.** Default terms only, across OpenAI, Resend, Twilio, AWS and Render.
9. **One claim is published today that the code contradicts** — the seven-year purge, quoted above. There is no scheduled job of any kind in the API behind it. *(The Singapore region claim was originally listed here as a second contradiction. That was my error, not the app's — see the correction in A2. The published claim is accurate.)*

## A6 — document consistency

**Six documents in four locations, and they are duplicated text today:**

| Document | Location | Draft banner? |
|---|---|---|
| Privacy Policy | [privacy-policy.tsx](../Projects/apps/mobile/app/privacy-policy.tsx) | Yes |
| Terms of Service | [terms-of-service.tsx](../Projects/apps/mobile/app/terms-of-service.tsx) | Yes |
| Data & privacy notice | [settings/data-privacy.tsx](../Projects/apps/mobile/app/settings/data-privacy.tsx) | Yes |
| About | [settings/about.tsx](../Projects/apps/mobile/app/settings/about.tsx) | Yes |
| Privacy Policy | `website/privacy/index.html` | **No** |
| Terms of Service | `website/terms/index.html` | **No** |

All six carry `3 July 2026` and `SiteSnap AI Limited`. Two inconsistencies already exist: the **two marketing pages have no draft banner** while the four in-app screens do, so the public-facing copies look finished; and the **marketing footer asserts `NZBN 9429053872258`** while the in-app notice says the entity must be confirmed *"once the company is incorporated."* One of those is wrong, and it is a question only you can answer.

> **Answered, and in the opposite direction to the one this report expected.** **NZBN 9429053872258 is correct and SiteSnap AI Limited is incorporated.** So the marketing footer is right and the **in-app wording is the stale claim** — `settings/data-privacy.tsx`'s *"once the company is incorporated"* must go. Stage 3 uses **SiteSnap AI Limited, NZBN 9429053872258** consistently across all six documents and removes the pending-incorporation wording wherever it appears.
>
> This is an upgrade rather than a correction: there is a real legal person behind the Terms and a named agency for the Privacy Act, instead of documents signed by nobody in particular.
>
> On how it was settled: this report could **not** verify the NZBN. Every path under the register API returns 404 without a subscription key — including a deliberately invalid NZBN and the service root — so "the register returned 404" carried no information about this one. The positive control is the only reason that was reported as *cannot verify* rather than as *does not exist*.

**Anti-drift proposal, deliberately small.** This is a four-page problem and does not deserve a build step, a CMS or a generator.

Put the canonical text in **`docs/legal/privacy-policy.md`** and **`docs/legal/terms-of-service.md`**, with a one-line header in each naming the four render targets. Then add one shell check to `Projects/scripts/ci.sh` that compares a normalised extraction (tags and whitespace stripped) of each rendered copy against its canonical source and fails the build on divergence. Roughly fifteen lines of `sed` and `diff`, no dependency, no codegen. Editing the markdown without updating the four copies fails CI; updating a copy without the markdown fails CI. That is the whole mechanism.

Why not generate the four files from the markdown: the in-app copies are React components with `Section`/`Body` structure and the web ones are hand-styled HTML, so a generator would have to own both layouts. Detecting drift is the cheap 90%; generating is the expensive 10%. The single `LAST_UPDATED` / "Last updated" date should come from the canonical header and be included in the comparison.

---

# 0D — The consolidated report

## 1 — Every issue found, in one list

**`K` = already known to you. `N` = new.**

### Critical

| | Issue | Why |
|---|---|---|
| **K** | Invitation emails link to `sitesnap://invite?token=…`, which does nothing for a recipient who does not already have the app | The only path to your first customer's crew is broken end to end |
| **N** | **The apex `getsitesnapai.com` 301-redirects every path, including `/.well-known/`, to `www`. Apple does not follow redirects when fetching the AASA** | Your stated plan used the apex. The entitlement would have installed, the file would have been published, and universal links would never have activated, with no error to explain it. Measured, not assumed |

### High

| | Issue | Why |
|---|---|---|
| **K** | `.env` points the dev client at production | Anything run locally writes to your live database. Narrowed: the EAS `development` profile already sets localhost, so the exposure is `expo start` only |
| **K** | The server accepts a finish time before a start time | `TimecardSchema` has no format and no ordering constraint. A payroll document, and in a dispute, evidence of hours worked |
| **K** | New Entry's swipe-dismiss discards photographs and captions silently | The draft save covers five fields and explicitly excludes photos — which is what disguises the loss |
| **N** | **Conditional hook in `supervisor-dashboard.tsx`** — `useMemo` sits after an early `return`, and `useAuth()` resolves `null → owner`, which is exactly the false→true transition that throws | A latent crash on the screen you are about to redesign |
| **N** | **`eslint-plugin-react-hooks` is not installed; `pnpm exec eslint` on that file exits 0** | Every conditional-hook bug in this repo passes typecheck and lint silently. Class-level, not instance-level |
| **N** | ~~**Render is in Oregon, USA — not Singapore.**~~ **Withdrawn — the error was mine.** Render is Singapore and the published claim is correct | Kept visible rather than deleted. The mechanism is the transferable part: a measurement of the wrong layer, not a bad measurement. See the correction in A2 |
| **N** | **OpenAI retains Responses API Application State for at least 30 days *by default*, and `store` is never passed** | Site notes, captions and photographs are retained in the US by default. Correcting an assumption I was carrying |
| **N** | **Nothing in this codebase ever deletes an S3 object** — zero `DeleteObject` calls | Every photograph ever uploaded is still in Sydney, including those belonging to deleted accounts |
| **N** | **`DELETE /auth/account` returns "Account and all associated data have been permanently deleted"** | False. `uploads` rows, S3 objects and `companies` all survive. A promise made to a user, in writing, that the code does not keep |
| **N** | **"Then permanently purged" after 7 years is not implemented** — no scheduled job of any kind exists in the API | A published retention commitment with no mechanism behind it |
| **N** | **`morgan :url` logs every request URL** into Render's persistent logs | Member emails, push tokens and signed-media `?sig=&exp=` credentials today — and the invite token too, if Stage 2 puts it in a query string |
| **N** | **Zero `SecureStore` usage.** Bearer token, profile including emergency contact, and raw base64 photographs all in plain AsyncStorage | The softest store in the system, and a disclosable fact |
| **K** | Legal documents are unreviewed drafts | Stage 3 |

### Medium

| | Issue | Why |
|---|---|---|
| **K** | Back chevron inert on Terms of Service | Reading eliminated every structural cause; needs the instrument |
| **K** | `userInterfaceStyle: "automatic"` against a light-only palette | ADR-0002; Stage 2 |
| **K** | Mobile Sentry transport dead (no DSN) | Confirmed: the whole block is gated on `if (sentryDsn)` and nothing supplies one. **And `attachScreenshot: true` means supplying one starts shipping screenshots of site photos — a decision, not a switch** |
| **N** | **Location opt-in is unreachable from the UI** while `resumeTrackingIfEnabled` runs at every boot | Nothing is collected today, but the consent surface doesn't exist and Stage 3 cannot describe one |
| **N** | **`uploads` has no FK to `auth_users`** | Upload rows survive account deletion |
| **N** | **OTP codes stored in plaintext** (`email_code`, `sms_code`, both `TEXT NOT NULL`) | Short-lived, but a database read yields live authentication codes |
| **N** | **Identity fields packed into a column named `password_hash`** | `${passwordHash}::${fullName}::${role}::${companyName}`. Hygiene, and it makes any future audit of where names are stored wrong |
| **N** | **`backup-data.tsx` is not a data export** — a device-cache dump of three entity types | There is no working IPP 6 access mechanism. Stage 3 input |
| **N** | **`create-site` and `profile` are modals with the same unguarded swipe as `new-entry`** | Reported, not widened |
| **N** | **The marketing legal pages carry no draft banner** while the in-app ones do, and the marketing footer asserts an NZBN the in-app notice calls pending | The public-facing copies look finished, and one of the two entity claims is wrong |

### Low

| | Issue | Why |
|---|---|---|
| **K** | `components/ErrorFallback.tsx` is dead | Confirmed; and it drags two more files with it |
| **N** | **A dead parallel auth stack**: `app/_app.tsx` (8 lines) → `lib/auth.tsx` (76 lines, with a `signInDev()` that POSTs to `/api/auth/login`), plus `app/_error.tsx`, referenced only by the already-dead `ErrorFallback.tsx` | Two auth providers in one tree. The live one is `lib/auth-context.tsx`. Not a security hole — the bodyless POST would 400 — but it is a second, confusable implementation |
| **N** | **`CLAUDE.md`'s `grep -l "FORCE ROW LEVEL SECURITY"` undercounts** | Migration 025 applies RLS through a dynamic `DO` loop, so `site_members`, `material_deliveries`, `crew_timecards` and `inspections` are invisible to that grep. A documented procedure that returns a wrong answer |
| **N** | **AUDIT L13 is stale** — it records that `api.`/`app.` don't resolve; both do now | `api.getsitesnapai.com` returns 404 at `/`, which is correct for an API root |
| **N** | **`scrypt` cost factor never specified** → Node defaults (N=16384) | Worth knowing, not worth a migration |
| **N** | **The supervisor-web map-polling preference is dead** — `sitesnap.mapPrefs` is written in `settings/page.tsx` (214, 264) and never read by `locations/page.tsx`, which uses a hardcoded `setInterval(…, 30_000)` | A user-visible control that does nothing |
| **N** | **The orphan probe row hypothesis is refuted** | AUDIT L24 already records its origin. Detail in A4 |

### Two findings that *remove* work

| | Finding |
|---|---|
| **N** | **`INVITE_URL` already exists as an environment variable** (`notificationService.ts:297`). Changing the invitation URL is a Render dashboard edit with zero code and zero deploy |
| **N** | **`+native-intent.tsx` already routes `https://…/invite?token=…` correctly** — it matches on pathname as well as hostname and passes `https://` through unchanged. **No mobile JS is needed for universal link handling** |

## 2 — The interactions between the three areas

**Files touched by more than one stage:**

| File | Collides | Nature |
|---|---|---|
| **`app/terms-of-service.tsx`** | Stage 1 item 2 ↔ Stage 3 | Item 2 instruments navigation *to* it; Stage 3 rewrites its body. **Your sequencing instinct is right — Stage 1 item 2 must land before Stage 3**, or Stage 3's rewrite lands on a screen whose defect is unresolved and the instrument's output becomes unreadable |
| **`app/settings/data-privacy.tsx`** | Stage 1 item 2 ↔ Stage 3 ↔ A2/A4 | It is item 2's entry point *and* the screen publishing the two false claims. Same ordering constraint |
| **`app/privacy-policy.tsx`** | Stage 1 item 2 ↔ Stage 3 | Same as Terms |
| **`app/_layout.tsx`** | Stage 1 items **2, 4 and 5** | The nav probe (item 2), the modal registration being guarded (item 4), and the duplicate "Dashboard" title (item 5) are all in this one file. **Three of five Stage 1 items touch it** — do them on one branch, in one pass, or the second and third edits will conflict |
| **`app.config.ts`** | Stage 2 items 1 and 2 | `associatedDomains` and `userInterfaceStyle` in the same file. This is *why* one build works |
| **`website/`** | Stage 2 ↔ Stage 3 | Stage 2 adds `.well-known/apple-app-site-association` and `invite/index.html`; Stage 3 rewrites `privacy/index.html` and `terms/index.html`. Different files in one directory — a merge conflict risk, not a logical one |
| **`services/api/src/services/notificationService.ts`** | Stage 2 ↔ Stage 3 | Stage 2 changes the invitation URL; Stage 3 must describe the invitation flow **as Stage 2 built it**. Stage 3 strictly after Stage 2 |
| **`docs/DECISIONS.md`** | Stage 2 (ADR-0002) ↔ Stage 3 (the not-reviewed-by-a-lawyer record) | Both append. Sequential is fine |
| **`docs/AUDIT.md`** | all three (L28+) | Orchestrator-only per CLAUDE.md §8. I will allocate numbers |

**Data flows one stage changes that another describes:**

- **Stage 2 changes what personal information travels where.** The invite token moves from a custom scheme into an https URL that transits Apple's AASA fetch, the recipient's mail client, and the Render static site's access log. Stage 3's invitation section must describe **that**, including the no-app landing page as a new (if minimal) processing point.
- **Stage 1 item 1 changes who the dev client talks to**, which changes whether test data lands in the production database — one of A5's honest gaps.
- **Stage 1 item 3 changes what a timesheet record can contain**, which is the employment-data section of Stage 3.
- **The `morgan :url` finding spans Stage 2 and Stage 3.** Stage 2 must not put the token in a query string; Stage 3 must describe what the logs hold.

**What the audit changes about what should be built:**

1. **Pass `store: false` on the OpenAI call.** One line in `routes/ai.ts`. It cuts "retained at least 30 days by default" out of Stage 3's AI section. Highest value-per-line in the whole plan, and it was not on your list.
2. **Fix the published data-privacy claim in Stage 3, not before.** ~~Two statements~~ **One statement** in `settings/data-privacy.tsx` is false: the seven-year purge. *(The Singapore claim was originally the second; it is correct — see A2.)* It is in the same file as item 2's entry point, so Stage 3 after Stage 1 is required.
3. **The Stage 2 invite URL must use `www.getsitesnapai.com`.** Not an implementation detail — the apex silently defeats the feature.
4. **The account-deletion response message must change in Stage 3's branch.** It is a written promise the code does not keep, which is precisely what your Stage 3 rules forbid. Either the message becomes accurate, or the code deletes the S3 objects. **My recommendation: change the message in Stage 3 and add S3 deletion to the backlog.** Deleting objects is a real feature with real failure modes and it does not belong in a documents branch.
5. **Do not supply the mobile Sentry DSN casually.** `attachScreenshot: true` turns it into a photo-exfiltration path the moment it works.

> ### Does the audit reorder the work? Yes, in one respect, and you invited this.
> **The audit is worth more than the documents, and three of its findings are cheaper than anything in Stage 1.** `store: false`, the `INVITE_URL` environment variable, and the apex-vs-www correction are collectively about four lines and one dashboard field, and they are worth more than any single UI item. The first two can be done inside the stages they belong to; the third is a decision you make before the build starts, which is now.
>
> **I would also add the conditional hook to Stage 1 as a sixth item.** It is in item 5's file, it is a crash rather than a cosmetic problem, and the lint configuration means nothing else will ever find it.

## 3 — Proposed build order

> **Your order holds. The analysis supports it, and the reason is specific: every one of the five Stage 1 items is JS-only.** Item 4 — the one that looked most likely to need native work — is settled by the installed source, not by documentation: `native-stack@7.14.2` maps `preventRemove` onto `preventNativeDismiss` on iOS at `NativeStackView.native.js:285`. No Stage 1 item forces a second build, so the stages stay independent and one build is enough.

Three refinements, none of which change the shape:

1. **The build needs only `app.config.ts`.** Both edits are known now. Start it the moment that one file is edited — the AASA file, the `/invite` landing page and the ADR update can all be written while it runs, on the same branch.
2. **Order inside Stage 2 matters.** The landing page must be live **before** `INVITE_URL` is flipped, or invitation emails will link to a 404. Sequence: publish `website/` → verify the AASA content type with `curl -I` → set `INVITE_URL` → install the build → test the link from Messages.
3. **Add the conditional hook to Stage 1 item 5.** Same file, one reordering, and a crash rather than a cosmetic fix.

Final sequence:

| | Step | Needs |
|---|---|---|
| 1 | Stage 0 — this report | Your approval |
| 2 | Stage 2 branch: edit `app.config.ts`, **tell you, wait for go**, start the build | Your go |
| 3 | While it builds: AASA file, `/invite` page, ADR-0002, PR body | — |
| 4 | **Stage 1 on its own branch, in parallel** | Item 1 first — item 2's instrument needs a non-production API |
| 5 | Stage 2 completes: install, test the link, flip `INVITE_URL` | A device |
| 6 | Stage 3 last | Stages 1 and 2 both merged |

Within Stage 1, item 1 first (your reason is correct and the instrument depends on it), then item 2 (the instrument, before Stage 3 touches those files), then 3, 4, 5.

## 4 — The native build

**Both Stage 2 items fit one build.** `associatedDomains` and `userInterfaceStyle` are both prebuild-time `app.config.ts` changes — the first produces the `com.apple.developer.associated-domains` entitlement, the second writes `UIUserInterfaceStyle: Light` into `Info.plist`. Nothing in Stage 1 adds a third.

**The exact command**, from `Projects/apps/mobile`:

```
eas build --platform ios --profile production
```

Then, separately:

```
eas submit --platform ios --profile production
```

(or `--auto-submit` on the build to chain them). The `production` profile is `distribution: "store"` with `ios.autoIncrement: true` and `appVersionSource: "remote"`, so the build number increments on EAS rather than in the repo — no version commit.

**Roughly how long:** 20–40 minutes from `eas build` to a finished artifact — typically 5–15 minutes queueing plus 15–25 minutes building — and then 10–30 minutes for Apple to process it into TestFlight. Call it an hour to a testable install, most of it unattended. That is the window Stage 1 runs in.

> **I have not started it and I will not without telling you first.** This paragraph is the telling. The build begins only after you approve an order, and I will ask again at that point.

## 5 — Everything you have to do by hand

Separate from what merges do on their own.

1. ~~**Decide the host.**~~ **Answered: `www.getsitesnapai.com`, confirmed for both.** Built in Stage 2 — the AASA file and the `associatedDomains` entitlement are both pinned to the `www` host, and ADR-0003 records why the apex cannot work (it 301s every path and Apple does not follow redirects).
2. **Render static site → Headers:** add a rule for path `/.well-known/*` setting `Content-Type: application/json`. Then verify: `curl -I https://www.getsitesnapai.com/.well-known/apple-app-site-association`.
3. **Render API service → Environment:** set `INVITE_URL=https://www.getsitesnapai.com/invite`. **Only after the landing page is live.**
4. ~~**Render dashboard → the Postgres instance → Region.**~~ **Answered: Singapore.** Read from the dashboard, which corrected this report — see A2. Co-location timing carries it to the web services too, so Stage 3 writes Singapore for both.
5. **`eas env:list --environment production`** — confirm whether `EXPO_PUBLIC_SENTRY_DSN` is set. Nothing in the repo supplies it, so the mobile Sentry block is inert, and I want that confirmed rather than inferred.
6. **Run the read-only timecard query** from 0A item 3 in the Render psql shell, including the `SET app.company_id` line, and send me the rows. I am not writing a migration.
7. **Apple Developer portal → Identifiers → `nz.getsitesnapai.app`:** confirm **Associated Domains** is enabled on the App ID. EAS normally enables it during the build's credentials step; confirm rather than assume.
8. **After the build installs:** tap the invite link from Messages or Notes — **not** from Safari's address bar, which bypasses universal links by design. A long-press showing "Open in SiteSnap" is the positive confirmation.
9. **Delete the app from your phone and tap the link again** to see the no-app path. This is the only way to test it (see part 6).
10. ~~**Decide the entity question.**~~ **Answered: SiteSnap AI Limited is incorporated and NZBN 9429053872258 is correct.** The marketing footer is right; the in-app *"once the company is incorporated"* is the stale claim and Stage 3 removes it. See the note in A6.
11. ~~**Decide on `store: false`**~~ **Answered: approved**, to land in Stage 1 as its own commit, after confirming nothing relies on server-side response state.
12. **Submit to TestFlight** (`eas submit`) and install from there.

## 6 — What cannot be verified, and what it would take

| Cannot verify | What it would take |
|---|---|
| Whether the universal link opens the app when installed | **The native build installed on your physical phone**, plus a tap from Messages. Simulator AASA validation is unreliable and the dev client claims `sitesnap://` |
| Whether the no-app invite path works | **A device without the app installed** — your phone with the app deleted, or a second device |
| Whether Render serves the AASA as `application/json` | **Publishing the file first.** Only answerable after deploy, with `curl -I` |
| How many bad timecard rows exist; how many expired invites; `worker_locations` row count; whether dev traffic ever reached production | **Production database access.** I will not touch it. Item 6 above covers the first |
| Whether EXIF survives the upload re-encode | **`exiftool` run against an object fetched from S3.** Not installed and there is no Homebrew on this machine. Stage 3 must say "EXIF handling is not verified" rather than claim stripping |
| ~~The Postgres region~~ **Answered** | The Render dashboard, since read: **Singapore.** See A2 |
| Whether the mobile Sentry DSN is set | **`eas env:list`.** Item 5 above |
| Whether item 2's defect reproduces on your TestFlight binary | **A `preview`-profile dev-client build installed on your phone.** `__DEV__` is false on a release build, so the instrument cannot run there. If the simulator comes back clean, this is what I will ask you for |
| Android App Links | **An Android device or emulator.** There is no Java on this machine, which also rules out Maestro |
| Whether OpenAI's full API data-usage policy says anything beyond the retention text | **A browser.** `openai.com/policies/api-data-usage-policies/` and `/enterprise-privacy/` both return HTTP 403 to automated fetches. I used `platform.openai.com/docs/guides/your-data` (HTTP 200) and quoted it verbatim rather than paraphrasing a search result |

---

## Two housekeeping answers

**AUDIT numbering — your statement is confirmed.** `grep -o "\bL[0-9]\+\b" docs/AUDIT.md | sort -u -V` returns exactly `L1 … L27`, contiguous, with **no duplicate L26 in the repo**. L26 is the double-tapped-save entry; L27 is the `flex: 1` finding. **Next free is L28.**

**Renumber your conflicting L26 (the mobile Sentry transport) to `L29`.** Reason: this work will allocate **L28** for the audit findings it produces, so L29 is the next clear number and nothing in the repo will reach for it. If you would rather it sort near the other mobile findings, say so and I will allocate differently — but L29 keeps your notes and the repo from colliding again.

---

## Provenance of this document

This was reported in full before anything was branched, written or committed, which was the condition Stage 0 was run under. It is published unchanged except for:

1. **The region correction**, applied in place as described in the preamble and recorded in A2 with its mechanism.
2. **The three by-hand items since answered** (1, 4, 11), annotated in part 5 with strike-through rather than removed.
3. **Conversational framing removed** — the opening and closing lines addressed to the reader in session, and the offer to publish this, which this document is the answer to.
4. **Source links rewritten** from repo-root-relative to `../Projects/…` so that they resolve from `docs/`.

No finding, measurement, caveat or recommendation has been added, softened or dropped. Where this report says something could not be verified, that remains true as at 3 October 2026 unless a later stage's PR body or ADR says otherwise.