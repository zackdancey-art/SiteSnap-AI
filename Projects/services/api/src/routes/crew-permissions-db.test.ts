/**
 * What a crew member may and may not do, measured against real Postgres.
 *
 * WHY THIS FILE IS THE AUTHORITATIVE ONE
 *
 * AUDIT L66 measured a crew member 403'd on 9 of 9 reachable GETs while the
 * owner got 200 on the same 9 — the entire field product refused to the person
 * who does the field work, by one pathless `requireAtLeast("viewer")`. AUDIT
 * L65 is why that measurement cannot be trusted to the in-memory suite: the
 * in-memory store and the Postgres store are two implementations, and the
 * suite can be green while production is broken.
 *
 * So this is the table, against the database that production uses, with all
 * three rows in the same test file against the same routes:
 *
 *   - crew 2xx on every operational route, read AND write
 *   - crew 403 on invitation, site deletion, company settings and the
 *     supervisor dashboard
 *   - owner 2xx on all of them
 *
 * BOTH CONTROLS, ON THE SAME ROUTE, IN THE SAME TEST — DELIBERATELY
 *
 * A 403 assertion on its own passes equally well when the route has been
 * deleted, and a 200 assertion on its own passes when every gate has been
 * removed. Neither half is evidence by itself. Every probe below therefore
 * carries both roles, and `measure()` records what each one answered so the
 * table printed at the end is the measurement rather than a restatement of
 * what the test expected.
 *
 * WHY THE CREW TOKEN IS NOT JUST A REGISTERED USER
 *
 * `registerUser` creates a company and makes the registrant its OWNER; a test
 * that then rewrites the role in the store is not the journey a real invitee
 * takes. Here the crew member is invited to a site at role "crew", registers,
 * and accepts — which is how a crew member actually comes to exist — and the
 * token the table is measured with is the fresh one the accept route issues.
 * `verifyAuthToken` is then asked, directly, whether that token really carries
 * companyRole "crew", because `requireAtLeast` reads the TOKEN and `/auth/me`
 * reads the store, so the two can disagree and only one of them gates a route.
 * Without that assertion the whole table could be measuring a viewer.
 *
 * Guarded on TEST_DATABASE_URL — skips (one placeholder) without one.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "crew-permissions-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { createApp } from "../server";
import { getPgPool } from "../storage/postgres";
import { deleteUserAccount } from "../storage/authStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import { verifyAuthToken } from "../utils/authToken";

if (!process.env.TEST_DATABASE_URL) {
  test("crew permissions table (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // See the sibling note in invite-accept-identity-db.test.ts: every store here
  // branches on DATABASE_URL and test-setup.ts blanks it, so without this line
  // the table would measure the in-memory implementation — the one it is not
  // about. It cannot reach production: getPgPool() refuses DATABASE_URL when
  // NODE_ENV === "test", and node:test gives each file its own process.
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
  const OWNER = `crew-perm-owner-${runId}@example.test`;
  const CREW = `crew-perm-crew-${runId}@example.test`;
  const PASSWORD = "Password123!";
  const TODAY = "2026-10-11";

  /**
   * The population of each half of the table, pinned.
   *
   * A route quietly dropped from a list below would otherwise take its row out
   * of the measurement and still leave the file green — the same failure mode
   * as a suite that passes because its selector matched nothing. Changing a
   * number here is changing what "crew can do their job" means, so it has to
   * happen in the same commit as the route that moved.
   */
  const EXPECTED_READS = 15;
  const EXPECTED_WRITE_STEPS = 13;
  const EXPECTED_REFUSALS = 15;

  let server: http.Server;
  let baseUrl: string;
  let pool: Pool;
  let ownerToken: string;
  let crewToken: string;
  let companyId: string;
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

  // ── The measurement ────────────────────────────────────────────────────────
  //
  // One row per probe, holding what each role ACTUALLY answered. The table is
  // printed at the end and is the thing quoted in the PR body; the assertions
  // read from the same rows, so the printed table cannot drift from what was
  // asserted.
  type Row = { label: string; route: string; crew: number; owner: number };
  const READS: Row[] = [];
  const WRITES: Row[] = [];
  const REFUSALS: Row[] = [];

  const ok = (status: number) => status >= 200 && status < 300;

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

    ownerToken = await register(OWNER, "Crew Perm Owner");
    const me = await seed<{ user: { companyId: string } }>("GET", "/auth/me", undefined, ownerToken);
    companyId = me.body.user.companyId;
    assert.ok(companyId, "the owner has no company, so nothing below is scoped to one");

    const site = await seed<{ site: { id: string } }>(
      "POST", "/projects/sites",
      { name: `Crew Perm Site ${runId}`, address: "1 Main St", client: "ACME", startDate: "2025-01-01", status: "active" },
      ownerToken
    );
    siteId = site.body.site.id;

    // The crew member, by the journey a real crew member takes.
    await seed("POST", `/projects/sites/${siteId}/invites`, { emails: [CREW], role: "crew" }, ownerToken);
    const invites = await seed<{ invites: Array<{ invitedEmail: string; token: string }> }>(
      "GET", `/projects/sites/${siteId}/invites`, undefined, ownerToken
    );
    const invite = invites.body.invites.find((i) => i.invitedEmail.toLowerCase() === CREW.toLowerCase());
    assert.ok(invite?.token, `no invitation listed for the crew member: ${JSON.stringify(invites.body.invites)}`);

    const registered = await register(CREW, "Crew Member");
    const accepted = await seed<{ token?: string; companyId: string | null }>(
      "POST", "/projects/invites/accept", { token: invite.token }, registered
    );
    assert.equal(accepted.body.companyId, companyId, "the invitation did not attach the crew member to the inviting company");
    crewToken = accepted.body.token ?? registered;
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    for (const email of [OWNER, CREW]) {
      await deleteUserAccount(email).catch(() => {});
    }
    await pool?.end().catch(() => {});
  });

  test("precondition: the two tokens really carry the two roles the table claims", () => {
    // requireAtLeast reads the TOKEN, not the store, so this is the only
    // assertion that makes the rest of the file mean anything. /auth/me would
    // answer from the store and could say "crew" while the token said owner.
    const crewClaims = verifyAuthToken(crewToken);
    const ownerClaims = verifyAuthToken(ownerToken);
    assert.ok(crewClaims, "the crew token does not verify");
    assert.ok(ownerClaims, "the owner token does not verify");
    assert.equal(crewClaims.companyRole, "crew", "the crew token does not carry companyRole crew, so no 403 below proves anything about crew");
    assert.equal(ownerClaims.companyRole, "owner", "the owner token does not carry companyRole owner, so no 200 below is an owner control");
    assert.equal(crewClaims.companyId, companyId, "the crew member is not in the company whose rows the table reads");
    assert.equal(ownerClaims.companyId, companyId);
  });

  test("crew read every operational route, and so does the owner", async () => {
    // The field product. L66's nine reachable GETs are all in here, plus the
    // rest of what the mobile app and the portal call on a normal day.
    const reads: Array<[string, string]> = [
      ["bootstrap (every portal screen, and mobile's first load)", "/projects/bootstrap"],
      ["sites", "/projects/sites"],
      ["diary entries", "/projects/entries"],
      ["diaries", "/projects/diaries"],
      ["diary templates", "/projects/templates"],
      ["timesheets", "/crew/timecards"],
      ["incidents", "/incidents"],
      ["inspections", "/inspections"],
      ["inspection templates", "/inspection-templates"],
      ["deliveries", "/deliveries"],
      ["entry templates", "/entry-templates"],
      ["WHS checklists", "/whs-checklists"],
      ["location — live map", "/location/workers"],
      ["push tokens", "/push/tokens"],
      ["account settings (personal, not company)", "/account/settings"],
    ];
    assert.equal(reads.length, EXPECTED_READS, "the operational read population changed — see EXPECTED_READS");

    for (const [label, route] of reads) {
      const asCrew = await req<{ error?: string }>("GET", route, undefined, crewToken);
      const asOwner = await req<{ error?: string }>("GET", route, undefined, ownerToken);
      READS.push({ label, route: `GET ${route}`, crew: asCrew.status, owner: asOwner.status });
      assert.ok(ok(asCrew.status), `crew must be able to read ${route}: ${asCrew.status} ${JSON.stringify(asCrew.body)}`);
      assert.ok(ok(asOwner.status), `the owner control failed on ${route}, so the crew result above proves nothing: ${asOwner.status} ${JSON.stringify(asOwner.body)}`);
    }
  });

  test("crew write the field product, and so does the owner", async () => {
    /**
     * The same sequence run twice, once per role, on the routes a crew member
     * uses to record a day's work. Read access without write access is not the
     * decision — "crew gets, read and write" — and a GET-only table would have
     * passed while every save still failed.
     *
     * Each role creates, edits and deletes its OWN rows, so neither run depends
     * on the other's state and the owner control is a genuine comparison rather
     * than a second pass over the first run's leftovers.
     */
    const sequence = async (who: string, token: string): Promise<Array<[string, string, number]>> => {
      const out: Array<[string, string, number]> = [];
      const step = async <T>(label: string, method: string, p: string, body?: unknown): Promise<Answer<T>> => {
        const res = await req<T>(method, p, body, token);
        out.push([label, `${method} ${p.replace(/\/[0-9a-f-]{8,}/gi, "/:id")}`, res.status]);
        return res;
      };

      const entry = await step<{ entry: { id: string } }>("record a diary entry", "POST", "/projects/entries", {
        siteId, date: TODAY, notes: `${who} was on site`, weather: "Fine", crewCount: "3",
      });
      const entryId = entry.body.entry?.id;
      await step("edit that entry", "PATCH", `/projects/entries/${entryId ?? "missing"}`, { notes: `${who} corrected the note` });

      const diary = await step<{ diary: { id: string } }>("save a diary", "POST", "/projects/diaries", {
        siteId, status: "draft", summary: `${who} daily diary`, reportPeriod: "daily",
      });
      const diaryId = diary.body.diary?.id;
      // Crew can approve a diary. That is NOT one of the three exceptions and
      // the route carries no manager gate — flagged in the PR body as a
      // permission inferred from the decision rather than stated by it.
      await step("approve that diary", "PATCH", `/projects/diaries/${diaryId ?? "missing"}`, { status: "approved" });

      await step("save a diary template", "POST", "/projects/templates", {
        siteId, name: `${who} template`, weather: "Fine", crewCount: "3", notesTemplate: "",
      });
      await step("enter a timesheet", "POST", "/crew/timecards", {
        siteId, workerName: who, date: TODAY, startTime: "07:00", endTime: "15:30", breakMinutes: 30, hoursRegular: 8,
      });
      await step("report an incident", "POST", "/incidents", {
        siteId, date: TODAY, severity: "near-miss", description: `${who} reported a near miss`,
      });
      const tpl = await step<{ template: { id: string } }>("create an inspection template", "POST", "/inspection-templates", {
        name: `${who} checklist`, items: ["Edge protection", "Harness"],
      });
      await step("complete an inspection", "POST", "/inspections", {
        siteId, templateId: tpl.body.template?.id ?? null, name: `${who} inspection`, date: TODAY,
        results: [{ item: "Edge protection", passed: true, notes: "", na: false, photos: [] }], status: "complete",
      });
      await step("log a delivery", "POST", "/deliveries", {
        siteId, date: TODAY, supplier: "Placemakers", items: ["Timber"], quantity: "20", notes: "",
      });
      await step("save an entry template", "POST", "/entry-templates", {
        name: `${who} entry template`, notes: "", crewCount: "3", weather: "Fine",
      });
      await step("send a location ping", "POST", "/location/update", {
        latitude: -36.8485, longitude: 174.7633, accuracy: 5, siteId, userName: who,
      });
      await step("update site progress", "PATCH", `/projects/sites/${siteId}/progress`, { progressPercent: 42 });
      // Last, because it removes the row the first two steps created.
      await step("delete that entry", "DELETE", `/projects/entries/${entryId ?? "missing"}`);
      return out;
    };

    const asCrew = await sequence("crew", crewToken);
    const asOwner = await sequence("owner", ownerToken);
    assert.equal(asCrew.length, EXPECTED_WRITE_STEPS, "the operational write population changed — see EXPECTED_WRITE_STEPS");
    assert.equal(asOwner.length, asCrew.length, "the two runs did not perform the same sequence, so they are not comparable");

    for (let i = 0; i < asCrew.length; i++) {
      const [label, route, crewStatus] = asCrew[i];
      const [ownerLabel, , ownerStatus] = asOwner[i];
      assert.equal(ownerLabel, label, "the two sequences diverged");
      WRITES.push({ label, route, crew: crewStatus, owner: ownerStatus });
      assert.ok(ok(crewStatus), `crew must be able to ${label} (${route}): ${crewStatus}`);
      assert.ok(ok(ownerStatus), `the owner control failed on ${route}, so the crew result above proves nothing: ${ownerStatus}`);
    }
  });

  test("crew are refused the four exceptions, and the owner is not, on the same routes", async () => {
    /**
     * Invitation, site deletion, company settings and the supervisor
     * dashboard. Each probe runs as crew and then as the owner against the SAME
     * route and, where it is destructive, the SAME resource — so the 403 cannot
     * be a deleted route and the 200 cannot be a removed gate.
     *
     * The destructive probes are ordered last within the list for the same
     * reason the entry deletion is last above: the owner control consumes the
     * thing being refused.
     */
    const disposable = await seed<{ site: { id: string } }>(
      "POST", "/projects/sites",
      { name: `Disposable Site ${runId}`, address: "2 Main St", client: "ACME", startDate: "2025-01-01", status: "active" },
      ownerToken
    );
    const disposableId = disposable.body.site.id;

    // An invitation the owner can then revoke, so the DELETE probe has a real id.
    const revokeTarget = `crew-perm-revoke-${runId}@example.test`;
    await seed("POST", `/projects/sites/${siteId}/invites`, { emails: [revokeTarget], role: "crew" }, ownerToken);
    const listed = await seed<{ invites: Array<{ id: string; invitedEmail: string }> }>(
      "GET", `/projects/sites/${siteId}/invites`, undefined, ownerToken
    );
    const revokeId = listed.body.invites.find((i) => i.invitedEmail.toLowerCase() === revokeTarget)?.id;
    assert.ok(revokeId, `no revocable invitation to probe with: ${JSON.stringify(listed.body.invites)}`);

    const probes: Array<{ label: string; method: string; path: string; body?: unknown }> = [
      // ── Exception 1: crew cannot invite anyone ────────────────────────────
      { label: "invite someone to a site", method: "POST", path: `/projects/sites/${siteId}/invites`, body: { emails: [`crew-perm-probe-${runId}@example.test`], role: "crew" } },
      { label: "see who has been invited to a site", method: "GET", path: `/projects/sites/${siteId}/invites` },
      { label: "invite someone to the company", method: "POST", path: "/company/members/invite", body: { emails: [`crew-perm-co-${runId}@example.test`], companyRole: "crew" } },
      { label: "see the company's pending invitations", method: "GET", path: "/company/invites" },
      { label: "list the company's members", method: "GET", path: "/company/members" },
      { label: "list a site's members", method: "GET", path: `/projects/sites/${siteId}/members` },
      // ── Exception 3: crew cannot change company settings ──────────────────
      { label: "read the company profile", method: "GET", path: "/company/profile" },
      { label: "change the company profile", method: "PATCH", path: "/company/profile", body: { name: `Crew Perm Co ${runId}` } },
      { label: "change somebody's company role", method: "PATCH", path: `/company/members/${encodeURIComponent(CREW)}/role`, body: { companyRole: "crew" } },
      // ── The supervisor dashboard ──────────────────────────────────────────
      { label: "the supervisor dashboard's own route", method: "GET", path: "/projects/reports/supervisor" },
      { label: "the supervisor summary aggregate", method: "GET", path: "/projects/summary" },
      // ── Exception 2: crew cannot remove a site. Also creating one. ────────
      { label: "create a site", method: "POST", path: "/projects/sites", body: { name: `Probe Site ${runId}`, address: "3 Main St", client: "ACME", startDate: "2025-01-01", status: "active" } },
      { label: "delete a site", method: "DELETE", path: `/projects/sites/${disposableId}` },
      { label: "revoke an invitation", method: "DELETE", path: `/projects/sites/${siteId}/invites/${revokeId}` },
      // Last of all: the owner control removes the crew member's own site
      // membership, which nothing below may depend on.
      { label: "remove somebody from a site", method: "DELETE", path: `/projects/sites/${siteId}/members/${encodeURIComponent(CREW)}` },
    ];
    assert.equal(probes.length, EXPECTED_REFUSALS, "the refusal population changed — see EXPECTED_REFUSALS");

    for (const { label, method, path: p, body } of probes) {
      const asCrew = await req<{ error?: string }>(method, p, body, crewToken);
      const asOwner = await req<{ error?: string }>(method, p, body, ownerToken);
      const route = `${method} ${p.replace(/\/[0-9a-f-]{8,}/gi, "/:id").replace(/\/[^/]*%40[^/]*/gi, "/:email")}`;
      REFUSALS.push({ label, route, crew: asCrew.status, owner: asOwner.status });
      assert.equal(asCrew.status, 403, `crew must be refused ${label} (${route}): ${asCrew.status} ${JSON.stringify(asCrew.body)}`);
      assert.ok(ok(asOwner.status), `the owner control failed on ${route}, so the 403 above could be a deleted route rather than a refusal: ${asOwner.status} ${JSON.stringify(asOwner.body)}`);
    }
  });

  test("the measured table is complete, and all three rows hold", () => {
    assert.equal(READS.length, EXPECTED_READS, "the read half did not run");
    assert.equal(WRITES.length, EXPECTED_WRITE_STEPS, "the write half did not run");
    assert.equal(REFUSALS.length, EXPECTED_REFUSALS, "the refusal half did not run");

    const lines: string[] = [];
    const emit = (heading: string, rows: Row[]) => {
      lines.push(`\n  ${heading}`);
      for (const r of rows) {
        lines.push(`    ${r.crew === 403 ? "403" : String(r.crew).padEnd(3)}  ${String(r.owner).padEnd(3)}  ${r.route}  — ${r.label}`);
      }
    };
    lines.push("\n  CREW PERMISSIONS, MEASURED AGAINST POSTGRES  (crew / owner)");
    emit("operational reads — crew must be allowed", READS);
    emit("operational writes — crew must be allowed", WRITES);
    emit("the exceptions — crew must be refused", REFUSALS);
    console.log(lines.join("\n"));

    // The three rows, as claims rather than as a list of individual asserts.
    assert.ok([...READS, ...WRITES].every((r) => ok(r.crew)), "crew were refused an operational route");
    assert.ok(REFUSALS.every((r) => r.crew === 403), "crew were admitted to an exception");
    assert.ok([...READS, ...WRITES, ...REFUSALS].every((r) => ok(r.owner)), "the owner was refused something, so some control above is not a control");
  });

}
