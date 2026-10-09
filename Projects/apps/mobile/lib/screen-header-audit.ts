import * as ts from "typescript";

/**
 * The screen-header registration invariant, as a thing a machine checks.
 *
 * THE RULE
 *
 * Every screen that renders the shared `<ScreenHeader>` must have the native
 * header hidden at every navigator level between it and the root. Equivalently:
 * no screen may show two headers.
 *
 * WHY THIS IS A TEST AND NOT A CONVENTION
 *
 * The rule has now been broken twice and found by hand twice.
 *
 *   - `terms-of-service` was reachable but never registered in app/_layout.tsx,
 *     so it fell through to the bare root `screenOptions` and native-stack drew
 *     its default title: the raw route name, "terms-of-service".
 *   - `settings/offline-sync` was the same omission with a louder symptom. It
 *     renders `ScreenHeader`, so with the native bar also shown it displayed
 *     BOTH a "‹ Back" bar and its own "‹ Offline Sync" header. Two back
 *     affordances, one screen. AUDIT L59.
 *
 * Nothing in the codebase could have noticed either. A hand sweep of 39 route
 * files found the second one and then evaporated; the fortieth screen can make
 * the identical mistake tomorrow. This module is that sweep made permanent.
 *
 * WHY THE TYPESCRIPT PARSER AND NOT A REGEX
 *
 * `app/_layout.tsx` writes registrations in at least three shapes — a one-line
 * self-closing element, a multi-line element with the `name` attribute on its
 * own line, and a nested `options={{ ... }}` object with other keys around the
 * one we care about. A grep for `name="x"` on one line misses the multi-line
 * form, which is exactly the mistake that once made `diary-gallery/[siteId]`
 * look unregistered when it is registered at _layout.tsx:184. Parsing with
 * `ts.createSourceFile` is not gold-plating; it is the difference between a
 * check that is right and one that is right most of the time about a rule
 * nobody remembers.
 *
 * WHAT IT REFUSES TO GUESS
 *
 * A `headerShown` it cannot evaluate statically — a spread, a variable, a
 * ternary — is reported as `unresolved` rather than assumed either way, and the
 * test treats a non-empty unresolved list as a failure. An approximation that
 * silently resolves to "fine" is how a check like this becomes decoration.
 *
 * Everything here takes a plain map of path -> source text, so the test can run
 * it against the real `app/` tree and against synthetic fixtures in the same
 * breath. The fixtures are what give the nested-navigator path any coverage at
 * all: today no `ScreenHeader` screen lives inside `(tabs)`, so without them
 * that branch would be reasoning nobody had ever executed.
 */

/** Paths relative to `app/` -> file contents. See the note above on why. */
export type VirtualFiles = Record<string, string>;

/**
 * expo-router navigators that draw a header of their own.
 *
 * `NativeTabs` (expo-router/unstable-native-tabs) is deliberately absent: it is
 * a SwiftUI tab view with no JS header, so it cannot contribute a second bar.
 * `app/(tabs)/_layout.tsx` renders NativeTabs or Tabs depending on
 * `isLiquidGlassAvailable()`, and only the Tabs branch has a header to hide.
 *
 * The test asserts the set of navigator components actually found is exactly
 * the union of these two lists, so a THIRD navigator type appearing in the tree
 * fails the build instead of being silently ignored by this classification.
 */
export const HEADER_BEARING_NAVIGATORS = ["Stack", "Tabs"] as const;
export const HEADERLESS_NAVIGATORS = ["NativeTabs"] as const;

/**
 * Files under `app/` that expo-router does not treat as routes.
 *
 * `_`-prefixed files are layouts and internals; `+`-prefixed files are
 * expo-router's own specials (`+not-found`, `+native-intent`), which it wires
 * up without a `Stack.Screen` registration.
 */
function isRouteFile(relPath: string): boolean {
  if (!relPath.endsWith(".tsx")) return false;
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return !base.startsWith("_") && !base.startsWith("+");
}

/** Absent, a resolved boolean, or something we refuse to guess at. */
export type OptionValue =
  | { kind: "boolean"; value: boolean }
  | { kind: "absent" }
  | { kind: "unresolved"; reason: string };

export type NavigatorFacts = {
  component: string;
  headerBearing: boolean;
  screenOptionsHeaderShown: OptionValue;
  /**
   * The `Screen`/`Trigger` registrations lexically inside THIS navigator.
   *
   * Attribution matters because a layout may render more than one navigator.
   * `app/(tabs)/_layout.tsx` renders `NativeTabs` or `Tabs` depending on
   * `isLiquidGlassAvailable()`, so every tab route is registered twice, in two
   * branches with different header semantics: NativeTabs has no JS header at
   * all, Tabs hides one via `screenOptions`. A flat list of registrations per
   * layout cannot tell those apart, and the first version of this module could
   * only report "registered 2 times" and give up on the entire tab subtree.
   */
  screens: ScreenFacts[];
};

export type ScreenFacts = {
  name: string;
  headerShown: OptionValue;
};

export type LayoutFacts = {
  path: string;
  navigators: NavigatorFacts[];
  /** Every registration in the file, whichever navigator owns it. */
  screens: ScreenFacts[];
  /**
   * Registrations not lexically inside any navigator — extracted into a
   * variable or a helper component. None exist today. They are collected
   * rather than ignored so that the test fails on one instead of quietly
   * treating the screen as unregistered.
   */
  orphanScreens: ScreenFacts[];
};

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function jsxTagName(node: ts.JsxOpeningElement | ts.JsxSelfClosingElement): string {
  return node.tagName.getText(node.getSourceFile());
}

function attribute(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string
): ts.JsxAttribute | undefined {
  for (const attr of node.attributes.properties) {
    if (ts.isJsxAttribute(attr) && attr.name.getText(node.getSourceFile()) === name) return attr;
  }
  return undefined;
}

/** `name="settings/about"` -> `settings/about`. Anything else is not a literal. */
function stringAttribute(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  name: string
): string | undefined {
  const attr = attribute(node, name);
  if (!attr || !attr.initializer) return undefined;
  if (ts.isStringLiteral(attr.initializer)) return attr.initializer.text;
  if (
    ts.isJsxExpression(attr.initializer) &&
    attr.initializer.expression &&
    ts.isStringLiteralLike(attr.initializer.expression)
  ) {
    return attr.initializer.expression.text;
  }
  return undefined;
}

/**
 * Reads `headerShown` out of an `options={{ ... }}` / `screenOptions={{ ... }}`
 * attribute, distinguishing "not written" from "written but not statically
 * knowable".
 */
function headerShownFrom(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
  attrName: string
): OptionValue {
  const attr = attribute(node, attrName);
  if (!attr) return { kind: "absent" };
  if (!attr.initializer || !ts.isJsxExpression(attr.initializer) || !attr.initializer.expression) {
    return { kind: "unresolved", reason: `${attrName} has no expression` };
  }
  const expr = attr.initializer.expression;
  if (!ts.isObjectLiteralExpression(expr)) {
    return { kind: "unresolved", reason: `${attrName} is not an object literal` };
  }

  // A spread could carry headerShown from anywhere, so the whole object becomes
  // unknowable rather than "absent".
  for (const prop of expr.properties) {
    if (ts.isSpreadAssignment(prop)) {
      return { kind: "unresolved", reason: `${attrName} contains a spread` };
    }
  }

  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
    if (key !== "headerShown") continue;
    if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) return { kind: "boolean", value: true };
    if (prop.initializer.kind === ts.SyntaxKind.FalseKeyword) return { kind: "boolean", value: false };
    return {
      kind: "unresolved",
      reason: `headerShown in ${attrName} is not a boolean literal`,
    };
  }
  return { kind: "absent" };
}

/** Does this file render the shared `<ScreenHeader>`? */
export function rendersScreenHeader(source: string, path = "x.tsx"): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (jsxTagName(node) === "ScreenHeader") {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(path, source));
  return found;
}

export function parseLayout(path: string, source: string): LayoutFacts {
  const navigators: NavigatorFacts[] = [];
  const screens: ScreenFacts[] = [];
  const orphanScreens: ScreenFacts[] = [];
  const known = new Set<string>([...HEADER_BEARING_NAVIGATORS, ...HEADERLESS_NAVIGATORS]);

  const registration = (open: ts.JsxOpeningElement | ts.JsxSelfClosingElement): ScreenFacts => {
    const name = stringAttribute(open, "name");
    if (name === undefined) {
      return {
        name: `(unreadable name at ${path})`,
        headerShown: { kind: "unresolved", reason: "the name attribute is not a string literal" },
      };
    }
    return { name, headerShown: headerShownFrom(open, "options") };
  };

  /** `owner` is the navigator we are lexically inside, if any. */
  const visit = (node: ts.Node, owner: NavigatorFacts | undefined): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const open = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = jsxTagName(open);
      const dot = tag.indexOf(".");

      if (dot === -1 && known.has(tag)) {
        const nav: NavigatorFacts = {
          component: tag,
          headerBearing: (HEADER_BEARING_NAVIGATORS as readonly string[]).includes(tag),
          screenOptionsHeaderShown: headerShownFrom(open, "screenOptions"),
          screens: [],
        };
        navigators.push(nav);
        // Descend into the children only, not the attributes. `(tabs)/_layout.tsx`
        // renders a <BlurView> inside `screenOptions.tabBarBackground`; that is
        // not a registration and must not be walked as one.
        if (ts.isJsxElement(node)) for (const child of node.children) visit(child, nav);
        return;
      }

      // `Stack.Screen`, `Tabs.Screen`, `NativeTabs.Trigger`
      if (dot !== -1 && known.has(tag.slice(0, dot))) {
        const facts = registration(open);
        screens.push(facts);
        if (owner) owner.screens.push(facts);
        else orphanScreens.push(facts);
      }
    }
    ts.forEachChild(node, (child) => visit(child, owner));
  };

  visit(parse(path, source), undefined);
  return { path, navigators, screens, orphanScreens };
}

/** One rung of the navigator chain: which layout governs, and what it says. */
export type ChainLevel = {
  layout: string;
  nameInLayout: string;
  value: OptionValue;
  from: string;
  /** Did this layout register the route, or does it only fall through? */
  registered: boolean;
};

function resolveLevel(layout: LayoutFacts, name: string): ChainLevel {
  const at = (value: OptionValue, from: string, registered: boolean): ChainLevel => ({
    layout: layout.path,
    nameInLayout: name,
    value,
    from,
    registered,
  });

  if (layout.orphanScreens.some((s) => s.name === name)) {
    return at(
      { kind: "unresolved", reason: `"${name}" is registered outside any navigator` },
      "unattributable registration",
      true
    );
  }

  const owners = layout.navigators.filter((n) => n.screens.some((s) => s.name === name));

  if (owners.length > 0) {
    // One entry per navigator BRANCH that registers this route. The screen is
    // only safe if EVERY branch hides the header, so the branches must agree;
    // disagreement is a real ambiguity and is reported, not averaged.
    const branches = owners.map((nav) => {
      const own = nav.screens.filter((s) => s.name === name);
      if (own.length > 1) {
        return {
          nav,
          value: {
            kind: "unresolved",
            reason: `registered ${own.length} times inside one <${nav.component}>`,
          } as OptionValue,
        };
      }
      const explicit = own[0].headerShown;
      if (explicit.kind !== "absent") return { nav, value: explicit };
      // A headerless navigator cannot contribute a header, whatever its
      // screenOptions say — NativeTabs is a SwiftUI tab view with no JS header.
      if (!nav.headerBearing) {
        return { nav, value: { kind: "boolean", value: false } as OptionValue };
      }
      return { nav, value: nav.screenOptionsHeaderShown };
    });

    const bad = branches.find((b) => b.value.kind === "unresolved");
    if (bad) return at(bad.value, `<${bad.nav.component}>`, true);

    const key = (v: OptionValue): string => (v.kind === "absent" ? "absent" : String(v.kind === "boolean" && v.value));
    if (new Set(branches.map((b) => key(b.value))).size > 1) {
      return at(
        {
          kind: "unresolved",
          reason:
            "navigator branches disagree on headerShown (" +
            branches.map((b) => `${b.nav.component}=${key(b.value)}`).join(", ") +
            ")",
        },
        "conditional navigators",
        true
      );
    }

    const value = branches[0].value;
    if (value.kind === "absent") return at(value, "registered, but no headerShown anywhere", true);
    return at(
      value,
      owners.length === 1
        ? `its <${owners[0].component}.Screen> registration`
        : `all ${owners.length} navigator branches agree`,
      true
    );
  }

  // Not registered here at all, so it falls through to whatever the
  // header-bearing navigators' screenOptions say. This is terms-of-service and
  // AUDIT L59: the root Stack sets colours but never `headerShown`, and
  // native-stack's default is a VISIBLE header.
  const bearing = layout.navigators.filter((n) => n.headerBearing);
  if (bearing.length === 0) {
    return at({ kind: "boolean", value: false }, "no header-bearing navigator in this layout", false);
  }
  const values = bearing.map((n) => n.screenOptionsHeaderShown);
  const unres = values.find((v) => v.kind === "unresolved");
  if (unres) return at(unres, "navigator screenOptions", false);
  const booleans = values.filter((v): v is { kind: "boolean"; value: boolean } => v.kind === "boolean");
  if (new Set(booleans.map((b) => b.value)).size > 1) {
    return at(
      { kind: "unresolved", reason: "header-bearing navigators disagree on headerShown" },
      "navigator screenOptions",
      false
    );
  }
  if (booleans.length === 0) return at({ kind: "absent" }, "not registered at all", false);
  return at({ kind: "boolean", value: booleans[0].value }, "not registered, inherited from screenOptions", false);
}

const dirOf = (p: string): string => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
};

/**
 * The chain of navigator levels governing one route, deepest first.
 *
 * `(tabs)/index` resolves twice: as `index` inside `(tabs)/_layout.tsx`, and
 * then as `(tabs)` inside `_layout.tsx` — because React Navigation options do
 * not inherit across navigators. The parent Stack's header wraps the whole tab
 * navigator, so BOTH levels have to be hidden for the screen to show one
 * header. That is why `(tabs)/supervisor` painting its own title bar is correct
 * and not a violation.
 */
export function chainFor(route: string, layouts: Map<string, LayoutFacts>): ChainLevel[] {
  const levels: ChainLevel[] = [];
  let target = route;
  let searchDir = dirOf(route);

  for (;;) {
    let layoutDir: string | undefined;
    let dir = searchDir;
    for (;;) {
      const candidate = dir === "" ? "_layout.tsx" : `${dir}/_layout.tsx`;
      if (layouts.has(candidate)) {
        layoutDir = dir;
        break;
      }
      if (dir === "") break;
      dir = dirOf(dir);
    }
    if (layoutDir === undefined) break;

    const layoutPath = layoutDir === "" ? "_layout.tsx" : `${layoutDir}/_layout.tsx`;
    const prefix = layoutDir === "" ? "" : `${layoutDir}/`;
    const nameInLayout = target.startsWith(prefix) ? target.slice(prefix.length) : target;
    levels.push(resolveLevel(layouts.get(layoutPath)!, nameInLayout));

    if (layoutDir === "") break;
    // The group directory is itself a route in the layout above it.
    target = layoutDir;
    searchDir = dirOf(layoutDir);
  }
  return levels;
}

export type Violation = {
  route: string;
  rule: "screen-header-needs-native-header-hidden" | "native-header-must-not-render-screen-header";
  detail: string;
};

export type Audit = {
  /** Every route file expo-router would treat as a screen. */
  routes: string[];
  layouts: string[];
  /** Distinct navigator components found, for the classification guard. */
  navigatorComponents: string[];
  /** Routes rendering `<ScreenHeader>`. */
  screenHeaderRoutes: string[];
  /** Routes whose nearest navigator level shows the native header. */
  nativeHeaderRoutes: string[];
  /** Routes hidden at every level — the ones free to paint their own. */
  headerHiddenRoutes: string[];
  /** Routes with no `Screen` registration in their nearest layout. */
  unregisteredRoutes: string[];
  unresolved: { route: string; detail: string }[];
  violations: Violation[];
};

export function auditScreenHeaders(files: VirtualFiles): Audit {
  const layouts = new Map<string, LayoutFacts>();
  for (const [path, source] of Object.entries(files)) {
    if (path === "_layout.tsx" || path.endsWith("/_layout.tsx")) {
      layouts.set(path, parseLayout(path, source));
    }
  }

  const navigatorComponents = [
    ...new Set([...layouts.values()].flatMap((l) => l.navigators.map((n) => n.component))),
  ].sort();

  const routes = Object.keys(files).filter(isRouteFile).sort();
  const screenHeaderRoutes: string[] = [];
  const nativeHeaderRoutes: string[] = [];
  const headerHiddenRoutes: string[] = [];
  const unregisteredRoutes: string[] = [];
  const unresolved: { route: string; detail: string }[] = [];
  const violations: Violation[] = [];

  for (const file of routes) {
    const route = file.slice(0, -".tsx".length);
    const paints = rendersScreenHeader(files[file], file);
    if (paints) screenHeaderRoutes.push(route);

    const chain = chainFor(route, layouts);
    if (chain.length === 0) {
      unresolved.push({ route, detail: "no layout governs this route" });
      continue;
    }
    if (!chain[0].registered) unregisteredRoutes.push(route);

    const bad = chain.find((l) => l.value.kind === "unresolved");
    if (bad && bad.value.kind === "unresolved") {
      unresolved.push({ route, detail: `${bad.layout}: ${bad.value.reason}` });
      continue;
    }

    // "absent" means native-stack's default, which is a visible header.
    const shownLevels = chain.filter(
      (l) => l.value.kind === "absent" || (l.value.kind === "boolean" && l.value.value)
    );

    if (shownLevels.length === 0) headerHiddenRoutes.push(route);
    if (chain[0].value.kind === "absent" || (chain[0].value.kind === "boolean" && chain[0].value.value)) {
      nativeHeaderRoutes.push(route);
    }

    if (paints && shownLevels.length > 0) {
      const where = shownLevels
        .map((l) => `${l.layout} (as "${l.nameInLayout}", ${l.from})`)
        .join("; ");

      // WHICH HALF OF THE RULE BROKE, and they are deliberately disjoint.
      //
      // Both halves describe one condition — paints its own header AND the
      // native one is shown — so a second pass over `nativeHeaderRoutes` would
      // only re-report the same routes under a second name. What actually
      // differs is the REMEDY, and that is what the two names are for:
      //
      //   deliberate  someone wrote `headerShown: true` and then also painted a
      //               ScreenHeader. Two headers were asked for. Remove one.
      //   fall-through  nobody wrote anything; the screen inherited native
      //               -stack's default visible header. This is terms-of-service
      //               and AUDIT L59. Register it with `headerShown: false`.
      //
      // A route is reported once, under whichever of those it is.
      const deliberate = shownLevels.some((l) => l.value.kind === "boolean" && l.value.value);
      violations.push(
        deliberate
          ? {
              route,
              rule: "native-header-must-not-render-screen-header",
              detail:
                `is registered with headerShown: true by ${where} AND renders ` +
                `<ScreenHeader>: two headers. Remove one of them.`,
            }
          : {
              route,
              rule: "screen-header-needs-native-header-hidden",
              detail:
                `renders <ScreenHeader> but the native header is still shown by ${where}. ` +
                `Register it with options={{ headerShown: false }}.`,
            }
      );
    }
  }

  return {
    routes: routes.map((f) => f.slice(0, -".tsx".length)),
    layouts: [...layouts.keys()].sort(),
    navigatorComponents,
    screenHeaderRoutes: screenHeaderRoutes.sort(),
    nativeHeaderRoutes: nativeHeaderRoutes.sort(),
    headerHiddenRoutes: headerHiddenRoutes.sort(),
    unregisteredRoutes: unregisteredRoutes.sort(),
    unresolved,
    violations,
  };
}
