/**
 * What to show when accepting an invitation is refused.
 *
 * This exists because app/invite.tsx decided what to render by SUBSTRING MATCH
 * on the server's prose:
 *
 *   if (msg.includes("not_found") || msg.includes("404"))      -> invalid
 *   else if (msg.includes("expired"))                          -> expired
 *   else if (msg.includes("wrong_user") || msg.includes("403")) -> wrong address
 *
 * None of those tokens is in a response body. The accept route answers 404 with
 * "Invite not found or has expired." and 403 with a sentence; it sends neither
 * `not_found` nor `wrong_user` nor a bare status in the text. So the first
 * branch never fired, the second one caught every 404 by way of the word
 * "expired" inside that one shared sentence, and a genuinely unknown token was
 * reported as expired. The `403` branch matched nothing either -- which is why
 * the device showed the generic wording for the refusal in item 3 of this
 * branch.
 *
 * The status and code never reached this decision at all: data-context's
 * doFetch threw `new Error(payload.error)` and dropped everything else. Both
 * halves are fixed -- doFetch now carries `status`, `code` and the parsed body
 * onto the error, and the decision is made here, on those fields, under test.
 *
 * Free of React Native imports on purpose: lib/test-setup.ts can load it.
 */

export type InviteRefusal = {
  /** Always a complete sentence. Never empty -- see the test of the same name. */
  message: string;
  /**
   * The address the invitation was issued to, and the address the request was
   * authenticated as. Both non-null ONLY for the wrong-recipient refusal, which
   * is the one case where signing out is the remedy -- so a caller can use
   * `invitedEmail !== null` to decide whether to offer it, without re-deriving
   * the condition.
   */
  invitedEmail: string | null;
  signedInAs: string | null;
};

const GENERIC = "Something went wrong accepting this invite.";

/**
 * A 404 covers all three of not-found, expired and already-used: the route
 * deliberately answers one status and one sentence for them, so that holding a
 * token tells you nothing about whether it ever existed. The wording therefore
 * has to cover all three rather than claim one of them.
 */
const NOT_USABLE =
  "This invite link is not valid. It may have expired, already been used, or been replaced by a newer invitation. Ask whoever invited you to send another.";

type ErrorFields = {
  status?: unknown;
  code?: unknown;
  body?: { invitedEmail?: unknown; signedInAs?: unknown } | null;
  message?: unknown;
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export function describeInviteRefusal(err: unknown): InviteRefusal {
  if (!err || typeof err !== "object") {
    return { message: GENERIC, invitedEmail: null, signedInAs: null };
  }
  const e = err as ErrorFields;
  const serverMessage = str(e.message);

  if (e.status === 403 && e.code === "invite_wrong_user") {
    const invitedEmail = str(e.body?.invitedEmail);
    const signedInAs = str(e.body?.signedInAs);
    if (invitedEmail && signedInAs) {
      // The server already composes the sentence naming both addresses, and it
      // is the same sentence the portal shows. Preferred over rebuilding it
      // here so the two clients cannot drift; the fallback covers an older API
      // reached by a newer bundle, which is the ordinary state of affairs for a
      // few minutes after an `eas update`.
      return {
        message:
          serverMessage ??
          `This invitation is for ${invitedEmail}. You're signed in as ${signedInAs} — sign out, then open the invitation link again to accept it.`,
        invitedEmail,
        signedInAs,
      };
    }
    // Code present, addresses absent. Still better than the old wording,
    // because it says what to do.
    return {
      message:
        serverMessage ??
        "This invitation was sent to a different email address. Sign out, then open the invitation link again.",
      invitedEmail: null,
      signedInAs: null,
    };
  }

  if (e.status === 404) {
    return { message: NOT_USABLE, invitedEmail: null, signedInAs: null };
  }

  return { message: serverMessage ?? GENERIC, invitedEmail: null, signedInAs: null };
}
