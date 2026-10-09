import Colors from "@/constants/colors";

/**
 * The colours a person can draw on a site photograph with.
 *
 * Extracted out of components/PhotoAnnotator.tsx so that the invariant in
 * lib/annotation-palette.test.ts can assert on it: the component imports React
 * Native, so a test cannot require it, and a palette no test can reach is a
 * palette whose legibility nobody checks.
 *
 * WHAT THE TEST GUARANTEES, AND WHY IT MATTERS MORE HERE THAN IN MOST UI
 *
 * An annotation is drawn ON a photograph, so there is no controlled background.
 * The thing it is drawn over is concrete, sky, shadow, high-vis, mud. A stroke
 * nobody can see is not a cosmetic problem: these photographs are the
 * compliance evidence this product exists to produce, the annotation is often
 * the only thing identifying what the photograph is OF, and an exported diary
 * is read months later by someone who cannot go back and re-mark it.
 *
 * So the test asserts a worst-case perceptual separation against three
 * reference backgrounds, and a pairwise separation between the palette entries
 * themselves — "red" and "amber" being hard to tell apart on an export matters
 * when one means a defect and the other means a note.
 *
 * SINGLE DEFINITION
 *
 * This is the only palette in the app. The two other places annotation colour
 * is rendered — components/AnnotatedImage.tsx and lib/export-utils.ts — both
 * read the colour stored on the stroke (`stroke={s.color}` and
 * `stroke="${escapeHtml(s.color)}"`), so they inherit whatever was chosen here
 * and carry no copy of their own. If a copy ever appears in either of them the
 * real defect is the duplication, and this test would be checking one of three
 * definitions while believing it covered the product.
 *
 * Colours are existing Colors tokens. Do not add a raw hex here: the test
 * cannot tell you whether a new one is legible until it is a token, and a
 * one-off hex in a palette is how a palette stops having a rationale.
 */
export type AnnotationColour = { label: string; color: string };

export const PALETTE: readonly AnnotationColour[] = [
  { label: "Red", color: Colors.error },
  { label: "Amber", color: Colors.warning },
  { label: "Green", color: Colors.success },
  { label: "Blue", color: Colors.infoText },
] as const;

/**
 * What the annotator opens on. Asserted to be a member of PALETTE — the
 * selected swatch is rendered by comparing against this value, so a default
 * that is not in the list shows an annotator with nothing selected.
 */
export const DEFAULT_ANNOTATION_COLOUR: string = PALETTE[0].color;
