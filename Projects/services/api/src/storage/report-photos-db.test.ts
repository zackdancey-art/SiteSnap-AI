/**
 * The cross-tenant photograph refusal, counted rather than silent — AUDIT L95's
 * sixth drop reason, against real Postgres.
 *
 * `normalizeBase64Image` declines a stored photograph whose upload does not
 * belong to the caller's company. That refusal is correct and is H7's guard;
 * what L95 names is that it was indistinguishable from every other reason an
 * image might not appear, and from the photograph never having been taken: "the
 * report is generated, returns 200, and reads as though those photographs were
 * never taken." A tenant-isolation refusal happening at a rate nobody can
 * measure is the kind of thing that is discovered by a customer.
 *
 * WHY THIS ONE CANNOT GO IN THE IN-MEMORY SUITE. The decision runs through
 * `uploadBelongsToActorCompany`, which on the Postgres path is a single
 * `WHERE id = $1 AND company_id = $2` with the FORCE RLS policy from migration
 * 023 behind it, and in memory is a Map lookup comparing the same field. The
 * two agree no matter what the SQL says — AUDIT L65 and the seven defects that
 * have hidden in that gap are why the predicate is measured here instead.
 *
 * NO FILE IS EVER READ. The foreign key is refused before `mediaStorage` is
 * reached, which is the whole point of the ordering in that guard, and the
 * owned key is proven owned through the store call rather than by streaming
 * bytes — this suite runs with the API's real environment, where media storage
 * may be a live S3 bucket, and a test has no business reading from it.
 *
 * BOTH CONTROLS, SAME CALL, SAME TEST. The ownership check is asserted in both
 * directions on the same function, and the refusal is measured in a
 * `buildVisionInputs` call that also attaches a usable photograph — because a
 * run that attached nothing and blamed tenancy is what deleting the attachment
 * path would look like.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "report-photos-db-test-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { getPgPool } from "./postgres";
import { recordUpload, uploadBelongsToActorCompany } from "./uploadsStore";
import { Actor } from "./actor";
import { buildVisionInputs } from "../routes/ai";

if (!process.env.TEST_DATABASE_URL) {
  test("report photograph ownership (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
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

  const runId = `${Date.now()}`;
  const hex = Math.random().toString(16).slice(2, 10).padEnd(8, "0");
  const companyA = `pho-company-a-${runId}`;
  const companyB = `pho-company-b-${runId}`;

  // Canonical `uploads/<id>-<filename>` keys, matching the shape the guard in
  // `normalizeBase64Image` requires: the id is `<digits>-<hex>`.
  const uploadA = `${runId}-a${hex}`;
  const uploadB = `${runId}-b${hex}`;
  const keyA = `uploads/${uploadA}-slab.jpg`;
  const keyB = `uploads/${uploadB}-formwork.jpg`;

  /** A 1x1 transparent GIF — the positive control that needs no storage. */
  const TINY_GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

  let pool: Pool;
  let actorA: Actor;
  let actorB: Actor;

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);

    actorA = { email: `pho-a-${runId}@test.local`, role: "worker", companyId: companyA, companyRole: "owner" };
    actorB = { email: `pho-b-${runId}@test.local`, role: "worker", companyId: companyB, companyRole: "owner" };

    // Ownership is bound at upload time from the uploader's identity, which is
    // the property the report's guard then relies on.
    await recordUpload(actorA, uploadA, "slab.jpg");
    await recordUpload(actorB, uploadB, "formwork.jpg");
  });

  after(async () => {
    await pool.end();
  });

  test("the ownership check answers both ways on the same upload pair", async () => {
    // The control that gives the refusal below its meaning: both rows exist and
    // each is readable by its own company, so a `false` is the company predicate
    // and not a missing row.
    assert.equal(await uploadBelongsToActorCompany(actorA, uploadA), true);
    assert.equal(await uploadBelongsToActorCompany(actorB, uploadB), true);

    assert.equal(await uploadBelongsToActorCompany(actorA, uploadB), false);
    assert.equal(await uploadBelongsToActorCompany(actorB, uploadA), false);
  });

  test("a photograph belonging to another company is refused AND counted — L95", async () => {
    const { content, accounting } = await buildVisionInputs(
      [
        {
          date: "2026-03-02",
          locationAddress: "4 Payload Parade",
          photos: [
            // POSITIVE CONTROL, same call: inline bytes, nothing to own, attaches.
            { base64: TINY_GIF, mimeType: "image/gif", caption: "slab" },
            // Company B's upload, referenced from company A's report. Refused
            // before `mediaStorage` is touched, and now named.
            { storageKey: keyB, mimeType: "image/jpeg" },
          ],
        },
      ],
      actorA
    );

    assert.equal(accounting.available, 2);
    assert.equal(accounting.selected, 2);
    assert.equal(accounting.attached, 1, "the caller's own photograph is still attached");
    assert.equal(content.filter((item) => item.type === "input_image").length, 1);

    // THE ASSERTION L95 IS ABOUT. Not that the image was withheld — it always
    // was — but that the report can now say so.
    assert.deepEqual(accounting.droppedByReason, { "not-owned-by-company": 1 });
    assert.equal(accounting.droppedTotal, 1);
    assert.equal(accounting.attached + accounting.droppedTotal, accounting.selected);
  });

  test("the same key in its owner's own report is not refused as foreign", async () => {
    // The mirror of the test above, and the reason it is evidence: key A under
    // actor A passes the ownership check, so `not-owned-by-company` is about
    // whose upload it is and not about stored photographs in general.
    //
    // It does not attach: nothing was ever written to media storage under this
    // id, so the read fails and the drop is `storage-read-failed`. That is the
    // distinction worth having — one refusal is a tenancy boundary and the
    // other is a missing file, and before this change both were the same
    // nothing.
    const { accounting } = await buildVisionInputs(
      [
        {
          date: "2026-03-02",
          locationAddress: "4 Payload Parade",
          photos: [{ storageKey: keyA, mimeType: "image/jpeg" }],
        },
      ],
      actorA
    );

    assert.equal(accounting.droppedTotal, 1);
    assert.equal(accounting.droppedByReason["not-owned-by-company"], undefined);
    assert.equal(accounting.droppedByReason["storage-read-failed"], 1);
  });
}
