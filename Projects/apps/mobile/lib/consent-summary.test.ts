import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_RECORD_MESSAGE,
  type ConsentRecord,
  formatAcceptedDate,
  summariseConsents,
} from "./consent-summary";

/**
 * WHY THESE TESTS EXIST
 *
 * Same reason as lib/permissions.test.ts: mobile cannot be screenshotted from
 * this environment, so for anything the app DISPLAYS this file is the only
 * verification available. That is why the wording and ordering decisions live
 * in consent-summary.ts instead of inside the screen's JSX.
 *
 * What is NOT verified here, and is in the PR's device checklist as unverified:
 * that app/settings/data-privacy.tsx renders these lines, and that the request
 * to GET /api/auth/consents succeeds against a real token.
 */

const record = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
  document: "terms",
  version: "Last updated: 3 October 2026",
  acceptedAt: "2026-10-04T02:15:00.000Z",
  source: "signup",
  ...over,
});

test("both documents are shown, terms first, in the order they are linked", () => {
  // Fed in privacy-first so that passing cannot be the input order surviving.
  const lines = summariseConsents(
    [
      record({ document: "privacy", version: "Last updated: 4 October 2026" }),
      record({ document: "terms", version: "Last updated: 3 October 2026" }),
    ],
    "UTC",
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0].label, "Terms of Service");
  assert.equal(lines[1].label, "Privacy Policy");
  // And the version travels with its own document rather than with its slot.
  assert.match(lines[0].detail, /3 October 2026/);
  assert.match(lines[1].detail, /4 October 2026/);
});

test("the newest acceptance of a document wins, and the older one is not shown", () => {
  // A re-acceptance after the terms change. The ledger keeps both rows; the
  // screen shows what is current.
  const lines = summariseConsents(
    [
      record({ acceptedAt: "2026-02-01T00:00:00.000Z", version: "Last updated: 1 January 2026" }),
      record({ acceptedAt: "2026-10-04T02:15:00.000Z", version: "Last updated: 3 October 2026" }),
    ],
    "UTC",
  );
  // The negative — the old version is gone — with its positive control: the new
  // one is present, from the same call. "Neither is shown" would otherwise pass
  // the first assertion just as well.
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0].detail, /1 January 2026/);
  assert.match(lines[0].detail, /3 October 2026/);
});

test("an account with no records gets no lines, so the screen can say so", () => {
  assert.deepEqual(summariseConsents([]), []);
  // The control: the same function with one record does produce a line. Without
  // this, summariseConsents returning [] unconditionally would pass above.
  assert.equal(summariseConsents([record()]).length, 1);
  // And the sentence the screen shows in that case says the RECORD is missing,
  // not that the documents were never accepted. See the doc comment on the
  // constant: telling someone they have not accepted the terms would be the app
  // asserting something false about them.
  assert.match(NO_RECORD_MESSAGE, /No acceptance is recorded/);
  assert.match(NO_RECORD_MESSAGE, /does not mean the documents were not accepted/);
});

test("a document this build does not recognise is still shown, under its raw name", () => {
  // The failure worth avoiding: an older app silently dropping a consent record
  // because the server has started recording a third document.
  const lines = summariseConsents(
    [record(), record({ document: "data-processing", acceptedAt: "2026-10-05T00:00:00.000Z" })],
    "UTC",
  );
  assert.equal(lines.length, 2);
  assert.equal(lines[0].label, "Terms of Service");
  assert.equal(lines[1].label, "data-processing");
});

test("the accepted date reads as a date, and a broken one is shown rather than hidden", () => {
  assert.equal(formatAcceptedDate("2026-10-04T02:15:00.000Z", "UTC"), "4 October 2026");
  // Not "Invalid Date" at somebody, and not an empty string either: an
  // unparseable value from the server is a bug to see.
  assert.equal(formatAcceptedDate("not-a-date"), "not-a-date");
});

test("the zone decides the calendar date, which is why the tests above pin one", () => {
  // 02:15 UTC on the 4th is still the 3rd in Los Angeles. Both directions from
  // the same instant, so this also proves the parameter is reaching the
  // formatter rather than being accepted and ignored.
  const instant = "2026-10-04T02:15:00.000Z";
  assert.equal(formatAcceptedDate(instant, "UTC"), "4 October 2026");
  assert.equal(formatAcceptedDate(instant, "Pacific/Auckland"), "4 October 2026");
  assert.equal(formatAcceptedDate(instant, "America/Los_Angeles"), "3 October 2026");
});

test("the detail line names both the acceptance date and the version accepted", () => {
  const [line] = summariseConsents([record()], "UTC");
  // Both halves, because either alone is a record that cannot answer the
  // question the ledger exists for: which text did this person agree to, and
  // when.
  assert.match(line.detail, /Accepted 4 October 2026/);
  assert.match(line.detail, /Last updated: 3 October 2026/);
});
