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
 *  - L104: five routes mint a replacement credential into a `Set-Cookie` and
 *    four of them had no assertion of any kind on that header, so the portal's
 *    only way of receiving the credential could have been deleted route by
 *    route with the suite still green.
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
import { SESSION_COOKIE } from "../utils/sessionCookie";

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

/**
 * `headers` is returned, not just the status and body, because half of this
 * API's session handling happens in a response header and none of it was
 * asserted. Five routes write a `Set-Cookie` — login, refresh, change-password,
 * revoke-all and `/projects/invites/accept` — and before this there was not one
 * `set-cookie` assertion in the suite, so every one of them could have been
 * deleted with the whole suite still green. AUDIT L104 is the standing record;
 * all five are now asserted, change-password below and the other four in the
 * L104 block at the end of this file.
 *
 * `cookie` is the portal's transport. A test that drives these routes with an
 * `Authorization` header is testing the mobile client's path; the portal's
 * cookie is httpOnly and cannot read a token out of a response body, so for the
 * portal a replacement credential arrives as a `Set-Cookie` or not at all.
 */
async function req<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  cookie?: string
): Promise<{ status: number; body: T; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      `${baseUrl}/api${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as T, headers: res.headers }); }
          catch { reject(new Error(`Non-JSON (${res.statusCode}): ${data}`)); }
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

/**
 * The session cookie out of a response, as a browser would send it back.
 *
 * Returned as the raw `name=value` pair rather than a decoded token, because
 * that is what the browser echoes and `readSessionCookie` is what decodes it —
 * re-encoding here would test this helper's agreement with itself instead of the
 * server's. SESSION_COOKIE is imported rather than written out so that renaming
 * the cookie fails this test rather than making it vacuous; a bare
 * "sitesnap.session" literal in middleware/auth.ts is what made the name worth
 * centralising in the first place (see utils/sessionCookie.ts).
 */
function sessionCookieFrom(headers: http.IncomingHttpHeaders, whichRoute: string): string {
  const raw = headers["set-cookie"] ?? [];
  const hit = raw.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(
    hit,
    `${whichRoute} sent no ${SESSION_COOKIE} cookie, so a portal caller never receives the credential it minted — ` +
      `set-cookie was ${JSON.stringify(raw)}`
  );
  return (hit as string).split(";")[0];
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
/** The same probe over the portal's transport: no Authorization header at all. */
const cookieStatus = async (cookie: string) =>
  (await req("GET", "/auth/me", undefined, undefined, cookie)).status;

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

/**
 * The same contract as the test above, over the OTHER transport.
 *
 * WHY THIS IS A SEPARATE TEST AND NOT A SECOND ASSERTION UP THERE
 *
 * The test above drives change-password with an `Authorization` header and
 * asserts on `body.token`. That is the mobile client's path, and it is the only
 * path anything asserted: `setSessionCookie(res, token)` could have been deleted
 * from routes/auth.ts and every test in this suite — all seven in
 * change-password.test.ts included — would still have passed. The portal's
 * cookie is httpOnly, so it cannot read the body's token; for a portal caller
 * the replacement arrives as a `Set-Cookie` or not at all.
 *
 * WHAT BREAKS IF THIS FAILS
 *
 * A password change increments `token_generation`, and `requireAuth` refuses a
 * token behind the record (middleware/auth.ts:193). That `return` is BEFORE the
 * staleClaims repair at middleware/auth.ts:247, so the repair — which does
 * compare the generation — can never rescue a cookie that is one generation
 * behind. Nothing else in the system defends this: without the Set-Cookie,
 * every portal user who successfully changes their password is signed out on
 * their next request, having done nothing wrong. This test is the only thing
 * standing there, so it is written to fail loudly (`sessionCookieFrom` asserts
 * and prints the actual `set-cookie`) rather than to fail as a confusing 401.
 *
 * WHY IT HAS NO POSTGRES TWIN, WHICH IS A DEVIATION FROM THIS FILE'S RULE
 *
 * Deliberate, not forgotten. The store-dependent half of this behaviour is the
 * generation `updateUserPassword` returns, and the test above already asserts
 * that on both stores. What is new here lives entirely in the route's response
 * headers, which `authStore`'s DATABASE_URL branch cannot reach — so a twin
 * would duplicate the assertion without being able to detect a divergence,
 * which is the one thing the pair exists for.
 */
test("a password change replaces the portal's cookie, and the cookie that made the change stops working", async () => {
  await seedOwner();

  // Sign in for a COOKIE rather than a token: this is the portal's journey.
  const signedIn = await req<{ token?: string }>("POST", "/auth/login", { email: OWNER, password: PASSWORD });
  assert.equal(signedIn.status, 200, `login failed: ${JSON.stringify(signedIn.body)}`);
  const original = sessionCookieFrom(signedIn.headers, "login");

  // CONTROL, on the same route this test will later expect to refuse that
  // cookie. Without it the 401 below passes just as well against a server that
  // refuses every cookie it is ever sent — which is exactly how /uploads/sign
  // shipped denying everyone with 126 tests green (docs/VACUITY-AUDIT.md, M7).
  assert.equal(await cookieStatus(original), 200, "control: the session cookie works before the change");

  const changed = await req<{ ok?: boolean; token?: string }>(
    "POST",
    "/auth/change-password",
    { currentPassword: PASSWORD, newPassword: NEXT_PASSWORD },
    undefined,
    original
  );
  assert.equal(changed.status, 200, `change-password over the cookie transport failed: ${JSON.stringify(changed.body)}`);
  assert.equal(changed.body.ok, true);

  // THE ASSERTION THIS TEST EXISTS FOR.
  const replacement = sessionCookieFrom(changed.headers, "change-password");
  assert.notEqual(
    replacement,
    original,
    "change-password echoed the cookie it was sent instead of minting one at the new generation"
  );

  // Both halves, in the same test. The replacement works...
  assert.equal(await cookieStatus(replacement), 200, "the replacement cookie must keep the portal signed in");
  // ...and the one that made the change does not, which is what the increment
  // means and why the replacement is not a courtesy.
  assert.equal(await cookieStatus(original), 401, "the cookie that changed the password must be revoked by the change");
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

/* ─── L104: the cookie transport, on the four routes that write it uncovered ───
 *
 * Five routes call `setSessionCookie`. Before this block exactly one of them —
 * change-password, above — had a `set-cookie` assertion anywhere in the suite,
 * so the other four could each have had their `setSessionCookie(res, token)`
 * line deleted with every test still green. AUDIT L104 is the standing record.
 *
 * The defect shape L104 names is specific: *a route hands back a replacement
 * credential and one transport never picks it up*. It is invisible to a bearer
 * test, because a bearer client reads the token out of the body and does not
 * care what the headers said. The portal's cookie is httpOnly; it cannot read
 * the body. So for the portal, "the replacement arrived" and "a Set-Cookie was
 * sent" are the same sentence, and nothing below drives these routes with an
 * Authorization header unless the test is specifically about what a bearer
 * caller must NOT receive.
 *
 * Every test here probes with `cookieStatus`, which sends no Authorization
 * header at all, and every one carries its positive control on that same
 * endpoint — because `/auth/me` refusing every cookie it is ever sent would
 * satisfy each of the 401s on its own.
 */

test("login sends a session cookie that authenticates on its own, and a forged one does not", async () => {
  await seedOwner();

  const signedIn = await req<{ token?: string }>("POST", "/auth/login", { email: OWNER, password: PASSWORD });
  assert.equal(signedIn.status, 200, `login failed: ${JSON.stringify(signedIn.body)}`);
  const cookie = sessionCookieFrom(signedIn.headers, "login");

  // THE ASSERTION. No Authorization header is sent, so a 200 here can only have
  // come from the cookie. This is the portal's entire sign-in: if login stopped
  // setting the cookie, nobody could use the portal at all, and until now no
  // test in this suite would have said so.
  assert.equal(await cookieStatus(cookie), 200, "the cookie login minted must authenticate with no bearer token");

  // POSITIVE CONTROL'S OTHER HALF, same endpoint: /auth/me is not simply
  // accepting any cookie-shaped string. The payload is the real one and the
  // signature is garbage, so this isolates verification rather than parsing.
  const forged = `${SESSION_COOKIE}=${cookie.split("=")[1].split(".")[0]}.not-a-real-signature`;
  assert.equal(await cookieStatus(forged), 401, "a cookie with a forged signature must be refused");
});

test("refresh renews the portal's cookie, which is the portal's only recovery from an expired session", async () => {
  await seedOwner();
  const { tokenTtlSeconds } = getSessionTimings();
  const now = Math.floor(Date.now() / 1000);

  // The exact state a portal tab is in after sitting open overnight: the cookie
  // is still in the browser (its max age is 30 days) and the token inside it
  // expired hours ago. Built with signClaims rather than by moving the clock,
  // because this is the shape the browsers are actually holding.
  const stale = `${SESSION_COOKIE}=${signClaims({
    email: OWNER,
    iat: now - tokenTtlSeconds - 60,
    exp: now - 60,
  })}`;

  // Precondition, not decoration: if this were 200 the test below would prove
  // nothing, because there would have been nothing to recover from.
  assert.equal(await cookieStatus(stale), 401, "an expired cookie must be refused on an ordinary request");

  // L74 plus L104 together. Refresh reads `readCredential`, which accepts the
  // cookie as well as the bearer header — so this call is reachable at all —
  // and then has to hand the replacement back over the SAME transport.
  const refreshed = await req<{ token?: string }>("POST", "/auth/refresh", {}, undefined, stale);
  assert.equal(refreshed.status, 200, `refresh refused the portal's expired cookie: ${JSON.stringify(refreshed.body)}`);

  // THE ASSERTION THIS TEST EXISTS FOR. Without the Set-Cookie the portal's tab
  // keeps the dead cookie, the next request 401s, and the user is bounced to
  // the login screen by a route whose entire purpose was to prevent that. The
  // 200 above would not have noticed.
  const renewed = sessionCookieFrom(refreshed.headers, "refresh");
  assert.notEqual(renewed, stale, "refresh echoed the expired cookie back instead of minting a replacement");
  assert.equal(await cookieStatus(renewed), 200, "the renewed cookie must keep the portal signed in");
});

test("revoke-all signs the portal's other tabs out and replaces the acting cookie", async () => {
  await seedOwner();

  const signedIn = await req<{ token?: string }>("POST", "/auth/login", { email: OWNER, password: PASSWORD });
  assert.equal(signedIn.status, 200, `login failed: ${JSON.stringify(signedIn.body)}`);
  const acting = sessionCookieFrom(signedIn.headers, "login");
  // Another browser, signed in earlier. signClaims rather than a second login
  // so it cannot be byte-identical to `acting` — two logins in the same second
  // mint the same claims, and then "the other one was revoked" and "the acting
  // one was revoked" would be the same assertion wearing two names.
  const otherBrowser = `${SESSION_COOKIE}=${signClaims({ email: OWNER })}`;

  // BOTH CONTROLS, BEFORE. Either 401 below is satisfied by a cookie the server
  // never accepted in the first place.
  assert.equal(await cookieStatus(acting), 200, "control: the acting cookie works before the revocation");
  assert.equal(await cookieStatus(otherBrowser), 200, "control: the other browser's cookie works before the revocation");

  const revoked = await req<{ token?: string }>("POST", "/auth/revoke-all", {}, undefined, acting);
  assert.equal(revoked.status, 200, `revoke-all over the cookie transport failed: ${JSON.stringify(revoked.body)}`);

  // The sign-out half. This is what the button in the portal's settings page
  // claims to do.
  assert.equal(await cookieStatus(otherBrowser), 401, "revoke-all must sign the other browser out");
  assert.equal(await cookieStatus(acting), 401, "revoke-all must revoke the cookie that pressed the button");

  // THE L104 HALF, and the reason the two 401s above are not the whole test.
  // "All" includes the acting credential, so without a Set-Cookie the portal
  // signs the user out of their own session the moment they use this feature —
  // the body token is no help, because an httpOnly cookie client cannot read
  // it. This is also the positive control the two refusals need.
  const replacement = sessionCookieFrom(revoked.headers, "revoke-all");
  assert.notEqual(replacement, acting, "revoke-all returned the revoked cookie rather than a replacement");
  assert.equal(await cookieStatus(replacement), 200, "the replacement cookie must keep the acting tab signed in");
});

test("accepting an invitation refreshes a cookie caller's credential and leaves a bearer caller's alone", async () => {
  await seedOwner();
  const ownerToken = await login();

  const site = await req<{ site?: { id: string } }>(
    "POST",
    "/projects/sites",
    { name: "Cookie Transport Site", address: "1 Main St", client: "ACME", startDate: "2025-01-01", status: "active" },
    ownerToken
  );
  assert.equal(site.status, 201, `site creation failed: ${JSON.stringify(site.body)}`);
  const siteId = site.body.site?.id as string;

  const COOKIE_INVITEE = "sessions-cookie-invitee@example.test";
  const BEARER_INVITEE = "sessions-bearer-invitee@example.test";
  const invited = await req<{ results?: { email: string; status: string }[] }>(
    "POST",
    `/projects/sites/${siteId}/invites`,
    { emails: [COOKIE_INVITEE, BEARER_INVITEE], role: "crew" },
    ownerToken
  );
  assert.equal(invited.status, 201, `invite creation failed: ${JSON.stringify(invited.body)}`);
  assert.deepEqual(
    invited.body.results?.map((r) => r.status),
    ["sent", "sent"],
    `both invitations must have been sent: ${JSON.stringify(invited.body)}`
  );

  // The accept tokens come from the LIST route, not from the create response:
  // the create response reports delivery status and deliberately does not echo
  // the credential it minted. Read here rather than hand-made because an invite
  // token this test invented would prove nothing about the one a real invitee
  // receives.
  const listed = await req<{ invites?: { invitedEmail: string; token?: string }[] }>(
    "GET",
    `/projects/sites/${siteId}/invites`,
    undefined,
    ownerToken
  );
  assert.equal(listed.status, 200, `listing invites failed: ${JSON.stringify(listed.body)}`);
  const inviteTokenFor = (email: string): string => {
    const hit = listed.body.invites?.find((i) => i.invitedEmail === email);
    assert.ok(hit?.token, `no invite token was minted for ${email}: ${JSON.stringify(listed.body)}`);
    return hit.token as string;
  };

  const hash = await hashPassword(PASSWORD);
  await createUser(COOKIE_INVITEE, hash, nextPhone(), "Cookie Invitee", "worker", COMPANY, "crew");
  await createUser(BEARER_INVITEE, hash, nextPhone(), "Bearer Invitee", "worker", COMPANY, "crew");

  // (1) THE PORTAL'S JOURNEY. Signed in by cookie, accepting by cookie.
  const portalSignIn = await req<{ token?: string }>("POST", "/auth/login", { email: COOKIE_INVITEE, password: PASSWORD });
  assert.equal(portalSignIn.status, 200, `invitee login failed: ${JSON.stringify(portalSignIn.body)}`);
  const inviteeCookie = sessionCookieFrom(portalSignIn.headers, "login");

  const cookieAccept = await req<{ siteId?: string }>(
    "POST",
    "/projects/invites/accept",
    { token: inviteTokenFor(COOKIE_INVITEE) },
    undefined,
    inviteeCookie
  );
  assert.equal(cookieAccept.status, 200, `accept over the cookie transport failed: ${JSON.stringify(cookieAccept.body)}`);
  assert.equal(cookieAccept.body.siteId, siteId, "accept attached the invitee to a different site");

  const refreshedCookie = sessionCookieFrom(cookieAccept.headers, "invites/accept");
  assert.equal(
    await cookieStatus(refreshedCookie),
    200,
    "the cookie accept handed back must keep the invitee signed in"
  );

  // (2) THE BEARER CALLER, on the same route, in the same test. The route sets
  // the cookie only for `authTransport === "cookie"`, deliberately: a device
  // holding both a body token and a cookie holds two credentials at two
  // generations. So this is a negative assertion with its positive control
  // sitting directly above it — delete the transport check and (1) still
  // passes while this fails, which is the only arrangement that can tell the
  // difference between "sets it for the portal" and "sets it for everyone".
  const bearerSignIn = await req<{ token?: string }>("POST", "/auth/login", { email: BEARER_INVITEE, password: PASSWORD });
  assert.equal(bearerSignIn.status, 200, `invitee login failed: ${JSON.stringify(bearerSignIn.body)}`);
  const bearerAccept = await req<{ token?: string }>(
    "POST",
    "/projects/invites/accept",
    { token: inviteTokenFor(BEARER_INVITEE) },
    bearerSignIn.body.token as string
  );
  assert.equal(bearerAccept.status, 200, `accept over the bearer transport failed: ${JSON.stringify(bearerAccept.body)}`);
  assert.ok(bearerAccept.body.token, "accept must still hand a bearer caller its replacement in the body");
  const sent = bearerAccept.headers["set-cookie"] ?? [];
  assert.ok(
    !sent.some((c) => c.startsWith(`${SESSION_COOKIE}=`)),
    `accept set a session cookie for a bearer caller, leaving the device holding two credentials: ${JSON.stringify(sent)}`
  );
});
