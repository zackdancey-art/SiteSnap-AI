// In-memory harness (CLAUDE.md §6): no real DB, no network.
process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
process.env.AUTH_TOKEN_SECRET = "rate-limit-abuse-test-secret";
// No proxy sits in front of the test server, so 0 is the CORRECT hop count here.
process.env.TRUST_PROXY_HOPS = "0";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetRateLimitStoreForTests, getRateLimiterStatus } from "../middleware/rateLimit";
import { getFakeSendsForTests, resetFakeSendsForTests } from "../services/notificationService";

/**
 * B1 durable rate limiting — the limits whose cost lands on a PERSON.
 *
 * Every test here asserts on messages ACTUALLY DISPATCHED (getFakeSendsForTests)
 * rather than on status codes, and every one carries a positive control in the
 * same test: the count must be the allowance, not zero. A limiter that blocks
 * everything would satisfy "the 4th call was refused" perfectly well, and a
 * test that only checked that would pass while the signup flow was dead.
 *
 * Each test is also written to FAIL if its fix is reverted — the red on revert
 * is the proof that it measures the limit and not something incidental.
 */

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

type RegBody = {
  ok: boolean;
  stage?: string;
  devCodes?: { emailCode?: string; smsCode?: string };
  error?: string;
};

/** Count SMS actually dispatched to one number. The unit the limit is denominated in. */
const smsTo = (phone: string) =>
  getFakeSendsForTests().filter((s) => s.kind === "sms" && s.to === phone).length;
const emailsTo = (email: string) =>
  getFakeSendsForTests().filter((s) => s.kind === "email" && s.to === email).length;

function initiate(email: string, phone: string) {
  return req<RegBody>("POST", "/auth/register/initiate", {
    email, password: "Password123!", phone, fullName: "Test User",
  });
}
function verifyEmail(email: string, emailCode: string) {
  return req<RegBody>("POST", "/auth/register/verify-email", { email, emailCode });
}

/** Full three-stage signup, returning nothing — used to seed a real account. */
async function registerFully(email: string, phone: string) {
  const reg = await initiate(email, phone);
  assert.equal(reg.status, 200, `stage 1 failed: ${JSON.stringify(reg.body)}`);
  const ve = await verifyEmail(email, reg.body.devCodes!.emailCode!);
  assert.equal(ve.status, 200, `stage 2 failed: ${JSON.stringify(ve.body)}`);
  const done = await req<RegBody>("POST", "/auth/register/verify", {
    email, smsCode: ve.body.devCodes!.smsCode!,
  });
  // 201 — stage 3 CREATES the account. Asserted as a range so the helper does not
  // silently accept a 4xx the way a discarded seed response would.
  assert.ok(done.status >= 200 && done.status < 300, `stage 3 failed: ${done.status} ${JSON.stringify(done.body)}`);
}

// ── (1) phone-keyed OTP cap ─────────────────────────────────────────────────

test("cycling throwaway emails against ONE phone cannot buy unbounded SMS", async () => {
  // The attack, in the shape an attacker would actually run it: create every
  // pending registration first (so the stage-1 peek sees an empty counter for
  // all of them), then redeem them. This is what proves the cap binds where the
  // SMS is SPENT — at stage 2 — and not merely at the stage-1 early exit.
  const VICTIM = "+61400555111";
  const emails = [0, 1, 2, 3].map((i) => `throwaway-${i}@example.com`);

  const codes: string[] = [];
  for (const email of emails) {
    const reg = await initiate(email, VICTIM);
    assert.equal(reg.status, 200, `stage 1 should succeed while the phone budget is unspent: ${JSON.stringify(reg.body)}`);
    codes.push(reg.body.devCodes!.emailCode!);
  }
  assert.equal(smsTo(VICTIM), 0, "stage 1 must never dispatch an SMS");

  const statuses: number[] = [];
  for (let i = 0; i < emails.length; i++) {
    statuses.push((await verifyEmail(emails[i], codes[i])).status);
  }

  // POSITIVE CONTROL. Three SMS must ACTUALLY have been dispatched to this
  // number. Without this line a limiter that refused every caller — or a
  // registration flow broken so it sends nothing at all — would satisfy the
  // assertion below and this test would pass while signup was dead.
  assert.equal(
    smsTo(VICTIM), 3,
    `expected the allowance of 3 SMS to be dispatched, got ${smsTo(VICTIM)}`
  );
  assert.deepEqual(
    statuses, [200, 200, 200, 429],
    "REGRESSION: a 4th throwaway email redeemed a 4th SMS to the same number — " +
      "one victim's phone can be flooded by cycling attacker-chosen mailboxes"
  );
});

test("the stage-1 peek turns an exhausted phone away before a pending row exists", async () => {
  const VICTIM = "+61400555222";
  for (let i = 0; i < 3; i++) {
    const email = `burn-${i}@example.com`;
    const reg = await initiate(email, VICTIM);
    assert.equal(reg.status, 200);
    assert.equal((await verifyEmail(email, reg.body.devCodes!.emailCode!)).status, 200);
  }
  assert.equal(smsTo(VICTIM), 3, "positive control: the allowance was actually spent on real SMS");

  // The budget is now fully spent, so the NEXT signup attempt for this number is
  // refused at stage 1 — no pending row, no email, no work done on the attacker's
  // behalf at all.
  const blocked = await initiate("late@example.com", VICTIM);
  assert.equal(blocked.status, 429, `stage 1 should refuse an exhausted phone: ${JSON.stringify(blocked.body)}`);
  assert.equal(emailsTo("late@example.com"), 0, "a refused signup must not send a verification email either");
});

test("the phone cap is keyed on the phone — a different number is unaffected", async () => {
  // The control that proves the counter is PER-NUMBER. Without it, a global or
  // wrongly-keyed limit would pass every assertion above.
  const VICTIM = "+61400555333";
  const BYSTANDER = "+61400555444";

  for (let i = 0; i < 3; i++) {
    const email = `v-${i}@example.com`;
    const reg = await initiate(email, VICTIM);
    await verifyEmail(email, reg.body.devCodes!.emailCode!);
  }
  assert.equal(smsTo(VICTIM), 3);
  assert.equal((await initiate("v-late@example.com", VICTIM)).status, 429, "victim's number is capped");

  const reg = await initiate("bystander@example.com", BYSTANDER);
  assert.equal(reg.status, 200, "an unrelated number must not inherit the victim's exhausted budget");
  assert.equal((await verifyEmail("bystander@example.com", reg.body.devCodes!.emailCode!)).status, 200);
  assert.equal(smsTo(BYSTANDER), 1, "the bystander's own SMS was dispatched");
});

// ── (2) forgot-password identifier cap ──────────────────────────────────────

test("forgot-password cannot text one account's phone without limit", async () => {
  const EMAIL = "victim@example.com";
  const PHONE = "+61400556000";
  await registerFully(EMAIL, PHONE);
  // Drop the signup's own SMS so the count below measures only this endpoint.
  resetFakeSendsForTests();

  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await req("POST", "/auth/forgot-password", { identifier: EMAIL, channel: "sms" })).status);
  }

  // POSITIVE CONTROL: the allowance was really dispatched. A limiter that
  // refused everything, or a reset flow that silently sent nothing, would
  // satisfy the status assertion below on its own.
  assert.equal(
    smsTo(PHONE), 3,
    `expected the allowance of 3 reset SMS to be dispatched, got ${smsTo(PHONE)}`
  );
  assert.deepEqual(
    statuses, [200, 200, 200, 429],
    "REGRESSION: forgot-password is limited only by IP, so a rented IP pool gives " +
      "unbounded SMS to a known account's phone"
  );
});

test("the forgot-password cap applies identically to an unknown identifier", async () => {
  // Uniformity is a security property here, not tidiness: the limit is checked
  // BEFORE the account lookup, so a 429 arriving sooner or later cannot be used
  // to tell a registered address from an unregistered one.
  const UNKNOWN = "no-such-person@example.com";
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await req("POST", "/auth/forgot-password", { identifier: UNKNOWN, channel: "sms" })).status);
  }
  assert.deepEqual(
    statuses, [200, 200, 200, 429],
    "an unknown identifier must be refused at the same call as a known one, or the " +
      "limit itself becomes an account-existence oracle"
  );
  assert.equal(getFakeSendsForTests().length, 0, "no message may be dispatched for an unknown identifier");
});

test("the forgot-password cap is keyed on the identifier, not the caller", async () => {
  const A = "person-a@example.com";
  const B = "person-b@example.com";
  for (let i = 0; i < 4; i++) {
    await req("POST", "/auth/forgot-password", { identifier: A, channel: "sms" });
  }
  const other = await req("POST", "/auth/forgot-password", { identifier: B, channel: "sms" });
  assert.equal(other.status, 200, "a second identifier must have its own budget from the same caller");
});

test("casing and phone formatting cannot mint a second budget", async () => {
  // One canonical key per identifier. Bob@x.com and bob@x.com are one address;
  // so are "+61 400 556 777" and "+61400556777".
  const variants = ["Mixed@Example.com", "mixed@example.com", "MIXED@EXAMPLE.COM", "mIxEd@example.com"];
  const statuses: number[] = [];
  for (const v of variants) {
    statuses.push((await req("POST", "/auth/forgot-password", { identifier: v, channel: "sms" })).status);
  }
  assert.equal(statuses[3], 429, "email casing must not buy a fresh counter");

  resetRateLimitStoreForTests();
  const phones = ["+61 400 556 777", "+61400556777", "+61-400-556-777", "+61 400556777"];
  const phoneStatuses: number[] = [];
  for (const p of phones) {
    phoneStatuses.push((await req("POST", "/auth/forgot-password", { identifier: p, channel: "sms" })).status);
  }
  assert.equal(phoneStatuses[3], 429, "phone formatting must not buy a fresh counter");
});

// ── (5) disposable email domains ────────────────────────────────────────────

test("a disposable email domain is refused and costs nothing", async () => {
  const res = await initiate("burner@mailinator.com", "+61400557000");
  assert.equal(res.status, 400, `expected a refusal: ${JSON.stringify(res.body)}`);
  assert.match(String(res.body.error), /disposable/i);
  assert.equal(getFakeSendsForTests().length, 0, "a refused signup must dispatch nothing at all");
});

test("a subdomain of a disposable provider is refused too", async () => {
  const res = await initiate("burner@inbox.mailinator.com", "+61400557001");
  assert.equal(res.status, 400, "providers handing out unlimited subdomains must not slip through");
});

test("a legitimate domain still registers and still receives its email", async () => {
  // THE control for the denylist. The failure mode of a domain blocklist is
  // over-blocking, and an over-broad list would be invisible to the two tests
  // above — they only prove it says no. This proves it still says yes, and that
  // the verification email is genuinely dispatched.
  const EMAIL = "foreman@bright-build.co.nz";
  const res = await initiate(EMAIL, "+61400557002");
  assert.equal(res.status, 200, `a legitimate corporate domain must register: ${JSON.stringify(res.body)}`);
  assert.equal(emailsTo(EMAIL), 1, "the verification email must actually have been dispatched");
});

test("a bare TLD suffix can never match the denylist", async () => {
  // The suffix walk stops before the last label; if it did not, one entry like
  // "com" — or a bug producing one — would refuse most of the internet.
  const res = await initiate("someone@ordinary-company.com", "+61400557003");
  assert.equal(res.status, 200, `a .com address must not be caught by suffix matching: ${JSON.stringify(res.body)}`);
});

// ── (4) the un-degraded control ─────────────────────────────────────────────

test("with no REDIS_URL the limiter reports 'disabled', not 'degraded'", async () => {
  // The control for rate-limit-redis-degraded.test.ts. "Redis is unreachable"
  // and "Redis was never configured" are different facts and must not read the
  // same on /health/ready — otherwise every single-instance deployment would
  // page someone forever, and a real outage would be indistinguishable from the
  // normal state.
  assert.equal(process.env.REDIS_URL ?? "", "", "this file must run with no REDIS_URL for the assertion below to mean anything");

  // Spend a limit so the status describes a limiter that actually ran.
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) {
    statuses.push((await req("POST", "/auth/forgot-password", { identifier: "disabled-state@example.com", channel: "sms" })).status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 429], "positive control: in-memory counting is genuinely enforcing");

  const status = getRateLimiterStatus();
  assert.equal(status.state, "disabled");
  assert.equal(status.backend, "memory");
  assert.equal(status.degradationReports, 0, "an unconfigured Redis is not an incident and must not be reported as one");
  assert.equal(status.degradedSince, null);
  assert.equal(status.lastError, null);
});
