process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
process.env.AUTH_TOKEN_SECRET = "report-window-route-test-secret";
process.env.TRUST_PROXY_HOPS = "0";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import { resetFakeSendsForTests } from "../services/notificationService";

/**
 * The HTTP contract for an explicit report window — AUDIT L92.
 *
 * SCOPE, and why this file is in the in-memory suite rather than the DB-gated
 * one. Every request here sends its own `entries` array, which takes the
 * branch of `resolveDiaryRequest` that reads NO STORE AT ALL (the branch
 * apps/supervisor-web/lib/api.ts documents at length, and the one the phone falls
 * back to when it has entries locally and the server has none). So these tests
 * exercise window parsing, refusal, the response contract and the report
 * header, none of which involve a store.
 *
 * The store-backed half — that the window filters in SQL before the limit, and
 * that a ranged read stays inside the caller's company — is in
 * `storage/report-range-db.test.ts`, against real Postgres, because that is
 * where the in-memory store and Postgres can disagree.
 *
 * RED ON REVERT. Remove the `from`/`to` fields from `GenerateDiaryBodySchema`
 * and zod strips them, every window becomes anchored, and test 1 goes red on
 * the included dates. Remove the `ReportWindowError` branch from the route's
 * catch and test 2 goes red: a bad range falls through to the template-fallback
 * path, which re-resolves, throws again, and answers "Failed to generate
 * diary." with a 400 that names nothing.
 */

let server: http.Server;
let baseUrl: string;

async function req<T = unknown>(
  method: string, path: string, body?: unknown, token?: string
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
        res.on("data", (c: string) => (data += c));
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

before(async () => {
  const app = createApp();
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { await new Promise<void>((res, rej) => server.close((e) => (e ? rej(e) : res()))); });
beforeEach(async () => {
  await resetAuthStoreForTests();
  resetRateLimitStoreForTests();
  resetFakeSendsForTests();
});

type RegBody = { devCodes?: { emailCode?: string; smsCode?: string }; token?: string };

let phoneCounter = 0;
const nextPhone = () => `+614${String(++phoneCounter).padStart(8, "0")}`;

async function registerCompany(email: string): Promise<string> {
  const reg = await req<RegBody>("POST", "/auth/register/initiate", {
    email, password: "Password123!", phone: nextPhone(), fullName: "Owner",
  });
  assert.equal(reg.status, 200, `stage 1: ${JSON.stringify(reg.body)}`);
  const ve = await req<RegBody>("POST", "/auth/register/verify-email", {
    email, emailCode: reg.body.devCodes!.emailCode!,
  });
  assert.equal(ve.status, 200, `stage 2: ${JSON.stringify(ve.body)}`);
  const done = await req<RegBody>("POST", "/auth/register/verify", {
    email, smsCode: ve.body.devCodes!.smsCode!,
  });
  assert.ok(done.status >= 200 && done.status < 300, `stage 3: ${JSON.stringify(done.body)}`);
  assert.ok(done.body.token, "registration must return a token");
  return done.body.token!;
}

/** Four entries spread over two months, so a window can select among them. */
const ENTRIES = [
  { date: "2026-02-26", notes: "Set out footings.", crewCount: "3" },
  { date: "2026-03-02", notes: "Poured slab.", crewCount: "4" },
  { date: "2026-03-05", notes: "Formwork strip.", crewCount: "2" },
  { date: "2026-04-20", notes: "Frame delivery.", crewCount: "5" },
];

const SITE = { name: "Window Test Site", client: "Acme", address: "1 Test St" };

type DiaryRes = {
  success?: boolean;
  error?: string;
  entriesIncluded?: number;
  undatedEntries?: number;
  reportWindow?: { from: string; to: string; period: string; mode: string; anchoredOn?: string };
  diary?: { fullReport?: string; sections?: Array<{ date: string }>; reportPeriod?: string };
};

const generate = (token: string, body: Record<string, unknown>) =>
  req<DiaryRes>("POST", "/generate-diary", { site: SITE, entries: ENTRIES, ...body }, token);

test("an explicit from/to selects the entries in that range and says so", async () => {
  const token = await registerCompany("window-a@example.com");

  const march = await generate(token, { period: "monthly", from: "2026-03-01", to: "2026-03-31" });
  assert.equal(march.status, 200, JSON.stringify(march.body));
  assert.deepEqual(march.body.reportWindow, {
    from: "2026-03-01",
    to: "2026-03-31",
    period: "monthly",
    mode: "explicit",
  });
  assert.deepEqual(
    march.body.diary?.sections?.map((s) => s.date),
    ["2026-03-02", "2026-03-05"],
    "only the March entries belong in a March window"
  );
  assert.equal(march.body.entriesIncluded, 2);

  // POSITIVE CONTROL on the same endpoint in the same test. The February and
  // April entries are in the payload either way — widen the window and they
  // appear, so their absence above is the range doing its job rather than the
  // request losing them.
  const wider = await generate(token, { period: "monthly", from: "2026-02-01", to: "2026-04-30" });
  assert.equal(wider.status, 200, JSON.stringify(wider.body));
  assert.deepEqual(
    wider.body.diary?.sections?.map((s) => s.date),
    ["2026-02-26", "2026-03-02", "2026-03-05", "2026-04-20"]
  );
  assert.equal(wider.body.entriesIncluded, 4);
});

test("the same dates asked for twice give the same report — the L92 defect itself", async () => {
  const token = await registerCompany("window-b@example.com");

  // The old anchored window moved with the data: the latest entry decided the
  // boundaries, so filing a new entry changed what "monthly" meant. Here the
  // same range is asked for against two different entry sets, one of which has
  // a later entry appended, and the window and its contents are identical.
  const first = await generate(token, { period: "monthly", from: "2026-03-01", to: "2026-03-31" });
  const withNewerEntry = await generate(token, {
    period: "monthly",
    from: "2026-03-01",
    to: "2026-03-31",
    entries: [...ENTRIES, { date: "2026-05-11", notes: "Later work.", crewCount: "6" }],
  });

  assert.equal(first.status, 200);
  assert.equal(withNewerEntry.status, 200);
  assert.deepEqual(withNewerEntry.body.reportWindow, first.body.reportWindow);
  assert.deepEqual(
    withNewerEntry.body.diary?.sections?.map((s) => s.date),
    first.body.diary?.sections?.map((s) => s.date)
  );

  // POSITIVE CONTROL that the appended entry is really there and really
  // reachable: ask for a window that contains it, and it arrives. So the
  // equality above is the window holding still, not the entry being dropped.
  const may = await generate(token, {
    period: "monthly",
    from: "2026-05-01",
    to: "2026-05-31",
    entries: [...ENTRIES, { date: "2026-05-11", notes: "Later work.", crewCount: "6" }],
  });
  assert.equal(may.status, 200, JSON.stringify(may.body));
  assert.deepEqual(may.body.diary?.sections?.map((s) => s.date), ["2026-05-11"]);
});

test("a range the caller cannot have meant is refused, in words, without a diary", async () => {
  const token = await registerCompany("window-c@example.com");

  const reversed = await generate(token, { period: "weekly", from: "2026-03-31", to: "2026-03-01" });
  assert.equal(reversed.status, 400, JSON.stringify(reversed.body));
  assert.match(String(reversed.body.error), /on or before/);
  assert.equal(reversed.body.diary, undefined, "a refused range must not produce a report");

  const malformed = await generate(token, { period: "weekly", from: "2026-02-31", to: "2026-03-01" });
  assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
  assert.match(String(malformed.body.error), /YYYY-MM-DD/);

  const half = await generate(token, { period: "weekly", from: "2026-03-01" });
  assert.equal(half.status, 400, JSON.stringify(half.body));

  const tooLong = await generate(token, { period: "monthly", from: "2026-01-01", to: "2026-12-31" });
  assert.equal(tooLong.status, 400, JSON.stringify(tooLong.body));
  assert.match(String(tooLong.body.error), /at most 92 days/);

  // POSITIVE CONTROL, same endpoint, same token, same entries: the identical
  // request with a range that makes sense succeeds. Four 400s alone would pass
  // just as well against a route that had been deleted or an auth check that
  // had started refusing everyone.
  const ok = await generate(token, { period: "weekly", from: "2026-03-01", to: "2026-03-07" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.diary, "the control request must return a real diary");
});

test("a caller that sends no range gets the old window, and is told it was derived", async () => {
  const token = await registerCompany("window-d@example.com");

  // This is the deploy-safety case: the API ships before both clients, so every
  // request in that gap looks like this one. The behaviour must be the old
  // behaviour — the window anchored on the latest entry, 2026-04-20 — and the
  // response must now say that is what happened.
  const anchored = await generate(token, { period: "monthly" });
  assert.equal(anchored.status, 200, JSON.stringify(anchored.body));
  assert.deepEqual(anchored.body.reportWindow, {
    from: "2026-04-01",
    to: "2026-04-20",
    period: "monthly",
    mode: "anchored",
    anchoredOn: "2026-04-20",
  });
  assert.deepEqual(anchored.body.diary?.sections?.map((s) => s.date), ["2026-04-20"]);

  // And the report itself carries the dates plus the note that they were
  // inferred, so a saved PDF is not silent about what it covered.
  const report = String(anchored.body.diary?.fullReport);
  assert.match(report, /Report Period: Monthly — 1 April 2026 – 20 April 2026/);
  assert.match(report, /Dates derived from the latest recorded entry \(2026-04-20\)/);

  // POSITIVE CONTROL for that second assertion: an explicit window prints the
  // dates and must NOT carry the derived-from note, so the note is tracking
  // `mode` rather than being printed unconditionally.
  const explicit = await generate(token, { period: "monthly", from: "2026-03-01", to: "2026-03-31" });
  const explicitReport = String(explicit.body.diary?.fullReport);
  assert.match(explicitReport, /Report Period: Monthly — 1 March 2026 – 31 March 2026/);
  assert.doesNotMatch(explicitReport, /Dates derived/);
});

test("an empty window is refused with the dates it searched", async () => {
  const token = await registerCompany("window-e@example.com");

  const empty = await generate(token, { period: "weekly", from: "2026-06-01", to: "2026-06-07" });
  assert.equal(empty.status, 400, JSON.stringify(empty.body));
  assert.match(
    String(empty.body.error),
    /No entries are available between 2026-06-01 and 2026-06-07/,
    "the old message named 'the selected report period', which the caller could not see"
  );
  assert.deepEqual(empty.body.reportWindow, {
    from: "2026-06-01",
    to: "2026-06-07",
    period: "weekly",
    mode: "explicit",
  });

  // POSITIVE CONTROL: the same payload with a populated window succeeds, so the
  // refusal is the window being empty rather than the entries never arriving.
  const populated = await generate(token, { period: "weekly", from: "2026-03-01", to: "2026-03-07" });
  assert.equal(populated.status, 200, JSON.stringify(populated.body));
  assert.equal(populated.body.entriesIncluded, 2);
});

test("an undated entry is excluded and counted, not folded into the window", async () => {
  const token = await registerCompany("window-f@example.com");

  const withUndated = await generate(token, {
    period: "weekly",
    from: "2026-03-01",
    to: "2026-03-07",
    entries: [...ENTRIES, { notes: "Filed with no date.", crewCount: "1" }],
  });

  assert.equal(withUndated.status, 200, JSON.stringify(withUndated.body));
  assert.deepEqual(withUndated.body.diary?.sections?.map((s) => s.date), ["2026-03-02", "2026-03-05"]);
  assert.equal(withUndated.body.undatedEntries, 1, "the undated entry must be reported, not silently dropped");

  // POSITIVE CONTROL: the same request without that entry reports no undated
  // entries at all, so the count above is counting something real.
  const without = await generate(token, { period: "weekly", from: "2026-03-01", to: "2026-03-07" });
  assert.equal(without.status, 200);
  assert.equal(without.body.undatedEntries, undefined);
  assert.deepEqual(without.body.diary?.sections?.map((s) => s.date), ["2026-03-02", "2026-03-05"]);
});
