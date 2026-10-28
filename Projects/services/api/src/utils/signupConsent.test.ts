import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_VERSION_LENGTH, parseSignupConsent } from "./signupConsent";

/**
 * In-memory by exception, and the exception is argued rather than assumed.
 *
 * The standing rule is that anything touching permissions, tenancy, ownership
 * or data goes in the DB-gated suite, because seven defects have hidden in the
 * gap between the in-memory store and Postgres. This file touches none of those:
 * parseSignupConsent takes a plain object and returns a plain object, with no
 * store, no clock and no request. There is nothing here for the two stores to
 * disagree about.
 *
 * The recording -- the part that writes a row and therefore can diverge -- is
 * tested against Postgres in routes/signup-consent.db.test.ts.
 */

const VERSION = "Last updated: 3 October 2026";

const accepted = (over: Record<string, unknown> = {}) => ({
  email: "someone@example.com",
  acceptedTerms: true,
  acceptedPrivacy: true,
  termsVersion: VERSION,
  privacyVersion: "Last updated: 4 October 2026",
  ...over,
});

test("a body with both acceptances and both versions is accepted, and keeps them apart", () => {
  const result = parseSignupConsent(accepted());
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  // Which version belongs to which document is the entire point of the record,
  // so assert them separately rather than asserting they are both present.
  assert.equal(result.termsVersion, "Last updated: 3 October 2026");
  assert.equal(result.privacyVersion, "Last updated: 4 October 2026");
});

test("a body that says nothing about consent is absent, not refused", () => {
  // The deploy-window decision, and the one most likely to be wanted back. An
  // older shipping client sends a signup with no consent fields at all; if that
  // were an error, every signup in the world would 400 between the API deploy
  // and both client builds shipping.
  assert.deepEqual(parseSignupConsent({ email: "someone@example.com", password: "x" }), {
    kind: "absent",
  });
  assert.deepEqual(parseSignupConsent({}), { kind: "absent" });
  assert.deepEqual(parseSignupConsent(undefined), { kind: "absent" });
  assert.deepEqual(parseSignupConsent("not an object"), { kind: "absent" });
  // The control for all four: the same function does NOT return absent when the
  // fields are there. Without it, a parseSignupConsent that had stopped looking
  // at the body at all would pass every assertion above.
  assert.equal(parseSignupConsent(accepted()).kind, "accepted");
});

test("a partial consent is a refusal, not an absence", () => {
  // The two shapes that matter: accepted one document, and mentioned the
  // versions without accepting anything. Both are client defects, and reading
  // either as "absent" would let the signup through with no record while the
  // client believed it had sent one.
  for (const body of [
    accepted({ acceptedPrivacy: undefined }),
    accepted({ acceptedTerms: undefined }),
    { termsVersion: VERSION, privacyVersion: VERSION },
  ]) {
    const result = parseSignupConsent(body);
    assert.equal(result.kind, "invalid", JSON.stringify(body));
  }
  // Positive control from the same call shape.
  assert.equal(parseSignupConsent(accepted()).kind, "accepted");
});

test("only a literal true or the string \"true\" is an acceptance", () => {
  // The string "false" is the one that matters: it is truthy, and it is exactly
  // what a form-encoded unticked checkbox serialises to. Reading it as consent
  // would put a legal record against somebody who declined.
  for (const value of ["false", false, 0, 1, "yes", "on", null, {}]) {
    const result = parseSignupConsent(accepted({ acceptedTerms: value }));
    assert.equal(result.kind, "invalid", `acceptedTerms=${JSON.stringify(value)}`);
  }
  // And the two that are accepted, so this is not just "nothing is accepted".
  assert.equal(parseSignupConsent(accepted({ acceptedTerms: true })).kind, "accepted");
  assert.equal(parseSignupConsent(accepted({ acceptedTerms: "true" })).kind, "accepted");
});

test("a version that is missing, blank, oversized or not a string is a refusal", () => {
  for (const value of ["", "   ", "x".repeat(MAX_VERSION_LENGTH + 1), 20261003, null, {}]) {
    const result = parseSignupConsent(accepted({ termsVersion: value }));
    assert.equal(result.kind, "invalid", `termsVersion=${JSON.stringify(value)}`);
    if (result.kind !== "invalid") continue;
    // The message is the client-defect one, not the "please accept" one: the
    // person did tick the boxes, and telling them to tick them again is advice
    // they cannot act on.
    assert.match(result.error, /document versions/);
  }
  // Exactly at the limit is fine -- the boundary is inclusive, and a test that
  // only checked over-the-limit would pass against an off-by-one that rejected
  // the limit itself.
  const atLimit = parseSignupConsent(accepted({ termsVersion: "x".repeat(MAX_VERSION_LENGTH) }));
  assert.equal(atLimit.kind, "accepted");
});

test("a version carrying control characters is refused, and surrounding space is trimmed", () => {
  // No regex over the date wording on purpose -- a copy edit must not break
  // signup -- so this is the whole of what "shaped like a version" means, and
  // the newline case is the one that matters: a version string is a single line
  // written into a ledger somebody reads.
  assert.equal(parseSignupConsent(accepted({ termsVersion: "Last updated:\n3 October" })).kind, "invalid");
  assert.equal(parseSignupConsent(accepted({ termsVersion: "Last\u0000updated" })).kind, "invalid");

  const trimmed = parseSignupConsent(accepted({ termsVersion: `  ${VERSION}  ` }));
  assert.equal(trimmed.kind, "accepted");
  if (trimmed.kind !== "accepted") return;
  assert.equal(trimmed.termsVersion, VERSION);
});
