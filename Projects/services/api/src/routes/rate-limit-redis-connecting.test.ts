process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
process.env.AUTH_TOKEN_SECRET = "redis-connecting-test-secret";
process.env.TRUST_PROXY_HOPS = "0";
// Refused instantly and deterministically — nothing listens on port 1.
process.env.REDIS_URL = "redis://127.0.0.1:1";
process.env.RATE_LIMIT_FORGOT_PASSWORD_PER_IDENTIFIER = "5";
// A REAL grace window, unlike rate-limit-redis-degraded.test.ts which sets it to
// zero to get at the announcement. Short enough that the last test can wait it
// out, long enough that the first two run comfortably inside it.
process.env.RATE_LIMIT_REDIS_CONNECT_GRACE_MS = "2000";
// How long the first caller waits for the handshake before falling back. Must
// stay well INSIDE the grace window above, or the grace timer fires first and
// the last test can no longer see the connect window it exists to sample.
process.env.RATE_LIMIT_REDIS_READY_TIMEOUT_MS = "800";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import net from "node:net";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetRateLimitStoreForTests, getRateLimiterStatus } from "../middleware/rateLimit";
import { resetFakeSendsForTests } from "../services/notificationService";

/**
 * The connect window: Redis is configured, the socket is not up yet, and
 * commands are failing.
 *
 * This is the only file that can see that window, and it exists because two
 * fixes were made that NOTHING ELSE TESTED. Both were verified by revert: with
 * each one undone, the live suite and the degraded suite both stayed green.
 *
 *   - The live suite (reachable Redis) cannot see it, because by the time any
 *     assertion runs the socket is ready and every state machine agrees.
 *   - The degraded suite cannot see it, because it sets the grace window to zero
 *     in order to assert on the announcement.
 *
 * What went wrong in production, and what these tests pin:
 *
 *   1. redisState was set to "connected" the moment the CLIENT WAS CONSTRUCTED.
 *      /health/ready then reported a healthy Redis during precisely the window
 *      in which every command was being rejected. A health field that guesses
 *      optimistically is wrong in the one direction that matters.
 *   2. The first failure in that window was announced to Sentry as a degradation.
 *      Every deploy therefore fired one degradation alert, which gave
 *      degradationReports a floor of 1 per boot and made it useless as a signal —
 *      you could not tell a real outage from a normal start.
 *
 * The third test is the other half of the bargain: suppression is only
 * defensible if it is BOUNDED. A Redis that never comes up must still alert.
 */

let server: http.Server;
let baseUrl: string;

before(async () => {
  server = createApp().listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  // Also hangs up the retrying Redis client. Without this the process stays
  // alive on ioredis's reconnect timer and the run never finishes — the last
  // test's client is never cleared by beforeEach.
  resetRateLimitStoreForTests();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  resetRateLimitStoreForTests();
  resetAuthStoreForTests();
  resetFakeSendsForTests();
});

async function forgot(identifier: string): Promise<number> {
  const res = await fetch(`${baseUrl}/api/auth/forgot-password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, channel: "sms" }),
  });
  return res.status;
}

test("boot against an unreachable Redis is not announced as an incident", async () => {
  const status = await forgot("connect-window@example.com");
  assert.equal(status, 200, "the request itself must still succeed — fallback, not failure");

  const s = getRateLimiterStatus();

  // POSITIVE CONTROL. Without this the assertion below is satisfied by a run in
  // which Redis was never contacted at all — "no alert" is trivially true when
  // nothing was attempted. A non-zero fallbackCount is the evidence that a
  // command really was issued, really failed, and really fell back to memory.
  assert.ok(
    s.fallbackCount > 0,
    `positive control: expected at least one recorded fallback, got ${s.fallbackCount}`
  );

  assert.equal(
    s.degradationReports,
    0,
    "a failure inside the connect grace window must not announce — this is what " +
      "gave every deploy a spurious Sentry alert and put a floor of 1 under " +
      "degradationReports"
  );
});

test("state is 'connecting' during the window, never 'connected'", async () => {
  const before = getRateLimiterStatus();
  assert.equal(
    before.state,
    "configured",
    "before any rate-limited request, REDIS_URL is set but unattempted"
  );

  await forgot("connect-window-state@example.com");
  const s = getRateLimiterStatus();

  assert.ok(s.fallbackCount > 0, `positive control: expected a recorded fallback, got ${s.fallbackCount}`);

  assert.notEqual(
    s.state,
    "connected",
    "constructing a client is not evidence the socket works; reporting 'connected' " +
      "while commands are being rejected is the exact production defect"
  );
  assert.equal(s.state, "connecting", `expected 'connecting', got '${s.state}'`);
  assert.equal(s.backend, "memory", "the counting is really happening in memory");
});

test("the silence is bounded — a Redis that never comes up does alert", async () => {
  await forgot("connect-window-timeout@example.com");
  assert.equal(getRateLimiterStatus().degradationReports, 0, "suppressed at first");

  // Outlast RATE_LIMIT_REDIS_CONNECT_GRACE_MS (2000ms above).
  await new Promise<void>((r) => setTimeout(r, 2600));

  const s = getRateLimiterStatus();
  assert.equal(
    s.degradationReports,
    1,
    "once the grace window expires without a ready socket, the degradation must " +
      "be announced exactly once — suppression that never ends is just a missed alert"
  );
  assert.equal(s.state, "degraded", `expected 'degraded' after the window, got '${s.state}'`);
});

test("'connected' is never claimed while the socket is still opening", async () => {
  // The other tests in this file cannot see the optimistic-"connected" defect,
  // and that was established by revert, not assumed: with the fix undone they
  // all stayed green. The reason is that an instantly-REFUSED connection fires
  // `error`, which routes through markDegraded and overwrites the optimistic
  // "connected" with "connecting" before any assertion runs.
  //
  // So this test uses a socket that OPENS AND THEN SAYS NOTHING — a hung Redis,
  // a network partition mid-handshake, a server still loading its dataset. No
  // error event fires, nothing overwrites the state, and the window stays open
  // for as long as the handshake is outstanding. That is the window in which
  // /health/ready told us Redis was healthy while every command was failing.
  //
  // It is sampled WHILE the request is in flight, because that is when a real
  // monitor would read it: /health/ready is not rate-limited and answers
  // concurrently with everything else.
  // Held sockets must be destroyed by hand at the end: server.close() stops
  // accepting but WAITS for open connections, and a connection that is being
  // held open on purpose never closes. That deadlocks the whole file, not just
  // this test.
  const held: net.Socket[] = [];
  const silent = net.createServer((socket) => {
    // Accept, hold, never speak RESP.
    socket.on("error", () => {});
    held.push(socket);
  });
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
  const addr = silent.address();
  if (!addr || typeof addr === "string") throw new Error("no port");

  const previousUrl = process.env.REDIS_URL;
  process.env.REDIS_URL = `redis://127.0.0.1:${addr.port}`;
  resetRateLimitStoreForTests();

  try {
    // Deliberately NOT awaited yet — the point is to observe mid-handshake.
    const inFlight = forgot("silent-socket@example.com");
    await new Promise<void>((r) => setTimeout(r, 250));

    const during = getRateLimiterStatus();
    assert.notEqual(
      during.state,
      "connected",
      "the socket is open but the handshake has not completed and commands are " +
        "being rejected; reporting 'connected' here is the production defect — " +
        "a health field that guesses optimistically is wrong in the one " +
        "direction that matters"
    );
    assert.equal(during.state, "connecting", `expected 'connecting' mid-handshake, got '${during.state}'`);

    assert.equal(await inFlight, 200, "the request still succeeds on the memory fallback");

    // POSITIVE CONTROL. Without it, "not connected" is equally satisfied by a
    // run in which Redis was never contacted. A recorded fallback is the proof
    // that a command was really issued against this socket and really failed.
    const after = getRateLimiterStatus();
    assert.ok(
      after.fallbackCount > 0,
      `positive control: expected a recorded fallback against the silent socket, got ${after.fallbackCount}`
    );
  } finally {
    resetRateLimitStoreForTests();
    if (previousUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previousUrl;
    for (const socket of held) socket.destroy();
    await new Promise<void>((r) => silent.close(() => r()));
  }
});
