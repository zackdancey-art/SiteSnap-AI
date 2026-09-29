/**
 * Media isolation and the signed-fetch round trip, against real Postgres.
 *
 * WHY THIS EXISTS ALONGSIDE tenant-isolation-matrix.test.ts
 *
 * That file covers the same endpoints, but it runs with DATABASE_URL="" — so
 * `uploadsStore` takes its in-memory branch and the RLS policy from migration
 * 023 is never executed. A policy that was dropped, or a FORCE that was lifted,
 * would not show up there. It also never fetches a signed URL: it asserts the
 * minted string contains "sig=" and stops.
 *
 * That second gap is the one that mattered. A photo uri exists in three shapes:
 *
 *   file:///…                                   before upload
 *   /api/uploads/<id>/<file>                    what POST /uploads returns and
 *                                               what Postgres stores
 *   https://…/api/uploads/<id>/<file>?sig=&exp= the only shape a client can load
 *
 * Six real photographs rendered as six blank tiles in the app because addEntry
 * put shape 2 into state and never signed it. Nothing on the server was wrong —
 * which is exactly why the server's contract needs to be written down as
 * assertions: shape 2 is NOT fetchable, shape 3 is, and shape 3 is obtainable
 * only by the owning company. If any of those three stops being true, the client
 * pipeline built on them breaks again.
 *
 * Both required properties are asserted for BOTH companies, each with its
 * positive control in the same test, on the same endpoint: a tenant cannot read
 * another tenant's media, and a tenant can write and read its own. The database
 * is then checked directly through a NOBYPASSRLS probe role, because the app
 * connects as the owner (Neon's neondb_owner) and would satisfy the store's
 * queries even with every policy removed.
 *
 * Guarded on TEST_DATABASE_URL — skips (one placeholder) without a real DB.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "uploads-media-isolation-secret";

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import type { Pool } from "pg";
import { createApp } from "../server";
import { getPgPool } from "../storage/postgres";
import { withTenant } from "../storage/tenant";
import { createAuthToken } from "../utils/authToken";
import { signUploadPath } from "../utils/signedUrl";

if (!process.env.TEST_DATABASE_URL) {
  test("uploads media isolation (skipped: set TEST_DATABASE_URL)", { skip: true }, () => {});
} else {
  /**
   * `uploadsStore.useDatabase()` reads DATABASE_URL on every call, and it is
   * blanked by test-setup.ts, so without this the route would take its
   * in-memory branch and this file would test nothing it claims to.
   *
   * This cannot reach production: getPgPool() refuses to read DATABASE_URL at
   * all when NODE_ENV === "test" and connects to TEST_DATABASE_URL or throws.
   * node:test runs each file in its own process, so no other suite sees it.
   */
  const originalDatabaseUrl = process.env.DATABASE_URL;
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

  const runId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const COMPANY_A = `media-co-a-${runId}`;
  const COMPANY_B = `media-co-b-${runId}`;
  const probeRole = `media_probe_${runId.replace(/[^a-z0-9]/gi, "")}`;
  const probePassword = `Media_${Date.now()}_7kQw`;

  const tokenA = createAuthToken({ email: `owner-a-${runId}@media.local`, fullName: "Owner A", companyId: COMPANY_A, companyRole: "owner" });
  const tokenB = createAuthToken({ email: `owner-b-${runId}@media.local`, fullName: "Owner B", companyId: COMPANY_B, companyRole: "owner" });

  const BYTES_A = Buffer.from(`company-a-photograph-${runId}`);
  const BYTES_B = Buffer.from(`company-b-photograph-${runId}`);

  let server: http.Server;
  let baseUrl: string;
  let pool: Pool;
  let probe: Client;

  type Uploaded = { id: string; filename: string; url: string; storageKey: string };
  const uploadedFiles: Uploaded[] = [];

  /** POST /api/uploads as the given company. Returns the API's own response. */
  const uploadAs = async (token: string, bytes: Buffer, filename: string): Promise<Uploaded> => {
    const form = new FormData();
    // new Uint8Array(...): Blob wants ArrayBufferView<ArrayBuffer>, and a Buffer
    // in a parameter position widens to Buffer<ArrayBufferLike>.
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), filename);
    const res = await fetch(`${baseUrl}/api/uploads`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form });
    const text = await res.text();
    assert.equal(res.status, 200, `upload failed: ${text}`);
    const uploaded = JSON.parse(text) as Uploaded;
    uploadedFiles.push(uploaded);
    return uploaded;
  };

  /** GET a media path. Returns the status and, on 200, the bytes. */
  const getMedia = async (urlOrPath: string, token?: string): Promise<{ status: number; body: Buffer }> => {
    const url = urlOrPath.startsWith("http") ? urlOrPath : `${baseUrl}${urlOrPath}`;
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  };

  const signAs = async (token: string, paths: string[]) => {
    const res = await fetch(`${baseUrl}/api/uploads/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ paths }),
    });
    assert.equal(res.status, 200, `sign request failed with ${res.status}`);
    return (await res.json()) as { signed: { path: string; url: string | null; error?: string }[] };
  };

  /** Run fn as the NOBYPASSRLS probe, in a rolled-back tx with the given GUCs. */
  const asProbe = async <T>(gucs: Record<string, string>, fn: (c: Client) => Promise<T>): Promise<T> => {
    await probe.query("BEGIN");
    try {
      for (const [k, v] of Object.entries(gucs)) await probe.query("SELECT set_config($1, $2, true)", [k, v]);
      const r = await fn(probe);
      await probe.query("ROLLBACK");
      return r;
    } catch (e) { await probe.query("ROLLBACK").catch(() => {}); throw e; }
  };

  before(async () => {
    pool = getPgPool();
    await applyMigrations(pool);

    const app = createApp();
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    await pool.query(`DROP ROLE IF EXISTS ${probeRole}`);
    await pool.query(`CREATE ROLE ${probeRole} LOGIN PASSWORD '${probePassword}' NOBYPASSRLS`);
    await pool.query(`GRANT SELECT, INSERT ON uploads TO ${probeRole}`);
    const u = new URL(process.env.TEST_DATABASE_URL as string);
    u.username = probeRole; u.password = probePassword;
    u.searchParams.delete("channel_binding"); u.searchParams.delete("sslmode");
    // Mirror getPgPool()'s PG_SSL gate: an ssl object against a plain Postgres
    // with no TLS (the CI postgres:16 service) forces a rejected handshake.
    probe = new Client({ connectionString: u.toString(), ssl: process.env.PG_SSL === "require" ? { rejectUnauthorized: false } : undefined });
    await probe.connect();
  });

  after(async () => {
    try { await probe.end(); } catch { /* ignore */ }
    await pool.query(`REVOKE ALL ON uploads FROM ${probeRole}`).catch(() => {});
    await pool.query(`DROP ROLE IF EXISTS ${probeRole}`).catch(() => {});
    for (const company of [COMPANY_A, COMPANY_B]) {
      await withTenant({ companyId: company }, (c) => c.query(`DELETE FROM uploads WHERE company_id = $1`, [company])).catch(() => {});
    }
    await pool.end();
    // Local-disk media adapter (MEDIA_STORAGE_PROVIDER is blanked in tests).
    for (const f of uploadedFiles) {
      await fs.rm(path.join(process.cwd(), "storage", "uploads", `${f.id}-${f.filename}`), { force: true }).catch(() => {});
    }
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  // ── The three uri shapes, as a contract ────────────────────────────────────

  test("POST /uploads returns an UNSIGNED relative path, which is NOT fetchable — and the signed form is", async () => {
    const uploaded = await uploadAs(tokenA, BYTES_A, "shape-contract.jpg");

    // Shape 2. This is what the API returns and what Postgres stores. A client
    // that puts this into view state renders nothing: React Native's <Image> has
    // no base URL and fails silently on a relative path.
    assert.match(uploaded.url, /^\/api\/uploads\/[^/]+\/[^/?]+$/, `expected a bare relative path, got ${uploaded.url}`);
    assert.ok(!uploaded.url.includes("sig="), "POST /uploads must not return a pre-signed url");

    // And it is genuinely not usable on its own: unauthenticated, unsigned → 401.
    const unsigned = await getMedia(uploaded.url);
    assert.equal(unsigned.status, 401, "an unsigned upload path must not serve bytes");

    // Shape 3, from the endpoint whose whole job is to mint it. POSITIVE CONTROL
    // for the 401 above, on the same endpoint: the same file, signed, serves the
    // exact bytes that were uploaded.
    const signed = await signAs(tokenA, [uploaded.url]);
    const signedUrl = signed.signed[0].url;
    assert.ok(typeof signedUrl === "string" && signedUrl.includes("sig=") && signedUrl.includes("exp="), `expected a signed url, got ${JSON.stringify(signed.signed[0])}`);
    const fetched = await getMedia(signedUrl);
    assert.equal(fetched.status, 200, "a signed url must serve the file");
    assert.deepEqual(fetched.body, BYTES_A, "the signed url must serve the bytes that were uploaded");
  });

  test("a tampered or foreign signature is refused, while the genuine one is accepted", async () => {
    const uploaded = await uploadAs(tokenA, BYTES_A, "signature-integrity.jpg");
    const { sig, exp } = signUploadPath(uploaded.id, uploaded.filename);

    const genuine = await getMedia(`/api/uploads/${uploaded.id}/${uploaded.filename}?sig=${encodeURIComponent(sig)}&exp=${exp}`);
    assert.equal(genuine.status, 200, "the genuine signature must be accepted");

    const tampered = `${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    const bad = await getMedia(`/api/uploads/${uploaded.id}/${uploaded.filename}?sig=${encodeURIComponent(tampered)}&exp=${exp}`);
    assert.equal(bad.status, 401, "a tampered signature must be refused");

    const expired = signUploadPath(uploaded.id, uploaded.filename);
    const stale = await getMedia(`/api/uploads/${uploaded.id}/${uploaded.filename}?sig=${encodeURIComponent(expired.sig)}&exp=${Math.floor(Date.now() / 1000) - 10}`);
    assert.equal(stale.status, 401, "an expired exp must be refused even with a well-formed sig");

    // A signature minted for one file must not authorize another.
    const other = await uploadAs(tokenA, BYTES_A, "signature-other.jpg");
    const crossed = await getMedia(`/api/uploads/${other.id}/${other.filename}?sig=${encodeURIComponent(sig)}&exp=${exp}`);
    assert.equal(crossed.status, 401, "a signature is bound to one id+filename");
  });

  // ── Both required properties, both directions, with Postgres in the path ───

  test("company B cannot read or sign company A's media, and company A can — same endpoints, same test", async () => {
    const uploaded = await uploadAs(tokenA, BYTES_A, "a-private.jpg");

    // Ownership was bound at upload time, in Postgres, from A's token.
    const rows = await withTenant({ companyId: COMPANY_A }, (c) =>
      c.query<{ company_id: string }>(`SELECT company_id FROM uploads WHERE id = $1`, [uploaded.id])
    );
    assert.equal(rows.rowCount, 1, "the upload must be recorded in Postgres, not in memory");
    assert.equal(rows.rows[0].company_id, COMPANY_A);

    const bBearer = await getMedia(uploaded.url, tokenB);
    assert.equal(bBearer.status, 404, "B must not read A's media (404, not 403 — existence is not confirmed)");
    const aBearer = await getMedia(uploaded.url, tokenA);
    assert.equal(aBearer.status, 200, "POSITIVE CONTROL: A must read its own media on the same endpoint");
    assert.deepEqual(aBearer.body, BYTES_A);

    const bSign = await signAs(tokenB, [uploaded.url]);
    assert.equal(bSign.signed[0].url, null, "B must not be able to mint a signed url for A's file");
    const aSign = await signAs(tokenA, [uploaded.url]);
    assert.ok(typeof aSign.signed[0].url === "string", "POSITIVE CONTROL: A must be able to mint one for the same file");
  });

  test("company B can write its own media and read it back, and company A cannot read it", async () => {
    const uploaded = await uploadAs(tokenB, BYTES_B, "b-private.jpg");

    // Write: the row is B's, written under B's tenant context.
    const rows = await withTenant({ companyId: COMPANY_B }, (c) =>
      c.query<{ company_id: string }>(`SELECT company_id FROM uploads WHERE id = $1`, [uploaded.id])
    );
    assert.equal(rows.rowCount, 1, "B's upload must be recorded under B's company");
    assert.equal(rows.rows[0].company_id, COMPANY_B);

    // Read own, both ways in.
    const bBearer = await getMedia(uploaded.url, tokenB);
    assert.equal(bBearer.status, 200, "B must read its own media with its bearer token");
    assert.deepEqual(bBearer.body, BYTES_B);
    const bSigned = await signAs(tokenB, [uploaded.url]);
    const bSignedUrl = bSigned.signed[0].url;
    assert.ok(typeof bSignedUrl === "string", "B must be able to sign its own file");
    const viaSignature = await getMedia(bSignedUrl);
    assert.equal(viaSignature.status, 200, "B's signed url must serve B's bytes");
    assert.deepEqual(viaSignature.body, BYTES_B);

    // And the boundary holds in the other direction too.
    const aBearer = await getMedia(uploaded.url, tokenA);
    assert.equal(aBearer.status, 404, "A must not read B's media");
    const aSign = await signAs(tokenA, [uploaded.url]);
    assert.equal(aSign.signed[0].url, null, "A must not be able to sign B's file");
  });

  // ── The database, not the store filter ────────────────────────────────────

  test("RLS on `uploads` is enforced by Postgres for a NOBYPASSRLS role, in both directions and fail-closed", async () => {
    const a = await uploadAs(tokenA, BYTES_A, "rls-a.jpg");
    const b = await uploadAs(tokenB, BYTES_B, "rls-b.jpg");

    const aSeesOwn = await asProbe({ "app.company_id": COMPANY_A }, (c) => c.query(`SELECT id FROM uploads WHERE id = $1`, [a.id]));
    assert.equal(aSeesOwn.rows.length, 1, "POSITIVE CONTROL: company A's context must see company A's upload row");

    const aSeesB = await asProbe({ "app.company_id": COMPANY_A }, (c) => c.query(`SELECT id FROM uploads WHERE id = $1`, [b.id]));
    assert.equal(aSeesB.rows.length, 0, "company A must not see company B's upload row");

    const bSeesA = await asProbe({ "app.company_id": COMPANY_B }, (c) => c.query(`SELECT id FROM uploads WHERE id = $1`, [a.id]));
    assert.equal(bSeesA.rows.length, 0, "company B must not see company A's upload row");

    const unscoped = await asProbe({}, (c) => c.query(`SELECT id FROM uploads WHERE id = ANY($1)`, [[a.id, b.id]]));
    assert.equal(unscoped.rows.length, 0, "no app.company_id must fail closed, not fall open");
  });

  test("RLS WITH CHECK stops a tenant writing an upload row attributed to another tenant", async () => {
    const own = `probe-own-${runId}`;
    const forged = `probe-forged-${runId}`;

    // POSITIVE CONTROL first: the probe genuinely can insert its own row, so the
    // rejection below cannot be explained by a missing grant.
    await asProbe({ "app.company_id": COMPANY_B }, (c) =>
      c.query(`INSERT INTO uploads (id, filename, company_id, owner_email) VALUES ($1, 'own.jpg', $2, 'b@media.local')`, [own, COMPANY_B])
    );

    await assert.rejects(
      () => asProbe({ "app.company_id": COMPANY_B }, (c) =>
        c.query(`INSERT INTO uploads (id, filename, company_id, owner_email) VALUES ($1, 'forged.jpg', $2, 'b@media.local')`, [forged, COMPANY_A])
      ),
      /row-level security/i,
      "company B must not be able to attribute a new upload row to company A"
    );
  });
}
