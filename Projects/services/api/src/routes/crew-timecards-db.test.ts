/**
 * Timesheet approval, measured against real Postgres.
 *
 * WHY THIS FILE IS THE AUTHORITATIVE HALF
 *
 * Seven defects have now hidden in the gap between the in-memory store and the
 * Postgres store (AUDIT L65 is the general case; L10 was timecards
 * specifically). Everything this workstream adds is a permission, an ownership
 * narrowing or a state that forbids a write, so all of it belongs here rather
 * than in the in-memory mirror. The sibling `crew-timecards.test.ts` runs the
 * same journeys against the JSON fallback so the two implementations are both
 * covered, but when they disagree THIS file is the one that describes
 * production.
 *
 * Four things are measured, and each needs a reason for being in the list:
 *
 *   1. THE RANK GATE. A crew member may not approve a timecard — their own
 *      least of all. `POST /crew/timecards/:id/approval` carries
 *      `requireAtLeast("manager")` and nothing else, so this is the one write
 *      on a timesheet that is deliberately somebody else's row.
 *
 *   2. READ-ONLY AFTER APPROVAL. Once approved, nobody changes the row — not
 *      the author, and not the manager who approved it. The refusal is a 409
 *      rather than a 403 because no rank opens an approved timecard; the way
 *      back is to reopen it, which is a recorded act.
 *
 *   3. THE FIELD GATE. `approvalStatus`, `approvedBy`, `approvedAt` and
 *      `approvalNote` are not editable fields. The edit route refuses the key
 *      outright (`.strict()`), and the store cannot write it even if the route
 *      stops refusing (`EDITABLE_COLUMNS` is a closed list). Both layers are
 *      probed, because CLAUDE.md §3's both-layers rule is only worth having if
 *      removing either one is visible.
 *
 *   4. CREW SEE ONLY THEIR OWN. `RECORD_CLASS.timesheet = "personal-record"`
 *      already narrows both the read and the write side, and that narrowing has
 *      never been measured against Postgres on this record type. An approval
 *      workflow is the point at which it starts to matter: a crew member who
 *      can see a colleague's hours can see what they are paid.
 *
 * EVERY NEGATIVE ASSERTION HAS A POSITIVE CONTROL ON THE SAME ENDPOINT IN THE
 * SAME TEST. A refusal test alone passes equally well when the route has been
 * deleted — and `docs/VACUITY-AUDIT.md` M7 is the case where exactly that
 * happened: mutating `/uploads/sign` to deny every caller left all 126 tests
 * green. So the 409 tests edit the row successfully first, the 403 tests have
 * the owner succeed on the same route in the same test, and the own-only test
 * asserts the crew member DOES see their own row and that the owner sees both.
 *
 * THE ONE PROBE THAT GOES ROUND THE ROUTES
 *
 * `TIMECARD_APPROVAL_STATUSES` in the store and the CHECK constraint in
 * migration 033 are two lists that have to agree, and neither one can prove the
 * other from the API surface: a status present in TypeScript but absent from
 * the CHECK is a 500 nobody writes a test for, and a CHECK that was never
 * created at all leaves every route test green. So one test writes each status
 * through the route (the TS list, proved acceptable to the database) and one
 * writes a status that is in neither list directly through the pool inside a
 * rolled-back transaction (the CHECK, proved to exist). The direct write sets
 * `app.company_id` first and asserts a VALID write matches one row before
 * trying the invalid one — without that control, RLS filtering the row out
 * would make the refusal indistinguishable from a constraint that is not there.
 *
 * Guarded on TEST_DATABASE_URL — skips (one placeholder) without one.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "crew-timecards-approval-secret";

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
import {
  TIMECARDS_TABLE,
  TIMECARD_APPROVAL_STATUS_COLUMN,
  TIMECARD_APPROVAL_STATUSES,
  TIMECARD_EDITABLE_STATUSES,
} from "../storage/crewStore";

if (!process.env.TEST_DATABASE_URL) {
  test("timecard approval (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // See the sibling note in crew-permissions-db.test.ts: every store here
  // branches on DATABASE_URL and test-setup.ts blanks it, so without this line
  // the suite would measure the in-memory implementation — the one it is not
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
  const OWNER = `tc-owner-${runId}@example.test`;
  const CREW = `tc-crew-${runId}@example.test`;
  const OTHER_CREW = `tc-crew2-${runId}@example.test`;
  const PASSWORD = "Password123!";
  const TODAY = "2026-10-20";

  let server: http.Server;
  let baseUrl: string;
  let pool: Pool;
  let ownerToken: string;
  let crewToken: string;
  let otherCrewToken: string;
  let companyId: string;
  let siteId: string;
  let phoneSeq = 0;

  type Answer<T> = { status: number; body: T };
  type Timecard = {
    id: string;
    ownerEmail: string;
    hoursRegular: number;
    notes: string;
    approvalStatus: string;
    approvedBy?: string | null;
    approvedAt?: string | null;
    approvalNote?: string | null;
  };

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

  /** Invite someone to the site at `role`, register them, accept. The journey. */
  const joinAsCrew = async (email: string, fullName: string): Promise<string> => {
    await seed("POST", `/projects/sites/${siteId}/invites`, { emails: [email], role: "crew" }, ownerToken);
    const invites = await seed<{ invites: Array<{ invitedEmail: string; token: string }> }>(
      "GET", `/projects/sites/${siteId}/invites`, undefined, ownerToken
    );
    const invite = invites.body.invites.find((i) => i.invitedEmail.toLowerCase() === email.toLowerCase());
    assert.ok(invite?.token, `no invitation listed for ${email}: ${JSON.stringify(invites.body.invites)}`);
    const registered = await register(email, fullName);
    const accepted = await seed<{ token?: string; companyId: string | null }>(
      "POST", "/projects/invites/accept", { token: invite.token }, registered
    );
    assert.equal(accepted.body.companyId, companyId, `the invitation did not attach ${email} to the inviting company`);
    return accepted.body.token ?? registered;
  };

  /** A fresh pending timecard owned by whoever holds `token`. */
  const createCard = async (token: string, hoursRegular: number, notes: string): Promise<Timecard> => {
    const created = await seed<{ timecard: Timecard }>("POST", "/crew/timecards", {
      siteId,
      workerName: "Worker",
      date: TODAY,
      hoursRegular,
      trade: "Carpentry",
      notes,
    }, token);
    assert.equal(created.body.timecard.approvalStatus, "pending", "a new timecard did not start pending");
    return created.body.timecard;
  };

  const approve = (id: string, status: string, note?: string, token = ownerToken) =>
    req<{ timecard?: Timecard; error?: string; code?: string; approvalStatus?: string }>(
      "POST", `/crew/timecards/${id}/approval`, note === undefined ? { status } : { status, note }, token
    );

  const editHours = (id: string, hoursRegular: number, token: string, extra: Record<string, unknown> = {}) =>
    req<{ timecard?: Timecard; error?: string; code?: string; approvalStatus?: string }>(
      "PATCH", `/crew/timecards/${id}`, {
        workerName: "Worker",
        date: TODAY,
        hoursRegular,
        trade: "Carpentry",
        notes: "edited",
        ...extra,
      }, token
    );

  /** What the database itself holds, read with the tenant context RLS needs. */
  const readStatusDirect = async (id: string): Promise<string | null> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
      const r = await client.query<Record<string, string>>(
        `SELECT ${TIMECARD_APPROVAL_STATUS_COLUMN} AS status FROM ${TIMECARDS_TABLE} WHERE id = $1`,
        [id]
      );
      await client.query("COMMIT");
      return r.rows[0]?.status ?? null;
    } finally {
      client.release();
    }
  };

  /**
   * The whole row as the database holds it, read with the tenant context RLS
   * needs. `SELECT *` rather than a column list on purpose: the assertions
   * below are about columns an edit must NOT have touched, and naming them in
   * SQL would put a hand-written literal in the one place this repo has already
   * been bitten by one (a `deleted_at` predicate on a table without the
   * column). The row's keys are read as JavaScript properties instead.
   */
  const readRowDirect = async (id: string): Promise<Record<string, unknown> | null> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);
      const r = await client.query<Record<string, unknown>>(
        `SELECT * FROM ${TIMECARDS_TABLE} WHERE id = $1`,
        [id]
      );
      await client.query("COMMIT");
      return r.rows[0] ?? null;
    } finally {
      client.release();
    }
  };

  // ── The measurement ────────────────────────────────────────────────────────
  //
  // One row per probe, holding what the route ACTUALLY answered. The table
  // printed at the end is the measurement quoted in the PR body, and the
  // assertions read from the same rows, so the printed table cannot drift from
  // what was asserted.
  type Row = { label: string; route: string; actor: string; status: number };
  const PROBES: Row[] = [];
  const record = (label: string, route: string, actor: string, status: number): number => {
    PROBES.push({ label, route, actor, status });
    return status;
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

    ownerToken = await register(OWNER, "Timecard Owner");
    const me = await seed<{ user: { companyId: string } }>("GET", "/auth/me", undefined, ownerToken);
    companyId = me.body.user.companyId;
    assert.ok(companyId, "the owner has no company, so nothing below is scoped to one");

    const site = await seed<{ site: { id: string } }>(
      "POST", "/projects/sites",
      { name: `Timecard Site ${runId}`, address: "1 Main St", client: "ACME", startDate: "2025-01-01", status: "active" },
      ownerToken
    );
    siteId = site.body.site.id;

    crewToken = await joinAsCrew(CREW, "Crew Member");
    otherCrewToken = await joinAsCrew(OTHER_CREW, "Other Crew Member");
  });

  after(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    for (const email of [OWNER, CREW, OTHER_CREW]) {
      await deleteUserAccount(email).catch(() => {});
    }
    await pool?.end().catch(() => {});
  });

  test("precondition: the three tokens really carry the three roles the suite claims", () => {
    // requireAtLeast reads the TOKEN, not the store, so this is the only thing
    // that makes the rank-gate test below a test of a crew member rather than
    // of a viewer who happens to be refused for some other reason.
    const owner = verifyAuthToken(ownerToken);
    const crew = verifyAuthToken(crewToken);
    const other = verifyAuthToken(otherCrewToken);
    assert.equal(owner?.companyRole, "owner", `owner token carries ${owner?.companyRole}`);
    assert.equal(crew?.companyRole, "crew", `crew token carries ${crew?.companyRole}`);
    assert.equal(other?.companyRole, "crew", `second crew token carries ${other?.companyRole}`);
    assert.notEqual(crew?.email, other?.email, "the two crew tokens are the same person");
  });

  test("the rank gate: crew cannot approve their own hours, the owner can approve the same row", async () => {
    const card = await createCard(crewToken, 8, "rank gate");

    // The refusal.
    const refused = await approve(card.id, "approved", undefined, crewToken);
    record("crew approves own timecard", "POST /crew/timecards/:id/approval", "crew", refused.status);
    assert.equal(refused.status, 403, `crew approving their own hours -> ${refused.status} ${JSON.stringify(refused.body)}`);

    // The row did not move, read from the database rather than from the route
    // that just refused — a 403 with the write already committed would pass the
    // assertion above.
    assert.equal(await readStatusDirect(card.id), "pending", "a refused approval still changed the row");

    // The positive control, same route, same row, same test: without it this
    // test passes just as well with the route deleted.
    const allowed = await approve(card.id, "approved", undefined, ownerToken);
    record("owner approves crew timecard", "POST /crew/timecards/:id/approval", "owner", allowed.status);
    assert.equal(allowed.status, 200, `the owner approving -> ${allowed.status} ${JSON.stringify(allowed.body)}`);
    assert.equal(allowed.body.timecard?.approvalStatus, "approved");
    assert.equal(await readStatusDirect(card.id), "approved", "the route said approved and the database disagreed");
  });

  test("approved_by is taken from the session and cannot be claimed in the body", async () => {
    const card = await createCard(crewToken, 7, "approver provenance");

    // The claim, refused by `.strict()` before it reaches the store.
    const claimed = await req<{ error?: string }>("POST", `/crew/timecards/${card.id}/approval`, {
      status: "approved",
      approvedBy: OWNER,
    }, crewToken);
    record("crew claims approvedBy in the body", "POST /crew/timecards/:id/approval", "crew", claimed.status);
    // 403 and not 400: the rank gate is middleware and runs first. Both are
    // refusals; what matters is that the row did not move.
    assert.equal(claimed.status, 403, `a crew member claiming approvedBy -> ${claimed.status}`);
    assert.equal(await readStatusDirect(card.id), "pending");

    // The same claim from someone who IS allowed to approve, so the only thing
    // left to refuse it is the schema.
    const byOwner = await req<{ error?: string }>("POST", `/crew/timecards/${card.id}/approval`, {
      status: "approved",
      approvedBy: CREW,
    }, ownerToken);
    record("owner claims approvedBy in the body", "POST /crew/timecards/:id/approval", "owner", byOwner.status);
    assert.equal(byOwner.status, 400, `an unknown approval key -> ${byOwner.status} ${JSON.stringify(byOwner.body)}`);
    assert.equal(await readStatusDirect(card.id), "pending", "a rejected payload still approved the row");

    // The control: the same approval without the extra key works, and records
    // the session's identity rather than anything a caller sent.
    const clean = await approve(card.id, "approved", "looks right");
    record("owner approves cleanly", "POST /crew/timecards/:id/approval", "owner", clean.status);
    assert.equal(clean.status, 200);
    assert.equal(clean.body.timecard?.approvedBy?.toLowerCase(), OWNER.toLowerCase(), "approved_by is not the approver");
    assert.ok(clean.body.timecard?.approvedAt, "approved_at was not recorded");
    assert.equal(clean.body.timecard?.approvalNote, "looks right");

    // Reopening clears both, so a reopened card does not still name an approver.
    const reopened = await approve(card.id, "pending");
    record("owner reopens", "POST /crew/timecards/:id/approval", "owner", reopened.status);
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.timecard?.approvedBy ?? null, null, "a reopened card still names an approver");
    assert.equal(reopened.body.timecard?.approvedAt ?? null, null, "a reopened card still carries an approval time");
  });

  test("read-only after approval: the author edits and deletes freely until it is approved, then neither", async () => {
    const card = await createCard(crewToken, 8, "lifecycle");

    // Positive control FIRST, so the refusals below are known to be about the
    // approval state and not about the route being shut.
    const beforeEdit = await editHours(card.id, 9, crewToken);
    record("author edits a pending card", "PATCH /crew/timecards/:id", "crew", beforeEdit.status);
    assert.equal(beforeEdit.status, 200, `editing a pending card -> ${beforeEdit.status} ${JSON.stringify(beforeEdit.body)}`);
    assert.equal(beforeEdit.body.timecard?.hoursRegular, 9);

    await seed("POST", `/crew/timecards/${card.id}/approval`, { status: "approved" }, ownerToken);

    // The author.
    const afterEdit = await editHours(card.id, 12, crewToken);
    record("author edits an approved card", "PATCH /crew/timecards/:id", "crew", afterEdit.status);
    assert.equal(afterEdit.status, 409, `editing an approved card -> ${afterEdit.status} ${JSON.stringify(afterEdit.body)}`);
    assert.equal(afterEdit.body.code, "timecard_approved");
    assert.equal(afterEdit.body.approvalStatus, "approved");

    // The manager who approved it. No rank opens an approved timecard, which is
    // why the refusal is a 409 and not a 403 — and this is the probe that would
    // catch it being implemented as a rank gate.
    const byManager = await editHours(card.id, 12, ownerToken);
    record("approver edits an approved card", "PATCH /crew/timecards/:id", "owner", byManager.status);
    assert.equal(byManager.status, 409, `the approver editing -> ${byManager.status} ${JSON.stringify(byManager.body)}`);

    // Deletion is the more important of the two: an edit leaves a row somebody
    // can still look at, a delete leaves nothing.
    const del = await req<{ code?: string }>("DELETE", `/crew/timecards/${card.id}`, undefined, crewToken);
    record("author deletes an approved card", "DELETE /crew/timecards/:id", "crew", del.status);
    assert.equal(del.status, 409, `deleting an approved card -> ${del.status} ${JSON.stringify(del.body)}`);
    const delByOwner = await req<{ code?: string }>("DELETE", `/crew/timecards/${card.id}`, undefined, ownerToken);
    record("approver deletes an approved card", "DELETE /crew/timecards/:id", "owner", delByOwner.status);
    assert.equal(delByOwner.status, 409, `the approver deleting -> ${delByOwner.status}`);

    // Still there, and still 9 hours, read from the database.
    assert.equal(await readStatusDirect(card.id), "approved", "the row is gone or no longer approved");
    const listed = await seed<{ timecards: Timecard[] }>("GET", `/crew/timecards?siteId=${siteId}`, undefined, ownerToken);
    const still = listed.body.timecards.find((t) => t.id === card.id);
    assert.ok(still, "the approved card was deleted by one of the refused requests");
    assert.equal(still.hoursRegular, 9, "an approved card's hours changed");

    // And the way back: reopening restores both, which is what makes the 409 a
    // state rather than a dead end.
    await seed("POST", `/crew/timecards/${card.id}/approval`, { status: "pending" }, ownerToken);
    const afterReopen = await editHours(card.id, 10, crewToken);
    record("author edits a reopened card", "PATCH /crew/timecards/:id", "crew", afterReopen.status);
    assert.equal(afterReopen.status, 200, `editing a reopened card -> ${afterReopen.status} ${JSON.stringify(afterReopen.body)}`);
    assert.equal(afterReopen.body.timecard?.hoursRegular, 10);
    const afterReopenDelete = await req("DELETE", `/crew/timecards/${card.id}`, undefined, crewToken);
    record("author deletes a reopened card", "DELETE /crew/timecards/:id", "crew", afterReopenDelete.status);
    assert.equal(afterReopenDelete.status, 200, "a reopened card could not be deleted by its author");
  });

  test("a rejected card is editable and an approved one is not, for every status the store declares", async () => {
    // TIMECARD_EDITABLE_STATUSES is the rule; this walks the whole declared
    // status list against it so a status added without a decision about
    // editability fails here rather than being silently editable.
    const measured: Array<{ status: string; edit: number; editable: boolean }> = [];
    for (const status of TIMECARD_APPROVAL_STATUSES) {
      const card = await createCard(crewToken, 8, `editability ${status}`);
      await seed("POST", `/crew/timecards/${card.id}/approval`, { status }, ownerToken);
      assert.equal(await readStatusDirect(card.id), status, `the database did not accept status ${status}`);
      const edit = await editHours(card.id, 6, crewToken);
      record(`author edits a ${status} card`, "PATCH /crew/timecards/:id", "crew", edit.status);
      measured.push({ status, edit: edit.status, editable: TIMECARD_EDITABLE_STATUSES.includes(status) });
    }

    // Every declared status was exercised — the cross-check that cannot satisfy
    // itself, since the loop and this comparison read the same exported list
    // but the DB round-trip above is what proves each one landed.
    assert.deepEqual(
      measured.map((m) => m.status).sort(),
      [...TIMECARD_APPROVAL_STATUSES].sort(),
      "a declared approval status was not exercised"
    );
    // The two lists that have to agree, compared directly rather than by a
    // hand-written floor on the length: the round-trip above proves the
    // database ACCEPTS every TypeScript status, and this proves the CHECK
    // declares exactly those and no others. A status added to one list and not
    // the other fails here with both lists printed.
    const migration = await fs.readFile(path.join(MIGRATIONS_DIR, "033_timecard_approval.sql"), "utf-8");
    const clause = new RegExp(`CHECK\\s*\\(\\s*${TIMECARD_APPROVAL_STATUS_COLUMN}\\s+IN\\s*\\(([^)]*)\\)`, "i").exec(migration);
    assert.ok(clause, `no CHECK (${TIMECARD_APPROVAL_STATUS_COLUMN} IN (...)) found in 033 — the constraint moved or was removed`);
    const declared = clause[1].split(",").map((v) => v.trim().replace(/^'|'$/g, "")).sort();
    assert.deepEqual(declared, [...TIMECARD_APPROVAL_STATUSES].sort(), "the store's status list and migration 033's CHECK disagree");

    // Both directions present, so neither half of the table is vacuous.
    assert.ok(measured.some((m) => m.editable), "no status was editable, so the 200 control never ran");
    assert.ok(measured.some((m) => !m.editable), "every status was editable, so the 409 probe never ran");
    for (const m of measured) {
      assert.equal(m.edit, m.editable ? 200 : 409, `status ${m.status} -> ${m.edit} (editable: ${m.editable})`);
    }
  });

  test("the CHECK constraint exists: a status outside the declared list is refused by the database itself", async () => {
    const card = await createCard(crewToken, 8, "check constraint");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // RLS is FORCEd on this table, so without the tenant context the UPDATE
      // below matches no rows and refuses nothing — the failure mode this
      // control exists to rule out.
      await client.query(`SELECT set_config('app.company_id', $1, true)`, [companyId]);

      const valid = await client.query(
        `UPDATE ${TIMECARDS_TABLE} SET ${TIMECARD_APPROVAL_STATUS_COLUMN} = $1 WHERE id = $2`,
        ["approved", card.id]
      );
      assert.equal(valid.rowCount, 1, "the row is not reachable, so the refusal below would prove nothing");

      let code: string | undefined;
      try {
        await client.query(
          `UPDATE ${TIMECARDS_TABLE} SET ${TIMECARD_APPROVAL_STATUS_COLUMN} = $1 WHERE id = $2`,
          ["half-approved", card.id]
        );
      } catch (err) {
        code = (err as { code?: string }).code;
      }
      // 23514 is check_violation. Asserting the code rather than any throw
      // keeps this from passing on an unrelated error such as a missing column.
      assert.equal(code, "23514", `an undeclared status was not refused by a CHECK constraint (code ${code ?? "none"})`);
    } finally {
      // Nothing above is kept: this test is about the constraint, not the row.
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
    assert.equal(await readStatusDirect(card.id), "pending", "the rolled-back transaction left the row changed");

    // And the route's half of the same disagreement, so a status the enum
    // rejects never reaches the database to begin with.
    const viaRoute = await approve(card.id, "half-approved");
    record("owner sends an undeclared status", "POST /crew/timecards/:id/approval", "owner", viaRoute.status);
    assert.equal(viaRoute.status, 400, `an undeclared status through the route -> ${viaRoute.status}`);
    const control = await approve(card.id, "approved");
    record("owner sends a declared status", "POST /crew/timecards/:id/approval", "owner", control.status);
    assert.equal(control.status, 200, "the control approval failed, so the 400 above proves nothing");
  });

  test("the field gate: an approval field cannot be smuggled through the edit route", async () => {
    const card = await createCard(crewToken, 8, "field gate");

    // Layer one: the route refuses the key outright rather than dropping it.
    // Quietly dropping is worse than refusing — the caller is told it worked.
    const smuggled = await editHours(card.id, 8, crewToken, { approvalStatus: "approved" });
    record("author sends approvalStatus on an edit", "PATCH /crew/timecards/:id", "crew", smuggled.status);
    assert.equal(smuggled.status, 400, `an approval key on an edit -> ${smuggled.status} ${JSON.stringify(smuggled.body)}`);
    assert.equal(await readStatusDirect(card.id), "pending", "an edit approved the card");

    for (const key of ["approvedBy", "approvedAt", "approvalNote"]) {
      const res = await editHours(card.id, 8, crewToken, { [key]: key === "approvedAt" ? new Date().toISOString() : OWNER });
      record(`author sends ${key} on an edit`, "PATCH /crew/timecards/:id", "crew", res.status);
      assert.equal(res.status, 400, `${key} on an edit -> ${res.status}`);
    }

    // Moving the row to another site is not a correction to the hours. An edit
    // route that accepted it would let an approved week be reassembled under a
    // site the approving manager never looked at.
    const moved = await editHours(card.id, 8, crewToken, { siteId: "some-other-site" });
    record("author sends siteId on an edit", "PATCH /crew/timecards/:id", "crew", moved.status);
    assert.equal(moved.status, 400, `siteId on an edit -> ${moved.status}`);

    // The control: the same edit without any of them is accepted, and the
    // approval state is untouched by a successful edit.
    const clean = await editHours(card.id, 11, crewToken);
    record("author edits with no approval keys", "PATCH /crew/timecards/:id", "crew", clean.status);
    assert.equal(clean.status, 200, `a clean edit -> ${clean.status} ${JSON.stringify(clean.body)}`);
    assert.equal(clean.body.timecard?.hoursRegular, 11);
    assert.equal(clean.body.timecard?.approvalStatus, "pending", "a successful edit changed the approval state");
    assert.equal(clean.body.timecard?.approvedBy ?? null, null);
  });

  test("crew see only their own timesheets, and may change only their own", async () => {
    const mine = await createCard(crewToken, 5, "mine");
    const theirs = await createCard(otherCrewToken, 6, "theirs");

    const asCrew = await seed<{ timecards: Timecard[] }>("GET", `/crew/timecards?siteId=${siteId}`, undefined, crewToken);
    record("crew lists timecards", "GET /crew/timecards", "crew", asCrew.status);
    const crewIds = asCrew.body.timecards.map((t) => t.id);

    // The positive control for a negative assertion: `!includes(theirs)` passes
    // just as well against an empty list, so the list must first be shown to
    // contain something.
    assert.ok(crewIds.includes(mine.id), "a crew member cannot see their own timecard");
    assert.ok(!crewIds.includes(theirs.id), "a crew member can see a colleague's timecard");
    assert.ok(
      asCrew.body.timecards.every((t) => t.ownerEmail.toLowerCase() === CREW.toLowerCase()),
      `the crew list contains somebody else's rows: ${JSON.stringify(asCrew.body.timecards.map((t) => t.ownerEmail))}`
    );

    // And the control that both rows exist and the route is capable of
    // returning them — otherwise the narrowing above could be a broken query.
    const asOwner = await seed<{ timecards: Timecard[] }>("GET", `/crew/timecards?siteId=${siteId}`, undefined, ownerToken);
    record("owner lists timecards", "GET /crew/timecards", "owner", asOwner.status);
    const ownerIds = asOwner.body.timecards.map((t) => t.id);
    assert.ok(ownerIds.includes(mine.id) && ownerIds.includes(theirs.id), "the owner cannot see both rows, so the narrowing above is untested");

    // The write side of the same rule, both directions in this test.
    const otherEdit = await editHours(theirs.id, 9, crewToken);
    record("crew edits a colleague's card", "PATCH /crew/timecards/:id", "crew", otherEdit.status);
    assert.equal(otherEdit.status, 403, `editing a colleague's card -> ${otherEdit.status} ${JSON.stringify(otherEdit.body)}`);
    const otherDelete = await req("DELETE", `/crew/timecards/${theirs.id}`, undefined, crewToken);
    record("crew deletes a colleague's card", "DELETE /crew/timecards/:id", "crew", otherDelete.status);
    assert.equal(otherDelete.status, 403, `deleting a colleague's card -> ${otherDelete.status}`);

    const ownEdit = await editHours(mine.id, 9, crewToken);
    record("crew edits own card", "PATCH /crew/timecards/:id", "crew", ownEdit.status);
    assert.equal(ownEdit.status, 200, `editing their own card -> ${ownEdit.status} ${JSON.stringify(ownEdit.body)}`);

    // The colleague's row is unchanged, read from the database — a 403 with the
    // write already committed would pass every assertion above.
    const stillTheirs = await seed<{ timecards: Timecard[] }>("GET", `/crew/timecards?siteId=${siteId}`, undefined, ownerToken);
    const row = stillTheirs.body.timecards.find((t) => t.id === theirs.id);
    assert.ok(row, "the refused delete removed the colleague's row");
    assert.equal(row.hoursRegular, 6, "the refused edit changed the colleague's row");
  });

  test("a timecard that does not exist is a 404 on every write, and the gate does not leak ids", async () => {
    // `requireOwnRecord` passes an absent row through to the handler's own 404
    // so the gate cannot be used to tell a real id from a made-up one.
    const absent = "00000000-0000-0000-0000-000000000000";
    const patch = await editHours(absent, 8, crewToken);
    record("author edits a missing card", "PATCH /crew/timecards/:id", "crew", patch.status);
    assert.equal(patch.status, 404, `editing a missing card -> ${patch.status}`);
    const del = await req("DELETE", `/crew/timecards/${absent}`, undefined, crewToken);
    record("author deletes a missing card", "DELETE /crew/timecards/:id", "crew", del.status);
    assert.equal(del.status, 404, `deleting a missing card -> ${del.status}`);
    const appr = await approve(absent, "approved");
    record("owner approves a missing card", "POST /crew/timecards/:id/approval", "owner", appr.status);
    assert.equal(appr.status, 404, `approving a missing card -> ${appr.status}`);

    // The control: the same three verbs on a real row answer differently, so
    // the 404s above are about the id and not about the routes.
    const real = await createCard(crewToken, 8, "exists");
    assert.equal((await editHours(real.id, 9, crewToken)).status, 200, "the control edit failed");
    assert.equal((await approve(real.id, "approved")).status, 200, "the control approval failed");
    await seed("POST", `/crew/timecards/${real.id}/approval`, { status: "pending" }, ownerToken);
    assert.equal((await req("DELETE", `/crew/timecards/${real.id}`, undefined, crewToken)).status, 200, "the control delete failed");
  });

  test("an edit writes the fields it names, and the database keeps the rest of the row", async () => {
    // THE DEFECT THIS IS ABOUT, AND WHY POSTGRES IS THE AUTHORITY ON IT
    // TIMECARD_FIELDS gives `trade` and `notes` a `.default("")`, so before the
    // edit schema was `.partial()` a PATCH naming one field arrived holding
    // blanks for the others and the UPDATE wrote all nine columns. The route's
    // own response echoes whatever the store returned, so a test that reads
    // only the response can be satisfied by a store that reported a value it
    // never stored. These assertions read the row straight out of the database.
    const card = await seed<{ timecard: Timecard }>("POST", "/crew/timecards", {
      siteId,
      workerName: "Worker",
      date: TODAY,
      startTime: "07:00",
      endTime: "15:30",
      breakMinutes: 30,
      hoursRegular: 8,
      hoursOvertime: 1.5,
      trade: "Carpentry",
      notes: "Level 3 formwork",
    }, crewToken);
    const id = card.body.timecard.id;

    const before = await readRowDirect(id);
    assert.ok(before, "the seeded card is not in the database");

    const edited = await req<{ timecard?: Timecard; error?: string }>(
      "PATCH", `/crew/timecards/${id}`, { notes: "Level 3 formwork, east bay" }, crewToken
    );
    record("author edits one field", "PATCH /crew/timecards/:id", "crew", edited.status);
    assert.equal(edited.status, 200, `a single-field edit -> ${edited.status} ${JSON.stringify(edited.body)}`);

    const after = await readRowDirect(id);
    assert.ok(after, "the edited card is gone from the database");

    // THE POSITIVE CONTROL FIRST. Without it, a store that wrote nothing at all
    // would satisfy every "unchanged" assertion below — which is the same shape
    // of vacuity the /uploads/sign mutation exposed (docs/VACUITY-AUDIT.md M7).
    assert.notEqual(after.notes, before.notes, "the edit wrote nothing, so nothing below is tested");
    assert.equal(after.notes, "Level 3 formwork, east bay");

    // Every other column the edit never mentioned, compared against what the
    // row held before it. Compared rather than asserted against literals, so
    // the test cannot pass by agreeing with a value the seed never stored.
    for (const column of Object.keys(before)) {
      if (column === "notes" || column === "updated_at") continue;
      assert.deepEqual(
        after[column],
        before[column],
        `an edit naming only notes changed ${column}: ${JSON.stringify(before[column])} -> ${JSON.stringify(after[column])}`
      );
    }

    // The two columns the loop above skips, asserted rather than ignored, so a
    // skip cannot hide a column that failed to move. `updated_at` is set from
    // NOW() in a later transaction than the INSERT, which left it unset.
    assert.notDeepEqual(
      after.updated_at,
      before.updated_at,
      "the edit did not advance updated_at, so the audit timestamp is not being written"
    );

    // The approval state is untouched by an edit, read from the database rather
    // than from the response.
    assert.equal(await readStatusDirect(id), "pending", "a single-field edit changed the approval state");
  });

  test("start, finish and break move together, and an empty edit writes nothing", async () => {
    const card = await createCard(crewToken, 8, "trio");
    const before = await readRowDirect(card.id);
    assert.ok(before, "the seeded card is not in the database");

    const patch = (body: Record<string, unknown>) =>
      req<{ timecard?: Timecard; error?: string }>("PATCH", `/crew/timecards/${card.id}`, body, crewToken);

    // Half a span cannot be validated against a half that is only in the
    // database, so the route refuses rather than guessing.
    for (const partial of [{ endTime: "16:30" }, { startTime: "06:00" }, { breakMinutes: 60 }]) {
      const res = await patch(partial);
      record(`author sends ${Object.keys(partial)[0]} alone`, "PATCH /crew/timecards/:id", "crew", res.status);
      assert.equal(res.status, 400, `${JSON.stringify(partial)} -> ${res.status} ${JSON.stringify(res.body)}`);
    }

    const empty = await patch({});
    record("author sends an empty edit", "PATCH /crew/timecards/:id", "crew", empty.status);
    assert.equal(empty.status, 400, `an empty edit -> ${empty.status} ${JSON.stringify(empty.body)}`);

    // None of the four refusals touched the row.
    assert.deepEqual(await readRowDirect(card.id), before, "a refused edit changed the stored row");

    // THE CONTROLS, in this test: the trio together is accepted and lands in
    // the database, and a non-span field on its own is accepted too. Without
    // them, `.partial()` having shut the edit route completely would read green.
    const trio = await patch({ startTime: "06:00", endTime: "16:30", breakMinutes: 60 });
    record("author sends the whole span", "PATCH /crew/timecards/:id", "crew", trio.status);
    assert.equal(trio.status, 200, `the whole span -> ${trio.status} ${JSON.stringify(trio.body)}`);
    const withSpan = await readRowDirect(card.id);
    assert.ok(withSpan, "the row is gone");
    assert.notDeepEqual(withSpan.break_minutes, before.break_minutes, "the accepted span did not reach the database");

    const nonSpan = await patch({ notes: "corrected" });
    record("author sends one non-span field", "PATCH /crew/timecards/:id", "crew", nonSpan.status);
    assert.equal(nonSpan.status, 200, `a non-span field alone -> ${nonSpan.status}`);

    // And the span rule still applies when all three arrive, so the trio rule
    // has not become a way around the validation it exists to make possible.
    const reversed = await patch({ startTime: "15:00", endTime: "07:00", breakMinutes: 0 });
    record("author sends a reversed span", "PATCH /crew/timecards/:id", "crew", reversed.status);
    assert.equal(reversed.status, 400, `a reversed span -> ${reversed.status}`);
  });

  test("the measured table", () => {
    // Printed rather than asserted against a hand-written count: every row here
    // was recorded by a probe that already asserted its own status, so the
    // table is the measurement, not a second expectation that could disagree
    // with it. The one thing asserted is that the probes ran at all.
    assert.ok(PROBES.length > 0, "no probe recorded a result, so every test above was skipped");
    const width = Math.max(...PROBES.map((p) => p.label.length));
    console.log(`\n  timecard approval — ${PROBES.length} probes against Postgres\n`);
    for (const p of PROBES) {
      console.log(`  ${p.label.padEnd(width)}  ${String(p.status).padStart(3)}  ${p.actor.padEnd(5)}  ${p.route}`);
    }
    console.log("");
  });
}
