import { v4 as uuidv4 } from "uuid";
import { getPgPool } from "./postgres";
import { Actor } from "./actor";
import { canEditRow, canReadRow, editOwnershipSql, readVisibilitySql } from "./recordScope";
import { withTenant } from "./tenant";

export type DeliveryRecord = {
  id: string;
  ownerEmail: string;
  companyId: string;
  siteId: string;
  date: string;
  supplier: string;
  items: string[];
  quantity: string;
  notes: string;
  createdAt: string;
  deletedAt?: string | null;
};

const memory = new Map<string, DeliveryRecord>();

function useDatabase() {
  return Boolean(process.env.DATABASE_URL?.trim());
}

// canAccess and crewScopeSql lived here; storage/recordScope.ts holds both
// rules now. A delivery docket is a shared site record — the company reads it,
// its author changes it.

function mapRow(row: {
  id: string; owner_email: string; company_id: string; site_id: string; date: string;
  supplier: string; items_json: string[]; quantity: string; notes: string;
  created_at: Date; deleted_at: Date | null;
}): DeliveryRecord {
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    companyId: row.company_id,
    siteId: row.site_id,
    date: row.date,
    supplier: row.supplier,
    items: Array.isArray(row.items_json) ? row.items_json : [],
    quantity: row.quantity,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
  };
}

export async function initDeliveriesSchema(): Promise<void> {
  if (!useDatabase()) return;
  await getPgPool().query(`
    CREATE TABLE IF NOT EXISTS material_deliveries (
      id           TEXT PRIMARY KEY,
      owner_email  TEXT NOT NULL REFERENCES auth_users(email) ON DELETE CASCADE,
      site_id      TEXT NOT NULL REFERENCES project_sites(id) ON DELETE CASCADE,
      date         TEXT NOT NULL,
      supplier     TEXT NOT NULL DEFAULT '',
      items_json   JSONB NOT NULL DEFAULT '[]'::jsonb,
      quantity     TEXT NOT NULL DEFAULT '',
      notes        TEXT NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at   TIMESTAMPTZ
    )
  `);
}

export async function listDeliveries(actor: Actor, siteId?: string): Promise<DeliveryRecord[]> {
  if (!useDatabase()) {
    return Array.from(memory.values())
      .filter((d) => canReadRow(actor, "delivery", d) && !d.deletedAt)
      .filter((d) => (siteId ? d.siteId === siteId : true))
      .sort((a, b) => b.date.localeCompare(a.date));
  }
  const params: unknown[] = [actor.companyId];
  const conditions: string[] = ["deleted_at IS NULL", `company_id = $1`];
  const visibility = readVisibilitySql(actor, "delivery", params);
  if (visibility) conditions.push(visibility);
  if (siteId) {
    params.push(siteId);
    conditions.push(`site_id = $${params.length}`);
  }
  const result = await withTenant(actor, (client) => client.query(
    `SELECT * FROM material_deliveries WHERE ${conditions.join(" AND ")} ORDER BY date DESC`,
    params
  ));
  return result.rows.map(mapRow);
}

export async function createDelivery(
  actor: Actor,
  payload: { siteId: string; date: string; supplier: string; items: string[]; quantity: string; notes: string }
): Promise<DeliveryRecord> {
  const record: DeliveryRecord = {
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
  const result = await withTenant(actor, (client) => client.query(
    `INSERT INTO material_deliveries (id, owner_email, company_id, site_id, date, supplier, items_json, quantity, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
    [record.id, actor.email, actor.companyId, payload.siteId, payload.date, payload.supplier,
     JSON.stringify(payload.items), payload.quantity, payload.notes]
  ));
  return mapRow(result.rows[0]);
}

export async function updateDelivery(
  actor: Actor,
  id: string,
  patch: Partial<Pick<DeliveryRecord, "date" | "supplier" | "items" | "quantity" | "notes">>
): Promise<DeliveryRecord | null> {
  if (!useDatabase()) {
    const existing = memory.get(id);
    if (!existing || existing.deletedAt || !canEditRow(actor, "delivery", existing)) return null;
    const updated = { ...existing, ...patch };
    memory.set(id, updated);
    return updated;
  }
  return withTenant(actor, async (client) => {
    const check = await client.query<{ owner_email: string; company_id: string }>(
      `SELECT owner_email, company_id FROM material_deliveries WHERE id = $1 AND deleted_at IS NULL LIMIT 1`, [id]
    );
    if (check.rowCount === 0) return null;
    if (!canEditRow(actor, "delivery", { companyId: check.rows[0].company_id, ownerEmail: check.rows[0].owner_email })) return null;
    const result = await client.query(
      `UPDATE material_deliveries SET
         date     = COALESCE($2, date),
         supplier = COALESCE($3, supplier),
         items_json = COALESCE($4::jsonb, items_json),
         quantity = COALESCE($5, quantity),
         notes    = COALESCE($6, notes),
         updated_at = NOW()
       WHERE id = $1 AND company_id = $7 RETURNING *`,
      [id, patch.date ?? null, patch.supplier ?? null,
       patch.items ? JSON.stringify(patch.items) : null,
       patch.quantity ?? null, patch.notes ?? null, actor.companyId]
    );
    if (result.rowCount === 0) return null;
    return mapRow(result.rows[0]);
  });
}

export async function deleteDelivery(actor: Actor, id: string): Promise<boolean> {
  if (!useDatabase()) {
    const existing = memory.get(id);
    if (!existing || !canEditRow(actor, "delivery", existing)) return false;
    memory.set(id, { ...existing, deletedAt: new Date().toISOString() });
    return true;
  }
  const params: unknown[] = [id, actor.companyId];
  const conditions = ["id = $1", "company_id = $2", "deleted_at IS NULL"];
  const ownership = editOwnershipSql(actor, "delivery", params);
  if (ownership) conditions.push(ownership);
  const result = await withTenant(actor, (client) => client.query(
    `UPDATE material_deliveries SET deleted_at = NOW() WHERE ${conditions.join(" AND ")}`, params
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
export async function findDeliveryOwner(
  actor: Actor,
  id: string
): Promise<{ companyId: string; ownerEmail: string } | null> {
  if (!useDatabase()) {
    const existing = memory.get(id);
    if (!existing || existing.deletedAt || existing.companyId !== actor.companyId) return null;
    return { companyId: existing.companyId, ownerEmail: existing.ownerEmail };
  }
  const result = await withTenant(actor, (client) =>
    client.query<{ owner_email: string; company_id: string }>(
      `SELECT owner_email, company_id FROM material_deliveries WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [id, actor.companyId]
    )
  );
  if (result.rowCount === 0) return null;
  return { companyId: result.rows[0].company_id, ownerEmail: result.rows[0].owner_email };
}
