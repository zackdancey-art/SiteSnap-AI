/**
 * Reading terms-and-privacy consent off a signup request body.
 *
 * Pure: no store, no clock, no request object. The timestamp a consent record
 * carries is the server's and is stamped by the route, not here, so that this
 * can be tested exhaustively in memory while the recording itself is tested
 * against Postgres.
 *
 * THE THREE-WAY ANSWER, WHICH IS THE WHOLE DESIGN
 *
 *   "absent"   the request carries no consent fields at all.
 *   "accepted" both documents accepted, with a usable version for each.
 *   an error   the request carries some consent and it does not make sense.
 *
 * "absent" is a PASS, and that is the one decision here somebody might want
 * back. Signup is POST /auth/register, and shipped mobile and portal builds
 * call it today without these fields. The API deploys from main on merge while
 * the client builds ship separately and on the owner's schedule, so requiring
 * consent server-side would 400 every signup in the world for the length of
 * that window -- days, not minutes. The clients are what enforce consent (the
 * button is disabled until both boxes are ticked, which is also what App Store
 * review sees); this records it.
 *
 * Tightening that afterwards is one line: make `absent` return an error. The
 * condition for doing it safely is both client builds shipped and old builds
 * no longer in use. It is called out in the pull request rather than left here
 * to be found.
 *
 * A PARTIAL consent is NOT treated as absent. A body that accepts the terms and
 * says nothing about the privacy policy is a client defect, and the cost of
 * guessing is a legal record saying somebody agreed to something they were
 * never shown. That gets a 400, which is loud, and cannot affect an old client,
 * which sends neither field.
 */

/** The parsed outcome. A discriminated union so no caller can read `consent` off an error. */
export type SignupConsentResult =
  | { kind: "absent" }
  | { kind: "accepted"; termsVersion: string; privacyVersion: string }
  | { kind: "invalid"; error: string };

/**
 * Longest version string accepted. The real ones are the documents' own "Last
 * updated: 4 October 2026" line, about thirty characters; this is room for a
 * longer format without being room for a payload.
 */
export const MAX_VERSION_LENGTH = 200;

/**
 * Why this is not a regular expression over "Last updated: D Month YYYY".
 *
 * A strict shape would be a hard coupling between the signup endpoint and the
 * prose at the top of a legal document that a non-engineer edits. The day the
 * wording of that line changes -- and it is wording, not a version number --
 * every signup starts failing, in production, for a copy edit. The failure mode
 * of being loose is an unusual string in an append-only ledger, which someone
 * reads and understands; the failure mode of being strict is nobody being able
 * to create an account.
 *
 * So: present, trimmed, bounded, one line, no control characters. The integrity
 * of the value comes from the other end -- the clients send the `lastUpdated`
 * field of the document they rendered, and Projects/scripts/ci.sh compares that
 * field word-for-word against the canonical file and every other copy of it, so
 * it cannot drift from the text it names.
 */
function cleanVersion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VERSION_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Accepts only a literal `true`.
 *
 * Not truthiness. "false" is a non-empty string and would be truthy, and a
 * form-encoded body is the one that sends strings -- so a checkbox a person
 * left unticked, serialised by a client that did not convert it, would read as
 * consent. The string "true" is accepted because JSON is not the only body
 * format this API has ever been sent, and refusing it would reject a real
 * acceptance; everything else is not an acceptance.
 */
function isAccepted(value: unknown): boolean {
  return value === true || value === "true";
}

/** True when the body says nothing about consent in any of the four fields. */
function mentionsConsent(body: Record<string, unknown>): boolean {
  return (
    body.acceptedTerms !== undefined ||
    body.acceptedPrivacy !== undefined ||
    body.termsVersion !== undefined ||
    body.privacyVersion !== undefined
  );
}

export function parseSignupConsent(body: unknown): SignupConsentResult {
  if (!body || typeof body !== "object") return { kind: "absent" };
  const fields = body as Record<string, unknown>;

  if (!mentionsConsent(fields)) return { kind: "absent" };

  if (!isAccepted(fields.acceptedTerms) || !isAccepted(fields.acceptedPrivacy)) {
    return {
      kind: "invalid",
      error: "Please accept the Terms of Service and the Privacy Policy to continue.",
    };
  }

  const termsVersion = cleanVersion(fields.termsVersion);
  const privacyVersion = cleanVersion(fields.privacyVersion);
  if (!termsVersion || !privacyVersion) {
    // Deliberately not a user-facing explanation of which field was wrong: a
    // person cannot act on it, because they did not type it. It is a client
    // defect and the message says so plainly enough to be searched for.
    return {
      kind: "invalid",
      error: "Consent was sent without the document versions. Please update the app and try again.",
    };
  }

  return { kind: "accepted", termsVersion, privacyVersion };
}
