/**
 * One definition of what it means to normalise an email address for storage
 * and comparison in this system.
 *
 * WHY THIS FILE EXISTS
 *
 * AUDIT L46. Registration and login have always normalised — `routes/auth.ts`
 * does `String(req.body?.email ?? "").trim().toLowerCase()` at register,
 * verify-email, verify and login — while the two invite routes stored whatever
 * was typed, and `acceptSiteInvite` compared the two halves with `!==`. So an
 * owner who typed `Sam.Taylor@Example.com` created an invitation that the real
 * Sam could never accept: they signed up as `sam.taylor@example.com` and were
 * refused `wrong_user`, a message meaning "this invitation is for somebody
 * else". It was for them. Nothing told either party that the fix was for the
 * owner to re-issue it in lower case.
 *
 * Three send surfaces were patched client-side to paper over this — mobile's
 * two invite screens and the portal's Team page all `.toLowerCase()` before
 * sending. That stops new bad rows from those three screens and does nothing
 * for a direct API call, and nothing at all for rows already in the database.
 * A client-side fix to a server-side comparison is a mitigation, not a fix.
 *
 * WHY A FUNCTION RATHER THAN `.toLowerCase()` AT EACH CALL SITE
 *
 * Because the bug was precisely that two call sites disagreed about the rule,
 * and a rule written out four times is four rules. Every place that writes or
 * compares an email address in an invitation path calls this, so there is one
 * answer to "are these the same person" and a test can assert on it.
 *
 * WHY CASE-FOLDING IS THE RIGHT RULE HERE, THOUGH IT IS WRONG IN GENERAL
 *
 * RFC 5321 makes the local-part case-SENSITIVE: `Sam@x.com` and `sam@x.com`
 * are formally different mailboxes, and a provider is entitled to treat them
 * as different people. No provider anyone uses does. More decisively: the
 * other half of every comparison in this system has already been folded by
 * `routes/auth.ts` since before invitations existed, so storing what was typed
 * cannot make the comparison more correct — it can only make it fail. Folding
 * both halves is the only choice that is self-consistent.
 *
 * What is deliberately NOT done: no Gmail dot-stripping, no `+tag` removal, no
 * unicode or punycode handling of the domain. Those change which mailbox an
 * address denotes and would silently merge two people into one. Trim and fold,
 * nothing else.
 */

/**
 * The stored and compared form of an email address: trimmed, lower-cased.
 *
 * Non-string input yields `""` rather than throwing — callers are route
 * handlers reading untrusted JSON, and an empty string fails the surrounding
 * `z.string().email()` cleanly instead of turning a malformed body into a 500.
 */
export function normalizeEmail(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.trim().toLowerCase();
}

/**
 * Whether two addresses denote the same person for invitation purposes.
 *
 * Use this instead of `===` anywhere an invitation's stored address is compared
 * against an authenticated account's. Two empty strings are NOT a match: an
 * absent address must never satisfy an identity check, which is what would
 * happen if a missing `invited_email` were compared against a missing claim.
 */
export function sameEmail(a: unknown, b: unknown): boolean {
  const left = normalizeEmail(a);
  const right = normalizeEmail(b);
  if (!left || !right) return false;
  return left === right;
}
