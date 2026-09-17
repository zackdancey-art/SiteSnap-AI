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

function mapUser(row: {
  email: string;
  password_hash: string;
  phone: string | null;
  full_name: string;
  role: "worker" | "supervisor" | "admin";
  company_id: string | null;
  company_role: CompanyRole | null;
  created_at: Date;
}): AuthUser {
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
  };
}

const USER_COLUMNS = "email, password_hash, phone, full_name, role, company_id, company_role, created_at";

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

  const result = await getPgPool().query<{
    email: string;
    password_hash: string;
    phone: string | null;
    full_name: string;
    role: "worker" | "supervisor" | "admin";
    company_id: string | null;
    company_role: CompanyRole | null;
    created_at: Date;
  }>(
    `SELECT ${USER_COLUMNS} FROM auth_users WHERE email = $1 LIMIT 1`,
    [email]
  );
  if (result.rowCount === 0) {
    return null;
  }
  return mapUser(result.rows[0]);
}

/** Read the caller's personal settings bag (migration 028). `{}` if none set. */
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

  const result = await getPgPool().query<{
    email: string;
    password_hash: string;
    phone: string | null;
    full_name: string;
    role: "worker" | "supervisor" | "admin";
    company_id: string | null;
    company_role: CompanyRole | null;
    created_at: Date;
  }>(
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
    });
    await persistMemory();
    return;
  }
  await getPgPool().query(`UPDATE auth_users SET password_hash = $2 WHERE email = $1`, [email, passwordHash]);
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
    return updated;
  }
  const result = await getPgPool().query<{
    email: string;
    password_hash: string;
    phone: string | null;
    full_name: string;
    role: "worker" | "supervisor" | "admin";
    company_id: string | null;
    company_role: CompanyRole | null;
    created_at: Date;
  }>(
    `UPDATE auth_users
     SET
      full_name = COALESCE($2, full_name),
      role = COALESCE($3, role)
     WHERE email = $1
     RETURNING ${USER_COLUMNS}`,
    [email, patch.fullName ?? null, patch.role ?? null]
  );
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
  const result = await getPgPool().query<{
    email: string; password_hash: string; phone: string | null; full_name: string;
    role: "worker" | "supervisor" | "admin"; company_id: string | null;
    company_role: CompanyRole | null; created_at: Date;
  }>(`SELECT ${USER_COLUMNS} FROM auth_users WHERE company_id = $1 ORDER BY created_at ASC`, [companyId]);
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

/** Sets a user's company + company_role (used by invite-accept and admin flows). */
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
    };
    memoryUsers.set(email, updated);
    await persistMemory();
    return updated;
  }
  const result = await getPgPool().query<{
    email: string; password_hash: string; phone: string | null; full_name: string;
    role: "worker" | "supervisor" | "admin"; company_id: string | null;
    company_role: CompanyRole | null; created_at: Date;
  }>(
    `UPDATE auth_users SET company_id = $2, company_role = $3 WHERE email = $1 RETURNING ${USER_COLUMNS}`,
    [email, companyId, companyRole]
  );
  if (result.rowCount === 0) return null;
  return mapUser(result.rows[0]);
}

/** Changes only a member's company_role. */
export async function setUserCompanyRole(
  email: string,
  companyRole: CompanyRole
): Promise<AuthUser | null> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const user = memoryUsers.get(email);
    if (!user) return null;
    const updated: AuthUser = { ...user, companyRole };
    memoryUsers.set(email, updated);
    await persistMemory();
    return updated;
  }
  const result = await getPgPool().query<{
    email: string; password_hash: string; phone: string | null; full_name: string;
    role: "worker" | "supervisor" | "admin"; company_id: string | null;
    company_role: CompanyRole | null; created_at: Date;
  }>(
    `UPDATE auth_users SET company_role = $2 WHERE email = $1 RETURNING ${USER_COLUMNS}`,
    [email, companyRole]
  );
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
    return;
  }
  // Password reset tokens are deleted via CASCADE on auth_users
  await getPgPool().query(`DELETE FROM auth_pending_registrations WHERE email = $1`, [email]);
  await getPgPool().query(`DELETE FROM auth_users WHERE email = $1`, [email]);
}

export async function resetAuthStoreForTests() {
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
