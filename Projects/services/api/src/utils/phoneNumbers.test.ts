import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  isTestPhoneNumber,
  logTestPhoneNumbersAtBoot,
  normalizePhone,
  parseTestPhoneNumbers,
  testPhoneNumberCount,
} from "./phoneNumbers";

/**
 * `TEST_PHONE_NUMBERS` is blanked by `test-setup.ts`'s allowlist, which is
 * correct — it holds real personal numbers in deployment. So each test sets it
 * explicitly, and ASSIGNS rather than deletes: `server.ts` calls
 * `dotenv.config()` on import, and dotenv repopulates an absent key while
 * leaving an empty one alone (CLAUDE.md §6).
 */
const LISTED = "+64211234567";
const OTHER = "+64219999999";

beforeEach(() => {
  process.env.TEST_PHONE_NUMBERS = "";
});

test("unset or empty means no number is exempt", () => {
  for (const value of ["", "   ", ",", ",,", " , "]) {
    process.env.TEST_PHONE_NUMBERS = value;
    assert.equal(isTestPhoneNumber(LISTED), false, `${JSON.stringify(value)} must exempt nothing`);
    assert.equal(testPhoneNumberCount(), 0);
  }
  // Positive control: the same number IS exempt once genuinely listed, so the
  // assertions above are testing the empty cases rather than a function that
  // always returns false.
  process.env.TEST_PHONE_NUMBERS = LISTED;
  assert.equal(isTestPhoneNumber(LISTED), true);
  assert.equal(testPhoneNumberCount(), 1);
});

test("a listed number is exempt and an unlisted one keeps the existing rule", () => {
  process.env.TEST_PHONE_NUMBERS = LISTED;
  assert.equal(isTestPhoneNumber(LISTED), true);
  assert.equal(isTestPhoneNumber(OTHER), false);
});

test("formatting variants of a listed number match", () => {
  process.env.TEST_PHONE_NUMBERS = "+64 21 123 4567";
  for (const variant of ["+64211234567", "+64-21-123-4567", "+64 (21) 123 4567", " +64211234567 "]) {
    assert.equal(isTestPhoneNumber(variant), true, `${variant} is the same number`);
  }
  // And a different number still is not, so the matching is not just truthy.
  assert.equal(isTestPhoneNumber(OTHER), false);
});

test("a stray separator does not become a wildcard", () => {
  // An entry normalising to nothing would otherwise match a caller passing no
  // phone, turning a trailing comma into a blanket exemption.
  process.env.TEST_PHONE_NUMBERS = `${LISTED},,-, ,+`;
  assert.equal(testPhoneNumberCount(), 1);
  for (const empty of ["", "   ", "-", "+", null, undefined]) {
    assert.equal(isTestPhoneNumber(empty), false, `${JSON.stringify(empty)} must not match`);
  }
  assert.equal(isTestPhoneNumber(LISTED), true);
});

test("the list is de-duplicated across formatting variants", () => {
  process.env.TEST_PHONE_NUMBERS = `${LISTED}, +64 21 123 4567 ,+64-21-123-4567,${OTHER}`;
  assert.equal(testPhoneNumberCount(), 2);
  assert.equal(isTestPhoneNumber(LISTED), true);
  assert.equal(isTestPhoneNumber(OTHER), true);
});

test("a number without a leading plus is a different number from one with it", () => {
  // Normalisation preserves the plus deliberately: +64211234567 and
  // 64211234567 are not interchangeable, and silently equating them would
  // exempt more than was listed.
  process.env.TEST_PHONE_NUMBERS = "64211234567";
  assert.equal(isTestPhoneNumber("64211234567"), true);
  assert.equal(isTestPhoneNumber("+64211234567"), false);
});

test("normalizePhone keeps a leading plus and discards everything but digits", () => {
  assert.equal(normalizePhone("+64 21 123-4567"), "+64211234567");
  assert.equal(normalizePhone("(021) 123 4567"), "0211234567");
  assert.equal(normalizePhone("  +64211234567  "), "+64211234567");
  assert.equal(normalizePhone("abc"), "");
  assert.equal(normalizePhone(""), "");
});

test("parseTestPhoneNumbers returns normalised entries", () => {
  assert.deepEqual(parseTestPhoneNumbers(undefined), []);
  assert.deepEqual(parseTestPhoneNumbers(""), []);
  assert.deepEqual(parseTestPhoneNumbers("+64 21 123 4567"), ["+64211234567"]);
  assert.deepEqual(parseTestPhoneNumbers(`${LISTED},${OTHER}`), [LISTED, OTHER]);
});

test("the boot log reports the count and never a number", () => {
  const lines: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    // Silent when the exemption is off — an ordinary production boot is
    // unchanged.
    process.env.TEST_PHONE_NUMBERS = "";
    logTestPhoneNumbersAtBoot();
    assert.equal(lines.length, 0);

    process.env.TEST_PHONE_NUMBERS = `${LISTED},${OTHER}`;
    logTestPhoneNumbersAtBoot();
    assert.equal(lines.length, 1, "a non-empty list must announce itself");
  } finally {
    console.warn = realWarn;
  }

  const logged = lines[0];
  assert.match(logged, /2 phone number/, "the count is the point of the line");
  // The numbers themselves must not be in it. Asserted on the significant
  // digits rather than the whole string so a substring cannot pass by luck.
  assert.doesNotMatch(logged, /1234567|9999999/);
  // Positive control for that negative: those digits really are in the value
  // that was configured, so this is not an assertion over an empty haystack.
  assert.match(process.env.TEST_PHONE_NUMBERS ?? "", /1234567/);
  assert.match(process.env.TEST_PHONE_NUMBERS ?? "", /9999999/);
});
