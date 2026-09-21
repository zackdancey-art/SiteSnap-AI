// In-memory harness (CLAUDE.md §6): no real DB, no network.
process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
process.env.AUTH_TOKEN_SECRET = "ai-model-params-test-secret";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests } from "../storage/projectsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import {
  getRecordedOpenAICallsForTests,
  resetOpenAIRecordingForTests,
  setOpenAINextErrorForTests,
} from "../services/openaiClient";
import { supportsSamplingParams, buildDiaryRequest } from "./ai";

/**
 * SITESNAP-API-9: every generation returned a template diary because the request
 * carried `temperature: 0.3`, which gpt-5.6-terra rejects with a 400, and the
 * catch block reported that 400 as "The AI service was unavailable."
 *
 * Two separate defects, so two separate groups of tests below:
 *   1. the request must be built per-model — temperature for the models that
 *      accept it, omitted for the ones that don't;
 *   2. a 400 must be reported as a configuration fault, never as an outage.
 *
 * What these tests CANNOT do is tell you whether OpenAI actually accepts the
 * parameter set — the boundary mock accepts anything by construction. That
 * question is answered by ai-openai-contract.test.ts against the real API.
 * These two files are complements; neither is sufficient alone.
 */

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
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as T }); }
        catch { reject(new Error(`Non-JSON response (${res.statusCode}): ${data}`)); }
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
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});
beforeEach(async () => {
  await resetAuthStoreForTests();
  await resetProjectStoreForTests();
  resetRateLimitStoreForTests();
  resetOpenAIRecordingForTests();
  delete process.env.OPENAI_MODEL;
});

let phoneCounter = 7100;
const nextPhone = () => `+614${String(phoneCounter++).padStart(8, "0")}`;

async function registerAndLogin(email: string): Promise<string> {
  const phone = nextPhone();
  const reg = await req<{ devCodes?: { emailCode: string } }>(
    "POST", "/auth/register", { email, password: "Password123!", phone, fullName: "Diary User" }
  );
  const { emailCode } = reg.body.devCodes!;
  const ve = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email, emailCode }
  );
  const { smsCode } = ve.body.devCodes!;
  const verify = await req<{ token: string }>("POST", "/auth/register/verify", { email, smsCode });
  return verify.body.token;
}

const DIARY_BODY = {
  period: "daily",
  entries: [{ date: "2026-01-01", notes: "Poured the ground-floor slab.", weather: "Fine", crewCount: "4" }],
};

type DiaryResponse = {
  success: boolean;
  generation?: { generator: string; model: string | null; warning: string | null };
  warning?: string;
};

/** Drive one real generation through the route and return the captured request. */
async function captureRequestFor(model: string | undefined, email: string): Promise<Record<string, unknown>> {
  if (model === undefined) delete process.env.OPENAI_MODEL;
  else process.env.OPENAI_MODEL = model;
  const token = await registerAndLogin(email);
  const res = await req<DiaryResponse>("POST", "/generate-diary", DIARY_BODY, token);
  assert.equal(res.status, 200, "positive control: the generation request itself must succeed");
  assert.equal(
    res.body.generation?.generator, "openai",
    "positive control: the AI path must have RUN — if this fell back, the captured request below is from nothing"
  );
  const calls = getRecordedOpenAICallsForTests();
  assert.equal(calls.length, 1, `exactly one OpenAI call should have been made, got ${calls.length}`);
  return calls[0].request;
}

// ── 1. the request is built per-model ────────────────────────────────────────

test("gpt-5.6-terra: temperature is omitted (the SITESNAP-API-9 regression)", async () => {
  const request = await captureRequestFor("gpt-5.6-terra", "terra@example.com");

  // POSITIVE CONTROLS FIRST. "temperature is absent" is satisfied just as well
  // by an empty object, so prove the request is real and fully formed before
  // asserting anything about what it lacks.
  assert.equal(request.model, "gpt-5.6-terra", "positive control: the model we configured is the one sent");
  assert.ok(Array.isArray(request.input), "positive control: the input array is present");
  assert.deepEqual(
    request.text, { format: { type: "json_object" } },
    "positive control: text.format is still sent — it is NOT model-conditional and must not be stripped"
  );

  assert.ok(
    !("temperature" in request),
    `temperature must not be sent to a model that rejects it — this is the exact 400 in SITESNAP-API-9. Got: ${JSON.stringify(request.temperature)}`
  );
  assert.ok(!("top_p" in request), "top_p is rejected by the same family and must not appear either");
});

test("gpt-4o: temperature IS sent, so the fix did not globally strip it", async () => {
  const request = await captureRequestFor("gpt-4o", "fouro@example.com");

  assert.equal(request.model, "gpt-4o");
  // This is the assertion that makes the previous test meaningful. Without it,
  // deleting the temperature line entirely would pass the whole file while
  // silently de-tuning every gpt-4o generation to the model's default sampling.
  assert.equal(
    request.temperature, 0.3,
    "gpt-4o accepts temperature and the tuned 0.3 must survive a revert of OPENAI_MODEL"
  );
});

test("an unrecognised model omits temperature — the safe direction", async () => {
  const request = await captureRequestFor("some-future-model-we-have-never-seen", "future@example.com");

  assert.equal(request.model, "some-future-model-we-have-never-seen", "positive control: request is real");
  assert.deepEqual(request.text, { format: { type: "json_object" } }, "positive control: still fully formed");
  // Omitting costs determinism on a model that would have accepted it; sending
  // costs EVERY generation on a model that rejects it. Default to the cheap loss.
  assert.ok(!("temperature" in request), "an unknown model must not be sent a parameter we have not verified");
});

test("the default model (OPENAI_MODEL unset) still gets temperature", async () => {
  const request = await captureRequestFor(undefined, "default@example.com");

  // The code falls back to the gpt-4o literal, which does accept temperature.
  assert.equal(request.model, "gpt-4o", "positive control: the documented default is what runs");
  assert.equal(request.temperature, 0.3);
});

test("supportsSamplingParams: dated snapshots inherit from their base model", () => {
  assert.equal(supportsSamplingParams("gpt-4o"), true);
  assert.equal(supportsSamplingParams("gpt-4o-2024-11-20"), true, "a dated gpt-4o snapshot still accepts temperature");
  assert.equal(supportsSamplingParams("gpt-5.6-terra"), false);
  assert.equal(supportsSamplingParams("gpt-5.6-terra-2026-09-01"), false, "a dated snapshot must not inherit a YES it never had");
  assert.equal(supportsSamplingParams("totally-unknown"), false);
});

test("buildDiaryRequest is the single construction path both callers share", () => {
  // The contract test posts THIS object to the real API. If the route stopped
  // using it, that test would be validating a request nobody sends.
  const withTemp = buildDiaryRequest("gpt-4o", "Return JSON.", [{ type: "input_text", text: "x" }]);
  const without = buildDiaryRequest("gpt-5.6-terra", "Return JSON.", [{ type: "input_text", text: "x" }]);
  assert.equal((withTemp as Record<string, unknown>).temperature, 0.3);
  assert.ok(!("temperature" in (without as Record<string, unknown>)));
  // Positive control: both are otherwise complete requests, not empty objects.
  for (const r of [withTemp, without]) {
    assert.ok(Array.isArray((r as Record<string, unknown>).input), "input must be present");
    assert.ok((r as Record<string, unknown>).text, "text.format must be present");
  }
});

// ── 2. a 400 is a misconfiguration, not an outage ────────────────────────────

function apiError(status: number, message: string): Error {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  return e;
}

test("400: reported as a configuration fault naming the model, NOT as an outage", async () => {
  process.env.OPENAI_MODEL = "gpt-5.6-terra";
  const token = await registerAndLogin("fourhundred@example.com");
  setOpenAINextErrorForTests(
    apiError(400, "Unsupported parameter: 'temperature' is not supported with this model.")
  );
  const res = await req<DiaryResponse>("POST", "/generate-diary", DIARY_BODY, token);

  assert.equal(res.status, 200, "positive control: a 400 from OpenAI still serves the user a diary");
  assert.equal(res.body.generation?.generator, "fallback", "positive control: it really did take the fallback path");
  const warning = res.body.warning ?? "";
  assert.ok(warning.length > 0, "positive control: a warning was produced at all");

  // The defect: this exact string sent a real investigation to OpenAI's status
  // page for a problem that was entirely in our own configuration.
  assert.ok(
    !/service was unavailable/i.test(warning),
    `a 400 must never be reported as an outage. Got: ${warning}`
  );
  assert.match(warning, /configuration problem/i, "it must name itself as a misconfiguration");
  assert.match(warning, /400/, "the status belongs in the message");
  assert.match(warning, /gpt-5\.6-terra/, "the model must be named — it is the value that is almost always wrong");
  assert.match(warning, /temperature/, "the provider's own reason must survive into the warning");
});

test("401 and 429 keep their own distinct messages", async () => {
  // Guards against the 400 branch swallowing its neighbours: a single catch-all
  // "configuration problem" would pass the test above while destroying the two
  // signals that already worked.
  const cases: Array<{ status: number; expect: RegExp }> = [
    { status: 401, expect: /key was rejected/i },
    { status: 429, expect: /quota or credits/i },
  ];
  for (const c of cases) {
    const token = await registerAndLogin(`status-${c.status}@example.com`);
    setOpenAINextErrorForTests(apiError(c.status, "boom"));
    const res = await req<DiaryResponse>("POST", "/generate-diary", DIARY_BODY, token);
    assert.equal(res.status, 200);
    const warning = res.body.warning ?? "";
    assert.match(warning, c.expect, `${c.status} must keep its specific message, got: ${warning}`);
    assert.ok(!/configuration problem/i.test(warning), `${c.status} is not a configuration fault`);
  }
});

test("a genuine outage (500) still reads as an outage", async () => {
  const token = await registerAndLogin("fivehundred@example.com");
  setOpenAINextErrorForTests(apiError(500, "upstream exploded"));
  const res = await req<DiaryResponse>("POST", "/generate-diary", DIARY_BODY, token);

  assert.equal(res.status, 200, "positive control: still served");
  assert.equal(res.body.generation?.generator, "fallback", "positive control: fallback path ran");
  // The "unavailable" wording is correct HERE. Narrowing it to 400 must not
  // delete it for the case it was always right about.
  assert.match(res.body.warning ?? "", /service was unavailable/i);
});
