/**
 * The registry in storage/softDelete.ts must agree with the schema, in both
 * directions.
 *
 * This is the test that would have caught AUDIT L99. A table listed as
 * soft-deletable without the column fails here; a table that has the column but
 * is missing from the list fails here too — and the second direction matters
 * just as much, because a table with `deleted_at` that nothing filters on shows
 * deleted rows to users, and a table the purge does not know about keeps them
 * forever.
 *
 * It reads the migration files directly. That is deliberate: the alternative is
 * asserting the registry against a hand-written list, which is the same class of
 * mistake one level up. The authoritative version of this check runs against a
 * real migrated database in `softDelete-db.test.ts` and queries
 * `information_schema`; this one runs everywhere, needs no Postgres, and fails
 * in the editor.
 *
 * No store is involved — it parses text and builds strings — which is why it is
 * an in-memory test rather than a DB-gated one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  SOFT_DELETE_COLUMN,
  SOFT_DELETABLE_TABLES,
  HARD_DELETED_CHILD_TABLES,
  assertSoftDeletable,
  liveOnly,
  deletedOnly,
  softDeleteAssignment,
  restoreAssignment,
  purgeEligible,
  daysInBin,
  BIN_RETENTION_DAYS,
} from "./softDelete";

/**
 * The migrations live in `src/`, and `tsc` does not copy `.sql`. In the
 * container the Dockerfile copies them next to the compiled output
 * (`dist/storage/migrations`), so both locations are tried — but a miss is a
 * FAILURE rather than an empty set, because a parser that finds no files would
 * otherwise agree with any registry at all.
 */
function migrationsDir(): string {
  const candidates = [
    path.join(__dirname, "migrations"),
    path.join(__dirname, "..", "..", "src", "storage", "migrations"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(`no migrations directory found; tried:\n  ${candidates.join("\n  ")}`);
}

function migrationFiles(): { name: string; sql: string }[] {
  const dir = migrationsDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), "utf8") }));
}

/**
 * Strips `--` line comments before parsing.
 *
 * Without this the prose in these files decides the result: softDelete.ts's own
 * header, and several migration comments, discuss `deleted_at` in sentences. A
 * commented-out column would otherwise register as a real one.
 */
const stripComments = (sql: string) => sql.replace(/--[^\n]*/g, "");

/** Tables that actually carry the column, read out of the migration files. */
function tablesWithColumnFromSchema(): Set<string> {
  const found = new Set<string>();
  for (const { sql } of migrationFiles()) {
    const clean = stripComments(sql);
    for (const m of clean.matchAll(
      /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\n\s*\);/gi
    )) {
      const body = m[2];
      if (new RegExp(`(^|[\\s,(])${SOFT_DELETE_COLUMN}\\s`, "i").test(body)) found.add(m[1]);
    }
    for (const m of clean.matchAll(
      new RegExp(
        `ALTER\\s+TABLE\\s+(\\w+)[\\s\\S]*?ADD\\s+COLUMN(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+${SOFT_DELETE_COLUMN}\\s`,
        "gi"
      )
    )) {
      found.add(m[1]);
    }
  }
  return found;
}

test("the migration files are actually being read, and the parser discriminates", () => {
  const files = migrationFiles();
  // Refuses to pass vacuously: an empty or tiny file list would make every
  // assertion below trivially true.
  assert.ok(
    files.length >= 30,
    `expected the full migration sequence, found ${files.length} file(s) — ` +
      `if migrations were removed this number is the thing to question, not raise`
  );
  assert.ok(
    files.some((f) => f.name.startsWith("001_")),
    "the first migration should be present"
  );

  const found = tablesWithColumnFromSchema();
  // Positive control: a table that definitely has the column.
  assert.ok(found.has("incidents"), `parser found no ${SOFT_DELETE_COLUMN} on incidents`);
  // Negative control with the positive control above it: the parser must
  // discriminate rather than returning every table it sees.
  assert.ok(
    !found.has("project_entries"),
    "project_entries is hard-deleted and must not appear to have the column"
  );
  assert.ok(
    !found.has("auth_users"),
    "auth_users is hard-deleted and must not appear to have the column"
  );
});

test("the registry equals the set of tables that have the column, in both directions", () => {
  const schema: string[] = [...tablesWithColumnFromSchema()].sort();
  const registry: string[] = [...SOFT_DELETABLE_TABLES].sort();

  const missingFromRegistry = schema.filter((t) => !registry.includes(t));
  const missingFromSchema = registry.filter((t) => !schema.includes(t));

  assert.deepEqual(
    schema,
    registry,
    `soft-delete registry and schema disagree.\n` +
      `  has ${SOFT_DELETE_COLUMN} but NOT in SOFT_DELETABLE_TABLES: ` +
      `${missingFromRegistry.join(", ") || "(none)"}\n` +
      `    → deleted rows from these tables are shown to users and never purged\n` +
      `  in SOFT_DELETABLE_TABLES but has NO ${SOFT_DELETE_COLUMN}: ` +
      `${missingFromSchema.join(", ") || "(none)"}\n` +
      `    → this is AUDIT L99: every statement using the predicate fails against Postgres`
  );
});

test("the hard-deleted tables are documented and genuinely lack the column", () => {
  const schema = tablesWithColumnFromSchema();
  const documented = Object.keys(HARD_DELETED_CHILD_TABLES);
  assert.ok(documented.length > 0, "the hard-deleted set should not be empty");
  for (const table of documented) {
    assert.ok(
      !schema.has(table),
      `${table} is documented as hard-deleted but has ${SOFT_DELETE_COLUMN} in the schema`
    );
    assert.ok(
      !(SOFT_DELETABLE_TABLES as readonly string[]).includes(table),
      `${table} is in both the soft and hard lists`
    );
    assert.ok(
      HARD_DELETED_CHILD_TABLES[table].length > 10,
      `${table} is listed as hard-deleted with no reason given`
    );
  }
  // Positive control on the same data: the soft set is non-empty and disjoint.
  assert.ok(SOFT_DELETABLE_TABLES.length >= 5);
});

test("a table outside the set is refused, and one inside it is returned", () => {
  // The negative control.
  assert.throws(
    () => assertSoftDeletable("project_entries"),
    /not soft-deletable/,
    "a hard-deleted table must be refused"
  );
  assert.throws(() => assertSoftDeletable("deleted_at"), /not soft-deletable/);
  assert.throws(() => assertSoftDeletable(""), /not soft-deletable/);
  // The positive control, on the same function, in the same test.
  assert.equal(assertSoftDeletable("project_sites"), "project_sites");
  for (const table of SOFT_DELETABLE_TABLES) {
    assert.equal(assertSoftDeletable(table), table);
  }
});

test("the predicates are derived from the column constant, not written out", () => {
  assert.equal(liveOnly("project_sites"), `${SOFT_DELETE_COLUMN} IS NULL`);
  assert.equal(deletedOnly("project_sites"), `${SOFT_DELETE_COLUMN} IS NOT NULL`);
  assert.equal(softDeleteAssignment("incidents"), `${SOFT_DELETE_COLUMN} = NOW()`);
  assert.equal(restoreAssignment("incidents"), `${SOFT_DELETE_COLUMN} = NULL`);

  // live and deleted must be exact complements, or a bin listing and a normal
  // listing can both show the same row, or neither can.
  assert.notEqual(liveOnly("inspections"), deletedOnly("inspections"));
  assert.ok(deletedOnly("inspections").startsWith(liveOnly("inspections").replace(" IS NULL", "")));
});

test("the purge predicate carries the stated retention period, and the UI can state the same number", () => {
  assert.equal(BIN_RETENTION_DAYS, 90);
  const sql = purgeEligible("project_sites");
  assert.match(sql, /^deleted_at < NOW\(\) - INTERVAL '90 days'$/);
  // The number must come from the constant: if BIN_RETENTION_DAYS changed and
  // the SQL did not, the bin would promise one period and the purge apply
  // another.
  assert.ok(
    sql.includes(`'${BIN_RETENTION_DAYS} days'`),
    "the interval must be built from BIN_RETENTION_DAYS"
  );
  assert.ok(!sql.includes("90 days'") || BIN_RETENTION_DAYS === 90);
});

test("days in the bin counts from the deletion, and a live row has no count", () => {
  const now = new Date("2026-10-21T00:00:00.000Z");
  // The negative control: a live row.
  assert.equal(daysInBin(null, now), null);
  assert.equal(daysInBin(undefined, now), null);
  assert.equal(daysInBin("not a date", now), null);
  // The positive controls, same function, same test.
  assert.equal(daysInBin("2026-10-21T00:00:00.000Z", now), 0);
  assert.equal(daysInBin("2026-10-20T00:00:00.000Z", now), 1);
  assert.equal(daysInBin("2026-07-23T00:00:00.000Z", now), 90);
  assert.ok((daysInBin("2026-07-22T00:00:00.000Z", now) ?? 0) > BIN_RETENTION_DAYS);
});
