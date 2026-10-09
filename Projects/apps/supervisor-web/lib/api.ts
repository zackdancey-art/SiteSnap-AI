import type { DiaryGeneration } from "./provenance";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type User = { email: string; name: string; role: string; companyId?: string; companyRole?: string };
export type Site = { id: string; name: string; client: string; address: string; status: string; startDate?: string };
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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    credentials: "include", // sends the httpOnly session cookie on every request
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    clearLocalSession();
    window.location.href = "/";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const text = await res.text();
    let msg = text;
    try { msg = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* */ }
    throw new Error(msg || `Request failed (${res.status})`);
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

export async function logout() {
  try { await request<{ ok: boolean }>("POST", "/api/auth/logout"); } catch { /* best-effort */ }
  clearLocalSession();
}

export type Timecard = {
  id: string; workerName: string; date: string; trade: string;
  startTime?: string; endTime?: string; breakMinutes?: number;
  hoursRegular: number; hoursOvertime: number; notes: string;
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

export async function inviteCompanyMembers(emails: string[], companyRole: string): Promise<{ results: { email: string; status: string }[] }> {
  return request<{ results: { email: string; status: string }[] }>("POST", "/api/company/members/invite", { emails, companyRole });
}

export async function updateMemberRole(email: string, companyRole: string): Promise<void> {
  await request<unknown>("PATCH", `/api/company/members/${encodeURIComponent(email)}/role`, { companyRole });
}

export async function removeCompanyMember(email: string): Promise<void> {
  await request<unknown>("DELETE", `/api/company/members/${encodeURIComponent(email)}`);
}
