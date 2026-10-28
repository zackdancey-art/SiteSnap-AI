import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describePhotoAuthor,
  describePhotoDerivation,
  describePhotoPlace,
  describePhotoRecord,
  orderPhotosForViewer,
  stepPhotoIndex,
} from "./photo-provenance";

/**
 * The PINNED TWIN of apps/mobile/lib/photo-provenance.test.ts.
 *
 * Every vector and every expected value below is identical to mobile's, on
 * purpose and by generation rather than by retyping. That identity is the whole
 * mechanism defending the duplicated rule: change a state name or a label on
 * one surface and this suite goes red on the other. If you are editing one of
 * these two files, you are editing both.
 *
 * What these tests are actually defending.
 *
 * The viewer puts four claims on screen next to a photograph in a compliance
 * record: when, where, who, and which entry. Each of them has a plausible wrong
 * answer sitting right next to the right one — the entry's address instead of
 * the photograph's coordinates, the entry's author instead of the annotator, a
 * defaulted `0, 0` instead of nothing. Every one of those substitutions reads as
 * a successful render, so none of them would be caught by looking at the screen.
 *
 * Every refusal below is therefore paired with a positive control on the same
 * function in the same test: a `state === "unknown"` assertion passes equally
 * well when the function correctly declined and when it was never wired up.
 */

const ENTRY = { date: "2026-10-18", locationAddress: "12 Bay Street, Sydney", ownerEmail: "logger@example.test" };
const SYDNEY = { latitude: -33.86785, longitude: 151.20732 };

test("a photograph with its own coordinates reports them, formatted from the input", () => {
  const got = describePhotoPlace(SYDNEY, ENTRY);
  assert.equal(got.state, "photograph");
  // The positive control for every refusal below: the numbers in the label are
  // derived from the argument, not a fixed string, and the machine-readable
  // pair is carried alongside so a map link uses the same value as the text.
  assert.equal(got.label, "-33.86785, 151.20732");
  assert.deepEqual(got.coordinates, SYDNEY);

  const elsewhere = describePhotoPlace({ latitude: -37.8142, longitude: 144.9632 }, ENTRY);
  assert.equal(elsewhere.label, "-37.81420, 144.96320");
});

test("the entry's address is a stand-in that never claims to be the photograph's location", () => {
  const standIn = describePhotoPlace({}, ENTRY);
  assert.equal(standIn.state, "entry-stand-in");
  assert.match(standIn.label, /No location on this photograph/);
  assert.match(standIn.label, /entry logged at 12 Bay Street, Sydney/);
  // No coordinate pair in this state, so a caller cannot drop a map pin on the
  // entry's address and present it as where the photograph was taken.
  assert.equal(standIn.coordinates, undefined);

  // Positive control: the same function on the same entry DOES produce a
  // located answer when the photograph carries one, and that answer does not
  // mention the entry's address at all.
  const located = describePhotoPlace(SYDNEY, ENTRY);
  assert.equal(located.state, "photograph");
  assert.doesNotMatch(located.label, /Bay Street/);
});

test("a defaulted 0, 0 is refused rather than pinned", () => {
  const zeroed = describePhotoPlace({ latitude: 0, longitude: 0 }, ENTRY);
  assert.equal(zeroed.state, "entry-stand-in");
  assert.equal(zeroed.coordinates, undefined);

  // Positive control: a zero in ONE axis is a real place and is accepted, so
  // the refusal above is specific to the zero pair and not a blanket distrust
  // of zero.
  const equator = describePhotoPlace({ latitude: 0, longitude: 151.20732 }, ENTRY);
  assert.equal(equator.state, "photograph");
  assert.equal(equator.label, "0.00000, 151.20732");
});

test("impossible and non-numeric coordinates are refused, and real ones are not", () => {
  for (const bad of [
    { latitude: 91, longitude: 0.1 },
    { latitude: -90.5, longitude: 0.1 },
    { latitude: 1, longitude: 181 },
    { latitude: 1, longitude: -180.5 },
    { latitude: Number.NaN, longitude: 151.2 },
    { latitude: -33.8, longitude: Number.POSITIVE_INFINITY },
    { latitude: -33.8, longitude: undefined },
    { latitude: undefined, longitude: 151.2 },
  ]) {
    const got = describePhotoPlace(bad, ENTRY);
    assert.equal(got.state, "entry-stand-in", `${JSON.stringify(bad)} must not be reported as a location`);
    assert.equal(got.coordinates, undefined);
  }

  // Positive control: the boundary values that ARE valid still pass, so the
  // range check rejects out-of-range values rather than everything.
  const pole = describePhotoPlace({ latitude: -90, longitude: 180 }, ENTRY);
  assert.equal(pole.state, "photograph");
  assert.equal(pole.label, "-90.00000, 180.00000");
});

test("with neither a photograph location nor an entry address, the answer is not recorded", () => {
  const nothing = describePhotoPlace({}, { date: "2026-10-18" });
  assert.equal(nothing.state, "unknown");
  assert.equal(nothing.label, "Location not recorded");

  // Positive control on the same call shape: adding only the address moves it
  // to the stand-in state, so "unknown" is a decision and not a dead end.
  assert.equal(describePhotoPlace({}, ENTRY).state, "entry-stand-in");

  // A whitespace-only address is not an address.
  assert.equal(describePhotoPlace({}, { date: "2026-10-18", locationAddress: "   " }).state, "unknown");
});

test("an annotation is attributed to its annotator, not to the entry's author", () => {
  const annotated = describePhotoAuthor(
    { kind: "annotated", annotatedBy: "manager@example.test" },
    ENTRY
  );
  assert.equal(annotated.state, "annotator");
  assert.equal(annotated.label, "Annotated by manager@example.test");
  // The entry's author is a DIFFERENT account in this fixture, and must not
  // appear: this is the substitution that would put a false name against a mark
  // drawn on evidence.
  assert.doesNotMatch(annotated.label, /logger@example\.test/);

  // Positive control: the same entry's author IS used for an original, so the
  // assertion above proves the annotator wins rather than that `entry` is
  // ignored entirely.
  const original = describePhotoAuthor({ kind: "original" }, ENTRY);
  assert.equal(original.state, "entry-author");
  assert.equal(original.label, "Entry logged by logger@example.test");
});

test("an annotation with no recorded annotator says so and borrows nobody's name", () => {
  for (const photo of [
    { kind: "annotated" as const },
    { kind: "annotated" as const, annotatedBy: "" },
    { kind: "annotated" as const, annotatedBy: "   " },
  ]) {
    const got = describePhotoAuthor(photo, ENTRY);
    assert.equal(got.state, "annotator-unrecorded");
    assert.doesNotMatch(got.label, /logger@example\.test/);
    assert.doesNotMatch(got.label, /@/, "no address at all, rather than a blank one");
  }

  // Positive control: the same function on the same entry does produce a named
  // annotator when one is recorded.
  assert.equal(
    describePhotoAuthor({ kind: "annotated", annotatedBy: "manager@example.test" }, ENTRY).state,
    "annotator"
  );
});

test("an original with no entry author reports no account rather than an empty one", () => {
  const got = describePhotoAuthor({ kind: "original" }, { date: "2026-10-18" });
  assert.equal(got.state, "unknown");
  assert.equal(got.label, "Account not recorded");

  // Positive control: supplying the author on the same shape names them.
  assert.equal(describePhotoAuthor({ kind: "original" }, ENTRY).state, "entry-author");
  // A record from before `kind` existed is an original, not an annotation.
  assert.equal(describePhotoAuthor({}, ENTRY).state, "entry-author");
});

test("derivation distinguishes an original, an annotation, and an orphaned annotation", () => {
  const original = { id: "a", kind: "original" as const };
  const annotation = { id: "b", kind: "annotated" as const, derivedFromId: "a" };
  const orphan = { id: "c", kind: "annotated" as const, derivedFromId: "gone" };
  const set = [original, annotation, orphan];

  assert.equal(describePhotoDerivation(original, set).state, "original");
  assert.equal(describePhotoDerivation(annotation, set).state, "annotation");

  const orphaned = describePhotoDerivation(orphan, set);
  assert.equal(orphaned.state, "annotation-orphaned");
  assert.match(orphaned.label, /no longer in this entry/);

  // Positive control for the orphan case: the SAME photograph is reported as a
  // normal annotation once its original is present, so the orphan state tracks
  // the set rather than being a property of that record.
  assert.equal(
    describePhotoDerivation(orphan, set.concat({ id: "gone", kind: "original" as const })).state,
    "annotation"
  );
  // And an annotation with no parent id at all is orphaned, not "original".
  assert.equal(describePhotoDerivation({ id: "d", kind: "annotated" }, set).state, "annotation-orphaned");
});

test("the viewer order puts each annotation directly after its own original", () => {
  const photos = [
    { id: "p1", kind: "original" as const },
    { id: "p2", kind: "original" as const },
    { id: "p1-mark", kind: "annotated" as const, derivedFromId: "p1" },
    { id: "p3", kind: "original" as const },
    { id: "p2-mark", kind: "annotated" as const, derivedFromId: "p2" },
    { id: "p1-mark-2", kind: "annotated" as const, derivedFromId: "p1" },
  ];
  const ordered = orderPhotosForViewer(photos).map((photo) => photo.id);
  assert.deepEqual(ordered, ["p1", "p1-mark", "p1-mark-2", "p2", "p2-mark", "p3"]);

  // The invariant that matters more than the exact order: nothing is lost and
  // nothing is duplicated. Both sides are MEASURED from the input, so this
  // cannot read green against a set of a different size.
  assert.equal(ordered.length, photos.length);
  assert.deepEqual([...ordered].sort(), photos.map((p) => p.id).sort());
});

test("an orphaned annotation is moved to the end, never dropped", () => {
  const photos = [
    { id: "orphan", kind: "annotated" as const, derivedFromId: "deleted" },
    { id: "p1", kind: "original" as const },
    { id: "p1-mark", kind: "annotated" as const, derivedFromId: "p1" },
  ];
  const ordered = orderPhotosForViewer(photos).map((photo) => photo.id);
  assert.deepEqual(ordered, ["p1", "p1-mark", "orphan"]);
  // Positive control on the same call: the orphan is PRESENT, so "moved to the
  // end" is not being satisfied by filtering it out.
  assert.ok(ordered.includes("orphan"));
  assert.equal(ordered.length, photos.length);

  assert.deepEqual(orderPhotosForViewer([]), []);
});

test("stepping clamps at both ends instead of wrapping", () => {
  // Positive control first: stepping does move, so the clamps below are not
  // passing because the function returns its input.
  assert.equal(stepPhotoIndex(1, 1, 4), 2);
  assert.equal(stepPhotoIndex(2, -1, 4), 1);

  assert.equal(stepPhotoIndex(0, -1, 4), 0, "back from the first must not wrap to the last");
  assert.equal(stepPhotoIndex(3, 1, 4), 3, "forward from the last must not wrap to the first");
  assert.equal(stepPhotoIndex(0, -99, 4), 0);
  assert.equal(stepPhotoIndex(3, 99, 4), 3);

  // An empty set has no valid index, and must not produce -1.
  assert.equal(stepPhotoIndex(0, 1, 0), 0);
  assert.equal(stepPhotoIndex(0, -1, 0), 0);
  // A single photograph cannot be stepped off.
  assert.equal(stepPhotoIndex(0, 1, 1), 0);
  assert.equal(stepPhotoIndex(0, -1, 1), 0);
});

test("the record line names the work date, and degrades without inventing one", () => {
  assert.equal(describePhotoRecord(ENTRY), "Site diary entry for 2026-10-18");
  // Positive control: the date in the label comes from the entry.
  assert.equal(describePhotoRecord({ date: "2026-01-02" }), "Site diary entry for 2026-01-02");
  // No entry, and no date substituted from anywhere.
  assert.equal(describePhotoRecord(null), "Site diary entry");
  assert.equal(describePhotoRecord(undefined), "Site diary entry");
  assert.doesNotMatch(describePhotoRecord({ date: "" }), /\d/);
});
