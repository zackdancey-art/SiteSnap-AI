// Fails if more than one version of `@types/react` is installed anywhere in the
// workspace.
//
// WHY THIS EXISTS
//
// The workspace used to carry two majors on purpose: apps/mobile on
// @types/react 19.1.17 (React 19.1.0 + react-native 0.81.5) and
// apps/supervisor-web on 18.3.31 (React 18.3 + Next 14). That is a legitimate
// pair of app requirements, and the lockfile described it correctly. It still
// broke the mobile typecheck -- on CI only, and only sometimes.
//
// The mechanism, which is worth writing down because nothing about it is
// visible in the lockfile:
//
//   `react-native-safe-area-context` declares exactly two peers, `react` and
//   `react-native`. It does NOT declare `@types/react`, so pnpm puts no
//   @types/react symlink in that package's own directory in the virtual store
//   -- the association with 19.1.17 that `pnpm why` prints is inherited through
//   react-native's peer suffix, which is a key in the lockfile and not a
//   directory on disk. TypeScript does not read the lockfile. When it compiles
//   that package's .d.ts and resolves `import { ReactNode } from "react"`, it
//   does a plain filesystem walk, finds no @types/react alongside the package,
//   and falls through to the one shared slot above it:
//   node_modules/.pnpm/node_modules/@types/react -- pnpm's hidden hoist.
//
//   That slot holds ONE version. Which of the two eligible versions lands in it
//   is an install-time hoisting decision that the lockfile does not pin. On
//   macOS/pnpm 10.30.3 it resolved to 19.1.17 and everything passed; on the CI
//   runner it resolved to 18.3.31 and apps/mobile failed with
//
//     lib/useScreenInsets.tsx(181,45): error TS2322: Type 'React.ReactNode' is
//     not assignable to type '...@types+react@18.3.31...'.ReactNode'.
//       Type 'bigint' is not assignable to type 'ReactNode'.
//
//   (`bigint` entered ReactNode in React 19's types, so a 19-typed child being
//   passed to an 18-typed `children` prop is how the duplicate announces
//   itself. Line 181 is `<SafeAreaProvider>{children}</SafeAreaProvider>`.)
//
// So the bug was never in useScreenInsets.tsx, and fixing it there would have
// pinned a coin-flip rather than removed it. The fix is the `@types/react`
// override in package.json, which leaves exactly one version in the store --
// one eligible candidate for that slot, so the outcome is determined by
// construction instead of by the hoisting order on a given machine.
//
// This file is what makes the override's failure mode noisy. Re-introducing a
// second major -- a dependency upgrade, a new app, or someone "restoring"
// supervisor-web's own 18.x pin -- puts the coin back in the air, and the next
// symptom would again be a typecheck that passes locally and fails on CI. That
// is the shape of bug this repo keeps producing, so it gets a cheap CI step.
//
// It asserts the INSTALLED TREE, not the manifest: the override is the means,
// one version on disk is the invariant.

import { readdirSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const STORE = resolve("node_modules/.pnpm");
const failures = [];
const fail = (m) => failures.push(m);

// Every place a copy can be found, so that a second version cannot hide in a
// corner this check does not look at.
const found = []; // { where, version }

const versionAt = (dir) => {
  try {
    return JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")).version;
  } catch {
    return null;
  }
};

if (!existsSync(STORE)) {
  fail(
    `node_modules/.pnpm does not exist. Run \`pnpm install\` first -- this\n` +
      `  check inspects the installed tree, and has nothing to inspect.`
  );
} else {
  // 1. Every physical copy in the virtual store.
  for (const entry of readdirSync(STORE)) {
    if (!/^@types\+react@/.test(entry)) continue;
    const dir = resolve(STORE, entry, "node_modules/@types/react");
    const v = versionAt(dir);
    if (v) found.push({ where: `.pnpm/${entry}`, version: v });
    else fail(`${entry} is in the virtual store but has no readable package.json`);
  }

  // 2. pnpm's hidden hoist -- the single shared slot that caused the original
  //    failure. Resolved through realpath so the version is the real one.
  const hoist = resolve(STORE, "node_modules/@types/react");
  if (existsSync(hoist)) {
    const v = versionAt(hoist);
    if (v) found.push({ where: ".pnpm/node_modules/@types/react (hidden hoist)", version: v });
    else fail("the hidden hoist slot exists but has no readable package.json");
  }

  // 3. Each workspace package's own direct link.
  const roots = ["shared", ...["apps", "services"].flatMap((group) =>
    existsSync(resolve(group))
      ? readdirSync(resolve(group), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => `${group}/${d.name}`)
      : []
  )];
  for (const pkg of roots) {
    const dir = resolve(pkg, "node_modules/@types/react");
    if (!existsSync(dir)) continue;
    const v = versionAt(dir);
    if (v) found.push({ where: `${pkg}/node_modules/@types/react`, version: v });
    else fail(`${pkg} links @types/react but its package.json is unreadable`);
  }
}

// The enumeration itself must not pass vacuously. Zero copies means the layout
// changed under this check and it is no longer looking where the copies live --
// which would read as a clean pass forever after.
if (!failures.length && found.length === 0) {
  fail(
    `found no @types/react anywhere in the installed tree.\n` +
      `  Both React packages depend on it, so zero copies means this check is\n` +
      `  looking in the wrong place (a node-linker or layout change?) rather\n` +
      `  than that the tree is clean. Refusing to pass on an empty enumeration.`
  );
}

const versions = [...new Set(found.map((f) => f.version))].sort();

if (versions.length > 1) {
  fail(
    `found ${versions.length} versions of @types/react in the installed tree: ` +
      `${versions.join(", ")}.\n` +
      found.map((f) => `    ${f.version.padEnd(10)} ${f.where}`).join("\n") +
      `\n\n` +
      `  Two versions means pnpm's hidden hoist slot\n` +
      `  (node_modules/.pnpm/node_modules/@types/react) has more than one\n` +
      `  eligible candidate, and which one wins is decided per install rather\n` +
      `  than by the lockfile. Any package whose own peers omit @types/react --\n` +
      `  react-native-safe-area-context is the one that bit us -- resolves React's\n` +
      `  types through that slot, so the mobile typecheck passes or fails\n` +
      `  depending on the machine it ran on.\n\n` +
      `  Fix it in the tree, not at the call site: the "@types/react" entry in\n` +
      `  pnpm.overrides (Projects/package.json) is what collapses this to one\n` +
      `  version. Do NOT paper over the resulting TS2322 with a cast, an \`any\`\n` +
      `  or skipLibCheck -- the duplicate is real and resurfaces elsewhere.`
  );
}

if (failures.length) {
  for (const f of failures) console.error(`assert-single-react-types: ${f}`);
  process.exit(1);
}

console.log(
  `assert-single-react-types: @types/react@${versions[0]} only, ` +
    `across ${found.length} location${found.length === 1 ? "" : "s"} checked ` +
    `(virtual store, hidden hoist, per-package links)`
);
