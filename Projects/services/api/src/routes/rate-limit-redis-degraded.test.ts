process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
process.env.AUTH_TOKEN_SECRET = "redis-degraded-test-secret";
process.env.TRUST_PROXY_HOPS = "0";
// Port 1 is reserved and nothing listens there, so every connection attempt is
// refused immediately and deterministically — no timeout, no flake, no network.
// The password is here to prove it never reaches a log or a Sentry event.
process.env.REDIS_URL = "redis://admin:hunter2@127.0.0.1:1";
// Small so the test spends three calls, not thirty.
process.env.RATE_LIMIT_FORGOT_PASSWORD_PER_IDENTIFIER = "2";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import {
  resetRateLimitStoreForTests,
  getRateLimiterStatus,
  redactRedisUrl,
} from "../middleware/rateLimit";
import { resetFakeSendsForTests } from "../services/notificationService";

/**
 * What happens when Redis is configured but unreachable.
 *
 * The decision here is deliberate and worth restating: the limiter FALLS BACK to
 * in-memory counting rather than failing the request. On a login path,
 * availability beats perfect counting — a Redis outage must not lock every user
 * out of the product.
 *
 * The cost of that decision is that a degraded limiter looks exactly like a
 * healthy one from the outside. Before B1 that was the whole story: the fallback
 * was silent, and you would discover it on a bill. So the fallback now has to be
 * LOUD, and "loud" is a testable property:
 *   - counting keeps working (availability), and
 *   - the degradation is reported once, not per request (a usable signal), and
 *   - /health/ready tells you the truth about which backend is live, and
 *   - the credentials in REDIS_URL never appear in any of it.
 */

let server: http.Server;
let baseUrl: string;

async function req<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
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
after(async () => {
  // Also hangs up the retrying Redis client — without this the process stays
  // alive on ioredis's reconnect timer and the run never finishes.
  resetRateLimitStoreForTests();
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});
beforeEach(async () => {
  await resetAuthStoreForTests();
  resetRateLimitStoreForTests();
  resetFakeSendsForTests();
});

test("an unreachable Redis does not take the login path down with it", async () => {
  const statuses: number[] = [];
  for (let i = 0; i < 3; i++) {
    statuses.push((await req("POST", "/auth/forgot-password", {
      identifier: "degraded-test@example.com", channel: "sms",
    })).status);
  }

  // POSITIVE CONTROL, and the point of the whole design: with Redis dead the
  // endpoint still SERVES. Not a 500, not a hang — the offline queue is
  // disabled precisely so a dead Redis fails fast into memory instead of
  // queueing commands and stalling the request.
  assert.equal(statuses[0], 200, "a Redis outage must not break the endpoint");
  assert.equal(statuses[1], 200, "a Redis outage must not break the endpoint");

  // And counting still HAPPENS. Falling back to a backend that doesn't count
  // would be the same unbounded hole with extra steps.
  assert.equal(statuses[2], 429, `the in-memory fallback must still enforce the limit, got ${statuses}`);
});

test("the degradation is announced once, not once per request", async () => {
  // What this proves and what it does not: it proves the announcement BRANCH —
  // the console.error and the Sentry.captureMessage that sit together inside
  // markDegraded's transition guard — executed exactly once across five
  // fallbacks. It does not prove Sentry delivered anything, and it cannot:
  // instrument.ts deliberately never calls Sentry.init() in test mode, so
  // captureMessage is a no-op, and @sentry/node exports it as a
  // non-configurable getter that cannot be stubbed. The delivery itself is a
  // one-line call reviewable by eye; the ONCE is the part that needed a test.
  for (let i = 0; i < 5; i++) {
    await req("POST", "/auth/forgot-password", { identifier: `noisy-${i}@example.com`, channel: "sms" });
  }
  const status = getRateLimiterStatus();

  // POSITIVE CONTROL: it announced at all. A report count of 0 satisfies "not
  // once per request" perfectly, and that silent fallback is the exact bug B1
  // exists to remove.
  assert.ok(status.degradationReports >= 1, "the fallback must announce itself — a silent degradation is the bug");
  assert.ok(status.fallbackCount >= 5, `positive control: all 5 requests really did fall back, got ${status.fallbackCount}`);
  assert.equal(
    status.degradationReports, 1,
    `the TRANSITION is the event, not each request: ${status.fallbackCount} fallbacks produced ` +
      `${status.degradationReports} announcements. A per-request report would bury the signal and burn ` +
      `the Sentry quota during exactly the incident you need it for.`
  );
  assert.match(String(status.lastError), /.+/, "the reason must be recorded, or the alert says nothing actionable");
});

test("the Redis password never reaches the recorded error or /health/ready", async () => {
  await req("POST", "/auth/forgot-password", { identifier: "secret-check@example.com", channel: "sms" });

  const health = await req<{ rateLimiter?: unknown }>("GET", "/health/ready");
  const status = getRateLimiterStatus();
  // lastError is the string that goes into both the log line and the Sentry
  // message, and /health/ready is unauthenticated — so these are the two places
  // a credential would surface.
  const exposed = JSON.stringify({ status, health: health.body });

  assert.ok(status.degradationReports >= 1, "positive control: something was actually reported to inspect");
  assert.ok(health.body.rateLimiter, "positive control: /health/ready actually carries limiter state to inspect");
  assert.ok(
    !exposed.includes("hunter2"),
    `the REDIS_URL password leaked into an error report or a health response: ${exposed}`
  );
});

test("redactRedisUrl keeps the host and drops the credentials", () => {
  const redacted = redactRedisUrl("redis://admin:hunter2@redis.internal:6379");
  assert.ok(!redacted.includes("hunter2"), "the password must be redacted");
  assert.ok(!redacted.includes("admin"), "the username must be redacted");
  // Positive control: redaction that returned "" would pass both lines above
  // while destroying the only useful part of the boot log.
  assert.ok(redacted.includes("redis.internal"), "the host must survive — it is the whole point of the log line");
  assert.ok(redacted.includes("6379"), "the port must survive");
  assert.equal(redactRedisUrl("not a url"), "<unparseable REDIS_URL>");
});

test("/health/ready reports the backend actually in use, not the one configured", async () => {
  const served = await req("POST", "/auth/forgot-password", { identifier: "health-check@example.com", channel: "sms" });
  // Positive control: the request was genuinely handled, so the state below
  // describes a limiter that actually ran rather than one that never executed.
  assert.equal(served.status, 200, "the request must be served while degraded");

  const res = await req<{ rateLimiter: { backend: string; state: string; degradedSince: string | null; fallbackCount: number; degradationReports: number } }>(
    "GET", "/health/ready"
  );
  const rl = res.body.rateLimiter;

  // REDIS_URL is set, so a status derived from configuration would say "redis".
  // It must say what is TRUE, which is that counting is happening in process
  // memory and will be lost on the next deploy.
  assert.equal(rl.backend, "memory", "REDIS_URL is set but unreachable — the report must follow reality, not config");
  assert.equal(rl.state, "degraded");
  assert.ok(rl.fallbackCount > 0, "positive control: the fallback counter registered a non-zero value");
  assert.ok(rl.degradedSince, "the report must say WHEN, so a bill can be reconciled against it");

  // Degraded counting is not an outage. Locking the whole service out over a
  // rate limiter would be a worse failure than the one it reports.
  assert.notEqual(getRateLimiterStatus().state, "connected");
});
