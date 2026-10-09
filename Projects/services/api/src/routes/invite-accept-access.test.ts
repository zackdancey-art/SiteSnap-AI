/**
 * The invitation-accept carve-out on projectsRouter — AUDIT L66.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM company-rbac.test.ts
 *
 * company-rbac.test.ts already has a "crew" case, and it passes, and it did not
 * catch this. The reason is worth stating because it is the whole point of the
 * file you are reading: that suite builds its crew member by registering WITHOUT
 * an invite token, which routes/auth.ts handles by creating a solo company and
 * making them its OWNER. The invitation is then accepted at rank owner(3), sails
 * through `requireAtLeast("viewer")`, and the account is demoted to crew only
 * afterwards. So the suite exercised accept-as-owner and never accept-as-crew,
 * which is the only journey a real invitee takes.
 *
 * The real journey registers WITH an invite token: companyId "" and companyRole
 * "crew" from the first moment. If acceptance does not complete during that
 * registration — a stale link, a lapsed invitation, a second invitation sent
 * later — routes/auth.ts deliberately falls through on the stated grounds that
 * "the user simply lands with no company yet and can retry the invite". The
 * retry was a 403, so the account was stranded with no route back by any means:
 * not the app, not the portal, not the emailed link, not a fresh invitation.
 *
 * These tests are therefore written against the orphan state specifically, and
 * each one carries its own positive control, because "crew can reach the accept
 * route" and "the gate never ran at all" are indistinguishable from a 200 alone.
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

/** A setup request whose response is checked, so a broken seed fails at the seed. */
async function seed<T = unknown>(...args: Parameters<typeof req>): Promise<{ status: number; body: T }> {
  const res = await req<T>(...args);
  assert.ok(
    res.status >= 200 && res.status < 300,
    `seed request failed: ${args[0]} ${args[1]} -> ${res.status} ${JSON.stringify(res.body)}`
  );
  return res;
}

let _phoneSeq = 0;
function nextPhone() { return `+615${String(++_phoneSeq).padStart(8, "0")}`; }

/**
 * Register + verify a user. `extra` goes into the final verify call, which is
 * where routes/auth.ts reads `inviteToken` — passing it is what produces an
 * invited account (companyId "", companyRole "crew") rather than a solo owner.
 */
async function registerUser(
  email: string,
  name: string,
  opts: { companyName?: string; inviteToken?: string } = {}
): Promise<string> {
  const regBody: Record<string, string> = {
    email,
    phone: nextPhone(),
    fullName: name,
    password: "Password123!!",
  };
  if (opts.companyName) regBody.companyName = opts.companyName;
  const regRes = await req<{ devCodes?: { emailCode: string } }>("POST", "/auth/register", regBody);
  assert.equal(regRes.status, 200, `register ${email} failed: ${JSON.stringify(regRes.body)}`);
  const emailCode = regRes.body.devCodes!.emailCode;

  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email, emailCode }
  );
  assert.equal(veRes.status, 200, `verify-email ${email} failed: ${JSON.stringify(veRes.body)}`);
  const smsCode = veRes.body.devCodes!.smsCode;

  const verifyBody: Record<string, string> = { email, smsCode };
  if (opts.inviteToken) verifyBody.inviteToken = opts.inviteToken;
  const verRes = await req<{ token: string }>("POST", "/auth/register/verify", verifyBody);
  assert.equal(verRes.status, 201, `verify ${email} failed: ${JSON.stringify(verRes.body)}`);
  return verRes.body.token;
}

/** The orphan state: an account created from an invitation that did not complete. */
async function registerOrphanedInvitee(email: string, name: string): Promise<string> {
  // A syntactically valid token that resolves to nothing — the stale-link case.
  // routes/auth.ts treats "not_found" as non-fatal, so the account is created
  // with no company and crew rank. This is the state under test.
  const token = await registerUser(email, name, { inviteToken: "0".repeat(64) });
  const me = await req<{ user: { companyId: string; companyRole: string } }>(
    "GET", "/auth/me", undefined, token
  );
  assert.equal(me.status, 200, `/auth/me failed: ${JSON.stringify(me.body)}`);
  assert.equal(
    me.body.user.companyRole, "crew",
    "precondition: an invited signup must land at crew rank, or this file is testing the wrong thing"
  );
  assert.equal(
    me.body.user.companyId, "",
    "precondition: an invited signup whose acceptance failed must land with no company"
  );
  return token;
}

async function inviteCompanyMember(ownerToken: string, email: string, companyRole: string): Promise<string> {
  const res = await seed<{ results: Array<{ token?: string }> }>(
    "POST", "/company/members/invite", { emails: [email], companyRole }, ownerToken
  );
  assert.equal(res.body.results.length, 1, `expected exactly 1 invite result, got ${res.body.results.length}`);
  const token = res.body.results[0]?.token;
  assert.ok(token, `invite for ${email} returned no token: ${JSON.stringify(res.body)}`);
  return token;
}

before(async () => {
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(async () => {
  resetAuthStoreForTests();
  resetProjectStoreForTests();
  resetRateLimitStoreForTests();
});

test("an orphaned invitee can retry acceptance, and the gate around it is still live", async () => {
  const ownerToken = await registerUser("owner@l66.test", "Owner", { companyName: "L66 Co" });
  const orphanToken = await registerOrphanedInvitee("orphan@l66.test", "Orphan");

  // POSITIVE CONTROL, same route, same run: the viewer gate is real and this
  // token is genuinely below it. Without these two lines a 200 on the accept
  // route below would be consistent with the gate having been deleted entirely.
  const ownerDash = await req("GET", "/projects/sites", undefined, ownerToken);
  assert.equal(ownerDash.status, 200, "control: an owner must still reach the dashboard");
  const orphanDash = await req<{ error?: string }>("GET", "/projects/sites", undefined, orphanToken);
  assert.equal(orphanDash.status, 403, "control: crew rank must still be refused the dashboard");

  // The carve-out: a fresh invitation, retried by the stranded account.
  const inviteToken = await inviteCompanyMember(ownerToken, "orphan@l66.test", "crew");
  const accept = await req<{ companyId?: string; companyRole?: string; token?: string; error?: string }>(
    "POST", "/projects/invites/accept", { token: inviteToken }, orphanToken
  );
  assert.equal(
    accept.status, 200,
    `a stranded invitee must be able to accept an invitation: ${accept.status} ${JSON.stringify(accept.body)}`
  );

  // Reaching the handler is not the same as being attached to the company, and
  // a 200 from a route that did nothing would satisfy the assertion above.
  assert.equal(accept.body.companyRole, "crew", "acceptance must stamp the invited role");
  assert.ok(accept.body.companyId, "acceptance must stamp a company id, not an empty string");
  assert.notEqual(accept.body.companyId, "", "acceptance must stamp a company id, not an empty string");

  const me = await req<{ user: { companyId: string; companyRole: string } }>(
    "GET", "/auth/me", undefined, accept.body.token
  );
  assert.equal(me.status, 200);
  assert.equal(
    me.body.user.companyId, accept.body.companyId,
    "the company on the reissued token must match the one acceptance reported"
  );
});

test("the carve-out matches one exact path and nothing adjacent to it", async () => {
  const ownerToken = await registerUser("owner2@l66.test", "Owner", { companyName: "L66 Co 2" });
  const orphanToken = await registerOrphanedInvitee("orphan2@l66.test", "Orphan");

  // Express routes case-insensitively by default, so this reaches the same
  // handler — but the carve-out compares req.path exactly, so the gate must
  // still apply. The failure mode being excluded is a loose comparison
  // (lowercasing, startsWith, a regex) that would let a crew token past the
  // gate for anything whose path merely resembles the accept route.
  const wrongCase = await req<{ error?: string }>(
    "POST", "/PROJECTS/INVITES/ACCEPT", { token: "whatever" }, orphanToken
  );
  assert.equal(
    wrongCase.status, 403,
    `a non-exact path must not be carved out of the gate: ${wrongCase.status} ${JSON.stringify(wrongCase.body)}`
  );

  // A path that merely starts with the carved-out one must not be carved out.
  const suffixed = await req<{ error?: string }>(
    "POST", "/projects/invites/accept-all", { token: "whatever" }, orphanToken
  );
  assert.equal(
    suffixed.status, 403,
    `a path extending the carved-out one must not be carved out: ${suffixed.status} ${JSON.stringify(suffixed.body)}`
  );

  // POSITIVE CONTROL: the exact path IS carved out, in this same test, for this
  // same token. Otherwise both assertions above would pass with the carve-out
  // removed, which is precisely how a check comes to verify nothing.
  const inviteToken = await inviteCompanyMember(ownerToken, "orphan2@l66.test", "crew");
  const exact = await req<{ error?: string }>(
    "POST", "/projects/invites/accept", { token: inviteToken }, orphanToken
  );
  assert.equal(
    exact.status, 200,
    `control: the exact accept path must be reachable: ${exact.status} ${JSON.stringify(exact.body)}`
  );
});
