-- The bin: project_sites gains the soft-delete column the code already believed it had.
--
-- WHAT THIS IS FOR
-- Deleting a site is today a hard `DELETE FROM project_sites`, and nine child
-- tables reference it `ON DELETE CASCADE` — project_entries, project_diaries,
-- project_templates, site_members, site_invites, crew_timecards, incidents,
-- inspections and material_deliveries. So one click destroys every photograph,
-- diary, timesheet, incident and inspection ever recorded against that site,
-- INCLUDING the four tables that were deliberately given `deleted_at` because
-- their contents are compliance evidence. The soft delete on those four is
-- defeated by the hard delete on their parent.
--
-- This column is what lets a deletion be undone. A site with `deleted_at` set
-- cascades nothing, because nothing has been deleted — the row is still there.
--
-- AUDIT L99
-- `updateSiteProgress` carried `deleted_at IS NULL` against this table from
-- commit 1141657 onward, and the column did not exist, so every site-progress
-- update against Postgres failed with `column "deleted_at" does not exist` for
-- months. L99 fixed it by REMOVING the predicate, correctly, noting that
-- soft-delete for sites belonged to this phase. This is that phase. The
-- predicate comes back here only through storage/softDelete.ts, which derives it
-- from a declared table set that a test holds against this schema in both
-- directions.
--
-- ADDITIVE AND IDEMPOTENT, AND IT WRITES NOTHING TO AN EXISTING ROW
--   - ADD COLUMN IF NOT EXISTS, NULLABLE, no default
--   - one partial index, IF NOT EXISTS
-- Every existing site gets NULL, which means "live" — the state every site is
-- in today. No row is read, rewritten or moved. Reversing this migration is
-- dropping one nullable column and one index; no data is lost by the reversal
-- because nothing has written to the column at the moment it is applied.
--
-- NO ROW IS EVER REMOVED BY ANYTHING IN THIS MIGRATION, AND NOTHING SCHEDULED
-- The purge that eventually hard-deletes a binned site is
-- src/scripts/purge-deleted-rows.ts: hand-run, dry-run by default, not imported
-- by the server, not wired to boot and not scheduled. It has never been run.
--
-- storage/migrate.ts wraps this file in its own BEGIN/COMMIT.

-- ══ 1. The column ═════════════════════════════════════════════════════════════
-- TIMESTAMPTZ rather than a boolean: the bin has to say how long a site has been
-- in it, and the purge has to know what is older than the retention period.
-- A boolean cannot answer either question, and a site deleted today and one
-- deleted a year ago are not the same thing.
--
-- NULLABLE with no default is the whole design. NULL = live. Any default would
-- be a write to every existing row, which is what this migration must not do.
ALTER TABLE project_sites
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- ══ 2. One partial index ══════════════════════════════════════════════════════
-- Partial, on the deleted rows only. The bin listing is `WHERE deleted_at IS NOT
-- NULL`, which is the rare case — most companies have an empty bin — so a
-- partial index is small and stays small, and it costs nothing on the common
-- path because a live row is not in it.
--
-- Deliberately NOT an index for the live-row filter. `deleted_at IS NULL` will
-- match nearly every row in this table, so an index on it would be read past in
-- favour of a sequential scan; project_sites is also small (one row per
-- building site, not per record). If that ever stops being true the index to
-- add is a composite on (company_id) WHERE deleted_at IS NULL, not this one
-- widened.
CREATE INDEX IF NOT EXISTS project_sites_deleted_at_idx
  ON project_sites (deleted_at)
  WHERE deleted_at IS NOT NULL;
