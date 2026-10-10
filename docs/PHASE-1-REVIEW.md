# Phase 1 review — crew invitations

**Branch:** `feat/crew-invitations-clean`. **Base:** `b29a05e`. **24 commits.**
**Date:** 2026-10-09 to 2026-10-10.

---

## 1. What was fixed, and how

### The thing you asked for: re-inviting an address

**The server never failed.** `createCompanyInvite` upserts through the partial unique
index with `ON CONFLICT … DO UPDATE`, overwriting `token` and `expires_at`. Driven
live against the running API: first POST `"sent"`, second POST to the same address
`"resent"`, one row in `GET /company/invites` both times, and the row **id changed**
between the two reads. That is an upsert reissuing a token, not a failure.

**Both clients misreported it, in opposite directions.** Mobile typed the result
`"sent" | "error"` and painted everything that was not `"sent"` red as "Failed to
send" — so a successful re-send looked exactly like the symptom you reported. The
portal did the reverse: a green tick on all four outcomes, the raw enum printed at
the reader (`✓ alice@example.com — already_member`), and `delivered` missing from the
type entirely, so an invitation whose email never left the building read as sent.

Both now derive glyph, colour and a full sentence from the whole result. Four
outcomes, four sentences. (`9a065ed`, `71cec94`, `411f4c0` — AUDIT **L67**, **L68**.)

### The thing that mattered more: nobody could get in at all

Tracing hop by hop before touching anything was the right instruction and it paid for
itself immediately. The hop that failed first for a company invitation was **hop 2**:
the route created the invitation and **never sent the email**. Fixing re-invitation
would have proved nothing while that was true.

Then, deeper: **`acceptSiteInvite` has never attached anybody to a company on
Postgres.** The `UPDATE auth_users` carried a guard whose both branches were dead. The
in-memory path — dev, tests, every probe — was always correct. So this worked
everywhere except production, which is the worst shape a bug can have, and it is the
reason no crew account has ever existed. (`8e729ef` — AUDIT **L65**, CRITICAL.)

Also closed: web had **no accept path at all** (no `/invite`, no `/signup` on the
portal, no landing page on the website); mobile dropped the invite token in three
separate places between the deep link and signup; the mobile signup composed an
invalid E.164 number by keeping the trunk `0`, so Twilio rejected it and the
verification SMS never arrived; invitation emails were matched case-sensitively
against addresses stored with whatever casing the sender typed.

### Item by item

| | Item | Result |
|---|---|---|
| 1.1 | Trace six hops, name the one that fails | **Done.** Hop 2 for company invitations; hop 4/5 for site invitations; hop 6 broken on Postgres only |
| 1.2 | Four candidates, none assumed | **Done.** Adjudicated in the trace document |
| 1.3 | Normalise on write **and** read, and backfill | **Done.** Migration 031. **Not smoke-tested against Postgres** — see §4 |
| 1.4 | Re-invitation re-sends; already-a-user is a different case; sender sees what they sent | **Done.** Reissue, not reuse — recommendation in §5 |
| 1.5 | `TEST_PHONE_NUMBERS` state, and what to set in Render | **Done**, with a correction to the premise — see §3 |
| 1.6 | The acceptance checklist | **Done.** `docs/PHASE-1-ACCEPTANCE-CHECKLIST.md` |

---

## 2. What I found that nobody asked for

**L65** — the Postgres acceptance bug above. CRITICAL. Found by reading the SQL after
the in-memory probe passed, not by the probe.

**L66** — `projects.ts` mounts seven routers behind a pathless
`requireAtLeast("viewer")`. Crew is rank 0. That is **31 routes** a crew member is
403'd out of. Measured: crew 403 on 9 of 9 reachable GETs, owner 200 on the same 9 of
9. **This blocks December** and the fix is your decision, not mine — see §5.

**L70** — migration **031, which I wrote this phase, would have aborted API boot** on
any database holding two casings of one invited address. 018's unique indexes are on
the raw column, so both casings can exist today; lower-casing them collides. And
migrations run at boot, so the symptom is a service that will not start, on exactly
the databases the migration exists to repair. Caught by reading 018 while writing
031's test. Fixed before it ran anywhere (`aaba972`).

**L69** — `GET /company/invites` was built, gated, returned the right shape, withheld
the token, and had **no caller**. Now it has one.

**L71** — the dev file-backed store does not persist companies, so a restarted dev API
404s `/company/profile` for an account that still logs in. Dev only. It cost a
verification run before I found it, and it will cost you one too.

Smaller findings recorded but **not fixed**, in the trace document: `listSiteInvites`
returns the raw bearer token to its caller and hides expired rows; `already_used` is
in the result union and never returned; `status: "error"` at `company.ts:112` is
unreachable; mobile signup defaults to `+1` in a New-Zealand-only product;
`+native-intent.tsx` maps neither `site-invite` nor `company-invite`; `listSites`
pagination can make an invitation email fall back to a raw site id; `forgot-password`
offers 5 dialling codes where signup offers 10; the portal login's "Owner and manager
accounts only" is copy, not enforcement.

---

## 3. What turned out to be wrong in the phase document

**"Both surfaces failing the same way is information. Say what it tells you."** They
did not fail the same way — they failed in **opposite** directions, and that is the
more useful fact. Mobile called successes failures; the portal called failures
successes. A shared failure would have pointed at the API. Two mismatches that do not
resemble each other point at two clients each written against a *guess* at the route's
return shape rather than against the route. That is a contract problem, and it is why
the fix in both places was to make the type name all four outcomes rather than to
change any behaviour.

**1.4's "establish why it fails rather than assuming a uniqueness constraint"** was
the right warning and the answer is further out than the warning implies: it is not a
uniqueness constraint, and it is not the server at all. Worth stating because the
constraint is load-bearing — "fixing" it would have broken the upsert that makes
re-invitation and expiry-renewal work.

**1.5 asks whether the listed number bypasses verification.** It does not, and it
never will, because that is not what the mechanism does. Both codes are still checked.
The exemption stores `NULL` in `phone`, which lifts the phone-uniqueness partial index
only — it lets a **second account exist on one handset**, which is the actual blocker.

**Hop 3 is not really a hop.** It is a redirect target; it has no independent failure
mode of its own.

---

## 4. What was not done, and why

**Migration 031 was not smoke-tested against a seeded Neon database.** The convention
requires it. This environment has no Postgres, no Docker, no `psql`, no
`TEST_DATABASE_URL` and no `DATABASE_URL` — all checked, not assumed — and the standing
instruction is that nothing I run locally may reach production, which rules out
pointing it at anything real. So 031 is covered by a **DB-gated test that has never
executed anywhere** and runs for the first time in CI. **This is the single largest
unverified thing in the phase**, it is a migration, and migrations run at boot. If CI
is red, read `invite-roundtrip.test.ts` before anything else.

**The migration itself was expected, not a stop condition.** Item 1.3 requires a
backfill in terms; 031 is that backfill. Number verified unused against the directory
at the time of writing, additive, idempotent.

**L66 is deliberately unfixed.** I fixed exactly one route — the accept route — because
an invitee who cannot reach it cannot be in the company at all, and that is this
phase. The other 30 are a permission-model decision.

**No native config was touched**, so Phase 5 is not reordered.

**Nothing on the phone was verified.** Mobile cannot be screenshotted; that was costed
and declined in an earlier phase. Four mobile invite states, the deep-link handoff and
the trunk-zero fix are code-reviewed only, and are listed as unverified in the
checklist rather than described as working.

**`delivered: true` cannot be produced locally.** `notificationService.sendEmail()`
returns `ok: false` in test mode by construction, and there is no mail provider in
dev. To photograph the delivered states I stubbed the **provider** — in gitignored
`dist/`, narrowed to the company-invitation subject, never in source, never committed,
then removed by a clean rebuild which I verified by grep (`local-screenshot-stub`
count 0, `test-fake` count 2). Stated plainly because this is adjacent to the L55
near-miss where a harness silently disabled the thing under test: here the things
under test are the portal renderer and the API route, and neither was touched. The
undelivered states in `C1`/`C2`/`C3` were then taken against the **unstubbed** API.

---

## 5. What needs your decision

**1. The crew permission model (L66).** Either crew gets a scoped subset of those 31
routes, or crew is not the right rank for a field user. This blocks step 9 of the
acceptance checklist, which is what a crew member does all day.

**2. Reuse or reissue the invitation token.** The code reissues, on both store paths,
and both surfaces now say so: *"any earlier link for this address has stopped
working."* **My recommendation is to keep it.** A link in an inbox is a bearer
credential with a seven-day life; re-inviting is the one moment the sender has
signalled something was wrong with the first attempt, and silently extending the old
token's life is the worse failure. The cost is real and is why this is yours: an
invitee who opens the *first* email gets a dead link. Both surfaces warn the sender at
the moment they re-invite, which is the only point anyone can act on it.

**3. `TEST_PHONE_NUMBERS` in Render.** Whether it is set today is the one question in
1.5 I cannot answer — I have no Render access. Exact instructions are in the checklist.

**4. Two smaller ones:** whether to unify the 5-code and 10-code dialling lists, and
whether the portal login should enforce its "Owner and manager accounts only." copy.

---

## 6. Could any check I wrote pass while the thing it checks is broken?

Four vacuous checks have been caught in this project, three of them mine. A fifth was
caught **in this phase, by its own positive control**, so the assumption held.

**The one that was vacuous.** I ran the host-allowlist and raw-enum assertions as a
*separate* CDP journey. A new journey opens a fresh `about:blank` target, so
`hosts: []`, `raw enums: 0` and `absent_other_states: true` all came back green
against an empty page. The control `positive_control_matcher_works` returned **false**
and exposed it. Fixed by appending those assertions to the end of the same journey;
the re-run gave `hosts: ["localhost:3001","localhost:4000"]` and
`control_matcher_live: true`. **Without the control I would have reported three green
checks that looked at nothing.**

**The one I then strengthened rather than defended.** "No invitation token reaches the
browser" was `page_hits === 0` with a general liveness control — enough to prove the
page was populated, not enough to prove the *hex* matcher worked. So I made the API
hand back a real token in the same page context and ran the matcher against it:

```
{"api_returned_a_token":true,"api_token_len":64,"matcher_finds_the_real_token":true,
 "page_hits":0,"page_html_hits":0,"control_injected_hit":1}
```

A real 64-character bearer token exists, the matcher catches it, concatenating it onto
the page text yields exactly one hit — and the page carries none, in the rendered text
**and** in the full DOM HTML, which is the stronger surface because React serialises
props there.

**The discrimination argument for the renderer.** Four outcomes produced four
different sentences from one matcher in one run — `Invitation sent`,
`Invitation re-sent`, `created, but the email could not be sent`,
`re-issued, but the email could not be sent`, `Already in your team` — with the
raw-enum count 0. A renderer stuck on any single string fails this; a matcher looking
at nothing returns an empty array.

**The checks that could still be vacuous, named rather than defended:**

- **The five DB-gated tests have never run.** They cannot have passed vacuously here
  because they have not executed at all, which is a different and worse problem: their
  first execution is CI. They were written with the vacuity rule in mind — test 3
  accepts the same token successfully after freeing the user, specifically because
  without that step the three refusal assertions pass just as happily against an
  `acceptSiteInvite` that refuses *everyone*; every enumeration asserts a count; test
  5 re-runs 031 and `deepEqual`s the post-state, which is the assertion the previous
  031 would have failed. **But written-to-be-sound is not run-and-passed.**
- **The in-memory suite cannot see three of this branch's fixes at all** — L65, the
  upsert alias and 031 live entirely in SQL. A local run was green before and after
  each of them. That is precisely how L65 survived in production.
- **Everything mobile.** Not a vacuous check; the absence of one.
- **`delivered: true` is unreachable without the provider stub**, so the delivered
  path's screenshot evidence depends on a stub, even though the code under test did
  not. The undelivered path needed no stub and is the stronger evidence.

---

## 7. Deployment

| Commits | Needs |
|---|---|
| `eca14ae` `8e729ef` `d344445` `365d699` `aaba972` `6d41d65` `554bc0a` `b178398` `f1300a9` | **API deploy.** Migration 031 runs at boot — watch the log |
| `4f98172` `a583395` `71cec94` `8d8f8cb` | **Portal deploy** |
| `7e8945a` | **Website deploy** |
| `81183fa` `37e0a26` `0aa049b` `9a065ed` `411f4c0` | **JS-only — `eas update`.** `APP_ENV` must be set or it publishes against a config with no `runtimeVersion` |
| `8bc2a7c` `dfc9b0e` `8a4b2fe` `2098145` and this document | Docs only |

**No native rebuild.** Nothing here touches native configuration.
