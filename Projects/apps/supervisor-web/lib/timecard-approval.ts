/**
 * A timecard's approval state, and what it closes.
 *
 * THIS IS NOT A ROLE DECISION, WHICH IS WHY IT IS NOT IN useRole.ts
 *
 * Everything in `useRole.ts` is keyed on who the viewer is. Everything here is
 * keyed on what state a row is in: an approved timecard is closed to everybody,
 * including the manager who approved it, and no rank reopens it except by
 * returning it to `pending` first. One screen has to tell those two kinds of
 * refusal apart to say anything true to the person it refuses — "you may not do
 * this" and "nobody may do this to this card" are different sentences — so they
 * are kept in different modules rather than blurred into one permission check.
 *
 * THE THIRD COPY OF THIS LIST, DELIBERATELY
 *
 * `services/api/src/storage/crewStore.ts` holds the authoritative list and
 * `apps/mobile/lib/permissions.ts` holds a second copy. Neither can be imported
 * here: `apps/supervisor-web` has no dependency on `@sitesnap/shared`, and
 * `@sitesnap/shared` carries types only, so it could not carry a runtime array
 * even if it were added (CLAUDE.md §8 forbids adding the dependency in passing).
 * So this is a copy by necessity, not by preference. If the API learns a fourth
 * status, three files change — and `normaliseApprovalStatus` below is what
 * decides how badly this one behaves in the window before it does.
 *
 * Mobile keeps its copy in `permissions.ts` alongside the role predicates
 * rather than in a module of its own. That is not a different judgement about
 * where this belongs: mobile's node test program cannot compile a file that
 * imports react-native, so the testable decisions were collected into the one
 * module that compiles. The portal has no such constraint.
 */
export const TIMECARD_APPROVAL_STATUSES = ["pending", "approved", "rejected"] as const;
export type TimecardApprovalStatus = (typeof TIMECARD_APPROVAL_STATUSES)[number];

/**
 * The states a timecard's own fields may still be changed in.
 *
 * Frozen, and read only through `isTimecardEditable` below. Nothing outside
 * this module asks whether a particular status is in the list, so the question
 * "may this card still be changed" has exactly one answer in the portal and
 * adding a fourth status means editing one line rather than auditing call sites
 * for comparisons against `"approved"`.
 */
export const TIMECARD_EDITABLE_STATUSES: readonly TimecardApprovalStatus[] = Object.freeze([
  "pending",
  "rejected",
]);

export function isTimecardEditable(status: TimecardApprovalStatus): boolean {
  return TIMECARD_EDITABLE_STATUSES.includes(status);
}

/**
 * Read a status off the wire, where it is a string this build may not know.
 *
 * An unrecognised value reads as `pending`, which is the OPTIMISTIC direction,
 * and the choice is deliberate. Optimism costs one clear refusal: the portal
 * offers Approve on a card the API has already put into some fourth state, the
 * API answers, and the manager reads a real message. Pessimism — reading an
 * unknown status as locked — would grey out the approval controls on every card
 * the moment the API learns a fourth status, with no error raised anywhere and
 * no way for the person to tell "this card is closed" from "this portal is out
 * of date". The portal is served fresh on every load so its window of
 * disagreement is short, but it is not zero: a long-lived tab outlives a deploy.
 *
 * This is the opposite default from `useRole.ts`, which refuses only roles it
 * recognises as crew or viewer and lets an unknown role through to the API.
 * Both land in the same place for the same reason — the API is the authority and
 * guessing in the client's favour produces an honest refusal rather than a
 * silent one.
 */
export function normaliseApprovalStatus(value: unknown): TimecardApprovalStatus {
  return TIMECARD_APPROVAL_STATUSES.includes(value as TimecardApprovalStatus)
    ? (value as TimecardApprovalStatus)
    : "pending";
}

/**
 * The 409 an approved card answers a write with.
 *
 * `services/api/src/routes/crew.ts` sends `code: "timecard_approved"` with the
 * 409. Matching on the code and not on the prose is the whole point of carrying
 * `code` out of `request()`: the server's wording is user-facing copy and will
 * be edited, and `app/invite.tsx` already demonstrated what happens to a client
 * that branches on wording — it matched tokens no response body contained and
 * chose its message by accident for months.
 */
export const TIMECARD_LOCKED_CODE = "timecard_approved";

/**
 * The longest note the approval route will accept.
 *
 * `TimecardApprovalSchema` in `services/api/src/routes/crew.ts` is
 * `z.string().max(2000)`, and this is a copy of that number for the same reason
 * the status list above is a copy — there is no module both sides can import.
 * It is here rather than inline in the page so that the one place to correct it
 * is next to the note the correction has to be read with.
 *
 * It is enforced as `maxLength` on the input, which stops the manager typing a
 * note the server will reject rather than letting them write 2,400 characters
 * and discover it on submit. The server is still the authority: a longer note
 * reaching it draws a 400 and `describeApprovalFailure` reports the message.
 */
export const TIMECARD_NOTE_MAX_LENGTH = 2000;

export const TIMECARD_LOCKED_MESSAGE =
  "This timecard has been approved, so it can no longer be changed. Reopen it first.";

/**
 * Whether a failed request failed because the card is closed.
 *
 * Status AND code, not status alone. A 409 is not reserved to this route — the
 * clients page gets one for a duplicate name — and a client that reads every
 * 409 as an approval lock would tell a manager their timecard was approved when
 * something else entirely refused them.
 */
export function isTimecardLocked(err: unknown): boolean {
  const e = err as { status?: number; code?: string } | null;
  return !!e && e.status === 409 && e.code === TIMECARD_LOCKED_CODE;
}

/**
 * What to put in front of the manager when a write fails.
 *
 * The portal's habit on this page is `catch (e) { console.error(e) }`, which
 * `useRole.ts` names as the least honest refusal the portal can give: the button
 * stops spinning and nothing is said. A lock gets its own sentence because it is
 * the one failure the manager can act on; everything else gets the server's
 * message if there is one, and the caller's fallback if there is not.
 */
export function describeApprovalFailure(err: unknown, fallback: string): string {
  if (isTimecardLocked(err)) return TIMECARD_LOCKED_MESSAGE;
  const message = err instanceof Error ? err.message.trim() : "";
  return message || fallback;
}
