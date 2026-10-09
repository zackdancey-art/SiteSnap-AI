import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  HEADER_BEARING_NAVIGATORS,
  HEADERLESS_NAVIGATORS,
  auditScreenHeaders,
  chainFor,
  parseLayout,
  rendersScreenHeader,
  type VirtualFiles,
} from "@/lib/screen-header-audit";

/**
 * THE VACUITY PROBLEM THIS FILE IS BUILT AROUND
 *
 * A test that enumerates a directory passes by enumerating nothing. If the
 * `app/` path is wrong, or a rename empties the glob, every assertion of the
 * form "no screen violates the rule" is satisfied by zero screens and the build
 * goes green having checked nothing. That has happened in this project four
 * times (docs/VACUITY-AUDIT.md).
 *
 * So the populations are pinned as COUNTS, not just as an absence of failures:
 *
 *   EXPECTED_ROUTES            every route file expo-router would mount
 *   EXPECTED_SCREEN_HEADER     screens rendering <ScreenHeader>
 *   EXPECTED_NATIVE_HEADER     screens showing the OS header instead
 *   EXPECTED_LAYOUTS           navigator layout files
 *
 * These numbers are expected to change. Raise them in the same commit that adds
 * a screen, so the change is deliberate and visible in review rather than a
 * count drifting unobserved — the same bargain as scripts/run-tests.sh.
 */
const EXPECTED_ROUTES = 33;
const EXPECTED_SCREEN_HEADER = 11;
const EXPECTED_NATIVE_HEADER = 9;
const EXPECTED_LAYOUTS = 2;

/**
 * `__dirname` is `dist-test/lib` at run time, so `app/` is two levels up. If
 * that ever stops being true this must FAIL rather than audit an empty tree,
 * which is the whole point of the next few lines.
 */
const APP_DIR = path.resolve(__dirname, "..", "..", "app");

function readAppTree(dir: string, prefix = ""): VirtualFiles {
  const files: VirtualFiles = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(files, readAppTree(full, rel));
    else if (entry.name.endsWith(".tsx")) files[rel] = fs.readFileSync(full, "utf8");
  }
  return files;
}

test("the app/ tree is where this test thinks it is", () => {
  assert.ok(
    fs.existsSync(APP_DIR),
    `app/ not found at ${APP_DIR}. Every assertion below would pass over an ` +
      `empty tree, so this is a hard failure rather than a silent clean run.`
  );
  assert.ok(
    fs.existsSync(path.join(APP_DIR, "_layout.tsx")),
    `${APP_DIR} has no _layout.tsx — the root navigator is what the invariant is about.`
  );
});

test("the real app/ tree has the populations this test expects to find", () => {
  const audit = auditScreenHeaders(readAppTree(APP_DIR));

  assert.equal(
    audit.routes.length,
    EXPECTED_ROUTES,
    `found ${audit.routes.length} route files, expected ${EXPECTED_ROUTES}:\n  ` +
      audit.routes.join("\n  ")
  );
  assert.equal(
    audit.layouts.length,
    EXPECTED_LAYOUTS,
    `found ${audit.layouts.length} layouts, expected ${EXPECTED_LAYOUTS}: ${audit.layouts.join(", ")}`
  );
  assert.equal(
    audit.screenHeaderRoutes.length,
    EXPECTED_SCREEN_HEADER,
    `found ${audit.screenHeaderRoutes.length} screens rendering <ScreenHeader>, expected ` +
      `${EXPECTED_SCREEN_HEADER}:\n  ` + audit.screenHeaderRoutes.join("\n  ")
  );
  assert.equal(
    audit.nativeHeaderRoutes.length,
    EXPECTED_NATIVE_HEADER,
    `found ${audit.nativeHeaderRoutes.length} screens showing the native header, expected ` +
      `${EXPECTED_NATIVE_HEADER}:\n  ` + audit.nativeHeaderRoutes.join("\n  ")
  );

  // Positive control on the classifier itself: an unrecognised navigator
  // component is silently ignored by resolveLevel, so the set found must be
  // exactly the set the module knows how to reason about.
  const known = [...HEADER_BEARING_NAVIGATORS, ...HEADERLESS_NAVIGATORS].sort();
  assert.deepEqual(
    audit.navigatorComponents,
    known,
    `navigator components in app/ are ${audit.navigatorComponents.join(", ")} but this module ` +
      `classifies ${known.join(", ")}. A navigator it does not know about contributes no ` +
      `headerShown and would make the audit silently permissive.`
  );
});

test("every screen rendering <ScreenHeader> has the native header hidden at every level", () => {
  const audit = auditScreenHeaders(readAppTree(APP_DIR));

  assert.deepEqual(
    audit.unresolved,
    [],
    "a headerShown could not be resolved statically. It is reported rather than assumed, " +
      "because assuming 'fine' is how this check would become decoration:\n  " +
      audit.unresolved.map((u) => `${u.route}: ${u.detail}`).join("\n  ")
  );

  assert.deepEqual(
    audit.violations,
    [],
    "screen-header invariant broken:\n  " +
      audit.violations.map((v) => `${v.route} [${v.rule}] ${v.detail}`).join("\n  ")
  );

  // The negative assertion above passes over an empty list, so: the population
  // it ran against is non-empty and every member is accounted for.
  assert.equal(audit.screenHeaderRoutes.length, EXPECTED_SCREEN_HEADER);
  for (const route of audit.screenHeaderRoutes) {
    assert.ok(
      audit.headerHiddenRoutes.includes(route),
      `${route} renders <ScreenHeader> but is not in the header-hidden set`
    );
  }
});

test("settings/offline-sync is registered — the AUDIT L59 regression guard", () => {
  const audit = auditScreenHeaders(readAppTree(APP_DIR));
  assert.ok(
    audit.screenHeaderRoutes.includes("settings/offline-sync"),
    "settings/offline-sync no longer renders <ScreenHeader>; this guard is now pointing at nothing"
  );
  assert.ok(
    audit.headerHiddenRoutes.includes("settings/offline-sync"),
    "settings/offline-sync is showing a native header again — this is exactly AUDIT L59"
  );
});

// ── Positive controls on synthetic trees ────────────────────────────────────
//
// These are not a substitute for the red-on-revert run against the real file;
// they are what gives the nested-navigator resolution any coverage at all.
// Today NO <ScreenHeader> screen lives inside `(tabs)`, so without the fixtures
// below, `chainFor`'s multi-level branch would be reasoning nobody executed —
// and `(tabs)/supervisor` not being flagged would be luck rather than logic.

const ROOT_LAYOUT_HIDDEN = `
  import { Stack } from "expo-router";
  export default function L() {
    return (
      <Stack screenOptions={{ headerBackTitle: "Back" }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="settings/thing" options={{ headerShown: false }} />
        <Stack.Screen name="legal" options={{ title: "Legal", headerShown: true }} />
      </Stack>
    );
  }
`;
const TABS_LAYOUT_HIDDEN = `
  import { Tabs } from "expo-router";
  export default function T() {
    return (
      <Tabs screenOptions={{ headerShown: false }}>
        <Tabs.Screen name="home" options={{ title: "Home" }} />
      </Tabs>
    );
  }
`;
const PAINTS_OWN = `
  import { ScreenHeader } from "@/components/ScreenHeader";
  export default function S() { return <ScreenHeader title="Thing" />; }
`;
const PAINTS_NOTHING = `export default function S() { return null; }`;

test("positive control: the rule is satisfied through a nested navigator", () => {
  const audit = auditScreenHeaders({
    "_layout.tsx": ROOT_LAYOUT_HIDDEN,
    "(tabs)/_layout.tsx": TABS_LAYOUT_HIDDEN,
    "(tabs)/home.tsx": PAINTS_OWN,
    "settings/thing.tsx": PAINTS_OWN,
    "legal.tsx": PAINTS_NOTHING,
  });
  assert.deepEqual(audit.unresolved, []);
  assert.deepEqual(audit.violations, []);
  assert.deepEqual(audit.screenHeaderRoutes, ["(tabs)/home", "settings/thing"]);
  assert.deepEqual(audit.nativeHeaderRoutes, ["legal"]);
  // Two levels had to resolve for (tabs)/home to be clean, not one.
  const chain = chainFor("(tabs)/home", new Map([
    ["_layout.tsx", parseLayout("_layout.tsx", ROOT_LAYOUT_HIDDEN)],
    ["(tabs)/_layout.tsx", parseLayout("(tabs)/_layout.tsx", TABS_LAYOUT_HIDDEN)],
  ]));
  assert.equal(chain.length, 2, "the nested chain did not resolve two levels");
});

test("positive control: an unregistered <ScreenHeader> screen is caught by name — AUDIT L59", () => {
  const audit = auditScreenHeaders({
    "_layout.tsx": ROOT_LAYOUT_HIDDEN,
    "settings/thing.tsx": PAINTS_OWN,
    // Reachable, renders its own header, never registered. The exact shape of
    // settings/offline-sync before L59 was fixed.
    "settings/forgotten.tsx": PAINTS_OWN,
  });
  assert.equal(audit.violations.length, 1, JSON.stringify(audit.violations, null, 2));
  assert.equal(audit.violations[0].route, "settings/forgotten");
  assert.equal(audit.violations[0].rule, "screen-header-needs-native-header-hidden");
  assert.match(audit.violations[0].detail, /not registered at all/);
  assert.deepEqual(audit.unregisteredRoutes, ["settings/forgotten"]);
});

test("positive control: headerShown false removed from a registration is caught", () => {
  const broken = ROOT_LAYOUT_HIDDEN.replace(
    `<Stack.Screen name="settings/thing" options={{ headerShown: false }} />`,
    `<Stack.Screen name="settings/thing" />`
  );
  assert.notEqual(broken, ROOT_LAYOUT_HIDDEN, "the fixture edit did not apply");
  const audit = auditScreenHeaders({ "_layout.tsx": broken, "settings/thing.tsx": PAINTS_OWN });
  assert.equal(audit.violations.length, 1, JSON.stringify(audit.violations, null, 2));
  assert.equal(audit.violations[0].route, "settings/thing");
});

test("positive control: the other half — headerShown true AND a ScreenHeader", () => {
  const audit = auditScreenHeaders({
    "_layout.tsx": ROOT_LAYOUT_HIDDEN,
    "legal.tsx": PAINTS_OWN, // registered headerShown: true, now paints its own too
  });
  // The deliberate case, so it is reported under the other half of the rule —
  // the remedy is "remove one", not "register it with headerShown: false".
  assert.equal(audit.violations.length, 1, JSON.stringify(audit.violations, null, 2));
  assert.equal(audit.violations[0].route, "legal");
  assert.equal(audit.violations[0].rule, "native-header-must-not-render-screen-header");
  assert.match(audit.violations[0].detail, /headerShown: true/);
  // And it is in the native-header population, which the real-tree test counts.
  assert.deepEqual(audit.nativeHeaderRoutes, ["legal"]);
});

test("positive control: a nested navigator that stops hiding its header is caught", () => {
  const broken = TABS_LAYOUT_HIDDEN.replace(`screenOptions={{ headerShown: false }}`, `screenOptions={{}}`);
  assert.notEqual(broken, TABS_LAYOUT_HIDDEN, "the fixture edit did not apply");
  const audit = auditScreenHeaders({
    "_layout.tsx": ROOT_LAYOUT_HIDDEN,
    "(tabs)/_layout.tsx": broken,
    "(tabs)/home.tsx": PAINTS_OWN,
  });
  assert.equal(audit.violations.length, 1, JSON.stringify(audit.violations, null, 2));
  assert.equal(audit.violations[0].route, "(tabs)/home");
  // Named the inner layout, not the root — the root is correct here.
  assert.match(audit.violations[0].detail, /\(tabs\)\/_layout\.tsx/);
});

test("a headerShown it cannot evaluate is reported, not assumed", () => {
  const spread = `
    import { Stack } from "expo-router";
    const opts = { headerShown: false };
    export default function L() {
      return (
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="settings/thing" options={{ ...opts }} />
        </Stack>
      );
    }
  `;
  const audit = auditScreenHeaders({ "_layout.tsx": spread, "settings/thing.tsx": PAINTS_OWN });
  assert.equal(audit.unresolved.length, 1, JSON.stringify(audit.unresolved));
  assert.match(audit.unresolved[0].detail, /spread/);
  // And it did NOT quietly pass as a violation-free tree.
  assert.deepEqual(audit.violations, []);
});

test("the multi-line registration form is parsed — the diary-gallery near-miss", () => {
  // A grep for `name="x"` on the same line as `Stack.Screen` misses this shape,
  // which once made a registered screen look unregistered.
  const multiline = `
    import { Stack } from "expo-router";
    export default function L() {
      return (
        <Stack screenOptions={{}}>
          <Stack.Screen
            name="diary-gallery/[siteId]"
            options={{
              headerShown: false,
            }}
          />
        </Stack>
      );
    }
  `;
  const facts = parseLayout("_layout.tsx", multiline);
  assert.deepEqual(facts.screens, [
    { name: "diary-gallery/[siteId]", headerShown: { kind: "boolean", value: false } },
  ]);
});

test("rendersScreenHeader finds the element and not the word", () => {
  assert.equal(rendersScreenHeader(PAINTS_OWN), true);
  assert.equal(
    rendersScreenHeader(`// the seven pushed screens get it from the shared ScreenHeader\nexport default function S(){return null;}`),
    false,
    "a mention of ScreenHeader in a comment must not count as rendering one — " +
      "app/(tabs)/supervisor.tsx has exactly that comment"
  );
  assert.equal(rendersScreenHeader(`const ScreenHeader = 1; export default ScreenHeader;`), false);
});
