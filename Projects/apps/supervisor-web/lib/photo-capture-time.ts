/**
 * When a photograph was taken — the portal's copy of the rule.
 *
 * THIS IS A DELIBERATE DUPLICATE of apps/mobile/lib/photo-capture-time.ts's
 * `describeCaptureTime`, and the duplication is the uncomfortable part of it.
 * The rule cannot currently be shared: `@sitesnap/shared` emits .d.ts only, so
 * it cannot carry runtime code, and neither client depends on it. Putting the
 * rule behind an API call would mean the portal could not label a photograph
 * without a round trip, and would still leave mobile's copy as the one that
 * runs offline.
 *
 * So both copies exist, and the thing that defends them is that BOTH ARE
 * TESTED AGAINST THE SAME VECTORS. If you change the states or the prefix words
 * here, apps/mobile/lib/photo-capture-time.test.ts fails too, because the pairs
 * are pinned in both suites. Keep them in step; do not "improve" one.
 *
 * The rule itself, from mobile's doc comment, is the part that matters:
 * `legacy` is labelled "Added", never "Taken", because labelling a record time
 * as a capture time publishes a false capture time into a compliance record —
 * and doing that is worse than admitting ignorance.
 */

export type CaptureTimeState =
  /** A real capture time, from the camera shutter or the file's own EXIF. */
  | "known"
  /** The photograph carried no readable date. Established, not assumed. */
  | "unknown"
  /** Pre-PART-1 record: only a record-creation time exists. Never called "Taken". */
  | "legacy"
  /** Nothing at all. */
  | "missing";

/**
 * The fields of a photograph this rule reads. Declared structurally rather than
 * imported from `./api`, so the module stays free of anything a bundler has to
 * resolve and can be compiled by tsconfig.test.json for `node --test`.
 */
export type CaptureTimeFields = {
  capturedAt?: string;
  captureTimeSource?: "camera" | "exif" | "unknown";
  timestamp?: string;
};

/**
 * Returns the LABEL as well as the state, exactly as mobile does, for mobile's
 * stated reason: the two surfaces must not disagree about the same photograph,
 * so neither screen formats its own sentence.
 *
 * The date inside the sentence is still each platform's `toLocaleString`, so
 * the two can render the same instant with different punctuation. That is a
 * cosmetic difference in the same claim; the state and the prefix word — which
 * are what say whether this is a capture time at all — are identical by test.
 */
export function describeCaptureTime(
  photo: CaptureTimeFields,
  locale = "en-AU"
): { state: CaptureTimeState; label: string } {
  const format = (iso: string) => new Date(iso).toLocaleString(locale);
  if (photo.captureTimeSource === "unknown") {
    return { state: "unknown", label: "Date taken unknown" };
  }
  if (
    photo.capturedAt &&
    (photo.captureTimeSource === "camera" || photo.captureTimeSource === "exif")
  ) {
    return { state: "known", label: `Taken ${format(photo.capturedAt)}` };
  }
  if (photo.timestamp) {
    return { state: "legacy", label: `Added ${format(photo.timestamp)}` };
  }
  return { state: "missing", label: "No date recorded" };
}
