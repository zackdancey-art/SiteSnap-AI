/**
 * The rank gate on voiding an inspection signature. AUDIT L91.
 *
 * Until the line this suite defends existed, the void route carried only
 * FIELD_ACCESS (`[requireAuth]` — identity, not rank), so any crew member with
 * a login could retract any signature on any inspection in their own company.
 * A signature is the claim that a named person inspected a named thing on a
 * date, on a document retained for seven years; voiding it retracts that claim.
 *
 * WHY THIS SUITE IS IN-MEMORY, against the standing "new permission tests are
 * DB-gated" rule:
 *
 *   The authoritative refusal for this route is DB-gated — it is a row in the
 *   refusal table in `crew-permissions-db.test.ts`, which runs against Postgres
 *   with a real signature to void. That is where the rule points and that is
 *   where it went.
 *
 *   This suite exists *as well* because there is no Postgres in the environment
 *   this gate was written in, so the DB row could not be executed, let alone
 *   red-on-reverted, before the branch was pushed. A rank gate is middleware:
 *   it refuses before any store is reached, which is precisely why the refusal
 *   half is provable without a database. The manager half cannot reach a real
 *   signature here, so it asserts the weaker, still-sufficient fact that the
 *   manager got *past the gate* and was refused by the store instead (404,
 *   "Signature not found.") rather than by the gate (403). The two assertions
 *   together distinguish "the gate refuses crew" from "the route refuses
 *   everyone" and from "the route is gone" — which a 403-only test cannot.
 *
 * The third assertion in the first test is the one that fails if someone later
 * moves this gate onto the router instead of the route: crew must still be able
 * to read inspections. Everything else on this router is identity-only on
 * purpose (AUDIT L66), and a router-wide manager gate would lock every crew
 * member out of the capture app while leaving the refusal assertion green.
 */

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { createUser, resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests } from "../storage/projectsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import { hashPassword } from "../utils/password";

let server: http.Server;
let baseUrl: string;

const COMPANY = "void-gate-co";
const PASSWORD = "Password123!!";
const CREW = "crew@void-gate.test";
const VIEWER = "viewer@void-gate.test";
const MANAGER = "manager@void-gate.test";
const OWNER = "owner@void-gate.test";

/** The route under test, with ids that deliberately do not exist. */
const VOID_PATH = "/inspections/no-such-inspection/signatures/no-such-signature/void";
const VOID_BODY = { reason: "signed by the wrong person" };

let _phoneSeq = 0;
function nextPhone() { return `+615${String(++_phoneSeq).padStart(8, "0")}`; }

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

/**
 * A real token off the real mint path. Checked, so a login that starts failing
 * fails here rather than turning every refusal below it into a test of nothing.
 */
async function login(email: string): Promise<string> {
  const res = await req<{ token?: string }>("POST", "/auth/login", { email, password: PASSWORD });
  assert.equal(res.status, 200, `login ${email} failed: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.token, `login ${email} returned no token`);
  return res.body.token as string;
}

/**
 * Legacy roles are deliberately crossed against company roles throughout: the
 * crew member is a legacy "admin" and the manager a legacy "worker". The legacy
 * role is deprecated (CLAUDE.md §3) and must not be what decides this, and a
 * seed that set both consistently could not tell which one was read.
 */
async function seedUsers(): Promise<void> {
  const hash = await hashPassword(PASSWORD);
  await createUser(CREW, hash, nextPhone(), "Void Gate Crew", "admin", COMPANY, "crew");
  await createUser(VIEWER, hash, nextPhone(), "Void Gate Viewer", "admin", COMPANY, "viewer");
  await createUser(MANAGER, hash, nextPhone(), "Void Gate Manager", "worker", COMPANY, "manager");
  await createUser(OWNER, hash, nextPhone(), "Void Gate Owner", "worker", COMPANY, "owner");
}

before(async () => {
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(async () => {
  resetAuthStoreForTests();
  resetProjectStoreForTests();
  resetRateLimitStoreForTests();
  await seedUsers();
});

test("crew are refused at the gate, a manager gets past it, and crew keep the rest of the router", async () => {
  const crewToken = await login(CREW);
  const managerToken = await login(MANAGER);

  // (1) The refusal. 403 from the gate, with the gate's own message — not the
  // 404 an absent route would give, and not the 400 a bad payload would.
  const refused = await req<{ error?: string }>("POST", VOID_PATH, VOID_BODY, crewToken);
  assert.equal(refused.status, 403, `crew were allowed to void a signature: ${JSON.stringify(refused.body)}`);
  assert.equal(refused.body.error, "Insufficient permissions.");

  // (2) The control, on the same endpoint with the same payload. A manager is
  // refused too — but by the store, for naming a signature that does not
  // exist, which is only reachable *after* the gate has passed them. Without
  // this, (1) reads green against a route that refuses everybody, and equally
  // green against a route that has been deleted.
  const allowedThrough = await req<{ error?: string }>("POST", VOID_PATH, VOID_BODY, managerToken);
  assert.notEqual(allowedThrough.status, 403, "a manager was refused by the rank gate");
  assert.equal(allowedThrough.status, 404, `manager response was not the store's: ${JSON.stringify(allowedThrough.body)}`);
  assert.equal(allowedThrough.body.error, "Signature not found.");

  // (3) The gate is on the route, not the router. Crew do the inspecting; this
  // branch added rank to exactly one operation and must not have added it to
  // the surrounding ones.
  const stillReadable = await req<{ inspections?: unknown[] }>("GET", "/inspections", undefined, crewToken);
  assert.equal(stillReadable.status, 200, `crew lost read access to inspections: ${JSON.stringify(stillReadable.body)}`);
  assert.ok(Array.isArray(stillReadable.body.inspections), "crew read did not return an inspections array");
});

test("the gate is a rank, so viewer is refused as well and owner passes as well", async () => {
  const viewerToken = await login(VIEWER);
  const ownerToken = await login(OWNER);

  // A viewer outranks crew and still cannot void: this is requireAtLeast,
  // not a crew-shaped exclusion list that the next role added would slip past.
  const viewer = await req<{ error?: string }>("POST", VOID_PATH, VOID_BODY, viewerToken);
  assert.equal(viewer.status, 403, `a viewer was allowed to void a signature: ${JSON.stringify(viewer.body)}`);
  assert.equal(viewer.body.error, "Insufficient permissions.");

  // And the rank is a floor, not an equality: owner is above manager and must
  // also get through to the store.
  const owner = await req<{ error?: string }>("POST", VOID_PATH, VOID_BODY, ownerToken);
  assert.notEqual(owner.status, 403, "an owner was refused by the rank gate");
  assert.equal(owner.status, 404, `owner response was not the store's: ${JSON.stringify(owner.body)}`);
  assert.equal(owner.body.error, "Signature not found.");
});

test("the gate runs before the payload check, so a crew member learns nothing from a malformed body", async () => {
  const crewToken = await login(CREW);
  const managerToken = await login(MANAGER);

  // Order matters for what the refusal discloses. An empty body is invalid
  // against SignatureVoidSchema; crew must still see 403 rather than the 400
  // that would confirm the route exists and tell them the payload shape.
  const crewBadBody = await req<{ error?: string }>("POST", VOID_PATH, {}, crewToken);
  assert.equal(crewBadBody.status, 403, `the payload check ran before the gate: ${JSON.stringify(crewBadBody.body)}`);
  assert.equal(crewBadBody.body.error, "Insufficient permissions.");

  // The control: the same empty body from a manager DOES reach the payload
  // check and is refused there. That is what proves the 403 above came from the
  // gate's position rather than from the body being rejected for everyone.
  const managerBadBody = await req<{ error?: string }>("POST", VOID_PATH, {}, managerToken);
  assert.equal(managerBadBody.status, 400, `a manager's malformed body was not refused by the schema: ${JSON.stringify(managerBadBody.body)}`);
  assert.equal(managerBadBody.body.error, "Invalid void payload.");
});
