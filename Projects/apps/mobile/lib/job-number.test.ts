/**
 * The job-number rule, driven directly.
 *
 * `lib/job-number.ts` imports nothing from react-native, which is the whole
 * reason the rule lives there rather than inside app/site/[id].tsx: there is
 * no simulator and no device here, so a rule written in a screen could only be
 * verified by reading it — and reading it is exactly what failed last time.
 * The field shipped as `(site as { jobNumber?: string }).jobNumber`, a cast
 * onto a type with no such property, and was `undefined` for every site in
 * production from the day migration 011 added the column (AUDIT L118).
 *
 * BOTH CONTROLS ON EVERY ASSERTION. Each absence case is paired with a real
 * value in the same test, because a module whose every function returned ""
 * or null would satisfy the absence halves on their own.
 *
 * The portal carries the same tests against its byte-identical copy
 * (apps/supervisor-web/lib/job-number.test.ts). Both sides are tested rather
 * than one being tested and carried across by ci.sh's diff, because the belief
 * that the portal had no test harness is what left its runner out of two
 * sweeps (AUDIT L115, L117).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  JOB_NUMBER_MAX_LENGTH,
  normaliseJobNumber,
  hasJobNumber,
  formatJobNumber,
  matchesJobNumber,
} from "./job-number";

test("normalisation strips padding and leaves internal spacing alone", () => {
  assert.equal(normaliseJobNumber("   12-4   "), "12-4");
  assert.equal(normaliseJobNumber("\t2026-NW-00123\n"), "2026-NW-00123");

  // THE CONTROL that makes the two assertions above mean "trim" rather than
  // "remove whitespace". A reference written as "SITE 12 B" on a drawing must
  // read back as "SITE 12 B", or the number in the app is not the number on
  // the paper.
  assert.equal(normaliseJobNumber("  SITE 12 B  "), "SITE 12 B");
  assert.equal(normaliseJobNumber("SITE 12 B"), "SITE 12 B");
});

test("every form of absence normalises to the empty string", () => {
  // The empty string is the ONE absence state: the column is NOT NULL DEFAULT
  // '' (migration 011). null and undefined are accepted because a client built
  // against an older API, or a site assembled offline, can carry either.
  assert.equal(normaliseJobNumber(""), "");
  assert.equal(normaliseJobNumber("     "), "");
  assert.equal(normaliseJobNumber(null), "");
  assert.equal(normaliseJobNumber(undefined), "");

  // POSITIVE CONTROL in the same test: a real value is not swallowed. Without
  // it, a `normaliseJobNumber` that returned "" unconditionally would pass
  // every assertion above.
  assert.equal(normaliseJobNumber("REAL-1"), "REAL-1");
});

test("hasJobNumber separates a real value from all four absences", () => {
  assert.equal(hasJobNumber("2026-NW-00123"), true);
  assert.equal(hasJobNumber("0"), true, "the string zero is a job number, not an absence");

  assert.equal(hasJobNumber(""), false);
  assert.equal(hasJobNumber("   "), false);
  assert.equal(hasJobNumber(null), false);
  assert.equal(hasJobNumber(undefined), false);
});

test("formatJobNumber returns a label for a value and null for an absence", () => {
  assert.equal(formatJobNumber("12-4"), "Job #12-4");
  assert.equal(formatJobNumber("  12-4  "), "Job #12-4", "the label kept the input's padding");

  // NULL AND NOT "": a caller must branch. A function returning "" for absence
  // would let a badge with a border and padding render around nothing.
  assert.equal(formatJobNumber(""), null);
  assert.equal(formatJobNumber("   "), null);
  assert.equal(formatJobNumber(null), null);
  assert.equal(formatJobNumber(undefined), null);
});

test("formatJobNumber cannot produce the string this field shipped as for months", () => {
  // AUDIT L118, as an assertion rather than a comment. app/site/[id].tsx read
  // the field as `(site as { jobNumber?: string }).jobNumber` — a cast onto a
  // type with no such property — so the value was `undefined` on every site in
  // production. Anything that interpolated it produced "Job #undefined".
  for (const absent of ["", "   ", null, undefined]) {
    const label = formatJobNumber(absent);
    assert.equal(label, null);
    assert.ok(
      label === null || !/undefined|null|NaN/.test(label),
      `formatJobNumber(${JSON.stringify(absent)}) produced ${JSON.stringify(label)}`
    );
  }

  // POSITIVE CONTROL: the function does produce labels, so the loop above is
  // not passing because formatJobNumber always returns null.
  assert.equal(formatJobNumber("OK-1"), "Job #OK-1");
});

test("matching is a case-insensitive substring, and an empty query matches nothing", () => {
  assert.equal(matchesJobNumber("2026-NW-00123", "nw-001"), true);
  assert.equal(matchesJobNumber("2026-NW-00123", "2026"), true);
  assert.equal(matchesJobNumber("2026-NW-00123", "  NW  ".trim()), true);
  assert.equal(matchesJobNumber("  2026-NW-00123  ", "nw"), true, "padding on the stored value defeated the match");

  assert.equal(matchesJobNumber("2026-NW-00123", "se-9"), false);

  // An empty or whitespace-only needle matches NOTHING here. The callers
  // handle "no query" by not filtering at all; a `matches` that returned true
  // for an empty needle would quietly make every site a match for every other
  // field's search as well.
  assert.equal(matchesJobNumber("2026-NW-00123", ""), false);
  assert.equal(matchesJobNumber("2026-NW-00123", "    "), false);

  // And an absent job number matches nothing, including a query that is itself
  // empty — otherwise a site with no job number would join every result set.
  assert.equal(matchesJobNumber("", "nw"), false);
  assert.equal(matchesJobNumber(null, "nw"), false);
  assert.equal(matchesJobNumber(undefined, ""), false);
});

test("the cap is a usable length and normalisation does not shorten a value at it", () => {
  assert.equal(typeof JOB_NUMBER_MAX_LENGTH, "number");
  assert.ok(Number.isInteger(JOB_NUMBER_MAX_LENGTH), "the cap is not a whole number of characters");
  assert.ok(JOB_NUMBER_MAX_LENGTH > 1, "the cap admits no usable job number");

  // The client's `maxLength` and the API's `z.string().trim().max(...)` are the
  // same number by ci.sh's assert_job_number_cap_agrees. This is the half that
  // belongs here: a value at the cap must survive this module untouched, or
  // the input would allow exactly what the save then rejects.
  const atCap = "J".repeat(JOB_NUMBER_MAX_LENGTH);
  assert.equal(normaliseJobNumber(atCap).length, JOB_NUMBER_MAX_LENGTH);
  assert.equal(normaliseJobNumber(atCap), atCap);

  // And a value whose LENGTH is only at the cap once its padding is gone is
  // accepted, which is why the API trims before it measures.
  const paddedToOver = `  ${atCap}  `;
  assert.ok(paddedToOver.length > JOB_NUMBER_MAX_LENGTH);
  assert.equal(normaliseJobNumber(paddedToOver).length, JOB_NUMBER_MAX_LENGTH);
});
