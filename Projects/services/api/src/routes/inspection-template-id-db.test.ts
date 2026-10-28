/**
 * The templateId a client may send on POST /inspections, measured against the
 * foreign key that decides it.
 *
 * WHY THIS FILE EXISTS
 *
 * migrations/009_v2_features.sql declares, on the inspections table:
 *
 *     template_id  TEXT REFERENCES inspection_templates(id) ON DELETE SET NULL
 *
 * and GET /api/whs-checklists serves five built-in Australian WHS checklists
 * that are hardcoded in routes/templates.ts and exist in no table at all. Their
 * ids are "pre-start-daily", "hazard-identification" and so on. Wiring those
 * checklists into the mobile inspection picker — which is what makes that route
 * reachable by a shipping client, and is the other half of this branch — puts
 * five selectable ids in front of the user that the foreign key has nothing to
 * point at.
 *
 * In the in-memory store that is a 201: memoryInspections is a Map and a Map
 * has no referential integrity. Against Postgres it is a 23503 foreign key
 * violation, caught by the route's try/catch, and a 500 reading "Failed to
 * create inspection." So the two stores disagree about whether the primary
 * action of the inspection screen works, and the in-memory suite would have
 * been green for all of it. That is the eighth defect to hide in that gap, and
 * it is why the authoritative half of this guard is measured here rather than
 * in the in-memory suite.
 *
 * WHAT IS MEASURED, AND WHY THE THIRD TEST IS THE IMPORTANT ONE
 *
 *   1. a built-in checklist id is refused with 400 and a code, while a real
 *      inspection_templates id is accepted with 201 — on the same route, in the
 *      same test
 *   2. another company's template id is refused, while the actor's own is
 *      accepted — the guard is company-scoped, not global
 *   3. the foreign key is REAL: the store call the route protects, made with a
 *      non-existent template id, raises 23503 from Postgres; made with a real
 *      one, it succeeds
 *
 * Test 3 is what stops the other two from being a belt around nothing. A 400
 * assertion on its own passes equally well if the hazard never existed — if the
 * column had no constraint, the guard would be refusing a request Postgres
 * would have been perfectly happy with, and the right change would be to delete
 * the guard rather than to test it. So the constraint is measured directly,
 * against the same database, through the same store function the route calls.
 *
 * BOTH CONTROLS ON EVERY ASSERTION
 *
 * Every test below asserts a refusal and an acceptance against the same
 * endpoint or the same function. A refusal test alone passes when the route has
 * been deleted; an acceptance test alone passes when the guard has been
 * removed. Neither half is evidence by itself, and the 400 assertions
 * additionally check the `code`, so a 400 arriving from Zod body validation for
 * some unrelated reason cannot be mistaken for this guard firing.
 *
 * WHAT THIS FILE DOES NOT COVER
 *
 * The client half — that the picker never sends a built-in id in the first
 * place — is apps/mobile/lib/whs-checklists.test.ts, which is pure logic with no
 * store involved and belongs in the mobile suite. Both halves ship together
 * deliberately: the client guard means the API guard is never reached in normal
 * use, and the API guard means a stale build, a replayed request or a third
 * client cannot produce the 500 either.
 *
 * Guarded on TEST_DATABASE_URL and registers one placeholder skip without it.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "inspection-template-id-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { createApp } from "../server";
import { getPgPool } from "../storage/postgres";
import { deleteUserAccount } from "../storage/authStore";
import { createInspection } from "../storage/inspectionStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";

if (!process.env.TEST_DATABASE_URL) {
  test("inspection templateId guard against Postgres (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // See the sibling note in crew-permissions-db.test.ts: authStore and
  // projectsStore branch on DATABASE_URL and test-setup.ts blanks it, so
  // without this line the registrations and the site below would land in the
  // in-memory maps while the inspections store used Postgres. It cannot reach
  // production: getPgPool() refuses to read DATABASE_URL when NODE_ENV ===
  // "test", and node:test gives each file its own process.
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

  const runId = Date.now().toString().slice(-7);
  const OWNER = `insp-tpl-owner-${runId}@example.test`;
  const OTHER = `insp-tpl-other-${runId}@example.test`;
  const PASSWORD = "Password123!";
  const TODAY = "2026-10-20";

  /**
   * The id a built-in WHS checklist actually carries, as routes/templates.ts
   * defines it. Not a made-up string: this is the exact value the inspection
   * picker holds for the first built-in checklist, and the exact value that
   * would reach template_id if the client sent its selection through unchanged.
   *
   * Taken from the route's own list rather than written out here by hand, so a
   * rename of the checklist ids fails this file instead of leaving it measuring
   * a string nothing produces any more.
   */
  let builtInChecklistId: string;

  let server: http.Server;
  let baseUrl: string;
  let pool: Pool;
  let ownerToken: string;
  let otherToken: string;
  let companyId: string;
  let siteId: string;
  /** A template that really is in inspection_templates, in the owner's company. */
  let realTemplateId: string;
  /** A template in a DIFFERENT company, for the tenancy half. */
  let otherCompanyTemplateId: string;
  /** And that company's own site, so its control can be a real 201. */
  let otherSiteId: string;
  let phoneSeq = 0;

  type Answer<T> = { status: number; body: T };

  const req = async <T>(method: string, p: string, body?: unknown, token?: string): Promise<Answer<T>> => {
    const res = await fetch(`${baseUrl}/api${p}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: T;
    try { parsed = JSON.parse(text) as T; } catch { parsed = { error: text } as unknown as T; }
    return { status: res.status, body: parsed };
  };

  /** A request whose response is CHECKED — a discarded seed makes every assertion below it a test of nothing. */
  const seed = async <T>(method: string, p: string, body?: unknown, token?: string): Promise<Answer<T>> => {
    const res = await req<T>(method, p, body, token);
    assert.ok(res.status >= 200 && res.status < 300, `seed ${method} ${p} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  };

  const register = async (email: string, fullName: string): Promise<string> => {
    const phone = `+6141${runId.slice(-5)}${(++phoneSeq).toString().padStart(2, "0")}`;
    const reg = await seed<{ devCodes?: { emailCode: string } }>("POST", "/auth/register", { email, password: PASSWORD, phone, fullName });
    const emailCode = reg.body.devCodes?.emailCode;
    assert.ok(emailCode, "registration did not return a dev email code");
    const ve = await seed<{ devCodes?: { smsCode: string } }>("POST", "/auth/register/verify-email", { email, emailCode });
    const smsCode = ve.body.devCodes?.smsCode;
    assert.ok(smsCode, "email verification did not return a dev sms code");
    const done = await seed<{ token: string }>("POST", "/auth/register/verify", { email, smsCode });
    assert.ok(done.body.token, "verification returned no auth token");
    return done.body.token;
  };

  /** The body POST /inspections wants, with only templateId varying. */
  const inspectionBody = (templateId: string | null, name = `Inspection ${runId}`) => ({
    siteId,
    templateId,
    name,
    date: TODAY,
    results: [{ item: "Edge protection in place", passed: null, notes: "", na: false }],
  });

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);
    resetRateLimitStoreForTests();

    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("server did not bind a port");
    baseUrl = `http://127.0.0.1:${addr.port}`;

    /**
     * THE PRECONDITION THIS WHOLE FILE RESTS ON, asserted here rather than
     * assumed three tests down.
     *
     * Read out of the catalogue rather than written as a literal, per the rule
     * about hand-written names in SQL predicates: a `deleted_at` literal on a
     * table without the column is how site progress came to have never worked.
     * If the foreign key is ever dropped, the guard the other tests measure is
     * refusing a request Postgres would have accepted, and this says so in one
     * line instead of leaving three green tests defending nothing.
     */
    const fk = await pool.query<{ constraint_name: string; foreign_table: string; foreign_column: string }>(
      `SELECT tc.constraint_name,
              ccu.table_name  AS foreign_table,
              ccu.column_name AS foreign_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON kcu.constraint_name = tc.constraint_name
          AND kcu.table_schema = tc.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY'
          AND tc.table_name = 'inspections'
          AND kcu.column_name = 'template_id'`
    );
    assert.equal(
      fk.rowCount, 1,
      "inspections.template_id has no foreign key — the guard under test refuses ids Postgres would accept, so it should be deleted rather than tested"
    );
    assert.equal(fk.rows[0].foreign_table, "inspection_templates", `template_id points at ${fk.rows[0].foreign_table}`);
    assert.equal(fk.rows[0].foreign_column, "id", `template_id points at ${fk.rows[0].foreign_table}.${fk.rows[0].foreign_column}`);

    ownerToken = await register(OWNER, "Inspection Owner");
    const me = await seed<{ user: { companyId: string } }>("GET", "/auth/me", undefined, ownerToken);
    companyId = me.body.user.companyId;
    assert.ok(companyId, "the owner has no company, so nothing below is scoped to one");

    // A real site: inspections.site_id is NOT NULL REFERENCES project_sites(id),
    // so without this every insert below would fail on the wrong foreign key and
    // the file would pass for a reason it is not about.
    const site = await seed<{ site: { id: string } }>(
      "POST", "/projects/sites",
      { name: `Inspection Site ${runId}`, address: "1 Main St", client: "ACME", startDate: "2026-01-01", status: "active" },
      ownerToken
    );
    siteId = site.body.site.id;

    const tpl = await seed<{ template: { id: string } }>(
      "POST", "/inspection-templates",
      { name: `Real Template ${runId}`, items: ["Edge protection in place", "Exclusion zone signed"] },
      ownerToken
    );
    realTemplateId = tpl.body.template.id;

    // A second company, by registration — registerUser creates a company and
    // makes the registrant its owner, so this is a genuinely separate tenant
    // rather than a role rewritten in the store.
    otherToken = await register(OTHER, "Other Company Owner");
    const otherMe = await seed<{ user: { companyId: string } }>("GET", "/auth/me", undefined, otherToken);
    assert.notEqual(otherMe.body.user.companyId, companyId, "the second registration landed in the first company, so the tenancy test below would prove nothing");
    const otherSite = await seed<{ site: { id: string } }>(
      "POST", "/projects/sites",
      { name: `Other Site ${runId}`, address: "2 Other St", client: "OTHER", startDate: "2026-01-01", status: "active" },
      otherToken
    );
    otherSiteId = otherSite.body.site.id;
    const otherTpl = await seed<{ template: { id: string } }>(
      "POST", "/inspection-templates",
      { name: `Other Template ${runId}`, items: ["Not yours"] },
      otherToken
    );
    otherCompanyTemplateId = otherTpl.body.template.id;

    // The built-in ids, from the route that serves them.
    const checklists = await seed<{ checklists: Array<{ id: string; name: string }> }>(
      "GET", "/whs-checklists", undefined, ownerToken
    );
    assert.ok(checklists.body.checklists.length > 0, "GET /whs-checklists served no checklists, so there is no built-in id to refuse");
    builtInChecklistId = checklists.body.checklists[0].id;
    assert.ok(builtInChecklistId, "the first built-in checklist has no id");
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    for (const email of [OWNER, OTHER]) {
      await deleteUserAccount(email).catch(() => {});
    }
    await pool?.end().catch(() => {});
  });

  test("a built-in WHS checklist id is refused with 400, and a real inspection_templates id is accepted", async () => {
    // THE DEFECT. This is the exact id the picker holds for the first built-in
    // checklist, sent exactly as an unguarded client would send it.
    const refused = await req<{ error?: string; code?: string }>(
      "POST", "/inspections", inspectionBody(builtInChecklistId, `Built-in ${runId}`), ownerToken
    );
    assert.equal(
      refused.status, 400,
      `a built-in checklist id must be refused, not persisted: ${refused.status} ${JSON.stringify(refused.body)}`
    );
    assert.equal(refused.body.code, "unknown_inspection_template", "the refusal must carry its own code, so a Zod body rejection cannot be mistaken for this guard");
    // Named explicitly: before the guard this was a 23503 caught by the route's
    // try/catch and reported as "Failed to create inspection." A 500 here is
    // the original defect, not a different failure.
    assert.notEqual(refused.status, 500, "the foreign key violation reached Postgres — the guard did not run");

    // POSITIVE CONTROL, SAME ROUTE, SAME TEST. Without this the test above
    // passes just as well when POST /inspections refuses every caller, or has
    // been deleted.
    const accepted = await req<{ inspection?: { id: string; templateId: string | null } }>(
      "POST", "/inspections", inspectionBody(realTemplateId, `Real ${runId}`), ownerToken
    );
    assert.equal(accepted.status, 201, `a real template id must still be accepted: ${accepted.status} ${JSON.stringify(accepted.body)}`);
    assert.equal(accepted.body.inspection?.templateId, realTemplateId, "the accepted inspection did not keep the template id it was created with");

    // AND THE THIRD CASE, which is the one the client actually takes: a
    // built-in checklist becomes templateId null plus the checklist's name, so
    // null must not be collateral damage of the guard.
    const withoutTemplate = await req<{ inspection?: { id: string; templateId: string | null } }>(
      "POST", "/inspections", inspectionBody(null, `No template ${runId}`), ownerToken
    );
    assert.equal(withoutTemplate.status, 201, `templateId null must be accepted — it is what the client sends for a built-in: ${JSON.stringify(withoutTemplate.body)}`);
    assert.equal(withoutTemplate.body.inspection?.templateId, null, "an inspection created without a template came back with one");

    // The refusal left no row. A 400 that had already written would be a worse
    // outcome than the 500 it replaced.
    const listed = await seed<{ inspections: Array<{ name: string }> }>("GET", `/inspections?siteId=${siteId}`, undefined, ownerToken);
    const names = listed.body.inspections.map((i) => i.name);
    assert.ok(names.includes(`Real ${runId}`), `the accepted inspection is missing from the list: ${JSON.stringify(names)}`);
    assert.ok(!names.includes(`Built-in ${runId}`), `the refused inspection was persisted anyway: ${JSON.stringify(names)}`);
  });

  test("another company's template id is refused, and the actor's own is accepted", async () => {
    // A real row in inspection_templates — so the foreign key would be
    // satisfied — belonging to a different tenant. The guard must answer "does
    // the foreign key have something to point at FOR YOU", not "does this id
    // exist somewhere".
    const refused = await req<{ error?: string; code?: string }>(
      "POST", "/inspections", inspectionBody(otherCompanyTemplateId, `Cross-tenant ${runId}`), ownerToken
    );
    assert.equal(
      refused.status, 400,
      `another company's template id must be refused: ${refused.status} ${JSON.stringify(refused.body)}`
    );
    assert.equal(refused.body.code, "unknown_inspection_template", "a cross-tenant template must be refused as unknown, not as forbidden — its existence is not the actor's business");

    // POSITIVE CONTROL, SAME ROUTE, SAME TEST, SAME TOKEN.
    const accepted = await req<{ inspection?: { templateId: string | null } }>(
      "POST", "/inspections", inspectionBody(realTemplateId, `Own template ${runId}`), ownerToken
    );
    assert.equal(accepted.status, 201, `the actor's own template id must be accepted: ${accepted.status} ${JSON.stringify(accepted.body)}`);
    assert.equal(accepted.body.inspection?.templateId, realTemplateId, "the accepted inspection did not keep its template id");

    // AND THE OTHER DIRECTION, which is what makes the first assertion about
    // TENANCY rather than about that id being unusable by anybody: the company
    // that owns the template creates an inspection from it, on its own site,
    // and gets a 201. Without this, a guard that refused every template id in
    // existence would pass the two assertions above.
    const otherOwn = await req<{ inspection?: { templateId: string | null } }>(
      "POST", "/inspections",
      { ...inspectionBody(otherCompanyTemplateId, `Other own ${runId}`), siteId: otherSiteId },
      otherToken
    );
    assert.equal(
      otherOwn.status, 201,
      `the template's own company must be able to use it: ${otherOwn.status} ${JSON.stringify(otherOwn.body)}`
    );
    assert.equal(
      otherOwn.body.inspection?.templateId, otherCompanyTemplateId,
      "the owning company's inspection did not keep the template id it was created with"
    );
  });

  test("the foreign key is real: the store call the route protects raises 23503 for an unknown template id", async () => {
    const actor = { email: OWNER, role: "admin" as const, companyId, companyRole: "owner" as const };
    const payload = {
      siteId,
      name: `Direct ${runId}`,
      date: TODAY,
      results: [],
      status: "pending" as const,
      scope: "", areaInspected: "", time: "",
      inspectorName: "", inspectorRole: "", inspectorCompany: "",
      defects: [], overallOutcome: "", followUpRequired: false,
    };

    // THE HAZARD, MEASURED. Not the route — the store function the route calls,
    // with the guard bypassed, which is what the route did before this branch.
    // In the in-memory store this same call returns a record and resolves.
    const err = await createInspection(actor, { ...payload, templateId: builtInChecklistId })
      .then(() => null)
      .catch((e: unknown) => e);
    assert.ok(err, `Postgres accepted a template_id that is in no table — the foreign key is not doing what 009 says it does`);
    assert.equal(
      (err as { code?: string }).code, "23503",
      `expected a foreign key violation, got: ${(err as { code?: string }).code} ${err instanceof Error ? err.message : String(err)}`
    );

    // POSITIVE CONTROL. Without it, the assertion above passes equally well if
    // createInspection throws for every input — a broken store would read as a
    // well-defended one.
    const created = await createInspection(actor, { ...payload, templateId: realTemplateId, name: `Direct ok ${runId}` });
    assert.equal(created.templateId, realTemplateId, "the control insert did not keep its template id");
    assert.ok(created.id, "the control insert returned no row");
  });
}
