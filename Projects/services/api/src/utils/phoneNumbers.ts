/**
 * Phone-number normalisation, and the one deliberate exemption from phone
 * uniqueness.
 *
 * WHY NORMALISATION LIVES HERE
 *
 * It used to be a private function in `routes/auth.ts`. It is needed in two
 * places now — signup, and the test-number list below — and two copies of a
 * normalisation rule is the shape of defect this repository has been bitten by
 * before: they drift, and nothing reports the disagreement. One definition,
 * imported by both.
 *
 * THE EXEMPTION, AND WHY IT IS SHAPED THE WAY IT IS
 *
 * Phone uniqueness is enforced by a Postgres partial unique index, created in
 * migration 001:
 *
 *     CREATE UNIQUE INDEX auth_users_phone_idx ON auth_users(phone)
 *       WHERE phone IS NOT NULL;
 *
 * There is exactly one way a user row is ever created — `createUser`, called
 * from `/auth/register/verify` — so that index applies to every account,
 * including one created by accepting an invitation. Testing a multi-account
 * flow with a single real phone number is therefore blocked outright.
 *
 * `TEST_PHONE_NUMBERS` lifts that for listed numbers, and the mechanism is
 * chosen so that it cannot lift anything else:
 *
 *   - It does NOT alter the index. No migration, nothing dropped, nothing
 *     relaxed. The constraint every other number meets is the same object it
 *     was before.
 *   - It works by storing NO phone on the row for a listed number. The index
 *     is PARTIAL — `WHERE phone IS NOT NULL` — so a row with no phone is
 *     already outside it, by the schema as written rather than by an exception
 *     added for this.
 *   - It skips no verification. Both codes are checked before this is
 *     consulted; a listed number still receives its SMS and still has to
 *     answer it. The rate limits keyed on the phone are untouched, which means
 *     they are still the binding constraint on how fast accounts can be made.
 *   - Unset or empty — the default — means no number is listed, and the
 *     comparison below can then never return true. Behaviour is identical to
 *     having none of this code.
 *
 * The consequence to be aware of: a test account's row carries no phone, so it
 * cannot be looked up by phone. Logging in by phone number will not find it.
 * Email and password work normally. That is the whole of the difference.
 *
 * The variable holds real personal phone numbers, so it belongs in the
 * deployment environment and never in the repository. It is deliberately NOT
 * on `test-setup.ts`'s allowlist — the test suite blanks it, and the tests here
 * set it explicitly per case.
 */

/**
 * Collapse a phone number to a comparable form: a leading `+` if one was
 * written, then digits only. Formatting variants of the same number therefore
 * compare equal.
 */
export function normalizePhone(phone: string): string {
  const trimmed = phone.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return `${hasPlus ? "+" : ""}${digits}`;
}

/**
 * The configured list, normalised, de-duplicated, and with anything that
 * normalises to nothing discarded.
 *
 * That last part matters more than it looks: an entry of `""` or `"-"`
 * normalises to the empty string, and an empty string left in the list would
 * match a caller passing no phone at all — turning a stray comma into a
 * wildcard. Dropped here, once, rather than guarded at each use.
 */
export function parseTestPhoneNumbers(raw: string | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const normalized = normalizePhone(part);
    if (normalized && normalized !== "+") seen.add(normalized);
  }
  return Array.from(seen);
}

/** How many numbers are exempt. For the boot log — never the numbers. */
export function testPhoneNumberCount(): number {
  return parseTestPhoneNumbers(process.env.TEST_PHONE_NUMBERS).length;
}

/**
 * Whether this number is exempt from the uniqueness index.
 *
 * Read from the environment on each call rather than cached at import, so that
 * clearing the variable takes effect on the next restart with no code change —
 * and so the tests can drive it without module-reset gymnastics.
 */
export function isTestPhoneNumber(phone: string | null | undefined): boolean {
  if (!phone) return false;
  const normalized = normalizePhone(phone);
  if (!normalized || normalized === "+") return false;
  return parseTestPhoneNumbers(process.env.TEST_PHONE_NUMBERS).includes(normalized);
}

/**
 * Say at boot whether the exemption is active, because "we cleared that
 * variable" and "that variable is clear" are two different facts and nothing
 * else distinguishes them. Silent when the list is empty, so an ordinary
 * production boot is unchanged.
 *
 * The count only. These are real personal numbers and logs are not the place
 * for them.
 */
export function logTestPhoneNumbersAtBoot(): void {
  const count = testPhoneNumberCount();
  if (count === 0) return;
  console.warn(
    `[auth] TEST_PHONE_NUMBERS is set: ${count} phone number(s) are exempt from the uniqueness check. ` +
      `Verification is NOT skipped for them. Clear the variable to restore normal behaviour.`
  );
}
