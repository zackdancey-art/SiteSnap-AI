/**
 * Client filing, measured against real Postgres. THIS IS THE AUTHORITATIVE HALF.
 *
 * WHY THIS FILE AND ITS IN-MEMORY TWIN BOTH EXIST
 *
 * `clients.test.ts` runs the same six scenarios against the in-memory store.
 * The duplication is deliberate and the two files must be changed together:
 * seven defects in this service have hidden in the gap between the two store
 * implementations (AUDIT L65, L87, L88, L89, L99), so a permissions or tenancy
 * claim is only worth making against the database production uses. The twin
 * earns its keep by being runnable with no Postgres, which is what makes a
 * red-on-revert reproducible on a laptop.
 *
 * WHAT IS BEING DEFENDED HERE
 *
 * Six things, each with both controls in the same test, because a refusal
 * assertion on its own passes equally well when the route has been deleted:
 *
 *   1. Crew READ the client list and cannot change it — and a manager can,
 *      on the same four endpoints, in the same test.
 *   2. A client is invisible and untouchable from another company, while that
 *      company's own client is both.
 *   3. One builder cannot be filed twice under two spellings, while a
 *      genuinely different name is accepted.
 *   4. Filing a site rewrites its free-text label to the client's canonical
 *      name; unfiling clears the link and KEEPS the label.
 *   5. Deleting a client UNFILES its sites and deletes none of them. This is
 *      the assertion that would catch `ON DELETE CASCADE` — the one-word
 *      difference in migration 032 between "unfile three sites" and "destroy
 *      three sites' worth of compliance evidence".
 *   6. Crew cannot file a site; a manager can, same endpoint, same test.
 *
 * NO HAND-WRITTEN COUNTS. `unfiledSites` is compared against the length of the
 * array of sites this file actually filed, not against a literal.
 *
 * Guarded on TEST_DATABASE_URL — skips (one placeholder) without one.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "clients-db-secret";

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
import { CLIENTS_TABLE, SITE_CLIENT_COLUMN } from "../storage/clientsStore";

if (!process.env.TEST_DATABASE_URL) {
  test("client filing against Postgres (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
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
  const OWNER = `clients-owner-${runId}@example.test`;
  const CREW = `clients-crew-${runId}@example.test`;
  const OUTSIDER = `clients-outsider-${runId}@example.test`;
  const PASSWORD = "Password123!";

  let server: http.Server;
  let baseUrl: string;
  let pool: Pool;
  let ownerToken: string;
  let crewToken: string;
  let outsiderToken: string;
  let companyId: string;
  let siteId: string;
  let phoneSeq = 0;

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

  type Client = { id: string; name: string; siteCount?: number };
  type Site = { id: string; name: string; client: string; clientId: string | null };

  const newSite = async (name: string, token: string): Promise<string> => {
    const res = await seed<{ site: Site }>(
      "POST", "/projects/sites",
      { name, address: "1 Main St", client: "Typed By Hand", startDate: "2026-01-01", status: "active" },
      token
    );
    return res.body.site.id;
  };

  const newClient = async (name: string, token: string): Promise<string> => {
    const res = await seed<{ client: Client }>("POST", "/clients", { name }, token);
    return res.body.client.id;
  };

  /**
   * A read from BEHIND the route — and through `withTenant`, not the bare pool.
   *
   * The pool in this file is held for exactly two things, which is why it is on
   * the lint exemption list: applying the migrations before the app boots, and
   * draining itself in `after()`. Neither touches tenanted data.
   *
   * Every read below does, and a bare `pool.query` against `clients` or
   * `project_sites` would have measured NOTHING: both are FORCE ROW LEVEL
   * SECURITY (migrations 022 and 032), the pool sets no `app.company_id`, so
   * `current_setting('app.company_id', true)` is NULL and `company_id = NULL`
   * matches no row. The cascade assertion below would then have read `undefined`
   * for a site that was sitting there intact — and the three `=== null` checks
   * would have been satisfied by a table the test could not see at all. That is
   * the fail-closed shape CLAUDE.md §3 describes, arriving as "the data is
   * missing" rather than as an error.
   *
   * Scoped to the owner's company because every row these scenarios read belongs
   * to it; the cross-company half is measured through the HTTP API, where it
   * belongs.
   */
  const behindTheRoute = async <T extends QueryResultRow>(sql: string, params: unknown[]) =>
    withTenant({ companyId }, (c) => c.query<T>(sql, params));

  const siteRow = async (id: string) => {
    const r = await behindTheRoute<{ client: string; client_id: string | null }>(
      `SELECT client, ${SITE_CLIENT_COLUMN} FROM project_sites WHERE id = $1`, [id]
    );
    return r.rows[0] ?? null;
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

    ownerToken = await register(OWNER, "Clients Owner");
    const me = await seed<{ user: { companyId: string } }>("GET", "/auth/me", undefined, ownerToken);
    companyId = me.body.user.companyId;
    assert.ok(companyId, "the owner has no company, so nothing below is scoped to one");

    siteId = await newSite(`Clients Site ${runId}`, ownerToken);

    // The crew member, by the journey a real crew member takes: invited to a
    // site at role crew, registers, accepts. `registerUser` would have made
    // them an OWNER of their own company, which is not the role under test.
    await seed("POST", `/projects/sites/${siteId}/invites`, { emails: [CREW], role: "crew" }, ownerToken);
    const invites = await seed<{ invites: Array<{ invitedEmail: string; token: string }> }>(
      "GET", `/projects/sites/${siteId}/invites`, undefined, ownerToken
    );
    const invite = invites.body.invites.find((i) => i.invitedEmail.toLowerCase() === CREW.toLowerCase());
    assert.ok(invite?.token, `no invitation listed for the crew member: ${JSON.stringify(invites.body.invites)}`);
    const registered = await register(CREW, "Clients Crew");
    const accepted = await seed<{ token?: string; companyId: string | null }>(
      "POST", "/projects/invites/accept", { token: invite.token }, registered
    );
    assert.equal(accepted.body.companyId, companyId, "the invitation did not attach the crew member to the inviting company");
    crewToken = accepted.body.token ?? registered;

    // A second company, for the tenancy scenario.
    outsiderToken = await register(OUTSIDER, "Clients Outsider");
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
    // refusals below could be measuring a viewer.
    const crew = verifyAuthToken(crewToken);
    const owner = verifyAuthToken(ownerToken);
    const outsider = verifyAuthToken(outsiderToken);
    assert.equal(crew?.companyRole, "crew", "the crew token does not carry companyRole crew");
    assert.equal(owner?.companyRole, "owner", "the owner token does not carry companyRole owner");
    assert.ok(outsider?.companyId && outsider.companyId !== owner?.companyId, "the outsider is in the same company, so scenario 2 measures nothing");
  });

  test("crew read the client list and cannot change it, while a manager can", async () => {
    const clientId = await newClient(`Readable Builders ${runId}`, ownerToken);

    // POSITIVE CONTROL on the read: crew do not merely get a 200, they get the
    // row. A route returning an empty list to everybody would pass a status
    // check and fail the product.
    const crewList = await req<{ clients: Client[] }>("GET", "/clients", undefined, crewToken);
    assert.equal(crewList.status, 200, "crew cannot read the client list");
    assert.ok(crewList.body.clients.some((c) => c.id === clientId), "crew got 200 but not the client");

    // The four refusals.
    const crewPost = await req("POST", "/clients", { name: `Crew Invention ${runId}` }, crewToken);
    const crewPatch = await req("PATCH", `/clients/${clientId}`, { name: `Crew Rename ${runId}` }, crewToken);
    const crewDelete = await req("DELETE", `/clients/${clientId}`, undefined, crewToken);
    assert.equal(crewPost.status, 403, "crew created a client");
    assert.equal(crewPatch.status, 403, "crew renamed a client");
    assert.equal(crewDelete.status, 403, "crew deleted a client");

    // THE CONTROLS, same endpoints, same test. Without these three the block
    // above passes just as well with all four routes deleted.
    const ownerPatch = await req<{ client: Client }>("PATCH", `/clients/${clientId}`, { name: `Renamed Builders ${runId}` }, ownerToken);
    assert.equal(ownerPatch.status, 200, "the owner cannot rename a client either — the route is broken, not gated");
    assert.equal(ownerPatch.body.client.name, `Renamed Builders ${runId}`);
    const ownerPost = await req<{ client: Client }>("POST", "/clients", { name: `Owner Invention ${runId}` }, ownerToken);
    assert.equal(ownerPost.status, 201, "the owner cannot create a client either");
    const ownerDelete = await req("DELETE", `/clients/${ownerPost.body.client.id}`, undefined, ownerToken);
    assert.equal(ownerDelete.status, 200, "the owner cannot delete a client either");

    // And the refusals refused in the DATABASE, not just in the response: the
    // crew member's invented client must not exist at all.
    const invented = await behindTheRoute<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${CLIENTS_TABLE} WHERE name = $1`, [`Crew Invention ${runId}`]
    );
    assert.equal(invented.rows[0].count, 0, "a 403 was returned but the row was written anyway");
  });

  test("a client is invisible and untouchable from another company, while that company's own is both", async () => {
    const mine = await newClient(`Tenancy Mine ${runId}`, ownerToken);
    const theirs = await newClient(`Tenancy Theirs ${runId}`, outsiderToken);

    const theirList = await req<{ clients: Client[] }>("GET", "/clients", undefined, outsiderToken);
    assert.equal(theirList.status, 200);
    // Both halves. The negative alone passes when the route returns nothing.
    assert.ok(!theirList.body.clients.some((c) => c.id === mine), "another company's client appeared in the list");
    assert.ok(theirList.body.clients.some((c) => c.id === theirs), "the caller's OWN client did not appear, so the negative above proves nothing");

    const crossPatch = await req("PATCH", `/clients/${mine}`, { name: `Stolen ${runId}` }, outsiderToken);
    const crossDelete = await req("DELETE", `/clients/${mine}`, undefined, outsiderToken);
    assert.equal(crossPatch.status, 404, "another company renamed my client");
    assert.equal(crossDelete.status, 404, "another company deleted my client");

    // CONTROL: the same two verbs on their own client succeed.
    const ownPatch = await req("PATCH", `/clients/${theirs}`, { name: `Tenancy Theirs Renamed ${runId}` }, outsiderToken);
    assert.equal(ownPatch.status, 200, "the outsider cannot patch their own client either — the 404 above is not a tenancy result");
    const ownDelete = await req("DELETE", `/clients/${theirs}`, undefined, outsiderToken);
    assert.equal(ownDelete.status, 200, "the outsider cannot delete their own client either");

    // And in the database: my row survived both attempts, unrenamed.
    const survived = await behindTheRoute<{ name: string; company_id: string }>(
      `SELECT name, company_id FROM ${CLIENTS_TABLE} WHERE id = $1`, [mine]
    );
    assert.equal(survived.rowCount, 1, "my client row was deleted by another company");
    assert.equal(survived.rows[0].name, `Tenancy Mine ${runId}`, "my client row was renamed by another company");
    assert.equal(survived.rows[0].company_id, companyId);
  });

  test("one builder cannot be filed twice under two spellings, while a different name is accepted", async () => {
    const name = `Metro Builders ${runId}`;
    const first = await req<{ client: Client }>("POST", "/clients", { name }, ownerToken);
    assert.equal(first.status, 201);

    // The same builder, retyped the way it actually gets retyped.
    const dupe = await req<{ error: string; clientId: string }>(
      "POST", "/clients", { name: `  ${name.toLowerCase()}  ` }, ownerToken
    );
    assert.equal(dupe.status, 409, "the same builder was filed twice under two spellings");
    assert.equal(dupe.body.clientId, first.body.client.id, "the 409 did not name the client it collided with");

    // CONTROL: a genuinely different name on the same endpoint is accepted, so
    // the 409 is a duplicate check and not a route that refuses everything.
    const different = await req<{ client: Client }>("POST", "/clients", { name: `${name} North` }, ownerToken);
    assert.equal(different.status, 201, "a different name was refused too — the check is not a duplicate check");

    // Measured, not asserted from a literal: exactly the two accepted names.
    const rows = await behindTheRoute<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM ${CLIENTS_TABLE} WHERE company_id = $1 AND name ILIKE $2`,
      [companyId, `${name}%`]
    );
    assert.equal(rows.rows[0].count, 2, "the duplicate was refused to the caller but written to the table");
  });

  test("filing a site rewrites its label to the client's name, and unfiling keeps the label", async () => {
    const canonical = `Canonical Builders Pty Ltd ${runId}`;
    const clientId = await newClient(canonical, ownerToken);
    const target = await newSite(`Filing Site ${runId}`, ownerToken);

    const before_ = await siteRow(target);
    assert.equal(before_?.client, "Typed By Hand", "the site did not start with the free text this scenario is about");
    assert.equal(before_?.client_id, null, "a brand new site arrived already filed");

    const filed = await req<{ site: Site }>("PATCH", `/projects/sites/${target}`, { clientId }, ownerToken);
    assert.equal(filed.status, 200, "a manager cannot file a site under a client");
    assert.equal(filed.body.site.clientId, clientId);
    assert.equal(filed.body.site.client, canonical, "the free-text label was not brought into step with the client's name");

    // In the database, not just in the response.
    const afterFiling = await siteRow(target);
    assert.equal(afterFiling?.client_id, clientId, "the response said filed but the column did not move");
    assert.equal(afterFiling?.client, canonical);

    // Unfiling clears the link and KEEPS the label — the alternative is a site
    // that loses its client's name entirely.
    const unfiled = await req<{ site: Site }>("PATCH", `/projects/sites/${target}`, { clientId: null }, ownerToken);
    assert.equal(unfiled.status, 200);
    assert.equal(unfiled.body.site.clientId, null, "unfiling left the site filed");
    assert.equal(unfiled.body.site.client, canonical, "unfiling wiped the free-text label as well as the link");
    const afterUnfiling = await siteRow(target);
    assert.equal(afterUnfiling?.client_id, null);
    assert.equal(afterUnfiling?.client, canonical);

    // Another company's client id cannot be used to file my site.
    const theirs = await newClient(`Cross Filing ${runId}`, outsiderToken);
    const cross = await req("PATCH", `/projects/sites/${target}`, { clientId: theirs }, ownerToken);
    assert.equal(cross.status, 400, "a site was filed under another company's client");
    assert.equal((await siteRow(target))?.client_id, null, "the cross-company filing was refused but written");

    // CONTROL on that refusal: my own client id still works on the same route.
    const refiled = await req<{ site: Site }>("PATCH", `/projects/sites/${target}`, { clientId }, ownerToken);
    assert.equal(refiled.status, 200, "the route refuses every clientId, so the 400 above is not a tenancy result");
    assert.equal(refiled.body.site.clientId, clientId);
  });

  test("deleting a client unfiles its sites and deletes none of them", async () => {
    const clientId = await newClient(`Doomed Builders ${runId}`, ownerToken);
    const FILED: string[] = [];
    for (const n of [1, 2, 3]) {
      const id = await newSite(`Doomed Site ${n} ${runId}`, ownerToken);
      await seed("PATCH", `/projects/sites/${id}`, { clientId }, ownerToken);
      FILED.push(id);
    }
    // POSITIVE CONTROL before the delete: they really are filed, so "unfiled
    // afterwards" is a change rather than the state they started in.
    for (const id of FILED) {
      assert.equal((await siteRow(id))?.client_id, clientId, `site ${id} was not filed before the delete`);
    }

    const removed = await req<{ ok: boolean; unfiledSites: number }>("DELETE", `/clients/${clientId}`, undefined, ownerToken);
    assert.equal(removed.status, 200);
    // Measured against what this test actually filed, never a literal.
    assert.equal(removed.body.unfiledSites, FILED.length, "the count of unfiled sites is wrong");

    // THE CASCADE ASSERTION. One word in migration 032 is the difference
    // between unfiling three sites and destroying three sites' compliance
    // evidence, and this is the only thing that can tell them apart.
    for (const id of FILED) {
      const row = await siteRow(id);
      assert.ok(row, `site ${id} was DELETED by deleting its client — migration 032 has CASCADE where it must have SET NULL`);
      assert.equal(row.client_id, null, `site ${id} still points at a client that no longer exists`);
      assert.equal(row.client, `Doomed Builders ${runId}`, `site ${id} lost its client's name as well as the link`);
    }
    // And the client itself is gone, so the loop above is not passing because
    // the delete silently did nothing.
    const gone = await behindTheRoute<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${CLIENTS_TABLE} WHERE id = $1`, [clientId]);
    assert.equal(gone.rows[0].count, 0, "the client was not deleted, so nothing above was measured");

    // The sites are still reachable through the product, not just present in
    // the table — which is what the user would actually notice.
    const list = await seed<{ sites: Site[] }>("GET", "/projects/sites", undefined, ownerToken);
    for (const id of FILED) {
      assert.ok(list.body.sites.some((s) => s.id === id), `site ${id} is in the table but no longer listed`);
    }
  });

  test("crew cannot file a site under a client, and a manager can", async () => {
    const clientId = await newClient(`Crew Filing ${runId}`, ownerToken);
    const target = await newSite(`Crew Filing Site ${runId}`, ownerToken);

    const crewAttempt = await req("PATCH", `/projects/sites/${target}`, { clientId }, crewToken);
    assert.equal(crewAttempt.status, 403, "crew filed a site under a client");
    assert.equal((await siteRow(target))?.client_id, null, "a 403 was returned but the site was filed anyway");

    // CONTROL, same endpoint, same test: the route works for a manager, so the
    // 403 is a gate rather than a broken route.
    const ownerAttempt = await req<{ site: Site }>("PATCH", `/projects/sites/${target}`, { clientId }, ownerToken);
    assert.equal(ownerAttempt.status, 200, "the manager cannot file a site either");
    assert.equal((await siteRow(target))?.client_id, clientId);

    // And crew retain the capability this workstream must not take away: they
    // can still see the site and its filing.
    const crewSites = await req<{ sites: Site[] }>("GET", "/projects/sites", undefined, crewToken);
    assert.equal(crewSites.status, 200);
    const seen = crewSites.body.sites.find((s) => s.id === target);
    assert.ok(seen, "crew can no longer see the site they are standing on");
    assert.equal(seen.clientId, clientId, "crew can see the site but not what it is filed under");
  });
}
