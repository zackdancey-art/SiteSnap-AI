import { orderPhotosForViewer } from "./photo-provenance";

/**
 * Which photographs the viewer steps through, and in what order.
 *
 * `orderPhotosForViewer` in `photo-provenance.ts` decides the ORDER and is the
 * pinned twin of mobile's copy. This module decides the SET, which is a
 * portal-only problem: mobile opens the viewer from inside one entry and
 * already has it, where the portal's Photos tab flattens every record on a site
 * into one grid and has to carry each photograph's record along with it.
 *
 * It lives in its own module rather than in the page because the identity
 * fallback below is a rule, not a rendering detail, and a rule inside a 1000-line
 * component with no test is a rule that will be "simplified" by the next person
 * who reads it.
 */

/** The fields of a photograph the viewer set is built from. Structural, so this module needs no bundler. */
export type ViewerPhoto = {
  uri: string;
  id?: string;
  kind?: "original" | "annotated";
  derivedFromId?: string;
};

/** The fields of a record the viewer set is built from. */
export type ViewerRecord<P extends ViewerPhoto> = { photos?: P[] };

/** One photograph with the record it belongs to, and the identity the ordering matched on. */
export type ViewerShot<P extends ViewerPhoto, E extends ViewerRecord<P>> = {
  id: string;
  kind?: "original" | "annotated";
  derivedFromId?: string;
  photo: P;
  entry: E;
};

/**
 * The photographs of ONE record, ordered.
 *
 * `id ?? uri` is the load-bearing line. `derivedFromId` points at an original's
 * `id`, and a row written before ids were assigned has none — so without a
 * fallback every such photograph would share the identity `undefined`, and
 * `orderPhotosForViewer` would match the first annotation it found against an
 * unrelated original and reorder the record's evidence on that basis. `uri` is
 * the right fallback because it is already this surface's identity for a
 * photograph: every signed-URL lookup in the page is keyed on it.
 *
 * The fallback does NOT invent a link. An annotation whose original has no id
 * still matches nothing, and `describePhotoDerivation` reports it as orphaned
 * rather than claiming the original is one step away. That is the designed
 * degradation: the set stays complete, and the label stays honest.
 */
export function buildViewerShots<P extends ViewerPhoto, E extends ViewerRecord<P>>(
  entry: E
): ViewerShot<P, E>[] {
  return orderPhotosForViewer(
    (entry.photos ?? []).map((photo) => ({
      id: photo.id ?? photo.uri,
      kind: photo.kind,
      derivedFromId: photo.derivedFromId,
      photo,
      entry,
    }))
  );
}

/**
 * Every record's photographs, each record ordered within itself and the results
 * concatenated.
 *
 * Ordering per record and then joining is not the same as ordering the joined
 * set, and the difference is the reason this function exists rather than one
 * `orderPhotosForViewer` call over everything: that function moves an orphaned
 * annotation to the END of whatever set it is handed, so ordering across a whole
 * site would lift a photograph out of its own record and drop it after an
 * unrelated day's evidence.
 */
export function buildViewerShotsForRecords<P extends ViewerPhoto, E extends ViewerRecord<P>>(
  entries: readonly E[]
): ViewerShot<P, E>[] {
  return entries.flatMap((entry) => buildViewerShots<P, E>(entry));
}
