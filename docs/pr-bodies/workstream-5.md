# Workstream 5 — Photograph viewer

Branch `feat/photo-viewer`, off `main` at `ee7e093`.

---

## Finding first, as instructed: what is actually stored

The brief said *"I said 'on mobile it already shows the date and time.' That proves a
value is displayed, not that a capture time is persisted"* and asked me to establish
the facts before building. I did, and the answer is better than the question
anticipated — **both times are stored, and the distinction is already modelled
honestly.** This is not a case of the portal needing a new rule invented; it is a case
of the portal **discarding fields that already arrive**.

### What exists server-side

| Where | Evidence |
|---|---|
| `storage/projectsStore.ts:266` | `photos_json JSONB NOT NULL DEFAULT '[]'::jsonb` |
| `storage/projectsStore.ts:346` | `mapEntry` does `photos: row.photos_json` — verbatim passthrough, no stripping |
| `routes/projects.ts:63` | `photos: z.array(z.record(z.unknown())).default([])` — no validation on the way in |

So the photographs array is **opaque JSONB with no server-side schema at all**. Nothing
is validated, nothing is stripped (unlike `inspectionStore.ts:192` and
`signatureStore.ts:81`, which both strip `base64`). **Every field mobile writes reaches
the portal unaltered.**

### Which timestamp is which

`apps/mobile/lib/types.ts` already carries all of this, and the doc comments are
load-bearing:

- `Photo.timestamp` — **when the RECORD was created.** Documented in those words, and
  every photograph already stored means that by it.
- `Photo.capturedAt` — **when the photograph was taken**, ISO-8601, **absent when that
  is not known.** The comment: *"It must never be filled in with the time of
  selection."*
- `Photo.captureTimeSource` — `camera` | `exif` | `unknown`, and **absent is a fourth
  state**, not a synonym for `unknown`: those records predate the field, so nothing has
  established whether a capture time is recoverable.

`lib/photo-capture-time.ts` → `describeCaptureTime` renders all four as distinct
sentences, and labels the legacy case **"Added", never "Taken"**. Its own comment is why
this workstream adopts it rather than reinventing it:

> Mobile and the portal must not disagree about the same photograph, so this returns the
> label rather than each screen formatting its own.

### The answer to the question as asked

- **Is it the capture time or the upload time?** Both are stored, in two separate
  fields, and which one is real is recorded in a third.
- **Do already-stored photographs have a recoverable capture time?** Those captured in
  the app or picked from the gallery since PART 1 do (`captureTimeSource` says which).
  Those created before it carry **neither field**, and that is the fourth state — their
  capture time is genuinely unrecoverable from the record, and `describeCaptureTime`
  reports "Added <record time>" for them rather than guessing.
- **Would mobile and the portal disagree today?** **Yes, and that is the defect.** Mobile
  shows the four-state label. The portal types a photograph as
  `EntryPhoto = { uri: string; caption?: string }` (`apps/supervisor-web/lib/api.ts:6`),
  so `capturedAt`, `captureTimeSource`, `timestamp`, `id`, `latitude` and `longitude`
  **arrive over the wire and are dropped at the type boundary.** The portal showed no
  date at all, which is the one failure mode that is not a false statement — but it also
  means the portal could not have agreed with mobile, because it was not displaying
  anything to agree with.

**Nothing in this workstream labels an upload time as a capture time, and nothing needed
to be corrected in order for that to be true** — PART 1 had already done that work on
mobile. The correction needed is in the portal, and it is a correction of omission.

### A second finding, in the same family

`DailyEntry` on mobile had no `ownerEmail`, yet the API returns it on **every** entry in
`/projects/bootstrap` (`projectsStore.ts` `mapEntry`, via `getScopedBootstrap` at
`:833`, which returns the records whole). The value has been arriving and being
discarded unread, for the same reason and in the same way as the portal's photo fields.
The viewer's "who" line needs it, so this commit adds it to the interface — a type-only
change; the data was already there at runtime.

### A third finding: annotation records no annotator

2.4 requires that an annotated copy *"records who annotated and when."* Reading
`app/entry/[id].tsx` → `handleSaveAnnotation`, the derivative sets `timestamp` (when),
`derivedFromId` (which original), inherits `capturedAt` / `captureTimeSource` /
`contentSha256` / `latitude` / `longitude`, and sets `kind: "annotated"` — **but carries
no annotator identity.** The only identity anywhere on the record is the entry's author,
who is not necessarily the annotator: a manager can annotate a crew member's entry.

Two things follow, and both are in this branch:

1. `Photo.annotatedBy` is added and recorded at annotation time.
2. **An annotated copy must never fall back to the entry author.** That is the single
   most consequential line in the branch — it is the difference between "we do not know
   who drew this" and a named person being falsely recorded as having marked up
   evidence. Red-on-revert proof A below is that line.

`annotatedBy` is **self-asserted by the client**, because the server does not parse the
photographs array. I am flagging that rather than hiding it: the set of accounts that
could write a false value is already the set that can edit the entry at all, so this is
strictly more provenance than the nothing it replaces, but it is an **attribution, not a
verified identity**, and neither the doc comment nor the UI claims otherwise. The
hardening path is for the API to stamp it server-side, which would mean giving the
entries route a real schema for `photos` — a larger change than this workstream, and one
that would alter what the route accepts. Not done here.

---

## What was built

Four commits, portal-side except where noted.

| commit | what |
|---|---|
| `27adc41` | Answer where, who and which record honestly, or say nothing |
| `6d38f81` | Swipe between a record's photographs, and say what each one is |
| `42daa00` | Make the portal's copy of the photograph rules fail when it diverges |
| `b82f5cf` | Stop the portal discarding what it already knows about a photograph |
| `912602a` | Annotate a photograph in the portal without touching the photograph |

### 2.2 — date and time on every photograph

Three states, labelled differently, and the portal now says the same sentence mobile
says for the same photograph. `lib/photo-capture-time.ts` is a deliberate duplicate of
mobile's rule; the duplication is defended by both suites pinning the same vectors, so
changing one reds the other. The reason it cannot be shared is structural and worth
recording: `@sitesnap/shared` emits `.d.ts` only (`build:types`), and neither client
depends on it, so **shared cannot carry runtime code today**. Single-sourcing it is the
candidate I would pick for workstream 8.

**Did the two surfaces disagree before this?** Not in the sense of contradicting each
other — the portal said *nothing at all*. Mobile said "Taken …" or "Date taken unknown";
the portal rendered the caption and no date. That is a gap rather than an incident,
because saying nothing is the one failure mode that is never a false statement, and it
is why this part needed building rather than repairing.

### 2.3 — viewer

`PhotoLightbox` in `app/sites/[id]/page.tsx`: the original image, zoom (pinch on touch,
scroll wheel and ± buttons on desktop), pan when zoomed, Escape and a ✕ to leave,
arrow keys and ‹ › within the set, caption and the five metadata lines visible, and
`{n} of {m}` so the set has a size. The full original is fetched when the viewer opens.

**"The full original loads only when the viewer opens" is only half true on the portal,
and the other half is a finding — see below.**

## Finding: the Photos grid still serves full-resolution originals

Not fixed in this branch, and I want to be exact about why.

The Photos tab renders every photograph through `PhotoTile`, which sets the signed
original as the `<img src>` and sizes it with `objectFit: "cover"`. A phone capture is
3024×4032, ~1.6 MB; sixteen of them is ~26 MB of transfer to draw sixteen 120px tiles.
The viewer's "load the original only on open" is therefore moot on this surface: the
originals were all loaded before the viewer opened.

### Where thumbnails should be generated, and what happens to what is already stored

**Where:** server-side, on upload, in the API's upload path — the same request that
writes the original, writing a second object beside it under a derived key
(`<key>.thumb.jpg`), and recording nothing new on the photograph record, so that the
signing route can serve a thumbnail by deriving the key rather than by looking up a
field. Doing it on upload rather than on first request means no cold-start latency on
the grid and no cache-stampede when a diary with forty photographs is opened.

**What this costs, stated plainly:** the repo has **no image library**, and CLAUDE.md §8
forbids adding dependencies unbidden — so this needs `sharp` (native, platform-specific
binaries, affects the Docker build) or an equivalent, and that is a decision for the
owner, not a thing to slip into a viewer PR. That is the main reason this is a proposal.

**What happens to the photographs already stored:** nothing, unless a backfill is run.
They have no thumbnail object, so the grid must fall back to the original for them —
which means the saving is prospective only, and a site photographed last month looks
exactly as expensive as it does today.

**Proposed backfill, NOT RUN:** a one-shot script that lists photograph keys, fetches
each original, writes the missing `.thumb.jpg`, and skips any key whose thumbnail
already exists, so it is resumable and idempotent. It writes only new objects and
**mutates no existing object and no database row**, which is what makes it safe to
propose at all. It is still a bulk read of every photograph in the bucket with the
egress and the API-call cost that implies, and it should be run per-company with a
count reported first. **I have not run it and have not written it.** Say the word and
it goes in workstream 8 or its own branch.

**Interim mitigation also not taken:** the grid could ask the browser to decode smaller
with `loading="lazy"` plus `decoding="async"`, which costs nothing and changes no
bytes transferred. It does not fix the transfer, so it would be a comfort rather than a
fix, and I would rather the finding stay visible than be softened.

## 2.4 — annotation

**The non-negotiable rule, and where it lives.** Annotating creates a new record
alongside the original and never replaces it. That is
`buildAnnotationDerivative` in `lib/annotation-derivative.ts` — a pure function with
ten tests, because the way this rule gets broken is not a decision anyone argues for,
it is a `.map()` written instead of a `.concat()` while tidying. Proof H below reverts
exactly that and shows seven tests going red.

**What the portal annotator does:** line, arrow and box, four colours, undo, clear,
cancel, save. It emits mobile's exact stroke shape — `{path, color, width}` SVG paths
in a 1000-wide viewBox, `fill="none"`-safe outlines — so **mobile renders a portal
annotation with no change to mobile at all**. The four palette hexes are mobile's four
tokens, written out and pinned by test, because the colour is stored on the stroke and
every renderer reads it from there.

**What it does not do, and why each one is deliberate:**

- **No text label**, although 2.4 asks for one. `AnnotationStroke` is
  `{path, color, width}` and `components/AnnotatedImage.tsx` renders strokes as
  `<Path … fill="none">` and nothing else. A text label stored from the portal would
  sync to the phone and be **silently invisible there** — the two surfaces disagreeing
  about what is marked on compliance evidence, which is the exact failure this
  workstream exists to prevent. Building it needs an additive change to
  `AnnotationVector` **and** a matching mobile renderer, shipped together. I nearly
  built it before checking; checking is what stopped it.
- **No freehand.** That is mobile's tool and a finger is good at it; a mouse is not.
- **No new pixels.** See the next section.

**Mobile's annotator was already correct on the non-negotiable rule** — I checked
rather than assumed. `app/entry/[id].tsx` → `handleSaveAnnotation` maps the existing
array to stamp `kind: "original"` on the untagged source and then `concat`s the
derivative; it does not overwrite. So mobile needed no change for 2.4's rule, and got
one only for the annotator-identity finding above.

### An annotated copy is not new bytes, on either surface — and this is the decision I want looked at

Mobile's derivative reuses the source's `uri`, `base64`, `mimeType`, `storageKey` and
`storagePath`, and carries the drawing as `annotationVector`, which `AnnotatedImage`
overlays as SVG at render time. **No second image is uploaded.** The portal now does
the same thing, for one reason: consistency with the client that has the install base.

So "creates a new image alongside the original" is honoured **at the record level** —
there are two retrievable photograph records, the original is unchanged, both are
listed, both are navigable — but there is no second *image file* anywhere. If the rule
was meant literally at the byte level, this does not satisfy it, and that is the
sentence I most want you to push back on.

Rasterising would mean: a canvas, the image loaded with `crossorigin="anonymous"`, a
`toBlob`, an upload, a new storage key. It is buildable. Three reasons I did not:

1. It needs the image loaded **with CORS**, and the media route is scoped
   `Cross-Origin-Resource-Policy: same-site` for a reason you documented at
   `routes/uploads.ts:160-215`. I was told not to widen it, and I did not. (CORP and
   CORS are different headers and a rasterisation needs the second, not the first — but
   it would also hit a real cache-poisoning hazard: the grid loads the same URL
   *without* `crossorigin`, and a later CORS load of an already-cached non-CORS
   response is rejected, so the first annotation after viewing the grid would fail
   intermittently and look like a flake.)
2. It would make portal annotations visible to the AI report and mobile annotations
   invisible to it — a worse outcome than either behaviour applied consistently.
3. It is not reversible. A vector can be rasterised later; bytes cannot be un-written.

### What the AI report receives — the reasoning, before it is baked in

You asked for this visible rather than decided. Today, with evidence:

`routes/ai.ts:355-379` iterates **every** photograph of every entry and pushes
`{ type: "input_image", image_url, detail }`, with bytes resolved by
`normalizeBase64Image` (`:308`) from `photo.base64` or `photo.storageKey`. There is no
filter on `kind`. So for an annotated photograph the model currently receives:

- **The same pixels twice**, as `photo-1` and `photo-2`, because the derivative shares
  the original's `storageKey`.
- **No marker** that either is an annotation, and **no sight of the drawing at all** —
  the `annotationVector` is never rendered into anything the model sees.
- **Double the image billing** for one photograph.
- A **`totalPhotos` count that overstates the site's evidence**: `:392` sums
  `e.photos.length` and `:402` renders "N site photographs were recorded". Annotate
  four photographs and the report claims twenty where sixteen were taken.

**My reasoning on what it should receive.** The annotation is a person pointing at the
thing that matters, so it is the *most* informative version, and sending the original
instead throws that away. But sending both is what happens today and it is strictly
worse than sending either. So: **send one image per original, and prefer the annotated
version when one exists** — which requires the annotated version to exist as pixels,
i.e. it depends on the rasterisation decision above. Until that is settled the
reversible interim is: **send originals only, skip `kind === "annotated"`, and fix
`totalPhotos` to count originals.** That removes the double billing and the false count
immediately, costs nothing, and does not pre-empt the real decision.

**I have not changed `ai.ts`.** It is a server-side change to the product's headline
feature, the double-count is a pre-existing defect rather than one this branch
introduces, and you asked to see the reasoning first.

## Block B — the last six inches

**This workstream adds no routes and widens no route.** Every endpoint it uses already
existed. The one it newly *calls* from the portal:

| route | added? | client that calls it | reached from |
|---|---|---|---|
| `PATCH /api/projects/entries/:id` (`routes/projects.ts:243`) | no — pre-existing | `lib/api.ts:379` `updateEntryPhotos` | `app/sites/[id]/page.tsx:369`, inside `saveAnnotation`, from the Annotate button at `:454` → `PhotoAnnotator` at `:474` |
| `POST /api/uploads/sign` | no — pre-existing, unchanged | `lib/api.ts` `signUploadPaths` | `app/sites/[id]/page.tsx:1021` (pre-existing; feeds both the grid and the viewer) |

Every other file in this branch is reached from the site page: `PhotoAnnotator` at
`:474`, `buildAnnotationDerivative` at `:353`, `buildViewerShots` /
`buildViewerShotsForRecords` in both tabs, `describeCaptureTime` and the four
`describePhoto*` helpers in the viewer's metadata footer. Nothing in this branch is
test-only.

**`PATCH /api/projects/entries/:id` is a whole-array write, and that is a race I cannot
win here.** `photos` is `z.array(z.record(z.unknown()))` with no per-photograph
addressing and no version or ETag to send, so two people annotating the same entry at
once means the second save drops the first annotation. The mitigation actually built is
that the client re-renders from the entry the API returns rather than from the array it
sent, so the losing client sees the true stored set instead of its own optimistic copy.
A real fix is a server-side append, and it is flagged rather than improvised.

## A finding I am not acting on: who can PATCH an entry

`canEditRow` (`storage/recordScope.ts:181-190`) returns `true` for any actor in the
company who is **not crew**, for a record class that is not a shared site attribute. So
a **viewer** can `PATCH /api/projects/entries/:id` — and therefore annotate, and
therefore rewrite an entry's whole photographs array. That is pre-existing and not
introduced here; the Annotate button is reachable by anyone who can open the site page.

I have not changed it, deliberately: it is a permissions change, it needs DB-gated
tests, and tightening it could break a workflow I cannot see from here. **It is the
finding on this branch most likely to matter to you**, and it is a one-line gate if you
want it.

## Red-on-revert proofs

Seven, each one line reverted, the failing output pasted, the line restored and the
restored file's sha256 compared against a pre-revert copy. The **"everything else
stayed green" figure is on every row** — that is the half that proves the new test is
the only thing holding the line, rather than one of several that happen to cover it.

### A — an annotated copy must never borrow the entry author's name

`apps/mobile/lib/photo-provenance.ts`, `describePhotoAuthor`: made an unrecorded
annotator fall back to `entry.ownerEmail`.

```
not ok 57 - an annotation with no recorded annotator says so and borrows nobody's name
  error: |-
    Expected values to be strictly equal:
    + actual - expected

    + 'entry-author'
    - 'annotator-unrecorded'
  expected: 'annotator-unrecorded'
  actual: 'entry-author'
# tests 126
# pass 125
# fail 1
```

One test. The other **125 stayed green** — nothing else on mobile objects to a named
person being recorded as having marked up evidence they never touched.

### B — a record time must never be labelled as a capture time

`photo-capture-time.ts` on **both** surfaces, same single line, `Added` → `Taken`.

Portal:
```
not ok 14 - describeCaptureTime never labels a record time as a capture time
not ok 16 - a capturedAt with no established source is not treated as a capture time
  actual: 'Taken 01/09/2026, 9:00:00 pm'
# pass 34
# fail 2
```
Mobile:
```
not ok 44 - describeCaptureTime never labels a record time as a capture time
  error: |-
    The input did not match the regular expression /^Added /. Input:

    'Taken 01/09/2026, 9:00:00 pm'
  actual: 'Taken 01/09/2026, 9:00:00 pm'
# pass 125
# fail 1
```

This is the proof that matters most for the duplication: **the same one-line change reds
both suites independently.** That is the whole defence for keeping two copies of the
rule, and it is why the copies must not be "improved" one at a time.

**Attribution, so the proof is not read as more than it is:** mobile's rule *and* its
test already existed on `origin/main` — `git show
origin/main:Projects/apps/mobile/lib/photo-capture-time.test.ts` finds
`describeCaptureTime never labels a record time as a capture time` at line 130. **This
branch added the portal's copy of both** (`42daa00`). So the mobile half of this proof
shows the existing guard still holds; the portal half shows the new one does. The reason
to run both was to establish that the second copy is independently defended rather than
leaning on the first, and it is.

### C — a defaulted 0, 0 must not be pinned as a location

`apps/supervisor-web/lib/photo-provenance.ts`, `isUsableCoordinate`: removed the
null-island guard.

```
not ok 20 - a defaulted 0, 0 is refused rather than pinned
  error: |-
    + actual - expected

    + 'photograph'
    - 'entry-stand-in'
# pass 35
# fail 1
```

The other **35 stayed green**. A photograph whose coordinates defaulted to zero would
otherwise have been presented as taken in the Gulf of Guinea, with no warning marker.

### F — a photograph with no id must not share an identity with every other

`lib/photo-viewer-set.ts`: removed `?? photo.uri` from the identity fallback.
(Measured at `b82f5cf`'s gate.)

```
not ok 19 - a photograph with no id is identified by its uri, so it is never confused with another
  + undefined, undefined
  - 'legacy-one.jpg', 'legacy-two.jpg'
not ok 20 - an annotation over an id-less original is reported as unmatched rather than attached to the wrong one
  expected: true
  actual: false
# pass 21
# fail 2
```

Without the fallback every id-less photograph shares the identity `undefined`, and the
ordering rule matches the first annotation it finds against an unrelated original.

### G — ordering must be per record, never across the joined set

`lib/photo-viewer-set.ts`: ordered the flattened set instead of each record.
(Measured at `b82f5cf`'s gate.)

```
not ok 22 - ordering is per record: one day's orphan never lands after another day's photographs
  + 't1', 'm-mark'
  - 'm-mark', 't1'
# pass 22
# fail 1
```

### H — annotating must append, never replace

`lib/annotation-derivative.ts`: `return marked.concat(derivative)` →
`return marked.map((photo) => (photo.id === sourceId ? derivative : photo))`. This is
the exact shape of the defect the rule exists to prevent — a `.map` written in place of
a `.concat`.

```
not ok 1 - annotating appends a new record and leaves the original in place, unchanged
  error: |-
    one photograph in, two out

    1 !== 2
  expected: 2
  actual: 1
not ok 2 - the original keeps its position, so the set is appended to and never reordered
not ok 3 - an untagged source is marked original, and a source already tagged is left alone
not ok 4 - the derivative records who annotated and when, and omits the author rather than writing a blank one
not ok 5 - the derivative depicts the same moment and place as its original, and shares its bytes
not ok 6 - an annotation of an annotation derives from what was on screen, not from its ancestor
not ok 7 - a source that is no longer in the set refuses rather than appending an orphan
# tests 36
# pass 29
# fail 7
```

Seven red. The **29 that stayed green are every other test in the portal suite** —
capture time, provenance, viewer sets, palette, viewBox and the path builders. Nothing
outside these seven objects to a compliance photograph being destroyed on annotation.

### I — an unknown annotator is an absent field, not a blank one

`lib/annotation-derivative.ts`: `...(annotatedBy ? { annotatedBy } : {})` →
`annotatedBy,`.

```
not ok 4 - the derivative records who annotated and when, and omits the author rather than writing a blank one
  error: 'an unknown annotator is an absent field, so the viewer can say so honestly'
  expected: true
  actual: false
# tests 36
# pass 35
# fail 1
```

Exactly one test; **35 stayed green**. Writing the key as `undefined` makes
`"annotatedBy" in photo` true, which is the difference between the viewer saying
"Annotated by an unrecorded account" and it saying "Annotated by undefined".

### J — the portal's viewBox width must not drift from mobile's

`ANNOTATION_VIEWBOX_WIDTH` 1000 → 1024.

```
not ok 12 - strokes are recorded in mobile's coordinate space, at mobile's width
  error: |-
    VIEWBOX_WIDTH, PhotoAnnotator.tsx:18

    1024 !== 1000
not ok 13 - the viewBox follows the displayed aspect ratio, and refuses a box that has not laid out
  + '0 0 1024 768'
  - '0 0 1000 750'
# tests 36
# pass 34
# fail 2
```

### Restoration

Every reverted file was restored from a pre-revert copy and compared:

| proof | file | sha256 match after restore |
|---|---|---|
| A | `apps/mobile/lib/photo-provenance.ts` | yes — `93a0947c…` |
| B | `apps/mobile/lib/photo-capture-time.ts` | yes — `f51a244d…` |
| B | `apps/supervisor-web/lib/photo-capture-time.ts` | yes — `5102f022…` |
| C | `apps/supervisor-web/lib/photo-provenance.ts` | yes — `c7d44db6…` |
| H, I, J | `apps/supervisor-web/lib/annotation-derivative.ts` | yes — `3116d142…` |

Full suite re-run after the last restoration: portal 36, mobile 126, API 194 with 18
gated skips.

## What is NOT defended by a test, said plainly

- **The pointer arithmetic in the portal viewer and annotator.** Pinch, pan and the
  pointer-to-viewBox mapping are reasoned against mobile's `handleImageLayout` and the
  mapping's pure half (`annotationViewBox`) is unit-tested — but **there is no browser
  and no Playwright in this environment**, so no drag has been observed. If one thing
  on this branch is wrong on contact with a real pointer, it is here.
- **The FlatList gesture arbitration on mobile** — swipe-between versus pinch-to-zoom.
  Same reason: no device, no simulator.
- **Mobile's `handleSaveAnnotation`.** The portal's derivative construction is extracted
  into a tested pure function; mobile's is still inline in `app/entry/[id].tsx`, so the
  non-negotiable rule is test-defended on the portal and convention-defended on mobile.
  That asymmetry is not deliberate design, it is where I ran out of branch. Extracting
  mobile's to match is small and I would take it in workstream 8.
- **The Annotate button's visibility rule** is in the component, not in a tested
  function. Its *consequences* are tested — `buildAnnotationDerivative` refuses an
  absent source (proof H, test 7) — so a mis-gated button cannot produce a bad record,
  only a button that should not be there.

## The harness decision — flagged, because it is yours

**This branch gives `apps/supervisor-web` its first test harness**, and registers it in
`Projects/scripts/assert-test-packages.sh` so the root `test` script and
`Projects/scripts/ci.sh:338` pick it up automatically. That means **CI now runs portal
tests on every PR**, which is a change to the build for every future branch, not just
this one.

It is deliberately the cheapest possible version: `tsconfig.test.json` with an explicit
`files` array, a `scripts/run-tests.sh` copied in shape from the API's, `node --test`,
**no new dependencies**, no React testing library, no jsdom, no `--require` preload. It
can only test pure modules, which is exactly why the rules in this branch were
extracted into pure modules.

**If you do not want it, it comes out in one commit** — delete the three files, the
`test` script, and the `sitesnap-supervisor-web` line in `assert-test-packages.sh`. The
cost of keeping it is a few seconds of CI. The cost of not keeping it is that
`buildAnnotationDerivative` goes back to being convention.

## Gate

Measured on `912602a`, the branch tip.

| gate | result |
|---|---|
| `pnpm -C Projects run typecheck` | exit 0 — mobile, API and portal all `Done` |
| `pnpm -C Projects run lint --max-warnings=0` | exit 0 |
| `assert-test-packages.sh` | ok — 3 packages declare tests |
| portal `test` | 4 files, **36 passed**, 0 skipped |
| mobile `test` | 16 files, **126 passed**, 0 skipped |
| API `test` (in-memory) | 45 files, **194 passed**, **18 skipped** |
| pre-commit hook | ✅ passed on every commit |

**No skipped tests other than the API's 18 gated ones** — 11 DB suites, 4 Redis, 3 live
OpenAI, each of which runs for real under `test:db` / `test:redis` / `test:openai`. That
is the expected total and it is unchanged by this branch: **this branch adds no DB-gated
suites, because it adds no store query, no route and no permission.** Every test it adds
is pure logic with no store involved, which is the one case the standing rule allows for
in-memory tests.

`test:db` **cannot be run here** — there is no local Postgres and no Docker. The DB
suites are unchanged by this branch, and CI runs them against its `postgres:16` service
container.

**Counters moved, each measured from a failing run, never written first.** Measured
with `git show <commit>:<path>`, not from memory:

| counter | `origin/main` | branch tip | moved at |
|---|---|---|---|
| portal `EXPECTED_TEST_FILES` | *(no harness)* | **4** | 2 at `42daa00` → 3 at `b82f5cf` → 4 at `912602a` |
| portal `EXPECTED_TESTS` | *(no harness)* | **36** | 17 → 23 → 36, same three commits |
| mobile `EXPECTED_TEST_FILES` | 15 | **16** | `27adc41` |
| mobile `EXPECTED_TESTS` | 113 | **126** | `27adc41` |
| API `EXPECTED_DB_SUITES` | 11 | 11 | unchanged |
| API `EXPECTED_REDIS_TESTS` | 4 | 4 | unchanged |
| API `EXPECTED_LIVE_OPENAI_TESTS` | 3 | 3 | unchanged |
| `assert-test-packages.sh` `EXPECTED` | 2 packages | **3 packages** | `42daa00` |

The portal's file-count guard caught each new test file before I touched either number —
`ERROR: found 3 test file(s), expected 2.` and then `ERROR: 36 test(s) passed, expected
33.` Both numbers were read off the failure, which is the evidence the guard works
rather than a claim that it does.

## Deploys this needs

| deploy | needed | independently safe? |
|---|---|---|
| **API** | **no** | — no server file changed; `git diff origin/main..HEAD -- Projects/services/` is empty |
| **portal** | **yes** | **yes** |
| **`eas update`** | **yes** (JS-only, no native rebuild) | **yes** |
| **native build** | **no** | — no native config touched, no `ios/` in any commit |

**The portal and mobile halves are independently safe, and this is the one workstream
where that is worth stating precisely rather than asserted.**

- Portal without mobile: the portal shows metadata and can annotate. A portal-made
  annotation on an un-updated phone renders through the **existing**
  `AnnotatedImage`, which already reads `annotationVector` and already gates on
  `kind === "annotated"` — both shipped before this branch. So it renders correctly on
  the current build. The only thing an un-updated phone misses is the annotator-identity
  line in its own viewer.
- Mobile without portal: mobile gains the annotator-identity recording and the
  provenance labels. A mobile-made annotation on the un-updated portal is simply not
  shown as annotated — the old portal had no viewer to show it in. Nothing breaks.
- **Neither half needs the API deployed**, which is what makes the batching safe: the
  endpoint it saves through has been live since before this branch.

So: **no, this does not need all three to ship together**, and it does not need the API
at all.

## Still open, for you

Carried out of this workstream rather than decided in it:

1. **Should an annotated copy be rasterised to real bytes?** The literal reading of
   2.4's rule says yes. I built the vector version because it matches mobile and is
   reversible. This is the question I most want an answer to.
2. **What should the AI report receive for an annotated photograph?** My reasoning is
   above. The interim fix (originals only, correct the count) is a small server change
   I have not made.
3. **Should `AnnotationStroke` gain a text variant?** Needed for 2.4's text label, and
   it is a coordinated portal + mobile release.
4. **Should the server stamp `annotatedBy` instead of trusting the client?**
5. **Should `PATCH /api/projects/entries/:id` gate above viewer?** `canEditRow` permits
   any non-crew actor today.
6. **Server-side thumbnails, and the backfill?** Needs a dependency decision first.
7. **Keep the portal test harness?**

---

*Do not merge. Do not deploy.*

🤖 Generated with [Claude Code](https://claude.com/claude-code)
