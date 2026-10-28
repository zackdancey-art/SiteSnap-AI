/**
 * Postgres round-trip + integrity test for the inspection-signature feature
 * (Part 3). Signatures live in `inspection_signatures` (migration 024 §4): an
 * append-only, FORCE ROW LEVEL SECURITY table with a BEFORE UPDATE trigger that
 * makes signed content immutable and voiding one-way. None of that is
 * observable in the in-memory harness — `signature-store.test.ts` covers the
 * app-level logic, but the DB-level guarantees (the trigger, and RLS company
 * isolation) can ONLY be proven against real Postgres. This is that proof.
 *
 * It exercises, through the real store (`signatureStore.ts` /
 * `inspectionStore.ts`) and, where the guarantee is at the schema level, raw
 * SQL against Postgres:
 *   1. insert + read-back round-trips every field (status active, hash, snapshot)
 *   2. the trigger REJECTS an in-place edit of a signed column
 *   3. void is allowed once and is one-way — un-voiding is REJECTED by the trigger
 *   4. editing a signed inspection AUTO-VOIDS the stale signature; a status-only
 *      (non-content) edit does NOT
 *   5. RLS blocks cross-company reads
 *
 * RLS caveat (learned the hard way in the 024 smoke test): a role with
 * BYPASSRLS — which Neon's default `neondb_owner` has — bypasses the policy
 * entirely, so asserting isolation on the app's own connection would falsely
 * pass (or falsely fail). Test 5 therefore creates a dedicated NOBYPASSRLS
 * login role and runs the isolation assertions as THAT role, which is the only
 * way to genuinely prove the policy isolates. Red-on-revert: drop the policy
 * (or the table's FORCE) and test 5 goes red — the probe role starts seeing the
 * other company's rows.
 *
 * Guarded like `rls-integration.test.ts` / `incident-roundtrip.test.ts`:
 * without `TEST_DATABASE_URL` it registers one skipped placeholder and touches
 * no database. `useDatabase()` in both stores is test-aware, so with
 * TEST_DATABASE_URL set the Postgres branch runs, not the in-memory fallback.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "signature-roundtrip-test-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { Client } from "pg";
import type { Pool } from "pg";
import { getPgPool } from "./postgres";
import { withTenant } from "./tenant";
import { Actor } from "./actor";
import { createInspection, updateInspection, getInspection, InspectionRecord } from "./inspectionStore";
import { createSignature, listSignatures, voidSignature, computeInspectionContentHash } from "./signatureStore";
import { applyMigrations } from "./testMigrations";

if (!process.env.TEST_DATABASE_URL) {
  test("signature round-trip (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  // Same minimal migration runner as rls-integration.test.ts / incident-roundtrip.test.ts.


  // ── Unique fixtures per run (safe against leftovers on a persistent DB) ──────
  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const companyA = `sig-company-a-${runId}`;
  const companyB = `sig-company-b-${runId}`;
  const ownerA = `sig-owner-a-${runId}@test.local`;
  const ownerB = `sig-owner-b-${runId}@test.local`;
  const siteA = `sig-site-a-${runId}`;
  const siteB = `sig-site-b-${runId}`;
  // Role/identifier must be a bare SQL identifier — strip everything non-alnum.
  const probeRole = `sig_probe_${runId.replace(/[^a-z0-9]/gi, "")}`;
  const probePassword = `Prb_${Date.now()}_9xZq`;

  let pool: Pool;
  let actorA: Actor;
  let actorB: Actor;
  let inspA: InspectionRecord;
  let inspB: InspectionRecord;

  const signableInput = (siteId: string, overrides: Partial<Omit<InspectionRecord, "id" | "ownerEmail" | "companyId" | "createdAt">> = {}) => ({
    siteId,
    templateId: null,
    name: "Weekly safety inspection",
    date: "2026-06-02",
    results: [
      { item: "PPE worn", passed: true, notes: "all crew compliant" },
      { item: "Edge protection", passed: false, notes: "missing on east face" },
    ],
    status: "pending" as const,
    scope: "Whole-of-site weekly",
    areaInspected: "Levels 1-3",
    time: "08:15",
    inspectorName: "Ada Inspector",
    inspectorRole: "H&S Advisor",
    inspectorCompany: "Acme Safety",
    defects: [{ description: "No edge protection east face", severity: "high", owner: "Site Mgr", dueDate: "2026-06-05", status: "open" }],
    overallOutcome: "conditional pass",
    followUpRequired: true,
    ...overrides,
  });

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);

    actorA = { email: ownerA, role: "worker", companyId: companyA, companyRole: "owner" };
    actorB = { email: ownerB, role: "worker", companyId: companyB, companyRole: "owner" };

    await pool.query(
      `INSERT INTO auth_users (email, password_hash, full_name, company_id, company_role)
       VALUES ($1, 'x', 'Sig Owner A', $2, 'owner'), ($3, 'x', 'Sig Owner B', $4, 'owner')`,
      [ownerA, companyA, ownerB, companyB]
    );

    // project_sites is FORCE RLS (022) — insert inside withTenant.
    await withTenant({ companyId: companyA }, (client) =>
      client.query(
        `INSERT INTO project_sites (id, owner_email, name, address, client, start_date, status, company_id)
         VALUES ($1, $2, 'Sig Site A', '1 Sig St', 'Client A', '2026-01-01', 'active', $3)`,
        [siteA, ownerA, companyA]
      )
    );
    await withTenant({ companyId: companyB }, (client) =>
      client.query(
        `INSERT INTO project_sites (id, owner_email, name, address, client, start_date, status, company_id)
         VALUES ($1, $2, 'Sig Site B', '1 Sig St', 'Client B', '2026-01-01', 'active', $3)`,
        [siteB, ownerB, companyB]
      )
    );

    // inspections is NOT RLS-forced — createInspection uses the bare pool path.
    inspA = await createInspection(actorA, signableInput(siteA));
    inspB = await createInspection(actorB, signableInput(siteB));
  });

  after(async () => {
    // Best-effort probe-role teardown (test 5 also drops it; guard against leaks
    // if that test failed mid-way).
    try {
      await pool.query(`REVOKE ALL ON inspection_signatures FROM ${probeRole}`);
      await pool.query(`DROP ROLE IF EXISTS ${probeRole}`);
    } catch {
      /* ignore */
    }
    // inspection_signatures + project_sites are FORCE RLS — delete inside withTenant.
    await withTenant({ companyId: companyA }, async (client) => {
      await client.query(`DELETE FROM inspection_signatures WHERE company_id = $1`, [companyA]);
      await client.query(`DELETE FROM project_sites WHERE id = $1`, [siteA]);
    });
    await withTenant({ companyId: companyB }, async (client) => {
      await client.query(`DELETE FROM inspection_signatures WHERE company_id = $1`, [companyB]);
      await client.query(`DELETE FROM project_sites WHERE id = $1`, [siteB]);
    });
    // inspections not RLS-forced — bare delete is fine.
    await pool.query(`DELETE FROM inspections WHERE company_id = ANY($1)`, [[companyA, companyB]]);
    await pool.query(`DELETE FROM auth_users WHERE email = ANY($1)`, [[ownerA, ownerB]]);
    await pool.end();
  });

  const sign = async (actor: Actor, insp: InspectionRecord, role: "inspector" | "manager" | "client" = "inspector", signerName = "Ada Inspector") => {
    const { hash, snapshot } = computeInspectionContentHash(insp);
    return createSignature(actor, {
      inspectionId: insp.id,
      role,
      signerName,
      path: "M0 0 L10 10 L20 5",
      viewBox: "0 0 200 80",
      contentHash: hash,
      snapshot,
    });
  }

  test("1: createSignature persists and a fresh read-back returns it active with hash + snapshot intact", async () => {
    const { hash, snapshot } = computeInspectionContentHash(inspA);
    const sig = await createSignature(actorA, {
      inspectionId: inspA.id,
      role: "inspector",
      signerName: "Ada Inspector",
      path: "M1 1 L2 2",
      viewBox: "0 0 100 40",
      contentHash: hash,
      snapshot,
    });

    const listed = await listSignatures(actorA, inspA.id);
    const readBack = listed.find((s) => s.id === sig.id);
    assert.ok(readBack, "signature should be returned by listSignatures");
    assert.equal(readBack.status, "active");
    assert.equal(readBack.role, "inspector");
    assert.equal(readBack.signerName, "Ada Inspector");
    assert.equal(readBack.path, "M1 1 L2 2");
    assert.equal(readBack.viewBox, "0 0 100 40");
    assert.equal(readBack.contentHash, hash);
    assert.equal(readBack.companyId, companyA);
    assert.deepEqual(readBack.snapshot, snapshot);
  });

  test("2: the trigger REJECTS an in-place edit of a signed column", async () => {
    const sig = await sign(actorA, inspA);
    // Raw UPDATE through the app's own connection (owner) — the trigger fires
    // regardless of RLS/bypass, so this proves the schema-level immutability.
    await assert.rejects(
      () => withTenant({ companyId: companyA }, (client) =>
        client.query(`UPDATE inspection_signatures SET path = 'M9 9 L8 8' WHERE id = $1`, [sig.id])),
      /immutable/i,
      "editing a signed column must be rejected by the immutability trigger"
    );
    await assert.rejects(
      () => withTenant({ companyId: companyA }, (client) =>
        client.query(`UPDATE inspection_signatures SET content_hash = 'forged', signer_name = 'Someone Else' WHERE id = $1`, [sig.id])),
      /immutable/i,
      "rewriting content_hash / signer_name must be rejected"
    );
  });

  test("3: void is one-way — second void is a no-op and un-voiding is REJECTED by the trigger", async () => {
    const sig = await sign(actorA, inspA);
    const voided = await voidSignature(actorA, sig.id, "superseded by re-sign");
    assert.ok(voided, "first void should succeed");
    assert.equal(voided.status, "voided");
    assert.equal(voided.voidedReason, "superseded by re-sign");

    // Store-level: a second void returns null (guarded by status='active').
    const again = await voidSignature(actorA, sig.id, "again");
    assert.equal(again, null, "a voided signature cannot be voided again");

    // Schema-level: a raw un-void is rejected by the trigger.
    await assert.rejects(
      () => withTenant({ companyId: companyA }, (client) =>
        client.query(`UPDATE inspection_signatures SET status = 'active' WHERE id = $1`, [sig.id])),
      /immutable/i,
      "reactivating a voided signature must be rejected"
    );
  });

  test("4: editing a signed inspection auto-voids the stale signature; a status-only edit does not", async () => {
    // Fresh inspection so we don't disturb inspA's signatures.
    const insp = await createInspection(actorA, signableInput(siteA, { name: "Auto-void probe inspection" }));
    const sig = await sign(actorA, insp);

    // Status-only change: status is excluded from the content hash, so the
    // signature must remain active.
    await updateInspection(actorA, insp.id, { status: "complete" });
    let listed = await listSignatures(actorA, insp.id);
    assert.equal(listed.find((s) => s.id === sig.id)?.status, "active", "a status-only edit must NOT void the signature");

    // A genuine content change (overallOutcome) must auto-void it.
    await updateInspection(actorA, insp.id, { overallOutcome: "FAIL — edited after signing" });
    listed = await listSignatures(actorA, insp.id);
    const after = listed.find((s) => s.id === sig.id);
    assert.equal(after?.status, "voided", "editing signable content must auto-void the signature");
    assert.match(after?.voidedReason ?? "", /content changed after signing/i);

    await withTenant({ companyId: companyA }, (client) => client.query(`DELETE FROM inspection_signatures WHERE inspection_id = $1`, [insp.id]));
  });

  test("5: RLS blocks cross-company reads (proven via a NOBYPASSRLS probe role)", async () => {
    // Guarantee at least one active signature exists in each company.
    await sign(actorA, inspA);
    await sign(actorB, inspB);

    // A role WITHOUT bypassrls — the only way to observe the policy on a DB
    // whose owner (e.g. Neon's neondb_owner) has BYPASSRLS.
    await pool.query(`DROP ROLE IF EXISTS ${probeRole}`);
    await pool.query(`CREATE ROLE ${probeRole} LOGIN PASSWORD '${probePassword}' NOBYPASSRLS`);
    await pool.query(`GRANT SELECT ON inspection_signatures TO ${probeRole}`);

    const probeUrl = new URL(process.env.TEST_DATABASE_URL as string);
    probeUrl.username = probeRole;
    probeUrl.password = probePassword;
    // Drop libpq-only params node-postgres doesn't honour (channel_binding forces
    // SCRAM channel binding, unsupported). SSL only when the DB requires it
    // (Neon: PG_SSL=require); a plain Postgres (CI postgres:16) rejects a forced
    // ssl handshake, so mirror getPgPool()'s PG_SSL gate.
    probeUrl.searchParams.delete("channel_binding");
    probeUrl.searchParams.delete("sslmode");
    const probe = new Client({ connectionString: probeUrl.toString(), ssl: process.env.PG_SSL === "require" ? { rejectUnauthorized: false } : undefined });
    await probe.connect();
    try {
      // Tenant context = company B: must see ZERO of company A's signatures.
      await probe.query("BEGIN");
      await probe.query("SELECT set_config('app.company_id', $1, true)", [companyB]);
      const bSeesA = await probe.query(`SELECT id FROM inspection_signatures WHERE company_id = $1`, [companyA]);
      await probe.query("ROLLBACK");
      assert.equal(bSeesA.rows.length, 0, "company B tenant context must NOT see company A's signatures");

      // Tenant context = company A: must see its own.
      await probe.query("BEGIN");
      await probe.query("SELECT set_config('app.company_id', $1, true)", [companyA]);
      const aSeesA = await probe.query(`SELECT id FROM inspection_signatures WHERE company_id = $1`, [companyA]);
      await probe.query("ROLLBACK");
      assert.ok(aSeesA.rows.length >= 1, "company A tenant context must see its own signatures");

      // No app.company_id set: fail-closed, zero rows.
      const unscoped = await probe.query(`SELECT id FROM inspection_signatures`);
      assert.equal(unscoped.rows.length, 0, "an unscoped query (no app.company_id) must see zero rows (fail-closed)");
    } finally {
      await probe.end();
      await pool.query(`REVOKE ALL ON inspection_signatures FROM ${probeRole}`);
      await pool.query(`DROP ROLE IF EXISTS ${probeRole}`);
    }
  });

  test("6: Part B — checklist photos round-trip through Postgres; base64 stripped server-side; photo change voids, uri swap does not", async () => {
    // (a) A client that WRONGLY includes base64 bytes in a checklist photo.
    const insp = await createInspection(actorA, signableInput(siteA, {
      name: "Checklist photo probe",
      results: [{ item: "Fire extinguisher tag", passed: true, notes: "tagged", na: false,
        photos: [{ id: "cp1", uri: "/uploads/xyz-tag.jpg", kind: "original", caption: "tag", base64: "PRETEND-IMAGE-BYTES" }] }],
    }));
    const readBack = await getInspection(actorA, insp.id);
    assert.ok(readBack, "created inspection should read back from Postgres");
    const photos = readBack!.results[0].photos as Array<Record<string, unknown>>;
    assert.equal(photos.length, 1);
    assert.equal("base64" in photos[0], false, "base64 must NOT be persisted into results_json (server-side strip on the DB path)");
    assert.equal(photos[0].id, "cp1", "photo identity survives the JSONB round-trip");
    assert.equal(photos[0].uri, "/uploads/xyz-tag.jpg");
    assert.equal(photos[0].kind, "original");

    // (b) Signable: adding a photo to a signed inspection auto-voids (DB path).
    const sig = await sign(actorA, readBack!);
    await updateInspection(actorA, insp.id, {
      results: [{ ...readBack!.results[0], photos: [...photos, { id: "cp2", uri: "/uploads/xyz-2.jpg", kind: "original", base64: "MORE-BYTES" }] }],
    });
    const afterAdd = await listSignatures(actorA, insp.id);
    assert.equal(afterAdd.find((s) => s.id === sig.id)?.status, "voided", "adding a checklist photo must auto-void the signature (DB path)");

    // (c) Anti-false-void: a local->remote uri swap on the SAME photo identity must NOT void.
    const insp2 = await createInspection(actorA, signableInput(siteA, {
      name: "uri swap probe",
      results: [{ item: "Edge protection", passed: true, notes: "", na: false, photos: [{ id: "u1", uri: "file:///local.jpg", kind: "original" }] }],
    }));
    const sig2 = await sign(actorA, (await getInspection(actorA, insp2.id))!);
    await updateInspection(actorA, insp2.id, {
      results: [{ item: "Edge protection", passed: true, notes: "", na: false, photos: [{ id: "u1", uri: "/uploads/u1.jpg", kind: "original" }] }],
    });
    const afterSwap = await listSignatures(actorA, insp2.id);
    assert.equal(afterSwap.find((s) => s.id === sig2.id)?.status, "active", "local->remote uri swap must NOT void (no false void) — DB path");

    await withTenant({ companyId: companyA }, (client) =>
      client.query(`DELETE FROM inspection_signatures WHERE inspection_id = ANY($1)`, [[insp.id, insp2.id]]));
  });
}
