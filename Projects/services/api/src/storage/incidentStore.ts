import { v4 as uuidv4 } from "uuid";
import { Actor } from "./actor";
import { canEditRow, canReadRow, editOwnershipSql, readVisibilitySql } from "./recordScope";
import { withTenant } from "./tenant";

export type IncidentSeverity = "near-miss" | "minor" | "major" | "critical";
export type IncidentStatus = "open" | "closed";

export type IncidentContributingFactors = {
  environment?: string;
  human?: string;
  equipment?: string;
  methods?: string;
};

export type IncidentCorrectiveActionItem = {
  action: string;
  owner: string;
  dueDate: string | null;
  status: string;
};

export type IncidentRecord = {
  id: string;
  ownerEmail: string;
  companyId: string;
  siteId: string;
  date: string;
  severity: IncidentSeverity;
  description: string;
  injuredParty: string;
  correctiveAction: string;
  status: IncidentStatus;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string | null;
  // Pre-existing-but-previously-dropped fields (024):
  time: string;
  type: string;
  locationArea: string;
  injuredRole: string;
  injuredEmployer: string;
  natureOfInjury: string;
  bodyPart: string;
  treatmentRequired: string;
  witnesses: string;
  immediateActions: string;
  rootCause: string;
  reportedBy: string;
  supervisorNotified: boolean;
  supervisorName: string;
  // New WorkSafe NZ investigation fields (024):
  propertyDamage: string;
  firstAiderName: string;
  contributingFactors: IncidentContributingFactors;
  worksafeNotified: boolean;
  worksafeNotifiedAt: string | null;
  worksafeNotifiedHow: string;
  investigatorName: string;
  correctiveActions: IncidentCorrectiveActionItem[];
};

function useDatabase() {
  // In test mode DATABASE_URL is deliberately unset (the harness forbids it), so
  // an explicit TEST_DATABASE_URL selects the Postgres path. Without this the
  // store's DB code is never exercised by any test — which is how the incident
  // field-drop bug survived. Non-test behaviour is unchanged.
  if (process.env.NODE_ENV === "test") return Boolean(process.env.TEST_DATABASE_URL?.trim());
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
}

// canAccess and crewScopeSql lived here. Both are now in storage/recordScope.ts,
// as two separate rules: an incident is a shared site record, so anyone in the
// company reads it (canReadRow) and only its author changes it (canEditRow).

const memoryIncidents = new Map<string, IncidentRecord>();

function mapRow(row: {
  id: string; owner_email: string; company_id: string; site_id: string; date: string;
  severity: IncidentSeverity; description: string; injured_party: string | null;
  corrective_action: string | null; status: IncidentStatus;
  created_at: Date; updated_at?: Date | null; deleted_at?: Date | null;
  time?: string | null; type?: string | null; location_area?: string | null;
  injured_role?: string | null; injured_employer?: string | null; nature_of_injury?: string | null;
  body_part?: string | null; treatment_required?: string | null; witnesses?: string | null;
  immediate_actions?: string | null; root_cause?: string | null; reported_by?: string | null;
  supervisor_notified?: boolean | null; supervisor_name?: string | null;
  property_damage?: string | null; first_aider_name?: string | null;
  contributing_factors?: IncidentContributingFactors | null;
  worksafe_notified?: boolean | null; worksafe_notified_at?: Date | null; worksafe_notified_how?: string | null;
  investigator_name?: string | null; corrective_actions?: IncidentCorrectiveActionItem[] | null;
}): IncidentRecord {
  return {
    id: row.id, ownerEmail: row.owner_email, companyId: row.company_id, siteId: row.site_id, date: row.date,
    severity: row.severity, description: row.description,
    injuredParty: row.injured_party || "", correctiveAction: row.corrective_action || "",
    status: row.status, createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at ? row.updated_at.toISOString() : undefined,
    deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
    time: row.time || "", type: row.type || "", locationArea: row.location_area || "",
    injuredRole: row.injured_role || "", injuredEmployer: row.injured_employer || "",
    natureOfInjury: row.nature_of_injury || "", bodyPart: row.body_part || "",
    treatmentRequired: row.treatment_required || "", witnesses: row.witnesses || "",
    immediateActions: row.immediate_actions || "", rootCause: row.root_cause || "",
    reportedBy: row.reported_by || "", supervisorNotified: row.supervisor_notified ?? false,
    supervisorName: row.supervisor_name || "",
    propertyDamage: row.property_damage || "", firstAiderName: row.first_aider_name || "",
    contributingFactors: row.contributing_factors && typeof row.contributing_factors === "object"
      ? row.contributing_factors : {},
    worksafeNotified: row.worksafe_notified ?? false,
    worksafeNotifiedAt: row.worksafe_notified_at ? row.worksafe_notified_at.toISOString() : null,
    worksafeNotifiedHow: row.worksafe_notified_how || "",
    investigatorName: row.investigator_name || "",
    correctiveActions: Array.isArray(row.corrective_actions) ? row.corrective_actions : [],
  };
}

export async function listIncidents(actor: Actor, siteId?: string): Promise<IncidentRecord[]> {
  if (!useDatabase()) {
    return Array.from(memoryIncidents.values())
      .filter((i) => canReadRow(actor, "incident", i))
      .filter((i) => !i.deletedAt)
      .filter((i) => (siteId ? i.siteId === siteId : true))
      .sort((a, b) => b.date.localeCompare(a.date));
  }
  const params: unknown[] = [actor.companyId];
  // `company_id = $1` is kept as belt-and-braces alongside the RLS policy
  // (migration 019), which is the authoritative company filter.
  const conditions = ["deleted_at IS NULL", `company_id = $1`];
  const visibility = readVisibilitySql(actor, "incident", params);
  if (visibility) conditions.push(visibility);
  if (siteId) { params.push(siteId); conditions.push(`site_id = $${params.length}`); }
  const result = await withTenant(actor, (client) =>
    client.query(
      `SELECT * FROM incidents WHERE ${conditions.join(" AND ")} ORDER BY date DESC`,
      params
    )
  );
  return result.rows.map(mapRow);
}

export async function createIncident(actor: Actor, payload: Omit<IncidentRecord, "id" | "ownerEmail" | "companyId" | "createdAt" | "updatedAt" | "deletedAt">): Promise<IncidentRecord> {
  const record: IncidentRecord = { id: uuidv4(), ownerEmail: actor.email, companyId: actor.companyId, createdAt: new Date().toISOString(), ...payload };
  if (!useDatabase()) { memoryIncidents.set(record.id, record); return record; }
  const result = await withTenant(actor, (client) =>
    client.query(
      `INSERT INTO incidents (
         id,owner_email,company_id,site_id,date,severity,description,injured_party,corrective_action,status,
         time,type,location_area,injured_role,injured_employer,nature_of_injury,body_part,treatment_required,
         witnesses,immediate_actions,root_cause,reported_by,supervisor_notified,supervisor_name,
         property_damage,first_aider_name,contributing_factors,worksafe_notified,worksafe_notified_at,
         worksafe_notified_how,investigator_name,corrective_actions
       )
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,$15,$16,$17,$18,
         $19,$20,$21,$22,$23,$24,
         $25,$26,$27::jsonb,$28,$29,
         $30,$31,$32::jsonb
       ) RETURNING *`,
      [record.id, actor.email, actor.companyId, record.siteId, record.date, record.severity, record.description,
       record.injuredParty || null, record.correctiveAction || null, record.status,
       record.time || null, record.type || null, record.locationArea || null, record.injuredRole || null,
       record.injuredEmployer || null, record.natureOfInjury || null, record.bodyPart || null,
       record.treatmentRequired || null, record.witnesses || null, record.immediateActions || null,
       record.rootCause || null, record.reportedBy || null, record.supervisorNotified ?? false,
       record.supervisorName || null,
       record.propertyDamage || null, record.firstAiderName || null,
       JSON.stringify(record.contributingFactors || {}), record.worksafeNotified ?? false,
       record.worksafeNotifiedAt || null, record.worksafeNotifiedHow || null, record.investigatorName || null,
       JSON.stringify(record.correctiveActions || [])]
    )
  );
  return mapRow(result.rows[0]);
}

export async function updateIncident(actor: Actor, id: string, patch: Partial<Pick<IncidentRecord, "status" | "correctiveAction" | "severity">>): Promise<IncidentRecord | null> {
  if (!useDatabase()) {
    const existing = memoryIncidents.get(id);
    if (!existing || existing.deletedAt || !canEditRow(actor, "incident", existing)) return null;
    const updated = { ...existing, ...patch };
    memoryIncidents.set(id, updated);
    return updated;
  }
  // Cross-company guard is enforced by the RLS policy (migration 019); the
  // `company_id = $2` clause is kept as belt-and-braces.
  //
  // AUDIT L89: this path had no authorship check at all while the in-memory
  // path above had one, so a crew member could rewrite anyone's incident in
  // production and the suite stayed green. editOwnershipSql is that check.
  const params: unknown[] = [id, actor.companyId, patch.status ?? null, patch.correctiveAction ?? null, patch.severity ?? null];
  const conditions = ["id = $1", "company_id = $2", "deleted_at IS NULL"];
  const ownership = editOwnershipSql(actor, "incident", params);
  if (ownership) conditions.push(ownership);
  const result = await withTenant(actor, (client) =>
    client.query(
      `UPDATE incidents SET
         status = COALESCE($3, status),
         corrective_action = COALESCE($4, corrective_action),
         severity = COALESCE($5, severity),
         updated_at = NOW()
       WHERE ${conditions.join(" AND ")} RETURNING *`,
      params
    )
  );
  if (result.rowCount === 0) return null;
  return mapRow(result.rows[0]);
}

export async function deleteIncident(actor: Actor, id: string): Promise<boolean> {
  if (!useDatabase()) {
    const existing = memoryIncidents.get(id);
    if (!existing || !canEditRow(actor, "incident", existing)) return false;
    memoryIncidents.set(id, { ...existing, deletedAt: new Date().toISOString() });
    return true;
  }
  const params: unknown[] = [id, actor.companyId];
  const conditions = ["id = $1", "company_id = $2", "deleted_at IS NULL"];
  const ownership = editOwnershipSql(actor, "incident", params);
  if (ownership) conditions.push(ownership);
  const result = await withTenant(actor, (client) =>
    client.query(`UPDATE incidents SET deleted_at = NOW() WHERE ${conditions.join(" AND ")}`, params)
  );
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
export async function findIncidentOwner(
  actor: Actor,
  id: string
): Promise<{ companyId: string; ownerEmail: string } | null> {
  if (!useDatabase()) {
    const existing = memoryIncidents.get(id);
    if (!existing || existing.deletedAt || existing.companyId !== actor.companyId) return null;
    return { companyId: existing.companyId, ownerEmail: existing.ownerEmail };
  }
  const result = await withTenant(actor, (client) =>
    client.query<{ owner_email: string; company_id: string }>(
      `SELECT owner_email, company_id FROM incidents WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL LIMIT 1`,
      [id, actor.companyId]
    )
  );
  if (result.rowCount === 0) return null;
  return { companyId: result.rows[0].company_id, ownerEmail: result.rows[0].owner_email };
}
