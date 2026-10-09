import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { asyncStorageGetItemCount, resetAsyncStorageForTests } from "./test-setup";
import {
  hydratePhotos,
  hydratePhotosFromMap,
  readPhotoPayloadMap,
  savePhotoPayloads,
  type PhotoPayloadMap,
} from "./photo-payload-store";
import type { Photo } from "./types";

/**
 * What these tests are actually defending.
 *
 * `sitesnap.photoPayloads` is ONE AsyncStorage key holding the base64 of every
 * photograph on the device that has not yet reached the server. On a phone that
 * has been offline on a site for a week that is tens of megabytes in a single
 * string. Reading it is therefore not a lookup — it is a megabyte-scale read
 * plus a `JSON.parse` of the same size, and the cost has nothing to do with how
 * many photographs the caller asked about.
 *
 * AUDIT L56 was that read happening once per inspection checklist item, inside
 * a nested `Promise.all` so every one of them was in flight at the same time,
 * on a screen where the item count grows with the site's history and most items
 * carry no photograph at all. Nothing in the codebase could have failed over
 * it: the output was correct, and only the number of reads was wrong.
 *
 * So the read COUNT is asserted here as a correctness property. Both sides are
 * asserted — the batch form must read once, and the per-array form must still
 * read once per array — because "reads once" passes trivially if the counter
 * itself has stopped counting, and the second assertion is what fails when it
 * has.
 */

const photo = (id: string, over: Partial<Photo> = {}): Photo => ({
  id,
  uri: `file:///tmp/${id}.jpg`,
  caption: "",
  timestamp: "2026-10-01T00:00:00.000Z",
  captureTimeSource: "camera",
  ...over,
});

beforeEach(() => {
  resetAsyncStorageForTests();
});

test("hydratePhotosFromMap re-attaches base64 and mimeType held in the map", () => {
  const map: PhotoPayloadMap = {
    a: { base64: "AAAA", mimeType: "image/png" },
  };

  const [hydrated] = hydratePhotosFromMap([photo("a")], map);

  assert.equal(hydrated.base64, "AAAA");
  assert.equal(hydrated.mimeType, "image/png");
});

test("a photograph absent from the map keeps no base64, and one present does", () => {
  // The negative half of this is the point — a missing payload must NOT become
  // an empty string or a placeholder, because `resolvePhotoSource` treats a
  // falsy base64 as "not displayable" and a truthy one as bytes to render.
  // Paired with the positive control in the same test: if hydration never ran
  // at all, the first assertion below would pass and the second would fail.
  const map: PhotoPayloadMap = { known: { base64: "BBBB" } };

  const [missing, known] = hydratePhotosFromMap([photo("missing"), photo("known")], map);

  assert.equal(missing.base64, undefined);
  assert.equal(missing.mimeType, "image/jpeg"); // the documented default
  assert.equal(known.base64, "BBBB");
});

test("base64 already on the photograph is not overwritten by the map", () => {
  const map: PhotoPayloadMap = { a: { base64: "FROM-MAP" } };

  const [kept] = hydratePhotosFromMap([photo("a", { base64: "ALREADY-HERE" })], map);

  assert.equal(kept.base64, "ALREADY-HERE");
});

test("readPhotoPayloadMap returns the saved map, and {} when the key is unreadable", async () => {
  // Positive control first, so the empty-case assertion below cannot pass by
  // the store never having worked.
  await savePhotoPayloads([photo("a", { base64: "CCCC" })]);
  const saved = await readPhotoPayloadMap();
  assert.equal(saved.a?.base64, "CCCC");

  resetAsyncStorageForTests();
  assert.deepEqual(await readPhotoPayloadMap(), {});
});

test("hydrating many arrays costs ONE storage read in the batch form and N in the per-array form", async () => {
  // The shape of the inspections screen: results-per-inspection, most of them
  // with no photograph. 24 arrays, 23 of them empty.
  const resultPhotos: Photo[][] = [[photo("a")], ...Array.from({ length: 23 }, () => [] as Photo[])];

  await savePhotoPayloads([photo("a", { base64: "DDDD" })]);
  const afterSeed = asyncStorageGetItemCount();

  const map = await readPhotoPayloadMap();
  const batch = resultPhotos.map((photos) => hydratePhotosFromMap(photos, map));
  assert.equal(asyncStorageGetItemCount() - afterSeed, 1);
  assert.equal(batch[0][0].base64, "DDDD"); // it really did hydrate

  // The per-array form, which is what the screen used to do: one read each,
  // empty arrays included. This assertion is the counter's positive control —
  // it fails if `getItem` has stopped being counted, which would make the
  // assertion above vacuous.
  const beforeLoop = asyncStorageGetItemCount();
  for (const photos of resultPhotos) {
    await hydratePhotos(photos);
  }
  assert.equal(asyncStorageGetItemCount() - beforeLoop, resultPhotos.length);
});
