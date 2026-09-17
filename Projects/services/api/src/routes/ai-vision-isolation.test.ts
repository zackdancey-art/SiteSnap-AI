/**
 * H7 (residual 3): the generate-diary VISION path reads server-stored photos by
 * a client-supplied storageKey. This test proves that path is company-scoped —
 * a cross-tenant photo is never read into the model — with a positive control
 * (the owner's photo IS sent) so the denial is attributable to ownership.
 *
 * OpenAI is mocked at the boundary (services/openaiClient getOpenAIClient returns
 * a fake in NODE_ENV=test that records the request `input`), mirroring the H3a
 * provider guards — no internal functions are exported.
 */
import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests } from "../storage/projectsStore";
import { resetUploadsStoreForTests } from "../storage/uploadsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import {
  getRecordedOpenAICallsForTests,
  resetOpenAIRecordingForTests,
} from "../services/openaiClient";

let server: http.Server;
let baseUrl: string;

async function req<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    parsed = text as unknown as T;
  }
  return { status: res.status, body: parsed };
}

let _phoneSeq = 0;
function nextPhone() {
  return `+614${String(++_phoneSeq).padStart(8, "0")}`;
}

async function registerUser(email: string, name: string, companyName?: string): Promise<string> {
  const reg = await req<{ devCodes?: { emailCode: string } }>(
    "POST",
    "/auth/register",
    { email, password: "Password123!!", phone: nextPhone(), fullName: name, companyName }
  );
  assert.equal(reg.status, 200, `register ${email} failed: ${JSON.stringify(reg.body)}`);
  const { emailCode } = reg.body.devCodes!;
  // Two-stage verification: the SMS is only minted once the email code
  // is accepted, so the sms code comes from THIS response, not register.
  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email: email, emailCode }
  );
  const { smsCode } = veRes.body.devCodes!;
  const ver = await req<{ token: string }>("POST", "/auth/register/verify", { email, smsCode });
  assert.equal(ver.status, 201, `verify ${email} failed: ${JSON.stringify(ver.body)}`);
  return ver.body.token;
}

/** Upload a jpeg as `token`, returning its canonical storageKey/id/filename. */
async function uploadPhoto(token: string): Promise<{ id: string; filename: string; storageKey: string }> {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from("VISION-SECRET-BYTES")], { type: "image/jpeg" }), "vision.jpg");
  const res = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text();
  assert.equal(res.status, 200, `upload failed: ${text}`);
  return JSON.parse(text) as { id: string; filename: string; storageKey: string };
}

/** Count input_image items across every recorded (mocked) OpenAI call. */
function imagesSentToModel(): number {
  let count = 0;
  for (const call of getRecordedOpenAICallsForTests()) {
    const input = call.input as Array<{ role?: string; content?: Array<{ type?: string }> }> | undefined;
    for (const msg of input ?? []) {
      for (const c of msg.content ?? []) {
        if (c.type === "input_image") count += 1;
      }
    }
  }
  return count;
}

async function generateDiaryWithPhoto(token: string, storageKey: string) {
  return req(
    "POST",
    "/generate-diary",
    {
      period: "daily",
      entries: [{ date: "2026-02-01", notes: "n", photos: [{ storageKey }] }],
    },
    token
  );
}

before(async () => {
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  resetAuthStoreForTests();
  resetProjectStoreForTests();
  resetUploadsStoreForTests();
  resetRateLimitStoreForTests();
  resetOpenAIRecordingForTests();
});

test("ai-vision: owner's photo IS sent to the model (positive control)", async () => {
  // OPENAI_API_KEY is emptied by the test preload; set it so the vision path runs
  // (the client itself is the NODE_ENV=test boundary mock, so no network call).
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-vision";
  try {
    const tokenA = await registerUser("owner-a@vision.test", "Owner A", "Vision Co A");
    const uploaded = await uploadPhoto(tokenA);

    const res = await generateDiaryWithPhoto(tokenA, uploaded.storageKey);
    assert.equal(res.status, 200, `A generate-diary failed: ${JSON.stringify(res.body)}`);
    assert.equal(imagesSentToModel(), 1, "owner's own photo should be read and sent to the model");
  } finally {
    process.env.OPENAI_API_KEY = prevKey;
  }
});

test("ai-vision: another company's photo is NEVER sent to the model", async () => {
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-vision";
  try {
    const tokenA = await registerUser("owner-a@vision.test", "Owner A", "Vision Co A");
    const tokenB = await registerUser("owner-b@vision.test", "Owner B", "Vision Co B");

    // A uploads (ownership bound to A). B references A's storageKey in a diary req.
    const uploaded = await uploadPhoto(tokenA);
    const res = await generateDiaryWithPhoto(tokenB, uploaded.storageKey);
    assert.equal(res.status, 200, `B generate-diary failed: ${JSON.stringify(res.body)}`);
    assert.equal(
      imagesSentToModel(),
      0,
      "B must NOT have A's photo read into the model (reverting the ai.ts ownership check makes this 1)"
    );
  } finally {
    process.env.OPENAI_API_KEY = prevKey;
  }
});

test("ai-vision: path-traversal storageKey is rejected (never read)", async () => {
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-vision";
  try {
    const tokenA = await registerUser("owner-a@vision.test", "Owner A", "Vision Co A");
    const tokenB = await registerUser("owner-b@vision.test", "Owner B", "Vision Co B");
    const uploaded = await uploadPhoto(tokenA);

    // B owns some id; craft a traversal key that would resolve to A's file.
    const bUpload = await uploadPhoto(tokenB);
    const traversalKey = `uploads/${bUpload.id}-x/../${uploaded.id}-${uploaded.filename}`;
    const res = await generateDiaryWithPhoto(tokenB, traversalKey);
    assert.equal(res.status, 200, `B traversal generate-diary failed: ${JSON.stringify(res.body)}`);
    assert.equal(imagesSentToModel(), 0, "a non-canonical/traversal storageKey must never be read");
  } finally {
    process.env.OPENAI_API_KEY = prevKey;
  }
});
