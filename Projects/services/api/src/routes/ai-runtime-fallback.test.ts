// In-memory harness (CLAUDE.md §6): no real DB, no network.
process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
process.env.AUTH_TOKEN_SECRET = "ai-runtime-fallback-test-secret";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests } from "../storage/projectsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import {
  setOpenAINextErrorForTests,
  resetOpenAIRecordingForTests,
} from "../services/openaiClient";

// X2: the rule-based generator is deliberately kept as a RUNTIME fallback for a
// reachable-but-erroring OpenAI API (bad key, server error, timeout). These tests
// prove that path still degrades gracefully — HTTP 200 with a real fallback diary
// and an explanatory warning — rather than surfacing an error to the field app.
// The error is injected at the client boundary (setOpenAINextErrorForTests), so no
// network call happens; OPENAI_API_KEY is set purely to select the API path (not
// the "no key -> straight to fallback" path) inside tryGenerateWithOpenAI.

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
  process.env.OPENAI_API_KEY = "sk-test-selects-the-api-path";
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  delete process.env.OPENAI_API_KEY;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(async () => {
  await resetAuthStoreForTests();
  await resetProjectStoreForTests();
  resetRateLimitStoreForTests();
  resetOpenAIRecordingForTests();
});

async function registerAndLogin(email: string, phone: string): Promise<string> {
  const reg = await req<{ devCodes?: { emailCode: string } }>(
    "POST", "/auth/register",
    { email, password: "Password123!", phone, fullName: "Diary User" }
  );
  const { emailCode } = reg.body.devCodes!;
  // Two-stage verification: the SMS is only minted once the email code
  // is accepted, so the sms code comes from THIS response, not register.
  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email: email, emailCode }
  );
  const { smsCode } = veRes.body.devCodes!;
  const verify = await req<{ token: string }>(
    "POST", "/auth/register/verify",
    { email, smsCode }
  );
  return verify.body.token;
}

const DIARY_BODY = {
  period: "daily",
  entries: [{ date: "2026-01-01", notes: "Poured the ground-floor slab.", weather: "Fine", crewCount: "4" }],
};

type DiaryResponse = {
  success: boolean;
  diary?: { fullReport: string; sections: unknown[] };
  generation?: {
    generator: string;
    model: string | null;
    promptVersion: string;
    warning: string | null;
    signature: string;
  };
  warning?: string;
  error?: string;
};

// Every degraded path must say so in the provenance record too, not only in the
// transient `warning` field — the record is what gets stored and exported.
function assertFallbackProvenance(r: { body: DiaryResponse }) {
  assert.equal(r.body.generation?.generator, "fallback", "provenance names the rule-based generator");
  assert.equal(r.body.generation?.model, null, "no model ran, so none is claimed");
  assert.ok((r.body.generation?.warning ?? "").length > 0, "provenance carries the reason");
  assert.ok((r.body.generation?.signature ?? "").length > 0, "provenance is signed");
}

let phoneCounter = 5000;
const nextPhone = () => `+614${String(phoneCounter++).padStart(8, "0")}`;

// An OpenAI-style error carrying an HTTP status, as the SDK throws.
function apiError(status: number, message: string): Error {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  return e;
}

test("401 (invalid key): 200 with rule-based fallback diary + a key-specific warning", async () => {
  const token = await registerAndLogin("diary401@example.com", nextPhone());
  setOpenAINextErrorForTests(apiError(401, "Incorrect API key provided"));

  const r = await req<DiaryResponse>("POST", "/generate-diary", DIARY_BODY, token);

  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.ok(r.body.diary && r.body.diary.fullReport.length > 20, "fallback produced a real diary from the entries");
  assert.match(r.body.warning ?? "", /OpenAI API key was rejected \(401\)/);
  assertFallbackProvenance(r);
});

test("500 (server error): 200 with fallback diary + a generic AI-unavailable warning", async () => {
  const token = await registerAndLogin("diary500@example.com", nextPhone());
  setOpenAINextErrorForTests(apiError(500, "The server had an error"));

  const r = await req<DiaryResponse>("POST", "/generate-diary", DIARY_BODY, token);

  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.ok(r.body.diary && r.body.diary.fullReport.length > 20, "fallback produced a real diary from the entries");
  assert.match(r.body.warning ?? "", /AI service was unavailable/);
  assertFallbackProvenance(r);
});

test("timeout (no HTTP status): 200 with fallback diary + a generic warning", async () => {
  const token = await registerAndLogin("diarytimeout@example.com", nextPhone());
  const timeout = new Error("Request timed out") as Error & { code?: string };
  timeout.code = "ETIMEDOUT";
  setOpenAINextErrorForTests(timeout);

  const r = await req<DiaryResponse>("POST", "/generate-diary", DIARY_BODY, token);

  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.ok(r.body.diary && r.body.diary.fullReport.length > 20, "fallback produced a real diary from the entries");
  assert.match(r.body.warning ?? "", /AI service was unavailable/);
  assertFallbackProvenance(r);
});
