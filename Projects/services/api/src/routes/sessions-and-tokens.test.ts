/**
 * Sessions, revocation and refresh — the in-memory half.
 *
 * WHAT THIS FILE IS, AND WHAT IT IS NOT
 * The authoritative version of these assertions is `sessions-and-tokens-db.test.ts`,
 * which runs the same scenarios against real Postgres. This file runs them
 * against the in-memory store. It exists for two reasons, and it is honest about
 * both:
 *
 *  1. It is the half that can be run on a machine with no Postgres, so a
 *     red-on-revert check on the guards below is something a developer can
 *     actually perform rather than describe.
 *  2. The two halves disagreeing is itself the signal. `authStore` branches on
 *     DATABASE_URL, and six production defects have now come from the in-memory
 *     path being green while the SQL path was wrong (AUDIT L65 is the standing
 *     record). `token_generation` is a new column read on EVERY authenticated
 *     request, which makes it the most expensive place for that divergence to
 *     happen next. Asserting the same behaviour on both paths is how a drift
 *     between them becomes a CI failure instead of a fleet-wide sign-out.
 *
 * So: duplication here is deliberate. If you change a scenario, change it in
 * both files, or the pair stops being a comparison.
 *
 * WHAT IS BEING GUARDED
 *  - L75: /auth/revoke-all minted a new token for the CALLER and invalidated
 *    nothing. A phone left in a taxi kept full access for up to seven days.
 *  - L74: /auth/refresh sat behind `requireAuth`, so the one route whose purpose
 *    is to replace an expired token could only be reached by a token that did
 *    not need replacing.
 *  - The session model: the token proves who you are, the record decides what
 *    you may do (see THE SESSION MODEL in storage/authStore.ts).
 *
 * EVERY TEST CARRIES BOTH CONTROLS, in the same test, on the same route. A
 * refusal test alone passes just as well when the route has been deleted, and
 * that is not a hypothetical here: mutating /uploads/sign to deny every caller
 * left all 126 tests green (docs/VACUITY-AUDIT.md, M7).
 */

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import crypto from "node:crypto";
import { createApp } from "../server";
import { createUser, resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests } from "../storage/projectsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import { hashPassword } from "../utils/password";
import { getSessionTimings, AuthClaims } from "../utils/authToken";

let server: http.Server;
let baseUrl: string;

const COMPANY = "sessions-co";
const OWNER = "sessions-owner@example.test";
const CREW = "sessions-crew@example.test";
const PASSWORD = "Sessions_pw_1A!";
const NEXT_PASSWORD = "Sessions_pw_2B!";

/**
 * The same secret the server will verify with, read rather than chosen.
 *
 * `getTokenSecret()` reads this variable at call time and falls back to the dev
 * literal when it is unset; mirroring that exactly means the two cannot
 * disagree. Every test below opens by proving a hand-signed token IS accepted,
 * so a mismatch here fails as a control rather than as a false pass.
 */
const SECRET = process.env.AUTH_TOKEN_SECRET || "dev-sitesnap-secret";

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

/**
 * A correctly signed token with arbitrary claims.
 *
 * Needed because the cases that matter cannot be produced by the mint path:
 * "a token minted on another device five minutes ago", "a token whose `exp` has
 * just passed", "a token claiming a rank the user's row does not have". Moving
 * the clock would not give the second one either — this is the exact shape the
 * phones were holding. The signature is computed with the same algorithm the
 * server verifies with, so a change to the token format fails these tests
 * rather than quietly passing them.
 *
 * The default `iat` is five minutes ago so that a token from "another device" is
 * never byte-identical to one minted in the same second by a login.
 */
function signClaims(overrides: Partial<AuthClaims> & { email: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const { tokenTtlSeconds } = getSessionTimings();
  const claims: AuthClaims = {
    fullName: "Session Owner",
    companyId: COMPANY,
    companyRole: "owner",
    role: "admin",
    iat: now - 300,
    exp: now - 300 + tokenTtlSeconds,
    tokenGeneration: 0,
    ...overrides,
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

async function seedOwner(companyRole: "owner" | "crew" = "owner"): Promise<void> {
  await createUser(OWNER, await hashPassword(PASSWORD), nextPhone(), "Session Owner", "admin", COMPANY, companyRole);
}

/** A real token off the real mint path, for the device that is acting. */
async function login(): Promise<string> {
  const res = await req<{ token?: string }>("POST", "/auth/login", { email: OWNER, password: PASSWORD });
  assert.equal(res.status, 200, `login failed: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.token, "login returned no token");
  return res.body.token as string;
}

const status = async (token: string) => (await req("GET", "/auth/me", undefined, token)).status;

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
  await resetAuthStoreForTests();
  resetProjectStoreForTests();
  await resetRateLimitStoreForTests();
});

test("revoke-all ends another device's session, and the acting device keeps working", async () => {
  await seedOwner();
  const acting = await login();
  const otherDevice = signClaims({ email: OWNER });

  // CONTROL, BEFORE THE REVOCATION. Both tokens are accepted. Without this the
  // 401s below would be satisfied by a hand-signed token the server never
  // liked, or by /auth/me having broken for everyone.
  assert.equal(await status(acting), 200, "the acting token must work before the revocation");
  assert.equal(await status(otherDevice), 200, "the other device's token must work before the revocation");

  const revoked = await req<{ token?: string }>("POST", "/auth/revoke-all", {}, acting);
  assert.equal(revoked.status, 200, `revoke-all failed: ${JSON.stringify(revoked.body)}`);
  assert.ok(revoked.body.token, "revoke-all must hand back a replacement credential");
  const replacement = revoked.body.token as string;

  // THE DEFECT, ASSERTED. This is the phone in the taxi. Before this branch it
  // answered 200 for up to seven more days.
  const other = await req<{ code?: string }>("GET", "/auth/me", undefined, otherDevice);
  assert.equal(other.status, 401, `the other device must be signed out: ${JSON.stringify(other.body)}`);
  assert.equal(other.body.code, "session_expired", "a revoked token must be indistinguishable from an expired one");

  // "All" includes the credential that pressed the button. That is why the route
  // hands one back.
  assert.equal(await status(acting), 401, "revoke-all must revoke the acting credential too");

  // POSITIVE CONTROL, SAME ROUTE. Without it every assertion above passes
  // against an /auth/me that now refuses everybody.
  assert.equal(await status(replacement), 200, "the replacement credential must work");
});

test("revocation reaches /auth/refresh, the one route that could have exempted itself", async () => {
  await seedOwner();
  const acting = await login();
  const otherDevice = signClaims({ email: OWNER });

  // CONTROL: this token can refresh before the revocation, so the refusal below
  // is the revocation and not the route.
  const beforeRevoke = await req<{ token?: string }>("POST", "/auth/refresh", {}, otherDevice);
  assert.equal(beforeRevoke.status, 200, `refresh failed before revocation: ${JSON.stringify(beforeRevoke.body)}`);
  assert.ok(beforeRevoke.body.token, "refresh returned no token");

  const revoked = await req<{ token?: string }>("POST", "/auth/revoke-all", {}, acting);
  assert.equal(revoked.status, 200, `revoke-all failed: ${JSON.stringify(revoked.body)}`);

  // A revoked token cannot refresh itself back to life. /auth/refresh is NOT
  // behind requireAuth any more (L74), so it carries this check itself; if it
  // ever stops, revocation becomes theatre everywhere else.
  const refused = await req<{ code?: string }>("POST", "/auth/refresh", {}, otherDevice);
  assert.equal(refused.status, 401, `a revoked token refreshed itself: ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.code, "session_expired");

  // Nor can the token that refresh handed out moments before the revocation: it
  // was minted at the old generation, so it is revoked by the same number.
  const chained = await req<{ code?: string }>("POST", "/auth/refresh", {}, beforeRevoke.body.token as string);
  assert.equal(chained.status, 401, "a token minted before the revocation must not extend the chain");

  // POSITIVE CONTROL: the replacement still refreshes.
  const allowed = await req<{ token?: string }>("POST", "/auth/refresh", {}, revoked.body.token as string);
  assert.equal(allowed.status, 200, `the replacement could not refresh: ${JSON.stringify(allowed.body)}`);
  assert.ok(allowed.body.token);
});

test("a password change signs out every other device and leaves this one signed in", async () => {
  await seedOwner();
  const acting = await login();
  const otherDevice = signClaims({ email: OWNER });
  assert.equal(await status(otherDevice), 200, "control: the other device works before the change");

  // A TYPO IS NOT A REVOCATION. 401 `invalid_credentials` on a live session, and
  // the session survives it. The client half of this contract is the portal's
  // and mobile's code check; this is the server half.
  const typo = await req<{ code?: string }>("POST", "/auth/change-password",
    { currentPassword: "not-my-password", newPassword: NEXT_PASSWORD }, acting);
  assert.equal(typo.status, 401, `expected 401 for a wrong current password: ${JSON.stringify(typo.body)}`);
  assert.equal(typo.body.code, "invalid_credentials", "a mistyped password must not look like a dead session");
  assert.equal(await status(acting), 200, "a mistyped current password must not end the session");

  const changed = await req<{ ok?: boolean; token?: string }>("POST", "/auth/change-password",
    { currentPassword: PASSWORD, newPassword: NEXT_PASSWORD }, acting);
  assert.equal(changed.status, 200, `change-password failed: ${JSON.stringify(changed.body)}`);
  assert.equal(changed.body.ok, true, "the `ok` field is load-bearing for the portal and change-password.test.ts");
  assert.ok(changed.body.token, "change-password must hand back a replacement token — the increment revokes the caller's own credential");

  assert.equal(await status(otherDevice), 401, "a password change must sign out every other device");
  assert.equal(await status(acting), 401, "the credential used to change the password is revoked by the change");
  // And the whole reason the route returns a token: the device in your hand does
  // not get signed out for using the feature correctly.
  assert.equal(await status(changed.body.token as string), 200, "the replacement must keep the acting device signed in");
});

test("a token that has just expired can refresh; one past the idle window cannot", async () => {
  await seedOwner();
  const { tokenTtlSeconds, refreshGraceSeconds } = getSessionTimings();
  // Measured, not assumed: with a zero grace the first case below would be
  // refused and this test would prove the opposite of what it says.
  assert.ok(refreshGraceSeconds > 0, `the refresh grace is ${refreshGraceSeconds}s, so this test cannot mean anything`);
  const now = Math.floor(Date.now() / 1000);

  const justExpired = signClaims({ email: OWNER, iat: now - tokenTtlSeconds - 60, exp: now - 60 });

  // The grace is refresh-only. An ordinary request still refuses it — otherwise
  // the "grace" is just a longer TTL under another name.
  const ordinary = await req<{ code?: string }>("GET", "/auth/me", undefined, justExpired);
  assert.equal(ordinary.status, 401, "an expired token must not be accepted on an ordinary request");
  assert.equal(ordinary.body.code, "session_expired");

  // L74, asserted. This call could not succeed before this branch: /auth/refresh
  // was behind the middleware that had just refused the token.
  const refreshed = await req<{ token?: string }>("POST", "/auth/refresh", {}, justExpired);
  assert.equal(refreshed.status, 200, `refresh refused a just-expired token: ${JSON.stringify(refreshed.body)}`);
  assert.ok(refreshed.body.token, "refresh returned no token");
  // The token it gave back has to be usable, or a 200 here means nothing.
  assert.equal(await status(refreshed.body.token as string), 200, "the refreshed token must be accepted");

  // Past the idle window the session is over, and refresh is where that is
  // decided. Both offsets come from the module's own numbers.
  const abandoned = signClaims({
    email: OWNER,
    iat: now - refreshGraceSeconds - tokenTtlSeconds - 3600,
    exp: now - refreshGraceSeconds - 3600,
  });
  const dead = await req<{ code?: string }>("POST", "/auth/refresh", {}, abandoned);
  assert.equal(dead.status, 401, `refresh accepted a token past the idle window: ${JSON.stringify(dead.body)}`);
  assert.equal(dead.body.code, "session_expired");
});

test("authority comes from the user row, so the token's claims can neither grant nor remove it", async () => {
  // Deliberately mismatched legacy roles: `companyRole` is what is enforced, and
  // a test that set both consistently could not tell which one was read.
  const hash = await hashPassword(PASSWORD);
  await createUser(CREW, hash, nextPhone(), "Session Crew", "admin", COMPANY, "crew");
  await createUser(OWNER, hash, nextPhone(), "Session Owner", "worker", COMPANY, "owner");

  // (1) The claims say owner. The row says crew. The row wins, so this is 403.
  // This is the escalation the model has to refuse: a token minted before a
  // demotion, or one whose claims were chosen by the holder's own invite flow.
  const claimsSayOwner = signClaims({ email: CREW, fullName: "Session Crew", companyRole: "owner", role: "admin" });
  const escalation = await req<{ error?: string }>("GET", "/company/members", undefined, claimsSayOwner);
  assert.equal(escalation.status, 403, `a stale owner claim was honoured: ${JSON.stringify(escalation.body)}`);

  // (2) The claims say crew. The row says owner. The row wins again, in the
  // other direction — and this is the control: without it (1) passes equally
  // well against a /company/members that refuses every caller. It is also the
  // half that keeps an invitee working through acceptance instead of landing on
  // a login screen.
  const claimsSayCrew = signClaims({ email: OWNER, fullName: "Session Owner", companyRole: "crew", role: "worker" });
  const allowed = await req<{ members?: { email: string }[] }>("GET", "/company/members", undefined, claimsSayCrew);
  assert.equal(allowed.status, 200, `a stale crew claim refused an owner: ${JSON.stringify(allowed.body)}`);

  // (3) The company comes from the row too, not only the rank. A claim naming
  // another company still lists THIS company's members — asserted positively,
  // because "lists nothing" is what a wrongly-scoped read also produces.
  const wrongCompany = signClaims({
    email: OWNER, fullName: "Session Owner", companyId: "not-their-company",
    companyRole: "crew", role: "worker",
  });
  const listed = await req<{ members?: { email: string }[] }>("GET", "/company/members", undefined, wrongCompany);
  assert.equal(listed.status, 200, `a bogus companyId claim broke the request: ${JSON.stringify(listed.body)}`);
  assert.ok(
    listed.body.members?.some((m) => m.email === CREW),
    `the company was taken from the claim, not the row: ${JSON.stringify(listed.body)}`
  );
});
