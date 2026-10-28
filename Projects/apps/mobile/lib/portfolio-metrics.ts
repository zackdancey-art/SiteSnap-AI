/**
 * The dashboard's figures, derived in one place and the same way on both
 * surfaces.
 *
 * WHAT THIS IS FOR
 *
 * The manager dashboard on this surface is supposed to match the portal's —
 * same cards, same figures, same gating. It did not. The portal shows four
 * metric cards and an approval-health bar counted in the database; this surface
 * showed a one-line sentence counted off the bootstrap arrays:
 *
 *     `${activeSites} active sites · ${entries.length} entries · ${diaries.length} diaries.`
 *
 * Those arrays are AUDIT L98. `/projects/bootstrap` passes no limit to
 * `listSites`/`listEntries`/`listDiaries`, so each takes their default
 * `limit = 200` — a company with five thousand entries read "200 entries" on
 * the phone, exactly as it did on the portal, and for the same reason. So this
 * is the parity work and the L98 fix on this surface in one: the figures now
 * come from `GET /projects/summary`, which counts in SQL.
 *
 * WHY THE PARSE IS DEFENSIVE RATHER THAN A CAST
 *
 * This is the one client where the deploy order genuinely cannot be relied on.
 * An `eas update` reaches a phone whenever the phone next launches, and it is
 * batched separately from the API deploy; so a bundle that expects
 * `activeSites` can be running against an API that does not send it yet. A cast
 * would render the word "undefined" in a metric card. `derivePortfolioMetrics`
 * therefore takes `unknown`, returns `null` unless every figure it needs is
 * actually a finite number, and the screen shows an em dash for `null`.
 *
 * AND WHY IT DOES NOT FALL BACK TO THE BOOTSTRAP ARRAYS
 *
 * Falling back is the tempting option and it is the wrong one: it would restore
 * exactly the silently-capped number this change exists to remove, on the one
 * path nobody tests. A missing number is visibly missing; a capped one is not.
 * The portal's dashboard makes the same choice for the same reason — see the
 * note in apps/supervisor-web/app/dashboard/page.tsx.
 *
 * FREE OF REACT NATIVE IMPORTS, DELIBERATELY
 *
 * Mobile cannot be screenshotted from this environment, so a unit test is the
 * only verification available for the figures; and the node test program cannot
 * compile a module that reaches AsyncStorage or a navigator. The arithmetic and
 * the thresholds live here and are tested; the request lives in
 * lib/usePortfolioSummary.ts, which is not. Same split as lib/permissions.ts,
 * and for the same stated reason.
 */

/**
 * The response shape of `GET /api/projects/summary`.
 *
 * Declared here rather than in lib/types.ts because nothing else reads it and
 * the only consumer is the function below. `actorRole` is deliberately absent:
 * the route returns it, this surface does not use it, and a field nothing reads
 * is a field that drifts.
 */
export type PortfolioSummary = {
  sites: number;
  activeSites: number;
  completedSites: number;
  onHoldSites: number;
  entries: number;
  diaries: number;
  approvedDiaries: number;
  draftDiaries: number;
};

export type PortfolioMetrics = {
  sites: number;
  active: number;
  completed: number;
  entries: number;
  diaries: number;
  approved: number;
  pending: number;
  /** Whole percent, 0-100. 0 when there are no diaries — not NaN, and not hidden. */
  approvalRate: number;
};

/** The eight fields a summary must carry before any card will render. */
const REQUIRED: readonly (keyof PortfolioSummary)[] = [
  "sites",
  "activeSites",
  "completedSites",
  "onHoldSites",
  "entries",
  "diaries",
  "approvedDiaries",
  "draftDiaries",
];

/**
 * Enumerated from REQUIRED rather than written out again. A list of names and a
 * loop over a different list of names is how a field comes to be validated
 * everywhere except the one place it was added.
 */
function isPortfolioSummary(value: unknown): value is PortfolioSummary {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return REQUIRED.every((key) => typeof row[key] === "number" && Number.isFinite(row[key]));
}

/**
 * `null` in, `null` out; an unrecognised payload, `null` out. The caller renders
 * `null` as an em dash, so there is no state in which a card shows a number
 * this function did not vouch for.
 */
export function derivePortfolioMetrics(payload: unknown): PortfolioMetrics | null {
  if (!isPortfolioSummary(payload)) return null;
  return {
    sites: payload.sites,
    active: payload.activeSites,
    completed: payload.completedSites,
    entries: payload.entries,
    diaries: payload.diaries,
    approved: payload.approvedDiaries,
    pending: payload.draftDiaries,
    approvalRate: approvalRate(payload.approvedDiaries, payload.diaries),
  };
}

/**
 * Guarded against a zero denominator because `0/0` is NaN and NaN renders as
 * the word "NaN" in a Text node. A company with no diaries has an approval rate
 * of nothing, and 0% is the nearest true statement.
 */
export function approvalRate(approved: number, diaries: number): number {
  if (diaries <= 0) return 0;
  return Math.round((approved / diaries) * 100);
}

export type ApprovalTone = "good" | "fair" | "poor";

/**
 * The same two thresholds the portal's health bar uses — 80 and 50 — named so
 * the two surfaces can be checked against each other rather than compared by
 * eye. The portal writes them inline as
 * `rate >= 80 ? green : rate >= 50 ? amber : red`; if either number moves, both
 * places have to move, and this function is the one worth grepping for.
 */
export const APPROVAL_TONE_THRESHOLDS = Object.freeze({ good: 80, fair: 50 });

export function approvalTone(rate: number): ApprovalTone {
  if (rate >= APPROVAL_TONE_THRESHOLDS.good) return "good";
  if (rate >= APPROVAL_TONE_THRESHOLDS.fair) return "fair";
  return "poor";
}
