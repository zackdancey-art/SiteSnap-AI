import type { Request, Response } from "express";

/**
 * The portal's session transport, in one place.
 *
 * WHY THIS IS NOT IN `routes/auth.ts` ANY MORE
 *
 * These four things were private to that file, and the cookie's NAME was
 * additionally written out as a bare string literal in `middleware/auth.ts`,
 * where the inbound cookie is read. Two copies of the name is the kind of
 * duplication that survives review and then costs an afternoon: rename it in one
 * place and every portal request starts answering 401 with a cookie sitting
 * right there in the headers.
 *
 * The forcing move is the half-life renewal in `middleware/auth.ts` — it has to
 * SET this cookie, not just read it, and middleware importing from `routes/`
 * inverts the dependency (routes already import the middleware, so it would also
 * be a cycle). So the transport moves down to `utils/`, which both layers may
 * depend on, and the name exists once.
 *
 * `utils/authToken.ts` reads COOKIE_MAX_AGE_MS from here too, which is what
 * makes the session's idle limit genuinely derived from the cookie's lifetime
 * rather than a second 30 written next to a comment claiming they agree.
 */
export const SESSION_COOKIE = "sitesnap.session";

/**
 * How long the browser is told to keep the session cookie.
 *
 * This is the outer bound on a portal session: once the browser drops the
 * cookie, nothing the API does about token lifetimes matters. `authToken.ts`
 * derives AUTH_SESSION_MAX_IDLE_SECONDS from it for exactly that reason.
 */
export const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE_MS,
    path: "/",
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  });
}

/**
 * The inbound half. Hand-parsed rather than via `req.cookies` because the API
 * does not mount `cookie-parser` — the portal is the only cookie client and this
 * is the only cookie it sends.
 */
export function readSessionCookie(req: Request): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}
