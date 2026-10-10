/**
 * Whether the signature sheet has enough to save, and if not, what to say.
 *
 * THE DEFECT THIS EXISTS FOR
 * Adding a signature to an inspection and tapping Save did nothing: no error, no
 * navigation, no saved record. The Save control was `disabled` until both the
 * signer's name and a stroke were present, and a disabled Pressable runs no
 * onPress — so the tap was swallowed. The handler behind it also opened with a
 * bare `if (!showActive || !sigName.trim() || !sigPath) return;`, so even once
 * the press landed there was a second silent exit.
 *
 * The stroke is captured on the first touch (SignaturePad emits onChange from
 * the pan gesture's onBegin), so after signing, the only state that could still
 * be blocking was an empty name — a placeholder-only field at the top of a
 * scrollable region, above the canvas, with no label and no required marker.
 *
 * WHY THIS IS A MODULE AND NOT AN `if` IN THE SCREEN
 * The sheet has cost four rounds of fixing already, three of them plausible
 * changes that changed nothing, and the screen itself cannot be loaded by the
 * node test program — it reaches React Native. The decision is therefore kept
 * here, free of React Native imports, where "an incomplete form produces words
 * rather than silence" is an assertion instead of a hope.
 */

export type SignatureInput = {
  /** Raw contents of the signer-name field, untrimmed. */
  signerName: string;
  /** The SVG path the pad has captured. Empty before the first touch. */
  path: string;
  /** Whether an inspection is still open behind the sheet. */
  hasInspection: boolean;
};

/**
 * The sentence to show, or null when the input is complete and the save should
 * be attempted.
 *
 * Never returns an empty string: "" and null are the same falsy value at a call
 * site, and that collapse is how a validation failure becomes silence. Every
 * refusal has words.
 */
export function describeIncompleteSignature(input: SignatureInput): string | null {
  const signerName = input.signerName.trim();
  const signed = input.path !== "";

  // Each branch names the ONE next action. A combined "complete all fields"
  // would be the same silence with extra words, because the field that is
  // missing is the one the sheet never labelled.
  if (!signerName && !signed) return "Enter the signer's name, then sign in the box below.";
  if (!signerName) return "Enter the signer's name above before saving.";
  if (!signed) return "Sign in the box below before saving.";

  // Not reachable from the UI - the sheet renders inside the open inspection -
  // but it was the other half of the silent `return`, so it gets words too.
  if (!input.hasInspection) return "This inspection is no longer open. Close this sheet and open it again.";

  return null;
}

/**
 * What to say when the request itself failed.
 *
 * Prefers the server's own sentence, which is written for the person reading it,
 * and rejects the `API <status>` placeholder the old screen helpers threw —
 * "API 409" tells a site manager nothing. Always returns a sentence: a save that
 * failed must say so, whatever went wrong.
 */
export function describeSignatureSaveFailure(err: unknown): string {
  const fallback = "The signature was not saved. Check your connection and try again.";
  if (!(err instanceof Error)) return fallback;
  const message = err.message.trim();
  if (!message || /^API \d+$/.test(message)) return fallback;
  return message;
}
