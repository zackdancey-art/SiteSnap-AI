/**
 * A rejected store call must become a RESPONSE, not a hung socket.
 *
 * WHAT HAPPENED, AND WHY A 403-STYLE TEST WOULD NOT HAVE CAUGHT IT
 *
 * `PATCH /projects/sites/:id/progress` ran an UPDATE naming `deleted_at`, a
 * column `project_sites` does not have. Postgres rejected the statement in under
 * a millisecond; the request then hung for five minutes until the test's fetch
 * gave up. The access-log line reads `PATCH /projects/sites/.../progress - - - -
 * ms`: no status, no duration, because `httpLogger` records on response finish
 * and the response never finished.
 *
 * Every assertion this suite makes elsewhere is of the form "this route answers
 * N". None of them can fail that way — a test that awaits a status code and gets
 * no response at all reports a client timeout, five minutes later, and names the
 * timeout rather than the route. So the property under test here is weaker and
 * more fundamental than a status code: **a response arrives at all**, within a
 * budget short enough that a regression costs seconds.
 *
 * THE MECHANISM, CONFIRMED RATHER THAN ASSUMED
 *
 * Express 4 (4.22.1 here) does not await route handlers. It forwards an error
 * only when a handler throws synchronously or calls `next(err)`; the Promise an
 * async handler returns is discarded. The first test below proves that directly,
 * on a bare `express.Router()`, and proves the wrapped router fixes it — the same
 * handler, the same error, the two routers side by side.
 *
 * It also explains why production survives rather than crashing: `bootstrap()`
 * registers `process.on("unhandledRejection", ...)` at `server.ts:244`, which
 * logs and captures to Sentry but — unlike the `uncaughtException` handler just
 * above it — does NOT shut down. Registering any listener suppresses Node's
 * default `--unhandled-rejections=throw`, so the process stays up and the socket
 * stays open. Sentry gets an event; the person gets a spinner.
 *
 * `createApp()` does not register that listener, so the first test installs one
 * for its own duration. Without it the deliberate rejection would take the test
 * runner down with it.
 */

import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import express, { Router } from "express";
import { createApp } from "../server";
import { asyncSafeRouter } from "../middleware/asyncRouter";
import { resetAuthStoreForTests } from "../storage/authStore";
import { resetProjectStoreForTests } from "../storage/projectsStore";
import { resetRateLimitStoreForTests } from "../middleware/rateLimit";
import * as projectsStore from "../storage/projectsStore";

/**
 * The budget. A hang must fail in seconds, not in the five minutes the real one
 * took — so every request here carries a deadline and "no response" is a value
 * the test can assert on rather than a timeout that kills the run.
 */
const BUDGET_MS = 2_000;
/** Shorter, for the case where NO response is the expected observation. */
const HANG_PROBE_MS = 600;

type Answer = { answered: true; status: number; body: unknown } | { answered: false };

function ask(url: string, method: string, budgetMs: number, token?: string, body?: unknown): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request(
      url,
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
          let parsed: unknown = data;
          try { parsed = JSON.parse(data); } catch { /* keep the raw text */ }
          resolve({ answered: true, status: res.statusCode ?? 0, body: parsed });
        });
      }
    );
    r.setTimeout(budgetMs, () => { r.destroy(); resolve({ answered: false }); });
    r.on("error", (err: NodeJS.ErrnoException) => {
      // destroy() after the timeout resolves surfaces here; the resolve above wins.
      if (err.code === "ECONNRESET") return;
      reject(err);
    });
    if (payload) r.write(payload);
    r.end();
  });
}

let server: http.Server;
let baseUrl: string;

let _phoneSeq = 0;
const nextPhone = () => `+617${String(++_phoneSeq).padStart(8, "0")}`;

async function api<T = unknown>(method: string, p: string, body?: unknown, token?: string) {
  const res = await ask(`${baseUrl}/api${p}`, method, BUDGET_MS, token, body);
  assert.ok(res.answered, `${method} ${p} never answered within ${BUDGET_MS}ms`);
  return res as { answered: true; status: number; body: T };
}

async function registerOwner(email: string, companyName: string): Promise<string> {
  const reg = await api<{ devCodes?: { emailCode: string } }>("POST", "/auth/register", {
    email, phone: nextPhone(), fullName: "Progress Owner", password: "Password123!!", companyName,
  });
  assert.equal(reg.status, 200, `register failed: ${JSON.stringify(reg.body)}`);
  const ve = await api<{ devCodes?: { smsCode: string } }>("POST", "/auth/register/verify-email", {
    email, emailCode: reg.body.devCodes!.emailCode,
  });
  assert.equal(ve.status, 200, `verify-email failed: ${JSON.stringify(ve.body)}`);
  const ver = await api<{ token: string }>("POST", "/auth/register/verify", {
    email, smsCode: ve.body.devCodes!.smsCode,
  });
  assert.equal(ver.status, 201, `verify failed: ${JSON.stringify(ver.body)}`);
  return ver.body.token;
}

before(async () => {
  resetAuthStoreForTests();
  resetProjectStoreForTests();
  resetRateLimitStoreForTests();
  server = http.createServer(createApp());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("nothing in the bare-router path turns a rejection into a response; asyncSafeRouter does", async () => {
  const boom = async () => { throw new Error("forced store failure"); };
  const failing = async (_req: express.Request, res: express.Response) => {
    await boom();
    res.json({ unreachable: true });
  };

  /** Mounts a router behind the same fallback error handler server.ts uses. */
  async function serve(router: express.Router) {
    const app = express();
    app.use(express.json());
    app.use(router);
    // The shape of server.ts's fallback handler, which is where a forwarded
    // error lands in production (behind Sentry's, which reports and re-throws
    // rather than responding).
    app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: "Internal server error." });
    });
    const s = http.createServer(app);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    return {
      url: `http://127.0.0.1:${(s.address() as { port: number }).port}/thing`,
      close: () => new Promise<void>((r) => s.close(() => r())),
    };
  }

  // ── THE RED, as an expected observation rather than a failing test ──────────
  //
  // The handler sits behind a probe whose ONLY addition to bare Express behaviour
  // is a `.catch` that records the rejection. That is not cosmetic and it is not
  // cheating: `node:test` fails any test that leaves an unhandled rejection
  // behind, and under a bare `express.Router()` a rejected handler promise is
  // ALWAYS unhandled — Express 4 discards the handler's return value, so there is
  // nowhere else for it to go. Recording it is the only way to observe the
  // rejection from inside the runner. The probe pointedly does NOT call
  // `next(err)`, and that single missing call is the entire defect: the wrapped
  // router below differs from this probe in exactly that one respect.
  let bareRejection: unknown;
  const bareRouter = Router();
  bareRouter.patch("/thing", (req, res) => {
    void failing(req, res).catch((err: unknown) => { bareRejection = err; /* observed, never forwarded */ });
  });
  const bare = await serve(bareRouter);
  const bareAnswer = await ask(bare.url, "PATCH", HANG_PROBE_MS);
  await bare.close();

  assert.ok(bareRejection instanceof Error, "the handler must actually have rejected, or the rest proves nothing");
  assert.match(String(bareRejection), /forced store failure/);
  assert.equal(
    bareAnswer.answered, false,
    `a rejection that was never forwarded still produced a response within ${HANG_PROBE_MS}ms, which should be ` +
    "impossible — nothing else in this app writes to that socket"
  );

  // ── THE GREEN: same handler, same error, wrapped router ────────────────────
  const safeRouter = asyncSafeRouter();
  safeRouter.patch("/thing", failing);
  const safe = await serve(safeRouter);
  const safeAnswer = await ask(safe.url, "PATCH", BUDGET_MS);
  await safe.close();

  assert.ok(safeAnswer.answered, `asyncSafeRouter did not answer within ${BUDGET_MS}ms — the hang is back`);
  assert.equal(safeAnswer.status, 500, "a forwarded store failure is a 500 from the fallback handler");
  assert.deepEqual(safeAnswer.body, { error: "Internal server error." });
});

test("a store failure on a real route becomes a response, not a hung request", async () => {
  const token = await registerOwner("progress-owner@example.com", "Progress Co");

  const siteRes = await api<{ site: { id: string } }>("POST", "/projects/sites", {
    name: "Progress Site", address: "1 Test Way", client: "Client", startDate: "2026-10-11", status: "active",
  }, token);
  assert.equal(siteRes.status, 201, `site seed failed: ${JSON.stringify(siteRes.body)}`);
  const siteId = siteRes.body.site.id;

  // THE POSITIVE CONTROL, FIRST. Unpatched, the route must work — otherwise the
  // assertion below would pass on a route that was broken, deleted or unmounted,
  // which is how a 403-only test proves nothing.
  const healthy = await api<{ site: { progressPercent: number } }>(
    "PATCH", `/projects/sites/${siteId}/progress`, { progressPercent: 42 }, token
  );
  assert.equal(healthy.status, 200, `the route must work before breaking it: ${JSON.stringify(healthy.body)}`);
  assert.equal(healthy.body.site.progressPercent, 42);

  // Force the real store to reject, at the boundary the route calls through.
  // TypeScript compiles to CommonJS here, so the route's call site is a property
  // lookup on the module object and this patch is live for it.
  const target = projectsStore as unknown as Record<string, unknown>;
  const original = target.updateSiteProgress;
  target.updateSiteProgress = async () => {
    throw new Error('column "deleted_at" does not exist');
  };
  try {
    const broken = await ask(
      `${baseUrl}/api/projects/sites/${siteId}/progress`, "PATCH", BUDGET_MS, token, { progressPercent: 43 }
    );
    assert.ok(
      broken.answered,
      `the route sent NO response within ${BUDGET_MS}ms. This is the five-minute hang: the async handler's ` +
      `rejection was never forwarded to the error handler, so nothing wrote to the socket. Check that ` +
      `routes/projects.ts builds its router with asyncSafeRouter().`
    );
    assert.equal(broken.status, 500, "a store failure is a 500, not a 404 — a 404 would claim the site is gone");
    assert.deepEqual(broken.body, { error: "Internal server error." });
  } finally {
    target.updateSiteProgress = original;
  }

  // And the route is still alive afterwards, so the patch did not leak into the
  // rest of the run.
  const after = await api<{ site: { progressPercent: number } }>(
    "PATCH", `/projects/sites/${siteId}/progress`, { progressPercent: 44 }, token
  );
  assert.equal(after.status, 200);
  assert.equal(after.body.site.progressPercent, 44);
});

test("every route file builds its router with asyncSafeRouter, so a new route is safe by default", () => {
  // The suite runs from dist/routes, so the TypeScript sources are two levels up
  // and across. Resolved rather than assumed: if the layout changes, this fails
  // loudly here instead of quietly reading an empty directory and passing.
  const dir = path.resolve(__dirname, "..", "..", "src", "routes");
  assert.ok(fs.existsSync(dir), `could not find the route sources at ${dir}`);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
  assert.ok(files.length >= 14, `expected the route files to still be here, found ${files.length}`);

  const offenders: string[] = [];
  let wrapped = 0;
  for (const f of files) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    // `Router()` as a CALL, not `express.Router` in a type position or a comment.
    const bare = src.match(/(?<![\w.])Router\(\)/g) ?? [];
    if (bare.length > 0) offenders.push(`${f} (${bare.length}x bare Router())`);
    if (/asyncSafeRouter\(\)/.test(src)) wrapped += 1;
  }
  assert.deepEqual(
    offenders, [],
    "a route file calls express.Router() directly, so its async handlers can hang the request. " +
    "Use asyncSafeRouter() from ../middleware/asyncRouter — see the note at the top of that file."
  );
  assert.equal(
    wrapped, files.length,
    `expected all ${files.length} route files to build a wrapped router, ${wrapped} do`
  );

  // The wrapper exists because Express 4 discards a handler's returned promise.
  // Express 5 awaits it and forwards the rejection itself, at which point
  // asyncSafeRouter is dead weight that should be removed rather than left to
  // rot. Pinned so the upgrade is forced to decide instead of inheriting it.
  const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { dependencies?: Record<string, string> };
  const declared = pkg.dependencies?.express;
  assert.ok(declared, `could not read the express dependency from ${pkgPath}`);
  const expressMajor = Number(declared.replace(/^[^\d]*/, "").split(".")[0]);
  assert.equal(
    expressMajor, 4,
    "Express is no longer v4. If it awaits route handlers now, delete asyncSafeRouter and this suite; " +
    "if it does not, update this pin. See the note at the top of middleware/asyncRouter.ts."
  );
});
