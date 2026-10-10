import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { auditSessionRouting, type VirtualFiles } from "@/lib/session-routing-audit";

/**
 * Item 4 of the crew-permissions work, proved rather than assumed.
 *
 * The permission phase generates 403s on purpose, and `lib/session.ts` keys on
 * 401 plus the server code, so a 403 SHOULD already be inert. The unit tests in
 * lib/permissions.test.ts prove that about the predicate. This file proves it
 * about the eight places that actually route to sign-in, because the predicate
 * being right does not stop a call site from calling the notifier on its own.
 *
 * THE VACUITY PROBLEM THIS IS BUILT AROUND
 *
 * "No file routes a 403 to sign-in" is satisfied by auditing no files. If the
 * path is wrong or a rename empties the sweep, every assertion below passes
 * having checked nothing — four times in this project already
 * (docs/VACUITY-AUDIT.md). So the population is pinned as counts, and the
 * fixtures at the bottom are the positive control: the real tree is correctly
 * free of a 403 sign-out, which means the real tree cannot show that one would
 * be caught. Only a synthetic one can.
 *
 * These numbers are expected to change. Raise them in the same commit that adds
 * a sign-out call site, so it is deliberate and visible in review — the same
 * bargain as scripts/run-tests.sh.
 */
const EXPECTED_NOTIFY_SITES = 8;
const EXPECTED_THROW_SITES = 4;

/** `__dirname` is `dist-test/lib` at run time, so the package root is two up. */
const PKG = path.resolve(__dirname, "..", "..");

/**
 * What is swept, and what is not.
 *
 * `lib/session.ts` DEFINES the notifier and the error: every reference in it is
 * a declaration, not a route to sign-in. `*.test.ts` files construct
 * `SessionExpiredError` deliberately in order to assert on it — including
 * lib/permissions.test.ts, which asserts that `isForbidden` rejects one — so
 * sweeping them would report the assertions as the defect. Everything else
 * under lib/ and app/ is in scope, .ts and .tsx alike.
 */
const EXCLUDED = new Set(["lib/session.ts"]);

function readTree(dir: string, prefix: string, files: VirtualFiles = {}): VirtualFiles {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = `${prefix}/${entry.name}`;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    if (entry.isDirectory()) readTree(full, rel, files);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !EXCLUDED.has(rel)) {
      files[rel] = fs.readFileSync(full, "utf8");
    }
  }
  return files;
}

function realTree(): VirtualFiles {
  return {
    ...readTree(path.join(PKG, "lib"), "lib"),
    ...readTree(path.join(PKG, "app"), "app"),
  };
}

test("the tree is where this test thinks it is", () => {
  // Without this, every assertion below is about zero files.
  for (const dir of ["lib", "app"]) {
    assert.ok(fs.existsSync(path.join(PKG, dir)), `${PKG}/${dir} must exist — fix the path, not this test`);
  }
  const files = realTree();
  assert.ok(
    Object.keys(files).length > 60,
    `swept only ${Object.keys(files).length} files; the sweep has broken rather than the app having shrunk`
  );
  assert.ok(files["lib/authed-fetch.ts"], "the one authenticated fetch must be in scope");
  assert.ok(files["lib/permissions.ts"], "the permission predicates must be in scope");
  assert.equal(files["lib/session.ts"], undefined, "lib/session.ts is excluded on purpose — see EXCLUDED");
});

test("every route to sign-in in the real app is guarded by a 401, and nothing else", () => {
  const audit = auditSessionRouting(realTree());

  const notify = audit.callSites.filter((s) => s.kind === "notify");
  const thrown = audit.callSites.filter((s) => s.kind === "throw");

  // The population, pinned. A sweep that finds no sign-out call sites would
  // otherwise satisfy "none of them is wrong".
  assert.equal(
    notify.length,
    EXPECTED_NOTIFY_SITES,
    `expected ${EXPECTED_NOTIFY_SITES} notifySessionExpired() call sites, found ${notify.length}:\n` +
      notify.map((s) => `  ${s.file}:${s.line}`).join("\n")
  );
  assert.equal(
    thrown.length,
    EXPECTED_THROW_SITES,
    `expected ${EXPECTED_THROW_SITES} new SessionExpiredError() sites, found ${thrown.length}:\n` +
      thrown.map((s) => `  ${s.file}:${s.line}`).join("\n")
  );

  assert.deepEqual(
    audit.violations,
    [],
    "a 403 must not sign anybody out:\n" +
      audit.violations.map((v) => `  ${v.file}:${v.line} [${v.rule}] ${v.detail}`).join("\n")
  );

  // Not merely "no violations": every site must positively carry the 401 test.
  // The two assertions differ when a future change makes the audit stop
  // recognising a guard at all.
  for (const site of audit.callSites) {
    assert.deepEqual(
      site.statuses,
      [401],
      `${site.file}:${site.line} is reached under status tests [${site.statuses.join(", ")}], ` +
        `not exactly [401]`
    );
  }
});

/**
 * THE POSITIVE CONTROL.
 *
 * Every assertion above is of the form "the tree contains no X". Each one
 * passes equally well if the audit cannot detect X at all — if `routerKind`
 * stopped matching, or `guardChain` returned the whole file's conditions. These
 * fixtures are the same shapes the app uses, with the status changed, and they
 * must be caught.
 */
const FIXTURES: { name: string; source: string; expect: string[] }[] = [
  {
    name: "the shape the app actually uses",
    source: `
      async function f(res: { status: number }, token: string | null) {
        if (res.status === 401 && token) {
          notifySessionExpired();
          throw new SessionExpiredError();
        }
      }`,
    expect: [],
  },
  {
    name: "a 403 routed to sign-in — the defect this phase could introduce",
    source: `
      function f(res: { status: number }) {
        if (res.status === 403) notifySessionExpired();
      }`,
    expect: ["sign-out-must-not-be-reached-on-another-status"],
  },
  {
    name: "a 403 thrown as an expiry, which would swallow the refusal silently",
    source: `
      function f(res: { status: number }) {
        if (res.status === 403) throw new SessionExpiredError();
      }`,
    expect: ["sign-out-must-not-be-reached-on-another-status"],
  },
  {
    name: "=== 401 generalised to >= 400 while tidying up",
    source: `
      function f(res: { status: number }) {
        if (res.status >= 400) notifySessionExpired();
      }`,
    expect: ["sign-out-needs-a-401-guard"],
  },
  {
    name: "no guard at all",
    source: `
      function f() {
        notifySessionExpired();
      }`,
    expect: ["sign-out-needs-a-401-guard"],
  },
  {
    name: "the else branch of a 401 test, where the status is anything BUT 401",
    source: `
      function f(res: { status: number }) {
        if (res.status === 401) {
          return;
        } else {
          notifySessionExpired();
        }
      }`,
    expect: ["sign-out-needs-a-401-guard"],
  },
  {
    name: "both statuses in one condition is still wrong",
    source: `
      function f(res: { status: number }) {
        if (res.status === 401 || res.status === 403) notifySessionExpired();
      }`,
    expect: ["sign-out-must-not-be-reached-on-another-status"],
  },
  {
    name: "the && form, which the real tree also uses",
    source: `
      function f(res: { status: number }, token: string | null) {
        res.status === 401 && token && notifySessionExpired();
      }`,
    expect: [],
  },
];

for (const fixture of FIXTURES) {
  test(`fixture: ${fixture.name}`, () => {
    const audit = auditSessionRouting({ "lib/fixture.ts": fixture.source });
    assert.ok(audit.callSites.length > 0, "the fixture must contain a sign-out call site at all");
    assert.deepEqual(
      audit.violations.map((v) => v.rule),
      fixture.expect,
      `violations were:\n` + audit.violations.map((v) => `  [${v.rule}] ${v.detail}`).join("\n")
    );
  });
}

test("a .tsx guard is read the same way — most call sites are screens", () => {
  // The real notifier call sites live in .tsx context providers. If the parser
  // were given the wrong ScriptKind, a generic or a JSX fragment would throw the
  // AST off and the sweep would quietly find nothing in exactly those files.
  const audit = auditSessionRouting({
    "lib/fixture.tsx": `
      export function C(res: { status: number }) {
        if (res.status === 403) notifySessionExpired();
        return <>{null}</>;
      }`,
  });
  assert.equal(audit.callSites.length, 1);
  assert.equal(audit.violations[0]?.rule, "sign-out-must-not-be-reached-on-another-status");
});
