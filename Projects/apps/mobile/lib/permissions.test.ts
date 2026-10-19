import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FORBIDDEN_MESSAGE,
  TIMECARD_LOCKED_CODE,
  TIMECARD_LOCKED_MESSAGE,
  canApproveDiary,
  canApproveTimesheet,
  canChangeCompanySettings,
  canDeleteSite,
  canInvite,
  canManageSiteMembers,
  canSeeSupervisorDashboard,
  describeFailure,
  isForbidden,
  isTimecardLocked,
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

  // Exception 2: removing a site, until the recoverable bin exists.
  assert.equal(canDeleteSite("crew"), false);
  assert.equal(canDeleteSite("manager"), true);
  assert.equal(canDeleteSite("owner"), true);

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
  //
  // DERIVED FROM THE MODULE'S EXPORTS, not listed by hand. The hand-written
  // version of this array sat here for one phase and was already one predicate
  // short of the module by the time canApproveTimesheet landed — a list that
  // has to be maintained alongside the thing it is checking is a list that
  // stops checking the newest entry, which is the only one worth checking.
  const predicates = Object.entries(permissionsModule)
    .filter(([name, value]) => /^can/.test(name) && typeof value === "function")
    .map(([, value]) => value as (role: unknown) => boolean);
  assert.ok(
    predicates.length > 0,
    "no can* predicates were found — the loop below would assert nothing"
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
