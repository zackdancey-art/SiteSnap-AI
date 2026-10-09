import { test } from "node:test";
import assert from "node:assert/strict";
import { composeE164, stripTrunkZero, DIALLING_CODES } from "@/lib/phone";

/**
 * The number the API is sent has to be the number the person meant.
 *
 * The defect being pinned: signup composed `prefix + every digit typed`, so a
 * New Zealand mobile entered as "021 555 0199" — the way it is written on a
 * business card — became +640215550199, keeping both the country code and the
 * trunk 0 that the country code replaces. Twilio rejects it, routes/auth.ts
 * returns 502, and the person sees an SMS code that never arrives.
 *
 * These tests run against the real exported list, not a fixture copy of it, so
 * adding a country to the picker without a trunk-zero answer fails here.
 */

test("a New Zealand mobile written the way people write it composes a valid E.164 number", () => {
  // The headline case: a local-format mobile, spaces and all.
  assert.equal(composeE164("+64", "021 555 0199"), "+64215550199");

  // Stated as its own assertion because it is the actual bug, and an equality
  // check above could be satisfied by some other transformation that happened
  // to agree on this one input.
  assert.notEqual(
    composeE164("+64", "021 555 0199"),
    "+640215550199",
    "the trunk 0 must not survive next to the country code — this is the malformed number Twilio rejects"
  );

  // Already in international form in the local field, which is the shape
  // somebody who knows the rule would type. Must be left alone.
  assert.equal(composeE164("+64", "21 555 0199"), "+64215550199");
});

test("every dialling code the picker offers drops a trunk zero, and the list is the size we think it is", () => {
  // The count assertion is the point: without it this loop passes over an empty
  // or truncated list and reports nothing. Raise it when a country is added,
  // deliberately, having decided the trunk-zero answer is right for it.
  assert.equal(DIALLING_CODES.length, 10, "the dialling-code list changed size — check the new entry's trunk rule");

  let checked = 0;
  for (const { label, code } of DIALLING_CODES) {
    assert.match(code, /^\+\d{1,3}$/, `${label} has a malformed dialling code: ${code}`);
    // "0" + an eight-digit subscriber number, the shape every trunk-dialled
    // number in this list takes.
    assert.equal(
      composeE164(code, "012345678"),
      `${code}12345678`,
      `${label} (${code}) kept its trunk 0`
    );
    checked += 1;
  }
  assert.equal(checked, DIALLING_CODES.length, "the loop did not visit every dialling code");
});

test("stripTrunkZero removes exactly one leading zero and nothing else", () => {
  assert.equal(stripTrunkZero("0215550199"), "215550199");

  // Exactly one. "00" is the international-access prefix, a different thing,
  // and a number written that way carries its own country code — eating both
  // zeros would quietly produce a plausible-looking wrong number.
  assert.equal(stripTrunkZero("0064215550199"), "064215550199");

  // POSITIVE CONTROL for the negative case below: the function does act when
  // there is a leading zero. Without this line, a function that returned its
  // argument untouched would pass every "unchanged" assertion here.
  assert.notEqual(stripTrunkZero("0215550199"), "0215550199");

  // No leading zero: unchanged. A zero anywhere else is a real digit.
  assert.equal(stripTrunkZero("215550199"), "215550199");
  assert.equal(stripTrunkZero("2025304992"), "2025304992");
  assert.equal(stripTrunkZero(""), "");
});
