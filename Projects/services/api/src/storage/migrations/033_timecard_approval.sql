-- Timecard approval: a status, who set it, when, and why.
--
-- WHAT THIS IS FOR
-- A timesheet today is a row a crew member writes and can rewrite for ever.
-- Nothing records that a manager has looked at it, so there is no point at
-- which the hours become payroll rather than a draft, and no way for a manager
-- to send a wrong one back. These four columns are that point.
--
-- WHAT THE STATUS MEANS
--   pending   — written, not yet reviewed. The crew member may still change it.
--   approved  — a manager has accepted the hours. NOBODY may change the row
--               while it says this, including the manager who approved it: to
--               correct an approved card a manager returns it to pending
--               first, which is itself a recorded action. An approval that can
--               be edited around is not an approval.
--   rejected  — a manager has sent it back. The crew member may change it
--               again, which is the whole point of the state existing; without
--               it a manager's only options are "approve" and "nothing", and a
--               wrong card stays wrong for ever.
--
-- WHY `approval_note`
-- A rejection the crew member cannot read is an instruction to guess. The note
-- is where the manager says what to fix, and it is kept across a later
-- approval rather than cleared, so the record of why it went back survives.
--
-- WHAT THIS IS NOT
-- It is not an access boundary. No row here is consulted when deciding who may
-- READ a timecard — that is `RECORD_CLASS.timesheet = "personal-record"` in
-- storage/recordScope.ts, unchanged by this migration: crew read only their
-- own, managers read the company's. Approval decides who may CHANGE a row, and
-- only via the state machine in storage/crewStore.ts.
--
-- ADDITIVE AND IDEMPOTENT
--   - ADD COLUMN IF NOT EXISTS, four times
--   - one partial index, IF NOT EXISTS
-- No column is dropped, renamed or retyped, and no existing value is rewritten.
--
-- WHAT IT DOES TO EXISTING ROWS
-- Every existing timecard gets `approval_status = 'pending'` and NULL for the
-- other three. That is not an assumption about the data: no timecard has ever
-- been approved, because until this migration there was nothing to approve
-- with. `pending` is the true state of every row in the table.
--
-- NOT NULL WITH A DEFAULT, deliberately, rather than a nullable column: a NULL
-- status would be a fourth state meaning "pending, probably", and every
-- predicate would then have to spell `IS NULL OR = 'pending'`. One of those
-- predicates would eventually be written without the NULL half, and an
-- unapproved card would read as editable to one query and locked to another.
-- Postgres 11+ applies a non-volatile default without rewriting the table.
--
-- Reversing this migration is dropping four columns and one index.
--
-- crew_timecards is FORCE ROW LEVEL SECURITY (025); ADD COLUMN is unaffected
-- by RLS, and this migration adds no policy because the existing
-- company_id policy already covers every row and every new column.
--
-- storage/migrate.ts wraps this file in its own BEGIN/COMMIT.

-- ══ 1. The status ═════════════════════════════════════════════════════════════
-- The CHECK is the authority on the value set. storage/crewStore.ts exports
-- TIMECARD_APPROVAL_STATUSES and the route schema is built from it, so the
-- three spellings exist once in TypeScript and once here; the DB-gated suite
-- asserts the two agree by writing every status in the exported list and by
-- proving the database refuses one outside it.
ALTER TABLE crew_timecards
  ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (approval_status IN ('pending', 'approved', 'rejected'));

-- ══ 2. Who, when, and why ═════════════════════════════════════════════════════
-- `approved_by` is the reviewer's address, not the author's. ON DELETE SET NULL
-- and NOT CASCADE, deliberately: removing a manager from the company must never
-- delete a payroll row they once approved. The row keeps the status and loses
-- only the name, which is the lesser of the two wrongs — and `approved_at`
-- stays, so "approved, by someone no longer here" remains a readable fact.
ALTER TABLE crew_timecards
  ADD COLUMN IF NOT EXISTS approved_by TEXT REFERENCES auth_users(email) ON DELETE SET NULL;

ALTER TABLE crew_timecards
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE crew_timecards
  ADD COLUMN IF NOT EXISTS approval_note TEXT;

-- ══ 3. The one index ══════════════════════════════════════════════════════════
-- Partial, on the status a manager actually queries for. "Show me what needs
-- approving" is the only read this adds; an approved card is read through the
-- existing site and owner indexes alongside everything else on the site.
CREATE INDEX IF NOT EXISTS idx_crew_timecards_pending
  ON crew_timecards (company_id, site_id)
  WHERE approval_status = 'pending' AND deleted_at IS NULL;
