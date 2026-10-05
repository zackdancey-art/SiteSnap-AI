import AsyncStorage from "@react-native-async-storage/async-storage";
import { Entry, Photo } from "@/lib/types";

export type StoredPhotoPayload = {
  base64?: string;
  mimeType?: string;
};

/** The whole device's photograph payloads, keyed by photograph id. */
export type PhotoPayloadMap = Record<string, StoredPhotoPayload>;

const PHOTO_PAYLOADS_KEY = "sitesnap.photoPayloads";

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

export async function savePhotoPayloads(photos: Photo[]) {
  const payloadMap = await readPhotoPayloadMap();
  photos.forEach((photo) => {
    if (!photo.id) return;
    if (!photo.base64) return;
    payloadMap[photo.id] = {
      base64: photo.base64,
      mimeType: photo.mimeType || "image/jpeg",
    };
  });
  await writePayloadMap(payloadMap);
}

export async function deletePhotoPayloads(photoIds: string[]) {
  if (photoIds.length === 0) return;
  const payloadMap = await readPhotoPayloadMap();
  photoIds.forEach((photoId) => {
    delete payloadMap[photoId];
  });
  await writePayloadMap(payloadMap);
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
