/**
 * H1b (migration 025) RLS integration test for the remaining company-scoped
 * tables: site_members, site_invites, material_deliveries, crew_timecards,
 * inspections. Like rls-integration.test.ts, every isolation assertion runs
 * through a dedicated NOBYPASSRLS probe role — the test/app owner (Neon's
 * neondb_owner) has BYPASSRLS and would make these pass/fail for the wrong
 * reason.
 *
 * Also covers the site_invites company-OR-token policy escape hatch:
 *   - the token branch grants EXACTLY the one named invite, never a wider read;
 *   - it fails closed when app.invite_token is unset;
 *   - acceptSiteInvite (the store) claims a cross-company invite by token and
 *     stamps the joined company on site_members, setting app.company_id only
 *     after validation.
 *
 * Guarded on TEST_DATABASE_URL — skips (one placeholder) without a real DB.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "rls-h1b-test-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import type { Pool } from "pg";
import { getPgPool } from "./postgres";
import { withTenant } from "./tenant";
import { acceptSiteInvite, isAcceptInviteSuccess } from "./projectsStore";
import { soloCompanyIdForEmail } from "../utils/authToken";

if (!process.env.TEST_DATABASE_URL) {
  test("RLS H1b (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
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

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const A = `h1b-co-a-${runId}`;
  const B = `h1b-co-b-${runId}`;
  const ownerA = `h1b-owner-a-${runId}@t.local`;
  const ownerB = `h1b-owner-b-${runId}@t.local`;
  const joinerEmail = `h1b-joiner-${runId}@t.local`; // starts with no company
  const siteA = `h1b-site-a-${runId}`;
  const siteB = `h1b-site-b-${runId}`;
  const inviteTokenA = `h1b-token-a-${runId}`;
  const inviteTokenB = `h1b-token-b-${runId}`;
  const probeRole = `h1b_probe_${runId.replace(/[^a-z0-9]/gi, "")}`;
  const probePassword = `H1b_${Date.now()}_9xZq`;

  let pool: Pool;
  let probe: Client;

  // Seed one row of each RLS table for a company, inside that company's tenant context.
  const seedCompany = async (company: string, ownerEmail: string, siteId: string, token: string) => {
    await pool.query(`INSERT INTO auth_users (email, password_hash, full_name, company_id, company_role) VALUES ($1,'x','O',$2,'owner')`, [ownerEmail, company]);
    await withTenant({ companyId: company }, async (c) => {
      await c.query(`INSERT INTO project_sites (id, owner_email, name, address, client, start_date, status, company_id) VALUES ($1,$2,'S','1 St','C','2026-01-01','active',$3)`, [siteId, ownerEmail, company]);
      await c.query(`INSERT INTO site_members (site_id, member_email, role, invited_by, company_id) VALUES ($1,$2,'worker',$2,$3)`, [siteId, ownerEmail, company]);
      await c.query(`INSERT INTO crew_timecards (id, owner_email, company_id, site_id, worker_name, date) VALUES ($1,$2,$3,$4,'W','2026-01-01')`, [`tc-${company}`, ownerEmail, company, siteId]);
      await c.query(`INSERT INTO material_deliveries (id, owner_email, company_id, site_id, supplier, date) VALUES ($1,$2,$3,$4,'Sup','2026-01-01')`, [`del-${company}`, ownerEmail, company, siteId]);
      await c.query(`INSERT INTO inspections (id, owner_email, company_id, site_id, name, date, results_json, status) VALUES ($1,$2,$3,$4,'Insp','2026-01-01','[]'::jsonb,'pending')`, [`insp-${company}`, ownerEmail, company, siteId]);
      await c.query(`INSERT INTO site_invites (id, site_id, company_id, company_role, invited_email, invited_by, role, token, expires_at) VALUES ($1,$2,$3,'crew',$4,$5,'crew',$6, NOW() + INTERVAL '7 days')`, [`inv-${company}`, siteId, company, joinerEmail, ownerEmail, token]);
    });
  }

  // Run fn as the NOBYPASSRLS probe in a tx with the given GUCs.
  const asProbe = async <T>(gucs: Record<string, string | null>, fn: (c: Client) => Promise<T>): Promise<T> => {
    await probe.query("BEGIN");
    try {
      for (const [k, v] of Object.entries(gucs)) if (v !== null) await probe.query("SELECT set_config($1, $2, true)", [k, v]);
      const r = await fn(probe);
      await probe.query("ROLLBACK");
      return r;
    } catch (e) { await probe.query("ROLLBACK").catch(() => {}); throw e; }
  }

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);
    await seedCompany(A, ownerA, siteA, inviteTokenA);
    await seedCompany(B, ownerB, siteB, inviteTokenB);
    // joiner is in their own SOLO company (the real derived id), which
    // acceptSiteInvite treats as "no real company" — so the cross-company join
    // to company A is allowed. (A random company_id would be rejected as
    // already_in_company.)
    await pool.query(`INSERT INTO auth_users (email, password_hash, full_name, company_id, company_role) VALUES ($1,'x','J',$2,'crew')`, [joinerEmail, soloCompanyIdForEmail(joinerEmail)]);

    await pool.query(`DROP ROLE IF EXISTS ${probeRole}`);
    await pool.query(`CREATE ROLE ${probeRole} LOGIN PASSWORD '${probePassword}' NOBYPASSRLS`);
    await pool.query(`GRANT SELECT, INSERT ON site_members, material_deliveries, crew_timecards, inspections, site_invites TO ${probeRole}`);
    const u = new URL(process.env.TEST_DATABASE_URL as string);
    u.username = probeRole; u.password = probePassword; u.searchParams.delete("channel_binding"); u.searchParams.delete("sslmode");
    // SSL only when the target DB requires it (Neon: PG_SSL=require). Against a
    // plain Postgres with no TLS (e.g. the CI postgres:16 service) an ssl object
    // forces a handshake the server rejects; mirror getPgPool()'s PG_SSL gate.
    probe = new Client({ connectionString: u.toString(), ssl: process.env.PG_SSL === "require" ? { rejectUnauthorized: false } : undefined });
    await probe.connect();
  });

  after(async () => {
    try { await probe.end(); } catch { /* ignore */ }
    await pool.query(`REVOKE ALL ON site_members, material_deliveries, crew_timecards, inspections, site_invites FROM ${probeRole}`).catch(() => {});
    await pool.query(`DROP ROLE IF EXISTS ${probeRole}`).catch(() => {});
    for (const co of [A, B]) await withTenant({ companyId: co }, async (c) => {
      await c.query(`DELETE FROM site_invites WHERE company_id=$1`, [co]);
      await c.query(`DELETE FROM inspections WHERE company_id=$1`, [co]);
      await c.query(`DELETE FROM material_deliveries WHERE company_id=$1`, [co]);
      await c.query(`DELETE FROM crew_timecards WHERE company_id=$1`, [co]);
      await c.query(`DELETE FROM site_members WHERE company_id=$1`, [co]);
      await c.query(`DELETE FROM project_sites WHERE company_id=$1`, [co]);
    });
    await pool.query(`DELETE FROM auth_users WHERE email = ANY($1)`, [[ownerA, ownerB, joinerEmail]]);
    await pool.end();
  });

  // ── Per-table company isolation (the "rows WITH tenant context, zero WITHOUT") ──
  for (const [table, col] of [["site_members", "member_email"], ["material_deliveries", "id"], ["crew_timecards", "id"], ["inspections", "id"]] as const) {
    test(`${table}: probe(company A) sees only A; company B sees zero of A; unscoped sees zero`, async () => {
      const aSeesA = await asProbe({ "app.company_id": A }, (c) => c.query(`SELECT ${col} FROM ${table} WHERE company_id=$1`, [A]));
      assert.ok(aSeesA.rows.length >= 1, `${table}: company A context must see its own rows`);
      const bSeesA = await asProbe({ "app.company_id": B }, (c) => c.query(`SELECT ${col} FROM ${table} WHERE company_id=$1`, [A]));
      assert.equal(bSeesA.rows.length, 0, `${table}: company B must NOT see company A's rows`);
      const unscoped = await asProbe({}, (c) => c.query(`SELECT ${col} FROM ${table} WHERE company_id=$1`, [A]));
      assert.equal(unscoped.rows.length, 0, `${table}: no app.company_id must fail closed`);
    });
  }

  // ── site_invites: company-OR-token policy (escalated checks) ──
  test("site_invites: company isolation — B does not see A's invites; unscoped sees zero", async () => {
    const bSeesA = await asProbe({ "app.company_id": B }, (c) => c.query(`SELECT id FROM site_invites WHERE company_id=$1`, [A]));
    assert.equal(bSeesA.rows.length, 0, "company B must not list company A's pending invites (emails/tokens)");
    const unscoped = await asProbe({}, (c) => c.query(`SELECT id FROM site_invites WHERE company_id=$1`, [A]));
    assert.equal(unscoped.rows.length, 0, "no app.company_id and no token must fail closed");
  });

  test("site_invites token branch grants EXACTLY the one named invite — not a wider read (escalated #2)", async () => {
    // Scope to a company with NO invites so ONLY the token branch can contribute,
    // proving it grants exactly the single named (unguessable) invite — never a
    // wider read. (Setting app.company_id=B would also grant B's own invite via
    // the company branch, which is correct but muddies this specific assertion.)
    const withToken = await asProbe({ "app.company_id": "co-with-no-invites", "app.invite_token": inviteTokenA }, (c) => c.query(`SELECT id, token, company_id FROM site_invites`));
    assert.equal(withToken.rows.length, 1, "the token branch must expose exactly one row");
    assert.equal(withToken.rows[0].token, inviteTokenA, "and it must be exactly the named invite");
    // Naming a token that does not exist grants nothing.
    const bogus = await asProbe({ "app.invite_token": `does-not-exist-${runId}` }, (c) => c.query(`SELECT id FROM site_invites`));
    assert.equal(bogus.rows.length, 0, "a non-existent token must grant zero rows");
  });

  test("site_invites WITH CHECK is company-only — the token branch cannot be used to INSERT into another company", async () => {
    await assert.rejects(
      () => asProbe({ "app.company_id": B, "app.invite_token": inviteTokenA }, (c) =>
        c.query(`INSERT INTO site_invites (id, site_id, company_id, company_role, invited_email, invited_by, role, token, expires_at)
                 VALUES ($1,$2,$3,'crew','x@t','y@t','crew',$4, NOW() + INTERVAL '1 day')`,
          [`rogue-${runId}`, siteA, A, `rogue-token-${runId}`])),
      /row-level security|policy/i,
      "inserting an invite stamped for another company must be rejected by WITH CHECK regardless of app.invite_token"
    );
  });

  // ── acceptSiteInvite: cross-company claim via token; membership stamped in the joined company (escalated #3) ──
  test("acceptSiteInvite claims A's invite for a company-less joiner and stamps site_members with A's company", async () => {
    const result = await acceptSiteInvite(joinerEmail, inviteTokenA);
    // Not `typeof result === "object"`: the wrong-recipient refusal is an
    // object too, and this assertion would pass against it.
    assert.ok(isAcceptInviteSuccess(result), `accept should succeed, got ${JSON.stringify(result)}`);
    // The membership row exists in company A (readable only in A's tenant context) with A's company_id.
    const member = await withTenant({ companyId: A }, (c) =>
      c.query(`SELECT company_id, role FROM site_members WHERE site_id=$1 AND member_email=$2`, [siteA, joinerEmail]));
    assert.equal(member.rows.length, 1, "the joiner must be a member of site A after accepting");
    assert.equal(member.rows[0].company_id, A, "site_members.company_id must be the invite's (joined) company, not steerable elsewhere");
    // The invite token was consumed.
    const goneToken = await asProbe({ "app.invite_token": inviteTokenA }, (c) => c.query(`SELECT id FROM site_invites WHERE token=$1`, [inviteTokenA]));
    assert.equal(goneToken.rows.length, 0, "the accepted invite must have been deleted");
  });
}
