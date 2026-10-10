import { test } from "node:test";
import assert from "node:assert/strict";
import { describeIncompleteSignature, describeSignatureSaveFailure } from "./signature-input";

/**
 * The property under test is the one the device reported missing: every refusal
 * to save produces words. A test that only checked the happy path would have
 * passed against the version where tapping Save did nothing at all.
 */

const complete = { signerName: "Jo Blogs", path: "M0 0 L10 10", hasInspection: true };

test("every incomplete signature produces a sentence, never silence", () => {
  const refusals = [
    { ...complete, signerName: "", path: "" },
    { ...complete, signerName: "" },
    { ...complete, signerName: "   " },
    { ...complete, path: "" },
    { ...complete, hasInspection: false },
  ];
  for (const input of refusals) {
    const message = describeIncompleteSignature(input);
    assert.equal(typeof message, "string", `no message for ${JSON.stringify(input)}`);
    assert.ok((message as string).length > 0, `empty message for ${JSON.stringify(input)}`);
  }

  // The positive control, and the reason this test is not vacuous: a complete
  // input must return null so the save is actually attempted. A function that
  // returned a sentence for everything would satisfy the loop above and would
  // make the sheet impossible to submit.
  assert.equal(describeIncompleteSignature(complete), null);
});

test("the message names the field that is missing", () => {
  // Which field it is matters more than that there is a message. The name field
  // is the one with no label and no required marker, so a generic "complete all
  // fields" would leave the person looking at the canvas they just signed.
  assert.match(describeIncompleteSignature({ ...complete, signerName: "" }) ?? "", /name/i);
  assert.match(describeIncompleteSignature({ ...complete, path: "" }) ?? "", /sign in the box/i);

  // And they are different sentences, so the two cases are distinguishable on
  // the device - the whole point of separating the branches.
  assert.notEqual(
    describeIncompleteSignature({ ...complete, signerName: "" }),
    describeIncompleteSignature({ ...complete, path: "" })
  );
});

test("a failed save always says so, and prefers the server's own words", () => {
  assert.equal(
    describeSignatureSaveFailure(new Error("A signature for this role already exists.")),
    "A signature for this role already exists."
  );

  // "API 409" is what the deleted screen helpers threw. It is not a sentence
  // for a site manager, so it is replaced rather than shown.
  assert.match(describeSignatureSaveFailure(new Error("API 409")), /not saved/i);
  assert.match(describeSignatureSaveFailure(new Error("API 500")), /not saved/i);

  // Nothing reaches the person as an empty string, whatever was thrown.
  for (const thrown of [new Error(""), new Error("   "), null, undefined, "boom", 42, {}]) {
    const message = describeSignatureSaveFailure(thrown);
    assert.ok(message.length > 0, `empty message for ${JSON.stringify(thrown)}`);
  }
});
