# Phase 1.6 — The acceptance test for crew invitations

**Date:** 2026-10-10. **Branch:** `feat/crew-invitations-clean`.

I cannot run this. It needs a phone that can receive an SMS, a second mailbox, and a
second handset or at least a second account on one — none of which this session has.
So this is the checklist, and it is explicit about which lines I verified myself,
which I verified *by proxy* on a surface that is not the phone, and which are
genuinely untested by anybody until you walk them.

**Nothing below is a claim that the flow works.** The code reads as though it should.
That is the same standard that produced four near-misses on this project, and it is
not the standard. Until step 9 passes on a handset, the honest status of crew
invitations is *"fixed in code, unproven in the field."*

---

## What I verified, and how

**Verified by driving the running system.** A real portal binary (`next start`, built
from this branch) at 1440×1100, driven over CDP against a real API on localhost, with
every request's host asserted in the same run (`localhost:3001`, `localhost:4000` —
nothing else):

- the invite form's four outcomes produce four distinct sentences, screenshots
  `B2`, `B3` (delivered) and `C1`, `C2`, `C3` (undelivered, re-issued undelivered,
  already-a-member), with 0 raw enum strings on the page and a live positive control
  proving the matcher was looking at a real page;
- re-inviting the same address leaves **one** row in Pending invitations with a **new
  id** — re-issued, not duplicated and not errored;
- the empty state when nothing is outstanding;
- no 48-plus-character hex run anywhere on the rendered page, i.e. no invitation
  token reaches the browser.

**Verified by reading SQL and covered by tests that have not yet run.** The Postgres
half of acceptance (L65), the upsert's `inserted` alias, and migration 031's
collision case. Five tests, gated on `TEST_DATABASE_URL`, which this environment does
not have. **They will execute for the first time in CI when you open the PR.** If CI
is red on this branch, read those five before anything else.

**Not verified at all.** Everything on the phone. The mobile invite screen cannot be
screenshotted from here — that was costed in an earlier phase and declined — so the
four result states in `company-invite.tsx` are code-reviewed and nothing more. The
portal and mobile render the same four outcomes from the same four API values with
the same four sentences, so a portal screenshot is *evidence about the contract* and
is **not** evidence about the phone. Step 7 below is where you check it.

---

## Step zero — know what you are testing

> *Results from a stale binary are not results.*

**This is harder than usual for this phase, and you need to know why.** Every mobile
commit here is **JS-only** — they ship by `eas update`, not a new build. An
`eas update` does **not** change the version or build number, so
**Settings → About will read exactly the same before and after.** The usual step zero
cannot distinguish them.

The app also has no in-app update identifier. `expo-updates` is installed and
configured, but `Updates.updateId` is surfaced nowhere in the UI — so there is
currently **no way, from inside the app, to tell which JS bundle you are running.**
That is a real gap, it is why this section is long, and it is already scoped: the
About build ID is Phase 4.

Until then, step zero is three things:

1. **Publish deliberately, and record what you published.**
   `eas update` must be run with `APP_ENV` set or it publishes against a config with
   no `runtimeVersion` and the update reaches nobody:

   ```
   APP_ENV=preview eas update --branch preview --message "phase 1 crew invitations"
   ```

   Note the update's ID from the command output. That is your build identity for this
   round; there is no in-app equivalent.

2. **Force-quit and reopen the app TWICE before testing.** The config is
   `checkAutomatically: "ON_LOAD"` with `fallbackToCacheTimeout: 0`: the app launches
   immediately from its cached bundle and downloads the new one in the background, so
   the update applies on the **next** launch. Opening once, seeing old behaviour and
   concluding the fix failed is the trap here, and it will look exactly like a bug.

3. **Confirm Settings → About shows the version you expect** — not as proof the
   update landed, but to catch the other error: testing a TestFlight binary that is
   older than `version` in `package.json` and therefore on a different
   `runtimeVersion`, which no amount of publishing will reach.

---

## Before you start: what must be deployed and set

| # | What | Where | Why |
|---|---|---|---|
| 0.1 | **Deploy the API** | Render, API service | The invitation is created, normalised and emailed here. Migration 031 runs at boot — watch the deploy log for it |
| 0.2 | **Deploy the portal** | wherever the portal is hosted | `/invite` and `/signup` did not exist; the result rendering and Pending invitations are here |
| 0.3 | **Deploy the website** | the static site | `/invite` is the Universal Link landing page. Without it the link 404s for anyone without the app |
| 0.4 | **`eas update`** | preview channel, per step zero | The three mobile fixes |
| 0.5 | **`INVITE_URL`** = `https://www.getsitesnapai.com/invite` | Render → API service → Environment | You confirmed this is set. If it is still `sitesnap://invite`, the link does nothing on a device without the app installed |
| 0.6 | **`TEST_PHONE_NUMBERS`** = your mobile, full international form, `+64` then nine digits, no leading `0`, no spaces | Render → API service → Environment → Environment Variables, then redeploy | Lets a **second account exist on your handset**. It does not skip verification — both codes are still required. The boot log prints a **count only**; a count of 1 is your confirmation. I have no Render access and cannot tell whether it is set today |

A mismatch in 0.6 is silent: the exemption simply never fires and you get the
uniqueness error it was set to prevent. The leading `+` is part of the match.

---

## The checklist

Each step says what should happen. Where a step has a known weak point, it is named —
those are the ones worth watching rather than ticking.

**1. Send one invitation.** Portal → Team → Invite people. Enter a second address you
control, pick a role, send.
→ A green row: **"Invitation sent"**, with the address above it.
→ *If it says "Invitation created, but the email could not be sent", stop.* The
invitation exists but hop 2 failed — check the API's Resend configuration before
going further. This message is the whole point of the change; previously it said
"Invitation sent" regardless.

**2. The invitation appears in Pending invitations.** Same page, below the form.
→ One row, the address, the role, your email as inviter, today's date, and a blue
**"Awaiting acceptance"** badge.

**3. Re-invite the same address.** Enter it again, send again.
→ **"Invitation re-sent — any earlier link for this address has stopped working"**,
in green.
→ Still **one** row in Pending invitations, with a fresh date.
→ *The earlier email's link is now dead.* That is deliberate and is the decision
flagged for you in the trace document. Use the **newest** email from here on — if you
click the first one you will correctly get an invalid-invitation error, and that is
not a bug.

**4. Invite yourself.** Enter your own address, send.
→ Grey, no tick: **"Already in your team — no invitation needed"**.
→ **No** new row in Pending invitations.
→ *This is the one that used to read `✓ you@example.com — already_member`.*

**5. The email arrives and the link opens.** Open the newest invitation email on the
**iPhone**.
→ With SiteSnap installed: the app opens directly on the invitation screen.
→ Without it installed, or from a desktop browser: the website's `/invite` page.
→ *Weak point.* Universal Links do not fire from every mail client, and iOS caches
the association file. If it opens Safari instead of the app, long-press the link and
choose "Open in SiteSnap" to confirm the route itself works, then treat the Universal
Link as a separate problem.

**6. Create the account from the link.** Follow it through signup on the phone: email,
password, name, phone.
→ Enter your phone **in the normal local form** with its leading `0`, having picked
`+64`. The app now strips that `0` before sending — this is the `composeE164` fix.
Previously it sent a 10-digit national number welded to `+64`, Twilio rejected it,
and the API returned 502 with no SMS.
→ An email code arrives, then an SMS code.
→ *This is the step `TEST_PHONE_NUMBERS` exists for.* Without it, registering a
second account on your number fails on phone uniqueness.

**7. Check the four invite-result states on the phone.** Open
mobile → company invite, and repeat steps 1, 3 and 4 from the handset.
→ Sent, re-sent, already-in-your-team, and (if you can make email fail) created-but-
not-emailed should each read as a distinct sentence, and only the first two should be
green.
→ **This is the step nothing has verified.** The phone cannot be screenshotted from
my side. Specifically watch for a **re-send reported as a red "Failed to send"** —
that was the original defect and it is what commit `9a065ed` claims to fix.

**8. The new account lands in YOUR company.** On the new account, check the company
name on screen; on your owner account, check Team → Members.
→ The invitee appears in **your** members list, with the role you invited them as.
→ *This is the deepest fix in the phase (L65).* On Postgres, acceptance never
attached anybody to a company — it worked in dev and not in production, which is the
worst shape a bug can have. If this step fails, nothing else in the phase matters.

**9. The crew account can do its job.** On the new crew account, open the app and try
to capture: a diary entry, a photo.
→ **Expect this to fail**, and read the warning below before you treat it as a
surprise.

---

## The thing that will stop you at step 9

**A crew member is locked out of every field route, and I have not fixed it, because
the fix is your decision and not mine.**

`projects.ts` mounts seven routers behind a pathless
`requireAtLeast("viewer")`. Company roles rank `owner > manager > viewer > crew`, so
crew — rank 0 — is below the gate. That is **31 routes**. Measured on the running
API: crew got 403 on **9 of 9** reachable GETs; an owner got 200 on the same **9 of
9**, which is the control that makes the 9 mean something.

I fixed exactly one route — `POST /projects/invites/accept` — because an invitee who
cannot reach the accept route cannot be in the company at all, and that is this
phase. The other 30 are a permission-model decision: either crew is granted a scoped
subset, or crew is not the right rank for a field user, and choosing between those
changes what gets built. It is recorded as **L66** in `docs/AUDIT.md`.

**This blocks December.** Step 9 is what a crew member does all day.

---

## Summary of status

| Claim | Status |
|---|---|
| Portal renders four distinct invitation outcomes | **Verified** — screenshots, 1440×1100, rebuilt binary |
| Re-inviting re-issues one invitation rather than erroring or duplicating | **Verified** — live API, row id changed, row count 1 |
| The sender can see pending and expired invitations | **Verified** — screenshot |
| No invitation token reaches the browser | **Verified** — 0 hex runs, live positive control |
| The Postgres acceptance path attaches the invitee to the company | **Tested, never run.** Five DB-gated tests, first execution is CI |
| The email actually leaves the building | **Unverified.** No mail provider locally; `delivered: true` is unreachable here without stubbing |
| Anything at all on the phone | **Unverified.** Cannot be screenshotted |
| A crew member can use the app once they are in | **Known broken.** L66, awaiting your decision |
