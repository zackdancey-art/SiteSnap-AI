import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ANDROID_LOCATION_PERMISSIONS,
  IOS_LOCATION_PURPOSE_KEYS,
  LOCATION_PLUGINS,
  auditNativeDeclarations,
  declaresPlugin,
} from "@/lib/native-permission-audit";

/**
 * app.config.ts must not declare location permissions. AUDIT L60.
 *
 * WHAT THIS DEFENDS
 *
 * The App Store submission. The app declared the iOS location purpose string
 * twice over and two Android location permissions, for a capability with no
 * entry point: lib/location-service.ts still exports requestPermissionAndStart,
 * startTracking and setLocationTrackingEnabled and nothing calls any of them.
 * Declaring a permission the app cannot request is a documented review
 * rejection reason. The declarations were removed; this is what keeps them
 * removed, because the next person to edit the config has no way of knowing
 * that re-adding `expo-location` to the plugins array is a submission problem.
 *
 * WHY THE PRESERVED COMMENT DOES NOT DEFEAT IT
 *
 * The removal keeps the removed lines, commented, at the top of app.config.ts,
 * so restoring the feature is uncommenting rather than rewriting. Every string
 * this test cares about is therefore still present in the file as text. The
 * audit reads the parsed syntax tree, where comments are trivia and not nodes,
 * so a commented declaration is not a declaration. "The comment does not count"
 * is not taken on trust: `only a comment` below is the fixture that proves it,
 * and it is paired with `the same source, uncommented` so that the pair fails if
 * the auditor has simply stopped finding anything at all.
 *
 * WHAT IT IS NOT
 *
 * A static reading of the config source, not a prebuild. No prebuild, simulator
 * or device is reachable here, so nothing in this file proves what lands in
 * Info.plist. It proves what the config says — which is the only way these
 * declarations have ever entered this project.
 */

/**
 * `__dirname` is `dist-test/lib` at run time, so app.config.ts is two levels up.
 * If that stops being true this must fail rather than audit an empty string.
 */
const CONFIG_PATH = path.resolve(__dirname, "..", "..", "app.config.ts");

/**
 * Pinned populations, measured from the file rather than written from reading
 * it — see the identical bargain in lib/screen-header-audit.test.ts. The point
 * is that "no location declaration" cannot be satisfied by an audit that found
 * no declarations at all, which is how four checks in this project have gone
 * green for the wrong reason (docs/VACUITY-AUDIT.md).
 *
 * Raise these in the same commit that adds a purpose string, permission or
 * plugin, so the change is visible in review.
 */
const EXPECTED_INFO_PLIST_KEYS = 8;
const EXPECTED_ANDROID_PERMISSIONS = 4;
const EXPECTED_PLUGINS = 7;

function configSource(): string {
  return fs.readFileSync(CONFIG_PATH, "utf8");
}

test("app.config.ts is where this test thinks it is", () => {
  assert.ok(
    fs.existsSync(CONFIG_PATH),
    `app.config.ts not found at ${CONFIG_PATH}. Every assertion below would ` +
      `otherwise audit an empty file and pass.`,
  );
  assert.ok(
    configSource().length > 1000,
    "app.config.ts is implausibly short; refusing to audit it",
  );
});

test("the audit found the config's declarations, and all of them", () => {
  const found = auditNativeDeclarations(configSource());

  assert.deepEqual(
    found.unresolved,
    [],
    `The audit could not interpret part of app.config.ts, so it does not know ` +
      `what the config declares and must not report a clean result:\n` +
      found.unresolved.map((u) => `  - ${u}`).join("\n"),
  );

  assert.equal(
    found.iosInfoPlistKeys.length,
    EXPECTED_INFO_PLIST_KEYS,
    `ios.infoPlist key count changed. Found: ${found.iosInfoPlistKeys.join(", ")}`,
  );
  assert.equal(
    found.androidPermissions.length,
    EXPECTED_ANDROID_PERMISSIONS,
    `android.permissions count changed. Found: ${found.androidPermissions.join(", ")}`,
  );
  assert.equal(
    found.plugins.length,
    EXPECTED_PLUGINS,
    `plugins count changed. Found: ${found.plugins.map((p) => p.name).join(", ")}`,
  );
});

test("no iOS location purpose string is declared, and the camera one still is", () => {
  const found = auditNativeDeclarations(configSource());

  for (const key of IOS_LOCATION_PURPOSE_KEYS) {
    assert.ok(
      !found.iosInfoPlistKeys.includes(key),
      `app.config.ts declares ${key}. AUDIT L60: the location feature has no ` +
        `entry point, so this tells App Store review the app collects data it ` +
        `cannot collect. If the feature is now real, raise it here deliberately.`,
    );
  }

  // The positive control, on the same list from the same parse. Without it,
  // deleting ios.infoPlist entirely — or breaking the parse — passes the loop
  // above with nothing checked.
  assert.ok(
    found.iosInfoPlistKeys.includes("NSCameraUsageDescription"),
    `NSCameraUsageDescription is missing from ios.infoPlist. Either the camera ` +
      `purpose string has been lost (the app cannot take a photograph without ` +
      `it) or this audit is no longer reading infoPlist at all, in which case ` +
      `the location assertions above checked nothing. Found: ` +
      `${found.iosInfoPlistKeys.join(", ")}`,
  );
});

test("no Android location permission is declared, and CAMERA still is", () => {
  const found = auditNativeDeclarations(configSource());

  for (const permission of ANDROID_LOCATION_PERMISSIONS) {
    assert.ok(
      !found.androidPermissions.includes(permission),
      `app.config.ts declares android permission ${permission} for a feature ` +
        `with no entry point. AUDIT L60.`,
    );
  }

  assert.ok(
    found.androidPermissions.includes("CAMERA"),
    `CAMERA is missing from android.permissions, so either the app can no ` +
      `longer photograph a site or this audit is not reading the permissions ` +
      `array. Found: ${found.androidPermissions.join(", ")}`,
  );
});

test("the expo-location plugin is not configured, and expo-notifications is", () => {
  const found = auditNativeDeclarations(configSource());

  for (const plugin of LOCATION_PLUGINS) {
    assert.ok(
      !declaresPlugin(found, plugin),
      `app.config.ts configures the ${plugin} plugin, which writes ` +
        `NSLocationWhenInUseUsageDescription during prebuild — the same key ` +
        `ios.infoPlist used to set, which is why AUDIT L60 lists two ` +
        `declarations of one capability. Removing the infoPlist line alone is ` +
        `not enough.`,
    );
  }

  assert.ok(
    declaresPlugin(found, "expo-notifications"),
    `The expo-notifications plugin is missing, so either push notifications ` +
      `have been unconfigured or this audit is not reading the plugins array ` +
      `and the refusal above means nothing. Found: ` +
      `${found.plugins.map((p) => p.name).join(", ")}`,
  );

  // The conditional-spread arm, which is the one a regex gets wrong. expo-updates
  // is only in the array when APP_ENV is production or preview, and it must still
  // be found — a plugin linked on some profile is linked.
  assert.ok(
    declaresPlugin(found, "expo-updates"),
    `expo-updates was not found inside the conditional spread. The audit is ` +
      `not reading spread elements, so a location plugin re-added inside one ` +
      `would also go unseen.`,
  );
});

// ── Fixtures: does the audit actually see a declaration when there is one? ────

const DECLARED = `
export default ({ config }) => ({
  ...config,
  ios: {
    infoPlist: {
      NSCameraUsageDescription: "camera",
      NSLocationWhenInUseUsageDescription: "location",
    },
  },
  android: { permissions: ["CAMERA", "ACCESS_FINE_LOCATION"] },
  plugins: ["expo-notifications", ["expo-location", { locationWhenInUsePermission: "x" }]],
});
`;

test("a real declaration is found", () => {
  const found = auditNativeDeclarations(DECLARED);
  assert.deepEqual(found.unresolved, []);
  assert.ok(found.iosInfoPlistKeys.includes("NSLocationWhenInUseUsageDescription"));
  assert.ok(found.androidPermissions.includes("ACCESS_FINE_LOCATION"));
  assert.ok(declaresPlugin(found, "expo-location"));
});

test("only a comment: the same declarations, commented, are not found", () => {
  // Every line of DECLARED that carries a location declaration, moved into a
  // comment. This is the shape app.config.ts is now in, and it is the one way
  // this guard could be silently useless.
  const commented = `
export default ({ config }) => ({
  ...config,
  ios: {
    infoPlist: {
      NSCameraUsageDescription: "camera",
      // NSLocationWhenInUseUsageDescription: "location",
    },
  },
  android: {
    permissions: [
      "CAMERA",
      /* "ACCESS_FINE_LOCATION", */
    ],
  },
  plugins: [
    "expo-notifications",
    // ["expo-location", { locationWhenInUsePermission: "x" }],
  ],
});
`;
  const found = auditNativeDeclarations(commented);
  assert.deepEqual(found.unresolved, []);

  assert.ok(
    !found.iosInfoPlistKeys.includes("NSLocationWhenInUseUsageDescription"),
    "a commented-out infoPlist key was reported as declared",
  );
  assert.ok(
    !found.androidPermissions.includes("ACCESS_FINE_LOCATION"),
    "a commented-out android permission was reported as declared",
  );
  assert.ok(
    !declaresPlugin(found, "expo-location"),
    "a commented-out plugin entry was reported as declared",
  );

  // Paired with the positives from the SAME parse: the three refusals above are
  // satisfied by an auditor that returns nothing, and this is what separates
  // "the comment does not count" from "nothing counts".
  assert.ok(found.iosInfoPlistKeys.includes("NSCameraUsageDescription"));
  assert.ok(found.androidPermissions.includes("CAMERA"));
  assert.ok(declaresPlugin(found, "expo-notifications"));
});

test("a plugin name it cannot read statically is unresolved, not ignored", () => {
  const found = auditNativeDeclarations(`
export default () => ({ plugins: [somePluginName, ["expo-notifications", {}]] });
`);
  assert.equal(found.unresolved.length, 1, found.unresolved.join(" | "));
  assert.match(found.unresolved[0], /somePluginName/);
  assert.ok(declaresPlugin(found, "expo-notifications"));
});
