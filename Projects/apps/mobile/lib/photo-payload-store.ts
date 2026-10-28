import AsyncStorage from "@react-native-async-storage/async-storage";
import { Entry, Photo } from "@/lib/types";
import { peekQueue } from "@/lib/offline-queue";
import {
  RetentionCandidate,
  RetentionPlan,
  RetentionPolicy,
  DEFAULT_RETENTION_POLICY,
  photoIdsPinnedByQueue,
  planPhotoPayloadRetention,
} from "@/lib/photo-payload-retention";

export type StoredPhotoPayload = {
  base64?: string;
  mimeType?: string;
  /**
   * When this payload was written, ISO 8601 — the clock the retention cap ages
   * against (AUDIT L6).
   *
   * OPTIONAL BECAUSE IT IS A LATE ADDITION. Every payload written before the
   * cap existed is on disk right now with no date on it, and those rows are
   * read back by this build. The retention planner reads an absent date as
   * "start the clock now" rather than "infinitely old", for the reason written
   * out in photo-payload-retention.ts: the other reading empties the device's
   * backlog on the first launch after the upgrade.
   */
  savedAt?: string;
};

/** The whole device's photograph payloads, keyed by photograph id. */
export type PhotoPayloadMap = Record<string, StoredPhotoPayload>;

/**
 * The one AsyncStorage key the whole payload map lives under.
 *
 * Exported so that a test seeding a backdated or undated payload — the two
 * states the retention cap exists to deal with, neither of which this module
 * has a writer for — addresses the same key the app does instead of a copy of
 * the string. A copy reads green against a renamed key.
 */
export const PHOTO_PAYLOADS_KEY = "sitesnap.photoPayloads";

/**
 * Reads the whole photograph payload map out of AsyncStorage.
 *
 * EXPORTED SO THAT A CALLER HYDRATING SEVERAL ARRAYS CAN READ IT ONCE.
 *
 * This is not a cheap lookup. It is one `getItem` returning, and one
 * `JSON.parse` over, EVERY base64 photograph payload still on the device —
 * which on a phone that has been offline for a week is tens of megabytes of
 * string held twice at once, raw and parsed. The cost is a function of the
 * device's entire backlog, not of the array being hydrated, and it is paid in
 * full even for an array of length zero.
 *
 * So `hydratePhotos` below is the ONE-ARRAY convenience only. Anything
 * hydrating N arrays calls this once and then `hydratePhotosFromMap` N times.
 * AUDIT L56 is what happens when it does not.
 */
export async function readPhotoPayloadMap(): Promise<PhotoPayloadMap> {
  try {
    const raw = await AsyncStorage.getItem(PHOTO_PAYLOADS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, StoredPhotoPayload>) : {};
  } catch {
    return {};
  }
}

async function writePayloadMap(value: PhotoPayloadMap) {
  await AsyncStorage.setItem(PHOTO_PAYLOADS_KEY, JSON.stringify(value));
}

export function stripPhotoPayloads<T extends { photos: Photo[] }>(entry: T): T {
  return {
    ...entry,
    photos: entry.photos.map((photo) => ({
      ...photo,
      base64: undefined,
      mimeType: photo.mimeType,
    })),
  };
}

/**
 * The retention pass, run inside a read/modify/write of the map that was
 * happening anyway.
 *
 * WHY IT IS HERE AND NOT ON A TIMER
 *
 * The map grows in exactly two places and shrinks in exactly two places, and
 * all four are this file. Both writers already pay the whole-map read that
 * `readPhotoPayloadMap`'s header describes, so enforcing the cap at the moment
 * of the write costs one extra `getItem` of the offline queue and nothing else
 * — no background task, no new storage round trip, and no window in which the
 * map is over the ceiling. A timer would add all three.
 *
 * `alwaysKeep` is the ids the calling write is itself putting in. They MUST be
 * pinned regardless of the queue, because the offline save path calls
 * `savePhotoPayloads(...)` BEFORE `enqueue(...)` — for a few milliseconds the
 * photograph exists in the map and in no queued op, and a ceiling pass that
 * trusted only the queue would be free to drop the very bytes it was asked to
 * keep.
 */
async function applyRetention(
  payloadMap: PhotoPayloadMap,
  alwaysKeep: readonly string[],
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY
): Promise<RetentionPlan> {
  const candidates: RetentionCandidate[] = Object.entries(payloadMap).map(([id, payload]) => ({
    id,
    savedAt: payload.savedAt,
    bytes: payload.base64?.length ?? 0,
  }));

  // The whole queue, failed ops included — see photoIdsPinnedByQueue. A read
  // that throws must not be read as "nothing is pinned": that is the one
  // failure mode here that loses a photograph, so it falls back to pinning
  // everything, which costs disk and nothing else.
  let pinned: string[];
  try {
    pinned = [...alwaysKeep, ...photoIdsPinnedByQueue(await peekQueue())];
  } catch {
    pinned = candidates.map((candidate) => candidate.id);
  }

  const plan = planPhotoPayloadRetention(candidates, pinned, now, policy);
  plan.evict.forEach((id) => {
    delete payloadMap[id];
  });
  const stampedAt = now.toISOString();
  plan.stamp.forEach((id) => {
    const payload = payloadMap[id];
    if (payload) payloadMap[id] = { ...payload, savedAt: stampedAt };
  });
  return plan;
}

export async function savePhotoPayloads(photos: Photo[]): Promise<RetentionPlan> {
  const payloadMap = await readPhotoPayloadMap();
  const now = new Date();
  const savedAt = now.toISOString();
  const justSaved: string[] = [];
  photos.forEach((photo) => {
    if (!photo.id) return;
    if (!photo.base64) return;
    payloadMap[photo.id] = {
      base64: photo.base64,
      mimeType: photo.mimeType || "image/jpeg",
      savedAt,
    };
    justSaved.push(photo.id);
  });
  const plan = await applyRetention(payloadMap, justSaved, now);
  await writePayloadMap(payloadMap);
  return plan;
}

export async function deletePhotoPayloads(photoIds: string[]): Promise<RetentionPlan | null> {
  if (photoIds.length === 0) return null;
  const payloadMap = await readPhotoPayloadMap();
  photoIds.forEach((photoId) => {
    delete payloadMap[photoId];
  });
  // The second enforcement point, and the one that reaches a device which has
  // stopped capturing. The drain calls this after every op it clears, so a
  // phone that is syncing a backlog ages the backlog out as it goes rather
  // than waiting for the next photograph to be taken.
  const plan = await applyRetention(payloadMap, [], new Date());
  await writePayloadMap(payloadMap);
  return plan;
}

/**
 * Re-attaches base64 to one array of photographs from a map ALREADY READ.
 *
 * Pure and synchronous, so hydrating a hundred arrays costs one storage read
 * rather than a hundred. Every multi-array caller goes through this.
 */
export function hydratePhotosFromMap(photos: Photo[], payloadMap: PhotoPayloadMap): Photo[] {
  return photos.map((photo) => ({
    ...photo,
    base64: photo.base64 || payloadMap[photo.id]?.base64,
    mimeType: photo.mimeType || payloadMap[photo.id]?.mimeType || "image/jpeg",
  }));
}

export async function hydrateEntriesWithPhotoPayloads(entries: Entry[]) {
  const payloadMap = await readPhotoPayloadMap();
  return entries.map((entry) => ({
    ...entry,
    photos: hydratePhotosFromMap(entry.photos, payloadMap),
  }));
}

export function stripPhotoArray(photos: Photo[]): Photo[] {
  return photos.map((photo) => ({
    ...photo,
    base64: undefined,
    mimeType: photo.mimeType,
  }));
}

/**
 * Hydrates ONE array, reading the device's whole payload map to do it.
 *
 * Correct for a single array and wrong in a loop — see `readPhotoPayloadMap`.
 */
export async function hydratePhotos(photos: Photo[]): Promise<Photo[]> {
  return hydratePhotosFromMap(photos, await readPhotoPayloadMap());
}
