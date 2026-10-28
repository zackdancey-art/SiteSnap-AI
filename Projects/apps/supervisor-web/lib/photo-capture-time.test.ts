import { test } from "node:test";
import assert from "node:assert/strict";

import { describeCaptureTime } from "./photo-capture-time";

/**
 * The PINNED TWIN of the `describeCaptureTime` test in
 * apps/mobile/lib/photo-capture-time.test.ts.
 *
 * The vectors and the expected states and prefixes below are copied from that
 * suite deliberately. The portal and mobile must not say different things about
 * the same photograph, and with the rule duplicated in two packages the only
 * thing that can enforce that is both suites asserting the same pairs. Change
 * one and the other goes red.
 *
 * What is NOT pinned across the two surfaces is the formatted date inside the
 * sentence: each platform calls its own `toLocaleString`, so the same instant
 * can come out with different punctuation. The assertions below are therefore
 * on the state and the PREFIX WORD — which are what say whether this is a
 * capture time at all — plus, in the positive control, that the date rendered
 * is the one that was passed in.
 */

test("describeCaptureTime never labels a record time as a capture time", () => {
  const known = describeCaptureTime({
    capturedAt: "2026-10-03T01:23:45.000Z",
    captureTimeSource: "exif",
    timestamp: "2026-10-05T09:00:00.000Z",
  });
  assert.equal(known.state, "known");
  assert.match(known.label, /^Taken /);

  const unknown = describeCaptureTime({
    captureTimeSource: "unknown",
    timestamp: "2026-10-05T09:00:00.000Z",
  });
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.label, "Date taken unknown");
  assert.doesNotMatch(
    unknown.label,
    /Taken \d|2026/,
    "an unknown date must not render the record's timestamp as the capture time"
  );

  // A record written before these fields existed. Its timestamp is when the
  // record was made; calling that "Taken" would publish a false capture time.
  const legacy = describeCaptureTime({ timestamp: "2026-09-01T09:00:00.000Z" });
  assert.equal(legacy.state, "legacy");
  assert.match(legacy.label, /^Added /);
  assert.doesNotMatch(legacy.label, /Taken/);

  const missing = describeCaptureTime({ timestamp: "" });
  assert.equal(missing.state, "missing");
  assert.equal(missing.label, "No date recorded");
});

test("the capture time shown is the capturedAt, not the record timestamp", () => {
  // The positive control the refusals above need: when a real capture time
  // exists, the date in the sentence is THAT date. Without this, "state is
  // known" would pass equally well against a label built from `timestamp`.
  const label = describeCaptureTime(
    {
      capturedAt: "2026-10-03T01:23:45.000Z",
      captureTimeSource: "camera",
      timestamp: "2026-12-25T09:00:00.000Z",
    },
    "en-AU"
  ).label;
  assert.match(label, /3\/10\/2026/, "the capture date, rendered en-AU");
  assert.doesNotMatch(label, /25\/12\/2026/, "the record date must not appear");
});

test("a capturedAt with no established source is not treated as a capture time", () => {
  // The source field is what makes a capture time trustworthy. A `capturedAt`
  // with no source — or with source "unknown" — must not be labelled "Taken",
  // or a value written by some future code path would be published as fact.
  const sourceless = describeCaptureTime({
    capturedAt: "2026-10-03T01:23:45.000Z",
    timestamp: "2026-10-05T09:00:00.000Z",
  });
  assert.equal(sourceless.state, "legacy");
  assert.match(sourceless.label, /^Added /);

  const contradicted = describeCaptureTime({
    capturedAt: "2026-10-03T01:23:45.000Z",
    captureTimeSource: "unknown",
  });
  assert.equal(contradicted.state, "unknown");
  assert.doesNotMatch(contradicted.label, /2026/);

  // Positive control: adding a real source to the same record does produce a
  // capture time, so the two refusals above are about the source field rather
  // than about this timestamp being unreadable.
  assert.equal(
    describeCaptureTime({
      capturedAt: "2026-10-03T01:23:45.000Z",
      captureTimeSource: "exif",
    }).state,
    "known"
  );
});

test("an empty record produces a sentence rather than silence", () => {
  const empty = describeCaptureTime({});
  assert.equal(empty.state, "missing");
  assert.equal(empty.label, "No date recorded");
  // Positive control: the function is capable of returning something else.
  assert.notEqual(describeCaptureTime({ timestamp: "2026-09-01T09:00:00.000Z" }).state, "missing");
});
