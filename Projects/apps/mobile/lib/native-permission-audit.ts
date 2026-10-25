import * as ts from "typescript";

/**
 * What native permissions app.config.ts actually declares, read with the
 * TypeScript parser.
 *
 * WHY THIS EXISTS
 *
 * AUDIT L60 removed four declarations of a capability no user can switch on:
 * the iOS NSLocationWhenInUseUsageDescription purpose string, the
 * `expo-location` config plugin (which writes the same Info.plist key, plus an
 * injected NSLocationAlwaysAndWhenInUseUsageDescription), and the Android
 * ACCESS_FINE_LOCATION / ACCESS_COARSE_LOCATION permissions. The removal is the
 * App Store answer, and it is worth exactly as much as the thing stopping it
 * being undone by accident on the next config edit.
 *
 * WHY THE PARSER AND NOT A GREP
 *
 * The removal deliberately PRESERVES the removed lines, commented, at the top of
 * app.config.ts, so that restoring the feature is uncommenting rather than
 * rediscovering the wording. Every string a grep would look for is therefore
 * still in the file. A grep-based guard would match the comment and fail on a
 * correct config; a guard built to tolerate that would be matching on prose.
 *
 * `ts.createSourceFile` makes the problem disappear instead of managing it:
 * comments are trivia, not nodes, so a declaration that exists only in a comment
 * is not a declaration and this module cannot see it. That is proved by fixture
 * in native-permission-audit.test.ts rather than asserted here.
 *
 * It is also the difference between right and right-most-of-the-time. The same
 * reasoning is written out at more length in lib/screen-header-audit.ts: the
 * plugins array alone holds bare strings, `[name, options]` tuples and a
 * conditional spread, and a regex that handles two of those three is the shape
 * of check that goes green for the wrong reason.
 *
 * WHAT IT REFUSES TO GUESS
 *
 * A plugins entry whose name cannot be read statically, or a `permissions` /
 * `infoPlist` value that is not the literal this expects, goes into
 * `unresolved` rather than being assumed harmless. The test fails on a
 * non-empty `unresolved` list. An approximation that silently resolves to
 * "fine" is how a guard becomes decoration.
 *
 * THIS IS A STATIC READING OF THE CONFIG SOURCE, NOT A PREBUILD. It proves what
 * the config says. It cannot prove what `expo prebuild` writes into
 * Info.plist or AndroidManifest.xml, because no prebuild, simulator or device is
 * reachable from the environment this runs in. The gap that leaves is real and
 * is stated in the pull request rather than papered over here: a future Expo
 * version, or a transitive plugin, could inject a purpose string that this
 * module would not see. What it does cover is the only way the declarations have
 * ever actually appeared in this project — written in this file by hand.
 */

/** A plugin entry in the `plugins` array, as this module could read it. */
export type PluginRef = {
  name: string;
  /** True for an entry inside a spread, e.g. `...(FLAG ? ["expo-updates"] : [])`. */
  conditional: boolean;
};

export type NativeDeclarations = {
  /** Info.plist keys assigned in `ios.infoPlist`. */
  iosInfoPlistKeys: string[];
  /** String entries of `android.permissions`. */
  androidPermissions: string[];
  /** Config plugins, conditional ones included. */
  plugins: PluginRef[];
  /**
   * Anything in those three positions this module declined to interpret, as
   * source text. A non-empty list means the audit is incomplete and must fail.
   */
  unresolved: string[];
};

function propertyName(node: ts.ObjectLiteralElementLike): string | undefined {
  const name = node.name;
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return undefined;
}

/** Every string literal anywhere beneath a node, in source order. */
function stringLiteralsWithin(node: ts.Node): string[] {
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n)) found.push(n.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * Read the native declarations out of an app.config.ts source text.
 *
 * Deliberately a whole-tree sweep for the three property names rather than a
 * walk down `export default -> return -> ios -> infoPlist`. The config is an
 * arrow function that spreads `config`, builds intermediates and returns an
 * object literal; a path-based reader would need updating every time that shape
 * is refactored, and would report "no declarations" — a pass — when it stopped
 * matching. Finding the properties wherever they are cannot fail that way, and
 * the test pins the populations so an extra `infoPlist` appearing somewhere
 * unexpected shows up as a count change rather than silently merging in.
 */
export function auditNativeDeclarations(source: string): NativeDeclarations {
  const file = ts.createSourceFile(
    "app.config.ts",
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  const result: NativeDeclarations = {
    iosInfoPlistKeys: [],
    androidPermissions: [],
    plugins: [],
    unresolved: [],
  };
  const text = (n: ts.Node): string => n.getText(file).replace(/\s+/g, " ").slice(0, 120);

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const key = propertyName(node);

      if (key === "infoPlist") {
        if (ts.isObjectLiteralExpression(node.initializer)) {
          for (const member of node.initializer.properties) {
            const name = propertyName(member);
            if (name === undefined) result.unresolved.push(`infoPlist: ${text(member)}`);
            else result.iosInfoPlistKeys.push(name);
          }
        } else {
          result.unresolved.push(`infoPlist: ${text(node.initializer)}`);
        }
      }

      if (key === "permissions") {
        if (ts.isArrayLiteralExpression(node.initializer)) {
          for (const element of node.initializer.elements) {
            if (ts.isStringLiteral(element)) result.androidPermissions.push(element.text);
            else result.unresolved.push(`permissions: ${text(element)}`);
          }
        } else {
          result.unresolved.push(`permissions: ${text(node.initializer)}`);
        }
      }

      if (key === "plugins") {
        if (ts.isArrayLiteralExpression(node.initializer)) {
          for (const element of node.initializer.elements) {
            // "expo-router"
            if (ts.isStringLiteral(element)) {
              result.plugins.push({ name: element.text, conditional: false });
              continue;
            }
            // ["expo-notifications", { ... }] -- the name is the head
            if (ts.isArrayLiteralExpression(element)) {
              const head = element.elements[0];
              if (head && ts.isStringLiteral(head)) {
                result.plugins.push({ name: head.text, conditional: false });
              } else {
                result.unresolved.push(`plugins: ${text(element)}`);
              }
              continue;
            }
            // ...(UPDATES_ENABLED ? ["expo-updates"] : [])
            // Both arms are collected: a plugin that is linked on SOME profile
            // is linked, and a permission declared on one profile is declared.
            if (ts.isSpreadElement(element)) {
              const names = stringLiteralsWithin(element.expression);
              if (names.length === 0) {
                result.unresolved.push(`plugins: ${text(element)}`);
              } else {
                for (const name of names) result.plugins.push({ name, conditional: true });
              }
              continue;
            }
            result.unresolved.push(`plugins: ${text(element)}`);
          }
        } else {
          result.unresolved.push(`plugins: ${text(node.initializer)}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(file);
  return result;
}

/** Whether a plugin is configured at all, on any build profile. */
export function declaresPlugin(declarations: NativeDeclarations, name: string): boolean {
  return declarations.plugins.some((plugin) => plugin.name === name);
}

/**
 * The iOS purpose-string keys that mean "this app collects location", and the
 * Android permissions that mean the same thing.
 *
 * NSLocationAlwaysAndWhenInUseUsageDescription is on the list even though this
 * project never set it by hand: AUDIT L60 recorded that the `expo-location`
 * plugin injected a generic one, so it is what a reintroduction would look like
 * if it came back through a plugin rather than through infoPlist.
 */
export const IOS_LOCATION_PURPOSE_KEYS = [
  "NSLocationWhenInUseUsageDescription",
  "NSLocationAlwaysAndWhenInUseUsageDescription",
  "NSLocationAlwaysUsageDescription",
  "NSLocationTemporaryUsageDescriptionDictionary",
] as const;

export const ANDROID_LOCATION_PERMISSIONS = [
  "ACCESS_FINE_LOCATION",
  "ACCESS_COARSE_LOCATION",
  "ACCESS_BACKGROUND_LOCATION",
] as const;

/** Expo config plugins that write a location purpose string during prebuild. */
export const LOCATION_PLUGINS = ["expo-location"] as const;
