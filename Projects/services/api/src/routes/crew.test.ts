/**
 * Tests for POST /api/crew/timecards span validation.
 *
 * The defect: nothing validated the start/finish span, so a finish time BEFORE
 * its start was accepted and stored. The mobile client's calcHours clamps the
 * negative result with Math.max(0, ...), and hoursRegular allows 0, so the
 * nonsense arrived here already laundered into a plausible payroll row reading
 * 0.0h — wrong, and indistinguishable from a legitimately empty one.
 *
 * Overnight shifts are not supported today (calcHours is plain subtraction with
 * no day rollover and already yields 0.0h for one), so rejecting a non-positive
 * span removes no working behaviour.
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

let _phoneSeq = 0;
function nextPhone() { return `+614${String(++_phoneSeq).padStart(8, "0")}`; }

/** Register + verify a user, returning their auth token. */
async function registerUser(email: string): Promise<string> {
  const regRes = await req<{ devCodes?: { emailCode: string } }>(
    "POST", "/auth/register",
    { email, phone: nextPhone(), fullName: "Timecard Tester", password: "Password123!!" }
  );
  assert.equal(regRes.status, 200, `register failed: ${JSON.stringify(regRes.body)}`);
  const { emailCode } = regRes.body.devCodes!;
  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email, emailCode }
  );
  const { smsCode } = veRes.body.devCodes!;
  const verRes = await req<{ token: string }>(
    "POST", "/auth/register/verify", { email, smsCode }
  );
  assert.equal(verRes.status, 201, `verify failed: ${JSON.stringify(verRes.body)}`);
  return verRes.body.token;
}

/** A timecard payload shaped exactly as the mobile client sends one. */
function timecard(over: Record<string, unknown> = {}) {
  return {
    siteId: "site-under-test",
    workerName: "A Builder",
    trade: "",
    date: "2026-10-03",
    startTime: "07:00",
    endTime: "15:30",
    breakMinutes: 30,
    hoursRegular: 8,
    hoursOvertime: 0,
    notes: "",
    ...over,
  };
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

beforeEach(() => {
  resetAuthStoreForTests();
  resetProjectStoreForTests();
  resetRateLimitStoreForTests();
});

test("crew timecards: a finish before its start is rejected with 400 naming endTime", async () => {
  const token = await registerUser("timecard-span@test.test");

  // The positive control, in this test and against this endpoint. Without it, a
  // 400 proves nothing: a route that rejected EVERY payload — or that 404'd
  // because the path moved — would pass the negative assertion alone.
  const good = await req<{ timecard: { hoursRegular: number } }>(
    "POST", "/crew/timecards", timecard(), token
  );
  assert.equal(good.status, 201, `a valid timecard must still save: ${JSON.stringify(good.body)}`);
  assert.equal(good.body.timecard.hoursRegular, 8);

  // The defect. 17:00 -> 09:00 is the shape that reached production as "0.0h".
  const bad = await req<{ error: string; details?: { fieldErrors?: Record<string, string[]> } }>(
    "POST", "/crew/timecards",
    timecard({ startTime: "17:00", endTime: "09:00", hoursRegular: 0, hoursOvertime: 0 }),
    token
  );
  assert.equal(bad.status, 400, `expected 400, got ${bad.status}: ${JSON.stringify(bad.body)}`);
  assert.match(bad.body.error, /endTime/, "the error must name the offending field");
  assert.ok(
    bad.body.details?.fieldErrors?.endTime?.length,
    `expected a field error on endTime: ${JSON.stringify(bad.body.details)}`
  );
});

test("crew timecards: a card with no clocked times is still accepted", async () => {
  // Both times absent predates this validation and stays legal — hours can be
  // recorded without a clocked span. Asserted explicitly because the span rules
  // are the kind of change that quietly takes an existing path with it.
  const token = await registerUser("timecard-untimed@test.test");
  const res = await req<{ timecard: { id: string } }>(
    "POST", "/crew/timecards",
    timecard({ startTime: undefined, endTime: undefined, breakMinutes: 0, hoursRegular: 6 }),
    token
  );
  assert.equal(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.timecard.id, "the timecard should have been created");
});
