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
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import type { Actor } from "./actor";

if (!process.env.TEST_DATABASE_URL) {
  test("store round-trip (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // Route the stores' useDatabase() to the DB path. getPgPool() ignores this and
  // binds to TEST_DATABASE_URL under NODE_ENV=test, so both point at the test DB.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

  const MIGRATIONS_DIR = path.join(process.cwd(), "src", "storage", "migrations");

  const applyMigrations = async (pool: Pool): Promise<void> => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
    );
    const done = new Set(
      (await pool.query<{ version: string }>(`SELECT version FROM schema_migrations`)).rows.map((r) => r.version)
    );
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
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
