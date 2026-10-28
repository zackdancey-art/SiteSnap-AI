import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  annotationViewBox,
  ANNOTATION_PALETTE,
  ANNOTATION_STROKE_WIDTH,
  ANNOTATION_VIEWBOX_WIDTH,
  buildAnnotationDerivative,
  buildArrowPath,
  buildBoxPath,
  buildLinePath,
  DEFAULT_ANNOTATION_COLOUR,
  type AnnotatablePhoto,
  type AnnotationVector,
} from "./annotation-derivative";

const vector: AnnotationVector = {
  viewBox: "0 0 100 200",
  strokes: [{ path: "M 1 1 L 9 9", color: "#ff0000", width: 4 }],
};

const original = (over: Partial<AnnotatablePhoto> = {}): AnnotatablePhoto => ({
  id: "orig-1",
  uri: "site-a/2026-10-18/one.jpg",
  caption: "Edge protection missing on level 3",
  timestamp: "2026-10-18T07:00:00.000Z",
  capturedAt: "2026-10-18T06:58:12.000Z",
  captureTimeSource: "camera",
  latitude: -33.86,
  longitude: 151.2,
  ...over,
});

const save = (photos: readonly AnnotatablePhoto[], over: Record<string, unknown> = {}) =>
  buildAnnotationDerivative({
    photos,
    sourceId: "orig-1",
    vector,
    id: "deriv-1",
    now: "2026-10-21T22:15:00.000Z",
    annotatedBy: "manager@example.test",
    ...over,
  });

// THE RULE. Both halves in one test: the original is still there AND the
// annotation was added. Asserting only the second passes just as well when the
// function has replaced the original in place, which is the exact defect.
test("annotating appends a new record and leaves the original in place, unchanged", () => {
  const photos = [original()];
  const result = save(photos);

  assert.ok(result, "a save against a present source must produce a result");
  assert.equal(result.length, 2, "one photograph in, two out");

  // positive control: the annotation really was created
  const annotated = result.filter((p) => p.kind === "annotated");
  assert.equal(annotated.length, 1);
  assert.equal(annotated[0]?.id, "deriv-1");
  assert.deepEqual(annotated[0]?.annotationVector, vector);

  // the refusal: the original survived, by id, and its own fields did not move
  const kept = result.find((p) => p.id === "orig-1");
  assert.ok(kept, "the original must still be in the set");
  assert.equal(kept.uri, "site-a/2026-10-18/one.jpg");
  assert.equal(kept.caption, "Edge protection missing on level 3");
  assert.equal(kept.capturedAt, "2026-10-18T06:58:12.000Z");
  assert.equal(kept.timestamp, "2026-10-18T07:00:00.000Z", "the original's own time is untouched");
  assert.equal(kept.annotationVector, undefined, "the drawing is not on the original");
  assert.equal(kept.derivedFromId, undefined);

  // and the array handed in was not mutated on the way through
  assert.equal(photos.length, 1);
  assert.equal(photos[0]?.kind, undefined);
});

test("the original keeps its position, so the set is appended to and never reordered", () => {
  const result = save([
    original({ id: "other-0", uri: "zero.jpg" }),
    original(),
    original({ id: "other-2", uri: "two.jpg" }),
  ]);
  assert.ok(result);
  assert.deepEqual(
    result.map((p) => p.id),
    ["other-0", "orig-1", "other-2", "deriv-1"],
    "the three originals stay in order and the derivative goes on the end"
  );
  // positive control: the derivative is the one at the end, not a copy of other-2
  assert.equal(result[3]?.kind, "annotated");
  assert.equal(result[3]?.derivedFromId, "orig-1");
});

test("an untagged source is marked original, and a source already tagged is left alone", () => {
  // the refusal: no overwriting of a value a record already carries
  const alreadyAnnotated = save([original({ kind: "annotated", derivedFromId: "older" })]);
  assert.ok(alreadyAnnotated);
  assert.equal(alreadyAnnotated[0]?.kind, "annotated", "an existing kind is never rewritten");

  // positive control: when there IS no kind, the stamp is applied
  const untagged = save([original()]);
  assert.ok(untagged);
  assert.equal(untagged[0]?.kind, "original", "a legacy photograph is named as the original");
});

test("the derivative records who annotated and when, and omits the author rather than writing a blank one", () => {
  // positive control: an author, present, is recorded
  const named = save([original()]);
  assert.ok(named);
  assert.equal(named[1]?.annotatedBy, "manager@example.test");
  assert.equal(named[1]?.timestamp, "2026-10-21T22:15:00.000Z");

  // the refusal: no author means the FIELD IS ABSENT, not empty string
  const anonymous = save([original()], { annotatedBy: undefined });
  assert.ok(anonymous);
  assert.ok(
    !("annotatedBy" in (anonymous[1] as object)),
    "an unknown annotator is an absent field, so the viewer can say so honestly"
  );
  assert.equal(anonymous[1]?.kind, "annotated", "the derivative is otherwise complete");
});

test("the derivative depicts the same moment and place as its original, and shares its bytes", () => {
  const result = save([original()]);
  assert.ok(result);
  const [, deriv] = result;
  // Shares the uri deliberately: mobile's derivative does the same, and pinning
  // it here means a future change to real rasterised bytes has to be a change
  // to this assertion, not a quiet divergence between the two clients.
  assert.equal(deriv?.uri, "site-a/2026-10-18/one.jpg");
  assert.equal(deriv?.capturedAt, "2026-10-18T06:58:12.000Z");
  assert.equal(deriv?.captureTimeSource, "camera");
  assert.equal(deriv?.latitude, -33.86);
  assert.equal(deriv?.longitude, 151.2);
  assert.equal(deriv?.caption, "Edge protection missing on level 3");
});

test("an annotation of an annotation derives from what was on screen, not from its ancestor", () => {
  const photos = [
    original(),
    original({ id: "deriv-0", kind: "annotated", derivedFromId: "orig-1", annotatedBy: "first@example.test", annotationVector: vector }),
  ];
  const result = buildAnnotationDerivative({
    photos,
    sourceId: "deriv-0",
    vector: { viewBox: "0 0 10 10", strokes: [] },
    id: "deriv-2",
    now: "2026-10-21T23:00:00.000Z",
    annotatedBy: "second@example.test",
  });
  assert.ok(result);
  assert.equal(result.length, 3);
  // the refusal: the new record does NOT inherit deriv-0's provenance
  assert.equal(result[2]?.derivedFromId, "deriv-0", "it names what it was drawn over");
  assert.equal(result[2]?.annotatedBy, "second@example.test", "not the earlier annotator");
  assert.deepEqual(result[2]?.annotationVector?.strokes, [], "not the earlier drawing");
  // positive control: the earlier annotation is untouched and still present
  assert.equal(result[1]?.annotatedBy, "first@example.test");
  assert.deepEqual(result[1]?.annotationVector, vector);
});

test("a source that is no longer in the set refuses rather than appending an orphan", () => {
  // the refusal
  assert.equal(
    save([original({ id: "someone-else" })]),
    null,
    "a derivative naming an absent original would be an orphan by construction"
  );
  // positive control, same endpoint: the identical call with the source present works
  const ok = save([original({ id: "someone-else" }), original()]);
  assert.ok(ok, "the same save succeeds once the source is there");
  assert.equal(ok.length, 3);
});

test("a line is a line; a box is a closed outline whichever way it was dragged", () => {
  assert.equal(buildLinePath(1, 2, 3, 4), "M 1 2 L 3 4");

  const topLeftFirst = buildBoxPath(10, 20, 50, 80);
  const bottomRightFirst = buildBoxPath(50, 80, 10, 20);
  assert.equal(topLeftFirst, bottomRightFirst, "a box dragged either way is the same box");
  assert.equal(topLeftFirst, "M 10 20 L 50 20 L 50 80 L 10 80 Z");
  // positive control that Z is what closes it: without it this would be an open path
  assert.ok(topLeftFirst.endsWith(" Z"), "closed, so it renders as a rectangle under fill=none");
});

test("an arrow has a head that points along the shaft, and a zero-length drag has none", () => {
  // positive control: a real drag produces shaft plus two barbs
  const arrow = buildArrowPath(0, 0, 100, 0);
  const subpaths = arrow.split("M ").length - 1;
  assert.equal(subpaths, 3, "shaft and two barbs");
  assert.ok(arrow.startsWith("M 0 0 L 100 0 "), "the shaft comes first");
  // pointing right means both barbs sit back from the tip, one above and one below
  assert.ok(arrow.includes("L 83.78 7.81"), arrow);
  assert.ok(arrow.includes("L 83.78 -7.81"), arrow);

  // the refusal: no NaN coordinates from dividing by a zero-length drag
  const degenerate = buildArrowPath(5, 5, 5, 5);
  assert.equal(degenerate, "M 5 5 L 5 5");
  assert.ok(!degenerate.includes("NaN"), "a stored NaN path renders as nothing at all");
});

test("the head never outgrows a short arrow", () => {
  // The head is clamped to the shaft length, so a 4-unit arrow asked for an
  // 18-unit head gets a 4-unit one and no barb reaches back past the tail at x=0.
  const short = buildArrowPath(0, 0, 4, 0, 18);
  const xs = [...short.matchAll(/-?[\d.]+(?= -?[\d.]+)/g)].map((m) => Number(m[0]));
  assert.ok(xs.length > 0, `expected coordinates in ${short}`);
  assert.ok(
    xs.every((x) => x >= 0),
    `a barb behind the tail would point the arrow the wrong way: ${short}`
  );
  assert.ok(short.includes("L 0.4 1.74"), short);

  // positive control, same function: with room, the full 18 units IS used, so
  // the clamp above is a clamp and not a head that is always the shaft length.
  const long = buildArrowPath(0, 0, 400, 0, 18);
  assert.ok(long.includes("L 383.78 7.81"), long);
});

// ── the twinned values ──────────────────────────────────────────────────────
// These pin the portal's copy against mobile's definitions. They are the whole
// defence for the duplication: change either side and this fails.

test("the palette is mobile's palette, hex for hex", () => {
  assert.deepEqual(ANNOTATION_PALETTE, [
    // apps/mobile/lib/annotation-palette.ts:41-46, resolved through
    // apps/mobile/constants/colors.ts — error:14, warning:16, success:15, infoText:42
    { label: "Red", color: "#EF4444" },
    { label: "Amber", color: "#F59E0B" },
    { label: "Green", color: "#22C55E" },
    { label: "Blue", color: "#1E3A8A" },
  ]);
  // the refusal: no portal-only colour, because the legibility test that
  // justifies a palette entry lives on mobile's side
  assert.equal(ANNOTATION_PALETTE.length, 4);
  // positive control, mirroring mobile's own assertion: the default is a member
  assert.ok(
    ANNOTATION_PALETTE.some((p) => p.color === DEFAULT_ANNOTATION_COLOUR),
    `the default ${DEFAULT_ANNOTATION_COLOUR} is not in the palette, so no swatch would look selected`
  );
});

test("strokes are recorded in mobile's coordinate space, at mobile's width", () => {
  assert.equal(ANNOTATION_VIEWBOX_WIDTH, 1000, "VIEWBOX_WIDTH, PhotoAnnotator.tsx:18");
  assert.equal(ANNOTATION_STROKE_WIDTH, 6, "STROKE_WIDTH, PhotoAnnotator.tsx:19");
});

test("the viewBox follows the displayed aspect ratio, and refuses a box that has not laid out", () => {
  // positive control: a 400x300 box scales to 1000x750
  const landscape = annotationViewBox(400, 300);
  assert.ok(landscape);
  assert.equal(landscape.viewBox, "0 0 1000 750");
  assert.equal(landscape.scaleX, 2.5);
  assert.equal(landscape.scaleY, 2.5);

  // a portrait photograph, which is what a phone actually produces
  const portrait = annotationViewBox(300, 400);
  assert.ok(portrait);
  assert.equal(portrait.viewBox, "0 0 1000 1333", "rounded, exactly as mobile rounds it");

  // the refusal: no Infinity coordinates from a box with no size yet
  assert.equal(annotationViewBox(0, 300), null);
  assert.equal(annotationViewBox(400, 0), null);
  assert.equal(annotationViewBox(-1, 300), null);
  assert.equal(annotationViewBox(Number.NaN, 300), null, "NaN is not a positive width");
});
