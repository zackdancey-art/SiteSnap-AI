/**
 * E.164 composition for the portal's signup form.
 *
 * This is a deliberate second copy of Projects/apps/mobile/lib/phone.ts, not an
 * oversight. Three places need this arithmetic and none of them can share it:
 *
 *   - @sitesnap/shared is types-only. Its tsconfig sets emitDeclarationOnly and
 *     its package `main` points at dist/index.d.ts, so it emits no runtime
 *     JavaScript at all and cannot host a function.
 *   - The API cannot do it server-side. services/api/src/utils/phoneNumbers.ts
 *     `normalizePhone` keeps a leading + and digits, and that is as far as it
 *     can safely go: stripping a trunk zero requires knowing where the country
 *     code ends, and the API receives one opaque string. Only the form knows,
 *     because the form holds the dialling code separately from the local part.
 *
 * So the rule is: strip the trunk zero where the two halves are still separate,
 * which is here. See the mobile copy for the full rationale and for the two
 * deliberate non-features (exactly one zero removed; no country-code dedupe).
 * If you change one, change both.
 */

/** Remove exactly one leading trunk zero. "00" is the international-access
 *  prefix, not two trunk zeros, so only the first is dropped. */
export function stripTrunkZero(localDigits: string): string {
  return localDigits.startsWith("0") ? localDigits.slice(1) : localDigits;
}

/** Join a dialling code to a locally-formatted number, as E.164. */
export function composeE164(prefix: string, local: string): string {
  return `${prefix}${stripTrunkZero(local.replace(/\D/g, ""))}`;
}

export type DiallingCode = { label: string; code: string };

/** Kept identical to the mobile signup list on purpose. A number that can
 *  create an account must also be able to receive a password reset, and the
 *  two lists drifting is already a recorded finding on the mobile side. */
export const DIALLING_CODES: DiallingCode[] = [
  { label: "New Zealand", code: "+64" },
  { label: "Australia", code: "+61" },
  { label: "United States", code: "+1" },
  { label: "Canada", code: "+1" },
  { label: "United Kingdom", code: "+44" },
  { label: "Ireland", code: "+353" },
  { label: "Singapore", code: "+65" },
  { label: "India", code: "+91" },
  { label: "South Africa", code: "+27" },
  { label: "United Arab Emirates", code: "+971" },
];
