/**
 * Numeric environment-variable parsing.
 *
 * Every numeric setting in this service used to be read as:
 *
 *     const ttl = Number(process.env.SOME_TTL_MS ?? 600_000);
 *
 * which is wrong in a way that is invisible until it isn't. `??` only falls back
 * on `null`/`undefined`, and an environment variable that is *present but empty*
 * is neither — so `SOME_TTL_MS=` yields `Number("")`, which is `0`, not the
 * default. A TTL of zero expires everything the instant it is created.
 *
 * That is not hypothetical here. `ACCOUNT_VERIFICATION_TTL_MS=` silently breaks
 * every signup: the emailed verification code is already expired by the time the
 * user reads it, the API returns a correct-looking 401, and nothing logs an
 * error because nothing went wrong from the code's point of view. Clearing a
 * value in a hosting dashboard (rather than deleting the row) is enough to
 * trigger it, and it fails closed for 100% of new users with no boot warning.
 *
 * `readIntEnv` distinguishes the three cases that `Number()` conflates:
 *
 *   unset, or empty/whitespace  -> "not configured": use the default.
 *   a valid integer             -> use it.
 *   anything else               -> "misconfigured": THROW at boot.
 *
 * The third case matters as much as the second. `Number("abc")` is `NaN`, and
 * every comparison against `NaN` is false — so a typo'd TTL doesn't shorten the
 * window, it removes expiry altogether. Failing loudly at startup is the only
 * safe reading of a value someone meant to set and got wrong.
 *
 * This generalises the bespoke parser already used for `TRUST_PROXY_HOPS` in
 * server.ts, which got this right on its own; the point of a shared helper is
 * that the next numeric setting cannot get it wrong by default.
 */
export function readIntEnv(
  name: string,
  fallback: number,
  opts: { min?: number; hint?: string } = {}
): number {
  const raw = process.env[name];

  // Absent and empty are the same thing: nobody configured this. Note that the
  // empty case is the whole reason this function exists — see the header above.
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number(raw.trim());
  const suffix = opts.hint ? ` ${opts.hint}` : "";

  if (!Number.isInteger(parsed)) {
    throw new Error(
      `${name} must be an integer (got ${JSON.stringify(raw)}). ` +
        `Leave it unset or empty to use the default of ${fallback}.${suffix}`
    );
  }

  const min = opts.min;
  if (min !== undefined && parsed < min) {
    throw new Error(
      `${name} must be >= ${min} (got ${parsed}). ` +
        `Leave it unset or empty to use the default of ${fallback}.${suffix}`
    );
  }

  return parsed;
}
