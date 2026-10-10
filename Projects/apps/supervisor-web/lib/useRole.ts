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
 * WHAT IS REFUSED, AND WHAT IS DELIBERATELY NOT
 *
 * Crew, and only crew. The decision is about crew: they view and edit
 * everything a manager can, except the supervisor dashboard, which does not
 * appear for them at all. A VIEWER keeps it, because the dashboard's own route
 * — GET /projects/reports/supervisor — is viewer+ at the API, so tightening
 * this to manager+ would take a whole screen off viewers in the name of a
 * decision that never mentioned them.
 *
 * Mobile's equivalent predicate (apps/mobile/lib/permissions.ts) IS manager+,
 * which it already was before this work. So a viewer gets the dashboard on the
 * portal and not on the phone. That asymmetry is pre-existing and is left
 * alone rather than unified in passing; it is written up in the PR body as a
 * question for the owner, because either direction changes what a viewer can
 * do and that is not this change's call.
 *
 * AN ABSENT ROLE IS NOT REFUSED, ON PURPOSE
 *
 * The role is read from localStorage, and a session stored by an older build
 * may carry no `companyRole` at all. Refusing a manager their dashboard
 * because their saved session predates the field would be a worse failure than
 * the one this guards against — and it would be invisible, since the fix is to
 * sign out and back in, which nobody would think to do. Only a role known to
 * be crew is withheld. The thing that holds when this is wrong is the API: it
 * refuses crew the dashboard's route independently, which is the point of
 * doing both halves.
 */
export function canSeeSupervisorDashboard(companyRole: string | null | undefined): boolean {
  return !isCrew(companyRole);
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
    canReadCompanyProfile: canReadCompanyProfile(user?.companyRole),
    canApproveDiary: canApproveDiary(user?.companyRole),
    isCrew: isCrew(user?.companyRole),
  };
}
