import { test } from "node:test";
import assert from "node:assert/strict";

import { describeRunningBundle, formatBundleCreatedAt, type UpdatesSnapshot } from "./running-bundle";

/**
 * What these tests are actually defending.
 *
 * The About screen's job here is to answer one question — "is the code on this
 * phone the code I just published?" — and the single way it can get that wrong
 * is to print a plausible UUID for a device that never received an update.
 * Updates.updateId is NOT null on an embedded launch, so the naive rendering
 * does exactly that, and the resulting screen is indistinguishable from a
 * successful one. The id is 36 characters of hex; nobody reading it off a
 * phone would notice it was the wrong one.
 *
 * So the central test is `an embedded launch never prints an update id`, and it
 * asserts the absence against the whole serialised result rather than against
 * one field, because a future change that moves the id into a detail string
 * would otherwise pass. Its positive control is the same id in the same shape
 * with isEmbeddedLaunch flipped — proving the absence came from the branch and
 * not from the id never being there.
 *
 * None of these states can be produced on a device to order. An emergency
 * launch needs a bundle that downloads and then refuses to start; the "enabled,
 * not embedded, no id" state should be unreachable. They are the reason the
 * decision lives in a pure function instead of inline in the component.
 */

const OTA: UpdatesSnapshot = {
  isEnabled: true,
  isEmbeddedLaunch: false,
  updateId: "01a11f4e-c6cb-728e-829a-62a131d713db",
  channel: "production",
  createdAt: new Date("2026-10-09T06:16:58.827Z"),
};

test("an over-the-air launch reports the update id verbatim", () => {
  const result = describeRunningBundle(OTA);

  assert.equal(result.kind, "ota");
  assert.equal(result.kind === "ota" && result.updateId, "01a11f4e-c6cb-728e-829a-62a131d713db");
  // The id is for comparing against publish output by eye, so it must not be
  // abbreviated, upper-cased or otherwise prettified on the way through.
  assert.equal(result.kind === "ota" && result.updateId.length, 36);
});

test("an embedded launch never prints an update id", () => {
  // Same id, same channel, same timestamp as OTA — only the flag differs.
  const embedded = describeRunningBundle({ ...OTA, isEmbeddedLaunch: true });
  const ota = describeRunningBundle(OTA);

  assert.equal(embedded.kind, "embedded");
  // Against the whole result, not one field: the point is that the id does not
  // reach the screen by ANY path.
  assert.doesNotMatch(JSON.stringify(embedded), /01a11f4e/);
  // The positive control. Without it this assertion would also pass against a
  // function that never returned the id at all, for any input.
  assert.match(JSON.stringify(ota), /01a11f4e/);
});

test("an embedded launch says it is running the built-in bundle, in words", () => {
  const embedded = describeRunningBundle({ ...OTA, isEmbeddedLaunch: true });
  const ota = describeRunningBundle(OTA);

  assert.equal(embedded.kind === "embedded" && /running the built-in bundle/i.test(embedded.words), true);
  // Control: the phrase must not appear on the over-the-air branch, or the
  // screen would claim the built-in bundle whatever is actually running.
  assert.doesNotMatch(JSON.stringify(ota), /built-in bundle/i);
});

test("isEmbeddedLaunch is decided before updateId is read", () => {
  // The ordering IS the behaviour: both fields are populated on an embedded
  // launch, so whichever branch is tested first wins. A reordering that reads
  // updateId first would turn every built-in launch into a false "ota".
  const embeddedWithId = describeRunningBundle({ ...OTA, isEmbeddedLaunch: true });
  assert.equal(embeddedWithId.kind, "embedded");

  // Control on the other side of the same ordering: with the flag down, the
  // identical id does select "ota".
  assert.equal(describeRunningBundle({ ...OTA, isEmbeddedLaunch: false }).kind, "ota");
});

test("a development build says updates are off rather than naming a bundle", () => {
  const dev = describeRunningBundle({
    ...OTA,
    isEnabled: false,
    updateId: null,
    channel: null,
    createdAt: null,
  });

  assert.equal(dev.kind, "disabled");
  assert.equal(dev.kind === "disabled" && /development build/i.test(dev.words), true);
  // Control: disabled must be driven by isEnabled and nothing else, so the
  // same nulls with updates ON must NOT come back as "disabled".
  assert.notEqual(
    describeRunningBundle({ ...OTA, isEnabled: true, updateId: null, channel: null, createdAt: null }).kind,
    "disabled"
  );
});

test("an emergency launch is reported as a failed update, not as a clean built-in launch", () => {
  const emergency = describeRunningBundle({
    ...OTA,
    isEmbeddedLaunch: true,
    isEmergencyLaunch: true,
    emergencyLaunchReason: "Failed to load the manifest",
  });
  const plain = describeRunningBundle({ ...OTA, isEmbeddedLaunch: true });

  assert.equal(emergency.kind, "embedded");
  assert.equal(emergency.kind === "embedded" && emergency.emergencyReason, "Failed to load the manifest");
  assert.equal(emergency.kind === "embedded" && /failed to start/i.test(emergency.words), true);
  // The control that makes this test worth having: the ordinary embedded
  // launch must NOT claim a failure, or every TestFlight install would look
  // like a broken update.
  assert.equal(plain.kind === "embedded" && plain.emergencyReason, null);
  assert.doesNotMatch(JSON.stringify(plain), /failed to start/i);
});

test("an emergency launch with no stated reason still reports that it was one", () => {
  const noReason = describeRunningBundle({
    ...OTA,
    isEmbeddedLaunch: true,
    isEmergencyLaunch: true,
    emergencyLaunchReason: null,
  });

  assert.equal(noReason.kind === "embedded" && noReason.emergencyReason, "no reason given");
  // Control: a reason, when present, is passed through rather than replaced by
  // the placeholder.
  const withReason = describeRunningBundle({
    ...OTA,
    isEmbeddedLaunch: true,
    isEmergencyLaunch: true,
    emergencyLaunchReason: "manifest fetch timed out",
  });
  assert.equal(withReason.kind === "embedded" && withReason.emergencyReason, "manifest fetch timed out");
});

test("the detail line carries the channel and the publish time", () => {
  const result = describeRunningBundle(OTA);

  assert.equal(result.kind === "ota" && result.detail.includes("production channel"), true);
  assert.equal(result.kind === "ota" && result.detail.includes("2026-10-09 06:16 UTC"), true);
});

test("a missing channel or timestamp drops that half of the detail line, not the id", () => {
  const noChannel = describeRunningBundle({ ...OTA, channel: null });
  const noDate = describeRunningBundle({ ...OTA, createdAt: null });
  const neither = describeRunningBundle({ ...OTA, channel: null, createdAt: null });

  assert.equal(noChannel.kind === "ota" && noChannel.detail, "published 2026-10-09 06:16 UTC");
  assert.equal(noDate.kind === "ota" && noDate.detail, "production channel");
  assert.equal(neither.kind === "ota" && neither.detail, "Over-the-air update");
  // In every one of those three, the id — the only part that matters — survives.
  for (const r of [noChannel, noDate, neither]) {
    assert.equal(r.kind === "ota" && r.updateId, "01a11f4e-c6cb-728e-829a-62a131d713db");
  }
});

test("the web build says so rather than raising a false alarm", () => {
  // expo-updates' web implementation reports isEnabled: true with no updateId,
  // which on a phone would be the "should not happen" state. Web simply has no
  // over-the-air mechanism, so it must not read as a fault.
  const web = describeRunningBundle({ ...OTA, updateId: null }, "web");
  const native = describeRunningBundle({ ...OTA, updateId: null });

  assert.equal(web.kind, "unavailable");
  assert.doesNotMatch(JSON.stringify(web), /should not happen/i);
  // The control: the identical snapshot WITHOUT the web platform does still
  // raise the alarm, so the suppression is the platform's doing and not the
  // alarm having been removed.
  assert.equal(native.kind, "unknown");
  assert.match(JSON.stringify(native), /should not happen/i);
});

test("updates on, not embedded, and no id is reported rather than papered over", () => {
  const impossible = describeRunningBundle({ ...OTA, updateId: null });

  assert.equal(impossible.kind, "unknown");
  assert.equal(impossible.kind === "unknown" && /should not happen/i.test(impossible.words), true);
  // Control: the same snapshot WITH an id is not "unknown", so this branch is
  // reached by the missing id and not by something else in the fixture.
  assert.equal(describeRunningBundle(OTA).kind, "ota");
});

test("the publish time is formatted in UTC to the minute", () => {
  assert.equal(formatBundleCreatedAt(new Date("2026-10-09T06:16:58.827Z")), "2026-10-09 06:16 UTC");
  // UTC on purpose: this line is compared against `eas update:list` output,
  // which is UTC, and the phone holding it may be anywhere. Asserting the
  // exact string also keeps the test independent of the runner's timezone —
  // CI and the author's shell are thirteen hours apart.
  assert.equal(formatBundleCreatedAt(new Date(0)), "1970-01-01 00:00 UTC");
});

test("an absent or unparseable publish time yields no line instead of throwing", () => {
  assert.equal(formatBundleCreatedAt(null), null);
  // `new Date("")` is an Invalid Date, whose toISOString() throws a RangeError.
  // The value is deserialised from the update manifest, so this is reachable.
  assert.equal(formatBundleCreatedAt(new Date("")), null);
  // Control: a valid date through the same function does return a line, so the
  // two nulls above are the guard working and not the function always failing.
  assert.equal(formatBundleCreatedAt(new Date("2026-01-02T03:04:05Z")), "2026-01-02 03:04 UTC");
});

test("an unparseable publish time does not take the update id down with it", () => {
  const result = describeRunningBundle({ ...OTA, createdAt: new Date("") });

  assert.equal(result.kind, "ota");
  assert.equal(result.kind === "ota" && result.updateId, "01a11f4e-c6cb-728e-829a-62a131d713db");
  assert.equal(result.kind === "ota" && result.detail, "production channel");
});
