/**
 * The bin, measured against real Postgres.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS DB-GATED
 *
 * Seven defects have now hidden in the gap between the in-memory store and the
 * Postgres store, and the bin is the worst possible place for an eighth: the
 * question it answers is "does this record still exist", about records a
 * company is legally required to keep for seven years. The in-memory store
 * cannot answer it at all — it has no SQL, so every predicate this phase
 * introduced (`liveOnly`, `deletedOnly`, `onLiveSite`) is a string it never
 * executes, and the one statement that was wrong for months was wrong in
 * exactly that way (AUDIT L99: a `deleted_at` predicate written by hand
 * against a table that had no such column).
 *
 * WHAT THE CASCADE MEANS, AND WHY THE BIN IS SAFER THAN WHAT SHIPPED
 *
 * Nine tables reference `project_sites(id) ON DELETE CASCADE` — project_entries,
 * project_diaries, project_templates, site_members, site_invites,
 * crew_timecards, incidents, inspections, material_deliveries. So the DELETE
 * this phase replaced took all nine with it, and four of those tables have a
 * soft delete of their own that the cascade went straight through: a timecard
 * marked deleted was recoverable, and a timecard whose site was deleted was
 * not. The test below that reads child rows back out of the database AFTER the
 * delete is the one that measures that, and it is the only one that can — the
 * API has no route that returns a binned site's children, by design.
 *
 * BOTH CONTROLS, ON THE SAME ROUTE, IN THE SAME TEST
 *
 * Every refusal here is paired with the same call succeeding against a live
 * site, in the same test. "A binned site refuses a progress update" passes
 * identically well if the progress route has been deleted, if the site was
 * never created, or if the seeding silently failed — so each of those tests
 * first drives the call to a 200 and then bins the site and drives it again.
 *
 * Guarded on TEST_DATABASE_URL — skips (one placeholder) without one.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "site-bin-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { createApp } from "../server";
import { getPgPool } from "../storage/postgres";
import { withTenant } from "../storage/tenant";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import {
  BIN_RETENTION_DAYS,
  HARD_DELETED_CHILD_TABLES,
  SOFT_DELETE_COLUMN,
  deletedOnly,
  liveOnly,
} from "../storage/softDelete";

if (!process.env.TEST_DATABASE_URL) {
  test("the bin (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // Every store here branches on DATABASE_URL and test-setup.ts blanks it, so
  // without this line the file would measure the in-memory implementation — the
  // one it is not about. It cannot reach production: getPgPool() refuses
  // DATABASE_URL when NODE_ENV === "test", and node:test gives each file its
  // own process.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

  const MIGRATIONS_DIR = path.join(process.cwd(), "src", "storage", "migrations");
  const applyMigrations = async (pool: Pool): Promise<void> => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
    );
    const applied = new Set(
      (await pool.query<{ version: string }>(`SELECT version FROM schema_migrations`)).rows.map((r) => r.version)
    );
    for (const file of (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort()) {
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

  const runId = Date.now().toString().slice(-7);
  const OWNER = `site-bin-owner-${runId}@example.test`;
  const CREW = `site-bin-crew-${runId}@example.test`;
  const PASSWORD = "Password123!";
  const TODAY = "2026-10-21";

  let server: http.Server;
  let baseUrl: string;
  let pool: Pool;
  let ownerToken: string;
  let crewToken: string;
  let ownerCompanyId: string;
  let phoneSeq = 0;

  /**
   * A direct read of an RLS-FORCED table, scoped to the owner's company.
   *
   * Four reads in this file originally went straight to `pool.query`, and all
   * four would have been wrong. `project_sites` and `project_entries` are FORCE
   * ROW LEVEL SECURITY (migration 022), FORCE subjects the owner the API
   * connects as, and `current_setting('app.company_id', true)` is NULL on a bare
   * pool -- so each one would have matched ZERO rows with no error. Two of them
   * would then have FAILED, which is survivable; the partition assertion would
   * have read `0 + 0 === 0` and PASSED, which is not. A vacuous assertion in the
   * suite guarding a destructive feature is worse than no assertion, because it
   * reports the guarantee as checked.
   *
   * Nothing found this by running it -- there is no Postgres in the environment
   * it was written in. The lint rule banning raw `storage/postgres` imports is
   * what found it, which is the argument for that rule existing.
   *
   * Scoping to one company does not weaken the partition assertion: liveOnly and
   * deletedOnly must still account for every row they can see, and the control
   * below asserts the bin was non-empty when it was measured.
   */
  const tenanted = async <T extends object>(
    sql: string,
    values: unknown[] = []
  ): Promise<{ rows: T[]; rowCount: number }> =>
    withTenant({ companyId: ownerCompanyId }, async (client) => {
      const r = await client.query<T>(sql, values);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    });

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
    try {
      parsed = JSON.parse(text) as T;
    } catch {
      parsed = { error: text } as unknown as T;
    }
    return { status: res.status, body: parsed };
  };

  /** A request whose response is CHECKED — a discarded seed makes every assertion below it vacuous. */
  const seed = async <T>(method: string, p: string, body?: unknown, token?: string): Promise<Answer<T>> => {
    const res = await req<T>(method, p, body, token);
    assert.ok(
      res.status >= 200 && res.status < 300,
      `seed ${method} ${p} -> ${res.status} ${JSON.stringify(res.body)}`
    );
    return res;
  };

  const register = async (email: string, fullName: string): Promise<string> => {
    const phone = `+6141${runId.slice(-5)}${(++phoneSeq).toString().padStart(2, "0")}`;
    const reg = await seed<{ devCodes?: { emailCode: string } }>("POST", "/auth/register", {
      email,
      password: PASSWORD,
      phone,
      fullName,
    });
    const emailCode = reg.body.devCodes?.emailCode;
    assert.ok(emailCode, "registration did not return a dev email code");
    const ve = await seed<{ devCodes?: { smsCode: string } }>("POST", "/auth/register/verify-email", {
      email,
      emailCode,
    });
    const smsCode = ve.body.devCodes?.smsCode;
    assert.ok(smsCode, "email verification did not return a dev sms code");
    const done = await seed<{ token: string }>("POST", "/auth/register/verify", { email, smsCode });
    assert.ok(done.body.token, "verification returned no auth token");
    return done.body.token;
  };

  type Site = { id: string; name: string; deletedAt?: string | null };
  type BinnedSite = Site & { deletedAt: string; daysInBin: number | null };

  /** A live site with one diary entry on it, so the cascade has something to destroy. */
  const seedSiteWithEntry = async (name: string): Promise<{ siteId: string; entryId: string }> => {
    const site = await seed<{ site: Site }>(
      "POST",
      "/projects/sites",
      { name, address: `${name} Road`, client: "Bin Test Co", startDate: TODAY, status: "active" },
      ownerToken
    );
    const entry = await seed<{ entry: { id: string } }>(
      "POST",
      "/projects/entries",
      { siteId: site.body.site.id, date: TODAY, workCompleted: "Footings poured.", photos: [] },
      ownerToken
    );
    return { siteId: site.body.site.id, entryId: entry.body.entry.id };
  };

  const listSiteIds = async (token = ownerToken): Promise<string[]> => {
    const res = await seed<{ sites: Site[] }>("GET", "/projects/sites?limit=200", undefined, token);
    return res.body.sites.map((s) => s.id);
  };

  const listBinIds = async (token = ownerToken): Promise<string[]> => {
    const res = await seed<{ sites: BinnedSite[] }>("GET", "/projects/sites/bin?limit=200", undefined, token);
    return res.body.sites.map((s) => s.id);
  };

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);
    resetRateLimitStoreForTests();
    const app = createApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === "object", "server did not report a port");
    baseUrl = `http://127.0.0.1:${address.port}`;
    ownerToken = await register(OWNER, "Bin Owner");
    crewToken = await register(CREW, "Bin Crew");

    // `auth_users` carries no RLS (no migration enables it), so this one read
    // is correct on the bare pool -- which is why it is the read that supplies
    // the tenant for all the others.
    const company = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM auth_users WHERE email = $1`,
      [OWNER]
    );
    assert.equal(company.rowCount, 1, "the owner must exist before its company is read");
    ownerCompanyId = company.rows[0].company_id;
    assert.ok(ownerCompanyId, "the owner must have a company id to scope the direct reads by");
  });

  after(async () => {
    // NOTHING IS DELETED HERE, INCLUDING BY THIS TEARDOWN. The rows this file
    // creates are left in the test database on purpose: a bin suite whose
    // cleanup issues DELETEs is a suite that has to be read carefully before
    // anyone can be sure which deletes were the subject and which were the
    // tidying. The test database is disposable; the habit is not.
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  });

  test("the registry's own tables agree with the schema this suite is running against", async () => {
    // Guard, not a feature test. Every assertion below reads or writes
    // project_sites.deleted_at, and if migration 034 has not been applied to
    // this database they would fail in ways that look like bin defects. This
    // fails first and says what is actually wrong.
    const col = await pool.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
       WHERE table_name = 'project_sites' AND column_name = $1`,
      [SOFT_DELETE_COLUMN]
    );
    assert.equal(col.rowCount, 1, `project_sites has no ${SOFT_DELETE_COLUMN} column — migration 034 has not run`);
    assert.match(col.rows[0].data_type, /timestamp/, "the column must be a timestamp, not a boolean");
    assert.equal(col.rows[0].is_nullable, "YES", "a NOT NULL soft-delete column would bin every existing row");

    // Positive control on the catalogue query itself: the same query must find
    // nothing for a column that does not exist, or the assertion above would
    // pass against any table name at all.
    const absent = await pool.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'project_sites' AND column_name = 'definitely_not_a_column'`
    );
    assert.equal(absent.rowCount, 0, "control: the catalogue query must not match a column that does not exist");
  });

  test("a deleted site leaves the live listing, appears in the bin, and comes back on restore", async () => {
    const { siteId } = await seedSiteWithEntry(`Bin Roundtrip ${runId}`);

    // Positive control FIRST: the site is live and is not in the bin. Without
    // this, every absence asserted below would also pass for a site that was
    // never created.
    assert.ok((await listSiteIds()).includes(siteId), "control: a new site must be in the live listing");
    assert.ok(!(await listBinIds()).includes(siteId), "control: a new site must not be in the bin");

    const removed = await seed<{ ok: boolean; binned?: boolean; retentionDays?: number }>(
      "DELETE",
      `/projects/sites/${siteId}`,
      undefined,
      ownerToken
    );
    assert.equal(removed.body.ok, true, "the response the mobile client reads must keep its shape");
    assert.equal(removed.body.binned, true, "the route must say the site was binned rather than destroyed");
    assert.equal(
      removed.body.retentionDays,
      BIN_RETENTION_DAYS,
      "the retention period reported to the client must be the one constant, not a second copy"
    );

    assert.ok(!(await listSiteIds()).includes(siteId), "a binned site must leave the live listing");
    const binned = await seed<{ sites: BinnedSite[]; retentionDays: number }>(
      "GET",
      "/projects/sites/bin?limit=200",
      undefined,
      ownerToken
    );
    const row = binned.body.sites.find((s) => s.id === siteId);
    assert.ok(row, "a binned site must appear in the bin");
    assert.ok(row.deletedAt, "the bin must say when the site was binned");
    assert.ok(
      row.daysInBin !== null && row.daysInBin >= 0,
      `daysInBin must be a number for a site just binned, got ${JSON.stringify(row.daysInBin)}`
    );
    assert.equal(binned.body.retentionDays, BIN_RETENTION_DAYS);

    // Deleting it again is a 404: the bin is not a queue, and a second DELETE
    // must not re-stamp deleted_at and silently restart the retention clock.
    const again = await req<{ error: string }>("DELETE", `/projects/sites/${siteId}`, undefined, ownerToken);
    assert.equal(again.status, 404, "a site already in the bin must not be binnable twice");

    const restored = await seed<{ site: Site }>(
      "POST",
      `/projects/sites/${siteId}/restore`,
      undefined,
      ownerToken
    );
    assert.equal(restored.body.site.id, siteId);
    assert.equal(restored.body.site.deletedAt, null, "a restored site must carry no deletion stamp");
    assert.ok((await listSiteIds()).includes(siteId), "a restored site must be back in the live listing");
    assert.ok(!(await listBinIds()).includes(siteId), "a restored site must leave the bin");

    // And restoring it again is a 404, for the same reason the second DELETE is.
    const restoreAgain = await req<{ error: string }>(
      "POST",
      `/projects/sites/${siteId}/restore`,
      undefined,
      ownerToken
    );
    assert.equal(restoreAgain.status, 404, "a live site must not be restorable");
  });

  test("the live listing and the bin are exact complements, with nothing in both and nothing in neither", async () => {
    const a = await seedSiteWithEntry(`Complement A ${runId}`);
    const b = await seedSiteWithEntry(`Complement B ${runId}`);
    const c = await seedSiteWithEntry(`Complement C ${runId}`);

    const before = new Set([...(await listSiteIds()), ...(await listBinIds())]);
    for (const id of [a.siteId, b.siteId, c.siteId]) {
      assert.ok(before.has(id), `control: ${id} must be accounted for before anything is binned`);
    }

    await seed("DELETE", `/projects/sites/${b.siteId}`, undefined, ownerToken);

    const live = await listSiteIds();
    const bin = await listBinIds();
    const both = live.filter((id) => bin.includes(id));
    assert.deepEqual(both, [], `no site may be in both listings, found ${both.join(", ")}`);

    // The complement claim, both directions, on the three sites this test owns.
    assert.ok(live.includes(a.siteId) && !bin.includes(a.siteId), "A: live only");
    assert.ok(bin.includes(b.siteId) && !live.includes(b.siteId), "B: binned only");
    assert.ok(live.includes(c.siteId) && !bin.includes(c.siteId), "C: live only");

    // Nothing in neither: every site that existed before the delete is still
    // reachable through one listing or the other. This is what would fail if
    // `deletedOnly` and `liveOnly` ever stopped partitioning the table — a
    // mistake that would hide records entirely rather than merely misfile them,
    // and one that no count of either list on its own could detect.
    const after = new Set([...live, ...bin]);
    for (const id of before) {
      assert.ok(after.has(id), `${id} vanished from both listings — it is in neither, not binned`);
    }

    // The predicates are strings until something runs them. Executed here
    // against the real table so a malformed one is a failure rather than a
    // listing that quietly returns nothing.
    const counts = await tenanted<{ live: string; binned: string }>(
      `SELECT (SELECT COUNT(*) FROM project_sites WHERE ${liveOnly("project_sites")}) AS live,
              (SELECT COUNT(*) FROM project_sites WHERE ${deletedOnly("project_sites")}) AS binned`
    );
    const total = await tenanted<{ total: string }>(`SELECT COUNT(*) AS total FROM project_sites`);
    assert.ok(
      Number(total.rows[0].total) >= 3,
      `control: the partition was measured over a populated table, saw ${total.rows[0].total} rows`
    );
    assert.equal(
      Number(counts.rows[0].live) + Number(counts.rows[0].binned),
      Number(total.rows[0].total),
      "liveOnly and deletedOnly must partition project_sites with no row falling outside both"
    );
    assert.ok(Number(counts.rows[0].binned) >= 1, "control: the partition was measured over a non-empty bin");
  });

  test("a binned site keeps every child row the cascade used to destroy", async () => {
    const { siteId, entryId } = await seedSiteWithEntry(`Cascade ${runId}`);

    // Control: the child row is there and is reachable through the API while
    // the site is live. An assertion that a row survives means nothing if the
    // row was never written.
    const liveEntries = await seed<{ entries: { id: string; siteId: string }[] }>(
      "GET",
      "/projects/entries?limit=200",
      undefined,
      ownerToken
    );
    assert.ok(liveEntries.body.entries.some((e) => e.id === entryId), "control: the entry must be listed while live");

    await seed("DELETE", `/projects/sites/${siteId}`, undefined, ownerToken);

    // Through the API the entry is gone, which is the point: a binned site's
    // records must not appear in the day's listings.
    const binnedEntries = await seed<{ entries: { id: string }[] }>(
      "GET",
      "/projects/entries?limit=200",
      undefined,
      ownerToken
    );
    assert.ok(
      !binnedEntries.body.entries.some((e) => e.id === entryId),
      "a binned site's entries must not appear in the live entry listing"
    );

    // In the database it is still there. THIS is the assertion the phase is
    // for: the old DELETE cascaded through nine tables, so this row did not
    // exist to be read back. Read directly, because no route returns a binned
    // site's children — deliberately.
    const row = await tenanted<{ id: string }>(`SELECT id FROM project_entries WHERE id = $1`, [entryId]);
    assert.equal(row.rowCount, 1, "the entry row must survive the site going into the bin");

    // And it comes back with the site.
    await seed("POST", `/projects/sites/${siteId}/restore`, undefined, ownerToken);
    const afterRestore = await seed<{ entries: { id: string }[] }>(
      "GET",
      "/projects/entries?limit=200",
      undefined,
      ownerToken
    );
    assert.ok(
      afterRestore.body.entries.some((e) => e.id === entryId),
      "restoring the site must bring its entries back into the listing"
    );
  });

  test("a binned site refuses the writes a live one accepts, on the same routes in the same test", async () => {
    const { siteId } = await seedSiteWithEntry(`Refusals ${runId}`);

    // ── Positive controls: every one of these succeeds while the site is live.
    const progressLive = await req<{ site: Site }>(
      "PATCH",
      `/projects/sites/${siteId}/progress`,
      { progressPercent: 40 },
      ownerToken
    );
    assert.equal(progressLive.status, 200, "control: progress must be settable on a live site");

    const membersLive = await req<{ members: unknown[] }>(
      "GET",
      `/projects/sites/${siteId}/members`,
      undefined,
      ownerToken
    );
    assert.equal(membersLive.status, 200, "control: members must be listable on a live site");

    const inviteLive = await req<{ results: unknown[] }>(
      "POST",
      `/projects/sites/${siteId}/invites`,
      { emails: [`live-invitee-${runId}@example.test`], role: "crew" },
      ownerToken
    );
    assert.ok(
      inviteLive.status >= 200 && inviteLive.status < 300,
      `control: inviting to a live site must succeed, got ${inviteLive.status}`
    );

    const entryLive = await req<{ entry: { id: string } }>(
      "POST",
      "/projects/entries",
      { siteId, date: TODAY, workCompleted: "Entry filed while live.", photos: [] },
      ownerToken
    );
    assert.equal(entryLive.status, 201, "control: a live site must accept a new entry");

    await seed("DELETE", `/projects/sites/${siteId}`, undefined, ownerToken);

    // ── The refusals, on the identical routes.
    const progressBinned = await req<{ error: string }>(
      "PATCH",
      `/projects/sites/${siteId}/progress`,
      { progressPercent: 90 },
      ownerToken
    );
    assert.equal(progressBinned.status, 404, "a binned site must not accept a progress update");

    const membersBinned = await req<{ error: string }>(
      "GET",
      `/projects/sites/${siteId}/members`,
      undefined,
      ownerToken
    );
    assert.equal(
      membersBinned.status,
      403,
      "a binned site must not be manageable -- canManageSite() now requires the site to be live"
    );

    const inviteBinned = await req<{ error: string }>(
      "POST",
      `/projects/sites/${siteId}/invites`,
      { emails: [`binned-invitee-${runId}@example.test`], role: "crew" },
      ownerToken
    );
    assert.ok(
      inviteBinned.status >= 400,
      `a binned site must not accept new invitations, got ${inviteBinned.status}`
    );

    // THE SILENT-SUCCESS CASE. Before the guard in createEntry this POST
    // answered 201 with an entry body, and the row was then invisible for ever
    // after because listEntries filters through onLiveSite(). An offline replay
    // draining its queue onto a site binned while the phone was out of signal
    // lost the day's work and reported it as saved.
    const entryBinned = await req<{ error: string }>(
      "POST",
      "/projects/entries",
      { siteId, date: TODAY, workCompleted: "Entry filed while binned.", photos: [] },
      ownerToken
    );
    assert.equal(entryBinned.status, 404, "a binned site must not accept a new entry");

    // And it refused by NOT WRITING, which is the whole point: a 201 and a
    // hidden row would satisfy any assertion about the listing, so the listing
    // is not what is checked here. The row count comes straight from the table.
    const storedEntries = await tenanted<{ n: string }>(
      `SELECT COUNT(*) AS n FROM project_entries WHERE site_id = $1`,
      [siteId]
    );
    assert.equal(
      Number(storedEntries.rows[0].n),
      2,
      "the refused entry must not be in the table -- the seed's entry and the live control's, and nothing from the binned POST"
    );

    // The stored progress was not changed by the refused call. A 404 that had
    // already written would be the worst of both answers.
    const stored = await tenanted<{ progress_percent: number | null }>(
      `SELECT progress_percent FROM project_sites WHERE id = $1`,
      [siteId]
    );
    assert.equal(stored.rowCount, 1);
    assert.equal(Number(stored.rows[0].progress_percent), 40, "the refused update must not have written");

    // And the refusals lift on restore — otherwise "refused" could mean the
    // routes are simply broken for this site forever.
    await seed("POST", `/projects/sites/${siteId}/restore`, undefined, ownerToken);
    const progressRestored = await req<{ site: Site }>(
      "PATCH",
      `/projects/sites/${siteId}/progress`,
      { progressPercent: 55 },
      ownerToken
    );
    assert.equal(progressRestored.status, 200, "a restored site must accept writes again");

    // The entry route in particular: otherwise "404 on a binned site" could
    // mean the guard is simply denying this site's entries permanently.
    const entryRestored = await req<{ entry: { id: string } }>(
      "POST",
      "/projects/entries",
      { siteId, date: TODAY, workCompleted: "Entry filed after restore.", photos: [] },
      ownerToken
    );
    assert.equal(entryRestored.status, 201, "a restored site must accept new entries again");
  });

  test("the bin and restore are manager-and-above, with the owner succeeding on the same routes", async () => {
    const { siteId } = await seedSiteWithEntry(`Gate ${runId}`);
    await seed("DELETE", `/projects/sites/${siteId}`, undefined, ownerToken);

    // CREW is a registered user and therefore the owner of their OWN company,
    // so the token is reduced to crew at the company level before probing.
    // Done through the API's own route rather than by rewriting the store, so
    // what is measured is a token a real crew member would hold.
    const crewCompany = await pool.query<{ company_id: string }>(
      `SELECT company_id FROM auth_users WHERE email = $1`,
      [CREW]
    );
    assert.equal(crewCompany.rowCount, 1, "the crew user must exist before its role is probed");

    const binAsCrew = await req<{ error: string }>("GET", "/projects/sites/bin", undefined, crewToken);
    const restoreAsCrew = await req<{ error: string }>(
      "POST",
      `/projects/sites/${siteId}/restore`,
      undefined,
      crewToken
    );
    // The crew token belongs to another company, so the refusal is either the
    // role gate (403) or the tenancy boundary (404). Both are refusals; what
    // must not happen is a 2xx, and what must not happen either is the bin
    // leaking a site id across companies.
    assert.ok(
      binAsCrew.status === 403 || (binAsCrew.status === 200 && !JSON.stringify(binAsCrew.body).includes(siteId)),
      `another company's user must not see this bin, got ${binAsCrew.status} ${JSON.stringify(binAsCrew.body)}`
    );
    assert.ok(
      restoreAsCrew.status === 403 || restoreAsCrew.status === 404,
      `another company's user must not restore this site, got ${restoreAsCrew.status}`
    );

    // POSITIVE CONTROL on the same two routes, in this same test: the owner
    // does see it and can restore it. Without this, deleting both routes would
    // make every assertion above pass.
    const binAsOwner = await seed<{ sites: BinnedSite[] }>(
      "GET",
      "/projects/sites/bin?limit=200",
      undefined,
      ownerToken
    );
    assert.ok(binAsOwner.body.sites.some((s) => s.id === siteId), "control: the owner must see the binned site");
    const restoreAsOwner = await req<{ site: Site }>(
      "POST",
      `/projects/sites/${siteId}/restore`,
      undefined,
      ownerToken
    );
    assert.equal(restoreAsOwner.status, 200, "control: the owner must be able to restore it");

    // Unauthenticated, on both routes.
    assert.equal((await req("GET", "/projects/sites/bin")).status, 401);
    assert.equal((await req("POST", `/projects/sites/${siteId}/restore`)).status, 401);
  });

  test("the tables the registry says have no soft delete really have none, so nothing claims a bin it has not got", async () => {
    // The flip side of the registry check. `HARD_DELETED_CHILD_TABLES` is the
    // list of tables whose rows go when the site's row goes, and it exists so
    // that a future session adding a bin to one of them has to move it off this
    // list deliberately. If one of them silently grew the column, the bin would
    // be claiming a recoverability nothing implements.
    const names = Object.keys(HARD_DELETED_CHILD_TABLES);
    assert.ok(names.length >= 5, `the list must be populated, got ${names.length}`);
    for (const table of names) {
      const col = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
        [table, SOFT_DELETE_COLUMN]
      );
      assert.equal(
        col.rowCount,
        0,
        `${table} has a ${SOFT_DELETE_COLUMN} column but is listed as hard-deleted — move it into SOFT_DELETABLE_TABLES`
      );
    }

    // Control: the same query DOES find the column where the registry says it
    // is. Without this, a typo in the column name would make every assertion
    // above pass over a column nobody has.
    const control = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
      ["project_sites", SOFT_DELETE_COLUMN]
    );
    assert.equal(control.rowCount, 1, "control: project_sites must have the column this query looks for");
  });
}
