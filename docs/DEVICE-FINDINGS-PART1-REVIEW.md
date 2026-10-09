# Device findings from the Part 1 update — review

Branch `fix/device-findings-part1`, off `main` at `38483da`. Five commits. 5 October 2026.

Five findings came off the device checklist after update group
`f61665a6-c209-41fc-9eef-245dde8591cb` landed. Four are fixed; the fifth was a cost-out and was
deliberately not built. Everything here is JS-only and reaches a phone by `eas update` — **no
native rebuild is needed for anything in this branch.**

---

## The headline answers, before the detail

| | Question asked | Answer |
|---|---|---|
| 1 | Is the Inspections eject something this update introduced? | **No.** Pre-existing. The premise it was investigated under was wrong, and that is the more important finding. |
| 1 | Is it triggered by old inspection records? | **No.** It is *total checklist items × device photograph backlog*. Any inspection with a checklist can do it. |
| 2 | Is the binary missing `NSCameraUsageDescription`? | **No.** Build 4's own `Info.plist` carries it. **No native build tonight.** |
| 2 | So which of the three causes is it? | **(3) — the app's own handling.** One "Don't Allow" was a permanent dead end. |
| 3 | Is the overlap a stacking-context problem, as on the portal? | **No.** It is the flex *shrink* pass. A z-index hunt would have found nothing. |
| 4 | Can the token set give more than three distinguishable mark colours? | **Four, and the fourth is marginal.** Measured, not asserted. One currently-shipping colour had to go. |
| 5 | Does the sync banner already cover a failed sync reaching you? | **Yes.** Verified. No change needed. |
| 6 | Would a screenshot harness have caught items 1 and 3? | **One of three defects, conditionally.** Not the crash. |

---

## 1 — What was fixed, and how

### Item 1 · Inspections ejected you from the app — `bb1878c` (AUDIT L56)

`app/inspections/[siteId].tsx` → `load()` called `hydratePhotos(r.photos ?? [])` **once per
checklist result**, inside a nested `Promise.all` so all of them ran at once. `hydratePhotos` reads
`sitesnap.photoPayloads` — one AsyncStorage key holding the base64 of every un-uploaded photograph
on the phone — and `JSON.parse`s the whole thing. Ten inspections of twenty items is two hundred
concurrent copies of a multi-megabyte string, held raw and parsed at the same time, during one
mount. `patchActive()` had the same shape.

**The actual error, as asked, rather than a hypothesis — reached by elimination with evidence:**

- Not a JS exception. The root `ErrorBoundary` in `app/_layout.tsx` renders a full-screen
  "Something went wrong" carrying the message. You saw no such screen. You were put back where you
  came from, or out of the app — the signature of the OS killing the process, not React unwinding.
- Not a null dereference on a field old records lack. The only unguarded read on the mount path,
  `insp.results`, sits inside `load()`'s own `try/catch` and degrades to `EmptyState`.
- Not commit `21407c1`'s caption input. That code is inside the `showActive` branch, which renders
  only after a card is tapped — and the eject happens before anything is tapped.

What is left is a native-level termination, and this was the one unbounded native resource path on
mount. **So it is pre-existing and this update did not introduce it.** That contradicts the brief's
own premise, which asked to be told exactly that.

Fixed by exporting `readPhotoPayloadMap()` and adding the pure `hydratePhotosFromMap(photos, map)`.
Both call sites now read once per screen.

**The read count is asserted as a correctness property**, because nothing in the codebase could
previously have failed over this — the output was always right and only the number of reads was
wrong. `lib/test-setup.ts` counts `getItem` calls; `lib/photo-payload-store.test.ts` asserts one
read for the batch form and N for the loop form, so the counter has a positive control.
Red-on-revert verified: reinstating a read inside `hydratePhotosFromMap` gave
`not ok 23 … expected: 1, actual: 25`.

**The same pattern on other screens touched by `21407c1` / `4b6d266`:** swept. `hydratePhotos` has
no other multi-array caller; `hydrateEntriesWithPhotoPayloads` already read once for a whole array.
This was the only instance.

### Item 2 · The camera was refused — `74d4389` (AUDIT L57)

**Cause (1) is ruled out on the binary, not on the config.** Build 4's real `.ipa` `Info.plist`
(`CFBundleVersion 4`, build id `466a694f-b8e8-4ae2-be44-2a4dda291968`) carries
`NSCameraUsageDescription`: "SiteSnap uses your camera to capture construction site photos." There
is nothing a rebuild would change about the camera. **The plan for tonight does not need a build.**

**It is cause (3), the app's handling.** Both screens shared four lines: on refusal,
`Alert.alert("Permission Required", "Camera access is needed to take photos.")` and return. iOS
shows the camera prompt **once per install**; after one "Don't Allow" the request resolves denied
with `canAskAgain: false` and never prompts again. So every later tap produced the same alert and
the camera was gone for the life of the install.

Fixed with `lib/camera-permission.ts` (pure, three tests, each branch paired against the other so a
constant-returning function fails) deciding what a refusal means, and `lib/camera-access.ts` saying
it and offering `Linking.openSettings()` when the phone will not ask again.

**What you have to do:** if the camera is still refused after this update, it is because the
permission was denied on this install. Tap Take Photo — the app now says so plainly and offers
**Open Settings**. Nothing else is required of you.

### Item 3 · The overlaps — `3b9f431` (AUDIT L58, L59)

**Not a stacking context.** Nothing on `site/[id]` is absolutely positioned and nothing has a
`z-index`. It is the flex shrink pass, established from the installed RN 0.81.5 source:

1. `ScrollView` composes its base style **under** the passed one via `StyleSheet.compose`
   (`ScrollView.js:1752,1760`), which merges per *property*. `actionBarScroll: { flexGrow: 0 }`
   overrode `flexGrow` and left `baseHorizontal`'s `flexShrink: 1` in force.
2. The `FlatList` kept `baseVertical`'s `flexGrow: 1, flexShrink: 1` with `flexBasis: auto` — its
   full content height as its base.
3. Inside `container` (`flex: 1`, a definite-height column) the bases exceeded the screen, Yoga ran
   the shrink pass, and the only two shrinkable children were the bar (basis ≈ 68pt) and the list.
   The bar absorbed `68/(68+content)` of the overflow, losing height in proportion to how much
   diary the site has, and `overflow: 'scroll'` clipped the labels.

It needed six entries because the search field is gated on `allEntries.length > 0` **and** the
overflow grows with the entry count.

Fixed by pinning the bar out of the shrink pass (`flexGrow: 0, flexShrink: 0, flexBasis: "auto"`)
and giving the list `flex: 1` — which Yoga resolves to `flexBasis: 0` rather than `auto`
(`yoga/node/Node.cpp:329-339`), so the list stops contributing its content height to the column's
base sum. Both are needed; the first alone leaves the column overflowing.

Same class as **L27** (`SignaturePad.padRoot`).

**The doubled back control** on `settings/offline-sync`: it was the only screen rendering
`ScreenHeader` with no `<Stack.Screen>` entry in `app/_layout.tsx`, so it fell through to the root
`screenOptions`, which sets colours but never `headerShown: false`. Same omission as the
`terms-of-service` bug already commented in that file.

The audit — every screen checked, with its result — is in the PR body in full.

### Item 4 · Annotator colours — `3d34f6d`

Three became four: **Red (`Colors.error`), Amber (`Colors.warning`), Green (`Colors.success`),
Blue (`Colors.infoText`)**. No new hex. Red and Amber were raw literals that happened to equal
those two tokens; they are the tokens now.

**Navy (`Colors.primary`) is dropped.** Measured against mid-shadow (#2E2E2E) it scores a WCAG
contrast ratio of **1.06** and a CIE76 ΔE of **20** — all but invisible in shade, which is where a
site defect is photographed. It failed your own stated criterion, so it went. Existing strokes
carrying it still render; nothing rewrites stored annotations.

**Method.** Every token scored against concrete #9A9A9A, sky #87BEE8 and mid-shadow #2E2E2E,
taking the worst of the three, two ways: WCAG contrast ratio and CIE76 ΔE in Lab. Then a pairwise
ΔE matrix, because a colour that reads well against concrete is useless if it reads as the same
mark as its neighbour.

Worst-case ΔE: amber 79, red 76, orange 75, green 74, accentLight 65, infoText 52, white 36,
info blue 30, primaryLight 23, navy 20.

**Four is the ceiling, and pairwise ΔE is why.** The warm family collapses — amber↔orange 23,
accentLight↔amber 19 — so neither `Colors.accent` nor `Colors.accentLight` can join amber without
two swatches that read as one mark. Red↔amber is 57, green is ≥92 from every warm colour, infoText
is ≥101 from all three. Any fifth token breaks a pair.

**The caveat on Blue, stated rather than buried:** infoText's worst case of 52 is carried almost
entirely by b*. Its L* is ≈23 against mid-shadow's ≈19, so on a deep-shadow photograph it is the
weakest of the four. It is in because four distinguishable marks beats three, not because it
matches the other three.

**Also fixed:** the default colour was `Colors.accent`, which was in no swatch — the annotator
opened with nothing selected and the starting colour was unrecoverable once you picked another. And
the swatches, being bare colour with no text, announced as four identical unlabelled buttons to a
screen reader; they now carry the label `PALETTE` already held.

**Your decision, not built.** No token in the set reaches 3:1 contrast against all three
backgrounds — the best is white at 1.99. Legibility over an arbitrary photograph is a property of
**rendering**, not of hue: it wants a casing, a dark outline under the stroke. That must be applied
identically in all three render sites (`PhotoAnnotator.tsx`, `AnnotatedImage.tsx`,
`lib/export-utils.ts:32`), and it changes how every annotation **already stored** appears in
exported compliance evidence. That is yours to decide.

### Item 5 · Offline sync reduced, not deleted — `34b9a24`

- **The Settings entry is gated** on `failedOps.length > 0 || pendingCount > 0`. It was permanent
  and told almost everyone who opened Settings that nothing was wrong, which teaches people to stop
  reading it and buries the one state that matters.
- **The explanatory paragraph is gone**, and so is the section that held it. "What this screen is
  for" explained in the abstract what a failed row already says in one line — what it was, when,
  what the server answered, how many photographs got through, how many times it was refused. The
  descriptive prose on "Did not send" went too, for the same reason.
- **Each section appears only with rows.** "Did not send" is first, because it is the only thing
  here needing a decision. Both stock reassurances ("Everything on this phone has been sent.",
  "Nothing has failed to send.") are gone. With both empty the screen is one line rather than
  blank — a state only reachable by retrying the last item while standing on it.
- **Three sections and a paragraph became one list.**
- **The banner question: yes, already covered, no change needed.** `components/SyncStatusBanner.tsx`
  returns `null` only when `failedOps.length === 0 && pendingCount === 0`; otherwise it renders
  "N items did not send" as a tap target into this screen, and it is rendered at
  `app/(tabs)/index.tsx:134` — the sites list, the landing screen after sign-in. Hiding the
  Settings row removes no notification path.
- The doubled back control was fixed in `3b9f431`.

**What it amounts to now, asked plainly.** It is a list that is usually empty, and I would keep it
anyway — but on narrower grounds than before. It is the only place a retained failed op can be
*read* and *retried*, and retry needs somewhere to live. What it is **not** any more is a
notification surface: the banner is that. So the honest shape is what now exists — an
unlisted detail screen that the banner pushes to, with no Settings entry unless there is something
in it. If you would rather it were not a screen at all, the rows belong **expanded under the banner
on the sites list**, with retry inline; that removes the route entirely. I would do that only if
the list stays short in practice, because the sites list is not the place for twenty failed ops.

### Item 6 · The screenshot path — costed, not built (AUDIT L61)

In the PR body in full. The short version, and the part that corrects the brief:

**The environment-safety mechanism already exists and already enforces this.**
`lib/api-base-url.ts:113` *throws* when a `__DEV__` build resolves a non-local API URL unless
`EXPO_PUBLIC_ALLOW_PROD_API=1`. `expo start --web` is a `__DEV__` build, and `isLocalApiUrl()` is
true only for loopback or plain `http://`, so `https://sitesap-ai.onrender.com` is refused by
construction. A local web run is **already structurally incapable of reaching production**. The
stated blocker — `.env` loading into any bundle — is closed by that guard, not by discipline.

The residual problem is the mirror image: with `.env` pointing at production, a web run **throws at
startup and screenshots nothing**. So the harness must set `EXPO_PUBLIC_API_URL=http://localhost:4000`
in its own environment and run a seeded local API.

**Would it have caught this round? One of three defects.** L58 probably yes (checked against
`react-native-web`'s own source, not assumed) — but only with six entries of seeded data, which is
most of the harness's cost. L59 no, there is no native navigation bar on web. **L56 no** — a native
memory termination cannot happen in a browser tab whose AsyncStorage is a ~5 MB `localStorage`
shim. It buys layout coverage of pure-flex defects on seedable screens, and nothing for the
native-runtime defects that eject people from the app.

---

## 2 — What I found that nobody asked for

1. **Location tracking is unreachable dead code, and the binary declares it anyway** — AUDIT **L60**,
   the most significant of these. `requestPermissionAndStart` is called by nothing;
   `setLocationTrackingEnabled` only by it; the only reachable entry point,
   `resumeTrackingIfEnabled()` at `app/_layout.tsx:266`, reads a flag **nothing in the app can
   set**. `expo-location` has no other importer. Yet the app ships
   `NSLocationWhenInUseUsageDescription`, the `expo-location` plugin config, and a generic injected
   `NSLocationAlwaysAndWhenInUseUsageDescription`, and commit `1d78148` added a purpose string for a
   capability no user can turn on. Declaring a permission the app cannot request is a documented App
   Store rejection reason. **Not fixed:** delete the feature or ship the toggle is your call, and
   either touches native config, so it needs a rebuild.
2. **The camera purpose string shown is not the one in `ios.infoPlist`.** The binary carries the
   `expo-image-picker` plugin's string by plugin precedence. Both are present and honest, but only
   one is ever displayed, so editing the other changes nothing.
3. **The annotator's default colour was in no swatch** (`Colors.accent`), so it opened unselected
   and the starting colour was unrecoverable. Fixed as part of item 4.
4. **The palette carried a `label` field that nothing rendered.** Now used for accessibility.
5. **`settings/offline-sync` was the only unregistered `ScreenHeader` screen** — found by sweeping
   all eleven rather than by fixing the one that was reported.

---

## 3 — What was not done, and why

- **The casing / stroke outline for annotation legibility.** It is the real answer to "a mark has to
  read against concrete, against sky, against shadow", because no hue in the token set achieves it.
  It touches three render sites and changes how annotations **already in exported compliance
  evidence** appear. Product decision.
- **The screenshot harness.** Instructed to cost it, not build it. Costed in the PR body and L61.
  Playwright is not installed.
- **Anything about the location permission** beyond recording L60. Needs a native rebuild and a
  product decision.
- **Naming the actual iOS termination reason for item 1.** Not obtainable from here — see below.
- **Any migration.** None was needed. Nothing in this branch touches the API, the schema or any
  store.

---

## 4 — New AUDIT entries

| ID | Severity | Subject | State |
|---|---|---|---|
| **L56** | HIGH | Inspections re-read the whole photograph backlog per checklist item, concurrently, on mount | Fixed `bb1878c` |
| **L57** | MEDIUM | One "Don't Allow" on the camera was a permanent dead end | Fixed `74d4389` |
| **L58** | HIGH | The site action bar was shrunk away by the entry list below it | Fixed `3b9f431` |
| **L59** | LOW | `settings/offline-sync` showed two back affordances | Fixed `3b9f431` |
| **L60** | MEDIUM | Location tracking is unreachable dead code; the binary declares it anyway | **Open — decision needed before the next native build** |
| **L61** | HIGH | Nothing here can look at the mobile app; third round lost to it | **Open — costed, not built** |

---

## 5 — What cannot be verified without you

1. **The iOS termination reason for item 1.** The mobile Sentry DSN is empty (**L31**) and
   `Sentry.init` is gated on it, so `sitesnap-mobile` has zero issues over 90 days. Only the phone's
   own crash log can name it: **Settings → Privacy & Security → Analytics & Improvements → Analytics
   Data → `SiteSnapAI-*.ips`**. If it says `JETSAM` or a memory resource limit, L56 is confirmed as
   the whole cause. If it names something else, there is a second bug.
2. **Every layout fix in item 3.** This is **L61**: I cannot look at the app. The mechanisms are
   established from source; the rendered result on a phone with six entries is unconfirmed.
3. **That the camera now recovers.** Needs a real "Don't Allow" and a real trip to Settings.
4. **Step 12 of the device checklist, which has never run** — a caption on an inspection checklist
   item surviving a leave-and-reopen. Item 1 is what blocked it, so it is still unverified. It is on
   the checklist in the PR body.
5. **Whether four annotation colours is enough in practice.** Four is the measured ceiling of the
   token set; whether it is enough for the work is a judgement only marking up real photographs will
   settle.
