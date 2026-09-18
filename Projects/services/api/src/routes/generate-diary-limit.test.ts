process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
process.env.AUTH_TOKEN_SECRET = "generate-diary-limit-test-secret";
process.env.TRUST_PROXY_HOPS = "0";
// Set BEFORE the imports below, because middleware/rateLimit reads LIMITS at
// module load. Verified against the CJS emit in dist/ — tsc preserves this
// ordering. 2 keeps the test short; the production default is 30/hour.
process.env.RATE_LIMIT_GENERATE_DIARY_PER_COMPANY = "2";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetRateLimitStoreForTests, LIMITS } from "../middleware/rateLimit";
import { resetFakeSendsForTests } from "../services/notificationService";

/**
 * /generate-diary spends OpenAI credit on every call, and until B1 it was keyed
 * on the CALLER'S IP. That was wrong in both directions: a whole crew behind one
 * site router shared a single budget, while an attacker with one account and a
 * handful of proxies had no effective limit at all on a paid endpoint.
 *
 * The spend is authenticated, so the payer is known. These tests prove the
 * counter now follows the company.
 */

let server: http.Server;
let baseUrl: string;

async function req<T = unknown>(
  method: string, path: string, body?: unknown, token?: string
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
        res.on("data", (c: string) => (data += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as T }); }
          catch { reject(new Error(`Non-JSON (${res.statusCode}): ${data}`)); }
        });
      }
    );
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

type RegBody = { devCodes?: { emailCode?: string; smsCode?: string }; token?: string };

/** Registering creates a company with this user as owner — one call, one tenant. */
async function registerCompany(email: string, phone: string): Promise<string> {
  const reg = await req<RegBody>("POST", "/auth/register/initiate", {
    email, password: "Password123!", phone, fullName: "Owner",
  });
  assert.equal(reg.status, 200, `stage 1: ${JSON.stringify(reg.body)}`);
  const ve = await req<RegBody>("POST", "/auth/register/verify-email", {
    email, emailCode: reg.body.devCodes!.emailCode!,
  });
  assert.equal(ve.status, 200, `stage 2: ${JSON.stringify(ve.body)}`);
  const done = await req<RegBody>("POST", "/auth/register/verify", {
    email, smsCode: ve.body.devCodes!.smsCode!,
  });
  assert.ok(done.status >= 200 && done.status < 300, `stage 3: ${JSON.stringify(done.body)}`);
  assert.ok(done.body.token, "registration must return a token");
  return done.body.token!;
}

const DIARY_BODY = {
  period: "monthly" as const,
  site: { name: "Test Site" },
  entries: [{ date: new Date().toISOString().slice(0, 10), notes: "Poured slab.", crewCount: "3" }],
};

type DiaryRes = { success?: boolean; diary?: unknown; error?: string };

test("the limit is 2 here because the env var says so, not because of a code default", () => {
  // If this drifts, every count below is measuring something else. The
  // production default is 30/hour; the override proves it is configurable
  // without a deploy, which is what makes a bad threshold survivable.
  assert.equal(LIMITS.generateDiaryPerCompany.max, 2);
  assert.equal(LIMITS.generateDiaryPerCompany.windowMs, 60 * 60 * 1000);
});

test("one company hammering /generate-diary cannot spend past its own budget", async () => {
  const token = await registerCompany("owner-a@example.com", "+61400558001");

  const first = await req<DiaryRes>("POST", "/generate-diary", DIARY_BODY, token);
  const second = await req<DiaryRes>("POST", "/generate-diary", DIARY_BODY, token);
  const third = await req<DiaryRes>("POST", "/generate-diary", DIARY_BODY, token);

  // POSITIVE CONTROL: the allowance must actually produce diaries. A limiter
  // that refused every call, or a handler broken so it returned nothing, would
  // satisfy the 429 assertion below on its own and this test would pass while
  // the feature was dead.
  assert.equal(first.status, 200, `call 1 must succeed: ${JSON.stringify(first.body)}`);
  assert.ok(first.body.diary, "call 1 must return a diary, not just a 200");
  assert.equal(second.status, 200, `call 2 must succeed: ${JSON.stringify(second.body)}`);
  assert.ok(second.body.diary, "call 2 must return a diary");

  assert.equal(third.status, 429, `call 3 must be refused: ${JSON.stringify(third.body)}`);
  assert.equal(third.body.diary, undefined, "a refused call must not reach the generator");
});

test("the budget follows the company, not the IP the request came from", async () => {
  // THE keying proof. Both companies call from 127.0.0.1 — under the old per-IP
  // key they shared one bucket, so B would be refused for A's spending. This
  // assertion is simultaneously the keying proof and the positive control: it
  // can only pass if a second tenant's call genuinely reaches the generator.
  const tokenA = await registerCompany("owner-a@example.com", "+61400558002");
  const tokenB = await registerCompany("owner-b@example.com", "+61400558003");

  for (let i = 0; i < 3; i++) await req("POST", "/generate-diary", DIARY_BODY, tokenA);
  const exhausted = await req<DiaryRes>("POST", "/generate-diary", DIARY_BODY, tokenA);
  assert.equal(exhausted.status, 429, "company A must be out of budget");

  const other = await req<DiaryRes>("POST", "/generate-diary", DIARY_BODY, tokenB);
  assert.equal(
    other.status, 200,
    `REGRESSION: company B was refused for company A's spending — the limit is still ` +
      `keyed on the shared IP, so one abusive tenant can deny the feature to everyone ` +
      `behind the same address: ${JSON.stringify(other.body)}`
  );
  assert.ok(other.body.diary, "company B must receive a real diary, not an empty 200");
});

test("an unauthenticated caller is refused before any budget is touched", async () => {
  // The limiter keys on the authenticated actor, so it fails CLOSED when there
  // is no actor: no companyId means no request, never an unlimited one.
  const res = await req<DiaryRes>("POST", "/generate-diary", DIARY_BODY);
  assert.equal(res.status, 401, `expected 401, got ${res.status}`);
  assert.equal(res.body.diary, undefined);
});
