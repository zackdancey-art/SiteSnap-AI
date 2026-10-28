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
 * Whether this role may add, rename or delete a client.
 *
 * Manager and owner, mirroring `requireAtLeast("manager")` on the three write
 * routes. Written as the allowed ranks rather than as "not crew" because a
 * VIEWER is refused here too — unlike canSeeSupervisorDashboard and
 * canReadCompanyProfile above, whose routes are viewer+.
 *
 * READING THE CLIENT LIST IS NOT GATED, AND MUST NOT BE
 *
 * There is deliberately no `canReadClients` beside this. GET /clients is
 * behind identity rather than rank because the sites list takes its group
 * headings from it, so a crew member who could not read it would see a list
 * of sites filed under nothing. The clients page is theirs to read; the three
 * controls on it are not.
 *
 * AND IT IS NOT AN ACCESS BOUNDARY EITHER
 *
 * A client groups sites for filing. Nothing decides who may read a site by
 * looking at its client — recordScope.ts on the API has no `client` record
 * kind, on purpose. So this predicate is about who may edit the filing
 * cabinet, never about who can see what is in it.
 *
 * AN ABSENT ROLE IS REFUSED HERE, UNLIKE THE THREE PREDICATES ABOVE
 *
 * This file already holds both conventions, and the difference is not an
 * oversight in either place. canSeeSupervisorDashboard, canReadCompanyProfile
 * and canApproveDiary read the RAW value and let an absent role through, so a
 * manager whose saved session predates the field does not silently lose a
 * screen. `isManager` and `isAtLeast` in useRole() below read the DEFAULTED
 * value and refuse it.
 *
 * These follow `isManager`, because withholding a button and withholding a
 * screen are not the same mistake. The failure when this is wrong is that a
 * manager with an old session sees the clients list without the three write
 * controls — annoying, visible, and fixed by signing out and in. The failure
 * in the other direction is a button that 403s on a page whose other buttons
 * work, which reads as the product being broken.
 */
const CLIENT_MANAGERS = ["manager", "owner"];

export function canManageClients(companyRole: string | null | undefined): boolean {
  return CLIENT_MANAGERS.includes(companyRole ?? "");
}

/**
 * Whether this role may file a site under a client, or unfile it.
 *
 * Its own predicate rather than a second caller of canManageClients, for the
 * same reason the mobile half keeps them apart: they agree today but answer to
 * different routes on different routers — this one to PATCH
 * /projects/sites/:id, the other to the clients router. Collapsing two
 * permissions that happen to match is how one of them later moves and the
 * other silently follows it.
 */
export function canFileSiteUnderClient(companyRole: string | null | undefined): boolean {
  return CLIENT_MANAGERS.includes(companyRole ?? "");
}

/**
 * Whether this role may approve, send back, or reopen a crew timecard.
 *
 * The same two refused roles as diary approval, and for a stronger reason than
 * tidiness: `POST /crew/timecards/:id/approval` carries `requireAtLeast(
 * "manager")`, so crew (rank 0) and viewer (rank 1) are both refused at the API.
 * Written as the refused roles by name rather than as a rank comparison, like
 * the rest of this file, so an unrecognised role is not silently demoted and the
 * API stays the authority on it.
 *
 * WHY THE PORTAL ASKS AT ALL, WHEN THE API ALREADY REFUSES
 *
 * Because of what a crew member would otherwise see. The approval controls are
 * the only thing on the timesheets tab that writes, and a crew member's own list
 * is narrowed to their own cards by the API, so offering them Approve would be
 * offering them self-approval of their own hours — the exact defect the rank gate
 * on that route exists to prevent — and then refusing it with a 403. Not drawing
 * the button says the true thing first.
 *
 * It is NOT the only thing standing between a crew member and that write. The
 * route refuses them independently, which is the point of doing both halves
 * (CLAUDE.md §3). This half decides what is drawn; that half decides what
 * happens.
 *
 * Mobile's `canApproveTimesheet` (apps/mobile/lib/permissions.ts) is written as
 * manager+ rather than as a refused list, and answers the same for all four
 * known roles. The two differ only on a role neither recognises — mobile refuses
 * it, this allows it — and that is the same pre-existing asymmetry already
 * recorded on canSeeSupervisorDashboard above, kept rather than unified in
 * passing.
 */
const REFUSED_TIMESHEET_APPROVAL = ["crew", "viewer"];

export function canApproveTimesheet(companyRole: string | null | undefined): boolean {
  return !REFUSED_TIMESHEET_APPROVAL.includes(companyRole ?? "");
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
    canManageClients: canManageClients(user?.companyRole),
    canFileSiteUnderClient: canFileSiteUnderClient(user?.companyRole),
    canApproveTimesheet: canApproveTimesheet(user?.companyRole),
    isCrew: isCrew(user?.companyRole),
  };
}
