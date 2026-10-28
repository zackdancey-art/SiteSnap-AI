/**
 * Postgres proof for what the generated report CONTAINS — AUDIT L96 and L97.
 *
 * Both findings are the same shape: a field the capture form collects, the API
 * persists and `mapEntry` reads back was simply absent from the object that
 * `routes/ai.ts` built for the report. Nothing failed, no test went red, and
 * the document just did not contain it. The pure rendering of those fields is
 * proven in `utils/reportPayload.test.ts` and the HTTP contract on the
 * client-entries branch in `routes/report-payload.test.ts`. Three things are
 * left that only the database can answer, and they are the three below.
 *
 * 1. WHICH COMPANY'S MEMBERS CAN SUPPLY A NAME. L96's fix attributes each day
 *    to a person, and the only acceptable source for that is the row's own
 *    `owner_email` resolved against `listCompanyMembers(actor.companyId)`.
 *    `listCompanyMembers` is a raw `WHERE company_id = $1` on `auth_users` —
 *    NOT a `withTenant` call, so there is no RLS policy behind it, and the
 *    predicate in that one query is the whole of the isolation. The in-memory
 *    store filters a Map by the same field and would agree no matter what the
 *    SQL said. AUDIT L65 is the standing reason that is not evidence.
 *
 * 2. A MISFILED ROW MUST NAME NOBODY. An entry whose `owner_email` belongs to
 *    another company's member is a row the tenant-misfiling work has already
 *    shown exists in production. Attribution must come back empty for it. The
 *    failure to avoid is not a crash — it is a compliance document confidently
 *    naming the wrong person, which no status code would ever catch.
 *
 * 3. THE COLUMN CANNOT HOLD "NEVER ANSWERED". `toolbox_talk` is
 *    `BOOLEAN NOT NULL DEFAULT false` (migration 006). That is the measured
 *    fact `toolboxTalkFromStoredRow` exists for, and a fact about the live
 *    schema is exactly what a static read of the source cannot establish. The
 *    day the column becomes nullable, test 4 goes red and tells whoever did it
 *    that the suppression in `reportPayload.ts` is now the wrong behaviour.
 *
 * BOTH CONTROLS, ON THE SAME CALL, IN THE SAME TEST. "Company A cannot name
 * B's member" passes just as well when the index is empty and nothing resolves
 * at all, so every exclusion below is paired with a resolution through the same
 * index, and every "renders nothing" with a "renders something" from the same
 * read. Deleting the predicate and deleting the feature must not look alike.
 *
 * RED ON REVERT. Change `listCompanyMembers`' predicate to drop the company
 * clause and tests 1 and 2 go red together — A starts naming B's member.
 * Replace `resolveAuthorName`'s lookup with the email itself and test 1 goes
 * red on the `/@/` assertion. Remove the `DATABASE_URL` assignment in `before`
 * and tests 1 and 2 go red together with `undefined` in place of both names,
 * because `authStore` then answers from an empty in-memory map instead of from
 * Postgres — see the comment on that line, and AUDIT L109. Forward
 * `entry.toolboxTalk` in place of `toolboxTalkFromStoredRow` and test 4 goes
 * red on the default row.
 *
 * Guarded like the other DB suites: without `TEST_DATABASE_URL` it registers
 * one skipped placeholder and touches no database.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "report-payload-db-test-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import type { Pool } from "pg";
import { getPgPool } from "./postgres";
import { withTenant } from "./tenant";
import { Actor } from "./actor";
import { createEntry, listEntries, PROJECT_ENTRIES_TABLE } from "./projectsStore";
import { listCompanyMembers } from "./authStore";
import {
  buildAuthorNameIndex,
  effectiveEntryNotes,
  renderSafetyRecord,
  resolveAuthorName,
  toolboxTalkFromStoredRow,
} from "../utils/reportPayload";

if (!process.env.TEST_DATABASE_URL) {
  test("report payload completeness (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // Same minimal migration runner as the other DB suites.
  const MIGRATIONS_DIR = path.join(process.cwd(), "src", "storage", "migrations");

  const applyMigrations = async (pool: Pool): Promise<void> => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const appliedResult = await pool.query<{ version: string }>(`SELECT version FROM schema_migrations`);
    const applied = new Set(appliedResult.rows.map((r) => r.version));
    const files = (await fs.readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
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

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const companyA = `pay-company-a-${runId}`;
  const companyB = `pay-company-b-${runId}`;
  const danaEmail = `pay-dana-${runId}@test.local`;
  const priyaEmail = `pay-priya-${runId}@test.local`;
  const brunoEmail = `pay-bruno-${runId}@test.local`;
  const siteA = `pay-site-a-${runId}`;

  // Names chosen to be distinguishable from each other and from any email
  // local-part above, so an assertion that "the report says Dana Okafor"
  // cannot be satisfied by the address leaking through.
  const DANA = "Dana Okafor";
  const PRIYA = "Priya Raman";
  const BRUNO = "Bruno Vitale";

  // Non-empty by construction: we are inside the `else` of the
  // TEST_DATABASE_URL gate above. `?? ""` is for the type, not the value.
  const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? "";

  let pool: Pool;
  let previousDatabaseUrl: string | undefined;
  let dana: Actor;
  let priya: Actor;
  // No actor for company B. The only thing B contributes is a member row with a
  // name in it, which is what makes "A cannot name him" a real exclusion rather
  // than a lookup against an empty table; B writes nothing.

  const baseEntry = (date: string) => ({
    siteId: siteA,
    date,
    locationAddress: "4 Payload Parade",
    weather: "Fine",
    crewCount: "3",
    notes: "",
    photos: [],
  });

  before(async () => {
    // WHY THIS FILE SETS `DATABASE_URL`, AND WHY DOING SO CANNOT REACH
    // PRODUCTION.
    //
    // Test 1 and test 2 both resolve a name through `listCompanyMembers`, and
    // on the first Postgres run of this suite both came back `undefined` — not
    // a wrong name, nothing at all. The reason is one line in another file:
    //
    //   authStore.ts    function useDatabase() {
    //                     return Boolean(process.env.DATABASE_URL && ...);
    //                   }
    //
    // `authStore.useDatabase()` is NOT test-aware, unlike `projectsStore`'s
    // (`projectsStore.ts`, which checks `TEST_DATABASE_URL` under
    // `NODE_ENV=test` for exactly this reason). `test-setup.ts` blanks
    // `DATABASE_URL` for every test — deliberately, so no suite can reach the
    // production database — so under `test:db` this store takes its IN-MEMORY
    // branch and reads `memoryUsers`, which is empty in this process because
    // the fixture below writes its member rows to Postgres with raw SQL.
    // `listCompanyMembers` returned `[]`, the index was empty, and every
    // lookup missed. The SELECT never ran. It is not a missing column:
    // `USER_COLUMNS` includes `full_name` and `mapUser` maps it.
    //
    // So this assignment is what makes the store under test actually be the
    // store this file claims to test. It is scoped to this file: `node --test`
    // runs each test file in its own child process, so the mutation cannot
    // leak into the in-memory suites that depend on the blanked value.
    //
    // It cannot point anywhere but the test database. `postgres.ts` refuses to
    // read `DATABASE_URL` at all under `NODE_ENV=test` — it builds its pool
    // from `TEST_DATABASE_URL` and throws "Tests must never connect to the
    // production DATABASE_URL" when that is unset. The value assigned here is
    // `TEST_DATABASE_URL` regardless, so both the flag and the connection
    // name the same database.
    //
    // THE GENERAL CASE IS NOT FIXED HERE, ON PURPOSE. Eight route DB suites
    // import `createUser`/`deleteUserAccount` from this store and have been
    // running auth in memory under `test:db` all along, which also makes their
    // Postgres-side cleanup a no-op. Making `useDatabase()` test-aware flips
    // all eight at once. That is AUDIT L109 and its own change.
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = TEST_DB_URL;

    pool = getPgPool();
    await applyMigrations(pool);

    dana = { email: danaEmail, role: "worker", companyId: companyA, companyRole: "owner" };
    priya = { email: priyaEmail, role: "worker", companyId: companyA, companyRole: "manager" };

    await pool.query(
      `INSERT INTO auth_users (email, password_hash, full_name, company_id, company_role)
       VALUES ($1, 'x', $2, $3, 'owner'),
              ($4, 'x', $5, $6, 'manager'),
              ($7, 'x', $8, $9, 'owner')`,
      [danaEmail, DANA, companyA, priyaEmail, PRIYA, companyA, brunoEmail, BRUNO, companyB]
    );

    // project_sites is FORCE RLS (022) — insert inside withTenant.
    await withTenant({ companyId: companyA }, (client) =>
      client.query(
        `INSERT INTO project_sites (id, owner_email, name, address, client, start_date, status, company_id)
         VALUES ($1, $2, 'Payload Site A', '4 Payload Parade', 'Client A', '2026-01-01', 'active', $3)`,
        [siteA, danaEmail, companyA]
      )
    );

    // 2026-03-02 — Dana, every L97 field populated, hourly notes written the way
    // the capture form writes them: EVERY hour in the 07:00–11:00 window, most
    // of them empty. Dropping those empties is the thing the report has to do.
    await createEntry(dana, {
      ...baseEntry("2026-03-02"),
      notes: "Slab pour, south bay.",
      swmsRef: "SWMS-114",
      hazardNotes: "Open penetration at grid C4, barricaded and signed.",
      toolboxTalk: true,
      notesMode: "hourly",
      hourlyNotes: [
        { hour: 7, note: "Pre-start and plant walk." },
        { hour: 8, note: "" },
        { hour: 9, note: "Pour commenced." },
        { hour: 10, note: "" },
        { hour: 11, note: "" },
      ],
    });

    // 2026-03-03 — Priya, none of the five fields given. This is what a row
    // written by today's clients actually looks like.
    await createEntry(priya, { ...baseEntry("2026-03-03"), notes: "Formwork strip." });

    // 2026-03-04 — a MISFILED row: company A's tenant, but `owner_email` is a
    // company B member. `createEntry` stamps `owner_email` from the actor, so
    // this cannot be written through it and is inserted directly.
    await withTenant({ companyId: companyA }, (client) =>
      client.query(
        `INSERT INTO project_entries
           (id, owner_email, company_id, site_id, date, location_address, weather, crew_count, notes, photos_json)
         VALUES ($1, $2, $3, $4, '2026-03-04', '4 Payload Parade', 'Fine', '3', 'Misfiled row.', '[]'::jsonb)`,
        [`pay-entry-misfiled-${runId}`, brunoEmail, companyA, siteA]
      )
    );
  });

  after(async () => {
    // Assign, never `delete`: `server.ts` calls `dotenv.config()` on import and
    // dotenv repopulates an ABSENT key while leaving an empty one alone
    // (CLAUDE.md §6). The harness blanks this variable, so "" is its real
    // prior value in a normal run.
    process.env.DATABASE_URL = previousDatabaseUrl ?? "";
    await pool.end();
  });

  test("an author name comes from the caller's own company, and is never the email — L96", async () => {
    const membersA = await listCompanyMembers(companyA);
    const indexA = buildAuthorNameIndex(membersA);

    // POSITIVE: both of company A's members resolve, to their own names, and
    // the two names differ — so attribution is per-row rather than one name
    // applied to everything.
    assert.equal(resolveAuthorName(indexA, danaEmail), DANA);
    assert.equal(resolveAuthorName(indexA, priyaEmail), PRIYA);
    assert.notEqual(resolveAuthorName(indexA, danaEmail), resolveAuthorName(indexA, priyaEmail));

    // NEGATIVE, through the same index: company B's member is in `auth_users`
    // and has a name, and A's index still cannot produce it. The predicate in
    // `listCompanyMembers` is the only thing that can be doing this.
    assert.equal(resolveAuthorName(indexA, brunoEmail), undefined);

    // CONTROL for that exclusion: B's own index DOES name him, so the row
    // exists, carries a full name, and is resolvable — the emptiness above is
    // the company clause and not a missing fixture.
    const indexB = buildAuthorNameIndex(await listCompanyMembers(companyB));
    assert.equal(resolveAuthorName(indexB, brunoEmail), BRUNO);

    // No address anywhere in what the index can hand to the document. This is
    // the half of L96 that is a privacy requirement rather than a feature: the
    // resolved value is sent to OpenAI with every generation.
    for (const value of indexA.byEmail.values()) assert.doesNotMatch(value, /@/);
    assert.equal(indexA.duplicateNames.length, 0);
  });

  test("a misfiled entry is attributed to nobody, not to the other company's member — L96", async () => {
    const indexA = buildAuthorNameIndex(await listCompanyMembers(companyA));
    const rows = await listEntries(dana, siteA, 50, 0, { from: "2026-03-01", to: "2026-03-31" });

    const misfiled = rows.find((row) => row.date === "2026-03-04");
    assert.ok(misfiled, "the misfiled row must be readable inside company A, or this test proves nothing");
    assert.equal(misfiled!.ownerEmail, brunoEmail, "fixture check: the row is owned by B's member");

    // The row is visible to A and its owner has a perfectly good name in
    // `auth_users` — and the report must still say nothing about who recorded
    // it, because A's own membership cannot vouch for that person.
    assert.equal(resolveAuthorName(indexA, misfiled!.ownerEmail), undefined);

    // CONTROL on the same read, through the same index: the two correctly filed
    // rows from the same query DO resolve. So "undefined" above is this row's
    // owner and not a broken index or an empty result set.
    const attributed = rows
      .filter((row) => row.date !== "2026-03-04")
      .map((row) => resolveAuthorName(indexA, row.ownerEmail));
    assert.deepEqual(attributed.slice().sort(), [DANA, PRIYA]);

    // And the count the route reports to the caller is derived from exactly
    // this: one of the three in-window entries cannot be attributed.
    const unattributed = rows.filter((row) => !resolveAuthorName(indexA, row.ownerEmail)).length;
    assert.equal(unattributed, 1);
  });

  test("the L97 fields survive the round trip into report text — L97", async () => {
    const rows = await listEntries(dana, siteA, 50, 0, { from: "2026-03-01", to: "2026-03-31" });
    const populated = rows.find((row) => row.date === "2026-03-02");
    const bare = rows.find((row) => row.date === "2026-03-03");
    assert.ok(populated && bare);

    // POSITIVE: the hourly content recorded on screen is in the report text,
    // and the empty hours the form also wrote are not.
    const notes = effectiveEntryNotes(populated!);
    assert.equal(populated!.notesMode, "hourly");
    assert.match(notes.text, /Pre-start and plant walk\./);
    assert.match(notes.text, /Pour commenced\./);
    assert.equal(notes.recordedHours, 2, "five hours were written, two carried a note");
    assert.equal(notes.source, "both", "the free-text note and the hourly log both survive");

    // The hour labels come back readable rather than as raw numbers.
    assert.match(notes.text, /07:00 — Pre-start/);
    assert.match(notes.text, /09:00 — Pour commenced/);

    // POSITIVE: the three safety columns round-trip and are rendered.
    const safety = renderSafetyRecord({
      swmsRef: populated!.swmsRef,
      hazardNotes: populated!.hazardNotes,
      toolboxTalk: toolboxTalkFromStoredRow(populated!.toolboxTalk),
    });
    assert.ok(safety);
    assert.match(safety!, /SWMS reference: SWMS-114/);
    assert.match(safety!, /Hazards noted: Open penetration at grid C4/);
    assert.match(safety!, /Toolbox talk: Held/);

    // CONTROL on the same read: the entry written WITHOUT any of the five
    // renders no safety record at all and no hourly log — so the matches above
    // are this row's stored content, not text the renderer always produces.
    const bareSafety = renderSafetyRecord({
      swmsRef: bare!.swmsRef,
      hazardNotes: bare!.hazardNotes,
      toolboxTalk: toolboxTalkFromStoredRow(bare!.toolboxTalk),
    });
    assert.equal(bareSafety, null);
    const bareNotes = effectiveEntryNotes(bare!);
    assert.equal(bareNotes.recordedHours, 0);
    assert.equal(bareNotes.source, "free");
    assert.equal(bareNotes.text, "Formwork strip.");
  });

  test("toolbox_talk cannot record 'never answered', which is why a stored false says nothing", async () => {
    // The schema fact, read from the live database rather than from migration
    // 006's text. If this column ever becomes nullable, the suppression in
    // `toolboxTalkFromStoredRow` stops being the honest behaviour and this
    // assertion is what says so.
    const column = await pool.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = $1 AND column_name = 'toolbox_talk'`,
      [PROJECT_ENTRIES_TABLE]
    );
    assert.equal(column.rowCount, 1, "toolbox_talk is read in a report predicate but is not a column");
    assert.equal(column.rows[0].is_nullable, "NO");
    assert.match(String(column.rows[0].column_default), /false/);

    const rows = await listEntries(dana, siteA, 50, 0, { from: "2026-03-01", to: "2026-03-31" });
    const bare = rows.find((row) => row.date === "2026-03-03");
    const held = rows.find((row) => row.date === "2026-03-02");
    assert.ok(bare && held);

    // The entry that never mentioned a toolbox talk reads back as `false` — the
    // column's default, indistinguishable from a person answering "no".
    assert.equal(bare!.toolboxTalk, false);
    // So it must contribute no line to the document.
    assert.equal(toolboxTalkFromStoredRow(bare!.toolboxTalk), undefined);
    assert.equal(renderSafetyRecord({ toolboxTalk: toolboxTalkFromStoredRow(bare!.toolboxTalk) }), null);

    // CONTROL on the same read: a row that genuinely recorded `true` still
    // speaks, so the suppression above is narrowed to the default and has not
    // simply removed the field from the report.
    assert.equal(held!.toolboxTalk, true);
    assert.equal(toolboxTalkFromStoredRow(held!.toolboxTalk), true);
    assert.equal(
      renderSafetyRecord({ toolboxTalk: toolboxTalkFromStoredRow(held!.toolboxTalk) }),
      "Toolbox talk: Held"
    );
  });
}
