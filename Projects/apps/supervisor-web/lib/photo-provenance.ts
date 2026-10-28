/**
 * A photograph's provenance — the portal's copy of the rules.
 *
 * THIS IS A DELIBERATE DUPLICATE of apps/mobile/lib/photo-provenance.ts, for
 * the reason set out at the top of ./photo-capture-time.ts: the rule cannot be
 * shared today, and both copies are therefore tested against the same vectors
 * so a divergence fails a build instead of surfacing as the two surfaces
 * stating different things about the same photograph. The LOGIC below is
 * identical to mobile's, line for line. Only the field types differ: they are
 * declared structurally here rather than Picked from mobile's `Photo`, so this
 * module needs nothing a bundler has to resolve and can be compiled by
 * tsconfig.test.json for `node --test`.
 *
 * The four questions the full-screen viewer has to answer about one photograph:
 * when, where, who, and which record. "When" is already answered by
 * `describeCaptureTime` in `photo-capture-time.ts` and is deliberately NOT
 * duplicated here. This module answers the other three, plus the order the
 * viewer swipes through.
 *
 * The rule the whole module exists to enforce is the same one that produced
 * `capturedAt` as a field separate from `timestamp`: a compliance record must
 * never assert something it does not know. Each answer therefore comes back as
 * a STATE alongside its label, so a caller cannot accidentally render a
 * stand-in as the real thing, and "not recorded" is a first-class answer rather
 * than an empty string the UI quietly hides.
 */

export type PhotoPlace = { latitude?: number; longitude?: number };
export type PhotoAuthor = { kind?: "original" | "annotated"; annotatedBy?: string };
export type PhotoDerivation = {
  id: string;
  kind?: "original" | "annotated";
  derivedFromId?: string;
};
export type EntryContext = {
  date?: string;
  locationAddress?: string;
  ownerEmail?: string;
};

/** Metres-level precision. Five decimal places is ~1.1 m at the equator. */
const COORDINATE_PRECISION = 5;

export type PlaceState =
  /** The photograph carries its own coordinates. */
  | "photograph"
  /** The photograph carries none; the ENTRY's address is offered as a stand-in. */
  | "entry-stand-in"
  /** Neither the photograph nor the entry records where this was. */
  | "unknown";

export type PhotoPlaceLabel = {
  state: PlaceState;
  label: string;
  /** Present only in the `photograph` state, for a map link or a copy button. */
  coordinates?: { latitude: number; longitude: number };
};

/**
 * True only for a coordinate pair that could describe somewhere on Earth AND is
 * not the zero pair.
 *
 * `0, 0` is rejected on purpose. It is a real point in the Gulf of Guinea, so
 * this does lose a legitimate value for anyone photographing open ocean there —
 * and it is accepted as a cost, because `0, 0` reaching a record is
 * overwhelmingly a defaulted or zeroed field, and a defaulted coordinate drawn
 * on a map is a confident false statement about where evidence was gathered.
 * Degrading to "not recorded" is recoverable; a wrong pin is not.
 */
function isUsableCoordinate(latitude: unknown, longitude: unknown): latitude is number {
  if (typeof latitude !== "number" || typeof longitude !== "number") return false;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return false;
  if (latitude === 0 && longitude === 0) return false;
  return true;
}

/**
 * Where the photograph was taken — or, failing that, where the entry says the
 * work was, clearly marked as the entry's and not the photograph's.
 *
 * The `entry-stand-in` label names the entry explicitly for the same reason
 * `describeCaptureTime` says "Added" rather than "Taken": the site address is
 * where the diary was filed, which is usually but not always where any given
 * photograph was taken, and presenting it as the photograph's own location
 * would publish a location the record never captured.
 */
export function describePhotoPlace(
  photo: PhotoPlace,
  entry?: EntryContext | null
): PhotoPlaceLabel {
  if (isUsableCoordinate(photo.latitude, photo.longitude)) {
    const latitude = photo.latitude as number;
    const longitude = photo.longitude as number;
    return {
      state: "photograph",
      label: `${latitude.toFixed(COORDINATE_PRECISION)}, ${longitude.toFixed(COORDINATE_PRECISION)}`,
      coordinates: { latitude, longitude },
    };
  }
  const address = entry?.locationAddress?.trim();
  if (address) {
    return {
      state: "entry-stand-in",
      label: `No location on this photograph — entry logged at ${address}`,
    };
  }
  return { state: "unknown", label: "Location not recorded" };
}

export type AuthorState =
  /** An annotated copy, and the account that annotated it is on the record. */
  | "annotator"
  /**
   * An annotated copy whose annotator was never recorded. A fourth-state
   * sibling of `captureTimeSource` being absent: these derivatives predate the
   * field, and the entry's author is NOT a safe substitute for them.
   */
  | "annotator-unrecorded"
  /** An original. The entry's author is the nearest thing the record holds. */
  | "entry-author"
  /** No identity anywhere on the record. */
  | "unknown";

export type PhotoAuthorLabel = { state: AuthorState; label: string };

/**
 * Who this image is attributable to.
 *
 * Two deliberate limits, both visible in the labels rather than papered over:
 *
 * 1. A photograph carries no photographer field. The entry's author is who
 *    LOGGED the entry, which is why the `entry-author` label says exactly that
 *    instead of "Photographed by".
 * 2. An annotated copy must never inherit the entry author's name. Whoever
 *    annotated may be a manager editing someone else's entry, so attributing
 *    their drawing to the entry's author would put a false name against a mark
 *    made on evidence. Absent `annotatedBy`, the honest answer is that it is
 *    not recorded.
 */
export function describePhotoAuthor(
  photo: PhotoAuthor,
  entry?: EntryContext | null
): PhotoAuthorLabel {
  if (photo.kind === "annotated") {
    const annotator = photo.annotatedBy?.trim();
    return annotator
      ? { state: "annotator", label: `Annotated by ${annotator}` }
      : { state: "annotator-unrecorded", label: "Annotated by an unrecorded account" };
  }
  const owner = entry?.ownerEmail?.trim();
  return owner
    ? { state: "entry-author", label: `Entry logged by ${owner}` }
    : { state: "unknown", label: "Account not recorded" };
}

export type DerivationState =
  /** An original capture, or a record from before `kind` existed. */
  | "original"
  /** An annotated copy whose original is present in the same record. */
  | "annotation"
  /** An annotated copy whose original is no longer in the record. */
  | "annotation-orphaned";

export type PhotoDerivationLabel = { state: DerivationState; label: string };

/**
 * Whether this image is an original or a mark-up of one, and whether the
 * original it names is still here.
 *
 * `annotation-orphaned` is reported rather than smoothed over: an annotation
 * whose original has been removed is a drawing with nothing to compare it
 * against, and a viewer that silently calls it an annotation implies the
 * original is one swipe away when it is gone.
 */
export function describePhotoDerivation(
  photo: PhotoDerivation,
  photos: readonly PhotoDerivation[]
): PhotoDerivationLabel {
  if (photo.kind !== "annotated") {
    return { state: "original", label: "Original photograph" };
  }
  const hasOriginal = photos.some((candidate) => candidate.id === photo.derivedFromId);
  return hasOriginal
    ? { state: "annotation", label: "Annotated copy of a photograph in this entry" }
    : { state: "annotation-orphaned", label: "Annotated copy — the original is no longer in this entry" };
}

/** Which record the photograph belongs to. The work date, not the logged time. */
export function describePhotoRecord(entry?: EntryContext | null): string {
  return entry?.date ? `Site diary entry for ${entry.date}` : "Site diary entry";
}

/**
 * The order the viewer swipes through the photographs of one record.
 *
 * Each original keeps its stored position and its annotated copies follow it
 * immediately, so swiping forward from a photograph lands on the mark-up of
 * that same photograph rather than on an unrelated image several positions
 * away. Orphaned annotations — the original deleted — go last rather than being
 * dropped: every element of the input appears exactly once in the output, which
 * is what stops a reordering bug from hiding evidence.
 */
export function orderPhotosForViewer<T extends PhotoDerivation>(photos: readonly T[]): T[] {
  const annotationsByOriginal = new Map<string, T[]>();
  const orphans: T[] = [];
  const originals: T[] = [];

  const originalIds = new Set(
    photos.filter((photo) => photo.kind !== "annotated").map((photo) => photo.id)
  );

  for (const photo of photos) {
    if (photo.kind !== "annotated") {
      originals.push(photo);
      continue;
    }
    const parent = photo.derivedFromId;
    if (parent && originalIds.has(parent)) {
      const siblings = annotationsByOriginal.get(parent);
      if (siblings) siblings.push(photo);
      else annotationsByOriginal.set(parent, [photo]);
    } else {
      orphans.push(photo);
    }
  }

  const ordered: T[] = [];
  for (const original of originals) {
    ordered.push(original);
    const annotations = annotationsByOriginal.get(original.id);
    if (annotations) ordered.push(...annotations);
  }
  return ordered.concat(orphans);
}

/**
 * Move the viewer by `delta`, CLAMPED to the ends — it does not wrap.
 *
 * Wrapping would make "is there another photograph?" unanswerable by swiping:
 * the set would feel endless, and a reader checking they had seen all the
 * evidence could not tell when they had. Clamping lets the caller disable the
 * control at the boundary, which is the honest signal. Returns 0 for an empty
 * set so there is no -1 index to mishandle.
 */
export function stepPhotoIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  const target = Math.trunc(index) + Math.trunc(delta);
  if (target < 0) return 0;
  if (target > length - 1) return length - 1;
  return target;
}
