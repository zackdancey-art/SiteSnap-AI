/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  DRAWING A SAVED ANNOTATION. THE PORTAL'S COPY OF THE RULE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The portal can CREATE annotations — `lib/annotation-derivative.ts` builds the
 * derivative and the lightbox in app/sites/[id]/page.tsx saves it — and until
 * this module landed it could not show one. Both of its photo surfaces rendered
 * a bare `<img>`: the grid tile and the lightbox. So a manager could annotate a
 * photograph in the portal, be told it saved, and then look at the result and
 * see the unmarked original, with the vector sitting in the record the whole
 * time. Identical defect to mobile's, same cause, found in the same sweep.
 * AUDIT L119.
 *
 * A note in `lib/annotation-derivative.ts` pointed at `apps/mobile/components/AnnotatedImage.tsx`
 * as the place a renderer change would have to be made alongside a type change.
 * The portal has never had that file — mobile does. The comment named a real
 * file in the wrong application, which is exactly the class of false comment
 * that has already cost three real gaps this week.
 *
 * The two geometry cases here are not the same as mobile's. The grid tile fits
 * `objectFit: cover` into a 4/3 box, and the lightbox fits `objectFit: contain`
 * inside a flex box AND then applies a zoom/pan `transform`. An overlay must
 * therefore share the image's own box and its transform, not the container's,
 * or the strokes drift as soon as somebody zooms. `overlayPreserveAspectRatio`
 * answers the first half; the call site answers the second.
 */

/*
 * THIS LOGIC EXISTS TWICE, AND CI PROVES THE TWO COPIES AGREE.
 *
 * The mobile twin is apps/mobile/lib/annotation-render.ts. Neither can import
 * the other, and `@sitesnap/shared` cannot hold it: that package resolves every
 * entry point to a `.d.ts`, so it carries types and no runtime JavaScript.
 *
 * The region between the two markers below is byte-identical in both files and
 * `assert_shared_logic_copies` in Projects/scripts/ci.sh diffs it, driven by the
 * `annotation-render` entry in that script's SHARED_LOGIC_GROUPS list. Edit one
 * and CI fails on the commit that did it, naming both paths. The prose above the
 * marker is each file's own; everything inside it is shared.
 *
 * It was spliced in from the mobile file by the commit that created it rather
 * than retyped, so the first run of the diff was a check of ci.sh and not of my
 * copying.
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
