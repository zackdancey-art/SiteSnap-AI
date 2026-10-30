import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FORBIDDEN_MESSAGE,
  TIMECARD_APPROVAL_STATUSES,
  TIMECARD_EDITABLE_STATUSES,
  TIMECARD_LOCKED_CODE,
  TIMECARD_LOCKED_MESSAGE,
  canApproveDiary,
  canApproveTimesheet,
  canChangeCompanySettings,
  canDeleteSite,
  canFileSiteUnderClient,
  canSetSiteJobNumber,
  canInvite,
  canManageClients,
  canSeeSiteBin,
  canManageSiteMembers,
  canSeeSupervisorDashboard,
  canVoidSignature,
  describeFailure,
  isForbidden,
  isTimecardEditable,
  isTimecardLocked,
  normaliseApprovalStatus,
} from "./permissions";
import * as permissionsModule from "./permissions";
import { SESSION_EXPIRED_MESSAGE, SessionExpiredError, isSessionExpired } from "./session";

/**
 * WHY THESE TESTS EXIST AT ALL
 *
 * Mobile cannot be screenshotted from this environment: there is no simulator
 * and no device attached to it. So for the UI half of a permission decision,
 * this file is the only verification available, and it is the reason
 * lib/permissions.ts holds the decision rather than each screen holding its own
 * copy of the expression. The RENDERING still has to be checked by hand on a
 * device — that is in the PR's device checklist, stated as unverified.
 *
 * The second half of the file is the one the phase was most worried about, and
 * it is not about rendering at all. See the comment above its tests.
 */

const ROLES = ["crew", "viewer", "manager", "owner"] as const;

test("the supervisor dashboard is for managers and owners, and for nobody else", () => {
  // Both directions, every role, because "crew are refused" and "everybody is
  // refused" are the same assertion when only crew is checked — and the second
  // is a plausible way to get this wrong, since the predicate it replaced was
  // inlined in three files.
  assert.equal(canSeeSupervisorDashboard("owner"), true);
  assert.equal(canSeeSupervisorDashboard("manager"), true);
  assert.equal(canSeeSupervisorDashboard("viewer"), false);
  assert.equal(canSeeSupervisorDashboard("crew"), false);
});

test("the three exceptions refuse crew and allow the roles that own them", () => {
  // Exception 1: inviting is the manager's job.
  assert.equal(canInvite("crew"), false);
  assert.equal(canInvite("manager"), true);
  assert.equal(canInvite("owner"), true);

  // Exception 2: removing a site. The bin now exists -- see canSeeSiteBin
  // below -- and the gate is unchanged, which is itself the decision.
  assert.equal(canDeleteSite("crew"), false);
  assert.equal(canDeleteSite("manager"), true);
  assert.equal(canDeleteSite("owner"), true);

  // The bin is gated WITH the deletion, not above or below it: whoever can put
  // a site in it can take it out. Both routes behind it are
  // requireAtLeast("manager"), so a wider predicate here would render a
  // Settings row that can only 403, which reads as a broken feature.
  // Messages on all four: the bin lists sites a person may restore, and both
  // routes behind it are requireAtLeast("manager"). A bare `true !== false` on
  // this line tells whoever broke it nothing about which half of that moved.
  assert.equal(canSeeSiteBin("crew"), false, "crew must not be shown the bin: the API 403s both its routes");
  assert.equal(canSeeSiteBin("viewer"), false, "viewer must not be shown the bin: the API 403s both its routes");
  assert.equal(canSeeSiteBin("manager"), true, "manager must be shown the bin, or the row is missing for the people it is for");
  assert.equal(canSeeSiteBin("owner"), true, "owner must be shown the bin, or the row is missing for the people it is for");
  for (const role of ROLES) {
    assert.equal(
      canSeeSiteBin(role),
      canDeleteSite(role),
      `${role}: seeing the bin and deleting a site must stay the same permission`
    );
  }

  // Exception 3: company settings, owner-only — stricter than the other two,
  // matching requireCompanyRole("owner") on PATCH /company/profile.
  assert.equal(canChangeCompanySettings("crew"), false);
  assert.equal(canChangeCompanySettings("manager"), false);
  assert.equal(canChangeCompanySettings("owner"), true);

  // The symmetrical half of inviting.
  assert.equal(canManageSiteMembers("crew"), false);
  assert.equal(canManageSiteMembers("manager"), true);
});

test("crew are the only operational role refused nothing else — every predicate here is an exception", () => {
  // The decision is "everything a manager can, except these". So the only
  // predicates in this module should be the exceptions, and a crew member must
  // be refused by all of them and granted by none. If a future predicate grants
  // crew something, it does not belong in a module of exceptions and this test
  // should be the thing that says so.
  // ENUMERATED FROM THE MODULE, NOT LISTED BY HAND.
  //
  // This was a hand-written array of seven, and a hand-written array is how the
  // rule above stops being enforced: the next predicate added to the module is
  // not in it, so "every predicate here is an exception" quietly becomes "the
  // seven predicates somebody remembered are". Eight other workstreams add
  // predicates to this module; by the tree this branch merges into there are
  // eleven, and a hand-written seven would have tested four of them not at all
  // while still reading green.
  //
  // Keyed on the `can` prefix, which is the module's own naming convention for
  // a permission predicate -- `isForbidden` and `describeFailure` answer
  // questions about an error, not about a role.
  const predicates = Object.entries(permissionsModule)
    .filter(([name, value]) => name.startsWith("can") && typeof value === "function")
    .map(([, value]) => value as (role: unknown) => boolean);

  // The control on the derivation. Without it, a filter that matched nothing
  // would make the loop below iterate zero times and pass — the vacuity shape
  // docs/VACUITY-AUDIT.md names.
  //
  // AN EQUALITY, NOT A FLOOR, per AUDIT L112. The previous line read
  // `>= 8` against a population of 11, which is the exact shape L112 was filed
  // about: a hand-written floor cannot fail upward, so it read green against a
  // tree it no longer described. The population here is knowable — it is
  // derived two lines above from this module's own exports — so it gets pinned
  // exactly.
  //
  // Adding a predicate therefore fails this line, and that is the intended
  // friction rather than a cost: the loop below is what proves every predicate
  // refuses crew, and the whole value of this count is to make a change in the
  // population something a human has to look at. Update the number in the same
  // commit that adds the predicate.
  //
  // MEASURED 12 on feat/pr2-job-number: canSeeSupervisorDashboard, canInvite,
  // canDeleteSite, canSeeSiteBin, canManageSiteMembers, canApproveDiary,
  // canManageClients, canFileSiteUnderClient, canApproveTimesheet,
  // canVoidSignature, canChangeCompanySettings, canSetSiteJobNumber.
  //
  // 11 -> 12 for canSetSiteJobNumber. The branches in this batch stack, so this
  // is measured at its real position (PR 0 -> PR 1 -> PR 2) rather than needing
  // a back-port when the ones ahead of it land.
  assert.equal(
    predicates.length,
    12,
    `expected exactly 12 permission predicates, found ${predicates.length} — ` +
      "if you added or removed one, update this count in the same commit"
  );
  assert.ok(
    predicates.includes(canSeeSupervisorDashboard),
    "control: the derivation must actually be finding this module's predicates"
  );

  for (const p of predicates) {
    assert.equal(p("crew"), false, `${p.name} must refuse crew`);
    assert.ok(
      p("owner"),
      `${p.name} must allow an owner — a predicate that refuses everybody is not a permission`
    );
  }
});

test("approving a diary is manager+, and that is not the same as using diaries", () => {
  // AUDIT L81. Matches requireAtLeast("manager") on the `status` field at the
  // API: a submitted diary is a claim, an approved one is the record, and the
  // portal presents an approval rate as oversight.
  assert.equal(canApproveDiary("crew"), false);
  assert.equal(canApproveDiary("viewer"), false);
  assert.equal(canApproveDiary("manager"), true);
  assert.equal(canApproveDiary("owner"), true);

  // THE ROW THAT MATTERS MOST IS NOT HERE, AND CANNOT BE
  //
  // The defect this predicate guards against is not "crew can approve". It is
  // the fix for it being written as "crew cannot use diaries" — which would
  // satisfy every assertion above and be a worse bug than the one it replaced.
  // A unit test of a boolean cannot distinguish those two, because the
  // difference is in what ELSE the diary screen still does. The assertion that
  // separates them is a crew content-edit returning 200 on the same route in
  // the same test as the refused approval, and it lives in the API's
  // routes/crew-permissions-db.test.ts, against Postgres.
  //
  // What this file can establish is that the module gained exactly one
  // predicate and not a diary predicate: there is no canUseDiaries,
  // canEditDiary or canWriteDiary to be found, because nothing about editing
  // one is conditional on role.
  assert.deepEqual(
    Object.keys(permissionsModule).filter((k) => /diar/i.test(k)),
    ["canApproveDiary"],
    "exactly one diary predicate — a second one is probably a refusal of editing"
  );
});

test("managing clients and filing a site are manager+, and READING the client list is not gated at all", () => {
  // Both match requireAtLeast("manager") — the three writes on routes/clients.ts
  // and PATCH /projects/sites/:id respectively.
  assert.equal(canManageClients("crew"), false);
  assert.equal(canManageClients("viewer"), false);
  assert.equal(canManageClients("manager"), true);
  assert.equal(canManageClients("owner"), true);

  assert.equal(canFileSiteUnderClient("crew"), false);
  assert.equal(canFileSiteUnderClient("viewer"), false);
  assert.equal(canFileSiteUnderClient("manager"), true);
  assert.equal(canFileSiteUnderClient("owner"), true);

  // THE ROW THIS FILE EXISTS TO PROTECT, and it is a negative one.
  //
  // GET /clients is behind identity alone, deliberately: the site a crew member
  // is standing on is filed under one of these names, and the client list is
  // how the grouped site list gets its headings. So the wrong fix here — the
  // one that would satisfy every assertion above — is a canSeeClients predicate
  // that hides the list from crew, turning a filing feature into an access
  // boundary the API does not have. There must be no read predicate to find.
  //
  // Same measurement as the diary case below: the module's own exports, not a
  // claim about them.
  assert.deepEqual(
    Object.keys(permissionsModule)
      .filter((k) => /client/i.test(k))
      .sort(),
    ["canFileSiteUnderClient", "canManageClients"],
    "two client predicates, both about WRITING — a third is probably a read gate the API has not got"
  );
});

test("setting a job number is manager+, and READING one is not gated at all", () => {
  // Matches requireAtLeast("manager") on PATCH /projects/sites/:id/job-number.
  // Both directions, every role: "crew are refused" and "everybody is refused"
  // are the same assertion when only crew is checked, and a predicate that
  // refuses everybody would hide the editor from the managers it is for.
  assert.equal(canSetSiteJobNumber("crew"), false);
  assert.equal(canSetSiteJobNumber("viewer"), false);
  assert.equal(canSetSiteJobNumber("manager"), true);
  assert.equal(canSetSiteJobNumber("owner"), true);

  // THE NEGATIVE ROW, and it is the same trap as the client list above.
  //
  // The wrong fix here is a canSeeJobNumber predicate. A crew member standing
  // on a site needs to read the job number — it is the reference they are asked
  // for on the phone — and GET /projects/sites is behind identity alone, so a
  // read gate on the client would hide something the API hands over freely and
  // turn an administrative edit into an access boundary. There must be no read
  // predicate to find, measured from the module's own exports rather than
  // claimed.
  assert.deepEqual(
    Object.keys(permissionsModule)
      .filter((k) => /job/i.test(k))
      .sort(),
    ["canSetSiteJobNumber"],
    "exactly one job-number predicate — a second is probably a read gate the API has not got"
  );
});

test("voiding a signature is manager+, and signing one is not", () => {
  // AUDIT L91. Matches requireAtLeast("manager") on
  // POST /inspections/:id/signatures/:sigId/void.
  assert.equal(canVoidSignature("crew"), false);
  assert.equal(canVoidSignature("viewer"), false);
  assert.equal(canVoidSignature("manager"), true);
  assert.equal(canVoidSignature("owner"), true);

  // The same shape of trap as the diary predicate, in its sharpest form here:
  // the fix for "crew can void" must not become "crew cannot sign". Crew are
  // the inspectors — the signature this gate protects is usually theirs — so a
  // canSignInspection predicate would be the defect, not the fix, and the
  // assertion that no such predicate exists is the only one this file can make
  // about it. The positive half, crew signing and being refused the void on the
  // same inspection, is a Postgres probe in the API's
  // routes/crew-permissions-db.test.ts.
  assert.deepEqual(
    Object.keys(permissionsModule).filter((k) => /sign(ature)?/i.test(k)),
    ["canVoidSignature"],
    "exactly one signature predicate — a second one is probably a refusal of signing"
  );
});

test("an unrecognised or absent role gets the least access, never the most", () => {
  // user.companyRole is rehydrated from storage and from a token payload, so an
  // older build or a hand-edited store can put anything here. Failing towards
  // "no access" is the opposite of lib/session.ts, where an unknown 401 code
  // fails towards sign-in, and the asymmetry is deliberate: there the cost of
  // being wrong is one sign-in, here it is drawing a control somebody may not
  // use.
  for (const value of [undefined, null, "", "Owner", "OWNER", "admin", "supervisor", 3, {}, []]) {
    assert.equal(
      canSeeSupervisorDashboard(value as unknown),
      false,
      `${JSON.stringify(value)} must not pass as a role`
    );
    assert.equal(canDeleteSite(value as unknown), false);
    assert.equal(canChangeCompanySettings(value as unknown), false);
  }
  // Control: the exact strings still work, so the above is strictness and not
  // a predicate that has stopped recognising anything.
  assert.deepEqual(
    ROLES.map(canSeeSupervisorDashboard),
    [false, false, true, true]
  );
});

/**
 * A 403 IS NOT A DEAD SESSION — the other dimension of AUDIT L73.
 *
 * L73 was closed by routing every 401 that carries a session code to the
 * sign-in screen, from one place, because seven screens had each invented their
 * own wording for "your session is over". This phase generates authorisation
 * failures ON PURPOSE: a crew member who reaches a manager-only route gets a
 * 403, and 403 means "you are who you say you are and you may not do this" —
 * the opposite of a dead session.
 *
 * So signing a crew member out every time they touch a manager-only screen
 * would be a worse bug than the one the phase fixes, and it is one line away:
 * isSessionExpired() keys on the status, and 401 and 403 are adjacent integers.
 * These tests prove the discrimination rather than assuming it, and each
 * carries the 401 in the same test — without that control, deleting the whole
 * session-expiry mechanism would leave every "403 does not sign out" assertion
 * green.
 */

test("a 403 does not route to sign-in, and a 401 in the same test still does", () => {
  const forbidden = { status: 403, code: "insufficient_permissions", body: { error: "Insufficient permissions." } };
  assert.equal(isSessionExpired(forbidden), false, "a 403 must not be read as an expired session");
  assert.equal(isForbidden(forbidden), true, "and it must be recognised as what it is");

  // The same object shape with the status that DOES mean the session is over.
  const expired = { status: 401, code: "session_expired" };
  assert.equal(isSessionExpired(expired), true, "control: a 401 session code must still route to sign-in");
  assert.equal(isForbidden(expired), false, "a 401 is not an authorisation refusal");

  // And the error the helpers actually throw, not a hand-made object.
  assert.equal(isSessionExpired(new SessionExpiredError()), true);
  assert.equal(isForbidden(new SessionExpiredError()), false);
});

test("a 403 carrying no code, or a session-shaped code, still does not route to sign-in", () => {
  // isSessionErrorCode() treats an ABSENT code as session-shaped on purpose —
  // it fails towards sign-in, because the client can be newer than the deployed
  // API. That rule is scoped to a 401 by isSessionExpired's status check, and
  // this is the test that it is scoped: a 403 with no code at all, and even a
  // 403 wrongly carrying "session_expired", must not sign anybody out.
  assert.equal(isSessionExpired({ status: 403 }), false);
  assert.equal(isSessionExpired({ status: 403, code: "session_expired" }), false);
  assert.equal(isSessionExpired({ status: 403, code: "" }), false);

  // Control: the absent-code rule is live where it belongs.
  assert.equal(isSessionExpired({ status: 401 }), true, "control: a bare 401 must still route to sign-in");
});

test("a 403 says something true, and a feature failure keeps its own wording", () => {
  // The habit L73 named was a failure reported as something it was not. The two
  // ways to repeat it here are to show the session message (which would be a
  // lie AND a sign-out) or "Failed to load" (which says the feature is broken).
  const forbidden = { status: 403 };
  assert.equal(describeFailure(forbidden, "Could not delete this site."), FORBIDDEN_MESSAGE);
  assert.notEqual(FORBIDDEN_MESSAGE, SESSION_EXPIRED_MESSAGE, "the two refusals must not read the same");
  assert.doesNotMatch(FORBIDDEN_MESSAGE, /failed|try again|error/i, "it must not blame the feature or invite a retry");
  assert.match(FORBIDDEN_MESSAGE, /access/i, "it must name the actual cause");

  // CONTROL: a genuine feature failure is NOT relabelled. If describeFailure
  // returned FORBIDDEN_MESSAGE for everything, every assertion above would pass
  // and the app would answer "you don't have access to this" for a timeout.
  const broken = { status: 500 };
  assert.equal(describeFailure(broken, "Could not delete this site."), "Could not delete this site.");
  assert.equal(describeFailure(new Error("Network request failed"), "Could not save."), "Could not save.");
  assert.equal(describeFailure(undefined, "Could not save."), "Could not save.");
});

test("approving a timesheet is manager+, and that is not the same as using timesheets", () => {
  assert.equal(canApproveTimesheet("crew"), false);
  assert.equal(canApproveTimesheet("viewer"), false);
  assert.equal(canApproveTimesheet("manager"), true);
  assert.equal(canApproveTimesheet("owner"), true);

  // The same hazard as canApproveDiary, and the same limit on what a unit test
  // of a boolean can show. The defect to avoid is not "crew can approve their
  // own hours"; it is that fix being written as "crew cannot use timesheets",
  // which would satisfy all four assertions above and remove the daily work the
  // screen exists for. The assertion that separates them is a crew member's own
  // edit returning 200 on the same route in the same test as their refused
  // approval, and it lives in the API's routes/crew-timecards-db.test.ts
  // against Postgres (test 2, the rank gate, and test 8, crew see only their
  // own).
  //
  // What this file can establish is that the module gained exactly one
  // timesheet predicate: there is no canUseTimesheets, canEditTimecard or
  // canDeleteTimecard, because none of those is conditional on role.
  assert.deepEqual(
    Object.keys(permissionsModule).filter((k) => /timesheet|timecard/i.test(k) && /^can/.test(k)),
    ["canApproveTimesheet"],
    "exactly one timesheet predicate — a second one is probably a refusal of editing"
  );
});

/**
 * AN APPROVED TIMECARD IS A THIRD KIND OF REFUSAL.
 *
 * The screen can now be refused three ways and they mean three different
 * things: 401 the session is over and the app navigates; 403 the caller lacks
 * the rank and a more senior person could do it; 409 the ROW is approved and
 * nobody's rank opens it, including the manager who approved it. The remedy
 * differs in each case, so a client that collapses any two of them tells
 * somebody to do something that will not work.
 *
 * The mobile half of this is also the only thing standing between a person and
 * a UI that lies about data loss: handleDelete used to swallow the failure and
 * drop the row from the list regardless, so with this 409 in place an approved
 * card would vanish from the screen while the server kept it.
 */

test("an approved timecard reads as locked, and the adjacent refusals do not", () => {
  // The refusal as routes/crew.ts actually sends it.
  const locked = {
    status: 409,
    code: TIMECARD_LOCKED_CODE,
    body: { error: "This timecard has been approved and can no longer be changed. Ask a manager to reopen it.", code: TIMECARD_LOCKED_CODE, approvalStatus: "approved" },
  };
  assert.equal(isTimecardLocked(locked), true, "the 409 the API sends must be recognised");

  // CONTROLS, in this test, because "everything is locked" and "the lock is
  // recognised" are the same assertion when only the lock is checked.
  assert.equal(isTimecardLocked({ status: 403, code: TIMECARD_LOCKED_CODE }), false, "a 403 is a rank refusal, not a locked row");
  assert.equal(isTimecardLocked({ status: 409 }), false, "a bare 409 is some other conflict");
  assert.equal(isTimecardLocked({ status: 409, code: "other_conflict" }), false);
  assert.equal(isTimecardLocked({ status: 200 }), false);
  assert.equal(isTimecardLocked(new Error("Network request failed")), false);
  assert.equal(isTimecardLocked(undefined), false);
  assert.equal(isTimecardLocked(null), false);

  // And it is not a dead session in either direction.
  assert.equal(isSessionExpired(locked), false, "a locked row must not sign anybody out");
  assert.equal(isForbidden(locked), false, "a locked row is not an authorisation refusal");
  assert.equal(isSessionExpired({ status: 401, code: "session_expired" }), true, "control: a 401 still routes to sign-in");
  assert.equal(isForbidden({ status: 403 }), true, "control: a 403 is still an authorisation refusal");
});

test("the three refusals read as three different things, and a feature failure keeps its own wording", () => {
  const featureMessage = "Failed to save timecard.";
  assert.equal(
    describeFailure({ status: 409, code: TIMECARD_LOCKED_CODE }, featureMessage),
    TIMECARD_LOCKED_MESSAGE
  );
  assert.equal(describeFailure({ status: 403 }, featureMessage), FORBIDDEN_MESSAGE);

  // CONTROL: a genuine feature failure, and a 409 that is not this one, both
  // keep the feature's wording. Without this, returning the lock message for
  // everything would pass every assertion above.
  assert.equal(describeFailure({ status: 500 }, featureMessage), featureMessage);
  assert.equal(describeFailure({ status: 409 }, featureMessage), featureMessage);
  assert.equal(describeFailure(new Error("boom"), featureMessage), featureMessage);

  // The three sentences must not be interchangeable.
  assert.notEqual(TIMECARD_LOCKED_MESSAGE, FORBIDDEN_MESSAGE);
  assert.notEqual(TIMECARD_LOCKED_MESSAGE, SESSION_EXPIRED_MESSAGE);
  assert.notEqual(TIMECARD_LOCKED_MESSAGE, featureMessage);

  // It must name the remedy rather than blaming the feature or the person. The
  // 403 message deliberately offers no remedy because there is none; this one
  // has one, and withholding it is the whole difference between the two.
  assert.doesNotMatch(TIMECARD_LOCKED_MESSAGE, /failed|try again|error/i);
  assert.match(TIMECARD_LOCKED_MESSAGE, /reopen/i);
  assert.doesNotMatch(FORBIDDEN_MESSAGE, /reopen/i, "control: the rank refusal must not suggest reopening anything");
});

test("an unrecognised or absent approval status reads as pending, not as locked", () => {
  // The three real states first, as the positive control. Without these,
  // returning "pending" unconditionally would pass every assertion below and
  // the test would be checking a constant.
  assert.equal(normaliseApprovalStatus("pending"), "pending");
  assert.equal(normaliseApprovalStatus("approved"), "approved");
  assert.equal(normaliseApprovalStatus("rejected"), "rejected");

  // And the list those three came from is the whole list, so a fourth status
  // added to the API without being added here fails this rather than appearing
  // silently as "pending" on every card.
  assert.deepEqual([...TIMECARD_APPROVAL_STATUSES], ["pending", "approved", "rejected"]);

  // Everything else falls to "pending", which is the direction that keeps the
  // controls usable. The cost of being wrong this way is one clear 409 from
  // the server; the cost of the other way is edit and delete greyed out on
  // every card with no error raised anywhere.
  for (const value of [
    undefined,
    null,
    "",
    "APPROVED",        // the API's values are lower case; a case-insensitive
                       // match here would be a contract the server does not have
    "approved ",       // and no trimming either, for the same reason
    "archived",        // a status a later API might add
    "locked",
    0,
    1,
    true,
    {},
    [],
    ["approved"],
    () => "approved",
  ]) {
    assert.equal(
      normaliseApprovalStatus(value),
      "pending",
      `${String(value)} should read as pending, so an out-of-date build stays usable`
    );
  }

  // CONTROL on the direction, stated as an assertion rather than as a comment:
  // whatever the fallback is, it must be a state the author can still edit.
  // A default of "approved" would satisfy "returns a known status" and lock
  // every card in the app.
  assert.ok(
    isTimecardEditable(normaliseApprovalStatus("something new")),
    "the fallback status must be an editable one, or an out-of-date build locks every card"
  );
});

test("an approved timecard is the only one its author cannot edit", () => {
  // Positive controls first: the two states that stay open.
  assert.equal(isTimecardEditable("pending"), true);
  assert.equal(isTimecardEditable("rejected"), true);

  // The refusal. This is the feature — a payroll row anybody can still edit
  // was never approved in any useful sense.
  assert.equal(isTimecardEditable("approved"), false);

  // Derived from the module rather than written out, so the next status added
  // to TIMECARD_APPROVAL_STATUSES is covered without anybody remembering to
  // extend this test. The hand-written version of the predicate list in this
  // file was already one entry short of the module by the time it mattered.
  const editable = TIMECARD_APPROVAL_STATUSES.filter(isTimecardEditable);
  const locked = TIMECARD_APPROVAL_STATUSES.filter((s) => !isTimecardEditable(s));
  assert.deepEqual([...editable], [...TIMECARD_EDITABLE_STATUSES]);
  assert.deepEqual(locked, ["approved"], "exactly one status locks a card, and it is approval");

  // Both sides non-empty, so neither "everything is editable" nor "nothing is"
  // can pass. A predicate returning a constant satisfies one of the two
  // deepEquals above on its own.
  assert.ok(editable.length > 0, "no status is editable — the screen would offer no edit at all");
  assert.ok(locked.length > 0, "no status is locked — approval would not lock anything");

  // The sentence shown when the lock is hit has to be true of this exact set:
  // it names approval, because approval is what locks, and a sent-back card is
  // still editable.
  assert.match(TIMECARD_LOCKED_MESSAGE, /approved/i);
  assert.doesNotMatch(
    TIMECARD_LOCKED_MESSAGE,
    /sent back|rejected/i,
    "control: a rejected card is editable, so the lock message must not claim otherwise"
  );
});
