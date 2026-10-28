import { test } from "node:test";
import assert from "node:assert/strict";

import { buildViewerShots, buildViewerShotsForRecords } from "./photo-viewer-set";

/**
 * The portal-only half of the viewer: which photographs are in the set, which
 * record each one belongs to, and what identity the ordering matched on.
 *
 * Every assertion here has its positive control in the same test, for the usual
 * reason: "the annotation was reported as orphaned" and "the grid lost the
 * photograph entirely" both satisfy a bare count, and "no cross-record
 * reordering happened" is satisfied just as well by a function that returned
 * nothing at all.
 */

type P = {
  uri: string;
  id?: string;
  kind?: "original" | "annotated";
  derivedFromId?: string;
};

const day = (date: string, photos: P[]) => ({ date, photos });

test("each annotation follows its own original, and every photograph is still there", () => {
  const entry = day("2026-10-18", [
    { uri: "a.jpg", id: "p1" },
    { uri: "b.jpg", id: "p2" },
    { uri: "a-marked.jpg", id: "p1-mark", kind: "annotated", derivedFromId: "p1" },
  ]);

  const ids = buildViewerShots(entry).map((shot) => shot.id);

  assert.deepEqual(ids, ["p1", "p1-mark", "p2"]);
  // Positive control on completeness: the reorder moved a photograph rather
  // than dropping one, and the count is the input's count.
  assert.equal(ids.length, entry.photos.length);
  assert.deepEqual([...ids].sort(), ["p1", "p1-mark", "p2"]);
});

test("a photograph with no id is identified by its uri, so it is never confused with another", () => {
  const entry = day("2026-10-18", [
    { uri: "legacy-one.jpg" },
    { uri: "legacy-two.jpg" },
  ]);

  const shots = buildViewerShots(entry);

  assert.deepEqual(shots.map((shot) => shot.id), ["legacy-one.jpg", "legacy-two.jpg"]);
  // The refusal that matters: two id-less photographs must not collapse onto
  // one identity. The positive control is that a photograph WITH an id still
  // uses it rather than its uri.
  assert.equal(new Set(shots.map((shot) => shot.id)).size, 2);
  assert.equal(buildViewerShots(day("2026-10-18", [{ uri: "x.jpg", id: "p9" }]))[0].id, "p9");
});

test("an annotation over an id-less original is reported as unmatched rather than attached to the wrong one", () => {
  const entry = day("2026-10-18", [
    { uri: "no-id.jpg" },
    { uri: "other.jpg", id: "p2" },
    { uri: "marked.jpg", id: "p1-mark", kind: "annotated", derivedFromId: "p1" },
  ]);

  const shots = buildViewerShots(entry);
  const marked = shots.find((shot) => shot.id === "p1-mark");

  // It is kept and moved to the end, not silently inserted after whichever
  // photograph happened to be first.
  assert.equal(shots.length, 3);
  assert.equal(shots[shots.length - 1].id, "p1-mark");
  assert.equal(marked?.derivedFromId, "p1");
  // Positive control: nothing in the set now claims to be the original it names.
  assert.equal(shots.some((shot) => shot.id === "p1"), false);
  assert.equal(shots.some((shot) => shot.id === "no-id.jpg"), true);
});

test("each photograph carries its own record, so a flattened grid can still name the day", () => {
  const monday = day("2026-10-19", [{ uri: "m1.jpg", id: "m1" }]);
  const tuesday = day("2026-10-20", [{ uri: "t1.jpg", id: "t1" }]);

  const shots = buildViewerShotsForRecords([monday, tuesday]);

  assert.deepEqual(shots.map((shot) => shot.entry.date), ["2026-10-19", "2026-10-20"]);
  // Positive control: the pairing is by identity, not by position — the shot
  // holds the very object it came from.
  assert.equal(shots[0].entry, monday);
  assert.equal(shots[1].entry, tuesday);
  assert.equal(shots[0].photo.uri, "m1.jpg");
});

test("ordering is per record: one day's orphan never lands after another day's photographs", () => {
  const monday = day("2026-10-19", [
    { uri: "m-mark.jpg", id: "m-mark", kind: "annotated", derivedFromId: "gone" },
    { uri: "m1.jpg", id: "m1" },
  ]);
  const tuesday = day("2026-10-20", [{ uri: "t1.jpg", id: "t1" }]);

  const ids = buildViewerShotsForRecords([monday, tuesday]).map((shot) => shot.id);

  // Monday's orphan goes last WITHIN MONDAY. Ordering the joined set instead
  // would have produced ["m1", "t1", "m-mark"] — Monday's evidence filed after
  // Tuesday's.
  assert.deepEqual(ids, ["m1", "m-mark", "t1"]);
  // Positive control: the orphan did move, so this is not just an untouched
  // input order being reported as success.
  assert.notDeepEqual(ids, ["m-mark", "m1", "t1"]);
});

test("a record with no photographs produces an empty set rather than throwing", () => {
  // Declared rather than inlined: a fresh literal with no `photos` key infers
  // the bare constraint and then trips the excess-property check on `date`.
  const noPhotosKey: { date: string; photos?: P[] } = { date: "2026-10-18" };
  assert.deepEqual(buildViewerShots(noPhotosKey), []);
  assert.deepEqual(buildViewerShots(day("2026-10-18", [])), []);
  assert.deepEqual(buildViewerShotsForRecords([]), []);
  // Positive control: the same functions do return shots when there are any.
  assert.equal(buildViewerShotsForRecords([day("2026-10-18", [{ uri: "a.jpg" }])]).length, 1);
});
