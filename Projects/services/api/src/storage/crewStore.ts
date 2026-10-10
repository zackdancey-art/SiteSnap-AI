import { v4 as uuidv4 } from "uuid";
import { Actor, isCrew } from "./actor";
import { withTenant } from "./tenant";

export type TimecardRecord = {
  id: string;
  ownerEmail: string;
  companyId: string;
  siteId: string;
  entryId: string | null;
  workerName: string;
  date: string;
  startTime?: string;
  endTime?: string;
  breakMinutes?: number;
  hoursRegular: number;
  hoursOvertime: number;
  trade: string;
  notes: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
};

function useDatabase() {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
}

function canAccess(actor: Actor, companyId: string, ownerEmail: string) {
  if (companyId !== actor.companyId) return false;
  if (!isCrew(actor)) return true;
  return actor.email === ownerEmail;
}

function crewScopeSql(actor: Actor, params: unknown[]): string | null {
  if (!isCrew(actor)) return null;
  params.push(actor.email);
  const p = params.length;
  return `(owner_email = $${p} OR site_id IN (SELECT site_id FROM site_members WHERE member_email = $${p}))`;
}

const memoryTimecards = new Map<string, TimecardRecord>();

function mapRow(row: {
  id: string; owner_email: string; company_id: string; site_id: string; entry_id: string | null;
  worker_name: string; date: string;
  start_time?: string | null; end_time?: string | null; break_minutes?: number | null;
  hours_regular: number; hours_overtime: number;
  trade: string | null; notes: string | null; created_at: Date;
  updated_at?: Date | null; deleted_at?: Date | null;
}): TimecardRecord {
  return {
    id: row.id, ownerEmail: row.owner_email, companyId: row.company_id, siteId: row.site_id, entryId: row.entry_id,
    workerName: row.worker_name, date: row.date,
    startTime: row.start_time ?? undefined,
    endTime: row.end_time ?? undefined,
    breakMinutes: row.break_minutes ?? undefined,
    hoursRegular: Number(row.hours_regular), hoursOvertime: Number(row.hours_overtime),
    trade: row.trade || "", notes: row.notes || "",
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at ? row.updated_at.toISOString() : undefined,
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
  };
}

export async function listTimecards(actor: Actor, siteId?: string): Promise<TimecardRecord[]> {
  if (!useDatabase()) {
    return Array.from(memoryTimecards.values())
      .filter((t) => canAccess(actor, t.companyId, t.ownerEmail))
      .filter((t) => !t.deletedAt)
      .filter((t) => (siteId ? t.siteId === siteId : true))
      .sort((a, b) => b.date.localeCompare(a.date));
  }
  const params: unknown[] = [actor.companyId];
  const conditions = ["deleted_at IS NULL", `company_id = $1`];
  const crew = crewScopeSql(actor, params);
  if (crew) conditions.push(crew);
  if (siteId) { params.push(siteId); conditions.push(`site_id = $${params.length}`); }
  const result = await withTenant(actor, (client) => client.query(
    `SELECT * FROM crew_timecards WHERE ${conditions.join(" AND ")} ORDER BY date DESC`,
    params
  ));
  return result.rows.map(mapRow);
}

export async function createTimecard(actor: Actor, payload: Omit<TimecardRecord, "id" | "ownerEmail" | "companyId" | "createdAt" | "updatedAt" | "deletedAt">): Promise<TimecardRecord> {
  const record: TimecardRecord = { id: uuidv4(), ownerEmail: actor.email, companyId: actor.companyId, createdAt: new Date().toISOString(), ...payload };
  if (!useDatabase()) { memoryTimecards.set(record.id, record); return record; }
  const result = await withTenant(actor, (client) => client.query(
    `INSERT INTO crew_timecards (id,owner_email,company_id,site_id,entry_id,worker_name,date,start_time,end_time,break_minutes,hours_regular,hours_overtime,trade,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [record.id, actor.email, actor.companyId, record.siteId, record.entryId ?? null, record.workerName, record.date,
     record.startTime ?? null, record.endTime ?? null, record.breakMinutes ?? null,
     record.hoursRegular, record.hoursOvertime, record.trade || null, record.notes || null]
  ));
  return mapRow(result.rows[0]);
}

export async function deleteTimecard(actor: Actor, id: string): Promise<boolean> {
  if (!useDatabase()) {
    const existing = memoryTimecards.get(id);
    if (!existing || !canAccess(actor, existing.companyId, existing.ownerEmail)) return false;
    memoryTimecards.set(id, { ...existing, deletedAt: new Date().toISOString() });
    return true;
  }
  const conditions = isCrew(actor) ? `id = $1 AND company_id = $2 AND owner_email = $3` : `id = $1 AND company_id = $2`;
  const params = isCrew(actor) ? [id, actor.companyId, actor.email] : [id, actor.companyId];
  const result = await withTenant(actor, (client) => client.query(
    `UPDATE crew_timecards SET deleted_at = NOW() WHERE ${conditions} AND deleted_at IS NULL`,
    params
  ));
  return (result.rowCount ?? 0) > 0;
}

/**
 * Who authored a row, for the route-level ownership gate.
 *
 * `requireOwnRecord` (middleware/recordOwnership.ts) needs the author BEFORE
 * the handler runs, so that a crew member changing somebody else's record is
 * refused with 403 rather than the 404 every store returns for "no row you may
 * touch". Returns null when there is no such row in the actor's company, which
 * the gate passes through untouched so the handler produces its own 404 — a
 * row that is not there must not be distinguishable from one that is.
 */
export async function findTimecardOwner(
  actor: Actor,
  id: string
): Promise<{ companyId: string; ownerEmail: string } | null> {
  if (!useDatabase()) {
    const existing = memoryTimecards.get(id);
    if (!existing || existing.deletedAt || existing.companyId !== actor.companyId) return null;
    return { companyId: existing.companyId, ownerEmail: existing.ownerEmail };
  }
  const result = await withTenant(actor, (client) =>
    client.query<{ owner_email: string; company_id: string }>(
      `SELECT owner_email, company_id FROM crew_timecards WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [id, actor.companyId]
    )
  );
  if (result.rowCount === 0) return null;
  return { companyId: result.rows[0].company_id, ownerEmail: result.rows[0].owner_email };
}
