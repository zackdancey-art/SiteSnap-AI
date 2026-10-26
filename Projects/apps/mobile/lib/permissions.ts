/**
 * What a company role may do, decided in one place.
 *
 * THE DECISION THIS ENCODES
 * A crew member may view and edit everything a manager can, with four
 * exceptions: the supervisor dashboard, which does not appear for them at all;
 * inviting anyone; removing a site; and changing company settings. Everything
 * else — diaries, photographs, incidents, inspections, deliveries, timesheets,
 * templates, location — crew gets, read and write, across every site in the
 * company.
 *
 * Plus one refusal that is narrower than a feature: crew may edit a diary and
 * may not APPROVE one. See canApproveDiary, and read the note there before
 * reaching for it — the hazard in this one is implementing it as "crew cannot
 * use diaries", which is a worse bug than the one it fixes.
 *
 * WHY A MODULE RATHER THAN THE EXPRESSION IT REPLACES
 * `user?.companyRole === "owner" || user?.companyRole === "manager"` was written
 * out longhand in three files (the tab layout and both halves of the supervisor
 * dashboard), and the delete-a-site control in app/site/[id].tsx had no check at
 * all even though the invite control two lines above it did. Three copies of a
 * predicate and one omission is how a permission comes to mean something
 * different on each screen.
 *
 * AND WHY IT IS FREE OF REACT NATIVE IMPORTS
 * Mobile cannot be screenshotted from this environment, so the only verification
 * available for the UI half of a permission decision is a unit test, and the node
 * test program cannot compile a module that reaches a navigator or AsyncStorage.
 * Keeping the decision here and the rendering in the screens is what makes it
 * testable at all. See lib/permissions.test.ts.
 *
 * THIS IS NOT THE ENFORCEMENT. Hiding a control is not a permission: every one
 * of these is refused independently by the API, because a hidden button is still
 * a reachable route. The server side is in services/api/src/routes — the three
 * exceptions are manager+ or owner-only there, and crew-permissions-db.test.ts
 * holds the table. What follows decides only what a person is shown.
 */

/** The four company roles, ranked as the API ranks them. */
export type CompanyRole = "crew" | "viewer" | "manager" | "owner";

/**
 * Narrowed from `unknown` deliberately. `user?.companyRole` is typed, but the
 * user object is rehydrated from storage and from a token payload, so a value
 * from an older build or a hand-edited store can be anything. Every predicate
 * below is written so that an unrecognised role gets the LEAST access — the
 * opposite of lib/session.ts, where an unknown 401 code fails towards sign-in,
 * because there the cost of being wrong is one sign-in and here it is showing
 * someone a control they may not use.
 */
function isRole(value: unknown, role: CompanyRole): boolean {
  return value === role;
}

function isManagerOrAbove(companyRole: unknown): boolean {
  return isRole(companyRole, "owner") || isRole(companyRole, "manager");
}

/**
 * The supervisor dashboard. Owners and managers only, and for everybody else
 * there is no tab, no button, and no route — see app/(tabs)/_layout.tsx, which
 * removes the screen from the navigator rather than hiding its button, so
 * guessing the URL does not reach it either.
 */
export function canSeeSupervisorDashboard(companyRole: unknown): boolean {
  return isManagerOrAbove(companyRole);
}

/**
 * Inviting anyone to a site or a company. Exception 1: inviting is the
 * manager's job, which is the shape of the workflow.
 *
 * Note that the API is stricter than this in one place the UI cannot see:
 * projectsStore.canManageSite() also admits a crew or viewer who personally
 * OWNS a site, which an owner demoted to crew still does. The route-level
 * manager+ gate is what closes that, not this function.
 */
export function canInvite(companyRole: unknown): boolean {
  return isManagerOrAbove(companyRole);
}

/**
 * Removing a site. Exception 2: editing entries is daily work, removing a site
 * is not, and the bin that would make it recoverable does not exist yet.
 */
export function canDeleteSite(companyRole: unknown): boolean {
  return isManagerOrAbove(companyRole);
}

/**
 * Removing somebody from a site. The symmetrical half of canInvite — a
 * membership change rather than field work — and gated with it.
 */
export function canManageSiteMembers(companyRole: unknown): boolean {
  return isManagerOrAbove(companyRole);
}

/**
 * APPROVING a site diary. Manager+, and note what this is NOT: it is not
 * permission to edit a diary, which crew keep in full.
 *
 * A submitted diary is a claim; an approved one is the record. The supervisor
 * dashboard computes an "approval rate" from the field and presents it as
 * oversight, so a rate counting the author's own approvals is a misleading
 * number on a seven-year compliance document. AUDIT L81.
 *
 * The API gate is finer than a route — POST and PATCH /projects/diaries inspect
 * the `status` field, so a content edit carrying no status passes for crew and
 * only the transition is refused. This predicate decides one control's
 * visibility; it does not decide whether a crew member may open the diary
 * screen, and the screen must stay fully usable for them.
 */
export function canApproveDiary(companyRole: unknown): boolean {
  return isManagerOrAbove(companyRole);
}

/**
 * Voiding an inspection signature: manager and above. AUDIT L91.
 *
 * The asymmetry with signing is the point. Crew inspect and crew sign what they
 * inspected, so there is no `canSignInspection` here and there must not be one.
 * Voiding is the retraction of that claim on a document retained for seven
 * years, and until the gate this predicate mirrors existed, any crew member
 * with a login could retract any signature on any inspection in their company.
 *
 * This hides one control. The server is what refuses — POST
 * /inspections/:id/signatures/:sigId/void is requireAtLeast("manager") in
 * routes/inspections.ts — and the rest of the inspections screen, signing
 * included, stays fully usable for crew.
 */
export function canVoidSignature(companyRole: unknown): boolean {
  return isManagerOrAbove(companyRole);
}

/**
 * Company settings: branding, NZBN, contact details, anything
 * organisation-level. Exception 3, and the only one that is owner-only rather
 * than manager+, because that is what the API already enforces
 * (routes/company.ts PATCH /company/profile is requireCompanyRole("owner")).
 */
export function canChangeCompanySettings(companyRole: unknown): boolean {
  return isRole(companyRole, "owner");
}

// ── What a 403 means on the client ───────────────────────────────────────────

/**
 * The words a person reads when the server refuses on authorisation.
 *
 * A 403 is not a dead session and it is not a feature failure. It means "you
 * are who you say you are, and you may not do this" — so neither of the two
 * messages the app already had is true for it. "Your session has expired"
 * would sign someone out for touching a manager-only screen, which is a worse
 * bug than the one it would be imitating; "Failed to load" is the habit AUDIT
 * L73 named, a failure reported as something it was not.
 *
 * One sentence, true, and finishable: there is nothing the person can do about
 * it and the message does not pretend otherwise or invite a retry.
 */
export const FORBIDDEN_MESSAGE = "You don't have access to this.";

/**
 * Whether a caught value is an authorisation refusal.
 *
 * Shape-checked rather than `instanceof`, matching isSessionExpired() in
 * lib/session.ts: authedJson throws a plain Error carrying `status`, and the
 * pre-existing helpers in lib/data-context.tsx do too.
 *
 * Deliberately keyed on the STATUS ALONE. Unlike a 401, a 403 from this API
 * means one thing — middleware/auth.ts answers it from requireAtLeast and
 * requireCompanyRole only — so there is no second cause to discriminate, and
 * inventing a code to match would be a contract the server does not have.
 */
export function isForbidden(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  return (err as { status?: unknown }).status === 403;
}

/**
 * The message to show for a caught error, given what the feature would
 * otherwise have said. A 403 gets the truth; everything else keeps the
 * feature's own wording, which is correct for a feature failure.
 *
 * A session failure is NOT handled here: lib/authed-fetch.ts converts a 401 to
 * SessionExpiredError before a call site sees it, and the handler navigates.
 */
export function describeFailure(err: unknown, featureMessage: string): string {
  return isForbidden(err) ? FORBIDDEN_MESSAGE : featureMessage;
}
