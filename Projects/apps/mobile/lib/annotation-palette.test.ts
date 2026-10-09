import { test } from "node:test";
import assert from "node:assert/strict";
import Colors from "@/constants/colors";
import {
  DEFAULT_ANNOTATION_COLOUR,
  PALETTE,
  type AnnotationColour,
} from "@/lib/annotation-palette";
import { contrastRatio, deltaE76, deltaE76Axes } from "@/lib/colour-distance";

/**
 * The annotation palette has to stay legible on a photograph.
 *
 * THE REFERENCE BACKGROUNDS
 *
 * An annotation is drawn over whatever the camera saw, so there is no single
 * background to measure against. These three span the lightness range a site
 * photograph actually covers: deep shade under a slab, mid-grey concrete, and
 * a bright sky. They are the only raw hex values in this work, and they are
 * deliberately NOT Colors tokens: they model photographic content, not app
 * chrome, and inventing `Colors.concrete` would add a product token that
 * nothing renders.
 *
 * Three samples prove separation from these three, not from every photograph.
 * High-vis orange and wet mud are not here. That is a real limit on what this
 * test is evidence of, and it is the reason the floor is set with headroom
 * rather than at the measured minimum.
 *
 * THE FLOOR: ΔE76 >= 40, and why that number
 *
 * Measured worst case across the three backgrounds, with the full matrix
 * printed by the tests below:
 *
 *   warning  (amber) 79.3      accent        75.5
 *   error    (red)   76.1      accentLight   64.7
 *   success  (green) 74.0      info          29.7   <- excluded
 *   infoText (blue)  52.3      primary       20.1   <- excluded
 *
 * 40 sits in the empty band between 29.7 and 52.3. It has to admit all four
 * current members and it has to exclude `primary` and `info`, which are the
 * two tokens someone would plausibly reach for next — both near-navy, both
 * invisible in shade, and `info` is invisible against sky as well. A floor at
 * 50 would admit the same four and exclude the same two, but would leave blue
 * 2.3 from the edge; a floor at 30 would let `info` in.
 *
 * Blue has the least headroom: 52.3 against a floor of 40, 31% above it. The
 * PR body states this, because the margin is not evenly spread — 82.9% of
 * blue's worst-case ΔE² is the b* (blue-yellow) axis alone, with only 2.4%
 * from lightness. Blue is told apart from deep shade almost entirely by being
 * blue, not by being brighter. Any future change that desaturates it, as
 * opposed to darkening it, eats that margin fast.
 *
 * THE PAIRWISE FLOOR: ΔE76 >= 45, and why that number
 *
 * The palette's own entries have to be distinguishable from each other, not
 * just from the background: on an exported diary read months later, "red" and
 * "amber" mean different things. Measured pairwise distances among the four:
 *
 *   error <-> warning     57.4   <- the tightest current pair
 *   warning <-> success   92.1
 *   error <-> infoText   101.5
 *   success <-> accent*  ...     (every other pair is above 92)
 *
 * and the pairs this threshold has to reject:
 *
 *   accent <-> accentLight   15.7
 *   warning <-> accentLight  19.2
 *   warning <-> accent       23.4
 *   infoText <-> info        31.2
 *   error <-> accent         34.9
 *   error <-> accentLight    42.3
 *
 * 45 sits in the band between 42.3 and 57.4. It is set against the measured
 * matrix rather than picked from a standard: red-vs-amber at 57.4 is the real
 * floor the product already lives with, so the threshold is below it with 28%
 * headroom, and above every pair that would actually be a mistake. The amber
 * family is what this guards: three of the six rejected pairs are an amber
 * beside another amber.
 *
 * WHY NOT A CONTRAST RATIO
 *
 * See the header of lib/colour-distance.ts. Amber scores 1.08 and navy 1.06
 * against these backgrounds — a contrast-ratio floor would have excluded amber
 * and kept navy. The tests print both numbers so that claim is checkable.
 */
const REFERENCE_BACKGROUNDS: readonly { label: string; hex: string }[] = [
  { label: "shadow", hex: "#2E2E2E" },
  { label: "concrete", hex: "#9A9A9A" },
  { label: "sky", hex: "#87BEE8" },
];

const VISIBILITY_FLOOR = 40;
const CONFUSABILITY_FLOOR = 45;

/** The populations. A test that enumerates can pass by enumerating nothing. */
const EXPECTED_PALETTE_SIZE = 4;
const EXPECTED_BACKGROUNDS = 3;
const EXPECTED_VISIBILITY_MEASUREMENTS = EXPECTED_PALETTE_SIZE * EXPECTED_BACKGROUNDS; // 12
const EXPECTED_PAIRS = (EXPECTED_PALETTE_SIZE * (EXPECTED_PALETTE_SIZE - 1)) / 2; // 6

type Check = { measurements: number; failures: string[] };

/** Worst-case ΔE for each colour against every reference background. */
function visibilityCheck(palette: readonly AnnotationColour[], floor: number): Check {
  let measurements = 0;
  const failures: string[] = [];
  for (const entry of palette) {
    let worst = Infinity;
    let worstOn = "";
    for (const bg of REFERENCE_BACKGROUNDS) {
      const d = deltaE76(entry.color, bg.hex);
      measurements += 1;
      if (d < worst) {
        worst = d;
        worstOn = bg.label;
      }
    }
    if (!(worst >= floor)) {
      failures.push(
        `${entry.label} (${entry.color}) is ΔE ${worst.toFixed(1)} from ${worstOn}, ` +
          `below the floor of ${floor}`
      );
    }
  }
  return { measurements, failures };
}

/** Every unordered pair within the palette. */
function confusabilityCheck(palette: readonly AnnotationColour[], floor: number): Check {
  let measurements = 0;
  const failures: string[] = [];
  for (let i = 0; i < palette.length; i += 1) {
    for (let j = i + 1; j < palette.length; j += 1) {
      const d = deltaE76(palette[i].color, palette[j].color);
      measurements += 1;
      if (!(d >= floor)) {
        failures.push(
          `${palette[i].label} (${palette[i].color}) and ${palette[j].label} ` +
            `(${palette[j].color}) are only ΔE ${d.toFixed(1)} apart, below the floor of ${floor}`
        );
      }
    }
  }
  return { measurements, failures };
}

test("PALETTE is the four Colors tokens this invariant was measured against", () => {
  assert.equal(
    PALETTE.length,
    EXPECTED_PALETTE_SIZE,
    `the palette has ${PALETTE.length} entries, expected ${EXPECTED_PALETTE_SIZE}. ` +
      `Every threshold below was calibrated against a specific four; adding or ` +
      `removing one means re-reading the measured matrix in this file's header, ` +
      `not just raising this number.`
  );
  // Named tokens, not hex. A raw hex substituted for a token would still pass
  // the ΔE assertions if it happened to be legible, and the palette would
  // quietly stop being made of the design system.
  assert.deepEqual(
    PALETTE.map((p) => [p.label, p.color]),
    [
      ["Red", Colors.error],
      ["Amber", Colors.warning],
      ["Green", Colors.success],
      ["Blue", Colors.infoText],
    ]
  );
  assert.equal(REFERENCE_BACKGROUNDS.length, EXPECTED_BACKGROUNDS);
});

test("every palette colour clears the visibility floor on every background", () => {
  // The measured matrix, so the numbers quoted in this file's header and in the
  // PR body are output rather than assertion.
  for (const entry of PALETTE) {
    const cells = REFERENCE_BACKGROUNDS.map((bg) => {
      const d = deltaE76(entry.color, bg.hex);
      const cr = contrastRatio(entry.color, bg.hex);
      return `${bg.label} ΔE ${d.toFixed(1)} / CR ${cr.toFixed(2)}`;
    });
    console.log(`  ${entry.label.padEnd(6)} ${entry.color}  ${cells.join("  |  ")}`);
  }

  const { measurements, failures } = visibilityCheck(PALETTE, VISIBILITY_FLOOR);
  // Failures first, then the count. Reversed, a real floor violation would be
  // reported as an arity mismatch — the count guard is here to catch a palette
  // that measured NOTHING, not to pre-empt the substantive assertion.
  assert.deepEqual(failures, [], failures.join("\n"));
  assert.equal(
    measurements,
    EXPECTED_VISIBILITY_MEASUREMENTS,
    `took ${measurements} measurements, expected ${EXPECTED_VISIBILITY_MEASUREMENTS}. ` +
      `Zero would mean this test proved nothing.`
  );
});

test("no two palette colours are confusable with each other", () => {
  const rows: string[] = [];
  for (let i = 0; i < PALETTE.length; i += 1) {
    for (let j = i + 1; j < PALETTE.length; j += 1) {
      rows.push(
        `  ${PALETTE[i].label} <-> ${PALETTE[j].label}: ΔE ` +
          deltaE76(PALETTE[i].color, PALETTE[j].color).toFixed(1)
      );
    }
  }
  console.log(rows.join("\n"));

  const { measurements, failures } = confusabilityCheck(PALETTE, CONFUSABILITY_FLOOR);
  assert.deepEqual(failures, [], failures.join("\n"));
  assert.equal(
    measurements,
    EXPECTED_PAIRS,
    `compared ${measurements} pairs, expected ${EXPECTED_PAIRS}. Zero would mean ` +
      `this test proved nothing.`
  );
});

test("the default annotation colour is a member of the palette", () => {
  // The selected swatch is drawn by comparing the current colour against this
  // value, so a default outside the list opens the annotator with nothing
  // selected and no way to tell what a stroke will be.
  assert.ok(
    PALETTE.some((p) => p.color === DEFAULT_ANNOTATION_COLOUR),
    `the default ${DEFAULT_ANNOTATION_COLOUR} is not one of ` +
      PALETTE.map((p) => p.color).join(", ")
  );
});

test("positive control: Colors.primary in the palette fails the visibility floor", () => {
  const withNavy = [...PALETTE, { label: "Navy", color: Colors.primary }];
  const { measurements, failures } = visibilityCheck(withNavy, VISIBILITY_FLOOR);
  assert.equal(measurements, EXPECTED_VISIBILITY_MEASUREMENTS + EXPECTED_BACKGROUNDS);
  assert.equal(failures.length, 1, JSON.stringify(failures));
  assert.match(failures[0], /^Navy/);
  assert.match(failures[0], /shadow/);
  console.log(`  ${failures[0]}`);

  // And the contrast ratio does NOT catch it, which is the point of using ΔE:
  // navy scores 1.06 against shadow and amber scores 1.08 against concrete, so
  // any contrast floor that rejected navy would also have rejected amber.
  const navyCr = Math.min(...REFERENCE_BACKGROUNDS.map((b) => contrastRatio(Colors.primary, b.hex)));
  const amberCr = Math.min(...REFERENCE_BACKGROUNDS.map((b) => contrastRatio(Colors.warning, b.hex)));
  assert.ok(
    navyCr < amberCr + 0.05 && amberCr < 1.2,
    `navy CR ${navyCr.toFixed(2)} vs amber CR ${amberCr.toFixed(2)} — if these have ` +
      `separated, a contrast-ratio floor may now be viable and this file's ` +
      `justification for ΔE needs re-reading`
  );
  console.log(`  navy worst CR ${navyCr.toFixed(2)}, amber worst CR ${amberCr.toFixed(2)}`);
});

test("positive control: Colors.accent beside amber fails the pairwise floor", () => {
  const withAccent = [...PALETTE, { label: "Orange", color: Colors.accent }];
  const { measurements, failures } = confusabilityCheck(withAccent, CONFUSABILITY_FLOOR);
  assert.equal(measurements, 10, "five colours is ten pairs");
  // Orange is legible on its own — it clears the visibility floor at 75.5 — so
  // only the pairwise check can reject it. That is why both halves exist.
  assert.deepEqual(visibilityCheck([{ label: "Orange", color: Colors.accent }], VISIBILITY_FLOOR).failures, []);
  assert.equal(failures.length, 2, JSON.stringify(failures));
  assert.ok(
    failures.some((f) => /Amber.*Orange/.test(f)),
    `expected an Amber/Orange collision, got:\n${failures.join("\n")}`
  );
  console.log(failures.map((f) => `  ${f}`).join("\n"));
});

test("the thresholds discriminate — they are calibrated, not decorative", () => {
  // A floor is only evidence if some plausible candidate fails it. If every
  // token in the design system cleared both, the numbers would be ornamental.
  const candidates = ["error", "warning", "success", "infoText", "primary", "accent", "accentLight", "info"] as const;
  const admitted: string[] = [];
  const excluded: string[] = [];
  for (const token of candidates) {
    const { failures } = visibilityCheck([{ label: token, color: Colors[token] }], VISIBILITY_FLOOR);
    (failures.length === 0 ? admitted : excluded).push(token);
  }
  console.log(`  admitted by the floor: ${admitted.join(", ")}`);
  console.log(`  excluded by the floor: ${excluded.join(", ")}`);

  assert.deepEqual(excluded, ["primary", "info"], "the floor no longer excludes the two near-navy tokens");
  for (const member of PALETTE) {
    assert.ok(
      admitted.includes(candidates.find((c) => Colors[c] === member.color) ?? "?"),
      `${member.label} is in the palette but not admitted by its own floor`
    );
  }

  // Headroom, stated rather than implied. Blue is the tight one.
  const blueWorst = Math.min(...REFERENCE_BACKGROUNDS.map((b) => deltaE76(Colors.infoText, b.hex)));
  assert.ok(blueWorst >= VISIBILITY_FLOOR, `blue is ΔE ${blueWorst.toFixed(1)}, below the floor`);
  const axes = deltaE76Axes(Colors.infoText, "#2E2E2E");
  const total = axes.dL ** 2 + axes.da ** 2 + axes.db ** 2;
  console.log(
    `  blue worst ΔE ${blueWorst.toFixed(1)} vs floor ${VISIBILITY_FLOOR} ` +
      `(+${(100 * (blueWorst / VISIBILITY_FLOOR - 1)).toFixed(0)}%); ` +
      `b* carries ${((100 * axes.db ** 2) / total).toFixed(1)}% of it, L* only ` +
      `${((100 * axes.dL ** 2) / total).toFixed(1)}%`
  );
  assert.ok(
    (axes.db ** 2) / total > 0.5,
    "blue's margin is no longer carried by the b* axis; the header's warning about " +
      "desaturation needs rewriting"
  );
});

test("the colour maths agrees with values that can be checked by hand", () => {
  // If this module silently returned inflated distances, navy would clear the
  // floor and the positive control above would stop failing — so these are the
  // backstop under both thresholds.
  assert.equal(deltaE76("#FFFFFF", "#FFFFFF"), 0);
  assert.equal(Math.round(contrastRatio("#000000", "#FFFFFF")), 21);
  assert.equal(Math.round(contrastRatio("#777777", "#777777")), 1);
  // Lab of pure white is L*100, a*0, b*0.
  const white = deltaE76Axes("#FFFFFF", "#000000");
  assert.equal(Math.round(white.dL), 100);
  assert.ok(Math.abs(white.da) < 0.01 && Math.abs(white.db) < 0.01);
  // A typo must throw, not resolve to black and quietly pass the floor.
  assert.throws(() => deltaE76("#GGGGGG", "#000000"), /not a six-digit hex/);
  assert.throws(() => deltaE76("blue", "#000000"), /not a six-digit hex/);
});
