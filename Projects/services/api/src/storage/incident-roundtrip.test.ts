/**
 * Postgres round-trip regression test for the incident data-loss bug
 * documented in migration 024 (`024_incident_inspection_signatures.sql`,
 * "incidents — stop the data loss + WorkSafe NZ fields"): the incident form
 * has always collected fields (time, type, locationArea, injuredRole,
 * injuredEmployer, natureOfInjury, bodyPart, treatmentRequired, witnesses,
 * immediateActions, rootCause, reportedBy, supervisorNotified,
 * supervisorName, plus the newer WorkSafe NZ investigation fields) that the
 * API silently dropped on the way into Postgres — `createIncident`'s INSERT
 * simply never named those columns, so anything a field crew typed into
 * those inputs vanished on save with no error.
 *
 * This is the test whose absence let that bug survive: it saves an incident
 * with EVERY field populated through the real store (`incidentStore.ts`),
 * reads it back with a *separate* SELECT against Postgres (not just the
 * `RETURNING *` of the INSERT itself), and asserts every single field
 * round-trips unchanged — base fields, the pre-existing-but-dropped fields,
 * and the new WorkSafe JSONB fields (`contributingFactors`,
 * `correctiveActions`). If `createIncident`'s INSERT or `mapRow` drops or
 * mangles any field, exactly that field's assertion fails.
 *
 * Guarded like `rls-integration.test.ts`: this test needs a real, disposable
 * Postgres database. Without `TEST_DATABASE_URL` it registers a single
 * skipped placeholder and does nothing else — no live DB connection is
 * attempted. `incidentStore.ts`'s `useDatabase()` is test-aware: under
 * NODE_ENV=test it only picks the Postgres path when `TEST_DATABASE_URL` is
 * set, so this test genuinely exercises `createIncident`/`listIncidents`'
 * database branch, not the in-memory fallback.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "roundtrip-test-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import type { Pool } from "pg";
import { getPgPool } from "./postgres";
import { withTenant } from "./tenant";
import { Actor } from "./actor";
import { applyMigrations } from "./testMigrations";

if (!process.env.TEST_DATABASE_URL) {
  test("incident round-trip (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // Same minimal migration runner as rls-integration.test.ts: storage/migrate.ts's
  // runMigrations() is gated on DATABASE_URL (not TEST_DATABASE_URL) and is a
  // no-op under NODE_ENV=test, and the compiled test runs from
  // dist/storage/*.test.js which does not carry the .sql files — so migrations
  // are read from the source tree relative to process.cwd() (the package root,
  // since `pnpm run test` always runs from services/api).


  // ── Fixture identifiers (unique per run so re-runs against a persistent
  // TEST_DATABASE_URL don't collide with leftovers from a previous run) ──────
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const companyId = `rt-company-${runId}`;
  const ownerEmail = `rt-owner-${runId}@test.local`;
  const siteId = `rt-site-${runId}`;

  let pool: Pool;
  let actor: Actor;
  let createdIncidentId: string | undefined;

  // Every IncidentRecord field the payload can carry (base + the
  // pre-existing-but-previously-dropped fields + the new WorkSafe NZ fields),
  // each set to a distinct, recognisable, non-empty value so a dropped or
  // swapped field is unambiguous in a failing assertion.
  const incidentInput = {
    siteId,
    date: "2026-05-14",
    severity: "major" as const,
    description: "Roundtrip-test description: scaffold plank gave way on level 3",
    injuredParty: "Roundtrip Injured Party Name",
    correctiveAction: "Roundtrip legacy corrective action string",
    status: "open" as const,
    time: "14:37",
    type: "Fall from height",
    locationArea: "Level 3 scaffold, north face",
    injuredRole: "Scaffolder",
    injuredEmployer: "Roundtrip Scaffolding Co",
    natureOfInjury: "Fractured wrist",
    bodyPart: "Left wrist",
    treatmentRequired: "Hospital — X-ray and cast",
    witnesses: "J. Roundtrip-Witness, K. Second-Witness",
    immediateActions: "Area cordoned off, first aid administered, ambulance called",
    rootCause: "Plank not rated for load, inspection tag missing",
    reportedBy: "Roundtrip Site Supervisor",
    supervisorNotified: true,
    supervisorName: "Roundtrip Supervisor Name",
    propertyDamage: "One scaffold plank destroyed",
    firstAiderName: "Roundtrip First Aider Name",
    contributingFactors: {
      environment: "Wet conditions from overnight rain",
      human: "Fatigue — end of double shift",
      equipment: "Plank not rated/tagged for the load",
      methods: "No pre-use scaffold inspection performed",
    },
    worksafeNotified: true,
    worksafeNotifiedAt: "2026-05-14T16:05:00.000Z",
    worksafeNotifiedHow: "Phone call to WorkSafe NZ 0800 line",
    investigatorName: "Roundtrip Investigator Name",
    correctiveActions: [
      {
        action: "Re-tag all scaffold planks on site",
        owner: "Roundtrip Site Manager",
        dueDate: "2026-05-21",
        status: "open",
      },
      {
        action: "Retrain crew on pre-use scaffold checks",
        owner: "Roundtrip HSE Lead",
        dueDate: "2026-05-28",
        status: "open",
      },
    ],
  };

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);

    actor = { email: ownerEmail, role: "worker", companyId, companyRole: "owner" };

    // auth_users carries no RLS policy (only company-scoped operational tables
    // do), so a bare INSERT is fine here — mirrors rls-integration.test.ts.
    await pool.query(
      `INSERT INTO auth_users (email, password_hash, full_name, company_id, company_role)
       VALUES ($1, 'x', 'Roundtrip Test Owner', $2, 'owner')`,
      [ownerEmail, companyId]
    );

    // project_sites is FORCE ROW LEVEL SECURITY (migration 022), so the INSERT
    // must run inside withTenant() for the WITH CHECK clause to see a matching
    // app.company_id — same pattern as rls-integration.test.ts.
    await withTenant({ companyId }, (client) =>
      client.query(
        `INSERT INTO project_sites (id, owner_email, name, address, client, start_date, status, company_id)
         VALUES ($1, $2, 'Roundtrip Test Site', '1 Roundtrip St', 'Roundtrip Client', '2026-01-01', 'active', $3)`,
        [siteId, ownerEmail, companyId]
      )
    );
  });

  after(async () => {
    // incidents and project_sites are both FORCE ROW LEVEL SECURITY — deletes
    // must run inside withTenant(), same as rls-integration.test.ts's after().
    await withTenant({ companyId }, async (client) => {
      if (createdIncidentId) {
        await client.query(`DELETE FROM incidents WHERE id = $1`, [createdIncidentId]);
      }
      await client.query(`DELETE FROM project_sites WHERE id = $1`, [siteId]);
    });
    await pool.query(`DELETE FROM auth_users WHERE email = $1`, [ownerEmail]);
    await pool.end();
  });

  test("createIncident persists every field to Postgres and a fresh read-back drops nothing", async () => {
    const { createIncident, listIncidents } = await import("./incidentStore");

    const created = await createIncident(actor, incidentInput);
    createdIncidentId = created.id;

    // Fresh SELECT * from Postgres — a separate round trip from the INSERT's
    // own RETURNING *, driven through the store's real read path exactly as a
    // route handler would use it.
    const listed = await listIncidents(actor, siteId);
    const readBack = listed.find((i) => i.id === created.id);
    assert.ok(readBack, `expected to find incident ${created.id} in listIncidents(actor, siteId) read-back`);

    // ── Base fields ──────────────────────────────────────────────────────
    assert.equal(readBack.siteId, incidentInput.siteId);
    assert.equal(readBack.date, incidentInput.date);
    assert.equal(readBack.severity, incidentInput.severity);
    assert.equal(readBack.description, incidentInput.description);
    assert.equal(readBack.injuredParty, incidentInput.injuredParty);
    assert.equal(readBack.correctiveAction, incidentInput.correctiveAction);
    assert.equal(readBack.status, incidentInput.status);
    assert.equal(readBack.companyId, companyId);
    assert.equal(readBack.ownerEmail, ownerEmail);

    // ── Pre-existing-but-previously-dropped fields (the actual bug) ────────
    assert.equal(readBack.time, incidentInput.time);
    assert.equal(readBack.type, incidentInput.type);
    assert.equal(readBack.locationArea, incidentInput.locationArea);
    assert.equal(readBack.injuredRole, incidentInput.injuredRole);
    assert.equal(readBack.injuredEmployer, incidentInput.injuredEmployer);
    assert.equal(readBack.natureOfInjury, incidentInput.natureOfInjury);
    assert.equal(readBack.bodyPart, incidentInput.bodyPart);
    assert.equal(readBack.treatmentRequired, incidentInput.treatmentRequired);
    assert.equal(readBack.witnesses, incidentInput.witnesses);
    assert.equal(readBack.immediateActions, incidentInput.immediateActions);
    assert.equal(readBack.rootCause, incidentInput.rootCause);
    assert.equal(readBack.reportedBy, incidentInput.reportedBy);
    assert.equal(readBack.supervisorNotified, incidentInput.supervisorNotified);
    assert.equal(readBack.supervisorName, incidentInput.supervisorName);

    // ── New WorkSafe NZ investigation fields ────────────────────────────────
    assert.equal(readBack.propertyDamage, incidentInput.propertyDamage);
    assert.equal(readBack.firstAiderName, incidentInput.firstAiderName);
    assert.deepEqual(readBack.contributingFactors, incidentInput.contributingFactors);
    assert.equal(readBack.worksafeNotified, incidentInput.worksafeNotified);
    assert.equal(readBack.worksafeNotifiedAt, incidentInput.worksafeNotifiedAt);
    assert.equal(readBack.worksafeNotifiedHow, incidentInput.worksafeNotifiedHow);
    assert.equal(readBack.investigatorName, incidentInput.investigatorName);
    assert.deepEqual(readBack.correctiveActions, incidentInput.correctiveActions);
  });
}
