# L28, L30, L31 — Photographs Captured Offline Reach the Server

**Branch:** `fix/offline-photo-sync`, off `main` (`4f6b327`)
**Commit count:** in the PR body rather than here — a count committed into the document it counts
is wrong the moment it is corrected
**Written:** 4 October 2026
**Source of truth for the diagnosis:** `docs/AUDIT.md` L28, L30, L31 and `docs/STAGE-1-3-REVIEW.md` Part 2
**Scope:** the capture path that silently dropped its inputs, the queue that deleted work the
server refused, the telemetry that would have reported both, and the privacy correction the
telemetry made necessary.

Read Part 2 and Part 8 if you read nothing else. Part 2 has one finding I did not go looking
for that I think is more urgent than anything left on your backlog. Part 8 answers your
question about whether closing these reorders it.

---

## Part 1 — What was fixed, and the mechanism

### L28 — the drain now uploads before it posts

The defect was four lines of absence. `addEntry`'s online path uploads the photographs and
posts the entry carrying the storage keys the upload returned. Its offline catch branch saved
the base64 locally and enqueued the entry with the payloads stripped — and the drain handler
posted that op straight to `/projects/entries` with no upload step anywhere in it. The entry
arrived with its `photos` array intact in shape and empty of anything the server could serve.

The fix is one sentence long: **the drain loop uploads each photograph and substitutes the
returned storage key before it posts the op.** Everything else in this branch is about where
the bytes wait and what happens when part of it fails.

**Where the bytes wait: the store that was already there.** I did not add a storage mechanism.
`savePhotoPayloads` has always written each photograph's base64 to AsyncStorage under
`sitesnap.photoPayloads` at capture time, `hydratePhotos` has always read it back, and
`deletePhotoPayloads` has always existed to remove it. AsyncStorage is a SQLite-backed store in
the app's documents directory, so it survives an app kill, a crash and a phone reboot in a ute
at the end of the day. That satisfies constraint (a) with no new dependency and no native
module, which is also why this branch is JS-only.

**Why a materialisation step was still needed.** `uploadPhotoOnce` sends a photograph by
handing `FormData` a `uri` and letting the native layer read that path off disk. The uri
recorded at capture time is an ImageManipulator path in the **cache** directory, and iOS makes
no promise that directory survives anything. So `lib/photo-bytes.ts` reverses the capture:
if the original cache file is still there it is used untouched (the common case — coverage
returns while the app is still running — costs one `exists` check); otherwise the durable
base64 is written to a fresh cache file, uploaded, and deleted. Base64 is a lossless encoding
of the same bytes `manipulateAsync` produced and nothing in the path re-encodes, recompresses
or re-orients anything, which is constraint (e). Test 7 asserts it: every field of the
photograph except `uri` and the storage key is byte-identical through the drain.

**Partial failure, constraint (d).** Progress is written back into the queued op after *each*
upload, not at the end. So a drain that uploads three of four and then loses signal leaves the
op in the queue with three photographs already carrying `/api/uploads/…` uris. The retry sees
those, and `uploadPhotoOnce` returns early for a managed uri, so it uploads **one** photograph
rather than four and the bucket does not accumulate a duplicate per attempt. The op is not
lost, and the entry is not posted at all while any photograph is missing — the POST is
downstream of the upload loop, so there is no state in which an entry claiming four
photographs is posted with three.

**How it is proved, and why the module exists.** This is the part worth your attention. The
test this branch needed is the one `docs/AUDIT.md` L28 said was required: queue an entry
offline, drain it, assert the server-side record carries a managed storage key per photograph.
`data-context.tsx` cannot load under `node --test` — it imports the Expo runtime, native
modules and React. Writing the test against a hand-rolled copy of the drain logic would have
produced a test of a strawman that could pass while the shipped path stayed broken.

So the drain was **extracted verbatim, defect included**, into `lib/offline-drain.ts` as a pure
function with its dependencies injected; `DataProvider` was rewired to call it; the red test was
run against that transcription and failed; and only then was it fixed. There is one copy of the
logic and the module under test is the shipped path. `apps/mobile` now has its first test
harness — 15 tests in 2 files, zero new dependencies.

### L30 — an op the server refuses is kept, and the user can see it

`markOpFailed` sets `status: "failed"` and records the stage, the HTTP status, the server's
message, the time and how many photographs had already uploaded. The op stays in local storage.
**Nothing in the app deletes a failed op** — this is a compliance-evidence product and that
deletion is your decision, so there is deliberately no discard button.

**Where a user sees it**, which your Part 3 said must not be a log:

- `components/SyncStatusBanner.tsx` on the sites list. Renders **nothing** when there is
  nothing to say; otherwise a tappable row that routes to the detail screen.
- `app/settings/offline-sync.tsx` — "Waiting to send", then "Did not send" listing each failed
  op: what it was, whether it failed uploading or posting, the status, when, the server's
  message, how many photographs already reached us, and how many times it has been refused.
- A row in Settings whose description carries the count and whose icon and `danger` styling
  flip when something has failed, so the failure is visible one level up without opening it.

**Retried by hand, not on a timer, and here is why.** The failures that reach this state have
been refused by the server on their merits. Retrying them on a schedule would consume attempts
forever and tell the user nothing new. More to the point, the thing that has to change is
usually outside the app — a membership restored, a validation rule relaxed, an entry someone
has to go and correct — so the person who fixed it is the only one who knows a retry is now
worth making. `retryFailedOps` clears `failure` so a second refusal records as fresh but keeps
`attempts`, because how many times the server has already said no is the number worth knowing
before trying a sixth time.

**A second defect in the same four lines, found while fixing the first.** The old loop `break`ed
on *any* error, network or not. So an op the server refused did not merely vanish — while it sat
at the head of the queue it stopped every op behind it from being attempted at all. Only a
network error breaks now; a refusal dead-letters and the drain continues to the next op. Test 9
is exactly this: "a refused op does not stop the ops behind it."

### L31 — the failure modes report themselves, without reporting what the user wrote

Three events: `queued-op-dead-lettered`, `queued-photo-upload-failed`,
`queued-photo-bytes-missing`. De-duplicated per session on `kind|opId|photoId|status` and
bounded at 200, so a queue of forty refused ops reports forty distinct failures rather than
forty copies of one. `reportSyncFailure` never throws — telemetry must not be able to break a
sync.

**The payload rule is enforced by code, not asserted in a comment.**
`lib/sync-telemetry-redaction.ts` imports nothing with a runtime and exports
`transmittablePayload`, which **is** the entire payload that goes to Sentry. That is the point
of the split: a test can assert over all of it rather than over a sample of it, so "no personal
content" is a property of the module rather than a claim about it. Identifiers and counts: op
type, op id, photo id, stage, HTTP status, photo count, photos already uploaded, refusal count.

`SyncFailureReport` has **no `uri` field at all**. That is how the signed-media `?sig=`/`?exp=`
pair is kept out — not by filtering it, but by there being nowhere for it to enter. The logger
fix closed that leak by stripping; this one closes it by structure, which cannot be defeated by
a future caller passing a different field.

**Two leaks found while building it.** Both would have shipped:

1. **A server's own response message is withheld when a `status` is present.** We do not control
   what a 4xx body says, and Stage 1's timecard validation echoes submitted values into its
   message. Our own wording is transmitted; theirs is not. `transmittableDetail` makes that
   decision in one place.
2. **A server-originated `Error` is never handed to Sentry as the exception.** Sentry titles an
   issue with the exception's own message. Passing the refusal through as the exception would
   have re-leaked in the issue *title* precisely what the payload had just withheld — the
   redaction would have been real and useless. `mayTransmitCause` decides; otherwise the issue
   carries an app-authored title.

**`materializeQueuedPhoto` reports from its own throw site**, not from the drain's catch. By the
time the drain sees it, all it has is an exception. At the throw site we know the distinction
that matters: the cache file was checked and absent **and** nothing was stored at capture time.
That pair says the durable write failed when the photograph was taken, which is a different
defect from an upload that could not reach the server, and it is the one mode where the
photograph is genuinely gone.

### The privacy correction, carried on this branch as you asked

`attachScreenshot` was **`true`**. Setting it to `false` was not bookkeeping: a screenshot is a
photograph of whatever was on screen, which on the capture screens is the note text, the site
address and the photographs themselves — exactly what the redaction module exists to withhold.
Leaving it on would have made the rest of Part 4 pointless. The reasoning is now at the call
site so it is not switched back on casually.

Section 5 said "Crash reports from the server go to Sentry" and section 10 listed app crash
reporting among the things not switched on. Both are now false. Corrected in the canonical
`docs/legal/privacy-policy.md` and in both render targets, and the anti-drift check was run and
confirms the copies followed:

```
═══ Structural: the legal documents have not drifted from their source ═══
  privacy-policy: 2612 words, both copies match.
  terms-of-service: 1308 words, both copies match.
```

Three things the new text asserts, each traceable to code rather than to intent: the payload
contents (enforced by `transmittablePayload` and its test); the device model, OS and app version
Sentry attaches automatically whether or not we ask, with `sendDefaultPii: false` so no IP and
no identity; and no screenshot.

**Section 10 was not simply emptied of the claim.** The sentence sat inside the
breach-detection paragraph, supporting the point that nothing would tell us a breach had
happened. That point stands, so the replacement keeps it: crash and sync reporting tells us our
own software broke, not that someone got in. Deleting the sentence outright would have left a
reader thinking error reporting covers intrusion detection.

`Last updated` moves to 4 October 2026 on the Privacy Policy's three copies. Terms of Service
keeps 3 October, which is correct — its text did not change, and the check compares each
document against its own copies rather than across documents.

---

## Part 2 — What I found that nobody asked for

### L36 — the supervisor portal publishes its own Privacy Policy and Terms, outside the drift check, still carrying the superseded text

**This is the finding. It is worse than the two sentences I was sent to fix, and I found it by
grepping for other stale crash-reporting claims while fixing L31.**

The October remediation replaced the canonical source, both in-app copies and both
marketing-site copies — six files — and `Projects/scripts/ci.sh` was then given an anti-drift
check over exactly those six. `Projects/apps/supervisor-web/app/privacy/page.tsx` and
`app/terms/page.tsx` are a **seventh and eighth** legal document. They were never touched, they
carry no `BEGIN LEGAL TEXT` marker, and the drift check does not know they exist.

They are not dead files. Both are reachable Next.js routes linked from the live portal UI in two
places: `app/settings/page.tsx:623` and `components/ProfileDropdown.tsx:150`.

What is still being served, from the same table in `docs/legal/README.md` that lists the claims
the code contradicts:

| Still live on the portal | Why it is false |
|---|---|
| "anonymised analytics events to improve the product" (`privacy/page.tsx:53`, `:62`) | There is no analytics SDK in the product at all |
| "Resend / SendGrid (USA)" (`:71`) | No `SENDGRID_API_KEY` is configured anywhere; SendGrid receives nothing |
| "Deleted account data is permanently purged within 30 days" (`:80`) | There is no scheduled job of any kind in the API |
| "Portability — request a machine-readable data export" (`:89`) | `backup-data.tsx` reads the device cache and omits timesheets, incidents, inspections, signatures, locations, photographs and the account record |
| "All overseas transfers … comply with … IPP 12" (`:76`) | Asserts a conclusion with no analysis, about providers it places in the wrong countries |
| The processor list (`:69-74`) | **Omits Render entirely**, so the Singapore hosting leg is undisclosed — the leg the whole Principle 12 position turns on |
| "billed in advance in New Zealand Dollars", "change pricing with 30 days' notice" (`terms/page.tsx:75`, `:107`) | There is no payment code in the repo. No Stripe, no RevenueCat, no in-app purchase dependency. The product cannot charge anyone. |

**Your correction last week was that US exposure runs through three paths, not two, and you
said it was the error that mattered.** This is the same class of error, one layer out: the
corrected text is published in six places and the uncorrected text is published in two more,
and the check built to prevent exactly this cannot see them.

**The generalisable part, and why I rated it HIGH.** The remediation was thorough about the
copies it knew about, and then built a check over that same set. A drift check can only prove
the copies it enumerates agree — it cannot discover a copy. So its green result actively
created confidence about two documents it had never read. This is the L35 shape again (a copy
defect fixed at the layer nobody reads) and the vacuity shape generally: **the right question
after writing an anti-drift check is not "does it pass" but "how would I find a copy it does
not list", and the answer here was one grep.** My own check, which I wrote and defended with a
400-word floor, had this hole in it from the start and I did not see it until I went looking for
something else.

**I did not fix it, and I want to be explicit that this was a judgement call you may overturn.**
Making those pages correct means rendering 2,612 and 1,308 words of reviewed legal text through
a third layout. You have twice reserved final say on published legal wording, and replacing two
complete legal documents inside a branch about offline photograph sync would bury it in review
and make it impossible to revert on its own. Extending the drift check to cover them first
would simply turn CI red and block this branch. The fix is recorded in L36 with the shape I
would use: port the reviewed text as data through the portal's existing `Section` component (the
shape `constants/legal/*-content.ts` already proves), add the markers, and extend
`assert_legal_copies` to compare three render targets per document instead of two — so the
check's green result finally means what it appears to mean. `docs/legal/README.md` records a
deliberate decision against a permanent generator, and a one-off transcription respects it.

### L37 — nothing rendered the sync state at all, so the badge your checklist refers to did not exist

`data-context.tsx` has exposed `syncStatus`, `pendingCount` and `isPending` for as long as the
queue has existed. **No component read any of them.** Verified by grep across `app/` and
`components/`: every renderer of `pendingCount` and `failedOps` is a file this branch added, and
`syncStatus` and `isPending` still have none.

So there was no pending badge, no "waiting to send" indicator, and no surface of any kind
distinguishing an entry held on the phone from an entry the server has. This is L28 one level
up: L28 was the silent data loss, and this is the silence. "It looks saved" was the only signal
available to a user, and L28 is what made that signal unreliable.

It also means Part 5's instruction could not be followed as written on a pre-branch build —
there was no badge to wait for. The banner and the Settings surface are the first two renderers.
What is still missing is the **per-entry** indicator, which is the more useful half, because the
question a person actually asks is "has *this* entry arrived", not "is anything pending".

### L38 — only `addSite` and `addEntry` are ever queued; an offline edit or delete is lost

`drainOfflineQueue` has branches for `updateEntry`, `deleteEntry` and `deleteSite`. Nothing
enqueues them — every `enqueue(` call site in `apps/mobile` is `addSite` or `addEntry`. Three of
the five `QueuedOpType` members have never executed.

The live half is what happens instead. `updateEntry` has **no try/catch at all**; offline, the
`apiJson` PATCH rejects and propagates to the caller. So correcting a crew count, fixing a note
or adding a photograph to yesterday's entry with no coverage fails at the point of saving and
is never queued for later. Whether the user is told depends on the calling screen, which is not
the guarantee the capture path has.

I did not expand into it, because queuing mutations brings ordering and conflict questions with
it — an edit queued behind the create of the entry it edits, a delete queued behind an edit —
and those are the offline-first architecture piece you told me not to build yet. The dead
branches were kept rather than deleted for the same reason.

### L39 — the server accepts an entry photograph with a `file://` uri and no storage key

`EntrySchema` types photographs as `z.array(z.record(z.unknown()))`, so the API stores whatever
shape the client posts, including a photograph whose `uri` points at a path on a phone.

Worth recording even though no client now sends one, because for the months L28 was live
**the server was in a position to notice and did not**. A rule rejecting an entry photograph
without a managed storage key would have turned L28 from a silent data loss into a 400 on the
first offline entry ever synced. It is also the reason L28 needed no migration — the same
looseness that hid it let the storage keys pass straight through — so it is a trade-off to
decide rather than an oversight to patch. Do not add the assertion before the fixed client is
actually deployed, or it will reject entries queued by an older build that are still sitting on
a phone.

---

## Part 3 — What was not done, and why

**The offline-first architecture.** You scoped L28/L30/L31 as a focused branch and said the
larger piece waits for a prompt. Nothing here reaches beyond the drain loop, the queue's
state and the surfaces that show it.

**L36, the portal legal pages.** Part 2 explains the call. It is the first thing I would pick up.

**Queuing `updateEntry`, `deleteEntry` and `deleteSite`** (L38). Needs ordering guarantees the
queue does not have.

**The per-entry sync indicator** (L37). A list-level surface exists; a per-row one does not.

**The server-side storage-key assertion** (L39). Deliberately after the fixed client deploys.

**The Sentry DSN.** Untouched, unread, unprinted. Yours to move.

**No schema change and no native module**, so neither stop condition fired. `EntrySchema` types
photos loosely enough that storage keys pass through untouched, and `expo-file-system ^19.0.24`
was already a dependency — the `File`/`Paths` class API is live even though the root
`writeAsStringAsync` is now a throwing deprecation stub. **JS-only. No rebuild needed to test
this, though you will need a new build to get it onto a phone.**

**No skipped tests.** 15 of 15 run and pass.

---

## Part 4 — What in the prompt turned out to be wrong

**"Wait for the badge to clear."** There was no badge (L37). Nothing rendered any sync state
before this branch. The instruction was unperformable rather than wrong, and the substitute is
the new banner and the Settings count.

**"Each should produce a telemetry event with enough context to diagnose it."** Correct, but
incomplete in a way that mattered: it constrains the *payload* and says nothing about the
*issue title*. Sentry titles an issue with the exception's message, so a compliant payload plus
a server-originated exception leaks in the title what the payload withheld. Following the
instruction literally would have produced a redaction that was real and useless.

**"If the test can only be written at a level that cannot run in this environment, say so."**
It could be written here, but only after an extraction — the honest answer was neither "yes" nor
"no" but "not against the file as it stands". You were also right to assume my check could pass
having read nothing. It could: a silent AsyncStorage failure would have made "no photograph
lacks a storage key" pass over an empty list. That is why test 1 is a harness positive control
and why the runner pins both the file count and the test count.

**One thing of my own that was wrong.** In Part 7 of the last review I presented the anti-drift
check as proof the legal copies agree. It proves the six it lists agree. Two more exist (L36).

---

## Part 5 — New AUDIT entries

| ID | Severity | What |
|---|---|---|
| **L36** | HIGH | The supervisor portal publishes its own Privacy Policy and Terms, outside the anti-drift check, still carrying the superseded text — eight false statements enumerated with line numbers |
| **L37** | MEDIUM | Nothing rendered the sync state at all; the badge the device checklist refers to did not exist. Partly closed here |
| **L38** | MEDIUM | Only `addSite`/`addEntry` are ever queued; an offline edit or delete fails to the caller and is lost |
| **L39** | LOW | The server accepts an entry photograph with a `file://` uri and no storage key, and was in a position to notice L28 for months |

L28 closed, L30 closed, L31 part-closed (the DSN half remains yours). Each disposition records
the mechanism rather than the outcome, and what was found while fixing it. L29 stays reserved.

---

## Part 6 — What cannot be verified here, and what it would take

**That a real photograph taken on a real phone with no coverage arrives in the bucket.** The
test proves the drain uploads before it posts and that the posted payload carries a managed
storage key per photograph, against injected dependencies. It does not prove
`expo-file-system`'s `File.write` round-trips base64 correctly on a device, that
`uploadPhotoOnce`'s `FormData` accepts the materialised path, or that AsyncStorage survives the
specific kind of kill iOS performs on a backgrounded app. Those need the device pass in Part 7,
and the second surface is the only honest check — the phone shows the photographs either way.

**That the telemetry arrives.** No DSN here, by your instruction. The redaction is proved; the
transport is not. When you move the DSN, the first dead-letter should produce a Sentry issue
whose title is app-authored and whose `sync` context carries counts and no content.

**The database suites.** The local run was `./scripts/ci.sh --no-db --no-redis`, which the
script labels a partial pass. CI on the PR is the real gate.

**That no entry already on the server lost its photographs.** This branch fixes the path
forward. It does not and must not touch records already written — you decide what happens to
incomplete records. Finding out how many exist is a read-only query against production I have
not run.

---

## Part 7 — The device checklist

Run this on a build from this branch. It needs a new native build to get onto a phone, but
nothing in it required a native change.

**1. The core case — the one that matters.**
Airplane mode on. New entry, four or five photographs, save. The entry appears with its
photographs and the banner says something is waiting. Airplane mode off. Wait for the banner to
clear and the Settings count to reach zero.

**Then check from somewhere that is not the phone** — the supervisor portal, a generated diary,
or an export. **The photographs must be there.**

**Still broken if:** the phone shows the photographs and the other surface does not. That is the
exact shape of the original defect, and the phone is the one surface that cannot tell you.

**2. Partial failure.** Same capture, then turn the network **off mid-drain**. Expect: the op
stays, the banner still shows it waiting, nothing is dead-lettered (a network error is not a
refusal). Network on. Expect the entry to arrive complete, and the bucket to hold each
photograph **once** — not twice for the ones that uploaded before the cut.

**3. A dead letter.** A timecard with a finish before its start is the easiest way to produce
the 4xx. Queue it offline, restore coverage. Expect: the op is **not** deleted, the banner turns
red, Settings shows it under "Did not send" with the server's reason and the time, and **any
entry queued behind it still syncs** — that last one is the L30 second defect and is the part
most likely to regress. Then fix the timecard and retry by hand.

**4. The restart case.** Capture offline, then force-quit the app before restoring coverage.
Reopen it with coverage. Expect the queue to drain with the photographs intact — this is the
case the old code could never have handled and the reason the bytes live in AsyncStorage.

---

## Part 8 — Does closing these reorder the backlog again

**Yes, and not to the thing you guessed.**

You asked whether closing L28 and L30 moves up the evidence-integrity surface or L6. Neither.
**L36 goes first** — ahead of both, and ahead of the narrative report.

The reasoning is the same one you used to move offline sync to first, applied one layer out. You
said an AI narrative report generated from an entry whose photographs never uploaded would
confidently describe evidence that is not there, and that in a compliance document that is worse
than no report. A published privacy policy that tells a user we run anonymised analytics we do
not run, purge their data on a timetable that does not exist, offer an export that does not
work, and comply with Principle 12 on the strength of an assertion with no analysis behind it —
while omitting the hosting leg the whole Principle 12 position turns on — is the same defect in
the same product, except that it is a legal document rather than a convenience, it is live right
now, and it is addressed to the person whose data it is about. And unlike L32 or L33 it is not a
question of wording accuracy about a real feature: it is text you have **already reviewed and
replaced**, still being served from a route linked in your own portal UI.

It is also cheap. The text exists and is reviewed; the work is transcription plus four lines in
the drift check. That combination — live false statements in a published legal document, a
known-good replacement already written, and a day's work — is what puts it first.

**My order from here:**

1. **L36** — the two portal legal documents, and extend the drift check so it can no longer be
   green about a copy it has not read.
2. **The device pass in Part 7.** Everything in this branch is test-verified and nothing is
   field-verified. Until the second surface shows the photographs, L28 is closed on my word.
3. **The Sentry DSN** (your half of L31). Until it moves, the telemetry this branch built reports
   to nowhere, and the December failure mode is still invisible.
4. **L37's per-entry indicator.** "Has this entry arrived" is the question people actually ask,
   and after this branch it is answerable — the data is there and nothing shows it per row.
5. **The evidence-integrity surface**, where you had it.
6. **L6**, which got *better* here rather than worse and is less urgent than it was.
7. **L38 / the offline-first architecture**, when you send the prompt. L38 is the honest reason
   it is still needed: the capture path is fixed and the edit path is not.

**On L6, since you asked specifically: better.** The queued path now calls
`deletePhotoPayloads` after a successful sync, released *after* the dequeue so a crash in
between orphans bytes rather than losing them. Before this branch nothing ever deleted a queued
payload — every photograph captured offline left its base64 in AsyncStorage permanently. The one
new consumer is the temporary cache file `photo-bytes.ts` writes, which is released in a
`finally` and is in the cache directory the OS reclaims anyway.

---

**What this branch does not change:** nothing on the server, nothing in the database, no
migration, no native module, no dependency. Each commit is revertible alone.
