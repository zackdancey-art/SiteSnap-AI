process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
process.env.AUTH_TOKEN_SECRET = "redis-live-test-secret";
process.env.TRUST_PROXY_HOPS = "0";
// The suite reads REDIS_TEST_URL and copies it into REDIS_URL itself, rather
// than allowlisting REDIS_URL in test-setup.ts. That keeps a developer's .env
// from ever pointing the suite at a real instance: only a var named for testing
// reaches here, and only this file turns it into the one the app reads.
if (process.env.REDIS_TEST_URL) process.env.REDIS_URL = process.env.REDIS_TEST_URL;
process.env.RATE_LIMIT_FORGOT_PASSWORD_PER_IDENTIFIER = "3";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetRateLimitStoreForTests, getRateLimiterStatus } from "../middleware/rateLimit";
import { resetFakeSendsForTests } from "../services/notificationService";

/**
 * The REACHABLE-Redis path — the one a working production service actually takes.
 *
 * This file exists because its absence hid a real defect. rate-limit-redis-degraded
 * points at an unreachable Redis, which never becomes ready, so the
 * connect-then-become-ready sequence had no coverage at all: the failure mode was
 * proved and the success mode was not. What that missed was the limiter setting
 * state to "connected" the instant the client object was CONSTRUCTED. With
 * enableOfflineQueue disabled, commands issued before the socket is ready are
 * rejected, so every single boot fell back to memory and fired a Sentry
 * degradation alert that resolved milliseconds later — giving degradationReports
 * a floor of 1 per deploy and destroying its meaning as an incident signal.
 *
 * Requires a real Redis at REDIS_TEST_URL. CI provides one as a service
 * container (see .github/workflows/ci.yml); locally, run:
 *   docker run -p 6379:6379 redis:7 && REDIS_TEST_URL=redis://localhost:6379 pnpm test
 */

const REDIS_URL = process.env.REDIS_TEST_URL;
// A skip is a real cost and this one is declared, not accidental: without a
// Redis there is nothing to test, and pretending otherwise would be the vacuous
// pass this whole body of work exists to remove.
const skip = REDIS_URL ? false : "REDIS_TEST_URL is not set — no Redis to test against";

type RedisLike = {
  get(k: string): Promise<string | null>;
  keys(p: string): Promise<string[]>;
  del(...k: string[]): Promise<number>;
  quit(): Promise<unknown>;
};

let server: http.Server;
let baseUrl: string;
let probe: RedisLike | null = null;

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

/** Poll until the limiter reaches `target`, or fail with what it reached instead. */
async function waitForState(target: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = getRateLimiterStatus();
    if (s.state === target) return;
    if (Date.now() > deadline) {
      throw new Error(`limiter never reached "${target}": ${JSON.stringify(s)}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

before(async () => {
  if (skip) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { default: Redis } = require("ioredis") as { default: new (u: string) => RedisLike };
  probe = new Redis(REDIS_URL!);
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  if (skip) return;
  resetRateLimitStoreForTests();
  if (probe) await probe.quit();
  await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res())));
});

beforeEach(async () => {
  if (skip) return;
  await resetAuthStoreForTests();
  // Redis OUTLIVES the process, so clearing the in-memory map is not enough:
  // counters written by the previous test are still there and would make the
  // next one start mid-budget. Scoped to rl:* rather than FLUSHDB so pointing
  // REDIS_TEST_URL at a shared local Redis cannot destroy anything else.
  const stale = await probe!.keys("rl:*");
  if (stale.length > 0) await probe!.del(...stale);
  resetRateLimitStoreForTests();
  resetFakeSendsForTests();
});

const forgot = (identifier: string) =>
  req("POST", "/auth/forgot-password", { identifier, channel: "sms" });

test("a boot against a reachable Redis raises no degradation alert", { skip }, async () => {
  // THE regression test. Before the fix this produced degradationReports >= 1
  // on every run, because the first request was issued against a socket that
  // was not ready yet and the limiter had already declared itself connected.
  await forgot("boot-alert@example.com");
  await waitForState("connected");

  const status = getRateLimiterStatus();
  assert.equal(
    status.degradationReports, 0,
    `a normal boot announced ${status.degradationReports} degradation(s). Every deploy would ` +
      `page on a Redis that is working, and degradationReports would have a floor of 1 per ` +
      `boot — which is what made it useless as an incident signal.`
  );
  assert.equal(status.degradedSince, null, "a working boot is not an incident");
  // POSITIVE CONTROL: the limiter really did run and really is on Redis. Without
  // this, a limiter that never executed at all would report zero alerts too.
  assert.equal(status.backend, "redis", "the counters must genuinely be in Redis, not memory");
  assert.equal(status.state, "connected");
});

test("the counter is really in Redis, at the value the endpoint produced", async (t) => {
  if (skip) return t.skip(skip as string);
  // Reading the key back through a SEPARATE client is what distinguishes
  // "counted in Redis" from "counted in memory while Redis happened to be up".
  // It is also the property that makes the limit survive a deploy at all.
  await forgot("in-redis@example.com");
  await waitForState("connected");
  await forgot("in-redis@example.com");
  await forgot("in-redis@example.com");

  const key = "rl:forgot-password:identifier:in-redis@example.com";
  const value = await probe!.get(key);
  assert.equal(value, "3", `expected the shared counter at ${key} to read 3, got ${value}`);
});

test("the limit binds through Redis, and the allowance is really served", { skip }, async () => {
  await forgot("binds@example.com");
  await waitForState("connected");

  const statuses = [200];
  for (let i = 0; i < 3; i++) statuses.push((await forgot("binds@example.com")).status);

  // Positive control and limit in one line: the first three are served, the
  // fourth is refused. A limiter that refused everything, or one that counted
  // nothing, fails this.
  assert.deepEqual(statuses, [200, 200, 200, 429], `got ${JSON.stringify(statuses)}`);
  assert.equal(getRateLimiterStatus().backend, "redis");
  assert.equal(getRateLimiterStatus().degradationReports, 0, "enforcing must not require degrading");
});

test("state is never 'connected' before the socket is ready", async (t) => {
  if (skip) return t.skip(skip as string);
  // The specific defect, asserted directly. Immediately after a reset nothing
  // has connected, so the honest answer is "configured" — REDIS_URL is set and
  // no attempt has been made. It must never be "disabled" (which asserts the
  // opposite of the truth) and never "connected" (which is unearned).
  resetRateLimitStoreForTests();
  const atRest = getRateLimiterStatus();
  assert.equal(atRest.state, "configured", "REDIS_URL is set, so 'disabled' would be a false report");
  assert.equal(atRest.backend, "memory", "nothing is connected yet, so counting is in memory");

  // And after a request it earns "connected" — the positive control proving
  // "configured" above is a transient starting point, not a stuck state.
  await forgot("ready-order@example.com");
  await waitForState("connected");
  assert.equal(getRateLimiterStatus().backend, "redis");
});
