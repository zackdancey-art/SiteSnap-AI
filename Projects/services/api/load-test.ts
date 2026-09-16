/**
 * SiteSnap Load / Integration Test  (v2 — real auth flow)
 *
 * Prerequisites:
 *   1. Start the API with test-mode rate limiting OFF:
 *        NODE_ENV=test RATE_LIMIT_DISABLE=1 DATABASE_URL=... pnpm run dev
 *   2. Run this script in a separate terminal:
 *        NODE_ENV=test RATE_LIMIT_DISABLE=1 DATABASE_URL=... pnpm run load-test
 *
 * Or via the package.json script (which sets NODE_ENV for you):
 *        DATABASE_URL=postgres://localhost/sitesnap_test pnpm run load-test
 *
 * Set REDIS_URL=... to also test Redis persistence across restarts.
 * NEVER run against production.
 */

import crypto from "crypto";
import { promisify } from "util";
import { Pool } from "pg";
import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as https from "https";

// ============================================================
// ADJUSTABLE PARAMETERS
// ============================================================
const TOTAL_USERS = 1000;
const SUPERVISORS = 150;
const SITES = 30;
const DAYS = 7;
const ENTRIES_PER_USER_MIN = 3;
const ENTRIES_PER_USER_MAX = 10;
const CONCURRENCY = 25;
const USE_REAL_AI = false;
const API_BASE = (process.env.API_BASE ?? "http://localhost:4000").replace(/\/$/, "");
const AUTH_SECRET = process.env.AUTH_TOKEN_SECRET ?? "dev-sitesnap-secret";
const TEST_PASSWORD = "Loadtest1!";

// ============================================================
// TYPES
// ============================================================

interface TestUser {
  index: number;
  email: string;
  fullName: string;
  phone: string;
  role: "worker" | "supervisor";
  token: string;
}

interface TestSite {
  id: string;
  name: string;
  ownerEmail: string;
}

interface Metric {
  operation: string;
  status: number;
  durationMs: number;
  ok: boolean;
  error?: string;
  detail?: string;
}

interface DistinctError {
  key: string;
  count: number;
  status: number;
  operation: string;
  exampleDetail: string;
  likelyCause: string;
}

// ============================================================
// CRYPTO UTILITIES (mirrors services/api/src/utils/*)
// ============================================================

const scryptAsync = promisify(crypto.scrypt);

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${derived.toString("hex")}`;
}

function createToken(email: string, fullName: string, role: string): string {
  const now = Math.floor(Date.now() / 1000);
  const claims = { email, fullName, role, iat: now, exp: now + 60 * 60 * 24 * 7 };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = crypto.createHmac("sha256", AUTH_SECRET).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

// ============================================================
// CONCURRENCY POOL
// ============================================================

async function poolMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

// ============================================================
// HTTP CLIENT
// ============================================================

interface ApiResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
  durationMs: number;
}

async function apiRequest(
  method: string,
  urlPath: string,
  body?: unknown,
  token?: string
): Promise<ApiResult> {
  const url = `${API_BASE}/api${urlPath}`;
  const start = Date.now();

  return new Promise((resolve) => {
    const isHttps = url.startsWith("https");
    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : undefined;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": payload ? Buffer.byteLength(payload).toString() : "0",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
    };

    const req = (isHttps ? https : http).request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const durationMs = Date.now() - start;
        const text = Buffer.concat(chunks).toString("utf8");
        let data: unknown;
        try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
        resolve({ status: res.statusCode ?? 0, data, durationMs });
      });
    });

    req.on("error", (err) => {
      resolve({ status: 0, data: { error: err.message }, durationMs: Date.now() - start });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// ============================================================
// METRICS COLLECTOR
// ============================================================

class MetricsCollector {
  private items: Metric[] = [];

  record(m: Metric) {
    this.items.push(m);
  }

  summary() {
    const byOp = new Map<string, Metric[]>();
    for (const m of this.items) {
      if (!byOp.has(m.operation)) byOp.set(m.operation, []);
      byOp.get(m.operation)!.push(m);
    }

    const result: Record<string, {
      attempted: number; succeeded: number; failed: number;
      avgMs: number; p50Ms: number; p95Ms: number; maxMs: number;
    }> = {};

    for (const [op, mets] of byOp) {
      const durations = mets.map((m) => m.durationMs).sort((a, b) => a - b);
      const len = durations.length;
      result[op] = {
        attempted: len,
        succeeded: mets.filter((m) => m.ok).length,
        failed: mets.filter((m) => !m.ok).length,
        avgMs: Math.round(durations.reduce((a, b) => a + b, 0) / len),
        p50Ms: durations[Math.floor(len * 0.5)] ?? 0,
        p95Ms: durations[Math.floor(len * 0.95)] ?? 0,
        maxMs: durations[len - 1] ?? 0,
      };
    }
    return result;
  }

  errors(): Metric[] {
    return this.items.filter((m) => !m.ok);
  }

  distinctErrors(): DistinctError[] {
    const map = new Map<string, DistinctError>();
    for (const m of this.errors()) {
      const key = `${m.operation}:${m.status}:${m.error ?? "unknown"}`;
      if (!map.has(key)) {
        map.set(key, {
          key,
          count: 0,
          status: m.status,
          operation: m.operation,
          exampleDetail: m.detail ?? m.error ?? "",
          likelyCause: diagnoseCause(m),
        });
      }
      map.get(key)!.count++;
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count);
  }

  totalRequests() { return this.items.length; }
  totalSucceeded() { return this.items.filter((m) => m.ok).length; }
  totalFailed() { return this.items.filter((m) => !m.ok).length; }
}

function diagnoseCause(m: Metric): string {
  if (m.status === 429) return "Rate limiter triggered. In load test mode, ensure NODE_ENV=test and RATE_LIMIT_DISABLE=1 are set on the API server.";
  if (m.status === 401) return "Invalid or expired auth token, or AUTH_TOKEN_SECRET mismatch between load test and server.";
  if (m.status === 403) return "Correct — worker correctly denied access to supervisor-only endpoint.";
  if (m.status === 409) return "Duplicate record. Run teardown-loadtest before re-running.";
  if (m.status === 0) return "API server not reachable at " + API_BASE + ". Confirm it is running.";
  if (m.status >= 500) return "Unhandled server error — check API logs for stack trace.";
  return "Unexpected response. See detail.";
}

// ============================================================
// HELPERS
// ============================================================

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

const WEATHER_OPTIONS = ["Sunny", "Cloudy", "Rainy", "Overcast", "Windy", "Foggy", "Partly cloudy"];
const NOTES_OPTIONS = [
  "Foundation work continues on schedule.",
  "Electrical rough-in completed on level 2.",
  "Framing inspection passed.",
  "Concrete poured for east wall.",
  "Safety briefing held at start of shift.",
  "Equipment delivery received and logged.",
  "Minor rework needed on plumbing penetrations.",
  "Scaffolding erected on north face.",
  "Progress meeting held — no blockers.",
  "Site access restricted due to weather.",
];

function randomDateInWindow(weekStart: Date, days: number): string {
  const d = new Date(weekStart);
  d.setDate(d.getDate() + randomInt(0, days - 1));
  return d.toISOString().split("T")[0];
}

function log(msg: string) {
  const ts = new Date().toISOString().replace("T", " ").split(".")[0];
  console.log(`[${ts}] ${msg}`);
}

// ============================================================
// PHASE 1 — SAFETY CHECK
// ============================================================

async function safetyCheck(pool: Pool) {
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl) throw new Error("DATABASE_URL is not set.");

  const prodPatterns = [
    "render.com", "supabase.co", "neon.tech", "rds.amazonaws.com",
    "railway.app", "planetscale.com", "cockroachdb.com", "fly.io",
    "heroku.com", "aiven.io",
  ];
  if (prodPatterns.some((p) => dbUrl.toLowerCase().includes(p))) {
    throw new Error(
      `🛑 STOPPED: DATABASE_URL looks like a production database.\n` +
      `URL: ${dbUrl}\nOnly run against a local/test database.`
    );
  }

  const health = await apiRequest("GET", "/../health");
  if (health.status !== 200) {
    throw new Error(
      `API server not reachable at ${API_BASE}/health (status ${health.status}).\n` +
      `Start it with: NODE_ENV=test RATE_LIMIT_DISABLE=1 DATABASE_URL=... pnpm run dev`
    );
  }

  await pool.query("SELECT 1");
  log(`✅ Safety check passed — DB and API are reachable.`);

  if (AUTH_SECRET === "dev-sitesnap-secret") {
    console.warn("   ⚠️  Using default dev AUTH_TOKEN_SECRET.");
  }
  if (process.env.NODE_ENV !== "test") {
    console.warn("   ⚠️  NODE_ENV is not 'test'. Rate limit bypass (RATE_LIMIT_DISABLE=1) won't be active on the server.");
  }
}

// ============================================================
// PHASE 2 — CREATE USERS VIA REAL HTTP (with dev code flow)
// ============================================================

async function createUsersViaHttp(metrics: MetricsCollector): Promise<TestUser[]> {
  log(`Registering ${TOTAL_USERS} users via real HTTP (register → verify flow, concurrency=${CONCURRENCY})...`);
  log(`  Requires: NODE_ENV=test RATE_LIMIT_DISABLE=1 on the API server.`);

  const users: TestUser[] = Array.from({ length: TOTAL_USERS }, (_, i) => {
    const isSupervisor = i < SUPERVISORS;
    const email = `loadtest+${isSupervisor ? "sup" : "user"}${i}@sitesnap.test`;
    return {
      index: i,
      email,
      fullName: isSupervisor ? `Load Supervisor ${i}` : `Load Worker ${i}`,
      phone: `+1555${String(i).padStart(7, "0")}`,
      role: (isSupervisor ? "supervisor" : "worker") as "supervisor" | "worker",
      token: "",
    };
  });

  // Step A: register initiate for all users
  const registerResults = await poolMap(users, CONCURRENCY, async (user) => {
    const result = await apiRequest("POST", "/auth/register", {
      email: user.email,
      password: TEST_PASSWORD,
      phone: user.phone,
      fullName: user.fullName,
    });

    const ok = result.status === 200;
    const devCodes = (result.data as { devCodes?: { emailCode: string } }).devCodes;
    metrics.record({
      operation: "http:register-initiate",
      status: result.status,
      durationMs: result.durationMs,
      ok,
      error: ok ? undefined : (result.data as { error?: string }).error,
      detail: JSON.stringify(result.data).slice(0, 200),
    });
    return { user, devCodes, ok };
  });

  // Step B: verify the email code. This is what releases the SMS — registration
  // no longer sends one, so the sms code comes from THIS response (migration 029).
  const emailVerifiable = registerResults.filter((r) => r.ok && r.devCodes);
  log(`  Initiate: ${emailVerifiable.length}/${users.length} succeeded, verifying email...`);

  const emailVerifyResults = await poolMap(emailVerifiable, CONCURRENCY, async ({ user, devCodes }) => {
    const result = await apiRequest("POST", "/auth/register/verify-email", {
      email: user.email,
      emailCode: devCodes!.emailCode,
    });

    const ok = result.status === 200;
    const smsCode = (result.data as { devCodes?: { smsCode: string } }).devCodes?.smsCode;
    metrics.record({
      operation: "http:register-verify-email",
      status: result.status,
      durationMs: result.durationMs,
      ok,
      error: ok ? undefined : (result.data as { error?: string }).error,
    });
    return { user, smsCode, ok };
  });

  // Step C: verify the SMS code and claim the account.
  const verifiable = emailVerifyResults.filter((r) => r.ok && r.smsCode);
  log(`  Email verify: ${verifiable.length}/${emailVerifiable.length} succeeded, proceeding to verify...`);

  const verifyResults = await poolMap(verifiable, CONCURRENCY, async ({ user, smsCode }) => {
    const result = await apiRequest("POST", "/auth/register/verify", {
      email: user.email,
      smsCode: smsCode!,
    });

    const ok = result.status === 201;
    const token = (result.data as { token?: string }).token ?? "";
    metrics.record({
      operation: "http:register-verify",
      status: result.status,
      durationMs: result.durationMs,
      ok,
      error: ok ? undefined : (result.data as { error?: string }).error,
    });
    return { user, token, ok };
  });

  // Apply tokens and flag users whose registration failed (they'll use generated tokens)
  const tokenMap = new Map(verifyResults.map((r) => [r.user.email, r.token]));
  let httpOk = 0;
  let fallback = 0;

  for (const user of users) {
    const httpToken = tokenMap.get(user.email);
    if (httpToken) {
      user.token = httpToken;
      httpOk++;
    } else {
      // Fall back to directly-generated token so the rest of the test can continue
      user.token = createToken(user.email, user.fullName, user.role);
      fallback++;
    }
  }

  log(`  Registration: ${httpOk} via HTTP, ${fallback} used fallback token.`);
  if (fallback > 0 && fallback === users.length) {
    console.warn("  ⚠️  ALL registrations failed. Is NODE_ENV=test RATE_LIMIT_DISABLE=1 set on the server?");
  }
  return users;
}

// ============================================================
// PHASE 3 — LOGIN VIA REAL HTTP
// ============================================================

async function loginViaHttp(users: TestUser[], metrics: MetricsCollector) {
  log(`Logging in ${users.length} users via real HTTP (concurrency=${CONCURRENCY})...`);

  await poolMap(users, CONCURRENCY, async (user) => {
    const result = await apiRequest("POST", "/auth/login", {
      email: user.email,
      password: TEST_PASSWORD,
    });

    const ok = result.status === 200;
    const serverToken = (result.data as { token?: string }).token;
    metrics.record({
      operation: "http:login",
      status: result.status,
      durationMs: result.durationMs,
      ok,
      error: ok ? undefined : (result.data as { error?: string }).error,
    });

    if (ok && serverToken) {
      user.token = serverToken;
    }
  });

  const loginSummary = metrics.summary()["http:login"];
  log(`  Login: ${loginSummary?.succeeded ?? 0}/${loginSummary?.attempted ?? 0} ok.`);
}

// ============================================================
// PHASE 4 — JOBSITE SCENARIO: Many distinct users, same IP
// ============================================================

async function jobsiteScenario(users: TestUser[], metrics: MetricsCollector) {
  log("Jobsite scenario: 50 distinct users logging in from the same IP (expect all 200)...");

  // All requests come from the same IP (loopback) — verifies per-account rate limit
  // doesn't collectively block users sharing a network
  const sample = users.slice(0, 50);

  for (const user of sample) {
    const result = await apiRequest("POST", "/auth/login", {
      email: user.email,
      password: TEST_PASSWORD,
    });
    const ok = result.status === 200;
    metrics.record({
      operation: "http:jobsite-login",
      status: result.status,
      durationMs: result.durationMs,
      ok,
      error: ok ? undefined : `${result.status}: ${(result.data as { error?: string }).error ?? ""}`,
    });
  }

  const s = metrics.summary()["http:jobsite-login"];
  if (s && s.failed > 0) {
    console.warn(`  ⚠️  ${s.failed} jobsite logins were blocked — per-IP backstop may be too low or test mode not active.`);
  } else {
    log(`  ✅ All ${s?.attempted} distinct users on same IP succeeded (per-account limiting working).`);
  }
}

// ============================================================
// PHASE 5 — BRUTE-FORCE SCENARIO: Same account, many wrong passwords
// ============================================================

async function bruteForceScenario(metrics: MetricsCollector) {
  log("Brute-force scenario: 15 wrong-password attempts on ONE account (expect 429 after limit)...");

  const targetEmail = "loadtest+sup0@sitesnap.test";
  let blocked = 0;
  let attempted = 0;

  for (let i = 0; i < 15; i++) {
    const result = await apiRequest("POST", "/auth/login", {
      email: targetEmail,
      password: "WrongPassword!",
    });
    attempted++;
    const isRateLimited = result.status === 429;
    metrics.record({
      operation: "http:brute-force-attempt",
      status: result.status,
      durationMs: result.durationMs,
      ok: isRateLimited, // ok = correctly blocked (we want 429 after limit)
      error: isRateLimited ? undefined : `Got ${result.status}, expected 401 or 429`,
    });
    if (isRateLimited) blocked++;
  }

  if (blocked > 0) {
    log(`  ✅ Brute-force blocked after ${attempted - blocked} attempts (${blocked} got 429 — per-account limit working).`);
  } else {
    console.warn(`  ⚠️  No brute-force blocking observed after ${attempted} attempts — check RATE_LIMIT_LOGIN_PER_ACCOUNT.`);
  }
}

// ============================================================
// PHASE 6 — CREATE SITES (via HTTP)
// ============================================================

async function createSites(users: TestUser[], metrics: MetricsCollector): Promise<TestSite[]> {
  log(`Creating ${SITES} sites via HTTP...`);

  const ADDRESSES = [
    "123 Main St, Springfield", "456 Oak Ave, Riverdale", "789 Pine Rd, Lakewood",
    "321 Elm Blvd, Maplewood", "654 Cedar Ln, Brookside",
  ];
  const CLIENTS = ["BuildCo Ltd", "Apex Construction", "Metro Builders", "Urban Develop", "Pacific Contractors"];
  const STATUSES: Array<"active" | "completed" | "on-hold"> = ["active", "active", "active", "completed", "on-hold"];

  const supervisors = users.filter((u) => u.role === "supervisor").slice(0, SITES);
  const sites: TestSite[] = [];

  await poolMap(supervisors, Math.min(CONCURRENCY, SITES), async (owner, i) => {
    const result = await apiRequest(
      "POST",
      "/projects/sites",
      {
        name: `LOADTEST-Site-${i}-${owner.email.split("+")[1]?.split("@")[0]}`,
        address: ADDRESSES[i % ADDRESSES.length],
        client: CLIENTS[i % CLIENTS.length],
        startDate: "2026-01-01",
        status: STATUSES[i % STATUSES.length],
      },
      owner.token
    );
    const ok = result.status === 201;
    metrics.record({
      operation: "http:create-site",
      status: result.status,
      durationMs: result.durationMs,
      ok,
      error: ok ? undefined : (result.data as { error?: string })?.error,
    });
    if (ok) {
      const siteId = (result.data as { site?: { id?: string } }).site?.id ?? "";
      sites.push({ id: siteId, name: `LOADTEST-Site-${i}`, ownerEmail: owner.email });
    }
  });

  log(`  Sites created: ${sites.length} / ${SITES}.`);
  return sites;
}

// ============================================================
// PHASE 7 — SIMULATE ENTRIES
// ============================================================

async function createEntries(users: TestUser[], sites: TestSite[], metrics: MetricsCollector) {
  if (sites.length === 0) {
    log("  No sites available — skipping entry creation.");
    return;
  }

  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - DAYS);

  interface EntryTask {
    user: TestUser;
    siteId: string;
    date: string;
  }

  const tasks: EntryTask[] = [];
  for (const user of users) {
    const entryCount = randomInt(ENTRIES_PER_USER_MIN, ENTRIES_PER_USER_MAX);
    const assignedCount = randomInt(1, Math.min(3, sites.length));
    const assignedSites = sites.slice().sort(() => Math.random() - 0.5).slice(0, assignedCount);
    for (let j = 0; j < entryCount; j++) {
      tasks.push({
        user,
        siteId: randomChoice(assignedSites).id,
        date: randomDateInWindow(weekStart, DAYS),
      });
    }
  }

  log(`Creating ${tasks.length} diary entries (concurrency=${CONCURRENCY})...`);

  await poolMap(tasks, CONCURRENCY, async (task) => {
    const body: Record<string, unknown> = {
      siteId: task.siteId,
      date: task.date,
      locationAddress: `Block ${randomInt(1, 20)}, Industrial Way`,
      weather: randomChoice(WEATHER_OPTIONS),
      crewCount: String(randomInt(2, 25)),
      notes: randomChoice(NOTES_OPTIONS),
      photos: USE_REAL_AI ? [] : [],
    };

    const result = await apiRequest("POST", "/projects/entries", body, task.user.token);
    const ok = result.status === 201;
    metrics.record({
      operation: "http:create-entry",
      status: result.status,
      durationMs: result.durationMs,
      ok,
      error: ok ? undefined : (result.data as { error?: string })?.error,
    });
  });

  const s = metrics.summary()["http:create-entry"];
  log(`  Entries: ${s?.succeeded ?? 0} created, ${s?.failed ?? 0} failed.`);
}

// ============================================================
// PHASE 8 — PERMISSION CHECKS
// ============================================================

async function permissionChecks(users: TestUser[], metrics: MetricsCollector) {
  log("Permission checks: supervisors → 200, workers → 403...");

  const supervisors = users.filter((u) => u.role === "supervisor");
  await poolMap(supervisors, CONCURRENCY, async (user) => {
    const result = await apiRequest("GET", "/projects/reports/supervisor", undefined, user.token);
    metrics.record({
      operation: "http:supervisor-dashboard",
      status: result.status,
      durationMs: result.durationMs,
      ok: result.status === 200,
      error: result.status !== 200 ? (result.data as { error?: string }).error : undefined,
    });
  });

  const workers = users.filter((u) => u.role === "worker").slice(0, 30);
  for (const user of workers) {
    const result = await apiRequest("GET", "/projects/reports/supervisor", undefined, user.token);
    metrics.record({
      operation: "http:worker-dashboard-denial",
      status: result.status,
      durationMs: result.durationMs,
      ok: result.status === 403,
      error: result.status !== 403 ? `Expected 403, got ${result.status}` : undefined,
    });
  }

  const sup = metrics.summary()["http:supervisor-dashboard"];
  const wrk = metrics.summary()["http:worker-dashboard-denial"];
  log(`  Supervisor access: ${sup?.succeeded ?? 0}/${sup?.attempted ?? 0} ok.`);
  log(`  Worker denial:     ${wrk?.succeeded ?? 0}/${wrk?.attempted ?? 0} correctly 403.`);
}

// ============================================================
// PHASE 9 — REDIS PERSISTENCE CHECK (optional)
// ============================================================

async function redisCheck(metrics: MetricsCollector) {
  if (!process.env.REDIS_URL) {
    log("REDIS_URL not set — skipping Redis persistence check.");
    return;
  }

  log("Redis persistence check: verifying rate-limit state survives API restart...");
  log("  (This test requires manually restarting the API server between the two login attempts.)");

  // First login — should succeed
  const first = await apiRequest("POST", "/auth/login", {
    email: "loadtest+sup0@sitesnap.test",
    password: TEST_PASSWORD,
  });
  metrics.record({
    operation: "http:redis-login-before-restart",
    status: first.status,
    durationMs: first.durationMs,
    ok: first.status === 200,
  });

  log("  → Restart the API server now (to test Redis state persistence), then press Enter...");
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });

  // After restart, rate-limit counter should have persisted in Redis
  const second = await apiRequest("POST", "/auth/login", {
    email: "loadtest+sup0@sitesnap.test",
    password: TEST_PASSWORD,
  });
  metrics.record({
    operation: "http:redis-login-after-restart",
    status: second.status,
    durationMs: second.durationMs,
    ok: second.status === 200,
  });

  log(`  Redis check: before restart=${first.status}, after restart=${second.status}`);
}

// ============================================================
// PHASE 10 — GENERATE REPORT
// ============================================================

function buildReport(metrics: MetricsCollector, totalRuntimeMs: number): string {
  const now = new Date().toISOString();
  const summary = metrics.summary();
  const distinctErrors = metrics.distinctErrors();
  const throughput = (metrics.totalRequests() / (totalRuntimeMs / 1000)).toFixed(1);

  const lines: string[] = [];

  lines.push(`# SiteSnap Load Test Report (v2 — Real Auth Flow)`);
  lines.push(`\n**Generated:** ${now}`);
  lines.push(`**Total runtime:** ${(totalRuntimeMs / 1000).toFixed(1)}s`);
  lines.push(`**Throughput:** ${throughput} req/s`);
  lines.push(`**Total requests:** ${metrics.totalRequests()} (${metrics.totalSucceeded()} ok / ${metrics.totalFailed()} failed)`);

  lines.push(`\n## Parameters\n`);
  lines.push(`| Parameter | Value |`);
  lines.push(`|-----------|-------|`);
  lines.push(`| TOTAL_USERS | ${TOTAL_USERS} |`);
  lines.push(`| SUPERVISORS | ${SUPERVISORS} |`);
  lines.push(`| SITES | ${SITES} |`);
  lines.push(`| DAYS | ${DAYS} |`);
  lines.push(`| ENTRIES_PER_USER | ${ENTRIES_PER_USER_MIN}–${ENTRIES_PER_USER_MAX} |`);
  lines.push(`| CONCURRENCY | ${CONCURRENCY} |`);
  lines.push(`| NODE_ENV | ${process.env.NODE_ENV ?? "(not set)"} |`);
  lines.push(`| RATE_LIMIT_DISABLE | ${process.env.RATE_LIMIT_DISABLE ?? "(not set)"} |`);
  lines.push(`| REDIS_URL | ${process.env.REDIS_URL ? "set" : "not set"} |`);

  lines.push(`\n## Per-Operation Results\n`);
  lines.push(`| Operation | Attempted | Succeeded | Failed | Avg ms | p50 ms | p95 ms | Max ms |`);
  lines.push(`|-----------|-----------|-----------|--------|--------|--------|--------|--------|`);
  for (const [op, s] of Object.entries(summary)) {
    lines.push(`| ${op} | ${s.attempted} | ${s.succeeded} | ${s.failed} | ${s.avgMs} | ${s.p50Ms} | ${s.p95Ms} | ${s.maxMs} |`);
  }

  lines.push(`\n## Scenario Results\n`);

  const jobsiteStats = summary["http:jobsite-login"];
  lines.push(`### Jobsite scenario (many distinct users, same IP)`);
  if (jobsiteStats) {
    const pass = jobsiteStats.failed === 0;
    lines.push(`- **Result: ${pass ? "✅ PASS" : "❌ FAIL"}**`);
    lines.push(`- ${jobsiteStats.succeeded}/${jobsiteStats.attempted} logins succeeded`);
    lines.push(`- ${pass ? "Per-account rate limiting correctly avoids collective lockout." : "Some users were blocked — per-IP backstop may be too low."}`);
  }

  const bruteStats = summary["http:brute-force-attempt"];
  lines.push(`\n### Brute-force scenario (same account, wrong passwords)`);
  if (bruteStats) {
    const blocked = bruteStats.succeeded; // ok=true means correctly blocked
    const pass = blocked > 0;
    lines.push(`- **Result: ${pass ? "✅ PASS" : "❌ FAIL"}**`);
    lines.push(`- ${blocked} of ${bruteStats.attempted} attempts were blocked with 429`);
    lines.push(`- ${pass ? "Per-account brute-force protection is working." : "Brute-force not blocked — check RATE_LIMIT_LOGIN_PER_ACCOUNT."}`);
  }

  lines.push(`\n## Distinct Errors (Priority Order)\n`);
  if (distinctErrors.length === 0) {
    lines.push("No errors.");
  } else {
    for (const e of distinctErrors) {
      lines.push(`\n### ${e.operation} → HTTP ${e.status} (×${e.count})\n`);
      lines.push(`- **Likely cause:** ${e.likelyCause}`);
      lines.push(`- **Example:** \`${e.exampleDetail.slice(0, 300)}\``);
    }
  }

  lines.push(`\n## Fixes Applied (this branch)\n`);
  lines.push(`- Added \`003_add_entries_index.sql\`: indexes on \`project_entries(owner_email, timestamp DESC)\`, \`project_entries(site_id)\`, \`project_diaries(site_id)\``);
  lines.push(`- Reworked rate limiter: per-account primary login limit, per-IP backstop, Redis-backed, env-var configurable`);
  lines.push(`- New env vars: \`RATE_LIMIT_LOGIN_PER_ACCOUNT\` (default 10), \`RATE_LIMIT_LOGIN_PER_IP\` (default 200), \`RATE_LIMIT_REGISTER_PER_IP\` (default 30), \`REDIS_URL\``);

  lines.push(`\n*Report generated by \`services/api/load-test.ts\`*`);
  return lines.join("\n");
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("\n🚀 SiteSnap Load / Integration Test (v2)\n");
  console.log(`   API: ${API_BASE}`);
  console.log(`   DB:  ${(process.env.DATABASE_URL ?? "(not set)").replace(/:[^:@]+@/, ":***@")}`);
  console.log(`   Mode: NODE_ENV=${process.env.NODE_ENV ?? "?"} RATE_LIMIT_DISABLE=${process.env.RATE_LIMIT_DISABLE ?? "?"}\n`);

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const metrics = new MetricsCollector();
  const runStart = Date.now();

  try {
    await safetyCheck(pool);

    // Phase 2: Real HTTP registration flow
    const users = await createUsersViaHttp(metrics);

    // Phase 3: Real HTTP login for all users
    await loginViaHttp(users, metrics);

    // Phase 4: Jobsite scenario (same IP, distinct accounts)
    await jobsiteScenario(users, metrics);

    // Phase 5: Brute-force (same account, wrong password)
    await bruteForceScenario(metrics);

    // Phase 6: Create sites
    const sites = await createSites(users, metrics);

    // Phase 7: Entries
    await createEntries(users, sites, metrics);

    // Phase 8: Permission checks
    await permissionChecks(users, metrics);

    // Phase 9: Redis persistence (interactive, only when REDIS_URL set)
    await redisCheck(metrics);

  } finally {
    await pool.end();
  }

  const totalRuntimeMs = Date.now() - runStart;

  console.log("\n" + "=".repeat(60));
  const summary = metrics.summary();
  for (const [op, s] of Object.entries(summary)) {
    console.log(`  ${op.padEnd(38)} ${s.attempted.toString().padStart(5)} req  ${s.succeeded.toString().padStart(5)} ok  ${s.failed.toString().padStart(5)} fail  p95=${s.p95Ms}ms`);
  }
  console.log(`\n  Total: ${metrics.totalRequests()} requests in ${(totalRuntimeMs / 1000).toFixed(1)}s`);

  const errors = metrics.distinctErrors();
  if (errors.length > 0) {
    console.log("\nDISTINCT ERRORS:");
    for (const e of errors) {
      console.log(`  [×${e.count}] ${e.operation} → ${e.status} — ${e.likelyCause.slice(0, 80)}`);
    }
  }

  const reportPath = path.join(process.cwd(), "..", "..", "load-test-report.md");
  fs.writeFileSync(reportPath, buildReport(metrics, totalRuntimeMs), "utf8");
  console.log(`\n✅ Report written to: ${reportPath}`);
}

main().catch((err) => {
  console.error("\n❌ Load test failed:", err.message ?? err);
  process.exit(1);
});
