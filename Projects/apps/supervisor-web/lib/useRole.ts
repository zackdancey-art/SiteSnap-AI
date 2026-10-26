"use client";

import { getSavedUser } from "./api";

const RANK: Record<string, number> = { crew: 0, viewer: 1, manager: 2, owner: 3 };

/**
 * The one role this phase's decision is about.
 *
 * Every refusal in this file is crew-specific, so they are all written in terms
 * of this rather than as separate rank comparisons that would have to be kept
 * in agreement by hand. The reasoning for why an absent or unrecognised role is
 * NOT treated as crew is below, on canSeeSupervisorDashboard, and applies to
 * every caller here.
 */
export function isCrew(companyRole: string | null | undefined): boolean {
  return companyRole === "crew";
}

/**
 * Whether the supervisor dashboard is shown to this role.
 *
 * MANAGER AND OWNER. THE OWNER DECIDED THIS; IT USED TO BE VIEWER+.
 *
 * The previous version of this comment left the question open, and said so:
 * the portal showed the dashboard to viewers because the route behind it is
 * viewer+ at the API, while mobile's equivalent predicate
 * (apps/mobile/lib/permissions.ts) was already manager+ — so a viewer got the
 * dashboard on the portal and not on the phone. That was written up as a
 * question rather than unified in passing, because either direction changes
 * what a viewer can do.
 *
 * The answer was to align both surfaces to manager+. This is that change. The
 * asymmetry is gone and mobile is the surface that did not move.
 *
 * WHAT THIS IS NOT
 *
 * It is NOT a new refusal. `GET /projects/summary` — the route both clients'
 * dashboards actually read their figures from — is still
 * `requireAtLeast("viewer")`, so a viewer who calls it directly still gets the
 * numbers. Hiding a control is
 * not a permission — the repo's own rule — and claiming this withholds data
 * would be false. What it withholds is the SCREEN, on both surfaces, which is
 * what the decision named. Moving the routes is a separate change: it would
 * touch the rank table in crew-permissions-db.test.ts, two access tests and
 * the load-test's route list, and it is flagged in the PR body as the owner's
 * call rather than taken here.
 *
 * AN ABSENT ROLE IS NOW REFUSED, WHICH IS A CHANGE
 *
 * Written as the two admitted roles by name, like the rest of this file, so an
 * unrecognised role gets the least access — matching mobile, where
 * `isManagerOrAbove` has always failed closed. The earlier viewer+ version
 * failed OPEN for an absent role on purpose, because `companyRole` is optional
 * on the saved user (`User` in lib/api.ts) and a session stored by an older
 * build may carry none; refusing a manager their dashboard over a stale
 * localStorage entry is a bad failure, and an invisible one, since the fix is
 * to sign out and back in and nobody would think to do that.
 *
 * Failing closed and saying nothing would reintroduce exactly that. So
 * `isUnknownRole` below exists to let the screen tell those two cases apart:
 * a known crew or viewer is told the dashboard is for managers; a session with
 * no role at all is told to sign in again, which is the thing that actually
 * fixes it.
 */
const DASHBOARD_ROLES = ["manager", "owner"];

export function canSeeSupervisorDashboard(companyRole: string | null | undefined): boolean {
  return DASHBOARD_ROLES.includes(companyRole ?? "");
}

/**
 * A saved session that carries no company role, or one this build does not
 * recognise — as distinct from a role that is simply below the line.
 *
 * Only used to choose which refusal to show. It is not a permission and grants
 * nothing: every predicate here still refuses an unknown role.
 */
const KNOWN_ROLES = ["crew", "viewer", "manager", "owner"];

export function isUnknownRole(companyRole: string | null | undefined): boolean {
  return !KNOWN_ROLES.includes(companyRole ?? "");
}

/**
 * Whether GET /company/profile will answer for this role.
 *
 * AUDIT L79. This is not a UI preference — it mirrors `requireAtLeast("viewer")`
 * on that route, which puts crew (rank 0) below the line and everybody else
 * above it. It exists because the Team and Settings pages were calling the
 * route unconditionally and then reporting its 403 as "failed to load", so a
 * crew member was told their settings page was broken when in fact one section
 * of it was not theirs. Asking the question first is the fix; a nicer error
 * message would not have been, because nothing was failing.
 *
 * Keep this in step with the route. If the API ever opens the profile to crew,
 * this is the single place the portal has to be told.
 */
export function canReadCompanyProfile(companyRole: string | null | undefined): boolean {
  return !isCrew(companyRole);
}

/**
 * Whether this role may move a diary to `approved`.
 *
 * AUDIT L81, and the one predicate here that is NOT crew-specific: the API
 * gates the `status` field at manager+, so a VIEWER is refused too. Written as
 * the two refused roles by name rather than as a rank comparison, for the same
 * reason as the rest of the file — an unrecognised role is not silently
 * demoted, and the API refuses it regardless.
 *
 * WHAT THIS DOES NOT MEAN
 *
 * It is not permission to use the reports page, or to read a diary, or to
 * generate one. Crew keep all of that. The only thing withheld is the
 * attestation, because the portal presents an approval rate as oversight and a
 * rate that counts self-approvals is a misleading number on a seven-year
 * compliance document.
 *
 * It matters here rather than being left to the API because the Approve
 * button's error path is `catch (e) { console.error(e); }` — a 403 there is
 * swallowed and the button simply stops spinning, which is the least honest
 * refusal of the three the portal can give. Not offering the button is.
 */
const REFUSED_DIARY_APPROVAL = ["crew", "viewer"];

export function canApproveDiary(companyRole: string | null | undefined): boolean {
  return !REFUSED_DIARY_APPROVAL.includes(companyRole ?? "");
}

/**
 * Where a signed-in person lands when they asked for no particular screen.
 *
 * The sign-in page sent everybody to /dashboard. For crew that is now the
 * refusal screen, which is true but is a poor first thing to see when the rest
 * of the portal does work for them: after the projects gate was scoped, crew
 * read /projects/bootstrap and /location/workers like anybody else, so Sites,
 * Reports, Activity and the live map all answer 200. Sites is the honest
 * landing page — it is the screen the rest of their work hangs off.
 *
 * Now that the dashboard is manager+, this sends VIEWERS to /sites too, which
 * is a visible change for them: they used to land on the dashboard. Everything
 * else a viewer could reach, they still can — including GET /projects/summary,
 * which stays viewer+ at the API.
 */
export function landingPath(companyRole: string | null | undefined): string {
  return canSeeSupervisorDashboard(companyRole) ? "/dashboard" : "/sites";
}

export function useRole() {
  const user = getSavedUser();
  const companyRole = user?.companyRole ?? "viewer";
  return {
    companyRole,
    isAtLeast: (min: string) => (RANK[companyRole] ?? 1) >= (RANK[min] ?? 0),
    isOwner: companyRole === "owner",
    isManager: companyRole === "manager" || companyRole === "owner",
    // Computed from the RAW value, not from `companyRole` above. The
    // `?? "viewer"` default would answer the same today, but it would make
    // this predicate depend on a default written for a different purpose, and
    // the reasoning for what an absent role gets here is its own — see the
    // note on canSeeSupervisorDashboard.
    canSeeSupervisorDashboard: canSeeSupervisorDashboard(user?.companyRole),
    isUnknownRole: isUnknownRole(user?.companyRole),
    canReadCompanyProfile: canReadCompanyProfile(user?.companyRole),
    canApproveDiary: canApproveDiary(user?.companyRole),
    isCrew: isCrew(user?.companyRole),
  };
}
