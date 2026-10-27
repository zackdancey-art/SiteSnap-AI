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
 * Plus two refusals that are narrower than a feature, both of them the same
 * shape: crew may edit a diary and may not APPROVE one (canApproveDiary), and
 * crew may enter, correct and delete their own timecards and may not APPROVE
 * one (canApproveTimesheet). Read the notes on those two before reaching for
 * either — the hazard in both is implementing them as "crew cannot use diaries"
 * or "crew cannot use timesheets", which is a worse bug than the one it fixes.
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
 * TWO KINDS OF DECISION LIVE HERE, AND THEY ARE NOT THE SAME KIND
 * Everything above is keyed on a company ROLE. Below FORBIDDEN_MESSAGE there
 * is a second kind, keyed on a ROW'S STATE: an approved timecard is closed to
 * everybody, including the manager who approved it, and no rank opens it. They
 * sit in one module because one screen has to tell them apart to say anything
 * true to the person it refuses, and because both are decisions rather than
 * rendering — which is what makes them testable here and nowhere else.
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
 * Creating, renaming or deleting a CLIENT. Manager+, matching the three write
 * routes on routes/clients.ts, which all carry requireAtLeast("manager").
 *
 * READING the client list is NOT gated and must not be: that route is behind
 * identity alone, deliberately, because the site a crew member is standing on
 * is filed under one of these names. So a screen may list clients for anybody
 * signed in; this predicate decides only whether it offers the add, edit and
 * delete controls.
 *
 * Note what deleting a client does, since the control this gates is the one
 * that triggers it: it UNFILES the client's sites and deletes none of them.
 * That is why this is manager+ rather than owner-only — it is a filing change,
 * not a data loss — and the number of sites affected is quoted in the
 * confirmation from the list route's `siteCount`.
 */
export function canManageClients(companyRole: unknown): boolean {
  return isManagerOrAbove(companyRole);
}

/**
 * Filing a site under a client, or unfiling it. Manager+, matching
 * PATCH /projects/sites/:id.
 *
 * Separate from canManageClients even though both resolve the same way today,
 * because they are two different controls answering to two different routes on
 * two different routers — and if either gate moves, the one that moved is the
 * one that should change here. Clients are filing, not an access boundary, so
 * refusing this refuses a tidying operation and nothing a person can see.
 */
export function canFileSiteUnderClient(companyRole: unknown): boolean {
  return isManagerOrAbove(companyRole);
}

/**
 * APPROVING a timesheet. Manager+, and the same shape as canApproveDiary for
 * the same reason: a timecard a crew member approved themselves is a payroll
 * claim with no second pair of eyes on it, and the row carries `approved_by`
 * into a seven-year record.
 *
 * What this is NOT, again: it is not permission to USE timesheets. Crew enter,
 * correct and delete their own timecards in full — that is the daily work this
 * screen exists for — and the only thing this predicate hides is the
 * approve/send-back control on somebody's card.
 *
 * Two refusals on this screen are deliberately different things, and conflating
 * them is the mistake to avoid:
 *   - no rank  → 403, this predicate, requireAtLeast("manager") at the API;
 *   - approved → 409, isTimecardLocked below, and NO rank opens it. A manager
 *     cannot edit an approved card either; they reopen it first.
 * A manager approving their own timecard is allowed on purpose: refusing it
 * would leave a working manager unable to record hours at all, and
 * `approved_by` is what makes that auditable rather than invisible.
 */
export function canApproveTimesheet(companyRole: unknown): boolean {
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

// ── What a 409 on a timecard means on the client ────────────────────────

/**
 * The code services/api/src/routes/crew.ts sends with its 409 (see
 * sendWriteResult there). It is 409 and not 403 because the ROW's state is what
 * refuses, not the caller's rank — so the remedy is to reopen the card, not to
 * find somebody more senior, and the sentence a client shows has to say that.
 */
export const TIMECARD_LOCKED_CODE = "timecard_approved";

/**
 * Client-authored, like FORBIDDEN_MESSAGE, and for the same reason: the API's
 * own sentence is good, but a screen that renders server copy verbatim shows
 * whatever a future deploy decides to say there. This one has to stay true of
 * both of the editable statuses — a rejected card is still editable — so it
 * names approval, which is the only state that locks.
 */
export const TIMECARD_LOCKED_MESSAGE =
  "This timecard has been approved, so it can no longer be changed. Ask a manager to reopen it.";

/**
 * Whether a caught value is the approved-timecard refusal.
 *
 * Keyed on the status AND the code, unlike isForbidden, which is keyed on the
 * status alone. The asymmetry is not an inconsistency: a 403 from this API
 * means exactly one thing from exactly two middlewares, whereas 409 is the
 * ordinary conflict status and describeFailure is shared by every screen. So
 * matching a bare 409 here would relabel some other screen's future conflict
 * as an approved timecard. The code is a contract the server actually has.
 *
 * An absent code therefore reads as NOT locked and keeps the feature's own
 * wording — which is the honest answer for a client newer than the API,
 * because that API has no approval lock to have hit.
 */
export function isTimecardLocked(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: unknown; code?: unknown };
  return e.status === 409 && e.code === TIMECARD_LOCKED_CODE;
}

// ── What state a timecard is in ──────────────────────────────────────────────

/**
 * The approval states a timecard can be in, mirrored from the API's
 * TIMECARD_APPROVAL_STATUSES (services/api/src/storage/crewStore.ts).
 *
 * THIS IS A DELIBERATE COPY, NOT AN OVERSIGHT. apps/mobile has no dependency
 * on @sitesnap/shared — read its package.json — and that package emits .d.ts
 * only, so there is no runtime list for a client to import even if the
 * dependency existed, and adding one is out of scope (CLAUDE.md §8). The copy
 * is the only option available; normaliseApprovalStatus is what makes it safe
 * for the copy to fall out of date.
 *
 * It lives in this module rather than in app/crew/[siteId].tsx for the reason
 * the header gives: that screen imports react-native and the node test program
 * cannot compile it, so a constant placed there is a constant nothing checks.
 */
export const TIMECARD_APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type TimecardApprovalStatus = (typeof TIMECARD_APPROVAL_STATUSES)[number];

/**
 * The states whose card its author may still change. `approved` is absent and
 * that absence is the whole feature: an approved timecard is payroll, and a
 * payroll row anybody can still edit was never approved in any useful sense. A
 * manager wanting to correct one reopens it first, which records that they did.
 *
 * Mirrors TIMECARD_EDITABLE_STATUSES in the store, where it is enforced under
 * a row lock. This copy decides which controls a screen draws.
 */
export const TIMECARD_EDITABLE_STATUSES: readonly TimecardApprovalStatus[] = Object.freeze([
  "pending",
  "rejected",
]);

export function isTimecardEditable(status: TimecardApprovalStatus): boolean {
  return TIMECARD_EDITABLE_STATUSES.includes(status);
}

/**
 * Anything unrecognised reads as "pending", and the DIRECTION of that default
 * is chosen rather than convenient.
 *
 * Optimism costs one clear refusal: the edit control appears, the person
 * presses it, and the API answers 409, which isTimecardLocked turns into "ask
 * a manager to reopen it". Pessimism — reading an unknown status as locked —
 * would grey out edit and delete on every card the moment the API learns a
 * fourth status, with no error raised anywhere and no way for the person to
 * tell "this card is locked" from "this app is out of date". That breaks daily
 * work silently, which is the worse of the two failures.
 *
 * This is the opposite default from isRole() at the top of the file, and
 * deliberately so: there, being wrong shows somebody a control they may not
 * use, so unknown means least access. Here, being wrong hides a control from
 * the person whose own record it is, and the server refuses anyway.
 *
 * A missing field is the same case as an unknown one: an API older than this
 * build sends no approvalStatus at all, and nothing on that API is locked.
 */
export function normaliseApprovalStatus(value: unknown): TimecardApprovalStatus {
  return TIMECARD_APPROVAL_STATUSES.includes(value as TimecardApprovalStatus)
    ? (value as TimecardApprovalStatus)
    : "pending";
}

/**
 * The message to show for a caught error, given what the feature would
 * otherwise have said. A 403 gets the truth, an approved timecard gets the
 * remedy, and everything else keeps the feature's own wording, which is correct
 * for a feature failure.
 *
 * A session failure is NOT handled here: lib/authed-fetch.ts converts a 401 to
 * SessionExpiredError before a call site sees it, and the handler navigates.
 */
export function describeFailure(err: unknown, featureMessage: string): string {
  if (isForbidden(err)) return FORBIDDEN_MESSAGE;
  if (isTimecardLocked(err)) return TIMECARD_LOCKED_MESSAGE;
  return featureMessage;
}
