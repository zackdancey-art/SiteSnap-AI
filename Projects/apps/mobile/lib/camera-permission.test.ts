import { test } from "node:test";
import assert from "node:assert/strict";

import { describeCameraRefusal } from "./camera-permission";

/**
 * What these tests are actually defending.
 *
 * A builder who taps "Don't Allow" once can never be asked again by iOS, and
 * the app's old answer — "Camera access is needed to take photos" — named
 * nothing they could do about it. The product's primary capture path was
 * unreachable and the app said so in a way that read like a transient error.
 *
 * So: the refusal text must differ between the retryable case and the
 * permanent one, and the Settings route must be offered in exactly one of
 * them. Each assertion below is paired against the other branch in the same
 * test, because "offerSettings is false" passes both when the branch was
 * chosen correctly and when the function returned a constant.
 */

test("a permanent refusal offers Settings and says the phone will not ask again", () => {
  const permanent = describeCameraRefusal(false);
  const retryable = describeCameraRefusal(true);

  assert.equal(permanent.offerSettings, true);
  assert.match(permanent.message, /will not ask again/);
  // The positive control: the other branch must NOT offer it, or this test
  // would pass against a function that always offers Settings.
  assert.equal(retryable.offerSettings, false);
});

test("a retryable refusal tells the user to tap again rather than open Settings", () => {
  const retryable = describeCameraRefusal(true);
  const permanent = describeCameraRefusal(false);

  assert.match(retryable.message, /again and choose Allow/);
  assert.equal(retryable.offerSettings, false);
  // Paired control: the permanent branch must not give the same advice, since
  // tapping again there does nothing at all.
  assert.doesNotMatch(permanent.message, /again and choose Allow/);
});

test("both refusals name the app and a concrete next action, and neither is the old dead end", () => {
  for (const refusal of [describeCameraRefusal(true), describeCameraRefusal(false)]) {
    assert.match(refusal.message, /SiteSnap/);
    assert.notEqual(refusal.message, "Camera access is needed to take photos.");
    assert.ok(refusal.title.length > 0 && refusal.message.length > 0);
  }
});
