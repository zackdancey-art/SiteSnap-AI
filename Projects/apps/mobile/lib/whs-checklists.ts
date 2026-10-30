/**
 * The built-in WHS checklists, and the one rule that keeps them out of a
 * foreign key.
 *
 * WHAT THE API SERVES
 * GET /api/whs-checklists returns five hardcoded Australian WHS checklists
 * (services/api/src/routes/templates.ts) — daily pre-start, hazard identification, incident and
 * near-miss, WHS inspection, SWMS review. They are read-only starter content
 * compiled into the API: no table, no rows, no company. Until now nothing
 * called the route, so a new company opening the inspections screen saw an
 * empty template list and had to type ten to twelve items by hand.
 *
 * WHY THIS IS A MODULE AND NOT INLINE IN THE SCREEN
 * The same reason lib/permissions.ts is a module: mobile cannot be
 * screenshotted from this environment and the node test program cannot compile
 * a file that imports react-native, so a decision kept in the screen cannot be
 * tested at all. The decision below is worth testing. See whs-checklists.test.ts.
 *
 * ── THE PART THAT MATTERS ────────────────────────────────────────────────────
 *
 * The inspections screen holds ONE `selectedTemplate` string for what is now
 * two different kinds of thing: a row in `inspection_templates`, and a built-in
 * checklist that is not in any table. That string is sent to
 * POST /api/inspections as `templateId`, and migration 009 declares
 *
 *     template_id TEXT REFERENCES inspection_templates(id) ON DELETE SET NULL
 *
 * So sending a built-in id as `templateId` is a foreign-key violation. In
 * production that is a 500 on create; against the in-memory store it is a
 * cheerful 201, because the fallback store has no constraints. That is the
 * eighth defect to hide in the gap between the two stores, and adding the
 * built-ins to the picker is what would have made it reachable — so the guard
 * ships with them, not after them.
 *
 * `templateIdForCreate` is that guard. Every call site that builds the create
 * payload must go through it rather than passing `selectedTemplate` along.
 *
 * AND WHY A PREFIX RATHER THAN SEARCHING THE TWO LISTS
 * "Is this selection a built-in?" could be answered by looking for the id in
 * the built-ins array. It must not be. If that fetch failed — offline, a 500,
 * an older API that has not got the route — the array is empty, every built-in
 * selection reads as "not a built-in", and the id goes to the server as a
 * template reference. The question would be answered by the success of a
 * network request. Prefixing the selection makes the answer structural: it is
 * in the string the screen is holding, and it is the same answer whether or not
 * anything loaded.
 */

/** A built-in checklist as GET /api/whs-checklists serves it. */
export type WhsChecklist = {
  id: string;
  name: string;
  category: string;
  items: string[];
};

/** A company's own checklist, from GET /api/inspection-templates. */
export type UserChecklistTemplate = {
  id: string;
  name: string;
  items: string[];
};

/**
 * Namespace for a built-in selection. Contains a colon, which uuid v4 cannot,
 * so a built-in selection can never collide with a real template id.
 */
export const BUILT_IN_PREFIX = "whs:";

/** The value the picker stores when a built-in checklist is chosen. */
export function builtInSelectionId(checklistId: string): string {
  return `${BUILT_IN_PREFIX}${checklistId}`;
}

/** Whether a stored selection names a built-in checklist rather than a row. */
export function isBuiltInSelection(selection: string | null | undefined): boolean {
  return typeof selection === "string" && selection.startsWith(BUILT_IN_PREFIX);
}

/** The checklist id inside a built-in selection, or "" if it is not one. */
export function builtInIdFromSelection(selection: string | null | undefined): string {
  return isBuiltInSelection(selection) ? (selection as string).slice(BUILT_IN_PREFIX.length) : "";
}

/**
 * The value to send as `templateId` on POST /api/inspections.
 *
 * null for a built-in checklist and null for no selection; the id itself only
 * for a real `inspection_templates` row. Read the foreign-key note at the top
 * of this file before changing it — the in-memory store will not complain and
 * production will.
 *
 * The inspection consequently records no machine-readable trace of which
 * built-in produced it. That is deliberate rather than overlooked: the
 * alternative is a nullable second column and a migration, and the screen
 * instead carries the checklist's NAME into the inspection's own `name` field,
 * which is already stored, already shown, and already on the exported report.
 */
export function templateIdForCreate(selection: string | null | undefined): string | null {
  if (!selection) return null;
  if (isBuiltInSelection(selection)) return null;
  return selection;
}

/**
 * The checklist items a selection resolves to.
 *
 * Falls back to `fallbackItems` for no selection AND for a selection that
 * resolves to nothing — a template deleted on another device, or a built-in id
 * from a newer build than the API. An inspection with zero items is a form
 * that cannot be filled in, so there is no case where returning an empty list
 * is the better answer.
 */
export function resolveChecklistItems(
  selection: string | null | undefined,
  userTemplates: readonly UserChecklistTemplate[],
  builtIns: readonly WhsChecklist[],
  fallbackItems: readonly string[]
): string[] {
  if (selection) {
    if (isBuiltInSelection(selection)) {
      const id = builtInIdFromSelection(selection);
      const found = builtIns.find((c) => c.id === id);
      if (found && found.items.length > 0) return [...found.items];
    } else {
      const found = userTemplates.find((t) => t.id === selection);
      if (found && found.items.length > 0) return [...found.items];
    }
  }
  return [...fallbackItems];
}

/**
 * The name to give an inspection started from a selection, or "" to leave
 * whatever the person typed alone.
 *
 * Only a built-in gets a name from here, and only because `templateId` is null
 * for one: without this the inspection would carry no record at all of which
 * checklist it came from. A user template's id IS stored on the row, so
 * renaming the inspection after it would overwrite a title the person chose in
 * order to duplicate something already recorded.
 */
export function suggestedInspectionName(
  selection: string | null | undefined,
  builtIns: readonly WhsChecklist[]
): string {
  if (!isBuiltInSelection(selection)) return "";
  const found = builtIns.find((c) => c.id === builtInIdFromSelection(selection));
  return found ? found.name : "";
}
