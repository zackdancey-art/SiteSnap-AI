/**
 * One definition of what a site's status is called and what colour it is.
 *
 * THE DEFECT THIS FIXES, MEASURED
 *
 * `STATUS_CFG` was copied verbatim into `app/dashboard/page.tsx:11` and
 * `app/sites/page.tsx:15`, and both copies keyed On Hold as `on_hold`, with an
 * underscore. The API's status is `on-hold`, with a hyphen — `z.enum(["active",
 * "completed", "on-hold"])` at `services/api/src/routes/projects.ts:53`, and
 * `type SiteStatus = "active" | "completed" | "on-hold"` at
 * `services/api/src/storage/projectsStore.ts:14`. So the key never matched, in three places:
 *
 *   1. the dashboard rendered an on-hold site as grey "Inactive", via the
 *      `?? STATUS_CFG.inactive` fallback;
 *   2. the Sites page's "On Hold" tab showed a count of 0, always, because
 *      `s.status === "on_hold"` is never true;
 *   3. selecting that tab showed an empty list, for the same reason — so an
 *      on-hold site was reachable only under "All".
 *
 * Nothing caught it because `Site.status` is typed `string` (`lib/api.ts:5`),
 * which is honest about the wire and useless as a guard.
 *
 * WHY `status` STAYS A `string` AT THE BOUNDARY
 *
 * Narrowing `Site.status` to a union would be a claim about every row ever
 * written, and this product predates the zod enum: the fallback key `inactive`
 * exists in the original config and is not in the API's enum, which is evidence
 * that rows outside it have existed. So the wire type stays loose and the
 * READING is made total instead — `siteStatusCfg` answers for any string, and
 * `canonicalSiteStatus` folds the spellings that mean the same thing.
 *
 * `on_hold` is kept as an alias rather than deleted. If any row really does
 * carry the underscore form, dropping the key would turn this fix into the same
 * bug pointing the other way.
 */

export type SiteStatusKey = "active" | "completed" | "on-hold" | "inactive";

/**
 * Spellings that mean the same status. The canonical form is the API's, so the
 * right-hand side of this map is the only vocabulary the rest of the portal
 * compares against.
 */
const ALIASES: Readonly<Record<string, SiteStatusKey>> = Object.freeze({
  "active": "active",
  "completed": "completed",
  "complete": "completed",
  "on-hold": "on-hold",
  "on_hold": "on-hold",
  "onhold": "on-hold",
  "inactive": "inactive",
});

/** The fallback, named once. An unrecognised status reads as Inactive. */
const UNKNOWN: SiteStatusKey = "inactive";

export function canonicalSiteStatus(raw: string | null | undefined): SiteStatusKey {
  if (!raw) return UNKNOWN;
  return ALIASES[raw.trim().toLowerCase()] ?? UNKNOWN;
}

export const SITE_STATUS_CFG: Readonly<Record<SiteStatusKey, { label: string; color: string; bg: string }>> =
  Object.freeze({
    active:    { label: "Active",    color: "#22C55E", bg: "#F0FDF4" },
    inactive:  { label: "Inactive",  color: "#9EAFC2", bg: "#F1F5F9" },
    completed: { label: "Complete",  color: "#E8731A", bg: "#FFF7ED" },
    "on-hold": { label: "On Hold",   color: "#F59E0B", bg: "#FFFBEB" },
  });

/** Total by construction: every string resolves to a config. */
export function siteStatusCfg(raw: string | null | undefined) {
  return SITE_STATUS_CFG[canonicalSiteStatus(raw)];
}

/**
 * The Sites page's filter tabs. `inactive` is deliberately absent: it is the
 * fallback label for an unrecognised value, not a status the product sets, and
 * a tab for it would invite filtering by "whatever we failed to understand".
 */
export const SITE_STATUS_FILTERS = ["all", "active", "completed", "on-hold"] as const;
export type SiteStatusFilter = (typeof SITE_STATUS_FILTERS)[number];

/** Label for a filter tab. Derived from the same config the badges use. */
export function siteStatusFilterLabel(filter: SiteStatusFilter): string {
  return filter === "all" ? "All" : SITE_STATUS_CFG[filter].label;
}

/** Does a site's raw status match the selected tab? Alias-tolerant. */
export function matchesSiteStatusFilter(raw: string | null | undefined, filter: SiteStatusFilter): boolean {
  return filter === "all" || canonicalSiteStatus(raw) === filter;
}
