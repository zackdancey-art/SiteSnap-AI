import { Actor, isCrew } from "./actor";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHO SEES WHICH ROWS, AND WHO MAY CHANGE THEM. THE ONE PLACE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every store in this service used to answer both of those questions with the
 * same predicate — `isCrew(actor) ? ownRowsOnly : wholeCompany` — written out
 * again in each file. That conflation is what produced the two defects this
 * module exists to separate:
 *
 *   - Crew saw too little. A company-level crew member has no `site_members`
 *     row (a company invitation does not create one, and should not: there is
 *     no particular site to name at invitation time), so the per-store crew
 *     clause reduced to `owner_email = me`. A crew member's "weekly site
 *     report" described only their own third of the week, with no warning.
 *
 *   - Crew could change too much. The permission table that approved the old
 *     rule only ever measured a crew member writing their OWN rows, so nothing
 *     exercised crew touching somebody else's. Two stores (incidents,
 *     inspections) had no ownership check at all on their Postgres update and
 *     delete paths, while their in-memory twins did — green suite, open door.
 *
 * So there are TWO rules here, not one, and they point in opposite directions:
 *
 *   READ  — `readVisibility`:   crew see every row in their company.
 *   WRITE — `canEditRow`:       crew change only the rows they created.
 *
 * with one named carve-out, `timesheet`, where both rules are own-only.
 *
 * ───────────────────────────────────────────────────────────────────────────
 *  WHY VISIBILITY IS COMPANY-WIDE RATHER THAN SITE-ASSIGNED, AND WHAT WOULD
 *  CHANGE IF THAT DECISION MOVED
 * ───────────────────────────────────────────────────────────────────────────
 *
 * Site-level assignment — a manager putting named crew on named sites — is a
 * model to expect later, and the machinery is already half-present:
 * `site_members` exists, site-scoped invitations populate it, and
 * `canManageSite` reads it. That half-wiring is exactly what produced the
 * read-side defect above, because a clause written for assigned sites was
 * being asked to answer a question about company membership.
 *
 * The decision today is company-wide. It lives in `readVisibility` below and
 * nowhere else: every store asks this module rather than testing `isCrew`
 * itself. To move to site assignment, change `readVisibility` to return a
 * third mode — `"assigned-sites"` — and the two emitters below to render it as
 * `site_id IN (SELECT site_id FROM site_members WHERE member_email = $n)` for
 * SQL and a membership-set test for the in-memory path. Nothing in any store
 * changes; the stores already hand their `site_id` column name to the SQL
 * emitter for exactly this reason. The tests that would have to change are
 * this module's own and the company-wide rows of the crew permission table.
 *
 * KEEP THE RULE HERE. A `company_id` check copied into a store method is how
 * the last model became unmovable.
 */

/**
 * Every record type a crew member can write, as a closed set.
 *
 * Closed because the write rule has to be decided for each one deliberately —
 * "crew edit only their own" is not self-evidently right for every row with an
 * `owner_email` column, and the types where it is NOT right are the ones worth
 * naming. See `RECORD_CLASS` for each disposition.
 */
export type RecordKind =
  | "entry"
  | "diary"
  | "diaryTemplate"
  | "incident"
  | "inspection"
  | "inspectionTemplate"
  | "delivery"
  | "timesheet"
  | "site";

/**
 * What kind of thing a row is — which is what decides both rules.
 *
 * `shared-site-record`
 *   The site's record of what happened: the diary, the incident, the
 *   inspection, the delivery docket. Anyone in the company may read it,
 *   because a site diary that only its author can see is not a site diary.
 *   Only its author may change it, because a compliance record whose author
 *   is recorded and whose content anyone can rewrite is evidence of nothing.
 *
 * `personal-record`
 *   Information that happens to be stored against a site but is ABOUT one
 *   person. Timesheets are the named instance: that is pay information, not a
 *   shared site record, so both rules are own-only and the whole company
 *   seeing it would be a disclosure rather than a feature.
 *
 * `shared-site-attribute`
 *   Not an authored record at all — a mutable property of the site itself,
 *   such as progress percentage. `owner_email` on a site is the manager who
 *   created it, so "edit only your own" would refuse crew every update and
 *   delete a working field capability rather than closing a gap. Read and
 *   write are both company-wide; the gate that matters on sites is the
 *   route-level manager+ on creation and deletion, which already exists.
 */
export type RecordClass = "shared-site-record" | "personal-record" | "shared-site-attribute";

export const RECORD_CLASS: Readonly<Record<RecordKind, RecordClass>> = Object.freeze({
  entry: "shared-site-record",
  diary: "shared-site-record",
  diaryTemplate: "shared-site-record",
  incident: "shared-site-record",
  inspection: "shared-site-record",
  inspectionTemplate: "shared-site-record",
  delivery: "shared-site-record",
  // The exception, named. Pay information.
  timesheet: "personal-record",
  site: "shared-site-attribute",
});

/**
 * Which of those tables carry a `site_id`, and so could be narrowed to a set of
 * assigned sites if the model moved. Inspection templates are the company's
 * reusable checklists and belong to no site, which is why a site-assignment
 * model could never narrow them and why `readVisibility` must keep answering
 * from the kind rather than from a column name a store passes in.
 */
export const SITE_SCOPED: Readonly<Record<RecordKind, boolean>> = Object.freeze({
  entry: true,
  diary: true,
  diaryTemplate: true,
  incident: true,
  inspection: true,
  inspectionTemplate: false,
  delivery: true,
  timesheet: true,
  site: false,
});

/** How much of the company a role may READ, for a given kind of row. */
export type ReadVisibility = "whole-company" | "own-rows";

/**
 * THE VISIBILITY RULE. Everything that reads rows asks this.
 *
 * Note what is deliberately absent: `site_members`. Membership is about who a
 * manager has ASSIGNED to a site, which is a model this product does not yet
 * have (see the header). Letting it widen visibility here is what made the two
 * models indistinguishable, and it is why a crew member on one site could read
 * another person's timesheet.
 */
export function readVisibility(actor: Actor, kind: RecordKind): ReadVisibility {
  // Pay information. Narrowed for crew only — a manager reviewing the week's
  // hours is the whole point of the record existing.
  if (RECORD_CLASS[kind] === "personal-record" && isCrew(actor)) return "own-rows";
  // Everything else, every role, the whole company. This is the line the
  // site-assignment model changes — see the header.
  return "whole-company";
}

/**
 * THE OWNERSHIP RULE. Everything that changes or removes a row asks this.
 *
 * Crew may change only what they created. Non-crew (viewer/manager/owner) are
 * not narrowed here — a manager correcting a crew member's diary entry is the
 * supervision this product is for, and the rank gates that stop a VIEWER
 * writing at all live on the routes, not here.
 *
 * The `owner_email` comparison is the authorship record, and it is set from
 * `actor.email` at creation in every store — never from the request body, so
 * it cannot be claimed.
 */
export function canEditRow(
  actor: Actor,
  kind: RecordKind,
  row: { companyId: string; ownerEmail: string }
): boolean {
  if (row.companyId !== actor.companyId) return false;
  if (RECORD_CLASS[kind] === "shared-site-attribute") return true;
  if (!isCrew(actor)) return true;
  return actor.email.toLowerCase() === row.ownerEmail.toLowerCase();
}

/** The in-memory twin of `readVisibility`, for the JSON fallback store. */
export function canReadRow(
  actor: Actor,
  kind: RecordKind,
  row: { companyId: string; ownerEmail: string }
): boolean {
  if (row.companyId !== actor.companyId) return false;
  if (readVisibility(actor, kind) === "whole-company") return true;
  return actor.email.toLowerCase() === row.ownerEmail.toLowerCase();
}

/**
 * The SQL twin of `readVisibility`: the extra WHERE clause a list query needs
 * BEYOND its own `company_id = $n`, or `null` when no narrowing applies.
 *
 * Pushes onto `params` and returns a clause referencing `$params.length`, which
 * is the convention every store here already uses. The `"assigned-sites"` mode
 * described in the header needs nothing from the caller that the `kind` does
 * not already supply — `SITE_SCOPED` records which tables have a `site_id` to
 * narrow on — which is why no store passes a column name.
 */
export function readVisibilitySql(actor: Actor, kind: RecordKind, params: unknown[]): string | null {
  if (readVisibility(actor, kind) === "whole-company") return null;
  params.push(actor.email);
  return `LOWER(owner_email) = LOWER($${params.length})`;
}

/**
 * The SQL twin of `canEditRow`: the extra WHERE clause an UPDATE or DELETE
 * needs beyond its own `company_id = $n`, or `null` when no narrowing applies.
 *
 * Stores keep this even though `requireOwnRecord` already refused the request
 * at the route — CLAUDE.md §3's both-layers rule. Deleting the middleware then
 * degrades the refusal from 403 to 404 rather than opening the row.
 */
export function editOwnershipSql(actor: Actor, kind: RecordKind, params: unknown[]): string | null {
  if (RECORD_CLASS[kind] === "shared-site-attribute") return null;
  if (!isCrew(actor)) return null;
  params.push(actor.email);
  return `LOWER(owner_email) = LOWER($${params.length})`;
}
