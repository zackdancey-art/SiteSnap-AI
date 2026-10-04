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
  /**
   * When this RECORD was created — not when the photograph was taken.
   *
   * It has always meant this, and every photograph already stored means this by
   * it, so the meaning is left alone. `capturedAt` below is the separate field
   * that answers "when was this taken", because conflating the two is how a
   * record ends up asserting a capture time it never had.
   */
  timestamp: string;
  /**
   * When the photograph was actually taken, ISO-8601, or ABSENT when that is
   * not known.
   *
   * Absent is a real and expected state — a screenshot, a download, an image
   * that has been through a messaging app. It must never be filled in with the
   * time of selection: a photograph in an evidence record dated today that was
   * taken last week is a false record. Read `captureTimeSource` alongside it.
   */
  capturedAt?: string;
  /**
   * How `capturedAt` was established, so a reader can tell a known capture time
   * from an unknown one without inferring it from a missing field.
   *
   * - `camera`  — photographed in the app; the shutter time is the capture time.
   * - `exif`    — read from the file's own `DateTimeOriginal`.
   * - `unknown` — chosen from the gallery and carrying no readable date.
   *
   * Absent on records created before this field existed, which is a fourth
   * state and not the same as `unknown`: those photographs may or may not have
   * a recoverable capture time, and nothing has established which.
   */
  captureTimeSource?: "camera" | "exif" | "unknown";
  /**
   * Lowercase hex SHA-256 of the bytes that were uploaded.
   *
   * Computed over `manipulateAsync`'s OUTPUT — the file that is actually sent —
   * so it can be verified against the stored object. A hash of the picked
   * asset would describe a file that never reaches the server.
   */
  contentSha256?: string;
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
