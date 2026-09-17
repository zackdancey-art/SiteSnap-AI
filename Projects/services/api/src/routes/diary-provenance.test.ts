// In-memory harness (CLAUDE.md §6): no real DB, no network.
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = "";
process.env.AUTH_TOKEN_SECRET = "diary-provenance-test-secret";
// This file exercises the "never even tried" path — the one production has
// actually been on since the OpenAI credits ran out. Blanked rather than
// deleted, for the reason test-setup.ts documents: server.ts calls
// dotenv.config() later, and dotenv repopulates a key that is ABSENT but leaves
// one that is empty alone. A `delete` here reads as "no key" but silently
// becomes the developer's real key from .env — a test that passes locally and
// fails in CI, which is the defect class this suite just spent a day on.
process.env.OPENAI_API_KEY = "";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests } from "../storage/projectsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";

// C1: a site diary is an evidentiary document. Before this, a diary written by
// the rule-based template generator was byte-identical in every response, every
// export and every database row to one written by the AI. These tests hold the
// three things that fix requires:
//   1. The no-key path declares itself instead of returning silently.
//   2. Provenance survives the round trip into storage.
//   3. Provenance the server did not mint is refused and stored as NULL —
//      unknown, never the generator it claimed to be.

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

async function registerAndLogin(email: string, phone: string): Promise<string> {
  const reg = await req<{ devCodes?: { emailCode: string } }>(
    "POST", "/auth/register",
    { email, password: "Password123!", phone, fullName: "Diary User" }
  );
  const { emailCode } = reg.body.devCodes!;
  const veRes = await req<{ devCodes?: { smsCode: string } }>(
    "POST", "/auth/register/verify-email", { email, emailCode }
  );
  const { smsCode } = veRes.body.devCodes!;
  const verify = await req<{ token: string }>("POST", "/auth/register/verify", { email, smsCode });
  return verify.body.token;
}

type Provenance = {
  generator: string;
  model: string | null;
  promptVersion: string;
  warning: string | null;
  generatedAtMs: number;
  tokenUsage: { input: number; output: number } | null;
  signature: string;
};

type DiaryResponse = {
  success: boolean;
  diary?: { summary: string; fullReport: string; sections: unknown[]; safetyChecklist: string[] };
  generation?: Provenance;
  warning?: string;
};

type SavedDiary = {
  id: string;
  siteId: string;
  summary: string;
  generation: Omit<Provenance, "signature"> | null;
};

const DIARY_BODY = {
  period: "daily",
  entries: [{ date: "2026-01-01", notes: "Poured the ground-floor slab.", weather: "Fine", crewCount: "4" }],
};

let phoneCounter = 7100;
const nextPhone = () => `+614${String(phoneCounter++).padStart(8, "0")}`;

async function createSite(token: string, name: string): Promise<string> {
  const r = await req<{ site: { id: string } }>(
    "POST", "/projects/sites",
    { name, client: "Client", address: "1 Test St", startDate: "2026-01-01", status: "active" },
    token
  );
  return r.body.site.id;
}

async function saveDiary(
  token: string,
  siteId: string,
  generation: unknown
): Promise<{ status: number; diary: SavedDiary }> {
  const r = await req<{ diary: SavedDiary }>(
    "POST", "/projects/diaries",
    {
      siteId,
      status: "draft",
      summary: "Slab poured.",
      reportPeriod: "daily",
      fullReport: "Full report text.",
      safetyChecklist: [],
      sections: [],
      ...(generation === undefined ? {} : { generation }),
    },
    token
  );
  return { status: r.status, diary: r.body.diary };
}

test("no API key: the response says a template wrote it, instead of saying nothing", async () => {
  const token = await registerAndLogin("prov-nokey@example.com", nextPhone());

  const r = await req<DiaryResponse>("POST", "/generate-diary", DIARY_BODY, token);

  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.ok(r.body.diary && r.body.diary.fullReport.length > 20, "a real diary was still produced");

  // This is the regression that matters. This path used to return the template
  // output with no warning at all — quieter than the 401/429 paths, which at
  // least set one — so a missing key looked exactly like a successful AI run.
  assert.equal(r.body.generation?.generator, "fallback");
  assert.equal(r.body.generation?.model, null);
  assert.match(r.body.generation?.warning ?? "", /not AI/i);
  assert.match(r.body.generation?.warning ?? "", /No OpenAI API key/i);
  assert.match(r.body.warning ?? "", /No OpenAI API key/i);
  assert.ok((r.body.generation?.signature ?? "").length > 0, "provenance is signed");
});

test("signed provenance round-trips into the stored diary", async () => {
  const token = await registerAndLogin("prov-roundtrip@example.com", nextPhone());
  const siteId = await createSite(token, "Round Trip Site");

  const gen = await req<DiaryResponse>("POST", "/generate-diary", DIARY_BODY, token);
  const provenance = gen.body.generation!;

  const saved = await saveDiary(token, siteId, provenance);
  assert.equal(saved.status, 201);
  assert.equal(saved.diary.generation?.generator, "fallback");
  assert.equal(saved.diary.generation?.promptVersion, provenance.promptVersion);
  assert.equal(saved.diary.generation?.generatedAtMs, provenance.generatedAtMs);
  // The signature is a transport credential, not part of the record.
  assert.equal(
    (saved.diary.generation as Record<string, unknown> | null)?.signature,
    undefined,
    "the signature is not stored alongside the record it authenticates"
  );

  const listed = await req<{ diaries: SavedDiary[] }>("GET", `/projects/diaries?siteId=${siteId}`, undefined, token);
  const fromDb = listed.body.diaries.find((d) => d.id === saved.diary.id);
  assert.equal(fromDb?.generation?.generator, "fallback", "provenance survives a read back");
});

test("forged provenance is refused and stored as NULL, not as the generator it claimed", async () => {
  const token = await registerAndLogin("prov-forged@example.com", nextPhone());
  const siteId = await createSite(token, "Forgery Site");

  const gen = await req<DiaryResponse>("POST", "/generate-diary", DIARY_BODY, token);
  const real = gen.body.generation!;

  // The client saves the diary in a SEPARATE request from the one that
  // generated it, so without verification any authenticated user could upgrade
  // their own template output to "written by GPT-4o" — on a document that can
  // end up in front of a QS or an insurer.
  const forged = { ...real, generator: "openai", model: "gpt-4o", warning: null };

  const saved = await saveDiary(token, siteId, forged);
  assert.equal(saved.status, 201, "the diary still saves; only the unprovable claim is dropped");
  assert.equal(
    saved.diary.generation,
    null,
    "a claim the server did not mint is stored as unknown, never as the claim itself"
  );
});

test("provenance minted for another company cannot be replayed", async () => {
  const tokenA = await registerAndLogin("prov-tenant-a@example.com", nextPhone());
  const tokenB = await registerAndLogin("prov-tenant-b@example.com", nextPhone());
  const siteB = await createSite(tokenB, "Tenant B Site");

  const gen = await req<DiaryResponse>("POST", "/generate-diary", DIARY_BODY, tokenA);
  const provenanceFromA = gen.body.generation!;

  const saved = await saveDiary(tokenB, siteB, provenanceFromA);
  assert.equal(saved.status, 201);
  assert.equal(
    saved.diary.generation,
    null,
    "the signature is bound to companyId, so another tenant's valid record is still unusable here"
  );
});

test("unsigned and malformed provenance are both refused", async () => {
  const token = await registerAndLogin("prov-unsigned@example.com", nextPhone());
  const siteId = await createSite(token, "Unsigned Site");

  const bare = {
    generator: "openai",
    model: "gpt-4o",
    promptVersion: "2026-09-v1",
    warning: null,
    generatedAtMs: Date.now(),
    tokenUsage: null,
  };
  assert.equal((await saveDiary(token, siteId, bare)).diary.generation, null, "no signature at all");
  assert.equal((await saveDiary(token, siteId, { signature: "x" })).diary.generation, null, "signature only");
  assert.equal((await saveDiary(token, siteId, "openai")).diary.generation, null, "not an object");
  assert.equal((await saveDiary(token, siteId, null)).diary.generation, null, "explicit null");
});

test("a diary saved with no provenance records NULL, not a guess", async () => {
  const token = await registerAndLogin("prov-absent@example.com", nextPhone());
  const siteId = await createSite(token, "No Provenance Site");

  const saved = await saveDiary(token, siteId, undefined);
  assert.equal(saved.status, 201);
  assert.equal(saved.diary.generation, null);
});

test("PATCH cannot set or change provenance", async () => {
  const token = await registerAndLogin("prov-patch@example.com", nextPhone());
  const siteId = await createSite(token, "Patch Site");

  const gen = await req<DiaryResponse>("POST", "/generate-diary", DIARY_BODY, token);
  const saved = await saveDiary(token, siteId, gen.body.generation!);
  assert.equal(saved.diary.generation?.generator, "fallback");

  // Provenance describes what produced the original text. Editing the text is
  // what the edit log is for; it can never turn a template report into an AI one.
  const patched = await req<{ diary: SavedDiary }>(
    "PATCH", `/projects/diaries/${saved.diary.id}`,
    { summary: "Edited by hand.", generation: { generator: "openai", model: "gpt-4o", signature: "whatever" } },
    token
  );

  assert.equal(patched.status, 200);
  assert.equal(patched.body.diary.summary, "Edited by hand.", "the editable field did change");
  assert.equal(patched.body.diary.generation?.generator, "fallback", "the provenance did not");
  assert.equal(patched.body.diary.generation?.model, null);
});
