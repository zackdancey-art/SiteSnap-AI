/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DRAWING A SAVED ANNOTATION. THE RULE, IN ONE TESTABLE PLACE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * An annotation in this product is a STROKE VECTOR, not an image. Saving one
 * creates a new `Photo` record that reuses the original's bytes and carries
 * `kind: "annotated"` plus an `annotationVector`; the original is never
 * replaced (AUDIT L33). That design is why an annotation can be stored
 * perfectly and still be invisible: the vector only becomes a mark on a
 * photograph at the moment some component chooses to draw it, and a component
 * that does not know about `annotationVector` renders the untouched original
 * with no error and no empty space — it looks exactly like an annotation that
 * was never saved.
 *
 * That is not hypothetical. It is the defect this module was written for: four
 * of mobile's six photo surfaces drew evidence through `EvidenceImage`, which
 * cannot draw a stroke, so an annotation saved from the entry detail screen
 * was persisted with its vector intact and then shown as the bare photograph.
 * The arrow pointing at the defect — frequently the evidence itself in a site
 * diary — simply was not there. AUDIT L119.
 *
 * WHY THIS IS NOT INSIDE THE COMPONENT
 *
 * Same reason as `lib/job-number.ts` and `lib/site-grouping.ts`: there is no
 * simulator and no device attached to this environment, so a rule written
 * inside components/AnnotatedImage.tsx could only be verified by reading it —
 * which is precisely how a whole screen came to be missing the overlay without
 * one test going red. This module imports nothing from react or react-native,
 * so `lib/annotation-render.test.ts` drives every state a stored photograph can
 * actually be in, including the three no screenshot would show: an annotated
 * record whose vector is absent, one whose stroke list is empty, and an
 * original that must NOT be drawn over.
 */

/*
 * THIS LOGIC EXISTS TWICE, AND CI PROVES THE TWO COPIES AGREE.
 *
 * The portal needs the same rule (apps/supervisor-web/lib/annotation-render.ts)
 * and cannot import this one: `@sitesnap/shared` resolves `main`, `types` and
 * every `exports` entry to a `.d.ts` file, so it carries types and no runtime
 * JavaScript, and changing that is an install-resolution decision belonging to
 * docs/DECISIONS.md rather than to a rendering fix.
 *
 * So the region between the two markers below is byte-identical in both files,
 * and `assert_shared_logic_copies` in Projects/scripts/ci.sh diffs it, driven by
 * the `annotation-render` entry in that script's SHARED_LOGIC_GROUPS list. Edit
 * one and CI fails on the commit that did it, naming both paths. The prose above
 * the marker is each file's own; everything inside it is shared.
 *
 * The region declares its own structural types rather than importing each
 * client's `Photo`, so that the two copies can be byte-identical while each
 * client keeps its own model. Both clients' real types are assignable to them,
 * and `annotation-render.test.ts` asserts that on each side with the real type
 * rather than leaving it to a reader.
 */

// SHARED-LOGIC-BEGIN
/** One drawn stroke. Field for field, mobile's `AnnotationStroke` and the portal's. */
export type OverlayStroke = { path: string; color: string; width: number };

/** A drawing, in the coordinate space its `viewBox` declares. */
export type OverlayVector = { viewBox: string; strokes: OverlayStroke[] };

/**
 * The photograph fields this module reads. Structural on purpose: see the note
 * above the marker.
 */
export type OverlayCandidate = {
  kind?: "original" | "annotated" | null;
  annotationVector?: OverlayVector | null;
};

/** Whether the photograph underneath is actually on screen yet. */
export type OverlayVisibility = "loading" | "displayable" | "unavailable";

/** How the photograph underneath is fitted into its box. */
export type OverlayFit = "cover" | "contain";

/**
 * The strokes to draw over this photograph, or null for none.
 *
 * FOUR REFUSALS, each for its own reason:
 *
 *   not annotated     an original must never be drawn over. The original is the
 *                     evidence; marks belong to the derivative alone.
 *   vector absent     a record that says `kind: "annotated"` and carries no
 *                     vector is a broken annotation, and drawing nothing is the
 *                     honest answer. `annotationIntegrity` below is how a screen
 *                     can say so out loud instead of showing a bare photograph.
 *   no strokes        an empty stroke list would mount an <Svg> with no <Path>
 *                     children — invisible, and indistinguishable to a reader
 *                     from a lost annotation.
 *   not displayable   strokes floating over the amber "unavailable" box would
 *                     suggest the markup applies to something the reader can
 *                     see. It does not. This also covers `loading`, so the
 *                     overlay appears with the image rather than before it.
 */
export function selectAnnotationOverlay(
  photo: OverlayCandidate,
  visibility: OverlayVisibility
): OverlayVector | null {
  if (photo.kind !== "annotated") return null;
  if (visibility !== "displayable") return null;
  const vector = photo.annotationVector;
  if (!vector || !Array.isArray(vector.strokes) || vector.strokes.length === 0) return null;
  if (typeof vector.viewBox !== "string" || vector.viewBox.trim() === "") return null;
  return vector;
}

/**
 * Whether this record claims an annotation it cannot draw.
 *
 * "drawable" and "empty" are both only reachable for `kind: "annotated"`.
 * `empty` is the state that matters: it means a derivative record exists — so
 * somebody annotated something and was told it saved — while the marks
 * themselves are gone. Nothing in this product should report that as a normal
 * photograph, which is what every surface did before AUDIT L119.
 */
export function annotationIntegrity(
  photo: OverlayCandidate
): "not-an-annotation" | "drawable" | "empty" {
  if (photo.kind !== "annotated") return "not-an-annotation";
  return selectAnnotationOverlay(photo, "displayable") ? "drawable" : "empty";
}

/**
 * The `preserveAspectRatio` that puts the strokes on the pixels they were
 * drawn over.
 *
 * THIS IS NOT COSMETIC. An SVG with a viewBox defaults to `xMidYMid meet`,
 * which letterboxes — the same geometry as `contain`. Draw that over an image
 * fitted with `cover` and the two scale differently: on a 4:3 photograph in a
 * square tile, `cover` crops the sides and `meet` does not, so every stroke
 * lands inboard of the thing it points at. An annotation that points at the
 * wrong part of a defect is worse than one that is missing, because the missing
 * one does not make a false claim about the evidence.
 *
 * `slice` is SVG's `cover`. The two existing surfaces that drew strokes
 * (new-entry and the inspections checklist) both fitted `cover` under a `meet`
 * overlay and so carried this offset silently from the start.
 */
export function overlayPreserveAspectRatio(fit: OverlayFit): string {
  return fit === "cover" ? "xMidYMid slice" : "xMidYMid meet";
}
// SHARED-LOGIC-END
