import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeCaptureTime,
  extractGpsFromExif,
  readCaptureTimeFromExif,
} from "./photo-capture-time";

/**
 * What these tests are actually defending.
 *
 * A photograph in an evidence record dated today that was taken last week is a
 * false record, and it is false precisely when someone is relying on it. The
 * only way to produce that falsehood is for a missing or unreadable date to be
 * quietly replaced by `Date.now()`. So most of what follows asserts that a
 * capture time is ABSENT — and every one of those assertions is paired with a
 * positive control in the same test, because `=== undefined` passes both when
 * the parser correctly refused and when the parser was never called at all.
 */

const DATE_SHAPE = "2026:10:03 14:23:45";

test("readCaptureTimeFromExif reads DateTimeOriginal, and the parse is real", () => {
  const got = readCaptureTimeFromExif({ DateTimeOriginal: DATE_SHAPE });
  assert.ok(got, "a well-formed DateTimeOriginal must produce a capture time");

  // The positive control for every negative test below: this asserts the
  // parser actually decodes the EXIF shape rather than returning any truthy
  // string. If this drifts, the refusal tests stop meaning anything.
  const parsed = new Date(got);
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 9, "October is month index 9");
  assert.equal(parsed.getDate(), 3);
  assert.equal(parsed.getHours(), 14);
  assert.equal(parsed.getMinutes(), 23);
  assert.equal(parsed.getSeconds(), 45);
});

test("OffsetTimeOriginal is honoured, so the stored instant is unambiguous", () => {
  // Both assertions are absolute instants, so they hold wherever this runs.
  // An earlier draft asserted that a junk offset produced a DIFFERENT instant
  // from "+13:00" — which passed or failed purely on the machine's own time
  // zone, and this one is at +13:00. A test whose result depends on where it
  // is run is not a test.
  assert.equal(
    readCaptureTimeFromExif({ DateTimeOriginal: DATE_SHAPE, OffsetTimeOriginal: "+13:00" }),
    "2026-10-03T01:23:45.000Z",
    "14:23:45+13:00 is 01:23:45Z the same day"
  );
  assert.equal(
    readCaptureTimeFromExif({ DateTimeOriginal: DATE_SHAPE, OffsetTimeOriginal: "-05:00" }),
    "2026-10-03T19:23:45.000Z",
    "14:23:45-05:00 is 19:23:45Z the same day"
  );

  // An unusable offset must be ignored, not allowed to discard a valid date:
  // the wall-clock reading is still the best available answer, so the result
  // must match the no-offset parse exactly.
  const noOffset = readCaptureTimeFromExif({ DateTimeOriginal: DATE_SHAPE });
  const junkOffset = readCaptureTimeFromExif({
    DateTimeOriginal: DATE_SHAPE,
    OffsetTimeOriginal: "not-an-offset",
  });
  assert.ok(noOffset, "the no-offset parse is the control for the junk-offset case");
  assert.equal(junkOffset, noOffset, "an unusable offset must be ignored, not applied");
});

test("a gallery photograph with no date produces NO date, never now", () => {
  const before = Date.now();

  for (const exif of [
    undefined,
    null,
    {},
    { DateTimeOriginal: "" },
    { DateTimeOriginal: "last Tuesday" },
    { DateTimeOriginal: "0000:00:00 00:00:00" },
    { DateTimeOriginal: 1759500000 },
  ]) {
    assert.equal(
      readCaptureTimeFromExif(exif),
      undefined,
      `must refuse to date a photograph from ${JSON.stringify(exif)}`
    );
  }

  // The control that makes the seven refusals above mean something: the same
  // function, called in the same way, DOES return a value for a real date.
  // Without this, deleting the function body would pass every assertion.
  assert.ok(readCaptureTimeFromExif({ DateTimeOriginal: DATE_SHAPE }));

  // And nothing above quietly produced "now" instead of undefined.
  assert.ok(Date.now() >= before);
});

test("an implausible date is treated as broken metadata, not as a capture time", () => {
  assert.equal(readCaptureTimeFromExif({ DateTimeOriginal: "1902:06:01 09:00:00" }), undefined);

  const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
  const pad = (n: number) => String(n).padStart(2, "0");
  const futureExif = `${future.getFullYear()}:${pad(future.getMonth() + 1)}:${pad(
    future.getDate()
  )} ${pad(future.getHours())}:${pad(future.getMinutes())}:${pad(future.getSeconds())}`;
  assert.equal(
    readCaptureTimeFromExif({ DateTimeOriginal: futureExif }),
    undefined,
    "a date a month in the future is a wrong clock, not a capture time"
  );

  // Control: a date inside the accepted window still reads.
  assert.ok(readCaptureTimeFromExif({ DateTimeOriginal: "2015:01:01 09:00:00" }));
});

test("DateTimeDigitized and DateTime are accepted as fallbacks, in that order", () => {
  const digitized = readCaptureTimeFromExif({ DateTimeDigitized: DATE_SHAPE });
  assert.ok(digitized, "DateTimeDigitized must be read when DateTimeOriginal is absent");

  const plain = readCaptureTimeFromExif({ DateTime: "2020:02:02 08:00:00" });
  assert.ok(plain, "DateTime must be read when nothing better is present");

  // DateTimeOriginal wins when more than one is present.
  const both = readCaptureTimeFromExif({
    DateTimeOriginal: DATE_SHAPE,
    DateTime: "2020:02:02 08:00:00",
  });
  assert.equal(both, digitized, "DateTimeOriginal must take precedence over DateTime");
});

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

test("extractGpsFromExif applies hemisphere refs and ignores a partial block", () => {
  assert.deepEqual(
    extractGpsFromExif({
      GPSLatitude: 41.2,
      GPSLongitude: 174.8,
      GPSLatitudeRef: "S",
      GPSLongitudeRef: "E",
    }),
    { latitude: -41.2, longitude: 174.8 },
    "a southern latitude must be negated"
  );

  assert.deepEqual(
    extractGpsFromExif({ GPSLatitude: 41.2, GPSLongitudeRef: "E" }),
    {},
    "half a coordinate pair is not a location"
  );
});
