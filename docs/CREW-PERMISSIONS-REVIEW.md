# Phase 1b — Crew Permissions — review

Branch `feat/crew-permissions`, five commits off `63b5fe3`. 11 October 2026.

The phase exists to answer one question — *would you now hand a crew member this app on a site in
December?* — and the honest answer is at the bottom, after the evidence that supports it.

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

### Item 5 — the table (`897fc80`, API deploy)

`routes/crew-permissions-db.test.ts`, 422 lines, DB-gated. Covered in §2.

---

## 2. What the measurement does and does not establish

The verification standard for this phase was explicit: anything touching authorisation needs a test
against Postgres, in the DB-gated suite, with **both** controls on the same route in the same test.

The test is written to that standard. Three populations are pinned —
`EXPECTED_READS = 15`, `EXPECTED_WRITE_STEPS = 13`, `EXPECTED_REFUSALS = 15` — so a sweep that
quietly measures nothing fails instead of passing. The crew member is a **real invitee**: the owner
invites at `role: "crew"`, the crew member registers with the token, accepts, and the test uses the
fresh token the accept route issues. That matters because L66's second finding was that
`company-rbac.test.ts` registered its "crew" member *without* an invite token, which makes them the
owner of a solo company, accepts at rank owner, and demotes afterwards — a journey no real invitee
takes, and the reason a green suite hid two critical findings.

And the table is not circular. A precondition test reads both tokens with `verifyAuthToken` and
asserts the roles they actually carry, with the failure messages saying why:

> *the crew token does not carry companyRole crew, so no 403 below proves anything about crew*

**What could not be done here, plainly.** This machine has no Postgres and no container runtime —
checked again this session. `pnpm --filter services-api run test:db` reports **10 tests, 0 pass, 10
skipped**. The three-row table has therefore **never been executed on this machine**. CI runs
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

Five new AUDIT entries, L79–L83, all discovered while measuring rather than while building.

- **L79** — the portal's Team and Settings screens call `/company/profile` unconditionally, so crew meet *"failed to load"* rather than a refusal. This is the L73 habit in a new place: a refusal reported as a breakage. Not fixed, because what those two screens should *show* a crew member is a product decision with three non-equivalent shapes.
- **L80** — `projectsStore.canManageSite` admits a crew or viewer who personally owns a site. An owner demoted to crew still satisfies it for every site they created. The manager+ gates close the reachable half; the store predicate is unchanged because narrowing it removes rights from existing rows.
- **L81** — any authenticated company member can approve a site diary, including its author. Crew could not reach it before only because L66 refused them the router. This is the one I would most want a second opinion on: approval is a supervisory attestation on a seven-year record, and the portal presents an "approval rate" computed from it as oversight.
- **L82** — `company.ts` carries the same pathless `use` as L66, harmless only because it is mounted last and because the middleware is `requireAuth` rather than a rank gate. Neither reason survives a reordering.
- **L83** — `useRole()` resolves an absent `companyRole` to `viewer`. Left alone, and the new dashboard predicate deliberately reads the raw value instead, so it does not inherit a default written for another purpose.

Beyond the AUDIT entries, two things are worth the owner's eye and are in the PR body:

**`POST /projects/sites` was made manager+, and that is a fourth exception the decision does not
name.** The decision lists three. My reasoning: creating a site is a setup act rather than daily
work, and since crew cannot delete a site and the bin does not exist yet, a site a crew member
created by accident would be permanent. That is a judgement I made and it may be the wrong one — it
is the single item in this branch most likely to need reverting, and reverting it is one line.

**The portal's login copy still reads "Owner and manager accounts only." and is still not enforced.**
It was already untrue; after this phase it is further from true, because crew now get a working
portal behind it.

---

## 5. What was not done, and why

- **The Postgres table was not run.** No Postgres here. CI produces it. Stated rather than papered over.
- **Mobile was not screenshotted.** It cannot be from this environment. The device checklist in the PR body says so plainly rather than implying coverage.
- **L79, L80, L81 were not fixed.** Each is a decision rather than a refactor, and two of them change what someone may do.
- **`company.ts` was left alone.** Outside the phase's file set, and changing its pathless `use` alters 401-versus-404 behaviour on unmatched paths, which is observable.
- **The mobile dashboard (manager+) and the portal dashboard (viewer+) were not unified.** Pre-existing asymmetry; either direction changes what a viewer can do, which is not this change's call.

---

## 6. What cannot be verified without you

1. **The permission table.** It runs for the first time in CI on this PR. If any row disagrees with the decision, that is the place it will show.
2. **Every mobile claim.** The navigator change, the hidden controls and the 403 copy are unverified on a device. The checklist in the PR body is the instrument; step zero is Settings → About naming the running bundle, because results from a stale binary are not results.
3. **`POST /projects/sites` at manager+.** A decision, not a finding.
4. **L81, diary self-approval.** Measured as crew 200. Whether that is correct is yours.
5. **What Team and Settings should show crew** (L79).

---

## 7. The question this phase exists to answer

> *Having measured it, would you now hand a crew member this app on a site in December?*

**Not yet — but the gap is now small, specific, and three of the four items are measurement rather
than construction.**

What is genuinely fixed: the thing that made the answer *no* in any season. A crew member could join
a company and do nothing — 31 routes, the entire field product, 403. That line is gone, each route
states its own requirement, the three exceptions are enforced server-side rather than hidden, and the
dashboard is absent from both clients and refused by the API independently.

What stands between here and yes:

1. **The table has to go green in CI.** Until then, everything in §2 is a well-built instrument that has not been read. This is the one that could still change the answer, and it resolves on this PR.
2. **The device pass has to happen.** Every mobile claim in this branch is unverified by construction. A crew member clocking in on a site is exactly the path no test here has executed.
3. **L79 has to be decided.** Two of the seven screens a crew member is offered say *"failed to load"*. That is not a safety problem; it is the kind of thing that makes somebody stop trusting the app in week one, which in December matters more than it reads on paper.
4. **L81 has to be decided.** Crew approving their own diaries is either the decision working as intended or a hole in a compliance record, and I cannot tell which from here.

Two of those are yours to answer and I have put them where you will see them. The other two are
work I have set up and cannot finish from this machine. If the table goes green and the device pass
is clean, I would say yes.

---

*Ends. No secrets, credentials, personal phone numbers or email addresses appear in this document or
in the branch.*
