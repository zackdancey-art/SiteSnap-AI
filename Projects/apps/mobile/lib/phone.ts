/**
 * Composing the phone number the API is sent, from a dialling-code prefix and a
 * number typed the way people actually write them.
 *
 * WHY THIS EXISTS
 *
 * Both signup and forgot-password built the number as
 * `${prefix}${local.replace(/\D/g, "")}` — the prefix, then every digit typed,
 * unchanged. For somebody in New Zealand entering their mobile as they would
 * write it anywhere else, "021 555 0199", that composes
 *
 *     +64 + 0215550199  ->  +640215550199
 *
 * which is not a valid number. The leading 0 is a TRUNK PREFIX: it is how the
 * number is dialled from inside the country, and E.164 replaces it with the
 * country code rather than keeping both. The number wanted is +64215550199.
 *
 * Twilio rejects the malformed form, and `routes/auth.ts` turns that into a 502
 * with the provider's message, so the symptom is an SMS code that never arrives
 * on an apparently valid number — with nothing anywhere telling the person that
 * the fix is to omit a digit they are used to dialling. Every country in the
 * picker except +1 works this way, so the only input that succeeded was one
 * typed in a form most people would not think to use.
 *
 * WHY ONE DEFINITION AND NOT TWO
 *
 * It was two: the same expression inlined in `app/signup.tsx` and
 * `app/forgot-password.tsx`. `services/api/src/utils/phoneNumbers.ts` was
 * extracted for this exact reason and says why — two copies of a normalisation
 * rule drift, and nothing reports the disagreement. Fixing one and leaving the
 * other would have made the accounts creatable and the password unresettable.
 *
 * No React Native import, so the node test program can require it.
 */

/**
 * Drop a single leading trunk `0` from a locally-written number.
 *
 * Safe for every country in the picker. +61, +64, +44, +353, +27 all use a
 * trunk 0 that E.164 omits. +65, +91, +971 have no trunk prefix and no number
 * beginning with 0, so there is nothing to strip. +1 is the one worth stating:
 * NANP area codes cannot begin with 0 or 1, so a leading 0 on a US or Canadian
 * number is a typo in every case, and removing it cannot destroy a valid input.
 *
 * Exactly one 0 is removed. "00" at the front is the international-access
 * prefix, a different thing from a trunk 0, and a number written that way
 * already carries its own country code — see the caveat on `composeE164`.
 */
export function stripTrunkZero(localDigits: string): string {
  return localDigits.startsWith("0") ? localDigits.slice(1) : localDigits;
}

/**
 * `("+64", "021 555 0199")` -> `"+64215550199"`.
 *
 * CAVEAT, deliberately not handled: a number typed into the local field in full
 * international form — "+64215550199", or "0064215550199" — is not detected,
 * and composes a wrong answer. Stripping a repeated country code sounds like
 * the obvious guard and is not safe to add: NZ area codes are a single digit,
 * so the valid local number "6 412 3456" normalises to "64123456", which begins
 * with the country code's own digits and would be silently mangled by it. A
 * country-code collision is a worse failure than the one being fixed, because
 * it corrupts a number that was entered correctly. Rejecting a leading "+" in
 * the field belongs in the field's own validation, not here.
 */
export function composeE164(prefix: string, local: string): string {
  return `${prefix}${stripTrunkZero(local.replace(/\D/g, ""))}`;
}

/** A country the signup picker offers, and its E.164 dialling code. */
export type DiallingCode = { label: string; code: string };

/**
 * The countries signup offers. Canonical here so the trunk-zero rule above can
 * be asserted against the real list rather than a copy of it in a test — a test
 * that enumerates its own fixture proves nothing about what ships.
 *
 * `app/forgot-password.tsx` deliberately still holds its own, SHORTER list
 * (5 of these 10 — no Canada, Ireland, Singapore, South Africa or UAE). That is
 * a real gap: an account can be created with a number whose country the SMS
 * password reset then does not offer, so that account cannot reset by SMS at
 * all. It is left alone here because unifying the lists changes a screen
 * outside this phase's scope. Reported for a decision, not quietly altered.
 */
export const DIALLING_CODES: DiallingCode[] = [
  { label: "United States", code: "+1" },
  { label: "Canada", code: "+1" },
  { label: "Australia", code: "+61" },
  { label: "New Zealand", code: "+64" },
  { label: "United Kingdom", code: "+44" },
  { label: "Ireland", code: "+353" },
  { label: "Singapore", code: "+65" },
  { label: "India", code: "+91" },
  { label: "South Africa", code: "+27" },
  { label: "United Arab Emirates", code: "+971" },
];
