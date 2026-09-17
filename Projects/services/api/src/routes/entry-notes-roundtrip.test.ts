/**
 * Entry notesMode / hourlyNotes round-trip (feature 5b).
 *
 * Proves the fields the mobile client sends for hourly notes are not
 * silently stripped by the route schema or dropped by the store —
 * the exact class of bug that caused prior incidents (a field the client
 * writes that the server accepts but never actually persists/returns).
 */

delete process.env.DATABASE_URL;
process.env.AUTH_TOKEN_SECRET = "entry-notes-test-secret";
process.env.NODE_ENV = "test";

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
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as T });
          } catch {
            reject(new Error(`Non-JSON (${res.statusCode}): ${data}`));
          }
        });
      }
    );
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// Global counter: phone numbers must be unique across all registrations in a test run.
let _phoneSeq = 0;
function nextPhone() { return `+614${String(++_phoneSeq).padStart(8, "0")}`; }

/** Register + verify a user, returning their auth token. */
async function registerUser(email: string, name: string, companyName?: string): Promise<string> {
  const regBody: Record<string, string> = { email, phone: nextPhone(), fullName: name, password: "Password123!!" };
  if (companyName) regBody.companyName = companyName;
  const regRes = await req<{ ok: boolean; devCodes?: { emailCode: string } }>(
    "POST", "/auth/register", regBody
  );
  assert.equal(regRes.status, 200, `register ${email} failed: ${JSON.stringify(regRes.body)}`);
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
  assert.equal(verRes.status, 201, `verify ${email} failed: ${JSON.stringify(verRes.body)}`);
  return verRes.body.token;
}

type Entry = {
  id: string;
  siteId: string;
  notes: string;
  notesMode: "free" | "hourly";
  hourlyNotes: Array<{ hour: number; note: string }>;
};

async function createSite(token: string): Promise<string> {
  const siteRes = await req<{ site: { id: string } }>(
    "POST", "/projects/sites",
    { name: "Notes Round-trip Site", address: "1 Note St", client: "QA", startDate: "2026-03-01", status: "active" },
    token
  );
  assert.equal(siteRes.status, 201, `site create failed: ${JSON.stringify(siteRes.body)}`);
  return siteRes.body.site.id;
}

async function findEntry(token: string, siteId: string, entryId: string): Promise<Entry> {
  const listRes = await req<{ entries: Entry[] }>("GET", `/projects/entries?siteId=${siteId}`, undefined, token);
  assert.equal(listRes.status, 200, `entry list failed: ${JSON.stringify(listRes.body)}`);
  const found = listRes.body.entries.find((e) => e.id === entryId);
  assert.ok(found, `entry ${entryId} not found in list: ${JSON.stringify(listRes.body.entries)}`);
  return found as Entry;
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

beforeEach(async () => {
  resetAuthStoreForTests();
  resetProjectStoreForTests();
  resetRateLimitStoreForTests();
});

test("hourly create round-trips notesMode and hourlyNotes (including an empty-note hour) through create + list", async () => {
  const token = await registerUser("owner@notes.test", "Owner", "Notes Co");
  const siteId = await createSite(token);

  const hourlyNotes = [
    { hour: 7, note: "Poured slab" },
    { hour: 9, note: "" },
    { hour: 13, note: "Final inspection" },
  ];

  const createRes = await req<{ entry: Entry }>(
    "POST", "/projects/entries",
    {
      siteId,
      date: "2026-03-01",
      locationAddress: "1 Note St",
      weather: "Sunny",
      crewCount: "4",
      notesMode: "hourly",
      hourlyNotes,
      photos: [],
    },
    token
  );
  assert.equal(createRes.status, 201, `entry create failed: ${JSON.stringify(createRes.body)}`);
  const entryId = createRes.body.entry.id;

  const stored = await findEntry(token, siteId, entryId);
  assert.equal(stored.notesMode, "hourly");
  assert.deepEqual(stored.hourlyNotes, hourlyNotes);
});

test("entry created without notesMode/hourlyNotes defaults to free mode and an empty hourlyNotes array", async () => {
  const token = await registerUser("owner@notes.test", "Owner", "Notes Co");
  const siteId = await createSite(token);

  const createRes = await req<{ entry: Entry }>(
    "POST", "/projects/entries",
    {
      siteId,
      date: "2026-03-01",
      locationAddress: "1 Note St",
      weather: "Sunny",
      crewCount: "4",
      notes: "Standard free-text entry, no hourly notes sent.",
      photos: [],
    },
    token
  );
  assert.equal(createRes.status, 201, `entry create failed: ${JSON.stringify(createRes.body)}`);
  const entryId = createRes.body.entry.id;

  const stored = await findEntry(token, siteId, entryId);
  assert.equal(stored.notesMode, "free");
  assert.deepEqual(stored.hourlyNotes, []);
});

test("patching a free entry to hourly round-trips notesMode and hourlyNotes", async () => {
  const token = await registerUser("owner@notes.test", "Owner", "Notes Co");
  const siteId = await createSite(token);

  const createRes = await req<{ entry: Entry }>(
    "POST", "/projects/entries",
    {
      siteId,
      date: "2026-03-01",
      locationAddress: "1 Note St",
      weather: "Sunny",
      crewCount: "4",
      notes: "Free-text entry to be patched to hourly.",
      photos: [],
    },
    token
  );
  assert.equal(createRes.status, 201, `entry create failed: ${JSON.stringify(createRes.body)}`);
  const entryId = createRes.body.entry.id;

  const patchedHourlyNotes = [
    { hour: 8, note: "Delivered materials" },
    { hour: 15, note: "Site cleanup" },
  ];

  const patchRes = await req<{ entry: Entry }>(
    "PATCH", `/projects/entries/${entryId}`,
    { notesMode: "hourly", hourlyNotes: patchedHourlyNotes },
    token
  );
  assert.equal(patchRes.status, 200, `entry patch failed: ${JSON.stringify(patchRes.body)}`);

  const stored = await findEntry(token, siteId, entryId);
  assert.equal(stored.notesMode, "hourly");
  assert.deepEqual(stored.hourlyNotes, patchedHourlyNotes);
});

test("entry explicitly created in free mode round-trips notes text and notesMode", async () => {
  const token = await registerUser("owner@notes.test", "Owner", "Notes Co");
  const siteId = await createSite(token);

  const freeNotes = "Poured foundations, crew of four, weather held off until the afternoon.";

  const createRes = await req<{ entry: Entry }>(
    "POST", "/projects/entries",
    {
      siteId,
      date: "2026-03-01",
      locationAddress: "1 Note St",
      weather: "Sunny",
      crewCount: "4",
      notesMode: "free",
      notes: freeNotes,
      photos: [],
    },
    token
  );
  assert.equal(createRes.status, 201, `entry create failed: ${JSON.stringify(createRes.body)}`);
  const entryId = createRes.body.entry.id;

  const stored = await findEntry(token, siteId, entryId);
  assert.equal(stored.notesMode, "free");
  assert.equal(stored.notes, freeNotes);
});
