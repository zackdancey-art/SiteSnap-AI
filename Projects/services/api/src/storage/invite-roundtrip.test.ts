/**
 * Phase 1 — the Postgres half of invitation acceptance.
 *
 * Three fixes on this branch live entirely in SQL, so the in-memory suite
 * cannot see any of them and a local run is green either way:
 *
 *   AUDIT L65  acceptSiteInvite's UPDATE of auth_users had a guard whose both
 *              branches were dead, so on Postgres accepting an invitation never
 *              attached anybody to a company. The in-memory path was always
 *              correct, which is exactly why nothing caught it.
 *   the alias  createSiteInvites read `rows[0].xmax` from a `RETURNING (xmax=0)
 *              AS inserted`, so every invitation on Postgres reported "resent".
 *              An ON CONFLICT upsert has no in-memory equivalent.
 *   031        the invited_email backfill. A migration is only observable
 *              against a real database.
 *
 * Every test here pairs its assertion with the opposite outcome in the same
 * run, because each of these three bugs was a silent success: the function
 * returned fine, the migration committed fine, and the wrong value went
 * unremarked. A test that only asserts "the happy path returns success" would
 * have passed against all three of them.
 *
 * Gated on TEST_DATABASE_URL — one skipped placeholder without a real DB.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "invite-roundtrip-test-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { getPgPool } from "./postgres";
import { withTenant } from "./tenant";
import { createSiteInvites, acceptSiteInvite, isAcceptInviteSuccess, initProjectSchema } from "./projectsStore";
import type { Actor } from "./actor";
import { soloCompanyIdForEmail } from "../utils/authToken";

if (!process.env.TEST_DATABASE_URL) {
  test("invite round-trip (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  const MIGRATIONS_DIR = path.join(process.cwd(), "src", "storage", "migrations");
  const M031 = path.join(MIGRATIONS_DIR, "031_normalise_invite_emails.sql");

  const applyMigrations = async (pool: Pool): Promise<void> => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
    );
    const done = new Set(
      (await pool.query<{ version: string }>(`SELECT version FROM schema_migrations`)).rows.map((r) => r.version)
    );
    for (const file of (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort()) {
      const version = file.replace(/\.sql$/, "");
      if (done.has(version)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(`INSERT INTO schema_migrations (version) VALUES ($1)`, [version]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${(e as Error).message}`);
      } finally {
        client.release();
      }
    }
  };

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const CO_A = `inv-co-a-${runId}`;
  const CO_B = `inv-co-b-${runId}`;
  const ownerA = `inv-owner-a-${runId}@t.local`;
  const ownerB = `inv-owner-b-${runId}@t.local`;
  const siteA = `inv-site-a-${runId}`;

  const actorA: Actor = { email: ownerA, role: "admin", companyId: CO_A, companyRole: "owner" };

  let pool: Pool;

  // phone carries a UNIQUE index WHERE phone IS NOT NULL (migration 001), and
  // nothing under test reads it, so it is left NULL rather than invented — a
  // generated number can collide with another suite's and fail this one for a
  // reason that has nothing to do with invitations.
  const seedUser = async (email: string, companyId: string, companyRole = "crew") => {
    await pool.query(
      `INSERT INTO auth_users (email, password_hash, full_name, role, company_id, company_role)
       VALUES ($1,'x','U','worker',$2,$3)
       ON CONFLICT (email) DO UPDATE SET company_id = EXCLUDED.company_id, company_role = EXCLUDED.company_role`,
      [email, companyId, companyRole]
    );
  };

  const companyOf = async (email: string): Promise<{ companyId: string | null; companyRole: string | null }> => {
    const r = await pool.query<{ company_id: string | null; company_role: string | null }>(
      `SELECT company_id, company_role FROM auth_users WHERE email = $1`,
      [email]
    );
    assert.equal(r.rowCount, 1, `expected exactly one auth_users row for ${email}, found ${r.rowCount}`);
    return { companyId: r.rows[0].company_id, companyRole: r.rows[0].company_role };
  };

  const tokenFor = async (email: string): Promise<string> => {
    const r = await withTenant(actorA, (c) =>
      c.query<{ token: string }>(`SELECT token FROM site_invites WHERE invited_email = $1`, [email])
    );
    assert.equal(r.rowCount, 1, `expected exactly one live invite for ${email}, found ${r.rowCount}`);
    return r.rows[0].token;
  };

  // Run migration 031's SQL body again, the way migrate.ts runs it: one file,
  // one transaction. Returns the NOTICE text so the test can read the counts the
  // migration itself reports rather than only the rows it left behind.
  const run031 = async (): Promise<string[]> => {
    const sql = await fs.readFile(M031, "utf8");
    const client = await pool.connect();
    const notices: string[] = [];
    const onNotice = (n: { message?: string }) => notices.push(n.message ?? "");
    client.on("notice", onNotice);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.removeListener("notice", onNotice);
      client.release();
    }
    return notices;
  };

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);
    const { initAuthSchema } = await import("./authStore");
    await initAuthSchema();
    await initProjectSchema();

    await seedUser(ownerA, CO_A, "owner");
    await seedUser(ownerB, CO_B, "owner");
    await withTenant(actorA, (c) =>
      c.query(
        `INSERT INTO project_sites (id, owner_email, name, address, client, start_date, status, company_id)
         VALUES ($1,$2,'Invite Site','1 Test Rd','C','2026-01-01','active',$3)`,
        [siteA, ownerA, CO_A]
      )
    );
  });

  after(async () => {
    // Leave no mixed-case invitation behind: 031 operates on the whole table,
    // and a stray row from this suite would become somebody else's puzzle.
    await withTenant(actorA, async (c) => {
      await c.query(`DELETE FROM site_members WHERE company_id = $1`, [CO_A]);
      await c.query(`DELETE FROM site_invites WHERE company_id = $1`, [CO_A]);
      await c.query(`DELETE FROM project_sites WHERE company_id = $1`, [CO_A]);
    }).catch(() => {});
    await pool.query(`DELETE FROM auth_users WHERE email LIKE $1`, [`inv-%-${runId}@t.local`]).catch(() => {});
    await pool.end().catch(() => {});
  });

  // ---------------------------------------------------------------- L65

  test("L65: an invited signup carrying an empty company_id is attached to the inviting company", async () => {
    const invitee = `inv-empty-${runId}@t.local`;
    // routes/auth.ts writes the EMPTY STRING, not NULL, when a signup carries an
    // invite token. This is the shape the old guard could not match.
    await seedUser(invitee, "", "crew");

    const before_ = await companyOf(invitee);
    assert.equal(before_.companyId, "", "precondition: the invitee starts with an empty company_id");

    const results = await createSiteInvites(actorA, siteA, [invitee], "worker", "crew");
    assert.ok(Array.isArray(results), "createSiteInvites returned a sentinel, not results");
    assert.equal(results.length, 1, "expected exactly one invite result");

    const outcome = await acceptSiteInvite(invitee, await tokenFor(invitee));
    // `typeof outcome === "object"` is NOT the success check any more: the
    // wrong-recipient refusal is an object too, so that assertion would now
    // pass against an accept that refused this invitee by name.
    assert.ok(isAcceptInviteSuccess(outcome), `accept failed: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.companyId, CO_A);

    // The row itself, not the return value. The bug was precisely that the
    // return value said success while the row did not move.
    const after_ = await companyOf(invitee);
    assert.equal(after_.companyId, CO_A, "auth_users.company_id was not stamped");
    assert.equal(after_.companyRole, "crew");

    const members = await withTenant(actorA, (c) =>
      c.query(`SELECT 1 FROM site_members WHERE site_id = $1 AND member_email = $2`, [siteA, invitee])
    );
    assert.equal(members.rowCount, 1, "expected exactly one site_members row for the invitee");
  });

  test("L65: a solo-company user is moved into the inviting company", async () => {
    const invitee = `inv-solo-${runId}@t.local`;
    const solo = soloCompanyIdForEmail(invitee);
    await seedUser(invitee, solo, "owner");

    const before_ = await companyOf(invitee);
    assert.equal(before_.companyId, solo, "precondition: the invitee starts in their own solo company");
    assert.notEqual(solo, CO_A, "precondition: the solo company is not the inviting company");

    const results = await createSiteInvites(actorA, siteA, [invitee], "worker", "manager");
    assert.ok(Array.isArray(results) && results.length === 1);

    const outcome = await acceptSiteInvite(invitee, await tokenFor(invitee));
    assert.ok(isAcceptInviteSuccess(outcome), `accept failed: ${JSON.stringify(outcome)}`);

    const after_ = await companyOf(invitee);
    assert.equal(after_.companyId, CO_A, "a solo company must be overridden by a real invitation");
    assert.equal(after_.companyRole, "manager");
  });

  test("L65: a real other-company member is refused, the token is not burned, and it works once they are free", async () => {
    const invitee = `inv-xco-${runId}@t.local`;
    await seedUser(invitee, CO_B, "manager");

    const results = await createSiteInvites(actorA, siteA, [invitee], "worker", "crew");
    assert.ok(Array.isArray(results) && results.length === 1);
    const token = await tokenFor(invitee);

    // Negative: refused, and the row did not move.
    const refused = await acceptSiteInvite(invitee, token);
    assert.equal(refused, "already_in_company");
    assert.equal((await companyOf(invitee)).companyId, CO_B, "a real company must not be overwritten");

    const stillThere = await withTenant(actorA, (c) =>
      c.query(`SELECT 1 FROM site_invites WHERE token = $1`, [token])
    );
    assert.equal(stillThere.rowCount, 1, "the rejected accept must not consume the invitation");

    // Positive control, same token, same test. Without this the assertions
    // above pass just as happily against an acceptSiteInvite that refuses
    // everyone — which is the shape of every vacuity bug found in this project.
    await pool.query(`UPDATE auth_users SET company_id = '' WHERE email = $1`, [invitee]);
    const accepted = await acceptSiteInvite(invitee, token);
    assert.ok(isAcceptInviteSuccess(accepted), `the surviving token should now work: ${JSON.stringify(accepted)}`);
    assert.equal((await companyOf(invitee)).companyId, CO_A);
  });

  // ------------------------------------------------- the `inserted` alias

  test("the upsert reports sent for a first invitation and resent for a repeat", async () => {
    const invitee = `inv-resend-${runId}@t.local`;
    await seedUser(invitee, "", "crew");

    const first = await createSiteInvites(actorA, siteA, [invitee], "worker", "crew");
    assert.ok(Array.isArray(first) && first.length === 1);
    assert.equal(first[0].status, "sent", "a first invitation must report sent");
    const token1 = await tokenFor(invitee);

    const second = await createSiteInvites(actorA, siteA, [invitee], "worker", "crew");
    assert.ok(Array.isArray(second) && second.length === 1);
    assert.equal(second[0].status, "resent", "a repeat invitation must report resent");
    const token2 = await tokenFor(invitee);

    // The pair is mutually controlling: code stuck on either answer fails one
    // of the two assertions above. These two then prove the upsert really did
    // update in place rather than inserting a second row.
    assert.notEqual(token2, token1, "a resend must issue a fresh token");
    const rows = await withTenant(actorA, (c) =>
      c.query(`SELECT 1 FROM site_invites WHERE site_id = $1 AND invited_email = $2`, [siteA, invitee])
    );
    assert.equal(rows.rowCount, 1, "a resend must leave exactly one invitation row");
  });

  // ----------------------------------------------------- migration 031

  test("migration 031 folds the live invitation, leaves the superseded duplicate, and survives a second run", async () => {
    const mixedSite = `INV-Fold-Site-${runId}@T.local`;
    const mixedNew = `INV-Fold-Dup-${runId}@T.local`;   // newer company invite
    const mixedOld = `inv-fold-dup-${runId}@T.LOCAL`;   // older, same folded form
    assert.equal(mixedSite.toLowerCase(), `inv-fold-site-${runId}@t.local`);
    assert.equal(mixedNew.toLowerCase(), mixedOld.toLowerCase(), "the two duplicates must fold to one address");
    assert.notEqual(mixedNew, mixedOld, "the two duplicates must differ before folding");

    // Seeded with raw SQL on purpose: createSiteInvites now normalises on write
    // (the L46 code fix), so the only way to produce the rows this migration
    // exists for is to write them the way the old code did.
    await withTenant(actorA, async (c) => {
      await c.query(
        `INSERT INTO site_invites (id, site_id, company_id, company_role, invited_email, invited_by, role, token, expires_at, created_at)
         VALUES ($1,$2,$3,'crew',$4,$5,'worker',$6, NOW() + INTERVAL '7 days', NOW())`,
        [`inv-f1-${runId}`, siteA, CO_A, mixedSite, ownerA, `tok-f1-${runId}`]
      );
      await c.query(
        `INSERT INTO site_invites (id, site_id, company_id, company_role, invited_email, invited_by, role, token, expires_at, created_at)
         VALUES ($1,NULL,$2,'crew',$3,$4,'worker',$5, NOW() + INTERVAL '7 days', NOW())`,
        [`inv-f2-${runId}`, CO_A, mixedNew, ownerA, `tok-f2-${runId}`]
      );
      await c.query(
        `INSERT INTO site_invites (id, site_id, company_id, company_role, invited_email, invited_by, role, token, expires_at, created_at)
         VALUES ($1,NULL,$2,'crew',$3,$4,'worker',$5, NOW() + INTERVAL '2 days', NOW() - INTERVAL '1 day')`,
        [`inv-f3-${runId}`, CO_A, mixedOld, ownerA, `tok-f3-${runId}`]
      );
    });

    const mine = async (): Promise<Record<string, string>> => {
      const r = await withTenant(actorA, (c) =>
        c.query<{ id: string; invited_email: string }>(
          `SELECT id, invited_email FROM site_invites WHERE id = ANY($1::text[]) ORDER BY id`,
          [[`inv-f1-${runId}`, `inv-f2-${runId}`, `inv-f3-${runId}`]]
        )
      );
      assert.equal(r.rowCount, 3, `expected my three seeded invites, found ${r.rowCount}`);
      return Object.fromEntries(r.rows.map((x) => [x.id, x.invited_email]));
    };

    const pre = await mine();
    const nonNormalisedPre = Object.values(pre).filter((e) => e !== e.toLowerCase()).length;
    assert.equal(nonNormalisedPre, 3, "precondition: all three seeded rows are non-normalised");

    const notices = await run031();
    assert.ok(
      notices.some((n) => n.startsWith("031:")),
      `migration 031 reported nothing — it must RAISE NOTICE its counts. Got: ${JSON.stringify(notices)}`
    );

    const post = await mine();
    assert.equal(post[`inv-f1-${runId}`], mixedSite.toLowerCase(), "the uncontested site invite must be folded");
    assert.equal(post[`inv-f2-${runId}`], mixedNew.toLowerCase(), "the newer of the colliding pair must be folded");
    assert.equal(post[`inv-f3-${runId}`], mixedOld, "the superseded duplicate must be left exactly as it was");
    const nonNormalisedPost = Object.values(post).filter((e) => e !== e.toLowerCase()).length;
    assert.equal(nonNormalisedPost, 1, "exactly one of the three rows should still be non-normalised");

    // Second run. This is the assertion the first version of 031 would have
    // failed: the superseded row is now the only candidate in its group, ranks
    // first, and a fold would collide with its sibling on
    // site_invites_company_email_partial — a unique violation that aborts the
    // whole migration. The target_taken guard is what makes the rerun a no-op.
    await run031();
    assert.deepEqual(await mine(), post, "a second run of 031 must change nothing");
  });
}
