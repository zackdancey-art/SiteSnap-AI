import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  auditSqlReferences,
  extractSqlLiterals,
  parseDeclarations,
  stripSqlComments,
  type DeclaredSchema,
  type SqlLiteral,
} from "./sqlSchemaAudit";

/**
 * AUDIT L99, made unrepeatable.
 *
 * This suite is in-memory on purpose and it is the documented exception to
 * "every new test goes in the DB-gated suite", not a dodge around it. The rule
 * exists because assertions about permissions, tenancy and ownership are
 * assertions about what a STORE does, and the in-memory store has repeatedly
 * disagreed with Postgres about that. This test touches no store. It reads the
 * migration files and the store SOURCE as text and compares two static
 * artefacts, so there is no second implementation for it to be wrong about, and
 * running it against a database would not make it check anything more.
 *
 * It is also the half of the Postgres-in-CI argument that needs no Postgres: of
 * the seven defects that have hidden between the two stores, L99 is the one no
 * in-memory test could ever have caught, because the in-memory store has no
 * schema to disagree with. This closes that class for every statement it can
 * resolve, and reports every statement it cannot.
 */

// __dirname is dist/storage at run time; rootDir is src, so src/ is two up.
const SRC = path.resolve(__dirname, "..", "..", "src");
const MIGRATIONS = path.join(SRC, "storage", "migrations");

function tsSources(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push({ file: path.relative(SRC, full), source: fs.readFileSync(full, "utf8") });
      }
    }
  };
  walk(SRC);
  return out;
}

function migrationSql(): string[] {
  return fs
    .readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
}

/**
 * Measured, not chosen. Every one of these came from running the audit and
 * reading the number back; see the PR body for the run that produced them.
 *
 * The three population counters are floors rather than equalities: SQL is added
 * to this codebase constantly and an exact pin would turn every new query into
 * a failing build for no defect. The floor still catches the failure that
 * matters, which is the audit silently examining less than it used to.
 *
 * EXPECTED_UNRESOLVED is an EQUALITY, and is the important one. It is the list
 * of statements this module declines to resolve. A new entry means a statement
 * left the audit, and that has to be a visible event rather than a quiet one.
 */
const EXPECTED_DML_STATEMENTS = 122;
const EXPECTED_RESOLVED_REFS = 603;
const EXPECTED_TABLES = 23;
const EXPECTED_COLUMNS = 255;
const EXPECTED_UNRESOLVED: Record<string, number> = {
  // SELECT EXISTS(SELECT 1 FROM site_members ...) in projectsStore.
  subquery: 1,
  // SELECT ... FROM ${TABLES[kind]} in projectsStore: the table is chosen at
  // run time from a lookup keyed by record kind. recordScope.ts governs that
  // mapping, and no static read of this statement can know the table.
  "interpolated-table": 1,
};

let cachedSchema: DeclaredSchema | null = null;
let cachedLiterals: SqlLiteral[] | null = null;

/**
 * The live schema, from the migrations PLUS the DDL the application issues
 * itself. The migration runner creates schema_migrations in TypeScript, so
 * leaving the second source out would report its own two statements as naming a
 * table nothing declares.
 */
function liveSchema(): DeclaredSchema {
  if (cachedSchema) return cachedSchema;
  const appDdl = liveLiterals()
    .map((l) => l.text)
    .filter((t) => /\bCREATE TABLE\b/i.test(t));
  cachedSchema = parseDeclarations([...migrationSql(), ...appDdl]);
  return cachedSchema;
}

function liveLiterals(): SqlLiteral[] {
  if (cachedLiterals) return cachedLiterals;
  cachedLiterals = tsSources().flatMap(({ file, source }) => extractSqlLiterals(file, source));
  return cachedLiterals;
}

// ── the comment stripper, which is load-bearing for both halves ──────────────

test("a trailing line comment does not swallow the column after it", () => {
  const schema = parseDeclarations([
    `CREATE TABLE IF NOT EXISTS widgets (
       id      TEXT PRIMARY KEY,
       owner   TEXT,  -- no FK constraint, soft relationship only
       status  TEXT NOT NULL DEFAULT 'active'
         CHECK (status IN ('active', 'retired')),
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     );`,
  ]);
  // Without comment stripping, the segment after `owner`'s comma begins with
  // the comment and `status` is read as undeclared. That exact bug reported
  // six real columns of inspection_signatures missing.
  assert.deepEqual(
    [...(schema.get("widgets") ?? [])].sort(),
    ["created_at", "id", "owner", "status"]
  );
});

test("stripSqlComments leaves two hyphens inside a string literal alone", () => {
  const sql = stripSqlComments(`SELECT * FROM t WHERE note = 'a -- b' -- real comment\nAND x = 1`);
  assert.match(sql, /'a -- b'/, "the string literal was cut by the comment stripper");
  assert.doesNotMatch(sql, /real comment/);
  assert.match(sql, /AND x = 1/, "the line after the comment was lost");
});

test("one ALTER TABLE declares every one of its ADD COLUMN clauses", () => {
  const schema = parseDeclarations([
    `ALTER TABLE project_entries
       ADD COLUMN IF NOT EXISTS swms_ref     TEXT NOT NULL DEFAULT '',
       ADD COLUMN IF NOT EXISTS hazard_notes TEXT NOT NULL DEFAULT '',
       ADD COLUMN IF NOT EXISTS toolbox_talk BOOLEAN NOT NULL DEFAULT false;`,
  ]);
  // Reading only the first clause invented two undeclared columns, which is
  // what migration 006 actually looks like.
  assert.deepEqual(
    [...(schema.get("project_entries") ?? [])].sort(),
    ["hazard_notes", "swms_ref", "toolbox_talk"]
  );
});

// ── the extractor, which must not invent statements ──────────────────────────

test("a SQL-shaped string inside a comment is not a statement", () => {
  // Regex backtick-pairing read this file's JSDoc as a template literal and
  // produced a statement that appears nowhere in the source. The parser treats
  // comments as trivia, so there is nothing here to find.
  const literals = extractSqlLiterals(
    "fixture.ts",
    `/**
      * The shape every \`SELECT \${USER_COLUMNS}\` returns.
      */
     export const x = 1;`
  );
  assert.deepEqual(literals, []);
});

test("the JavaScript .join() of a predicate list is not a SQL JOIN", () => {
  const schema = parseDeclarations([`CREATE TABLE crew_timecards (id TEXT, site_id TEXT, date DATE);`]);
  const literals = extractSqlLiterals(
    "fixture.ts",
    "const q = `SELECT * FROM crew_timecards WHERE ${conditions.join(\" AND \")} ORDER BY date DESC`;"
  );
  const audit = auditSqlReferences(schema, literals);
  // Classifying this as a join dropped twelve real single-table statements out
  // of the audit without reporting that it had.
  assert.deepEqual(audit.unresolved, [], "a single-table statement was declined");
  assert.equal(audit.statements, 1);
  assert.deepEqual(audit.violations, []);
});

// ── the check itself ────────────────────────────────────────────────────────

test("the L99 shape is caught: a predicate on a column the table lacks", () => {
  const schema = parseDeclarations([
    `CREATE TABLE project_sites (id TEXT PRIMARY KEY, company_id TEXT NOT NULL);`,
    `CREATE TABLE project_entries (id TEXT PRIMARY KEY, deleted_at TIMESTAMPTZ);`,
  ]);
  const literals = extractSqlLiterals(
    "fixture.ts",
    "const q = `SELECT id FROM project_sites WHERE company_id = $1 AND deleted_at IS NULL`;"
  );
  const audit = auditSqlReferences(schema, literals);
  assert.deepEqual(
    audit.violations.map((v) => `${v.table}.${v.column}`),
    ["project_sites.deleted_at"],
    "the exact L99 defect was not reported"
  );
  // And the positive control on the same statement: the columns that ARE
  // declared resolved, so this is a schema disagreement and not a parse
  // failure. `id` and `company_id`; this read 1 by hand and was wrong, which is
  // the whole argument for measuring pins rather than writing them.
  assert.equal(audit.resolved, 2);
  assert.deepEqual(audit.unresolved, []);
});

test("a column declared on another table in the statement resolves", () => {
  const schema = parseDeclarations([
    `CREATE TABLE worker_locations (id TEXT, user_email TEXT);`,
    `CREATE TABLE auth_users (email TEXT, full_name TEXT);`,
  ]);
  const literals = extractSqlLiterals(
    "fixture.ts",
    "const q = `SELECT wl.id, u.full_name FROM worker_locations wl JOIN auth_users u ON u.email = wl.user_email`;"
  );
  const audit = auditSqlReferences(schema, literals);
  assert.deepEqual(audit.violations, []);
  assert.deepEqual(audit.unresolved, []);
  assert.equal(audit.resolved, 4, "the four qualified references did not all resolve");
});

test("a qualified reference to a column its own table lacks is caught", () => {
  const schema = parseDeclarations([
    `CREATE TABLE worker_locations (id TEXT, user_email TEXT);`,
    `CREATE TABLE auth_users (email TEXT, full_name TEXT);`,
  ]);
  const literals = extractSqlLiterals(
    "fixture.ts",
    "const q = `SELECT wl.full_name FROM worker_locations wl JOIN auth_users u ON u.email = wl.user_email`;"
  );
  const audit = auditSqlReferences(schema, literals);
  // full_name exists — on the other table. An unqualified reference is given
  // the benefit of the doubt; a qualified one is not.
  assert.deepEqual(
    audit.violations.map((v) => `${v.table}.${v.column}`),
    ["worker_locations.full_name"]
  );
});

// ── the live sweep ──────────────────────────────────────────────────────────

test("every resolvable SQL reference in the API names a declared column", () => {
  const audit = auditSqlReferences(liveSchema(), liveLiterals());
  assert.deepEqual(
    audit.violations.map((v) => `${v.file}:${v.line} ${v.table}.${v.column}`),
    [],
    "SQL references a column the migrations do not declare"
  );
  // A zero-violation run over zero statements is the failure this guards. Both
  // numbers are measured; raise them in the same commit that adds SQL.
  assert.ok(
    audit.statements >= EXPECTED_DML_STATEMENTS,
    `examined ${audit.statements} DML statements, expected at least ${EXPECTED_DML_STATEMENTS}`
  );
  assert.ok(
    audit.resolved >= EXPECTED_RESOLVED_REFS,
    `resolved ${audit.resolved} column references, expected at least ${EXPECTED_RESOLVED_REFS}`
  );
});

test("the schema read from the migrations is the whole schema", () => {
  const schema = liveSchema();
  assert.ok(
    schema.size >= EXPECTED_TABLES,
    `parsed ${schema.size} tables, expected at least ${EXPECTED_TABLES}`
  );
  const columns = [...schema.values()].reduce((n, set) => n + set.size, 0);
  assert.ok(
    columns >= EXPECTED_COLUMNS,
    `parsed ${columns} columns, expected at least ${EXPECTED_COLUMNS}`
  );
  // Every table carries at least one column. A table parsed to an empty column
  // set would make every reference to it a violation, or — worse, if the
  // reference check ever grew a "no columns known, skip" branch — none.
  for (const [table, cols] of schema) {
    assert.ok(cols.size > 0, `${table} parsed with no columns`);
  }
});

test("the statements this audit declines are the ones it is known to decline", () => {
  const audit = auditSqlReferences(liveSchema(), liveLiterals());
  const reasons = audit.unresolved.map((u) => u.reason.replace(/:.*/, "")).sort();
  const counted = reasons.reduce<Record<string, number>>((acc, r) => {
    acc[r] = (acc[r] ?? 0) + 1;
    return acc;
  }, {});
  // Pinned so that a refactor which moves statements OUT of the audit has to
  // say so. A rise here is coverage lost silently, which is the failure mode
  // this whole module exists to avoid.
  assert.deepEqual(counted, EXPECTED_UNRESOLVED, JSON.stringify(audit.unresolved, null, 2));
});
