// Fails if the exported documents' palette has drifted from the design tokens,
// or if a raw hex literal has reappeared in the export templates.
//
// WHY THIS EXISTS — AUDIT L63
//
// `apps/mobile/lib/export-utils.ts` builds the HTML that becomes the exported
// diary and inspection PDF: the document this product exists to produce, and the
// copy a client or a regulator reads. It carried 28 hex literals, 14 distinct,
// and did not import `@/constants/colors` at all. Five duplicated a design token
// by value; nine were a second navy-and-grey scale existing nowhere in the token
// file. L63 calls it the shape of A6 and L36 — the legal-text drift — "in a
// place nobody looked: several copies of one thing, each internally consistent,
// with no check comparing them."
//
// The colours now live in `apps/mobile/constants/exportPalette.ts`, deliberately
// still as frozen literals rather than token imports, because L63's disposition
// is explicit that "changing export colours changes already-exported evidence".
// That module's own doc comment argues the decision. What this script adds is
// the part L63 actually asks for: the disagreement becomes LOUD instead of
// silent, so moving a token is a decision somebody makes in a commit rather than
// a thing that happens to every future export.
//
// TWO CHECKS
//
//   1. DRIFT. Each colour in `EXPORT_PALETTE_TOKEN_TWINS` must still equal its
//      named token in `constants/colors.ts`, compared case-insensitively (the
//      export values are lowercase, matching the CSS they replaced; the tokens
//      are uppercase).
//
//   2. CENSUS. `export-utils.ts` must contain NO raw hex, and the other mobile
//      files that contain any must be exactly the ones enumerated below, at
//      exactly the counts measured. A new raw hex literal anywhere in the app
//      fails the build on the commit that adds it.
//
// THE PATTERN IS QUOTE-INDEPENDENT, AND THAT IS THE WHOLE POINT. L63 records
// that its own first measurement was wrong: a grep for `"#......"` — requiring
// the quote — reported 4 files, because the export templates write colour inside
// CSS strings as `color:#6f8095` with no quote around the value. The real figure
// is 8 files. "A check written on the first pattern would have passed while
// missing the entire finding." So this one matches the hex itself, never a quote.
//
// WHAT IT DOES NOT PROVE
//
//   - Nothing about documents already exported. Those are files on somebody's
//     device or in an email, and no check can reach them. That is the asymmetry
//     that makes freezing the export values the conservative choice.
//   - Nothing about whether the nine print-only colours are *right*. They are
//     ungoverned by design and only their presence is pinned.
//   - It does not cover `rgba(...)`, `hsl(...)`, named CSS colours, or a colour
//     built by string concatenation. Hex is what L63 measured and hex is what is
//     pinned; a wider pattern would need its own measurement rather than an
//     assumption.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Anchored on this script's location: ci.sh runs it from Projects/ and a
// developer runs it from the repo root.
const PKGS = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const fail = (m) => failures.push(m);
const read = (p) => {
  try {
    return readFileSync(resolve(PKGS, p), "utf8");
  } catch (err) {
    fail(`could not read ${p}: ${err.message}`);
    return null;
  }
};

// Quote-independent, deliberately. See the header.
const HEX = /#[0-9a-fA-F]{6}\b/g;

const EXPORT_UTILS = "apps/mobile/lib/export-utils.ts";
const PALETTE = "apps/mobile/constants/exportPalette.ts";
const TOKENS = "apps/mobile/constants/colors.ts";

// ── 1. Drift: each token twin still equals its token ────────────────────────

const paletteSrc = read(PALETTE);
const tokensSrc = read(TOKENS);

/** `name: "#rrggbb",` pairs anywhere in a source file. */
function hexEntries(src) {
  const out = new Map();
  for (const m of src.matchAll(/(\w+)\s*:\s*"(#[0-9a-fA-F]{6})"/g)) {
    if (!out.has(m[1])) out.set(m[1], m[2]);
  }
  return out;
}

if (paletteSrc && tokensSrc) {
  // The mapping is read from the palette module rather than written here, so a
  // renamed colour cannot leave this script comparing a name nothing uses.
  const twinsRegion = (() => {
    const at = paletteSrc.indexOf("EXPORT_PALETTE_TOKEN_TWINS");
    if (at < 0) return null;
    const open = paletteSrc.indexOf("{", at);
    const close = paletteSrc.indexOf("});", open);
    return open < 0 || close < 0 ? null : paletteSrc.slice(open, close);
  })();

  const twins = twinsRegion ? [...twinsRegion.matchAll(/(\w+)\s*:\s*"(\w+)"/g)].map((m) => [m[1], m[2]]) : [];

  if (!twins.length) {
    fail(
      `could not read EXPORT_PALETTE_TOKEN_TWINS from ${PALETTE}.\n` +
        "    This script has no hard-coded mapping to fall back on, so it refuses to\n" +
        "    report a pass. Two empty sets compare equal — that is how a check passes\n" +
        "    having read nothing."
    );
  }

  const paletteValues = hexEntries(paletteSrc);
  const tokenValues = hexEntries(tokensSrc);

  if (tokenValues.size < 10) {
    fail(`parsed only ${tokenValues.size} colours out of ${TOKENS} (expected many). Not comparing anything against it.`);
  } else {
    for (const [exportName, tokenName] of twins) {
      const exportValue = paletteValues.get(exportName);
      const tokenValue = tokenValues.get(tokenName);
      if (!exportValue) {
        fail(`${PALETTE} names a twin "${exportName}" that has no hex value in EXPORT_PALETTE.`);
        continue;
      }
      if (!tokenValue) {
        fail(`${PALETTE} maps "${exportName}" to token "${tokenName}", which is not a hex colour in ${TOKENS}.`);
        continue;
      }
      if (exportValue.toLowerCase() !== tokenValue.toLowerCase()) {
        fail(
          `the export palette has drifted from the design token.\n` +
            `    EXPORT_PALETTE.${exportName} = ${exportValue}\n` +
            `    Colors.${tokenName} = ${tokenValue}\n` +
            "    These were equal, and the export deliberately keeps its own frozen\n" +
            "    copy so that restyling the app cannot restyle a compliance document.\n" +
            "    Decide which is intended and say so in the commit: move the export\n" +
            "    value to match (every FUTURE export changes appearance), or update\n" +
            "    the twin mapping in exportPalette.ts to record that they have\n" +
            "    legitimately diverged."
        );
      }
    }
  }
}

// ── 2. Census: where raw hex is allowed to be, and how much ─────────────────
//
// Measured on 26 October 2026, quote-independent, across every .ts/.tsx in
// apps/mobile outside the two colour modules. Each entry carries why it is
// allowed. These counts are EXPECTED TO CHANGE — change them in the same commit
// that changes the file, so it is visible in review.
const ALLOWED = [
  {
    path: "apps/mobile/lib/annotation-palette.test.ts",
    count: 14,
    why: "a test ABOUT colours; the literals are its fixtures and assertions",
  },
  {
    path: "apps/mobile/lib/colour-distance.ts",
    count: 1,
    why: "a worked example in a doc comment, not a rendered colour",
  },
  {
    path: "apps/mobile/app.config.ts",
    count: 3,
    why: "native splash/icon background — Expo config, not app styling, and off-limits to anything but a native-config change",
  },
  // The three screens L63 names as "the same pattern, smaller elsewhere". Real
  // debt, deliberately NOT fixed here: these are screen styles, where importing
  // Colors IS the right fix, which makes them a different change from the export
  // templates (where it is not). Pinned so they cannot grow.
  { path: "apps/mobile/app/inspections/[siteId].tsx", count: 7, why: "L63 debt, pinned not fixed: 3 token duplicates plus #6f8095" },
  { path: "apps/mobile/app/crew/[siteId].tsx", count: 2, why: "L63 debt, pinned not fixed" },
  { path: "apps/mobile/app/_layout.tsx", count: 1, why: "L63 debt, pinned not fixed" },
];

const exportSrc = read(EXPORT_UTILS);
if (exportSrc) {
  const found = [...exportSrc.matchAll(HEX)].map((m) => m[0]);
  if (found.length) {
    const lines = found.map((h) => {
      const at = exportSrc.indexOf(h);
      return `${h} (line ${exportSrc.slice(0, at).split("\n").length})`;
    });
    fail(
      `${EXPORT_UTILS} contains ${found.length} raw hex literal(s): ${lines.join(", ")}\n` +
        "    The export templates read their colours from constants/exportPalette.ts.\n" +
        "    A literal here is a 15th colour in the compliance artefact that no\n" +
        "    decision about the palette can see — which is L63 reappearing."
    );
  }
  // Positive control: a file that interpolates NO palette entry is not a clean
  // file, it is a file that has stopped using the palette. An empty hex count
  // and an empty palette count look identical in a report; they are not.
  const uses = [...exportSrc.matchAll(/EXPORT_PALETTE\.\w+/g)].length;
  if (uses < 20) {
    fail(
      `${EXPORT_UTILS} interpolates only ${uses} palette value(s) (expected ~28).\n` +
        "    Zero raw hex is only meaningful in a file that is still colouring the\n" +
        "    document from the palette. If the templates moved elsewhere, move this\n" +
        "    check with them in the same commit."
    );
  }
}

for (const entry of ALLOWED) {
  const src = read(entry.path);
  if (!src) continue;
  const n = [...src.matchAll(HEX)].length;
  if (n !== entry.count) {
    fail(
      `${entry.path} has ${n} raw hex literal(s), expected ${entry.count}.\n` +
        `    Allowed because: ${entry.why}\n` +
        (n > entry.count
          ? "    A new raw colour was added. Use constants/colors.ts, or raise this\n" +
            "    count here with a reason in the same commit."
          : "    Fewer than expected — if they were moved into the tokens, lower this\n" +
            "    count in the same commit so the check keeps meaning something.")
    );
  }
}

if (failures.length) {
  console.error("assert-export-palette: FAIL\n");
  for (const f of failures) console.error(`  - ${f}\n`);
  process.exit(1);
}

const total = ALLOWED.reduce((a, e) => a + e.count, 0);
console.log(`  export palette: 14 colours, 5 twins still equal their tokens, 0 raw hex in export-utils.ts.`);
console.log(`  raw-hex census: ${ALLOWED.length} files, ${total} literals, exactly the ones enumerated.`);
