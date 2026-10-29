/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  JOB NUMBERS. THE RULE, IN ONE TESTABLE PLACE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A job number is the contractor's own reference for a job — the string they
 * quote on an invoice and write on a drawing. It is free text, optional, and
 * NEVER unique: contractors reuse a number across years and across clients,
 * and an index that refused the second one would refuse the real world.
 *
 * WHY THIS IS NOT INSIDE THE SCREENS
 *
 * Same reason as `lib/site-grouping.ts` and `lib/permissions.ts`: there is no
 * simulator and no device attached to this environment, so a rule written
 * inside app/site/[id].tsx could only be verified by reading it. This module
 * imports nothing from react-native, so `lib/job-number.test.ts` can drive
 * every case a site can actually be in — including the three a screenshot of a
 * populated list would never show: a site whose job number is the empty
 * string, one whose job number is absent from the object entirely, and a
 * search query that is nothing but spaces.
 *
 * THE DEFECT THIS REPLACES. app/site/[id].tsx used to read the field as
 * `(site as { jobNumber?: string }).jobNumber` — a type assertion onto a Site
 * type that had no such property. It was `undefined` on every site in
 * production, for every company, since migration 011 shipped the column; the
 * cast is the reason the compiler could not say so. AUDIT L118.
 */

/*
 * THIS LOGIC EXISTS TWICE, AND CI PROVES THE TWO COPIES AGREE.
 *
 * The portal needs the same rule (apps/supervisor-web/lib/job-number.ts) and
 * cannot import this one: `@sitesnap/shared` resolves `main`, `types` and every
 * `exports` entry to a `.d.ts` file, so it carries types and no runtime
 * JavaScript, and changing that is an install-resolution decision belonging to
 * docs/DECISIONS.md rather than to this field.
 *
 * So the region between the two markers below is byte-identical in both files,
 * and `assert_shared_logic_copies` in Projects/scripts/ci.sh diffs it. Edit one
 * and CI fails on the commit that did it, naming both paths. The prose above
 * the marker is each file's own; everything inside it is shared.
 *
 * Unlike site-grouping, BOTH copies now carry tests — the portal grew a test
 * harness, and the belief that it had none is what left its runner out of two
 * sweeps (AUDIT L115, L117). So this module is tested on both sides rather than
 * tested once and carried across by the diff.
 */

// SHARED-LOGIC-BEGIN
/**
 * The job-number length cap.
 *
 * It is stated in THREE places and ci.sh proves all three agree: here, in the
 * portal twin of this file (byte-identical region), and in
 * services/api/src/routes/projects.ts, where it is the number the zod schema
 * refuses. `assert_job_number_cap_agrees` in Projects/scripts/ci.sh compares
 * the API's literal against this one.
 *
 * Why it has to be here at all, rather than only on the server: both clients
 * set `maxLength` on the text input from it. Without that the form accepts a
 * 60-character value, the save 400s, and the person is told their input is
 * invalid after typing it rather than being stopped at the cap.
 */
export const JOB_NUMBER_MAX_LENGTH = 40;

/**
 * Trim, and nothing else.
 *
 * NOT a whitespace collapse. "SITE 12 B" is a reference somebody wrote on a
 * drawing, and rewriting it to "SITE12B" would mean the number in the app is
 * not the number on the paper. Only the padding a text input accumulates is
 * removed, which is also exactly what the API's `z.string().trim()` does, so
 * the client and the server agree about what was sent.
 *
 * A value of nothing but whitespace normalises to "" — a cleared field, not a
 * one-space job number that every grouping would render as a blank badge.
 */
export function normaliseJobNumber(raw: string | null | undefined): string {
  return (raw ?? "").trim();
}

/**
 * Whether a site has a job number at all.
 *
 * THE ABSENCE STATE IS THE EMPTY STRING. `job_number` is NOT NULL DEFAULT ''
 * (migration 011), so every site that existed before the field was wired up
 * holds '' rather than NULL — and the API maps a narrow select's NULL to ''
 * too. This function nonetheless accepts null and undefined, because a client
 * built against an older API, or a site object assembled offline, can carry
 * either, and `Job #undefined` is the defect this whole field is being rescued
 * from (AUDIT L118).
 */
export function hasJobNumber(value: string | null | undefined): boolean {
  return normaliseJobNumber(value).length > 0;
}

/**
 * The job number as it is shown to a person, or null when there is none.
 *
 * NULL AND NOT "" — a caller must branch rather than render the result
 * unconditionally. A function that returned "" for absence would let a badge
 * with a border and padding appear around nothing, which is how empty chips
 * end up on a list.
 */
export function formatJobNumber(value: string | null | undefined): string | null {
  const trimmed = normaliseJobNumber(value);
  return trimmed ? `Job #${trimmed}` : null;
}

/**
 * Whether a job number matches what someone typed in the search box.
 *
 * Case-insensitive substring, on the trimmed value and the trimmed query, so
 * "nw-001" finds "2026-NW-00123" and a query that is only spaces matches
 * nothing rather than everything. An EMPTY query returns false here and the
 * callers handle "no query" by not filtering at all — a `matches` function that
 * returned true for an empty needle would quietly make every site a match for
 * every other field's search too.
 */
export function matchesJobNumber(value: string | null | undefined, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return false;
  return normaliseJobNumber(value).toLowerCase().includes(needle);
}
// SHARED-LOGIC-END
