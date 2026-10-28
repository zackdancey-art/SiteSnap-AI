import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";

/**
 * SCHEMA IS DEFINED BY MIGRATIONS. A STORE MAY NOT DEFINE ITS OWN.
 *
 * WHAT THIS GUARDS, AND WHY IT IS NOT HYPOTHETICAL
 *
 * Three stores carried an `init*Schema()` function holding a full
 * `CREATE TABLE IF NOT EXISTS` for the table that store reads —
 * templateStore (entry_templates), pushStore (push_tokens) and
 * deliveriesStore (material_deliveries). All three were UNCALLED, and all
 * three were stale: every one of them omitted the `company_id` column that
 * migration 017 added and that every live query in the same file requires.
 *
 * The hazard is the one CLAUDE.md §5 names for AUDIT L11: a
 * `CREATE TABLE IF NOT EXISTS` that runs BEFORE the migrations silently wins,
 * the migration's own create no-ops, and the table is left without the columns
 * the later migrations would have added. Nothing errors. The store then reads
 * zero rows or 500s on a column that was never created — which is how site
 * progress came to have never once worked in production.
 *
 * TWO LIVE FUNCTIONS OF THE SAME SHAPE REMAIN, AND ARE EXEMPT HERE
 *
 * `initAuthSchema` (authStore) and `initProjectSchema` (projectsStore) hold the
 * same kind of duplicated DDL and ARE called at boot. They are harmless today
 * for exactly one reason: server.ts runs `runMigrations()` BEFORE both of them,
 * so every statement in them is an `IF NOT EXISTS` no-op against a database the
 * migrations have already brought up to date. `initProjectSchema`'s
 * `project_sites` create omits `company_id` just as the deleted three did — so
 * the ordering is the only thing standing between it and L11.
 *
 * That is why the boot-order assertion below is in this file rather than
 * somewhere tidier: it is the invariant that makes the exemption safe, and
 * swapping two adjacent `await` lines in server.ts is all it would take to lose
 * it. Retiring those two functions is the real fix and it needs something this
 * environment does not have — a fresh-database boot against Postgres to prove
 * nothing they declare is missing from the migrations. Until then, pinned.
 *
 * NO STORE IS INVOLVED, SO THIS RUNS IN THE IN-MEMORY SUITE. It reads source
 * text off disk and asserts nothing about data, permissions, tenancy or
 * ownership — there is no Postgres behaviour for it to be wrong about.
 */

// The suite runs from dist/storage, so the TypeScript sources are two levels up
// and across. Resolved rather than assumed: if the layout changes this fails
// loudly here instead of quietly reading an empty directory and passing.
const SRC = path.resolve(__dirname, "..", "..", "src");
const MIGRATIONS = path.join(SRC, "storage", "migrations");

/**
 * The files allowed to contain DDL, each with the reason.
 *
 * Paths are relative to src/ and matched exactly. Adding to this list is a
 * decision a reviewer should see; it is not a place to park a new store.
 */
const DDL_EXEMPT: Record<string, string> = {
  // The migration runner has to bootstrap its own ledger table before it can
  // read which migrations have been applied. Genuinely unavoidable.
  "storage/migrate.ts": "creates schema_migrations, the ledger the runner reads",
  // Legacy, live, and no-ops because migrations run first. See the note above.
  "storage/authStore.ts": "initAuthSchema, pre-migration legacy, runs after runMigrations()",
  "storage/projectsStore.ts": "initProjectSchema, pre-migration legacy, runs after runMigrations()",
  // The test-database migration runner, hoisted out of eleven copies. Same
  // bootstrap problem as migrate.ts above and for the same reason: it cannot
  // read the applied-migrations set before the table holding it exists.
  "storage/testMigrations.ts": "creates schema_migrations for the DB-gated suites, same bootstrap as migrate.ts",
  // READS DDL, DOES NOT ISSUE IT. The three matches are a SQL reserved-word
  // list and the two regexes that parse CREATE TABLE and ALTER TABLE out of the
  // migration files. stripComments() cannot tell this apart from a store
  // defining schema, because here the DDL text is code rather than a comment —
  // which is exactly the case the exemption list exists to carry.
  "storage/sqlSchemaAudit.ts": "parses DDL out of the migrations to audit store SQL against it; issues none",
};

/** DDL verbs. A store issuing any of these is defining schema. */
const DDL = /\b(?:CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|CREATE\s+POLICY|DROP\s+POLICY|ROW\s+LEVEL\s+SECURITY)\b/i;

/**
 * Comments stripped before scanning, so that a file DESCRIBING a migration —
 * which several of them do, at length — is not reported as issuing one. The
 * scan is for code.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

test("no store defines its own schema — DDL lives in migrations, and the scanner proves it can see DDL", () => {
  assert.ok(fs.existsSync(SRC), `could not find the API sources at ${SRC}`);
  const files = sourceFiles(SRC);
  // A floor, not an equality: source files are added all the time and a count
  // that has to be bumped for every unrelated file gets bumped without being
  // read. Measured at 57 on 2026-10-20; the point is that the walk found the
  // tree rather than an empty directory.
  assert.ok(files.length >= 40, `expected the API sources, walked up ${files.length} files`);

  const offenders: string[] = [];
  for (const full of files) {
    const rel = path.relative(SRC, full).split(path.sep).join("/");
    if (rel in DDL_EXEMPT) continue;
    const code = stripComments(fs.readFileSync(full, "utf8"));
    const hit = code.match(DDL);
    if (hit) offenders.push(`${rel} (${hit[0].replace(/\s+/g, " ")})`);
  }
  assert.deepEqual(
    offenders,
    [],
    "application code is issuing DDL. Schema belongs in src/storage/migrations/NNN_*.sql, applied in " +
      "filename order at boot by storage/migrate.ts. A CREATE TABLE IF NOT EXISTS here silently wins " +
      "over the migration's own create and leaves the table missing every column the later migrations " +
      "add — AUDIT L11. If the statement is genuinely unavoidable, add the file to DDL_EXEMPT with the reason."
  );

  // POSITIVE CONTROL, same scanner, same regex. Without this the assertion
  // above passes just as well with a regex that matches nothing, an exemption
  // list that swallows everything, or a walk that returned no files — which is
  // the shape of M7 in docs/VACUITY-AUDIT.md.
  const migrations = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"));
  const withDdl = migrations.filter((f) => DDL.test(fs.readFileSync(path.join(MIGRATIONS, f), "utf8")));
  assert.ok(
    withDdl.length >= 12,
    `the scanner found DDL in only ${withDdl.length} of ${migrations.length} migrations — ` +
      "if that is near zero the regex above has stopped matching and the negative assertion is vacuous"
  );

  // And the exemptions are live rather than inherited: each exempt file must
  // still actually contain the DDL it is excused for. When one is cleaned up,
  // this fails and the list shrinks with it instead of growing stale.
  for (const [rel, reason] of Object.entries(DDL_EXEMPT)) {
    const full = path.join(SRC, rel);
    assert.ok(fs.existsSync(full), `DDL_EXEMPT names ${rel}, which is not there any more — remove the entry`);
    assert.ok(
      DDL.test(stripComments(fs.readFileSync(full, "utf8"))),
      `${rel} no longer contains DDL (${reason}) — remove it from DDL_EXEMPT rather than leaving the hole open`
    );
  }
});

test("migrations run before the two legacy init functions, which is the only reason they are harmless", () => {
  // initProjectSchema's `CREATE TABLE IF NOT EXISTS project_sites` has no
  // company_id column. Run before the migrations it would create the table
  // without one, migration 017's ADD COLUMN would be the only thing standing
  // between that and a tenancy filter against a column that does not exist.
  // Run after, every statement is a no-op. Two adjacent `await` lines decide
  // which, so the order is pinned here.
  const serverPath = path.join(SRC, "server.ts");
  const code = stripComments(fs.readFileSync(serverPath, "utf8"));

  const at = (call: string) => {
    const i = code.indexOf(`await ${call}()`);
    assert.notEqual(i, -1, `could not find \`await ${call}()\` in server.ts — if the boot sequence was restructured, re-pin this`);
    return i;
  };

  const migrations = at("runMigrations");
  const auth = at("initAuthSchema");
  const projects = at("initProjectSchema");

  assert.ok(
    migrations < auth,
    "initAuthSchema() now runs BEFORE runMigrations(). Its CREATE TABLE IF NOT EXISTS statements will win " +
      "over the migrations' and leave auth_users missing the columns later migrations add — AUDIT L11."
  );
  assert.ok(
    migrations < projects,
    "initProjectSchema() now runs BEFORE runMigrations(). Its project_sites create has no company_id column, " +
      "so the tenancy column would never be added and every company filter would fail against it — AUDIT L11."
  );
});

// WHY THE SCAN BELOW STRIPS COMMENTS, and it is a merge finding rather than a
// preference. This guard reported a failure on the twelve-branch union that
// neither parent branch could produce: the soft-delete workstream deleted
// `initDeliveriesSchema` and left a comment naming it twice where it used to
// be, explaining why the table is a migration's job. Scanning raw source, the
// documentation of the fix failed the test for the fix.
//
// Stripping comments first is the narrow correction. What it gives up is a
// commented-out reintroduction, which is not what this test is for: a
// commented-out CREATE TABLE executes nothing, and the DDL scan above -- which
// has always stripped comments, for this same reason -- is what guards the
// statement itself. What it keeps is the whole point of the test: a live call,
// a live definition, or a live reference to any of the three is still a
// failure, and the positive control below still proves the walk ran.
//
// Worth carrying to every other guard in this repo that greps source text.
test("the three uncalled init*Schema functions are gone, and the two live ones are still called", () => {
  // The deleted three were uncalled AND stale — each one's CREATE TABLE omitted
  // the company_id that migration 017 added and that every live query in the
  // same file filters on. Wiring any of them in would have reintroduced L11.
  const storage = path.join(SRC, "storage");
  const deleted = ["initTemplateSchema", "initPushSchema", "initDeliveriesSchema"];
  const found: string[] = [];
  for (const full of sourceFiles(storage)) {
    // stripComments, not the raw source. A comment that NAMES one of the three
    // is documentation of the deletion, not a reintroduction of it -- and the
    // raw scan could not tell the two apart. See the note under this test.
    const code = stripComments(fs.readFileSync(full, "utf8"));
    for (const name of deleted) {
      if (code.includes(name)) found.push(`${path.basename(full)}: ${name}`);
    }
  }
  assert.deepEqual(
    found,
    [],
    "a deleted init*Schema function is back. The table it creates is defined by a migration " +
      "(entry_templates and material_deliveries by 010, push_tokens by 009, company_id by 017, RLS by 019/021/022/025) " +
      "and a duplicate create here can only be stale."
  );

  // POSITIVE CONTROL: the scan above is a `includes` over source text, which
  // passes identically if sourceFiles() returned nothing, if the storage
  // directory moved, or if the loop never ran. The two surviving functions must
  // be found by the same walk, and found as calls in the boot sequence — so
  // "no init*Schema anywhere" cannot read as green.
  const names = sourceFiles(storage).flatMap((full) =>
    (fs.readFileSync(full, "utf8").match(/export async function (init\w*Schema)/g) ?? []).map((m) =>
      m.replace("export async function ", "")
    )
  );
  assert.deepEqual(
    names.sort(),
    ["initAuthSchema", "initProjectSchema"],
    "exactly two init*Schema functions should remain, both legacy and both called after runMigrations()"
  );
  const server = stripComments(fs.readFileSync(path.join(SRC, "server.ts"), "utf8"));
  for (const name of names) {
    assert.ok(server.includes(`await ${name}()`), `${name} is defined but not called — delete it instead`);
  }
});
