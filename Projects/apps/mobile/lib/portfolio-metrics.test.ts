import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_TONE_THRESHOLDS,
  approvalRate,
  approvalTone,
  derivePortfolioMetrics,
} from "./portfolio-metrics";

/**
 * WHY THESE TESTS EXIST
 *
 * The dashboard's figures are the whole point of the screen, and this
 * environment has no simulator to look at them in. So the arithmetic and the
 * guard live in a module with no React Native imports, and these are the only
 * verification the numbers get until someone opens the app. The RENDERING is in
 * the PR's device checklist, stated as unverified.
 *
 * The guard is the half worth reading. `eas update` reaches a phone whenever
 * the phone next launches and is batched separately from the API deploy, so a
 * bundle expecting `activeSites` can run against an API that does not send it.
 * The tests below pin what happens then: `null`, which the screen renders as an
 * em dash — not the word "undefined", and not a number quietly counted off the
 * capped bootstrap arrays.
 */

const FULL = {
  sites: 12,
  activeSites: 7,
  completedSites: 4,
  onHoldSites: 1,
  entries: 5000,
  diaries: 100,
  approvedDiaries: 81,
  draftDiaries: 19,
};

test("a complete summary derives every figure the cards show", () => {
  const m = derivePortfolioMetrics(FULL);
  assert.ok(m, "a complete summary must derive");
  assert.equal(m.active, 7);
  assert.equal(m.completed, 4);
  assert.equal(m.sites, 12);
  assert.equal(m.entries, 5000);
  assert.equal(m.diaries, 100);
  assert.equal(m.approved, 81);
  assert.equal(m.pending, 19);
  assert.equal(m.approvalRate, 81);

  // 5000 is above the API's default `limit = 200`, which is the figure this
  // screen used to show. Asserted as a number rather than a bound because the
  // defect was specifically that 5000 read as 200.
  assert.notEqual(m.entries, 200);
});

test("a summary missing any field derives nothing at all", () => {
  // One assertion per field, enumerated from the object, so adding a ninth
  // field to the wire type without adding it to the guard fails here.
  for (const key of Object.keys(FULL)) {
    const partial: Record<string, unknown> = { ...FULL };
    delete partial[key];
    assert.equal(
      derivePortfolioMetrics(partial),
      null,
      `a summary with no ${key} must not derive`
    );
  }

  // The positive control for the loop above: the same object, intact, DOES
  // derive. Without this line the loop passes just as well against a function
  // that returns null for everything.
  assert.ok(derivePortfolioMetrics(FULL), "the intact summary must still derive");
});

test("anything that is not a summary of numbers derives nothing", () => {
  for (const bad of [
    null,
    undefined,
    "ok",
    42,
    [],
    {},
    { ...FULL, entries: "5000" }, // a string where a number is expected
    { ...FULL, entries: null },
    { ...FULL, diaries: Number.NaN }, // finite, specifically: NaN renders as "NaN"
    { ...FULL, sites: Number.POSITIVE_INFINITY },
    { error: "Forbidden" }, // what a refusal body actually looks like
  ]) {
    assert.equal(derivePortfolioMetrics(bad), null, `derived from ${JSON.stringify(bad)}`);
  }

  assert.ok(derivePortfolioMetrics(FULL), "the intact summary must still derive");
});

test("the approval rate is a whole percent, and is 0 rather than NaN with no diaries", () => {
  assert.equal(approvalRate(81, 100), 81);
  assert.equal(approvalRate(1, 3), 33); // rounded, not truncated or floated
  assert.equal(approvalRate(2, 3), 67);
  assert.equal(approvalRate(100, 100), 100);
  assert.equal(approvalRate(0, 100), 0);

  // The division that would otherwise be 0/0. `assert.equal(NaN, 0)` fails, so
  // this is the assertion that keeps the word "NaN" out of a Text node.
  assert.equal(approvalRate(0, 0), 0);
  assert.equal(approvalRate(5, 0), 0);
  assert.equal(approvalRate(0, -1), 0);

  // And through the deriving function, since that is how the screen gets it.
  const none = derivePortfolioMetrics({ ...FULL, diaries: 0, approvedDiaries: 0, draftDiaries: 0 });
  assert.ok(none);
  assert.equal(none.approvalRate, 0);
});

test("the health colour changes at 80 and 50, on the boundary and either side of it", () => {
  // The thresholds the portal's health bar uses inline. Tested on the boundary
  // because `>=` versus `>` is the realistic way to get this wrong, and it
  // would be invisible — an amber bar at exactly 80% looks like a judgement
  // call, not a bug.
  assert.equal(approvalTone(100), "good");
  assert.equal(approvalTone(80), "good");
  assert.equal(approvalTone(79), "fair");
  assert.equal(approvalTone(50), "fair");
  assert.equal(approvalTone(49), "poor");
  assert.equal(approvalTone(0), "poor");

  // The thresholds are named, not literal, so this reads them back. If someone
  // changes the constant the boundary assertions above move with it and the
  // portal is then the one out of step — which is stated in the module.
  assert.equal(APPROVAL_TONE_THRESHOLDS.good, 80);
  assert.equal(APPROVAL_TONE_THRESHOLDS.fair, 50);
  assert.ok(Object.isFrozen(APPROVAL_TONE_THRESHOLDS));
});
