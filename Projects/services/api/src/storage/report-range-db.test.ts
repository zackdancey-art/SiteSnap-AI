/**
 * Postgres proof for the report date range — AUDIT L98 and the schema half of
 * AUDIT L99's rule about literals in predicates.
 *
 * Two things are proven here and can only be proven here.
 *
 * 1. THE COLUMN NAMED IN THE PREDICATE EXISTS. `listEntries` builds its range
 *    clause from `PROJECT_ENTRY_DATE_COLUMN` on `PROJECT_ENTRIES_TABLE` rather
 *    than from a hand-written `date`, and this file asserts against
 *    `information_schema.columns` that the pair names something real, with the
 *    type the string comparison assumes. L99 is what the absence of this test
 *    cost once already: a `deleted_at IS NULL` predicate against a column in no
 *    migration, so the write matched zero rows and site progress had never
 *    worked in production. Nothing errored — the predicate was just false. A
 *    static read of the source cannot catch that; only the live schema can.
 *
 * 2. THE RANGE IS APPLIED IN SQL, BEFORE THE LIMIT. This is the actual L98
 *    defect and it is invisible in the in-memory store, where `limit` is a
 *    `.slice()` over a Map that holds every row the test wrote. The report used
 *    to load `limit` rows ordered by `timestamp DESC` and filter them by period
 *    afterwards, so a window of older entries was crowded out by newer entries
 *    OUTSIDE it — the report came back empty or short, and said nothing about
 *    what it had dropped. The fixture below is built to make that concrete: the
 *    two in-window entries are written FIRST (older timestamps) and three
 *    out-of-window entries after them (newer), with the limit set to 2. Filter
 *    first and you get both March entries; paginate first and you get two April
 *    entries and no March at all.
 *
 * RED ON REVERT. Remove the `if (range)` block from `listEntries`' Postgres
 * path and test 2 goes red on the ranged read — it returns the April entries.
 * Rename the column constant to anything else and test 1 goes red on the
 * information_schema assertion while test 2 goes red on a SQL error.
 *
 * Every negative assertion here has a positive control on the same call in the
 * same test: "the window excludes April" is paired with "the same query without
 * a range returns April", so deleting the range parameter outright cannot pass,
 * and "company A cannot see B's in-window entry" is paired with "B can".
 *
 * Guarded like the other DB suites: without `TEST_DATABASE_URL` it registers
 * one skipped placeholder and touches no database.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "report-range-db-test-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { getPgPool } from "./postgres";
import { withTenant } from "./tenant";
import { Actor } from "./actor";
import {
  createEntry,
  listEntries,
  PROJECT_ENTRIES_TABLE,
  PROJECT_ENTRY_DATE_COLUMN,
} from "./projectsStore";

if (!process.env.TEST_DATABASE_URL) {
  test("report date range (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // Same minimal migration runner as the other DB suites.
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
  const companyA = `rng-company-a-${runId}`;
  const companyB = `rng-company-b-${runId}`;
  const ownerA = `rng-owner-a-${runId}@test.local`;
  const ownerB = `rng-owner-b-${runId}@test.local`;
  const siteA = `rng-site-a-${runId}`;
  const siteB = `rng-site-b-${runId}`;

  const MARCH = { from: "2026-03-01", to: "2026-03-31" };

  let pool: Pool;
  let actorA: Actor;
  let actorB: Actor;

  const entryInput = (siteId: string, date: string) => ({
    siteId,
    date,
    locationAddress: "1 Range Road",
    weather: "Fine",
    crewCount: "4",
    notes: `work on ${date}`,
    photos: [],
  });

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);

    actorA = { email: ownerA, role: "worker", companyId: companyA, companyRole: "owner" };
    actorB = { email: ownerB, role: "worker", companyId: companyB, companyRole: "owner" };

    await pool.query(
      `INSERT INTO auth_users (email, password_hash, full_name, company_id, company_role)
       VALUES ($1, 'x', 'Range Owner A', $2, 'owner'), ($3, 'x', 'Range Owner B', $4, 'owner')`,
      [ownerA, companyA, ownerB, companyB]
    );

    // project_sites is FORCE RLS (022) — insert inside withTenant.
    await withTenant({ companyId: companyA }, (client) =>
      client.query(
        `INSERT INTO project_sites (id, owner_email, name, address, client, start_date, status, company_id)
         VALUES ($1, $2, 'Range Site A', '1 Range Rd', 'Client A', '2026-01-01', 'active', $3)`,
        [siteA, ownerA, companyA]
      )
    );
    await withTenant({ companyId: companyB }, (client) =>
      client.query(
        `INSERT INTO project_sites (id, owner_email, name, address, client, start_date, status, company_id)
         VALUES ($1, $2, 'Range Site B', '1 Range Rd', 'Client B', '2026-01-01', 'active', $3)`,
        [siteB, ownerB, companyB]
      )
    );

    // ORDER MATTERS. `createEntry` stamps `timestamp` with the wall clock, and
    // `listEntries` orders by it descending — so the in-window entries are
    // written first precisely so that a limit applied BEFORE the range filter
    // would exclude them. See the file comment.
    await createEntry(actorA, entryInput(siteA, "2026-03-02"));
    await createEntry(actorA, entryInput(siteA, "2026-03-05"));
    await createEntry(actorA, entryInput(siteA, "2026-04-20"));
    await createEntry(actorA, entryInput(siteA, "2026-04-21"));
    await createEntry(actorA, entryInput(siteA, "2026-04-22"));

    // Company B's entry sits INSIDE company A's window, so the range predicate
    // cannot be what excludes it — the tenant predicate has to be.
    await createEntry(actorB, entryInput(siteB, "2026-03-03"));
  });

  after(async () => {
    await pool.end();
  });

  test("the column the range predicate names exists on the table it names", async () => {
    const result = await pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
         FROM information_schema.columns
        WHERE table_name = $1 AND column_name = $2`,
      [PROJECT_ENTRIES_TABLE, PROJECT_ENTRY_DATE_COLUMN]
    );

    assert.equal(
      result.rowCount,
      1,
      `${PROJECT_ENTRIES_TABLE}.${PROJECT_ENTRY_DATE_COLUMN} is named in a SQL predicate but is not a column on that table`
    );
    // The range comparison is a string comparison on YYYY-MM-DD. If this column
    // ever becomes a real `date`, the comparison still works but the in-memory
    // store's string compare and this one stop being the same operation, which
    // is the disagreement reportWindow.ts exists to prevent.
    assert.equal(result.rows[0].data_type, "text");

    // Positive control for the query itself: a column known to exist is found,
    // so a rowCount of 1 above means "found" rather than "information_schema
    // answered nothing for this table".
    const control = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'site_id'`,
      [PROJECT_ENTRIES_TABLE]
    );
    assert.equal(control.rowCount, 1);
  });

  test("the range filters in SQL, before the limit — L98", async () => {
    // The window, with a limit smaller than the number of rows on the site.
    const windowed = await listEntries(actorA, siteA, 2, 0, MARCH);
    const windowedDates = windowed.map((entry) => entry.date).sort();

    assert.deepEqual(
      windowedDates,
      ["2026-03-02", "2026-03-05"],
      "the ranged read must return the in-window entries, not the newest two rows"
    );

    // POSITIVE CONTROL on the same call. Without the range, the same limit over
    // the same site returns the April rows — which proves the April rows exist,
    // that the limit is live, and that it is the range and not an empty table
    // doing the work above. Delete the range parameter and this pair cannot
    // both pass.
    const unwindowed = await listEntries(actorA, siteA, 2, 0);
    const unwindowedDates = unwindowed.map((entry) => entry.date).sort();
    assert.deepEqual(unwindowedDates, ["2026-04-21", "2026-04-22"]);
    assert.equal(
      unwindowedDates.some((date) => date.startsWith("2026-03")),
      false,
      "the unranged read must NOT reach March under this limit — if it does, the fixture no longer demonstrates L98"
    );
  });

  test("the range is inclusive at both ends, and excludes the day either side", async () => {
    const exact = await listEntries(actorA, siteA, 50, 0, { from: "2026-03-02", to: "2026-03-05" });
    assert.deepEqual(exact.map((e) => e.date).sort(), ["2026-03-02", "2026-03-05"]);

    const inside = await listEntries(actorA, siteA, 50, 0, { from: "2026-03-03", to: "2026-03-04" });
    assert.deepEqual(inside.map((e) => e.date), [], "a window between the two entries holds neither");

    // Positive control for that empty result: widen by one day at each end and
    // the entries come back, so the emptiness above is the predicate and not a
    // broken query.
    const widened = await listEntries(actorA, siteA, 50, 0, { from: "2026-03-02", to: "2026-03-04" });
    assert.deepEqual(widened.map((e) => e.date), ["2026-03-02"]);
  });

  test("a ranged read stays inside the caller's company", async () => {
    const aSees = await listEntries(actorA, undefined, 50, 0, MARCH);
    const aDates = aSees.map((entry) => entry.date).sort();

    // A sees its OWN in-window entries — the positive control that makes the
    // exclusion below mean something.
    assert.deepEqual(aDates, ["2026-03-02", "2026-03-05"]);
    assert.equal(
      aSees.some((entry) => entry.siteId === siteB),
      false,
      "company A's ranged read must not reach company B's entry, which is inside the same window"
    );

    // And B sees its own, through the same call with the same range: so the
    // row is present, dated inside the window, and visible to its owner.
    const bSees = await listEntries(actorB, undefined, 50, 0, MARCH);
    assert.deepEqual(bSees.map((entry) => entry.date), ["2026-03-03"]);
    assert.equal(bSees.every((entry) => entry.siteId === siteB), true);
  });
}
