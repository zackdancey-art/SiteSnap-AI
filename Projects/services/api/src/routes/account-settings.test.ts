// In-memory harness (CLAUDE.md §6): no real DB, no network.
process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
process.env.AUTH_TOKEN_SECRET = "account-settings-test-secret";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";

// Guards the #3 settings-persistence endpoints. Two properties the review demanded:
//  (1) cross-account safety — the caller's identity is ALWAYS the verified token,
//      never request input; you cannot read or write another user's row via a
//      top-level `email`, a nested payload, or anything else.
//  (2) strict validation — unknown keys are rejected at EVERY level (root and each
//      nested group), so a typo'd preference 400s instead of silently accumulating
//      in the JSONB bag (Zod is the only guard; JSONB has no column constraints).

let server: http.Server;
let baseUrl: string;

async function req<T = unknown>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
beforeEach(async () => { await resetAuthStoreForTests(); resetRateLimitStoreForTests(); });

let phoneCounter = 7000;
const nextPhone = () => `+614${String(phoneCounter++).padStart(8, "0")}`;

async function registerAndLogin(email: string): Promise<string> {
  const reg = await req<{ devCodes?: { emailCode: string; smsCode: string } }>(
    "POST", "/auth/register", { email, password: "Password123!", phone: nextPhone(), fullName: "Test User" });
  const { emailCode, smsCode } = reg.body.devCodes!;
  const verify = await req<{ token: string }>("POST", "/auth/register/verify", { email, emailCode, smsCode });
  return verify.body.token;
}

type SettingsResp = { settings: Record<string, Record<string, unknown>>; error?: string };

test("GET returns {} before anything is set; PATCH persists and merges partially", async () => {
  const a = await registerAndLogin("settings-a@example.com");
  assert.deepEqual((await req<SettingsResp>("GET", "/account/settings", undefined, a)).body.settings, {});

  const p1 = await req<SettingsResp>("PATCH", "/account/settings",
    { notifs: { weeklyDigest: false, pushEnabled: true }, display: { dateFormat: "yyyy-mm-dd" }, export: { defaultFormat: "csv" } }, a);
  assert.equal(p1.status, 200);
  assert.equal(p1.body.settings.notifs.weeklyDigest, false);
  assert.equal(p1.body.settings.display.dateFormat, "yyyy-mm-dd");

  // Partial patch of one field in a group must preserve the group's other fields.
  const p2 = await req<SettingsResp>("PATCH", "/account/settings", { notifs: { approvalAlerts: false } }, a);
  assert.equal(p2.body.settings.notifs.weeklyDigest, false, "weeklyDigest preserved across partial patch");
  assert.equal(p2.body.settings.notifs.approvalAlerts, false, "approvalAlerts updated");
  assert.equal(p2.body.settings.notifs.pushEnabled, true, "pushEnabled preserved");
});

test("cross-account: one user's writes never touch another's row", async () => {
  const a = await registerAndLogin("iso-a@example.com");
  const b = await registerAndLogin("iso-b@example.com");
  await req("PATCH", "/account/settings", { notifs: { pushEnabled: true }, export: { includePhotos: false } }, a);
  // B is untouched.
  assert.deepEqual((await req<SettingsResp>("GET", "/account/settings", undefined, b)).body.settings, {});
});

test("cross-account: a top-level `email` in the body is rejected (strict) — cannot target another row", async () => {
  const a = await registerAndLogin("email-a@example.com");
  const b = await registerAndLogin("email-b@example.com");
  const r = await req<SettingsResp>("PATCH", "/account/settings", { email: "email-b@example.com", notifs: { pushEnabled: true } }, a);
  assert.equal(r.status, 400, "unknown top-level key `email` must 400");
  // Neither A nor B was written.
  assert.deepEqual((await req<SettingsResp>("GET", "/account/settings", undefined, b)).body.settings, {}, "B untouched");
  assert.deepEqual((await req<SettingsResp>("GET", "/account/settings", undefined, a)).body.settings, {}, "A untouched (patch rejected)");
});

test("strict: unknown keys rejected at root AND nested (typo'd prefs 400)", async () => {
  const a = await registerAndLogin("strict-a@example.com");
  const cases: unknown[] = [
    { unknownGroup: { x: 1 } },              // unknown root group
    { display: { timezone: "Pacific/Auckland" } }, // timezone is company-level, not accepted here
    { display: { foo: true } },              // unknown nested key
    { notifs: { typo: true } },              // unknown nested key
    { export: { defaultFormat: "xml" } },    // invalid enum value
  ];
  for (const body of cases) {
    const r = await req<SettingsResp>("PATCH", "/account/settings", body, a);
    assert.equal(r.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  // A well-formed patch still works after the rejections.
  const ok = await req<SettingsResp>("PATCH", "/account/settings", { display: { compactTables: true } }, a);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.settings.display.compactTables, true);
});

test("unauthenticated GET and PATCH are rejected", async () => {
  assert.equal((await req("GET", "/account/settings")).status, 401);
  assert.equal((await req("PATCH", "/account/settings", { notifs: { pushEnabled: true } })).status, 401);
});
