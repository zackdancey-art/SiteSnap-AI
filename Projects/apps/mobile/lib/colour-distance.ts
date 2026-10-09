/**
 * Perceptual colour distance, in enough of CIELAB to answer one question:
 * can a person tell these two colours apart on a construction photograph?
 *
 * This exists for the annotation palette invariant (lib/annotation-palette.ts).
 * It is pure arithmetic over hex strings with no React Native import, so the
 * node test program can require it.
 *
 * WHY ΔE AND NOT WCAG CONTRAST RATIO
 *
 * Contrast ratio is a luminance ratio, and it is the wrong instrument here.
 * Measured against the reference backgrounds, `Colors.warning` (amber) scores
 * 1.08 and `Colors.primary` (navy) scores 1.06 — indistinguishable. But amber
 * on concrete is obvious and navy on shadow is invisible, and ΔE separates them
 * 79.3 to 20.1. Asserting a contrast-ratio floor would have thrown amber out of
 * the palette while keeping navy in. `contrastRatio` is kept because it is the
 * accessibility number people expect to see quoted, and because the test
 * records it alongside ΔE to show why ΔE is the one being asserted on.
 */

/** `#1E3A8A` -> `[30, 58, 138]`. Throws rather than coercing a typo to black. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a six-digit hex colour: ${JSON.stringify(hex)}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** sRGB gamma expansion, per IEC 61966-2-1. */
function linearise(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map(linearise);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1 (identical) to 21 (black on white). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export type Lab = { L: number; a: number; b: number };

// D65, the white point sRGB is defined against.
const WHITE = { x: 0.95047, y: 1.0, z: 1.08883 };

export function hexToLab(hex: string): Lab {
  const [r, g, b] = hexToRgb(hex).map(linearise);

  // sRGB -> CIE XYZ (D65)
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / WHITE.x;
  const y = (0.2126729 * r + 0.7151522 * g + 0.072175 * b) / WHITE.y;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / WHITE.z;

  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : (841 / 108) * t + 4 / 29);
  const [fx, fy, fz] = [f(x), f(y), f(z)];

  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

/**
 * CIE76 ΔE — the Euclidean distance in Lab.
 *
 * CIEDE2000 is the better metric and is deliberately not used: it is far more
 * code, its corrections matter most for small differences, and every number
 * this file is used to assert on is well above the threshold where the two
 * agree on the verdict. ΔE76 is also the metric the measured figures quoted in
 * lib/annotation-palette.test.ts were taken with, so swapping it would silently
 * invalidate those numbers.
 */
export function deltaE76(a: string, b: string): number {
  const x = hexToLab(a);
  const y = hexToLab(b);
  return Math.sqrt((x.L - y.L) ** 2 + (x.a - y.a) ** 2 + (x.b - y.b) ** 2);
}

/** Per-axis contributions to a ΔE76, for saying WHERE a margin comes from. */
export function deltaE76Axes(a: string, b: string): { dL: number; da: number; db: number } {
  const x = hexToLab(a);
  const y = hexToLab(b);
  return { dL: x.L - y.L, da: x.a - y.a, db: x.b - y.b };
}
