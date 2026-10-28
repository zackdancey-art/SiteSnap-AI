/**
 * Which photographs reach the report, and an honest account of the rest.
 *
 * AUDIT L93, L94 and L95 are three faces of one pipeline, and the audit says
 * the third is probably masking the first two: "L93 and L94's numbers cannot
 * be interpreted without knowing how many images were dropped rather than
 * capped." So all three are answered here, in one pure module, with the
 * arithmetic arranged so the numbers cannot disagree.
 *
 * L93 — THE CEILING TOOK THE TWELVE OLDEST. `buildVisionInputs` walked entries
 * in ascending date order and stopped at twelve images, so on any site logging
 * more than twelve photographs in the window — a week of normal capture on a
 * two-crew site — every image the model saw came from the earliest entries and
 * the reported progress was the progress at the start of the window.
 * `selectPhotographs` spreads the same twelve across the window instead:
 * round-robin by entry, so every day that photographed anything contributes an
 * image before any day contributes a second.
 *
 * THE CEILING ITSELF IS NOT CHANGED, DELIBERATELY. The audit calls which twelve
 * to keep "a cost decision, not a bug fix", because "spreading them across the
 * window, or raising the ceiling, changes the per-report token bill". Spreading
 * them does not: twelve images in, twelve images out, the same bill for a
 * report that now covers the whole window instead of its first few days. Raising
 * the ceiling does change the bill and is left alone.
 *
 * L94 — TWO NUMBERS THAT DISAGREED. The payload carried
 * `totalPhotosAttached: 12` beside per-entry counts summing to forty-seven,
 * with no statement of which twelve, and the model was observed reconciling
 * that by describing photographs it could not see. The fix is not a better
 * number, it is one source: `summarisePhotoOutcome` DERIVES `attached` by
 * subtraction rather than accepting it, so a payload where the parts do not add
 * up to the whole is not expressible. Per entry, `available` and `attached` are
 * both reported, so a day whose photographs were capped away says so.
 *
 * L95 — FIVE SILENT FAILURES. `normalizeBase64Image` returned `null` on five
 * distinct conditions and the caller did `if (!imageUrl) continue;` for all of
 * them, so a photograph refused by the cross-tenant ownership check was
 * indistinguishable in the output from a photograph nobody took. `PhotoDropReason`
 * names every one, the counts go to the response and the generation log, and
 * `PHOTO_DROP_REASONS` exists so a test can assert the list is complete rather
 * than trusting that it is.
 *
 * NOTHING IN THIS FILE TOUCHES A PHOTOGRAPH'S CONTENTS. It sorts, counts and
 * labels. Reading bytes, and the H7 ownership check that guards that read, stay
 * in `routes/ai.ts` where the actor is.
 */

/**
 * Why a selected photograph did not reach the model.
 *
 * One per `return null` in `normalizeBase64Image`, plus the read failure that
 * was the single path with a log line. These are reason CODES, not messages:
 * they go into telemetry and the response body, so they carry no filename, no
 * storage key and no caption — a storage key ends in the uploaded filename, and
 * the standing rule for this product's telemetry is identifiers and counts, no
 * personal content.
 */
export type PhotoDropReason =
  | "malformed-data-url"
  | "no-image-data"
  | "unresolvable-storage-key"
  | "non-canonical-storage-key"
  | "not-owned-by-company"
  | "storage-read-failed";

/**
 * Every reason, for a test to measure the enumeration against rather than a
 * hand-written count of it. AUDIT L95 is a defect of five paths sharing one
 * silent outcome; a seventh path added without a code here would recreate it.
 */
export const PHOTO_DROP_REASONS: readonly PhotoDropReason[] = [
  "malformed-data-url",
  "no-image-data",
  "unresolvable-storage-key",
  "non-canonical-storage-key",
  "not-owned-by-company",
  "storage-read-failed",
];

/**
 * The image ceiling for one report. Unchanged from the value L93 measured — see
 * the note above on why spreading is in scope and raising is not.
 */
export const MAX_REPORT_IMAGES = 12;

export type PhotoDropCounts = Partial<Record<PhotoDropReason, number>>;

type PhotoLike = { caption?: string; timestamp?: string };
type EntryLike<P extends PhotoLike> = { date?: string; locationAddress?: string; photos?: P[] };

/**
 * A photograph chosen for the report, carrying where it came from.
 *
 * `photoIndex` is the position within its OWN entry, not within the selection.
 * That is the whole point of it: see `photoCitation`.
 */
export type SelectedPhoto<P extends PhotoLike> = {
  entryIndex: number;
  photoIndex: number;
  entryDate: string;
  entryLocation: string;
  photo: P;
};

export type PhotoSelection<P extends PhotoLike> = {
  selected: SelectedPhoto<P>[];
  /** Per entry, by entryIndex: how many it has, how many were chosen. */
  perEntry: Array<{ available: number; selected: number }>;
  totalAvailable: number;
  ceiling: number;
  /** How many were left out BY THE CEILING, as opposed to failing to load. */
  droppedToCeiling: number;
  /** Entries that have photographs but got none under the ceiling. */
  entriesWithNoneSelected: number;
};

/**
 * How the reader of the report can find the photograph being described.
 *
 * The old instruction was `'Photo ' + includedImages` — a number assigned by
 * attachment order, which, as L93 puts it, "does not correspond to anything the
 * reader of the report can see". The reader has the document, which is organised
 * by date, and the entry, whose photographs appear in capture order in the app's
 * grid and are numbered that way by the mobile PDF export
 * (`apps/mobile/lib/export-utils.ts:735` prints `Photo ${index + 1}`). So the
 * date plus the within-entry position is a citation that resolves to one
 * photograph by the same numbering the reader already sees.
 *
 * An undated entry is said to be undated rather than given a date it never had.
 */
export function photoCitation(entryDate: string, photoIndex: number): string {
  const n = photoIndex + 1;
  const date = String(entryDate || "").trim();
  return date ? `${date} photo ${n}` : `photo ${n} of the undated entry`;
}

/**
 * Pick `count` positions evenly across `length`, first and last included.
 *
 * This is the part that makes the selection cover the WINDOW rather than the
 * start of it. Taking the first `count` entries is what L93 measured; walking
 * entries in order and stopping at the ceiling does the same thing in a
 * different shape, which is a mistake worth naming because it is the obvious
 * fix and it is still wrong: twelve images over a twenty-day month would be
 * days one to twelve, and the last eight days of progress would be as absent as
 * before. Both ends are pinned deliberately — the first day because a report
 * should start where the work started, the last because that is the state the
 * site is in now.
 *
 * Strictly increasing whenever `count <= length`, which is the only way it is
 * called, so the result needs no de-duplication.
 */
function evenlySpacedIndices(length: number, count: number): number[] {
  if (count <= 0 || length <= 0) return [];
  if (count >= length) return Array.from({ length }, (_, i) => i);
  // One image gets the most recent entry, not the oldest: a single-image report
  // showing the first morning of a month is the degradation L93 is about.
  if (count === 1) return [length - 1];
  return Array.from({ length: count }, (_, k) => Math.round((k * (length - 1)) / (count - 1)));
}

/**
 * Choose up to `ceiling` photographs, spread across the window.
 *
 * Two regimes, because a month of daily capture and a single busy day are
 * different problems:
 *
 *   - MORE DAYS THAN IMAGES. Take one photograph from each of `ceiling` days
 *     spaced evenly across the window, first and last day included. Twelve
 *     images over twenty days become twelve different days rather than the
 *     first twelve.
 *   - MORE IMAGES THAN DAYS. Round-robin by entry — one from each day that has
 *     any, then a second from each — so every day is represented before any day
 *     is represented twice, and the depth then goes to the days that have it.
 *
 * Both are deterministic and order-preserving, so the same window produces the
 * same selection on a retry and two API instances answering the same request
 * agree. Under the ceiling nothing is dropped at all, so a small site behaves
 * exactly as it did before this change.
 *
 * The result is returned in (entry, photo) order rather than selection order, so
 * the model receives the images chronologically and a citation it is given
 * matches the document it is writing.
 */
export function selectPhotographs<P extends PhotoLike, E extends EntryLike<P>>(
  entries: readonly E[],
  ceiling: number = MAX_REPORT_IMAGES
): PhotoSelection<P> {
  const limit = Number.isInteger(ceiling) && ceiling > 0 ? ceiling : 0;
  const perEntry = entries.map((entry) => ({
    available: Array.isArray(entry.photos) ? entry.photos.length : 0,
    selected: 0,
  }));
  const totalAvailable = perEntry.reduce((n, e) => n + e.available, 0);
  const selected: SelectedPhoto<P>[] = [];

  const take = (entryIndex: number, photoIndex: number): void => {
    const entry = entries[entryIndex];
    const photos = Array.isArray(entry.photos) ? entry.photos : [];
    const photo = photos[photoIndex];
    if (!photo) return;
    selected.push({
      entryIndex,
      photoIndex,
      entryDate: String(entry.date || "").trim(),
      entryLocation: String(entry.locationAddress || "").trim(),
      photo,
    });
    perEntry[entryIndex].selected += 1;
  };

  const withPhotos = perEntry
    .map((entry, index) => (entry.available > 0 ? index : -1))
    .filter((index) => index >= 0);

  if (withPhotos.length >= limit) {
    for (const position of evenlySpacedIndices(withPhotos.length, limit)) {
      take(withPhotos[position], 0);
    }
  } else {
    const deepest = perEntry.reduce((n, e) => Math.max(n, e.available), 0);
    for (let round = 0; round < deepest && selected.length < limit; round += 1) {
      for (const entryIndex of withPhotos) {
        if (selected.length >= limit) break;
        take(entryIndex, round);
      }
    }
  }

  selected.sort((a, b) =>
    a.entryIndex === b.entryIndex ? a.photoIndex - b.photoIndex : a.entryIndex - b.entryIndex
  );

  return {
    selected,
    perEntry,
    totalAvailable,
    ceiling: limit,
    droppedToCeiling: totalAvailable - selected.length,
    entriesWithNoneSelected: perEntry.filter((e) => e.available > 0 && e.selected === 0).length,
  };
}

/**
 * The reconciled account of a report's photographs.
 *
 * `attached` is DERIVED, never passed in. That is the fix for L94: the two
 * numbers the payload used to carry came from two places and disagreed by
 * thirty-five on a real month, and a model told both reconciled them by
 * describing photographs it had not been shown. Here the whole is the sum of
 * its parts by construction — `available` splits into `droppedToCeiling` plus
 * `selected`, and `selected` splits into `attached` plus the drop counts — so a
 * payload where they do not add up cannot be built.
 */
export type PhotoAccounting = {
  available: number;
  selected: number;
  attached: number;
  ceiling: number;
  droppedToCeiling: number;
  droppedByReason: PhotoDropCounts;
  droppedTotal: number;
};

export function summarisePhotoOutcome(args: {
  available: number;
  selected: number;
  ceiling: number;
  droppedByReason: PhotoDropCounts;
}): PhotoAccounting {
  const droppedTotal = PHOTO_DROP_REASONS.reduce(
    (n, reason) => n + (args.droppedByReason[reason] ?? 0),
    0
  );
  return {
    available: args.available,
    selected: args.selected,
    attached: args.selected - droppedTotal,
    ceiling: args.ceiling,
    droppedToCeiling: args.available - args.selected,
    droppedByReason: args.droppedByReason,
    droppedTotal,
  };
}

/**
 * The one sentence the model is given about what it is NOT looking at.
 *
 * L94's failure mode was a model reconciling a photograph count it could not
 * see with images it had, by inventing descriptions. Telling it the shortfall
 * explicitly, in the same object as the images, is the cheap half of the fix;
 * the SYSTEM_PROMPT requirement not to describe an image it was not shown is
 * the other half. Returns null when every photograph on every entry is attached
 * and there is nothing to disclose.
 */
export function describePhotoShortfall(accounting: PhotoAccounting): string | null {
  if (accounting.available === 0) return null;
  if (accounting.droppedToCeiling === 0 && accounting.droppedTotal === 0) return null;
  const parts: string[] = [
    `${accounting.attached} of ${accounting.available} photographs recorded in this period are attached below.`,
  ];
  if (accounting.droppedToCeiling > 0) {
    parts.push(
      `${accounting.droppedToCeiling} were omitted to stay within the ${accounting.ceiling}-image limit for one report; the attached images are spread across the period rather than taken from its first days.`
    );
  }
  if (accounting.droppedTotal > 0) {
    parts.push(`${accounting.droppedTotal} could not be loaded and are not attached.`);
  }
  parts.push(
    "Describe only the images attached to this request. Do not describe, infer or summarise the contents of any photograph that is not attached."
  );
  return parts.join(" ");
}
