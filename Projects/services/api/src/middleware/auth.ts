import { NextFunction, Request, RequestHandler, Response } from "express";
import { AuthClaims, CompanyRole, UserRole, verifyAuthToken } from "../utils/authToken";

export type AuthenticatedRequest = Request & { auth: AuthClaims };

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

function extractSessionCookie(req: Request): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === "sitesnap.session") {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = extractBearerToken(req) ?? extractSessionCookie(req);
  if (!token) {
    return res.status(401).json({ error: "Missing bearer token.", code: AUTH_ERROR_CODES.NO_CREDENTIAL });
  }
  const claims = verifyAuthToken(token);
  if (!claims) {
    // One answer for every unacceptable token. See AUTH_ERROR_CODES.
    return res.status(401).json({ error: SESSION_EXPIRED_MESSAGE, code: AUTH_ERROR_CODES.SESSION_EXPIRED });
  }
  (req as AuthenticatedRequest).auth = claims;
  return next();
}

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
