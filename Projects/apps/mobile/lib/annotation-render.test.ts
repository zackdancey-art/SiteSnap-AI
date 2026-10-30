import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { resetAsyncStorageForTests } from "./test-setup";
import { savePhotoPayloads, stripPhotoPayloads, hydrateEntriesWithPhotoPayloads } from "./photo-payload-store";
import {
  annotationIntegrity,
  overlayPreserveAspectRatio,
  selectAnnotationOverlay,
  type OverlayCandidate,
} from "./annotation-render";
import type { Entry, Photo } from "./types";

/**
 * THE DEFECT THESE TESTS EXIST FOR, and why nothing caught it.
 *
 * An annotation saved from the entry detail screen was persisted perfectly and
 * displayed as the unmarked original: the screen rendered photographs through
 * `EvidenceImage`, which cannot draw a stroke. Twenty-five days, no error, no
 * blank tile, no exception. AUDIT L119.
 *
 * NOTHING IN THIS REPOSITORY ASSERTED THAT AN ANNOTATION IS READABLE AFTER IT
 * IS SAVED. There were tests of the annotation palette, of the portal's
 * derivative builder, of payload stripping and of photo uri resolution — every
 * link in the chain, and nothing that followed one annotation from the save
 * through the storage shape and out the other side to ask whether it could
 * still be drawn. That is the test below, and it is the one that fails on a
 * revert of the fix.
 *
 * WHAT IS REAL HERE AND WHAT IS A STAND-IN, stated rather than implied:
 *
 *   real       the derivative shape the screen builds, `savePhotoPayloads`,
 *              `stripPhotoPayloads`, `hydrateEntriesWithPhotoPayloads`, the
 *              AsyncStorage behind them, and the overlay selection.
 *   stand-in   the server. `JSON.parse(JSON.stringify(x))` stands for the API
 *              hop, which is honest about what the API does to this field and
 *              nothing more: `photos` is `z.array(z.record(z.unknown()))` in
 *              `EntryPatchSchema` and lands in `photos_json JSONB`, so the
 *              round trip IS a JSON round trip and no field is read, validated
 *              or rewritten on the way. A real Postgres round trip for this
 *              column cannot be run in this environment (no local Postgres);
 *              `store-roundtrip.test.ts` is where that is covered, DB-gated.
 */

const VECTOR = {
  viewBox: "0 0 1000 750",
  strokes: [
    { path: "M 100 100 L 400 420", color: "#FF3B30", width: 6 },
    { path: "M 400 420 L 360 380", color: "#FF3B30", width: 6 },
  ],
};

function original(): Photo {
  return {
    id: "photo-original",
    uri: "https://media.example.test/companies/c1/entries/e1/original.jpg",
    caption: "Cracked lintel, north elevation",
    timestamp: "2026-10-30T09:00:00.000Z",
    capturedAt: "2026-10-30T08:58:00.000Z",
    captureTimeSource: "camera",
    base64: "ORIGINALBYTES",
    mimeType: "image/jpeg",
    storageKey: "companies/c1/entries/e1/original.jpg",
    storagePath: "/api/uploads/companies/c1/entries/e1/original.jpg",
    kind: "original",
  };
}

/**
 * The derivative exactly as `app/entry/[id].tsx` builds it.
 *
 * `null` rather than `undefined` for "no vector", because `undefined` re-triggers
 * the default parameter and hands back an intact annotation. That is not a
 * hypothetical tidy-up: the first run of this file passed `undefined`, got a
 * fully-formed vector, and the refusal assertion below went red and said so.
 */
function derivative(vector: Photo["annotationVector"] | null = VECTOR): Photo {
  const source = original();
  return {
    ...source,
    id: "photo-annotated",
    timestamp: "2026-10-30T09:05:00.000Z",
    kind: "annotated",
    derivedFromId: source.id,
    annotatedBy: "manager@example.test",
    ...(vector ? { annotationVector: vector } : {}),
  };
}

function entryWith(photos: Photo[]): Entry {
  return {
    id: "entry-1",
    siteId: "site-1",
    date: "2026-10-30",
    notes: "",
    photos,
  } as Entry;
}

beforeEach(() => {
  resetAsyncStorageForTests();
});

test("an annotation survives the round trip and is readable afterwards", async () => {
  const photos = [original(), derivative()];

  // ── save, as the screen does: payloads to AsyncStorage, then the stripped
  //    entry to the API.
  await savePhotoPayloads(photos);
  const sent = stripPhotoPayloads(entryWith(photos));

  // A CONTROL ON THE ROUND TRIP ITSELF. If `stripPhotoPayloads` were a no-op
  // the test below would still pass while having exercised nothing, so prove
  // the strip ran: the bytes are gone from what goes to the server.
  assert.equal(sent.photos[1].base64, undefined, "the strip did not run — base64 is still on the wire");
  // ...and prove the annotation is NOT what was stripped. This is the assertion
  // that distinguishes "the annotation was never sent" from the three other
  // places it could have been lost.
  assert.deepEqual(sent.photos[1].annotationVector, VECTOR, "the vector was stripped on the way out");
  assert.equal(sent.photos[1].kind, "annotated");
  assert.equal(sent.photos[1].derivedFromId, "photo-original");

  // ── the server hop. See the note at the top: for this column the API is a
  //    JSON round trip and nothing else.
  const returned: Entry = JSON.parse(JSON.stringify(sent));

  // ── read back, as the client does on refresh.
  const [rehydrated] = await hydrateEntriesWithPhotoPayloads([returned]);

  // Control on the hydrate: the bytes came back, so the hydrate ran.
  assert.equal(rehydrated.photos[1].base64, "ORIGINALBYTES", "the hydrate did not run");

  // ── THE ASSERTION THAT WOULD HAVE CAUGHT L119. Not "is the vector on the
  //    record" — it always was — but "would a surface draw it".
  const back = rehydrated.photos[1];
  const overlay = selectAnnotationOverlay(back, "displayable");
  assert.notEqual(overlay, null, "the annotation survived storage but nothing would draw it");
  assert.equal(overlay!.viewBox, VECTOR.viewBox);
  assert.equal(overlay!.strokes.length, 2);
  assert.deepEqual(overlay!.strokes, VECTOR.strokes, "the strokes changed across the round trip");
  assert.equal(annotationIntegrity(back), "drawable");

  // ── BOTH CONTROLS, same test, same round trip. The original went through
  //    every one of these steps alongside the derivative and must NOT acquire
  //    an overlay: an assertion that only ever saw annotated records would pass
  //    just as well against a renderer that drew strokes on everything.
  const originalBack = rehydrated.photos[0];
  assert.equal(originalBack.id, "photo-original", "the round trip reordered the photographs");
  assert.equal(
    selectAnnotationOverlay(originalBack, "displayable"),
    null,
    "the original is being drawn over — an annotation must never mark the evidence itself"
  );
  assert.equal(annotationIntegrity(originalBack), "not-an-annotation");
});

test("an annotated record whose vector did not survive is reported, not shown as a plain photograph", async () => {
  // The state the fix must not paper over: a derivative exists, so somebody was
  // told their annotation saved, and the marks are not in it.
  const photos = [original(), derivative(null)];
  await savePhotoPayloads(photos);
  const returned: Entry = JSON.parse(JSON.stringify(stripPhotoPayloads(entryWith(photos))));
  const [rehydrated] = await hydrateEntriesWithPhotoPayloads([returned]);
  const broken = rehydrated.photos[1];

  assert.equal(broken.kind, "annotated", "the fixture is wrong — this is not an annotated record");
  assert.equal(selectAnnotationOverlay(broken, "displayable"), null);
  assert.equal(
    annotationIntegrity(broken),
    "empty",
    "an annotation with no strokes must be distinguishable from a photograph that was never annotated"
  );

  // Positive control on the same assertion: the intact derivative, through the
  // same code, reports `drawable`. Without this, `annotationIntegrity` could
  // return "empty" unconditionally and this test would pass.
  assert.equal(annotationIntegrity(derivative()), "drawable");
});

test("an empty stroke list and a blank viewBox are refusals, not an invisible overlay", () => {
  assert.equal(selectAnnotationOverlay(derivative({ viewBox: "0 0 10 10", strokes: [] }), "displayable"), null);
  assert.equal(selectAnnotationOverlay(derivative({ viewBox: "   ", strokes: VECTOR.strokes }), "displayable"), null);
  // Positive control: the same call with a well-formed vector returns it.
  assert.notEqual(selectAnnotationOverlay(derivative(), "displayable"), null);
});

test("strokes are drawn only once the photograph is on screen", () => {
  const photo = derivative();
  assert.equal(selectAnnotationOverlay(photo, "loading"), null, "drawn before the image arrives");
  assert.equal(
    selectAnnotationOverlay(photo, "unavailable"),
    null,
    "drawn over the unavailable box — the marks would claim to describe something invisible"
  );
  // Positive control, same photo, same function.
  assert.notEqual(selectAnnotationOverlay(photo, "displayable"), null);
});

test("the overlay is fitted the same way as the photograph underneath it", () => {
  // `cover` crops; an overlay defaulting to `meet` would letterbox and every
  // stroke would land inboard of what it points at.
  assert.equal(overlayPreserveAspectRatio("cover"), "xMidYMid slice");
  assert.equal(overlayPreserveAspectRatio("contain"), "xMidYMid meet");
  // The two must DIFFER. A function returning one constant satisfies either
  // assertion above on its own and is exactly the defect being fixed.
  assert.notEqual(overlayPreserveAspectRatio("cover"), overlayPreserveAspectRatio("contain"));
});

test("mobile's real Photo type is accepted by the shared structural type", () => {
  // Compile-time, asserted here rather than left to a reader: the shared region
  // in annotation-render.ts declares its own structural types so the two client
  // copies can be byte-identical, and that is only sound if each client's real
  // model is assignable to them. A drift in `Photo` fails this line at
  // typecheck, in this package, rather than at runtime on a device.
  const asCandidate: OverlayCandidate = derivative();
  assert.equal(selectAnnotationOverlay(asCandidate, "displayable")!.strokes.length, 2);
});
