// Live contract suite. Gated on OPENAI_LIVE_TEST_KEY and OPT-IN ONLY: it makes
// real, billable calls to the OpenAI API and is deliberately NOT part of CI.
//   pnpm -C Projects --filter services-api run test:openai
process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
process.env.AUTH_TOKEN_SECRET = "ai-openai-contract-test-secret";

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDiaryRequest, SYSTEM_PROMPT } from "./ai";

/**
 * Why this file exists, when ai-model-params.test.ts already covers the same fix.
 *
 * The boundary mock in openaiClient.ts returns a canned success for ANY argument
 * object. It can prove we sent the parameters we meant to; it cannot prove the
 * provider accepts them. SITESNAP-API-9 lived precisely in that gap: the mocked
 * suite was green for the entire life of the bug, because a fake OpenAI is
 * perfectly happy with a `temperature` that the real gpt-5.6-terra rejects with
 * a 400.
 *
 * So this suite sends the ACTUAL production request body — built by the same
 * buildDiaryRequest() the route calls, carrying the real SYSTEM_PROMPT — to the
 * real API, and asserts the provider accepts it. The third test is the one that
 * makes the other two mean something: it proves the parameter really is refused
 * when we put it back, so the capability table describes a live constraint
 * rather than a superstition we are now carrying forever.
 *
 * It is not in CI on purpose: CI has no key, the calls cost money, and a green
 * build must never depend on a third party's availability. Run it by hand when
 * changing the request shape or the model.
 */

const KEY = process.env.OPENAI_LIVE_TEST_KEY;
const skip = KEY ? false : "OPENAI_LIVE_TEST_KEY is not set (opt-in, billable)";

const SAMPLE_CONTENT = [
  {
    type: "input_text" as const,
    text: JSON.stringify({
      reportContext: { period: "daily", totalEntries: 1, totalPhotosAttached: 0 },
      entries: [{ date: "2026-01-01", notes: "Poured the ground-floor slab.", weather: "Fine", crewCount: "4" }],
    }),
  },
];

async function postToOpenAI(body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

function errorMessage(json: Record<string, unknown>): string {
  const e = json.error as { message?: string } | undefined;
  return e?.message ?? "";
}

test("the production request body is accepted by gpt-5.6-terra", { skip }, async () => {
  const body = buildDiaryRequest("gpt-5.6-terra", SYSTEM_PROMPT, SAMPLE_CONTENT);

  // Positive control on the fixture itself: if the builder ever stopped
  // omitting temperature, this test would still be asserting the wrong body.
  assert.ok(!("temperature" in body), "precondition: the builder omits temperature for this model");

  const { status, json } = await postToOpenAI(body);
  assert.equal(status, 200, `the real API rejected our production request: ${errorMessage(json)}`);
  // Positive control on the response: a 200 that produced nothing would mean
  // the parameter set is accepted but the request is useless.
  assert.ok(json.output, "the response must actually carry output");
});

test("the production request body is accepted by gpt-4o, temperature included", { skip }, async () => {
  const body = buildDiaryRequest("gpt-4o", SYSTEM_PROMPT, SAMPLE_CONTENT);

  assert.equal(
    (body as Record<string, unknown>).temperature, 0.3,
    "precondition: gpt-4o is supposed to RECEIVE temperature — this is the revert path"
  );

  const { status, json } = await postToOpenAI(body);
  assert.equal(status, 200, `gpt-4o rejected a request we believe it accepts: ${errorMessage(json)}`);
  assert.ok(json.output, "the response must actually carry output");
});

test("putting temperature back really does 400 on gpt-5.6-terra", { skip }, async () => {
  // Red-on-revert, against the provider rather than against our own mock. If
  // this ever starts passing, the model has gained sampling support and
  // MODELS_SUPPORTING_SAMPLING_PARAMS should be updated — the fix is not
  // load-bearing any more and this file is how you find that out.
  const body = { ...buildDiaryRequest("gpt-5.6-terra", SYSTEM_PROMPT, SAMPLE_CONTENT), temperature: 0.3 };

  const { status, json } = await postToOpenAI(body);
  assert.equal(status, 400, "the constraint this whole fix rests on has changed — re-verify the capability table");
  assert.match(
    errorMessage(json), /temperature/i,
    "the 400 must actually be about temperature, not some unrelated rejection"
  );
});
