import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAnnotationDerivative, type AnnotationVector } from "./annotation-derivative";
import {
  annotationIntegrity,
  overlayPreserveAspectRatio,
  selectAnnotationOverlay,
  type OverlayCandidate,
} from "./annotation-render";

/**
 * The portal's half of AUDIT L119.
 *
 * The portal has been able to CREATE an annotation since the lightbox gained
 * the annotator, and has never been able to show one: both of its photo
 * surfaces rendered a bare `<img>`. `annotation-derivative.test.ts` proved the
 * derivative was built correctly, and that is exactly the shape of the gap —
 * every test in this package asserted that the annotation was recorded, and
 * none that it could be read back.
 *
 * So these tests take the output of the REAL builder, not a hand-written
 * fixture, and ask the renderer's selector whether it would draw it. That is
 * the join the two test files had between them and did not cover.
 */

const VECTOR: AnnotationVector = {
  viewBox: "0 0 1200 900",
  strokes: [{ path: "M 10 10 L 600 480", color: "#FF3B30", width: 8 }],
};

function built(vector: AnnotationVector = VECTOR) {
  const photos = buildAnnotationDerivative({
    photos: [
      {
        id: "p-original",
        uri: "https://media.example.test/c1/e1/original.jpg",
        caption: "Cracked lintel",
        kind: "original",
      },
    ],
    sourceId: "p-original",
    vector,
    id: "p-annotated",
    now: "2026-10-30T09:05:00.000Z",
    annotatedBy: "manager@example.test",
  });
  assert.ok(photos, "the real builder refused the fixture — this test is testing nothing");
  return photos;
}

test("the annotation the portal builds is one the portal would draw", () => {
  const photos = built();
  assert.equal(photos.length, 2, "an annotation must add a record, never replace the original");

  const derivative = photos[1];
  assert.equal(derivative.kind, "annotated");

  // THE ASSERTION THE PORTAL DID NOT HAVE.
  const overlay = selectAnnotationOverlay(derivative, "displayable");
  assert.notEqual(overlay, null, "the portal records an annotation it would not render");
  assert.deepEqual(overlay!.strokes, VECTOR.strokes);
  assert.equal(overlay!.viewBox, VECTOR.viewBox);
  assert.equal(annotationIntegrity(derivative), "drawable");

  // BOTH CONTROLS, same call, same array: the original went through the same
  // builder and must not be drawn over. Without this, a selector that returned
  // the vector for every photograph would pass the assertions above.
  assert.equal(
    selectAnnotationOverlay(photos[0], "displayable"),
    null,
    "the original is being drawn over — the marks belong to the derivative alone"
  );
  assert.equal(annotationIntegrity(photos[0]), "not-an-annotation");
});

test("strokes are drawn only while the photograph is on screen", () => {
  const derivative = built()[1];
  assert.equal(selectAnnotationOverlay(derivative, "loading"), null);
  assert.equal(selectAnnotationOverlay(derivative, "unavailable"), null);
  // Positive control, same record.
  assert.notEqual(selectAnnotationOverlay(derivative, "displayable"), null);
});

test("an empty stroke list is a refusal, and is reported as an emptied annotation", () => {
  const empty = built({ viewBox: "0 0 10 10", strokes: [] })[1];
  assert.equal(selectAnnotationOverlay(empty, "displayable"), null);
  assert.equal(annotationIntegrity(empty), "empty", "indistinguishable from a photograph nobody annotated");
  // Positive control: the intact one, through the same functions.
  assert.equal(annotationIntegrity(built()[1]), "drawable");
});

test("the overlay is fitted the same way as the photograph underneath it", () => {
  // The grid tile is objectFit:cover and the lightbox objectFit:contain, so both
  // answers are live in this package and a constant would break one of them.
  assert.equal(overlayPreserveAspectRatio("cover"), "xMidYMid slice");
  assert.equal(overlayPreserveAspectRatio("contain"), "xMidYMid meet");
  assert.notEqual(overlayPreserveAspectRatio("cover"), overlayPreserveAspectRatio("contain"));
});

test("the portal's own photo type is accepted by the shared structural type", () => {
  // Compile-time, asserted here rather than left to a reader: the shared region
  // declares its own types so the two client copies can be byte-identical, which
  // is only sound while each client's model is assignable to them.
  const asCandidate: OverlayCandidate = built()[1];
  assert.equal(selectAnnotationOverlay(asCandidate, "displayable")!.strokes.length, 1);
});
