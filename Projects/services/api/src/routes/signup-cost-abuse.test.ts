// In-memory harness (CLAUDE.md §6): no real DB, no network.
process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
process.env.AUTH_TOKEN_SECRET = "signup-cost-abuse-test-secret";
// No proxy sits in front of the test server, so 0 is the CORRECT hop count here
// — the same way 2 is correct on Render. The spoofing test below asserts that a
// correctly-set hop count cannot be moved by a forged header; it is not
// asserting anything about the number itself.
process.env.TRUST_PROXY_HOPS = "0";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import { getFakeSendsForTests, resetFakeSendsForTests } from "../services/notificationService";

// B0 cost-abuse guards. Every test here is written to FAIL if the fix is
// reverted — that is the point of the file, so keep the assertions on observed
// side effects (messages actually dispatched) rather than on status codes alone.
//
// Two properties:
//  (1) An unauthenticated caller cannot cause an SMS. Registration used to send
//      an email AND an SMS in one anonymous POST, which made a stranger's phone
//      number a free target for flooding — a security problem, not just a bill.
//  (2) A forged X-Forwarded-For cannot move req.ip, so per-IP limits actually
//      bind. getClientIp() used to read the header's first entry directly.

let server: http.Server;
let baseUrl: string;

async function req<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
        ...(payload ? { "Content-Length": Buffer.byteLength(payload).toString() } : {}),
      },
    };
    const r = http.request(`${baseUrl}/api${path}`, options, (res) => {
      let data = "";
      res.on("data", (c: string) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as T }); }
        catch { reject(new Error(`Non-JSON (${res.statusCode}): ${data}`)); }
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

before(async () => {
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))); });
beforeEach(async () => {
  await resetAuthStoreForTests();
  resetRateLimitStoreForTests();
  resetFakeSendsForTests();
});

const smsCount = () => getFakeSendsForTests().filter((s) => s.kind === "sms").length;
const emailCount = () => getFakeSendsForTests().filter((s) => s.kind === "email").length;

type RegBody = { ok: boolean; stage?: string; devCodes?: { emailCode?: string; smsCode?: string }; error?: string };

async function initiate(email: string, phone = "+61400000001") {
  return req<RegBody>("POST", "/auth/register/initiate", {
    email, password: "Password123!", phone, fullName: "Test User",
  });
}

// ── (1) the SMS gate ────────────────────────────────────────────────────────

test("registration sends an email and NO sms — an anonymous POST cannot cost a Twilio message", async () => {
  const reg = await initiate("stage-a@example.com");
  assert.equal(reg.status, 200);
  assert.equal(reg.body.stage, "email");

  assert.equal(emailCount(), 1, "expected exactly one verification email");
  assert.equal(
    smsCount(), 0,
    "REGRESSION: registration dispatched an SMS before the mailbox was proven — " +
      "an unauthenticated caller can bill Twilio and flood an arbitrary phone number"
  );
});

test("the sms is dispatched only once the email code is verified", async () => {
  const reg = await initiate("stage-b@example.com");
  const emailCode = reg.body.devCodes!.emailCode!;
  assert.equal(smsCount(), 0);

  const ve = await req<RegBody>("POST", "/auth/register/verify-email", {
    email: "stage-b@example.com", emailCode,
  });
  assert.equal(ve.status, 200, JSON.stringify(ve.body));
  assert.equal(ve.body.stage, "sms");
  assert.equal(smsCount(), 1, "expected exactly one verification SMS after email verification");
});

test("a wrong email code sends no sms", async () => {
  await initiate("stage-c@example.com");
  const ve = await req<RegBody>("POST", "/auth/register/verify-email", {
    email: "stage-c@example.com", emailCode: "000000",
  });
  assert.equal(ve.status, 401);
  assert.equal(smsCount(), 0, "a failed email verification must not dispatch an SMS");
});

test("the email stage cannot be skipped — final verify fails closed with no sms code on the row", async () => {
  await initiate("stage-d@example.com");
  const verify = await req<{ error?: string; stage?: string }>("POST", "/auth/register/verify", {
    email: "stage-d@example.com", smsCode: "123456",
  });
  assert.equal(verify.status, 409, JSON.stringify(verify.body));
  assert.equal(verify.body.stage, "email");
  assert.equal(smsCount(), 0);
});

test("re-verifying resends the same code under a cooldown rather than minting another", async () => {
  const reg = await initiate("stage-e@example.com");
  const emailCode = reg.body.devCodes!.emailCode!;

  const first = await req<RegBody>("POST", "/auth/register/verify-email", { email: "stage-e@example.com", emailCode });
  assert.equal(first.status, 200);
  assert.equal(smsCount(), 1);

  const second = await req<{ status: number; error?: string; retryAfterSeconds?: number }>(
    "POST", "/auth/register/verify-email", { email: "stage-e@example.com", emailCode }
  );
  assert.equal(second.status, 429, JSON.stringify(second.body));
  assert.equal(smsCount(), 1, "the cooldown must prevent a second SMS for the same pending signup");
});

test("re-initiating clears verified state, so a verified signup cannot be re-pointed at a new phone for a free sms", async () => {
  const first = await initiate("stage-f@example.com", "+61400000111");
  const emailCode = first.body.devCodes!.emailCode!;
  await req<RegBody>("POST", "/auth/register/verify-email", { email: "stage-f@example.com", emailCode });
  assert.equal(smsCount(), 1);

  // Same email, different phone — must return to the email stage, not send.
  await initiate("stage-f@example.com", "+61400000222");
  assert.equal(smsCount(), 1, "re-initiating must not dispatch an SMS to the newly supplied number");

  const stale = await req<{ error?: string }>("POST", "/auth/register/verify", {
    email: "stage-f@example.com", smsCode: "123456",
  });
  assert.equal(stale.status, 409, "the previously verified state must not survive a re-initiate");
});

// ── (2) the per-IP limit actually binds ─────────────────────────────────────

test("a forged X-Forwarded-For cannot buy a fresh rate-limit bucket", async () => {
  // forgot-password is IP-limited at 8/10min and dispatches nothing for an
  // unknown account, so this measures the limiter and only the limiter.
  const max = 8;
  const statuses: number[] = [];
  for (let i = 0; i < max + 1; i++) {
    const res = await req<{ ok?: boolean; error?: string }>(
      "POST", "/auth/forgot-password",
      { identifier: `nobody-${i}@example.com` },
      { "X-Forwarded-For": `203.0.113.${i + 1}` } // a different "client" each time
    );
    statuses.push(res.status);
  }

  assert.deepEqual(
    statuses.slice(0, max), Array(max).fill(200),
    `the first ${max} requests should be allowed, got ${statuses.join(",")}`
  );
  assert.equal(
    statuses[max], 429,
    "REGRESSION: varying X-Forwarded-For produced a fresh counter — every per-IP " +
      "limit in the app is bypassable by setting one header"
  );
});

test("the limiter still blocks when no forwarding header is sent at all", async () => {
  const max = 8;
  let last = 0;
  for (let i = 0; i < max + 1; i++) {
    const res = await req("POST", "/auth/forgot-password", { identifier: `plain-${i}@example.com` });
    last = res.status;
  }
  assert.equal(last, 429);
});
