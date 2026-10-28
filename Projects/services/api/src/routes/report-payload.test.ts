process.env.NODE_ENV = "test";
delete process.env.DATABASE_URL;
process.env.AUTH_TOKEN_SECRET = "report-payload-route-test-secret";
process.env.TRUST_PROXY_HOPS = "0";

import assert from "node:assert/strict";
import { test, before, after, beforeEach } from "node:test";
import http from "node:http";
import { createApp } from "../server";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import { resetFakeSendsForTests } from "../services/notificationService";

/**
 * What the generated document contains — AUDIT L97, and L96's response half.
 *
 * SCOPE, and why this file is in the in-memory suite. Every request here sends
 * its own `entries` array, which takes the branch of `resolveDiaryRequest` that
 * reads NO STORE. So what is under test is the HTTP contract and the template
 * generator's rendering: that the five dropped fields reach the report, that an
 * hourly entry is no longer generated from blank, and that the response says
 * how many entries could not be attributed.
 *
 * Attribution itself cannot be tested here, and deliberately so: the only
 * author name the server will use is one it resolved from the row's owner
 * against the caller's own company, which is store work. That half is in
 * `storage/report-payload-db.test.ts`. What this file proves about L96 is the
 * other, equally important half — that a CLIENT cannot supply attribution. Test
 * "a caller cannot attribute an entry to anyone" below is that assertion.
 *
 * These tests run with no OPENAI_API_KEY, so the template generator writes the
 * report. That is the right path to pin: it is what ships when the key is
 * missing or the provider is down, and unlike the model's prose it is
 * deterministic. The model is told the same fields (see `structuredPayload` in
 * ai.ts), and the system prompt now requires it to attribute each day.
 *
 * RED ON REVERT. Replace `effectiveEntryNotes(entry)` with `entry.notes` in
 * `normalizeEntry` and the hourly test goes red: the day's work disappears from
 * the report and is replaced by the "Site activities recorded" placeholder.
 * Restore `safetyObservations: "N/A"` and the safety test goes red on all
 * three fields at once.
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

const SITE = { name: "Payload Test Site", client: "Acme", address: "1 Test St" };

type Section = {
  date: string;
  recordedBy?: string;
  workCompleted: string;
  safetyObservations: string;
};

type DiaryRes = {
  success?: boolean;
  error?: string;
  entriesIncluded?: number;
  unattributedEntries?: number;
  ambiguousAuthorNames?: string[];
  diary?: { fullReport?: string; sections?: Section[]; safetyChecklist?: string[] };
};

/**
 * Every call sends an EXPLICIT March window. Without one the window is
 * anchored (AUDIT L92's preserved default) and a `daily` report would select
 * only the latest entry, so a fixture of three days would silently become a
 * report of one and these tests would be asserting against the wrong document.
 * All fixture dates below sit inside this range.
 */
const generate = (token: string, entries: Array<Record<string, unknown>>) =>
  req<DiaryRes>(
    "POST",
    "/generate-diary",
    { site: SITE, period: "monthly", from: "2026-03-01", to: "2026-03-31", entries },
    token
  );

test("an entry captured hour by hour reaches the report instead of generating blank", async () => {
  const token = await registerCompany("payload-hourly@example.com");

  // The shape the capture form saves for an hourly entry: `notes` empty, the
  // work in `hourlyNotes`, and every hour of the chosen window present.
  const hourlyNotes = [];
  for (let hour = 7; hour <= 12; hour += 1) hourlyNotes.push({ hour, note: "" });
  hourlyNotes[1].note = "Scaffold handover inspection with Kelly.";
  hourlyNotes[4].note = "Blockwork to lift 2, east elevation.";

  const res = await generate(token, [
    { date: "2026-03-02", notes: "", notesMode: "hourly", hourlyNotes, crewCount: "4" },
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const section = res.body.diary!.sections![0];
  assert.match(section.workCompleted, /08:00 — Scaffold handover inspection with Kelly\./);
  assert.match(section.workCompleted, /11:00 — Blockwork to lift 2, east elevation\./);
  assert.match(res.body.diary!.fullReport!, /Scaffold handover inspection with Kelly\./);
  // The form's empty hours are not printed into a compliance document.
  assert.doesNotMatch(section.workCompleted, /09:00 —/);

  // THE CONTROL, same endpoint, same test: the identical entry with the hourly
  // log removed is what the old payload effectively sent — and it generates the
  // placeholder. Without this assertion the one above would also pass if the
  // placeholder happened to contain the words.
  const blank = await generate(token, [
    { date: "2026-03-02", notes: "", notesMode: "hourly", hourlyNotes: [], crewCount: "4" },
  ]);
  assert.equal(blank.status, 200, JSON.stringify(blank.body));
  assert.match(
    blank.body.diary!.sections![0].workCompleted,
    /Site activities recorded/,
    "with no hourly log there is genuinely nothing to report, and the placeholder is correct"
  );
  assert.notEqual(
    section.workCompleted,
    blank.body.diary!.sections![0].workCompleted,
    "so the first report is not the placeholder"
  );
});

test("the safety record is reported, and 'not held' is not the same as unanswered", async () => {
  const token = await registerCompany("payload-safety@example.com");

  const res = await generate(token, [
    {
      date: "2026-03-03",
      notes: "Slab pour.",
      crewCount: "6",
      swmsRef: "SWMS-114",
      hazardNotes: "Open penetration at grid C4, barricaded and signed.",
      toolboxTalk: true,
    },
    { date: "2026-03-04", notes: "Formwork strip.", crewCount: "2", toolboxTalk: false },
    { date: "2026-03-05", notes: "Site clean.", crewCount: "1" },
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const [full, refused, silent] = res.body.diary!.sections!;

  assert.match(full.safetyObservations, /SWMS reference: SWMS-114/);
  assert.match(full.safetyObservations, /Hazards noted: Open penetration at grid C4/);
  assert.match(full.safetyObservations, /Toolbox talk: Held/);
  assert.match(refused.safetyObservations, /Toolbox talk: Not held/);

  // An entry that never answered must not acquire an answer in either
  // direction. The two assertions above are the positive control for this one:
  // both lines are printable, so their absence here is a decision, not a
  // renderer that does nothing.
  assert.doesNotMatch(silent.safetyObservations, /Toolbox talk/);
  assert.equal(silent.safetyObservations, "N/A", "nothing recorded still says so");

  // The hazard note is a safety observation by the field it was typed into, so
  // it reaches the checklist with no photograph beside it.
  assert.ok(
    res.body.diary!.safetyChecklist!.some((item) => /Open penetration at grid C4/.test(item)),
    `hazard notes must reach the checklist: ${JSON.stringify(res.body.diary!.safetyChecklist)}`
  );
  // And the control: the general notes field still does NOT, without evidence.
  assert.ok(
    !res.body.diary!.safetyChecklist!.some((item) => /Slab pour\./.test(item)),
    "general notes with no photograph are not safety observations"
  );
});

test("a caller cannot attribute an entry to anyone", async () => {
  const token = await registerCompany("payload-attrib@example.com");

  // A client-supplied entries array is the one branch where attribution could
  // be forged, so it is the one that must refuse to carry it. `authorName` is
  // not on the request schema; zod strips it before the route reads the body.
  const res = await generate(token, [
    { date: "2026-03-06", notes: "Steel erection.", crewCount: "8", authorName: "A. Fabrication" },
    { date: "2026-03-07", notes: "Deck pour.", crewCount: "8", recordedBy: "Someone Else" },
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const sections = res.body.diary!.sections!;
  assert.equal(sections.length, 2);
  for (const section of sections) {
    assert.equal(section.recordedBy, "Not recorded");
  }
  assert.doesNotMatch(res.body.diary!.fullReport!, /A\. Fabrication/);
  assert.doesNotMatch(res.body.diary!.fullReport!, /Someone Else/);

  // The report says how many entries it could not attribute, rather than
  // printing a blank and leaving the reader to count. Measured from the
  // response's own entry count, not written as a literal.
  assert.equal(res.body.unattributedEntries, res.body.entriesIncluded);
  assert.equal(res.body.unattributedEntries, 2);

  // THE CONTROL: the field is printable and the line exists — so "Not recorded"
  // above is a resolved value, not an absent one. If `recordedBy` were dropped
  // from the section the loop would compare undefined to undefined and pass.
  assert.match(res.body.diary!.fullReport!, /Recorded by: Not recorded/);
  assert.equal(
    (res.body.diary!.fullReport!.match(/Recorded by:/g) ?? []).length,
    sections.length,
    "one attribution line per day, measured against the sections returned"
  );
  // Nothing ambiguous to report on this branch, and the key is absent rather
  // than an empty array a client would have to interpret.
  assert.equal(res.body.ambiguousAuthorNames, undefined);
});
