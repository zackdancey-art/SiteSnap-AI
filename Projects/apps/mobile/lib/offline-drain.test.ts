import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { drainQueue, type DrainDeps } from "./offline-drain";
import {
  enqueue,
  dequeue,
  isNetworkError,
  peekQueue,
  updateQueuedPayload,
} from "./offline-queue";
import {
  deletePhotoPayloads,
  hydratePhotos,
  savePhotoPayloads,
  stripPhotoPayloads,
} from "./photo-payload-store";
import { isManagedMediaUri } from "./photo-uri";
import { asyncStorageKeys, resetAsyncStorageForTests } from "./test-setup";
import type { Entry, Photo } from "./types";

/**
 * AUDIT L28 — photographs captured with no coverage must reach the server.
 *
 * WHAT IS REAL HERE AND WHAT IS A FAKE
 *
 * Real: `offline-queue.ts`, `photo-payload-store.ts` and `photo-uri.ts`, running
 * against the substitute AsyncStorage from `test-setup.ts`. The queued op in
 * every test below is built by the same two calls `addEntry`'s offline branch
 * makes — `savePhotoPayloads(photos)` then `enqueue({ type: "addEntry",
 * payload: stripPhotoPayloads(optimistic) })` — so the input is the app's own,
 * not a hand-written approximation of it.
 *
 * Faked: the network. `apiJson` records what was POSTed; `uploadPhoto` returns
 * the shape `uploadPhotoOnce` returns on success (a canonical
 * `/api/uploads/<id>/<name>` uri plus `storagePath` and `storageKey`).
 *
 * WHY A STORAGE KEY IS THE THING ASSERTED
 *
 * A photograph is on the server when, and only when, the entry the server
 * stores names an object the server can fetch. A `file:///var/mobile/…` uri
 * names a path inside one phone's sandbox. The API accepts it without
 * complaint — `EntrySchema` types photos as `z.array(z.record(z.unknown()))`
 * — so a POST carrying four such photographs returns 201 and the sync badge
 * clears having uploaded nothing. That is the concealment, and it is why the
 * assertion has to be about the key rather than about the request succeeding.
 */

const SITE_ID = "site-brisbane-1";

/** Mirrors what `createStoredPhoto` hands back in new-entry.tsx. */
function capturedPhoto(n: number): Photo {
  return {
    id: `photo-${n}`,
    uri: `file:///var/mobile/Containers/Data/Application/A1B2/tmp/ImageManipulator/cap-${n}.jpg`,
    caption: "",
    timestamp: `2026-12-04T07:1${n}:00.000Z`,
    base64: `BASE64-BYTES-OF-PHOTO-${n}`,
    mimeType: "image/jpeg",
    latitude: -27.4705,
    longitude: 153.026,
  };
}

/**
 * The offline capture path, transcribed from `addEntry`'s `isNetworkError`
 * branch in data-context.tsx. Returns the photographs as captured.
 */
async function captureEntryWhileOffline(photoCount: number): Promise<Photo[]> {
  const photos = Array.from({ length: photoCount }, (_, i) => capturedPhoto(i + 1));
  const optimistic = {
    id: `pending-1764800000000`,
    siteId: SITE_ID,
    date: "2026-12-04",
    weather: "Fine, 31°C",
    crewCount: "4",
    notes: "Slab pour, grid C3–C7. Pump truck on site 0630.",
    photos,
    timestamp: "2026-12-04T07:20:00.000Z",
    createdAt: "2026-12-04T07:20:00.000Z",
    isPending: true,
  } as Entry;

  await savePhotoPayloads(photos);
  await enqueue({ type: "addEntry", payload: stripPhotoPayloads(optimistic) });
  return photos;
}

interface Recorder {
  deps: DrainDeps;
  posted: { path: string; body: Entry }[];
  uploaded: string[];
  released: string[];
  warnings: unknown[][];
}

function networkError(): Error {
  return new Error("Network request failed");
}

/**
 * @param failUploadOnCall 1-based index of the upload call that should fail
 *                         with a network error; 0 means none fail.
 */
function recorder(failUploadOnCall = 0): Recorder {
  const posted: { path: string; body: Entry }[] = [];
  const uploaded: string[] = [];
  const released: string[] = [];
  const warnings: unknown[][] = [];

  const deps: DrainDeps = {
    peekQueue,
    dequeue,
    isNetworkError,
    stripPhotoPayloads,
    hydratePhotos,
    deletePhotoPayloads: async (ids) => {
      released.push(...ids);
      await deletePhotoPayloads(ids);
    },
    isManagedMediaUri,
    updateQueuedPayload,
    apiJson: async (path, init) => {
      posted.push({ path, body: JSON.parse(init.body ?? "{}") as Entry });
      return { entry: {} };
    },
    uploadPhoto: async (photo) => {
      uploaded.push(photo.id);
      if (failUploadOnCall !== 0 && uploaded.length === failUploadOnCall) throw networkError();
      return {
        ...photo,
        uri: `/api/uploads/up-${photo.id}/${photo.id}.jpg`,
        storagePath: `up-${photo.id}/${photo.id}.jpg`,
        storageKey: `media/companies/c1/up-${photo.id}/${photo.id}.jpg`,
      };
    },
    onPending: () => {},
    warn: (...args) => warnings.push(args),
  };

  return { deps, posted, uploaded, released, warnings };
}

beforeEach(() => {
  resetAsyncStorageForTests();
});

/**
 * Positive control for the harness, and it must come first.
 *
 * Every assertion below is about what the drain did with a queued op. If the
 * substitute AsyncStorage silently failed, `peekQueue()` would return an empty
 * array, the drain would return immediately, and a test asserting "no
 * photograph lacks a storage key" would pass over an empty list — having
 * proved nothing. So: prove the real queue and the real payload store round
 * trip through the substitute before trusting anything else in this file.
 */
test("the harness persists through the real queue and payload store", async () => {
  const photos = await captureEntryWhileOffline(2);

  const queue = await peekQueue();
  assert.equal(queue.length, 1, "the capture path must have queued exactly one op");
  assert.equal(queue[0].type, "addEntry");

  const queued = queue[0].payload as Entry;
  assert.equal(queued.photos.length, 2, "the queued op must carry both photographs");
  assert.equal(
    queued.photos[0].base64,
    undefined,
    "the queue must not hold base64 — that is what the payload store is for"
  );

  const rehydrated = await hydratePhotos(queued.photos);
  assert.deepEqual(
    rehydrated.map((photo) => photo.base64),
    photos.map((photo) => photo.base64),
    "the payload store must return the captured bytes for both photographs"
  );
});

/**
 * Constraint (a) from the design: the bytes must survive an app restart.
 *
 * A restart loses every module-level variable and every React state value. It
 * does not lose AsyncStorage. This test drops all in-memory knowledge of the
 * photographs and reads them back through the store's own API, which is what
 * the drain will do on the next launch.
 */
test("the captured bytes survive a restart", async () => {
  const photos = await captureEntryWhileOffline(3);

  const keys = asyncStorageKeys();
  assert.ok(
    keys.includes("sitesnap.photoPayloads"),
    `the payloads must be in persistent storage, found keys: ${keys.join(", ")}`
  );
  assert.ok(keys.includes("sitesnap.offlineQueue"), "the queue must be in persistent storage too");

  // Everything the app held in memory is gone; only storage remains.
  const [afterRestart] = await peekQueue();
  const rehydrated = await hydratePhotos((afterRestart.payload as Entry).photos);
  assert.deepEqual(
    rehydrated.map((photo) => photo.base64),
    photos.map((photo) => photo.base64),
    "a restart must not lose the photographs"
  );
});

/**
 * Positive control for the fake uploader.
 *
 * Without this, a failure of the next test is ambiguous: it could mean the
 * drain never uploads, or it could mean the fake uploader does not return a
 * key. Pin the fake's contract so only the first reading is available.
 */
test("the fake uploader returns a managed uri and a storage key", async () => {
  const { deps } = recorder();
  const uploaded = await deps.uploadPhoto(capturedPhoto(1));

  assert.ok(uploaded.storageKey, "the fake must return a storage key");
  assert.ok(
    isManagedMediaUri(uploaded.uri),
    `the fake must return a managed uri, got ${uploaded.uri}`
  );
  assert.equal(
    isManagedMediaUri(capturedPhoto(1).uri),
    false,
    "and a freshly captured file:// uri must NOT read as managed"
  );
});

/**
 * THE DEFECT. AUDIT L28.
 */
test("an entry queued offline reaches the server with a storage key per photograph", async () => {
  await captureEntryWhileOffline(4);

  const { deps, posted, uploaded } = recorder();
  const result = await drainQueue(deps);

  // Positive controls. Each assertion below this block would pass just as
  // happily if the drain had never run at all.
  assert.equal(posted.length, 1, "the drain must have POSTed exactly one entry");
  assert.equal(posted[0].path, "/projects/entries");
  assert.equal(result.synced, 1, "the op must have been treated as synced");
  assert.equal(result.remaining, 0, "and must have left the queue");

  const body = posted[0].body;
  assert.equal(body.photos.length, 4, "the POSTed entry must still carry four photographs");

  // The defect, stated as the mechanism.
  assert.equal(
    uploaded.length,
    4,
    `the drain POSTed an entry with ${body.photos.length} photograph(s) after uploading ` +
      `${uploaded.length} of them. Every photograph on the entry must be uploaded before the POST.`
  );

  // The defect, stated as the symptom a reader of the data would see.
  const withoutKey = body.photos
    .filter((photo) => !photo.storageKey && !photo.storagePath)
    .map((photo) => photo.id);
  assert.deepEqual(
    withoutKey,
    [],
    `the server was sent ${body.photos.length} photograph(s), ${withoutKey.length} of which ` +
      `carry no storage key: ${withoutKey.join(", ")}. Nothing outside this phone can ` +
      `resolve them to bytes, and the POST succeeded, so the sync badge cleared.`
  );

  const localOnly = body.photos.filter((photo) => !isManagedMediaUri(photo.uri));
  assert.deepEqual(
    localOnly.map((photo) => photo.uri),
    [],
    "no photograph may reach the server still addressed by a path inside one phone's sandbox"
  );
});

/**
 * Constraint (b): cleaning up after a successful sync. AUDIT L6.
 *
 * The online path already releases a photograph's local base64 once the server
 * has it (`deletePhotoPayloads` in `deleteEntry` and `updateEntry`). The queued
 * path never did, so a photograph synced from the queue stayed duplicated in
 * AsyncStorage for the life of the install.
 */
test("a successful sync releases the local copy of the bytes", async () => {
  await captureEntryWhileOffline(2);

  const { deps, released } = recorder();
  await drainQueue(deps);

  assert.deepEqual(
    released.sort(),
    ["photo-1", "photo-2"],
    "both photographs' local payloads must be released once the server has them"
  );

  const leftover = await hydratePhotos([capturedPhoto(1), capturedPhoto(2)].map((p) => ({ ...p, base64: undefined })));
  assert.deepEqual(
    leftover.map((photo) => photo.base64),
    [undefined, undefined],
    "and must actually be gone from storage, not merely reported as released"
  );
});

/**
 * Constraint (d): partial failure must be survivable.
 *
 * Four photographs; the third upload fails on a dropped connection. The three
 * requirements, in the order they matter:
 *
 *   1. the op must not be lost
 *   2. the entry must not be posted claiming four photographs when two are up
 *   3. the retry must not re-upload the two that already succeeded
 *
 * (3) is not fussiness. `uploadPhotoOnce` is byte-identical-duplicate-prone by
 * design — AUDIT records the bucket holding the same six images twice — and a
 * ute driving in and out of coverage retries this loop repeatedly.
 */
test("a failed upload part-way through loses nothing and does not duplicate what succeeded", async () => {
  await captureEntryWhileOffline(4);

  const first = recorder(3);
  await drainQueue(first.deps);

  assert.equal(
    first.posted.length,
    0,
    `the entry must not be POSTed when a photograph failed to upload; it was POSTed ` +
      `with ${first.posted[0]?.body.photos.length ?? 0} photograph(s)`
  );

  const stillQueued = await peekQueue();
  assert.equal(stillQueued.length, 1, "the op must still be in the queue");

  // Positive control: the run really did get two photographs up before failing.
  assert.equal(first.uploaded.length, 3, "three upload attempts: two succeeded, the third failed");

  const second = recorder();
  await drainQueue(second.deps);

  assert.deepEqual(
    second.uploaded,
    ["photo-3", "photo-4"],
    `the retry must upload only what did not get through; it uploaded ${second.uploaded.join(", ")}`
  );
  assert.equal(second.posted.length, 1, "and must then POST the entry");
  assert.equal(
    second.posted[0].body.photos.filter((photo) => photo.storageKey).length,
    4,
    "with all four photographs carrying storage keys"
  );
});

/**
 * The constraint that bounds everything above: a photograph is not altered on
 * its way to the server. No re-encode, no recompress, no strip. The drain may
 * change where a photograph is addressed from; it may not change what it is.
 */
test("the drain does not alter a photograph beyond its address", async () => {
  const captured = await captureEntryWhileOffline(2);

  const { deps, posted } = recorder();
  await drainQueue(deps);

  const body = posted[0].body;
  for (const original of captured) {
    const sent = body.photos.find((photo) => photo.id === original.id);
    assert.ok(sent, `photograph ${original.id} must still be on the entry`);
    assert.equal(sent.caption, original.caption);
    assert.equal(sent.timestamp, original.timestamp, "the capture time must be untouched");
    assert.equal(sent.mimeType, original.mimeType, "the type must be untouched");
    assert.equal(sent.latitude, original.latitude, "the GPS fix must be untouched");
    assert.equal(sent.longitude, original.longitude, "the GPS fix must be untouched");
  }
});
