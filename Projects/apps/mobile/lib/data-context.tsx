import React, { createContext, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  Site,
  Client,
  BinnedSite,
  Entry,
  GeneratedDiary,
  SiteTemplate,
  SiteMember,
  InviteResult,
} from "@/lib/types";
import { resolveApiBaseUrl } from "@/lib/api-base-url";
import { clientsAfterSiteBinned, clientsAfterSiteRefiled } from "@/lib/client-site-counts";
import { useAuth, isTokenExpiringSoon } from "@/lib/auth-context";
import { SessionExpiredError, notifySessionExpired } from "@/lib/session";
import {
  deletePhotoPayloads,
  hydrateEntriesWithPhotoPayloads,
  hydratePhotos,
  savePhotoPayloads,
  stripPhotoPayloads,
} from "@/lib/photo-payload-store";
import {
  enqueue,
  peekQueue,
  peekFailedQueue,
  dequeue,
  isNetworkError,
  markOpFailed,
  retryFailedOps,
  updateQueuedPayload,
  type QueuedOp,
} from "@/lib/offline-queue";
import { drainQueue } from "@/lib/offline-drain";
import { entrySyncStatesFromQueue, type EntrySyncStates } from "@/lib/entry-sync-state";
import { materializeQueuedPhoto } from "@/lib/photo-bytes";
import {
  canonicalUploadPathFromResponse,
  isManagedMediaUri,
  toCanonicalPath,
  toStorablePhotoUri,
  UploadAddressMissingError,
} from "@/lib/photo-uri";
import { reportMediaFailure } from "@/lib/media-telemetry";
import { reportSyncFailure } from "@/lib/sync-telemetry";

interface DataContextType {
  sites: Site[];
  /**
   * The company's clients, for filing sites under. Readable by every role —
   * GET /clients is behind identity, not rank, deliberately (see
   * lib/permissions.ts). Whether the WRITE controls are drawn is decided by
   * canManageClients / canFileSiteUnderClient, not by this list being empty.
   */
  clients: Client[];
  entries: Entry[];
  diaries: GeneratedDiary[];
  templates: SiteTemplate[];
  syncStatus: "idle" | "syncing" | "offline" | "error";
  lastSyncError: string | null;
  /** Ops waiting for coverage. */
  pendingCount: number;
  /**
   * Ops the server refused and the drain has given up on. AUDIT L30: these used
   * to be deleted, so this number and the list below it are the only way anyone
   * holding the phone can learn that work did not sync.
   */
  failedOps: QueuedOp[];
  /**
   * Per-entry sync state, keyed by entry id — AUDIT L37's remaining half. An
   * entry id ABSENT from this map has reached the server; see
   * lib/entry-sync-state.ts for why it is derived from the queue rather than
   * read off `Entry.isPending`, which is set once and never cleared.
   */
  entrySyncStates: EntrySyncStates;
  /** Hands failed ops back to the drain. Returns how many were queued again. */
  retryFailedSync: (ids?: string[]) => Promise<number>;
  addSite: (site: Omit<Site, "id" | "createdAt">) => Promise<void>;
  /**
   * Moves a site to the bin. Phase 6: this no longer destroys anything. The
   * site and every record under it stay in the database and can be restored
   * until the retention period runs out.
   */
  deleteSite: (id: string) => Promise<void>;
  /**
   * The four client calls, and ALL FOUR REQUIRE CONNECTIVITY. That is a
   * decision, not an omission.
   *
   * `lib/offline-queue.ts` has a closed union of five op types — addEntry,
   * updateEntry, deleteEntry, addSite, deleteSite — covering field capture,
   * which is what the queue exists for: a phone in a basement with photographs
   * on it. Filing is office work that can wait for coverage, and queuing it
   * would mean a client created offline has a local id that no site can be
   * filed against until the queue drains, which is a worse experience than
   * being told to try again with signal. A network failure therefore surfaces
   * to the caller, which shows it with describeFailure().
   */
  addClient: (input: ClientInput) => Promise<Client>;
  updateClient: (id: string, patch: Partial<ClientInput>) => Promise<Client>;
  /** Unfiles the client's sites and deletes none of them. Returns how many. */
  deleteClient: (id: string) => Promise<number>;
  /** File a site under a client, or pass null to unfile it. */
  fileSite: (siteId: string, clientId: string | null) => Promise<void>;
  /**
   * Set or clear a site's job number. The empty string CLEARS it; there is no
   * separate "clear" call, because "" is the only spelling of absence the
   * column has (`job_number TEXT NOT NULL DEFAULT ''`, migration 011).
   *
   * Online-only, like fileSite above and for the same reason: a job number
   * comes off a contract in the office, not off the site, and the offline
   * queue's op types are a closed set of five that this is deliberately not
   * joining. A failure surfaces to the caller as a refusal rather than a
   * pending op.
   */
  setSiteJobNumber: (siteId: string, jobNumber: string) => Promise<void>;

  /**
   * The sites in the bin, newest first, with the number of days each has been
   * there. Not held in state like `sites` is: a screen nobody has opened should
   * not be refetching, and a stale bin list is worse than no bin list when the
   * decision being made on it is whether something still exists.
   */
  listBinnedSites: () => Promise<{ sites: BinnedSite[]; retentionDays: number }>;
  /** Takes a site back out of the bin, and refreshes so its records reappear. */
  restoreSite: (id: string) => Promise<void>;
  addEntry: (
    entry: Omit<Entry, "id" | "timestamp" | "createdAt">,
    onProgress?: SaveProgressCallback
  ) => Promise<void>;
  updateEntry: (id: string, patch: Partial<Entry>, onProgress?: SaveProgressCallback) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  addDiary: (diary: Omit<GeneratedDiary, "id" | "generatedAt">) => GeneratedDiary;
  updateDiary: (id: string, patch: Partial<GeneratedDiary>) => void;
  getSite: (id?: string) => Site | undefined;
  getEntry: (id?: string) => Entry | undefined;
  getSiteEntries: (siteId?: string) => Entry[];
  getSiteDiaries: (siteId?: string) => GeneratedDiary[];
  getSiteTemplates: (siteId?: string) => SiteTemplate[];
  loading: boolean;
  refresh: () => Promise<void>;
  inviteCrewMembers: (siteId: string, emails: string[], role: string) => Promise<InviteResult[]>;
  inviteCompanyMembers: (emails: string[], companyRole: string) => Promise<CompanyInviteResult[]>;
  acceptInvite: (token: string) => Promise<{ siteId: string | null; siteName: string | null; role: string }>;
  getSiteMembers: (siteId: string) => Promise<SiteMember[]>;
  removeSiteMember: (siteId: string, memberEmail: string) => Promise<void>;
}

/**
 * One result per address from POST /company/members/invite.
 *
 * THE ROUTE HAS FOUR OUTCOMES, NOT TWO. This interface used to declare
 * `"sent" | "error"`, and `app/company-invite.tsx` renders anything that is not
 * `"sent"` with a red alert icon and the words "Failed to send" — so a
 * successful RE-send, which the route reports as `"resent"`, appeared on this
 * screen as a failure, and so did `"already_member"`, which is not a failure
 * either. That is the whole of the reported "I cannot send a second invitation
 * to an address I have already invited": the second invitation is created and
 * emailed, and the screen says it was not.
 *
 * `delivered` is the second half of the same problem. The route creates the
 * invitation row first and emails it second, and reports those two steps
 * separately: `status: "sent"` with `delivered: false` means the invitation
 * exists and the email did not go out. Dropping the field from this type made
 * that case indistinguishable from a delivered one.
 *
 * The route also returns the bearer `token` when delivery failed. It is
 * deliberately NOT declared here: it grants company membership, and nothing on
 * this screen should be able to render it by accident.
 */
export interface CompanyInviteResult {
  email: string;
  status: "sent" | "resent" | "already_member" | "error";
  /** Absent on `already_member` and `error` — neither sends an email. */
  delivered?: boolean;
  deliveryError?: string;
}

/**
 * What a client form sends. Deliberately NOT `Omit<Client, …>`: `siteCount` is
 * computed by the API from a GROUP BY and must never be writable from here,
 * and spelling the five fields out is what keeps it that way if Client grows a
 * field. Matches ClientSchema in services/api/src/routes/clients.ts, where
 * `name` is the only required one — a builder adding a client mid-job has the
 * name and nothing else to hand.
 */
export interface ClientInput {
  name: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
}

const DataContext = createContext<DataContextType | null>(null);
const SITES_KEY = "sitesnap.sites";
const CLIENTS_KEY = "sitesnap.clients";
const ENTRIES_KEY = "sitesnap.entries";
const DIARIES_KEY = "sitesnap.diaries";
const BASE_URL = resolveApiBaseUrl();

function normalizeEmailKey(email?: string | null) {
  return (email || "anonymous").trim().toLowerCase().replace(/[^a-z0-9@._-]+/g, "_");
}

function getCacheKeys(email?: string | null) {
  const scope = normalizeEmailKey(email);
  return {
    sites: `${SITES_KEY}:${scope}`,
    clients: `${CLIENTS_KEY}:${scope}`,
    entries: `${ENTRIES_KEY}:${scope}`,
    diaries: `${DIARIES_KEY}:${scope}`,
  };
}

function safeParseArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function getToken() {
  return AsyncStorage.getItem("sitesnap.token");
}

// Holds a reference to the auth context's refreshToken so apiJson can call it without prop-drilling
let _refreshTokenFn: (() => Promise<string | null>) | null = null;
export function _setRefreshTokenFn(fn: () => Promise<string | null>) {
  _refreshTokenFn = fn;
}

async function doFetch<T>(path: string, init: RequestInit | undefined, token: string | null): Promise<T> {
  const res = await fetch(`${BASE_URL}/api${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    if (res.status === 401) {
      // This branch has always existed, and has always thrown the word
      // "Unauthorized" into whichever feature asked - which is how a dead
      // session came to be reported as "couldn't save timesheet". The 401
      // status is preserved (apiJson below still branches on it) and the
      // message becomes the one the person should actually read.
      if (token) notifySessionExpired();
      throw new SessionExpiredError();
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = (await res.json()) as { error?: string; message?: string; code?: unknown };
      // The status, the code and the body ride along on the error.
      //
      // This line used to be a bare `throw new Error(payload.error || ...)`,
      // which discarded all three - and a caller that needs to tell one refusal
      // from another therefore had nothing to branch on but the prose. That is
      // literally what app/invite.tsx did (`msg.includes("wrong_user")`), and
      // the tokens it looked for are not in any response body, so the screen
      // picked its wording by accident. Matching authedJson, which carries the
      // same fields for the same reason.
      const err = new Error(payload.error || payload.message || `Request failed (${res.status})`) as Error & {
        status?: number;
        code?: string;
        body?: Record<string, unknown>;
      };
      err.status = res.status;
      if (typeof payload.code === "string") err.code = payload.code;
      err.body = payload as Record<string, unknown>;
      throw err;
    }
    const text = await res.text();
    if (text.trim().toLowerCase().startsWith("<!doctype html")) {
      throw new Error("API returned HTML instead of JSON. Check EXPO_PUBLIC_API_URL and backend port.");
    }
    throw new Error(text || `Request failed (${res.status})`);
  }
  const okContentType = res.headers.get("content-type") || "";
  if (!okContentType.includes("application/json")) {
    const text = await res.text();
    if (text.trim().toLowerCase().startsWith("<!doctype html")) {
      throw new Error("API returned HTML instead of JSON. Check EXPO_PUBLIC_API_URL and backend port.");
    }
    throw new Error("Unexpected response type from API.");
  }
  return res.json() as Promise<T>;
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  let token = await getToken();

  // Proactively refresh if the token expires within 1 hour
  if (token && isTokenExpiringSoon(token) && _refreshTokenFn) {
    const refreshed = await _refreshTokenFn();
    if (refreshed) token = refreshed;
  }

  try {
    return await doFetch<T>(path, init, token);
  } catch (err) {
    // One refresh-and-retry, kept because it genuinely rescues the narrow case
    // it was written for: a stored token the server rejects while a newer one
    // exists. It CANNOT rescue an EXPIRED token, and that is worth stating here
    // rather than rediscovering: `/api/auth/refresh` is itself mounted behind
    // requireAuth (routes/auth.ts), so the request that would mint a new token
    // is refused by the same check that refused the original. The recovery path
    // cannot work in the one situation it exists for. doFetch has already
    // raised the session notice by this point, so the failure is reported
    // correctly either way; the retry is left as it was because removing it
    // changes behaviour this commit has no evidence about.
    if (err instanceof Error && (err as Error & { status?: number }).status === 401 && _refreshTokenFn) {
      const refreshed = await _refreshTokenFn();
      if (refreshed) return doFetch<T>(path, init, refreshed);
    }
    throw err;
  }
}

async function uploadPhotoOnce(photo: Entry["photos"][number]) {
  // Already stored server-side? Then there is nothing to upload.
  //
  // This used to test `/^https?:\/\//` alone, which never matched: what we
  // store — and what the API returns — is the RELATIVE canonical path
  // `/api/uploads/<id>/<name>`. So every edit of an entry re-uploaded every
  // photo it already held, writing a byte-identical duplicate into S3 each
  // time (the bucket shows the same six images stored twice within one minute)
  // and orphaning the previous object, which is still referenced by nothing.
  if (isManagedMediaUri(photo.uri)) {
    return photo;
  }

  const token = await getToken();
  if (!token) {
    throw new Error("Authentication is required to upload photos.");
  }
  const form = new FormData();
  form.append("file", {
    uri: photo.uri,
    type: photo.mimeType || "image/jpeg",
    name: `${photo.id || Date.now()}.jpg`,
  } as unknown as Blob);

  const res = await fetch(`${BASE_URL}/api/uploads`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  });

  if (!res.ok) {
    if (res.status === 401) {
      notifySessionExpired();
      throw new SessionExpiredError();
    }
    const text = await res.text();
    throw new Error(text || `Photo upload failed (${res.status})`);
  }

  const payload = (await res.json()) as { url?: string; storagePath?: string; storageKey?: string };

  // A 200 carrying no address is not a success — see
  // `canonicalUploadPathFromResponse`. Reported from here rather than left to
  // the drain because this is where the cause is known: the server took the
  // bytes and did not name them. That is a different defect from an upload that
  // never arrived, and it is the only one that can leave behind a record
  // asserting it holds a photograph with no address for one.
  let canonicalPath: string;
  try {
    canonicalPath = canonicalUploadPathFromResponse(payload.url, photo.id);
  } catch (err) {
    reportSyncFailure({
      kind: "photo-upload-address-missing",
      photoId: photo.id,
      stage: "upload",
      cause: err,
    });
    throw err;
  }

  return {
    ...photo,
    uri: canonicalPath,
    storagePath: payload.storagePath,
    storageKey: payload.storageKey,
  };
}

async function uploadPhoto(photo: Entry["photos"][number]): Promise<Entry["photos"][number]> {
  const backoff = [1000, 2500, 5000];
  let lastErr: unknown;
  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    try {
      return await uploadPhotoOnce(photo);
    } catch (err) {
      lastErr = err;
      // Not transient, and retrying it costs more than it could win: every
      // attempt re-POSTs the same bytes and leaves another orphaned object in
      // the bucket. Fail now and let the op dead-letter.
      if (err instanceof UploadAddressMissingError) break;
      if (attempt < backoff.length) {
        await new Promise((r) => setTimeout(r, backoff[attempt]));
      }
    }
  }
  throw lastErr;
}

/**
 * The uploader the offline drain is given.
 *
 * It differs from `uploadPhoto` in one respect: the bytes come from wherever
 * they actually are. A photograph that has waited in the queue overnight may
 * no longer have a readable `uri` — see `lib/photo-bytes.ts` — so it is written
 * back out to a cache file first, and that file is deleted once the server has
 * taken the bytes.
 */
async function uploadQueuedPhoto(photo: Entry["photos"][number]): Promise<Entry["photos"][number]> {
  const materialized = materializeQueuedPhoto(photo);
  try {
    return await uploadPhoto(materialized.uri === photo.uri ? photo : { ...photo, uri: materialized.uri });
  } finally {
    materialized.release();
  }
}

/**
 * What a save is doing right now, so the UI can say so instead of appearing to
 * have ignored the tap. Saving an entry with photos on site data is slow — the
 * uploads are the slow part, and they retry with backoff (see uploadPhoto), so
 * "a while with no feedback" is the normal case, not the pathological one.
 */
export type SaveProgress =
  | { phase: "uploading"; completed: number; total: number }
  | { phase: "saving" };

export type SaveProgressCallback = (progress: SaveProgress) => void;

export async function uploadPhotos(
  photos: Entry["photos"],
  onProgress?: (completed: number, total: number) => void
) {
  // `total` counts only the photos that will actually hit the network.
  // uploadPhotoOnce returns immediately for a uri that is already managed
  // server-side, so counting every photo would make an edit that adds one photo
  // to five existing ones report "0 of 6" and then jump to "5 of 6" instantly —
  // a progress number that is technically true and completely useless.
  const total = photos.filter((photo) => !isManagedMediaUri(photo.uri)).length;
  let completed = 0;
  onProgress?.(0, total);
  return Promise.all(
    photos.map(async (photo) => {
      // Decided BEFORE the await: uploadPhoto rewrites the uri to the managed
      // form on success, so testing afterwards would count every photo.
      const needsUpload = !isManagedMediaUri(photo.uri);
      const uploaded = await uploadPhoto(photo);
      if (needsUpload) {
        completed += 1;
        onProgress?.(completed, total);
      }
      return uploaded;
    })
  );
}

/**
 * Signed URLs expire (2 h server-side) and are credential-bearing. Writing them
 * into AsyncStorage stores something that is guaranteed to stop working and
 * leaves a fetchable media URL at rest for no benefit — every load path calls
 * attachSignedPhotoUris, which re-signs from the canonical path anyway. Local
 * `file://` uris on a not-yet-uploaded photo are left exactly as they are.
 */
function toStorableEntry(entry: Entry): Entry {
  const stripped = stripPhotoPayloads(entry);
  return {
    ...stripped,
    photos: stripped.photos.map((photo) => ({ ...photo, uri: toStorablePhotoUri(photo.uri) })),
  };
}

async function persistCache(email: string | null | undefined, sites: Site[], entries: Entry[], diaries: GeneratedDiary[]) {
  const keys = getCacheKeys(email);
  await Promise.all([
    AsyncStorage.setItem(keys.sites, JSON.stringify(sites)),
    AsyncStorage.setItem(keys.entries, JSON.stringify(entries.map((entry) => toStorableEntry(entry)))),
    AsyncStorage.setItem(keys.diaries, JSON.stringify(diaries)),
  ]);
}


/**
 * The clients cache is its own pair of helpers rather than a fifth argument to
 * persistCache.
 *
 * persistCache is called from nineteen places and every one of them passes
 * sites, entries and diaries because every one of them changes one of those
 * three. A client write changes none of them, and widening the shared function
 * would mean nineteen call sites each passing a `clients` they do not touch —
 * which is how a stale array gets written over a fresh one by a caller that had
 * no business naming it.
 *
 * There is NO legacy unscoped key to fall back to here, unlike loadCache: this
 * key is new in this commit, so an absent value means "not fetched yet", and
 * the only correct answer for it is an empty list.
 */
async function persistClientsCache(email: string | null | undefined, clients: Client[]) {
  await AsyncStorage.setItem(getCacheKeys(email).clients, JSON.stringify(clients));
}

async function loadClientsCache(email: string | null | undefined): Promise<Client[]> {
  return safeParseArray<Client>(await AsyncStorage.getItem(getCacheKeys(email).clients));
}

async function loadCache(email: string | null | undefined) {
  const keys = getCacheKeys(email);
  const [sitesRaw, entriesRaw, diariesRaw] = await Promise.all([
    AsyncStorage.getItem(keys.sites),
    AsyncStorage.getItem(keys.entries),
    AsyncStorage.getItem(keys.diaries),
  ]);

  const sites = safeParseArray<Site>(sitesRaw);
  const entries = await hydrateEntriesWithPhotoPayloads(safeParseArray<Entry>(entriesRaw));
  const diaries = safeParseArray<GeneratedDiary>(diariesRaw);

  if (sites.length > 0 || entries.length > 0 || diaries.length > 0) {
    return { sites, entries, diaries };
  }

  const [legacySitesRaw, legacyEntriesRaw, legacyDiariesRaw] = await Promise.all([
    AsyncStorage.getItem(SITES_KEY),
    AsyncStorage.getItem(ENTRIES_KEY),
    AsyncStorage.getItem(DIARIES_KEY),
  ]);
  const legacySites = safeParseArray<Site>(legacySitesRaw);
  const legacyEntries = await hydrateEntriesWithPhotoPayloads(safeParseArray<Entry>(legacyEntriesRaw));
  const legacyDiaries = safeParseArray<GeneratedDiary>(legacyDiariesRaw);
  if (legacySites.length > 0 || legacyEntries.length > 0 || legacyDiaries.length > 0) {
    await persistCache(email, legacySites, legacyEntries, legacyDiaries);
  }
  return { sites: legacySites, entries: legacyEntries, diaries: legacyDiaries };
}

// Module-level signed URL cache keyed by canonical path
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();
const SIGNED_URL_CACHE_TTL_MS = 90 * 60 * 1000; // 90 min — well under 2-hr server TTL

/**
 * Sign a batch of canonical paths, and say how many did not sign.
 *
 * The previous version returned void and swallowed every failure with the
 * comment "Signing failure is non-fatal — photos just won't display". That is
 * exactly the fault: an unsigned photo still rendered as a grey tile, so
 * "won't display" meant "will lie". Failures are still non-fatal to the save —
 * losing the entry over a signing hiccup would be worse — but they are now
 * counted, logged with the reason, and visible in the UI as an explicit
 * unavailable tile rather than an empty one.
 */
async function batchSignPaths(paths: string[], token: string): Promise<{ failed: string[] }> {
  if (paths.length === 0) return { failed: [] };
  try {
    const res = await fetch(`${BASE_URL}/api/uploads/sign`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) {
      // The telemetry stays: the count and status are how this was diagnosed at
      // all (SITESNAP-MOBILE-1, "Media signing request failed (401) for 21
      // photo(s)"). What was missing is that nothing told the person holding
      // the phone, who saw twenty-one unavailable thumbnails and no reason.
      reportMediaFailure({ kind: "sign-request-failed", status: res.status, count: paths.length });
      if (res.status === 401) notifySessionExpired();
      return { failed: paths };
    }
    const data = (await res.json()) as { signed: { path: string; url: string | null }[] };
    const expiresAt = Date.now() + SIGNED_URL_CACHE_TTL_MS;
    const signed = new Set<string>();
    for (const item of data.signed) {
      if (item.url) {
        signedUrlCache.set(item.path, { url: item.url, expiresAt });
        signed.add(item.path);
      }
    }
    const failed = paths.filter((path) => !signed.has(path));
    if (failed.length > 0) {
      // Reported per path, not once per batch: a signer that refuses ONE photo
      // out of six is a different problem from one that refuses all six, and
      // the scrubbed path is what identifies which object is unreachable.
      for (const path of failed) {
        reportMediaFailure({ kind: "sign-refused", uri: path, count: failed.length, total: paths.length });
      }
    }
    return { failed };
  } catch (err) {
    reportMediaFailure({ kind: "sign-threw", count: paths.length, cause: err });
    return { failed: paths };
  }
}

async function attachSignedPhotoUris(entries: Entry[], token: string | null): Promise<Entry[]> {
  if (entries.length === 0) return entries;
  if (!token) {
    // Nothing can be signed without a token. The photos then keep their
    // canonical `/api/uploads/…` uri, which EvidenceImage renders as an
    // explicit "image unavailable" tile — not as an empty one.
    const unsignable = entries.reduce(
      (total, entry) => total + entry.photos.filter((photo) => isManagedMediaUri(photo.uri)).length,
      0
    );
    if (unsignable > 0) {
      reportMediaFailure({ kind: "sign-no-token", count: unsignable });
    }
    return entries;
  }
  const now = Date.now();

  // Collect canonical paths that need (re-)signing
  const toSign: string[] = [];
  for (const entry of entries) {
    for (const photo of entry.photos) {
      if (!photo.uri) continue;
      const canonical = toCanonicalPath(photo.uri);
      if (!canonical) continue;
      const cached = signedUrlCache.get(canonical);
      if (!cached || cached.expiresAt <= now) toSign.push(canonical);
    }
  }
  // Deduplicate
  const unique = [...new Set(toSign)];
  // Batch in groups of 50 (server limit)
  const failed: string[] = [];
  for (let i = 0; i < unique.length; i += 50) {
    const result = await batchSignPaths(unique.slice(i, i + 50), token);
    failed.push(...result.failed);
  }
  if (failed.length > 0) {
    // Console only, deliberately. Every path in `failed` has already been
    // reported to Sentry individually inside batchSignPaths; this line is the
    // local summary of those, and reporting it again would duplicate each event
    // and inflate the count on every screen that renders the same entry.
    console.warn(`[media] ${failed.length} photo(s) will render as unavailable — signing did not succeed`);
  }

  return entries.map((entry) => ({
    ...entry,
    photos: entry.photos.map((photo) => {
      if (!photo.uri) return photo;
      const canonical = toCanonicalPath(photo.uri);
      if (!canonical) return photo;
      const cached = signedUrlCache.get(canonical);
      return cached ? { ...photo, uri: cached.url } : photo;
    }),
  }));
}

export function DataProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, loading: authLoading, user, token, refreshToken } = useAuth();

  // Keep the module-level refresh fn in sync with the current context instance
  React.useEffect(() => {
    _setRefreshTokenFn(refreshToken);
  }, [refreshToken]);
  const [sites, setSites] = useState<Site[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [diaries, setDiaries] = useState<GeneratedDiary[]>([]);
  const [templates, setTemplates] = useState<SiteTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "offline" | "error">("idle");
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [failedOps, setFailedOps] = useState<QueuedOp[]>([]);
  const [entrySyncStates, setEntrySyncStates] = useState<EntrySyncStates>({});

  // The failed list is read from storage rather than accumulated in memory:
  // ops dead-lettered on a previous launch must still be visible on this one.
  const refreshFailedOps = React.useCallback(async () => {
    try {
      setFailedOps(await peekFailedQueue());
    } catch {
      // Storage being unreadable must not take the screen down with it.
    }
  }, []);

  /**
   * Re-derives the per-entry sync map from the queue. Called wherever the queue
   * changes, which is the only thing that can change the answer.
   *
   * This is a whole-queue read, and that is affordable here in a way the
   * photograph payload map is not: queued payloads have their base64 stripped
   * before being enqueued (stripPhotoPayloads), so the queue is a short array of
   * small objects rather than tens of megabytes of string.
   *
   * On a read failure the map is left EXACTLY AS IT WAS rather than cleared.
   * Clearing it would silently promote every outstanding entry to "arrived",
   * which is the one wrong answer this indicator exists to prevent.
   */
  const refreshEntrySyncStates = React.useCallback(async () => {
    try {
      setEntrySyncStates(entrySyncStatesFromQueue(await peekQueue()));
    } catch {
      // Keep the last known map; see above.
    }
  }, []);

  // The loop itself lives in `lib/offline-drain.ts` so it can be tested without a
  // simulator; everything with an effect is injected from here. See that file's
  // header for why, and `lib/offline-drain.test.ts` for what it proves.
  const drainOfflineQueue = async () => {
    await drainQueue({
      peekQueue,
      dequeue,
      apiJson: (path, init) => apiJson(path, init as RequestInit),
      isNetworkError,
      stripPhotoPayloads,
      hydratePhotos,
      uploadPhoto: uploadQueuedPhoto,
      deletePhotoPayloads,
      isManagedMediaUri,
      updateQueuedPayload,
      markOpFailed,
      report: reportSyncFailure,
      onPending: (count) => {
        setPendingCount(count);
        // An op leaving the queue is the moment an entry becomes "arrived", so
        // the per-entry map has to be re-derived here and not only on mount.
        void refreshEntrySyncStates();
      },
      onFailed: () => {
        // The count comes back with the list, so there is one source for both.
        void refreshFailedOps();
        void refreshEntrySyncStates();
      },
      warn: (...args) => console.warn(...args),
    });
  };

  const retryFailedSync = async (ids?: string[]) => {
    const retried = await retryFailedOps(ids);
    await refreshFailedOps();
    // A retried op goes from failed back to pending, so the badge must follow.
    await refreshEntrySyncStates();
    if (retried > 0) await drainOfflineQueue();
    return retried;
  };

  const refresh = async () => {
    const userEmail = user?.email ?? null;
    const cachedBase = await loadCache(userEmail);
    const cached = { ...cachedBase, entries: await attachSignedPhotoUris(cachedBase.entries, token) };
    setSites(cached.sites);
    setClients(await loadClientsCache(userEmail));
    setEntries(cached.entries);
    setDiaries(cached.diaries);

    if (!isAuthenticated) {
      setSyncStatus("offline");
      return;
    }

    try {
      setSyncStatus("syncing");
      setLastSyncError(null);
      // Drain any queued offline writes before pulling fresh data
      await drainOfflineQueue();
      const [bootstrap, templatesResp, clientsResp] = await Promise.all([
        apiJson<{ sites: Site[]; entries: Entry[]; diaries: GeneratedDiary[] }>("/projects/bootstrap"),
        apiJson<{ templates: SiteTemplate[] }>("/projects/templates").catch(() => ({ templates: [] })),
        /**
         * WHY THIS ONE SWALLOWS ITS FAILURE, matching templates above.
         *
         * Filing is additive. Every site carries its own `client` label and its
         * own `clientId`, both from /projects/bootstrap, so a sites list, a
         * site screen and every entry still work with no client list at all —
         * the only thing lost is the headings on the grouped list and the
         * picker's options, and the grouped list falls back to the label.
         *
         * Letting this reject would put the whole refresh into the catch below,
         * which reverts sites, entries AND diaries to the cache and reports the
         * app as offline. That trade is wrong in both directions: a phone
         * running a build whose API has not yet deployed /clients would show a
         * stale cache for everything, and the owner's deploy order is
         * API-first, so the window is real but narrow and the failure mode must
         * not be "the app stopped working".
         *
         * The cost of swallowing it: an empty picker is indistinguishable from
         * a company with no clients. That is why the picker says "No clients
         * yet" rather than claiming a failure, and why nothing here infers
         * anything about permissions from an empty list.
         */
        apiJson<{ clients: Client[] }>("/clients").catch(() => ({ clients: null })),
      ]);
      const hydratedEntries = await attachSignedPhotoUris(
        await hydrateEntriesWithPhotoPayloads(bootstrap.entries),
        token
      );
      setSites(bootstrap.sites);
      setEntries(hydratedEntries);
      setDiaries(bootstrap.diaries);
      setTemplates(templatesResp.templates);
      // NULL means the request failed; an EMPTY ARRAY means a company with no
      // clients. Collapsing those two into `[]` was the first version of this
      // line, and it is wrong in both directions: a failed fetch would have
      // overwritten a good cache with nothing, and deleting the last client
      // from another device would have left this one showing it forever. The
      // cache is only touched when the server actually answered.
      if (clientsResp.clients !== null) {
        setClients(clientsResp.clients);
        await persistClientsCache(userEmail, clientsResp.clients);
      }
      await persistCache(userEmail, bootstrap.sites, hydratedEntries, bootstrap.diaries);
      const remaining = await peekQueue();
      setSyncStatus(remaining.length > 0 ? "offline" : "idle");
    } catch (err) {
      console.warn("Remote bootstrap failed, using cache:", err);
      setSites(cached.sites);
      setEntries(cached.entries);
      setDiaries(cached.diaries);
      setLastSyncError(err instanceof Error ? err.message : String(err));
      setSyncStatus(cached.sites.length > 0 || cached.entries.length > 0 || cached.diaries.length > 0 ? "offline" : "error");
    }
  };

  useEffect(() => {
    if (authLoading) return;
    (async () => {
      try {
        await refresh();
      } finally {
        setLoading(false);
      }
    })();
  }, [authLoading, isAuthenticated, user?.email, token]);

  // An op dead-lettered on a previous launch must be visible on this one before
  // any drain runs — the phone may not have coverage again for days.
  useEffect(() => {
    void refreshFailedOps();
    peekQueue()
      .then((queue) => {
        setPendingCount(queue.filter((op) => op.status !== "failed").length);
        setEntrySyncStates(entrySyncStatesFromQueue(queue));
      })
      .catch(() => {});
  }, [refreshFailedOps]);

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      loadCache(user?.email ?? null)
        .then((cached) => {
          setSites(cached.sites);
          setEntries(cached.entries);
          setDiaries(cached.diaries);
        })
        .catch((error) => console.warn("cache restore on logout failed", error));
      // Separately, because the clients cache has its own key and its own
      // failure: a readable sites cache and an unreadable clients one must not
      // take each other down.
      loadClientsCache(user?.email ?? null)
        .then(setClients)
        .catch((error) => console.warn("client cache restore on logout failed", error));
    }
  }, [authLoading, isAuthenticated, user?.email, token]);

  /**
   * PATCH /projects/sites/:id/job-number -- the client call that makes that
   * route exist.
   *
   * Its own endpoint rather than a field on PATCH /projects/sites/:id, because
   * that route's SiteFilingSchema is `.strict()` with one key and says in its
   * own comment that it is deliberately not the missing general site-edit
   * route; widening it would quietly make it one. See the note above
   * updateSiteJobNumber in services/api/src/storage/projectsStore.ts.
   *
   * No optimistic local write. The route trims and length-checks the value, so
   * the row the server returns is the authority on what was stored -- writing
   * a guess into state first and reconciling after would make a trimmed value
   * flicker.
   */
  const setSiteJobNumber = async (siteId: string, jobNumber: string): Promise<void> => {
    const resp = await apiJson<{ site: Site }>(`/projects/sites/${siteId}/job-number`, {
      method: "PATCH",
      body: JSON.stringify({ jobNumber }),
    });
    const updatedSites = sites.map((s) => (s.id === siteId ? resp.site : s));
    setSites(updatedSites);
    await persistCache(user?.email, updatedSites, entries, diaries);
  };

  const addSite = async (siteData: Omit<Site, "id" | "createdAt">) => {
    try {
      const response = await apiJson<{ site: Site }>("/projects/sites", {
        method: "POST",
        body: JSON.stringify(siteData),
      });
      const updated = [response.site, ...sites];
      setSites(updated);
      await persistCache(user?.email, updated, entries, diaries);
    } catch (err) {
      if (isNetworkError(err)) {
        // Optimistic local add while offline
        const optimistic: Site = {
          ...siteData,
          id: `pending-${Date.now()}`,
          createdAt: new Date().toISOString(),
        };
        const updated = [optimistic, ...sites];
        setSites(updated);
        await persistCache(user?.email, updated, entries, diaries);
        await enqueue({ type: "addSite", payload: siteData });
        setPendingCount((n) => n + 1);
        void refreshEntrySyncStates();
        setSyncStatus("offline");
        return;
      }
      throw err;
    }
  };

  /**
   * Phase 6: the route is still DELETE and still 404s when it does nothing, so
   * this call is unchanged. What changed is what it means on the server -- the
   * site is binned, not destroyed.
   *
   * The local filtering below stays, and is still correct: a binned site is
   * absent from `GET /projects/sites`, and its entries and diaries are absent
   * from their listings too, so dropping them from state matches what the next
   * refresh would produce. It is a HIDE, not a destroy -- which is why
   * `restoreSite` can bring all three back with a plain refresh.
   */
  const deleteSite = async (id: string) => {
    await apiJson<{ ok: boolean; binned?: boolean; retentionDays?: number }>(`/projects/sites/${id}`, {
      method: "DELETE",
    });
    // Read the filing BEFORE the site leaves state — it is the only place the
    // phone knows which client's count has just changed.
    const binnedClientId = sites.find((s) => s.id === id)?.clientId ?? null;
    const updatedSites = sites.filter((s) => s.id !== id);
    const updatedEntries = entries.filter((e) => e.siteId !== id);
    const updatedDiaries = diaries.filter((d) => d.siteId !== id);
    setSites(updatedSites);
    setEntries(updatedEntries);
    setDiaries(updatedDiaries);
    await persistCache(user?.email, updatedSites, updatedEntries, updatedDiaries);
    // THE SECOND HALF OF L114, and the half that is the phone's alone.
    //
    // Everything above prunes the three lists a binned site appears in, so
    // state matches what the next refresh would produce. The CLIENT list was
    // not pruned, and it carries `siteCount` — so after binning a site the
    // clients screen went on showing the pre-delete number out of the cache,
    // on a screen the user had just come from. Fixing the server's count (the
    // GROUP BY counted binned rows) does nothing for this: the phone was not
    // asking the server again.
    //
    // The arithmetic itself is in lib/client-site-counts.ts, with its own
    // test file, because this module cannot be loaded by `node --test` — it
    // imports react-native transitively — so a rule written inline here could
    // only ever be verified by reading it. Same arrangement as
    // lib/site-grouping.ts.
    //
    // Decremented locally rather than refetched, to match the three lines
    // above: this function is deliberately a local prune, and a round trip
    // here would make binning a site slower than it is. `restoreSite` is the
    // other direction and needs no equivalent — it calls refresh(), which
    // refetches the client list wholesale.
    const nextClients = clientsAfterSiteBinned(clients, binnedClientId);
    if (nextClients !== clients) await commitClients(nextClients);
  };

  /**
   * ═════════════════════════════════════════════════════════════════════════
   *  CLIENT FILING. FOUR CALLS, ALL ONLINE-ONLY.
   * ═════════════════════════════════════════════════════════════════════════
   *
   * None of these has an offline-optimistic branch and none enqueues. See the
   * note on the interface above for why. A network failure reaches the screen,
   * which renders it through describeFailure() so a 403 reads as a refusal
   * rather than a breakage.
   *
   * Each one re-sorts by name after writing, because GET /clients returns the
   * list sorted and a local insert that appends would put a new client at the
   * bottom until the next refresh — the list would reorder itself under the
   * finger that just created the row.
   */
  const sortClients = (list: Client[]) =>
    [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

  const commitClients = async (next: Client[]) => {
    const sorted = sortClients(next);
    setClients(sorted);
    await persistClientsCache(user?.email, sorted);
    return sorted;
  };

  const addClient = async (input: ClientInput): Promise<Client> => {
    const resp = await apiJson<{ client: Client }>("/clients", {
      method: "POST",
      body: JSON.stringify(input),
    });
    await commitClients([...clients, resp.client]);
    return resp.client;
  };

  /**
   * The PATCH response carries no `siteCount` — routes/clients.ts returns the
   * store record, and the count is computed only by the list route. So the
   * local count is CARRIED OVER rather than taken from the response, which
   * would otherwise write `undefined` into a field the delete confirmation
   * quotes and turn "this will unfile 4 sites" into "unfile undefined sites".
   */
  const updateClient = async (id: string, patch: Partial<ClientInput>): Promise<Client> => {
    const resp = await apiJson<{ client: Omit<Client, "siteCount"> }>(`/clients/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    const previous = clients.find((c) => c.id === id);
    const merged: Client = { ...resp.client, siteCount: previous?.siteCount ?? 0 };
    await commitClients(clients.map((c) => (c.id === id ? merged : c)));
    return merged;
  };

  /**
   * Delete a client. ITS SITES SURVIVE — the API unfiles them and deletes none,
   * and the count it returns is what the screen reports.
   *
   * The local site rows are updated here too, because the sites in state still
   * carry the dead `clientId`: leaving them would group them under a heading
   * whose client no longer exists until the next refresh. `client` — the
   * free-text label — is deliberately left alone, matching the server, which
   * keeps it so that unfiling never erases what somebody typed.
   */
  const deleteClient = async (id: string): Promise<number> => {
    const resp = await apiJson<{ ok: boolean; unfiledSites: number }>(`/clients/${id}`, {
      method: "DELETE",
    });
    await commitClients(clients.filter((c) => c.id !== id));
    const updatedSites = sites.map((site) =>
      (site.clientId ?? null) === id ? { ...site, clientId: null } : site
    );
    setSites(updatedSites);
    await persistCache(user?.email, updatedSites, entries, diaries);
    return resp.unfiledSites;
  };

  /**
   * File a site under a client, or unfile it with null.
   *
   * The site comes back from the route rather than being patched locally, and
   * that matters for one field: filing REWRITES `client`, the free-text label,
   * to the client's canonical name. Spreading `{ ...site, clientId }` here
   * instead would leave the card showing the old typed label next to its new
   * heading, which is the disagreement this feature exists to remove.
   *
   * `siteCount` on the two affected clients is adjusted locally for the same
   * reason the sort is local — the delete confirmation quotes it, and a count
   * that is one behind until the next refresh would misreport what deleting a
   * client is about to do.
   */
  const fileSite = async (siteId: string, clientId: string | null): Promise<void> => {
    const previousClientId = sites.find((s) => s.id === siteId)?.clientId ?? null;
    const resp = await apiJson<{ site: Site }>(`/projects/sites/${siteId}`, {
      method: "PATCH",
      body: JSON.stringify({ clientId }),
    });
    const updatedSites = sites.map((s) => (s.id === siteId ? resp.site : s));
    setSites(updatedSites);
    await persistCache(user?.email, updatedSites, entries, diaries);
    // Same module, same reason, and the `from === to` guard that used to be
    // this `if` now lives inside it — see the note there on why +1 and -1 are
    // not commutative at zero.
    const nextClients = clientsAfterSiteRefiled(clients, previousClientId, clientId);
    if (nextClients !== clients) await commitClients(nextClients);
  };

  const listBinnedSites = async (): Promise<{ sites: BinnedSite[]; retentionDays: number }> => {
    const response = await apiJson<{ sites: BinnedSite[]; retentionDays: number }>(
      "/projects/sites/bin"
    );
    return { sites: response.sites ?? [], retentionDays: response.retentionDays };
  };

  /**
   * `refresh()` rather than splicing the restored site into state: restoring a
   * site brings its entries and diaries back with it, and this provider holds
   * all three. Reconstructing that here would mean deciding which of the cached
   * entries belong to the restored site, when the server already knows.
   */
  const restoreSite = async (id: string) => {
    await apiJson<{ site: Site }>(`/projects/sites/${id}/restore`, { method: "POST" });
    await refresh();
  };

  const addEntry = async (
    entryData: Omit<Entry, "id" | "timestamp" | "createdAt">,
    onProgress?: SaveProgressCallback
  ) => {
    try {
      const uploadedPhotos = await uploadPhotos(entryData.photos, (completed, total) =>
        onProgress?.({ phase: "uploading", completed, total })
      );
      onProgress?.({ phase: "saving" });
      await savePhotoPayloads(uploadedPhotos);
      const response = await apiJson<{ entry: Entry }>("/projects/entries", {
        method: "POST",
        body: JSON.stringify(stripPhotoPayloads({ ...entryData, photos: uploadedPhotos } as Entry)),
      });
      // THE FIX (root cause of the six-grey-tiles bug).
      //
      // `response.entry.photos[].uri` is the server's canonical path,
      // `/api/uploads/<id>/<name>`. Putting that straight into state — which is
      // what this did — hands <Image> a relative uri it cannot resolve, so the
      // entry you have just saved shows one empty tile per photograph. Only
      // refresh() signed, which is why a force-quit and reopen "fixed" it and
      // why the photos were never actually missing.
      const [hydratedEntry] = await hydrateEntriesWithPhotoPayloads([response.entry]);
      const [displayableEntry] = await attachSignedPhotoUris([hydratedEntry], await getToken());
      const updated = [displayableEntry, ...entries];
      setEntries(updated);
      await persistCache(user?.email, sites, updated, diaries);
    } catch (err) {
      if (isNetworkError(err)) {
        // Optimistic local entry — marked pending so UI can indicate sync state
        const optimistic: Entry = {
          ...entryData,
          id: `pending-${Date.now()}`,
          timestamp: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          isPending: true,
        };
        await savePhotoPayloads(entryData.photos);
        const updated = [optimistic, ...entries];
        setEntries(updated);
        await persistCache(user?.email, sites, updated, diaries);
        await enqueue({ type: "addEntry", payload: stripPhotoPayloads(optimistic) });
        setPendingCount((n) => n + 1);
        void refreshEntrySyncStates();
        setSyncStatus("offline");
        return;
      }
      throw err;
    }
  };

  const deleteEntry = async (id: string) => {
    const existing = entries.find((entry) => entry.id === id);
    await apiJson<{ ok: boolean }>(`/projects/entries/${id}`, { method: "DELETE" });
    const updated = entries.filter((e) => e.id !== id);
    if (existing) {
      await deletePhotoPayloads(existing.photos.map((photo) => photo.id));
    }
    setEntries(updated);
    await persistCache(user?.email, sites, updated, diaries);
  };

  const updateEntry = async (id: string, patch: Partial<Entry>, onProgress?: SaveProgressCallback) => {
    const existing = entries.find((entry) => entry.id === id);
    if (patch.photos) {
      const uploadedPhotos = await uploadPhotos(patch.photos, (completed, total) =>
        onProgress?.({ phase: "uploading", completed, total })
      );
      patch = { ...patch, photos: uploadedPhotos };
      await savePhotoPayloads(uploadedPhotos);
      if (existing) {
        const nextIds = new Set(uploadedPhotos.map((photo) => photo.id));
        const removedIds = existing.photos.filter((photo) => !nextIds.has(photo.id)).map((photo) => photo.id);
        await deletePhotoPayloads(removedIds);
      }
    }
    onProgress?.({ phase: "saving" });
    const response = await apiJson<{ entry: Entry }>(`/projects/entries/${id}`, {
      method: "PATCH",
      body: JSON.stringify(
        patch.photos
          ? {
              ...patch,
              photos: stripPhotoPayloads({ photos: patch.photos } as Entry).photos,
            }
          : patch
      ),
    });
    // Same fix as addEntry: sign before the entry reaches state, or every photo
    // in the edited entry renders as an empty tile until the next cold start.
    const [hydratedEntry] = await hydrateEntriesWithPhotoPayloads([response.entry]);
    const [displayableEntry] = await attachSignedPhotoUris([hydratedEntry], await getToken());
    const updated = entries.map((e) => (e.id === id ? displayableEntry : e));
    setEntries(updated);
    await persistCache(user?.email, sites, updated, diaries);
  };

  const addDiary = (diaryData: Omit<GeneratedDiary, "id" | "generatedAt">) => {
    const optimisticDiary: GeneratedDiary = {
      ...diaryData,
      id: Date.now().toString(),
      generatedAt: new Date().toISOString(),
    };
    setDiaries((prev) => {
      const next = [optimisticDiary, ...prev];
      void persistCache(user?.email, sites, entries, next);
      return next;
    });
    apiJson<{ diary: GeneratedDiary }>("/projects/diaries", {
      method: "POST",
      body: JSON.stringify(diaryData),
    })
      .then(({ diary }) => {
        setDiaries((prev) => {
          const next = [diary, ...prev.filter((d) => d.id !== optimisticDiary.id)];
          void persistCache(user?.email, sites, entries, next);
          return next;
        });
      })
      .catch((error) => {
        console.warn("save diary failed, rolling back optimistic entry", error);
        setDiaries((prev) => {
          const next = prev.filter((d) => d.id !== optimisticDiary.id);
          void persistCache(user?.email, sites, entries, next);
          return next;
        });
      });
    return optimisticDiary;
  };

  const updateDiary = (id: string, patch: Partial<GeneratedDiary>) => {
    let previousDiary: GeneratedDiary | undefined;
    setDiaries((prev) => {
      previousDiary = prev.find((d) => d.id === id);
      const next = prev.map((d) => (d.id === id ? { ...d, ...patch } : d));
      void persistCache(user?.email, sites, entries, next);
      return next;
    });
    apiJson<{ diary: GeneratedDiary }>(`/projects/diaries/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })
      .then(({ diary }) => {
        setDiaries((prev) => {
          const next = prev.map((d) => (d.id === id ? diary : d));
          void persistCache(user?.email, sites, entries, next);
          return next;
        });
      })
      .catch((error) => {
        console.warn("update diary failed, rolling back optimistic update", error);
        if (previousDiary) {
          const snapshot = previousDiary;
          setDiaries((prev) => {
            const next = prev.map((d) => (d.id === id ? snapshot : d));
            void persistCache(user?.email, sites, entries, next);
            return next;
          });
        }
      });
  };

  const getSite = (id?: string) => {
    if (!id) return undefined;
    return sites.find((s) => s.id === id);
  };

  const getEntry = (id?: string) => {
    if (!id) return undefined;
    return entries.find((e) => e.id === id);
  };

  const getSiteEntries = (siteId?: string) => {
    if (!siteId) return [];
    return entries.filter((e) => e.siteId === siteId);
  };

  const getSiteDiaries = (siteId?: string) => {
    if (!siteId) return [];
    if (!Array.isArray(diaries)) return [];
    return diaries.filter((d) => d.siteId === siteId).sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  };

  const getSiteTemplates = (siteId?: string) => {
    if (!siteId) return [];
    return templates.filter((t) => t.siteId === siteId);
  };

  const inviteCrewMembers = async (siteId: string, emails: string[], role: string): Promise<InviteResult[]> => {
    const resp = await apiJson<{ results: InviteResult[] }>(`/projects/sites/${siteId}/invites`, {
      method: "POST",
      body: JSON.stringify({ emails, role }),
    });
    return resp.results;
  };

  const inviteCompanyMembers = async (emails: string[], companyRole: string): Promise<CompanyInviteResult[]> => {
    const resp = await apiJson<{ results: CompanyInviteResult[] }>("/company/members/invite", {
      method: "POST",
      body: JSON.stringify({ emails, companyRole }),
    });
    return resp.results;
  };

  /**
   * Accept a site or company invitation.
   *
   * `siteId` and `siteName` are NULL for a company invitation, which joins a
   * company and no site. This signature used to promise `string` for both; the
   * route has always returned null here, and `app/invite.tsx` rendered the
   * literal "null" into its subtitle on the strength of that promise.
   *
   * THE TOKEN REFRESH IS LOAD-BEARING, NOT HYGIENE
   *
   * Every route derives the acting company from the bearer token's CLAIMS, not
   * from the user row (`middleware/auth.ts` sets `req.auth` from the verified
   * token; each router's `getActor` copies `companyId`/`companyRole` straight
   * off it). An invitee's pre-acceptance token carries `companyId: ""` and
   * `companyRole: "crew"`, so holding onto it after a successful acceptance
   * leaves every subsequent request scoped to no company: RLS matches no rows
   * and the company-scoped routes refuse the caller. The invitee accepts, sees
   * an empty app, and has to log out and back in before anything appears.
   *
   * Nothing else recovers from this. The 401 retry inside `apiJson` does not:
   * the old token is perfectly valid, merely under-privileged, so the routes
   * answer 403 and the refresh-and-retry path is never entered.
   *
   * `refreshToken()` re-reads the user row, so the claims it mints agree with
   * what the database actually recorded. That is deliberately preferred over
   * adopting the fresh token the accept response also carries, which is built
   * from the values the handler intended to write and would therefore report a
   * company the row may not have — the exact shape of AUDIT L65, where accept
   * reported success for attaching nobody to anything. If the attachment did
   * not happen we want the invitee to see an empty app, not a token asserting
   * a membership the database disagrees with.
   *
   * `apiJson` reads the token from AsyncStorage on every call and
   * `refreshToken()` persists it there before setting React state, so the
   * `refresh()` below runs with the new claims rather than the stale closure.
   */
  const acceptInvite = async (
    token: string
  ): Promise<{ siteId: string | null; siteName: string | null; role: string }> => {
    const resp = await apiJson<{ siteId: string | null; siteName: string | null; role: string }>(
      "/projects/invites/accept",
      {
        method: "POST",
        body: JSON.stringify({ token }),
      }
    );
    // Pick up the company the acceptance just granted, before reading any data.
    await refreshToken();
    // Refresh so the newly joined site appears in the sites list
    await refresh();
    return resp;
  };

  const getSiteMembers = async (siteId: string): Promise<SiteMember[]> => {
    const resp = await apiJson<{ members: SiteMember[] }>(`/projects/sites/${siteId}/members`);
    return resp.members;
  };

  const removeSiteMember = async (siteId: string, memberEmail: string): Promise<void> => {
    await apiJson<{ ok: boolean }>(`/projects/sites/${siteId}/members/${encodeURIComponent(memberEmail)}`, {
      method: "DELETE",
    });
  };

  return (
    <DataContext.Provider
      value={{
        sites,
        clients,
        entries,
        diaries,
        templates,
        syncStatus,
        lastSyncError,
        pendingCount,
        failedOps,
        entrySyncStates,
        retryFailedSync,
        addSite,
        deleteSite,
        addClient,
        updateClient,
        deleteClient,
        fileSite,
        setSiteJobNumber,
        listBinnedSites,
        restoreSite,
        addEntry,
        updateEntry,
        deleteEntry,
        addDiary,
        updateDiary,
        getEntry,
        getSite,
        getSiteEntries,
        getSiteDiaries,
        getSiteTemplates,
        loading,
        refresh,
        inviteCrewMembers,
        inviteCompanyMembers,
        acceptInvite,
        getSiteMembers,
        removeSiteMember,
      }}
    >
      {children}
    </DataContext.Provider>
  );
}

export function useData() {
  const context = useContext(DataContext);
  if (!context) {
    throw new Error("useData must be used within DataProvider");
  }
  return context;
}
