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
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as T });
        } catch {
          reject(new Error(`Non-JSON response (${res.statusCode}): ${data}`));
        }
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
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(async () => {
  await resetAuthStoreForTests();
  await resetProjectStoreForTests();
  resetRateLimitStoreForTests();
});

// ─── Auth ────────────────────────────────────────────────────────────────────

test("health endpoint returns ok", async () => {
  const { status, body } = await req<{ status: string }>("GET", "/health");
  assert.equal(status, 200);
  assert.equal((body as { status: string }).status, "ok");
});

test("register → verify → login flow", async () => {
  const registerRes = await req<{ ok: boolean; devCodes?: { emailCode: string } }>(
    "POST",
    "/auth/register",
    { email: "test@example.com", password: "password123", phone: "+447911123456", fullName: "Test User" }
  );
  assert.equal(registerRes.status, 200);
  assert.ok(registerRes.body.ok);
  assert.ok(registerRes.body.devCodes, "dev codes should be present in non-production");

  const { emailCode } = registerRes.body.devCodes!;
  // Two-stage verification: the SMS is only minted once the email code
  // is accepted, so the sms code comes from THIS response, not register.
  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email: "test@example.com", emailCode }
  );
  const { smsCode } = veRes.body.devCodes!;
  const verifyRes = await req<{ ok: boolean; token: string; user: { email: string; role: string } }>(
    "POST",
    "/auth/register/verify",
    { email: "test@example.com", smsCode }
  );
  assert.equal(verifyRes.status, 201);
  assert.ok(verifyRes.body.token);
  assert.equal(verifyRes.body.user.email, "test@example.com");
  assert.equal(verifyRes.body.user.role, "worker");

  const loginRes = await req<{ ok: boolean; token: string }>(
    "POST",
    "/auth/login",
    { email: "test@example.com", password: "password123" }
  );
  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.body.token);
});

test("login with wrong password returns 401", async () => {
  const { status, body } = await req<{ error: string }>(
    "POST",
    "/auth/login",
    { email: "nobody@example.com", password: "wrongpassword" }
  );
  assert.equal(status, 404);
  assert.ok((body as { error: string }).error);
});

test("auth/me requires valid token", async () => {
  const { status } = await req("GET", "/auth/me", undefined, "invalid-token");
  assert.equal(status, 401);
});

// ─── Projects ────────────────────────────────────────────────────────────────

async function createWorkerToken() {
  const reg = await req<{ devCodes?: { emailCode: string } }>(
    "POST",
    "/auth/register",
    { email: "worker@example.com", password: "password123", phone: "+447911000001", fullName: "Worker" }
  );
  const { emailCode } = reg.body.devCodes!;
  // Two-stage verification: the SMS is only minted once the email code
  // is accepted, so the sms code comes from THIS response, not register.
  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email: "worker@example.com", emailCode }
  );
  const { smsCode } = veRes.body.devCodes!;
  const verify = await req<{ token: string }>(
    "POST",
    "/auth/register/verify",
    { email: "worker@example.com", smsCode }
  );
  return verify.body.token;
}

test("create and list sites", async () => {
  const token = await createWorkerToken();

  const createRes = await req<{ site: { id: string; name: string } }>(
    "POST",
    "/projects/sites",
    { name: "Test Site", address: "123 Main St", client: "ACME", startDate: "2025-01-01", status: "active" },
    token
  );
  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.site.name, "Test Site");

  const listRes = await req<{ sites: { id: string }[] }>("GET", "/projects/sites", undefined, token);
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.sites.length, 1);
});

test("create site rejects invalid payload", async () => {
  const token = await createWorkerToken();
  const { status, body } = await req<{ error: string }>(
    "POST",
    "/projects/sites",
    { name: "" },
    token
  );
  assert.equal(status, 400);
  assert.ok((body as { error: string }).error);
});

test("create entry and list entries", async () => {
  const token = await createWorkerToken();

  const site = await req<{ site: { id: string } }>(
    "POST",
    "/projects/sites",
    { name: "Site A", address: "1 Rd", client: "Client", startDate: "2025-01-01", status: "active" },
    token
  );
  const siteId = site.body.site.id;

  const entryRes = await req<{ entry: { id: string; notes: string } }>(
    "POST",
    "/projects/entries",
    { siteId, date: "2025-01-01", notes: "Work done", photos: [] },
    token
  );
  assert.equal(entryRes.status, 201);
  assert.equal(entryRes.body.entry.notes, "Work done");

  const list = await req<{ entries: { id: string }[] }>(
    "GET",
    `/projects/entries?siteId=${siteId}`,
    undefined,
    token
  );
  assert.equal(list.status, 200);
  assert.equal(list.body.entries.length, 1);
});

test("delete site removes associated entries", async () => {
  const token = await createWorkerToken();

  const site = await req<{ site: { id: string } }>(
    "POST",
    "/projects/sites",
    { name: "To Delete", address: "1 Rd", client: "C", startDate: "2025-01-01", status: "active" },
    token
  );
  const siteId = site.body.site.id;

  await req("POST", "/projects/entries", { siteId, date: "2025-01-01", notes: "x", photos: [] }, token);

  const del = await req<{ ok: boolean }>("DELETE", `/projects/sites/${siteId}`, undefined, token);
  assert.equal(del.status, 200);

  const entries = await req<{ entries: unknown[] }>("GET", `/projects/entries?siteId=${siteId}`, undefined, token);
  assert.equal(entries.body.entries.length, 0);
});

test("pagination limit and offset work", async () => {
  const token = await createWorkerToken();

  for (let i = 0; i < 5; i++) {
    await req(
      "POST",
      "/projects/sites",
      { name: `Site ${i}`, address: "A", client: "C", startDate: "2025-01-01", status: "active" },
      token
    );
  }

  const page1 = await req<{ sites: unknown[]; limit: number; offset: number }>(
    "GET",
    "/projects/sites?limit=3&offset=0",
    undefined,
    token
  );
  assert.equal(page1.body.sites.length, 3);

  const page2 = await req<{ sites: unknown[] }>(
    "GET",
    "/projects/sites?limit=3&offset=3",
    undefined,
    token
  );
  assert.equal(page2.body.sites.length, 2);
});

// ─── AI ─────────────────────────────────────────────────────────────────────

test("generate-diary uses local fallback when no OPENAI_API_KEY", async () => {
  const token = await createWorkerToken();

  const res = await req<{ success: boolean; diary: { summary: string; sections: unknown[] } }>(
    "POST",
    "/generate-diary",
    {
      period: "daily",
      entries: [
        { date: "2025-01-01", notes: "Poured concrete foundations", crewCount: "4", weather: "Sunny", photos: [] },
      ],
    },
    token
  );
  assert.equal(res.status, 200);
  assert.ok(res.body.success);
  assert.ok(res.body.diary.summary);
  assert.ok(Array.isArray(res.body.diary.sections));
});

test("generate-diary returns 400 when no entries match period", async () => {
  const token = await createWorkerToken();

  const res = await req<{ error: string }>(
    "POST",
    "/generate-diary",
    { period: "daily", entries: [] },
    token
  );
  assert.equal(res.status, 400);
  assert.ok(res.body.error);
});
