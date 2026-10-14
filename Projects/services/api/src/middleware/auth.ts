import { NextFunction, Request, RequestHandler, Response } from "express";
import {
  AuthClaims,
  CompanyRole,
  UserRole,
  createAuthToken,
  getSessionTimings,
  verifyAuthToken,
} from "../utils/authToken";
import { readSessionCookie, setSessionCookie } from "../utils/sessionCookie";
import { loadSessionIdentity } from "../storage/authStore";

export type AuthenticatedRequest = Request & {
  auth: AuthClaims;
  /**
   * Which credential the caller actually presented.
   *
   * A route that mints a replacement token mid-request has to deliver it on the
   * transport the caller can receive it on: the mobile client reads it out of
   * the JSON body, the portal cannot (its cookie is httpOnly) and needs a
   * Set-Cookie. Guessing from the User-Agent, or setting both unconditionally,
   * both end in a client holding two credentials at different generations.
   * `requireAuth` already knows which one it matched, so it says so.
   */
  authTransport: "bearer" | "cookie";
};

/**
 * Machine-readable discriminators on a 401.
 *
 * A 401 does not mean one thing. Three of this API's 401s are about the
 * CREDENTIAL IN THE REQUEST BODY, not about the session: a mistyped current
 * password (POST /auth/change-password), a wrong email or password at sign-in,
 * and a wrong registration verification code. The other 401s mean the bearer
 * token is absent or no longer acceptable.
 *
 * Until now the two were distinguishable only by comparing English prose, so a
 * client that wanted to route an expired session to sign-in had to either
 * string-match or treat every 401 the same. The first is fragile; the second is
 * worse, because signing someone out for mistyping their own password is the
 * same class of defect as telling them a timesheet failed when their session
 * had died. `code` is the discriminator, and the message stays for humans.
 *
 * WHAT IS DELIBERATELY NOT HERE: a distinction between "the signature did not
 * verify" and "the signature verified but `exp` has passed". Both answer
 * SESSION_EXPIRED. Separating them would tell someone probing with a forged
 * token whether their forgery produced a valid signature, which is the one
 * useful bit of feedback an attacker can get out of this endpoint.
 */
export const AUTH_ERROR_CODES = {
  /** No bearer token and no session cookie was presented at all. */
  NO_CREDENTIAL: "no_credential",
  /** A token was presented and is not acceptable — malformed, bad signature, or past `exp`. */
  SESSION_EXPIRED: "session_expired",
  /** A credential in the request BODY was wrong. The session, if any, is fine. */
  INVALID_CREDENTIALS: "invalid_credentials",
  /** A one-time verification code in the request BODY was wrong. */
  INVALID_VERIFICATION_CODE: "invalid_verification_code",
  /**
   * We could not find out whether this session is still valid, because the
   * user store was unreachable. **This is answered 503, never 401**, and a
   * client must never treat it as a signed-out session.
   *
   * It is in this enum because it comes out of the same code path as the 401s
   * and a client switching on `code` has to see it. It is not an auth failure:
   * the token verified, its signature is good, and it is not expired. The only
   * thing we do not know is the generation it must match.
   *
   * Answering 401 here would route every client in the field through its
   * session handler and sign out the entire fleet over a Postgres hiccup — the
   * defect this codebase has closed at the client (L73) and in the logger, one
   * layer further down. A 503 says "ask again shortly", which is true.
   */
  SESSION_UNAVAILABLE: "session_unavailable",
} as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[keyof typeof AUTH_ERROR_CODES];

/**
 * The wording a client shows when a session has died. It lives here rather than
 * in the client so the two cannot drift, and because the client has to be able
 * to fall back to its own copy when the request never reached us at all.
 */
export const SESSION_EXPIRED_MESSAGE = "Your session has expired. Please sign in again.";

function extractBearerToken(req: Request): string | null {
  const raw = req.headers.authorization;
  if (!raw) return null;
  const [scheme, token] = raw.split(" ");
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") return null;
  return token;
}

export type Credential = { token: string; transport: "bearer" | "cookie" };

/**
 * Where a credential comes from, defined once.
 *
 * `requireAuth` is not the only route that has to answer this: `/auth/refresh`
 * deliberately does NOT sit behind `requireAuth` (AUDIT L74 — a token that has
 * just expired must be able to refresh itself, and `requireAuth` refuses it by
 * definition), so it reads the credential itself. Two hand-rolled readers would
 * drift, and the one that drifted would be the one that stopped accepting the
 * portal's cookie — a browser cannot send a bearer header it has no way to read.
 *
 * Bearer wins over the cookie when both are present, as it always has: a
 * request carrying an explicit Authorization header means it.
 */
export function readCredential(req: Request): Credential | null {
  const bearer = extractBearerToken(req);
  if (bearer) return { token: bearer, transport: "bearer" };
  const cookie = readSessionCookie(req);
  if (cookie) return { token: cookie, transport: "cookie" };
  return null;
}

/**
 * The message for a token that is cryptographically fine but no longer names a
 * usable session — the account is gone, or a revocation has moved past it. It is
 * the same prose as an expiry on purpose: see the note in AUTH_ERROR_CODES about
 * what a more specific answer tells someone probing.
 */
const SESSION_UNAVAILABLE_MESSAGE =
  "We could not verify your session just now. Please try again in a moment.";

/**
 * Authenticates a request, and now also asks whether the session behind the
 * token is still one we recognise.
 *
 * WHY THIS IS ASYNC, WHICH IT WAS NOT BEFORE
 *
 * A signature check alone cannot answer revocation. Until this branch a stolen
 * token was good for its full seven days with no way to end it short of
 * rotating AUTH_TOKEN_SECRET and signing out every user of the product; a
 * demotion did not take effect until the holder happened to sign in again
 * (AUDIT L75, and the permissions hole Phase 1b opened on top of it). So every
 * authenticated request now reads the user's current token_generation and
 * refuses a token minted before it. That read is cached for 60 seconds per
 * instance, so the cost is one query per user per minute, not one per request,
 * and the revocation window is bounded by the same number.
 *
 * This is safe to make async because every route file builds its router with
 * `asyncSafeRouter`, which wraps `use` as well as the verbs, so a rejection out
 * of here becomes `next(err)` rather than a hung socket. It is belt and braces
 * — the body catches nothing itself, because `loadSessionIdentity` returns its
 * failure as a value rather than throwing.
 *
 * THE THREE OUTCOMES, AND WHY ONE OF THEM IS A 503
 *
 *   found, generation matches   -> next()
 *   found, generation is behind -> 401 session_expired
 *   no record at all            -> 401 session_expired
 *   store unreachable           -> 503 session_unavailable, NOT 401
 *
 * The last one is the part of this design that would be most costly to get
 * wrong, and the reasoning is at SESSION_UNAVAILABLE.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const credential = readCredential(req);
  if (!credential) {
    return res.status(401).json({ error: "Missing bearer token.", code: AUTH_ERROR_CODES.NO_CREDENTIAL });
  }
  const bearer = credential.transport === "bearer" ? credential.token : null;
  const claims = verifyAuthToken(credential.token);
  if (!claims) {
    // One answer for every unacceptable token. See AUTH_ERROR_CODES.
    return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE, code: AUTH_ERROR_CODES.SESSION_EXPIRED });
  }

  const result = await loadSessionIdentity(claims.email);
  if (!result.ok) {
    if (result.reason === "unavailable") {
      console.error("[auth] session identity unavailable", result.error);
      return res
        .status(503)
        .json({ error: SESSION_UNAVAILABLE_MESSAGE, code: AUTH_ERROR_CODES.SESSION_UNAVAILABLE });
    }
    // The signature verified, so this token was minted by us for an account
    // that no longer exists. Deleting an account used to leave its tokens
    // working until they expired; now it ends them.
    return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE, code: AUTH_ERROR_CODES.SESSION_EXPIRED });
  }

  // `<`, not `!==`. A token AHEAD of the record can only have been minted by us
  // at a generation the record held at the time, and the record does not go
  // backwards except through a database restore. `!==` would refuse such a
  // token — and there is a routine way to produce one: revoke-all increments on
  // one instance and clears only that instance's cache, so a second instance
  // can hold the previous generation for up to the cache TTL while the freshly
  // minted token is already in flight. That is a sign-in that cannot sign in,
  // which is the failure the required `tokenGeneration` parameter exists to
  // prevent; it would be perverse to reintroduce it here.
  if (claims.tokenGeneration < result.identity.tokenGeneration) {
    return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE, code: AUTH_ERROR_CODES.SESSION_EXPIRED });
  }

  // ── req.auth is RECORD-derived, not token-derived ─────────────────────────
  //
  // This is the line the whole session model turns on: see THE SESSION MODEL at
  // `storage/authStore.ts`'s SessionIdentity. The token proved who the caller
  // is; the row decides what they may do. Every route and store below reads its
  // actor from here, so taking companyId/companyRole/role from the row is what
  // makes a demotion or a removal take effect within the cache TTL instead of
  // whenever the holder's token happens to expire.
  //
  // It also means a stale claim never has to be refused. It is simply never
  // consulted — which is why `setUserCompany` and `setUserCompanyRole` do not
  // need to revoke anything, and why an invitee's pre-acceptance token keeps
  // working through the acceptance instead of ending at a login screen.
  //
  // `email` comes from the row too, for consistency, and provably cannot
  // differ: `findUserByEmail` matches the email exactly, so a row was only
  // found because it is byte-identical to the claim.
  const identity = result.identity;
  const effective: AuthClaims = {
    email: identity.email,
    fullName: identity.fullName,
    role: identity.role,
    companyId: identity.companyId,
    companyRole: identity.companyRole,
    iat: claims.iat,
    exp: claims.exp,
    // The higher of the two. Normally the row's. The token's can lead it when
    // revoke-all ran on another instance whose cache this one has not caught up
    // with yet — minting a replacement at the lower value would produce a token
    // the originating instance refuses.
    tokenGeneration: Math.max(claims.tokenGeneration, identity.tokenGeneration),
  };
  (req as AuthenticatedRequest).auth = effective;
  (req as AuthenticatedRequest).authTransport = bearer ? "bearer" : "cookie";

  // ── Repair and sliding renewal, for the cookie transport only ─────────────
  //
  // WHY THIS IS COOKIE-ONLY, AND WHY THAT IS NOT A HALF-MECHANISM
  //
  // A bearer caller gets no repair, and needs none. The stale claim it is
  // holding is never used for a decision — `effective` above came from the row
  // — so the request is already answered with the right authority. Handing the
  // mobile client a replacement token would need a response header carrying it,
  // which was considered and declined; without one the client has no way to
  // pick a re-minted token up, and it does not need one. It renews on its own
  // schedule through /auth/refresh, which mints from the row for the same
  // reason. So: cookie callers are repaired, bearer callers are simply correct.
  //
  // For the portal the repair is real, because a Set-Cookie does land. Three
  // things drive it:
  if (!bearer && !result.stale) {
    const { tokenTtlSeconds } = getSessionTimings();
    const age = Math.floor(Date.now() / 1000) - claims.iat;
    // (1) The claims in the cookie disagree with the row. The request itself is
    // already correct, but leaving the cookie wrong means the portal keeps
    // presenting stale claims and this comparison fires on every request. Write
    // the truth into it once instead.
    const staleClaims =
      claims.companyId !== effective.companyId ||
      claims.companyRole !== effective.companyRole ||
      claims.role !== effective.role ||
      claims.tokenGeneration !== effective.tokenGeneration;
    // (2) Past half-life. AUDIT L76: the portal signed people out every seven
    // days, at the moment the token expired, with no renewal anywhere. Half-life
    // rather than near-expiry so a weekly user is never close to the edge and a
    // renewal that fails to reach the browser has days of further attempts.
    const pastHalfLife = age > tokenTtlSeconds / 2;
    // (3) Never from a stale read (the `!result.stale` above). A stale identity
    // is good enough to let a request through — refusing would be the
    // fleet-wide sign-out this design exists to avoid — but not good enough to
    // stamp into a cookie that then carries it for another seven days.
    if (staleClaims || pastHalfLife) {
      // Minted from the RECORD. Copying the claims forward would defeat the
      // point of both branches above. The marginal cost is zero: the row is
      // already in hand.
      setSessionCookie(
        res,
        createAuthToken({
          email: effective.email,
          fullName: effective.fullName,
          role: effective.role,
          companyId: effective.companyId,
          companyRole: effective.companyRole,
          tokenGeneration: effective.tokenGeneration,
        }),
      );
    }
  }

  return next();
}

/**
 * What an OPERATIONAL route requires: an authenticated member of a company, at
 * any company role. Diaries, photographs, incidents, inspections, deliveries,
 * timesheets, entry templates and location are the field product, and a crew
 * member is the person who does that work — so these routes gate on identity
 * and the stores gate on tenancy, and rank does not come into it.
 *
 * WHY THIS IS AN ARRAY HOLDING ONE HANDLER, AND NOT `requireAtLeast("crew")`
 *
 * `requireAtLeast("crew")` would read like the explicit requirement this is, and
 * it would be a gate that cannot refuse anything. crew is rank 0, and
 * verifyAuthToken ALWAYS derives a companyRole — an absent or unrecognised
 * claim falls back to companyRoleFromLegacy(claims.role), never to undefined —
 * so every request requireAuth accepts already satisfies it. A check that
 * cannot fail is worse than no check, because it looks like protection in
 * review and in a diff (docs/VACUITY-AUDIT.md is the standing record of what
 * that costs here). The honest statement of "any authenticated member" is
 * requireAuth, named so that a reader can tell a deliberate decision from an
 * omission.
 *
 * It is an array so that a router states its requirement in ONE place —
 * `router.use("/incidents", ...FIELD_ACCESS)` — rather than repeating a
 * handler on every route, where the next route added is the one that forgets.
 * AUDIT L66 is what happens when a router's role requirement is expressed
 * anywhere other than against its own paths.
 */
export const FIELD_ACCESS: readonly RequestHandler[] = [requireAuth];

// ── Company-role middleware ──────────────────────────────────────────────────
const ROLE_RANK: Record<CompanyRole, number> = { crew: 0, viewer: 1, manager: 2, owner: 3 };

/** Requires the caller's company_role to rank at or above `min`. */
export function requireAtLeast(min: CompanyRole): RequestHandler {
  return (req, res, next) => {
    const role = (req as AuthenticatedRequest).auth?.companyRole;
    if (!role || ROLE_RANK[role] < ROLE_RANK[min]) {
      return res.status(403).json({ error: "Insufficient permissions." });
    }
    next();
  };
}

/** Requires the caller's company_role to be one of `allowed`. */
export function requireCompanyRole(...allowed: CompanyRole[]): RequestHandler {
  return (req, res, next) => {
    const role = (req as AuthenticatedRequest).auth?.companyRole;
    if (!role || !allowed.includes(role)) {
      return res.status(403).json({ error: "Insufficient permissions." });
    }
    next();
  };
}

/**
 * @deprecated Legacy role gate keyed on the pre-company `role` claim. Kept for
 * any route not yet migrated to company roles. New routes should use
 * requireAtLeast / requireCompanyRole instead.
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const auth = (req as AuthenticatedRequest).auth;
    if (!auth) {
      return res.status(401).json({ error: "Authentication required.", code: AUTH_ERROR_CODES.NO_CREDENTIAL });
    }
    if (!roles.includes(auth.role)) {
      return res.status(403).json({ error: "Insufficient permissions." });
    }
    return next();
  };
}
