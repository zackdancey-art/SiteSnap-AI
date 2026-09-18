import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import {
  resetProjectStoreForTests,
  createSite as createSiteRecord,
  createSiteInvites,
  INVITE_ROLE_TOO_HIGH,
} from "../storage/projectsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import type { Actor } from "../storage/actor";

let server: http.Server;
let baseUrl: string;

/**
 * A seed request whose response is CHECKED.
 *
 * An unchecked `await req(...)` used as setup is the quiet form of the failure
 * this suite is meant to catch: if the seed starts failing, every assertion
 * downstream of it tests nothing, and a "must be absent / must be 0" assertion
 * will happily pass because the thing was never created in the first place.
 * seed() fails loudly at the setup line instead. Use it for any request whose
 * response you would otherwise discard.
 */
async function seed<T = unknown>(...args: Parameters<typeof req>): Promise<{ status: number; body: T }> {
  const res = await req<T>(...args);
  assert.ok(
    res.status >= 200 && res.status < 300,
    `seed request failed: ${args[0]} ${args[1]} -> ${res.status} ${JSON.stringify(res.body)}`
  );
  return res;
}

async function req<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { "Content-Length": Buffer.byteLength(payload).toString() } : {}),
      },
    };
    const r = http.request(`${baseUrl}/api${path}`, options, (res) => {
      let data = "";
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as T });
        } catch {
          reject(new Error(`Non-JSON response (${res.statusCode}): ${data}`));
        }
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  // supervisor@example.com is allowed to register as supervisor
  process.env.SUPERVISOR_SIGNUP_EMAILS = "supervisor@example.com";
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(async () => {
  await resetAuthStoreForTests();
  await resetProjectStoreForTests();
  resetRateLimitStoreForTests();
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function registerAndLogin(email: string, phone: string, fullName: string): Promise<string> {
  const reg = await req<{ devCodes?: { emailCode: string } }>(
    "POST", "/auth/register",
    { email, password: "Password123!", phone, fullName }
  );
  const { emailCode } = reg.body.devCodes!;
  // Two-stage verification: the SMS is only minted once the email code
  // is accepted, so the sms code comes from THIS response, not register.
  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email: email, emailCode }
  );
  const { smsCode } = veRes.body.devCodes!;
  const verify = await req<{ token: string }>(
    "POST", "/auth/register/verify",
    { email, smsCode }
  );
  return verify.body.token;
}

async function createSite(token: string, name = "Test Site"): Promise<string> {
  const r = await req<{ site: { id: string } }>(
    "POST", "/projects/sites",
    { name, address: "1 Main St", client: "ACME", startDate: "2025-01-01", status: "active" },
    token
  );
  assert.equal(r.status, 201);
  return r.body.site.id;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("supervisor can create an invite", async () => {
  const supToken = await registerAndLogin("supervisor@example.com", "+447911000010", "Supervisor");
  const siteId = await createSite(supToken);

  const r = await req<{ results: Array<{ email: string; status: string }> }>(
    "POST",
    `/projects/sites/${siteId}/invites`,
    { emails: ["worker1@example.com"], role: "crew" },
    supToken
  );
  assert.equal(r.status, 201);
  assert.equal(r.body.results.length, 1);
  assert.equal(r.body.results[0].email, "worker1@example.com");
  assert.equal(r.body.results[0].status, "sent");
});

test("worker (non-supervisor, non-owner) gets 403 when creating invite", async () => {
  const supToken = await registerAndLogin("supervisor@example.com", "+447911000010", "Supervisor");
  const workerToken = await registerAndLogin("worker1@example.com", "+447911000011", "Worker");
  const siteId = await createSite(supToken);

  const r = await req<{ error: string }>(
    "POST",
    `/projects/sites/${siteId}/invites`,
    { emails: ["other@example.com"], role: "crew" },
    workerToken
  );
  assert.equal(r.status, 403);
});

test("site owner (crew role) can create invite for their own site", async () => {
  const ownerToken = await registerAndLogin("owner@example.com", "+447911000020", "Owner");
  const siteId = await createSite(ownerToken);

  const r = await req<{ results: Array<{ email: string; status: string }> }>(
    "POST",
    `/projects/sites/${siteId}/invites`,
    { emails: ["invited@example.com"], role: "crew" },
    ownerToken
  );
  assert.equal(r.status, 201);
  assert.equal(r.body.results[0].status, "sent");
});

test("accepted invite registers user as member; token cannot be reused", async () => {
  const supToken = await registerAndLogin("supervisor@example.com", "+447911000010", "Supervisor");
  const siteId = await createSite(supToken, "Invite Site");

  // Send invite
  await seed(
    "POST", `/projects/sites/${siteId}/invites`,
    { emails: ["joiner@example.com"], role: "crew" },
    supToken
  );

  // List invites to get the token
  const listR = await req<{ invites: Array<{ token: string }> }>(
    "GET", `/projects/sites/${siteId}/invites`, undefined, supToken
  );
  assert.equal(listR.body.invites.length, 1);
  const token = listR.body.invites[0].token;
  assert.ok(token, "token should be present");

  // Register the invitee
  const joinerToken = await registerAndLogin("joiner@example.com", "+447911000030", "Joiner");

  // Accept the invite
  const acceptR = await req<{ siteId: string; siteName: string; role: string }>(
    "POST", "/projects/invites/accept",
    { token },
    joinerToken
  );
  assert.equal(acceptR.status, 200);
  assert.equal(acceptR.body.siteId, siteId);
  assert.equal(acceptR.body.siteName, "Invite Site");
  assert.equal(acceptR.body.role, "crew");

  // Verify the joiner appears in members list
  const membersR = await req<{ members: Array<{ memberEmail: string }> }>(
    "GET", `/projects/sites/${siteId}/members`, undefined, supToken
  );
  assert.equal(membersR.status, 200);
  assert.ok(membersR.body.members.some((m) => m.memberEmail === "joiner@example.com"));

  // Reuse the same token → should fail (token was consumed)
  const reuse = await req<{ error: string }>(
    "POST", "/projects/invites/accept",
    { token },
    joinerToken
  );
  assert.equal(reuse.status, 404, "reused token must be rejected");
});

test("expired or unknown token is rejected", async () => {
  const joinerToken = await registerAndLogin("joiner2@example.com", "+447911000040", "Joiner2");
  const r = await req<{ error: string }>(
    "POST", "/projects/invites/accept",
    { token: "0000000000000000000000000000000000000000000000000000000000000000" },
    joinerToken
  );
  assert.equal(r.status, 404, "unknown/expired token must return 404");
});

test("wrong-user token is rejected", async () => {
  const supToken = await registerAndLogin("supervisor@example.com", "+447911000010", "Supervisor");
  const siteId = await createSite(supToken);

  await seed("POST", `/projects/sites/${siteId}/invites`,
    { emails: ["target@example.com"], role: "crew" }, supToken);

  const listR = await req<{ invites: Array<{ token: string }> }>(
    "GET", `/projects/sites/${siteId}/invites`, undefined, supToken
  );
  const token = listR.body.invites[0].token;

  // Different user tries to accept
  const otherToken = await registerAndLogin("other@example.com", "+447911000050", "Other");
  const r = await req<{ error: string }>(
    "POST", "/projects/invites/accept",
    { token },
    otherToken
  );
  assert.equal(r.status, 403, "wrong-user token must return 403");
  // Original token must still be valid (wasn't consumed)
  const targetToken = await registerAndLogin("target@example.com", "+447911000060", "Target");
  const r2 = await req<{ siteId: string }>(
    "POST", "/projects/invites/accept",
    { token },
    targetToken
  );
  assert.equal(r2.status, 200, "original invitee can still accept");
});

test("invited member sees the site in their sites list", async () => {
  const supToken = await registerAndLogin("supervisor@example.com", "+447911000010", "Supervisor");
  const siteId = await createSite(supToken, "Member Site");

  await seed("POST", `/projects/sites/${siteId}/invites`,
    { emails: ["member@example.com"], role: "crew" }, supToken);

  const listR = await req<{ invites: Array<{ token: string }> }>(
    "GET", `/projects/sites/${siteId}/invites`, undefined, supToken
  );
  const token = listR.body.invites[0].token;

  const memberToken = await registerAndLogin("member@example.com", "+447911000070", "Member");
  await seed("POST", "/projects/invites/accept", { token }, memberToken);

  const sitesR = await req<{ sites: Array<{ id: string; name: string }> }>(
    "GET", "/projects/sites", undefined, memberToken
  );
  assert.equal(sitesR.status, 200);
  assert.ok(sitesR.body.sites.some((s) => s.id === siteId && s.name === "Member Site"),
    "member should see the invited site");
});

test("supervisor can revoke an invite", async () => {
  const supToken = await registerAndLogin("supervisor@example.com", "+447911000010", "Supervisor");
  const siteId = await createSite(supToken);

  await seed("POST", `/projects/sites/${siteId}/invites`,
    { emails: ["revoked@example.com"], role: "crew" }, supToken);

  const listR = await req<{ invites: Array<{ id: string; token: string }> }>(
    "GET", `/projects/sites/${siteId}/invites`, undefined, supToken
  );
  const invite = listR.body.invites[0];

  const delR = await req("DELETE", `/projects/sites/${siteId}/invites/${invite.id}`, undefined, supToken);
  assert.equal(delR.status, 200);

  // Token should now be invalid
  const joinerToken = await registerAndLogin("revoked@example.com", "+447911000080", "Revoked");
  const acceptR = await req<{ error: string }>(
    "POST", "/projects/invites/accept",
    { token: invite.token },
    joinerToken
  );
  assert.equal(acceptR.status, 404, "revoked invite token should not be accepted");
});

test("already_member status returned for existing member", async () => {
  const supToken = await registerAndLogin("supervisor@example.com", "+447911000010", "Supervisor");
  const siteId = await createSite(supToken);

  // Invite and accept once
  await seed("POST", `/projects/sites/${siteId}/invites`,
    { emails: ["repeat@example.com"], role: "crew" }, supToken);
  const listR = await req<{ invites: Array<{ token: string }> }>(
    "GET", `/projects/sites/${siteId}/invites`, undefined, supToken
  );
  const memberToken = await registerAndLogin("repeat@example.com", "+447911000090", "Repeat");
  await seed("POST", "/projects/invites/accept", { token: listR.body.invites[0].token }, memberToken);

  // Invite again → should return already_member
  const r2 = await req<{ results: Array<{ email: string; status: string }> }>(
    "POST", `/projects/sites/${siteId}/invites`,
    { emails: ["repeat@example.com"], role: "crew" },
    supToken
  );
  assert.equal(r2.status, 201);
  assert.equal(r2.body.results[0].status, "already_member");
});

test("supervisor can remove a member", async () => {
  const supToken = await registerAndLogin("supervisor@example.com", "+447911000010", "Supervisor");
  const siteId = await createSite(supToken);

  await seed("POST", `/projects/sites/${siteId}/invites`,
    { emails: ["leaveme@example.com"], role: "crew" }, supToken);
  const listR = await req<{ invites: Array<{ token: string }> }>(
    "GET", `/projects/sites/${siteId}/invites`, undefined, supToken
  );
  const memberToken = await registerAndLogin("leaveme@example.com", "+447911000095", "Leave");
  await seed("POST", "/projects/invites/accept", { token: listR.body.invites[0].token }, memberToken);

  const removeR = await req(
    "DELETE", `/projects/sites/${siteId}/members/leaveme@example.com`,
    undefined, supToken
  );
  assert.equal(removeR.status, 200);

  // Member should no longer see the site
  const sitesR = await req<{ sites: Array<{ id: string }> }>(
    "GET", "/projects/sites", undefined, memberToken
  );
  assert.ok(!sitesR.body.sites.some((s) => s.id === siteId), "removed member should not see the site");
});

// ─── Role-mapping contract (invite role → invitee company_role) ───────────────

test("inviting as 'manager' and accepting sets the invitee's companyRole to manager", async () => {
  const ownerToken = await registerAndLogin("owner-mgr@example.com", "+447911000100", "Owner");
  const siteId = await createSite(ownerToken, "Manager Invite Site");

  const inviteR = await req<{ results: Array<{ email: string; status: string }> }>(
    "POST", `/projects/sites/${siteId}/invites`,
    { emails: ["newmanager@example.com"], role: "manager" },
    ownerToken
  );
  assert.equal(inviteR.status, 201);
  assert.equal(inviteR.body.results[0].status, "sent");

  const listR = await req<{ invites: Array<{ token: string }> }>(
    "GET", `/projects/sites/${siteId}/invites`, undefined, ownerToken
  );
  const token = listR.body.invites[0].token;

  const managerToken = await registerAndLogin("newmanager@example.com", "+447911000101", "NewManager");

  const acceptR = await req<{ companyRole: string; role: string }>(
    "POST", "/projects/invites/accept",
    { token },
    managerToken
  );
  assert.equal(acceptR.status, 200);
  // Must be strictly "manager" — if the code regresses to hardcoding "crew",
  // this assertion fails.
  assert.equal(acceptR.body.companyRole, "manager");

  // Independently verify via a fresh read of the persisted user record.
  const meR = await req<{ user: { companyRole: string } }>(
    "GET", "/auth/me", undefined, managerToken
  );
  assert.equal(meR.status, 200);
  assert.equal(meR.body.user.companyRole, "manager");
});

test("inviting as 'crew' and accepting sets the invitee's companyRole to crew", async () => {
  const ownerToken = await registerAndLogin("owner-crew@example.com", "+447911000110", "Owner");
  const siteId = await createSite(ownerToken, "Crew Invite Site");

  const inviteR = await req<{ results: Array<{ email: string; status: string }> }>(
    "POST", `/projects/sites/${siteId}/invites`,
    { emails: ["newcrew@example.com"], role: "crew" },
    ownerToken
  );
  assert.equal(inviteR.status, 201);
  assert.equal(inviteR.body.results[0].status, "sent");

  const listR = await req<{ invites: Array<{ token: string }> }>(
    "GET", `/projects/sites/${siteId}/invites`, undefined, ownerToken
  );
  const token = listR.body.invites[0].token;

  const crewToken = await registerAndLogin("newcrew@example.com", "+447911000111", "NewCrew");

  const acceptR = await req<{ companyRole: string; role: string }>(
    "POST", "/projects/invites/accept",
    { token },
    crewToken
  );
  assert.equal(acceptR.status, 200);
  assert.equal(acceptR.body.companyRole, "crew");

  const meR = await req<{ user: { companyRole: string } }>(
    "GET", "/auth/me", undefined, crewToken
  );
  assert.equal(meR.status, 200);
  assert.equal(meR.body.user.companyRole, "crew");
});

test("legacy role 'worker' is rejected by the invite schema", async () => {
  const ownerToken = await registerAndLogin("owner-legacy1@example.com", "+447911000120", "Owner");
  const siteId = await createSite(ownerToken);

  const r = await req<{ error: string }>(
    "POST", `/projects/sites/${siteId}/invites`,
    { emails: ["someone@example.com"], role: "worker" },
    ownerToken
  );
  assert.equal(r.status, 400, "legacy 'worker' role must be rejected by the schema, not silently accepted");
});

test("role 'owner' is rejected by the invite schema (owner is not assignable via invite)", async () => {
  const ownerToken = await registerAndLogin("owner-legacy2@example.com", "+447911000130", "Owner");
  const siteId = await createSite(ownerToken);

  const r = await req<{ error: string }>(
    "POST", `/projects/sites/${siteId}/invites`,
    { emails: ["someone-else@example.com"], role: "owner" },
    ownerToken
  );
  assert.equal(r.status, 400, "'owner' must not be assignable via invite");
});

// ─── Part C: invite role ceiling (non-owner site invites are crew-only) ───────
//
// Prior to the fix, `createSiteInvites` stamped the invitee's COMPANY role to
// whatever `role` the inviter requested, with no check on the inviter's own
// companyRole. Any user who could manage a site (a company manager/owner, or a
// crew/viewer member who personally owns that site) could therefore mint a
// company-manager or company-viewer via a site invite — a privilege-escalation
// path around the owner-only `/company/members/invite` endpoint. The fix adds a
// ceiling: only an `owner` may request `role !== "crew"`; anyone else gets
// `INVITE_ROLE_TOO_HIGH` → HTTP 403.

const CEILING_ERROR = "Only an owner can invite managers or viewers. You can invite crew only.";

/** Looks up the pending invite token for `email` on `siteId` (as a manager) and
 *  accepts it as a freshly-registered invitee, returning the accept response
 *  (which carries the invitee's fresh token, companyId, and companyRole). */
async function acceptSiteInviteFor(
  listerToken: string,
  siteId: string,
  email: string,
  phone: string,
  name: string
): Promise<{ token: string; companyId: string; companyRole: string }> {
  const listR = await req<{ invites: Array<{ token: string; invitedEmail: string }> }>(
    "GET", `/projects/sites/${siteId}/invites`, undefined, listerToken
  );
  const invite = listR.body.invites.find((i) => i.invitedEmail === email);
  assert.ok(invite, `no pending invite found for ${email}`);
  const inviteeToken = await registerAndLogin(email, phone, name);
  const acceptR = await req<{ token: string; companyId: string; companyRole: string }>(
    "POST", "/projects/invites/accept",
    { token: invite!.token },
    inviteeToken
  );
  assert.equal(acceptR.status, 200, `accept failed for ${email}: ${JSON.stringify(acceptR.body)}`);
  return acceptR.body;
}

test("ceiling: owner inviting 'manager' via site invite succeeds (201)", async () => {
  const ownerToken = await registerAndLogin("ceil-owner1@example.com", "+447911002001", "CeilOwner1");
  const siteId = await createSite(ownerToken, "Ceiling Site 1");

  const r = await req<{ results: Array<{ email: string; status: string }> }>(
    "POST", `/projects/sites/${siteId}/invites`,
    { emails: ["ceil-mgr1@example.com"], role: "manager" },
    ownerToken
  );
  assert.equal(r.status, 201);
  assert.equal(r.body.results[0].status, "sent");
});

test("ceiling: manager inviting 'crew' via site invite succeeds (201)", async () => {
  const ownerToken = await registerAndLogin("ceil-owner2@example.com", "+447911002010", "CeilOwner2");
  const siteId = await createSite(ownerToken, "Ceiling Site 2");

  await seed("POST", `/projects/sites/${siteId}/invites`,
    { emails: ["ceil-mgr2@example.com"], role: "manager" }, ownerToken);
  const accepted = await acceptSiteInviteFor(
    ownerToken, siteId, "ceil-mgr2@example.com", "+447911002011", "CeilMgr2"
  );
  assert.equal(accepted.companyRole, "manager");

  const r = await req<{ results: Array<{ email: string; status: string }> }>(
    "POST", `/projects/sites/${siteId}/invites`,
    { emails: ["ceil-crew2@example.com"], role: "crew" },
    accepted.token
  );
  assert.equal(r.status, 201);
  assert.equal(r.body.results[0].status, "sent");
});

test("ceiling (headline): manager inviting 'manager' via site invite is rejected 403", async () => {
  const ownerToken = await registerAndLogin("ceil-owner3@example.com", "+447911002020", "CeilOwner3");
  const siteId = await createSite(ownerToken, "Ceiling Site 3");

  await seed("POST", `/projects/sites/${siteId}/invites`,
    { emails: ["ceil-mgr3@example.com"], role: "manager" }, ownerToken);
  const accepted = await acceptSiteInviteFor(
    ownerToken, siteId, "ceil-mgr3@example.com", "+447911002021", "CeilMgr3"
  );
  assert.equal(accepted.companyRole, "manager");

  const r = await req<{ error: string }>(
    "POST", `/projects/sites/${siteId}/invites`,
    { emails: ["ceil-escalate3@example.com"], role: "manager" },
    accepted.token
  );
  assert.equal(r.status, 403, "a non-owner must not be able to mint a company-manager via a site invite");
  assert.equal(
    r.body.error,
    CEILING_ERROR,
    "must be the specific role-ceiling error, not the generic 'insufficient permissions' 403"
  );
});

test("ceiling: manager inviting 'viewer' via site invite is rejected 403", async () => {
  const ownerToken = await registerAndLogin("ceil-owner4@example.com", "+447911002030", "CeilOwner4");
  const siteId = await createSite(ownerToken, "Ceiling Site 4");

  await seed("POST", `/projects/sites/${siteId}/invites`,
    { emails: ["ceil-mgr4@example.com"], role: "manager" }, ownerToken);
  const accepted = await acceptSiteInviteFor(
    ownerToken, siteId, "ceil-mgr4@example.com", "+447911002031", "CeilMgr4"
  );
  assert.equal(accepted.companyRole, "manager");

  const r = await req<{ error: string }>(
    "POST", `/projects/sites/${siteId}/invites`,
    { emails: ["ceil-escalate4@example.com"], role: "viewer" },
    accepted.token
  );
  assert.equal(r.status, 403, "a non-owner must not be able to mint a company-viewer via a site invite either");
  assert.equal(r.body.error, CEILING_ERROR);
});

test("ceiling (store-level): a crew member who owns a site cannot grant a company role above crew via a site invite", async () => {
  // canManageSite() grants a crew/viewer member management of a site they
  // personally own (independent of company role), so the ceiling must apply on
  // that path too — the hole isn't limited to company managers. This is a
  // near-unreachable state via the HTTP API (site creation is gated at
  // manager+), so we exercise the store directly with a crew actor who owns the
  // site: no token/accept indirection, just the exact authorization logic.
  const companyId = "ceil-co-store-5";
  const crewActor: Actor = { email: "crew-owner5@example.com", role: "worker", companyId, companyRole: "crew" };
  const crewSite = await createSiteRecord(crewActor, {
    name: "Crew-owned site", address: "9 Crew Rd", client: "Crew Client", startDate: "2026-01-01", status: "active",
  });

  // The crew member CAN manage their own site: inviting crew succeeds (returns
  // an InviteResult[]), proving the escalation rejection below is the ROLE
  // ceiling firing, not a generic "can't manage this site" denial.
  const okCrew = await createSiteInvites(crewActor, crewSite.id, ["mate@example.com"], "crew", "crew");
  assert.ok(Array.isArray(okCrew), "a crew site-owner can invite crew to their own site");

  // But NOT an elevated company role — the ceiling returns INVITE_ROLE_TOO_HIGH.
  const escalate = await createSiteInvites(crewActor, crewSite.id, ["escalate@example.com"], "manager", "manager");
  assert.equal(escalate, INVITE_ROLE_TOO_HIGH, "a crew site-owner must not mint a company-manager via a site invite");
});

test("ceiling: company-member invite remains owner-only (manager 403, owner 201)", async () => {
  const ownerToken = await registerAndLogin("ceil-owner6@example.com", "+447911002050", "CeilOwner6");
  const siteId = await createSite(ownerToken, "Ceiling Site 6");

  await seed("POST", `/projects/sites/${siteId}/invites`,
    { emails: ["ceil-mgr6@example.com"], role: "manager" }, ownerToken);
  const accepted = await acceptSiteInviteFor(
    ownerToken, siteId, "ceil-mgr6@example.com", "+447911002051", "CeilMgr6"
  );
  assert.equal(accepted.companyRole, "manager");

  const managerAttempt = await req<{ error?: string }>(
    "POST", "/company/members/invite",
    { emails: ["ceil-blocked6@example.com"], companyRole: "crew" },
    accepted.token
  );
  assert.equal(managerAttempt.status, 403, "manager must remain blocked from the company-member invite endpoint");

  const ownerAttempt = await req<{ results: Array<{ email: string; status: string }> }>(
    "POST", "/company/members/invite",
    { emails: ["ceil-allowed6@example.com"], companyRole: "crew" },
    ownerToken
  );
  assert.equal(ownerAttempt.status, 201, "owner-only company-member invite must still succeed unchanged");
  assert.equal(ownerAttempt.body.results[0].status, "sent");
});

test("ceiling: server-side enforcement — a rejected manager→manager site invite leaves no invite record", async () => {
  // Proves the 403 is a real server-side boundary, not merely a client-facing
  // error message: the escalation attempt must not have created state that a
  // different client path could exploit or that a race could accept.
  const ownerToken = await registerAndLogin("ceil-owner7@example.com", "+447911002060", "CeilOwner7");
  const siteId = await createSite(ownerToken, "Ceiling Site 7");

  await seed("POST", `/projects/sites/${siteId}/invites`,
    { emails: ["ceil-mgr7@example.com"], role: "manager" }, ownerToken);
  const accepted = await acceptSiteInviteFor(
    ownerToken, siteId, "ceil-mgr7@example.com", "+447911002061", "CeilMgr7"
  );

  const escalateEmail = "ceil-escalate7@example.com";
  const r = await req<{ status: number; error?: string }>(
    "POST", `/projects/sites/${siteId}/invites`,
    { emails: [escalateEmail], role: "manager" },
    accepted.token
  );
  assert.equal(r.status, 403);
  assert.equal(r.body.error, CEILING_ERROR);

  const listR = await req<{ invites: Array<{ invitedEmail: string }> }>(
    "GET", `/projects/sites/${siteId}/invites`, undefined, ownerToken
  );
  assert.ok(
    !listR.body.invites.some((i) => i.invitedEmail === escalateEmail),
    "a rejected escalation attempt must not leave behind a usable invite record"
  );
});
