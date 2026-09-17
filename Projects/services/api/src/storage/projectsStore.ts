import crypto from "crypto";
import path from "path";
import { v7 as uuidv7 } from "uuid";
import { getPgPool } from "./postgres";
import { CompanyRole, soloCompanyIdForEmail } from "../utils/authToken";
import { Actor, isCrew } from "./actor";
import { FileBackedStore } from "./fileStore";
import { findUserByEmail, setUserCompany } from "./authStore";
import { withTenant } from "./tenant";
import { DiaryProvenance } from "../services/diaryProvenance";

type SiteStatus = "active" | "completed" | "on-hold";
type DiaryStatus = "draft" | "approved";
type ReportPeriod = "daily" | "weekly" | "monthly";

export type SiteRecord = {
  id: string;
  ownerEmail: string;
  companyId: string;
  name: string;
  address: string;
  client: string;
  startDate: string;
  status: SiteStatus;
  createdAt: string;
  progressPercent?: number;
  deletedAt?: string | null;
};

export type EntryRecord = {
  id: string;
  ownerEmail: string;
  companyId: string;
  siteId: string;
  date: string;
  locationAddress: string;
  weather: string;
  crewCount: string;
  notes: string;
  photos: Array<Record<string, unknown>>;
  timestamp: string;
  swmsRef?: string;
  hazardNotes?: string;
  toolboxTalk?: boolean;
  // 5b: per-entry choice of free-form notes vs an hourly log. Additive; the
  // columns (notes_mode / hourly_notes) were added in migration 024.
  notesMode?: "free" | "hourly";
  hourlyNotes?: Array<{ hour: number; note: string }>;
};

export type DiaryEditLogEntry = {
  at: string;
  action: "approved" | "reverted" | "edited";
  by: string;
  note?: string;
};

export type DiaryRecord = {
  id: string;
  ownerEmail: string;
  companyId: string;
  siteId: string;
  generatedAt: string;
  status: DiaryStatus;
  summary: string;
  reportPeriod: ReportPeriod;
  fullReport: string;
  safetyChecklist: string[];
  sections: Array<Record<string, unknown>>;
  editLog: DiaryEditLogEntry[];
  /**
   * Which generator wrote this diary. NULL on every row created before
   * migration 030 — genuinely unknown, never assumed. Written only from a
   * server-verified signature (see services/diaryProvenance.ts); never patchable.
   */
  generation: DiaryProvenance | null;
};

export type TemplateRecord = {
  id: string;
  ownerEmail: string;
  companyId: string;
  siteId: string;
  name: string;
  weather: string;
  crewCount: string;
  notesTemplate: string;
  createdAt: string;
};

export type SiteInviteRecord = {
  id: string;
  siteId: string | null;
  companyId: string | null;
  companyRole: CompanyRole | null;
  invitedEmail: string;
  invitedBy: string;
  role: string;
  token: string;
  expiresAt: string;
  createdAt: string;
};

export type SiteMemberRecord = {
  siteId: string;
  memberEmail: string;
  role: string;
  invitedBy: string;
  joinedAt: string;
};

export type InviteResult = {
  email: string;
  status: "sent" | "resent" | "already_member";
};

type MemoryState = {
  sites: Map<string, SiteRecord>;
  entries: Map<string, EntryRecord>;
  diaries: Map<string, DiaryRecord>;
  templates: Map<string, TemplateRecord>;
  siteInvites: Map<string, SiteInviteRecord>;  // key = token
  siteMembers: Map<string, SiteMemberRecord>;  // key = `${siteId}:${memberEmail}`
};

type MemoryJson = {
  sites: SiteRecord[];
  entries: EntryRecord[];
  diaries: DiaryRecord[];
  templates: TemplateRecord[];
  siteInvites?: SiteInviteRecord[];
  siteMembers?: SiteMemberRecord[];
};

const memory: MemoryState = {
  sites: new Map<string, SiteRecord>(),
  entries: new Map<string, EntryRecord>(),
  diaries: new Map<string, DiaryRecord>(),
  templates: new Map<string, TemplateRecord>(),
  siteInvites: new Map<string, SiteInviteRecord>(),
  siteMembers: new Map<string, SiteMemberRecord>(),
};

function useDatabase() {
  // In test mode DATABASE_URL is deliberately unset (the harness forbids it), so
  // an explicit TEST_DATABASE_URL selects the Postgres path — otherwise this
  // store's DB code (incl. the H1b withTenant conversions + acceptSiteInvite's
  // token-scoped accept) is never exercised by any test. Non-test unchanged.
  if (process.env.NODE_ENV === "test") return Boolean(process.env.TEST_DATABASE_URL?.trim());
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
}

// Company-scoped access to a row identified by its company + owner. A row is
// accessible when it belongs to the actor's company AND, for crew, when the
// actor owns it or is a member of its site. Non-crew (viewer/manager/owner)
// see everything within their own company.
function canAccessRow(
  actor: Actor,
  rowCompanyId: string,
  ownerEmail: string,
  memberSiteIds?: Set<string>,
  siteId?: string
): boolean {
  // Explicit site-member record grants access regardless of company match —
  // this allows site invites accepted with a stale pre-accept token to still
  // surface the invited site in list queries.
  if (siteId && memberSiteIds?.has(siteId)) return true;
  if (rowCompanyId !== actor.companyId) return false;
  // Crew only see sites they own; non-crew company members see all.
  if (isCrew(actor)) return actor.email === ownerEmail;
  return true;
}

const store = new FileBackedStore<Partial<MemoryJson>>(
  path.join(process.cwd(), "data", "projects-store.json"),
  (parsed) => {
    for (const site of Array.isArray(parsed.sites) ? parsed.sites : []) {
      memory.sites.set(site.id, site);
    }
    for (const entry of Array.isArray(parsed.entries) ? parsed.entries : []) {
      memory.entries.set(entry.id, entry);
    }
    for (const diary of Array.isArray(parsed.diaries) ? parsed.diaries : []) {
      memory.diaries.set(diary.id, diary);
    }
    for (const tmpl of Array.isArray(parsed.templates) ? parsed.templates : []) {
      memory.templates.set(tmpl.id, tmpl);
    }
    for (const inv of Array.isArray(parsed.siteInvites) ? parsed.siteInvites : []) {
      memory.siteInvites.set(inv.token, inv);
    }
    for (const mem of Array.isArray(parsed.siteMembers) ? parsed.siteMembers : []) {
      memory.siteMembers.set(`${mem.siteId}:${mem.memberEmail}`, mem);
    }
  },
  () => ({
    sites: Array.from(memory.sites.values()),
    entries: Array.from(memory.entries.values()),
    diaries: Array.from(memory.diaries.values()),
    templates: Array.from(memory.templates.values()),
    siteInvites: Array.from(memory.siteInvites.values()),
    siteMembers: Array.from(memory.siteMembers.values()),
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

export async function initProjectSchema() {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    return;
  }

  await getPgPool().query(`
    CREATE TABLE IF NOT EXISTS project_sites (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL REFERENCES auth_users(email) ON DELETE CASCADE,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      client TEXT NOT NULL,
      start_date TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await getPgPool().query(`
    CREATE TABLE IF NOT EXISTS project_entries (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL REFERENCES auth_users(email) ON DELETE CASCADE,
      site_id TEXT NOT NULL REFERENCES project_sites(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      location_address TEXT NOT NULL DEFAULT '',
      weather TEXT NOT NULL DEFAULT '',
      crew_count TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      photos_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await getPgPool().query(`
    CREATE TABLE IF NOT EXISTS project_diaries (
      id TEXT PRIMARY KEY,
      owner_email TEXT NOT NULL REFERENCES auth_users(email) ON DELETE CASCADE,
      site_id TEXT NOT NULL REFERENCES project_sites(id) ON DELETE CASCADE,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'draft',
      summary TEXT NOT NULL DEFAULT '',
      report_period TEXT NOT NULL DEFAULT 'daily',
      full_report TEXT NOT NULL DEFAULT '',
      safety_checklist_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      sections_json JSONB NOT NULL DEFAULT '[]'::jsonb
    )
  `);
  await getPgPool().query(`
    ALTER TABLE project_diaries
      ADD COLUMN IF NOT EXISTS report_period TEXT NOT NULL DEFAULT 'daily',
      ADD COLUMN IF NOT EXISTS full_report TEXT NOT NULL DEFAULT '',
      ADD COLUMN IF NOT EXISTS safety_checklist_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS generation JSONB
  `);
}

function mapSite(row: {
  id: string;
  owner_email: string;
  company_id: string;
  name: string;
  address: string;
  client: string;
  start_date: string;
  status: SiteStatus;
  created_at: Date;
}): SiteRecord {
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    companyId: row.company_id,
    name: row.name,
    address: row.address,
    client: row.client,
    startDate: row.start_date,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

function mapEntry(row: {
  id: string;
  owner_email: string;
  company_id: string;
  site_id: string;
  date: string;
  location_address: string;
  weather: string;
  crew_count: string;
  notes: string;
  photos_json: Array<Record<string, unknown>>;
  timestamp: Date;
  swms_ref?: string | null;
  hazard_notes?: string | null;
  toolbox_talk?: boolean | null;
  notes_mode?: string | null;
  hourly_notes?: Array<{ hour: number; note: string }> | null;
}): EntryRecord {
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    companyId: row.company_id,
    siteId: row.site_id,
    date: row.date,
    locationAddress: row.location_address,
    weather: row.weather,
    crewCount: row.crew_count,
    notes: row.notes,
    photos: row.photos_json,
    timestamp: row.timestamp.toISOString(),
    swmsRef: row.swms_ref ?? undefined,
    hazardNotes: row.hazard_notes ?? undefined,
    toolboxTalk: row.toolbox_talk ?? undefined,
    notesMode: row.notes_mode === "hourly" ? "hourly" : "free",
    hourlyNotes: Array.isArray(row.hourly_notes) ? row.hourly_notes : [],
  };
}

function mapDiary(row: {
  id: string;
  owner_email: string;
  company_id: string;
  site_id: string;
  generated_at: Date;
  status: DiaryStatus;
  summary: string;
  report_period: string;
  full_report: string;
  safety_checklist_json: string[] | null;
  sections_json: Array<Record<string, unknown>>;
  edit_log?: DiaryEditLogEntry[] | null;
  generation?: DiaryProvenance | null;
}): DiaryRecord {
  const period: ReportPeriod =
    row.report_period === "weekly" || row.report_period === "monthly" ? row.report_period : "daily";
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    companyId: row.company_id,
    siteId: row.site_id,
    generatedAt: row.generated_at.toISOString(),
    status: row.status,
    summary: row.summary,
    reportPeriod: period,
    fullReport: row.full_report || "",
    safetyChecklist: Array.isArray(row.safety_checklist_json) ? row.safety_checklist_json : [],
    sections: row.sections_json,
    editLog: Array.isArray(row.edit_log) ? row.edit_log : [],
    generation: row.generation ?? null,
  };
}

type SiteRow = {
  id: string;
  owner_email: string;
  company_id: string;
  name: string;
  address: string;
  client: string;
  start_date: string;
  status: SiteStatus;
  created_at: Date;
};

export async function listSites(actor: Actor, limit = 200, offset = 0): Promise<SiteRecord[]> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const memberSiteIds = new Set(
      Array.from(memory.siteMembers.values())
        .filter((m) => m.memberEmail === actor.email)
        .map((m) => m.siteId)
    );
    return Array.from(memory.sites.values())
      .filter((site) => canAccessRow(actor, site.companyId, site.ownerEmail, memberSiteIds, site.id))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(offset, offset + limit);
  }
  // Non-crew (viewer/manager/owner): every site in the company.
  // Crew: only sites they own or are a member of, within the company.
  const result = await withTenant(actor, (client) =>
    !isCrew(actor)
      ? client.query<SiteRow>(
          `SELECT * FROM project_sites
           WHERE company_id = $1
           ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
          [actor.companyId, limit, offset]
        )
      : client.query<SiteRow>(
          `SELECT * FROM project_sites
           WHERE company_id = $1
             AND (owner_email = $2
                  OR id IN (SELECT site_id FROM site_members WHERE member_email = $2))
           ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
          [actor.companyId, actor.email, limit, offset]
        )
  );
  return result.rows.map(mapSite);
}

export async function createSite(
  actor: Actor,
  payload: Omit<SiteRecord, "id" | "ownerEmail" | "createdAt" | "companyId">
): Promise<SiteRecord> {
  const site: SiteRecord = {
    id: uuidv7(),
    ownerEmail: actor.email,
    companyId: actor.companyId,
    createdAt: new Date().toISOString(),
    ...payload,
  };
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    memory.sites.set(site.id, site);
    await persistMemory();
    return site;
  }
  const result = await withTenant(actor, (client) =>
    client.query<SiteRow>(
      `INSERT INTO project_sites (id, owner_email, company_id, name, address, client, start_date, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [site.id, actor.email, actor.companyId, site.name, site.address, site.client, site.startDate, site.status]
    )
  );
  return mapSite(result.rows[0]);
}

export async function deleteSite(actor: Actor, siteId: string): Promise<boolean> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const existing = memory.sites.get(siteId);
    // Cross-company guard: never touch another company's site.
    if (!existing || existing.companyId !== actor.companyId) return false;
    // Crew may only delete sites they own.
    if (isCrew(actor) && existing.ownerEmail !== actor.email) return false;
    memory.sites.delete(siteId);
    for (const [entryId, entry] of memory.entries.entries()) {
      if (entry.siteId === siteId) memory.entries.delete(entryId);
    }
    for (const [diaryId, diary] of memory.diaries.entries()) {
      if (diary.siteId === siteId) memory.diaries.delete(diaryId);
    }
    await persistMemory();
    return true;
  }
  const result = await withTenant(actor, (client) =>
    isCrew(actor)
      ? client.query(
          `DELETE FROM project_sites WHERE id = $1 AND company_id = $2 AND owner_email = $3`,
          [siteId, actor.companyId, actor.email]
        )
      : client.query(
          `DELETE FROM project_sites WHERE id = $1 AND company_id = $2`,
          [siteId, actor.companyId]
        )
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listEntries(actor: Actor, siteId?: string, limit = 200, offset = 0): Promise<EntryRecord[]> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const memberSiteIds = new Set(
      Array.from(memory.siteMembers.values())
        .filter((m) => m.memberEmail === actor.email)
        .map((m) => m.siteId)
    );
    return Array.from(memory.entries.values())
      .filter((entry) => canAccessRow(actor, entry.companyId, entry.ownerEmail, memberSiteIds, entry.siteId))
      .filter((entry) => (siteId ? entry.siteId === siteId : true))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(offset, offset + limit);
  }

  // Always company-scoped. Crew additionally limited to owned/member sites.
  const params: unknown[] = [actor.companyId];
  const queryParts: string[] = [`company_id = $1`];
  if (isCrew(actor)) {
    params.push(actor.email);
    queryParts.push(
      `(owner_email = $${params.length} OR site_id IN (SELECT site_id FROM site_members WHERE member_email = $${params.length}))`
    );
  }
  if (siteId) {
    params.push(siteId);
    queryParts.push(`site_id = $${params.length}`);
  }
  const where = `WHERE ${queryParts.join(" AND ")}`;
  params.push(limit, offset);
  const result = await withTenant(actor, (client) =>
    client.query(
      `SELECT * FROM project_entries ${where} ORDER BY timestamp DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
  );
  return result.rows.map(mapEntry);
}

export async function createEntry(
  actor: Actor,
  payload: Omit<EntryRecord, "id" | "ownerEmail" | "timestamp" | "companyId">
): Promise<EntryRecord> {
  const entry: EntryRecord = {
    id: uuidv7(),
    ownerEmail: actor.email,
    companyId: actor.companyId,
    timestamp: new Date().toISOString(),
    ...payload,
    // Normalize the 5b fields here so the in-memory store path (which stores the
    // record verbatim, never through mapEntry) matches the Postgres path's
    // defaults instead of leaving them undefined in dev/tests.
    notesMode: payload.notesMode ?? "free",
    hourlyNotes: payload.hourlyNotes ?? [],
  };
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    memory.entries.set(entry.id, entry);
    await persistMemory();
    return entry;
  }
  const result = await withTenant(actor, (client) =>
    client.query(
      `INSERT INTO project_entries
         (id, owner_email, company_id, site_id, date, location_address, weather, crew_count, notes, photos_json, swms_ref, hazard_notes, toolbox_talk, notes_mode, hourly_notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15::jsonb)
       RETURNING *`,
      [
        entry.id,
        actor.email,
        actor.companyId,
        entry.siteId,
        entry.date,
        entry.locationAddress,
        entry.weather,
        entry.crewCount,
        entry.notes,
        JSON.stringify(entry.photos),
        entry.swmsRef ?? "",
        entry.hazardNotes ?? "",
        entry.toolboxTalk ?? false,
        entry.notesMode ?? "free",
        JSON.stringify(entry.hourlyNotes ?? []),
      ]
    )
  );
  return mapEntry(result.rows[0]);
}

export async function updateEntry(
  actor: Actor,
  entryId: string,
  patch: Partial<Omit<EntryRecord, "id" | "ownerEmail" | "timestamp" | "siteId">>
): Promise<EntryRecord | null> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const memberSiteIds = new Set(
      Array.from(memory.siteMembers.values())
        .filter((m) => m.memberEmail === actor.email)
        .map((m) => m.siteId)
    );
    const current = memory.entries.get(entryId);
    if (!current || !canAccessRow(actor, current.companyId, current.ownerEmail, memberSiteIds, current.siteId)) return null;
    const updated: EntryRecord = {
      ...current,
      ...patch,
      timestamp: new Date().toISOString(),
    };
    memory.entries.set(entryId, updated);
    await persistMemory();
    return updated;
  }
  return withTenant(actor, async (client) => {
    const existingResult = await client.query<{ owner_email: string; company_id: string; site_id: string }>(
      `SELECT owner_email, company_id, site_id FROM project_entries WHERE id = $1 LIMIT 1`,
      [entryId]
    );
    if (existingResult.rowCount === 0) return null;
    const existingRow = existingResult.rows[0];
    // Cross-company guard: a different company's row is invisible (treated as 404).
    if (existingRow.company_id !== actor.companyId) return null;
    if (isCrew(actor) && existingRow.owner_email !== actor.email) {
      const member = await client.query(
        `SELECT 1 FROM site_members WHERE site_id = $1 AND member_email = $2`,
        [existingRow.site_id, actor.email]
      );
      if (member.rowCount === 0) return null;
    }

    const result = await client.query(
      `UPDATE project_entries
       SET
         date = COALESCE($2, date),
         location_address = COALESCE($3, location_address),
         weather = COALESCE($4, weather),
         crew_count = COALESCE($5, crew_count),
         notes = COALESCE($6, notes),
         photos_json = COALESCE($7::jsonb, photos_json),
         swms_ref = COALESCE($8, swms_ref),
         hazard_notes = COALESCE($9, hazard_notes),
         toolbox_talk = COALESCE($10, toolbox_talk),
         notes_mode = COALESCE($11, notes_mode),
         hourly_notes = COALESCE($12::jsonb, hourly_notes),
         timestamp = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        entryId,
        patch.date ?? null,
        patch.locationAddress ?? null,
        patch.weather ?? null,
        patch.crewCount ?? null,
        patch.notes ?? null,
        patch.photos ? JSON.stringify(patch.photos) : null,
        patch.swmsRef ?? null,
        patch.hazardNotes ?? null,
        patch.toolboxTalk ?? null,
        patch.notesMode ?? null,
        patch.hourlyNotes ? JSON.stringify(patch.hourlyNotes) : null,
      ]
    );
    if (result.rowCount === 0) return null;
    return mapEntry(result.rows[0]);
  });
}

export async function deleteEntry(actor: Actor, entryId: string): Promise<boolean> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const existing = memory.entries.get(entryId);
    if (!existing || existing.companyId !== actor.companyId) return false;
    if (isCrew(actor) && existing.ownerEmail !== actor.email) return false;
    memory.entries.delete(entryId);
    await persistMemory();
    return true;
  }
  const result = await withTenant(actor, (client) =>
    isCrew(actor)
      ? client.query(
          `DELETE FROM project_entries WHERE id = $1 AND company_id = $2 AND owner_email = $3`,
          [entryId, actor.companyId, actor.email]
        )
      : client.query(
          `DELETE FROM project_entries WHERE id = $1 AND company_id = $2`,
          [entryId, actor.companyId]
        )
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listDiaries(actor: Actor, siteId?: string, limit = 200, offset = 0): Promise<DiaryRecord[]> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const memberSiteIds = new Set(
      Array.from(memory.siteMembers.values())
        .filter((m) => m.memberEmail === actor.email)
        .map((m) => m.siteId)
    );
    return Array.from(memory.diaries.values())
      .filter((diary) => canAccessRow(actor, diary.companyId, diary.ownerEmail, memberSiteIds, diary.siteId))
      .filter((diary) => (siteId ? diary.siteId === siteId : true))
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))
      .slice(offset, offset + limit);
  }
  const params: unknown[] = [actor.companyId];
  const queryParts: string[] = [`company_id = $1`];
  if (isCrew(actor)) {
    params.push(actor.email);
    queryParts.push(
      `(owner_email = $${params.length} OR site_id IN (SELECT site_id FROM site_members WHERE member_email = $${params.length}))`
    );
  }
  if (siteId) {
    params.push(siteId);
    queryParts.push(`site_id = $${params.length}`);
  }
  const where = `WHERE ${queryParts.join(" AND ")}`;
  params.push(limit, offset);
  const result = await withTenant(actor, (client) =>
    client.query(
      `SELECT * FROM project_diaries ${where} ORDER BY generated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    )
  );
  return result.rows.map(mapDiary);
}

export async function createDiary(
  actor: Actor,
  // `generation` is optional on the way in — callers that never generated
  // anything (tests, imports) simply omit it and the row records NULL.
  payload: Omit<DiaryRecord, "id" | "ownerEmail" | "generatedAt" | "editLog" | "companyId" | "generation"> & {
    generation?: DiaryProvenance | null;
  }
): Promise<DiaryRecord> {
  const diary: DiaryRecord = {
    id: uuidv7(),
    ownerEmail: actor.email,
    companyId: actor.companyId,
    generatedAt: new Date().toISOString(),
    editLog: [],
    ...payload,
    generation: payload.generation ?? null,
  };
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    memory.diaries.set(diary.id, diary);
    await persistMemory();
    return diary;
  }
  const result = await withTenant(actor, (client) =>
    client.query(
      `INSERT INTO project_diaries (
        id, owner_email, company_id, site_id, status, summary, report_period, full_report, safety_checklist_json, sections_json, generation
      )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb)
       RETURNING *`,
      [
        diary.id,
        actor.email,
        actor.companyId,
        diary.siteId,
        diary.status,
        diary.summary,
        diary.reportPeriod,
        diary.fullReport,
        JSON.stringify(diary.safetyChecklist),
        JSON.stringify(diary.sections),
        diary.generation ? JSON.stringify(diary.generation) : null,
      ]
    )
  );
  return mapDiary(result.rows[0]);
}

function buildAuditEntry(
  current: DiaryRecord,
  patch: Partial<Pick<DiaryRecord, "status" | "summary" | "reportPeriod" | "fullReport" | "safetyChecklist" | "sections">>,
  actor: Actor,
  note?: string
): DiaryEditLogEntry | null {
  if (patch.status && patch.status !== current.status) {
    const action = patch.status === "approved" ? "approved" : "reverted";
    const entry: DiaryEditLogEntry = { at: new Date().toISOString(), action, by: actor.email };
    if (note) entry.note = note;
    return entry;
  }
  const contentChanged =
    (patch.summary !== undefined && patch.summary !== current.summary) ||
    (patch.fullReport !== undefined && patch.fullReport !== current.fullReport);
  if (contentChanged) {
    return { at: new Date().toISOString(), action: "edited", by: actor.email };
  }
  return null;
}

export async function updateDiary(
  actor: Actor,
  diaryId: string,
  patch: Partial<Pick<DiaryRecord, "status" | "summary" | "reportPeriod" | "fullReport" | "safetyChecklist" | "sections">>,
  note?: string
): Promise<DiaryRecord | null> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const memberSiteIds = new Set(
      Array.from(memory.siteMembers.values())
        .filter((m) => m.memberEmail === actor.email)
        .map((m) => m.siteId)
    );
    const current = memory.diaries.get(diaryId);
    if (!current || !canAccessRow(actor, current.companyId, current.ownerEmail, memberSiteIds, current.siteId)) return null;
    const auditEntry = buildAuditEntry(current, patch, actor, note);
    const updated: DiaryRecord = {
      ...current,
      ...patch,
      editLog: auditEntry ? [...current.editLog, auditEntry] : current.editLog,
    };
    memory.diaries.set(diaryId, updated);
    await persistMemory();
    return updated;
  }

  return withTenant(actor, async (client) => {
    const existingResult = await client.query<{
      owner_email: string;
      company_id: string;
      site_id: string;
      status: DiaryStatus;
      summary: string;
      full_report: string;
      edit_log: DiaryEditLogEntry[] | null;
    }>(
      `SELECT owner_email, company_id, site_id, status, summary, full_report, edit_log FROM project_diaries WHERE id = $1 LIMIT 1`,
      [diaryId]
    );
    if (existingResult.rowCount === 0) return null;
    const existing = existingResult.rows[0];
    if (existing.company_id !== actor.companyId) return null;
    if (isCrew(actor) && existing.owner_email !== actor.email) {
      const member = await client.query(
        `SELECT 1 FROM site_members WHERE site_id = $1 AND member_email = $2`,
        [existing.site_id, actor.email]
      );
      if (member.rowCount === 0) return null;
    }

    const currentForAudit: DiaryRecord = {
      id: diaryId,
      ownerEmail: existing.owner_email,
      companyId: existing.company_id,
      siteId: "",
      generatedAt: "",
      status: existing.status,
      summary: existing.summary,
      generation: null,
      reportPeriod: "daily",
      fullReport: existing.full_report,
      safetyChecklist: [],
      sections: [],
      editLog: Array.isArray(existing.edit_log) ? existing.edit_log : [],
    };
    const auditEntry = buildAuditEntry(currentForAudit, patch, actor, note);

    const result = await client.query<{
      id: string;
      owner_email: string;
      company_id: string;
      site_id: string;
      generated_at: Date;
      status: DiaryStatus;
      summary: string;
      report_period: string;
      full_report: string;
      safety_checklist_json: string[] | null;
      sections_json: Array<Record<string, unknown>>;
      edit_log: DiaryEditLogEntry[] | null;
    }>(
      `UPDATE project_diaries
       SET
         status = COALESCE($2, status),
         summary = COALESCE($3, summary),
         report_period = COALESCE($4, report_period),
         full_report = COALESCE($5, full_report),
         safety_checklist_json = COALESCE($6::jsonb, safety_checklist_json),
         sections_json = COALESCE($7::jsonb, sections_json),
         edit_log = CASE WHEN $8::jsonb IS NOT NULL THEN edit_log || $8::jsonb ELSE edit_log END
       WHERE id = $1
       RETURNING *`,
      [
        diaryId,
        patch.status ?? null,
        patch.summary ?? null,
        patch.reportPeriod ?? null,
        patch.fullReport ?? null,
        patch.safetyChecklist ? JSON.stringify(patch.safetyChecklist) : null,
        patch.sections ? JSON.stringify(patch.sections) : null,
        auditEntry ? JSON.stringify([auditEntry]) : null,
      ]
    );
    if (result.rowCount === 0) return null;
    return mapDiary(result.rows[0]);
  });
}

export async function getScopedBootstrap(actor: Actor) {
  const [sites, entries, diaries] = await Promise.all([listSites(actor), listEntries(actor), listDiaries(actor)]);
  return { sites, entries, diaries };
}

export type SupervisorReportRow = {
  siteId: string;
  name: string;
  client: string;
  status: SiteStatus;
  ownerEmail: string;
  entries: number;
  diaries: number;
  approvedDiaries: number;
};

export async function getSupervisorReport(actor: Actor): Promise<SupervisorReportRow[]> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const sites = Array.from(memory.sites.values()).filter((s) => s.companyId === actor.companyId);
    const entries = Array.from(memory.entries.values());
    const diaries = Array.from(memory.diaries.values());
    return sites.map((site) => {
      const siteDiaries = diaries.filter((d) => d.siteId === site.id);
      return {
        siteId: site.id,
        name: site.name,
        client: site.client,
        status: site.status,
        ownerEmail: site.ownerEmail,
        entries: entries.filter((e) => e.siteId === site.id).length,
        diaries: siteDiaries.length,
        approvedDiaries: siteDiaries.filter((d) => d.status === "approved").length,
      };
    });
  }

  const result = await withTenant(actor, (client) =>
    client.query<{
      site_id: string;
      name: string;
      client: string;
      status: SiteStatus;
      owner_email: string;
      entries: string;
      diaries: string;
      approved_diaries: string;
    }>(`
      SELECT
        s.id AS site_id,
        s.name,
        s.client,
        s.status,
        s.owner_email,
        COUNT(DISTINCT e.id) AS entries,
        COUNT(DISTINCT d.id) AS diaries,
        COUNT(DISTINCT CASE WHEN d.status = 'approved' THEN d.id END) AS approved_diaries
      FROM project_sites s
      LEFT JOIN project_entries e ON e.site_id = s.id
      LEFT JOIN project_diaries d ON d.site_id = s.id
      WHERE s.company_id = $1
      GROUP BY s.id, s.name, s.client, s.status, s.owner_email
      ORDER BY s.created_at DESC
    `, [actor.companyId])
  );

  return result.rows.map((row) => ({
    siteId: row.site_id,
    name: row.name,
    client: row.client,
    status: row.status,
    ownerEmail: row.owner_email,
    entries: Number(row.entries),
    diaries: Number(row.diaries),
    approvedDiaries: Number(row.approved_diaries),
  }));
}

export async function deleteAllUserProjectData(email: string): Promise<void> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    for (const [id, site] of memory.sites.entries()) {
      if (site.ownerEmail === email) memory.sites.delete(id);
    }
    for (const [id, entry] of memory.entries.entries()) {
      if (entry.ownerEmail === email) memory.entries.delete(id);
    }
    for (const [id, diary] of memory.diaries.entries()) {
      if (diary.ownerEmail === email) memory.diaries.delete(id);
    }
    for (const [id, tmpl] of memory.templates.entries()) {
      if (tmpl.ownerEmail === email) memory.templates.delete(id);
    }
    await persistMemory();
    return;
  }
  // No Actor is available here (called by email during account deletion), so
  // derive the company to scope the tenant transaction — otherwise these
  // DELETEs run with no app.company_id set and RLS silently matches zero rows.
  const user = await findUserByEmail(email);
  const companyId = user?.companyId || soloCompanyIdForEmail(email);
  // DELIBERATE: this scopes deletion to the user's CURRENT company. Rows the user
  // authored under a *former* company (if they later switched) carry that old
  // company_id and are intentionally left untouched by RLS here — this is
  // by-design under the soft-cancel + 7-year record-retention model (see
  // CLAUDE.md §3), not a missed case. It only ever under-deletes the user's own
  // historical rows; it can never reach another tenant's data.
  await withTenant({ companyId }, async (client) => {
    // CASCADE constraints handle entries/diaries/templates automatically on site delete
    await client.query(`DELETE FROM project_sites WHERE owner_email = $1`, [email]);
    await client.query(`DELETE FROM project_entries WHERE owner_email = $1`, [email]);
    await client.query(`DELETE FROM project_diaries WHERE owner_email = $1`, [email]);
    await client.query(`DELETE FROM project_templates WHERE owner_email = $1`, [email]);
  });
}

export async function resetProjectStoreForTests() {
  if (useDatabase()) {
    await getPgPool().query(`DELETE FROM site_members`);
    await getPgPool().query(`DELETE FROM site_invites`);
    await getPgPool().query(`DELETE FROM project_diaries`);
    await getPgPool().query(`DELETE FROM project_entries`);
    await getPgPool().query(`DELETE FROM project_templates`);
    await getPgPool().query(`DELETE FROM project_sites`);
    return;
  }
  memory.sites.clear();
  memory.entries.clear();
  memory.diaries.clear();
  memory.templates.clear();
  memory.siteInvites.clear();
  memory.siteMembers.clear();
  store.resetForTests();
}

// ─── Templates ───────────────────────────────────────────────────────────────

function mapTemplate(row: {
  id: string;
  owner_email: string;
  company_id: string;
  site_id: string;
  name: string;
  weather: string;
  crew_count: string;
  notes_template: string;
  created_at: Date;
}): TemplateRecord {
  return {
    id: row.id,
    ownerEmail: row.owner_email,
    companyId: row.company_id,
    siteId: row.site_id,
    name: row.name,
    weather: row.weather,
    crewCount: row.crew_count,
    notesTemplate: row.notes_template,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listTemplates(actor: Actor, siteId?: string): Promise<TemplateRecord[]> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const memberSiteIds = new Set(
      Array.from(memory.siteMembers.values())
        .filter((m) => m.memberEmail === actor.email)
        .map((m) => m.siteId)
    );
    return Array.from(memory.templates.values())
      .filter((t) => canAccessRow(actor, t.companyId, t.ownerEmail, memberSiteIds, t.siteId))
      .filter((t) => (siteId ? t.siteId === siteId : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const params: unknown[] = [actor.companyId];
  const queryParts: string[] = [`company_id = $1`];
  if (isCrew(actor)) {
    params.push(actor.email);
    queryParts.push(
      `(owner_email = $${params.length} OR site_id IN (SELECT site_id FROM site_members WHERE member_email = $${params.length}))`
    );
  }
  if (siteId) {
    params.push(siteId);
    queryParts.push(`site_id = $${params.length}`);
  }
  const where = `WHERE ${queryParts.join(" AND ")}`;
  const result = await withTenant(actor, (client) =>
    client.query(`SELECT * FROM project_templates ${where} ORDER BY created_at DESC`, params)
  );
  return result.rows.map(mapTemplate);
}

export async function createTemplate(
  actor: Actor,
  payload: Pick<TemplateRecord, "siteId" | "name" | "weather" | "crewCount" | "notesTemplate">
): Promise<TemplateRecord> {
  const tmpl: TemplateRecord = {
    id: uuidv7(),
    ownerEmail: actor.email,
    companyId: actor.companyId,
    createdAt: new Date().toISOString(),
    ...payload,
  };
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    memory.templates.set(tmpl.id, tmpl);
    await persistMemory();
    return tmpl;
  }
  const result = await withTenant(actor, (client) =>
    client.query(
      `INSERT INTO project_templates (id, owner_email, company_id, site_id, name, weather, crew_count, notes_template)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [tmpl.id, actor.email, actor.companyId, tmpl.siteId, tmpl.name, tmpl.weather, tmpl.crewCount, tmpl.notesTemplate]
    )
  );
  return mapTemplate(result.rows[0]);
}

export async function updateTemplate(
  actor: Actor,
  templateId: string,
  patch: Partial<Pick<TemplateRecord, "name" | "weather" | "crewCount" | "notesTemplate">>
): Promise<TemplateRecord | null> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const current = memory.templates.get(templateId);
    if (!current || current.companyId !== actor.companyId) return null;
    if (isCrew(actor) && current.ownerEmail !== actor.email) return null;
    const updated = { ...current, ...patch };
    memory.templates.set(templateId, updated);
    await persistMemory();
    return updated;
  }
  return withTenant(actor, async (client) => {
    const existing = await client.query<{ owner_email: string; company_id: string }>(
      `SELECT owner_email, company_id FROM project_templates WHERE id = $1 LIMIT 1`,
      [templateId]
    );
    if (existing.rowCount === 0) return null;
    if (existing.rows[0].company_id !== actor.companyId) return null;
    if (isCrew(actor) && existing.rows[0].owner_email !== actor.email) return null;
    const result = await client.query(
      `UPDATE project_templates
       SET name = COALESCE($2, name),
           weather = COALESCE($3, weather),
           crew_count = COALESCE($4, crew_count),
           notes_template = COALESCE($5, notes_template)
       WHERE id = $1
       RETURNING *`,
      [templateId, patch.name ?? null, patch.weather ?? null, patch.crewCount ?? null, patch.notesTemplate ?? null]
    );
    if (result.rowCount === 0) return null;
    return mapTemplate(result.rows[0]);
  });
}

export async function deleteTemplate(actor: Actor, templateId: string): Promise<boolean> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const tmpl = memory.templates.get(templateId);
    if (!tmpl || tmpl.companyId !== actor.companyId) return false;
    if (isCrew(actor) && tmpl.ownerEmail !== actor.email) return false;
    memory.templates.delete(templateId);
    await persistMemory();
    return true;
  }
  return withTenant(actor, async (client) => {
    const existing = await client.query<{ owner_email: string; company_id: string }>(
      `SELECT owner_email, company_id FROM project_templates WHERE id = $1 LIMIT 1`,
      [templateId]
    );
    if (existing.rowCount === 0) return false;
    if (existing.rows[0].company_id !== actor.companyId) return false;
    if (isCrew(actor) && existing.rows[0].owner_email !== actor.email) return false;
    const result = await client.query(
      `DELETE FROM project_templates WHERE id = $1 AND company_id = $2`,
      [templateId, actor.companyId]
    );
    return (result.rowCount ?? 0) > 0;
  });
}

// ─── Site invites & members ───────────────────────────────────────────────────

function generateInviteToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

function mapInvite(row: {
  id: string; site_id: string | null; company_id: string | null;
  company_role: CompanyRole | null; invited_email: string; invited_by: string;
  role: string; token: string; expires_at: Date; created_at: Date;
}): SiteInviteRecord {
  return {
    id: row.id,
    siteId: row.site_id,
    companyId: row.company_id,
    companyRole: row.company_role,
    invitedEmail: row.invited_email,
    invitedBy: row.invited_by,
    role: row.role,
    token: row.token,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  };
}

async function canManageSite(actor: Actor, siteId: string): Promise<boolean> {
  // Managers and owners manage any site in their company; crew/viewer may only
  // manage a site they personally own. Cross-company access is always denied.
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const site = memory.sites.get(siteId);
    if (!site || site.companyId !== actor.companyId) return false;
    if (actor.companyRole === "owner" || actor.companyRole === "manager") return true;
    return site.ownerEmail === actor.email;
  }
  const r = await withTenant(actor, (client) =>
    client.query<{ owner_email: string; company_id: string }>(
      `SELECT owner_email, company_id FROM project_sites WHERE id = $1 LIMIT 1`,
      [siteId]
    )
  );
  const row = r.rows[0];
  if (!row || row.company_id !== actor.companyId) return false;
  if (actor.companyRole === "owner" || actor.companyRole === "manager") return true;
  return row.owner_email === actor.email;
}

// Sentinel returned when an invite requests the un-assignable 'owner' role.
export const INVITE_OWNER_REJECTED = "owner_role_not_assignable" as const;
// A non-owner tried to grant a company role above crew via a site invite.
export const INVITE_ROLE_TOO_HIGH = "invite_role_exceeds_inviter" as const;

export async function createSiteInvites(
  actor: Actor,
  siteId: string,
  emails: string[],
  role: string,
  companyRole?: CompanyRole
): Promise<InviteResult[] | null | typeof INVITE_OWNER_REJECTED | typeof INVITE_ROLE_TOO_HIGH> {
  // Owner is never assignable via invite — it is only acquired by founding a
  // company at signup or via explicit owner-to-owner promotion.
  if (companyRole === "owner") return INVITE_OWNER_REJECTED;
  if (!(await canManageSite(actor, siteId))) return null;

  await ensureMemoryLoaded();
  const results: InviteResult[] = [];
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  // Invites always carry the actor's company so acceptance can stamp membership.
  const inviteCompanyId = actor.companyId;
  const inviteCompanyRole: CompanyRole = companyRole ?? "crew";

  // Role ceiling (privilege-escalation fix): only an owner may grant an elevated
  // company role via a site invite. Any other inviter — a manager, or a crew/
  // viewer who happens to own the site (both pass canManageSite) — may bring
  // people in as crew ONLY. Without this, a site invite is a backdoor around the
  // owner-only company-member invite: e.g. a manager could mint a company-manager.
  if (actor.companyRole !== "owner" && inviteCompanyRole !== "crew") return INVITE_ROLE_TOO_HIGH;

  for (const email of emails) {
    const token = generateInviteToken();
    if (!useDatabase()) {
      const memberKey = `${siteId}:${email}`;
      if (memory.siteMembers.has(memberKey)) {
        results.push({ email, status: "already_member" });
        continue;
      }
      const existing = Array.from(memory.siteInvites.values()).find(
        (i) => i.siteId === siteId && i.invitedEmail === email
      );
      if (existing) {
        memory.siteInvites.delete(existing.token);
        const resent: SiteInviteRecord = {
          ...existing,
          companyId: inviteCompanyId,
          companyRole: inviteCompanyRole,
          token,
          expiresAt,
        };
        memory.siteInvites.set(token, resent);
        results.push({ email, status: "resent" });
      } else {
        const invite: SiteInviteRecord = {
          id: uuidv7(),
          siteId,
          companyId: inviteCompanyId,
          companyRole: inviteCompanyRole,
          invitedEmail: email,
          invitedBy: actor.email,
          role,
          token,
          expiresAt,
          createdAt: new Date().toISOString(),
        };
        memory.siteInvites.set(token, invite);
        results.push({ email, status: "sent" });
      }
    } else {
      const isMember = await withTenant(actor, (client) => client.query<{ exists: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM site_members WHERE site_id=$1 AND member_email=$2) AS exists`,
        [siteId, email]
      ));
      if (isMember.rows[0].exists) {
        results.push({ email, status: "already_member" });
        continue;
      }
      const upsert = await withTenant(actor, (client) => client.query(
        `INSERT INTO site_invites (id, site_id, company_id, company_role, invited_email, invited_by, role, token, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (site_id, invited_email) WHERE site_id IS NOT NULL DO UPDATE
           SET token=$8, expires_at=$9, role=$7, invited_by=$6,
               company_id=$3, company_role=$4
         RETURNING *, (xmax = 0) AS inserted`,
        [uuidv7(), siteId, inviteCompanyId, inviteCompanyRole, email, actor.email, role, token, expiresAt]
      ));
      const wasNew = (upsert as unknown as { rows: Array<{ xmax: string }> }).rows[0].xmax === "0";
      results.push({ email, status: wasNew ? "sent" : "resent" });
    }
  }

  if (!useDatabase()) await persistMemory();
  return results;
}

// Company-only invite (no site). Adds a user to the company with a company_role.
export async function createCompanyInvite(
  actor: Actor,
  email: string,
  companyRole: CompanyRole
): Promise<SiteInviteRecord | typeof INVITE_OWNER_REJECTED> {
  if (companyRole === "owner") return INVITE_OWNER_REJECTED;
  await ensureMemoryLoaded();
  const token = generateInviteToken();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const record: SiteInviteRecord = {
    id: uuidv7(),
    siteId: null,
    companyId: actor.companyId,
    companyRole,
    invitedEmail: email,
    invitedBy: actor.email,
    role: "worker",
    token,
    expiresAt,
    createdAt: new Date().toISOString(),
  };
  if (!useDatabase()) {
    // Replace any existing company invite for this email.
    for (const [t, inv] of memory.siteInvites.entries()) {
      if (inv.siteId === null && inv.companyId === actor.companyId && inv.invitedEmail === email) {
        memory.siteInvites.delete(t);
      }
    }
    memory.siteInvites.set(token, record);
    await persistMemory();
    return record;
  }
  const r = await withTenant(actor, (client) => client.query(
    `INSERT INTO site_invites (id, site_id, company_id, company_role, invited_email, invited_by, role, token, expires_at)
     VALUES ($1,NULL,$2,$3,$4,$5,'worker',$6,$7)
     ON CONFLICT (company_id, invited_email) WHERE company_id IS NOT NULL AND site_id IS NULL DO UPDATE
       SET token=$6, expires_at=$7, company_role=$3, invited_by=$5
     RETURNING *`,
    [record.id, actor.companyId, companyRole, email, actor.email, token, expiresAt]
  ));
  return mapInvite(r.rows[0]);
}

export async function listSiteInvites(
  actor: Actor,
  siteId: string
): Promise<SiteInviteRecord[] | null> {
  if (!(await canManageSite(actor, siteId))) return null;
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const now = new Date().toISOString();
    return Array.from(memory.siteInvites.values()).filter(
      (i) => i.siteId === siteId && i.expiresAt > now
    );
  }
  const r = await withTenant(actor, (client) => client.query(
    `SELECT * FROM site_invites WHERE site_id=$1 AND expires_at > NOW() ORDER BY created_at DESC`,
    [siteId]
  ));
  return r.rows.map(mapInvite);
}

export async function deleteSiteInvite(
  actor: Actor,
  siteId: string,
  inviteId: string
): Promise<boolean> {
  if (!(await canManageSite(actor, siteId))) return false;
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    for (const [token, invite] of memory.siteInvites.entries()) {
      if (invite.id === inviteId && invite.siteId === siteId) {
        memory.siteInvites.delete(token);
        await persistMemory();
        return true;
      }
    }
    return false;
  }
  const r = await withTenant(actor, (client) => client.query(
    `DELETE FROM site_invites WHERE id=$1 AND site_id=$2`,
    [inviteId, siteId]
  ));
  return (r.rowCount ?? 0) > 0;
}

export type AcceptInviteSuccess = {
  siteId: string | null;
  siteName: string | null;
  role: string;
  companyId: string | null;
  companyRole: CompanyRole | null;
};

export type AcceptInviteResult =
  | AcceptInviteSuccess
  | "expired"
  | "not_found"
  | "wrong_user"
  | "already_used"
  | "already_in_company";

// Applies the company side of an invite to the accepting user. Returns
// "already_in_company" if the user already belongs to a *different real* company.
// Solo companies (auto-created on registration) are treated as "no real company"
// and can be overridden when the user accepts an invite from a real company.
async function applyCompanyMembership(
  actorEmail: string,
  invite: { companyId: string | null; companyRole: CompanyRole | null }
): Promise<"ok" | "already_in_company"> {
  if (!invite.companyId) return "ok";
  const user = await findUserByEmail(actorEmail);
  const currentCompany = user?.companyId ?? "";
  const isSoloCompany = currentCompany === soloCompanyIdForEmail(actorEmail);
  if (currentCompany && !isSoloCompany && currentCompany !== invite.companyId) {
    return "already_in_company";
  }
  if (!currentCompany || currentCompany !== invite.companyId) {
    await setUserCompany(actorEmail, invite.companyId, invite.companyRole ?? "crew");
  }
  return "ok";
}

export async function acceptSiteInvite(
  actorEmail: string,
  token: string
): Promise<AcceptInviteResult> {
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const invite = memory.siteInvites.get(token);
    if (!invite) return "not_found";
    if (invite.invitedEmail !== actorEmail) return "wrong_user";
    if (new Date(invite.expiresAt) < new Date()) return "expired";

    // Cross-company guard BEFORE consuming the token — a different-company user
    // is rejected without burning the invite. Solo companies are treated as
    // "no real company" and can be overridden by an explicit company invite.
    if (invite.companyId) {
      const user = await findUserByEmail(actorEmail);
      const currentCompany = user?.companyId ?? "";
      const isSoloCompany = currentCompany === soloCompanyIdForEmail(actorEmail);
      if (currentCompany && !isSoloCompany && currentCompany !== invite.companyId) {
        return "already_in_company";
      }
    }

    // Atomic in the single-threaded JS sense: delete first, then apply.
    memory.siteInvites.delete(token);
    await applyCompanyMembership(actorEmail, invite);

    const siteId = invite.siteId;
    if (siteId) {
      const memberKey = `${siteId}:${actorEmail}`;
      if (!memory.siteMembers.has(memberKey)) {
        memory.siteMembers.set(memberKey, {
          siteId,
          memberEmail: actorEmail,
          role: invite.role,
          invitedBy: invite.invitedBy,
          joinedAt: new Date().toISOString(),
        });
      }
    }
    await persistMemory();
    const site = siteId ? memory.sites.get(siteId) : undefined;
    return {
      siteId: siteId,
      siteName: siteId ? site?.name ?? siteId : null,
      role: invite.role,
      companyId: invite.companyId,
      companyRole: invite.companyRole,
    };
  }

  const pool = getPgPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The accept is intentionally cross-company: the invite belongs to the
    // company being JOINED. Supply the invite token so the site_invites
    // company-OR-token RLS policy (migration 025) exposes exactly this one
    // invite row. SET LOCAL (is_local=true) — scoped to THIS transaction only,
    // never session-scoped, never leaking into other queries on this connection.
    await client.query("SELECT set_config('app.invite_token', $1, true)", [token]);
    // Peek at the invite first (without consuming) so a cross-company rejection
    // doesn't burn the token.
    const peek = await client.query<{
      invited_email: string; company_id: string | null; expires_at: Date;
    }>(`SELECT invited_email, company_id, expires_at FROM site_invites WHERE token=$1`, [token]);
    if (peek.rowCount && peek.rows[0].company_id) {
      if (peek.rows[0].invited_email === actorEmail) {
        const userRow = await client.query<{ company_id: string | null }>(
          `SELECT company_id FROM auth_users WHERE email=$1`,
          [actorEmail]
        );
        const currentCompany = userRow.rows[0]?.company_id ?? "";
        const isSoloCompany = currentCompany === soloCompanyIdForEmail(actorEmail);
        if (currentCompany && !isSoloCompany && currentCompany !== peek.rows[0].company_id) {
          await client.query("ROLLBACK");
          return "already_in_company";
        }
      }
    }

    // Atomically claim the token — DELETE RETURNING means only one concurrent
    // request can claim it; subsequent requests get 0 rows.
    const del = await client.query<{
      id: string; site_id: string | null; company_id: string | null;
      company_role: CompanyRole | null; invited_email: string; invited_by: string; role: string;
    }>(
      `DELETE FROM site_invites WHERE token=$1 AND expires_at > NOW() RETURNING *`,
      [token]
    );
    if (del.rowCount === 0) {
      const check = await client.query(`SELECT 1 FROM site_invites WHERE token=$1`, [token]);
      await client.query("ROLLBACK");
      return check.rowCount === 0 ? "not_found" : "expired";
    }
    const invite = del.rows[0];
    if (invite.invited_email !== actorEmail) {
      await client.query("ROLLBACK");
      return "wrong_user";
    }

    // Invite validated (token claimed atomically + invited_email matches). ONLY
    // NOW establish the tenant context of the company being JOINED, so the
    // site_members INSERT below satisfies WITH CHECK and the project_sites name
    // read isn't fail-closed. Setting app.company_id strictly AFTER validation
    // prevents a forged/mismatched token from steering the membership write into
    // another tenant.
    if (invite.company_id) {
      await client.query("SELECT set_config('app.company_id', $1, true)", [invite.company_id]);
    }

    // Stamp company membership within the same transaction (soft relationship).
    if (invite.company_id) {
      await client.query(
        `UPDATE auth_users
           SET company_id = $2, company_role = $3
         WHERE email = $1 AND (company_id IS NULL OR company_id = $2)`,
        [actorEmail, invite.company_id, invite.company_role ?? "crew"]
      );
    }

    let siteName: string | null = null;
    if (invite.site_id) {
      await client.query(
        `INSERT INTO site_members (site_id, member_email, role, invited_by, company_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT DO NOTHING`,
        [invite.site_id, actorEmail, invite.role, invite.invited_by, invite.company_id]
      );
      // Cross-company read: the site belongs to the invite's company, which may
      // differ from the accepter's current company; app.company_id was already
      // set to invite.company_id above (strictly after validation), so this
      // RLS-protected read is scoped to the site's company, not fail-closed.
      const siteRow = await client.query<{ name: string }>(
        `SELECT name FROM project_sites WHERE id=$1`,
        [invite.site_id]
      );
      siteName = siteRow.rows[0]?.name ?? invite.site_id;
    }

    await client.query("COMMIT");
    return {
      siteId: invite.site_id,
      siteName,
      role: invite.role,
      companyId: invite.company_id,
      companyRole: invite.company_role,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listSiteMembers(
  actor: Actor,
  siteId: string
): Promise<SiteMemberRecord[] | null> {
  if (!(await canManageSite(actor, siteId))) return null;
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    return Array.from(memory.siteMembers.values()).filter((m) => m.siteId === siteId);
  }
  const r = await withTenant(actor, (client) => client.query<{
    site_id: string; member_email: string; role: string; invited_by: string; joined_at: Date;
  }>(
    `SELECT * FROM site_members WHERE site_id=$1 ORDER BY joined_at ASC`,
    [siteId]
  ));
  return r.rows.map((row) => ({
    siteId: row.site_id,
    memberEmail: row.member_email,
    role: row.role,
    invitedBy: row.invited_by,
    joinedAt: row.joined_at.toISOString(),
  }));
}

export async function updateSiteProgress(actor: Actor, siteId: string, progressPercent: number): Promise<SiteRecord | null> {
  const pct = Math.max(0, Math.min(100, Math.round(progressPercent)));
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const existing = memory.sites.get(siteId);
    if (!existing || existing.companyId !== actor.companyId || existing.deletedAt) return null;
    if (isCrew(actor) && existing.ownerEmail !== actor.email) return null;
    const updated: SiteRecord = { ...existing, progressPercent: pct };
    memory.sites.set(siteId, updated);
    await persistMemory();
    return updated;
  }
  const result = await withTenant(actor, (client) =>
    client.query<SiteRow & { progress_percent: number }>(
      `UPDATE project_sites SET progress_percent = $2
       WHERE id = $1 AND company_id = $3 AND deleted_at IS NULL RETURNING *`,
      [siteId, pct, actor.companyId]
    )
  );
  if (result.rowCount === 0) return null;
  return mapSite(result.rows[0]);
}

export async function removeSiteMember(
  actor: Actor,
  siteId: string,
  memberEmail: string
): Promise<boolean> {
  if (!(await canManageSite(actor, siteId))) return false;
  if (!useDatabase()) {
    await ensureMemoryLoaded();
    const key = `${siteId}:${memberEmail}`;
    if (!memory.siteMembers.has(key)) return false;
    memory.siteMembers.delete(key);
    await persistMemory();
    return true;
  }
  const r = await withTenant(actor, (client) => client.query(
    `DELETE FROM site_members WHERE site_id=$1 AND member_email=$2`,
    [siteId, memberEmail]
  ));
  return (r.rowCount ?? 0) > 0;
}
