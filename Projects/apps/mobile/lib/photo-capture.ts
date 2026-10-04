import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import type * as ImagePicker from "expo-image-picker";

import type { Photo } from "@/lib/types";
import {
  extractGpsFromExif,
  readCaptureTimeFromExif,
  type ExifBag,
} from "@/lib/photo-capture-time";

// Re-exported so call sites have one import for "photograph capture", while the
// pure half stays in a module `node --test` can load. See
// `photo-capture-time.ts` for why that split exists.
export {
  extractGpsFromExif,
  readCaptureTimeFromExif,
  describeCaptureTime,
  CAPTION_MAX_LENGTH,
  type CaptureTimeState,
} from "@/lib/photo-capture-time";

/**
 * Turning a picked or photographed asset into a `Photo` record.
 *
 * WHY THIS MODULE EXISTS
 *
 * `createStoredPhoto` and `extractGpsFromExif` were written twice —
 * `app/new-entry.tsx` and `app/inspections/[siteId].tsx` — with the second
 * carrying a comment saying it mirrored the first. Two copies of the code that
 * decides what a photograph's metadata says is a drift hazard in the one place
 * the product cannot afford one: the moment a record is created. They are one
 * function here, and both screens call it.
 *
 * WHAT IS AND IS NOT DONE TO THE IMAGE
 *
 * `manipulateAsync` is called with an EMPTY action list, so nothing is resized,
 * cropped or rotated. It does re-encode to JPEG at `compress: COMPRESS_QUALITY`
 * — that is pre-existing behaviour, deliberately left alone here, and it is the
 * reason every read of the original's metadata below happens BEFORE this call.
 */

/**
 * Unchanged from the two copies this module replaces. Stated as a constant so
 * the compression quality is one number rather than two literals that can
 * disagree.
 */
const COMPRESS_QUALITY = 0.55;

/**
 * The picker's own `mimeType` is ignored on purpose: whatever came in, what
 * leaves `manipulateAsync` below is a JPEG, so claiming anything else would
 * mislabel the bytes actually stored. Carried over verbatim.
 */
function normalizeImageMimeType(_mimeType?: string | null) {
  return "image/jpeg";
}

/**
 * SHA-256 over the bytes that are uploaded — not the bytes that were picked.
 *
 * This matters more than it reads. `manipulateAsync` re-encodes the image, so a
 * hash taken from the asset the picker handed over would describe a file that
 * never reaches the server, and every later verification against the stored
 * object would fail. So this runs on `manipulateAsync`'s OUTPUT file, which is
 * the exact path `uploadPhotoOnce` hands to FormData.
 *
 * The queued/offline path reconstructs that same file from the base64 in
 * AsyncStorage (`lib/photo-bytes.ts`), and base64 is a lossless encoding of the
 * same bytes, so the hash holds across a capture that syncs days later.
 *
 * Returns undefined rather than throwing: a photograph that cannot be hashed is
 * still evidence worth keeping, and failing the capture over a missing checksum
 * would trade a real photograph for a metadata field.
 */
export async function hashUploadedBytes(uri: string): Promise<string | undefined> {
  try {
    const bytes = await new File(uri).bytes();
    const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return undefined;
  }
}

/** Where a photograph came from. Decides how its capture time is established. */
export type CaptureSource = "camera" | "gallery";

export type StoredPhoto = Photo & { base64: string };

/**
 * Builds the stored record for one picked or photographed asset.
 *
 * THE CAPTURE TIME, WHICH IS THE WHOLE POINT
 *
 * - `camera` — the shutter just fired, so the capture time is now, and it is
 *   known. `captureTimeSource: "camera"`.
 * - `gallery` with a readable `DateTimeOriginal` — that is the capture time,
 *   whenever it was. `captureTimeSource: "exif"`.
 * - `gallery` with nothing readable — `capturedAt` is left ABSENT and
 *   `captureTimeSource: "unknown"`. It does not fall back to now. The UI shows
 *   it as unknown.
 *
 * `timestamp` is left exactly as it was — the moment this record was created —
 * because existing records already mean that by it and changing its meaning
 * would retroactively relabel every photograph already stored. `capturedAt` is
 * the new, separate field that means what it says.
 */
export async function createStoredPhoto(
  asset: ImagePicker.ImagePickerAsset,
  source: CaptureSource
): Promise<StoredPhoto> {
  // Read the original's metadata BEFORE anything touches the image. Whether
  // EXIF survives `manipulateAsync` is explicitly unverified (AUDIT L32), so
  // nothing downstream of that call is trusted to still carry it.
  const exif = asset.exif as ExifBag;
  const gps = extractGpsFromExif(exif);
  const exifCaptureTime = readCaptureTimeFromExif(exif);

  const manipulated = await manipulateAsync(asset.uri, [], {
    compress: COMPRESS_QUALITY,
    format: SaveFormat.JPEG,
    base64: true,
  });

  const now = new Date().toISOString();
  const capturedAt = source === "camera" ? now : exifCaptureTime;
  const captureTimeSource: Photo["captureTimeSource"] =
    source === "camera" ? "camera" : exifCaptureTime ? "exif" : "unknown";

  const contentSha256 = await hashUploadedBytes(manipulated.uri);

  return {
    id: Crypto.randomUUID(),
    uri: manipulated.uri,
    caption: "",
    timestamp: now,
    ...(capturedAt ? { capturedAt } : {}),
    captureTimeSource,
    ...(contentSha256 ? { contentSha256 } : {}),
    base64: manipulated.base64 || asset.base64 || "",
    mimeType: normalizeImageMimeType(asset.mimeType),
    ...gps,
  };
}
