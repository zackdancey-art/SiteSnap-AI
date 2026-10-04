# Status of the legal documents in this directory

**These documents were drafted from a code audit. They have not been reviewed by a lawyer.**

| | |
|---|---|
| Drafted | 3 October 2026 |
| Drafted against | the working tree at commit `dfb7fc1` (branch `fix/stage-1-field-app-defects`) |
| Basis | `docs/STAGE-0-ANALYSIS.md` sections A1–A6, plus the direct code checks recorded below |
| Reviewed by a lawyer | **No. Not once, not in part.** |
| Entity | SiteSnap AI Limited, NZBN 9429053872258 (incorporated; NZBN supplied by the owner) |

Every factual claim in `privacy-policy.md` and `terms-of-service.md` was traced to code or to
configuration before it was written down. Nothing was carried over from the previous drafts on
the strength of it already being published — the previous drafts contained several statements
the code contradicts, listed at the end of this file.

That is a different thing from legal review. What has been checked is **whether the documents
describe the software accurately**. What has *not* been checked is whether the documents say
what the Privacy Act 2020, the Fair Trading Act 1986, the Consumer Guarantees Act 1993 or the
Australian Privacy Act 1988 require them to say, whether the liability and consumer-law carve-
outs in the Terms are effective, or whether describing the product's gaps this openly creates
exposure of its own.

## When this needs a lawyer

**Before the first paying customer, or before any crew member who is not the owner has data in
the system — whichever comes first.**

The second trigger is the one that will fire first and is the easier one to miss. The moment a
real person who is not the owner is named on a timecard or accepts a site invitation, SiteSnap
holds personal information about someone who has no relationship with SiteSnap AI Limited and
no practical way to exercise a Principle 6 access request. Today, while the only data in the
system is the owner's own, the exposure is theoretical. One timesheet with a real worker's name
on it ends that.

`docs/legal-review-checklist.md` is the existing list of questions for that review. The items
below are additions to it.

## Questions a lawyer needs to answer

1. **Is the Singapore hosting leg a disclosure at all?** The analysis below concludes it
   probably is not, because Render holds the data as our agent. The whole Principle 12 position
   for the database rests on that, so it should be confirmed rather than assumed.
2. **Is "no data processing agreement with any provider" survivable?** Principle 12(f) points
   at a contract. We have each provider's standard published terms and nothing negotiated.
3. **Does the seven-year retention justification hold?** The documents assert that construction
   and health-and-safety record keeping is why deletion is a flag. That belief has never been
   checked against HSWA, its regulations, or WorkSafe guidance, and the specific figure of seven
   years has no citation behind it anywhere in this repo. It is load-bearing: it is the stated
   reason the product does not delete things.
4. **Is disclosing the gaps in section 10 of the Privacy Policy the right call?** It is the
   honest call. Whether it is the prudent one is a judgement we are not qualified to make.
5. **Does the Terms' limitation of liability survive the Consumer Guarantees Act** for a user in
   trade, and is the "in trade" carve-out drafted correctly?
6. **Crew members who never consented.** A named person on a timecard is the hardest problem in
   the product. The documents say the only route in is through their employer. Whether that is
   sufficient under the Act, and whether SiteSnap or the employer is the agency holding that
   information, needs a real answer.

## Principle 12 for Singapore, researched rather than assumed

The earlier drafts said "all overseas transfers comply with NZ Privacy Act 2020 IPP 12" and
listed every provider as being in the USA. Both halves were wrong. The hosting is in Singapore,
and a one-line assertion of compliance is not an analysis. This is the analysis.

**Principle 12 permits disclosure to a foreign person only on one of six bases** (Privacy Act
2020 s 22, IPP 12(a)–(f)): the individual authorises it after being told the recipient may not
have comparable safeguards; the recipient carries on business in New Zealand and is subject to
the Act; the recipient is subject to privacy laws with comparable safeguards overall; the
recipient participates in a prescribed binding scheme; the recipient is subject to the laws of
a prescribed country; or the recipient is otherwise required to protect the information
comparably, for example by agreement.

**No country has ever been prescribed.** Section 214 allows regulations prescribing countries
with comparable safeguards. The Ministry of Justice consulted on which countries to assess in
late 2020 and no regulations have been made since; the Act as consolidated at 27 November 2025
still has no prescribed countries. So basis (e) is available to nobody, for any country,
including Australia. Any analysis that says "Singapore is not on the adequacy list" is
describing a list that does not exist.

**The threshold question comes first: is it a disclosure?** Section 11 of the Act provides that
where one agency holds information as an agent for another, the information is treated as held
by the principal, not the agent — and a transfer from principal to agent is therefore not a use
or disclosure. Pure cloud hosting is the standard example. Render stores and runs our database,
app server and logs and does not use our records for its own purposes, so on this reading
Principle 12 does not apply to the Singapore leg at all. Two caveats, and both are real: the
protection falls away to the extent the provider uses the information for its own purposes, and
we remain responsible for our agent's safeguards regardless.

**If it is a disclosure, Singapore is weaker than it first looks.** Singapore has the Personal
Data Protection Act 2012, a general statute with a regulator (the PDPC) and mandatory breach
notification since 2021 — so basis (c) looks promising. But the PDPA expressly lifts Parts 3 to
6 off a *data intermediary* processing personal data on behalf of another organisation under a
written contract, leaving only s 24 (protection) and s 25 (retention limitation). Render, in
this arrangement, is exactly such a data intermediary. So "the recipient is subject to
comparable privacy laws" is being claimed about an entity that Singapore's own law has
deliberately relieved of most of those laws' obligations. That reasoning should not be leaned
on. Basis (f), a contract, is the honest one, and what we have is Render's standard terms.

**OpenAI is the one case where Principle 12 plainly bites.** OpenAI retains what we send for
its own abuse-monitoring purposes, which takes it outside the s 11 agent position. It is a
disclosure to a US company, and the only available basis is (f) on its standard API terms.

**Australia (S3 Sydney) is the least exposed leg.** Same agent position as Render, and the
Australian Privacy Act 1988 is the closest comparable regime of any jurisdiction our data
reaches.

Sources consulted: the Office of the Privacy Commissioner's IPP 12 page for the statutory text
of (a)–(f); legislation.govt.nz for s 214 and the current consolidation date; the Ministry of
Justice cross-border disclosure consultation for the prescribed-country status; Singapore
Statutes Online and PDPC advisory guidelines for the data-intermediary carve-out; and
`platform.openai.com/docs/guides/your-data` for OpenAI's retention terms (recorded in Stage 0,
which also records that `openai.com/policies/api-data-usage-policies/` returns HTTP 403 to
automated fetches, so the policy pages themselves could not be read).

## The sub-processors, as configured today

| Provider | Role | Location | Status |
|---|---|---|---|
| Render | Hosting, Postgres, request logs | Singapore | Active |
| Amazon S3 `sitesnapai-media` | Photographs and files | `ap-southeast-2`, Sydney | Active |
| Amazon S3 `sitesnapai-bucket` | Older photographs | `us-east-1`, N. Virginia | Legacy; nothing deletes from it |
| OpenAI | AI diary drafting | USA | Active; `store: false` now sent (commit `dfb7fc1`) |
| Resend | Transactional email | USA | Active (`RESEND_API_KEY` configured) |
| Twilio | SMS verification | USA | Active |
| Sentry | Error reporting | USA | Active. **Server and app.** The app reports crashes and failed offline syncs; `attachScreenshot` is `false` and the payload is restricted to identifiers and counts by `apps/mobile/lib/sync-telemetry-redaction.ts` |

**SendGrid is deliberately not listed in the published documents.** A complete SendGrid code
path exists in `services/api/src/services/notificationService.ts` as an alternative to Resend,
but no `SENDGRID_API_KEY` is configured in any environment, so it never runs. Listing a
processor that receives nothing would be as inaccurate as omitting one that does.

**Render Key Value / Redis is not in use** — the rate limiter runs in memory in production, so
no emails, phone numbers or IP addresses are held as Redis keys.

## Corrected after drafting: app-side error reporting

The table above originally recorded Sentry as receiving data from the API only, on the
grounds that the mobile DSN was empty. Section 5 of the Privacy Policy said "Crash reports
from the server go to Sentry" and section 10 listed app crash reporting among the things not
switched on. Closing AUDIT L31 changed that: the app now reports its own crashes, and
reports when a photograph or an entry captured offline fails to reach the server — which is
the whole point of L31, because a phone has no log and a sync that failed on a site in
December could not otherwise be reconstructed in February.

Both sentences were corrected in the canonical text and in both render copies, and the
anti-drift check described at the end of this file was run to prove the copies followed.

What the correction asserts, and where each claim is enforced in code:

| Claim in section 5 | Enforced by |
|---|---|
| Reports carry identifiers, counts and error codes | `apps/mobile/lib/sync-telemetry-redaction.ts` — `transmittablePayload` is the whole payload, and `sync-telemetry-redaction.test.ts` asserts over all of it |
| No photographs, note text, site addresses or email addresses | the same test, which puts real-shaped entry content into the report and asserts none of it is serialised |
| No signed-media `?sig=`/`?exp=` pair | there is no `uri` field on `SyncFailureReport` at all, so there is nowhere for one to enter |
| A server's own response wording is not transmitted | `transmittableDetail` withholds the message when a `status` is present, and `mayTransmitCause` keeps a server-originated `Error` out of the Sentry issue title |
| No screenshot | `attachScreenshot: false` in `apps/mobile/app/_layout.tsx` |

Sentry also records what any SDK records automatically — device model, operating system and
app version — which section 5 now says. `sendDefaultPii` is `false`, so no IP address or
account identity is attached.

**Section 10 was not simply emptied of the claim.** The sentence sat in the breach-detection
paragraph, supporting the point that nothing would tell us a breach had happened. That point
still stands and the replacement says so: crash and sync reporting tells us our own software
broke, not that someone got in. It is error reporting, not intrusion detection, and the
paragraph would be misleading if the removal left a reader thinking otherwise.

## Deliberately not disclosed in the published documents

Two things were found in the audit and kept out of the public text on purpose. Both are
recorded here, and both are in the pull request as security backlog items.

1. **Email and SMS verification codes are stored in clear text** in
   `auth_pending_registrations` until the signup completes or expires. The published Privacy
   Policy says the codes are held; it does not advertise that they are held unhashed. No
   Information Privacy Principle requires disclosing the weakness of a safeguard, and
   publishing it is an invitation rather than a disclosure. It should be fixed, not announced.
2. **The scrypt cost factor is never specified**, so Node's default (N=16384) applies, which is
   on the low side of current guidance. Same reasoning.

The five gaps the Privacy Policy *does* disclose in its section 10 — single-operator access with
no read logging, no breach detection or process, unencrypted device storage, no data processing
agreements, and unverified photo metadata handling — are disclosed because each one changes what
a reader should expect of the product, not merely how well a safeguard is implemented.

## Claims in the previous drafts that the code contradicts

Each of these was published to users before today. Each is removed or corrected in the new text.

| Previous claim | Why it was false |
|---|---|
| "Usage data: anonymised analytics events to improve the product" | There is no analytics SDK in the app at all, and the marketing site loads zero external scripts. Nothing of the kind is collected. |
| "Improving the product through aggregate, anonymised analytics" | Same. |
| "Location data: GPS coordinates used at request time to auto-fill weather — not stored" | False twice over. `extractGpsFromExif` in `new-entry.tsx` and `inspections/[siteId].tsx` reads the camera's coordinates out of each photograph and stores them in the entry's `photos_json`. Separately, `worker_locations` and `POST /api/location/update` exist for five-minute interval tracking. |
| "Auth tokens are stored in httpOnly cookies not accessible by browser scripts" | True of the supervisor web portal only. In the mobile app — the primary client — the bearer token is in plain AsyncStorage, with zero `SecureStore` use anywhere. |
| "Deleted account data is permanently purged within 30 days" | There is no scheduled job of any kind in the API. Nothing purges anything on a timetable. |
| "then permanently purged" (the seven-year claim in `settings/data-privacy.tsx`) | Same. The clause described no mechanism. |
| "Portability — request a machine-readable data export" | `backup-data.tsx` reads the device cache and omits timesheets, incidents, inspections, signatures, locations, photographs and the account record. There is no export that satisfies this. |
| "We will notify users and relevant authorities of any notifiable privacy breach" | The intention is real; the capability is not. There is no monitoring that would detect a breach and no written process. |
| "Account and all associated data have been permanently deleted" (`DELETE /auth/account` response) | `uploads` rows, every S3 object and the `companies` record survive. Corrected in the same pull request. |
| "Resend / SendGrid (USA)" | SendGrid is configured nowhere and receives nothing. |
| "All overseas transfers comply with NZ Privacy Act 2020 IPP 12" | Asserted a conclusion with no analysis behind it, about providers it placed in the wrong countries. Replaced by section 5 of the new Privacy Policy. |
| "Entity name pending NZ registration" / "Update LEGAL_ENTITY once the company is registered" | SiteSnap AI Limited is incorporated, NZBN 9429053872258. The marketing footer was right and the in-app wording was stale. |
| Terms: "billed in advance", "AUD where indicated at checkout", "change pricing with 30 days' notice" | There is no payment code in the repo — no Stripe, no RevenueCat, no in-app purchase dependency, no billing module. The product cannot charge anyone. |

## What the anti-drift check in `Projects/scripts/ci.sh` does

For each of the two canonical documents it extracts the text between the `BEGIN LEGAL TEXT` and
`END LEGAL TEXT` markers from the canonical file and from each render target, reduces each to a
lower-case word stream (URLs and `mailto:` targets dropped, markup and punctuation dropped, one
word per line), and `diff`s them. Divergence fails the build.

**What it catches:** a paragraph edited in one copy and not the others; a section added to the
website and not the app; a `Last updated` date changed in one place; a sentence deleted.

**What it does not catch:** punctuation, capitalisation, word order within a line (it compares
streams, so reordering *is* caught, but transposing two words is reported as a change at that
position rather than as a reorder), styling, section ordering if the words happen to be
identical, and anything outside the markers. It also cannot know whether the text is *true* —
that is what this file is for.

**Why not generate the copies from the canonical source:** the in-app copies are React
components and the web copies are hand-styled HTML, so a generator would have to own both
layouts. Detecting drift is the cheap ninety per cent.
