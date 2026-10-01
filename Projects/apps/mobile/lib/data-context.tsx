import React, { createContext, useContext, useEffect, useState } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Site, Entry, GeneratedDiary, SiteTemplate, SiteMember, InviteResult } from "@/lib/types";
import { resolveApiBaseUrl } from "@/lib/api-base-url";
import { useAuth, isTokenExpiringSoon } from "@/lib/auth-context";
import {
  deletePhotoPayloads,
  hydrateEntriesWithPhotoPayloads,
  savePhotoPayloads,
  stripPhotoPayloads,
} from "@/lib/photo-payload-store";
import { enqueue, peekQueue, dequeue, isNetworkError } from "@/lib/offline-queue";
import { isManagedMediaUri, toCanonicalPath, toStorablePhotoUri } from "@/lib/photo-uri";
import { reportMediaFailure } from "@/lib/media-telemetry";

interface DataContextType {
  sites: Site[];
  entries: Entry[];
  diaries: GeneratedDiary[];
  templates: SiteTemplate[];
  syncStatus: "idle" | "syncing" | "offline" | "error";
  lastSyncError: string | null;
  pendingCount: number;
  addSite: (site: Omit<Site, "id" | "createdAt">) => Promise<void>;
  deleteSite: (id: string) => Promise<void>;
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
  acceptInvite: (token: string) => Promise<{ siteId: string; siteName: string; role: string }>;
  getSiteMembers: (siteId: string) => Promise<SiteMember[]>;
  removeSiteMember: (siteId: string, memberEmail: string) => Promise<void>;
}

export interface CompanyInviteResult {
  email: string;
  status: "sent" | "error";
}

const DataContext = createContext<DataContextType | null>(null);
const SITES_KEY = "sitesnap.sites";
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
      const err = new Error("Unauthorized") as Error & { status: number };
      err.status = 401;
      throw err;
    }
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const payload = (await res.json()) as { error?: string; message?: string };
      throw new Error(payload.error || payload.message || `Request failed (${res.status})`);
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
    // On 401, attempt one token refresh then retry
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
    const text = await res.text();
    throw new Error(text || `Photo upload failed (${res.status})`);
  }

  const payload = (await res.json()) as { url?: string; storagePath?: string; storageKey?: string };
  const canonicalPath = payload.url?.startsWith("/") ? payload.url : (payload.url || "");

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
      if (attempt < backoff.length) {
        await new Promise((r) => setTimeout(r, backoff[attempt]));
      }
    }
  }
  throw lastErr;
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
      reportMediaFailure({ kind: "sign-request-failed", status: res.status, count: paths.length });
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
  const [entries, setEntries] = useState<Entry[]>([]);
  const [diaries, setDiaries] = useState<GeneratedDiary[]>([]);
  const [templates, setTemplates] = useState<SiteTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "offline" | "error">("idle");
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  const drainOfflineQueue = async () => {
    const queue = await peekQueue();
    if (queue.length === 0) return;
    setPendingCount(queue.length);
    for (const op of queue) {
      try {
        if (op.type === "addEntry") {
          const data = op.payload as Omit<Entry, "id" | "timestamp" | "createdAt">;
          await apiJson<{ entry: Entry }>("/projects/entries", {
            method: "POST",
            body: JSON.stringify(stripPhotoPayloads({ ...data } as Entry)),
          });
        } else if (op.type === "addSite") {
          await apiJson<{ site: Site }>("/projects/sites", {
            method: "POST",
            body: JSON.stringify(op.payload),
          });
        } else if (op.type === "updateEntry") {
          const { id, patch } = op.payload as { id: string; patch: Partial<Entry> };
          await apiJson<{ entry: Entry }>(`/projects/entries/${id}`, {
            method: "PATCH",
            body: JSON.stringify(patch),
          });
        } else if (op.type === "deleteEntry") {
          await apiJson<{ ok: boolean }>(`/projects/entries/${op.payload as string}`, { method: "DELETE" });
        } else if (op.type === "deleteSite") {
          await apiJson<{ ok: boolean }>(`/projects/sites/${op.payload as string}`, { method: "DELETE" });
        }
        await dequeue(op.id);
      } catch (err) {
        if (!isNetworkError(err)) {
          // Non-network error (e.g. 4xx): drop the op to avoid infinite retry
          await dequeue(op.id);
          console.warn("[queue] Dropping unrecoverable queued op", op.type, err);
        }
        // Network error: leave in queue for next refresh
        break;
      }
    }
    const remaining = await peekQueue();
    setPendingCount(remaining.length);
  };

  const refresh = async () => {
    const userEmail = user?.email ?? null;
    const cachedBase = await loadCache(userEmail);
    const cached = { ...cachedBase, entries: await attachSignedPhotoUris(cachedBase.entries, token) };
    setSites(cached.sites);
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
      const [bootstrap, templatesResp] = await Promise.all([
        apiJson<{ sites: Site[]; entries: Entry[]; diaries: GeneratedDiary[] }>("/projects/bootstrap"),
        apiJson<{ templates: SiteTemplate[] }>("/projects/templates").catch(() => ({ templates: [] })),
      ]);
      const hydratedEntries = await attachSignedPhotoUris(
        await hydrateEntriesWithPhotoPayloads(bootstrap.entries),
        token
      );
      setSites(bootstrap.sites);
      setEntries(hydratedEntries);
      setDiaries(bootstrap.diaries);
      setTemplates(templatesResp.templates);
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
    }
  }, [authLoading, isAuthenticated, user?.email, token]);

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
        setSyncStatus("offline");
        return;
      }
      throw err;
    }
  };

  const deleteSite = async (id: string) => {
    await apiJson<{ ok: boolean }>(`/projects/sites/${id}`, { method: "DELETE" });
    const updatedSites = sites.filter((s) => s.id !== id);
    const updatedEntries = entries.filter((e) => e.siteId !== id);
    const updatedDiaries = diaries.filter((d) => d.siteId !== id);
    setSites(updatedSites);
    setEntries(updatedEntries);
    setDiaries(updatedDiaries);
    await persistCache(user?.email, updatedSites, updatedEntries, updatedDiaries);
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

  const acceptInvite = async (token: string): Promise<{ siteId: string; siteName: string; role: string }> => {
    const resp = await apiJson<{ siteId: string; siteName: string; role: string }>("/projects/invites/accept", {
      method: "POST",
      body: JSON.stringify({ token }),
    });
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
        entries,
        diaries,
        templates,
        syncStatus,
        lastSyncError,
        pendingCount,
        addSite,
        deleteSite,
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
