import path from "path";
import { getPgPool } from "./postgres";
import { FileBackedStore } from "./fileStore";
import { CompanyRole, soloCompanyIdForEmail } from "../utils/authToken";

export type AuthUser = {
  email: string;
  passwordHash: string;
  phone: string | null;
  fullName: string;
  role: "worker" | "supervisor" | "admin";
  companyId: string;
  companyRole: CompanyRole;
  createdAt: string;
  /**
   * The generation this user's tokens must carry to be accepted. Incrementing
   * it refuses every token minted before the increment — see
   * `loadSessionIdentity` and `revokeAllSessions` below. The column was added by
   * migration 012 (`DEFAULT 0`) and, until this branch, read by nothing.
   */
  tokenGeneration: number;
};

export type PendingRegistration = {
  email: string;
  passwordHash: string;
  phone: string;
  emailCode: string;
  /**
   * NULL until the email code is verified. The SMS is only minted and sent at
   * that point (migration 029), so a pending signup that never proves control
   * of its mailbox never costs a Twilio message.
   */
  smsCode: string | null;
  emailVerifiedAt: string | null;
  smsSentAt: string | null;
  expiresAt: string;
  attempts: number;
};

export type PasswordResetRecord = {
  token: string;
  email: string;
  expiresAt: string;
};

type AuthMemoryJson = {
  users: AuthUser[];
  pending: PendingRegistration[];
  resetTokens: PasswordResetRecord[];
};

const memoryUsers = new Map<string, AuthUser>();
const memoryPending = new Map<string, PendingRegistration>();
const memoryResetTokens = new Map<string, PasswordResetRecord>();
// Per-user personal settings bag (migration 028), keyed by email. Kept separate
// from AuthUser so the general user object/columns are untouched.
const memorySettings = new Map<string, Record<string, unknown>>();

function useDatabase() {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
}

function uniqueViolationError(message: string) {
  return { code: "23505", message };
}

const store = new FileBackedStore<Partial<AuthMemoryJson>>(
  path.join(process.cwd(), "data", "auth-store.json"),
  (parsed) => {
    for (const user of Array.isArray(parsed.users) ? parsed.users : []) {
      memoryUsers.set(user.email, user);
    }
    for (const pending of Array.isArray(parsed.pending) ? parsed.pending : []) {
      memoryPending.set(pending.email, pending);
    }
    for (const token of Array.isArray(parsed.resetTokens) ? parsed.resetTokens : []) {
      memoryResetTokens.set(token.token, token);
    }
  },
  () => ({
    users: Array.from(memoryUsers.values()),
    pending: Array.from(memoryPending.values()),
    resetTokens: Array.from(memoryResetTokens.values()),
  })
);

async function ensureMemoryLoaded() {
  if (useDatabase()) return;
  await store.ensureLoaded();
}

async function persistMemory() {
  if (useDatabase()) return;
  await store.persist();
}

export async function initAuthSchema() {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    return;
  }

  await getPgPool().query(`
    CREATE TABLE IF NOT EXISTS auth_users (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      phone TEXT,
      full_name TEXT NOT NULL DEFAULT 'User',
      role TEXT NOT NULL DEFAULT 'worker',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await getPgPool().query(`
    ALTER TABLE auth_users
    ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT 'User'
  `);
  await getPgPool().query(`
    ALTER TABLE auth_users
    ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'worker'
  `);

  await getPgPool().query(`
    CREATE UNIQUE INDEX IF NOT EXISTS auth_users_phone_idx
      ON auth_users(phone)
      WHERE phone IS NOT NULL
  `);

  await getPgPool().query(`
    CREATE TABLE IF NOT EXISTS auth_pending_registrations (
      email TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      phone TEXT NOT NULL,
      email_code TEXT NOT NULL,
      sms_code TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await getPgPool().query(`
    CREATE TABLE IF NOT EXISTS auth_password_reset_tokens (
      token TEXT PRIMARY KEY,
      email TEXT NOT NULL REFERENCES auth_users(email) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

/**
 * The shape every `SELECT ${USER_COLUMNS}` returns.
 *
 * This was six identical inline annotations, in two different formattings,
 * before `token_generation` had to be added to all of them. Named once, a column
 * added to USER_COLUMNS and not to this type fails `mapUser` at typecheck;
 * copied six times, the one site that gets missed returns `undefined` and the
 * generation check silently compares against nothing. The duplication was the
 * hazard, not the verbosity.
 */
type UserRow = {
  email: string;
  password_hash: string;
  phone: string | null;
  full_name: string;
  role: "worker" | "supervisor" | "admin";
  company_id: string | null;
  company_role: CompanyRole | null;
  created_at: Date;
  token_generation: number;
};

function mapUser(row: UserRow): AuthUser {
  return {
    email: row.email,
    passwordHash: row.password_hash,
    phone: row.phone,
    fullName: row.full_name,
    role: row.role,
    // company_id is NOT NULL post-backfill; coalesce defensively for any
    // pre-migration row read before 016 ran.
    companyId: row.company_id ?? soloCompanyIdForEmail(row.email),
    companyRole: row.company_role ?? "owner",
    createdAt: row.created_at.toISOString(),
    tokenGeneration: row.token_generation,
  };
}

const USER_COLUMNS =
  "email, password_hash, phone, full_name, role, company_id, company_role, created_at, token_generation";

function mapPending(row: {
  email: string;
  password_hash: string;
  phone: string;
  email_code: string;
  sms_code: string | null;
  email_verified_at: Date | null;
  sms_sent_at: Date | null;
  expires_at: Date;
  attempts: number;
}): PendingRegistration {
  return {
    email: row.email,
    passwordHash: row.password_hash,
    phone: row.phone,
    emailCode: row.email_code,
    smsCode: row.sms_code,
    emailVerifiedAt: row.email_verified_at ? row.email_verified_at.toISOString() : null,
    smsSentAt: row.sms_sent_at ? row.sms_sent_at.toISOString() : null,
    expiresAt: row.expires_at.toISOString(),
    attempts: row.attempts,
  };
}

export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    return memoryUsers.get(email) ?? null;
  }

  const result = await getPgPool().query<UserRow>(
    `SELECT ${USER_COLUMNS} FROM auth_users WHERE email = $1 LIMIT 1`,
    [email]
  );
  if (result.rowCount === 0) {
    return null;
  }
  return mapUser(result.rows[0]);
}

/** Read the caller's personal settings bag (migration 028). `{}` if none set. */
// ─── Session identity: what every authenticated request has to know ─────────

/**
 * The slice of the user record `requireAuth` needs on every authenticated
 * request, and the only reason that middleware touches the database at all.
 *
 * Two jobs, one row:
 *   - `tokenGeneration`, compared against the token's claim. This is what makes
 *     `/auth/revoke-all` real (AUDIT L75): the route used to mint a new token
 *     and invalidate nothing, so a lost phone kept working for seven days.
 *   - the current claims, used to MINT a renewed token. A renewal that copied
 *     the claims out of the token it replaced would carry a stale `companyRole`
 *     for the whole life of the session, which after crew permissions landed is
 *     a live permissions hole rather than a cosmetic one.
 */
export type SessionIdentity = {
  email: string;
  fullName: string;
  role: AuthUser["role"];
  companyId: string;
  companyRole: CompanyRole;
  tokenGeneration: number;
};

/**
 * Deliberately three outcomes, not two.
 *
 * `not_found` and `unavailable` must never collapse into one answer. The first
 * is a dead session and belongs at 401; the second is Postgres being
 * unreachable and belongs at 503. Answering 401 for an unreachable database
 * would route every client in the field through the session handler and sign
 * out the entire fleet over an infrastructure blip — the defect this codebase
 * has now closed at the client (L73) and the logger, one layer further down.
 * `middleware/auth.ts` is where that distinction is spent.
 */
export type SessionIdentityResult =
  | { ok: true; identity: SessionIdentity; stale: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "unavailable"; error: unknown };

/**
 * How long a read is reused. This is the whole cost control: without it, every
 * authenticated request adds a database round trip to a middleware that
 * previously did no I/O at all. With it, the amortised cost is one read per
 * user per instance per minute.
 *
 * The price is paid in revocation latency, and it is the honest number to
 * quote: a revoke-all takes effect immediately on the instance that served it
 * (it evicts its own entry) and within SESSION_IDENTITY_TTL_MS on any other.
 */
const SESSION_IDENTITY_TTL_MS = 60_000;

/**
 * How long a cached identity may be served AFTER a failed read.
 *
 * Mostly this window is safe by construction: a revoke-all is a database write,
 * so an unreachable database cannot have accepted one that this cache is
 * missing. It is bounded anyway for the sequence where it is not — a revoke
 * lands, the database dies seconds later, and the pre-revoke entry is still
 * cached. Past this grace the answer becomes 503: "we cannot verify your
 * session" is true, and it is not the same claim as "your session has ended".
 */
const SESSION_IDENTITY_STALE_GRACE_MS = 5 * 60_000;

type SessionIdentityEntry = { identity: SessionIdentity; readAt: number };
const sessionIdentityCache = new Map<string, SessionIdentityEntry>();

function identityFromUser(user: AuthUser): SessionIdentity {
  return {
    email: user.email,
    fullName: user.fullName,
    role: user.role,
    companyId: user.companyId,
    companyRole: user.companyRole,
    tokenGeneration: user.tokenGeneration,
  };
}

/**
 * Drops one user's cached identity.
 *
 * Called by every function in this file that changes a claim or the generation.
 * It is called from inside those functions rather than by their callers, because
 * a caller that forgets leaves a 60-second window in which a revocation, a
 * demotion or a password change has silently not happened.
 */
export function invalidateSessionIdentity(email: string) {
  sessionIdentityCache.delete(email);
}

export async function loadSessionIdentity(email: string): Promise<SessionIdentityResult> {
  const now = Date.now();
  const cached = sessionIdentityCache.get(email);
  if (cached && now - cached.readAt < SESSION_IDENTITY_TTL_MS) {
    return { ok: true, identity: cached.identity, stale: false };
  }
  try {
    const user = await findUserByEmail(email);
    if (!user) {
      // A signed token for an account that no longer exists. Before this, a
      // deleted account's tokens kept working until they expired, because
      // nothing on the request path ever looked for the row.
      sessionIdentityCache.delete(email);
      return { ok: false, reason: "not_found" };
    }
    const identity = identityFromUser(user);
    sessionIdentityCache.set(email, { identity, readAt: now });
    return { ok: true, identity, stale: false };
  } catch (error) {
    if (cached && now - cached.readAt < SESSION_IDENTITY_TTL_MS + SESSION_IDENTITY_STALE_GRACE_MS) {
      return { ok: true, identity: cached.identity, stale: true };
    }
    return { ok: false, reason: "unavailable", error };
  }
}

/**
 * Increments the user's token generation, refusing every token already issued.
 *
 * Returns the new generation so the caller can mint a replacement that carries
 * it; `null` means there is no such user. One statement, so the read and the
 * increment cannot interleave with another revoke.
 */
export async function revokeAllSessions(email: string): Promise<number | null> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const user = memoryUsers.get(email);
    if (!user) return null;
    const next = user.tokenGeneration + 1;
    memoryUsers.set(email, { ...user, tokenGeneration: next });
    await persistMemory();
    invalidateSessionIdentity(email);
    return next;
  }
  const result = await getPgPool().query<{ token_generation: number }>(
    `UPDATE auth_users SET token_generation = token_generation + 1
     WHERE email = $1 RETURNING token_generation`,
    [email]
  );
  invalidateSessionIdentity(email);
  if (result.rowCount === 0) return null;
  return result.rows[0].token_generation;
}

/** Clears every cached identity. Tests reuse emails; a leaked entry is a ghost. */
export function resetSessionIdentityCacheForTests() {
  sessionIdentityCache.clear();
}

export async function getUserSettings(email: string): Promise<Record<string, unknown>> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    return memorySettings.get(email) ?? {};
  }
  const result = await getPgPool().query<{ settings: Record<string, unknown> }>(
    `SELECT settings FROM auth_users WHERE email = $1 LIMIT 1`,
    [email]
  );
  return result.rows[0]?.settings ?? {};
}

/**
 * Merge a validated partial settings patch into the caller's bag and persist it,
 * returning the merged result. Two-level deep merge so patching one field of a
 * group (e.g. display.dateFormat) does not drop the group's other fields. `email`
 * ALWAYS comes from the verified token — never from request input — so a caller can
 * only ever write their own row.
 */
export async function updateUserSettings(
  email: string,
  patch: Record<string, Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const current = await getUserSettings(email);
  const merged: Record<string, unknown> = { ...current };
  for (const [group, vals] of Object.entries(patch)) {
    const existingGroup = (current[group] as Record<string, unknown> | undefined) ?? {};
    merged[group] = { ...existingGroup, ...vals };
  }
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    memorySettings.set(email, merged);
    return merged;
  }
  await getPgPool().query(
    `UPDATE auth_users SET settings = $2::jsonb WHERE email = $1`,
    [email, JSON.stringify(merged)]
  );
  return merged;
}

export async function findUserByIdentifier(identifier: string, normalizedPhone: string): Promise<AuthUser | null> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const byEmail = memoryUsers.get(identifier);
    if (byEmail) {
      return byEmail;
    }
    const byPhone = Array.from(memoryUsers.values()).find((user) => user.phone === normalizedPhone);
    return byPhone ?? null;
  }

  const result = await getPgPool().query<UserRow>(
    `
    SELECT ${USER_COLUMNS}
    FROM auth_users
    WHERE email = $1 OR phone = $2
    LIMIT 1
  `,
    [identifier, normalizedPhone]
  );
  if (result.rowCount === 0) {
    return null;
  }
  return mapUser(result.rows[0]);
}

export async function createUser(
  email: string,
  passwordHash: string,
  phone: string | null,
  fullName: string,
  role: "worker" | "supervisor" | "admin",
  companyId: string,
  companyRole: CompanyRole
) {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    if (memoryUsers.has(email)) {
      throw uniqueViolationError("auth_users_email");
    }
    if (phone) {
      const phoneConflict = Array.from(memoryUsers.values()).some((user) => user.phone === phone);
      if (phoneConflict) {
        throw uniqueViolationError("auth_users_phone");
      }
    }
    memoryUsers.set(email, {
      email,
      passwordHash,
      phone,
      fullName,
      role,
      companyId,
      companyRole,
      createdAt: new Date().toISOString(),
      tokenGeneration: 0,
    });
    await persistMemory();
    return;
  }

  await getPgPool().query(
    `
    INSERT INTO auth_users (email, password_hash, phone, full_name, role, company_id, company_role)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `,
    [email, passwordHash, phone, fullName, role, companyId, companyRole]
  );
}

/**
 * Start (or restart) a pending signup at the EMAIL stage.
 *
 * Always resets the row to unverified with no SMS code: re-initiating must not
 * inherit a previously verified state, or an attacker could re-point a verified
 * pending signup at a new phone number and get a free SMS.
 */
export async function upsertPendingRegistration(
  email: string,
  passwordHash: string,
  phone: string,
  emailCode: string,
  expiresAt: Date
) {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    memoryPending.set(email, {
      email,
      passwordHash,
      phone,
      emailCode,
      smsCode: null,
      emailVerifiedAt: null,
      smsSentAt: null,
      expiresAt: expiresAt.toISOString(),
      attempts: 0,
    });
    await persistMemory();
    return;
  }

  await getPgPool().query(
    `
    INSERT INTO auth_pending_registrations
      (email, password_hash, phone, email_code, sms_code, email_verified_at, sms_sent_at, expires_at, attempts)
    VALUES ($1, $2, $3, $4, NULL, NULL, NULL, $5, 0)
    ON CONFLICT (email)
    DO UPDATE SET
      password_hash     = EXCLUDED.password_hash,
      phone             = EXCLUDED.phone,
      email_code        = EXCLUDED.email_code,
      sms_code          = NULL,
      email_verified_at = NULL,
      sms_sent_at       = NULL,
      expires_at        = EXCLUDED.expires_at,
      attempts          = 0
  `,
    [email, passwordHash, phone, emailCode, expiresAt.toISOString()]
  );
}

/**
 * Promote a pending signup to the SMS stage: record that the mailbox is proven
 * and store the code that is about to be texted.
 *
 * Guarded on `email_verified_at IS NULL` in SQL so two concurrent verifications
 * of the same email cannot both win and send two messages — the second updates
 * zero rows and is told to use the existing code. Attempts reset, because the
 * SMS code is a fresh secret and shouldn't inherit the email stage's failures.
 */
export async function markPendingEmailVerified(
  email: string,
  smsCode: string,
  sentAt: Date
): Promise<boolean> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const record = memoryPending.get(email);
    if (!record || record.emailVerifiedAt) return false;
    memoryPending.set(email, {
      ...record,
      smsCode,
      emailVerifiedAt: sentAt.toISOString(),
      smsSentAt: sentAt.toISOString(),
      attempts: 0,
    });
    await persistMemory();
    return true;
  }

  const result = await getPgPool().query(
    `
    UPDATE auth_pending_registrations
       SET sms_code = $2, email_verified_at = $3, sms_sent_at = $3, attempts = 0
     WHERE email = $1
       AND email_verified_at IS NULL
  `,
    [email, smsCode, sentAt.toISOString()]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Record (or clear) the moment the verification SMS was last sent.
 *
 * Passing null clears it, which is what a FAILED send does: the cooldown must
 * not lock a user out of retrying a message that never arrived.
 */
export async function touchPendingSmsSentAt(email: string, sentAt: Date | null) {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const record = memoryPending.get(email);
    if (!record) return;
    memoryPending.set(email, { ...record, smsSentAt: sentAt ? sentAt.toISOString() : null });
    await persistMemory();
    return;
  }

  await getPgPool().query(`UPDATE auth_pending_registrations SET sms_sent_at = $2 WHERE email = $1`, [
    email,
    sentAt ? sentAt.toISOString() : null,
  ]);
}

export async function getPendingRegistration(email: string): Promise<PendingRegistration | null> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    return memoryPending.get(email) ?? null;
  }

  const result = await getPgPool().query<{
    email: string;
    password_hash: string;
    phone: string;
    email_code: string;
    sms_code: string | null;
    email_verified_at: Date | null;
    sms_sent_at: Date | null;
    expires_at: Date;
    attempts: number;
  }>(
    `
    SELECT email, password_hash, phone, email_code, sms_code,
           email_verified_at, sms_sent_at, expires_at, attempts
    FROM auth_pending_registrations
    WHERE email = $1
    LIMIT 1
  `,
    [email]
  );
  if (result.rowCount === 0) {
    return null;
  }
  return mapPending(result.rows[0]);
}

export async function incrementPendingAttempts(email: string): Promise<number> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const pending = memoryPending.get(email);
    if (!pending) {
      return 0;
    }
    pending.attempts += 1;
    memoryPending.set(email, pending);
    await persistMemory();
    return pending.attempts;
  }

  const result = await getPgPool().query<{ attempts: number }>(
    `
    UPDATE auth_pending_registrations
    SET attempts = attempts + 1
    WHERE email = $1
    RETURNING attempts
  `,
    [email]
  );
  if (result.rowCount === 0) {
    return 0;
  }
  return result.rows[0].attempts;
}

export async function deletePendingRegistration(email: string) {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    memoryPending.delete(email);
    await persistMemory();
    return;
  }
  await getPgPool().query(`DELETE FROM auth_pending_registrations WHERE email = $1`, [email]);
}

export async function createPasswordResetToken(token: string, email: string, expiresAt: Date) {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    memoryResetTokens.set(token, {
      token,
      email,
      expiresAt: expiresAt.toISOString(),
    });
    await persistMemory();
    return;
  }

  await getPgPool().query(
    `
    INSERT INTO auth_password_reset_tokens (token, email, expires_at)
    VALUES ($1, $2, $3)
  `,
    [token, email, expiresAt.toISOString()]
  );
}

export async function getPasswordResetToken(token: string): Promise<PasswordResetRecord | null> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    return memoryResetTokens.get(token) ?? null;
  }

  const result = await getPgPool().query<{ token: string; email: string; expires_at: Date }>(
    `
    SELECT token, email, expires_at
    FROM auth_password_reset_tokens
    WHERE token = $1
    LIMIT 1
  `,
    [token]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return {
    token: result.rows[0].token,
    email: result.rows[0].email,
    expiresAt: result.rows[0].expires_at.toISOString(),
  };
}

export async function deletePasswordResetToken(token: string) {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    memoryResetTokens.delete(token);
    await persistMemory();
    return;
  }
  await getPgPool().query(`DELETE FROM auth_password_reset_tokens WHERE token = $1`, [token]);
}

export async function updateUserPassword(email: string, passwordHash: string) {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const user = memoryUsers.get(email);
    if (!user) {
      return;
    }
    memoryUsers.set(email, {
      ...user,
      passwordHash,
      tokenGeneration: user.tokenGeneration + 1,
    });
    await persistMemory();
    invalidateSessionIdentity(email);
    return;
  }
  // The increment is the point, not a side effect: changing a password and
  // leaving every other session signed in is not what anyone means by it, and
  // it is the one place where the person acting has already proved they are the
  // account holder (change-password verifies the current password first).
  await getPgPool().query(
    `UPDATE auth_users SET password_hash = $2, token_generation = token_generation + 1
     WHERE email = $1`,
    [email, passwordHash]
  );
  invalidateSessionIdentity(email);
}

export async function updateUserProfile(
  email: string,
  patch: { fullName?: string; role?: "worker" | "supervisor" | "admin" }
) {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const user = memoryUsers.get(email);
    if (!user) return null;
    const updated: AuthUser = {
      ...user,
      fullName: patch.fullName ?? user.fullName,
      role: patch.role ?? user.role,
    };
    memoryUsers.set(email, updated);
    await persistMemory();
    invalidateSessionIdentity(email);
    return updated;
  }
  const result = await getPgPool().query<UserRow>(
    `UPDATE auth_users
     SET
      full_name = COALESCE($2, full_name),
      role = COALESCE($3, role)
     WHERE email = $1
     RETURNING ${USER_COLUMNS}`,
    [email, patch.fullName ?? null, patch.role ?? null]
  );
  // Invalidated but NOT incremented, and that is a decision. This is a person
  // editing their own name; ending their sessions on their other devices for it
  // would be hostile. Dropping the cache entry is enough — the next renewal
  // mints the new name rather than the old one.
  invalidateSessionIdentity(email);
  if (result.rowCount === 0) return null;
  return mapUser(result.rows[0]);
}

// ── Company membership + company management ──────────────────────────────────

export type CompanyRecord = {
  id: string;
  name: string;
  country: string;
  ownerEmail: string | null;
  status: "active" | "suspended" | "cancelled";
};

function mapCompany(row: {
  id: string; name: string; country: string; owner_email: string | null;
  status: "active" | "suspended" | "cancelled";
}): CompanyRecord {
  return {
    id: row.id,
    name: row.name,
    country: row.country,
    ownerEmail: row.owner_email,
    status: row.status,
  };
}

const memoryCompanies = new Map<string, CompanyRecord>();

export async function createCompany(input: {
  id: string; name: string; country?: string; ownerEmail: string;
}): Promise<CompanyRecord> {
  const record: CompanyRecord = {
    id: input.id,
    name: input.name,
    country: input.country ?? "",
    ownerEmail: input.ownerEmail,
    status: "active",
  };
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    memoryCompanies.set(record.id, record);
    return record;
  }
  const result = await getPgPool().query<{
    id: string; name: string; country: string; owner_email: string | null;
    status: "active" | "suspended" | "cancelled";
  }>(
    `INSERT INTO companies (id, name, country, owner_email)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, name, country, owner_email, status`,
    [record.id, record.name, record.country, record.ownerEmail]
  );
  return mapCompany(result.rows[0]);
}

export async function getCompany(companyId: string): Promise<CompanyRecord | null> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    return memoryCompanies.get(companyId) ?? null;
  }
  const result = await getPgPool().query<{
    id: string; name: string; country: string; owner_email: string | null;
    status: "active" | "suspended" | "cancelled";
  }>(`SELECT id, name, country, owner_email, status FROM companies WHERE id = $1 LIMIT 1`, [companyId]);
  if (result.rowCount === 0) return null;
  return mapCompany(result.rows[0]);
}

export async function updateCompanyProfile(
  companyId: string,
  patch: { name?: string; country?: string }
): Promise<CompanyRecord | null> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const existing = memoryCompanies.get(companyId);
    if (!existing) return null;
    const updated: CompanyRecord = {
      ...existing,
      name: patch.name ?? existing.name,
      country: patch.country ?? existing.country,
    };
    memoryCompanies.set(companyId, updated);
    return updated;
  }
  const result = await getPgPool().query<{
    id: string; name: string; country: string; owner_email: string | null;
    status: "active" | "suspended" | "cancelled";
  }>(
    `UPDATE companies
       SET name = COALESCE($2, name), country = COALESCE($3, country)
     WHERE id = $1
     RETURNING id, name, country, owner_email, status`,
    [companyId, patch.name ?? null, patch.country ?? null]
  );
  if (result.rowCount === 0) return null;
  return mapCompany(result.rows[0]);
}

export async function listCompanyMembers(companyId: string): Promise<AuthUser[]> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    return Array.from(memoryUsers.values()).filter((u) => u.companyId === companyId);
  }
  const result = await getPgPool().query<UserRow>(`SELECT ${USER_COLUMNS} FROM auth_users WHERE company_id = $1 ORDER BY created_at ASC`, [companyId]);
  return result.rows.map(mapUser);
}

export async function countCompanyOwners(companyId: string): Promise<number> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    return Array.from(memoryUsers.values()).filter(
      (u) => u.companyId === companyId && u.companyRole === "owner"
    ).length;
  }
  const result = await getPgPool().query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM auth_users WHERE company_id = $1 AND company_role = 'owner'`,
    [companyId]
  );
  return Number(result.rows[0].count);
}

/**
 * Sets a user's company + company_role (used by invite-accept and admin flows).
 *
 * Increments the token generation, which ends this user's sessions on every
 * other device. That is deliberate in both directions this is called:
 *   - removal from a company (`company.ts`): the whole point is that access
 *     stops now rather than up to seven days later;
 *   - accepting an invitation (`projectsStore.acceptSiteInvite`): the person's
 *     companyId has changed, so a token still carrying the old one addresses
 *     the wrong tenant. The accepting device is handed a replacement token in
 *     the same response, so it sees nothing.
 */
export async function setUserCompany(
  email: string,
  companyId: string | null,
  companyRole: CompanyRole
): Promise<AuthUser | null> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const user = memoryUsers.get(email);
    if (!user) return null;
    const updated: AuthUser = {
      ...user,
      companyId: companyId ?? "",
      companyRole,
      tokenGeneration: user.tokenGeneration + 1,
    };
    memoryUsers.set(email, updated);
    await persistMemory();
    invalidateSessionIdentity(email);
    return updated;
  }
  const result = await getPgPool().query<UserRow>(
    `UPDATE auth_users
     SET company_id = $2, company_role = $3, token_generation = token_generation + 1
     WHERE email = $1 RETURNING ${USER_COLUMNS}`,
    [email, companyId, companyRole]
  );
  invalidateSessionIdentity(email);
  if (result.rowCount === 0) return null;
  return mapUser(result.rows[0]);
}

/**
 * Changes only a member's company_role.
 *
 * Increments the token generation, so a demotion takes effect within the
 * identity cache's TTL rather than whenever the demoted person's token happens
 * to expire. Without it, a token minted as `manager` keeps saying `manager` for
 * its whole remaining life, and with a thirty-day session that is a month of
 * access that was supposed to have been taken away. It applies to a promotion
 * too: the person signs in again and gets claims that match the record.
 */
export async function setUserCompanyRole(
  email: string,
  companyRole: CompanyRole
): Promise<AuthUser | null> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const user = memoryUsers.get(email);
    if (!user) return null;
    const updated: AuthUser = { ...user, companyRole, tokenGeneration: user.tokenGeneration + 1 };
    memoryUsers.set(email, updated);
    await persistMemory();
    invalidateSessionIdentity(email);
    return updated;
  }
  const result = await getPgPool().query<UserRow>(
    `UPDATE auth_users
     SET company_role = $2, token_generation = token_generation + 1
     WHERE email = $1 RETURNING ${USER_COLUMNS}`,
    [email, companyRole]
  );
  invalidateSessionIdentity(email);
  if (result.rowCount === 0) return null;
  return mapUser(result.rows[0]);
}

export async function purgeExpiredAuthRecords() {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const now = Date.now();
    let changed = false;
    for (const [email, record] of memoryPending.entries()) {
      if (new Date(record.expiresAt).getTime() < now) {
        memoryPending.delete(email);
        changed = true;
      }
    }
    for (const [token, record] of memoryResetTokens.entries()) {
      if (new Date(record.expiresAt).getTime() < now) {
        memoryResetTokens.delete(token);
        changed = true;
      }
    }
    if (changed) {
      await persistMemory();
    }
    return;
  }

  await getPgPool().query(`DELETE FROM auth_pending_registrations WHERE expires_at < NOW()`);
  await getPgPool().query(`DELETE FROM auth_password_reset_tokens WHERE expires_at < NOW()`);
}

export async function deleteUserAccount(email: string): Promise<void> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    memoryUsers.delete(email);
    memoryPending.delete(email);
    for (const [token, record] of memoryResetTokens.entries()) {
      if (record.email === email) memoryResetTokens.delete(token);
    }
    await persistMemory();
    invalidateSessionIdentity(email);
    return;
  }
  // Password reset tokens are deleted via CASCADE on auth_users
  await getPgPool().query(`DELETE FROM auth_pending_registrations WHERE email = $1`, [email]);
  await getPgPool().query(`DELETE FROM auth_users WHERE email = $1`, [email]);
  // Without this the deleted account keeps authenticating from cache for up to
  // SESSION_IDENTITY_TTL_MS.
  invalidateSessionIdentity(email);
}

export async function resetAuthStoreForTests() {
  resetSessionIdentityCacheForTests();
  if (useDatabase()) {
    await getPgPool().query(`DELETE FROM auth_password_reset_tokens`);
    await getPgPool().query(`DELETE FROM auth_pending_registrations`);
    await getPgPool().query(`DELETE FROM auth_users`);
    await getPgPool().query(`DELETE FROM companies`);
    return;
  }
  memoryUsers.clear();
  memorySettings.clear();
  memoryPending.clear();
  memoryResetTokens.clear();
  memoryCompanies.clear();
  store.resetForTests();
}
