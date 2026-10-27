import { v4 as uuidv4 } from "uuid";
import { Actor } from "./actor";
import { withTenant } from "./tenant";

export type PushTokenRecord = {
  id: string;
  ownerEmail: string;
  companyId: string;
  token: string;
  platform: string;
  createdAt: string;
};

function useDatabase() {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
}

const memoryTokens = new Map<string, PushTokenRecord>();

export async function upsertPushToken(actor: Actor, token: string, platform = "expo"): Promise<PushTokenRecord> {
  if (!useDatabase()) {
    const existing = Array.from(memoryTokens.values()).find(
      (t) => t.ownerEmail === actor.email && t.token === token
    );
    if (existing) return existing;
    const record: PushTokenRecord = { id: uuidv4(), ownerEmail: actor.email, companyId: actor.companyId, token, platform, createdAt: new Date().toISOString() };
    memoryTokens.set(record.id, record);
    return record;
  }
  const result = await withTenant(actor, (client) =>
    client.query<{ id: string; owner_email: string; company_id: string; token: string; platform: string; created_at: Date }>(
      `INSERT INTO push_tokens (id, owner_email, company_id, token, platform)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (owner_email, token) DO UPDATE SET updated_at = NOW(), platform = EXCLUDED.platform, company_id = EXCLUDED.company_id
       RETURNING id, owner_email, company_id, token, platform, created_at`,
      [uuidv4(), actor.email, actor.companyId, token, platform]
    )
  );
  const row = result.rows[0];
  return { id: row.id, ownerEmail: row.owner_email, companyId: row.company_id, token: row.token, platform: row.platform, createdAt: row.created_at.toISOString() };
}

export async function deletePushToken(actor: Actor, token: string): Promise<boolean> {
  if (!useDatabase()) {
    for (const [id, record] of memoryTokens.entries()) {
      if (record.ownerEmail === actor.email && record.token === token) {
        memoryTokens.delete(id);
        return true;
      }
    }
    return false;
  }
  const result = await withTenant(actor, (client) =>
    client.query(
      `DELETE FROM push_tokens WHERE owner_email = $1 AND token = $2`,
      [actor.email, token]
    )
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getTokensForUser(actor: Actor): Promise<PushTokenRecord[]> {
  if (!useDatabase()) {
    return Array.from(memoryTokens.values()).filter((t) => t.ownerEmail === actor.email);
  }
  const result = await withTenant(actor, (client) =>
    client.query<{ id: string; owner_email: string; company_id: string; token: string; platform: string; created_at: Date }>(
      `SELECT id, owner_email, company_id, token, platform, created_at FROM push_tokens WHERE owner_email = $1`,
      [actor.email]
    )
  );
  return result.rows.map((row) => ({
    id: row.id, ownerEmail: row.owner_email, companyId: row.company_id, token: row.token,
    platform: row.platform, createdAt: row.created_at.toISOString(),
  }));
}

export async function getAllTokensForEmails(actor: Actor, emails: string[]): Promise<PushTokenRecord[]> {
  if (emails.length === 0) return [];
  if (!useDatabase()) {
    const emailSet = new Set(emails);
    return Array.from(memoryTokens.values()).filter((t) => emailSet.has(t.ownerEmail));
  }
  const result = await withTenant(actor, (client) =>
    client.query<{ id: string; owner_email: string; company_id: string; token: string; platform: string; created_at: Date }>(
      `SELECT id, owner_email, company_id, token, platform, created_at FROM push_tokens WHERE owner_email = ANY($1)`,
      [emails]
    )
  );
  return result.rows.map((row) => ({
    id: row.id, ownerEmail: row.owner_email, companyId: row.company_id, token: row.token,
    platform: row.platform, createdAt: row.created_at.toISOString(),
  }));
}
