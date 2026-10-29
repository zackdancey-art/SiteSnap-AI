/**
 * Job numbers, measured against real Postgres. THIS IS THE AUTHORITATIVE HALF.
 *
 * `job-number.test.ts` runs the same seven scenarios against the in-memory
 * store. The duplication is deliberate and the two files must be changed
 * together: several defects in this service have hidden in the gap between the
 * two store implementations (AUDIT L65, L87, L88, L89, L99), so a permissions
 * or tenancy claim is only worth making against the database production uses.
 * The twin earns its keep by being runnable with no Postgres, which is what
 * makes a red-on-revert reproducible on a laptop.
 *
 * WHAT THIS HALF CAN PROVE THAT THE TWIN CANNOT
 *
 * Three things, and they are the reason PR 2 is a database change at all even
 * though it adds no migration:
 *
 *   1. `job_number` is NOT NULL DEFAULT '' in migration 011, so a row created
 *      before PR 2 holds '' and not NULL. The twin's in-memory store has no
 *      column defaults and cannot show that; the `preexisting row` scenario
 *      below writes a row the way migration 011 left it and reads it back
 *      through the product.
 *   2. `project_sites` is FORCE ROW LEVEL SECURITY, so the tenancy refusal is
 *      the database refusing rather than a hand-written `companyId` filter.
 *   3. `UPDATE ... RETURNING *` actually carries the column, which is the half
 *      of AUDIT L118 that a type check cannot reach: `mapSite` dropped
 *      `job_number` for months while every statement selected it.
 *
 * L109 DECLARATION — the stores this suite touches, and whether they honour
 * TEST_DATABASE_URL:
 *
 *   | store         | test-aware? | what this suite uses it for        |
 *   |---------------|-------------|------------------------------------|
 *   | projectsStore | YES         | sites, job numbers, the bin        |
 *   | authStore     | NO          | registration, tokens, accounts     |
 *   | crewStore     | NO          | site members, via invite accept    |
 *
 * So the identities below are held in the IN-MEMORY auth store while every site
 * row is in Postgres. That is deliberate and it is the same arrangement every
 * other `-db` route suite in this service runs under: `DATABASE_URL` is
 * assigned below, which is what `projectsStore.useDatabase()` reads, and
 * `authStore.useDatabase()` ignores it by design. The compensating line is the
 * `precondition` test — it verifies the three tokens carry the three
 * `companyRole` values these scenarios are measured with, so a suite whose
 * identities had silently stopped being distinct would fail loudly rather than
 * pass having tested one role three times. The site rows, which are the subject
 * of every assertion, are unambiguously in Postgres: `behindTheRoute` reads
 * them with SQL through `withTenant`.
 *
 * Guarded on TEST_DATABASE_URL — skips (one placeholder) without one.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "job-number-db-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool, QueryResultRow } from "pg";
import { createApp } from "../server";
import { getPgPool } from "../storage/postgres";
import { withTenant } from "../storage/tenant";
import { deleteUserAccount } from "../storage/authStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import { verifyAuthToken } from "../utils/authToken";

if (!process.env.TEST_DATABASE_URL) {
  test("job numbers against Postgres (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // Every store branches on DATABASE_URL and test-setup.ts blanks it, so
  // without this line these scenarios would measure the in-memory
  // implementation — the one this file is not about. It cannot reach
  // production: getPgPool() refuses DATABASE_URL when NODE_ENV === "test", and
  // node:test gives each file its own process.
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
  const OWNER = `jobno-owner-${runId}@example.test`;
  const CREW = `jobno-crew-${runId}@example.test`;
  const OUTSIDER = `jobno-outsider-${runId}@example.test`;
  const PASSWORD = "Password123!";

  /** The cap, DERIVED from the route's own refusal rather than restated (AUDIT L112). */
  let CAP = 0;

  let server: http.Server;
  let baseUrl: string;
  let pool: Pool;
  let ownerToken: string;
  let crewToken: string;
  let outsiderToken: string;
  let companyId: string;
  let siteId: string;
  let phoneSeq = 0;
  let idSeq = 0;

  type Answer<T> = { status: number; body: T };

  const req = async <T>(method: string, p: string, body?: unknown, token?: string): Promise<Answer<T>> => {
    const res = await fetch(`${baseUrl}/api${p}`, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: T;
    try { parsed = JSON.parse(text) as T; } catch { parsed = { error: text } as unknown as T; }
    return { status: res.status, body: parsed };
  };

  /** A request whose response is CHECKED — a silently failing seed turns every assertion below it into a test of nothing. */
  const seed = async <T>(method: string, p: string, body?: unknown, token?: string): Promise<Answer<T>> => {
    const res = await req<T>(method, p, body, token);
    assert.ok(res.status >= 200 && res.status < 300, `seed ${method} ${p} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  };

  const register = async (email: string, fullName: string): Promise<string> => {
    const phone = `+6142${runId.slice(-5)}${(++phoneSeq).toString().padStart(2, "0")}`;
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

  type Site = { id: string; name: string; client: string; clientId: string | null; jobNumber: string };

  const newSite = async (name: string, token: string, jobNumber?: string): Promise<Site> => {
    const res = await seed<{ site: Site }>(
      "POST", "/projects/sites",
      {
        name, address: "1 Main St", client: "Typed By Hand", startDate: "2026-01-01", status: "active",
        ...(jobNumber === undefined ? {} : { jobNumber }),
      },
      token
    );
    return res.body.site;
  };

  const setJobNumber = (id: string, jobNumber: string, token: string) =>
    req<{ site: Site; error?: string }>("PATCH", `/projects/sites/${id}/job-number`, { jobNumber }, token);

  /**
   * A read from BEHIND the route — and through `withTenant`, not the bare pool.
   *
   * The pool in this file is held for exactly two things, which is why it is on
   * the lint exemption list: applying the migrations before the app boots, and
   * draining itself in `after()`.
   *
   * A bare `pool.query` against `project_sites` would have measured NOTHING:
   * the table is FORCE ROW LEVEL SECURITY (migration 032), the pool sets no
   * `app.company_id`, so `current_setting('app.company_id', true)` is NULL and
   * `company_id = NULL` matches no row. Every "the job number did not change"
   * assertion below would then have been satisfied by a table the test could
   * not see at all — the fail-closed shape CLAUDE.md §3 describes, arriving as
   * "the data is missing" rather than as an error.
   */
  const behindTheRoute = async <T extends QueryResultRow>(sql: string, params: unknown[]) =>
    withTenant({ companyId }, (c) => c.query<T>(sql, params));

  /** The stored job number, read as SQL rather than through the mapper under test. */
  const storedJobNumber = async (id: string): Promise<string | null | undefined> => {
    const r = await behindTheRoute<{ job_number: string | null }>(
      `SELECT job_number FROM project_sites WHERE id = $1`, [id]
    );
    return r.rows[0]?.job_number;
  };

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

    ownerToken = await register(OWNER, "Job Owner");
    const me = await seed<{ user: { companyId: string } }>("GET", "/auth/me", undefined, ownerToken);
    companyId = me.body.user.companyId;
    assert.ok(companyId, "the owner has no company, so nothing below is scoped to one");

    siteId = (await newSite(`Job Number Site ${runId}`, ownerToken)).id;

    // The crew member, by the journey a real crew member takes. `register`
    // alone would have made them an OWNER of their own company.
    await seed("POST", `/projects/sites/${siteId}/invites`, { emails: [CREW], role: "crew" }, ownerToken);
    const invites = await seed<{ invites: Array<{ invitedEmail: string; token: string }> }>(
      "GET", `/projects/sites/${siteId}/invites`, undefined, ownerToken
    );
    const invite = invites.body.invites.find((i) => i.invitedEmail.toLowerCase() === CREW.toLowerCase());
    assert.ok(invite?.token, `no invitation listed for the crew member: ${JSON.stringify(invites.body.invites)}`);
    const registered = await register(CREW, "Job Crew");
    const accepted = await seed<{ token?: string; companyId: string | null }>(
      "POST", "/projects/invites/accept", { token: invite.token }, registered
    );
    assert.equal(accepted.body.companyId, companyId, "the invitation did not attach the crew member to the inviting company");
    crewToken = accepted.body.token ?? registered;

    // A second company, for the tenancy scenario.
    outsiderToken = await register(OUTSIDER, "Job Outsider");

    // Read the cap out of the route rather than restating it.
    const refusal = await setJobNumber(siteId, "x".repeat(4096), ownerToken);
    assert.equal(refusal.status, 400, "a 4096-character job number was not refused, so there is no cap to read");
    const found = /at most (\d+) characters/.exec(refusal.body.error ?? "");
    assert.ok(found, `the route's refusal does not name the cap: ${JSON.stringify(refusal.body)}`);
    CAP = Number(found[1]);
    assert.ok(CAP > 1 && CAP < 4096, `the cap read from the route is not usable: ${CAP}`);
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    for (const email of [OWNER, CREW, OUTSIDER]) {
      await deleteUserAccount(email).catch(() => {});
    }
    await pool?.end().catch(() => {});
  });

  test("precondition: the three tokens carry the three roles these scenarios claim", () => {
    // requireAtLeast reads the TOKEN; /auth/me reads the store. The two can
    // disagree, and only one of them gates a route — so without this the
    // refusals below could be measuring a viewer. This is also the L109
    // compensating check named in the header: the identities come from the
    // in-memory auth store, and this is what proves they are still three.
    const crew = verifyAuthToken(crewToken);
    const owner = verifyAuthToken(ownerToken);
    const outsider = verifyAuthToken(outsiderToken);
    assert.equal(crew?.companyRole, "crew", "the crew token does not carry companyRole crew");
    assert.equal(owner?.companyRole, "owner", "the owner token does not carry companyRole owner");
    assert.ok(outsider?.companyId && outsider.companyId !== owner?.companyId, "the outsider is in the same company, so the tenancy scenario measures nothing");
  });

  test("a manager sets a job number, crew cannot, and crew can still see it", async () => {
    const site = await newSite(`Set Site ${runId}-${++idSeq}`, ownerToken);

    const crewAttempt = await setJobNumber(site.id, "CREW-INVENTED", crewToken);
    assert.equal(crewAttempt.status, 403, "crew set a job number");
    assert.equal(await storedJobNumber(site.id), "", "a 403 was returned but the job number was written anyway");

    // CONTROL, same endpoint, same test: the route works for a manager, so the
    // 403 above is a gate rather than a broken route.
    const managerAttempt = await setJobNumber(site.id, "2026-NW-00123", ownerToken);
    assert.equal(managerAttempt.status, 200, "the manager cannot set a job number either");
    assert.equal(managerAttempt.body.site.jobNumber, "2026-NW-00123", "the route returned 200 with the wrong job number");
    assert.equal(await storedJobNumber(site.id), "2026-NW-00123", "the column does not hold what the route returned");

    // And the capability crew MUST keep: they see the job number on the site
    // they are standing on.
    const crewList = await seed<{ sites: Site[] }>("GET", "/projects/sites", undefined, crewToken);
    const crewView = crewList.body.sites.find((s) => s.id === site.id);
    assert.ok(crewView, "crew can no longer see the site");
    assert.equal(crewView.jobNumber, "2026-NW-00123", "crew can see the site but not its job number");
  });

  test("a value at the cap is accepted and one character more is refused, not truncated", async () => {
    const site = await newSite(`Cap Site ${runId}-${++idSeq}`, ownerToken);

    const atCap = "J".repeat(CAP);
    const ok = await setJobNumber(site.id, atCap, ownerToken);
    assert.equal(ok.status, 200, `a job number of exactly ${CAP} characters was refused`);
    assert.equal(await storedJobNumber(site.id), atCap);

    const overCap = "K".repeat(CAP + 1);
    const refused = await setJobNumber(site.id, overCap, ownerToken);
    assert.equal(refused.status, 400, `a job number of ${CAP + 1} characters was accepted`);

    // THE POINT OF THIS TEST. A truncating implementation would also return a
    // value and a status-only check would pass. The column must still hold the
    // PREVIOUS value.
    assert.equal(await storedJobNumber(site.id), atCap, "the over-long value was stored instead of refused");
    assert.notEqual(await storedJobNumber(site.id), overCap.slice(0, CAP), "the over-long value was truncated and stored");
  });

  test("a site created with a job number keeps it, and one created without holds the empty string", async () => {
    const withNumber = await newSite(`With Number ${runId}-${++idSeq}`, ownerToken, "INV-9981");
    assert.equal(withNumber.jobNumber, "INV-9981", "POST /projects/sites dropped the job number it was given");
    assert.equal(await storedJobNumber(withNumber.id), "INV-9981", "the INSERT did not carry the job number");

    // An EQUALITY against "" and not a falsy check: NULL and "" are both falsy
    // and only one of them is what this column is supposed to hold.
    const without = await newSite(`Without Number ${runId}-${++idSeq}`, ownerToken);
    assert.equal(without.jobNumber, "", "a site created with no job number did not read back as the empty string");
    assert.equal(await storedJobNumber(without.id), "", "the column holds NULL where it should hold ''");
  });

  test("a row written the way migration 011 left it reads back as no job number", async () => {
    // THE SCENARIO THE TWIN CANNOT RUN. Every site that existed before PR 2 was
    // inserted by a statement that did not mention `job_number`, so the value
    // came from the column DEFAULT. This writes a row exactly that way and
    // proves the product reports it as "no job number" rather than as NULL —
    // which is the whole reason PR 2 adds no migration to make the column
    // nullable.
    const preexisting = `preexisting-${runId}-${++idSeq}`;
    await behindTheRoute(
      `INSERT INTO project_sites (id, owner_email, company_id, name, address, client, start_date, status)
       VALUES ($1,$2,$3,$4,'9 Legacy Rd','Legacy Client','2025-01-01','active')`,
      [preexisting, OWNER, companyId, `Legacy Site ${runId}`]
    );
    assert.equal(await storedJobNumber(preexisting), "", "the column default is not the empty string, so PR 2's absence state is wrong");

    const listed = await seed<{ sites: Site[] }>("GET", "/projects/sites", undefined, ownerToken);
    const seen = listed.body.sites.find((s) => s.id === preexisting);
    assert.ok(seen, "the pre-existing row is not listed, so this scenario measured nothing");
    assert.equal(seen.jobNumber, "", "a pre-PR-2 row does not read back as the empty string");

    // CONTROL on the same row: it is a working site, not a broken one. It takes
    // a job number like any other, which is what "existing sites stay valid"
    // has to mean.
    const set = await setJobNumber(preexisting, "LEGACY-1", ownerToken);
    assert.equal(set.status, 200, "a pre-existing site cannot be given a job number");
    assert.equal(await storedJobNumber(preexisting), "LEGACY-1");
  });

  test("the empty string clears a job number", async () => {
    const site = await newSite(`Clear Site ${runId}-${++idSeq}`, ownerToken, "TO-BE-CLEARED");
    // CONTROL FIRST: it really was set, so the "" below clears something.
    assert.equal(await storedJobNumber(site.id), "TO-BE-CLEARED", "the job number was never set, so clearing it proves nothing");

    const cleared = await setJobNumber(site.id, "", ownerToken);
    assert.equal(cleared.status, 200, "clearing a job number was refused");
    assert.equal(cleared.body.site.jobNumber, "");
    assert.equal(await storedJobNumber(site.id), "", "the job number was not cleared");
  });

  test("surrounding whitespace is trimmed and internal spacing is kept", async () => {
    const site = await newSite(`Trim Site ${runId}-${++idSeq}`, ownerToken);

    const padded = await setJobNumber(site.id, "   12-4   ", ownerToken);
    assert.equal(padded.status, 200);
    assert.equal(await storedJobNumber(site.id), "12-4", "the job number was stored with its padding, so the search box will miss it");

    // CONTROL: trimming is not collapsing. "SITE 12 B" is a reference somebody
    // wrote on a drawing.
    const internal = await setJobNumber(site.id, "  SITE 12 B  ", ownerToken);
    assert.equal(internal.status, 200);
    assert.equal(await storedJobNumber(site.id), "SITE 12 B", "internal spacing was altered");

    const blank = await setJobNumber(site.id, "     ", ownerToken);
    assert.equal(blank.status, 200);
    assert.equal(await storedJobNumber(site.id), "", "a whitespace-only job number was stored as whitespace");
  });

  test("another company's manager can neither read nor change a job number", async () => {
    const site = await newSite(`Tenancy Site ${runId}-${++idSeq}`, ownerToken, "PRIVATE-77");

    const outsiderAttempt = await setJobNumber(site.id, "STOLEN", outsiderToken);
    assert.equal(outsiderAttempt.status, 404, "another company's manager changed a job number");
    assert.equal(await storedJobNumber(site.id), "PRIVATE-77", "a 404 was returned but the job number changed anyway");

    const outsiderList = await seed<{ sites: Site[] }>("GET", "/projects/sites", undefined, outsiderToken);
    assert.ok(!outsiderList.body.sites.some((s) => s.id === site.id), "another company's manager can see the site");

    // CONTROL, same two endpoints: the outsider is a working manager of their
    // own company. Without this, a token that had simply stopped
    // authenticating would satisfy both refusals above.
    const theirs = await newSite(`Outsider Site ${runId}-${++idSeq}`, outsiderToken, "THEIRS-1");
    assert.equal(theirs.jobNumber, "THEIRS-1", "the outsider cannot create a site with a job number, so the refusals above measure nothing");
    const theirsSet = await setJobNumber(theirs.id, "THEIRS-2", outsiderToken);
    assert.equal(theirsSet.status, 200, "the outsider cannot set a job number on their own site");
  });

  test("a site in the bin takes no job-number update, and a live one does", async () => {
    const binned = await newSite(`Binned Site ${runId}-${++idSeq}`, ownerToken, "BIN-1");
    await seed("DELETE", `/projects/sites/${binned.id}`, undefined, ownerToken);

    const attempt = await setJobNumber(binned.id, "BIN-2", ownerToken);
    assert.equal(attempt.status, 404, "a binned site accepted a job-number update");
    // Read from behind the route, which is the only way to see a binned row:
    // otherwise "404" and "edited then hidden" look identical.
    assert.equal(await storedJobNumber(binned.id), "BIN-1", "the binned site's job number was changed behind the 404");

    // CONTROL, same endpoint: restored, it takes the update, so the 404 was the
    // `liveOnly` predicate and not a missing route.
    await seed("POST", `/projects/sites/${binned.id}/restore`, undefined, ownerToken);
    const live = await setJobNumber(binned.id, "BIN-2", ownerToken);
    assert.equal(live.status, 200, "a restored site still cannot take a job-number update");
    assert.equal(await storedJobNumber(binned.id), "BIN-2");
  });
}
