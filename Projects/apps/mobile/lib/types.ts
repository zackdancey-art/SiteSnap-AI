export interface Site {
  id: string;
  name: string;
  address: string;
  client: string;
  startDate: string;
  status: "active" | "completed" | "on-hold";
  createdAt: string;
}

export interface AnnotationStroke {
  path: string;
  color: string;
  width: number;
}

export interface AnnotationVector {
  viewBox: string;
  strokes: AnnotationStroke[];
}

export interface Photo {
  id: string;
  uri: string;
  caption: string;
  timestamp: string;
  base64?: string;
  mimeType?: string;
  storagePath?: string;
  storageKey?: string;
  latitude?: number;
  longitude?: number;
  kind?: "original" | "annotated";
  derivedFromId?: string;
  annotationVector?: AnnotationVector;
}

export interface HourlyNote {
  hour: number;
  note: string;
}

export interface DailyEntry {
  id: string;
  siteId: string;
  date: string;
  locationAddress?: string;
  weather: string;
  crewCount: string;
  notes: string;
  photos: Photo[];
  timeCode?: string;
  hoursWorked?: string;
  createdAt?: string;
  timestamp: string;
  isPending?: boolean;
  notesMode?: "free" | "hourly";
  hourlyNotes?: HourlyNote[];
}

export interface DiaryEditLogEntry {
  at: string;
  action: "approved" | "reverted" | "edited";
  by?: string;
  note?: string;
}

export interface GeneratedDiary {
  id: string;
  siteId: string;
  generatedAt: string;
  status: "draft" | "approved";
  summary: string;
  reportPeriod?: "daily" | "weekly" | "monthly";
  fullReport?: string;
  safetyChecklist?: string[];
  sections: DiarySection[];
  editLog?: DiaryEditLogEntry[];
  /** Which generator wrote this report. Absent/null means unknown — never assume. */
  generation?: DiaryGeneration | null;
}

export interface DiaryGeneration {
  generator: "openai" | "fallback";
  model: string | null;
  promptVersion: string;
  /** Why the run was degraded. Null on a clean AI run. */
  warning: string | null;
  generatedAtMs: number;
  tokenUsage: { input: number; output: number } | null;
  /**
   * Server-minted HMAC, present only in transit from /generate-diary to the
   * save request. It is what makes the record unforgeable; the API verifies it
   * and stores the record without it.
   */
  signature?: string;
}

export interface DiarySection {
  date: string;
  weather: string;
  crewCount: string;
  workCompleted: string;
  safetyObservations: string;
  materialsUsed: string;
  issues: string;
  photoAnalysis: string;
}

// Backwards-compatible alias expected by some modules
export type Entry = DailyEntry;

export interface SiteTemplate {
  id: string;
  ownerEmail: string;
  siteId: string;
  name: string;
  weather: string;
  crewCount: string;
  notesTemplate: string;
  createdAt: string;
}

export interface SiteMember {
  siteId: string;
  memberEmail: string;
  role: "worker" | "supervisor" | "admin";
  invitedBy: string;
  joinedAt: string;
}

export interface InviteResult {
  email: string;
  status: "sent" | "resent" | "already_member";
}
