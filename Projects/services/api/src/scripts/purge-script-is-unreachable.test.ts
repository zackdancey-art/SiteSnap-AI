/**
 * The purge script's own doc comment claims it is unreachable. This is the file
 * that makes that claim checkable.
 *
 * WHY A TEST AND NOT A COMMENT
 *
 * purge-deleted-rows.ts is the only thing in this phase that destroys records,
 * and the only thing keeping it from running is that nobody invokes it. That is
 * a property of the whole repository, not of the file, so the file cannot state
 * it truthfully on its own: somebody adds an npm script, or a Render cron, or an
 * `import` for a type they wanted, and the comment is now a lie that reads like
 * a guarantee. So the claim is asserted here, and adding any of those fails the
 * build with the reason.
 *
 * It also tests the two things that cannot be checked any other way in this
 * environment, which has no Postgres: that the tenant is set before every
 * statement, and that the DELETEs go children-first. Both are ORDERING
 * properties, and a fake client that records what it was asked proves an
 * ordering without a database. The first of them is not hypothetical -- the
 * first version of this script issued every statement on a bare pool against
 * five FORCE-ROW-LEVEL-SECURITY tables, so it counted zero rows, deleted zero
 * rows and exited 0 for ever. Nothing would have reported that.
 *
 * In-memory rather than DB-gated, deliberately and against the standing default.
 * Every assertion here is either pure logic, static parsing of the repository,
 * or a fake client recording a call sequence; none of it touches a store. A
 * Postgres connection would add nothing and would make the one test that guards
 * a destructive script depend on the one environment that cannot run it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PURGE_ORDER,
  assertPurgeOrderCoversRegistry,
  countEligible,
  deleteEligible,
  formatPlan,
  listCompanyIds,
  planRun,
  totalEligible,
  type EligibleCount,
} from "./purge-deleted-rows";
import { SOFT_DELETABLE_TABLES, BIN_RETENTION_DAYS } from "../storage/softDelete";

/** Repo root. The suite runs from dist/scripts, so src is two up and across. */
const API_ROOT = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(API_ROOT, "..", "..", "..");
const SRC = path.join(API_ROOT, "src");

const SCRIPT_MODULE = "purge-deleted-rows";
/** The one file allowed to import it: this one. */
const THIS_TEST = "purge-script-is-unreachable.test.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// ── 1. Unreachable from the server ──────────────────────────────────────────

test("nothing in the API source imports the purge script except this test", () => {
  assert.ok(fs.existsSync(SRC), `could not find the API sources at ${SRC}`);
  const files = walk(SRC).filter((f) => f.endsWith(".ts"));

  // Positive control FIRST. A walk that silently returned nothing would make
  // every assertion below pass without reading a line, which is precisely the
  // shape of vacuous test this repo has already been bitten by.
  assert.ok(files.length > 100, `expected the API sources, walked up ${files.length} files`);
  // Any module specifier naming it, in any import position: `from "x"`,
  // a side-effect `import "x"`, `require("x")` and `await import("x")`. The
  // first version of this matched only `from "x"`, so a side-effect import --
  // the exact shape someone reaches for when they want a module's top-level
  // behaviour and not its exports -- would have gone past it unseen.
  const specifies = (text: string, mod: string) =>
    new RegExp(`(?:from|import|require)\\s*\\(?\\s*"[^"]*${mod}"`).test(text);

  // `softDelete"` and not `storage/softDelete"`: the eleven importers are split
  // between `../storage/softDelete` and, from inside src/storage,
  // `./softDelete`. The first version of this control demanded the longer form,
  // matched only four, and failed -- which is the control working.
  const importsSoftDelete = files.filter((f) => specifies(fs.readFileSync(f, "utf8"), "softDelete"));
  assert.ok(
    importsSoftDelete.length >= 5,
    "control failed: the same search found no importer of storage/softDelete, which many " +
      "files do import -- so a zero result below would mean the search is broken, not that " +
      "the purge script is unreferenced"
  );

  const importers = files
    .filter((f) => path.basename(f) !== THIS_TEST)
    .filter((f) => specifies(fs.readFileSync(f, "utf8"), SCRIPT_MODULE))
    .map((f) => path.relative(REPO_ROOT, f));

  assert.deepEqual(
    importers,
    [],
    "something now imports purge-deleted-rows.ts. It destroys compliance records and is " +
      "meant to be reachable only by a person typing its name. If this import is deliberate, " +
      "the script's header doc and this test both have to change in the same commit."
  );
});

test("no compiled module that ships reaches the purge script, and the build does compile it", () => {
  // dist is what actually runs, so the source check above is repeated against
  // the artefact. Checking server.js alone would not do: it requires a barrel
  // (`require("./routes")`), so anything it reaches, it reaches transitively.
  // Walking the whole of dist is what makes this a statement about reachability
  // rather than about one file's first line.
  const dist = path.join(API_ROOT, "dist");
  assert.ok(fs.existsSync(dist), `could not find the build output at ${dist}`);

  // The script IS compiled -- it lives under src -- so its absence from dist
  // would mean this test is checking nothing.
  const compiled = path.join(dist, "scripts", `${SCRIPT_MODULE}.js`);
  assert.ok(
    fs.existsSync(compiled),
    `expected ${SCRIPT_MODULE} to be compiled to ${compiled}; if the build stopped emitting it, ` +
      "this suite is asserting against a file that is not there"
  );

  const js = walk(dist).filter((f) => f.endsWith(".js"));
  assert.ok(js.length > 50, `control failed: walked up ${js.length} compiled files`);

  // A `require()` CALL, not any mention of the name. tsc does not strip doc
  // comments, so storage/softDelete.js carries the sentence "See
  // scripts/purge-deleted-rows.ts" into dist -- and a substring search flagged
  // it as a caller. A comment pointing at the script is exactly what should be
  // there; what must not be there is a require of it.
  const requires = (text: string, mod: string) =>
    new RegExp(`require\\(\\s*"[^"]*${mod}"\\s*\\)`).test(text);

  // Control: the same require-shaped search DOES find the module every shipping
  // store reaches, so a zero result below is a fact about the purge script and
  // not about a pattern that matches nothing.
  const reachSoftDelete = js.filter((f) => requires(fs.readFileSync(f, "utf8"), "softDelete"));
  assert.ok(
    reachSoftDelete.length >= 5,
    `control failed: only ${reachSoftDelete.length} compiled files require softDelete`
  );

  const allowed = new Set([path.join("scripts", "purge-script-is-unreachable.test.js")]);
  const callers = js
    .map((f) => path.relative(dist, f))
    .filter((rel) => !allowed.has(rel))
    .filter((rel) => requires(fs.readFileSync(path.join(dist, rel), "utf8"), SCRIPT_MODULE));

  assert.deepEqual(
    callers,
    [],
    "a compiled module that ships now requires the purge script, so the running server can " +
      "reach code that destroys compliance records. Nothing but this test may."
  );
});

// ── 2. Unreachable from the build, the container and CI ─────────────────────

test("no npm script, Dockerfile line, workflow step or repo script invokes the purge", () => {
  const surfaces: { label: string; text: string }[] = [];

  const addFile = (rel: string) => {
    const full = path.join(REPO_ROOT, rel);
    assert.ok(fs.existsSync(full), `expected to find ${rel} -- this test is reading the wrong tree`);
    surfaces.push({ label: rel, text: fs.readFileSync(full, "utf8") });
  };

  addFile("Dockerfile");
  addFile("Projects/package.json");
  addFile("Projects/services/api/package.json");
  for (const f of fs.readdirSync(path.join(REPO_ROOT, ".github", "workflows"))) {
    addFile(path.join(".github", "workflows", f));
  }
  const repoScripts = path.join(REPO_ROOT, "Projects", "scripts");
  for (const f of fs.readdirSync(repoScripts)) {
    addFile(path.join("Projects", "scripts", f));
  }
  addFile("Projects/services/api/scripts/run-tests.sh");

  // Positive control: the same corpus, searched for something that IS in it.
  assert.ok(surfaces.length >= 10, `expected the invocation surfaces, collected ${surfaces.length}`);
  assert.ok(
    surfaces.some((s) => s.text.includes("services/api/dist/server.js")),
    "control failed: no surface mentions the server entry point, so this corpus is not the one " +
      "that decides what runs and finding no purge reference in it would prove nothing"
  );

  const hits = surfaces
    .filter((s) => s.text.includes(SCRIPT_MODULE))
    .map((s) => s.label);
  assert.deepEqual(
    hits,
    [],
    "something in the build, the container, CI or a repo script now names the purge script. " +
      "It is hand-run on purpose: there is no scheduler, no cron and no boot hook, and the " +
      "retention promise does not require one. Wiring it up is a decision for the owner."
  );
});

// ── 3. Every gate, each with the control that a good invocation passes ──────

const GOOD_ENV = {
  PURGE_DATABASE_URL: "postgres://host/purge-target",
  PURGE_I_UNDERSTAND_THIS_DESTROYS_RECORDS: "yes",
} as const;

function refusal(result: ReturnType<typeof planRun>): string {
  assert.equal(result.ok, false, `expected a refusal, got ${JSON.stringify(result)}`);
  return (result as { ok: false; reason: string }).reason;
}

test("the dry run is the default, and --execute needs the number the dry run printed", () => {
  // Positive control for the whole block: fully satisfied, it does not refuse.
  const dry = planRun([], GOOD_ENV);
  assert.deepEqual(dry, {
    ok: true,
    databaseUrl: GOOD_ENV.PURGE_DATABASE_URL,
    execute: false,
    expect: null,
  });

  const live = planRun(["--execute", "--expect=7"], GOOD_ENV);
  assert.deepEqual(live, {
    ok: true,
    databaseUrl: GOOD_ENV.PURGE_DATABASE_URL,
    execute: true,
    expect: 7,
  });

  // --execute alone deletes nothing.
  assert.match(refusal(planRun(["--execute"], GOOD_ENV)), /--expect=<n>/);
  // A number that is not one.
  assert.match(refusal(planRun(["--execute", "--expect=7.5"], GOOD_ENV)), /whole number/);
  assert.match(refusal(planRun(["--execute", "--expect=-1"], GOOD_ENV)), /whole number/);
  assert.match(refusal(planRun(["--execute", "--expect=lots"], GOOD_ENV)), /whole number/);
  // A number with no --execute is a misunderstanding worth stopping on rather
  // than ignoring: the operator thinks they asked for something.
  assert.match(refusal(planRun(["--expect=7"], GOOD_ENV)), /without --execute/);
});

test("it refuses without an explicit target, and refuses this host's own database", () => {
  // Control: the same argv succeeds once the env is right.
  assert.equal(planRun([], GOOD_ENV).ok, true);

  assert.match(
    refusal(planRun([], { PURGE_I_UNDERSTAND_THIS_DESTROYS_RECORDS: "yes" })),
    /PURGE_DATABASE_URL is not set/
  );

  // DATABASE_URL must never be the thing that decides the target.
  const refusedSame = refusal(
    planRun([], { ...GOOD_ENV, DATABASE_URL: GOOD_ENV.PURGE_DATABASE_URL })
  );
  assert.match(refusedSame, /same as DATABASE_URL/);

  // ...and a DIFFERENT DATABASE_URL is not an obstacle, which is the control
  // proving the refusal above is about the two being equal and not merely about
  // DATABASE_URL being present.
  assert.equal(
    planRun([], { ...GOOD_ENV, DATABASE_URL: "postgres://host/production" }).ok,
    true
  );

  // A missing DATABASE_URL must not be read as a match against a missing
  // PURGE_DATABASE_URL -- undefined === undefined would have refused for the
  // wrong reason, or passed for one.
  assert.match(refusal(planRun([], {})), /PURGE_DATABASE_URL is not set/);
});

test("it refuses unless the operator has said in words that this destroys records", () => {
  assert.equal(planRun([], GOOD_ENV).ok, true); // control
  for (const value of [undefined, "", "y", "YES", "true", "1", "no"]) {
    const env = { ...GOOD_ENV, PURGE_I_UNDERSTAND_THIS_DESTROYS_RECORDS: value };
    assert.match(
      refusal(planRun([], env)),
      /PURGE_I_UNDERSTAND_THIS_DESTROYS_RECORDS/,
      `${JSON.stringify(value)} was accepted as consent`
    );
  }
});

// ── 4. The ordering properties, proved with a recording client ──────────────

type Recorded = { sql: string; values?: unknown[] };

function fakeClient(rowCount = 1) {
  const log: Recorded[] = [];
  return {
    log,
    client: {
      query: async (sql: string, values?: unknown[]) => {
        log.push({ sql, values });
        return { rows: [{ n: "0" }], rowCount };
      },
    },
  };
}

const SOFT_DELETE_TABLE_RE = new RegExp(`\\b(${SOFT_DELETABLE_TABLES.join("|")})\\b`);

test("the tenant is set before every statement that touches an RLS-forced table", async () => {
  const { log, client } = fakeClient();
  const pool = {
    connect: async () => ({ ...client, release: () => {} }),
  };

  await countEligible(pool as never, ["company-a", "company-b"]);

  // Control: the fake was actually driven. A recording that stayed empty would
  // satisfy every "no statement without a tenant" assertion below.
  assert.ok(log.length > 0, "countEligible issued no statements at all");
  const counts = log.filter((q) => /SELECT COUNT\(\*\)/.test(q.sql));
  assert.equal(
    counts.length,
    PURGE_ORDER.length * 2,
    `expected one count per table per company, got ${counts.length}`
  );

  // THE ASSERTION. Walk the log in order; a statement naming a soft-deletable
  // table must be preceded by a set_config for the company it is scoped to.
  let tenant: string | null = null;
  for (const q of log) {
    if (q.sql.includes("set_config('app.company_id'")) {
      tenant = String(q.values?.[0]);
      continue;
    }
    if (SOFT_DELETE_TABLE_RE.test(q.sql)) {
      assert.ok(
        tenant !== null,
        `statement ran with no tenant set, so RLS would match zero rows: ${q.sql}`
      );
    }
  }
  assert.equal(tenant, "company-b", "expected the last tenant set to be the last company");

  // Both companies were actually scoped to, not just the first one.
  const tenants = log
    .filter((q) => q.sql.includes("set_config('app.company_id'"))
    .map((q) => String(q.values?.[0]));
  assert.deepEqual(tenants, ["company-a", "company-b"]);

  // And it is one transaction, opened read-only: counting must not be able to write.
  assert.equal(log[0].sql, "BEGIN READ ONLY");
  assert.equal(log[log.length - 1].sql, "COMMIT");
});

test("the DELETEs run children before parents, per company, with the tenant set", async () => {
  const { log, client } = fakeClient(3);

  const deleted = await deleteEligible(client as never, ["company-a", "company-b"]);

  // Control: it reported the rows the fake claimed, so the loop ran.
  assert.equal(deleted, 3 * PURGE_ORDER.length * 2);

  // It does NOT own the transaction -- the caller decides whether to commit
  // after comparing the count, and a function that committed could not be
  // driven by a test without a real database to roll back.
  assert.deepEqual(
    log.filter((q) => ["BEGIN", "COMMIT", "ROLLBACK"].includes(q.sql.trim())),
    [],
    "deleteEligible opened or closed a transaction; the caller owns that"
  );

  const perCompany: Record<string, string[]> = {};
  let tenant: string | null = null;
  for (const q of log) {
    if (q.sql.includes("set_config('app.company_id'")) {
      tenant = String(q.values?.[0]);
      perCompany[tenant] = [];
      continue;
    }
    const table = PURGE_ORDER.find((t) => new RegExp(`DELETE FROM ${t}\\b`).test(q.sql));
    assert.ok(table, `unexpected statement in the purge: ${q.sql}`);
    assert.ok(tenant !== null, `DELETE ran with no tenant set: ${q.sql}`);
    perCompany[tenant].push(table);
  }

  // project_sites LAST, every time. Deleting it cascades to the other four, so
  // a parent-first order would destroy rows a later statement was counted on to
  // match and the run would roll back -- or, worse, would stop matching the
  // number the operator approved.
  assert.deepEqual(Object.keys(perCompany), ["company-a", "company-b"]);
  for (const [company, tables] of Object.entries(perCompany)) {
    assert.deepEqual(tables, [...PURGE_ORDER], `${company} deleted in the wrong order`);
    assert.equal(
      tables[tables.length - 1],
      "project_sites",
      `${company}: project_sites must be last -- its cascade removes the other four`
    );
  }
});

test("companies come from the tenant root, which is the one table with no RLS", async () => {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [{ id: "c2" }, { id: "c1" }] };
    },
  };
  const ids = await listCompanyIds(pool as never);
  assert.deepEqual(ids, ["c2", "c1"], "it must not reorder what the database returned");
  assert.equal(queries.length, 1);
  assert.match(queries[0], /FROM companies/);
  // Control that it is NOT reading a tenanted table, which would read zero rows
  // on a bare connection and silently scope the purge to nothing.
  assert.ok(
    !SOFT_DELETE_TABLE_RE.test(queries[0]),
    `the company enumeration reads an RLS-forced table: ${queries[0]}`
  );
});

// ── 5. The registry stays the single source of the table set ────────────────

test("the purge order is exactly the registry, reordered, with the parent last", () => {
  // Control: the real pair passes. This also runs at module load, so a failure
  // here means the shipped constants disagree.
  assert.doesNotThrow(() => assertPurgeOrderCoversRegistry());
  assert.deepEqual([...PURGE_ORDER].sort(), [...SOFT_DELETABLE_TABLES].sort());

  // A table added to the registry and not placed in the order.
  assert.throws(
    () => assertPurgeOrderCoversRegistry(PURGE_ORDER, [...SOFT_DELETABLE_TABLES, "site_notes"]),
    /Missing from the order: site_notes/
  );
  // A table in the order that is not soft-deletable at all.
  assert.throws(
    () => assertPurgeOrderCoversRegistry(["project_entries", ...PURGE_ORDER], SOFT_DELETABLE_TABLES),
    /Not in the registry: project_entries/
  );
  // Named twice: it would double-count against --expect and roll back every run.
  assert.throws(
    () => assertPurgeOrderCoversRegistry([...PURGE_ORDER, "incidents"], SOFT_DELETABLE_TABLES),
    /names a table twice/
  );
  // Parent first.
  assert.throws(
    () => assertPurgeOrderCoversRegistry(["project_sites", "crew_timecards", "incidents", "inspections", "material_deliveries"], SOFT_DELETABLE_TABLES),
    /must end with project_sites/
  );
});

test("the script writes no predicate and no retention number of its own", () => {
  const src = fs.readFileSync(path.join(SRC, "scripts", `${SCRIPT_MODULE}.ts`), "utf8");
  assert.ok(src.length > 1000, `control failed: read ${src.length} bytes of the purge script`);
  const code = src
    .split("\n")
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
    .join("\n");
  assert.ok(code.includes("purgeEligible(table)"), "control failed: found no call to purgeEligible");

  // An INTERVAL literal here would be a second copy of the retention period,
  // free to drift from the one the bin screen shows a person.
  assert.doesNotMatch(code, /INTERVAL\s*'/, "the purge writes its own INTERVAL literal");
  assert.doesNotMatch(
    code,
    new RegExp(String(BIN_RETENTION_DAYS)),
    `the retention period ${BIN_RETENTION_DAYS} is written out in the purge script; it belongs ` +
      "only in storage/softDelete.ts, which the bin UI reads too"
  );
});

test("the plan it prints covers every table and totals them", () => {
  const counts: EligibleCount[] = PURGE_ORDER.map((table, i) => ({ table, eligible: i }));
  assert.equal(totalEligible(counts), 0 + 1 + 2 + 3 + 4);
  const printed = formatPlan(counts);
  for (const table of SOFT_DELETABLE_TABLES) {
    assert.ok(printed.includes(table), `${table} is missing from the printed plan`);
  }
  assert.match(printed, new RegExp(`more than ${BIN_RETENTION_DAYS} days`));
  assert.match(printed, /total\s+10/);
  // Control: a different set of counts prints a different total, so the match
  // above is reading the number rather than a constant string.
  assert.match(formatPlan([{ table: "incidents", eligible: 2 }]), /total\s+2/);
});
