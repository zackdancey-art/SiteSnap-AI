/**
 * What a 401 means, asserted against real Postgres.
 *
 * WHY THIS EXISTS
 * An API deploy left every stored mobile token unacceptable. Every authenticated
 * write then failed, and the app reported each failure in the vocabulary of
 * whatever feature made the call — "Failed to save timecard" for a dead session.
 * The client fix is to route a 401 to sign-in instead; this file holds the half
 * of that contract the server owns, because the client cannot route correctly
 * unless the server says which kind of 401 this is.
 *
 * THE TRAP THIS GUARDS
 * A 401 does not mean one thing. POST /api/auth/change-password answers 401 for
 * a mistyped CURRENT password: an authenticated request, a live session, a wrong
 * credential in the body. A client keyed on the status alone would sign that
 * person out of the app for a typo — the same substitution of the wrong cause,
 * pointing the other way. So the two must be distinguishable, and both cases are
 * asserted on the SAME ROUTE in the SAME TEST, together with the success that
 * proves the route works at all.
 *
 * WHAT IS DELIBERATELY NOT DISTINGUISHED
 * An expired token and a forged signature answer identically — same status, same
 * code, same message. Separating them would tell someone probing with a forged
 * token whether their signature verified, which is the one useful bit of
 * feedback this endpoint can leak. That indistinguishability is asserted, not
 * assumed, because it is a security property and the obvious "improvement" is to
 * break it.
 *
 * WHY POSTGRES AND NOT THE IN-MEMORY SUITE
 * The password check reads a real user row. L65 is the standing reminder that the
 * in-memory suite can be green while production is broken: `authStore` branches
 * on DATABASE_URL, so an in-memory run proves nothing about the row the deployed
 * API reads. Guarded on TEST_DATABASE_URL — skips (one placeholder) without one.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "auth-401-codes-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import crypto from "node:crypto";
import type { Pool } from "pg";
import { createApp } from "../server";
import { getPgPool } from "../storage/postgres";
import { createUser, deleteUserAccount } from "../storage/authStore";
import { createAuthToken } from "../utils/authToken";
import { hashPassword } from "../utils/password";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import { applyMigrations } from "../storage/testMigrations";

if (!process.env.TEST_DATABASE_URL) {
  test("auth 401 codes (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // authStore.useDatabase() reads DATABASE_URL on every call and test-setup.ts
  // blanks it, so without this the route would read the in-memory map and this
  // file would test nothing it claims to. It cannot reach production: getPgPool()
  // refuses to read DATABASE_URL when NODE_ENV === "test", and node:test gives
  // each file its own process.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;


  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const COMPANY = `codes-co-${runId}`;
  const EMAIL_A = `codes-a-${runId}@example.test`;
  const EMAIL_B = `codes-b-${runId}@example.test`;
  // A third account for the login test. Both tests above END by changing the
  // password of the account they used, so a login test sharing one of them
  // would depend on file order for whether CURRENT_PASSWORD is still current.
  const EMAIL_C = `codes-c-${runId}@example.test`;
  const UNKNOWN_EMAIL = `codes-nobody-${runId}@example.test`;
  const CURRENT_PASSWORD = `Current_${runId}_1A`;

  let server: http.Server;
  let baseUrl: string;
  let pool: Pool;

  /**
   * A token that is correctly signed and whose `exp` has passed.
   *
   * Built here rather than by moving the clock, because this is the exact shape
   * the phones were holding: a token this secret signed, now too old. The HMAC
   * is reproduced from the same algorithm the server verifies with, so a change
   * to the token format fails this test rather than silently passing it.
   */
  const expiredTokenFor = (email: string): string => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const claims = {
      email, fullName: "Codes A", companyId: COMPANY, companyRole: "owner",
      role: "admin", iat: past - 10, exp: past,
    };
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signature = crypto
      .createHmac("sha256", process.env.AUTH_TOKEN_SECRET as string)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  };

  /** A token whose payload is intact and whose signature is not ours. */
  const forgedTokenFor = (email: string): string => {
    const valid = createAuthToken({ email, fullName: "Codes A", companyId: COMPANY, companyRole: "owner", tokenGeneration: 0 });
    const [payload, signature] = valid.split(".");
    // Same length, different bytes: verifyAuthToken rejects a length mismatch
    // before it reaches timingSafeEqual, and a length mismatch is a different
    // code path from a signature that simply does not match.
    const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
    return `${payload}.${flipped}`;
  };

  type Answer = { status: number; body: { error?: string; code?: string; ok?: boolean; token?: string } };

  const changePassword = async (
    token: string | null,
    currentPassword: string,
    newPassword: string
  ): Promise<Answer> => {
    const res = await fetch(`${baseUrl}/api/auth/change-password`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const text = await res.text();
    let body: Answer["body"] = {};
    try { body = JSON.parse(text) as Answer["body"]; } catch { body = { error: text }; }
    return { status: res.status, body };
  };

  const login = async (email: string, password: string): Promise<Answer> => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const text = await res.text();
    let body: Answer["body"] = {};
    try { body = JSON.parse(text) as Answer["body"]; } catch { body = { error: text }; }
    return { status: res.status, body };
  };

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);

    const hash = await hashPassword(CURRENT_PASSWORD);
    // Two accounts so the per-account rate limiter on change-password (5 per 15
    // minutes) cannot make the second test depend on how many requests the
    // first one spent.
    await createUser(EMAIL_A, hash, `+6140000${runId.slice(-4).replace(/\D/g, "0")}1`, "Codes A", "admin", COMPANY, "owner");
    await createUser(EMAIL_B, hash, `+6140000${runId.slice(-4).replace(/\D/g, "0")}2`, "Codes B", "admin", COMPANY, "owner");
    await createUser(EMAIL_C, hash, `+6140000${runId.slice(-4).replace(/\D/g, "0")}3`, "Codes C", "admin", COMPANY, "owner");
    await resetRateLimitStoreForTests();

    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server did not bind a port");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await deleteUserAccount(EMAIL_A).catch(() => {});
    await deleteUserAccount(EMAIL_B).catch(() => {});
    await deleteUserAccount(EMAIL_C).catch(() => {});
    await pool?.end().catch(() => {});
  });

  test("a dead session and a mistyped password are both 401 and are told apart by code", async () => {
    const token = createAuthToken({ email: EMAIL_A, fullName: "Codes A", companyId: COMPANY, companyRole: "owner", tokenGeneration: 0 });

    // (1) Live session, wrong credential in the BODY. The client must keep its
    // own message here; routing this to sign-in signs someone out for a typo.
    const typo = await changePassword(token, "not-my-password", `Next_${runId}_1A`);
    assert.equal(typo.status, 401);
    assert.equal(typo.body.code, "invalid_credentials");
    assert.equal(typo.body.error, "Current password is incorrect.");

    // (2) Dead session, correct credential in the body. Same route, same status,
    // different code - and this one must route to sign-in.
    const dead = await changePassword(expiredTokenFor(EMAIL_A), CURRENT_PASSWORD, `Next_${runId}_2A`);
    assert.equal(dead.status, 401);
    assert.equal(dead.body.code, "session_expired");

    // (3) The positive control, on the same route. Without it both assertions
    // above would pass against a route that refused every caller - which is
    // exactly how M7 shipped a /uploads/sign that denied everyone with 126
    // tests green (docs/VACUITY-AUDIT.md).
    const ok = await changePassword(token, CURRENT_PASSWORD, `Next_${runId}_3A`);
    assert.equal(ok.status, 200, `change-password refused a correct password: ${JSON.stringify(ok.body)}`);
    assert.equal(ok.body.ok, true);

    // ADOPT THE REPLACEMENT, BECAUSE A REAL CLIENT DOES.
    //
    // The change at (3) incremented the account's token generation, which is
    // what changing a password means — every token on the account stops being
    // accepted, including `token`, the one that just made the request. So (4)
    // below cannot reuse it: `requireAuth` would answer session_expired before
    // the route ever looked at the password, and the assertion about the
    // PASSWORD would be measuring the session instead.
    //
    // Adopting the replacement is the fix rather than reordering (4) above (3),
    // because reordering would dodge the revocation and leave the file passing
    // against a route that had stopped issuing a replacement at all. This is the
    // same move commit 7710b16 made in the mobile client
    // (`apps/mobile/app/settings/account.tsx`), and asserting the token is
    // present makes this test fail if that half of the contract is ever removed
    // — which would sign every device out on a password change.
    assert.ok(
      ok.body.token,
      "change-password returned no replacement token, so every client is signed out by a successful change"
    );
    const adopted = ok.body.token;

    // And the password really changed in Postgres, not just in a reply: the old
    // one is now the wrong credential, with the body-credential code again. On a
    // live session, so a 401 here can only be about the password.
    const stale = await changePassword(adopted, CURRENT_PASSWORD, `Next_${runId}_4A`);
    assert.equal(stale.status, 401, `expected the OLD password to be refused on a live session: ${JSON.stringify(stale.body)}`);
    assert.equal(stale.body.code, "invalid_credentials");
  });

  test("an expired token and a forged signature are deliberately indistinguishable", async () => {
    const expired = await changePassword(expiredTokenFor(EMAIL_B), CURRENT_PASSWORD, `Next_${runId}_1B`);
    const forged = await changePassword(forgedTokenFor(EMAIL_B), CURRENT_PASSWORD, `Next_${runId}_2B`);

    assert.equal(expired.status, 401);
    assert.equal(forged.status, 401);
    assert.equal(expired.body.code, "session_expired");
    assert.equal(forged.body.code, "session_expired");
    // The prose too. A different sentence is as good a probe as a different code.
    assert.equal(expired.body.error, forged.body.error);

    // No credential at all is a different thing and says so: the app is signed
    // out rather than expired, and the sign-in screen must not announce an
    // expiry to someone who is already on it.
    const none = await changePassword(null, CURRENT_PASSWORD, `Next_${runId}_3B`);
    assert.equal(none.status, 401);
    assert.equal(none.body.code, "no_credential");

    // Positive control on the same route: a token this secret signed, not yet
    // expired, is accepted. Without it this test would pass if requireAuth
    // rejected everything.
    const live = createAuthToken({ email: EMAIL_B, fullName: "Codes B", companyId: COMPANY, companyRole: "owner", tokenGeneration: 0 });
    const ok = await changePassword(live, CURRENT_PASSWORD, `Next_${runId}_4B`);
    assert.equal(ok.status, 200, `change-password refused a valid token: ${JSON.stringify(ok.body)}`);
    assert.equal(ok.body.ok, true);
  });

  test("an unknown account and a wrong password are deliberately indistinguishable too", async () => {
    /**
     * AUDIT L18, the third member of this file's family and the one that was
     * open longest. An unknown email answered 404 "Account not found. Please
     * sign up first." while a wrong password answered 401, so POST /auth/login
     * would tell any unauthenticated caller whether a given address has an
     * account here. For a product whose users are named supervisors at
     * identifiable companies, that answer is the information worth having.
     *
     * Against Postgres rather than in memory for the reason in this file's
     * header: the branch being asserted is `findUserByEmail` returning nothing,
     * and authStore chooses its store by DATABASE_URL. An in-memory run
     * exercises a different lookup from the deployed one. The equivalence is
     * asserted on the whole body, not the status, because a distinguishing
     * message leaks the same bit.
     */
    await resetRateLimitStoreForTests();

    const wrongPassword = await login(EMAIL_C, `definitely-not-${runId}`);
    const noSuchAccount = await login(UNKNOWN_EMAIL, `definitely-not-${runId}`);

    assert.equal(wrongPassword.status, 401, `a wrong password did not answer 401: ${JSON.stringify(wrongPassword.body)}`);
    assert.equal(noSuchAccount.status, 401, `an unknown account did not answer 401: ${JSON.stringify(noSuchAccount.body)}`);
    assert.equal(wrongPassword.body.code, "invalid_credentials");
    assert.deepEqual(
      noSuchAccount.body, wrongPassword.body,
      "the two failures are distinguishable by their bodies, which is the same oracle in a different field"
    );

    // Positive control on the same route. Both assertions above hold just as
    // well for a login that refuses everybody, and this account's password has
    // not been changed by anything above -- which is why it is its own account.
    const good = await login(EMAIL_C, CURRENT_PASSWORD);
    assert.equal(good.status, 200, `login refused a correct password: ${JSON.stringify(good.body)}`);
    assert.ok(good.body.token, "a successful login returned no token");
  });
}
