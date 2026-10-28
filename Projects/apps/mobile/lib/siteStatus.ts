import Colors from "@/constants/colors";

/**
 * What a site's status is CALLED and what colour it is, on this surface.
 *
 * THE TWIN OF apps/supervisor-web/lib/siteStatus.ts, AND WHY THERE ARE TWO
 *
 * There is no third place to put this. `@sitesnap/shared` emits `.d.ts` only
 * (`"main": "dist/index.d.ts"`), so it cannot carry a runtime constant, and the
 * two clients are separate bundles with separate token files. So the vocabulary
 * is declared twice and `scripts/assert-site-status-vocabulary.mjs` requires the
 * two to agree — on the keys AND on the labels. That check is the mechanism;
 * this comment is not.
 *
 * WHAT IT ALREADY COST, MEASURED
 *
 * Three places on this surface decided the question separately:
 *
 *   app/(tabs)/index.tsx:23-24  a ternary pair. A completed site read "Completed"
 *                               in Colors.textTertiary — grey, the colour this
 *                               file gives to a status it does not recognise —
 *                               while the portal shows "Complete" in accent
 *                               orange. Same site, two surfaces, different word
 *                               and different colour.
 *   app/supervisor-dashboard.tsx:146  `site.status.toUpperCase()`, which printed
 *                               "ON-HOLD" where every portal surface says
 *                               "On Hold".
 *
 * The label chosen here is the PORTAL's existing one, "Complete", because that
 * is the word already shown to clients. Mobile's "Completed" is the one that
 * changes. If the other word is wanted it is one line here and one in the
 * portal's twin, and the structural check will refuse to let only one of them
 * move.
 *
 * WHY THE READING IS TOTAL RATHER THAN THE TYPE NARROW
 *
 * `Site.status` is typed `"active" | "completed" | "on-hold"` in lib/types.ts
 * and that type is a claim, not a guarantee: sites are rehydrated from
 * AsyncStorage by `safeParseArray<Site>`, which casts without validating, so a
 * cache written by any past build can hold anything. Rather than trust the
 * union at the edge, `canonicalSiteStatus` accepts a string and is total. An
 * unrecognised value reads as Inactive in grey — visibly not one of the three,
 * which is the honest rendering of a value we do not understand.
 */

export type SiteStatusKey = "active" | "completed" | "on-hold" | "inactive";

/**
 * Deliberately WIDER than the API's enum, on the read side only. `on_hold` is
 * here because the portal shipped that spelling for the life of the product and
 * a cache or an old row may still carry it; `complete` and `onhold` for the same
 * reason. Nothing here lets a new value be WRITTEN — SiteSchema in
 * services/api/src/routes/projects.ts is the only authority on that.
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

/**
 * Colours come from the design tokens, not from the portal's hex strings — and
 * they agree anyway, which is why the portal's values are quoted here. That
 * agreement is not luck: the portal's status palette was picked from the same
 * four roles. It is written down so that if a token moves, this comment is the
 * record of what the other surface will still be showing.
 *
 *   active    Colors.success      #22C55E  = the portal's #22C55E
 *   completed Colors.accent       #E8731A  = the portal's #E8731A
 *   on-hold   Colors.warning      #F59E0B  = the portal's #F59E0B
 *   inactive  Colors.textTertiary #9EAFC2  = the portal's #9EAFC2
 */
export const SITE_STATUS_CFG: Readonly<Record<SiteStatusKey, { label: string; color: string }>> =
  Object.freeze({
    active:    { label: "Active",   color: Colors.success },
    inactive:  { label: "Inactive", color: Colors.textTertiary },
    completed: { label: "Complete", color: Colors.accent },
    "on-hold": { label: "On Hold",  color: Colors.warning },
  });

/** Total by construction: every string resolves to a config. */
export function siteStatusCfg(raw: string | null | undefined) {
  return SITE_STATUS_CFG[canonicalSiteStatus(raw)];
}

export function siteStatusLabel(raw: string | null | undefined): string {
  return siteStatusCfg(raw).label;
}
