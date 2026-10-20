import { v4 as uuidv4 } from "uuid";
import { Actor } from "./actor";
import { withTenant } from "./tenant";

export type EntryTemplate = {
  id: string;
  ownerEmail: string;
  companyId: string;
  name: string;
  notes: string;
  crewCount: string;
  weather: string;
  createdAt: string;
};

const memory = new Map<string, EntryTemplate>();

function useDatabase() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function mapRow(row: {
  id: string; owner_email: string; company_id: string; name: string;
  notes: string; crew_count: string; weather: string; created_at: Date;
}): EntryTemplate {
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    companyId: row.company_id,
    name: row.name,
    notes: row.notes,
    crewCount: row.crew_count,
    weather: row.weather,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listTemplates(actor: Actor): Promise<EntryTemplate[]> {
  if (!useDatabase()) {
    return Array.from(memory.values())
      .filter((t) => t.ownerEmail === actor.email)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  // `company_id = $2` is kept as belt-and-braces alongside the RLS policy
  // (migration 021), which is the authoritative company filter.
  const result = await withTenant(actor, (client) =>
    client.query<{
      id: string; owner_email: string; company_id: string; name: string;
      notes: string; crew_count: string; weather: string; created_at: Date;
    }>(
      `SELECT * FROM entry_templates WHERE owner_email = $1 AND company_id = $2 ORDER BY name ASC`,
      [actor.email, actor.companyId]
    )
  );
  return result.rows.map(mapRow);
}

export async function createTemplate(
  actor: Actor,
  payload: { name: string; notes: string; crewCount: string; weather: string }
): Promise<EntryTemplate> {
  const record: EntryTemplate = {
    id: uuidv4(),
    ownerEmail: actor.email,
    companyId: actor.companyId,
    createdAt: new Date().toISOString(),
    ...payload,
  };
  if (!useDatabase()) {
    memory.set(record.id, record);
    return record;
  }
  const result = await withTenant(actor, (client) =>
    client.query<{
      id: string; owner_email: string; company_id: string; name: string;
      notes: string; crew_count: string; weather: string; created_at: Date;
    }>(
      `INSERT INTO entry_templates (id, owner_email, company_id, name, notes, crew_count, weather)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [record.id, actor.email, actor.companyId, payload.name, payload.notes, payload.crewCount, payload.weather]
    )
  );
  return mapRow(result.rows[0]);
}

export async function deleteTemplate(actor: Actor, id: string): Promise<boolean> {
  if (!useDatabase()) {
    const existing = memory.get(id);
    if (!existing || existing.ownerEmail !== actor.email) return false;
    memory.delete(id);
    return true;
  }
  const result = await withTenant(actor, (client) =>
    client.query(
      `DELETE FROM entry_templates WHERE id = $1 AND owner_email = $2 AND company_id = $3`,
      [id, actor.email, actor.companyId]
    )
  );
  return (result.rowCount ?? 0) > 0;
}
