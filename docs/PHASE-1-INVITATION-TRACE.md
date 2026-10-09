# Phase 1.1 — The invitation journey, traced hop by hop

**Date:** 2026-10-09. **Branch:** `feat/crew-invitations`. **Base:** `b29a05e`.

The task was to walk the invitation journey with evidence rather than inference, name
the hop that fails, and only then fix. This is the report. Every claim below is either
a quoted line of code with a file reference, or the verbatim output of a probe driven
over real HTTP against the app booted by `createApp()`.

## How the evidence was obtained

A temporary probe file (`src/routes/__probe-invite.test.ts`, deleted before the first
commit — it is not part of this branch) booted the real Express app on an ephemeral
port and drove six scenarios with the suite's own `req()` helper and the two-stage
`devCodes` registration flow. The probes made no network calls and wrote to no real
provider; `src/test-setup.ts` blanks every credential outside its allowlist.

**One limitation, stated up front and load-bearing for everything below.** This
environment has no Postgres, no Docker/podman/colima, no `psql`, and no
`TEST_DATABASE_URL` (all six checked, not assumed). The probes therefore exercise the
**in-memory store only**. Production runs Postgres. Where the two paths diverge — and
they diverge at the single most important point in this trace — the Postgres half is
established by reading the SQL and is verified by a **DB-gated test that runs in CI,
not here**. Each such claim is labelled *(DB path — CI-verified, not run locally)*.

## The six hops

### Hop 1 — the invitation is created. **WORKS.**

Two distinct routes write to the same table:

| Route | Row written | `site_id` | Role granted |
|---|---|---|---|
| `POST /projects/sites/:siteId/invites` ([projects.ts:297](../Projects/services/api/src/routes/projects.ts#L297)) | `site_invites` | the site | `company_role` from the request, ceiling-checked |
| `POST /company/members/invite` ([company.ts:81](../Projects/services/api/src/routes/company.ts#L81)) | `site_invites` | `NULL` | `company_role`, owner-only route |

Token is 64 hex characters from `generateInviteToken()`; expiry is
`Date.now() + 7 days` ([projectsStore.ts:1231](../Projects/services/api/src/storage/projectsStore.ts#L1231)).
Uniqueness is two partial indexes from migration 018 — `site_invites_site_email_partial`
on `(site_id, invited_email) WHERE site_id IS NOT NULL` and
`site_invites_company_email_partial` on `(company_id, invited_email) WHERE company_id
IS NOT NULL AND site_id IS NULL` — and both exactly match the `ON CONFLICT` arbiters
used against them.

PROBE A, verbatim:

```
PROBE A first  -> 201 {"results":[{"email":"builder@example.com","status":"sent"}]}
PROBE A second -> 201 {"results":[{"email":"builder@example.com","status":"resent"}]}
PROBE A list   -> 200 {"invites":[{ ... "invitedEmail":"builder@example.com", "token":"8ee1201a...", "expiresAt":"2026-10-16T07:42:06.675Z" }]}
```

### Hop 2 — the email is sent. **FAILS for company invitations.**

Site invitations send. The route looks the tokens up once and calls `sendSiteInvite`
for every result whose status is not `already_member`
([projects.ts:320-338](../Projects/services/api/src/routes/projects.ts#L320-L338)),
building the URL as `${process.env.INVITE_URL || "sitesnap://invite"}?token=${token}`
([notificationService.ts:296](../Projects/services/api/src/services/notificationService.ts#L296)).

**Company invitations send nothing.** `POST /company/members/invite` contains no call
to `sendSiteInvite` or to any other notification function. The token is returned in
the JSON response body and exists nowhere else. PROBE D, verbatim:

```
PROBE D company invite -> 201 {"results":[{"email":"cm@example.com","status":"sent","token":"651688c2..."}]}
PROBE D repeat         -> 201 {"results":[{"email":"cm@example.com","status":"sent","token":"c9bb7d45..."}]}
```

Note the status says `"sent"`. Nothing was sent. This is the route **both** of the
surfaces a person would actually use are wired to: the portal's Team page
([team/page.tsx:129](../Projects/apps/supervisor-web/app/team/page.tsx#L129)) and
mobile's `company-invite.tsx`, both via `inviteCompanyMembers`. So "I invite someone
from the web and they never get an email" is fully explained here, at hop 2, before
any question of links or routes arises.

### Hop 3 — the recipient opens the link. **DEAD END BY DESIGN.**

`INVITE_URL` points at `https://sitesnap.co.nz/invite`, served by
[`website/invite/index.html`](../website/invite/index.html). It is a static
instructions page: it reads `?token=`, sets a fallback button to
`sitesnap://invite?token=…`, then `history.replaceState`s the token out of the address
bar. It has no onward route to signup, and says so in its own copy — *"Sign in, or
create an account, using the same email address the invitation was sent to."* It tells
the reader what to do; it does not carry them there.

### Hop 4 — mobile. **FAILS, in three independent places.**

The deep link itself is fine: `+native-intent.tsx`'s `redirectSystemPath` matches
`invite` on either hostname or pathname and returns `/invite?token=…`. After that:

1. **Fresh install loses the link before any screen sees it.**
   [`_layout.tsx:275-277`](../Projects/apps/mobile/app/_layout.tsx#L275-L277) reads
   `ONBOARDING_COMPLETE_KEY` and, finding nothing, does
   `router.replace("/onboarding")`. That replaces the pending invite route.
   `onboarding.tsx` then sets the key and replaces to `/login`. The token is gone. A
   new crew member is by definition a fresh install.
2. **`invite.tsx` hands the token to a screen that ignores it.** For an
   unauthenticated caller it does
   `router.replace({ pathname: "/login", params: { next: "/invite?token=" + token } })`.
   **`login.tsx` never reads `next`.** The only `next`-shaped strings in the file are
   `// eslint-disable-next-line` and `returnKeyType="next"`; on success line 54 is an
   unconditional `router.replace("/(tabs)")`. It also sends the user to **login**, not
   signup — a new crew member has no account to log in to.
3. **Signup cannot carry an invitation even if it were reached.** `signup.tsx` posts
   `{ email, password, phone, fullName }` and **never `inviteToken`**; on success it
   does `router.replace("/login")`, dropping any context a second time.

### Hop 5 — web. **FAILS. There is no accept path at all.**

The portal's routes are `activity`, `dashboard`, `forgot-password`, `locations`,
`page`, `reports`, `reset-password`, `settings`, `sites`, `sites/[id]`, `team`. There
is **no `/invite` route and no `/signup` route.** The portal can send invitations and
cannot receive one.

### Hop 6 — the account is created and attached to the inviting organisation.

This is where the trace stops agreeing with every expectation, including mine.

**The server-side invited-signup path exists and is complete.**
[`auth.ts:423`](../Projects/services/api/src/routes/auth.ts#L423) reads
`inviteToken` from `POST /auth/register/verify`; when present it creates the user with
`companyId = ""` and `companyRole = "crew"`, creating **no** company, then calls
`acceptSiteInvite` to stamp company and role transactionally. PROBE E drove the whole
flow and it works end to end on the in-memory path — the invitee lands in the
**inviter's** company, with a real `site_members` row:

```
PROBE E inviter companyId -> {"user":{"email":"owner-e@example.com", ... "companyId":"company_0c000b95bfe1ed89faaa8db928a89827","companyRole":"owner"}}
PROBE E invitee  -> 201 {"email":"crew-e@example.com", ... "companyId":"company_0c000b95bfe1ed89faaa8db928a89827","companyRole":"crew"}
PROBE E members  -> 200 {"members":[{"siteId":"01a11fa2-...","memberEmail":"crew-e@example.com","role":"crew","invitedBy":"owner-e@example.com", ...}]}
```

Same company id on both lines. That is hop 6 working.

**`inviteToken` appears in zero files under `Projects/apps/`.** The feature was built
on the server and no client has ever sent it.

## Which hop fails first

- For a **company invitation** (the portal Team page, mobile `company-invite.tsx`):
  **hop 2.** No email is ever sent, so hops 3-6 are never reached.
- For a **site invitation** (mobile `site-invite.tsx`): hops 1-3 succeed, and the
  first failure is **hop 4** on mobile and **hop 5** on web.
- **Hop 6 is not the problem on the in-memory path and is the deepest problem on the
  Postgres one** — see L65 below.

## 1.2 — the four candidates, adjudicated

| # | Candidate | Verdict |
|---|---|---|
| 1 | The `/invite` page renders but has no route onward to signup | **CONFIRMED.** `website/invite/index.html` is static instructions. |
| 2 | The universal link opens the app and the app has no handler for the token | **WRONG AS STATED.** The handler exists (`+native-intent.tsx` maps the link, `invite.tsx` receives it). It *discards* the token for an unauthenticated user, and onboarding discards the route before that. Broken, not missing — which matters, because the fix is three small changes rather than a new screen. |
| 3 | The portal has no accept-invitation route at all | **CONFIRMED.** No `/invite`, no `/signup`. |
| 4 | L46's server half | **CONFIRMED AS A DEFECT, BUT IT IS NOT WHAT BREAKS THE JOURNEY YOU DESCRIBED.** See below. |

### Candidate 4, precisely

The casing defect is real and reproduces end to end. PROBE B invited
`Builder@Example.com`, registered `builder@example.com`, and accepted:

```
PROBE B invite -> 201 {"results":[{"email":"Builder@Example.com","status":"sent"}]}
PROBE B stored invitedEmail -> ["Builder@Example.com"]
PROBE B accept -> 403 {"error":"This invitation was sent to a different email address."}
```

But it cannot be the cause of *"I press Accept invitation and never reach signup"*,
because on that journey **no accept request is ever made** — the token is discarded in
the client at hop 4 or has no route at hop 5. The casing defect bites one hop deeper
than the reported symptom. It is in this phase because it would break the flow the
moment the client half starts working, not because it explains today's failure.

It is also **masked** on three of four send surfaces: mobile's two invite screens and
the portal's Team page all `.toLowerCase()` before sending, and the portal's does so
under a comment that names this exact finding and says *"Fixing the comparison
properly needs a backfill migration; normalising here stops new bad invitations being
created and costs nothing."* Exposed today: any direct API call, and any invitation
already in the database from before those three mitigations landed.

**Correction to the phase document.** The document calls this *"L36's server half"*.
L36 is the portal legal-document drift finding. The invitation casing finding is
**L46** — `docs/AUDIT.md:1143`. Nothing else about the item changes.

### "Both surfaces failing the same way is information. Say what it tells you."

It tells us the shared cause is **not on the server**, and that is the opposite of the
stated leading suspicion. The server's invited-signup path works end to end (PROBE E).
What the two surfaces actually share is that **neither client was ever built to carry
the token into signup**: `inviteToken` is implemented in the API, documented in a
comment, and referenced by no client file in the repository. The symptom is identical
because the missing piece is identical — the client half of hop 6 was never written.
The two surfaces then fail for *different* secondary reasons (mobile has a route that
throws the token away; web has no route), which is why fixing one proves nothing about
the other and both are in this phase.

## What the trace found that nobody asked for

### L65 — on Postgres, accepting an invitation has never attached anybody to a company. CRITICAL.

*(DB path — established by reading SQL; CI-verified by the new DB-gated test, not run locally.)*

[`projectsStore.ts`](../Projects/services/api/src/storage/projectsStore.ts), the
Postgres branch of `acceptSiteInvite`, stamps company membership with:

```sql
UPDATE auth_users
   SET company_id = $2, company_role = $3
 WHERE email = $1 AND (company_id IS NULL OR company_id = $2)
```

Both branches of that `WHERE` are dead in production:

- **`company_id IS NULL` cannot be true.** Migration
  `016_backfill_companies.sql:145-154` ends with an assertion that `RAISE EXCEPTION`s
  if any `auth_users` row still has a NULL `company_id`. After 016 no row is NULL, and
  the invited-signup path writes `companyId = ""` — an *empty string*, not NULL
  (`auth.ts:433`, and `createUser` passes the value straight into the INSERT at
  `authStore.ts:334`; the column is plain nullable `TEXT` from migration 015).
- **`company_id = $2` is a no-op** — it matches only a user already in the target
  company.

So the UPDATE matches **zero rows** for every case that matters: a brand-new invited
signup (`''`), and an existing solo-company user (`company_<hash>`). The function then
returns success, and the route issues a fresh auth token built from
`result.companyId` — the invite's company, not the user's — so the **token claims a
company the database row does not have.** The next login reverts to the stale company.

The guard also directly contradicts the intent stated two lines above it in the same
function, where the cross-company peek deliberately treats a solo company as "no real
company" that "can be overridden by an explicit company invite" — and then the UPDATE
refuses to override it. The in-memory path gets this right via
`applyCompanyMembership`, whose condition is
`if (!currentCompany || currentCompany !== invite.companyId)`. The two paths disagree,
and the one that runs in production is the wrong one.

This is why the one workaround that the code *ought* to permit also fails. Today a
person can in principle: ignore the link, sign up normally (becoming owner of a solo
company), log in, then tap the emailed link a second time — at which point
`invite.tsx` sees `isAuthenticated` and calls `acceptInvite`. That sequence succeeds
on the in-memory path. On Postgres the UPDATE matches nothing, so it fails too. There
is no working path to crew membership in production at all, by any route, including
the undiscoverable one.

### Smaller findings

- **The `xmax` read is broken, so every invitation reports `"resent"` in production.**
  `createSiteInvites` returns `RETURNING *, (xmax = 0) AS inserted` and then reads
  `rows[0].xmax`. `RETURNING *` does not expand system columns, so `rows[0].xmax` is
  `undefined`, `wasNew` is always `false`, and a brand-new invitation is reported as
  `"resent"`. The query computes the right answer under the alias `inserted` and the
  code reads the wrong field. In-memory is unaffected, which is why PROBE A shows the
  correct `sent`/`resent` pair and production does not.
- **`POST /projects/invites/accept` is unreachable for crew.**
  `projectsRouter.use(requireAuth, requireAtLeast("viewer"))`
  ([projects.ts:115](../Projects/services/api/src/routes/projects.ts#L115)) blocks rank
  0 from the **entire** router, and the accept route is on it. So the retry that
  `auth.ts`'s own comment promises — *"the account is created; the user simply lands
  with no company yet and can retry the invite"* — is impossible. PROBE F:

  ```
  PROBE F after signup -> 201 {"email":"crew.f@example.com", ... "companyId":"","companyRole":"crew"}
  PROBE F retry accept -> 403 {"error":"Insufficient permissions."}
  ```

  An orphaned crew account with no company cannot recover, and a crew member invited
  to a *second* site is refused by the same gate.
- **Expired invitations become invisible rather than recoverable.**
  `listSiteInvites` filters `expires_at > NOW()` on both paths, so an invitation that
  lapsed disappears from the sender's list entirely. To the sender that is
  indistinguishable from never having sent it.
- **`listSiteInvites` returns the raw `token`** to the caller. The route is
  manager-gated so this is not a privilege leak, but a bearer credential in a list
  response is a credential in logs and browser history.
- **`already_used` is in the `AcceptInviteResult` union and is never returned** by
  either path; the route maps it to 404 for nothing.
- **Mobile's signup country-code picker defaults to `+1`** (`signup.tsx:58`) in a
  New-Zealand-only product whose `PREFIX_OPTIONS` include `+64`.
- **`+native-intent.tsx` does not map `site-invite` or `company-invite`**, only
  `invite` and `reset-password`.

## 1.5 — `TEST_PHONE_NUMBERS`: already built, and the premise needs correcting

The phase asks whether the mechanism exists, is read, is set, and whether the
number given in the phase document bypasses verification today. Answers, in order:
**yes, yes, cannot be determined from here, and no — and it never will, because that
is not what it does.**

That number is deliberately not written anywhere in this repository, here included.
It is a real personal identifier, the repository is public, and the standing
instruction on it is that it never enters the repository — it lives in the Render
dashboard and nowhere else. Where a value is needed below it is described rather
than quoted.

[`utils/phoneNumbers.ts`](../Projects/services/api/src/utils/phoneNumbers.ts) is 120
lines with a rationale header. `parseTestPhoneNumbers` splits on commas, normalises,
dedupes, and drops anything normalising to `""` or `"+"` — explicitly so that a stray
comma cannot become a wildcard. `isTestPhoneNumber` re-reads
`process.env.TEST_PHONE_NUMBERS` on **every call**, so there is no boot-time snapshot
to go stale. `logTestPhoneNumbersAtBoot` prints a **count only**, never the numbers,
and is silent when the list is empty. It is wired in exactly one place that can create
a user (`auth.ts:451`) and once at boot (`server.ts:204`), and is covered from both
sides by `routes/test-phone-exemption.test.ts` and `utils/phoneNumbers.test.ts`.

**What it does not do: skip verification.** Both the email code and the SMS code are
checked and must match before line 451 is reached. The exemption works by storing
`NULL` in the `phone` column, which lifts the phone-uniqueness *partial index* only.
So a listed number does not bypass any verification step; it lets a **second account
exist on the same handset**, which is the actual blocker for testing an invitation
with one phone. The one consequence is that such a row cannot be looked up by phone.

Guards: an explicit comma-separated list with no wildcard; the empty value is the
safe default and logs nothing; the variable is deliberately **absent** from
`test-setup.ts`'s allowlist, so the test suite cannot inherit it from a `.env`; and
nothing is compiled into the binary, so there is no code path to enable accidentally.

**What to set, exactly.** In the Render dashboard, on the **API service**
(`sitesnap-ai`), under **Environment → Environment Variables**, add:

- **Key:** `TEST_PHONE_NUMBERS`
- **Value:** your mobile in full international form — `+64`, then your number with
  its leading `0` removed. Nine digits after the `+64`. No spaces, no brackets.

Then redeploy — the variable is read at request time, but Render requires a restart
for a new variable to enter the process environment.

**The leading `+` is significant**, and the value has to match what the app actually
sends, character for character after normalisation. `utils/phoneNumbers.ts` keeps a
leading `+` and then digits only, and `phoneNumbers.test.ts:79` asserts that
`isTestPhoneNumber("+64211234567")` is **false** when the list holds the same digits
without the `+`. A mismatch is silent: the exemption simply never fires, and the
symptom is the uniqueness error it was set to avoid.

**This changed in this phase.** Mobile used to build the number as
`` `${phonePrefix}${normalizeLocalPhone(phoneLocal)}` ``, where the local part had
its non-digits stripped and a leading zero **kept** — so choosing `+64` and typing a
number in the usual local form produced a 10-digit national number welded onto the
country code, which is not a valid E.164 number at all. Twilio rejects it and
`routes/auth.ts` returns 502, so the SMS never arrived. That is now fixed:
`lib/phone.ts` → `composeE164` drops the single trunk `0`, and
`lib/phone.test.ts` pins it for every dialling code the picker offers.

So set the value to the **correct** international form, as described above. Earlier
advice in this document to "set both forms, comma-separated" is superseded: with the
fix in place the app sends one form, and listing a malformed variant achieves
nothing. Note the ordering consequence — the app must be on a build carrying this fix
(`eas update`) for the number it sends to match.

Confirm by the boot log line reporting a count of 1 — that line is the only signal,
and I have no Render log access to read it, so **whether the variable is set today is
the one question in 1.5 I cannot answer.**
