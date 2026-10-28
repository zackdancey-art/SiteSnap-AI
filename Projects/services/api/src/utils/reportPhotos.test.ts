/**
 * The photograph selection and its arithmetic — AUDIT L93 and L94.
 *
 * Pure logic, no store, so it runs in the in-memory suite. The part of L95 that
 * needs the uploads table is in `storage/report-photos-db.test.ts`, and the
 * drop counting through the route's own function is in
 * `routes/report-photos.test.ts`.
 *
 * The first test is the one that matters. L93 is not a crash, it is a report
 * whose every image came from the first days of the window, so the assertion
 * has to be about WHICH photographs were chosen — and it is written as the
 * before-and-after, with the old "first twelve in order" selection computed in
 * the test from the same fixture so the two can be compared directly. A test
 * that only asserted "twelve were chosen" would have passed against the defect.
 */

process.env.NODE_ENV = "test";

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describePhotoShortfall,
  MAX_REPORT_IMAGES,
  PHOTO_DROP_REASONS,
  photoCitation,
  selectPhotographs,
  summarisePhotoOutcome,
  type PhotoDropReason,
} from "./reportPhotos";

/** 20 entries across a month, 3 photographs each: 60 available, ceiling 12. */
const monthOfEntries = () =>
  Array.from({ length: 20 }, (_, i) => ({
    date: `2026-03-${String(i + 1).padStart(2, "0")}`,
    locationAddress: "4 Payload Parade",
    photos: [
      { caption: `day ${i + 1} photo 1` },
      { caption: `day ${i + 1} photo 2` },
      { caption: `day ${i + 1} photo 3` },
    ],
  }));

test("the ceiling spreads across the window instead of taking the oldest twelve — L93", () => {
  const entries = monthOfEntries();
  const selection = selectPhotographs(entries, MAX_REPORT_IMAGES);

  // The ceiling is respected and the bill is unchanged: twelve images, as
  // before. This change is about WHICH twelve, not how many.
  assert.equal(selection.selected.length, 12);
  assert.equal(selection.totalAvailable, 60);
  assert.equal(selection.droppedToCeiling, 48);

  const chosenDates = selection.selected.map((s) => s.entryDate);

  // THE DEFECT, computed from the same fixture rather than described: the old
  // loop walked entries in ascending date order and stopped at twelve, which
  // takes three photographs each from the first four days and nothing after.
  const oldSelection = entries
    .flatMap((entry) => entry.photos.map(() => entry.date))
    .slice(0, 12);
  assert.deepEqual(
    [...new Set(oldSelection)],
    ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04"],
    "fixture check: the old selection covered four days of a twenty-day window"
  );

  // THE FIX: twelve distinct days, which is the most a twelve-image report can
  // cover, and the last day of the window is one of them.
  assert.equal(new Set(chosenDates).size, 12, "one photograph from each of twelve different days");
  assert.notDeepEqual(chosenDates, oldSelection);

  // BOTH ENDS, and no long blind stretch in between. This is the assertion the
  // first version of this module failed: walking entries in order and stopping
  // at twelve gives twelve different days and still covers only the first
  // twelve of twenty, so "twelve distinct days" alone does not establish that
  // the report spans the window.
  assert.equal(chosenDates[0], "2026-03-01", "the window must start where the work started");
  assert.equal(chosenDates[11], "2026-03-20", "the last day is the state the site is in now");
  const dayNumbers = chosenDates.map((d) => Number(d.slice(-2)));
  const gaps = dayNumbers.slice(1).map((day, i) => day - dayNumbers[i]);
  assert.equal(Math.max(...gaps), 2, "twelve images over twenty days leaves at most one day unseen between them");

  // Every chosen photograph is the FIRST of its day under this fixture, because
  // no day gets a second image until every day has had one.
  assert.deepEqual([...new Set(selection.selected.map((s) => s.photoIndex))], [0]);

  // Chronological order out, so the images arrive in the order the report reads.
  assert.deepEqual(chosenDates, [...chosenDates].sort());
});

test("under the ceiling nothing is dropped, and a deep entry is not starved", () => {
  // Positive control for the test above: the spreading must not become a cap of
  // its own on a site that photographs less than the ceiling.
  const small = [
    { date: "2026-03-01", photos: [{}, {}] },
    { date: "2026-03-02", photos: [{}] },
  ];
  const all = selectPhotographs(small, MAX_REPORT_IMAGES);
  assert.equal(all.selected.length, 3);
  assert.equal(all.droppedToCeiling, 0);
  assert.equal(all.entriesWithNoneSelected, 0);
  assert.deepEqual(all.perEntry, [
    { available: 2, selected: 2 },
    { available: 1, selected: 1 },
  ]);

  // And when one day carries nearly everything, the round-robin comes back for
  // it once the other days have had their first — so a ten-photograph day in a
  // three-day window is not reduced to one image.
  const lopsided = [
    { date: "2026-03-01", photos: Array.from({ length: 10 }, () => ({})) },
    { date: "2026-03-02", photos: [{}] },
    { date: "2026-03-03", photos: [{}] },
  ];
  const spread = selectPhotographs(lopsided, 6);
  assert.equal(spread.selected.length, 6);
  assert.deepEqual(
    spread.perEntry.map((e) => e.selected),
    [4, 1, 1],
    "every day is represented first, then the depth goes to the day that has it"
  );
  assert.equal(spread.entriesWithNoneSelected, 0);
});

test("a photograph is cited by something the report's reader can find — L93", () => {
  // The old instruction was 'Photo ' + attachment order, a number that appears
  // nowhere the reader can see. The date plus the within-entry position matches
  // the numbering the mobile export already prints.
  assert.equal(photoCitation("2026-03-02", 0), "2026-03-02 photo 1");
  assert.equal(photoCitation("2026-03-02", 2), "2026-03-02 photo 3");

  // An undated entry is said to be undated rather than given a date.
  assert.equal(photoCitation("", 1), "photo 2 of the undated entry");
  assert.equal(photoCitation("   ", 0), "photo 1 of the undated entry");

  // Citations across a selection are unique, which is what makes them usable as
  // references at all — and the old attachment-order numbering was unique while
  // being unresolvable, so uniqueness alone was never the missing property.
  const selection = selectPhotographs(monthOfEntries(), MAX_REPORT_IMAGES);
  const citations = selection.selected.map((s) => photoCitation(s.entryDate, s.photoIndex));
  assert.equal(new Set(citations).size, citations.length);
});

test("the attached count cannot disagree with the per-entry counts — L94", () => {
  // L94 is two numbers from two places. `attached` is derived here, so the only
  // way to state a wrong total is to state a wrong part.
  const accounting = summarisePhotoOutcome({
    available: 47,
    selected: 12,
    ceiling: 12,
    droppedByReason: { "not-owned-by-company": 2, "storage-read-failed": 1 },
  });

  assert.equal(accounting.attached, 9, "12 selected less 3 that could not be loaded");
  assert.equal(accounting.droppedToCeiling, 35);
  assert.equal(accounting.droppedTotal, 3);

  // The identity the old payload broke: every photograph recorded is accounted
  // for exactly once, as attached, capped, or failed.
  assert.equal(
    accounting.attached + accounting.droppedToCeiling + accounting.droppedTotal,
    accounting.available
  );

  // Positive control: with nothing dropped the identity still holds and the
  // numbers are the plain ones, so the arithmetic above is not an artefact of
  // the failure case.
  const clean = summarisePhotoOutcome({ available: 5, selected: 5, ceiling: 12, droppedByReason: {} });
  assert.equal(clean.attached, 5);
  assert.equal(clean.droppedToCeiling, 0);
  assert.equal(clean.droppedTotal, 0);
  assert.equal(clean.attached + clean.droppedToCeiling + clean.droppedTotal, clean.available);
});

test("every drop reason is enumerated, and the count is measured from the type — L95", () => {
  // The defect was five distinct conditions sharing one silent outcome. This
  // asserts the enumeration is complete against a list written out by hand in
  // the test, so adding a sixth code without adding it to PHOTO_DROP_REASONS —
  // which is what the counting and the response read — fails here.
  const expected: PhotoDropReason[] = [
    "malformed-data-url",
    "no-image-data",
    "unresolvable-storage-key",
    "non-canonical-storage-key",
    "not-owned-by-company",
    "storage-read-failed",
  ];
  assert.deepEqual([...PHOTO_DROP_REASONS].sort(), expected.sort());
  assert.equal(new Set(PHOTO_DROP_REASONS).size, PHOTO_DROP_REASONS.length);

  // And a reason absent from the list is not silently counted into the total:
  // the summary sums over the enumeration, so an unlisted code contributes
  // nothing and the identity above would expose it rather than absorb it.
  const withUnlisted = summarisePhotoOutcome({
    available: 3,
    selected: 3,
    ceiling: 12,
    droppedByReason: { "made-up-reason": 1 } as never,
  });
  assert.equal(withUnlisted.droppedTotal, 0);
  assert.equal(withUnlisted.attached, 3);
});

test("the model is told what it is not being shown, and only when there is something to say", () => {
  const capped = describePhotoShortfall(
    summarisePhotoOutcome({ available: 47, selected: 12, ceiling: 12, droppedByReason: { "storage-read-failed": 1 } })
  );
  assert.ok(capped);
  assert.match(capped!, /11 of 47 photographs/);
  assert.match(capped!, /35 were omitted to stay within the 12-image limit/);
  assert.match(capped!, /1 could not be loaded/);
  assert.match(capped!, /Do not describe, infer or summarise the contents of any photograph that is not attached/);

  // NEGATIVE, with the positive control above in the same test: a report whose
  // every photograph is attached says nothing, because a notice explaining that
  // nothing is missing is noise in a compliance document.
  assert.equal(
    describePhotoShortfall(summarisePhotoOutcome({ available: 4, selected: 4, ceiling: 12, droppedByReason: {} })),
    null
  );
  // Nor does a period with no photographs at all get a notice about photographs.
  assert.equal(
    describePhotoShortfall(summarisePhotoOutcome({ available: 0, selected: 0, ceiling: 12, droppedByReason: {} })),
    null
  );
});
