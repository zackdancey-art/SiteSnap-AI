/**
 * DB ROUND-TRIP tests — the guard against schema-vs-store column drift.
 *
 * This is the class-killer for the family of bugs where a store's INSERT/SELECT
 * names a column the schema doesn't have (crew_timecards start_time/end_time/
 * break_minutes; the incident data-loss bug; H6 company_id). Each test drives the
 * store's REAL create function — the actual full-column INSERT, not a hand-written
 * subset like the Neon smoke used — against a real Postgres, then reads the row
 * back and asserts the distinctive field values survived. A missing column makes
 * the INSERT throw and the test fail; a dropped column makes the read-back assert
 * fail. Either way it fails CI instead of 500ing silently in prod.
 *
 * Why the ordinary suite can't catch this: stores gate their DB path on
 * useDatabase() (DATABASE_URL), which the in-memory suite leaves unset, so every
 * createX() runs in memory and never emits SQL. Here we point DATABASE_URL at the
 * test database so useDatabase() is true and the real INSERT runs; getPgPool()
 * still binds to TEST_DATABASE_URL under NODE_ENV=test.
 *
 * Schema is built the way prod boots — migrations (read from src/, because the
 * test build does not copy .sql into dist/) THEN the inline initAuthSchema /
 * initProjectSchema — so the check is against BOTH schema sources and cannot
 * reproduce a single-source false positive (e.g. project_diaries' *_json columns,
 * which live only in the inline schema).
 *
 * Gated: needs a real, disposable Postgres via TEST_DATABASE_URL. Without it, one
 * skipped placeholder test is registered and no connection is attempted.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { Pool } from "pg";
import type { Actor } from "./actor";
import { applyMigrations } from "./testMigrations";

if (!process.env.TEST_DATABASE_URL) {
  test("store round-trip (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // Route the stores' useDatabase() to the DB path. getPgPool() ignores this and
  // binds to TEST_DATABASE_URL under NODE_ENV=test, so both point at the test DB.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;



  const CO = "rt-company";
  const OWNER = "rt-owner@test.local";
  const actor: Actor = { email: OWNER, role: "admin", companyId: CO, companyRole: "owner" };
  let pool: Pool;
  let siteId = "";

  // store functions (imported after the env is pointed at the DB)
  let S: typeof import("./projectsStore");
  let C: typeof import("./crewStore");
  let D: typeof import("./deliveriesStore");
  let I: typeof import("./inspectionStore");
  let G: typeof import("./signatureStore");

  before(async () => {
    const { getPgPool } = await import("./postgres");
    pool = getPgPool();
    await applyMigrations(pool);
    const { initAuthSchema } = await import("./authStore");
    S = await import("./projectsStore");
    C = await import("./crewStore");
    D = await import("./deliveriesStore");
    I = await import("./inspectionStore");
    G = await import("./signatureStore");
    await initAuthSchema();
    await S.initProjectSchema();

    // Seed the owner auth_users row (FK target for owner_email on every table).
    await pool.query(
      `INSERT INTO auth_users (email, password_hash, full_name, phone, role, company_id, company_role)
       VALUES ($1,'x','RT Owner',$2,'admin',$3,'owner')
       ON CONFLICT (email) DO NOTHING`,
      [OWNER, "+64" + Date.now().toString().slice(-9), CO]
    );

    // A site is the FK parent for entries/diaries/timecards/deliveries/inspections.
    const site = await S.createSite(actor, {
      name: "RT Site", address: "1 Test Rd", client: "RT Client", startDate: "2026-01-01", status: "active",
    } as Parameters<typeof S.createSite>[1]);
    siteId = site.id;
  });

  after(async () => {
    if (pool) await pool.end();
  });

  test("project_sites: createSite round-trips", async () => {
    const sites = await S.listSites(actor);
    const row = sites.find((s) => s.id === siteId);
    assert.ok(row, "created site not read back");
    assert.equal(row!.name, "RT Site");
    assert.equal(row!.client, "RT Client");
  });

  test("project_entries: full-column createEntry round-trips (incl. hazardNotes/toolboxTalk/swmsRef)", async () => {
    const entry = await S.createEntry(actor, {
      siteId, date: "2026-02-02", locationAddress: "Zone A", weather: "Fine", crewCount: "5",
      notes: "poured slab", photos: [], swmsRef: "SWMS-9", hazardNotes: "trench barriered", toolboxTalk: true,
    } as Parameters<typeof S.createEntry>[1]);
    // createEntry refuses a binned or out-of-company site with null; this seed
    // uses the live site created above, so a null here is a broken fixture
    // rather than the guard, and must not read as a passing round trip.
    assert.ok(entry, "createEntry refused the round-trip fixture's own live site");
    const rows = await S.listEntries(actor, siteId);
    const row = rows.find((e) => e.id === entry.id);
    assert.ok(row, "created entry not read back");
    assert.equal(row!.swmsRef, "SWMS-9");
    assert.equal(row!.hazardNotes, "trench barriered");
    assert.equal(row!.toolboxTalk, true);
  });

  test("project_diaries: full-column createDiary round-trips (safetyChecklist/sections via *_json)", async () => {
    const diary = await S.createDiary(actor, {
      siteId, status: "draft", summary: "day summary", reportPeriod: "daily", fullReport: "full",
      safetyChecklist: ["PPE checked"], sections: [{ date: "2026-02-02", workCompleted: "slab" }],
    } as Parameters<typeof S.createDiary>[1]);
    const rows = await S.listDiaries(actor, siteId);
    const row = rows.find((d) => d.id === diary.id);
    assert.ok(row, "created diary not read back");
    assert.deepEqual(row!.safetyChecklist, ["PPE checked"]);
    assert.equal(Array.isArray(row!.sections) && row!.sections.length, 1);
  });

  test("crew_timecards: full-column createTimecard round-trips (start_time/end_time/break_minutes — the drift bug)", async () => {
    const tc = await C.createTimecard(actor, {
      siteId, entryId: null, workerName: "Ada", date: "2026-02-02",
      startTime: "07:00", endTime: "15:30", breakMinutes: 30,
      hoursRegular: 8, hoursOvertime: 0.5, trade: "carpenter", notes: "n/a",
    } as Parameters<typeof C.createTimecard>[1]);
    const rows = await C.listTimecards(actor, siteId);
    const row = rows.find((t) => t.id === tc.id);
    assert.ok(row, "created timecard not read back");
    // These three assertions fail before migration 026 (INSERT throws on missing columns).
    assert.equal(row!.startTime, "07:00");
    assert.equal(row!.endTime, "15:30");
    assert.equal(row!.breakMinutes, 30);

    // Migration 033's four columns. The create path deliberately does NOT name
    // approval_status in its INSERT — the DEFAULT supplies it and RETURNING *
    // reads it back, so the default lives in one place — which means this
    // assertion is the only thing that would notice the column missing or the
    // default being dropped. The other three must read back as NULL: a new
    // timecard has not been reviewed, and a non-NULL approver on a pending row
    // would be a record of a decision nobody made.
    assert.equal(row!.approvalStatus, "pending", "a new timecard did not read back pending");
    assert.equal(row!.approvedBy ?? null, null);
    assert.equal(row!.approvedAt ?? null, null);
    assert.equal(row!.approvalNote ?? null, null);
  });

  test("crew_timecards: setTimecardApproval and updateTimecard round-trip the approval columns", async () => {
    // The write paths migration 033's columns exist for, driven against the
    // real schema. A column named by the UPDATE but absent from the table makes
    // the statement throw; a column present but never read back makes the
    // assertion fail. The in-memory mirror in routes/crew.test.ts proves the
    // state machine, and proves nothing about the SQL.
    const tc = await C.createTimecard(actor, {
      siteId, entryId: null, workerName: "Grace", date: "2026-02-03",
      startTime: "08:00", endTime: "16:00", breakMinutes: 0,
      hoursRegular: 8, hoursOvertime: 0, trade: "sparky", notes: "",
    } as Parameters<typeof C.createTimecard>[1]);

    const approved = await C.setTimecardApproval(actor, tc.id, "approved", "signed off");
    assert.ok(approved.ok, `approval write failed: ${JSON.stringify(approved)}`);
    assert.equal(approved.timecard.approvalStatus, "approved");
    assert.equal(approved.timecard.approvedBy, actor.email, "approved_by is not the actor");
    assert.ok(approved.timecard.approvedAt, "approved_at was not written");
    assert.equal(approved.timecard.approvalNote, "signed off");

    // Read back through the list query rather than the write's RETURNING, so a
    // value that was computed but never committed fails here.
    const afterApproval = (await C.listTimecards(actor, siteId)).find((t) => t.id === tc.id);
    assert.equal(afterApproval?.approvalStatus, "approved", "the approval did not persist");
    assert.equal(afterApproval?.approvalNote, "signed off");

    // The lock, in the store that production uses. The route's 409 is built on
    // this return value and nothing else.
    const blocked = await C.updateTimecard(actor, tc.id, {
      workerName: "Grace", date: "2026-02-03", hoursRegular: 12, hoursOvertime: 0,
      breakMinutes: 0, trade: "sparky", notes: "",
    });
    assert.equal(blocked.ok, false, "an approved timecard was editable");
    assert.equal(blocked.ok === false ? blocked.reason : null, "locked");

    // Reopening clears the reviewer and restores the edit — both directions in
    // one test, so neither half is vacuous.
    const reopened = await C.setTimecardApproval(actor, tc.id, "pending");
    assert.ok(reopened.ok, `reopen failed: ${JSON.stringify(reopened)}`);
    assert.equal(reopened.timecard.approvedBy ?? null, null, "a reopened timecard still names an approver");
    assert.equal(reopened.timecard.approvedAt ?? null, null);

    const allowed = await C.updateTimecard(actor, tc.id, {
      workerName: "Grace", date: "2026-02-03", hoursRegular: 10, hoursOvertime: 0,
      breakMinutes: 0, trade: "sparky", notes: "corrected",
    });
    assert.ok(allowed.ok, `editing a reopened timecard failed: ${JSON.stringify(allowed)}`);
    assert.equal(allowed.timecard.hoursRegular, 10);
    assert.equal(allowed.timecard.notes, "corrected");
    assert.equal(allowed.timecard.approvalStatus, "pending", "an edit changed the approval state");
  });

  test("material_deliveries: full-column createDelivery round-trips", async () => {
    const del = await D.createDelivery(actor, {
      siteId, date: "2026-02-02", supplier: "ACME", items: ["rebar", "mesh"], quantity: "2t", notes: "gate B",
    } as Parameters<typeof D.createDelivery>[1]);
    const rows = await D.listDeliveries(actor, siteId);
    const row = rows.find((d) => d.id === del.id);
    assert.ok(row, "created delivery not read back");
    assert.equal(row!.supplier, "ACME");
    assert.deepEqual(row!.items, ["rebar", "mesh"]);
  });

  test("inspections + inspection_signatures: full-column create round-trips (+ signature reads ACTIVE)", async () => {
    const insp = await I.createInspection(actor, {
      siteId, templateId: null, name: "RT Inspection", date: "2026-02-02", results: [], status: "pending",
      scope: "slab", areaInspected: "Zone A", time: "09:00", inspectorName: "Ada", inspectorRole: "engineer",
      inspectorCompany: "RT", defects: [], overallOutcome: "pass", followUpRequired: false,
    } as Parameters<typeof I.createInspection>[1]);
    const inspRows = await I.listInspections(actor, siteId);
    assert.ok(inspRows.find((x) => x.id === insp.id), "created inspection not read back");

    const sig = await G.createSignature(actor, {
      inspectionId: insp.id, role: "inspector", signerName: "Ada", path: "M0 0 L1 1", viewBox: "0 0 1 1",
      contentHash: "rt-hash", snapshot: {},
    });
    const sigs = await G.listSignatures(actor, insp.id);
    const row = sigs.find((s) => s.id === sig.id);
    assert.ok(row, "created signature not read back");
    assert.equal(row!.status, "active");
  });

  /**
   * ───────────────────────────────────────────────────────────────────────────
   * getPortfolioCounts — AUDIT L98. The one thing the in-memory suite cannot
   * prove, because the defect is the SQL `LIMIT`.
   *
   * `/projects/summary` and the portal dashboard both reported totals by
   * loading a list and measuring it, through calls that pass no limit and so
   * take `listSites`/`listEntries`/`listDiaries`' default `limit = 200`. The
   * number came back plausible and wrong, and nothing reported it.
   *
   * WHY THIS LIVES HERE rather than in a new DB-gated suite: `applyMigrations`
   * is currently copied into all eleven DB suites, and workstream 8 hoists
   * those eleven into one shared helper. A twelfth copy would leave that hoist
   * silently incomplete and its pinned count of eleven wrong, so this uses the
   * migrated pool this file already stands up.
   *
   * WHY A FRESH COMPANY PER RUN: every other test in this file uses the fixed
   * `rt-company` with `ON CONFLICT DO NOTHING`, so rows accumulate across runs
   * against a persistent `TEST_DATABASE_URL`. An absolute count assertion on a
   * shared company would pass once and then drift. These two companies are
   * unique per run, so `201` and `3` are exact rather than lower bounds.
   * ───────────────────────────────────────────────────────────────────────────
   */
  const ABOVE_THE_LIST_CAP = 201; // the default is 200; this must exceed it

  const seedCompany = async (tag: string, entryCount: number) => {
    const companyId = `pc-${tag}-${Date.now()}`;
    const email = `${companyId}@test.local`;
    const who: Actor = { email, role: "admin", companyId, companyRole: "owner" };
    await pool.query(
      `INSERT INTO auth_users (email, password_hash, full_name, phone, role, company_id, company_role)
       VALUES ($1,'x','PC Owner',$2,'admin',$3,'owner')
       ON CONFLICT (email) DO NOTHING`,
      [email, "+65" + String(Date.now()).slice(-9), companyId]
    );
    const site = await S.createSite(who, {
      name: `PC Site ${tag}`, address: "2 Count Rd", client: "PC Client",
      startDate: "2026-01-01", status: "active",
    } as Parameters<typeof S.createSite>[1]);
    for (let i = 0; i < entryCount; i += 1) {
      await S.createEntry(who, {
        siteId: site.id, date: "2026-03-03", locationAddress: "Zone C", weather: "Fine",
        crewCount: "2", notes: `count probe ${i}`, photos: [],
      } as Parameters<typeof S.createEntry>[1]);
    }
    return { who, siteId: site.id, companyId };
  };

  test("getPortfolioCounts counts past the list's limit, and stays inside the company", async () => {
    const a = await seedCompany("a", ABOVE_THE_LIST_CAP);
    const b = await seedCompany("b", 3);

    // The control that makes the assertion below mean something: the list
    // really is capped, so a count that agrees with the list would be the bug.
    // If someone "fixes" L98 by raising the limit instead of counting in SQL,
    // this line fails and says so.
    const listed = await S.listEntries(a.who);
    assert.equal(listed.length, 200, "listEntries' default cap is no longer 200 — L98's premise changed");

    const countsA = await S.getPortfolioCounts(a.who);
    assert.equal(
      countsA.entries, ABOVE_THE_LIST_CAP,
      `portfolio count ${countsA.entries} — a count that stops at the list's limit is the L98 defect`
    );

    // Tenant isolation, both directions, same endpoint. A negative alone would
    // pass equally well against a function that counts nothing at all.
    const countsB = await S.getPortfolioCounts(b.who);
    assert.equal(countsB.entries, 3, "B must count its OWN rows (positive control)");
    assert.notEqual(countsB.entries, ABOVE_THE_LIST_CAP + 3, "B must not count A's rows");
    assert.equal(countsA.entries, ABOVE_THE_LIST_CAP, "A must not count B's rows");

    // One site each, created active, so the status breakdown is checkable
    // against a known shape rather than against itself.
    assert.equal(countsA.sites, 1);
    assert.equal(countsA.activeSites, 1);
    assert.equal(countsA.completedSites, 0);
    assert.equal(countsA.onHoldSites, 0);
  });

  test("getPortfolioCounts' diary breakdown splits approved from draft", async () => {
    const c = await seedCompany("c", 0);
    for (const status of ["approved", "approved", "draft"] as const) {
      await S.createDiary(c.who, {
        siteId: c.siteId, status, summary: "s", reportPeriod: "daily", fullReport: "f",
        safetyChecklist: [], sections: [],
      } as Parameters<typeof S.createDiary>[1]);
    }
    const counts = await S.getPortfolioCounts(c.who);
    assert.equal(counts.diaries, 3);
    assert.equal(counts.approvedDiaries, 2);
    assert.equal(counts.draftDiaries, 1, "draft is derived by subtraction — DiaryStatus is a closed two-value union");
    assert.equal(counts.entries, 0, "a company with no entries counts zero, not the other companies' rows");
  });

  test("auth_users.settings: personal settings round-trip + partial JSONB merge (migration 028)", async () => {
    const { getUserSettings, updateUserSettings } = await import("./authStore");
    assert.deepEqual(await getUserSettings(OWNER), {}, "no settings before any write");

    await updateUserSettings(OWNER, {
      notifs: { weeklyDigest: false, pushEnabled: true },
      display: { dateFormat: "yyyy-mm-dd" },
      export: { defaultFormat: "csv" },
    });
    let s = await getUserSettings(OWNER) as Record<string, Record<string, unknown>>;
    assert.equal(s.notifs.weeklyDigest, false);
    assert.equal(s.notifs.pushEnabled, true);
    assert.equal(s.display.dateFormat, "yyyy-mm-dd");
    assert.equal(s.export.defaultFormat, "csv");

    // Patch one field of a group; the group's other fields survive the JSONB write.
    await updateUserSettings(OWNER, { notifs: { approvalAlerts: false } });
    s = await getUserSettings(OWNER) as Record<string, Record<string, unknown>>;
    assert.equal(s.notifs.weeklyDigest, false, "preserved across partial patch");
    assert.equal(s.notifs.approvalAlerts, false, "updated");
    assert.equal(s.display.dateFormat, "yyyy-mm-dd", "other groups preserved");
  });
}
