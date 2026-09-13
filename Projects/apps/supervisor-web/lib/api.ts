const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type User = { email: string; name: string; role: string; companyId?: string; companyRole?: string };
export type Site = { id: string; name: string; client: string; address: string; status: string; startDate?: string };
export type EntryPhoto = { uri: string; caption?: string };
export type Entry = { id: string; siteId: string; date: string; notes: string; weather?: string; crewCount?: string; photos?: EntryPhoto[] };
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

export async function generateDiary(payload: { siteId: string; period: string; entries: Entry[] }): Promise<Diary> {
  const data = await request<{ success: boolean; diary: Diary }>("POST", `/api/generate-diary`, {
    period: payload.period,
    entries: payload.entries.map((e) => ({
      date: e.date, notes: e.notes, weather: e.weather, crewCount: e.crewCount, photos: [],
    })),
    siteId: payload.siteId,
  });
  return data.diary;
}

export async function signUploadPaths(paths: string[]): Promise<{ path: string; url: string | null }[]> {
  const data = await request<{ signed: { path: string; url: string | null }[] }>("POST", "/api/uploads/sign", { paths });
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
