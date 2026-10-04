import type { Photo } from "./types";

/**
 * The pure half of photograph capture metadata: reading EXIF, and saying what a
 * capture time means in words.
 *
 * SEPARATE FROM `photo-capture.ts` DELIBERATELY, and not for tidiness. That
 * module imports expo-crypto, expo-file-system, expo-image-manipulator and
 * expo-image-picker, none of which `node --test` can load — so anything living
 * there is untestable off-device. These functions decide whether a record
 * states a true capture time or a false one, which is the last thing in this
 * codebase that should rest on a device pass and a careful read.
 *
 * Same reasoning, and same shape, as `lib/offline-drain.ts` (AUDIT L28): the
 * logic that matters is extracted so it can be driven directly.
 *
 * Nothing here may import React Native or expo. `tsconfig.test.json` lists this
 * file explicitly and the compile fails loudly if that changes.
 */

export type ExifBag = Record<string, unknown> | undefined | null;

/**
 * Reads the camera's coordinates out of the asset's own EXIF block.
 *
 * Carried over verbatim from the two screens. See AUDIT L32: this already runs
 * in production and the coordinates are already persisted in `photos_json`.
 */
export function extractGpsFromExif(exif: ExifBag): { latitude?: number; longitude?: number } {
  if (!exif) return {};
  const lat = exif["GPSLatitude"] ?? exif["GPS Latitude"];
  const lon = exif["GPSLongitude"] ?? exif["GPS Longitude"];
  const latRef = String(exif["GPSLatitudeRef"] ?? "N");
  const lonRef = String(exif["GPSLongitudeRef"] ?? "E");
  if (typeof lat !== "number" || typeof lon !== "number") return {};
  return {
    latitude: latRef === "S" ? -lat : lat,
    longitude: lonRef === "W" ? -lon : lon,
  };
}

/**
 * Reads the moment the photograph was actually taken out of its EXIF block.
 *
 * `DateTimeOriginal` is an EXIF-format local wall-clock string —
 * `"YYYY:MM:DD HH:MM:SS"`, colon-separated in the date as well as the time —
 * which `new Date()` cannot parse. It carries no timezone of its own;
 * `OffsetTimeOriginal` ("+13:00") does, when the camera wrote one, and is used
 * when present so the stored instant is unambiguous. Without it the string is
 * interpreted in the device's current zone, which is the best available reading
 * and is what every photo tool does.
 *
 * RETURNS UNDEFINED RATHER THAN GUESSING. A screenshot, a downloaded image, a
 * file that has been through a messaging app — all of these commonly arrive
 * with no date at all, and some cameras write a zeroed
 * `"0000:00:00 00:00:00"`. Every one of those must read as unknown. A record
 * dated today for a photograph taken last week is a false record, and it is
 * false precisely when someone is relying on it.
 */
export function readCaptureTimeFromExif(exif: ExifBag): string | undefined {
  if (!exif) return undefined;

  const raw =
    exif["DateTimeOriginal"] ??
    exif["DateTimeDigitized"] ??
    exif["DateTime"] ??
    exif["{Exif}DateTimeOriginal"];
  if (typeof raw !== "string") return undefined;

  // "2026:10:03 14:23:45" -> "2026-10-03T14:23:45"
  const match = raw.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second] = match;

  // A zeroed date is a camera writing a placeholder, not a date.
  if (year === "0000" || month === "00" || day === "00") return undefined;

  const offsetRaw = exif["OffsetTimeOriginal"] ?? exif["OffsetTime"];
  const offset =
    typeof offsetRaw === "string" && /^[+-]\d{2}:\d{2}$/.test(offsetRaw.trim())
      ? offsetRaw.trim()
      : "";

  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`);
  if (Number.isNaN(parsed.getTime())) return undefined;

  // A date before digital photography, or in the future, is a broken metadata
  // block rather than a capture time. Bounded rather than trusted, because the
  // whole point of this function is that a wrong date is worse than no date.
  const year_ = parsed.getUTCFullYear();
  if (year_ < 1990 || parsed.getTime() > Date.now() + 24 * 60 * 60 * 1000) return undefined;

  return parsed.toISOString();
}

/**
 * The one place that turns a photograph's capture metadata into words.
 *
 * FOUR STATES, SAID DIFFERENTLY — the point of this function is that they are
 * never collapsed into one sentence:
 *
 * - `known`   — a real capture time, from the shutter or from EXIF.
 * - `unknown` — chosen from the gallery, carrying no readable date. Said so.
 * - `legacy`  — a record created before `captureTimeSource` existed. Its
 *               `timestamp` is when the record was made, which for a gallery
 *               photograph may be long after it was taken. It is labelled
 *               "Added", never "Taken", because labelling a record time as a
 *               capture time publishes a false capture time into a compliance
 *               record — and doing that is worse than admitting ignorance.
 * - `missing`  — no usable time at all.
 *
 * Mobile and the portal must not disagree about the same photograph, so this
 * returns the label rather than each screen formatting its own.
 */
export type CaptureTimeState = "known" | "unknown" | "legacy" | "missing";

export function describeCaptureTime(
  photo: Pick<Photo, "capturedAt" | "captureTimeSource" | "timestamp">,
  locale = "en-AU"
): { state: CaptureTimeState; label: string } {
  const format = (iso: string) => new Date(iso).toLocaleString(locale);

  if (photo.captureTimeSource === "unknown") {
    return { state: "unknown", label: "Date taken unknown" };
  }

  if (photo.capturedAt && (photo.captureTimeSource === "camera" || photo.captureTimeSource === "exif")) {
    return { state: "known", label: `Taken ${format(photo.capturedAt)}` };
  }

  if (photo.timestamp) {
    return { state: "legacy", label: `Added ${format(photo.timestamp)}` };
  }

  return { state: "missing", label: "No date recorded" };
}
