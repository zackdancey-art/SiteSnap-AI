/**
 * What a 401 means, decided in one place.
 *
 * THE DEFECT THIS EXISTS FOR
 * An API deploy left every stored token unacceptable. Every authenticated write
 * then failed, and each one reported the failure in the vocabulary of whatever
 * feature happened to make the call: "Failed to save timesheet", "Failed to save
 * signature", "invite denied". None of them said the true thing, which is that
 * the session was over and signing in again would fix all of it at once. The
 * person on the phone concluded the features were broken, because that is what
 * the app told them.
 *
 * The cause was not one bad call site. Seven screens had each written their own
 * authenticated `fetch` helper, and exactly one of the fourteen places that
 * attach a bearer token had any 401 handling at all. A 401 is not a feature
 * error and no feature can usefully describe it, so no feature should try.
 *
 * WHY A LATCH AND NOT A TIME WINDOW
 * A 401 arrives once per in-flight request, and there can be many: the session
 * that produced this module's first report had twenty-one media-signing requests
 * fail together. Twenty-one navigations to the sign-in screen is its own defect.
 * A time window would also be wrong — it would re-fire on the next request after
 * the window lapsed, while the person is still sitting on the sign-in screen
 * typing. So the notice latches: raised once, and lowered only by
 * `clearSessionExpired()`, which the auth layer calls when a session genuinely
 * begins or ends. The latch is the state "we have already said this".
 *
 * This module is deliberately free of React Native imports: it holds the only
 * decision worth testing, and the node test program cannot compile a module that
 * reaches AsyncStorage or the navigator. The parts that need those live in
 * lib/authed-fetch.ts, which is a thin shell over this.
 */

/**
 * The words the person actually reads. One sentence, naming the cause and the
 * remedy, in place of the feature-specific message that was wrong.
 */
export const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please sign in again.";

/**
 * The `code` values on an API 401 that mean the SESSION is over.
 *
 * A 401 does not mean one thing, and keying the whole app off the status alone
 * was a second bug waiting behind the first. POST /api/auth/change-password
 * answers 401 for a mistyped CURRENT PASSWORD — an authenticated request, a
 * perfectly live session, a credential in the body that was wrong. Treating
 * that as an expiry would sign someone out of the app for a typo, which is the
 * same substitution-of-the-wrong-cause this module exists to remove, pointing
 * the other way.
 *
 * So the server now discriminates (services/api/src/middleware/auth.ts,
 * AUTH_ERROR_CODES) and this is the half of that contract the client holds.
 */
export const SESSION_ERROR_CODES: readonly string[] = ["session_expired", "no_credential"];

/**
 * Whether a 401's `code` means the session, as opposed to something in the
 * request body.
 *
 * An ABSENT or non-string code reads as a session failure, deliberately. Every
 * 401 in this API was session-shaped before the codes existed, the client can
 * be newer than the deployed API (an `eas update` lands on the next launch, a
 * Render deploy takes minutes), and a session the app wrongly believes is dead
 * costs one sign-in — while a session it wrongly believes is live costs the
 * silent-failure defect all over again. Fail towards sign-in.
 */
export function isSessionErrorCode(code: unknown): boolean {
  if (typeof code !== "string" || code === "") return true;
  return SESSION_ERROR_CODES.includes(code);
}

/**
 * Thrown in place of whatever a call site would otherwise have invented. It
 * carries `status` because the existing helpers in lib/data-context.tsx already
 * signal through a `status` property and some callers branch on it.
 */
export class SessionExpiredError extends Error {
  readonly status = 401;
  readonly code = "session_expired";
  constructor(message: string = SESSION_EXPIRED_MESSAGE) {
    super(message);
    this.name = "SessionExpiredError";
  }
}

/**
 * Whether a caught value is the end of a session rather than a feature failure.
 *
 * Checks the shape rather than `instanceof`, because an error can cross a module
 * boundary that duplicated this module (two bundles, a hot reload) and because
 * the pre-existing helpers throw a plain Error with `status` set. Both must be
 * recognised, or a call site will show its own message for a 401 again — which
 * is the whole defect.
 *
 * A 401 carrying a non-session `code` is NOT an expiry and the call site keeps
 * its own reporting — that is the mistyped-password case, where the feature's
 * message is the correct one. See isSessionErrorCode.
 */
export function isSessionExpired(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; code?: unknown };
  if (e.status !== 401) return false;
  return isSessionErrorCode(e.code);
}

type SessionExpiredHandler = () => void;

let handler: SessionExpiredHandler | null = null;
let raised = false;

/**
 * Registers the one thing that happens when a session ends: sign out, and route
 * to the sign-in screen carrying SESSION_EXPIRED_MESSAGE. Called once, by the
 * auth provider. Returns the previous handler so a provider that remounts can
 * restore rather than leak.
 */
export function setSessionExpiredHandler(fn: SessionExpiredHandler | null): SessionExpiredHandler | null {
  const previous = handler;
  handler = fn;
  return previous;
}

/**
 * Report that the server refused a credential we had. Idempotent while the
 * notice stands: the first caller runs the handler, every later caller is a
 * no-op until `clearSessionExpired()`.
 *
 * Returns whether this call was the one that raised the notice, so a caller can
 * tell "I ended the session" from "it was already over" without reading state.
 */
export function notifySessionExpired(): boolean {
  if (raised) return false;
  raised = true;
  // The handler navigates, which must not be able to stop a 401 from being
  // converted into SessionExpiredError at the call site that asked.
  try {
    handler?.();
  } catch {
    // Swallowed on purpose. A throw here would surface at an arbitrary call
    // site as that feature's error, which is the exact failure mode this module
    // exists to remove.
  }
  return true;
}

/** Whether the session-expired notice currently stands. */
export function isSessionExpiredNoticeRaised(): boolean {
  return raised;
}

/**
 * Lower the notice. Called when a session begins (a successful sign-in or token
 * refresh) or deliberately ends (sign-out) — the two moments after which a fresh
 * 401 is news again.
 */
export function clearSessionExpired(): void {
  raised = false;
}

/** Test-only reset, matching the `reset*ForTests` convention in the API stores. */
export function resetSessionForTests(): void {
  handler = null;
  raised = false;
}
