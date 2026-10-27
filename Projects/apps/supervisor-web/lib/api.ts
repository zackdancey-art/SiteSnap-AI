import type { DiaryGeneration } from "./provenance";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type User = { email: string; name: string; role: string; companyId?: string; companyRole?: string };
/**
 * `client` is free text and `clientId` is the filing; both are real and they
 * are not the same thing. Nothing backfills `client` on a pre-032 row, filing
 * overwrites it with the canonical client name, and unfiling keeps it — so a
 * site can carry a label whose client no longer exists, or a stale label for a
 * client since renamed. The clients list is the current truth; the label is
 * what the site itself remembers. `undefined` and `null` both mean unfiled.
 */
export type Site = {
  id: string;
  name: string;
  client: string;
  clientId?: string | null;
  address: string;
  status: string;
  startDate?: string;
};
export type EntryPhoto = { uri: string; caption?: string };
/**
 * A diary entry as `/api/projects/bootstrap` already sends it.
 *
 * `ownerEmail`, `timestamp` and `locationAddress` are not new fields and no
 * endpoint changed to provide them: `getScopedBootstrap` returns whole
 * `EntryRecord`s, and the portal's type was simply narrower than the payload.
 * They are optional here because the in-memory fallback store and older rows
 * cannot all be relied on to carry them, not because the server might omit the
 * key.
 */
export type Entry = {
  id: string; siteId: string; date: string; notes: string;
  weather?: string; crewCount?: string; photos?: EntryPhoto[];
  /** The account that logged the entry. The portal has no name lookup, so this is shown as-is. */
  ownerEmail?: string;
  /** When it was logged, as opposed to the work date it is filed under. */
  timestamp?: string;
  locationAddress?: string;
};
export type DiarySection = {
  date?: string; weather?: string; crewCount?: string;
  workCompleted?: string; safetyObservations?: string;
  materialsUsed?: string; issues?: string; photoAnalysis?: string;
};

export type Diary = {
  id: string; siteId: string; status: string; generatedAt: string;
  reportPeriod?: string; summary?: string;
  fullReport?: string; sections?: DiarySection[];
  safetyChecklist?: string[];
  signedBy?: string; signedAt?: string;
  /** Which generator wrote this diary; null/absent means unknown. See lib/provenance.ts. */
  generation?: DiaryGeneration | null;
};

export interface BootstrapData {
  sites: Site[];
  entries: Entry[];
  diaries: Diary[];
}

// Auth token is stored in an httpOnly cookie set by the API — JavaScript cannot
// read it, which eliminates XSS token theft.  User profile info (non-secret) is
// kept in localStorage for display purposes only.

export function getSavedUser(): User | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("sitesnap.user");
    return raw ? (JSON.parse(raw) as User) : null;
  } catch { return null; }
}

export function saveUser(user: User) {
  localStorage.setItem("sitesnap.user", JSON.stringify(user));
}

function clearLocalSession() {
  localStorage.removeItem("sitesnap.user");
}

/** @deprecated Token is now stored in an httpOnly cookie. Kept for callers that
 *  haven't migrated yet; does nothing meaningful in the cookie model. */
export function saveToken(_token: string) { /* no-op — cookie is set by API */ }

/** @deprecated Use logout() for async cookie clearing. Kept for sync callers. */
export function clearToken() { clearLocalSession(); }

export function isAuthenticated(): boolean {
  return !!getSavedUser();
}

/**
 * The `code` values on a 401 that mean the SESSION is over.
 *
 * A 401 does not mean one thing, and keying a sign-out off the status alone is
 * a defect. POST /api/auth/change-password answers 401 for a mistyped CURRENT
 * password: an authenticated request, a live session, a wrong value in the
 * body. This file used to clear local state and send the browser to `/` for
 * that — signing someone out of the portal, losing whatever they had open,
 * because they fat-fingered their own password into a form.
 *
 * The API discriminates (services/api/src/middleware/auth.ts, AUTH_ERROR_CODES)
 * and this is the portal's half of that contract. The mobile client holds the
 * same list in apps/mobile/lib/session.ts; the three cannot be a shared
 * constant because @sitesnap/shared emits types only, so they are kept in step
 * by name and by this comment.
 */
const SESSION_ERROR_CODES: readonly string[] = ["session_expired", "no_credential"];

/**
 * An ABSENT or non-string code reads as a session failure, deliberately, and
 * for the same reason as on mobile. Every 401 in this API was session-shaped
 * before the codes existed, the portal can be newer than the deployed API (a
 * Vercel deploy and a Render deploy are not atomic), and a session the portal
 * wrongly believes is dead costs one sign-in — while one it wrongly believes
 * is live costs a user staring at a page that silently does nothing. Fail
 * towards sign-in.
 */
function isSessionErrorCode(code: unknown): boolean {
  if (typeof code !== "string" || code === "") return true;
  return SESSION_ERROR_CODES.includes(code);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    credentials: "include", // sends the httpOnly session cookie on every request
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    // Read the body ONCE, before branching: a Response body cannot be consumed
    // twice, and the 401 branch now needs the `code` out of it.
    const text = await res.text();
    let parsed: { error?: string; code?: string } = {};
    try { parsed = JSON.parse(text) as { error?: string; code?: string }; } catch { /* not JSON */ }
    if (res.status === 401 && isSessionErrorCode(parsed.code)) {
      clearLocalSession();
      window.location.href = "/";
      throw new Error("Unauthorized");
    }
    /**
     * The STATUS and the code ride out on the error, not just the prose.
     *
     * This was a bare `new Error(message)`, which left a caller that needs to
     * tell one refusal from another with nothing to branch on but the wording —
     * and app/invite.tsx did exactly that, matching on tokens no response body
     * ever contained, so it picked its message by accident. The clients page
     * needs the 409 specifically (a duplicate client name), and asking for it
     * by status is the only way that stays correct when the wording changes.
     */
    const err = new Error(parsed.error || text || `Request failed (${res.status})`) as Error & {
      status?: number;
      code?: string;
    };
    err.status = res.status;
    if (parsed.code) err.code = parsed.code;
    throw err;
  }
  return res.json() as Promise<T>;
}

/**
 * The same call, for a page nobody is signed in on yet.
 *
 * `request` above treats 401 as "your session died": it clears local state and
 * sends the browser to `/`. On the invitation and signup pages that is exactly
 * wrong — nobody has a session yet, 401 is an ordinary answer, and the redirect
 * would throw away the `?token=` in the URL on its way out, stranding the
 * invitee on the sign-in page with the invitation gone and no way back to it
 * but the original email. So these routes get a helper that reports the status
 * and navigates nowhere.
 *
 * It still sends credentials, because /projects/invites/accept is called with
 * the session cookie once sign-in has happened on the same page.
 */
async function publicRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { msg = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* */ }
    throw new Error(msg || `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

/**
 * Registration, in the three steps the API requires: start, confirm the email
 * code, then confirm the SMS code. `inviteToken` goes on the LAST call, which
 * is where routes/auth.ts reads it — passing it earlier does nothing, and
 * omitting it makes the new account the owner of its own empty company instead
 * of a member of the one that invited them.
 */
export async function registerStart(payload: {
  email: string; phone: string; fullName: string; password: string;
}): Promise<{ devCodes?: { emailCode: string } }> {
  return publicRequest("POST", "/api/auth/register", payload);
}

export async function registerVerifyEmail(email: string, emailCode: string): Promise<{ devCodes?: { smsCode: string } }> {
  return publicRequest("POST", "/api/auth/register/verify-email", { email, emailCode });
}

export async function registerVerify(
  email: string, smsCode: string, inviteToken?: string
): Promise<{ token: string; user: User }> {
  return publicRequest("POST", "/api/auth/register/verify", {
    email, smsCode, ...(inviteToken ? { inviteToken } : {}),
  });
}

export type AcceptedInvite = {
  siteId: string | null;
  siteName: string | null;
  role: string;
  companyId?: string;
  companyRole?: string;
};

/**
 * Accept an invitation as the signed-in user.
 *
 * `siteId`/`siteName` are null for a company invitation, which carries no site.
 * Requires a session: the API reads the cookie, and the caller must have signed
 * in or registered first.
 */
export async function acceptInvite(token: string): Promise<AcceptedInvite> {
  return publicRequest("POST", "/api/projects/invites/accept", { token });
}

export async function login(email: string, password: string): Promise<{ token: string; user: User }> {
  const data = await request<{ token: string; user: User }>("POST", "/api/auth/login", { email, password });
  // API sets the httpOnly session cookie; we only persist display info locally.
  saveUser(data.user);
  return data;
}

export async function fetchBootstrap(): Promise<BootstrapData> {
  return request<BootstrapData>("GET", "/api/projects/bootstrap");
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await request<{ ok: boolean }>("POST", "/api/auth/change-password", { currentPassword, newPassword });
}

export async function revokeAllSessions(): Promise<void> {
  await request<{ token: string }>("POST", "/api/auth/revoke-all");
  // API rotates the session cookie; no client-side token to update.
}

export async function forgotPassword(identifier: string): Promise<void> {
  await request<{ ok: boolean }>("POST", "/api/auth/forgot-password", { identifier, channel: "email" });
}

// Account-scoped personal settings (migration 028). Persist per-account via the API
// (not localStorage), so they follow the user across devices. Only personal groups
// live here — timezone and the live-map thresholds are company-level and stay local
// until they get a company home.
export type AccountSettings = {
  notifs?: Partial<{ weeklyDigest: boolean; approvalAlerts: boolean; newEntryAlerts: boolean; incidentAlerts: boolean; pushEnabled: boolean }>;
  display?: Partial<{ dateFormat: "dd/mm/yyyy" | "mm/dd/yyyy" | "yyyy-mm-dd"; defaultPeriod: "daily" | "weekly" | "monthly"; compactTables: boolean }>;
  export?: Partial<{ defaultFormat: "pdf" | "word" | "html" | "csv"; includePhotos: boolean; includeSafetyChecklist: boolean; includeSignature: boolean }>;
};

export async function getAccountSettings(): Promise<AccountSettings> {
  const { settings } = await request<{ settings: AccountSettings }>("GET", "/api/account/settings");
  return settings ?? {};
}

export async function updateAccountSettings(patch: AccountSettings): Promise<AccountSettings> {
  const { settings } = await request<{ settings: AccountSettings }>("PATCH", "/api/account/settings", patch);
  return settings ?? {};
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  await request<{ ok: boolean }>("POST", "/api/auth/reset-password", { token, newPassword });
}

/**
 * What a sign-out now does, in one place so three call sites cannot disagree.
 *
 * HALF-BUILT-MECHANISMS F5: `/auth/logout` used to clear the cookie and revoke
 * nothing. It now increments the account's token generation, which is the only
 * revocation mechanism this product has and is per ACCOUNT rather than per
 * session — so signing out here also signs out the phone. That is wider than
 * anybody would assume from a button labelled "Sign Out", so it is said out
 * loud before it happens rather than discovered on a site.
 */
export const SIGN_OUT_SCOPE_NOTICE =
  "This signs you out on every device using this account. Continue?";

export async function logout() {
  try { await request<{ ok: boolean }>("POST", "/api/auth/logout"); } catch { /* best-effort */ }
  clearLocalSession();
}

/**
 * A crew timecard, with the four approval columns the API has sent since
 * migration 033.
 *
 * `approvalStatus` is typed as the string it arrives as and NOT as
 * `TimecardApprovalStatus`. The server is free to learn a fourth state before
 * this portal is redeployed, and typing the field as the union would let every
 * reader assume a value the wire cannot promise. `normaliseApprovalStatus` in
 * `lib/timecard-approval.ts` is the only thing that should read it.
 *
 * All four are optional because the list endpoint is also served by an older
 * API during a deploy: a card with no approval fields is a pending card, which
 * is what the normaliser answers for `undefined`.
 */
export type Timecard = {
  id: string; workerName: string; date: string; trade: string;
  startTime?: string; endTime?: string; breakMinutes?: number;
  hoursRegular: number; hoursOvertime: number; notes: string;
  approvalStatus?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  approvalNote?: string | null;
};
export type Incident = {
  id: string; siteId: string; date: string; severity: string;
  description: string; injuredParty?: string; correctiveAction?: string; status: string;
};
export type Inspection = {
  id: string; siteId: string; date: string; score?: number;
  status: string; results?: { item: string; passed: boolean | null; notes?: string }[];
  notes?: string;
};
export type Delivery = {
  id: string; siteId: string; date: string; supplier?: string;
  items?: string[]; quantity?: string; notes?: string; status?: string;
};

export async function fetchTimecards(siteId: string): Promise<Timecard[]> {
  const data = await request<{ timecards: Timecard[] }>("GET", `/api/crew/timecards?siteId=${siteId}`);
  return data.timecards;
}

/**
 * Approve a timecard, send it back for correction, or reopen an approved one.
 *
 * THE NOTE IS SENT FROM HERE AND NOT FROM MOBILE, ON PURPOSE
 *
 * The API takes an optional `note` and the mobile screen never sends one — a
 * confirmation dialog on a phone has nowhere to type a reason, and it tells the
 * person so rather than pretending. The portal has a text field, so a send-back
 * from here carries why. That is the asymmetry working as intended: the
 * correction reason is the one thing a worker needs to act on, and it is written
 * where somebody has a keyboard.
 *
 * An EMPTY note is omitted rather than sent as "". The store treats a supplied
 * note as an overwrite and an absent one as "keep what is stored", so sending
 * "" when the manager typed nothing would erase the reason a card was sent back
 * at the moment it is approved — destroying the only record of the correction.
 * That is `setTimecardApproval`'s documented behaviour in crewStore.ts, not an
 * inference, and this is the call that depends on it.
 *
 * `status` is sent as a plain string: the union lives in
 * `lib/timecard-approval.ts`, which is a UI module, and `lib/api.ts` does not
 * import from the UI layer anywhere else. The route validates it with a Zod
 * enum and 400s anything else, so a typo here fails loudly rather than writing
 * a state nothing recognises.
 */
export async function setTimecardApproval(
  timecardId: string,
  status: string,
  note?: string
): Promise<Timecard> {
  const trimmed = note?.trim();
  const data = await request<{ timecard: Timecard }>(
    "POST",
    `/api/crew/timecards/${timecardId}/approval`,
    trimmed ? { status, note: trimmed } : { status }
  );
  return data.timecard;
}

export async function fetchIncidents(siteId: string): Promise<Incident[]> {
  const data = await request<{ incidents: Incident[] }>("GET", `/api/incidents?siteId=${siteId}`);
  return data.incidents;
}

export async function fetchInspections(siteId: string): Promise<Inspection[]> {
  const data = await request<{ inspections: Inspection[] }>("GET", `/api/inspections?siteId=${siteId}`);
  return data.inspections;
}

export async function fetchDeliveries(siteId: string): Promise<Delivery[]> {
  const data = await request<{ deliveries: Delivery[] }>("GET", `/api/deliveries?siteId=${siteId}`);
  return data.deliveries;
}

export async function approveDiary(diaryId: string): Promise<Diary> {
  const data = await request<{ diary: Diary }>("PATCH", `/api/projects/diaries/${diaryId}`, { status: "approved" });
  return data.diary;
}

/**
 * Ask the API to generate a diary for one site and period.
 *
 * SENDS `siteId` AND `period` AND NOTHING ELSE, and that is the fix for AUDIT
 * L45 rather than an omission.
 *
 * `/api/generate-diary` resolves its entries one of two ways
 * (`routes/ai.ts` → `resolveDiaryRequest`): if the request carries a non-empty
 * `entries` array it uses that array and never reads the store; otherwise it
 * loads the site and its entries itself. This portal was sending an `entries`
 * array built by hand with `photos: []` hardcoded — so it was taking the first
 * branch and displacing the server's own load, which is the one that supplies
 * the photographs. Every diary the portal generated was written from notes
 * alone, while the same endpoint called from the phone saw the images. The
 * mobile app's primary call sends `{ siteId, period }` too; this now matches it.
 *
 * Passing the photographs through instead would have been the smaller edit and
 * the worse one. Three things come back with the second branch that cannot be
 * had on the first:
 *
 *   - The photographs, with their `storageKey`s, mapped by the server's own
 *     code. The server then reads each image out of its own media store after
 *     checking the upload belongs to the caller's company (H7). A
 *     caller-supplied key is deliberately not trusted for that, so the client
 *     is the wrong place for this data to come from in any case.
 *   - The site record. With a client `entries` array the server resolves
 *     `site: body.site || {}`, and this portal never sent a `site` object — so
 *     the generated report's header and the model's prompt both had no site
 *     name, client or address. Reports generated from the office were
 *     unidentified.
 *   - No fifty-entry cap. `entries` on the request schema is
 *     `.max(50)`; the server's own load has no such limit. A monthly report on
 *     a busy site was silently truncated by a number the portal never saw.
 *
 * The caller still needs its own entry list for the "no entries to report on"
 * pre-check — hence the parameter staying — but it is a guard, not a payload.
 *
 * `generation` rides along in the response so the preview and the exports can
 * mark the diary honestly even before it is persisted.
 */
export async function generateDiary(payload: { siteId: string; period: string }): Promise<Diary> {
  const data = await request<{ success: boolean; diary: Diary; generation?: DiaryGeneration | null }>("POST", `/api/generate-diary`, {
    siteId: payload.siteId,
    period: payload.period,
  });
  return { ...data.diary, generation: data.generation ?? null };
}

/**
 * One path's result from `/api/uploads/sign`.
 *
 * `error` is the field this type used to drop. The server distinguishes two
 * refusals per path — `"Invalid upload path."` for something that is not a
 * managed `/api/uploads/<id>/<name>` address, and `"Not found."` for one whose
 * upload row does not belong to the caller's company (deliberately the same
 * answer for a missing file and another tenant's, so existence is not
 * confirmed). Discarding it left the portal unable to say anything beyond a
 * grey square that reads "Loading…" forever (AUDIT L43).
 */
export type SignedUploadPath = { path: string; url: string | null; error?: string };

export async function signUploadPaths(paths: string[]): Promise<SignedUploadPath[]> {
  const data = await request<{ signed: SignedUploadPath[] }>("POST", "/api/uploads/sign", { paths });
  return data.signed;
}

// ── Company ────────────────────────────────────────────────────────────────────

export type CompanyProfile = { id: string; name: string; country?: string; ownerEmail: string; status: string };
export type CompanyMember = { email: string; name: string; companyRole: string };

export async function fetchCompanyProfile(): Promise<CompanyProfile> {
  const data = await request<{ company: CompanyProfile }>("GET", "/api/company/profile");
  return data.company;
}

export async function updateCompanyProfile(patch: { name?: string; country?: string }): Promise<CompanyProfile> {
  const data = await request<{ company: CompanyProfile }>("PATCH", "/api/company/profile", patch);
  return data.company;
}

export async function listCompanyMembers(): Promise<CompanyMember[]> {
  const data = await request<{ members: CompanyMember[] }>("GET", "/api/company/members");
  return data.members;
}

/**
 * One result per address from POST /company/members/invite.
 *
 * The route reports four outcomes and two separate steps, and this type used to
 * flatten both: `status` was typed `string`, which let the Team page print the
 * raw enum at the reader, and `delivered` was not declared at all.
 *
 * `delivered` is the step that matters. The route creates the invitation row
 * first and emails it second, and says so separately — `status: "sent"` with
 * `delivered: false` means the invitation exists and no email went out. With
 * the field dropped, the page showed a green tick either way, so an invitation
 * nobody could have received read as sent.
 *
 * The route also returns the bearer `token` when delivery failed. It is
 * deliberately NOT declared here: it grants company membership, and nothing on
 * this surface should be able to render it by accident.
 */
export type CompanyInviteResult = {
  email: string;
  status: "sent" | "resent" | "already_member" | "error";
  /** Absent on `already_member` and `error` — neither sends an email. */
  delivered?: boolean;
  deliveryError?: string;
};

export async function inviteCompanyMembers(emails: string[], companyRole: string): Promise<{ results: CompanyInviteResult[] }> {
  return request<{ results: CompanyInviteResult[] }>("POST", "/api/company/members/invite", { emails, companyRole });
}

/**
 * A company invitation that has been sent and not yet accepted.
 *
 * Mirrors `CompanyInviteSummary` in the API's projectsStore. There is no token
 * on it, by design: `GET /company/invites` does not return one.
 */
export type CompanyInviteSummary = {
  id: string;
  invitedEmail: string;
  companyRole: string | null;
  invitedBy: string;
  createdAt: string;
  expiresAt: string;
  state: "pending" | "expired";
};

/**
 * What has been sent and not yet accepted. Manager and above, matching
 * `listCompanyMembers` — a manager who cannot see a pending invitation issues
 * a duplicate.
 */
export async function listCompanyInvites(): Promise<CompanyInviteSummary[]> {
  const data = await request<{ invites: CompanyInviteSummary[] }>("GET", "/api/company/invites");
  return data.invites;
}

export async function updateMemberRole(email: string, companyRole: string): Promise<void> {
  await request<unknown>("PATCH", `/api/company/members/${encodeURIComponent(email)}/role`, { companyRole });
}

export async function removeCompanyMember(email: string): Promise<void> {
  await request<unknown>("DELETE", `/api/company/members/${encodeURIComponent(email)}`);
}

// ───────────────────────────────────────────────────────────────────────────
//  CLIENTS. FILING, NOT AN ACCESS BOUNDARY.
// ───────────────────────────────────────────────────────────────────────────
//
// A client groups sites for filing and reporting. It is deliberately NOT a
// permission scope: recordScope.ts on the API has no `client` record kind, and
// nothing anywhere decides who may read a site by looking at its client. Two
// levels only — clients hold sites, sites hold everything else.
//
// GET is behind identity rather than rank, because the grouped sites list takes
// its headings from it. The three writes are requireAtLeast("manager").

export type Client = {
  id: string;
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  /** Sites currently filed under this client. Server-computed; never sent. */
  siteCount: number;
};

/** The five writable fields. Spelled out rather than derived from `Client`, so
 *  `siteCount` cannot be written from the browser even by accident. */
export type ClientInput = {
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
};

export async function listClients(): Promise<Client[]> {
  const data = await request<{ clients: Client[] }>("GET", "/api/clients");
  return data.clients;
}

export async function createClient(input: ClientInput): Promise<Client> {
  const data = await request<{ client: Client }>("POST", "/api/clients", input);
  return data.client;
}

/**
 * PATCH does NOT return siteCount — the route answers `{ client }` with the
 * record only. The caller carries the previous count over; an `undefined`
 * there is what would make the delete confirmation misstate how many sites
 * are about to be unfiled.
 */
export async function updateClient(
  id: string,
  patch: Partial<ClientInput>
): Promise<Omit<Client, "siteCount">> {
  const data = await request<{ client: Omit<Client, "siteCount"> }>(
    "PATCH",
    `/api/clients/${id}`,
    patch
  );
  return data.client;
}

/**
 * Deleting a client UNFILES its sites and deletes none of them. Returns how
 * many were unfiled, which is the server's count rather than the caller's
 * prediction — they disagree whenever another session filed a site in between.
 */
export async function deleteClient(id: string): Promise<number> {
  const data = await request<{ ok: boolean; unfiledSites: number }>(
    "DELETE",
    `/api/clients/${id}`
  );
  return data.unfiledSites;
}

/** File a site under a client, or pass null to unfile it. Returns the site as
 *  the server now has it, because filing rewrites its `client` label. */
export async function fileSiteUnderClient(
  siteId: string,
  clientId: string | null
): Promise<Site> {
  const data = await request<{ site: Site }>("PATCH", `/api/projects/sites/${siteId}`, {
    clientId,
  });
  return data.site;
}
