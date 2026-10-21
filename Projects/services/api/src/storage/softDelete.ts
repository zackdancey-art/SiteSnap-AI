/**
 * The soft-deletable tables, named once, and the predicates derived from them.
 *
 * WHY THIS FILE EXISTS
 * `updateSiteProgress` carried a hand-written `deleted_at IS NULL` against
 * `project_sites`, a table with no such column. Every progress update against
 * Postgres failed with `column "deleted_at" does not exist` from the commit that
 * introduced it until AUDIT L99 found it — months in which site progress had
 * never once worked in production. Nothing caught it because the in-memory
 * suite never executes that statement and the literal reads correct: four other
 * tables do have the column, so the line looks like the lines around it.
 *
 * A comment saying "check the column exists" would not have prevented it. The
 * only thing that prevents it is making the wrong version impossible to write,
 * so:
 *
 *   - the set of soft-deletable tables is declared ONCE, here, as a const
 *     tuple, and `SoftDeletableTable` is derived from it;
 *   - every predicate helper takes a `SoftDeletableTable`, so
 *     `liveOnly("project_entries")` is a COMPILE error, not a runtime surprise;
 *   - the column name appears exactly once in the API source outside the
 *     migrations, as SOFT_DELETE_COLUMN below;
 *   - `softDelete.schema.test.ts` parses the migration files and asserts this
 *     set equals the set of tables that actually have the column, in BOTH
 *     directions — a table listed here without the column fails, and a table
 *     with the column missing from here fails too;
 *   - `.eslintrc.js` bans the string `deleted_at` in any API source file except
 *     this one and the tests that assert against it, so the next hand-written
 *     literal fails lint rather than passing review.
 *
 * WHAT IS DELIBERATELY NOT IN THE SET
 * `project_entries`, `project_diaries` and `project_templates` are HARD
 * deleted, and that is unchanged by this file. They are listed in
 * HARD_DELETED_CHILD_TABLES below, with the reason, because the thing that
 * makes a mistake here invisible is a reader not knowing whether an omission
 * was a decision or an oversight.
 */

/**
 * The column. One occurrence, so a rename is one edit and a typo is one failure
 * rather than thirty.
 *
 * It is `TIMESTAMPTZ NULL` on every table in the set: NULL means live, a
 * timestamp means in the bin since that moment. Not a boolean — the purge needs
 * to know how long a row has been deleted, and a boolean cannot say.
 */
export const SOFT_DELETE_COLUMN = "deleted_at" as const;

/**
 * Every table that carries SOFT_DELETE_COLUMN.
 *
 * The first four have had it since their CREATE TABLE (migrations 009 and 010)
 * because they hold compliance records: an incident, a timesheet, an inspection
 * and a delivery are evidence, and evidence that a user can erase is not
 * evidence. `project_sites` joins them in migration 034 — see the bin.
 *
 * Order is alphabetical and carries no meaning. Adding a table here without
 * adding the column fails `softDelete.schema.test.ts`; adding the column
 * without adding it here fails the same test from the other side.
 */
export const SOFT_DELETABLE_TABLES = [
  "crew_timecards",
  "incidents",
  "inspections",
  "material_deliveries",
  "project_sites",
] as const;

export type SoftDeletableTable = (typeof SOFT_DELETABLE_TABLES)[number];

/**
 * Tables that are hard deleted, and why — so that an omission from
 * SOFT_DELETABLE_TABLES is readable as a decision.
 *
 * All of these cascade from `project_sites` via `ON DELETE CASCADE`, which is
 * the fact that makes the bin worth building: before it, deleting a site hard
 * deleted every entry, diary, template, timecard, incident, inspection and
 * delivery on that site — defeating the soft delete on the four tables that
 * have it. A site in the bin cascades nothing, because nothing is deleted yet.
 */
export const HARD_DELETED_CHILD_TABLES: Readonly<Record<string, string>> = Object.freeze({
  project_entries:
    "the record itself; deleted only with its site, and retained while the site is in the bin",
  project_diaries: "derived from entries; regenerable, and retained with the site",
  project_templates: "configuration, not a record",
  site_members: "an access grant, not a record; meaningless once the site is gone",
  site_invites: "an access grant, not a record",
  inspection_signatures: "child of `inspections`, which is itself soft-deletable",
});

const isSoftDeletable = (table: string): table is SoftDeletableTable =>
  (SOFT_DELETABLE_TABLES as readonly string[]).includes(table);

/**
 * Throws for a table that is not in the set.
 *
 * The type parameter already makes the wrong call a compile error, so this is
 * for the one caller the compiler cannot help: a table name that arrives as a
 * `string` at runtime (the purge reads its target list from the registry, but a
 * future caller might not). Belt and braces, deliberately, because the failure
 * this guards against was silent for months.
 */
export function assertSoftDeletable(table: string): SoftDeletableTable {
  if (!isSoftDeletable(table)) {
    throw new Error(
      `${table} is not soft-deletable. Tables with ${SOFT_DELETE_COLUMN}: ` +
        `${SOFT_DELETABLE_TABLES.join(", ")}. Adding one means a migration AND an ` +
        `entry in SOFT_DELETABLE_TABLES in storage/softDelete.ts.`
    );
  }
  return table;
}

/**
 * `deleted_at IS NULL` — the predicate for "not in the bin".
 *
 * Takes the table purely so that it cannot be used against a table without the
 * column. The returned string does not name the table (the column is unique in
 * every statement it appears in), but requiring the argument is what makes the
 * type check load-bearing rather than decorative.
 */
export function liveOnly(table: SoftDeletableTable): string {
  assertSoftDeletable(table);
  return `${SOFT_DELETE_COLUMN} IS NULL`;
}

/** `deleted_at IS NOT NULL` — the predicate for "in the bin", for bin listings. */
export function deletedOnly(table: SoftDeletableTable): string {
  assertSoftDeletable(table);
  return `${SOFT_DELETE_COLUMN} IS NOT NULL`;
}

/**
 * `deleted_at = NOW()` — the assignment that puts a row in the bin.
 *
 * `NOW()` is the transaction start time, which is what we want: every row
 * soft-deleted by one statement shares a timestamp, so a bin listing groups
 * them and the purge treats them as one act.
 */
export function softDeleteAssignment(table: SoftDeletableTable): string {
  assertSoftDeletable(table);
  return `${SOFT_DELETE_COLUMN} = NOW()`;
}

/** `deleted_at = NULL` — the assignment that takes a row back out of the bin. */
export function restoreAssignment(table: SoftDeletableTable): string {
  assertSoftDeletable(table);
  return `${SOFT_DELETE_COLUMN} = NULL`;
}

/**
 * How long a row stays in the bin before the purge is entitled to remove it.
 *
 * 90 days, matching the figure already written into the audit trail for this
 * work. It is deliberately a single exported constant rather than a literal in
 * the purge script, so the bin UI can tell a person the same number the purge
 * uses — "deleted 12 days ago, purged after 90" is only true if both read this.
 *
 * NOTHING IN THE SHIPPING API READS THIS TO DELETE ANYTHING. The purge is a
 * hand-run script; there is no scheduler, no cron and no boot hook. See
 * scripts/purge-deleted-rows.ts.
 */
export const BIN_RETENTION_DAYS = 90;

/**
 * `deleted_at < NOW() - INTERVAL '90 days'` — the purge's eligibility predicate.
 *
 * Built from BIN_RETENTION_DAYS rather than written out, so the number in the
 * bin UI and the number the purge acts on cannot drift apart. The interval
 * literal is interpolated from a number this module owns, never from input.
 */
export function purgeEligible(table: SoftDeletableTable): string {
  assertSoftDeletable(table);
  return `${SOFT_DELETE_COLUMN} < NOW() - INTERVAL '${BIN_RETENTION_DAYS} days'`;
}

/**
 * Days since a row went into the bin, for display. Returns null for a live row.
 *
 * In the API rather than the clients because two clients would otherwise each
 * implement it, and the portal already demonstrated what that costs.
 */
export function daysInBin(deletedAt: string | null | undefined, now = new Date()): number | null {
  if (!deletedAt) return null;
  const then = new Date(deletedAt).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.floor((now.getTime() - then) / 86_400_000);
}
