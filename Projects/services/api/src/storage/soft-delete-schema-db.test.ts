/**
 * The authoritative check that the soft-delete registry matches the database,
 * and that the predicates it builds actually execute.
 *
 * `softDelete.test.ts` parses the migration files and runs everywhere. This one
 * asks Postgres. The difference matters: AUDIT L99 was a predicate naming a
 * column that did not exist, and the thing that would have caught it is not a
 * parser agreeing with a list — it is a statement being executed. For months
 * nothing executed `deleted_at IS NULL` against `project_sites` outside
 * production, where it failed on every call and the error went to a log nobody
 * read.
 *
 * So this suite does three things no file-parsing test can:
 *   1. asks `information_schema` which tables really have the column, and what
 *      type and nullability it has;
 *   2. EXECUTES every predicate the registry builds, against every table in the
 *      set — the statement either runs or it does not;
 *   3. round-trips a real site through soft delete and restore, inside
 *      `withTenant`, so the assignment strings are proved and not just read.
 *
 * It deletes nothing. The purge predicate is executed as a SELECT only — see the
 * comment on that test. Nothing in this file issues a DELETE or a DROP.
 *
 * Guarded like the other DB suites: without TEST_DATABASE_URL it registers one
 * skipped placeholder and opens no connection.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "soft-delete-schema-test-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { getPgPool } from "./postgres";
import { withTenant } from "./tenant";
import {
  SOFT_DELETE_COLUMN,
  SOFT_DELETABLE_TABLES,
  HARD_DELETED_CHILD_TABLES,
  liveOnly,
  deletedOnly,
  softDeleteAssignment,
  restoreAssignment,
  purgeEligible,
} from "./softDelete";

if (!process.env.TEST_DATABASE_URL) {
  test("soft-delete schema agreement (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  const MIGRATIONS_DIR = path.join(process.cwd(), "src", "storage", "migrations");

  const applyMigrations = async (pool: Pool): Promise<void> => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const appliedResult = await pool.query<{ version: string }>(`SELECT version FROM schema_migrations`);
    const applied = new Set(appliedResult.rows.map((r) => r.version));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      if (applied.has(version)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf-8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${version} failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        client.release();
      }
    }
  };

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const companyId = `sd-company-${runId}`;
  const ownerEmail = `sd-owner-${runId}@test.local`;
  const siteId = `sd-site-${runId}`;

  let pool: Pool;

  before(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    pool = getPgPool();
    await applyMigrations(pool);
    await pool.query(
      `INSERT INTO auth_users (email, password_hash, full_name, company_id, company_role)
       VALUES ($1, 'x', 'Soft Delete Test Owner', $2, 'owner')`,
      [ownerEmail, companyId]
    );
    await withTenant({ companyId }, (client) =>
      client.query(
        `INSERT INTO project_sites (id, owner_email, name, address, client, start_date, status, company_id)
         VALUES ($1, $2, 'Soft Delete Test Site', '1 Bin St', 'Bin Client', '2026-01-01', 'active', $3)`,
        [siteId, ownerEmail, companyId]
      )
    );
  });

  after(async () => {
    // Leaves the site row in place: this suite does not delete rows, and a
    // unique runId means it never collides with a later run. Removing it here
    // would be the one DELETE in the file.
    await pool.end().catch(() => {});
  });

  const columnInfo = async (table: string) =>
    (
      await pool.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
        `SELECT data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2`,
        [table, SOFT_DELETE_COLUMN]
      )
    ).rows;

  test("every table in the registry really has the column, nullable and timestamped", async () => {
    // Refuses to pass vacuously: an empty registry would make the loop below a
    // no-op and the test green.
    assert.ok(SOFT_DELETABLE_TABLES.length >= 5, "the registry should not have shrunk");

    for (const table of SOFT_DELETABLE_TABLES) {
      const rows = await columnInfo(table);
      assert.equal(
        rows.length,
        1,
        `${table} is in SOFT_DELETABLE_TABLES but information_schema reports ` +
          `${rows.length} ${SOFT_DELETE_COLUMN} column(s). This is AUDIT L99.`
      );
      assert.equal(
        rows[0].data_type,
        "timestamp with time zone",
        `${table}.${SOFT_DELETE_COLUMN} must be TIMESTAMPTZ — the purge compares it to NOW()`
      );
      assert.equal(
        rows[0].is_nullable,
        "YES",
        `${table}.${SOFT_DELETE_COLUMN} must be nullable — NULL is how a live row is spelled`
      );
      assert.equal(
        rows[0].column_default,
        null,
        `${table}.${SOFT_DELETE_COLUMN} must have no default, or new rows arrive pre-deleted`
      );
    }
  });

  test("the hard-deleted tables really do not have the column", async () => {
    const documented = Object.keys(HARD_DELETED_CHILD_TABLES);
    assert.ok(documented.length > 0, "the hard-deleted set should not be empty");
    for (const table of documented) {
      const rows = await columnInfo(table);
      assert.equal(
        rows.length,
        0,
        `${table} is documented as hard-deleted but has a ${SOFT_DELETE_COLUMN} column — ` +
          `its deleted rows are invisible to every listing and to the purge`
      );
    }
    // The positive control, on the same query against the same catalogue: the
    // query does find the column when it is there. Without this, a typo in
    // columnInfo would make every assertion above pass.
    const control = await columnInfo("incidents");
    assert.equal(control.length, 1, "columnInfo must find the column on a table that has it");
  });

  test("every predicate the registry builds executes against every table in the set", async () => {
    // This is the test that would have caught L99: it runs the statement.
    for (const table of SOFT_DELETABLE_TABLES) {
      for (const [label, predicate] of [
        ["liveOnly", liveOnly(table)],
        ["deletedOnly", deletedOnly(table)],
        ["purgeEligible", purgeEligible(table)],
      ] as const) {
        // A SELECT, never a DELETE — including for purgeEligible, whose whole
        // point in production is to precede a DELETE that this suite must not
        // perform. LIMIT 1 keeps it O(1) on a seeded database.
        await assert.doesNotReject(
          () => pool.query(`SELECT 1 FROM ${table} WHERE ${predicate} LIMIT 1`),
          `${label}("${table}") does not execute against the real schema`
        );
      }
    }

    // The positive control that the harness above can actually fail: a
    // deliberately wrong predicate must be rejected. Without this, a
    // doesNotReject that silently swallowed everything would read green.
    await assert.rejects(
      () => pool.query(`SELECT 1 FROM project_sites WHERE no_such_column IS NULL LIMIT 1`),
      /no_such_column/,
      "a predicate naming a missing column must fail — this is the L99 failure mode"
    );
  });

  test("a site round-trips into the bin and back out, and the bin and live listings are exact complements", async () => {
    const read = async () =>
      (
        await withTenant({ companyId }, (client) =>
          client.query<{ deleted_at: Date | null }>(
            `SELECT deleted_at FROM project_sites WHERE id = $1`,
            [siteId]
          )
        )
      ).rows[0];

    const inList = async (predicate: string) =>
      (
        await withTenant({ companyId }, (client) =>
          client.query(`SELECT 1 FROM project_sites WHERE id = $1 AND ${predicate}`, [siteId])
        )
      ).rowCount ?? 0;

    // Starts live.
    assert.equal((await read()).deleted_at, null, "a new site must start live");
    assert.equal(await inList(liveOnly("project_sites")), 1, "a live site is in the live listing");
    assert.equal(await inList(deletedOnly("project_sites")), 0, "a live site is not in the bin");

    // Into the bin, using the registry's assignment string.
    await withTenant({ companyId }, (client) =>
      client.query(
        `UPDATE project_sites SET ${softDeleteAssignment("project_sites")} WHERE id = $1`,
        [siteId]
      )
    );
    const binned = await read();
    assert.ok(binned.deleted_at instanceof Date, "soft delete must stamp a real timestamp");
    assert.equal(await inList(liveOnly("project_sites")), 0, "a binned site leaves the live listing");
    assert.equal(await inList(deletedOnly("project_sites")), 1, "a binned site appears in the bin");

    // The row and its children are still there — that is the entire point.
    const stillThere = await withTenant({ companyId }, (client) =>
      client.query(`SELECT name, owner_email FROM project_sites WHERE id = $1`, [siteId])
    );
    assert.equal(stillThere.rowCount, 1, "soft delete must not remove the row");
    assert.equal(stillThere.rows[0].name, "Soft Delete Test Site", "soft delete must not alter the row");

    // Not yet purgeable: it went into the bin a moment ago, not 90 days ago.
    assert.equal(
      await inList(purgeEligible("project_sites")),
      0,
      "a site binned seconds ago must not be purge-eligible"
    );

    // Back out of the bin.
    await withTenant({ companyId }, (client) =>
      client.query(
        `UPDATE project_sites SET ${restoreAssignment("project_sites")} WHERE id = $1`,
        [siteId]
      )
    );
    assert.equal((await read()).deleted_at, null, "restore must clear the timestamp");
    assert.equal(await inList(liveOnly("project_sites")), 1, "a restored site returns to the live listing");
    assert.equal(await inList(deletedOnly("project_sites")), 0, "a restored site leaves the bin");
  });

  test("a site in the bin keeps its children, which is what the hard delete destroyed", async () => {
    // project_entries cascades from project_sites ON DELETE CASCADE, so a hard
    // delete of the site takes every entry with it. The bin must not.
    const entryId = `sd-entry-${runId}`;
    await withTenant({ companyId }, (client) =>
      client.query(
        `INSERT INTO project_entries (id, owner_email, site_id, date, notes, company_id)
         VALUES ($1, $2, $3, '2026-01-02', 'bin test entry', $4)`,
        [entryId, ownerEmail, siteId, companyId]
      )
    );

    const entryCount = async () =>
      (
        await withTenant({ companyId }, (client) =>
          client.query(`SELECT 1 FROM project_entries WHERE id = $1`, [entryId])
        )
      ).rowCount ?? 0;

    assert.equal(await entryCount(), 1, "the fixture entry should exist");

    await withTenant({ companyId }, (client) =>
      client.query(
        `UPDATE project_sites SET ${softDeleteAssignment("project_sites")} WHERE id = $1`,
        [siteId]
      )
    );
    assert.equal(
      await entryCount(),
      1,
      "binning a site must keep its entries — the photographs are the evidence"
    );

    await withTenant({ companyId }, (client) =>
      client.query(
        `UPDATE project_sites SET ${restoreAssignment("project_sites")} WHERE id = $1`,
        [siteId]
      )
    );
    assert.equal(await entryCount(), 1, "restoring a site must still have its entries");
  });
}
