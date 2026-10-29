export interface Site {
  id: string;
  name: string;
  address: string;
  /**
   * The client's name as free text, and it STAYS free text.
   *
   * Every site created before clients existed has one of these and no
   * `clientId`, and nothing backfills them — so this is the only label the
   * grouped site list can rely on, and it is what the site card has always
   * rendered. When a site is filed, the API overwrites this with the client's
   * canonical name; when it is unfiled, the label is deliberately KEPT, so
   * unfiling never silently erases what somebody typed.
   */
  client: string;
  /**
   * Which client the site is filed under, or null for unfiled.
   *
   * Optional because the field arrived in migration 032 and a cached site from
   * an older build has no such key — `undefined` and `null` both mean unfiled,
   * which is why every read here goes through a `?? null`. It is NOT an access
   * boundary: filing changes how sites are grouped in a list and nothing about
   * who may read one. See services/api/src/storage/clientsStore.ts.
   */
  clientId?: string | null;
  /**
   * The contractor's own reference for the job, or "" for none.
   *
   * NOT optional, and not nullable, unlike `clientId` above. The column has
   * been `job_number TEXT NOT NULL DEFAULT ''` since migration 011, so the API
   * cannot return null for it and the store normalises a missing row value to
   * "" (`mapSite` in services/api/src/storage/projectsStore.ts). One spelling
   * of absence means every reader can call `.trim()` without a guard, and
   * `hasJobNumber` in lib/job-number.ts is the one place that decides what
   * counts as absent.
   *
   * It arrived in the schema long before anything read it: from migration 011
   * until PR 2 no store, route, schema or client touched the column, and this
   * screen's `Job #` line was rendered through a `(site as { jobNumber?:
   * string })` cast — which is exactly why the compiler never reported the
   * missing field. AUDIT L118. The cast is gone; a cached site from a build
   * older than PR 2 has no such key, so `formatJobNumber` and `hasJobNumber`
   * both take `string | null | undefined` rather than `string`.
   *
   * Free text and deliberately NOT unique: contractors reuse a job number
   * across sites, and the field is a reference, never an identity.
   */
  jobNumber: string;
  startDate: string;
  status: "active" | "completed" | "on-hold";
  createdAt: string;
}

/**
 * A client, as GET /clients returns it.
 *
 * `siteCount` is computed by that route from one GROUP BY, not stored — so it
 * is present on the list and on a create (as 0) and is the number the delete
 * confirmation quotes, because "this will unfile 4 sites" is the only thing
 * about deleting a client that a person needs to be warned about. Deleting a
 * client deletes no sites.
 */
export interface Client {
  id: string;
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
  createdAt: string;
  updatedAt: string;
  siteCount: number;
}

/**
 * A site in the bin, as `GET /projects/sites/bin` returns it.
 *
 * Separate from `Site` rather than two optional fields on it, because every
 * screen that renders a `Site` renders a CURRENT site, and a binned one must
 * not be assignable to those props. A deleted site appearing in the sites list
 * because the types allowed it is the failure this shape rules out.
 *
 * `daysInBin` and `retentionDays` are computed by the API, not here. Two clients
 * each doing their own date arithmetic against a server timestamp is how they
 * end up disagreeing about when something will be destroyed.
 */
export interface BinnedSite extends Site {
  deletedAt: string;
  daysInBin: number | null;
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
  /**
   * The account that drew the annotation, on an `annotated` derivative only.
   *
   * ABSENT is a real state and must not be filled in from the entry's author:
   * whoever annotated may be a manager marking up someone else's entry, so the
   * entry author is a different person from the annotator often enough that
   * substituting them would put a false name against a mark made on evidence.
   *
   * It is also self-asserted by the client, because the API stores this array
   * as opaque JSONB and does not parse it. The set of accounts that can write a
   * false value here is already the set that can edit the entry at all, so this
   * is strictly more provenance than the nothing it replaces — but it is an
   * attribution, not a verified identity, and the UI must not imply otherwise.
   */
  annotatedBy?: string;
}

export interface HourlyNote {
  hour: number;
  note: string;
}

export interface DailyEntry {
  id: string;
  siteId: string;
  date: string;
  /**
   * The account that logged the entry, as the API already returns it on every
   * entry in `/projects/bootstrap`. It was absent from this interface, so the
   * value arrived and was discarded unread.
   *
   * Optional because an entry created offline has not been assigned one yet.
   * It is who LOGGED the entry, not provably who took any photograph in it.
   */
  ownerEmail?: string;
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
