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
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { createApp } from "../server";
import { getPgPool } from "../storage/postgres";
import { createUser, deleteUserAccount } from "../storage/authStore";
import { createAuthToken } from "../utils/authToken";
import { hashPassword } from "../utils/password";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";

if (!process.env.TEST_DATABASE_URL) {
  test("auth 401 codes (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // authStore.useDatabase() reads DATABASE_URL on every call and test-setup.ts
  // blanks it, so without this the route would read the in-memory map and this
  // file would test nothing it claims to. It cannot reach production: getPgPool()
  // refuses to read DATABASE_URL when NODE_ENV === "test", and node:test gives
  // each file its own process.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

  const MIGRATIONS_DIR = path.join(process.cwd(), "src", "storage", "migrations");
  const applyMigrations = async (pool: Pool): Promise<void> => {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const applied = new Set((await pool.query<{ version: string }>(`SELECT version FROM schema_migrations`)).rows.map((r) => r.version));
    for (const file of (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort()) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf-8");
      const client = await pool.connect();
      try { await client.query("BEGIN"); await client.query(sql); await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]); await client.query("COMMIT"); }
      catch (err) { await client.query("ROLLBACK"); throw new Error(`Migration ${version} failed: ${err instanceof Error ? err.message : String(err)}`); }
      finally { client.release(); }
    }
  };

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const COMPANY = `codes-co-${runId}`;
  const EMAIL_A = `codes-a-${runId}@example.test`;
  const EMAIL_B = `codes-b-${runId}@example.test`;
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
    const valid = createAuthToken({ email, fullName: "Codes A", companyId: COMPANY, companyRole: "owner" });
    const [payload, signature] = valid.split(".");
    // Same length, different bytes: verifyAuthToken rejects a length mismatch
    // before it reaches timingSafeEqual, and a length mismatch is a different
    // code path from a signature that simply does not match.
    const flipped = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");
    return `${payload}.${flipped}`;
  };

  type Answer = { status: number; body: { error?: string; code?: string; ok?: boolean } };

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

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);

    const hash = await hashPassword(CURRENT_PASSWORD);
    // Two accounts so the per-account rate limiter on change-password (5 per 15
    // minutes) cannot make the second test depend on how many requests the
    // first one spent.
    await createUser(EMAIL_A, hash, `+6140000${runId.slice(-4).replace(/\D/g, "0")}1`, "Codes A", "admin", COMPANY, "owner");
    await createUser(EMAIL_B, hash, `+6140000${runId.slice(-4).replace(/\D/g, "0")}2`, "Codes B", "admin", COMPANY, "owner");
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
    await pool?.end().catch(() => {});
  });

  test("a dead session and a mistyped password are both 401 and are told apart by code", async () => {
    const token = createAuthToken({ email: EMAIL_A, fullName: "Codes A", companyId: COMPANY, companyRole: "owner" });

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

    // And the password really changed in Postgres, not just in a reply: the old
    // one is now the wrong credential, with the body-credential code again.
    const stale = await changePassword(token, CURRENT_PASSWORD, `Next_${runId}_4A`);
    assert.equal(stale.status, 401);
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
    const live = createAuthToken({ email: EMAIL_B, fullName: "Codes B", companyId: COMPANY, companyRole: "owner" });
    const ok = await changePassword(live, CURRENT_PASSWORD, `Next_${runId}_4B`);
    assert.equal(ok.status, 200, `change-password refused a valid token: ${JSON.stringify(ok.body)}`);
    assert.equal(ok.body.ok, true);
  });
}
