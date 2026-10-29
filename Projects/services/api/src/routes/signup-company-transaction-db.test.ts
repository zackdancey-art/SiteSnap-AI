/**
 * Signup creates a company and its owner atomically, against real Postgres.
 *
 * WHY THIS EXISTS (L105)
 * `POST /auth/register/verify` called `createCompany` and then `createUser` as
 * two statements on the pool, each in its own implicit transaction. The second
 * can fail: `auth_users` carries a unique partial index on `phone`
 * (utils/phoneNumbers.ts), and two pending signups are allowed to share a
 * number because stage 1 checks the email for an existing account and nothing
 * else. So the first signup to finish takes the number, the second 409s at
 * stage 3 -- and its company row has already committed, owned by a user that
 * will never exist.
 *
 * Nothing in the product deletes that row. The person retries, usually from
 * the same address, `soloCompanyIdForEmail` derives the same id, and
 * `ON CONFLICT (id) DO UPDATE` adopts the orphan rather than reporting it.
 * Every intermediate row is permanent and unreachable.
 *
 * WHY POSTGRES AND NOT THE IN-MEMORY SUITE
 * The standing rule puts anything touching data in the DB-gated suite, and
 * this defect is specifically about what commits. The in-memory store has no
 * transactions at all: `createCompanyWithOwner` compensates there by restoring
 * a Map, which is a different mechanism proving a different thing. Only a real
 * database can show that `BEGIN`/`ROLLBACK` actually discards the company row
 * -- and the unique index that triggers the whole scenario exists only in the
 * schema. In memory the collision is detected by a linear scan of a Map, which
 * would pass this file's assertions against an implementation that had no
 * transaction in it.
 *
 * STORES TOUCHED, per L109
 *   - `storage/authStore` -- `companies`, `auth_users`,
 *     `pending_registrations`, `user_consents`.
 *   - `middleware/rateLimit`'s counter store, reset between tests.
 * `authStore.useDatabase()` reads `DATABASE_URL` and ignores
 * `TEST_DATABASE_URL`, so it IS one of the seven stores L109 names. The
 * compensating line is immediately below the gate: `DATABASE_URL` is set from
 * `TEST_DATABASE_URL` inside this file. Without it every route call here would
 * answer from the in-memory maps and the file would report coverage it does
 * not have.
 *
 * Guarded on TEST_DATABASE_URL; registers one skip placeholder without it.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "signup-company-transaction-secret";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { createApp } from "../server";
import { getPgPool } from "../storage/postgres";
import {
  USER_CONSENTS_TABLE,
  deleteUserAccount,
  findUserByEmail,
  getCompany,
} from "../storage/authStore";
import { soloCompanyIdForEmail } from "../utils/authToken";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";

if (!process.env.TEST_DATABASE_URL) {
  test("signup company transaction (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
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
  const TERMS_VERSION = "Last updated: 3 October 2026";
  const PRIVACY_VERSION = "Last updated: 4 October 2026";
  const CONSENT = {
    acceptedTerms: true,
    acceptedPrivacy: true,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
  };

  let server: http.Server;
  let baseUrl: string;
  let pool: Pool;

  /** Every address this file creates a row for, so `after` removes exactly them. */
  const created: string[] = [];
  let emailCounter = 0;
  const nextEmail = (label: string): string => {
    const email = `orphan-${label}-${emailCounter++}-${runId}@example.test`;
    created.push(email);
    return email;
  };
  // Distinct per signup unless a test deliberately collides them. The per-phone
  // OTP cap is three sends in fifteen minutes, and a shared number is the one
  // limit these tests could trip; two signups per number stays under it, and
  // beforeEach resets the counters anyway.
  let phoneCounter = 0;
  const nextPhone = (): string => `+6148${String(100000 + phoneCounter++).slice(-6)}`;

  type Answer = { status: number; body: Record<string, unknown> };

  const post = async (route: string, body: unknown): Promise<Answer> => {
    const res = await fetch(`${baseUrl}${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { error: text }; }
    return { status: res.status, body: parsed };
  };

  /**
   * Stages 1 and 2 only, stopping with a verified pending row and the SMS code
   * in hand. Split from stage 3 because every test here needs two pending
   * signups to exist SIMULTANEOUSLY on one phone number -- which is the
   * precondition the defect needs and which a single all-in-one helper cannot
   * express.
   *
   * Both stages are asserted. A helper that silently stopped working at stage 2
   * would turn every assertion below it into a test of nothing, which is the
   * exact failure docs/VACUITY-AUDIT.md was written about.
   *
   * The codes come back in `devCodes`, which the routes return only when no
   * provider is configured; test-setup.ts blanks the provider credentials, so
   * no email and no SMS leaves the process.
   */
  const beginSignup = async (
    email: string,
    phone: string,
    companyName?: string
  ): Promise<{ smsCode: string }> => {
    const initiate = await post("/api/auth/register/initiate", {
      email,
      password: `Orphan_${runId}_1A`,
      phone,
      fullName: "Orphan Tester",
      ...(companyName ? { companyName } : {}),
      ...CONSENT,
    });
    assert.equal(initiate.status, 200, `stage 1 failed: ${JSON.stringify(initiate.body)}`);
    const emailCode = (initiate.body.devCodes as { emailCode?: string } | undefined)?.emailCode;
    assert.ok(emailCode, `stage 1 returned no dev email code: ${JSON.stringify(initiate.body)}`);

    const verifyEmail = await post("/api/auth/register/verify-email", { email, emailCode });
    assert.equal(verifyEmail.status, 200, `stage 2 failed: ${JSON.stringify(verifyEmail.body)}`);
    const smsCode = (verifyEmail.body.devCodes as { smsCode?: string } | undefined)?.smsCode;
    assert.ok(smsCode, `stage 2 returned no dev sms code: ${JSON.stringify(verifyEmail.body)}`);
    return { smsCode };
  };

  const finishSignup = (email: string, smsCode: string): Promise<Answer> =>
    post("/api/auth/register/verify", { email, smsCode });

  /** Rows in `companies` for exactly these ids. Equality comparands, per L112. */
  const companyRowsFor = async (ids: string[]): Promise<string[]> => {
    const result = await pool.query<{ id: string }>(
      `SELECT id FROM companies WHERE id = ANY($1::text[]) ORDER BY id`,
      [ids]
    );
    return result.rows.map((row) => row.id);
  };

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);

    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server did not bind a port");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  beforeEach(() => {
    // Signup burns per-IP, per-account and per-phone OTP quota, and every test
    // here runs several signups from 127.0.0.1.
    resetRateLimitStoreForTests();
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    for (const email of created) {
      await deleteUserAccount(email).catch(() => {});
      // Test hygiene, not product behaviour. Deleting an account deliberately
      // does NOT delete its consent rows (migration 035), and nothing deletes
      // a company -- which is the whole subject of this file. This suite still
      // has to leave the database as it found it, including the rows it meant
      // to create.
      await pool?.query(`DELETE FROM ${USER_CONSENTS_TABLE} WHERE user_email = $1`, [email]).catch(() => {});
      await pool?.query(`DELETE FROM companies WHERE id = $1`, [soloCompanyIdForEmail(email)]).catch(() => {});
    }
    await pool?.end().catch(() => {});
  });

  test("a signup refused on the phone index leaves no company behind", async () => {
    const phone = nextPhone();
    const winner = nextEmail("winner");
    const loser = nextEmail("loser");

    // Both pending signups exist on the one number before either finishes.
    // Stage 1 checks the email for an existing account and does not look at the
    // phone, so this is reachable by two strangers who typed the same number,
    // or by one person signing up twice.
    const winnerCodes = await beginSignup(winner, phone);
    const loserCodes = await beginSignup(loser, phone);

    const first = await finishSignup(winner, winnerCodes.smsCode);
    assert.equal(first.status, 201, `the first signup should succeed: ${JSON.stringify(first.body)}`);

    const second = await finishSignup(loser, loserCodes.smsCode);
    assert.equal(
      second.status,
      409,
      `the second signup should be refused on the phone index: ${JSON.stringify(second.body)}`
    );
    assert.match(String(second.body.error), /already exists/i);

    // THE DEFECT. Before this branch the refused signup had already committed
    // its company, so this read returned a row owned by an email with no user.
    assert.equal(
      await getCompany(soloCompanyIdForEmail(loser)),
      null,
      "the refused signup left a company row behind -- the two writes are not in one transaction"
    );
    assert.equal(
      await findUserByEmail(loser),
      null,
      "the refused signup left a user row behind"
    );

    // BOTH CONTROLS, SAME ENDPOINT, SAME TEST. A getCompany that answered null
    // to everything -- or a /register/verify that had stopped creating
    // companies at all -- would pass the two assertions above having proved
    // nothing. The signup that WAS accepted must still have both of its rows.
    const winnerCompany = await getCompany(soloCompanyIdForEmail(winner));
    assert.ok(winnerCompany, "the accepted signup has no company -- the control failed, so the negatives above prove nothing");
    assert.equal(winnerCompany.ownerEmail, winner);
    const winnerUser = await findUserByEmail(winner);
    assert.ok(winnerUser, "the accepted signup has no user row");
    assert.equal(winnerUser.companyId, soloCompanyIdForEmail(winner));

    // And the population, as an equality rather than a floor (L112): of the two
    // company ids this test could have produced, exactly one exists. A floor of
    // ">= 1" cannot fail upward, which is the only direction this defect fails.
    assert.deepEqual(
      await companyRowsFor([soloCompanyIdForEmail(winner), soloCompanyIdForEmail(loser)]),
      [soloCompanyIdForEmail(winner)].sort(),
      "exactly one of the two attempted signups should own a company row"
    );
  });

  test("no orphan company is left under the refused owner's email", async () => {
    const phone = nextPhone();
    const winner = nextEmail("owner-winner");
    const loser = nextEmail("owner-loser");

    const winnerCodes = await beginSignup(winner, phone, "Winner Contracting");
    const loserCodes = await beginSignup(loser, phone, "Loser Contracting");

    assert.equal((await finishSignup(winner, winnerCodes.smsCode)).status, 201);
    assert.equal((await finishSignup(loser, loserCodes.smsCode)).status, 409);

    // Keyed on owner_email rather than on the derived id, deliberately. The
    // test above would miss an orphan written under some other id -- a future
    // company id that is not derived from the email, for instance -- and this
    // one would not.
    const orphans = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM companies WHERE owner_email = $1`,
      [loser]
    );
    assert.equal(
      orphans.rowCount,
      0,
      `the refused signup owns ${orphans.rowCount} company row(s): ${JSON.stringify(orphans.rows)}`
    );

    // The control for that query, on the same column, in the same test: the
    // accepted signup DOES own exactly one row, with the name it asked for. A
    // WHERE clause that matched nothing -- a renamed column, a case mismatch on
    // the email -- would otherwise report zero orphans forever.
    const accepted = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM companies WHERE owner_email = $1`,
      [winner]
    );
    assert.equal(accepted.rowCount, 1, "the accepted signup does not own exactly one company row");
    assert.equal(accepted.rows[0].name, "Winner Contracting");
  });

  test("retrying the refused signup with a fresh number creates the company once", async () => {
    const sharedPhone = nextPhone();
    const winner = nextEmail("retry-winner");
    const retrier = nextEmail("retry-loser");

    const winnerCodes = await beginSignup(winner, sharedPhone);
    const firstAttempt = await beginSignup(retrier, sharedPhone, "First Attempt Ltd");
    assert.equal((await finishSignup(winner, winnerCodes.smsCode)).status, 201);
    assert.equal((await finishSignup(retrier, firstAttempt.smsCode)).status, 409);

    // The retry: same address, so soloCompanyIdForEmail derives the same id.
    // This is the step that made the orphan permanent rather than merely
    // present -- ON CONFLICT (id) DO UPDATE adopted the row the failed attempt
    // had left, so the orphan became the live company and nothing ever
    // reported it.
    const retry = await beginSignup(retrier, nextPhone(), "Second Attempt Ltd");
    const finished = await finishSignup(retrier, retry.smsCode);
    assert.equal(finished.status, 201, `the retry should succeed: ${JSON.stringify(finished.body)}`);

    const rows = await pool.query<{ id: string; name: string; owner_email: string }>(
      `SELECT id, name, owner_email FROM companies WHERE owner_email = $1`,
      [retrier]
    );
    assert.equal(rows.rowCount, 1, "the retry should own exactly one company row");
    assert.equal(rows.rows[0].id, soloCompanyIdForEmail(retrier));
    assert.equal(rows.rows[0].name, "Second Attempt Ltd");

    // The control: the retried account really is usable, not just a row. The
    // token the route issued carries the company the user row points at, and
    // both must be the id above -- otherwise this test would pass against a
    // signup that created a company and no session.
    const user = await findUserByEmail(retrier);
    assert.ok(user, "the retry created no user row");
    assert.equal(user.companyId, soloCompanyIdForEmail(retrier));
    assert.equal(user.companyRole, "owner");
    assert.ok(typeof finished.body.token === "string" && finished.body.token.length > 0);
  });
}
