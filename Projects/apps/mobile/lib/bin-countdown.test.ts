import { test } from "node:test";
import assert from "node:assert/strict";
import { describeBinAge, formatDeletedAt } from "./bin-countdown";

/**
 * The bin's countdown is the only number on the phone that tells someone how
 * long is left before records they are responsible for stop existing. There is
 * no simulator in this environment, so this file is the only place the strings
 * are ever executed.
 */

test("the countdown counts down, and says both halves", () => {
  assert.equal(
    describeBinAge({ deletedAt: "2026-10-18T09:00:00.000Z", daysInBin: 3 }, 90),
    "Deleted 3 days ago · 87 days left"
  );
  // Singular on both halves, because "1 days" is the tell that nobody ran it.
  assert.equal(
    describeBinAge({ deletedAt: "2026-10-20T09:00:00.000Z", daysInBin: 1 }, 2),
    "Deleted 1 day ago · 1 day left"
  );
  assert.equal(
    describeBinAge({ deletedAt: "2026-10-21T09:00:00.000Z", daysInBin: 0 }, 90),
    "Deleted today · 90 days left"
  );
});

test("a site past its retention period says it is due, not a negative number", () => {
  // It is still in the bin: nothing in the shipping API deletes it, so the only
  // honest statement is that it is due to be cleared.
  assert.equal(
    describeBinAge({ deletedAt: "2026-01-01T09:00:00.000Z", daysInBin: 90 }, 90),
    "Deleted 90 days ago · due to be cleared"
  );
  assert.equal(
    describeBinAge({ deletedAt: "2026-01-01T09:00:00.000Z", daysInBin: 140 }, 90),
    "Deleted 140 days ago · due to be cleared"
  );

  // CONTROL: the clamp has not swallowed the ordinary case into "due".
  assert.equal(
    describeBinAge({ deletedAt: "2026-10-20T09:00:00.000Z", daysInBin: 89 }, 90),
    "Deleted 89 days ago · 1 day left"
  );
});

test("no number is shown rather than a guessed one", () => {
  // daysInBin null: the API could not work it out. A countdown invented here
  // from the phone's clock is the defect this module exists to refuse -- the
  // phone's clock is the one that can be wrong by a year.
  const noCount = describeBinAge({ deletedAt: "2026-10-18T09:00:00.000Z", daysInBin: null }, 90);
  assert.match(noCount, /^Deleted /);
  assert.doesNotMatch(noCount, /left|due to be cleared/, "no countdown may be derived locally");

  // retentionDays null: the API sent no period. Same refusal, other direction.
  const noPeriod = describeBinAge({ deletedAt: "2026-10-18T09:00:00.000Z", daysInBin: 3 }, null);
  assert.equal(noPeriod, "Deleted 3 days ago");
  assert.doesNotMatch(noPeriod, /90/, "the retention period must never be hardcoded here");

  // An unreadable timestamp degrades to the bare word, not to "Invalid Date".
  assert.equal(describeBinAge({ deletedAt: "not-a-date", daysInBin: null }, 90), "Deleted");
  assert.equal(formatDeletedAt("not-a-date"), "");

  // CONTROL for all three: with both numbers present, both halves do appear.
  // Without this, every doesNotMatch above would also pass if describeBinAge
  // returned the empty string for everything.
  assert.equal(
    describeBinAge({ deletedAt: "2026-10-18T09:00:00.000Z", daysInBin: 3 }, 90),
    "Deleted 3 days ago · 87 days left"
  );
  assert.notEqual(formatDeletedAt("2026-10-18T09:00:00.000Z"), "");
});
