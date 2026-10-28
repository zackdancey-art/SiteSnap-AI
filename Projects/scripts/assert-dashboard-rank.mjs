// Fails if the two clients disagree about who may see the supervisor dashboard.
//
// WHY THIS EXISTS
//
// The decision is one sentence — the dashboard is manager+ on every surface,
// invisible to crew — and it is implemented twice, in two packages, with no
// compiler link between them:
//
//   apps/mobile/lib/permissions.ts          isManagerOrAbove / canSeeSupervisorDashboard
//   apps/supervisor-web/lib/useRole.ts      DASHBOARD_ROLES / canSeeSupervisorDashboard
//
// They have already disagreed once, for the life of the portal: mobile was
// manager+ and the portal was viewer+, so a viewer got a dashboard on one
// device and a refusal on the other. That is the drift this check exists to
// stop recurring, now that the question has been answered.
//
// WHY A SOURCE CHECK RATHER THAN A TEST
//
// The mobile half IS a real test — lib/permissions.test.ts asserts all four
// roles in both directions. The portal half has nothing: apps/supervisor-web
// has no test program at all, so reverting its predicate to viewer+ turns
// nothing red. Proved, not assumed: that revert was run, and typecheck, lint
// and both other clients' suites stayed green.
//
// Adding a test runner to the portal means adding a dependency, which is not
// this change's call. So this is the available mechanism: it reads both
// declarations out of source and requires them to name the same roles.
//
// WHAT IT ASSERTS
//
//   1. The portal admits exactly the roles it names, and they are manager and
//      owner — read from the source, not compared against a literal written
//      twice here.
//   2. Mobile's predicate admits the same two, read from its own source.
//   3. Neither admits crew or viewer.
//
// WHAT IT DOES NOT PROVE
//
//   - Nothing about the API. The route both dashboards read their figures
//     from, GET /projects/summary, is `requireAtLeast("viewer")`, so a VIEWER
//     who calls it directly still gets the numbers. This is a screen withheld,
//     not data withheld. Hiding a control is not a permission; moving the route
//     is a separate decision.
//     (GET /projects/reports/supervisor is viewer+ as well and is usually
//     described as this screen's second route. Nothing in either client calls
//     it — both build their report HTML locally — so it is not evidence about
//     this screen either way.)
//   - Nothing about rendering. Whether the refusal card actually appears on a
//     device is a device check, and it is in the PR's checklist as unverified.
//   - It reads source text. A role computed at runtime is invisible to it.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKGS = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const fail = (m) => failures.push(m);
const show = (set) => (set && set.size ? [...set].sort().map((s) => `"${s}"`).join(", ") : "(empty)");

const read = (p) => {
  try {
    return readFileSync(resolve(PKGS, p), "utf8");
  } catch (err) {
    fail(`could not read ${p}: ${err.message}`);
    return null;
  }
};

const PORTAL = "apps/supervisor-web/lib/useRole.ts";
const MOBILE = "apps/mobile/lib/permissions.ts";

const portal = read(PORTAL);
const mobile = read(MOBILE);

/** The portal's admitted roles: the array its predicate tests membership of. */
function portalRoles(src) {
  if (!src) return null;
  const decl = /const DASHBOARD_ROLES\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!decl) {
    fail(
      `could not find \`const DASHBOARD_ROLES = [...]\` in ${PORTAL}.\n` +
        "    This script has no fallback list, so it refuses to report a pass. If\n" +
        "    the predicate was rewritten as a rank comparison or inlined, this check\n" +
        "    must be rewritten with it in the same commit — not deleted."
    );
    return null;
  }
  const roles = [...decl[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!roles.length) {
    fail(`DASHBOARD_ROLES in ${PORTAL} is empty, which would refuse everybody.`);
    return null;
  }

  // And that the predicate actually USES it. An array nothing reads is a
  // comment, and this check would then be asserting against a decoration.
  if (!/canSeeSupervisorDashboard[\s\S]{0,200}DASHBOARD_ROLES/.test(src)) {
    fail(
      `canSeeSupervisorDashboard in ${PORTAL} does not read DASHBOARD_ROLES.\n` +
        "    The list this check reads is then not the list the portal applies."
    );
    return null;
  }
  return new Set(roles);
}

/**
 * Mobile's admitted roles: the roles `isManagerOrAbove` names, plus a check
 * that canSeeSupervisorDashboard is still defined in terms of it. Written
 * against that function rather than against a rank number because that is how
 * the file is written — every predicate there names roles, so an unrecognised
 * role gets the least access.
 */
function mobileRoles(src) {
  if (!src) return null;
  const fn = /function isManagerOrAbove\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(src);
  if (!fn) {
    fail(`could not find \`function isManagerOrAbove\` in ${MOBILE}.`);
    return null;
  }
  const roles = [...fn[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (!roles.length) {
    fail(`isManagerOrAbove in ${MOBILE} names no roles.`);
    return null;
  }
  if (!/export function canSeeSupervisorDashboard[\s\S]{0,200}isManagerOrAbove/.test(src)) {
    fail(
      `canSeeSupervisorDashboard in ${MOBILE} is no longer defined by isManagerOrAbove.\n` +
        "    The roles this check reads are then not the roles the phone applies."
    );
    return null;
  }
  return new Set(roles);
}

const REFUSED = ["crew", "viewer"];

const p = portalRoles(portal);
const m = mobileRoles(mobile);

if (p && m) {
  const onlyPortal = [...p].filter((r) => !m.has(r));
  const onlyMobile = [...m].filter((r) => !p.has(r));
  if (onlyPortal.length || onlyMobile.length) {
    fail(
      "the two clients admit different roles to the supervisor dashboard.\n" +
        `    portal (${PORTAL}): ${show(p)}\n` +
        `    mobile (${MOBILE}): ${show(m)}` +
        (onlyPortal.length ? `\n    portal only: ${onlyPortal.map((x) => `"${x}"`).join(", ")}` : "") +
        (onlyMobile.length ? `\n    mobile only: ${onlyMobile.map((x) => `"${x}"`).join(", ")}` : "") +
        "\n    The decision is that the dashboard is the same screen for the same\n" +
        "    people on both surfaces. One surface moved."
    );
  }
}

// The decision itself, asserted against each surface independently, so a check
// that both agree cannot pass by both being wrong together.
for (const [where, set] of [
  [PORTAL, p],
  [MOBILE, m],
]) {
  if (!set) continue;
  const admitted = REFUSED.filter((r) => set.has(r));
  if (admitted.length) {
    fail(
      `${where} admits ${admitted.map((x) => `"${x}"`).join(", ")} to the supervisor dashboard.\n` +
        "    The decision is manager and owner, invisible to crew, on every surface."
    );
  }
  if (!set.has("manager") || !set.has("owner")) {
    fail(
      `${where} does not admit both manager and owner to the supervisor dashboard.\n` +
        `    admits: ${show(set)}`
    );
  }
}

if (failures.length) {
  console.error("assert-dashboard-rank: FAIL\n");
  for (const f of failures) console.error(`  - ${f}\n`);
  console.error("  One decision, two implementations, no compiler link between them.");
  process.exit(1);
}

console.log(`  supervisor dashboard: ${show(p)} — both clients agree, and refuse ${REFUSED.map((r) => `"${r}"`).join(" and ")}.`);
