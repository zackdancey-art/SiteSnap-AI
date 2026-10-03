import type { Photo } from "@/lib/types";

/**
 * One place that decides whether a photo can actually be shown.
 *
 * WHY THIS EXISTS
 *
 * A photo's `uri` goes through three different shapes in its life:
 *
 *   1. `file:///…`            straight off the camera or picker, before upload
 *   2. `/api/uploads/<id>/<name>`   what the API returns and what Postgres stores
 *   3. `https://api…/api/uploads/<id>/<name>?sig=…&exp=…`   signed, loadable
 *
 * Shape 2 is the trap. It is a real, correct, server-side path — the object it
 * names exists in S3 and the bytes come back with a 200 — but React Native's
 * <Image> has no base URL to resolve it against, so `source={{ uri: "/api/…" }}`
 * fails silently and leaves the parent view's backgroundColor showing. That is
 * how six photographs of a construction site rendered as six grey squares
 * indistinguishable from loading placeholders: the record said "6 photos" and
 * showed nothing, and nothing anywhere reported a failure.
 *
 * So "is this displayable" stops being a judgement each call site makes with an
 * ad-hoc truthiness check (`photo.uri ? … : photo.base64 ? … : undefined`, which
 * picks shape 2 over a perfectly good local payload) and becomes one function
 * with one answer. Callers that cannot display a photo are told WHY, so the UI
 * can say so instead of rendering an empty box.
 *
 * Everything here is pure and free of React and react-native imports, so it can
 * be reasoned about — and eventually tested — without a renderer.
 */

/** Matches the canonical media path, with or without a host and query string. */
const UPLOAD_PATH_PATTERN = /(\/api\/uploads\/[^?#]+)/;

/** Query params the signer adds; stripped to recover the canonical path. */
const SIGNING_PARAMS_PATTERN = /[?&](authToken|sig|exp)=[^&]*/g;

/**
 * Schemes <Image> can load on its own, with no base URL and no signature:
 * bundled/remote HTTP, inline data, and the local-file forms the camera roll
 * and image picker hand back.
 */
const LOADABLE_SCHEME_PATTERN = /^(https?|data|file|content|ph|asset|assets-library|blob):/i;

/**
 * Recover the canonical `/api/uploads/<id>/<filename>` path from any of the
 * three shapes above. Returns null for a local file, a data URI, or anything
 * that is not one of our media paths.
 */
export function toCanonicalPath(uri: string | undefined | null): string | null {
  if (!uri) return null;
  const cleaned = uri.replace(SIGNING_PARAMS_PATTERN, "").replace(/[?&]$/, "");
  const match = cleaned.match(UPLOAD_PATH_PATTERN);
  return match ? match[1] : null;
}

/** True when the uri names a remote object on our own API (signed or not). */
export function isManagedMediaUri(uri: string | undefined | null): boolean {
  return toCanonicalPath(uri) !== null;
}

/**
 * True when <Image source={{ uri }}> can load this on its own. A bare
 * `/api/uploads/…` path is deliberately NOT loadable — see the header.
 */
export function isLoadableUri(uri: string | undefined | null): boolean {
  if (!uri) return false;
  return LOADABLE_SCHEME_PATTERN.test(uri);
}

/** Why a photo cannot be displayed. Each maps to different user-facing wording. */
export type PhotoUnavailableReason =
  /** Stored on the server but this client has no signed URL for it yet. */
  | "unsigned"
  /** No uri and no local payload — there is nothing to show at all. */
  | "missing"
  /** A signed/absolute uri that the image loader rejected at runtime. */
  | "load-failed";

export type PhotoSource =
  | { status: "displayable"; uri: string }
  | { status: "unavailable"; reason: PhotoUnavailableReason };

/**
 * Decide what to show for a photo.
 *
 * Order matters: a locally held payload beats an unsigned server path, which is
 * the inverse of what every call site used to do. If the bytes are on the
 * device there is no reason to show nothing while waiting on a signature.
 */
export function resolvePhotoSource(photo: Pick<Photo, "uri" | "base64" | "mimeType">): PhotoSource {
  if (isLoadableUri(photo.uri)) {
    return { status: "displayable", uri: photo.uri };
  }
  if (photo.base64) {
    return {
      status: "displayable",
      uri: `data:${photo.mimeType || "image/jpeg"};base64,${photo.base64}`,
    };
  }
  if (isManagedMediaUri(photo.uri)) {
    return { status: "unavailable", reason: "unsigned" };
  }
  return { status: "unavailable", reason: "missing" };
}

/**
 * Plain language for the person holding the phone — and for the reader of an
 * exported PDF. No error codes, no "null", no mention of signatures: what is
 * wrong, and whether their evidence is at risk.
 */
export function describeUnavailable(reason: PhotoUnavailableReason): string {
  switch (reason) {
    case "unsigned":
      return "Image could not be loaded. It is stored safely — reopen the app while online to view it.";
    case "missing":
      return "This photo has no image attached. The record is incomplete.";
    case "load-failed":
      return "Image could not be loaded. Check your connection and try again.";
  }
}

/** Short form, for a thumbnail with no room for a sentence. */
export const UNAVAILABLE_SHORT_LABEL = "Image unavailable";

/**
 * Normalise a photo for persistence: store the canonical path, never a signed
 * URL. Signatures expire (2 h server-side), so a cache full of them is a cache
 * of things that will stop working, and it puts a bearer-equivalent credential
 * into AsyncStorage for no benefit — `attachSignedPhotoUris` re-signs on load.
 */
export function toStorablePhotoUri(uri: string | undefined | null): string {
  return toCanonicalPath(uri) ?? uri ?? "";
}

/**
 * Thrown when the server took a photograph's bytes but did not say where it
 * put them.
 *
 * A distinct type rather than a plain Error because the retry wrapper must be
 * able to recognise it. Every other upload failure is worth retrying; this one
 * is not, and retrying it is actively harmful — each attempt re-POSTs the same
 * bytes and leaves another orphaned object in the bucket, which is the same
 * duplicate-write defect `uploadPhotoOnce`'s own header describes.
 */
export class UploadAddressMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadAddressMissingError";
  }
}

/**
 * The canonical path from an upload response, or a throw.
 *
 * WHY THIS IS NOT AN INLINE EXPRESSION ANY MORE
 *
 * It used to be one, at the `POST /api/uploads` call site:
 *
 *     const canonicalPath = payload.url?.startsWith("/") ? payload.url : (payload.url || "");
 *
 * Read the fallbacks. A response with no `url` — a 200 whose body is `{}`, a
 * shape change, a proxy that rewrote the body — produced the empty string, and
 * the empty string was then written to the photograph's `uri` as though the
 * upload had succeeded. The queue dequeued the op, the local bytes were
 * released, and nothing threw, logged or reported. What remained was a record
 * asserting it held a photograph, with no address for one and no copy left on
 * the device.
 *
 * That is the failure this whole area exists to prevent, arrived at from the
 * opposite direction: not a photograph the server never received, but one it
 * received and could not name. So the absence of an address is now an error.
 * The op dead-letters, the person is told, and the bytes stay on the device —
 * the same handling as any other upload that did not complete.
 *
 * Note what is NOT in the thrown message: the offending value. A uri never goes
 * into an error that reaches telemetry (see `sync-telemetry-redaction.ts` — the
 * report has no field for one, deliberately, because a displayable media uri
 * carries an HMAC granting two hours of read access). The photograph's id says
 * which one it was; that is enough to investigate with.
 */
export function canonicalUploadPathFromResponse(
  url: unknown,
  photoId: string | undefined
): string {
  const canonical = typeof url === "string" ? toCanonicalPath(url.trim()) : null;
  if (!canonical) {
    throw new UploadAddressMissingError(
      `Photograph ${photoId || "(no id)"} was accepted by the server, but the response carried no usable upload address.`
    );
  }
  return canonical;
}
