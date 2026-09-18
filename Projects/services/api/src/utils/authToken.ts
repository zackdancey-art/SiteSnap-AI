import crypto from "crypto";
import { readIntEnv } from "./env";

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
};

// A TTL of 0 would mint tokens that are already expired; min 1 makes that a
// boot failure rather than a fleet-wide logout.
const TOKEN_TTL_SECONDS = readIntEnv("AUTH_TOKEN_TTL_SECONDS", 60 * 60 * 24 * 7, { min: 1 });

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
  };
  const payload = base64UrlEncode(JSON.stringify(claims));
  const signature = signPayload(payload);
  return `${payload}.${signature}`;
}

export function verifyAuthToken(token: string): AuthClaims | null {
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
    if (claims.exp < Math.floor(Date.now() / 1000)) return null;

    // Backward compat: tokens minted before the company model lack these
    // fields. Derive stable defaults so older sessions keep working.
    const companyRole: CompanyRole =
      claims.companyRole && COMPANY_ROLES.includes(claims.companyRole)
        ? claims.companyRole
        : companyRoleFromLegacy(claims.role);
    const companyId = claims.companyId ?? soloCompanyIdForEmail(claims.email);

    return { ...claims, companyId, companyRole } as AuthClaims;
  } catch {
    return null;
  }
}
