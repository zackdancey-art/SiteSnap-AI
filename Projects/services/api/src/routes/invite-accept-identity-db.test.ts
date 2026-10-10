/**
 * Who an invitation is for, asserted against real Postgres.
 *
 * WHY THIS EXISTS
 * Accepting an invitation on a device answered "invite denied, invite was sent
 * to another email address" for both the link and the button. Two explanations
 * fitted: correct behaviour badly worded, or a casing bug -- migration 031
 * lowercased stored invitation addresses, so an accept path comparing against a
 * NON-normalised address would refuse every invitation at exactly this step.
 * (It was the first: the two addresses differed in the mailbox name, not the
 * case. The evidence is in the PR body.)
 *
 * The casing explanation was wrong but it was not far-fetched -- it is L36's
 * shape exactly, normalised on the write side and missed on the read side -- and
 * nothing in the suite would have told the two apart. So both halves are pinned
 * here: an invitation whose stored address is in a different case is still
 * accepted by its recipient, and an invitation presented by the wrong account is
 * still refused, named, and left unconsumed.
 *
 * WHY POSTGRES AND NOT THE IN-MEMORY SUITE
 * `projectsStore` has two accept implementations, and the one that runs in
 * production is the SQL one -- a different function, with its own copy of the
 * comparison, reached only when a database is configured. The in-memory suite
 * exercises the other one. L65 is the standing proof that this distinction is
 * not theoretical: an in-memory-green accept path shipped a dead UPDATE guard.
 * The stored address is also only reachable as a mixed-case row through SQL,
 * because every write path normalises it -- which is the point of the test.
 * Guarded on TEST_DATABASE_URL -- skips (one placeholder) without one.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "invite-identity-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { createApp } from "../server";
import { getPgPool } from "../storage/postgres";
import { withTenant } from "../storage/tenant";
import { deleteUserAccount } from "../storage/authStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";

if (!process.env.TEST_DATABASE_URL) {
  test("invite accept identity (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // Every store consulted here branches on DATABASE_URL, and test-setup.ts
  // blanks it. Without this line the route would read the in-memory maps and
  // this file would test the one implementation it is not about. It cannot
  // reach production: getPgPool() refuses DATABASE_URL when NODE_ENV === "test",
  // and node:test gives each file its own process.
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
  const OWNER = `inv-id-owner-${runId}@example.test`;
  const CASED = `inv-id-cased-${runId}@example.test`;
  const TARGET = `inv-id-target-${runId}@example.test`;
  const BYSTANDER = `inv-id-other-${runId}@example.test`;
  const PASSWORD = "Password123!";

  let server: http.Server;
  let baseUrl: string;
  let pool: Pool;
  let ownerToken: string;
  let ownerCompanyId: string;
  let siteId: string;
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

  /** A request whose response is CHECKED — see the note in routes/invites.test.ts. */
  const seed = async <T>(method: string, p: string, body?: unknown, token?: string): Promise<Answer<T>> => {
    const res = await req<T>(method, p, body, token);
    assert.ok(res.status >= 200 && res.status < 300, `seed ${method} ${p} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  };

  const register = async (email: string, fullName: string): Promise<string> => {
    // 11 digits, matching the shape the sibling DB test uses. Longer numbers
    // risk tripping an E.164 length rule for no benefit; the last five digits of
    // the run id are enough to keep concurrent runs apart.
    const phone = `+6140${runId.slice(-5)}${(++phoneSeq).toString().padStart(2, "0")}`;
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

  /** The bystander signs in rather than registering twice across tests. */
  const tokenForBystander = async (): Promise<string> => {
    const r = await seed<{ token: string }>("POST", "/auth/login", { email: BYSTANDER, password: PASSWORD });
    return r.body.token;
  };

  /** Issues one site invitation and returns its token. */
  const inviteToken = async (email: string): Promise<string> => {
    await seed("POST", `/projects/sites/${siteId}/invites`, { emails: [email], role: "crew" }, ownerToken);
    const list = await seed<{ invites: Array<{ invitedEmail: string; token: string }> }>(
      "GET", `/projects/sites/${siteId}/invites`, undefined, ownerToken
    );
    const row = list.body.invites.find((i) => i.invitedEmail.toLowerCase() === email.toLowerCase());
    assert.ok(row?.token, `no invitation listed for ${email}: ${JSON.stringify(list.body.invites)}`);
    return row.token;
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

    ownerToken = await register(OWNER, "Invite Owner");
    const me = await seed<{ user: { companyId: string } }>("GET", "/auth/me", undefined, ownerToken);
    ownerCompanyId = me.body.user.companyId;
    assert.ok(ownerCompanyId, "the owner has no company, so no invitation can be scoped to one");

    const site = await seed<{ site: { id: string } }>(
      "POST", "/projects/sites",
      { name: `Identity Site ${runId}`, address: "1 Main St", client: "ACME", startDate: "2025-01-01", status: "active" },
      ownerToken
    );
    siteId = site.body.site.id;
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    for (const email of [OWNER, CASED, TARGET, BYSTANDER]) {
      await deleteUserAccount(email).catch(() => {});
    }
    await pool?.end().catch(() => {});
  });

  test("an invitation stored in a different case is accepted by its recipient, and a wrong address still is not", async () => {
    // ── the case that must pass ──────────────────────────────────────────────
    const casedInvite = await inviteToken(CASED);

    // Rewrite the stored address to a mixed case, which is the only way to
    // produce the pre-migration-031 row this is about: createSiteInvites
    // normalises, so no route can create one. Written through withTenant
    // because site_invites is RLS-FORCED and a bare pool query would match no
    // rows and silently update nothing.
    const upper = CASED.replace(/^([^@]+)@(.+)$/, (_m, local: string, domain: string) => `${local.toUpperCase()}@${domain}`);
    assert.notEqual(upper, CASED, "precondition: the two spellings must actually differ");
    const updated = await withTenant({ companyId: ownerCompanyId }, (c) =>
      c.query(`UPDATE site_invites SET invited_email = $1 WHERE token = $2`, [upper, casedInvite])
    );
    assert.equal(updated.rowCount, 1, "the stored address was not rewritten, so this test proves nothing");

    // And read it back, because an UPDATE that reported a row is not the same
    // as a row that now holds what we meant.
    const stored = await withTenant({ companyId: ownerCompanyId }, (c) =>
      c.query<{ invited_email: string }>(`SELECT invited_email FROM site_invites WHERE token = $1`, [casedInvite])
    );
    assert.equal(stored.rows[0]?.invited_email, upper);

    const casedUserToken = await register(CASED, "Cased Invitee");
    const accepted = await req<{ siteId: string | null; companyId: string | null; error?: string }>(
      "POST", "/projects/invites/accept", { token: casedInvite }, casedUserToken
    );
    assert.equal(accepted.status, 200, `a casing difference refused the right recipient: ${JSON.stringify(accepted.body)}`);
    assert.equal(accepted.body.siteId, siteId);
    assert.equal(accepted.body.companyId, ownerCompanyId, "the invitation must attach the recipient to the inviting company");

    // ── the case that must fail, on the same route ───────────────────────────
    // Without this, every assertion above would pass equally well against an
    // accept route that admits anybody holding a token — which is the strongest
    // possible version of this bug and the one a "fix the casing" change could
    // plausibly introduce.
    const targetInvite = await inviteToken(TARGET);
    const bystanderToken = await register(BYSTANDER, "Bystander");
    const refused = await req<{ code?: string; invitedEmail?: string }>(
      "POST", "/projects/invites/accept", { token: targetInvite }, bystanderToken
    );
    assert.equal(refused.status, 403, "a genuinely wrong address must still be refused");
    assert.equal(refused.body.code, "invite_wrong_user");
  });

  test("the wrong-recipient refusal names both addresses and leaves the invitation usable", async () => {
    const token = await inviteToken(TARGET);

    const refused = await req<{ error: string; code?: string; invitedEmail?: string; signedInAs?: string }>(
      "POST", "/projects/invites/accept", { token }, await tokenForBystander()
    );
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, "invite_wrong_user");
    assert.equal(refused.body.invitedEmail, TARGET, "the refusal must name the invited address");
    assert.equal(refused.body.signedInAs, BYSTANDER, "and the account that presented it");
    assert.match(refused.body.error, new RegExp(TARGET.replace(/[.+]/g, "\\$&")));
    assert.match(refused.body.error, new RegExp(BYSTANDER.replace(/[.+]/g, "\\$&")));
    assert.match(refused.body.error, /sign out/i, "the refusal must say what to do about it");

    // The invitation survived the refusal. This is the ROLLBACK after the
    // DELETE ... RETURNING in the SQL accept path: the token is claimed before
    // the address is compared, so without that rollback a stranger's single tap
    // would destroy a valid invitation. In-memory never exercises it.
    const targetToken = await register(TARGET, "Target");
    const accepted = await req<{ siteId: string | null; error?: string }>(
      "POST", "/projects/invites/accept", { token }, targetToken
    );
    assert.equal(accepted.status, 200, `the refused invitation did not survive: ${JSON.stringify(accepted.body)}`);
    assert.equal(accepted.body.siteId, siteId);
  });

}
