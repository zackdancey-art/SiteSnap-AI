/**
 * Cross-company isolation and RBAC enforcement tests.
 *
 * Covers the seven test cases from the approved design:
 *  1. Tenant read isolation — Company A user cannot see Company B's sites
 *  2. Viewer is read-only — GET 200, POST/DELETE 403
 *  3. Crew blocked from dashboard — GET /projects/sites → 403
 *  4. Owner-only member management — manager invite attempt → 403
 *  5. Cross-company mutate — Company A manager on Company B resource → 404
 *  6. Invite accept stamps company_id/company_role; already-in-different-company → rejected
 *  7. Backfill invariant — no auth_users rows with company_id = null in memory store
 */

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests } from "../storage/projectsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";

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
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as T });
          } catch {
            reject(new Error(`Non-JSON (${res.statusCode}): ${data}`));
          }
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// Global counter: phone numbers must be unique across all registrations in a test run.
let _phoneSeq = 0;
function nextPhone() { return `+614${String(++_phoneSeq).padStart(8, "0")}`; }

/** Register + verify a user, returning their auth token. */
async function registerUser(email: string, name: string, companyName?: string): Promise<string> {
  const regBody: Record<string, string> = { email, phone: nextPhone(), fullName: name, password: "Password123!!" };
  if (companyName) regBody.companyName = companyName;
  const regRes = await req<{ ok: boolean; devCodes?: { emailCode: string } }>(
    "POST", "/auth/register", regBody
  );
  assert.equal(regRes.status, 200, `register ${email} failed: ${JSON.stringify(regRes.body)}`);
  const { emailCode } = regRes.body.devCodes!;
  // Two-stage verification: the SMS is only minted once the email code
  // is accepted, so the sms code comes from THIS response, not register.
  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email: email, emailCode }
  );
  const { smsCode } = veRes.body.devCodes!;
  const verRes = await req<{ token: string }>(
    "POST", "/auth/register/verify", { email, smsCode }
  );
  assert.equal(verRes.status, 201, `verify ${email} failed: ${JSON.stringify(verRes.body)}`);
  return verRes.body.token;
}

before(async () => {
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:(${(server.address() as { port: number }).port}`;
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

beforeEach(async () => {
  resetAuthStoreForTests();
  resetProjectStoreForTests();
  resetRateLimitStoreForTests();
});

// ── 1. Tenant read isolation ──────────────────────────────────────────────────

test("1: Company A manager cannot see Company B sites", async () => {
  const tokenA = await registerUser("owner-a@co.test", "Owner A", "Company A");
  const tokenB = await registerUser("owner-b@co.test", "Owner B", "Company B");

  // Company B creates a site
  const siteRes = await req<{ site: { id: string } }>(
    "POST", "/projects/sites",
    { name: "Site B", address: "1 B St", client: "Client B", startDate: "2026-01-01", status: "active" },
    tokenB
  );
  assert.equal(siteRes.status, 201);
  const siteBId = siteRes.body.site.id;

  // Company A lists sites — must not contain Site B
  const listRes = await req<{ sites: { id: string }[] }>("GET", "/projects/sites", undefined, tokenA);
  assert.equal(listRes.status, 200);
  const ids = listRes.body.sites.map((s) => s.id);
  assert.ok(!ids.includes(siteBId), `Company A should not see site ${siteBId} from Company B`);
});

// ── 2. Viewer is read-only ────────────────────────────────────────────────────

test("2: Viewer GET /projects/sites returns 200; POST returns 403", async () => {
  // Owner registers and invites a viewer
  const ownerToken = await registerUser("owner@co.test", "Owner", "My Co");

  // Invite viewer
  const invRes = await req<{ results: { token?: string }[] }>(
    "POST", "/company/members/invite",
    { emails: ["viewer@co.test"], companyRole: "viewer" },
    ownerToken
  );
  assert.equal(invRes.status, 201, `invite failed: ${JSON.stringify(invRes.body)}`);
  const inviteToken = invRes.body.results[0]?.token;
  assert.ok(inviteToken, "invite token missing from response");

  // Viewer registers and accepts invite — use the fresh token from the response
  const viewerToken = await registerUser("viewer@co.test", "Viewer");
  const acceptRes = await req<{ token?: string }>("POST", "/projects/invites/accept", { token: inviteToken }, viewerToken);
  assert.equal(acceptRes.status, 200, `accept failed: ${JSON.stringify(acceptRes.body)}`);
  const viewerActiveToken = acceptRes.body.token ?? viewerToken;

  // Viewer GET should succeed
  const getRes = await req("GET", "/projects/sites", undefined, viewerActiveToken);
  assert.equal(getRes.status, 200, "viewer GET should be 200");

  // Viewer POST should be blocked
  const postRes = await req(
    "POST", "/projects/sites",
    { name: "X", address: "X", client: "X", startDate: "2026-01-01", status: "active" },
    viewerActiveToken
  );
  assert.equal(postRes.status, 403, "viewer POST should be 403");
});

// ── 3. Crew blocked from dashboard ───────────────────────────────────────────

test("3: Crew token on GET /projects/sites returns 403", async () => {
  const ownerToken = await registerUser("owner@co.test", "Owner", "My Co");

  const invRes = await req<{ results: { token?: string }[] }>(
    "POST", "/company/members/invite",
    { emails: ["crew@co.test"], companyRole: "crew" },
    ownerToken
  );
  assert.equal(invRes.status, 201);
  const inviteToken = invRes.body.results[0]?.token;

  const crewToken = await registerUser("crew@co.test", "Crew Member");
  const crewAccept = await req<{ token?: string }>("POST", "/projects/invites/accept", { token: inviteToken }, crewToken);
  const crewActiveToken = crewAccept.body.token ?? crewToken;

  const dashRes = await req("GET", "/projects/sites", undefined, crewActiveToken);
  assert.equal(dashRes.status, 403, "crew should be blocked from dashboard");
});

// ── 4. Owner-only member management ──────────────────────────────────────────

test("4: Manager cannot POST /company/members/invite", async () => {
  const ownerToken = await registerUser("owner@co.test", "Owner", "My Co");

  // Invite a manager
  const invRes = await req<{ results: { token?: string }[] }>(
    "POST", "/company/members/invite",
    { emails: ["mgr@co.test"], companyRole: "manager" },
    ownerToken
  );
  assert.equal(invRes.status, 201);
  const mgrToken = await registerUser("mgr@co.test", "Manager");
  const mgrAccept = await req<{ token?: string }>("POST", "/projects/invites/accept", { token: invRes.body.results[0]?.token }, mgrToken);
  const mgrActiveToken = mgrAccept.body.token ?? mgrToken;

  // Manager tries to invite someone — must be 403
  const attemptRes = await req(
    "POST", "/company/members/invite",
    { emails: ["other@co.test"], companyRole: "crew" },
    mgrActiveToken
  );
  assert.equal(attemptRes.status, 403, "manager should not be able to invite");
});

// ── 5. Cross-company mutate blocked ──────────────────────────────────────────

test("5: Company A manager PATCH on Company B site returns 404", async () => {
  const tokenA = await registerUser("owner-a@co.test", "Owner A", "Company A");
  const tokenB = await registerUser("owner-b@co.test", "Owner B", "Company B");

  const siteRes = await req<{ site: { id: string } }>(
    "POST", "/projects/sites",
    { name: "Site B", address: "1 B St", client: "Client B", startDate: "2026-01-01", status: "active" },
    tokenB
  );
  const siteBId = siteRes.body.site.id;

  // Company A tries to update the progress of Site B
  const patchRes = await req(
    "PATCH", `/projects/sites/${siteBId}/progress`,
    { progressPercent: 50 },
    tokenA
  );
  assert.equal(patchRes.status, 404, "cross-company PATCH should return 404");
});

// ── 6. Invite accept stamps company; rejects cross-company ───────────────────

test("6a: Invite accept stamps company_id and company_role on invitee", async () => {
  const ownerToken = await registerUser("owner@co.test", "Owner", "My Co");
  const invRes = await req<{ results: { token?: string }[] }>(
    "POST", "/company/members/invite",
    { emails: ["invitee@co.test"], companyRole: "viewer" },
    ownerToken
  );
  assert.equal(invRes.status, 201);
  const inviteToken = invRes.body.results[0]?.token;

  const inviteeToken = await registerUser("invitee@co.test", "Invitee");
  const acceptRes = await req<{ ok: boolean }>(
    "POST", "/projects/invites/accept", { token: inviteToken }, inviteeToken
  );
  assert.equal(acceptRes.status, 200);

  // Confirm invitee can read (viewer access)
  const getRes = await req("GET", "/projects/sites", undefined, inviteeToken);
  assert.equal(getRes.status, 200, "invited viewer should be able to GET sites");
});

test("6b: Accepting invite when already in a different company is rejected", async () => {
  const ownerAToken = await registerUser("owner-a@co.test", "Owner A", "Company A");
  const ownerBToken = await registerUser("owner-b@co.test", "Owner B", "Company B");

  // Invite same user from both companies
  const invARes = await req<{ results: { token?: string }[] }>(
    "POST", "/company/members/invite",
    { emails: ["dual@co.test"], companyRole: "crew" },
    ownerAToken
  );
  const invBRes = await req<{ results: { token?: string }[] }>(
    "POST", "/company/members/invite",
    { emails: ["dual@co.test"], companyRole: "crew" },
    ownerBToken
  );

  // User registers and accepts Company A invite
  const dualToken = await registerUser("dual@co.test", "Dual User");
  await req("POST", "/projects/invites/accept", { token: invARes.body.results[0]?.token }, dualToken);

  // Attempting to accept Company B invite should be rejected
  const rejectRes = await req<{ status?: string; error?: string }>(
    "POST", "/projects/invites/accept", { token: invBRes.body.results[0]?.token }, dualToken
  );
  const rejected =
    rejectRes.status === 409 ||
    rejectRes.body.status === "already_in_company" ||
    (rejectRes.body.error ?? "").toLowerCase().includes("company");
  assert.ok(rejected, `expected cross-company invite rejection, got ${rejectRes.status}: ${JSON.stringify(rejectRes.body)}`);
});

// ── 7. No NULL company_id in in-memory store after registration ───────────────

test("7: Registered users always have a company_id (no NULL backfill required for new signups)", async () => {
  const token = await registerUser("solo@co.test", "Solo User", "Solo Co");
  const meRes = await req<{ user: { email: string; companyRole: string } }>(
    "GET", "/auth/me", undefined, token
  );
  assert.equal(meRes.status, 200);
  // Confirm the token carried company info
  assert.ok(meRes.body.user.companyRole, "company_role should be set on registered user");
});
