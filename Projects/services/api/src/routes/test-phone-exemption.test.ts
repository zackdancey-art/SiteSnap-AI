/**
 * `TEST_PHONE_NUMBERS` — the behaviour, driven over HTTP.
 *
 * `utils/phoneNumbers.test.ts` covers the list parsing. This file covers the
 * thing that was actually asked for: whether a second account can be created
 * on one phone number, and whether anything else moved when it could.
 *
 * Four cases, and the first is the one that makes the rest mean anything:
 *
 *   1. With the variable unset, the second registration on a phone is refused.
 *      Without this, every "it worked" below could be a test of a constraint
 *      that was never reachable in the in-memory harness.
 *   2. With the number listed, both registrations succeed.
 *   3. A listed number does not exempt an unlisted one.
 *   4. A listed number still has to answer both verification codes.
 */

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests } from "../storage/projectsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";

let server: http.Server;
let baseUrl: string;

async function req<T = unknown>(
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      `${baseUrl}/api${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
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

const PHONE = "+64211234567";
const PASSWORD = "Password123!!";

/**
 * Walk the full two-stage signup and return the final response.
 *
 * Deliberately NOT a `seed()`-style wrapper that asserts success: the point of
 * several of these tests is the final status, so each caller checks it.
 */
async function register(email: string, phone: string) {
  const regRes = await req<{ ok: boolean; devCodes?: { emailCode: string } }>(
    "POST", "/auth/register", { email, phone, fullName: "Test Person", password: PASSWORD }
  );
  if (regRes.status !== 200) return { stage: "initiate" as const, ...regRes };

  const emailCode = regRes.body.devCodes?.emailCode;
  assert.ok(emailCode, `no dev email code — the harness relies on the unconfigured-provider fallback: ${JSON.stringify(regRes.body)}`);

  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email, emailCode }
  );
  if (veRes.status !== 200) return { stage: "verify-email" as const, ...veRes };

  const smsCode = veRes.body.devCodes?.smsCode;
  assert.ok(smsCode, `no dev sms code: ${JSON.stringify(veRes.body)}`);

  const verRes = await req<{ ok?: boolean; error?: string }>(
    "POST", "/auth/register/verify", { email, smsCode }
  );
  return { stage: "verify" as const, ...verRes };
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
  await resetAuthStoreForTests();
  await resetProjectStoreForTests();
  await resetRateLimitStoreForTests();
  // ASSIGN, never delete: server.ts calls dotenv.config() on import, and
  // dotenv repopulates an absent key while leaving an empty one alone.
  process.env.TEST_PHONE_NUMBERS = "";
});

test("with the variable unset, a second account on one phone number is refused", async () => {
  const first = await register("owner-a@example.test", PHONE);
  assert.equal(first.status, 201, `first registration should succeed: ${JSON.stringify(first.body)}`);

  const second = await register("owner-b@example.test", PHONE);
  assert.equal(second.status, 409, `second registration should be refused: ${JSON.stringify(second.body)}`);
});

test("with the number listed, a second account on it is allowed", async () => {
  process.env.TEST_PHONE_NUMBERS = PHONE;

  const first = await register("owner-c@example.test", PHONE);
  assert.equal(first.status, 201, `first: ${JSON.stringify(first.body)}`);

  const second = await register("owner-d@example.test", PHONE);
  assert.equal(second.status, 201, `second should be allowed by the exemption: ${JSON.stringify(second.body)}`);

  // A third, because "two" could be an off-by-one somewhere rather than an
  // exemption. Several accounts is the actual requirement.
  const third = await register("owner-e@example.test", PHONE);
  assert.equal(third.status, 201, `third: ${JSON.stringify(third.body)}`);
});

test("a listed number does not exempt an unlisted one", async () => {
  process.env.TEST_PHONE_NUMBERS = PHONE;
  const other = "+64219999999";

  // Positive control, in this same test: the listed number IS exempt here.
  assert.equal((await register("owner-f@example.test", PHONE)).status, 201);
  assert.equal((await register("owner-g@example.test", PHONE)).status, 201);

  // The unlisted one keeps the existing rule exactly.
  assert.equal((await register("owner-h@example.test", other)).status, 201);
  const reuse = await register("owner-i@example.test", other);
  assert.equal(reuse.status, 409, `an unlisted number must still be unique: ${JSON.stringify(reuse.body)}`);
});

test("a listed number still has to answer both verification codes", async () => {
  process.env.TEST_PHONE_NUMBERS = PHONE;

  const regRes = await req<{ devCodes?: { emailCode: string } }>(
    "POST", "/auth/register", { email: "owner-j@example.test", phone: PHONE, fullName: "Test Person", password: PASSWORD }
  );
  assert.equal(regRes.status, 200);
  const emailCode = regRes.body.devCodes?.emailCode;
  assert.ok(emailCode);

  // A wrong email code is still refused — the exemption is not a way past stage one.
  const badEmail = await req("POST", "/auth/register/verify-email", { email: "owner-j@example.test", emailCode: "000000" });
  assert.ok(badEmail.status >= 400, `a wrong email code must be refused, got ${badEmail.status}`);

  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email: "owner-j@example.test", emailCode }
  );
  assert.equal(veRes.status, 200, `the correct email code must still work: ${JSON.stringify(veRes.body)}`);
  const smsCode = veRes.body.devCodes?.smsCode;
  assert.ok(smsCode);

  // And a wrong SMS code is still refused — nor past stage two.
  const badSms = await req("POST", "/auth/register/verify", { email: "owner-j@example.test", smsCode: "000000" });
  assert.ok(badSms.status >= 400, `a wrong sms code must be refused, got ${badSms.status}`);

  // Positive control for both negatives: the real codes do complete the signup,
  // so the refusals above are the guard working rather than the flow being broken.
  const ok = await req("POST", "/auth/register/verify", { email: "owner-j@example.test", smsCode });
  assert.equal(ok.status, 201, `the correct codes must complete signup: ${JSON.stringify(ok.body)}`);
});
