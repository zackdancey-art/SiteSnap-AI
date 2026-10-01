/**
 * The one place the four company roles get their human-readable names.
 *
 * There were two vocabularies before this file. `app/team/page.tsx` labelled
 * `companyRole` as Owner / Manager / Viewer / Crew, while `ProfileDropdown`
 * rendered the DEPRECATED legacy `role` field uppercased — so the same person's
 * badge read "SUPERVISOR" in the header and "Manager" on the team page, two
 * words for one role in one session.
 *
 * These four are the app's existing words, not new ones: mobile's
 * `settings/account.tsx` capitalises `companyRole` directly, and the mobile
 * invite screens offer Manager / Viewer / Crew as chips. Web now reads from the
 * same four.
 *
 * Keyed on `companyRole`, never on `role` — CLAUDE.md §3: the legacy
 * worker/supervisor/admin role is deprecated and no new logic should key on it.
 * The legacy pair maps `admin → owner` and `supervisor → manager`
 * (`services/api/src/utils/authToken.ts`), which is why "admin" is not one of
 * these labels.
 */
export const COMPANY_ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  manager: "Manager",
  viewer: "Viewer",
  crew: "Crew",
};

/**
 * The role's display name, or `null` when there is nothing truthful to show.
 *
 * Returning null rather than a default matters: `companyRole` is optional on
 * `User`, and a badge that reads "Viewer" for a user whose role we do not know
 * is a statement about their permissions that we cannot support. Mobile's
 * `settings/account.tsx` already renders nothing in that case.
 */
export function companyRoleLabel(companyRole: string | null | undefined): string | null {
  if (!companyRole) return null;
  return COMPANY_ROLE_LABELS[companyRole] ?? null;
}
