/**
 * Cross-tenant isolation MATRIX for AUDIT.md finding H1
 * ("multi-tenancy is enforced by convention only").
 *
 * This is the "proposed isolation test" described in AUDIT.md's H1 section:
 * register Company A + Company B, seed ONE record of every company-scoped
 * resource as Company A, then assert Company B is denied on every HTTP
 * verb that resource exposes (GET-list, PATCH, DELETE — there are no
 * individual GET-by-id routes anywhere in this API; every resource is
 * fetched by listing and filtering client-side, so "read" isolation is
 * proven by asserting the seeded id is absent from Company B's list).
 *
 * This file runs entirely against the IN-MEMORY store (DATABASE_URL="" —
 * see test-setup.ts, preloaded via `node --require`). Postgres/RLS is
 * covered separately by storage/rls-integration.test.ts (guarded on
 * TEST_DATABASE_URL); H4/H6 company_id-write regressions are covered by
 * storage/company-id-writes.test.ts. This file's job is narrower and
 * different from both: prove that the *hand-written store filters* (the
 * mechanism H1 says is fragile) actually hold, end-to-end, through the real
 * HTTP routes, for every tenant-scoped resource — and that the inventory of
 * "every tenant-scoped resource" cannot silently drift out of date.
 *
 * Conventions copied deliberately from company-rbac.test.ts: the `req`
 * helper, `nextPhone`/`registerUser`, and the createApp() + ephemeral-server
 * + beforeEach-reset harness. Do not introduce a different pattern here.
 *
 * ── Completeness mechanism (do not hardcode a resource list) ──────────────
 * `KNOWN_ROUTERS` below pairs every router actually mounted on `apiRouter`
 * (routes/index.ts) with either (a) the MATRIX resource key(s) it owns, or
 * (b) `tenantScoped: false` plus a one-line reason it carries no
 * company-scoped "record" resource of its own. The completeness test walks
 * `apiRouter`'s real Express layer stack at runtime (reference-equality on
 * `layer.handle`, not string/name matching — Express router mounts are
 * anonymous, so this is the only reliable way to introspect them) and
 * cross-checks it against `KNOWN_ROUTERS`, then cross-checks `KNOWN_ROUTERS`
 * against `MATRIX`. Concretely, this means: if a future PR adds a new route
 * file and mounts it in routes/index.ts (e.g. `apiRouter.use(notesRouter)`)
 * without touching this file, `apiRouter.stack` grows by one layer whose
 * `.handle` doesn't match anything in `KNOWN_ROUTERS` — the first assertion
 * in the completeness test fails immediately, naming this file as the place
 * to fix it. This was verified structurally (see report) by mounting an
 * extra throwaway router on a scratch Express Router with the same
 * `.stack`/`layer.handle` shape used here, outside this repo's source tree.
 */

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests } from "../storage/projectsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";

// Same set of imports routes/index.ts uses to build apiRouter — this is
// intentional: it lets us identify each mounted layer by reference equality
// against the exact router object index.ts passes to `.use()`.
import { apiRouter } from "./index";
import authRouter from "./auth";
import { aiRouter } from "./ai";
import { uploadsRouter } from "./uploads";
import { healthRouter } from "./health";
import { projectsRouter } from "./projects";
import { pushRouter } from "./push";
import { crewRouter } from "./crew";
import { incidentsRouter } from "./incidents";
import { inspectionsRouter } from "./inspections";
import { deliveriesRouter } from "./deliveries";
import { templatesRouter } from "./templates";
import { locationRouter } from "./location";
import { companyRouter } from "./company";

let server: http.Server;
let baseUrl: string;

async function req<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      `${baseUrl}/api${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { "Content-Length": Buffer.byteLength(payload).toString() } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as T });
          } catch {
            reject(new Error(`Non-JSON (${res.statusCode}): ${data}`));
          }
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// Raw-status variant for the one endpoint in this matrix that can return a
// binary body on success (GET /uploads/:id/:filename returns image bytes,
// not JSON — the shared `req` helper above would throw on that response).
async function reqStatus(method: string, path: string, token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      `${baseUrl}/api${path}`,
      { method, headers: token ? { Authorization: `Bearer ${token}` } : {} },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      }
    );
    r.on("error", reject);
    r.end();
  });
}

// Global counter: phone numbers must be unique across all registrations in a test run.
let _phoneSeq = 0;
function nextPhone() { return `+614${String(++_phoneSeq).padStart(8, "0")}`; }

/** Register + verify a user, returning their auth token. */
async function registerUser(email: string, name: string, companyName?: string): Promise<string> {
  const regBody: Record<string, string> = { email, phone: nextPhone(), fullName: name, password: "Password123!!" };
  if (companyName) regBody.companyName = companyName;
  const regRes = await req<{ ok: boolean; devCodes?: { emailCode: string } }>(
    "POST", "/auth/register", regBody
  );
  assert.equal(regRes.status, 200, `register ${email} failed: ${JSON.stringify(regRes.body)}`);
  const { emailCode } = regRes.body.devCodes!;
  // Two-stage verification: the SMS is only minted once the email code
  // is accepted, so the sms code comes from THIS response, not register.
  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email: email, emailCode }
  );
  const { smsCode } = veRes.body.devCodes!;
  const verRes = await req<{ token: string }>(
    "POST", "/auth/register/verify", { email, smsCode }
  );
  assert.equal(verRes.status, 201, `verify ${email} failed: ${JSON.stringify(verRes.body)}`);
  return verRes.body.token;
}

async function createSiteAs(token: string, name: string): Promise<string> {
  const res = await req<{ site: { id: string } }>(
    "POST", "/projects/sites",
    { name, address: "1 Matrix St", client: "Matrix Client", startDate: "2026-01-01", status: "active" },
    token
  );
  assert.equal(res.status, 201, `seed site failed: ${JSON.stringify(res.body)}`);
  return res.body.site.id;
}

before(async () => {
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

beforeEach(async () => {
  resetAuthStoreForTests();
  resetProjectStoreForTests();
  resetRateLimitStoreForTests();
});

// ── Resource descriptor table (the "MATRIX") ────────────────────────────────
//
// Each entry seeds exactly one record as Company A's owner, then — as
// Company B's owner — drives every mutating/listing HTTP verb the resource
// actually exposes and asserts denial. Every assertion below is genuinely
// boundary-dependent: it checks for the *specific seeded id* (membership in
// a list, or a targeted PATCH/DELETE by that id), not just "the list has the
// right length" — so if the underlying company_id filter were ever deleted,
// these exact assertions would start failing (Company B's list would gain
// Company A's id; the PATCH/DELETE would stop 404ing). This was confirmed
// per-resource by reading each store's scoping code (see report for the
// per-resource notes) rather than by editing source, which this test
// suite is not permitted to do.

type MatrixEntry = {
  key: string;
  run: () => Promise<void>;
};

const MATRIX: MatrixEntry[] = [
  {
    key: "sites",
    run: async () => {
      const tokenA = await registerUser("owner-a@sites.matrix.test", "Owner A", "Sites Co A");
      const tokenB = await registerUser("owner-b@sites.matrix.test", "Owner B", "Sites Co B");
      const siteAId = await createSiteAs(tokenA, "Matrix Site A");

      // Positive control: prove the list endpoint returns rows at all. Without it
      // an endpoint broken to return [] for EVERY caller would satisfy the negative
      // assertion below and this row would pass while isolation went untested.
      // (Not hypothetical: mutating listSites() to return [] left the whole matrix
      //  green — see docs/VACUITY-AUDIT.md, mutation M6.)
      const ownRes = await req<{ sites: { id: string }[] }>("GET", "/projects/sites", undefined, tokenA);
      assert.equal(ownRes.status, 200);
      assert.ok(
        ownRes.body.sites.map((r) => r.id).includes(siteAId),
        "positive control: Company A must see its OWN site in the list"
      );
      const listRes = await req<{ sites: { id: string }[] }>("GET", "/projects/sites", undefined, tokenB);
      assert.equal(listRes.status, 200);
      assert.ok(!listRes.body.sites.map((s) => s.id).includes(siteAId), "Company B must not see Company A's site in the list");

      const patchRes = await req("PATCH", `/projects/sites/${siteAId}/progress`, { progressPercent: 50 }, tokenB);
      assert.equal(patchRes.status, 404, "Company B PATCH on Company A's site must 404");

      const delRes = await req("DELETE", `/projects/sites/${siteAId}`, undefined, tokenB);
      assert.equal(delRes.status, 404, "Company B DELETE on Company A's site must 404");
    },
  },
  {
    key: "entries",
    run: async () => {
      const tokenA = await registerUser("owner-a@entries.matrix.test", "Owner A", "Entries Co A");
      const tokenB = await registerUser("owner-b@entries.matrix.test", "Owner B", "Entries Co B");
      const siteAId = await createSiteAs(tokenA, "Matrix Site A");

      const entryRes = await req<{ entry: { id: string } }>(
        "POST", "/projects/entries", { siteId: siteAId, date: "2026-01-02", notes: "matrix entry A" }, tokenA
      );
      assert.equal(entryRes.status, 201, `seed entry failed: ${JSON.stringify(entryRes.body)}`);
      const entryAId = entryRes.body.entry.id;

      // Positive control: prove the list endpoint returns rows at all. Without it
      // an endpoint broken to return [] for EVERY caller would satisfy the negative
      // assertion below and this row would pass while isolation went untested.
      // (Not hypothetical: mutating listSites() to return [] left the whole matrix
      //  green — see docs/VACUITY-AUDIT.md, mutation M6.)
      const ownRes = await req<{ entries: { id: string }[] }>("GET", "/projects/entries", undefined, tokenA);
      assert.equal(ownRes.status, 200);
      assert.ok(
        ownRes.body.entries.map((r) => r.id).includes(entryAId),
        "positive control: Company A must see its OWN entrie in the list"
      );
      const listRes = await req<{ entries: { id: string }[] }>("GET", "/projects/entries", undefined, tokenB);
      assert.equal(listRes.status, 200);
      assert.ok(!listRes.body.entries.map((e) => e.id).includes(entryAId), "Company B must not see Company A's entry in the list");

      const patchRes = await req("PATCH", `/projects/entries/${entryAId}`, { notes: "hijacked" }, tokenB);
      assert.equal(patchRes.status, 404, "Company B PATCH on Company A's entry must 404");

      const delRes = await req("DELETE", `/projects/entries/${entryAId}`, undefined, tokenB);
      assert.equal(delRes.status, 404, "Company B DELETE on Company A's entry must 404");
    },
  },
  {
    key: "diaries",
    run: async () => {
      const tokenA = await registerUser("owner-a@diaries.matrix.test", "Owner A", "Diaries Co A");
      const tokenB = await registerUser("owner-b@diaries.matrix.test", "Owner B", "Diaries Co B");
      const siteAId = await createSiteAs(tokenA, "Matrix Site A");

      const diaryRes = await req<{ diary: { id: string } }>(
        "POST", "/projects/diaries", { siteId: siteAId, status: "draft", summary: "matrix diary A" }, tokenA
      );
      assert.equal(diaryRes.status, 201, `seed diary failed: ${JSON.stringify(diaryRes.body)}`);
      const diaryAId = diaryRes.body.diary.id;

      // Positive control: prove the list endpoint returns rows at all. Without it
      // an endpoint broken to return [] for EVERY caller would satisfy the negative
      // assertion below and this row would pass while isolation went untested.
      // (Not hypothetical: mutating listSites() to return [] left the whole matrix
      //  green — see docs/VACUITY-AUDIT.md, mutation M6.)
      const ownRes = await req<{ diaries: { id: string }[] }>("GET", "/projects/diaries", undefined, tokenA);
      assert.equal(ownRes.status, 200);
      assert.ok(
        ownRes.body.diaries.map((r) => r.id).includes(diaryAId),
        "positive control: Company A must see its OWN diarie in the list"
      );
      const listRes = await req<{ diaries: { id: string }[] }>("GET", "/projects/diaries", undefined, tokenB);
      assert.equal(listRes.status, 200);
      assert.ok(!listRes.body.diaries.map((d) => d.id).includes(diaryAId), "Company B must not see Company A's diary in the list");

      const patchRes = await req("PATCH", `/projects/diaries/${diaryAId}`, { status: "approved" }, tokenB);
      assert.equal(patchRes.status, 404, "Company B PATCH on Company A's diary must 404");

      // No DELETE /projects/diaries/:id route exists in this API (verified in
      // routes/projects.ts) — list + PATCH are the full cross-company surface here.
    },
  },
  {
    key: "site-templates",
    run: async () => {
      const tokenA = await registerUser("owner-a@sitetpl.matrix.test", "Owner A", "SiteTpl Co A");
      const tokenB = await registerUser("owner-b@sitetpl.matrix.test", "Owner B", "SiteTpl Co B");
      const siteAId = await createSiteAs(tokenA, "Matrix Site A");

      const tplRes = await req<{ template: { id: string } }>(
        "POST", "/projects/templates", { siteId: siteAId, name: "Matrix Site Template A" }, tokenA
      );
      assert.equal(tplRes.status, 201, `seed site-template failed: ${JSON.stringify(tplRes.body)}`);
      const tplAId = tplRes.body.template.id;

      // Positive control: prove the list endpoint returns rows at all. Without it
      // an endpoint broken to return [] for EVERY caller would satisfy the negative
      // assertion below and this row would pass while isolation went untested.
      // (Not hypothetical: mutating listSites() to return [] left the whole matrix
      //  green — see docs/VACUITY-AUDIT.md, mutation M6.)
      const ownRes = await req<{ templates: { id: string }[] }>("GET", "/projects/templates", undefined, tokenA);
      assert.equal(ownRes.status, 200);
      assert.ok(
        ownRes.body.templates.map((r) => r.id).includes(tplAId),
        "positive control: Company A must see its OWN template in the list"
      );
      const listRes = await req<{ templates: { id: string }[] }>("GET", "/projects/templates", undefined, tokenB);
      assert.equal(listRes.status, 200);
      assert.ok(!listRes.body.templates.map((t) => t.id).includes(tplAId), "Company B must not see Company A's site-template in the list");

      const patchRes = await req("PATCH", `/projects/templates/${tplAId}`, { name: "hijacked" }, tokenB);
      assert.equal(patchRes.status, 404, "Company B PATCH on Company A's site-template must 404");

      const delRes = await req("DELETE", `/projects/templates/${tplAId}`, undefined, tokenB);
      assert.equal(delRes.status, 404, "Company B DELETE on Company A's site-template must 404");
    },
  },
  {
    key: "entry-templates",
    run: async () => {
      const tokenA = await registerUser("owner-a@entrytpl.matrix.test", "Owner A", "EntryTpl Co A");
      const tokenB = await registerUser("owner-b@entrytpl.matrix.test", "Owner B", "EntryTpl Co B");

      const tplRes = await req<{ template: { id: string } }>(
        "POST", "/entry-templates", { name: "Matrix Entry Template A" }, tokenA
      );
      assert.equal(tplRes.status, 201, `seed entry-template failed: ${JSON.stringify(tplRes.body)}`);
      const tplAId = tplRes.body.template.id;

      // Positive control: prove the list endpoint returns rows at all. Without it
      // an endpoint broken to return [] for EVERY caller would satisfy the negative
      // assertion below and this row would pass while isolation went untested.
      // (Not hypothetical: mutating listSites() to return [] left the whole matrix
      //  green — see docs/VACUITY-AUDIT.md, mutation M6.)
      const ownRes = await req<{ templates: { id: string }[] }>("GET", "/entry-templates", undefined, tokenA);
      assert.equal(ownRes.status, 200);
      assert.ok(
        ownRes.body.templates.map((r) => r.id).includes(tplAId),
        "positive control: Company A must see its OWN template in the list"
      );
      const listRes = await req<{ templates: { id: string }[] }>("GET", "/entry-templates", undefined, tokenB);
      assert.equal(listRes.status, 200);
      assert.ok(!listRes.body.templates.map((t) => t.id).includes(tplAId), "Company B must not see Company A's entry-template in the list");

      // No PATCH /entry-templates/:id route exists (verified in routes/templates.ts).
      const delRes = await req("DELETE", `/entry-templates/${tplAId}`, undefined, tokenB);
      assert.equal(delRes.status, 404, "Company B DELETE on Company A's entry-template must 404");
    },
  },
  {
    key: "incidents",
    run: async () => {
      const tokenA = await registerUser("owner-a@incidents.matrix.test", "Owner A", "Incidents Co A");
      const tokenB = await registerUser("owner-b@incidents.matrix.test", "Owner B", "Incidents Co B");
      const siteAId = await createSiteAs(tokenA, "Matrix Site A");

      const incRes = await req<{ incident: { id: string } }>(
        "POST", "/incidents",
        { siteId: siteAId, date: "2026-01-03", severity: "minor", description: "matrix incident A" },
        tokenA
      );
      assert.equal(incRes.status, 201, `seed incident failed: ${JSON.stringify(incRes.body)}`);
      const incAId = incRes.body.incident.id;

      // Positive control: prove the list endpoint returns rows at all. Without it
      // an endpoint broken to return [] for EVERY caller would satisfy the negative
      // assertion below and this row would pass while isolation went untested.
      // (Not hypothetical: mutating listSites() to return [] left the whole matrix
      //  green — see docs/VACUITY-AUDIT.md, mutation M6.)
      const ownRes = await req<{ incidents: { id: string }[] }>("GET", "/incidents", undefined, tokenA);
      assert.equal(ownRes.status, 200);
      assert.ok(
        ownRes.body.incidents.map((r) => r.id).includes(incAId),
        "positive control: Company A must see its OWN incident in the list"
      );
      const listRes = await req<{ incidents: { id: string }[] }>("GET", "/incidents", undefined, tokenB);
      assert.equal(listRes.status, 200);
      assert.ok(!listRes.body.incidents.map((i) => i.id).includes(incAId), "Company B must not see Company A's incident in the list");

      const patchRes = await req("PATCH", `/incidents/${incAId}`, { status: "closed" }, tokenB);
      assert.equal(patchRes.status, 404, "Company B PATCH on Company A's incident must 404");

      const delRes = await req("DELETE", `/incidents/${incAId}`, undefined, tokenB);
      assert.equal(delRes.status, 404, "Company B DELETE on Company A's incident must 404");
    },
  },
  {
    key: "deliveries",
    run: async () => {
      const tokenA = await registerUser("owner-a@deliveries.matrix.test", "Owner A", "Deliveries Co A");
      const tokenB = await registerUser("owner-b@deliveries.matrix.test", "Owner B", "Deliveries Co B");
      const siteAId = await createSiteAs(tokenA, "Matrix Site A");

      const delivRes = await req<{ delivery: { id: string } }>(
        "POST", "/deliveries", { siteId: siteAId, date: "2026-01-04", supplier: "Matrix Supplier A" }, tokenA
      );
      assert.equal(delivRes.status, 201, `seed delivery failed: ${JSON.stringify(delivRes.body)}`);
      const delivAId = delivRes.body.delivery.id;

      // Positive control: prove the list endpoint returns rows at all. Without it
      // an endpoint broken to return [] for EVERY caller would satisfy the negative
      // assertion below and this row would pass while isolation went untested.
      // (Not hypothetical: mutating listSites() to return [] left the whole matrix
      //  green — see docs/VACUITY-AUDIT.md, mutation M6.)
      const ownRes = await req<{ deliveries: { id: string }[] }>("GET", "/deliveries", undefined, tokenA);
      assert.equal(ownRes.status, 200);
      assert.ok(
        ownRes.body.deliveries.map((r) => r.id).includes(delivAId),
        "positive control: Company A must see its OWN deliverie in the list"
      );
      const listRes = await req<{ deliveries: { id: string }[] }>("GET", "/deliveries", undefined, tokenB);
      assert.equal(listRes.status, 200);
      assert.ok(!listRes.body.deliveries.map((d) => d.id).includes(delivAId), "Company B must not see Company A's delivery in the list");

      const patchRes = await req("PATCH", `/deliveries/${delivAId}`, { notes: "hijacked" }, tokenB);
      assert.equal(patchRes.status, 404, "Company B PATCH on Company A's delivery must 404");

      const delRes = await req("DELETE", `/deliveries/${delivAId}`, undefined, tokenB);
      assert.equal(delRes.status, 404, "Company B DELETE on Company A's delivery must 404");
    },
  },
  {
    key: "inspections",
    run: async () => {
      const tokenA = await registerUser("owner-a@inspections.matrix.test", "Owner A", "Inspections Co A");
      const tokenB = await registerUser("owner-b@inspections.matrix.test", "Owner B", "Inspections Co B");
      const siteAId = await createSiteAs(tokenA, "Matrix Site A");

      const inspRes = await req<{ inspection: { id: string } }>(
        "POST", "/inspections", { siteId: siteAId, name: "Matrix Inspection A", date: "2026-01-05" }, tokenA
      );
      assert.equal(inspRes.status, 201, `seed inspection failed: ${JSON.stringify(inspRes.body)}`);
      const inspAId = inspRes.body.inspection.id;

      // Positive control: prove the list endpoint returns rows at all. Without it
      // an endpoint broken to return [] for EVERY caller would satisfy the negative
      // assertion below and this row would pass while isolation went untested.
      // (Not hypothetical: mutating listSites() to return [] left the whole matrix
      //  green — see docs/VACUITY-AUDIT.md, mutation M6.)
      const ownRes = await req<{ inspections: { id: string }[] }>("GET", "/inspections", undefined, tokenA);
      assert.equal(ownRes.status, 200);
      assert.ok(
        ownRes.body.inspections.map((r) => r.id).includes(inspAId),
        "positive control: Company A must see its OWN inspection in the list"
      );
      const listRes = await req<{ inspections: { id: string }[] }>("GET", "/inspections", undefined, tokenB);
      assert.equal(listRes.status, 200);
      assert.ok(!listRes.body.inspections.map((i) => i.id).includes(inspAId), "Company B must not see Company A's inspection in the list");

      const patchRes = await req("PATCH", `/inspections/${inspAId}`, { status: "complete" }, tokenB);
      assert.equal(patchRes.status, 404, "Company B PATCH on Company A's inspection must 404");

      const delRes = await req("DELETE", `/inspections/${inspAId}`, undefined, tokenB);
      assert.equal(delRes.status, 404, "Company B DELETE on Company A's inspection must 404");
    },
  },
  {
    key: "inspection-templates",
    run: async () => {
      const tokenA = await registerUser("owner-a@insptpl.matrix.test", "Owner A", "InspTpl Co A");
      const tokenB = await registerUser("owner-b@insptpl.matrix.test", "Owner B", "InspTpl Co B");

      const tplRes = await req<{ template: { id: string } }>(
        "POST", "/inspection-templates", { name: "Matrix Inspection Template A", items: ["Item 1", "Item 2"] }, tokenA
      );
      assert.equal(tplRes.status, 201, `seed inspection-template failed: ${JSON.stringify(tplRes.body)}`);
      const tplAId = tplRes.body.template.id;

      // Positive control: prove the list endpoint returns rows at all. Without it
      // an endpoint broken to return [] for EVERY caller would satisfy the negative
      // assertion below and this row would pass while isolation went untested.
      // (Not hypothetical: mutating listSites() to return [] left the whole matrix
      //  green — see docs/VACUITY-AUDIT.md, mutation M6.)
      const ownRes = await req<{ templates: { id: string }[] }>("GET", "/inspection-templates", undefined, tokenA);
      assert.equal(ownRes.status, 200);
      assert.ok(
        ownRes.body.templates.map((r) => r.id).includes(tplAId),
        "positive control: Company A must see its OWN template in the list"
      );
      const listRes = await req<{ templates: { id: string }[] }>("GET", "/inspection-templates", undefined, tokenB);
      assert.equal(listRes.status, 200);
      assert.ok(!listRes.body.templates.map((t) => t.id).includes(tplAId), "Company B must not see Company A's inspection-template in the list");

      // No PATCH /inspection-templates/:id route exists (verified in routes/inspections.ts).
      const delRes = await req("DELETE", `/inspection-templates/${tplAId}`, undefined, tokenB);
      assert.equal(delRes.status, 404, "Company B DELETE on Company A's inspection-template must 404");
    },
  },
  {
    key: "crew-timecards",
    run: async () => {
      const tokenA = await registerUser("owner-a@timecards.matrix.test", "Owner A", "Timecards Co A");
      const tokenB = await registerUser("owner-b@timecards.matrix.test", "Owner B", "Timecards Co B");
      const siteAId = await createSiteAs(tokenA, "Matrix Site A");

      const tcRes = await req<{ timecard: { id: string } }>(
        "POST", "/crew/timecards",
        { siteId: siteAId, workerName: "Matrix Worker A", date: "2026-01-06", hoursRegular: 8 },
        tokenA
      );
      assert.equal(tcRes.status, 201, `seed timecard failed: ${JSON.stringify(tcRes.body)}`);
      const tcAId = tcRes.body.timecard.id;

      // Positive control: prove the list endpoint returns rows at all. Without it
      // an endpoint broken to return [] for EVERY caller would satisfy the negative
      // assertion below and this row would pass while isolation went untested.
      // (Not hypothetical: mutating listSites() to return [] left the whole matrix
      //  green — see docs/VACUITY-AUDIT.md, mutation M6.)
      const ownRes = await req<{ timecards: { id: string }[] }>("GET", "/crew/timecards", undefined, tokenA);
      assert.equal(ownRes.status, 200);
      assert.ok(
        ownRes.body.timecards.map((r) => r.id).includes(tcAId),
        "positive control: Company A must see its OWN timecard in the list"
      );
      const listRes = await req<{ timecards: { id: string }[] }>("GET", "/crew/timecards", undefined, tokenB);
      assert.equal(listRes.status, 200);
      assert.ok(!listRes.body.timecards.map((t) => t.id).includes(tcAId), "Company B must not see Company A's timecard in the list");

      // No PATCH /crew/timecards/:id route exists (verified in routes/crew.ts).
      const delRes = await req("DELETE", `/crew/timecards/${tcAId}`, undefined, tokenB);
      assert.equal(delRes.status, 404, "Company B DELETE on Company A's timecard must 404");
    },
  },
  {
    key: "worker-locations",
    run: async () => {
      const tokenA = await registerUser("owner-a@locations.matrix.test", "Owner A", "Locations Co A");
      const tokenB = await registerUser("owner-b@locations.matrix.test", "Owner B", "Locations Co B");

      const updRes = await req("POST", "/location/update", { latitude: -33.8688, longitude: 151.2093 }, tokenA);
      assert.equal(updRes.status, 200, `seed location failed: ${JSON.stringify(updRes.body)}`);

      // GET /location/workers is the only read surface for this resource
      // (there's no per-id GET/PATCH/DELETE — it's a live "current position"
      // upsert keyed by user email). Both actors are company owners, so
      // canViewCompanyLocations() passes for both; the only thing that
      // should keep Company A's location out of Company B's view is the
      // company_id filter in storage/locationStore.ts's getAllWorkerLocations().
      const listRes = await req<{ locations: { userEmail: string }[] }>("GET", "/location/workers", undefined, tokenB);
      assert.equal(listRes.status, 200);
      assert.ok(
        !listRes.body.locations.some((l) => l.userEmail === "owner-a@locations.matrix.test"),
        "Company B must not see Company A's worker location"
      );
    },
  },
  {
    key: "push-tokens",
    run: async () => {
      const tokenA = await registerUser("owner-a@pushtok.matrix.test", "Owner A", "PushTok Co A");
      const tokenB = await registerUser("owner-b@pushtok.matrix.test", "Owner B", "PushTok Co B");

      const pushToken = `ExponentPushToken[matrix-a-${Date.now()}-${Math.random().toString(16).slice(2)}]`;
      const regRes = await req("POST", "/push/tokens", { token: pushToken, platform: "expo" }, tokenA);
      assert.equal(regRes.status, 201, `seed push token failed: ${JSON.stringify(regRes.body)}`);

      // GET /push/tokens is always self-scoped (returns only the caller's own
      // tokens, by design — there's no company-wide token listing endpoint),
      // so this leg of the check is guaranteed regardless of company
      // scoping. The genuinely boundary-dependent assertion is the DELETE
      // below: if pushStore.deletePushToken ever stopped checking
      // ownership/company and matched on token value alone, Company B could
      // silently deregister Company A's device.
      const listRes = await req<{ tokens: { token: string }[] }>("GET", "/push/tokens", undefined, tokenB);
      assert.equal(listRes.status, 200);
      assert.ok(!listRes.body.tokens.some((t) => t.token === pushToken), "Company B must not see Company A's push token");

      const delRes = await req("DELETE", `/push/tokens/${encodeURIComponent(pushToken)}`, undefined, tokenB);
      assert.equal(delRes.status, 404, "Company B DELETE on Company A's push token must 404");
    },
  },
];

for (const entry of MATRIX) {
  test(`matrix — ${entry.key}: Company B is denied on every seeded Company A record`, entry.run);
}

// ── uploads: seed + fetch + sign (finding H7 — fixed) ────────────────────────
//
// Ownership is bound at UPLOAD time in the `uploads(id, company_id)` table
// (uploadsStore.recordUpload), NOT inferred from caller-writable entry JSON.
// routes/uploads.ts gates the bearer fetch and the sign endpoint on
// uploadBelongsToActorCompany. This test asserts the boundary is UNFORGEABLE:
// B plants an entry in B's own company referencing A's upload id and is still
// denied fetch + sign (the earlier entry-inference design was forgeable here).
const UPLOADS_MATRIX_KEY = "uploads";

test(
  `matrix — ${UPLOADS_MATRIX_KEY}: Company B cannot fetch or sign Company A's uploaded file`,
  async () => {
    const tokenA = await registerUser("owner-a@uploads.matrix.test", "Owner A", "Uploads Co A");
    const tokenB = await registerUser("owner-b@uploads.matrix.test", "Owner B", "Uploads Co B");

    // A uploads a file.
    const form = new FormData();
    form.append("file", new Blob([Buffer.from("matrix-upload-a")], { type: "image/jpeg" }), "matrix-a.jpg");
    const uploadRes = await fetch(`${baseUrl}/api/uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}` },
      body: form,
    });
    const uploadBodyText = await uploadRes.text();
    assert.equal(uploadRes.status, 200, `seed upload failed: ${uploadBodyText}`);
    const uploaded = JSON.parse(uploadBodyText) as {
      id: string; filename: string; url: string; storageKey: string;
    };

    // Ownership is bound to A at upload time (uploads table), so A can fetch its
    // own file without needing an entry to reference it.
    const aFetch = await reqStatus("GET", `/uploads/${uploaded.id}/${uploaded.filename}`, tokenA);
    assert.equal(aFetch, 200, `Company A should fetch its own upload, got ${aFetch}`);

    // Naive cross-tenant fetch as B is denied.
    const bFetch = await reqStatus("GET", `/uploads/${uploaded.id}/${uploaded.filename}`, tokenB);
    assert.ok(bFetch === 404 || bFetch === 401, `Company B fetch should be denied, got ${bFetch}`);

    // FORGERY ATTACK (the bypass a prior fix missed): B plants an entry in B's
    // OWN company referencing A's upload id. Authorization must NOT be inferable
    // from caller-writable entry JSON — B must STILL be denied.
    const siteB = await req<{ site: { id: string } }>(
      "POST", "/projects/sites",
      { name: "Forge Site B", address: "9 B St", client: "B", startDate: "2026-01-01", status: "active" },
      tokenB
    );
    assert.equal(siteB.status, 201, `B site seed failed: ${JSON.stringify(siteB.body)}`);
    const forgedEntry = await req(
      "POST", "/projects/entries",
      {
        siteId: siteB.body.site.id, date: "2026-01-02", notes: "forged reference",
        photos: [{ id: uploaded.id, uri: uploaded.url, storageKey: uploaded.storageKey, filename: uploaded.filename }],
      },
      tokenB
    );
    assert.equal(forgedEntry.status, 201, `B forged entry should be created: ${JSON.stringify(forgedEntry.body)}`);

    const bForgedFetch = await reqStatus("GET", `/uploads/${uploaded.id}/${uploaded.filename}`, tokenB);
    assert.ok(
      bForgedFetch === 404 || bForgedFetch === 401,
      `Company B must STILL be denied after forging a referencing entry, got ${bForgedFetch}`
    );

    // Positive control for the assertion below: signing must actually WORK for
    // the rightful owner. Without this, a /uploads/sign broken to return
    // url:null for every caller would satisfy B's null-check and this test
    // would pass while the feature was entirely dead. (Not hypothetical:
    // mutating the ownership check to deny everyone left all 126 tests green —
    // see docs/VACUITY-AUDIT.md, mutation M7.)
    const aSign = await req<{ signed: { url: string | null }[] }>(
      "POST", "/uploads/sign", { paths: [uploaded.url] }, tokenA
    );
    assert.equal(aSign.status, 200);
    assert.ok(
      typeof aSign.body.signed[0].url === "string" && aSign.body.signed[0].url.includes("sig="),
      `Company A must receive a signed URL for its OWN file, got ${JSON.stringify(aSign.body.signed[0])}`
    );

    // Company B cannot mint a signed URL for A's file, even after the forgery.
    const bSign = await req<{ signed: { url: string | null }[] }>(
      "POST", "/uploads/sign", { paths: [uploaded.url] }, tokenB
    );
    assert.equal(bSign.status, 200);
    assert.equal(bSign.body.signed[0].url, null, "Company B must not receive a signed URL for Company A's file");
  }
);

// ── Completeness assertion ──────────────────────────────────────────────────
//
// Derives its source-of-truth set from `apiRouter.stack` at runtime (see the
// file-level comment above for exactly how). KNOWN_ROUTERS is the only
// place a human needs to edit when adding a new router; everything else is
// cross-checked programmatically.

type KnownRouter = {
  router: unknown;
  label: string;
  tenantScoped: boolean;
  resourceKeys: string[];
  reason?: string;
};

const KNOWN_ROUTERS: KnownRouter[] = [
  {
    router: authRouter, label: "authRouter", tenantScoped: false, resourceKeys: [],
    reason: "Identity/session management (register/login/verify/password reset) — no company-scoped data record of its own. Covered by change-password.test.ts, invites.test.ts, and company-rbac.test.ts.",
  },
  {
    router: aiRouter, label: "aiRouter", tenantScoped: false, resourceKeys: [],
    reason: "Diary generation reads/writes exclusively through projectsStore (already the 'diaries' matrix entry); no independent persisted resource.",
  },
  {
    router: uploadsRouter, label: "uploadsRouter", tenantScoped: true, resourceKeys: [UPLOADS_MATRIX_KEY],
    reason: "Covered by the dedicated uploads test above (media isn't a CRUD-by-id resource), not the MATRIX array.",
  },
  {
    router: healthRouter, label: "healthRouter", tenantScoped: false, resourceKeys: [],
    reason: "Static liveness endpoint — no data.",
  },
  { router: projectsRouter, label: "projectsRouter", tenantScoped: true, resourceKeys: ["sites", "entries", "diaries", "site-templates"] },
  { router: pushRouter, label: "pushRouter", tenantScoped: true, resourceKeys: ["push-tokens"] },
  { router: crewRouter, label: "crewRouter", tenantScoped: true, resourceKeys: ["crew-timecards"] },
  { router: incidentsRouter, label: "incidentsRouter", tenantScoped: true, resourceKeys: ["incidents"] },
  { router: inspectionsRouter, label: "inspectionsRouter", tenantScoped: true, resourceKeys: ["inspections", "inspection-templates"] },
  { router: deliveriesRouter, label: "deliveriesRouter", tenantScoped: true, resourceKeys: ["deliveries"] },
  { router: templatesRouter, label: "templatesRouter", tenantScoped: true, resourceKeys: ["entry-templates"] },
  { router: locationRouter, label: "locationRouter", tenantScoped: true, resourceKeys: ["worker-locations"] },
  {
    router: companyRouter, label: "companyRouter", tenantScoped: false, resourceKeys: [],
    reason: "Company membership/invite management is the tenancy boundary itself, not a scoped 'record' resource in the seed-then-deny sense — exhaustively covered by company-rbac.test.ts (tests 2, 4, 6a, 6b) and invites.test.ts.",
  },
];

test("matrix completeness: every router mounted in routes/index.ts is accounted for here", () => {
  const stack = (apiRouter as unknown as { stack: Array<{ handle: unknown }> }).stack;
  assert.ok(stack.length > 0, "apiRouter has no mounted layers — sanity check failed, something is very wrong with this introspection");

  // 1) Every layer actually mounted on apiRouter must be a router we recognise.
  //    This is the trip wire: a new route file mounted in routes/index.ts
  //    and NOT added to KNOWN_ROUTERS below shows up here as an unmatched
  //    layer, and this assertion fails.
  for (const layer of stack) {
    const known = KNOWN_ROUTERS.find((k) => k.router === layer.handle);
    assert.ok(
      known,
      "apiRouter (routes/index.ts) mounts a router this file does not recognise. " +
        "A new resource router was added to routes/index.ts without updating KNOWN_ROUTERS " +
        "in tenant-isolation-matrix.test.ts — add it there (tenantScoped + resourceKeys, or " +
        "tenantScoped: false with a reason), and if tenant-scoped, add a MATRIX entry (or an " +
        "equivalent dedicated test, as done for uploads) covering it."
    );
  }

  // 2) Reverse direction: every router we claim is mounted must actually be
  //    mounted (catches stale/renamed entries in KNOWN_ROUTERS).
  for (const known of KNOWN_ROUTERS) {
    assert.ok(
      stack.some((layer) => layer.handle === known.router),
      `${known.label} is listed in KNOWN_ROUTERS but is not actually mounted on apiRouter — stale entry.`
    );
  }

  // 3) Every tenant-scoped router's declared resourceKeys must have MATRIX
  //    (or equivalent dedicated) coverage.
  const matrixKeys = new Set([...MATRIX.map((m) => m.key), UPLOADS_MATRIX_KEY]);
  for (const known of KNOWN_ROUTERS) {
    if (!known.tenantScoped) continue;
    assert.ok(known.resourceKeys.length > 0, `${known.label} is marked tenantScoped but declares no resourceKeys.`);
    for (const key of known.resourceKeys) {
      assert.ok(matrixKeys.has(key), `Resource "${key}" (router ${known.label}) has no matrix test coverage — add one.`);
    }
  }

  // 4) And every matrix key must trace back to a tenant-scoped router
  //    (catches orphaned/renamed matrix entries).
  const tenantScopedKeys = new Set(KNOWN_ROUTERS.filter((k) => k.tenantScoped).flatMap((k) => k.resourceKeys));
  for (const key of matrixKeys) {
    assert.ok(tenantScopedKeys.has(key), `Matrix key "${key}" does not correspond to any router's declared resourceKeys — stale/orphaned entry.`);
  }
});
