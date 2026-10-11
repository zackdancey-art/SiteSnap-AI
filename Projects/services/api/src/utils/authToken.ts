import crypto from "crypto";
import { readIntEnv } from "./env";
import { COOKIE_MAX_AGE_MS } from "./sessionCookie";

export type UserRole = "worker" | "supervisor" | "admin";
export type CompanyRole = "owner" | "manager" | "viewer" | "crew";

export type AuthClaims = {
  email: string;
  fullName: string;
  companyId: string;
  companyRole: CompanyRole;
  // Legacy role retained for backward compatibility during the transition.
  role: UserRole;
  iat: number;
  exp: number;
  /**
   * The user's `auth_users.token_generation` at the moment this token was
   * minted. `middleware/auth.ts` compares it against the current value on every
   * authenticated request; a token whose generation is behind is refused.
   *
   * Named for the column rather than introduced as a third word for the same
   * number. Absent on every token minted before this branch, and read as 0 for
   * those — see verifyAuthToken.
   */
  tokenGeneration: number;
};

// A TTL of 0 would mint tokens that are already expired; min 1 makes that a
// boot failure rather than a fleet-wide logout.
const TOKEN_TTL_SECONDS = readIntEnv("AUTH_TOKEN_TTL_SECONDS", 60 * 60 * 24 * 7, { min: 1 });

/**
 * How long a session survives without being used.
 *
 * This is NOT the token's lifetime. The token lives TOKEN_TTL_SECONDS (seven
 * days); past that, `/auth/refresh` will still exchange it for a new one until
 * this much time has passed since it was minted. So a person using the app is
 * never signed out, and a person who stops using it is signed out somewhere
 * between (this minus the TTL) and this — between 23 and 30 days — depending on
 * where in the seven-day cycle they stopped. Renewal happens at expiry, not
 * continuously, which is what makes it a range rather than a number.
 *
 * The 30 days is not invented here, and it is not written here either. It is
 * COOKIE_MAX_AGE_MS, imported, which the portal has been setting since the
 * cookie model landed: the browser was already being told to keep the session
 * for 30 days while the token inside it was honoured for 7. One of those two
 * numbers was wrong, and two numbers that disagree are worse than one that is
 * slightly generous — so there is now one number, and changing the cookie's
 * lifetime moves this with it.
 */
const SESSION_MAX_IDLE_SECONDS = readIntEnv(
  "AUTH_SESSION_MAX_IDLE_SECONDS",
  Math.floor(COOKIE_MAX_AGE_MS / 1000),
  { min: 1 },
);

/**
 * How far past `exp` the refresh route will still accept a token.
 *
 * Derived rather than configured, so the two numbers cannot drift into a state
 * where the grace outlives the session. Clamped at 0 for the case where the TTL
 * is configured longer than the idle limit, which would otherwise produce a
 * negative grace and an off-by-a-month acceptance window.
 */
const REFRESH_GRACE_SECONDS = Math.max(0, SESSION_MAX_IDLE_SECONDS - TOKEN_TTL_SECONDS);

/**
 * Both numbers, for the middleware that renews at half-life and for the tests
 * that measure these rather than asserting them.
 *
 * Still read once at module load, so changing either needs a restart. That was
 * worth recording when the TTL was the cause of the weekly sign-out (AUDIT
 * L76); it stops mattering now that the TTL is not the thing that has to change
 * to fix it, and on Render a configuration change restarts the service anyway.
 */
export function getSessionTimings() {
  return {
    tokenTtlSeconds: TOKEN_TTL_SECONDS,
    sessionMaxIdleSeconds: SESSION_MAX_IDLE_SECONDS,
    refreshGraceSeconds: REFRESH_GRACE_SECONDS,
  };
}

export const ELEVATED_ROLES: UserRole[] = ["supervisor", "admin"];

/**
 * @deprecated Legacy elevation check kept only for auth-route call sites that
 * still reference the pre-company `role`. Company scoping no longer uses this —
 * all enforcement filters by companyId + companyRole. Do not add new callers.
 */
export function isElevatedRole(role: UserRole) {
  return role === "supervisor" || role === "admin";
}

// ── Legacy ↔ company role mapping (transition helpers) ────────────────────────
export function companyRoleFromLegacy(role: UserRole): CompanyRole {
  if (role === "admin") return "owner";
  if (role === "supervisor") return "manager";
  return "crew";
}

export function legacyRoleFromCompany(companyRole: CompanyRole): UserRole {
  if (companyRole === "owner") return "admin";
  if (companyRole === "manager") return "supervisor";
  // viewer + crew both map to the least-privileged legacy role.
  return "worker";
}

// Deterministic per-email solo-company id — mirrors the SQL backfill
// ('company_' || md5(email)) so tokens minted without an explicit company
// (legacy callers / dev in-memory mode) land on a stable, unique company.
export function soloCompanyIdForEmail(email: string): string {
  return `company_${crypto.createHash("md5").update(email).digest("hex")}`;
}

function getTokenSecret() {
  const secret = process.env.AUTH_TOKEN_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_TOKEN_SECRET environment variable is required in production.");
    }
    return "dev-sitesnap-secret";
  }
  return secret;
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(payloadBase64: string) {
  return crypto.createHmac("sha256", getTokenSecret()).update(payloadBase64).digest("base64url");
}

const COMPANY_ROLES: CompanyRole[] = ["owner", "manager", "viewer", "crew"];

export function createAuthToken(input: {
  email: string;
  fullName: string;
  role?: UserRole;
  companyId?: string;
  companyRole?: CompanyRole;
  /**
   * Required, with no default, on purpose. A mint site that defaulted this to 0
   * for a user whose record says 3 would produce a token that is refused the
   * instant it is used — a sign-in that cannot sign in. Required makes every
   * such site a typecheck error; a default makes it a support ticket.
   */
  tokenGeneration: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  // Derive missing pieces so legacy callers (and dev/in-memory paths) still
  // produce a fully-formed company token.
  const companyRole: CompanyRole =
    input.companyRole ?? (input.role ? companyRoleFromLegacy(input.role) : "owner");
  const role: UserRole = input.role ?? legacyRoleFromCompany(companyRole);
  const companyId = input.companyId ?? soloCompanyIdForEmail(input.email);

  const claims: AuthClaims = {
    email: input.email,
    fullName: input.fullName,
    companyId,
    companyRole,
    role,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    tokenGeneration: input.tokenGeneration,
  };
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = signPayload(payload);
  return `${payload}.${signature}`;
}

/**
 * Verifies a token, optionally accepting one that expired recently.
 *
 * `expiryGraceSeconds` is the ONLY difference between the two exported
 * verifiers. Everything an attacker controls -- the signature, the payload's
 * shape, the role whitelist -- is checked identically, because the refresh route
 * has to be reachable by exactly the tokens it exists to serve and by nothing
 * else. A refresh that accepts anything is worse than one that accepts nothing.
 */
function verifyToken(token: string, expiryGraceSeconds: number): AuthClaims | null {
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expectedSignature = signPayload(payload);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (providedBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(providedBuffer, expectedBuffer)) return null;

  try {
    const claims = JSON.parse(base64UrlDecode(payload)) as Partial<AuthClaims>;
    if (!claims.email || !claims.exp || !claims.iat || !claims.role || !claims.fullName) {
      return null;
    }
    if (!["worker", "supervisor", "admin"].includes(claims.role)) return null;
    if (claims.exp + expiryGraceSeconds < Math.floor(Date.now() / 1000)) return null;

    // Backward compat: tokens minted before the company model lack these
    // fields. Derive stable defaults so older sessions keep working.
    const companyRole: CompanyRole =
      claims.companyRole && COMPANY_ROLES.includes(claims.companyRole)
        ? claims.companyRole
        : companyRoleFromLegacy(claims.role);
    const companyId = claims.companyId ?? soloCompanyIdForEmail(claims.email);

    // A token minted before this branch carries no generation, and every row in
    // auth_users holds 0 (migration 012's DEFAULT, applied in production since
    // June). So reading an absent claim as 0 is not leniency -- the two values
    // genuinely agree, and nobody is signed out by the deploy. It is also not
    // forgeable: the claim is inside the HMAC-signed payload, so stripping it to
    // get a 0 changes the signature. The grandfathering closes itself, because
    // the first revoke-all on an account takes it to 1 and its pre-deploy tokens
    // stop verifying from then on.
    const tokenGeneration =
      typeof claims.tokenGeneration === "number" && Number.isFinite(claims.tokenGeneration)
        ? claims.tokenGeneration
        : 0;

    return { ...claims, companyId, companyRole, tokenGeneration } as AuthClaims;
  } catch {
    return null;
  }
}

/** The request path: a token must not be expired at all. */
export function verifyAuthToken(token: string): AuthClaims | null {
  return verifyToken(token, 0);
}

/**
 * The refresh path: a token may be up to REFRESH_GRACE_SECONDS past `exp`.
 *
 * This is the fix for AUDIT L74. `/auth/refresh` was mounted behind
 * `requireAuth` -- the middleware that had just refused the token -- so the one
 * route whose entire purpose is to replace an expired token could only ever be
 * reached by a token that did not need replacing. The recovery path was
 * reachable only when it was not needed, and had therefore never worked once.
 */
export function verifyAuthTokenForRefresh(token: string): AuthClaims | null {
  return verifyToken(token, REFRESH_GRACE_SECONDS);
}
