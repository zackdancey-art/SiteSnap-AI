# Rollout defects review — three live defects from the Phase 1 rollout

**Branch:** `fix/rollout-defects`. **Base:** `f9e47c2` (`origin/main`, PR #61 merged).
**4 commits.** **Date:** 2026-10-10.

Three defects were reported from a phone running the Phase 1 OTA. They share a shape,
and the shape turned out to be the finding: **in each case the app did something wrong
and told the person something that was not what had happened.** Two of the three are
one cause. The third is not a bug at all, and establishing that took the same work.

---

## 1. What was fixed, and how

### Item 1 — the deploy invalidated every session, and the app blamed the features

**Why the old token was rejected — with evidence.**

Phase 1 did not change the token. `git log f9e47c2 --oneline -- src/utils/authToken.ts
src/middleware/auth.ts` over the Phase 1 range returns **nothing**: neither the mint
nor the verify side was touched, so the payload shape, the claim set and the HMAC are
identical either side of the deploy. `verifyAuthToken` already carried explicit
backward compatibility for pre-company tokens — a token without `companyId` verifies
and resolves the company from the user record — so the L65 company-attachment fix did
not invalidate anything either; that was the case it was written for.

That leaves two candidates, and the deployment environment eliminates a third. An
**absent** `AUTH_TOKEN_SECRET` cannot be the cause: `getTokenSecret()` throws when it
is missing and `NODE_ENV=production`, and `Dockerfile:35` sets `NODE_ENV=production`
(added by `721f16f`, not by Phase 1), so an absent secret presents as a **per-request
500**, not a 401. Every failure the owner saw was a 401 — Sentry caught one as exactly
that. So the secret was present, and the token was rejected either because its `exp`
had elapsed or because the secret's **value** changed.

**Which of the two, only the owner can say** — a value change means an edit in the
Render dashboard, and the dashboard's history is not visible from here. It is recorded
as an open question rather than guessed at, because the owner asked whether it
recurs, and the two answers differ: a one-off dashboard edit does not recur, and an
elapsed `exp` recurs **weekly**.

**And the weekly case is live regardless.** Measured against the running API rather
than read off a default: the TTL resolves to **604800 seconds, exactly 7.0 days**,
`utils/authToken.ts` reads it **once at module load**, and nothing extends an existing
token's `exp` on use. So whichever cause produced this particular incident, every user
of this app meets the same wall every seven days, and until this branch the app's
answer was *"Failed to save timecard."* (AUDIT **L76**.)

**Why it reached the feature call site.** `data-context`'s `apiJson` responds to a 401
by calling `/auth/refresh` — which is mounted behind `requireAuth`, the middleware
that just rejected the token. An expired token cannot refresh. The refresh answers 401
too, and the original error falls through to whatever the feature does with a rejected
promise. **The recovery path is reachable only when it is not needed.** (AUDIT
**L74**.)

**The fix: one sentence, said once, centrally.** `lib/session.ts` holds the decision —
it classifies a thrown error as a dead session only on a 401 whose server `code` says
so, notifies a single listener, and the listener routes to sign-in with *"Your session
has expired. Please sign in again."* A feature's own catch block no longer substitutes
its own explanation for a session failure. **All fourteen token-attaching call sites
are covered, and they are enumerated one by one in the PR body** rather than
summarised, because the owner asked to see the coverage instead of trusting it.

**The API's rejection is now distinguishable.** It previously answered every rejection
with `401 {"error":"Unauthorized"}` — a dead session, a malformed header and a
request-body problem were the same response. It now carries a `code`:
`session_expired`, `token_invalid`, `token_missing`. The *message* is unchanged and
deliberately uninformative: the code says which **class** of refusal it is, never
which **part** of the token failed, so it tells a legitimate client what to do without
telling anyone anything that narrows a guess at a valid token. Proved both ways in
`auth-401-codes-db.test.ts`, against Postgres, on the same route in the same test.

**Could the deploy have accepted old tokens through a transition? Reported, not
built.** Yes, and it is cheap: accept a second secret for a window
(`AUTH_TOKEN_SECRET_PREVIOUS`), verify against both, mint only with the current one.
That is the standard shape and it would have made a secret rotation invisible. It is
**not in this branch** — the owner asked to be told rather than handed a migration
path, and it is also the wrong instrument for the more likely cause: it does nothing
for an elapsed `exp`, which is L76's problem and needs a TTL or refresh decision
instead.

**The 21 photographs: the premise is wrong, and nothing was lost.** The Sentry event
came from `batchSignPaths` via `lib/media-telemetry.ts`. Its caller collects only
paths that `toCanonicalPath(photo.uri)` resolves to `/api/uploads/…` — i.e. media that
is **already stored on the server** and is being signed so it can be *displayed*,
batched fifty at a time. They were never in an upload queue. Nothing was dead-lettered
and nothing was destroyed: 21 saved photographs rendered as unavailable tiles for as
long as the session was dead, and signing retries on every load, which is why signing
in again restored them with no action taken.

The genuine dead-letter path is separate — `uploadPhotoOnce` → `lib/offline-queue.ts`,
`markOpFailed` at `:115`, `retryFailedOps` at `:146` — and the answer to *"how do I
retry"* is **Settings → Offline sync → Retry failed**
(`app/settings/offline-sync.tsx:45-51`). It was not engaged by this incident.

### Item 2 — the signature Save button did nothing

**Which of the four candidates: candidate 4, silent validation.** It failed silently
twice, in sequence:

1. The `Pressable` was `disabled` whenever the signer name or the drawn path was
   empty. **A disabled `Pressable` runs no `onPress`** — the tap was not refused, it
   was not received.
2. `handleSaveSignature` opened with `if (!showActive || !sigName.trim() || !sigPath)
   return;` — a bare early return behind the same condition, so a tap that did arrive
   still produced nothing.

**Candidates 2 and 3 are excluded by the same observation.** Both the handler's own
`catch` and the screen's fetch helper terminate in `Alert.alert("Error", "Failed to
save signature.")`, and the helper throws on every non-2xx — so a handler that threw,
or a server that refused with any status including a 401, **would have shown an
alert**. None appeared. Whatever happened did not reach the `try`.

**Which input was missing is not in doubt either.** `SignaturePad.appendPoint` calls
`onChange` through `runOnJS` from `Gesture.Pan().minDistance(0).onBegin(...)`, so
`sigPath` is non-empty from the first touch; `sigSaving` is false at rest. Only an
empty `sigName` could still have been disabling Save — and that is a placeholder-only
field at the top of the scrollable region, **above** the canvas, with no label and no
required marker, on the sheet that already produced L27.

**Candidate 1 — geometry — is not excluded, and could not be.** Re-measuring it needs
the renderer, which needs a yoga package this environment does not have and which
CLAUDE.md §8 forbids adding. The instrument already exists:
`lib/dev-signature-probe.tsx`, whose assertions 4 and 5 are literally *covered* and
*off-screen*. It needs a device. It is in the device checklist and stated unverified.

**The fix.** The refusal decision moved out of the component into
`lib/signature-input.ts`, which returns a sentence for **every** incomplete state and
`null` only for a complete one — and is tested to never return an empty string,
because `""` and `null` are the same falsy value at a call site and that collapse is
exactly how a validation failure becomes a silence. The control is `disabled` only
while a save is in flight, where the spinner already explains itself; it still dims
for incomplete input, so it reads as not-ready, but **a tap now always answers.** The
field has a label and a required marker, and a save that fails reports the server's
own words. (AUDIT **L77**.)

### Item 3 — "invite was sent to another email address"

**Explanation (a): correct behaviour, badly worded.** Driven live against the API, not
inferred:

Both addresses are the owner's own, and both are **withheld from this record** —
this repository is public and they are real personal identifiers, the same reason the
owner's phone number is kept out of it. They are written here as `INVITED` and
`SIGNED-IN`; the owner holds both and can confirm the pairing.

| question | answer | how |
|---|---|---|
| what address the invitation record holds | `INVITED` | `GET /api/company/invites` |
| what the request is authenticated as | `SIGNED-IN` | `GET /api/auth/me` |
| what the endpoint compared | `sameEmail(invite.invited_email, actorEmail)`, both sides `trim().toLowerCase()` | `projectsStore.ts:1673` |
| what it returned | `403 {"error":"This invitation was sent to a different email address."}` | `routes/projects.ts:451` |

**The one fact that settles it:** `INVITED` and `SIGNED-IN` differ in the **mailbox
name** — different letters and four extra digits — **not in case**. Lower-casing both
sides maps them to two different strings, as it should.

**The casing bug is therefore ruled out twice over:** the comparison already
normalises both sides, and there was no casing difference to normalise in the first
place. Migration 031 did its job and L36's read half was never missing on this path.

Controls captured on the same route in the same session: a nonexistent token →
`404 {"error":"Invite not found or has expired."}`; no bearer →
`401 {"error":"Missing bearer token."}`.

**What I could not do, stated rather than papered over:** I could not replay the
owner's exact accept request, because `GET /api/company/invites` withholds the token
by design — the listing returns `companyRole, createdAt, expiresAt, id, invitedBy,
invitedEmail, state` and no token field. The evidence above is the record, the
identity and the comparison, driven live; the request itself is reconstructed from
them.

**So the refusal was right and the sentence was wrong**, and it was wrong in the way
that matters: it was reported as a bug by the person who owns the system, which is the
measure of how badly it read. It named neither address, so it could not be checked,
and it did not say that the fix is to sign out. It now says:

> This invitation is for `INVITED`. You're signed in as `SIGNED-IN` — sign out, then
> open the invitation link again to accept it.

(with the two real addresses substituted at runtime, not the placeholders)

with `code: "invite_wrong_user"` and both addresses as fields, and the error screen
offers **Sign out and accept**. Signing out re-runs the screen's effect, which finds
no session and forwards the still-attached token to `/signup` — so the person lands
where the invitation was always meant to take them without having to find the link
again.

**The disclosure is deliberate and stated.** Returning the invited address tells
whoever holds the link which mailbox it was sent to. The refusal is reachable only by
an **authenticated** caller presenting a valid, unexpired invitation token, so it is
not an anonymous address oracle — but it is a disclosure, and the trade is that the
alternative is the sentence that was just reported as a defect. It is recorded at the
type definition rather than left for someone to discover.

**The third place the owner predicted is real.** A sweep of every email equality in
the API found `routes/company.ts:193/218/222` — `PATCH /company/members/:email/role`
and `DELETE /company/members/:email` — taking `req.params.email` **raw** and comparing
it with `===`. Everything else compares stored-to-stored values, and
`projectsStore.ts:1258`/`:1380` were already normalised. It fails **closed** today (a
404), so it is usability rather than authorisation — but the obvious half-fix is a
hole: making the member lookup case-insensitive **without** folding the self-removal
guard in the same change would let an owner of a company with two or more owners pass
their own address in a different case, fail the self-check, be found by the lookup,
pass `ownerCount <= 1`, and remove themselves. Both halves are in the one commit.
(AUDIT **L78**.)

---

## 2. The shared cause — the finding that is bigger than any of the three

The owner asked whether there is a shared cause. There is, and it is not a helper that
swallows errors.

**Seven screens had each written their own authenticated `fetch` helper.** They agreed
on every mechanical part — base URL, `Content-Type`, the `Authorization` header, JSON
parsing — and disagreed on the only part that mattered. Six turned a 401 into a
feature-level error string. The seventh, `app/site/[id].tsx`'s progress PATCH, never
looked at `res.ok` at all, so a refused write left the optimistic value on screen and
said nothing. **Of fourteen call sites that attach a bearer token, exactly one had any
401 handling.**

That is item 1. Item 3's rendering half is **the same habit at the other end of the
wire**: `doFetch` threw `new Error(payload.error)` and discarded the status, the code
and the body, so `app/invite.tsx` had nothing to branch on but the server's prose —
and branched on tokens the server does not send (`"not_found"`, `"wrong_user"`,
`"403"`). The first branch could never fire. The second caught **every** 404 through
the word "expired" inside the one sentence the route answers for not-found, expired
and already-used alike, so an invitation that never existed was reported as one that
had run out. The third — the only refusal a person can act on — could not be
recognised at all.

Item 2 is the same assumption in its purest form: a failure that is not displayed is
not a failure.

The habit is written down in the code in one place, which is how to recognise it
elsewhere. `app/incidents/[siteId].tsx:235`:

```
// silent — common in dev when auth is fresh
```

A 401 was understood as background noise. (AUDIT **L73**.)

**What is deliberately not solved.** The seven helpers are now two, not one.
Consolidating `data-context`'s `doFetch` with `lib/authed-fetch.ts` means moving the
offline queue and the token refresh under one roof — a larger change than a defect fix
should carry, and one that would have made this branch unreviewable. Two helpers that
agree is the holding position. Two that drift is this finding coming back.

---

## 3. What I found that nobody asked for

- **`POST /auth/revoke-all` mints a new token and invalidates nothing.** Tokens are
  stateless HMACs with no registry and no version claim, so every token issued before
  the call keeps working until its own `exp` — seven days. The route is named for the
  remedy after a lost phone and does not perform it. (AUDIT **L75**.)
- **`/auth/refresh` behind `requireAuth`** makes the client's whole 401 recovery path
  structurally dead. (AUDIT **L74**.)
- **A 7-day non-sliding TTL read once at module load** means item 1's symptom is
  weekly for every user, independent of what caused this particular incident. (AUDIT
  **L76**.)
- **Three of the API's 401s are about the request, not the session** — a malformed
  `Authorization` header, a missing one, a structurally invalid token — and before
  this branch they were indistinguishable at the client from a dead session. A client
  that signs the user out on all of them is wrong in a different direction.
- **`app/site/[id].tsx` discarded its `Response` entirely.** A refused progress PATCH
  left the new value on screen. It now throws, and the caller reports it and rolls the
  optimistic value back.
- **`app/invite.tsx` branched on prose for tokens the server never sends**, and its
  only reachable branch reported an unknown invitation as expired.
- **`doFetch` discarded status, code and body** on every error, which is what left
  that screen with nothing but prose to read.
- **`routes/company.ts`'s unnormalised member-route params** — latent, fails closed,
  fixed here with the guard it would otherwise have opened. (AUDIT **L78**.)
- **CLAUDE.md §5 is stale** on the API test counters: it documents
  `EXPECTED_DB_SUITES=6` and 13 in-memory skips. The current, asserted values are
  **9** and **16** (this branch moves the first from 8 to 9). Not corrected here —
  CLAUDE.md is not in this branch's scope and a doc edit in a defect branch is how
  scope grows.

---

## 4. What was not done, and why

- **No transition window for old tokens.** Reported above, not built — the owner asked
  to be told first, and it is the wrong instrument for the likelier cause.
- **No `tokenVersion` claim**, which is what would make L75's `/auth/revoke-all` real.
  That is a migration and a claims change. A migration is a stop condition.
- **No TTL or refresh change for L76.** Both are decisions about how long a stolen
  token stays useful. Owner's call.
- **The two request helpers were not merged into one.** See §2.
- **`docs/PHASE-1-INVITATION-TRACE.md:172` still records the old 403 sentence
  verbatim.** It is a dated trace of what the system did on that date; rewriting it
  would destroy the record. Left as-is deliberately.
- **No migration, no native config change, no new hex, no dependency added.** The
  branch is JS and TS only.

---

## 5. New AUDIT entries

| ID | Severity | What |
|---|---|---|
| **L31** | — | **Correction.** The mobile Sentry DSN is live; `SITESNAP-MOBILE-1` has received its first event. The heading, the length-0 table row and the "DSN half remains owner action" disposition are superseded. Includes the correction that the 21 photographs were a display-signing batch, not an upload queue. |
| **L73** | HIGH | Seven screens each wrote their own authenticated `fetch`; the error channel between API and person was prose. The shared cause behind items 1 and 3. **Closed.** |
| **L74** | MEDIUM | `/auth/refresh` sits behind `requireAuth`, so the 401 recovery path cannot run in the one case it exists for. **Open.** |
| **L75** | MEDIUM | `/auth/revoke-all` mints a new token and invalidates nothing. **Open.** |
| **L76** | MEDIUM | 7-day non-sliding TTL, read once at module load — item 1's symptom is weekly. **Partly addressed.** |
| **L77** | HIGH | The signature Save control answered nothing, twice over. **Closed**, except candidate 1. |
| **L78** | LOW | `routes/company.ts` compared a request-supplied email with `===` — the third place. **Closed.** |

---

## 6. What cannot be verified without you

1. **Whether `AUTH_TOKEN_SECRET`'s value changed in the Render dashboard around the
   Phase 1 deploy.** This is the one open half of item 1's cause, and it decides
   whether the incident recurs. If it did change, this was a one-off. If it did not,
   the tokens simply reached day seven and L76 is the whole story — in which case it
   happens again next week.
2. **Everything visual.** Mobile cannot be screenshotted here; that was costed and
   declined. The sign-in routing, the session-expired sentence, the signature field's
   new label and required marker, the Save control answering a tap, and the
   two-address refusal with its **Sign out and accept** button are all **unverified**
   and are in the device checklist in the PR body. Step zero of that checklist is
   confirming **Settings → About** names the bundle under test — results from a stale
   binary are not results.
3. **Candidate 1 of item 2** — whether the Save control is also covered, off-screen or
   behind an overlay. `lib/dev-signature-probe.tsx` is the instrument and it needs a
   device.
4. **The two DB-gated suites.** `auth-401-codes-db.test.ts` and
   `invite-accept-identity-db.test.ts` are written, registered, and counted by the
   harness — `EXPECTED_DB_SUITES` is now 9 — but **were not executed here**, because
   this environment has no Postgres, no Docker and no `TEST_DATABASE_URL`. They will
   run in CI on the pull request, which is the first real evidence about them. L65
   proved an in-memory green suite can sit on top of broken production, so this is
   stated plainly rather than folded into "tests pass".
5. **Whether the invitation that triggered item 3 is still usable.** The refusal
   rolls back, and test 2 of `invite-accept-identity-db.test.ts` proves the same token
   accepts afterwards — but against a test database. The real invitation to the
   `INVITED` address should still work, and the way to prove it is to open the link on
   a phone signed in as that account.

---

## 7. Verification actually run

| check | result |
|---|---|
| `pnpm -C Projects run typecheck` | clean, all three packages |
| `pnpm -C Projects run lint` | clean, `--max-warnings=0` |
| `pnpm -C Projects --filter apps-mobile run test` | **94 pass, 0 fail, 0 skipped**; harness counters (13 files / 94 tests) matched |
| `pnpm -C Projects --filter services-api run test` | **tests 200, pass 184, fail 0, skipped 16**; "16 skip(s), as expected" |
| `test:db` | **not run** — no Postgres in this environment. See §6.4. |
| secret scan over the staged diff | no matches for `sk-`, `AKIA`, `ingest.sentry.io`, `https://<hex>@`, `postgres://`, `re_`, `AC<hex>`, either of the owner's addresses, a `+64` number, or the production password |
| pre-commit hook | passed on all four commits |
