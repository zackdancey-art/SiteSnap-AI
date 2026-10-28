/**
 * Signup consent, against real Postgres.
 *
 * WHY THIS EXISTS
 * Nothing in this repository recorded that a user had agreed to the Terms of
 * Service or the Privacy Policy. A grep for `consent`, `terms_accepted`,
 * `privacy_accepted`, `acceptedTerms` and `termsVersion` across
 * services/api/src returned nothing at all. The signup screens linked both
 * documents and asked nothing; App Store review asks for the opposite.
 *
 * WHY POSTGRES AND NOT THE IN-MEMORY SUITE
 * The standing rule is that anything touching permissions, tenancy, ownership
 * or data is tested against Postgres, because seven defects have hidden in the
 * gap between the in-memory store and the real one. This is squarely in that
 * set: it writes rows, it reads them back through a route, and its isolation is
 * a WHERE clause on an email rather than row level security. The in-memory
 * store would answer all of it from a Map and prove none of it.
 *
 * Specifically unprovable in memory, and proven here:
 *   - `user_consents` exists with the columns the store writes (the L10/L11
 *     store-vs-schema drift class: a CREATE TABLE IF NOT EXISTS no-op column
 *     reads green against a static audit and 500s in production).
 *   - the CHECK on `document` admits exactly the two values.
 *   - `recorded_at` has a server-side default, so the ledger records when it
 *     learned a thing as well as when the thing happened.
 *   - the table is NOT row-level-security-forced, which is deliberate
 *     (migration 035) and is the sort of thing that is true or false only in a
 *     real database.
 *
 * The pure parsing half -- which bodies are accepted, refused, or treated as
 * absent -- is exhaustively covered in utils/signupConsent.test.ts, in memory,
 * because it has no store in it at all.
 *
 * Guarded on TEST_DATABASE_URL; registers one skip placeholder without it.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "signup-consent-secret";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { createApp } from "../server";
import { getPgPool } from "../storage/postgres";
import {
  CONSENT_DOCUMENTS,
  USER_CONSENTS_TABLE,
  deleteUserAccount,
  listConsents,
  recordSignupConsent,
} from "../storage/authStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";

if (!process.env.TEST_DATABASE_URL) {
  test("signup consent (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
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

  let server: http.Server;
  let baseUrl: string;
  let pool: Pool;

  /** Every address this file creates, so `after` can clean up exactly them. */
  const created: string[] = [];
  let emailCounter = 0;
  const nextEmail = (label: string): string => {
    const email = `consent-${label}-${emailCounter++}-${runId}@example.test`;
    created.push(email);
    return email;
  };
  // Globally unique within a run, per the suite's convention. Distinct per
  // signup because the per-phone OTP cap is three in fifteen minutes and is
  // the one limit here that a shared number would trip.
  let phoneCounter = 0;
  const nextPhone = (): string => `+6149${String(100000 + phoneCounter++).slice(-6)}`;

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

  const getConsents = async (token: string): Promise<Answer> => {
    const res = await fetch(`${baseUrl}/api/auth/consents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = { error: text }; }
    return { status: res.status, body: parsed };
  };

  type Returned = { document: string; version: string; acceptedAt: string; source: string };

  /**
   * The whole three-stage signup, with whatever consent fields are handed in.
   *
   * `seed()`-style rather than a bare sequence of requests: every stage is
   * asserted, because a signup helper that silently stopped working at stage two
   * would turn every assertion below it into a test of nothing -- the exact
   * failure docs/VACUITY-AUDIT.md was written about.
   *
   * The verification codes come back in `devCodes`, which the routes return only
   * when no provider is configured. test-setup.ts blanks the provider
   * credentials for every test in this suite, so that path is the one taken
   * here, and no email or SMS leaves the process.
   */
  const signup = async (
    email: string,
    consentFields: Record<string, unknown>
  ): Promise<{ token: string; consentRecorded: unknown; initiatedAt: Date }> => {
    const initiatedAt = new Date();
    const initiate = await post("/api/auth/register/initiate", {
      email,
      password: `Consent_${runId}_1A`,
      phone: nextPhone(),
      fullName: "Consent Tester",
      ...consentFields,
    });
    assert.equal(initiate.status, 200, `stage 1 failed: ${JSON.stringify(initiate.body)}`);
    const emailCode = (initiate.body.devCodes as { emailCode?: string } | undefined)?.emailCode;
    assert.ok(emailCode, `stage 1 returned no dev email code: ${JSON.stringify(initiate.body)}`);

    const verifyEmail = await post("/api/auth/register/verify-email", { email, emailCode });
    assert.equal(verifyEmail.status, 200, `stage 2 failed: ${JSON.stringify(verifyEmail.body)}`);
    const smsCode = (verifyEmail.body.devCodes as { smsCode?: string } | undefined)?.smsCode;
    assert.ok(smsCode, `stage 2 returned no dev sms code: ${JSON.stringify(verifyEmail.body)}`);

    const verify = await post("/api/auth/register/verify", { email, smsCode });
    assert.equal(verify.status, 201, `stage 3 failed: ${JSON.stringify(verify.body)}`);
    assert.ok(typeof verify.body.token === "string", "stage 3 returned no token");
    return {
      token: verify.body.token as string,
      consentRecorded: verify.body.consentRecorded,
      initiatedAt,
    };
  };

  const ACCEPTED = {
    acceptedTerms: true,
    acceptedPrivacy: true,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
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
    // Signup burns per-IP and per-account OTP quota, and every test here runs
    // several signups from 127.0.0.1.
    resetRateLimitStoreForTests();
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    for (const email of created) {
      await deleteUserAccount(email).catch(() => {});
      // Test hygiene, not product behaviour: deleting an account deliberately
      // does NOT delete its consent rows (migration 035 -- there is no foreign
      // key and no cascade, so the evidence that somebody agreed survives them
      // closing the account). This suite still has to leave the database as it
      // found it.
      await pool?.query(`DELETE FROM ${USER_CONSENTS_TABLE} WHERE user_email = $1`, [email]).catch(() => {});
    }
    await pool?.end().catch(() => {});
  });

  test("a signup that sends consent is recorded; one that does not records nothing", async () => {
    const withConsent = nextEmail("with");
    const accepted = await signup(withConsent, ACCEPTED);
    assert.equal(accepted.consentRecorded, true);

    // One row per document, each carrying its OWN version. Asserting "two rows
    // exist" would pass against a function that wrote the terms version twice.
    const rows = await listConsents(withConsent);
    assert.equal(rows.length, CONSENT_DOCUMENTS.length);
    const byDocument = new Map(rows.map((row) => [row.document, row]));
    assert.equal(byDocument.get("terms")?.version, TERMS_VERSION);
    assert.equal(byDocument.get("privacy")?.version, PRIVACY_VERSION);
    assert.equal(byDocument.get("terms")?.source, "signup");

    // The negative, and it is the one that matters: an older client sends no
    // consent fields, and the signup must still succeed with no row invented
    // for it. A row here would be a legal record of an agreement nobody gave.
    const withoutConsent = nextEmail("without");
    const silent = await signup(withoutConsent, {});
    assert.equal(silent.consentRecorded, false);
    assert.deepEqual(await listConsents(withoutConsent), []);

    // ...and the positive control for that negative, on the same store call,
    // in the same test: the account that DID send consent still has its rows.
    // Without this, a listConsents that returned [] for everybody -- or a
    // recordSignupConsent that had stopped writing -- would pass the line above.
    assert.equal((await listConsents(withConsent)).length, CONSENT_DOCUMENTS.length);
  });

  test("the route returns the caller's own consents and nobody else's", async () => {
    const mine = nextEmail("mine");
    const theirs = nextEmail("theirs");
    const mineSignup = await signup(mine, ACCEPTED);
    const theirsSignup = await signup(theirs, {
      ...ACCEPTED,
      termsVersion: "Last updated: 1 January 2020",
      privacyVersion: "Last updated: 2 January 2020",
    });

    const answer = await getConsents(mineSignup.token);
    assert.equal(answer.status, 200);
    const consents = answer.body.consents as Returned[];
    assert.equal(consents.length, CONSENT_DOCUMENTS.length);

    // The negative: the other account's distinctive versions are not in my
    // answer. `user_consents` has no company_id and no row level security --
    // migration 035 explains why at length -- so this WHERE clause is the
    // entire isolation for the table, and it is the thing most worth a test.
    for (const consent of consents) {
      assert.doesNotMatch(consent.version, /2020/);
    }
    // Both controls, same endpoint, same test: the other token DOES get the
    // other account's rows. A route that answered an empty list to everyone, or
    // 403'd everyone, would otherwise pass the loop above -- which is exactly
    // how a /uploads/sign that refused every caller shipped with the whole
    // suite green (docs/VACUITY-AUDIT.md, M7).
    const theirAnswer = await getConsents(theirsSignup.token);
    assert.equal(theirAnswer.status, 200);
    const theirConsents = theirAnswer.body.consents as Returned[];
    assert.equal(theirConsents.length, CONSENT_DOCUMENTS.length);
    assert.ok(
      theirConsents.every((consent) => /2020/.test(consent.version)),
      `the other account's own versions did not come back: ${JSON.stringify(theirConsents)}`
    );
  });

  test("the route refuses an unauthenticated caller, and serves an authenticated one", async () => {
    const email = nextEmail("auth");
    const { token } = await signup(email, ACCEPTED);

    const anonymous = await fetch(`${baseUrl}/api/auth/consents`);
    assert.equal(anonymous.status, 401);

    // The control: the same URL, with a token, answers 200 with rows. Without
    // it the 401 above would read identically against a deleted route.
    const authed = await getConsents(token);
    assert.equal(authed.status, 200);
    assert.equal((authed.body.consents as Returned[]).length, CONSENT_DOCUMENTS.length);
  });

  test("the recorded time is when the boxes were ticked, not when verification finished", async () => {
    const email = nextEmail("timing");
    const { initiatedAt } = await signup(email, ACCEPTED);
    const finishedAt = new Date();

    const [row] = await listConsents(email);
    const acceptedAt = new Date(row.acceptedAt).getTime();
    // Stage 1 is where consent is given; stage 3 is two verification codes
    // later. Stamping the verification time would be a worse record than none,
    // because it would look precise and be wrong. The window is wide on purpose
    // -- this asserts which stage the timestamp came from, not a duration.
    assert.ok(acceptedAt >= initiatedAt.getTime() - 1000, `acceptedAt ${row.acceptedAt} predates the signup`);
    assert.ok(acceptedAt <= finishedAt.getTime() + 1000, `acceptedAt ${row.acceptedAt} is after the signup finished`);

    // recorded_at is the database's own default and is a separate fact: when the
    // ledger learned it, as against when it happened. Both are stored, and the
    // default is a thing only a real database has.
    const recordedAt = new Date(row.recordedAt).getTime();
    assert.ok(Number.isFinite(recordedAt), "recorded_at came back unparseable");
    assert.ok(recordedAt >= acceptedAt - 1000, "recorded_at is before the acceptance it records");
  });

  test("a client-supplied timestamp is ignored: the server's clock is the record", async () => {
    const email = nextEmail("clock");
    const { initiatedAt } = await signup(email, {
      ...ACCEPTED,
      // A handset with a wrong clock, or a client trying to pick its own date.
      // The version string is evidence of what the client displayed, which only
      // the client knows; the time is evidence against the client.
      acceptedAt: "1999-01-01T00:00:00.000Z",
      consentAcceptedAt: "1999-01-01T00:00:00.000Z",
    });

    const [row] = await listConsents(email);
    assert.doesNotMatch(row.acceptedAt, /^1999/);
    // The control: the row exists and carries a time from this signup, so the
    // assertion above is not passing because nothing was written.
    assert.ok(new Date(row.acceptedAt).getTime() >= initiatedAt.getTime() - 1000);
  });

  test("a partial consent is refused before any signup state is created", async () => {
    const refused = `consent-partial-${runId}@example.test`;
    const partial = await post("/api/auth/register/initiate", {
      email: refused,
      password: `Consent_${runId}_1A`,
      phone: nextPhone(),
      fullName: "Consent Tester",
      // Accepted the terms, said nothing about the privacy policy. A client
      // defect, and guessing would mean recording an agreement to a document
      // the person was never shown.
      acceptedTerms: true,
      termsVersion: TERMS_VERSION,
    });
    assert.equal(partial.status, 400, JSON.stringify(partial.body));

    // Refused BEFORE the pending row and before any OTP quota: the check sits
    // with the other field validations in initiateRegistration. Read straight
    // from the table, because "the response was a 400" does not say whether a
    // row was left behind.
    const pendingRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM auth_pending_registrations WHERE email = $1`,
      [refused]
    );
    assert.equal(pendingRows.rows[0].count, "0");

    // Both controls, same endpoint: a complete consent reaches stage 1 and DOES
    // leave a pending row. Otherwise the two assertions above would pass
    // against a route that refused every signup, consent or not.
    const good = nextEmail("complete");
    const ok = await post("/api/auth/register/initiate", {
      email: good,
      password: `Consent_${runId}_1A`,
      phone: nextPhone(),
      fullName: "Consent Tester",
      ...ACCEPTED,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const goodRows = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM auth_pending_registrations WHERE email = $1`,
      [good]
    );
    assert.equal(goodRows.rows[0].count, "1");
  });

  test("the ledger appends a re-acceptance rather than overwriting the first one", async () => {
    const email = nextEmail("reaccept");
    const { token } = await signup(email, ACCEPTED);

    // What happens when the documents change and the person accepts the new
    // text. The table is deliberately NOT unique on (email, document, version)
    // -- migration 035 -- so this is an append, not a 23505.
    await recordSignupConsent(
      email,
      {
        termsVersion: "Last updated: 1 December 2026",
        privacyVersion: "Last updated: 1 December 2026",
        acceptedAt: new Date(),
      },
      "terms-update"
    );

    const rows = await listConsents(email);
    assert.equal(rows.length, CONSENT_DOCUMENTS.length * 2);
    // The first acceptance survives, which is the entire reason this is a ledger
    // and not two columns on auth_users: columns would have overwritten it, and
    // the first time the terms changed the question a consent record exists to
    // answer would have become unanswerable.
    assert.ok(rows.some((row) => row.version === TERMS_VERSION), "the original terms acceptance was lost");
    assert.ok(rows.some((row) => row.version === "Last updated: 1 December 2026"), "the new acceptance was not recorded");
    // Most recent first, so the client can take the head of each document.
    assert.ok(rows[0].acceptedAt >= rows[rows.length - 1].acceptedAt, "listConsents is not ordered newest first");
    // And the route hands all of it to the client, which is what lets
    // app/settings/data-privacy.tsx show the current version per document.
    const answer = await getConsents(token);
    assert.equal((answer.body.consents as Returned[]).length, CONSENT_DOCUMENTS.length * 2);
  });

  test("the schema admits exactly the two documents, and nothing else", async () => {
    // The CHECK constraint from migration 035, which only a real database has.
    // A third document is a migration plus a version on the request, and this is
    // what makes that true rather than aspirational.
    const email = nextEmail("check");
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO ${USER_CONSENTS_TABLE} (id, user_email, document, version, accepted_at, source)
           VALUES ($1, $2, $3, $4, NOW(), $5)`,
          [`check-${runId}`, email, "marketing", TERMS_VERSION, "test"]
        ),
      /user_consents_document_check|violates check constraint/,
    );

    // The control: the same INSERT with a permitted document succeeds. Without
    // it, a table that rejected every insert -- or did not exist -- would pass
    // the rejection above.
    for (const document of CONSENT_DOCUMENTS) {
      await pool.query(
        `INSERT INTO ${USER_CONSENTS_TABLE} (id, user_email, document, version, accepted_at, source)
         VALUES ($1, $2, $3, $4, NOW(), $5)`,
        [`check-${document}-${runId}`, email, document, TERMS_VERSION, "test"]
      );
    }
    assert.equal((await listConsents(email)).length, CONSENT_DOCUMENTS.length);
  });

  test("the consent table is not row-level-security-forced, deliberately", async () => {
    // Migration 035 writes out why: consent is a fact about a person, not about
    // a company, and an invited signup's company_id is "" at the moment the row
    // is written -- so an RLS-forced company column here would have made every
    // invited user's consent invisible to their actual employer, silently,
    // matching zero rows with no error. That is the failure mode migration 025
    // documents, and it is worth asserting rather than trusting.
    const forced = await pool.query<{ relforcerowsecurity: boolean }>(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = $1`,
      [USER_CONSENTS_TABLE]
    );
    assert.equal(forced.rows.length, 1, `${USER_CONSENTS_TABLE} is not in pg_class -- the migration did not run`);
    assert.equal(forced.rows[0].relforcerowsecurity, false);

    // The control that makes that a measurement rather than a tautology: a
    // table this codebase DOES force is reported as forced by the same query.
    // Without it, a typo'd column name or a pg_class that answered false to
    // everything would read as "deliberately not forced".
    const control = await pool.query<{ relforcerowsecurity: boolean }>(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'project_entries'`
    );
    assert.equal(control.rows.length, 1);
    assert.equal(control.rows[0].relforcerowsecurity, true);
  });
}
