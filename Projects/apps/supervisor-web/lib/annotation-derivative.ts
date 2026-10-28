/**
 * Annotating a photograph creates a new record alongside the original and never
 * replaces it. That rule is the whole reason this module exists, and it is
 * stated as a function with tests rather than as a convention in a component,
 * because the way it gets broken is not a wrong decision — it is a `.map()`
 * that someone writes instead of a `.concat()` while tidying up.
 *
 * WHAT A DERIVATIVE ACTUALLY IS HERE, AND WHY IT IS NOT NEW PIXELS
 *
 * Mobile's derivative (`app/entry/[id].tsx`, `handleSaveAnnotation`) reuses the
 * source's `uri` and `storageKey` and carries the drawing as a vector in
 * `annotationVector`, which `components/AnnotatedImage.tsx` overlays as SVG
 * paths. No second image is uploaded. This module deliberately does the same
 * thing, for one reason: the two clients must not diverge. A portal that
 * rasterised the drawing into new bytes would produce annotations that the AI
 * report sees and mobile's do not, which is a worse outcome than either
 * behaviour chosen consistently.
 *
 * Whether the stored form should instead be flattened pixels is a real
 * question, and it is the SAME question as what the AI report should receive.
 * Both are flagged in the PR body rather than decided here.
 *
 * `fill="none"` in mobile's renderer is load-bearing for the shapes below: a
 * box has to be an outline path, not a filled one, or it will render as an
 * outline on mobile and a solid block anywhere that defaults to filling.
 */

/** One drawn stroke. Matches mobile's `AnnotationStroke` field for field. */
export type AnnotationStroke = { path: string; color: string; width: number };

/**
 * A drawing, in the coordinate space its `viewBox` declares.
 *
 * NOTE there is no text variant. Mobile's renderer draws `strokes` as SVG
 * `<Path>` and nothing else, so a text label written here would be stored,
 * synced, and then silently invisible on mobile — the two surfaces disagreeing
 * about what is marked on a piece of evidence. Text is therefore NOT offered by
 * the portal annotator; adding it needs an additive change to this type AND a
 * matching change to `components/AnnotatedImage.tsx`, shipped together.
 */
export type AnnotationVector = { viewBox: string; strokes: AnnotationStroke[] };

/** The photograph fields this module reads and writes. Structural, so no bundler is needed. */
export type AnnotatablePhoto = {
  id?: string;
  uri: string;
  caption?: string;
  timestamp?: string;
  capturedAt?: string;
  captureTimeSource?: "camera" | "exif" | "unknown";
  latitude?: number;
  longitude?: number;
  kind?: "original" | "annotated";
  derivedFromId?: string;
  annotatedBy?: string;
  annotationVector?: AnnotationVector;
};

/**
 * The photographs array to PATCH onto the entry: the original still there, now
 * explicitly marked `original`, with the new annotated record appended.
 *
 * Takes `id` and `now` as arguments rather than calling `crypto.randomUUID()`
 * and `Date.now()` itself, so the result is a pure function of its inputs and a
 * test can assert the exact record rather than its shape.
 *
 * What the derivative INHERITS is as deliberate as what it sets. An annotation
 * is a document about the same moment as the photograph it marks, so it depicts
 * the same capture time, the same place and the same bytes — copying those
 * across is what makes the derivative describable on its own. What it must NOT
 * inherit is the source's own `kind`, `derivedFromId`, `annotatedBy` or
 * `annotationVector`: those describe the source's provenance, and carrying them
 * forward is how an annotation of an annotation ends up claiming to be the
 * original's.
 */
export function buildAnnotationDerivative<P extends AnnotatablePhoto>(input: {
  photos: readonly P[];
  sourceId: string;
  vector: AnnotationVector;
  id: string;
  now: string;
  /** The signed-in account. Omitted from the record when absent — never written blank. */
  annotatedBy?: string;
}): P[] | null {
  const { photos, sourceId, vector, id, now, annotatedBy } = input;

  // `kind` is stamped onto the source only when it has none. A photograph
  // recorded before `kind` existed is an original, but saying so is a change to
  // a stored compliance record, so it happens exactly once and never overwrites
  // an existing value.
  const marked = photos.map((photo) =>
    photo.id === sourceId && !photo.kind ? { ...photo, kind: "original" as const } : photo
  );
  const source = marked.find((photo) => photo.id === sourceId);

  // No source means the set changed under the editor. Returning null rather
  // than appending an orphan: a derivative naming an original that is not in
  // the record is exactly the `annotation-orphaned` state the viewer has to
  // apologise for, and creating one on purpose would be absurd.
  if (!source) return null;

  const derivative = {
    ...source,
    id,
    // When the DERIVATIVE was made. Everything about the photograph itself is
    // inherited above; this is the one field that describes the annotation.
    timestamp: now,
    kind: "annotated" as const,
    derivedFromId: sourceId,
    annotationVector: vector,
    ...(annotatedBy ? { annotatedBy } : {}),
  } as P;

  // Deliberately `concat`, and deliberately not in place. The original array is
  // never mutated and the original record is never substituted.
  return marked.concat(derivative);
}

/**
 * The colours and stroke width a portal annotation is drawn with — the portal's
 * copy of apps/mobile/lib/annotation-palette.ts, and DELIBERATELY the same four
 * values.
 *
 * The colour is stored ON THE STROKE, and every renderer (mobile's
 * AnnotatedImage, mobile's export-utils, the portal's own overlay) reads it from
 * there. So these hexes are not a portal theme choice: a portal-drawn "Red" with
 * a different hex would export as a visibly different red beside a mobile-drawn
 * one on the same photograph.
 *
 * The hexes are written out rather than imported because the portal has no
 * access to mobile's `constants/colors` and `@sitesnap/shared` emits .d.ts only.
 * They are pinned in annotation-derivative.test.ts against the token values at
 * apps/mobile/constants/colors.ts:14-16 and :42, so a change on either side
 * fails this suite rather than diverging silently.
 *
 * Mobile's palette test additionally asserts perceptual separation against three
 * reference backgrounds. That test is not duplicated here: it belongs to the
 * palette's definition, and these values ARE that palette. Adding a portal-only
 * colour would mean the separation is no longer checked — so don't; add it to
 * mobile's palette, where the test lives, and mirror it here.
 */
export const ANNOTATION_PALETTE: readonly { label: string; color: string }[] = [
  { label: "Red", color: "#EF4444" },
  { label: "Amber", color: "#F59E0B" },
  { label: "Green", color: "#22C55E" },
  { label: "Blue", color: "#1E3A8A" },
];

/** What the annotator opens on. A member of the palette, asserted in the suite. */
export const DEFAULT_ANNOTATION_COLOUR = ANNOTATION_PALETTE[0].color;

/**
 * Stroke width, in viewBox units. Matches `STROKE_WIDTH` at
 * apps/mobile/components/PhotoAnnotator.tsx:19 — same units, because the viewBox
 * width below is also the same.
 */
export const ANNOTATION_STROKE_WIDTH = 6;

/**
 * The width of the coordinate space strokes are recorded in, matching
 * `VIEWBOX_WIDTH` at apps/mobile/components/PhotoAnnotator.tsx:18.
 *
 * This is the one number that MUST agree between the two clients. Mobile records
 * strokes scaled into a 1000-wide box whose height is the image's displayed
 * aspect ratio, and stores that box as the vector's `viewBox`. Both renderers
 * then scale the stored viewBox to fill the image. Recording portal strokes in a
 * different width would still render correctly — the viewBox travels with the
 * drawing — but it would make the two clients' stored coordinates
 * incomparable for anything that later reads them, so they are kept identical.
 */
export const ANNOTATION_VIEWBOX_WIDTH = 1000;

/**
 * The viewBox for an image displayed at `width` x `height` CSS pixels, and the
 * scale factors to convert a pointer position in that box into its coordinates.
 *
 * Mirrors mobile's `handleImageLayout` (PhotoAnnotator.tsx:70-77) including its
 * rounding, so the same drag on the same photograph on both surfaces records the
 * same path. A zero or negative box returns null: it means the image has not
 * laid out yet, and dividing by it produces Infinity coordinates that store a
 * stroke rendering nowhere.
 */
export function annotationViewBox(width: number, height: number): {
  viewBox: string;
  scaleX: number;
  scaleY: number;
} | null {
  if (!(width > 0) || !(height > 0)) return null;
  const vbHeight = Math.round((ANNOTATION_VIEWBOX_WIDTH / width) * height);
  return {
    viewBox: `0 0 ${ANNOTATION_VIEWBOX_WIDTH} ${vbHeight}`,
    scaleX: ANNOTATION_VIEWBOX_WIDTH / width,
    scaleY: vbHeight / height,
  };
}

/** Two decimal places. Enough for pixel coordinates, short enough to keep the JSONB small. */
const round = (n: number) => Math.round(n * 100) / 100;

/** A straight line as an SVG path. */
export function buildLinePath(x1: number, y1: number, x2: number, y2: number): string {
  return `M ${round(x1)} ${round(y1)} L ${round(x2)} ${round(y2)}`;
}

/**
 * A rectangle as an OUTLINE path, closed with `Z`.
 *
 * Written from the two corners in either order, because a box dragged
 * right-to-left or bottom-to-top is the same box and a negative width would
 * otherwise produce a path that renders as nothing.
 */
export function buildBoxPath(x1: number, y1: number, x2: number, y2: number): string {
  const left = round(Math.min(x1, x2));
  const right = round(Math.max(x1, x2));
  const top = round(Math.min(y1, y2));
  const bottom = round(Math.max(y1, y2));
  return `M ${left} ${top} L ${right} ${top} L ${right} ${bottom} L ${left} ${bottom} Z`;
}

/**
 * An arrow: the shaft, then the two head barbs, as one path.
 *
 * The head is sized from `headLength` rather than from the shaft, so a short
 * arrow does not get a head longer than itself. The barbs are drawn as two
 * separate `M…L` subpaths rather than a closed triangle because the renderer
 * uses `fill="none"`, and an unfilled triangle is just an outline anyway.
 */
export function buildArrowPath(
  x1: number, y1: number, x2: number, y2: number, headLength = 18
): string {
  const shaft = buildLinePath(x1, y1, x2, y2);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  // A zero-length drag has no direction, so there is no head to point. The
  // shaft alone is returned rather than dividing by zero into NaN coordinates,
  // which would store a path that silently renders nothing.
  if (length === 0) return shaft;
  const head = Math.min(headLength, length);
  const angle = Math.atan2(dy, dx);
  const barb = (spread: number) =>
    buildLinePath(
      x2, y2,
      x2 - head * Math.cos(angle - spread),
      y2 - head * Math.sin(angle - spread)
    );
  return `${shaft} ${barb(Math.PI / 7)} ${barb(-Math.PI / 7)}`;
}
