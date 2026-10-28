/**
 * RLS integration test for AUDIT.md finding H1 ("multi-tenancy is
 * convention-only" — company scoping was hand-written WHERE clauses with no
 * database-level backstop). Migrations 019-022 add Postgres Row-Level
 * Security to the tenanted tables; this is the only test in the suite that
 * can actually prove RLS works, because the rest of the suite runs against
 * the in-memory store fallback (DATABASE_URL="" under NODE_ENV=test — see
 * test-setup.ts) and never touches Postgres at all.
 *
 * Guarded: this test needs a real, disposable Postgres database. Without
 * `TEST_DATABASE_URL` set it registers a single skipped placeholder test and
 * does nothing else — no live DB connection is attempted. This is the
 * documented, intended behaviour for the sandbox this suite normally runs
 * in; it is expected to SKIP here.
 *
 * `getPgPool()` (storage/postgres.ts) already special-cases NODE_ENV==="test":
 * it connects using TEST_DATABASE_URL (never DATABASE_URL, even if a test
 * accidentally sets it), so we can call it directly with no extra plumbing.
 *
 * `incidents` is used as the RLS table under test — migration
 * 019_rls_incidents_reference.sql documents it as the reference/proof table
 * (ENABLE + FORCE ROW LEVEL SECURITY, USING/WITH CHECK against
 * current_setting('app.company_id', true)); project_sites carries the same
 * policy shape as of migration 022.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { Client } from "pg";
import type { Pool } from "pg";
import { getPgPool } from "./postgres";
import { withTenant } from "./tenant";
import { applyMigrations } from "./testMigrations";

if (!process.env.TEST_DATABASE_URL) {
  test("RLS integration (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // ── Migration runner ──────────────────────────────────────────────────────
  // storage/migrate.ts's runMigrations() is gated on `process.env.DATABASE_URL`
  // (not TEST_DATABASE_URL) and is a no-op under NODE_ENV=test, so it can't be
  // reused directly here. This is a minimal, idempotent re-implementation of
  // the same "schema_migrations tracking table + apply anything new, in
  // filename order" pattern against whichever pool getPgPool() hands back.
  //
  // The compiled test runs from dist/storage/*.test.js, and the build does not
  // copy the .sql migration files into dist/ (confirmed: no dist/storage/migrations
  // directory exists after `pnpm run build`). The package's own `test` script
  // always runs from the services/api package root (via pnpm), so migrations
  // are read from the *source* tree relative to process.cwd() rather than
  // __dirname.


  // ── Fixture identifiers (unique per run so re-runs against a persistent
  // TEST_DATABASE_URL don't collide with leftovers from a previous run) ──────
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const companyA = `rls-test-company-a-${runId}`;
  const companyB = `rls-test-company-b-${runId}`;
  const ownerAEmail = `rls-test-owner-a-${runId}@test.local`;
  const ownerBEmail = `rls-test-owner-b-${runId}@test.local`;
  const siteAId = `rls-test-site-a-${runId}`;
  const siteBId = `rls-test-site-b-${runId}`;
  const incidentAId = `rls-test-incident-a-${runId}`;
  const incidentBId = `rls-test-incident-b-${runId}`;
  // RLS assertions MUST run as a NOBYPASSRLS role. The test/app owner (e.g.
  // Neon's neondb_owner) has BYPASSRLS, which bypasses the policy entirely and
  // would make every isolation check pass/fail for the wrong reason. All three
  // assertions below run through this dedicated non-bypass login role.
  const probeRole = `rls_int_probe_${runId.replace(/[^a-z0-9]/gi, "")}`;
  const probePassword = `Rls_Int_${Date.now()}_9xZq`;

  let pool: Pool;
  let probe: Client;

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);

    // auth_users has no RLS policy (only company-scoped operational tables
    // do), so a bare INSERT is fine here.
    await pool.query(
      `INSERT INTO auth_users (email, password_hash, full_name, company_id, company_role)
       VALUES ($1, 'x', 'RLS Test Owner A', $2, 'owner'), ($3, 'x', 'RLS Test Owner B', $4, 'owner')`,
      [ownerAEmail, companyA, ownerBEmail, companyB]
    );

    // project_sites and incidents are both FORCE ROW LEVEL SECURITY as of
    // migrations 022 and 019 respectively, so their INSERTs must run inside
    // withTenant() for the WITH CHECK clause to see a matching app.company_id.
    await withTenant({ companyId: companyA }, (client) =>
      client.query(
        `INSERT INTO project_sites (id, owner_email, name, address, client, start_date, status, company_id)
         VALUES ($1, $2, 'RLS Test Site A', '1 Test St', 'Test Client', '2026-01-01', 'active', $3)`,
        [siteAId, ownerAEmail, companyA]
      )
    );
    await withTenant({ companyId: companyB }, (client) =>
      client.query(
        `INSERT INTO project_sites (id, owner_email, name, address, client, start_date, status, company_id)
         VALUES ($1, $2, 'RLS Test Site B', '1 Test St', 'Test Client', '2026-01-01', 'active', $3)`,
        [siteBId, ownerBEmail, companyB]
      )
    );

    await withTenant({ companyId: companyA }, (client) =>
      client.query(
        `INSERT INTO incidents (id, owner_email, site_id, date, severity, description, company_id)
         VALUES ($1, $2, $3, '2026-01-01', 'minor', 'RLS test incident A', $4)`,
        [incidentAId, ownerAEmail, siteAId, companyA]
      )
    );
    await withTenant({ companyId: companyB }, (client) =>
      client.query(
        `INSERT INTO incidents (id, owner_email, site_id, date, severity, description, company_id)
         VALUES ($1, $2, $3, '2026-01-01', 'minor', 'RLS test incident B', $4)`,
        [incidentBId, ownerBEmail, siteBId, companyB]
      )
    );

    // Create + connect the NOBYPASSRLS probe role (seeding above runs as the
    // owner, which is fine — only the *assertions* must be non-bypass).
    await pool.query(`DROP ROLE IF EXISTS ${probeRole}`);
    await pool.query(`CREATE ROLE ${probeRole} LOGIN PASSWORD '${probePassword}' NOBYPASSRLS`);
    await pool.query(`GRANT SELECT, INSERT ON incidents TO ${probeRole}`);
    const probeUrl = new URL(process.env.TEST_DATABASE_URL as string);
    probeUrl.username = probeRole;
    probeUrl.password = probePassword;
    probeUrl.searchParams.delete("channel_binding");
    probeUrl.searchParams.delete("sslmode");
    // SSL only when the target DB requires it (Neon: PG_SSL=require); a plain
    // Postgres (CI postgres:16 service) rejects a forced ssl handshake. Mirror getPgPool().
    probe = new Client({ connectionString: probeUrl.toString(), ssl: process.env.PG_SSL === "require" ? { rejectUnauthorized: false } : undefined });
    await probe.connect();
  });

  after(async () => {
    try {
      await probe.end();
    } catch {
      /* ignore */
    }
    await pool.query(`REVOKE ALL ON incidents FROM ${probeRole}`).catch(() => {});
    await pool.query(`DROP ROLE IF EXISTS ${probeRole}`).catch(() => {});
    // Deletes on the RLS-forced tables must also run inside withTenant() —
    // a bare-connection DELETE would see zero rows (same fail-closed
    // behaviour under test below) and silently delete nothing.
    await withTenant({ companyId: companyA }, async (client) => {
      await client.query(`DELETE FROM incidents WHERE id = $1`, [incidentAId]);
      await client.query(`DELETE FROM project_sites WHERE id = $1`, [siteAId]);
    });
    await withTenant({ companyId: companyB }, async (client) => {
      await client.query(`DELETE FROM incidents WHERE id = $1`, [incidentBId]);
      await client.query(`DELETE FROM project_sites WHERE id = $1`, [siteBId]);
    });
    await pool.query(`DELETE FROM auth_users WHERE email = $1`, [ownerAEmail]);
    await pool.query(`DELETE FROM auth_users WHERE email = $1`, [ownerBEmail]);
    await pool.end();
  });

  test("a: tenant context (company A) sees only company A's incident — via a NOBYPASSRLS role", async () => {
    await probe.query("BEGIN");
    await probe.query("SELECT set_config('app.company_id', $1, true)", [companyA]);
    const result = await probe.query<{ id: string; company_id: string }>(
      `SELECT id, company_id FROM incidents WHERE id IN ($1, $2)`,
      [incidentAId, incidentBId]
    );
    await probe.query("ROLLBACK");
    assert.equal(result.rows.length, 1, `expected exactly 1 visible row, got ${result.rows.length}`);
    assert.equal(result.rows[0].id, incidentAId);
    assert.equal(result.rows[0].company_id, companyA);
  });

  test("b: no app.company_id set sees zero rows (fail-closed) — via a NOBYPASSRLS role", async () => {
    // No transaction / no set_config → current_setting('app.company_id', true)
    // is NULL → the policy matches nothing. This is the forgot-to-wrap failure
    // mode RLS exists to catch, observed on a role that cannot bypass the policy.
    const result = await probe.query<{ id: string }>(
      `SELECT id FROM incidents WHERE id IN ($1, $2)`,
      [incidentAId, incidentBId]
    );
    assert.equal(
      result.rows.length,
      0,
      `expected zero rows with no app.company_id; RLS must fail closed, not leak either tenant's row. Got: ${JSON.stringify(result.rows)}`
    );
  });

  test("c: an INSERT whose company_id does not match the tenant context is rejected by WITH CHECK — via a NOBYPASSRLS role", async () => {
    const rogueId = `rls-test-incident-rogue-${runId}`;
    await probe.query("BEGIN");
    await probe.query("SELECT set_config('app.company_id', $1, true)", [companyA]);
    await assert.rejects(
      () =>
        probe.query(
          `INSERT INTO incidents (id, owner_email, site_id, date, severity, description, company_id)
           VALUES ($1, $2, $3, '2026-01-01', 'minor', 'should be rejected by WITH CHECK', $4)`,
          [rogueId, ownerAEmail, siteAId, companyB] // tenant context is A, but company_id column says B
        ),
      /row-level security|policy/i,
      "an INSERT stamping a different company_id than the active tenant context must be rejected by the WITH CHECK policy"
    );
    await probe.query("ROLLBACK");

    // Belt-and-braces: confirm the rejected row was not committed.
    await probe.query("BEGIN");
    await probe.query("SELECT set_config('app.company_id', $1, true)", [companyA]);
    const check = await probe.query(`SELECT id FROM incidents WHERE id = $1`, [rogueId]);
    await probe.query("ROLLBACK");
    assert.equal(check.rows.length, 0, "rejected INSERT must not have left a row behind");
  });
}
