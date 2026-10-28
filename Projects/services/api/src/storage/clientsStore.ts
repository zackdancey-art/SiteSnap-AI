import { v4 as uuidv4 } from "uuid";
import { Actor } from "./actor";
import { withTenant } from "./tenant";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CLIENTS: THE BUILDER'S HANDFUL OF CUSTOMERS, PROMOTED FROM FREE TEXT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `project_sites.client` has existed since migration 001 as a required free-text
 * field. It is captured on both clients, shown on site cards and searched on.
 * What it is not is a THING: "Metro Builders", "metro builders" and "Metro
 * Builders Pty Ltd" are three strings and no way to ask what work was done for
 * that builder. This store is that string promoted to a row.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  WHY THIS STORE DOES NOT CONSULT recordScope.ts
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Every other store here asks `recordScope.ts` who may read and who may write.
 * This one deliberately does not, and the reason is worth writing down so a
 * future session does not "fix" the inconsistency:
 *
 *   - A client is not an authored record. `created_by` on this table is
 *     provenance — who typed it in — and nothing reads it to make a decision.
 *     That is why the column is NOT called `owner_email`: a reviewer should not
 *     be able to mistake it for the ownership column that `canEditRow` and
 *     `editOwnershipSql` key on, because wiring it up that way would mean the
 *     manager who created a client is the only manager who can rename it.
 *
 *   - A client is not a site attribute either. `shared-site-attribute` means a
 *     mutable property of one site, such as progress percentage. A client is a
 *     company-level filing label that outlives every site under it.
 *
 * So the two rules here are flat and route-enforced:
 *
 *   READ  — anyone in the company, crew included. A crew member seeing a site
 *           filed under "Metro Builders" is the whole point.
 *   WRITE — manager or above, gated on the routes in routes/clients.ts.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  AND CLIENTS ARE NOT AN ACCESS BOUNDARY
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Nothing in this file is ever consulted when deciding who may read or change
 * a site, an entry, a diary or anything else. No `client_id` appears in any
 * read-visibility or ownership predicate anywhere in this service, and none
 * should be added: the tenancy boundary is `company_id` (enforced by RLS), and
 * the record rules are `recordScope.ts`. Clients are filing.
 *
 * The one thing this store shares with the rest: every query runs through
 * `withTenant` AND carries its own `company_id = $n`, because `clients` is
 * RLS-forced by migration 032 and CLAUDE.md §3 keeps both layers.
 */

/**
 * Table and column names used by more than one store, in one place.
 *
 * `project_sites.client_id` is written by `projectsStore` and read by the site
 * count below, which is two files holding the same string — the shape that put
 * a `deleted_at` predicate on a table that has never had the column. Imported,
 * not retyped.
 */
export const CLIENTS_TABLE = "clients";
export const SITE_CLIENT_COLUMN = "client_id";

export type ClientRecord = {
  id: string;
  companyId: string;
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type ClientInput = {
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
};

const memory = new Map<string, ClientRecord>();

/** @internal Test isolation, per CLAUDE.md §6. */
export function resetClientsStoreForTests(): void {
  memory.clear();
}

function useDatabase() {
  // Same test-awareness as projectsStore: in test mode DATABASE_URL is blanked
  // by the harness, so TEST_DATABASE_URL is what selects the Postgres path.
  // Without this the pg half of this file would be unreachable from any test.
  if (process.env.NODE_ENV === "test") return Boolean(process.env.TEST_DATABASE_URL?.trim());
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
}

type ClientRow = {
  id: string;
  company_id: string;
  name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  notes: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

function mapRow(row: ClientRow): ClientRecord {
  return {
    id: row.id,
    companyId: row.company_id,
    name: row.name,
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * The comparison the unique index in migration 032 makes.
 *
 * `lower(btrim(name))` there; the same fold here, so the in-memory path refuses
 * the duplicate the database would refuse. Two spellings of one builder is the
 * defect this whole workstream exists to stop, and it would be absurd for the
 * dev and test path to allow it.
 */
function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

function sortByName(a: ClientRecord, b: ClientRecord): number {
  return nameKey(a.name).localeCompare(nameKey(b.name));
}

/** Raised when a name collides with an existing client in the same company. */
export class DuplicateClientNameError extends Error {
  constructor(public readonly existingId: string) {
    super("A client with that name already exists.");
    this.name = "DuplicateClientNameError";
  }
}

export async function listClients(actor: Actor): Promise<ClientRecord[]> {
  if (!useDatabase()) {
    return Array.from(memory.values())
      .filter((c) => c.companyId === actor.companyId)
      .sort(sortByName);
  }
  const result = await withTenant(actor, (client) =>
    client.query<ClientRow>(
      `SELECT * FROM ${CLIENTS_TABLE} WHERE company_id = $1 ORDER BY lower(btrim(name)) ASC`,
      [actor.companyId]
    )
  );
  return result.rows.map(mapRow);
}

export async function getClient(actor: Actor, id: string): Promise<ClientRecord | null> {
  if (!useDatabase()) {
    const existing = memory.get(id);
    if (!existing || existing.companyId !== actor.companyId) return null;
    return existing;
  }
  const result = await withTenant(actor, (client) =>
    client.query<ClientRow>(
      `SELECT * FROM ${CLIENTS_TABLE} WHERE id = $1 AND company_id = $2 LIMIT 1`,
      [id, actor.companyId]
    )
  );
  if (result.rowCount === 0) return null;
  return mapRow(result.rows[0]);
}

export async function createClient(actor: Actor, payload: ClientInput): Promise<ClientRecord> {
  const now = new Date().toISOString();
  const record: ClientRecord = {
    id: uuidv4(),
    companyId: actor.companyId,
    name: payload.name.trim(),
    contactName: payload.contactName,
    contactEmail: payload.contactEmail,
    contactPhone: payload.contactPhone,
    notes: payload.notes,
    createdBy: actor.email,
    createdAt: now,
    updatedAt: now,
  };
  if (!useDatabase()) {
    const clash = Array.from(memory.values()).find(
      (c) => c.companyId === actor.companyId && nameKey(c.name) === nameKey(record.name)
    );
    if (clash) throw new DuplicateClientNameError(clash.id);
    memory.set(record.id, record);
    return record;
  }
  // ON CONFLICT names the index from migration 032 by its predicate rather than
  // by its name, so the two stay in step if the index is ever renamed.
  const result = await withTenant(actor, (client) =>
    client.query<ClientRow>(
      `INSERT INTO ${CLIENTS_TABLE}
         (id, company_id, name, contact_name, contact_email, contact_phone, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (company_id, lower(btrim(name))) DO NOTHING
       RETURNING *`,
      [record.id, actor.companyId, record.name, record.contactName, record.contactEmail,
       record.contactPhone, record.notes, actor.email]
    )
  );
  if (result.rowCount === 0) {
    const clash = await withTenant(actor, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM ${CLIENTS_TABLE} WHERE company_id = $1 AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
        [actor.companyId, record.name]
      )
    );
    throw new DuplicateClientNameError(clash.rows[0]?.id ?? "");
  }
  return mapRow(result.rows[0]);
}

export async function updateClient(
  actor: Actor,
  id: string,
  patch: Partial<ClientInput>
): Promise<ClientRecord | null> {
  const trimmedName = patch.name === undefined ? undefined : patch.name.trim();
  if (!useDatabase()) {
    const existing = memory.get(id);
    if (!existing || existing.companyId !== actor.companyId) return null;
    if (trimmedName !== undefined) {
      const clash = Array.from(memory.values()).find(
        (c) => c.id !== id && c.companyId === actor.companyId && nameKey(c.name) === nameKey(trimmedName)
      );
      if (clash) throw new DuplicateClientNameError(clash.id);
    }
    const updated: ClientRecord = {
      ...existing,
      ...patch,
      ...(trimmedName !== undefined ? { name: trimmedName } : {}),
      updatedAt: new Date().toISOString(),
    };
    memory.set(id, updated);
    return updated;
  }
  if (trimmedName !== undefined) {
    const clash = await withTenant(actor, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM ${CLIENTS_TABLE}
          WHERE company_id = $1 AND lower(btrim(name)) = lower(btrim($2)) AND id <> $3 LIMIT 1`,
        [actor.companyId, trimmedName, id]
      )
    );
    if (clash.rowCount && clash.rowCount > 0) throw new DuplicateClientNameError(clash.rows[0].id);
  }
  const result = await withTenant(actor, (client) =>
    client.query<ClientRow>(
      `UPDATE ${CLIENTS_TABLE} SET
         name          = COALESCE($3, name),
         contact_name  = COALESCE($4, contact_name),
         contact_email = COALESCE($5, contact_email),
         contact_phone = COALESCE($6, contact_phone),
         notes         = COALESCE($7, notes),
         updated_at    = NOW()
       WHERE id = $1 AND company_id = $2
       RETURNING *`,
      [id, actor.companyId, trimmedName ?? null, patch.contactName ?? null,
       patch.contactEmail ?? null, patch.contactPhone ?? null, patch.notes ?? null]
    )
  );
  if (result.rowCount === 0) return null;
  return mapRow(result.rows[0]);
}

/**
 * How many of this company's sites are filed under a client.
 *
 * Exists so DELETE can tell the caller what it is about to unfile, and so the
 * clients list can be rendered with counts in ONE query rather than one per
 * client. Returns a map keyed by client id; clients with no sites are absent
 * rather than zero, which the callers normalise.
 */
export async function countSitesByClient(actor: Actor): Promise<Record<string, number>> {
  if (!useDatabase()) {
    // The in-memory twin has to ask projectsStore, which is the only place the
    // site rows live in that mode. Imported lazily to keep the module graph
    // one-directional: projectsStore does not know this file exists.
    const { listSitesForClientCounts } = await import("./projectsStore");
    const counts: Record<string, number> = {};
    for (const site of await listSitesForClientCounts(actor)) {
      if (!site.clientId) continue;
      counts[site.clientId] = (counts[site.clientId] ?? 0) + 1;
    }
    return counts;
  }
  const result = await withTenant(actor, (client) =>
    client.query<{ client_id: string; count: string }>(
      `SELECT ${SITE_CLIENT_COLUMN} AS client_id, COUNT(*)::int AS count
         FROM project_sites
        WHERE company_id = $1 AND ${SITE_CLIENT_COLUMN} IS NOT NULL
        GROUP BY ${SITE_CLIENT_COLUMN}`,
      [actor.companyId]
    )
  );
  const counts: Record<string, number> = {};
  for (const row of result.rows) counts[row.client_id] = Number(row.count);
  return counts;
}

/**
 * Remove a client. Sites filed under it are UNFILED, never deleted.
 *
 * The database does the unfiling: `client_id` is `REFERENCES clients(id) ON
 * DELETE SET NULL` in migration 032, deliberately not CASCADE. The in-memory
 * path has no foreign keys, so it does the same thing by hand — and the
 * DB-gated test asserts the site survived with a null `client_id`, which is the
 * assertion that would have caught a CASCADE.
 *
 * Returns the number of sites unfiled, or null when there was no such client.
 */
export async function deleteClient(actor: Actor, id: string): Promise<{ unfiledSites: number } | null> {
  if (!useDatabase()) {
    const existing = memory.get(id);
    if (!existing || existing.companyId !== actor.companyId) return null;
    const { unfileSitesForDeletedClient } = await import("./projectsStore");
    const unfiledSites = await unfileSitesForDeletedClient(actor, id);
    memory.delete(id);
    return { unfiledSites };
  }
  return withTenant(actor, async (client) => {
    const counted = await client.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM project_sites
        WHERE company_id = $1 AND ${SITE_CLIENT_COLUMN} = $2`,
      [actor.companyId, id]
    );
    const result = await client.query(
      `DELETE FROM ${CLIENTS_TABLE} WHERE id = $1 AND company_id = $2`,
      [id, actor.companyId]
    );
    if ((result.rowCount ?? 0) === 0) return null;
    return { unfiledSites: Number(counted.rows[0]?.count ?? 0) };
  });
}
