/**
 * Sessions, revocation and refresh — asserted against real Postgres.
 *
 * THIS IS THE AUTHORITATIVE HALF. `sessions-and-tokens.test.ts` runs the same
 * five scenarios against the in-memory store; that one is what a developer with
 * no local Postgres can run, and this one is what decides whether the behaviour
 * is real. The duplication is deliberate and the two must be changed together —
 * see the long note in the in-memory file for why a comparison is the point.
 *
 * WHY POSTGRES IS NOT OPTIONAL HERE
 * `token_generation` is a COLUMN, and every guard below is an integer
 * comparison against a value `authStore` reads from one of two completely
 * different code paths depending on DATABASE_URL. AUDIT L65 is the standing
 * record that the in-memory path can be green while the SQL path is wrong, and
 * six production defects have arrived that way. The specific risks this file
 * covers that the in-memory one structurally cannot:
 *
 *  - `UPDATE auth_users SET token_generation = token_generation + 1 RETURNING
 *    token_generation` returning the POST-increment value. In-memory the
 *    arithmetic is in TypeScript and cannot disagree with itself; in SQL,
 *    RETURNING after a self-referential UPDATE is exactly the shape that
 *    returns the old value when written slightly differently.
 *  - The column existing at all, with its DEFAULT 0, in a boot-migrated schema
 *    (migration 012). A `CREATE TABLE IF NOT EXISTS` no-op column reads as
 *    `undefined`, and `undefined < 1` is false — a revoked token that is still
 *    accepted, with every in-memory test green (this is the L11 shape).
 *  - `loadSessionIdentity` reading the real row, so that a demotion written by
 *    one request is honoured by the next.
 *
 * Guarded on TEST_DATABASE_URL and registers one placeholder skip without it.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "sessions-and-tokens-secret";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { createApp } from "../server";
import { getPgPool } from "../storage/postgres";
import { createUser, deleteUserAccount, resetSessionIdentityCacheForTests } from "../storage/authStore";
import { hashPassword } from "../utils/password";
import { getSessionTimings, AuthClaims, CompanyRole, UserRole } from "../utils/authToken";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";

if (!process.env.TEST_DATABASE_URL) {
  test("sessions and tokens against Postgres (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // authStore.useDatabase() reads DATABASE_URL on every call and test-setup.ts
  // blanks it, so without this the routes would read the in-memory map and this
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
  const COMPANY = `sessions-co-${runId}`;
  const PASSWORD = `Sessions_${runId}_1A`;
  const NEXT_PASSWORD = `Sessions_${runId}_2B`;
  const phoneBase = String(Date.now()).slice(-8);

  let server: http.Server;
  let baseUrl: string;
  let pool: Pool;
  let _phoneSeq = 0;
  const created: string[] = [];

  /**
   * One account per scenario, not one shared account.
   *
   * Every test here revokes something, and `token_generation` is persistent
   * state in a real table — a shared account would make each test depend on how
   * many revocations ran before it, and the per-account rate limiters on
   * change-password and refresh would make that dependence intermittent rather
   * than obvious. Distinct emails also mean the cleanup in `after` is targeted:
   * this file never issues a blanket DELETE against a database it shares.
   */
  const emailFor = (scenario: string): string => `sessions-${scenario}-${runId}@example.test`;

  const seedUser = async (
    email: string,
    fullName: string,
    role: UserRole,
    companyRole: CompanyRole
  ): Promise<void> => {
    await createUser(email, await hashPassword(PASSWORD), `+614${phoneBase}${++_phoneSeq}`, fullName, role, COMPANY, companyRole);
    created.push(email);
  };

  const req = async <T = unknown>(
    method: string,
    path_: string,
    body?: unknown,
    token?: string
  ): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${baseUrl}/api${path_}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: T;
    try { parsed = JSON.parse(text) as T; } catch { parsed = { error: text } as unknown as T; }
    return { status: res.status, body: parsed };
  };

  /**
   * A correctly signed token with arbitrary claims — the cases the mint path
   * cannot produce: a token from another device, one whose `exp` has just
   * passed, one claiming a rank the row does not hold. Signed with the same
   * algorithm the server verifies with, so a token-format change fails this
   * file rather than passing it quietly. Default `iat` is five minutes ago so a
   * second device's token is never byte-identical to a fresh login's.
   */
  const signClaims = (overrides: Partial<AuthClaims> & { email: string }): string => {
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
    const signature = crypto
      .createHmac("sha256", process.env.AUTH_TOKEN_SECRET as string)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  };

  const login = async (email: string, password = PASSWORD): Promise<string> => {
    const res = await req<{ token?: string }>("POST", "/auth/login", { email, password });
    assert.equal(res.status, 200, `login failed for ${email}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.token, "login returned no token");
    return res.body.token as string;
  };

  const status = async (token: string) => (await req("GET", "/auth/me", undefined, token)).status;

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);

    // The column every assertion in this file depends on. Asserted here rather
    // than discovered as a confusing 200 three tests down: a missing column
    // reads as `undefined`, and `undefined < 1` is false — every guard below
    // would wave the revoked token through.
    const column = await pool.query<{ column_default: string | null; data_type: string }>(
      `SELECT column_default, data_type FROM information_schema.columns
        WHERE table_name = 'auth_users' AND column_name = 'token_generation'`
    );
    assert.equal(column.rowCount, 1, "auth_users.token_generation does not exist (migration 012 did not apply)");
    assert.equal(column.rows[0].data_type, "integer", `token_generation is ${column.rows[0].data_type}`);

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
    for (const email of created) await deleteUserAccount(email).catch(() => {});
    await pool?.end().catch(() => {});
  });

  beforeEach(() => {
    // Not resetAuthStoreForTests(): in DB mode that DELETEs every row in
    // auth_users and companies, and this file shares its database. Only the
    // 60-second identity cache needs clearing, so that a generation written by
    // one test is never read from cache by the next.
    resetSessionIdentityCacheForTests();
  });

  test("revoke-all ends another device's session, and the acting device keeps working", async () => {
    const email = emailFor("revoke");
    await seedUser(email, "Session Owner", "admin", "owner");
    const acting = await login(email);
    const otherDevice = signClaims({ email });

    // CONTROL, BEFORE THE REVOCATION. Both tokens are accepted, so the 401s
    // below are the revocation and not a hand-signed token the server never
    // liked or an /auth/me that broke for everyone.
    assert.equal(await status(acting), 200, "the acting token must work before the revocation");
    assert.equal(await status(otherDevice), 200, "the other device's token must work before the revocation");

    const revoked = await req<{ token?: string }>("POST", "/auth/revoke-all", {}, acting);
    assert.equal(revoked.status, 200, `revoke-all failed: ${JSON.stringify(revoked.body)}`);
    assert.ok(revoked.body.token, "revoke-all must hand back a replacement credential");

    // THE DEFECT (L75), ASSERTED. This is the phone left in a taxi. Before this
    // branch the row was never touched and this answered 200 for seven days.
    const other = await req<{ code?: string }>("GET", "/auth/me", undefined, otherDevice);
    assert.equal(other.status, 401, `the other device must be signed out: ${JSON.stringify(other.body)}`);
    assert.equal(other.body.code, "session_expired", "a revoked token must be indistinguishable from an expired one");
    assert.equal(await status(acting), 401, "revoke-all must revoke the acting credential too");
    assert.equal(await status(revoked.body.token as string), 200, "the replacement credential must work");

    // AND THE COLUMN ACTUALLY MOVED. The whole point of running this against
    // Postgres: a route that answered correctly from a cache while writing
    // nothing would pass every assertion above and lose the revocation on the
    // next deploy.
    const row = await pool.query<{ token_generation: number }>(
      `SELECT token_generation FROM auth_users WHERE email = $1`, [email]
    );
    assert.equal(row.rowCount, 1, "the account row disappeared");
    assert.equal(row.rows[0].token_generation, 1, "revoke-all must increment auth_users.token_generation");
  });

  test("revocation reaches /auth/refresh, the one route that could have exempted itself", async () => {
    const email = emailFor("refresh-revoked");
    await seedUser(email, "Session Owner", "admin", "owner");
    const acting = await login(email);
    const otherDevice = signClaims({ email });

    // CONTROL: this token can refresh before the revocation.
    const beforeRevoke = await req<{ token?: string }>("POST", "/auth/refresh", {}, otherDevice);
    assert.equal(beforeRevoke.status, 200, `refresh failed before revocation: ${JSON.stringify(beforeRevoke.body)}`);
    assert.ok(beforeRevoke.body.token, "refresh returned no token");

    const revoked = await req<{ token?: string }>("POST", "/auth/revoke-all", {}, acting);
    assert.equal(revoked.status, 200, `revoke-all failed: ${JSON.stringify(revoked.body)}`);

    // /auth/refresh is NOT behind requireAuth any more (L74), so it carries the
    // generation check itself. If it ever stops, revocation is theatre: anyone
    // holding a revoked token trades it for a live one.
    const refused = await req<{ code?: string }>("POST", "/auth/refresh", {}, otherDevice);
    assert.equal(refused.status, 401, `a revoked token refreshed itself: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.code, "session_expired");

    // Nor can the token refresh handed out moments before the revocation.
    const chained = await req<{ code?: string }>("POST", "/auth/refresh", {}, beforeRevoke.body.token as string);
    assert.equal(chained.status, 401, "a token minted before the revocation must not extend the chain");

    // POSITIVE CONTROL: the replacement still refreshes.
    const allowed = await req<{ token?: string }>("POST", "/auth/refresh", {}, revoked.body.token as string);
    assert.equal(allowed.status, 200, `the replacement could not refresh: ${JSON.stringify(allowed.body)}`);
    assert.ok(allowed.body.token);
  });

  test("a password change signs out every other device and leaves this one signed in", async () => {
    const email = emailFor("password");
    await seedUser(email, "Session Owner", "admin", "owner");
    const acting = await login(email);
    const otherDevice = signClaims({ email });
    assert.equal(await status(otherDevice), 200, "control: the other device works before the change");

    // A TYPO IS NOT A REVOCATION: 401 `invalid_credentials` on a live session,
    // and the session survives it. auth-401-codes-db.test.ts owns the code
    // contract; this owns the consequence.
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
    assert.equal(await status(changed.body.token as string), 200, "the replacement must keep the acting device signed in");

    // The replacement must be minted at the value the UPDATE returned. If
    // `RETURNING token_generation` handed back the PRE-increment number, the
    // token above would be refused and the assertion before this one would have
    // caught it — this reads the row directly so the failure names the cause.
    const row = await pool.query<{ token_generation: number }>(
      `SELECT token_generation FROM auth_users WHERE email = $1`, [email]
    );
    assert.equal(row.rows[0].token_generation, 1, "a password change must increment auth_users.token_generation exactly once");

    // And the password really changed in Postgres, not just in a reply.
    assert.equal((await req("POST", "/auth/login", { email, password: PASSWORD })).status, 401, "the old password must stop working");
    const relogin = await req<{ token?: string }>("POST", "/auth/login", { email, password: NEXT_PASSWORD });
    assert.equal(relogin.status, 200, `the new password must work: ${JSON.stringify(relogin.body)}`);
    assert.equal(await status(relogin.body.token as string), 200, "a fresh login must be accepted at the new generation");
  });

  test("a token that has just expired can refresh; one past the idle window cannot", async () => {
    const email = emailFor("expiry");
    await seedUser(email, "Session Owner", "admin", "owner");
    const { tokenTtlSeconds, refreshGraceSeconds } = getSessionTimings();
    // Measured, not assumed: with a zero grace the first case below would be
    // refused and this test would prove the opposite of what it says.
    assert.ok(refreshGraceSeconds > 0, `the refresh grace is ${refreshGraceSeconds}s, so this test cannot mean anything`);
    const now = Math.floor(Date.now() / 1000);

    const justExpired = signClaims({ email, iat: now - tokenTtlSeconds - 60, exp: now - 60 });

    // The grace is refresh-only. An ordinary request still refuses it, or the
    // "grace" is a longer TTL under another name.
    const ordinary = await req<{ code?: string }>("GET", "/auth/me", undefined, justExpired);
    assert.equal(ordinary.status, 401, "an expired token must not be accepted on an ordinary request");
    assert.equal(ordinary.body.code, "session_expired");

    // L74, asserted. This call could not succeed before this branch:
    // /auth/refresh sat behind the middleware that had just refused the token,
    // so the recovery path was reachable only when it was not needed.
    const refreshed = await req<{ token?: string }>("POST", "/auth/refresh", {}, justExpired);
    assert.equal(refreshed.status, 200, `refresh refused a just-expired token: ${JSON.stringify(refreshed.body)}`);
    assert.ok(refreshed.body.token, "refresh returned no token");
    assert.equal(await status(refreshed.body.token as string), 200, "the refreshed token must be accepted");

    const abandoned = signClaims({
      email,
      iat: now - refreshGraceSeconds - tokenTtlSeconds - 3600,
      exp: now - refreshGraceSeconds - 3600,
    });
    const dead = await req<{ code?: string }>("POST", "/auth/refresh", {}, abandoned);
    assert.equal(dead.status, 401, `refresh accepted a token past the idle window: ${JSON.stringify(dead.body)}`);
    assert.equal(dead.body.code, "session_expired");
  });

  test("authority comes from the user row, so the token's claims can neither grant nor remove it", async () => {
    // Deliberately mismatched legacy roles: `companyRole` is what is enforced,
    // and a test that set both consistently could not tell which was read.
    const crewEmail = emailFor("crew");
    const ownerEmail = emailFor("owner");
    await seedUser(crewEmail, "Session Crew", "admin", "crew");
    await seedUser(ownerEmail, "Session Owner", "worker", "owner");

    // (1) The claims say owner. The row says crew. The row wins: 403. This is
    // the escalation the model has to refuse — a token minted before a
    // demotion, or one whose claims the holder's own invite flow chose.
    const claimsSayOwner = signClaims({ email: crewEmail, fullName: "Session Crew", companyRole: "owner", role: "admin" });
    const escalation = await req<{ error?: string }>("GET", "/company/members", undefined, claimsSayOwner);
    assert.equal(escalation.status, 403, `a stale owner claim was honoured: ${JSON.stringify(escalation.body)}`);

    // (2) The claims say crew. The row says owner. The row wins in the other
    // direction — and this is the control: without it (1) passes equally well
    // against a /company/members that refuses every caller.
    const claimsSayCrew = signClaims({ email: ownerEmail, fullName: "Session Owner", companyRole: "crew", role: "worker" });
    const allowed = await req<{ members?: { email: string }[] }>("GET", "/company/members", undefined, claimsSayCrew);
    assert.equal(allowed.status, 200, `a stale crew claim refused an owner: ${JSON.stringify(allowed.body)}`);

    // (3) The company comes from the row too, not only the rank — asserted
    // positively, because "lists nothing" is also what a wrongly-scoped read
    // produces, and under RLS that is the FAIL-CLOSED shape a missing
    // withTenant gives you.
    const wrongCompany = signClaims({
      email: ownerEmail, fullName: "Session Owner", companyId: `not-their-company-${runId}`,
      companyRole: "crew", role: "worker",
    });
    const listed = await req<{ members?: { email: string }[] }>("GET", "/company/members", undefined, wrongCompany);
    assert.equal(listed.status, 200, `a bogus companyId claim broke the request: ${JSON.stringify(listed.body)}`);
    assert.ok(
      listed.body.members?.some((m) => m.email === crewEmail),
      `the company was taken from the claim, not the row: ${JSON.stringify(listed.body)}`
    );
  });
}
