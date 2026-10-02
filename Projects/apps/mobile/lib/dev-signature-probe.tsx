/**
 * Dev-only layout probe for the Add Signature sheet. NOT part of the product.
 *
 * Why this exists
 * ---------------
 * The signature sheet was diagnosed, fixed, reviewed, merged and shipped three
 * times and stayed broken on device. The reason is not carelessness: nothing in
 * this repo can see the screen. `react-test-renderer` has no layout engine, so
 * a unit test builds a JS element tree with no Yoga behind it, `onLayout` never
 * fires, and every geometric property of the defect — a box with zero height, a
 * canvas painted outside its parent, two views overlapping — is simply not
 * representable. A jest test would have passed on the broken sheet.
 *
 * So this measures the real thing on a real simulator: it reads frames back out
 * of the live view tree with `measureInWindow` and asserts on the numbers.
 *
 * HOW THIS FILE STAYS OUT OF PRODUCTION BUNDLES — read before editing
 * -------------------------------------------------------------------
 * Every call site reaches this module through `require()` placed INSIDE an
 * `if (__DEV__)` block. That is load-bearing and it is not interchangeable with
 * a top-level `import`. Measured, not assumed, by exporting a production bundle
 * and grepping the Hermes string table:
 *
 *   top-level `import`, call site gated by __DEV__ -> module strings PRESENT
 *   `require()` inside `if (__DEV__)`              -> module strings ABSENT
 *
 * Metro does not tree-shake; it bundles every statically imported module whether
 * or not anything reachable calls it. Only the gated `require` keeps the
 * dependency out of the graph. If someone "tidies" these requires into imports,
 * this entire file ships to customers. See docs/SIGNATURE-SHEET-HARNESS.md.
 *
 * It also must not alter what it measures. It adds no wrapping views and
 * changes no styles: it attaches callback refs and `onLayout` handlers to views
 * that already exist. The on-screen report is absolutely positioned (so Yoga
 * excludes it from flow) and `pointerEvents="none"` (so it cannot steal the
 * drawing gesture), and the keyboard-closed pass is measured before any report
 * overlay exists in the tree at all.
 */

import React from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import Colors from "@/constants/colors";

export type ProbeRect = { x: number; y: number; width: number; height: number };

export type ProbeAssertion = {
  name: string;
  pass: boolean;
  detail: string;
};

export type ProbePass = {
  label: string;
  ran: boolean;
  skipReason?: string;
  window: { width: number; height: number };
  rects: Record<string, ProbeRect | null>;
  assertions: ProbeAssertion[];
};

type Measurable = {
  measureInWindow: (cb: (x: number, y: number, width: number, height: number) => void) => void;
};

const nodes = new Map<string, Measurable>();
const refCache = new Map<string, (n: unknown) => void>();

/** Stable callback ref per key. Attaching a ref to an existing view changes no layout. */
export function nodeRef(key: string): (n: unknown) => void {
  const cached = refCache.get(key);
  if (cached) return cached;
  const fn = (n: unknown) => {
    if (n && typeof (n as Measurable).measureInWindow === "function") {
      nodes.set(key, n as Measurable);
    } else {
      nodes.delete(key);
    }
  };
  refCache.set(key, fn);
  return fn;
}

export function resetNodes(): void {
  nodes.clear();
}

function measureOne(key: string): Promise<ProbeRect | null> {
  const node = nodes.get(key);
  if (!node) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    // measureInWindow does not invoke its callback if the view is detached.
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(null);
      }
    }, 500);
    node.measureInWindow((x, y, width, height) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ x, y, width, height });
    });
  });
}

export async function measureAll(keys: string[]): Promise<Record<string, ProbeRect | null>> {
  const out: Record<string, ProbeRect | null> = {};
  for (const k of keys) {
    out[k] = await measureOne(k);
  }
  return out;
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const fmt = (r: ProbeRect | null) =>
  r ? `x=${r1(r.x)} y=${r1(r.y)} w=${r1(r.width)} h=${r1(r.height)} bottom=${r1(r.y + r.height)}` : "NOT MEASURED";

function overlapArea(a: ProbeRect, b: ProbeRect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export const PROBE_KEYS = ["padWrap", "canvas", "actions", "card"] as const;

/**
 * The expected painted height of the signing surface. The sheet passes
 * `height={160}` to SignaturePad, so the surface view carries an explicit
 * 160pt height and will report it from measureInWindow even when its parent
 * contributes nothing to layout. That is precisely why `padWrap` is measured
 * too: the wrapper's height is what exposes a flex child collapsed to a
 * zero-height flexBasis, and the wrapper is the only place the collapse is
 * visible in a frame.
 */
export const EXPECTED_CANVAS_HEIGHT = 160;

export function evaluate(
  label: string,
  rects: Record<string, ProbeRect | null>,
  win: { width: number; height: number }
): ProbePass {
  const a: ProbeAssertion[] = [];
  const canvas = rects.canvas;
  const padWrap = rects.padWrap;
  const actions = rects.actions;
  const card = rects.card;

  // 1. The mechanism. A `flex: 1` child of an auto-height parent resolves
  //    flexBasis to 0pt in React Native, contributing nothing to the parent's
  //    content height, so the wrapper ends up shorter than the canvas it
  //    nominally contains.
  if (padWrap && canvas) {
    const pass = padWrap.height >= canvas.height;
    a.push({
      name: "pad wrapper is at least as tall as the canvas it contains",
      pass,
      detail: `wrapper h=${r1(padWrap.height)} vs canvas h=${r1(canvas.height)}` +
        (pass ? "" : ` -> wrapper is ${r1(canvas.height - padWrap.height)}pt SHORT; the canvas occupies no layout space`),
    });
  } else {
    a.push({ name: "pad wrapper is at least as tall as the canvas it contains", pass: false, detail: "wrapper or canvas not measured" });
  }

  // 2. The canvas is really the height it is supposed to be.
  if (canvas) {
    const pass = Math.abs(canvas.height - EXPECTED_CANVAS_HEIGHT) <= 1;
    a.push({
      name: `canvas is ${EXPECTED_CANVAS_HEIGHT}pt tall as passed by the sheet`,
      pass,
      detail: `canvas h=${r1(canvas.height)}`,
    });
  }

  // 3. The user-visible symptom: the canvas runs off the bottom of the screen.
  if (canvas) {
    const bottom = canvas.y + canvas.height;
    const pass = canvas.y >= 0 && bottom <= win.height + 0.5;
    a.push({
      name: "canvas is fully inside the window",
      pass,
      detail: `canvas top=${r1(canvas.y)} bottom=${r1(bottom)} window h=${r1(win.height)}` +
        (pass ? "" : ` -> ${r1(bottom - win.height)}pt of the canvas is BELOW the bottom edge of the screen`),
    });
  }

  // 4. The other user-visible symptom: Cancel/Save painted on top of the canvas.
  if (canvas && actions) {
    const area = overlapArea(canvas, actions);
    a.push({
      name: "canvas does not overlap the Cancel/Save row",
      pass: area === 0,
      detail: area === 0
        ? "no intersection"
        : `intersection ${r1(area)}pt^2 -> the buttons are drawn ON the signing surface`,
    });
  }

  // 5. Both buttons reachable.
  if (actions) {
    const bottom = actions.y + actions.height;
    const pass = actions.height > 0 && actions.y >= 0 && bottom <= win.height + 0.5;
    a.push({
      name: "Cancel/Save row is fully inside the window",
      pass,
      detail: `actions top=${r1(actions.y)} bottom=${r1(bottom)} h=${r1(actions.height)} window h=${r1(win.height)}`,
    });
  }

  // 6. The sheet itself fits.
  if (card) {
    const bottom = card.y + card.height;
    const pass = bottom <= win.height + 0.5;
    a.push({
      name: "sheet card bottom is inside the window",
      pass,
      detail: `card top=${r1(card.y)} bottom=${r1(bottom)} window h=${r1(win.height)}`,
    });
  }

  return { label, ran: true, window: win, rects, assertions: a };
}

export function skipped(label: string, reason: string, win: { width: number; height: number }): ProbePass {
  return { label, ran: false, skipReason: reason, window: win, rects: {}, assertions: [] };
}

export function formatPass(p: ProbePass): string {
  const lines: string[] = [];
  lines.push(`--- ${p.label} ---`);
  if (!p.ran) {
    lines.push(`  NOT RUN: ${p.skipReason ?? "unknown"}`);
    lines.push(`  (recorded as not run, NOT as a pass)`);
    return lines.join("\n");
  }
  lines.push(`  window: ${r1(p.window.width)} x ${r1(p.window.height)}`);
  for (const k of PROBE_KEYS) {
    lines.push(`  ${k.padEnd(8)} ${fmt(p.rects[k] ?? null)}`);
  }
  for (const as of p.assertions) {
    lines.push(`  [${as.pass ? "PASS" : "FAIL"}] ${as.name}`);
    lines.push(`         ${as.detail}`);
  }
  return lines.join("\n");
}

export function formatReport(passes: ProbePass[]): string {
  const ran = passes.filter((p) => p.ran);
  const notRun = passes.filter((p) => !p.ran);
  const all = ran.flatMap((p) => p.assertions);
  const failed = all.filter((a) => !a.pass).length;
  const head = `SIGPROBE_REPORT_BEGIN signature-sheet geometry`;
  const verdict =
    all.length === 0
      ? "NO ASSERTIONS RAN - this is a failure, not a pass"
      : failed === 0
        ? `GREEN: ${all.length} assertions passed across ${ran.length} pass(es)`
        : `RED: ${failed} of ${all.length} assertions FAILED across ${ran.length} pass(es)`;
  const tail = notRun.length > 0 ? `\n${notRun.length} pass(es) did not run; see above.` : "";
  return [head, ...passes.map(formatPass), `=> ${verdict}${tail}`, "SIGPROBE_REPORT_END"].join("\n");
}

export function verdictOf(passes: ProbePass[]): { green: boolean; failed: number; total: number } {
  const all = passes.filter((p) => p.ran).flatMap((p) => p.assertions);
  const failed = all.filter((a) => !a.pass).length;
  return { green: all.length > 0 && failed === 0, failed, total: all.length };
}

const probeStyles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 44,
    left: 8,
    right: 8,
    backgroundColor: Colors.overlay,
    borderRadius: 8,
    padding: 8,
  },
  text: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    fontSize: 8.5,
    lineHeight: 11,
  },
});

/**
 * The on-screen report, so `xcrun simctl io booted screenshot` captures a
 * verdict rather than a picture someone has to interpret.
 *
 * Absolutely positioned, so Yoga takes it out of flow and it cannot move the
 * card whose geometry it is reporting; `pointerEvents="none"`, so it cannot
 * intercept the pan gesture the signature pad needs. Colours are existing
 * tokens (Colors.overlay / success / error) — no new palette values.
 */
export function renderReport(text: string, green: boolean): React.ReactElement {
  return (
    <View pointerEvents="none" style={probeStyles.overlay}>
      <Text style={[probeStyles.text, { color: green ? Colors.success : Colors.error }]}>{text}</Text>
    </View>
  );
}
