import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";

/**
 * Applies the migrations to a test database. One copy.
 *
 * There were eleven, in five variants. The variants differed by formatting, by
 * whether the applied-set was called `applied` or `done`, by `"utf-8"` versus
 * `"utf8"`, and by the wording of the error thrown when a migration fails.
 * Nothing else: every copy created schema_migrations, read the applied set,
 * sorted the directory, skipped what was applied, and ran each remaining file
 * in its own transaction with a ROLLBACK and a rethrow on failure.
 *
 * Eleven behaviourally identical copies is not a style problem. It is eleven
 * places to edit when the migration mechanism changes and eleven chances to
 * edit ten of them, and it is the thing standing between this repo and running
 * the whole suite against Postgres — which needs one place that knows how to
 * bring a database up, not eleven.
 *
 * WHY process.cwd() AND NOT __dirname
 *
 * All eleven copies resolved the migrations directory from process.cwd(), and
 * scripts/run-tests.sh cd's to the package root before running node, so this is
 * correct under the runner. It is kept rather than improved because these are
 * DB-gated suites: they skip without TEST_DATABASE_URL, there is no Postgres on
 * the machine this was hoisted on, and so the eleven call sites could not be
 * executed to prove a change of path semantics safe. Preserving what demonstrably
 * works beats improving what cannot be checked.
 */
export const MIGRATIONS_DIR = path.join(process.cwd(), "src", "storage", "migrations");

export async function applyMigrations(pool: Pool): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  );
  const applied = new Set(
    (await pool.query<{ version: string }>(`SELECT version FROM schema_migrations`)).rows.map((r) => r.version)
  );
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
}
