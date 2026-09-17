/**
 * Tests for POST /api/auth/change-password
 *
 * Covers:
 *  1. Wrong current password is rejected (401)
 *  2. Short new password is rejected (400)
 *  3. Missing fields are rejected (400)
 *  4. Successful change returns ok:true
 *  5. Old password no longer works after change
 *  6. New password works for login after change
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

async function registerAndLogin(email: string, password: string): Promise<string> {
  const regRes = await req<{ devCodes?: { emailCode: string } }>(
    "POST", "/auth/register",
    { email, phone: nextPhone(), fullName: "Test User", password }
  );
  assert.equal(regRes.status, 200, `register failed: ${JSON.stringify(regRes.body)}`);
  const { emailCode } = regRes.body.devCodes!;
  // Two-stage verification: the SMS is only minted once the email code
  // is accepted, so the sms code comes from THIS response, not register.
  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email: email, emailCode }
  );
  const { smsCode } = veRes.body.devCodes!;
  const verRes = await req<{ token: string }>(
    "POST", "/auth/register/verify", { email, smsCode }
  );
  assert.equal(verRes.status, 201, `verify failed: ${JSON.stringify(verRes.body)}`);
  return verRes.body.token;
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

test("change-password: wrong current password is rejected with 401", async () => {
  const token = await registerAndLogin("user@test.test", "OldPassword1!");
  const res = await req<{ error: string }>(
    "POST", "/auth/change-password",
    { currentPassword: "WrongPassword!", newPassword: "NewPassword2!" },
    token
  );
  assert.equal(res.status, 401, `expected 401, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.ok(res.body.error, "should return an error message");
});

test("change-password: new password shorter than 8 chars is rejected with 400", async () => {
  const token = await registerAndLogin("user@test.test", "OldPassword1!");
  const res = await req<{ error: string }>(
    "POST", "/auth/change-password",
    { currentPassword: "OldPassword1!", newPassword: "short" },
    token
  );
  assert.equal(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test("change-password: missing fields are rejected with 400", async () => {
  const token = await registerAndLogin("user@test.test", "OldPassword1!");
  const res = await req<{ error: string }>(
    "POST", "/auth/change-password",
    { currentPassword: "OldPassword1!" },
    token
  );
  assert.equal(res.status, 400);
});

test("change-password: unauthenticated request is rejected with 401", async () => {
  const res = await req<{ error: string }>(
    "POST", "/auth/change-password",
    { currentPassword: "OldPassword1!", newPassword: "NewPassword2!" }
  );
  assert.equal(res.status, 401);
});

test("change-password: successful change returns ok:true", async () => {
  const token = await registerAndLogin("user@test.test", "OldPassword1!");
  const res = await req<{ ok: boolean }>(
    "POST", "/auth/change-password",
    { currentPassword: "OldPassword1!", newPassword: "NewPassword2!" },
    token
  );
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);
});

test("change-password: old password no longer works for login after change", async () => {
  const token = await registerAndLogin("user@test.test", "OldPassword1!");
  await req("POST", "/auth/change-password",
    { currentPassword: "OldPassword1!", newPassword: "NewPassword2!" }, token);

  const loginRes = await req<{ error?: string }>(
    "POST", "/auth/login", { email: "user@test.test", password: "OldPassword1!" }
  );
  assert.equal(loginRes.status, 401, "old password should be rejected after change");
});

test("change-password: new password works for login after change", async () => {
  const token = await registerAndLogin("user@test.test", "OldPassword1!");
  await req("POST", "/auth/change-password",
    { currentPassword: "OldPassword1!", newPassword: "NewPassword2!" }, token);

  const loginRes = await req<{ token?: string }>(
    "POST", "/auth/login", { email: "user@test.test", password: "NewPassword2!" }
  );
  assert.equal(loginRes.status, 200, `new password login should succeed: ${JSON.stringify(loginRes.body)}`);
  assert.ok(loginRes.body.token, "should return a token");
});
