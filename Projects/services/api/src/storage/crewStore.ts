import { v4 as uuidv4 } from "uuid";
import { Actor } from "./actor";
import { canEditRow, canReadRow, editOwnershipSql, readVisibilitySql } from "./recordScope";
import { withTenant } from "./tenant";
import { liveOnly, softDeleteAssignment } from "./softDelete";

/**
 * The table and the approval columns, named once.
 *
 * Every predicate below builds its SQL from these rather than from a quoted
 * literal. The reason is a real defect, not tidiness: a hand-written
 * `deleted_at` literal in a predicate against a table that had no such column
 * meant site progress had never once worked in production, and nothing failed
 * — the query simply matched nothing. A constant that is wrong is wrong in one
 * place and wrong everywhere at once, which is the failure mode you find.
 */
export const TIMECARDS_TABLE = "crew_timecards";
export const TIMECARD_APPROVAL_STATUS_COLUMN = "approval_status";
export const TIMECARD_APPROVED_BY_COLUMN = "approved_by";
export const TIMECARD_APPROVED_AT_COLUMN = "approved_at";
export const TIMECARD_APPROVAL_NOTE_COLUMN = "approval_note";

/**
 * The three approval states, as a closed list.
 *
 * This array is the single TypeScript definition: `TimecardApprovalStatus` is
 * derived from it, routes/crew.ts builds its zod enum from it, and the DB-gated
 * suite writes every member of it so that a status added here without being
 * added to migration 033's CHECK constraint fails against Postgres instead of
 * 500ing in production. The two definitions (here and the CHECK) cannot be
 * collapsed into one — the database has to hold its own — so the test is what
 * holds them together.
 */
export const TIMECARD_APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type TimecardApprovalStatus = (typeof TIMECARD_APPROVAL_STATUSES)[number];

/**
 * The state a timecard must be in for its author to change it.
 *
 * `approved` is absent, and that absence is the whole feature: an approved
 * timecard is payroll, and a payroll row anybody can still edit was never
 * approved in any useful sense. A manager wanting to correct one returns it to
 * `pending` through setTimecardApproval first, which records who reopened it.
 */
export const TIMECARD_EDITABLE_STATUSES: readonly TimecardApprovalStatus[] = Object.freeze([
  "pending",
  "rejected",
]);

export function isTimecardEditable(status: TimecardApprovalStatus): boolean {
  return TIMECARD_EDITABLE_STATUSES.includes(status);
}

/**
 * What a write attempt did, rather than a boolean.
 *
 * A boolean cannot distinguish "there is no such row" from "the row is there
 * and locked", and those need different HTTP codes: 404 for the first, 409 for
 * the second. Returning false for both is how an approved timecard would have
 * reported itself as missing to the person looking straight at it.
 */
export type TimecardWriteResult =
  | { ok: true; timecard: TimecardRecord }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "locked"; status: TimecardApprovalStatus };

/**
 * The fields the author of a timecard may change. Closed, and deliberately so.
 *
 * EVERY ONE OF THEM IS OPTIONAL, AND THAT IS THE POINT
 * An edit changes the fields it was given and leaves the rest of the row alone.
 * The first version of this type had `workerName`, `date`, `trade` and `notes`
 * required, and the route's schema gave `trade` and `notes` a `.default("")` —
 * so a PATCH that corrected only the finish time arrived carrying
 * `trade: ""`, `notes: ""` and `breakMinutes: 0`, and the UPDATE wrote all nine
 * columns. Correcting one field erased three others. On a seven-year compliance
 * record that is data loss performed by the save button.
 *
 * `undefined` therefore means "not mentioned, leave it", and it is the only
 * thing it can mean: there is no way to CLEAR a start or finish time through an
 * edit, because the route's schema has no null for them. That is a deliberate
 * limit rather than an oversight — see the trio rule on TimecardUpdateSchema in
 * routes/crew.ts, which keeps start, finish and break moving together so the
 * server never has to validate half a span against a stored half.
 */
export type TimecardEditableFields = {
  workerName?: string;
  date?: string;
  startTime?: string;
  endTime?: string;
  breakMinutes?: number;
  hoursRegular?: number;
  hoursOvertime?: number;
  trade?: string;
  notes?: string;
};

/**
 * The columns an edit writes, paired with how to read each one off the payload.
 *
 * Spelled out as a list rather than derived from the payload's own keys,
 * because deriving it is exactly the mistake that would let an approval field
 * through: `SET ... FROM Object.keys(payload)` writes whatever the caller sent
 * once a schema stops rejecting the extra key. No approval column appears
 * here, and adding one would have to be a deliberate edit to this list.
 */
const EDITABLE_COLUMNS: ReadonlyArray<{
  column: string;
  field: keyof TimecardEditableFields;
  read: (f: TimecardEditableFields) => unknown;
}> = Object.freeze([
  { column: "worker_name", field: "workerName", read: (f) => f.workerName },
  { column: "date", field: "date", read: (f) => f.date },
  { column: "start_time", field: "startTime", read: (f) => f.startTime ?? null },
  { column: "end_time", field: "endTime", read: (f) => f.endTime ?? null },
  { column: "break_minutes", field: "breakMinutes", read: (f) => f.breakMinutes ?? null },
  { column: "hours_regular", field: "hoursRegular", read: (f) => f.hoursRegular },
  { column: "hours_overtime", field: "hoursOvertime", read: (f) => f.hoursOvertime },
  { column: "trade", field: "trade", read: (f) => f.trade || null },
  { column: "notes", field: "notes", read: (f) => f.notes || null },
]);

/**
 * The entries of EDITABLE_COLUMNS the caller actually supplied.
 *
 * `field` carries the presence test and `read` the coercion, and the two are
 * separate because they answer different questions: whether to write the column
 * at all, and what to write when a blank string or an absent optional should
 * land as SQL NULL. Deriving either from the payload's own keys is the mistake
 * the header above EDITABLE_COLUMNS describes.
 */
function suppliedColumns(fields: TimecardEditableFields) {
  return EDITABLE_COLUMNS.filter((c) => fields[c.field] !== undefined);
}

/**
 * The supplied fields, as a patch for an in-memory record.
 *
 * Not `{ ...existing, ...fields }`. A spread copies a key that is present and
 * holding `undefined` — which zod can produce for an optional key — and would
 * then set `trade: undefined` on a row whose trade the caller never mentioned.
 * That is the in-memory half of the same erasure the SQL half avoids by
 * filtering the column list, and the two paths have to agree: seven defects
 * have hidden in the gap between this store's two halves.
 */
function suppliedPatch(fields: TimecardEditableFields): Partial<TimecardRecord> {
  const patch: Partial<TimecardRecord> = {};
  for (const { field } of suppliedColumns(fields)) {
    Object.assign(patch, { [field]: fields[field] });
  }
  return patch;
}

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
  /**
   * Never optional. A NULL or absent status would be a fourth state meaning
   * "pending, probably", and the first predicate written without the
   * `?? "pending"` half would disagree with every other one about whether the
   * row is editable. Migration 033 makes the column NOT NULL DEFAULT 'pending'
   * for the same reason, and mapRow defaults it so that a row read back from a
   * database that has somehow not applied 033 is treated as pending rather
   * than as undefined.
   */
  approvalStatus: TimecardApprovalStatus;
  approvedBy?: string | null;
  approvedAt?: string | null;
  approvalNote?: string | null;
};

function useDatabase() {
  return Boolean(process.env.DATABASE_URL && process.env.DATABASE_URL.trim());
}

// A timesheet is the named exception: RECORD_CLASS calls it `personal-record`,
// so crew read and write only their own while a manager sees everyone's. The
// clause that used to live here ORed in `site_members`, which meant a crew
// member on a shared site could read a colleague's hours — pay information,
// disclosed by a clause written for site assignment. AUDIT L90.

const memoryTimecards = new Map<string, TimecardRecord>();

function mapRow(row: {
  id: string; owner_email: string; company_id: string; site_id: string; entry_id: string | null;
  worker_name: string; date: string;
  start_time?: string | null; end_time?: string | null; break_minutes?: number | null;
  hours_regular: number; hours_overtime: number;
  trade: string | null; notes: string | null; created_at: Date;
  updated_at?: Date | null; deleted_at?: Date | null;
  approval_status?: string | null; approved_by?: string | null;
  approved_at?: Date | null; approval_note?: string | null;
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
    // Defaulted, not asserted. `SELECT *` against a database that has not
    // applied 033 yet returns no such key, and the honest reading of a row
    // with no approval column is that nobody has approved it — not undefined,
    // which would make `isTimecardEditable` throw on an older database during
    // the window between the API deploying and the migration finishing.
    approvalStatus: normaliseApprovalStatus(row.approval_status),
    approvedBy: row.approved_by ?? null,
    approvedAt: row.approved_at ? row.approved_at.toISOString() : null,
    approvalNote: row.approval_note ?? null,
  };
}

/**
 * A stored status string, narrowed to the closed list.
 *
 * Falls back to `pending` rather than throwing. A value outside the list can
 * only arrive from a database whose CHECK constraint disagrees with
 * TIMECARD_APPROVAL_STATUSES, and failing the read of an entire week of
 * timesheets is a worse answer to that than treating one unrecognised row as
 * unreviewed — which is also the safe direction, because `pending` is the
 * state that grants no lock and claims no approval.
 */
function normaliseApprovalStatus(value: unknown): TimecardApprovalStatus {
  return TIMECARD_APPROVAL_STATUSES.includes(value as TimecardApprovalStatus)
    ? (value as TimecardApprovalStatus)
    : "pending";
}

export async function listTimecards(actor: Actor, siteId?: string): Promise<TimecardRecord[]> {
  if (!useDatabase()) {
    return Array.from(memoryTimecards.values())
      .filter((t) => canReadRow(actor, "timesheet", t))
      .filter((t) => !t.deletedAt)
      .filter((t) => (siteId ? t.siteId === siteId : true))
      .sort((a, b) => b.date.localeCompare(a.date));
  }
  const params: unknown[] = [actor.companyId];
  const conditions = [liveOnly(TIMECARDS_TABLE), `company_id = $1`];
  const visibility = readVisibilitySql(actor, "timesheet", params);
  if (visibility) conditions.push(visibility);
  if (siteId) { params.push(siteId); conditions.push(`site_id = $${params.length}`); }
  const result = await withTenant(actor, (client) => client.query(
    `SELECT * FROM ${TIMECARDS_TABLE} WHERE ${conditions.join(" AND ")} ORDER BY date DESC`,
    params
  ));
  return result.rows.map(mapRow);
}

/**
 * The approval fields are omitted from the payload, not defaulted from it.
 *
 * A caller cannot create an already-approved timecard, which is the same gate
 * as the one on editing and matters for the same reason: `owner_email` is set
 * from the actor and never from the body, and `approval_status` is set from
 * this literal and never from the body. Both are claims a request must not be
 * able to make about itself.
 */
export async function createTimecard(
  actor: Actor,
  payload: Omit<
    TimecardRecord,
    | "id" | "ownerEmail" | "companyId" | "createdAt" | "updatedAt" | "deletedAt"
    | "approvalStatus" | "approvedBy" | "approvedAt" | "approvalNote"
  >
): Promise<TimecardRecord> {
  const record: TimecardRecord = {
    id: uuidv4(),
    ownerEmail: actor.email,
    companyId: actor.companyId,
    createdAt: new Date().toISOString(),
    ...payload,
    approvalStatus: "pending",
    approvedBy: null,
    approvedAt: null,
    approvalNote: null,
  };
  if (!useDatabase()) { memoryTimecards.set(record.id, record); return record; }
  const result = await withTenant(actor, (client) => client.query(
    `INSERT INTO ${TIMECARDS_TABLE} (id,owner_email,company_id,site_id,entry_id,worker_name,date,start_time,end_time,break_minutes,hours_regular,hours_overtime,trade,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [record.id, actor.email, actor.companyId, record.siteId, record.entryId ?? null, record.workerName, record.date,
     record.startTime ?? null, record.endTime ?? null, record.breakMinutes ?? null,
     record.hoursRegular, record.hoursOvertime, record.trade || null, record.notes || null]
  ));
  return mapRow(result.rows[0]);
}

/**
 * Change a timecard's hours. The author only, and only while it is unapproved.
 *
 * A PARTIAL UPDATE. Only the fields the caller supplied are written; every
 * other column keeps the value it had. See TimecardEditableFields for the
 * defect that shape exists to prevent, and note that both halves of this
 * function have to implement it — the SQL half by narrowing the column list,
 * the in-memory half by patching rather than spreading the payload.
 *
 * TWO REFUSALS, TWO CODES
 * `not-found` is "no such row you may touch", which the route answers 404 —
 * the same answer every other store gives, so a row in another company stays
 * indistinguishable from one that is not there. `locked` is "the row is right
 * there and approved", which the route answers 409: the person is looking at
 * the record, so pretending it is missing would read as a bug rather than as a
 * refusal, and 403 would be a lie about whose permission is lacking. Nobody's
 * rank opens an approved row.
 *
 * WHY THE POSTGRES PATH READS BEFORE IT WRITES
 * It needs to tell those two refusals apart, and a single UPDATE with the
 * status in its WHERE clause cannot: zero rows affected means either. The
 * SELECT is `FOR UPDATE` and `withTenant` has already opened a transaction, so
 * the status cannot change between the check and the write — without the row
 * lock, a manager approving at the same moment as an author saving would let
 * the save land on an approved row.
 */
export async function updateTimecard(
  actor: Actor,
  id: string,
  fields: TimecardEditableFields
): Promise<TimecardWriteResult> {
  if (!useDatabase()) {
    const existing = memoryTimecards.get(id);
    if (!existing || existing.deletedAt) return { ok: false, reason: "not-found" };
    if (!canEditRow(actor, "timesheet", existing)) return { ok: false, reason: "not-found" };
    if (!isTimecardEditable(existing.approvalStatus)) {
      return { ok: false, reason: "locked", status: existing.approvalStatus };
    }
    const patch = suppliedPatch(fields);
    // Nothing to change is not an error and not a write: the row is returned
    // as it stands, with its updatedAt untouched, so an empty edit cannot
    // rewrite the audit timestamp of a record nobody changed. The route
    // refuses an empty payload out loud before it gets here; this is the
    // second layer, and it is also what stops the SQL half emitting an UPDATE
    // with no assignments.
    if (Object.keys(patch).length === 0) return { ok: true, timecard: existing };
    const updated: TimecardRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    memoryTimecards.set(id, updated);
    return { ok: true, timecard: updated };
  }

  return withTenant(actor, async (client) => {
    const selectParams: unknown[] = [id, actor.companyId];
    const selectConditions = ["id = $1", "company_id = $2", liveOnly(TIMECARDS_TABLE)];
    const ownership = editOwnershipSql(actor, "timesheet", selectParams);
    if (ownership) selectConditions.push(ownership);
    // The whole row rather than the status column alone, so that an edit which
    // turns out to change nothing can be answered from the locked row without a
    // second query — and without an UPDATE.
    const current = await client.query(
      `SELECT * FROM ${TIMECARDS_TABLE}` +
        ` WHERE ${selectConditions.join(" AND ")} FOR UPDATE`,
      selectParams
    );
    if (current.rowCount === 0) return { ok: false, reason: "not-found" } as const;
    const status = normaliseApprovalStatus(
      (current.rows[0] as Record<string, unknown>)[TIMECARD_APPROVAL_STATUS_COLUMN]
    );
    if (!isTimecardEditable(status)) return { ok: false, reason: "locked", status } as const;

    // Built from EDITABLE_COLUMNS, so the set of writable columns is the list
    // above and not whatever keys the caller happened to send — and narrowed to
    // the ones the caller DID send, so an unmentioned column keeps its value.
    const writable = suppliedColumns(fields);
    if (writable.length === 0) return { ok: true, timecard: mapRow(current.rows[0]) } as const;
    const updateParams: unknown[] = [id, actor.companyId];
    const assignments = writable.map((c) => {
      updateParams.push(c.read(fields));
      return `${c.column} = $${updateParams.length}`;
    });
    const result = await client.query(
      `UPDATE ${TIMECARDS_TABLE} SET ${assignments.join(", ")}, updated_at = NOW()` +
        ` WHERE id = $1 AND company_id = $2 RETURNING *`,
      updateParams
    );
    // The FOR UPDATE above already proved the row is there and editable, so
    // zero rows here is not a refusal — it is an impossible state, and
    // returning not-found would file it as an ordinary 404 nobody looks at.
    if (result.rowCount === 0) {
      throw new Error(`updateTimecard: row ${id} vanished between the lock and the write`);
    }
    return { ok: true, timecard: mapRow(result.rows[0]) } as const;
  });
}

/**
 * Approve a timecard, send it back, or reopen one that was approved.
 *
 * THE RANK GATE IS NOT HERE, AND THAT IS DELIBERATE
 * `requireAtLeast("manager")` on the route is what stops a crew member calling
 * this at all — rank gates live on routes in this service, not in stores (see
 * storage/recordScope.ts's header). What this function enforces is the part a
 * rank gate cannot: that the approval columns are only ever written from here,
 * with the reviewer taken from `actor.email` and never from a request body.
 *
 * `approvalNote` is kept when the caller sends nothing, rather than cleared. A
 * manager approving a card they previously rejected should not erase the
 * reason it went back; that note is the only record of the correction.
 */
export async function setTimecardApproval(
  actor: Actor,
  id: string,
  status: TimecardApprovalStatus,
  note?: string
): Promise<TimecardWriteResult> {
  // Approving records a reviewer and a time; returning a card to `pending`
  // clears both, because a pending card has not been reviewed and leaving the
  // old reviewer's name on it would claim otherwise. A rejection keeps them:
  // somebody did review it, and who sent it back is the useful fact.
  const clearsReview = status === "pending";
  const reviewer = clearsReview ? null : actor.email;

  if (!useDatabase()) {
    const existing = memoryTimecards.get(id);
    if (!existing || existing.deletedAt) return { ok: false, reason: "not-found" };
    if (existing.companyId !== actor.companyId) return { ok: false, reason: "not-found" };
    const updated: TimecardRecord = {
      ...existing,
      approvalStatus: status,
      approvedBy: reviewer,
      approvedAt: clearsReview ? null : new Date().toISOString(),
      approvalNote: note !== undefined ? note : (existing.approvalNote ?? null),
      updatedAt: new Date().toISOString(),
    };
    memoryTimecards.set(id, updated);
    return { ok: true, timecard: updated };
  }

  const params: unknown[] = [id, actor.companyId, status, reviewer];
  // COALESCE keeps the stored note when none is supplied. Passing the old value
  // back in from a prior read would reopen the race this avoids.
  if (note !== undefined) params.push(note);
  const noteAssignment =
    note !== undefined
      ? `${TIMECARD_APPROVAL_NOTE_COLUMN} = $${params.length}`
      : `${TIMECARD_APPROVAL_NOTE_COLUMN} = ${TIMECARD_APPROVAL_NOTE_COLUMN}`;
  const result = await withTenant(actor, (client) => client.query(
    `UPDATE ${TIMECARDS_TABLE} SET ${TIMECARD_APPROVAL_STATUS_COLUMN} = $3,` +
      ` ${TIMECARD_APPROVED_BY_COLUMN} = $4,` +
      ` ${TIMECARD_APPROVED_AT_COLUMN} = ${clearsReview ? "NULL" : "NOW()"},` +
      ` ${noteAssignment}, updated_at = NOW()` +
      ` WHERE id = $1 AND company_id = $2 AND ${liveOnly(TIMECARDS_TABLE)} RETURNING *`,
    params
  ));
  if (result.rowCount === 0) return { ok: false, reason: "not-found" };
  return { ok: true, timecard: mapRow(result.rows[0]) };
}

/**
 * Remove a timecard. The author only, and only while it is unapproved.
 *
 * Deleting an approved card is refused for the same reason editing one is, and
 * it is the more important of the two: an edit leaves a row somebody can look
 * at and query, and a delete leaves nothing. An approved timesheet is the
 * record that someone was paid for those hours. A manager who needs it gone
 * returns it to `pending` first, which records that they did.
 *
 * Returns the same three-way result as updateTimecard rather than a boolean,
 * so the route can answer 409 for a locked row and keep 404 for a row the
 * actor may not touch. The soft delete itself is unchanged — `deleted_at`, not
 * a DELETE — because this is a compliance product and nothing here removes a
 * row from the table.
 */
export async function deleteTimecard(actor: Actor, id: string): Promise<TimecardWriteResult> {
  if (!useDatabase()) {
    const existing = memoryTimecards.get(id);
    if (!existing || existing.deletedAt) return { ok: false, reason: "not-found" };
    if (!canEditRow(actor, "timesheet", existing)) return { ok: false, reason: "not-found" };
    if (!isTimecardEditable(existing.approvalStatus)) {
      return { ok: false, reason: "locked", status: existing.approvalStatus };
    }
    const removed: TimecardRecord = { ...existing, deletedAt: new Date().toISOString() };
    memoryTimecards.set(id, removed);
    return { ok: true, timecard: removed };
  }

  return withTenant(actor, async (client) => {
    const selectParams: unknown[] = [id, actor.companyId];
    const selectConditions = ["id = $1", "company_id = $2", liveOnly(TIMECARDS_TABLE)];
    const ownership = editOwnershipSql(actor, "timesheet", selectParams);
    if (ownership) selectConditions.push(ownership);
    const current = await client.query<{ approval_status: string | null }>(
      `SELECT ${TIMECARD_APPROVAL_STATUS_COLUMN} FROM ${TIMECARDS_TABLE}` +
        ` WHERE ${selectConditions.join(" AND ")} FOR UPDATE`,
      selectParams
    );
    if (current.rowCount === 0) return { ok: false, reason: "not-found" } as const;
    const status = normaliseApprovalStatus(current.rows[0].approval_status);
    if (!isTimecardEditable(status)) return { ok: false, reason: "locked", status } as const;

    const result = await client.query(
      `UPDATE ${TIMECARDS_TABLE} SET ${softDeleteAssignment(TIMECARDS_TABLE)}, updated_at = NOW()` +
        ` WHERE id = $1 AND company_id = $2 RETURNING *`,
      [id, actor.companyId]
    );
    if (result.rowCount === 0) {
      throw new Error(`deleteTimecard: row ${id} vanished between the lock and the write`);
    }
    return { ok: true, timecard: mapRow(result.rows[0]) } as const;
  });
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
      `SELECT owner_email, company_id FROM ${TIMECARDS_TABLE}` +
        ` WHERE id = $1 AND company_id = $2 AND ${liveOnly(TIMECARDS_TABLE)} LIMIT 1`,
      [id, actor.companyId]
    )
  );
  if (result.rowCount === 0) return null;
  return { companyId: result.rows[0].company_id, ownerEmail: result.rows[0].owner_email };
}
