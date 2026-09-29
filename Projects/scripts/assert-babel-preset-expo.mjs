// Fails if apps/mobile's `babel-preset-expo` pin drifts from what the installed
// `expo` actually asks for, or if the preset stops being resolvable from the app
// directory.
//
// WHY THIS EXISTS
//
// babel.config.js names `babel-preset-expo`, and Babel resolves a bare preset
// name by require()-ing it relative to the config file's own directory --
// apps/mobile. Under pnpm's default isolated node-linker, apps/mobile/node_modules
// holds symlinks for that package's DIRECT dependencies only, so a package that
// arrives transitively (babel-preset-expo comes in through `expo`) sits in the
// .pnpm store, reachable through the dependency graph but NOT by a bare Node
// resolution walk from apps/mobile. `eas build` never noticed, because it bundles
// on Expo's servers; `eas update` bundles LOCALLY and failed with
// `Cannot find module 'babel-preset-expo'`. See AUDIT L19 -- this was its third
// instance.
//
// The fix was to declare babel-preset-expo directly in apps/mobile, pinned to the
// range `expo` itself declares. That fix has one weakness, and this file is the
// answer to it: the pin is now maintained BY HAND. If an SDK upgrade moves expo's
// own constraint and nobody updates ours, two copies of the preset land in the
// graph -- and the one we declared wins the bare resolution from apps/mobile. The
// app would then transform with the wrong preset and NOT error. That is the
// failure mode worth spending a CI step on: not loud breakage, silent divergence.
//
// WHY THERE IS NO `semver` IMPORT
//
// `semver` is not resolvable from the workspace root either -- same isolated
// linker, same reason. Adding it as a dependency purely to run this check would be
// a fourth instance of the problem the check exists to police. The range shapes
// actually used here are `~x.y.z`, `^x.y.z` and exact, so those three are
// implemented below; anything else fails loudly asking to be taught, rather than
// being guessed at and passing.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const PKG = "babel-preset-expo";
const APP_DIR = resolve("apps/mobile");
const appRequire = createRequire(resolve(APP_DIR, "noop.js"));

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// --- 1. what apps/mobile declares -------------------------------------------
const appPkg = readJson(resolve(APP_DIR, "package.json"));
const declared =
  appPkg.devDependencies?.[PKG] ?? appPkg.dependencies?.[PKG] ?? null;

if (declared === null) {
  fail(
    `apps/mobile/package.json does not declare ${PKG}.\n` +
      `  babel.config.js names it as a preset, so Babel resolves it from\n` +
      `  apps/mobile -- where pnpm's isolated linker will not put a transitive\n` +
      `  package. Declaring it directly is what makes it resolvable.`
  );
  process.exit(1);
}

// --- 2. what the installed expo asks for ------------------------------------
let expoPkg;
try {
  expoPkg = readJson(appRequire.resolve("expo/package.json"));
} catch {
  fail("cannot resolve `expo` from apps/mobile -- run `pnpm install`.");
  process.exit(1);
}
const expected = expoPkg.dependencies?.[PKG];
if (!expected) {
  fail(
    `expo@${expoPkg.version} no longer declares ${PKG} as a dependency.\n` +
      `  The SDK has changed shape; re-derive where the preset should come from\n` +
      `  and update this check rather than deleting it.`
  );
  process.exit(1);
}

// --- 3. the ranges must agree exactly ---------------------------------------
if (declared !== expected) {
  fail(
    `${PKG} pin has drifted from the SDK.\n` +
      `    apps/mobile/package.json : ${declared}\n` +
      `    expo@${expoPkg.version} wants   : ${expected}\n` +
      `  Set apps/mobile to "${expected}" and re-run \`pnpm install\`.\n` +
      `  Left alone this does not break the build -- it puts two copies of the\n` +
      `  preset in the graph and lets ours win, so the app transforms with the\n` +
      `  wrong preset silently. See AUDIT L19.`
  );
}

// --- 4. it must be resolvable the way Babel resolves it ---------------------
let installed = null;
try {
  installed = readJson(appRequire.resolve(`${PKG}/package.json`)).version;
} catch {
  fail(
    `${PKG} is declared but not resolvable from apps/mobile.\n` +
      `  This is the exact resolution Babel performs for babel.config.js.\n` +
      `  Run \`pnpm install\`; if it is still unresolvable, the install layout\n` +
      `  has changed and AUDIT L19 needs revisiting.`
  );
}

// --- 5. the installed version must satisfy expo's range ---------------------
// Only the comparator shapes this repo uses. An unrecognised shape is a hard
// failure, never a pass: a range this cannot parse is a range it cannot vouch for.
const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

if (installed !== null) {
  const op = /^[~^]/.test(expected) ? expected[0] : "=";
  const base = parse(expected.replace(/^[~^]/, ""));
  const got = parse(installed);

  if (base === null || got === null) {
    fail(
      `cannot compare ${PKG} versions: expo wants "${expected}", installed ` +
        `"${installed}".\n` +
        `  This check understands ~x.y.z, ^x.y.z and exact x.y.z only.\n` +
        `  Teach it the new shape -- do not relax it.`
    );
  } else {
    const upper =
      op === "~" ? [base[0], base[1] + 1, 0]
      : op === "^" ? [base[0] + 1, 0, 0]
      : base;
    const ok =
      op === "=" ? cmp(got, base) === 0
      : cmp(got, base) >= 0 && cmp(got, upper) < 0;
    if (!ok) {
      fail(
        `installed ${PKG}@${installed} does not satisfy expo's ${expected}.\n` +
          `  Run \`pnpm install\`; if the lockfile is pinning an out-of-range\n` +
          `  version, that is the bug.`
      );
    }
  }
}

if (process.exitCode) process.exit(1);
console.log(
  `assert-babel-preset-expo: ${PKG}@${installed} resolvable from apps/mobile, ` +
    `pin ${declared} matches expo@${expoPkg.version}`
);
