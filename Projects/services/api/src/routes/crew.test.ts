/**
 * Tests for the in-memory half of /api/crew/timecards: span validation, and
 * the approval state machine.
 *
 * WHAT THIS FILE IS AND IS NOT FOR. The authoritative coverage of the approval
 * workstream is `crew-timecards-db.test.ts`, against Postgres — every
 * permission, ownership and tenancy assertion lives there, because the
 * in-memory store and the Postgres store are two implementations and this one
 * has no RLS, no CHECK constraints and no row locks. What is here is the part
 * that is worth having twice: the STATE MACHINE, written out separately in each
 * store. Two stores (incidents, inspections) once had no ownership check at all
 * on their Postgres write paths while their in-memory twins did — green suite,
 * open door. The same divergence in the other direction is what this covers:
 * an approved row that the in-memory branch lets through would be invisible to
 * the DB suite and would be the behaviour every other test in this suite runs
 * against.
 *
 * ── SPAN VALIDATION ───────────────────────────────────────────────────────
 *
 * The defect: nothing validated the start/finish span, so a finish time BEFORE
 * its start was accepted and stored. The mobile client's calcHours clamps the
 * negative result with Math.max(0, ...), and hoursRegular allows 0, so the
 * nonsense arrived here already laundered into a plausible payroll row reading
 * 0.0h — wrong, and indistinguishable from a legitimately empty one.
 *
 * Overnight shifts are not supported today (calcHours is plain subtraction with
 * no day rollover and already yields 0.0h for one), so rejecting a non-positive
 * span removes no working behaviour.
 */

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests } from "../storage/projectsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import { TIMECARD_APPROVAL_STATUSES } from "../storage/crewStore";
import { verifyAuthToken } from "../utils/authToken";

let server: http.Server;
let baseUrl: string;

async function req<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      `${baseUrl}/api${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as T }); }
          catch { reject(new Error(`Non-JSON (${res.statusCode}): ${data}`)); }
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

let _phoneSeq = 0;
function nextPhone() { return `+614${String(++_phoneSeq).padStart(8, "0")}`; }

/** Register + verify a user, returning their auth token. */
async function registerUser(email: string): Promise<string> {
  const regRes = await req<{ devCodes?: { emailCode: string } }>(
    "POST", "/auth/register",
    { email, phone: nextPhone(), fullName: "Timecard Tester", password: "Password123!!" }
  );
  assert.equal(regRes.status, 200, `register failed: ${JSON.stringify(regRes.body)}`);
  const { emailCode } = regRes.body.devCodes!;
  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email, emailCode }
  );
  const { smsCode } = veRes.body.devCodes!;
  const verRes = await req<{ token: string }>(
    "POST", "/auth/register/verify", { email, smsCode }
  );
  assert.equal(verRes.status, 201, `verify failed: ${JSON.stringify(verRes.body)}`);
  return verRes.body.token;
}

/** A timecard payload shaped exactly as the mobile client sends one. */
function timecard(over: Record<string, unknown> = {}) {
  return {
    siteId: "site-under-test",
    workerName: "A Builder",
    trade: "",
    date: "2026-10-03",
    startTime: "07:00",
    endTime: "15:30",
    breakMinutes: 30,
    hoursRegular: 8,
    hoursOvertime: 0,
    notes: "",
    ...over,
  };
}

before(async () => {
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

beforeEach(() => {
  resetAuthStoreForTests();
  resetProjectStoreForTests();
  resetRateLimitStoreForTests();
});

test("crew timecards: a finish before its start is rejected with 400 naming endTime", async () => {
  const token = await registerUser("timecard-span@test.test");

  // The positive control, in this test and against this endpoint. Without it, a
  // 400 proves nothing: a route that rejected EVERY payload — or that 404'd
  // because the path moved — would pass the negative assertion alone.
  const good = await req<{ timecard: { hoursRegular: number } }>(
    "POST", "/crew/timecards", timecard(), token
  );
  assert.equal(good.status, 201, `a valid timecard must still save: ${JSON.stringify(good.body)}`);
  assert.equal(good.body.timecard.hoursRegular, 8);

  // The defect. 17:00 -> 09:00 is the shape that reached production as "0.0h".
  const bad = await req<{ error: string; details?: { fieldErrors?: Record<string, string[]> } }>(
    "POST", "/crew/timecards",
    timecard({ startTime: "17:00", endTime: "09:00", hoursRegular: 0, hoursOvertime: 0 }),
    token
  );
  assert.equal(bad.status, 400, `expected 400, got ${bad.status}: ${JSON.stringify(bad.body)}`);
  assert.match(bad.body.error, /endTime/, "the error must name the offending field");
  assert.ok(
    bad.body.details?.fieldErrors?.endTime?.length,
    `expected a field error on endTime: ${JSON.stringify(bad.body.details)}`
  );
});

test("crew timecards: a card with no clocked times is still accepted", async () => {
  // Both times absent predates this validation and stays legal — hours can be
  // recorded without a clocked span. Asserted explicitly because the span rules
  // are the kind of change that quietly takes an existing path with it.
  const token = await registerUser("timecard-untimed@test.test");
  const res = await req<{ timecard: { id: string } }>(
    "POST", "/crew/timecards",
    timecard({ startTime: undefined, endTime: undefined, breakMinutes: 0, hoursRegular: 6 }),
    token
  );
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.timecard.id, "the timecard should have been created");
});

// ── The approval state machine, in-memory ──────────────────────────────────

/**
 * The transitions, in the store that every other test in this suite runs
 * against.
 *
 * The actor here is the company OWNER — `registerUser` creates a company and
 * makes the registrant its owner — so this file cannot measure a crew member
 * being refused, and does not try to. It measures what the owner can and
 * cannot do, which is where the state machine shows: an owner is never
 * narrowed by `canEditRow`, so a 409 here can only have come from the approval
 * status itself. The crew/owner table is in `crew-timecards-db.test.ts`.
 */
test("crew timecards: an approved card is read-only, and reopening it restores the edit", async () => {
  const token = await registerUser("timecard-approval@test.test");
  const created = await req<{ timecard: { id: string; approvalStatus: string } }>(
    "POST", "/crew/timecards", timecard(), token
  );
  assert.equal(created.status, 201, `the card must save first: ${JSON.stringify(created.body)}`);
  assert.equal(created.body.timecard.approvalStatus, "pending", "a new card did not start pending");
  const id = created.body.timecard.id;

  const edit = (hoursRegular: number, extra: Record<string, unknown> = {}) =>
    req<{ timecard?: { hoursRegular: number; approvalStatus: string }; error?: string; code?: string }>(
      "PATCH", `/crew/timecards/${id}`,
      { ...timecard({ hoursRegular, ...extra }), siteId: undefined, entryId: undefined },
      token
    );

  // The positive control first, so the refusal below is known to be about the
  // approval state and not about the route being shut or the payload rejected.
  const pendingEdit = await edit(9);
  assert.equal(pendingEdit.status, 200, `editing a pending card: ${JSON.stringify(pendingEdit.body)}`);
  assert.equal(pendingEdit.body.timecard?.hoursRegular, 9);

  const approved = await req<{ timecard?: { approvalStatus: string; approvedBy?: string | null } }>(
    "POST", `/crew/timecards/${id}/approval`, { status: "approved" }, token
  );
  assert.equal(approved.status, 200, `approving: ${JSON.stringify(approved.body)}`);
  assert.equal(approved.body.timecard?.approvalStatus, "approved");
  // Taken from the session, never from the body — the same rule the DB suite
  // probes with a claimed `approvedBy`.
  assert.equal(
    approved.body.timecard?.approvedBy?.toLowerCase(),
    "timecard-approval@test.test",
    "approved_by is not the approver"
  );

  const lockedEdit = await edit(12);
  assert.equal(lockedEdit.status, 409, `editing an approved card: ${JSON.stringify(lockedEdit.body)}`);
  assert.equal(lockedEdit.body.code, "timecard_approved");

  const lockedDelete = await req<{ code?: string }>("DELETE", `/crew/timecards/${id}`, undefined, token);
  assert.equal(lockedDelete.status, 409, `deleting an approved card: ${JSON.stringify(lockedDelete.body)}`);

  // Still there and still 9 hours: a 409 with the write already committed would
  // pass both assertions above.
  const listed = await req<{ timecards: Array<{ id: string; hoursRegular: number }> }>(
    "GET", "/crew/timecards?siteId=site-under-test", undefined, token
  );
  assert.equal(listed.status, 200);
  const row = listed.body.timecards.find((t) => t.id === id);
  assert.ok(row, "the approved card was removed by one of the refused requests");
  assert.equal(row.hoursRegular, 9, "an approved card's hours changed");

  // Reopening is the way back, which is what makes the 409 a state rather than
  // a dead end.
  const reopened = await req<{ timecard?: { approvalStatus: string; approvedBy?: string | null } }>(
    "POST", `/crew/timecards/${id}/approval`, { status: "pending" }, token
  );
  assert.equal(reopened.status, 200, `reopening: ${JSON.stringify(reopened.body)}`);
  assert.equal(reopened.body.timecard?.approvedBy ?? null, null, "a reopened card still names an approver");

  const reopenedEdit = await edit(10);
  assert.equal(reopenedEdit.status, 200, `editing a reopened card: ${JSON.stringify(reopenedEdit.body)}`);
  assert.equal(reopenedEdit.body.timecard?.hoursRegular, 10);

  const reopenedDelete = await req("DELETE", `/crew/timecards/${id}`, undefined, token);
  assert.equal(reopenedDelete.status, 200, "a reopened card could not be deleted");
});

test("crew timecards: a rejected card stays editable, so a correction is possible", async () => {
  // The whole point of rejecting rather than deleting: the author fixes it.
  // If `rejected` were locked alongside `approved`, the reject button would be
  // a way to destroy a week's hours with no way back except a manager reopening
  // it, and nothing else in the suite would notice.
  const token = await registerUser("timecard-rejected@test.test");
  const created = await req<{ timecard: { id: string } }>("POST", "/crew/timecards", timecard(), token);
  assert.equal(created.status, 201, `the card must save first: ${JSON.stringify(created.body)}`);
  const id = created.body.timecard.id;

  const rejected = await req<{ timecard?: { approvalStatus: string; approvalNote?: string | null } }>(
    "POST", `/crew/timecards/${id}/approval`, { status: "rejected", note: "Friday looks wrong" }, token
  );
  assert.equal(rejected.status, 200, `rejecting: ${JSON.stringify(rejected.body)}`);
  assert.equal(rejected.body.timecard?.approvalStatus, "rejected");
  assert.equal(rejected.body.timecard?.approvalNote, "Friday looks wrong", "the rejection note was not kept");

  const corrected = await req<{ timecard?: { hoursRegular: number } }>(
    "PATCH", `/crew/timecards/${id}`,
    { ...timecard({ hoursRegular: 7 }), siteId: undefined, entryId: undefined },
    token
  );
  assert.equal(corrected.status, 200, `correcting a rejected card: ${JSON.stringify(corrected.body)}`);
  assert.equal(corrected.body.timecard?.hoursRegular, 7);
});

test("crew timecards: the edit route refuses an approval field rather than dropping it", async () => {
  // Layer one of the field gate. Quietly dropping an unknown key is worse than
  // refusing it: the caller is told the write worked. Layer two — the store's
  // closed `EDITABLE_COLUMNS` list — is what the DB suite probes.
  const token = await registerUser("timecard-strict@test.test");
  const created = await req<{ timecard: { id: string } }>("POST", "/crew/timecards", timecard(), token);
  assert.equal(created.status, 201, `the card must save first: ${JSON.stringify(created.body)}`);
  const id = created.body.timecard.id;

  const base = { ...timecard({ hoursRegular: 8 }), siteId: undefined, entryId: undefined };
  for (const [key, value] of [
    ["approvalStatus", "approved"],
    ["approvedBy", "someone@else.test"],
    ["approvedAt", "2026-10-20T00:00:00.000Z"],
    ["approvalNote", "signed off"],
    ["siteId", "another-site"],
  ] as Array<[string, string]>) {
    const res = await req<{ error?: string; timecard?: { approvalStatus: string } }>(
      "PATCH", `/crew/timecards/${id}`, { ...base, [key]: value }, token
    );
    assert.equal(res.status, 400, `${key} on an edit -> ${res.status} ${JSON.stringify(res.body)}`);
  }

  // The control: the same edit without any of them is accepted, and leaves the
  // approval state alone. Without it, every 400 above is equally consistent
  // with a PATCH route that refuses all payloads.
  const clean = await req<{ timecard?: { hoursRegular: number; approvalStatus: string } }>(
    "PATCH", `/crew/timecards/${id}`, base, token
  );
  assert.equal(clean.status, 200, `a clean edit -> ${clean.status} ${JSON.stringify(clean.body)}`);
  assert.equal(clean.body.timecard?.approvalStatus, "pending", "a successful edit changed the approval state");
});

test("crew timecards: an approval status outside the declared list is refused, a declared one is not", async () => {
  const token = await registerUser("timecard-status@test.test");
  const created = await req<{ timecard: { id: string } }>("POST", "/crew/timecards", timecard(), token);
  assert.equal(created.status, 201, `the card must save first: ${JSON.stringify(created.body)}`);
  const id = created.body.timecard.id;

  const bogus = await req<{ error?: string }>(
    "POST", `/crew/timecards/${id}/approval`, { status: "half-approved" }, token
  );
  assert.equal(bogus.status, 400, `an undeclared status -> ${bogus.status} ${JSON.stringify(bogus.body)}`);

  // Every status the store declares is accepted by the route, so the enum and
  // the list cannot drift apart. The database half of the same agreement —
  // migration 033's CHECK — is in the DB-gated suite.
  for (const status of TIMECARD_APPROVAL_STATUSES) {
    const res = await req<{ timecard?: { approvalStatus: string } }>(
      "POST", `/crew/timecards/${id}/approval`, { status }, token
    );
    assert.equal(res.status, 200, `status ${status} -> ${res.status} ${JSON.stringify(res.body)}`);
    assert.equal(res.body.timecard?.approvalStatus, status);
  }
});

test("crew timecards: a crew member cannot approve their own hours, the owner can approve the same row", async () => {
  /**
   * The rank gate, in the store this suite runs against.
   *
   * This is the one write on a timesheet that is deliberately somebody else's
   * row, so it is the one gate on this route that is not an ownership check —
   * `requireAtLeast("manager")` and nothing else. A crew member approving
   * their own hours is the defect the route exists to prevent.
   *
   * The crew member here comes in by the COMPANY invitation journey, the same
   * one `company-rbac.test.ts` uses, because `registerUser` makes the
   * registrant the OWNER of a new company — a test that registered and then
   * rewrote the role would be measuring a token that `requireAtLeast` never
   * reads. `verifyAuthToken` is asked directly what the token carries, since
   * the gate reads the TOKEN and `/auth/me` reads the store and the two can
   * disagree.
   */
  const ownerToken = await registerUser("timecard-rank-owner@test.test");
  const invited = await req<{ results: Array<{ token?: string }> }>(
    "POST", "/company/members/invite",
    { emails: ["timecard-rank-crew@test.test"], companyRole: "crew" },
    ownerToken
  );
  assert.equal(invited.status, 201, `inviting the crew member: ${JSON.stringify(invited.body)}`);
  const inviteToken = invited.body.results[0]?.token;
  assert.ok(inviteToken, `no invitation token issued: ${JSON.stringify(invited.body)}`);

  const registered = await registerUser("timecard-rank-crew@test.test");
  const accepted = await req<{ token?: string }>(
    "POST", "/projects/invites/accept", { token: inviteToken }, registered
  );
  assert.equal(accepted.status, 200, `accepting: ${JSON.stringify(accepted.body)}`);
  const crewToken = accepted.body.token ?? registered;

  assert.equal(
    verifyAuthToken(crewToken)?.companyRole,
    "crew",
    "the token under test is not a crew token, so the refusal below would prove nothing"
  );
  assert.equal(verifyAuthToken(ownerToken)?.companyRole, "owner");

  // The crew member's own card, created by them.
  const created = await req<{ timecard: { id: string; approvalStatus: string } }>(
    "POST", "/crew/timecards", timecard(), crewToken
  );
  assert.equal(created.status, 201, `the crew member must be able to record hours: ${JSON.stringify(created.body)}`);
  assert.equal(created.body.timecard.approvalStatus, "pending");
  const id = created.body.timecard.id;

  // The refusal.
  const refused = await req<{ error?: string }>(
    "POST", `/crew/timecards/${id}/approval`, { status: "approved" }, crewToken
  );
  assert.equal(refused.status, 403, `crew approving their own hours -> ${refused.status} ${JSON.stringify(refused.body)}`);

  // The row did not move. A 403 with the write already committed would pass
  // the assertion above, and the list route is the only way to see that here.
  const afterRefusal = await req<{ timecards: Array<{ id: string; approvalStatus: string }> }>(
    "GET", "/crew/timecards?siteId=site-under-test", undefined, crewToken
  );
  assert.equal(
    afterRefusal.body.timecards.find((t) => t.id === id)?.approvalStatus,
    "pending",
    "a refused approval still changed the row"
  );

  // The positive control, same route, same row, same test: without it this test
  // passes just as well with the route deleted.
  const allowed = await req<{ timecard?: { approvalStatus: string; approvedBy?: string | null } }>(
    "POST", `/crew/timecards/${id}/approval`, { status: "approved" }, ownerToken
  );
  assert.equal(allowed.status, 200, `the owner approving -> ${allowed.status} ${JSON.stringify(allowed.body)}`);
  assert.equal(allowed.body.timecard?.approvalStatus, "approved");
  assert.equal(
    allowed.body.timecard?.approvedBy?.toLowerCase(),
    "timecard-rank-owner@test.test",
    "approved_by is not the approver"
  );
});
