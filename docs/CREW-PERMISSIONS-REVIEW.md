# Phase 1b — Crew Permissions — review

Branch `feat/crew-permissions`, seventeen commits off `63b5fe3`. 11 October 2026.

The phase exists to answer one question — *would you now hand a crew member this app on a site in
December?* — and the honest answer is at the bottom, after the evidence that supports it.

Revised twice. First after the owner's three decisions on the measurement: `POST /projects/sites`
stays manager+ as a deliberate fourth exception; diary approval becomes manager+ as a
**field-level** gate; and L79 is closed with Team hidden from crew and Settings kept working.

Then again, and more substantially, after **the headline rule itself was corrected** — section 0
below. The first twelve commits implement the superseded rule; five more implement the correction.
Read §0 before §1, because two of §1's items describe the rule as it was.

---

## 0. The rule was corrected, in both directions, and the table could not see either

The rule this branch was built to, and the rule it now implements:

| | superseded | **as corrected** |
|---|---|---|
| manager | view and edit everything, dashboard included | unchanged |
| crew — read | "everything a manager can" | **view every site and every entry in the company** |
| crew — write | "everything a manager can", minus four exceptions | **edit only the entries they created** |
| crew — dashboard | absent | unchanged |

The four exceptions stand unchanged: no inviting, no creating a site, no deleting a site, no company
settings, no approving a diary. Timesheets are the one record carved out in the other direction —
crew see and edit only their own, because that is pay information rather than a shared site record.

**Two gaps, in opposite directions, and the measurement in §2 could not have detected either.**

1. **Crew saw too little.** `listEntries` scoped crew to `owner_email` OR a `site_members` row, and
   a company-level invitation creates no `site_members` row. So a crew member invited to the
   company saw only their own entries — wrong under either reading of the rule. Fixed without
   inserting membership rows on company invitation: a company invitation has no particular site, so
   inventing a site list at invitation time would be inventing data.
2. **Crew could edit too much.** Nothing checked authorship on `PATCH` or `DELETE`. Two Postgres
   paths had no authorship check at all (AUDIT L89). Thirteen write routes now carry
   `requireOwnRecord`.

Why §2's table missed both, which is the part worth keeping:

> A 200 returning a filtered subset is indistinguishable from a 200 returning everything. Fifteen
> green reads proved the routes were **reachable**, not that they returned the right rows. And every
> write the table measured was a crew member writing their **own** row, so nothing in it exercised
> crew touching somebody else's — which is how two stores came to have no authorship check at all.

The table now measures rows received, by id, and authorship. §2 carries the new populations.

**Where the rule lives.** One named module: `Projects/services/api/src/storage/recordScope.ts`. It
answers read and write separately — `readVisibility`/`canReadRow` and `canEditRow` — plus two SQL
emitters for the store queries. No store tests `isCrew` any more; each passes an actor and a
`RecordKind` and asks. The one deliberate exception is `deleteSite`, documented at the line: it is
unreachable for crew behind a manager+ route, and routing it through `canEditRow` would remove a
second-layer guard on a destructive cascade rather than express the rule.

**What moving to site-level assignment would cost**, since the owner expects to want it: change
`readVisibility` to return a third mode, `"assigned-sites"`, and the two emitters beside it to
render it as `site_id IN (SELECT site_id FROM site_members WHERE member_email = $n)` for SQL and a
membership-set test for the in-memory path. `SITE_SCOPED` in the same file already records which
record kinds have a `site_id` to narrow on. No store changes. The tests that change are that
module's own and the company-wide rows of the permission table.

---

## 1. What was built

### Item 1 — the pathless gate is gone (`3029ab7`, API deploy)

`projectsRouter` carried one pathless `use(requireAuth, requireAtLeast("viewer"))`. A pathless `use`
on a router that is itself mounted pathlessly runs for every request reaching the API at or after it
in mount order, and seven routers are mounted after it carrying no role gate of their own. Crew is
rank 0. That one line refused crew all 31 of those routes — the whole field product — which is L66.

It is now `projectsRouter.use("/projects", ...FIELD_ACCESS)`. The path argument is the fix. Crew was
**not** promoted to viewer, because a rank promotion grants whatever else viewer implies on every
route that gates on viewer today and every one added later, none of which anybody would re-examine.

`FIELD_ACCESS` is a new export in `middleware/auth.ts` and is deliberately `[requireAuth]`, **not**
`[requireAuth, requireAtLeast("crew")]`. `requireAtLeast("crew")` cannot refuse anything —
`verifyAuthToken` always derives a `companyRole` and crew is rank 0 — so it would be a gate that
reads as protection and is vacuous. The reason is written at the definition so the next reader does
not "tighten" it into decoration. `docs/VACUITY-AUDIT.md` is why that sentence is there.

Routes that need more than identity now say so, individually:

| requirement | routes |
|---|---|
| `requireAtLeast("viewer")` | `GET /projects/summary`, `GET /projects/reports/supervisor` |
| `requireAtLeast("manager")` | `POST /projects/sites`, `DELETE /projects/sites/:id`, the three site-invitation routes, `GET` and `DELETE /projects/sites/:siteId/members` |

The same pathless shape existed in `deliveries.ts` and `templates.ts` and did no harm only because of
where they sit in the mount order. Both are scoped now. `company.ts` is the one remaining instance
and is left alone — see L82.

The accept-invitation carve-out is deleted. There is nothing left to carve out of: gating acceptance
on the rank you acquire *by* accepting was circular, and with the blanket gate gone the route needs
identity, which is what it asks for. `routes/invite-accept-access.test.ts` still holds the proof that
the orphan state it stranded is reachable and recoverable.

### Item 2 — the supervisor dashboard, both halves (`3c78374` mobile, `a4290ce` portal)

**Mobile.** `lib/permissions.ts` is new and holds the decision in one place. The predicate
`user?.companyRole === "owner" || user?.companyRole === "manager"` had been written out longhand in
three files, and the delete-a-site control in `app/site/[id].tsx` had no check at all even though the
invite control two lines above it did. The tab layout now **removes the screen from the navigator**
rather than hiding its button, so guessing the route does not reach it either.

The module has no React Native import, on purpose: mobile cannot be screenshotted from this
environment, so a unit test is the only verification available for the UI half, and the node test
program cannot compile a module that reaches a navigator or AsyncStorage.

**Portal.** `lib/useRole.ts` gained `canSeeSupervisorDashboard()` and `landingPath()`. The Dashboard
nav item carries `managerOnly: true` — a field on the item rather than a filter at the call site, so
the next entry added has to state which it is instead of defaulting to visible by omission.
`app/dashboard/page.tsx` refuses the URL independently and says something true while doing it.

Crew used to land on `/dashboard` after sign-in, which is now their refusal screen. They land on
`/sites` instead, which is the screen the rest of their work hangs off.

### Item 3 — the three exceptions, server-side

Invitation, site deletion and company settings are refused by the API, not merely hidden:

- invitation — `POST/GET/DELETE /projects/sites/:siteId/invites` are manager+; `POST /company/members/invite` and `GET /company/invites` were already manager+ in `company.ts`;
- site deletion — `DELETE /projects/sites/:id` is manager+;
- company settings — `GET` and `PATCH /company/profile` are viewer+ and manager+ respectively in `company.ts`, untouched, so crew refusal there is status quo rather than new work.

### Item 4 — a 403 is not a dead session (`74ec3a8`, test program only)

Covered in full in §3.

### Item 5 — the table (`897fc80` and `5d845ef`, API deploy)

`routes/crew-permissions-db.test.ts`, DB-gated. Covered in §2.

### Item 6 — approving a diary is manager+, on the field and not the route (`d96dae0` API, `28d0d9d` mobile, `da86179` portal)

The owner's second decision, and the one with a trap in it. A submitted diary is a claim; an
approved one is the record. The portal presents an approval rate as oversight, and a rate counting
self-approvals is a misleading number on a document kept seven years.

The gate is `requireManagerToAttestDiaryStatus` in `routes/projects.ts`, applied to **both**
`POST /projects/diaries` and `PATCH /projects/diaries/:id`. It reads the `status` field out of the
body: absent, or `draft`, it calls `next()`; anything else goes through `requireAtLeast("manager")`.
So crew keep notes, photographs, weather, crew count, creating a diary and correcting one — only the
attestation is refused. A route-level gate would have satisfied any test asserting a 403 while
turning *"crew may keep a diary"* into *"crew may not use diaries"*, which is a worse defect than
the one being fixed; §2 covers how both rows are held.

Allowlisting the one status that asserts nothing is what makes it **fail closed**: a third enum
value added later is refused by default rather than quietly admitted. The sweep that settled there
is no third value today, and that no other status enum in the API needs the same treatment, is in
L81.

Two consequences are flagged rather than buried. `POST` is gated as well as `PATCH`, which is beyond
the letter of the decision — `DiarySchema.status` is required on create, so an ungated POST would
let a refused crew member create the diary already approved and make the PATCH gate decoration. And
because `draft` is allowlisted, crew can still move an approved diary *back* to draft; that is a
different transition from the one named, left ungated deliberately, and written up as L86 for the
owner.

Both clients follow the gate rather than discovering it: `canApproveDiary` in
`apps/mobile/lib/permissions.ts` and in `apps/supervisor-web/lib/useRole.ts`. On mobile the Approve
control's condition had been `Boolean(user)` — true for anyone signed in — which means the
*"Awaiting supervisor approval"* branch written for exactly this case had never once been reachable.
On the portal the button is withheld from crew and viewer, because its error path swallows the 403
(L85).

### Item 7 — L79: Team is gone for crew, Settings stays and works (`39575e7`, portal deploy)

The owner's third decision, and the two screens take different shapes because they are different
things. **Team** is company administration end to end, so it goes the way the dashboard went:
filtered from the sidebar by a `hiddenFromCrew` flag *and* refused by the page itself, so guessing
the URL reaches a refusal card. **Settings** stays — crew need their password, their notifications
and sign out — with only the Organisation section withheld, dropped from the section list so they
are not offered a tab that would refuse them.

The defect in L79 was never the 403. It was that the page called `/company/profile` unconditionally
and then reported the refusal as *"failed to load"*. Both pages now ask `canReadCompanyProfile`
first. §2 has the measurement, which is a request log rather than a screenshot, because *"the
request is no longer fired"* is not a thing a screenshot can show.

---

## 2. What the measurement does and does not establish

The verification standard for this phase was explicit: anything touching authorisation needs a test
against Postgres, in the DB-gated suite, with **both** controls on the same route in the same test.

The test is written to that standard. Six populations are pinned —
`EXPECTED_READS = 15`, `EXPECTED_WRITE_STEPS = 14`, `EXPECTED_REFUSALS = 15`,
`EXPECTED_FIELD_PROBES = 4`, `EXPECTED_PARITY_KINDS = 5`, `EXPECTED_OWNERSHIP_PROBES = 20`
— so a sweep that quietly measures nothing fails instead of passing. The last two were added with
the correction in §0 and are described at the end of this section; the first four measure
reachability and refusal, which is all they were ever capable of measuring. The crew member is a **real invitee**: the owner
invites at `role: "crew"`, the crew member registers with the token, accepts, and the test uses the
fresh token the accept route issues. That matters because L66's second finding was that
`company-rbac.test.ts` registered its "crew" member *without* an invite token, which makes them the
owner of a solo company, accepts at rank owner, and demotes afterwards — a journey no real invitee
takes, and the reason a green suite hid two critical findings.

And the table is not circular. A precondition test reads both tokens with `verifyAuthToken` and
asserts the roles they actually carry, with the failure messages saying why:

> *the crew token does not carry companyRole crew, so no 403 below proves anything about crew*

**The fourth population is the diary gate, and it exists because of how this one could go wrong.**
A gate on the status field cannot be measured by a route-level table: a row reading
*crew, `PATCH /projects/diaries/:id`, 403* would be produced equally by the gate that was wanted and
by the gate that locks crew out of diaries altogether. So the same route answers **both ways for the
same role in the same test** — four probes, run as crew and again as owner:

| probe | crew | owner |
|---|---|---|
| `PATCH /projects/diaries/:id`, content only, no `status` in the body | allowed | allowed |
| `POST /projects/diaries` with `status: "draft"` | allowed | allowed |
| `POST /projects/diaries` with `status: "approved"` | refused | allowed |
| `PATCH /projects/diaries/:id` with `status: "approved"` | refused | allowed |

The write sequence changed to match: its *"approve that diary"* step is now *"edit that diary"*,
because the sequence measures what crew do daily and approving is no longer one of those things.

Red-on-revert was run twice here, against the two ways of getting it wrong, and both are real
output. Removing the gate from both routes:

```
not ok 82 - the diary gate reads the status field and not the path, so crew keep diaries
    crew must not approve a diary: 200 ... "status":"approved" ...
    200 !== 403
```

And the *wrong fix* — `requireAtLeast("manager")` on the route itself, which is what a route-level
reading of the decision produces:

```
not ok 82 - the diary gate reads the status field and not the path, so crew keep diaries
    error: 'crew must be able to save a draft diary: 403 {"error":"Insufficient permissions."}'
```

That second one is the point of the whole arrangement. A table with only the refusal row goes green
on it.

**The portal's conditional call was measured, not inferred.** A screenshot can show the Organisation
section is absent; it cannot show that no request was fired, which is the actual content of the L79
fix. So a request-logging stub was put on the port the portal build points at, and `/settings` was
loaded as each role in the same build:

```
crew: GET /api/account/settings
mgr : GET /api/account/settings
      GET /api/company/profile
```

One call for crew — their own account, which is theirs — and the manager differs by exactly the one
request. The rendered frames were byte-identical to the screenshots taken in the earlier pass, so
the two runs corroborate each other.

**What could not be done here, plainly.** This machine has no Postgres and no container runtime —
checked again this session. `pnpm --filter services-api run test:db` reports **10 tests, 0 pass, 10
skipped**. The four-row table has therefore **never been executed on this machine**. CI runs
`test:db` against a `postgres:16` service container through `Projects/scripts/ci.sh`, and a missing
`TEST_DATABASE_URL` is a hard failure there rather than a green run full of skips, so the pull
request is where the table is first produced. That is stated in the PR body rather than implied.

Because of that, red-on-revert for the *Postgres table* could not be shown either. What was shown
instead is red-on-revert for the **gate** — express middleware, identical under both store
implementations. Reinstating the blanket gate produced four real failures as actual output,
including the regression test that names the mechanism directly:

```
not ok 81 - the projects gate applies to its own paths and not to the routers mounted after it
    a crew token must reach crewRouter, which projectsRouter does not own: 403
```

That establishes the gate's shape and the in-memory half. It does not establish the Postgres table.
The distinction is the whole of L65's lesson and it is not blurred here.

The diary gate is covered the same way and for the same reason: the four probes also run in-memory,
in `routes/invite-accept-access.test.ts`, against a crew member who was genuinely invited and
accepted. A gate nobody has watched execute is a gate on paper, and that in-memory copy is what made
both red-on-revert runs above possible before CI ever sees the branch.

**The two rows added with §0's correction, and why they are shaped the way they are.**

`EXPECTED_PARITY_KINDS = 5` — sites, entries, incidents, inspections and deliveries are each seeded
with one row written by the owner and one by the crew member on the same site. Both roles `GET` the
list; the ids are sorted and compared with `deepEqual`. Status codes are not compared, because that
is the measurement that failed. Three things make the comparison non-vacuous:

- The **owner control asserts it saw something first.** Two empty lists are trivially "the same
  rows", so without this the row would go green on a route returning nothing to anybody.
- The **named rows are asserted individually** as well as the sets. Set equality would also hold if
  both roles were wrongly narrowed in the same way.
- The **precondition is stated rather than inherited.** This file's crew member was created by a
  *site* invitation, so a `site_members` row exists and a green read could be coming from membership
  rather than from company scope. The test removes the membership itself — having first proved it was
  there to remove, otherwise "zero rows remain" passes when the `WHERE` clause is wrong — proves it
  is gone, and restores it in a `finally` so the refusals row below still has one to revoke. All
  three statements run with `app.company_id` set, because `site_members` is FORCE RLS as of
  migration 025; on the bare pool they would match no rows and the precondition would be theatre.

`EXPECTED_OWNERSHIP_PROBES = 20` — five probes on each of the four authored record types:

| probe | expected | what it is for |
|---|---|---|
| crew `PATCH` their own | 2xx | the capability, which must survive the fix |
| crew `PATCH` the owner's | 403 | the defect |
| crew `DELETE` the owner's | 403 | the defect, destructively |
| owner `PATCH` the owner's | 2xx | the row crew just failed to delete is still there, and the route still works |
| owner `PATCH` the crew member's | 2xx | "manager: edit everything", and proof the gate is crew-specific rather than ownership for all |

The fourth is the one easy to leave out and it is doing real work: a 403 on a `DELETE` is
indistinguishable from a 403 on a row that was already gone. The refusal messages name the
diagnosis rather than the expectation — *404 means the store narrowed it but `requireOwnRecord` did
not run; 200 means neither did* — because those are two different bugs with two different fixes.

Timesheets get their own row and are the one comparison that must **not** match, so its control runs
the other way round: the **owner** must be able to see the crew member's timecard before the test
asserts that the crew member cannot see the owner's. Otherwise "crew see fewer rows" would pass just
as well on a route returning nothing to anybody. The completeness test asserts
`PARITY.some((r) => !r.same)`, so the carve-out being *applied* is itself measured rather than
assumed.

---

## 3. The 403 half, which the phase called the part most likely to go wrong

It was right to. L73 was closed by routing every session-shaped 401 through `lib/session.ts` from
fourteen call sites, which put a sign-out next to eight response-status branches. 401 and 403 are
adjacent integers, and this phase generates 403s on purpose.

Two tests, because one of them cannot do the job alone.

`lib/permissions.test.ts` proves the **predicate** discriminates: `isSessionExpired()` is false for a
403 with no code, with a session code, and with an empty code — each alongside a 401 control in the
same test. That proves the function. It cannot prove that the places which actually route to sign-in
agree with it, and those are where the defect would live.

So `lib/session-routing-audit.ts` parses `lib/` and `app/` and reports every
`notifySessionExpired()` call and every `new SessionExpiredError()` that is not reached under a
readable `=== 401`, or that is reached under a test for any other status. **82 files, 12 sign-out
sites, all `[401]`, no violations.**

It refuses to guess. A guard it cannot read as a status comparison is a violation, not a pass —
`>= 400`, a variable holding the status, a `switch`, and the else branch of a 401 test all fail
closed. The alternative resolves *"I do not understand this"* to *"fine"*, which is how a check
becomes decoration.

Red-on-revert, as actual output. Changing `query-client.ts:30` from 401 to 403:

```
not ok 85 - every route to sign-in in the real app is guarded by a 401, and nothing else
    lib/query-client.ts:30 [sign-out-must-not-be-reached-on-another-status]
    routes to sign-in under a test for 403.
```

The real tree is correctly free of a 403 sign-out, so the real tree cannot show that one would be
caught — eight fixtures are the positive control, and the call-site counts are pinned so a sweep
finding nothing fails rather than satisfying "none of them is wrong" with zero files.

**A 403 also says something true.** `describeFailure()` answers a specific forbidden message for a
403 and leaves every other failure its own wording. No third fetch helper was written: `authedFetch`
and `authedJson` remain the only two, which was the instruction.

---

## 4. What I found that nobody asked for

Eight new AUDIT entries, L79–L86, all discovered while measuring rather than while building. Three
of them are now closed by the owner's decisions; the closures are marked.

- **L79 — closed.** The portal's Team and Settings screens called `/company/profile` unconditionally, so crew met *"failed to load"* rather than a refusal — the L73 habit in a new place. Team is now hidden and refused; Settings works with the Organisation section withheld; both calls are conditional. Item 7 above.
- **L80** — `projectsStore.canManageSite` admits a crew or viewer who personally owns a site. An owner demoted to crew still satisfies it for every site they created. The manager+ gates close the reachable half; the store predicate is unchanged because narrowing it removes rights from existing rows.
- **L81 — closed.** Any authenticated company member could approve a site diary, including its author. This was the one I most wanted a second opinion on, and the owner's answer was manager+, as a field-level gate. Item 6 above. The sweep it prompted also settled that no other status enum in the API needs the same treatment.
- **L82** — `company.ts` carries the same pathless `use` as L66, harmless only because it is mounted last and because the middleware is `requireAuth` rather than a rank gate. Neither reason survives a reordering.
- **L83** — `useRole()` resolves an absent `companyRole` to `viewer`. Left alone, and the four new predicates deliberately read the raw value instead, so they do not inherit a default written for another purpose.
- **L84 — a decision, not a defect.** `POST /projects/sites` at manager+ is a deliberate **fourth exception**, confirmed by the owner: creating a site is setup work, and until the bin exists (Phase 6) an accidental site is permanent. It is recorded in the AUDIT precisely because the next reader will find four exceptions where the decision names three and reasonably conclude one is drift. It is not drift; do not relax it without asking.
- **L85** — the portal's diary Approve button catches its own failure into `console.error` and clears the spinner, so nothing reaches the person. Phase 1b made it unreachable for the refused roles, which is avoidance rather than a fix: an expired session or a 500 still lands in the same silent branch. It belongs with L73's remaining call sites.
- **L86** — the diary gate allowlists `draft`, so crew can still move an approved diary back to draft (mobile's `handleRevertToDraft`, which prompts for an audit reason). A different transition from the one named, left ungated deliberately. Recorded because it is a direct consequence of the implementation's shape rather than an independent discovery. Owner's call, and the change is one asymmetry rather than a redesign.

Beyond the AUDIT entries, one thing is still worth the owner's eye and is in the PR body:

**The portal's login copy still reads "Owner and manager accounts only." and is still not enforced.**
It was already untrue; after this phase it is further from true, because crew now get a working
portal behind it.

---

## 5. What was not done, and why

- **The Postgres table was not run.** No Postgres here. CI produces it. Stated rather than papered over.
- **Mobile was not screenshotted.** It cannot be from this environment. The device checklist in the PR body says so plainly rather than implying coverage.
- **L80 was not fixed.** `canManageSite`'s ownership clause is unchanged: narrowing it to role alone removes rights from any site whose creator is no longer a manager, which is data-affecting in a compliance-evidence product. The reachable half is closed by the manager+ gates.
- **L85 and L86 were not fixed.** L85's fix is L73's shape and converting one button would leave the reports page half done. L86 extends a refusal the owner did not name, which this phase was told not to do unasked.
- **The revert-to-draft transition was not gated.** Same point as L86, stated here because it is the one place this branch could be accused of a gap rather than a decision. It is a decision, and it is the owner's to reverse.
- **`company.ts` was left alone.** Outside the phase's file set, and changing its pathless `use` alters 401-versus-404 behaviour on unmatched paths, which is observable.
- **The mobile dashboard (manager+) and the portal dashboard (viewer+) were not unified.** Pre-existing asymmetry; either direction changes what a viewer can do, which is not this change's call.
- **Voiding an inspection signature was not gated (L91).** It is the one write on the inspection surface left out of the ownership sweep, and deliberately: `inspection_signatures` records `signer_name` as free text and carries no author column, so there is nothing for `requireOwnRecord` to look up. Three options are written out in L91; the cheap one is manager+, consistent with approval, and it is the owner's call because it costs a crew member the ability to correct a mis-signature on the spot.
- **None of the report findings were fixed.** Seven are recorded as AUDIT L92–L98 with line numbers, under the instruction to record rather than fix: the period window anchoring on the latest visible entry, the twelve-photograph ceiling taking the oldest twelve, `totalPhotosAttached` disagreeing with the per-entry sum, five silent drop paths in `normalizeBase64Image`, no author attribution, five entry fields dropped from the payload, and `listEntries`' `limit = 200` applied before the period filter. Two of them — the period anchor and the author attribution — got *worse* as a direct result of the correction in §0, because a crew member's report now draws on the whole company's entries rather than their own. Both are recorded as such.
- **L98 is L45's truncation in a second place, not the same defect.** Asked and answered in the finding: L45's cap was `z.array(...).max(50)` on the request schema and was fixed by having the server load the entries itself; this one is a cap inside that server-side load. The fix moved the truncation rather than removing it — from the client's payload to the server's query, and from 50 to 200.

---

## 6. What cannot be verified without you

1. **The permission table, now six rows.** It runs for the first time in CI on this PR. If any row disagrees with the decision, that is the place it will show. The in-memory copy of the diary probes has run here and is green, which narrows but does not close this — and the two rows added with §0's correction have **no** in-memory half at all. The id-parity row and the twenty ownership probes are compiled, linted and unexecuted. They are also the two rows measuring the defects the first four could not see, so this is the item with the most riding on it.
2. **Every mobile claim.** The navigator change, the hidden controls, the Approve control's new condition and the 403 copy are unverified on a device. The checklist in the PR body is the instrument; step zero is Settings → About naming the running bundle, because results from a stale binary are not results.
3. **L86 — crew reverting an approved diary to draft.** Implemented as open, deliberately. Whether it stays open is yours.

---

## 7. The question this phase exists to answer

> *Having measured it, would you now hand a crew member this app on a site in December?*

**Yes, subject to the same two verification items — the table going green in CI, and a device pass.**
The answer has not moved. What it rests on has, and that is the honest headline of this revision:
the previous Yes was issued against a rule the owner has since corrected, on the strength of a
measurement that could not have detected either of the two gaps §0 describes. The answer was right
by luck in one direction and wrong in fact in the other — a company-invited crew member really was
seeing only their own entries at the moment that Yes was written.

So the Yes is worth more now than it was, for a reason unrelated to its wording: it is the first
time it has been given against a table that measures which rows came back and who may change them,
rather than which status code came back.

What is genuinely fixed: the thing that made the answer *no* in any season. A crew member could join
a company and do nothing — 31 routes, the entire field product, 403. That line is gone, each route
states its own requirement, the three exceptions are enforced server-side rather than hidden, and the
dashboard is absent from both clients and refused by the API independently.

Since then: a crew member is no longer told two of their seven screens are broken when they are not
(L79), and a diary approval now means a supervisor said so (L81). Those were the two items on the
previous list that were nobody's to fix but the owner's.

What stands between here and yes:

1. **The table has to go green in CI.** Until then, everything in §2 is a well-built instrument that has not been read. This is the one that could still change the answer, and it resolves on this PR. The in-memory half is green here, including both red-on-revert runs, so the risk is narrower than it was — but Postgres is where authorisation is actually enforced and that has still not run. Narrower in a smaller way than before, too: the id-parity and ownership rows have no in-memory half, so for the two rows that matter most there is nothing to be reassured by yet.
2. **The device pass has to happen.** Every mobile claim in this branch is unverified by construction. A crew member clocking in on a site is exactly the path no test here has executed, and this branch added a control to that path (the Approve button's new condition) rather than only removing them.

Both are work I have set up and cannot finish from this machine. Neither is a question I am waiting
on an answer to — which is the real difference from the last time this section was written.

Two things I would not call settled, though neither blocks December. Crew can still revert an
approved diary to draft (L86) — a decision made in the direction of not extending a refusal unasked,
and the item in this branch I would most expect the owner to change. And voiding an inspection
signature is open to everybody (L91), which is the same kind of decision made for a different
reason: there is no author column to gate on, so closing it means either a role gate or a migration.

One thing I would say about the shape of the work rather than the product. Both gaps in §0 were in
the gap between the in-memory store and Postgres — L87, L88, L89 and L90 are all that shape, which
is L65's — and three of the four were invisible to a suite that runs almost entirely in-memory. The
seventeen commits on this branch moved every one of those predicates into one module whose two
functions both stores call. That is the change I would defend, more than any individual gate.

---

*Ends. No secrets, credentials, personal phone numbers or email addresses appear in this document or
in the branch.*
