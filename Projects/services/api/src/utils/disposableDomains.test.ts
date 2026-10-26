import { test } from "node:test";
import assert from "node:assert/strict";

import { disposableDomainCount, isDisposableEmailDomain } from "./disposableDomains";

/**
 * WHY THIS FILE EXISTS, GIVEN THE GUARD IS ALREADY TESTED
 *
 * `rate-limit-abuse.test.ts` drives the guard through /auth/register and proves
 * a disposable address is refused and a subdomain of one is too. What it cannot
 * prove is that the LIST still has anything in it. Both of those tests probe
 * `mailinator.com`, so a denylist truncated to that single entry — by a bad
 * merge resolution, by a sed over the array, by anything — keeps them green
 * while every other throwaway provider in the file walks through signup.
 *
 * That is the shape this repo has been bitten by four times (AUDIT L36,
 * docs/VACUITY-AUDIT.md M7): a guard whose only evidence is one probe of one
 * input. `disposableDomainCount` was written for exactly this and its docblock
 * said "exposed for tests" while having no caller anywhere in the repo
 * (HALF-BUILT F7), so the measurement it offers was never taken.
 *
 * WHY IN-MEMORY AND NOT DB-GATED
 * The standing rule is that new tests touching permissions, tenancy, ownership
 * or data go in the DB-gated suite, and in-memory tests are for pure logic with
 * no store involved. This is that exception and it is not a close call: the
 * module is a frozen array, a Set built from it, and a string walk. There is no
 * store, no actor, no query, and nothing a real Postgres would decide
 * differently.
 */

/**
 * MEASURED, not chosen. Read off the file itself:
 *
 *   node -e 'const s=require("fs").readFileSync(
 *     "src/utils/disposableDomains.ts","utf8");
 *     const m=s.match(/const DISPOSABLE_DOMAINS[^=]*=\s*\[([\s\S]*?)\];/);
 *     const items=m[1].split("\n").map(l=>l.trim()).filter(l=>l.startsWith("\""));
 *     console.log(items.length, new Set(items).size)'
 *   144 144
 *
 * If you add or remove entries, re-run that and update this number in the same
 * commit. Do not nudge it to whatever the failure printed — a count edited to
 * match the code it is supposed to check is the defect this test is here to
 * prevent, one level up.
 */
const EXPECTED_DOMAIN_COUNT = 144;

test("the denylist still holds every entry it was built with, not just the one other tests probe", () => {
  assert.equal(
    disposableDomainCount(),
    EXPECTED_DOMAIN_COUNT,
    `the disposable-domain denylist has ${disposableDomainCount()} entries, expected ${EXPECTED_DOMAIN_COUNT}. ` +
      "If this is a deliberate edit to the list, re-measure and update EXPECTED_DOMAIN_COUNT in the same commit. " +
      "If it is not, the denylist has lost entries and signup is accepting throwaway addresses it used to refuse."
  );

  // Positive control, same assertion in the same test: the count is a real
  // reading of a real Set, not a constant. A guard that denied nothing would
  // satisfy every negative assertion below it, so prove the list is load-bearing
  // in both directions before trusting its size.
  assert.equal(
    isDisposableEmailDomain("someone@mailinator.com"),
    true,
    "a listed provider must be refused — if this fails the count above is measuring a Set nothing consults"
  );
  assert.equal(
    isDisposableEmailDomain("someone@a-real-construction-firm.co.nz"),
    false,
    "an ordinary customer domain must be admitted — this is the denylist-not-allowlist promise in the module header"
  );
});

test("the parent walk covers subdomains without ever denying a bare suffix", () => {
  // The walk is the only part of the module with a boundary in it, and the
  // boundary is what keeps a denylist from becoming an outage: if the loop ran
  // to labels.length - 1 it would test "com" against the Set, and one careless
  // entry would refuse every address in the world.
  assert.equal(
    isDisposableEmailDomain("someone@anything.mailinator.com"),
    true,
    "a subdomain of a listed provider must be refused, which is why one base entry suffices"
  );
  assert.equal(
    isDisposableEmailDomain("someone@deep.nested.mailinator.com"),
    true,
    "the walk must reach every registrable parent, not only the immediate one"
  );

  // Both controls on the boundary itself. "com" is not in the list, so a
  // positive assertion here cannot distinguish "the suffix was never tested"
  // from "the suffix was tested and missed". So assert the structural fact the
  // comment in the module claims: the candidate always has at least two labels.
  assert.equal(
    isDisposableEmailDomain("someone@com"),
    false,
    "a single-label domain must never be denied — there is no registrable parent to test"
  );
  assert.equal(
    isDisposableEmailDomain("someone@mailinator"),
    false,
    "a bare label that happens to match a listed provider's first label must not be denied either"
  );
  assert.equal(
    isDisposableEmailDomain("someone@notmailinator.com"),
    false,
    "matching must be label-wise, not substring-wise, or a legitimate domain containing a listed one is locked out"
  );
});

test("malformed input is admitted rather than refused, and the guard is still live", () => {
  // Fail-open is the deliberate direction for this one guard (module header:
  // the cost of a miss is one unverified signup, the cost of a false refusal is
  // a lost customer). The address-shape validation that rejects these lives
  // elsewhere in the signup path; this function's job is only the denylist.
  for (const bad of ["", "no-at-sign", "trailing@", "@leading.com", "spaces @ everywhere"]) {
    assert.equal(
      isDisposableEmailDomain(bad),
      false,
      `${JSON.stringify(bad)} must not be treated as disposable`
    );
  }

  // Positive control for the loop above, which is five negative assertions and
  // would pass identically against a function that returned false always.
  // Note the whitespace is INSIDE the string the guard receives, not trimmed by
  // the test: the `.trim()` and `.toLowerCase()` being exercised are the
  // guard's own, which is the point of the control.
  assert.equal(
    isDisposableEmailDomain("SOMEONE@ MailInator.COM "),
    true,
    "case and whitespace around the domain must not defeat the denylist"
  );
});
