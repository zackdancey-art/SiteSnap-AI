# Stage 1, Stage 3 and the Review

**Branch:** `fix/stage-1-field-app-defects` — 12 commits off `main`
**Written:** 3 October 2026, against commit `ec457cb`
**Source of truth for the diagnosis:** `docs/STAGE-0-ANALYSIS.md`
**Scope:** Stage 1's eight field-app defects, Stage 3's six legal documents, and this review.

Read Part 2 and Part 7 if you read nothing else. Part 2 is the unasked-for findings;
Part 7 includes one that I think changes your December plan.

---

## Part 1 — What was fixed

One commit per item, so any single one can be reverted alone. "Verified by harness"
means I observed the behaviour change on a running system; "verified by test" means an
automated test fails when the fix is removed; "unverified — device" means the mechanism
is in place but only a person holding a phone can confirm the result.

### Item 1 — A development client could read and write the production database
**`f33613b`** · `apps/mobile/lib/api-base-url.ts`, `.env.example` · JS-only

Every guard in that file ran in one direction: they protected a *release* build from dev
values. Nothing protected *dev* from production values, so `expo start` with
`EXPO_PUBLIC_API_URL` pointing at the deployed API was accepted in silence. Added the
mirror image: in `__DEV__`, a non-local API URL throws unless `EXPO_PUBLIC_ALLOW_PROD_API=1`
is set deliberately, and when it is, boot logs a loud one-time warning naming the
deployment it is about to write to. The escape hatch lives in code, not `.env`, so a
review can see it exists.

The 4000/4001 disagreement (AUDIT L2) is settled on **4000** — the port `server.ts`
actually listens on and the one the EAS `development` profile already sets.

**Verified by harness, both directions.** A dev boot with the production URL set threw
`[api] Refusing to use the non-local API URL "https://sitesap-ai.onrender.com" in a
development build.` and the app did not start; with the URL unset it logged
`[api] Resolved base URL: http://127.0.0.1:4000` and ran.

### Item 2 — Terms of Service back button: **not fixed, deliberately**
**`38e47b2`** · `apps/mobile/lib/dev-nav-probe.ts`, `app/_layout.tsx` · JS-only

Instrumented, as instructed, rather than guessed at. Behind `EXPO_PUBLIC_NAV_PROBE`, a
gated `require` attaches a navigation listener that logs every action, its payload, and
the stack before and after, so the three possible causes separate cleanly: nothing logged
means the press never reaches JS; an action logged as NOOP means a navigator refused it;
an action with an unchanged stack means it was applied and then undone.

The probe works. On a real boot it logged the push onto the screen correctly
(`#2 PUSH terms-of-service`, stack after `__root (1/1) > terms-of-service (2/2)`).
**What it did not do is tap the back chevron**, because this environment cannot drive the
Simulator — Accessibility permission for System Events cannot be granted
non-interactively, and `idb`, `cliclick` and `xdotool` are all absent. The positive
control failed identically to the test case, which is how I know the limitation is the
harness and not the app.

So: **no defect was reproduced, nothing was changed, and I am not offering a third
hypothesis.** The tap matrix is in the device checklist in the PR body. One thing the
probe banner says that matters when you run it: a native chevron emits `POP`, a
`ScreenHeader` back button emits `GO_BACK`. Reading "no POP" off a screen that uses the
latter is a false positive, and it is the shape of mistake that produced this item.

### Item 3 — A timesheet could be saved with a finish before its start
**`56dddf5`** · `services/api/src/routes/crew.ts`, `apps/mobile/app/crew/[siteId].tsx`,
`services/api/src/routes/crew.test.ts` · JS-only

Server first: a Zod `.superRefine()` on the timecard schema rejects a card whose finish is
not after its start, with a 400 naming `endTime`. The client mirrors it so the person gets
the message before the round trip, but the server is the authority.

**Overnight shifts are not supported, and I did not build support for them.** A card
finishing at 02:00 after a 22:00 start is rejected. That is the existing behaviour made
explicit rather than a new restriction.

No migration. No existing row was read, altered or counted.

**Verified by test,** with the positive control in the same test: the valid card is
accepted against the same endpoint, so the rejection is not passing because the endpoint
denies everything. A second test asserts a card with no clocked times at all is still
accepted, because that is a legitimate shape here.

### Item 4 — Swipe-to-dismiss could discard a New Entry mid-save
**`0eb0ef0`** · `apps/mobile/app/new-entry.tsx` · JS-only

`useUnsavedChangesGuard(isDirty)` became `useUnsavedChangesGuard(isDirty || saving)`. The
guard was keyed only on unsaved edits, so the window where the photographs are uploading —
the slow part, the part a person swipes away from — was unguarded.

**Reported, not widened:** `create-site.tsx` and `profile.tsx` both call the same hook
with `isDirty` alone, so they are guarded against a dirty dismiss but not against a
dismiss during a save. Same one-word change, two files I was told not to touch.

**Unverified — device.** The hook is wired; whether the gesture is actually blocked during
an upload needs a phone and a slow connection.

### Item 5 — Dashboard rebuild, and the conditional hook in the same file
**`0fadf2d`** · `apps/mobile/app/supervisor-dashboard.tsx` · JS-only

Note for anyone reading the commit subject: this is the **mobile** screen named
"supervisor dashboard", not the `apps/supervisor-web` Next.js package. I had it as the
latter in the first draft of this review and corrected it from the commit's file list — it
matters because it changes the deploy target from a website deploy to an `eas update`.

Rebuilt, and the hook that sat below an early return moved above it, so the hook order is
stable across renders rather than depending on whether data had loaded.

**`eslint-plugin-react-hooks` is not installed and I did not install it** — confirmed by
reading `Projects/package.json` and the eslint config, not assumed. A repo-wide rule would
light up files this branch has no business touching. Logged as backlog.

### Item 6 — The request logger wrote member emails, push tokens and signed-media secrets
**`537117e`** · `services/api/src/middleware/logger.ts` + `logger.test.ts` · JS-only

morgan's `:url` token logged the full request URL. On this API that means member email
addresses in path segments, push tokens, and the `?sig=` / `?exp=` pair that makes a
signed media URL loadable — so anyone with log access had working photograph links.
Replaced with a `safeurl` token backed by `redactUrl()`.

**Verified by test.**

### Item 7 — OpenAI was retaining site notes, captions and photographs
**`dfb7fc1`** · `services/api/src/routes/ai.ts` · JS-only

`store: false` on the diary request, after checking that nothing reads back server-side
state: there is exactly one LLM call site, it is a single-turn request, and no previous
response id is ever referenced.

**The `temperature` half of this item needed no change.** It was already handled: the
request attaches sampling parameters per-model through `supportsSamplingParams(model)`,
against a documented allowlist of models positively verified to accept them, with the
SITESNAP-API-9 incident written up in the file. Nothing to derive, nothing to skip.

### Item 8 — Is `app.company_id` ever set from request-supplied data?
No code change needed. **No.**

One line, as asked: every value comes either from `claims.companyId` on a
signature-verified token or from `soloCompanyIdForEmail(verifiedEmail)`, which is an md5
of the email the token proves. The only two non-test call sites that set it are
`storage/tenant.ts:35` and `storage/projectsStore.ts:1540`.

The one candidate I chased down because it looked like a counter-example:
`routes/auth.ts:124` reads `companyName` from the request body. It is a display string and
is never used to derive an id.

### Part 2 of the prompt — the legal documents
**`87679c9`, `c8978cc`, `d4b20b6`, `f65cb47`, `ec457cb`**

- **`docs/legal/privacy-policy.md`** and **`docs/legal/terms-of-service.md`** are the
  canonical text, 2,508 and 1,308 compared words, each naming its render targets.
- **`docs/legal/README.md`** records that these were drafted from a code audit on
  3 October 2026 against commit `dfb7fc1`, that they have **not been reviewed by a
  lawyer**, the review trigger, six questions for a lawyer, the full IPP 12 analysis with
  sources, the sub-processor table, and a 13-row table of previously-published claims the
  code contradicts.
- Four app surfaces and two website pages render from that source. The draft banner is
  gone from the published pages; a single "Last updated" date comes from the canonical
  header.
- **`Projects/scripts/ci.sh`** fails the build when a rendered copy diverges.

Entity is consistent across all six documents: **SiteSnap AI Limited, NZBN 9429053872258**.
Pending-incorporation wording removed everywhere it appeared.

**Render is Singapore, not Oregon**, and the cross-border analysis is New Zealand →
Singapore, researched for Singapore rather than inherited from a US write-up. The short
version, with the long version in `docs/legal/README.md`:

- IPP 12 (Privacy Act 2020 s 22) lists six bases for sending personal information
  overseas. **No country has ever been prescribed** under s 214, so basis (e) is available
  to nobody — not a Singapore problem, a nobody problem.
- The **s 11 agent rule** is the load-bearing part: information held by an agent is held
  by the principal, so pure hosting is not a disclosure and the Singapore leg probably
  falls outside IPP 12 altogether.
- Singapore's PDPA **data-intermediary carve-out** lifts Parts 3–6 off exactly Render's
  role, leaving only s 24 (protection) and s 25 (retention). So basis (c) — comparable
  safeguards — is **weaker than it looks**, which is the opposite of the conclusion a US
  analysis would have produced.
- **OpenAI is the leg where IPP 12 plainly bites,** because OpenAI retains content for its
  own abuse monitoring and is not acting purely as our agent. `store: false` reduces what
  is retained; it does not make that leg an agency relationship.
- US exposure runs through **three** paths, not the two the prompt named: OpenAI, the
  legacy `sitesnapai-bucket` in `us-east-1`, and **Sentry** — the API has a live DSN. See
  Part 4.

### Part 2 of the prompt — the four promises the product does not keep

1. **`DELETE /auth/account` said "permanently deleted".** Fixed in `ec457cb`, and the fix
   went further than the item, for a reason in Part 2 below.
2. **Nothing deletes an S3 object.** Not fixed — correctly, per instruction. It is in the
   PR body as backlog and recorded as **L33**.
3. **"then permanently purged" described no mechanism.** Removed from
   `settings/data-privacy.tsx`; replaced with the two mechanisms that actually exist.
4. **`backup-data.tsx` is not a data export.** Relabelled. Under IPP 6 the honest answer
   is on the screen: email us and we assemble it by hand within 20 working days.

**The retention contradiction is named, not smoothed.** Section 8 of the Privacy Policy
sets out that deletion of a compliance record is a flag, that the company record survives,
that no photograph file is ever deleted, and that this cannot be reconciled with a promise
that deleting your account deletes your photographs — and says we are not going to print
both. The choice is in the PR body for you.

---

## Part 2 — What I found that nobody asked for

### 1. An entry captured offline syncs **without its photographs**

This is the one to read. I found it while checking a sentence for Part 7 and it is worse
than anything in Stage 1.

The online create path uploads photographs to S3 and then POSTs the entry with the
returned storage keys (`lib/data-context.tsx:585-592`). If the upload fails with a network
error, the catch branch builds an optimistic local entry and queues it:

```
await savePhotoPayloads(entryData.photos);          // base64 kept on the phone
await enqueue({ type: "addEntry", payload: stripPhotoPayloads(optimistic) });
```

`stripPhotoPayloads` removes the base64. The photographs were never uploaded, so they
carry no storage key either. When the queue drains (`data-context.tsx:434-441`) the handler
does this:

```
await apiJson("/projects/entries", { method: "POST", body: JSON.stringify(stripPhotoPayloads({ ...data })) });
```

**There is no upload step anywhere in the drain loop.** `uploadPhotos` is called at lines
585 and 644 — both online paths — and nowhere else in the queue. So the record that
reaches the server has photo objects pointing at a local device path, and the images never
leave the phone.

The reason this is severe rather than merely wrong: `savePhotoPayloads` keeps the base64
locally, so **the app still shows the photographs**. The entry loses its pending badge when
the queue drains and looks synced. Nothing on the phone, and nothing on the server,
indicates that the evidence is not there. You would discover it the first time you opened
the supervisor portal, or a report, looking for a photograph you remember taking.

For a product whose entire value is photographic evidence captured on sites with poor
signal, this is the core promise failing in exactly the conditions it was built for.
Recorded as **L28**. I did not fix it: it is outside this branch's eight items, it needs a
design decision about where queued binaries live and how the drain re-attaches them, and it
deserves its own branch and its own test rather than being appended to a legal-documents
PR at the end of a long session.

### 2. A queued offline write that the server rejects is silently discarded

Same loop, the error branch:

```
if (!isNetworkError(err)) {
  await dequeue(op.id);                 // drop the op to avoid infinite retry
  console.warn("[queue] Dropping unrecoverable queued op", op.type, err);
}
```

Avoiding an infinite retry is right. Dropping the person's work to achieve it is not. Any
4xx — including, now, a timesheet the Item 3 validation rejects — makes a queued entry
vanish with a `console.warn` nobody sees, on a device with no crash reporting (see 4
below). Recorded as **L30**.

### 3. The fix I was asked for was at the layer nobody reads

Item 1 of the four promises named the `DELETE /auth/account` response message. I changed
it. Then I checked who displays it, and found that `settings.tsx` discards the response
body on success and navigates to `/login`. **The message is dead text.** The promise a
person actually reads is the `Alert` in the confirmation dialog, which said "This will
permanently delete your account and all your site data, entries, and reports."

Fixing only the string named in the audit would have changed nothing a user sees, and the
item would have been closed as done. Both are fixed in `ec457cb`. Recorded as **L35**,
because the pattern generalises: a user-facing-copy finding located by grepping the API is
located at the wrong layer by default.

### 4. Mobile Sentry is dead because the DSN is in the wrong `.env` file

`EXPO_PUBLIC_SENTRY_DSN` is set — 95 characters, value never printed or logged — in
**`Projects/services/api/.env`**, where nothing reads an `EXPO_PUBLIC_` variable. In
`Projects/apps/mobile/.env` the same key is present and **empty**.

So the explanation for "mobile Sentry transport is dead" is not a broken transport. The
value exists and is one file away from where it is needed. That changes the backlog item
from an investigation into a two-minute move — and it changes the priority, because it
means that from the moment you start on real sites in December you have **no crash
visibility from the field at all**, which is also what makes findings 1 and 2 above
invisible in practice. Recorded as **L31**.

Note the decision this creates rather than removes, which was already in your backlog
framing: `attachScreenshot: true` means a crash report may carry a screenshot of a site
photograph. Supplying the DSN is therefore a privacy decision, not a switch.

### 5. Camera GPS coordinates are extracted and stored, and the policy said they were not

The published privacy text said GPS coordinates are used at request time to auto-fill
weather and are not stored. That is false. The app passes `exif: true` to the picker,
`extractGpsFromExif()` reads the camera's coordinates in both `new-entry.tsx` and
`inspections/[siteId].tsx`, `...gps` is spread onto the photo object, `types.ts:31` carries
`latitude`/`longitude`, and `photos_json JSONB` persists them.

So every photograph may carry the location where it was taken, in the database, which for
a site diary is arguably a feature — but it was being denied in a privacy policy. The
canonical policy now describes it. Recorded as **L32**.

**Separately, and still unverified:** the uploaded file is a re-encoded JPEG from
`manipulateAsync`, and I did not inspect that output's own metadata block. So the policy
says EXIF handling is **unverified** and does **not** claim stripping, exactly as
instructed. What it would take is in Part 6.

### 6. There is no payment code anywhere

No Stripe, no RevenueCat, no `react-native-iap`, no `expo-in-app-purchases`, no billing
module — verified against both `package.json` files. The previous Terms described billing
in advance, "AUD where indicated at checkout", and 30 days' notice of price changes. All of
it described software that does not exist.

Section 8 of the new Terms is written around what the product can actually do: it is free
because there is no way to charge you, and if that changes, records stay readable and
exportable for at least ninety days. That last part is a commitment I wrote and you should
check you are willing to keep.

### 7. Two deletion mechanisms coexist and nothing named which was which

Incidents, timesheets, inspections and deliveries **soft**-delete — `UPDATE … SET
deleted_at = NOW()`, row retained, which is correct for compliance records. Sites and
diary entries **hard**-delete — `DELETE FROM`, gone. Account deletion is also a hard
delete and cascades widely.

Nothing in the product or the docs distinguished them, and my own first draft of
`settings/data-privacy.tsx` got it wrong in the generous direction: it told the reader
their deleted records were retained, which for a site or an entry is not true. Corrected in
`ec457cb`. Folded into **L33**.

### 8. Two security findings I deliberately kept out of the published text

Both belong in the audit; neither belongs in a public policy, because no IPP requires
disclosing the weakness of a safeguard and publishing it is an invitation rather than a
disclosure.

- **Email and SMS verification codes are stored in plaintext.** `auth_pending_registrations`
  carries `email_code TEXT NOT NULL` and `sms_code TEXT NOT NULL` — the codes themselves,
  beside the `password_hash`. Recorded as **L34**.
- **The scrypt cost factor is unspecified.** `utils/password.ts` calls
  `scrypt(password, salt, KEY_LENGTH)` with no options, so it takes Node's defaults
  (N=16384, r=8, p=1). Defensible, but it is a default rather than a decision, and nothing
  records that anyone chose it. Noted under L34.

### 9. `docs/STAGE-0-ANALYSIS.md` is not on `main`

The prompt says to read it as though it were present. It is not — it lives on
`feat/invite-universal-links`, your branch. I read it via `git show`. Worth knowing before
the next fresh session follows the same instruction and concludes the file does not exist.

---

## Part 3 — What was not done, and why

**"No change needed" is a result.** Four of these are that.

| Item | Status | Why |
|---|---|---|
| **Item 2** — ToS back button | **No change** | No defect reproduced. The probe is committed and works; the tap could not be driven from this environment. Not holding the branch, not offering a third hypothesis. |
| **Item 7** — `temperature` | **No change needed** | Already handled per-model against a verified allowlist, with the incident documented in the file. |
| **Item 8** — `app.company_id` | **No change needed** | Clean. Server-side only, from a signature-verified token. |
| **Item 4** — `create-site`, `profile` | **Reported, not widened** | Both guard a dirty dismiss but not a dismiss during a save. Same one-word change; told not to touch them. |
| `eslint-plugin-react-hooks` | **Not installed** | Instructed not to. A repo-wide rule lights up files outside this branch. Backlog. |
| S3 object deletion | **Not built** | Instructed not to. Backlog, and **L33**. |
| Overnight shift support | **Not built** | Instructed not to. The rejection is the existing behaviour made explicit. |
| **L28** — offline photographs | **Not fixed** | Found at the end, outside the eight items, needs a design decision and its own tests. Its own branch. |
| **L30** — dropped queued ops | **Not fixed** | Same reason, same branch as L28. |
| **L31** — the misplaced Sentry DSN | **Not moved** | It is a real credential in a gitignored file. Moving a secret between `.env` files is yours to do; I will not relocate a live DSN unprompted. |
| Database migration | **None written** | Nothing here needed one. Highest on disk remains `030_project_diaries_generation.sql`; next free is **031**. Production reports `applied: 30, expected: 30`. |
| Native rebuild | **None needed** | All twelve commits are JS-only. Stage 0's one-build plan holds. |

---

## Part 4 — Every claim that turned out to be wrong

Mine, the prompt's, and Stage 0's.

### Mine

1. **I said Render runs in Oregon. It runs in Singapore.** You corrected me by reading the
   dashboard. The mechanism is worth keeping, because it will recur: I measured
   `gcp-us-west1-1.origin.onrender.com`, which is real, and read a *region* off what is an
   *edge/origin* hostname. That is a measurement of the wrong layer, not a bad measurement
   — and it produced a confident, specific, wrong answer that a whole cross-border analysis
   was then built on.
2. **I wrote that deleted records are "marked deleted rather than erased", unqualified.**
   True for four tables, false for sites and entries, which are hard deletes. Corrected in
   `ec457cb`. I wrote a privacy claim from a pattern I had seen in one store rather than
   from the store that handles the data in question.
3. **I wrote "two things survive deleting your account" on the settings screen.** Three do:
   the upload records, the photograph files, and the company record. The canonical policy
   had it right; the summary screen I derived from it undercounted.
4. **My first drift-check extractor matched the wrong lines.** `sed -n '/BEGIN LEGAL
   TEXT/,/END LEGAL TEXT/p'` matched the phrase in the canonical files' own header prose,
   so the range started near the top of the file and reported the metadata table as stray
   markdown. The check now anchors on the exact comment line. Encoded as a comment in
   `ci.sh` so the next person does not rediscover it.
5. **My first version of the drift check could pass vacuously.** Two empty word streams
   compare equal, so renaming a marker would have made both sides empty and passed the
   check having read nothing. Caught by testing the check against a renamed marker rather
   than by reasoning about it. There is now a hard minimum-length assertion. This is M7
   from `docs/VACUITY-AUDIT.md` in a new place, which is the second time that pattern has
   appeared in a check I wrote.

### The prompt's

6. **"US exposure runs through exactly two paths: OpenAI, and the legacy
   `sitesnapai-bucket` in `us-east-1`."** There are three. **Sentry** is the other: the API
   has a live `SENTRY_DSN` and Sentry's org is US-hosted. The reason it is easy to miss is
   finding 4 above — mobile Sentry is dead, so Sentry feels inactive, but the server side
   is not.
7. **"`settings/data-privacy.tsx` says 'once the company is incorporated'."** That wording
   is not in that file. The stale pending-incorporation wording was in `privacy-policy.tsx`
   and `terms-of-service.tsx`. Both fixed; the claim about which file was wrong.
8. **"`create-site` and `profile` have the same unguarded gesture."** Both already call
   `useUnsavedChangesGuard(isDirty)`. The gap is narrower than stated: they are guarded
   against a dirty dismiss and unguarded only during a save.
9. **"The next free AUDIT number is L28; the user's conflicting L26 is renumbered L29."**
   I could not find a second L26 to renumber. `docs/AUDIT.md` carries L24–L27 **identically
   on `main`, on this branch, and on `feat/invite-universal-links`**, and its L26 is the
   double-tapped-Save finding. So either your L26 lives outside git or it is the same one.
   I have left **L29 unused and reserved** for it and numbered my new entries L28, then
   L30 onward, so nothing collides whichever it turns out to be.

### Stage 0's

10. **"Zero occurrences of `beforeRemove` / `gestureEnabled` in the mobile app."** False.
    Both appear. Its Finding N was built on that count and is false with it.
11. **Stage 0's A6 table says all four in-app legal screens carry a draft banner.** Two
    do. `privacy-policy.tsx` and `terms-of-service.tsx` carried one; `settings/about.tsx`
    and `settings/data-privacy.tsx` never did. The two marketing pages also carried none,
    which the prompt had right.
12. **Stage 0 described EXIF handling as unknown.** It is partly knowable and I resolved it
    in both directions: GPS **is** extracted and persisted (finding 5), while what survives
    in the re-encoded upload remains genuinely unverified.

---

## Part 5 — New AUDIT entries

Numbered from **L28**, with **L29 reserved** per Part 4 item 9. Full entries are appended
to `docs/AUDIT.md`; these are the headlines.

| ID | Severity | Finding |
|---|---|---|
| **L28** | **HIGH** | An entry captured offline syncs without its photographs, and looks synced. |
| L29 | — | *Reserved for the renumbered finding referred to in Prompt 23.* |
| **L30** | MEDIUM | A queued offline write rejected by the server is silently discarded. |
| **L31** | MEDIUM | `EXPO_PUBLIC_SENTRY_DSN` is set in the API's `.env` and empty in the mobile app's, so there is no crash visibility from the field. |
| **L32** | MEDIUM | Camera GPS coordinates are extracted and persisted while the published policy denied it. |
| **L33** | MEDIUM | No code path can delete a stored object, and two deletion mechanisms coexist unnamed. |
| **L34** | MEDIUM | Email and SMS verification codes are stored in plaintext; the scrypt cost factor is a default rather than a decision. |
| **L35** | LOW | A user-facing-copy fix was applied at a layer no user reads. |

---

## Part 6 — What still cannot be verified, and what it would take

| Claim | Why not verified | What would settle it |
|---|---|---|
| The ToS back button is or is not broken | This environment cannot tap the Simulator: Accessibility cannot be granted to System Events non-interactively, and `idb`, `cliclick`, `xdotool` are absent. The positive control failed identically. | The four-tap matrix in the PR body, on a device, with `EXPO_PUBLIC_NAV_PROBE=1`. Ten minutes. |
| Swipe-to-dismiss is blocked during a save (Item 4) | The window only exists while photographs are uploading. | A phone on a throttled connection, a multi-photo entry, swipe during the progress indicator. |
| Whether EXIF survives `manipulateAsync` | I read the call and the inputs, not the bytes it emits. | `exiftool` on one re-encoded upload pulled from the bucket, or a one-off test that encodes a known-EXIF fixture and inspects the output. Until then the policy says unverified and claims nothing. |
| RLS and store/schema agreement on this branch | No local Postgres. I ran `./scripts/ci.sh --no-db --no-redis`, which the script itself labels a partial pass. | CI on the PR. It provisions `postgres:16` and refuses to skip the DB suites. |
| The reachable-Redis path | No local Redis. | Same — CI, or `docker run --rm -p 6379:6379 redis:7-alpine`. |
| That production is unaffected by any of this | Nothing here was run against production, by instruction. | The Render deploy plus the device checklist, in the order the PR body gives. |
| Whether L28 has already lost photographs in your testing | It would be invisible from the phone. | A query for entries whose `photos_json` holds a `file://` or otherwise unmanaged uri. Read-only. Yours to run; I did not query production. |

What I **did** verify: 176 tests, 0 failures, 13 pinned skips; typecheck and lint clean on
every commit; the drift check passing at 2,508 and 1,308 words and failing in all three
ways it should.

---

## Part 7 — The honest state of the product

The capture path works, the tenancy model is enforced by the database rather than by
convention, and after this branch the compliance posture is documented from the code rather
than imagined — which is a real change, because the previous legal text made at least
thirteen claims the code contradicted. But it is **further from usable on a real site in
December than I think you believe**, and the reason is not the eight items in Stage 1. It is
L28: an entry captured where there is no signal — which on a construction site is the normal
case, and the case this product exists for — reaches the server with no photographs, while
the phone goes on displaying them and drops the pending badge, so nothing tells you. Behind
that sit three things that make it worse rather than independent: a queued write the server
rejects is deleted without a trace (L30), there is no crash or error visibility from the
field at all because the Sentry DSN is in the wrong file (L31), and AsyncStorage keeps the
base64 for every photograph forever (L6), so the device fills up over a six-month job. Taken
together, the failure mode for December is not a crash — it is discovering in February that
some weeks of site evidence are thinner than the diary says they are, with no logs to
reconstruct what happened. That is the opposite of what a compliance-evidence product is
for, and it is why my ordering below differs from yours.

---

## Part 8 — What comes next, in my order

Your backlog, reordered, with the one disagreement stated plainly.

**You are underrating offline sync.** You had it ninth. It is first, and it is not a
feature — it is a data-loss defect (L28) wearing a feature's name. Everything else on the
list improves a product that is reliably recording evidence. This one decides whether it is.

1. **L28 — photographs captured offline must reach the server.** The drain loop needs to
   upload before it POSTs, and the queued op needs to carry something that survives an app
   restart. Its own branch, with a test that queues an entry offline, drains it, and
   asserts the server-side record has a managed storage key — which fails today.
2. **L30 — stop deleting queued work on a 4xx.** Small, and it stops the fix above from
   hiding its own failures. Do it in the same branch.
3. **L31 — move the Sentry DSN into the mobile `.env`.** Minutes, and nothing above this
   line is observable without it. Decide `attachScreenshot` at the same time; my
   suggestion is off until L28 is fixed, because a screenshot of an entry whose
   photographs did not upload is exactly the report you would want, and also a site
   photograph leaving the country through a third path.
4. **Photo metadata at the shutter.** You had this sixth. It rises because L32 showed the
   data is already being captured and persisted — so this is mostly about doing
   deliberately, and disclosing, what the app already does by accident.
5. **L6 — cap AsyncStorage payload retention.** A six-month job on a low-end Android is a
   device-filling bug, and it bites in month three, not week one.
6. **Evidence-integrity surface.** Promoted from near-last. This is the product's actual
   claim, and the three findings above are all failures of it. Doing it earlier would have
   caught L28.
7. **Onboarding to a first report.** The shortest path from "installed" to "this is
   useful", and the thing that makes the rest worth having.
8. **AI narrative report.** The headline feature, now that `store: false` means running it
   does not leave site content with OpenAI.
9. **Mobile dashboard parity**, then **dashboard deploy prep**, then **client share
   links** — in that order, because share links are the first thing that puts data in
   front of someone outside the company, and that should happen after the legal review
   below, not before.
10. **Responsive audit**, **branding and NZ templates**.
11. **S3 object deletion (L33).** Deliberately low: it is a real gap, but it is a promise
    problem that the new policy has already made honest, and the photographs it would
    delete are the evidence the product exists to retain. Build it when someone asks to be
    deleted, and build it as part of a retention decision rather than a delete button.
12. **`eslint-plugin-react-hooks`.** Install it on a branch that does nothing else, so the
    repo-wide noise is one reviewable commit.

**Not on your list, and it has a date rather than a position:** the legal review. The
trigger in `docs/legal/README.md` is **before the first paying customer, or before any crew
member who is not you has data in the system, whichever comes first.** The second half of
that lands the moment you put a real crew on a real site — which, if December is the plan,
is sooner than the first half. These documents were drafted from a code audit by a tool,
not a lawyer, and they now say so in writing.

---

*Drafted from the code, not from the previous documents. Where this review and
`docs/STAGE-0-ANALYSIS.md` disagree, Part 4 says so explicitly rather than quietly
preferring one.*
