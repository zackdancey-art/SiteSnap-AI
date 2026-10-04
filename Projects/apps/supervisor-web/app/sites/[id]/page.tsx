"use client";

import { useEffect, useState, useMemo, useRef } from "react";
import { useRouter, useParams } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import ProfileDropdown from "@/components/ProfileDropdown";
import { SkeletonTable } from "@/components/Skeleton";
import {
  fetchBootstrap, getSavedUser, isAuthenticated,
  fetchTimecards, fetchIncidents, fetchInspections, fetchDeliveries,
  approveDiary, signUploadPaths,
} from "@/lib/api";
import type {
  BootstrapData, Diary, Entry, User,
  Timecard, Incident, Inspection, Delivery,
} from "@/lib/api";

type Tab = "overview" | "entries" | "timesheets" | "incidents" | "inspections" | "dockets" | "photos" | "reports";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "overview",    label: "Overview",    icon: "🏗️" },
  { id: "entries",     label: "Entries",     icon: "📄" },
  { id: "timesheets",  label: "Timesheets",  icon: "⏱️" },
  { id: "incidents",   label: "Incidents",   icon: "⚠️" },
  { id: "inspections", label: "Inspections", icon: "🔍" },
  { id: "dockets",     label: "Dockets",     icon: "📦" },
  { id: "photos",      label: "Photos",      icon: "📷" },
  { id: "reports",     label: "Reports",     icon: "📋" },
];

/**
 * How many paths go in one `/api/uploads/sign` request.
 *
 * The server refuses more than 50 per request and returns 400 for the WHOLE
 * request — so a site with 51 photographs displayed none of them, and a site
 * with 49 displayed all of them. The photograph count decided whether the
 * feature existed (AUDIT L42).
 *
 * BATCHED, NOT VIEWPORT-DRIVEN, AND WHY
 *
 * Signing only what is on screen would save requests for photographs the
 * manager never scrolls to, but it does not make any individual photograph
 * cheaper: the cost is one indexed ownership lookup plus an HMAC per path
 * either way. What it does cost is an IntersectionObserver per tile, a request
 * queue fed from render, and the same machinery again for the Entries tab —
 * real complexity in an effect that has just been repaired for re-entrancy,
 * and the part most likely to reintroduce it.
 *
 * Batching is a slice on top of the structure already here. The first batch
 * displays immediately and the rest fill in behind it, so the count no longer
 * decides whether any photograph appears, which is what was asked for.
 *
 * The expense worth managing is not the signatures — a few hundred bytes of
 * JSON each — but the photographs, which are megabytes each. That is handled
 * where it belongs, with `loading="lazy"` on the images, so the bytes are not
 * fetched until a tile is near the viewport however many have been signed.
 *
 * 25 rather than 50: half the server's ceiling, so a batch cannot be pushed
 * over it by an off-by-one, and small enough that the first row of tiles
 * appears quickly on a site with hundreds.
 */
const SIGN_BATCH_SIZE = 25;

const SEVERITY_CFG: Record<string, { label: string; color: string; bg: string }> = {
  "near-miss": { label: "Near Miss", color: "#F59E0B", bg: "#FFFBEB" },
  minor:       { label: "Minor",     color: "#E8731A", bg: "#FFF7ED" },
  major:       { label: "Major",     color: "#EF4444", bg: "#FEF2F2" },
  critical:    { label: "Critical",  color: "#7C3AED", bg: "#F5F3FF" },
};

function formatTime(t?: string) {
  if (!t) return "—";
  const [h, m] = t.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

type PhotoView = { uri: string; caption?: string };
type Shot = { url: string; caption?: string };

/**
 * One photograph tile, in whichever of its three states applies: signed and
 * displayable, refused with the server's reason, or not yet attempted.
 *
 * Shared by the Photos tab and the Entries tab deliberately. Those three states
 * are the whole of what L42–L44 were about, and two copies of them would drift:
 * one would still be saying "Loading…" over a finished failure long after the
 * other had stopped.
 */
function PhotoTile({
  photo, index, signedUrls, errors, compact, onOpen,
}: {
  photo: PhotoView;
  index: number;
  signedUrls: Map<string, string>;
  errors: Map<string, string>;
  /** Small, with the caption rendered beneath by the caller rather than over the image. */
  compact?: boolean;
  onOpen: (shot: Shot) => void;
}) {
  const signedUrl = signedUrls.get(photo.uri);
  const failure = signedUrl ? undefined : errors.get(photo.uri);

  return (
    <div
      onClick={() => signedUrl && onOpen({ url: signedUrl, caption: photo.caption })}
      title={failure ?? photo.caption ?? undefined}
      style={{
        borderRadius: compact ? 8 : 12, overflow: "hidden",
        background: "var(--surface-secondary)",
        aspectRatio: "4/3",
        display: "flex", alignItems: "center", justifyContent: "center",
        border: "1px solid var(--border)",
        cursor: signedUrl ? "pointer" : "default",
        position: "relative",
        transition: "transform 0.15s, box-shadow 0.15s",
      }}
      onMouseEnter={(e) => { if (signedUrl) { (e.currentTarget as HTMLDivElement).style.transform = "scale(1.02)"; (e.currentTarget as HTMLDivElement).style.boxShadow = "0 6px 20px rgba(0,0,0,0.12)"; } }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.transform = "scale(1)"; (e.currentTarget as HTMLDivElement).style.boxShadow = "none"; }}
    >
      {signedUrl ? (
        <img
          src={signedUrl}
          alt={photo.caption ?? `Photo ${index + 1}`}
          loading="lazy"
          decoding="async"
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        // "Loading…" under a load that has finished and failed is the defect,
        // not the styling: it tells a manager to wait for something that is
        // never coming.
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: compact ? 2 : 8, padding: compact ? 4 : 10, textAlign: "center" }}>
          <span style={{ fontSize: compact ? 18 : 32, opacity: 0.4 }}>{failure ? "⚠" : "📷"}</span>
          <span style={{ fontSize: compact ? 9 : 11, color: failure ? "var(--error)" : "var(--text-tertiary)" }}>
            {failure ? "Unavailable" : "Loading…"}
          </span>
          {failure && !compact && (
            <span style={{ fontSize: 10, color: "var(--text-tertiary)", lineHeight: 1.3 }}>{failure}</span>
          )}
        </div>
      )}
      {photo.caption && signedUrl && !compact && (
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          background: "linear-gradient(transparent, rgba(15,43,70,0.75))",
          padding: "20px 10px 8px",
          fontSize: 11, color: "#fff", fontWeight: 500,
        }}>
          {photo.caption}
        </div>
      )}
    </div>
  );
}

/** The full-screen view of one photograph. Shared for the same reason as the tile. */
function PhotoLightbox({ shot, onClose }: { shot: Shot; onClose: () => void }) {
  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 1000,
        background: "rgba(10,18,30,0.92)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 24,
      }}
      onClick={onClose}
    >
      <button
        onClick={onClose}
        style={{ position: "absolute", top: 20, right: 20, background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: 10, width: 38, height: 38, fontSize: 20, cursor: "pointer" }}
      >
        ✕
      </button>
      <img
        src={shot.url}
        alt={shot.caption ?? "Site photo"}
        style={{ maxWidth: "90vw", maxHeight: "85vh", borderRadius: 12, objectFit: "contain", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
        onClick={(e) => e.stopPropagation()}
      />
      {shot.caption && (
        <div style={{ position: "absolute", bottom: 28, left: "50%", transform: "translateX(-50%)", color: "#fff", fontSize: 14, fontWeight: 500, background: "rgba(0,0,0,0.5)", padding: "6px 16px", borderRadius: 20 }}>
          {shot.caption}
        </div>
      )}
    </div>
  );
}

/**
 * The banner that tells a manager some photographs did not load, and offers to
 * ask again. Shared by both tabs that display photographs.
 */
function PhotoFailureBanner({
  failedCount, total, requestError, onRetry,
}: {
  failedCount: number;
  total: number;
  requestError: string | null;
  onRetry: () => void;
}) {
  if (!requestError && failedCount === 0) return null;
  return (
    <div style={{
      margin: "16px 20px 0", padding: "10px 14px",
      display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
      borderRadius: 10,
      border: "1px solid var(--error)",
      background: "var(--surface-secondary)",
      fontSize: 13, color: "var(--text-secondary)",
    }}>
      <span style={{ color: "var(--error)" }}>⚠</span>
      <span style={{ flex: 1, minWidth: 160 }}>
        {requestError
          ? `Photos could not be loaded: ${requestError}`
          : `${failedCount} of ${total} photo${total === 1 ? "" : "s"} could not be loaded.`}
      </span>
      <button className="btn-ghost" onClick={onRetry} style={{ fontSize: 12, padding: "5px 12px" }}>
        Try again
      </button>
    </div>
  );
}

function PhotosTab({
  photos, signedUrls, errors, requestError, signing, onRetry,
}: {
  photos: PhotoView[];
  signedUrls: Map<string, string>;
  errors: Map<string, string>;
  requestError: string | null;
  signing: boolean;
  onRetry: () => void;
}) {
  const [lightbox, setLightbox] = useState<Shot | null>(null);
  const failedCount = photos.filter((p) => errors.has(p.uri)).length;

  return (
    <>
      <div className="card">
        <div className="card-header">
          <span>📷</span>
          <span className="card-title">Site Photos</span>
          <span className="card-count">{photos.length}</span>
          {signing && (
            <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-secondary)" }}>
              {photos.length > SIGN_BATCH_SIZE
                ? `Loading ${signedUrls.size} of ${photos.length}…`
                : "Loading…"}
            </span>
          )}
        </div>

        {/* A manager looking at grey squares is told what went wrong and can ask
            again. Shown whether the failure was per-path or whole-request. */}
        {!signing && (
          <PhotoFailureBanner failedCount={failedCount} total={photos.length} requestError={requestError} onRetry={onRetry} />
        )}

        {photos.length === 0 ? (
          <div className="empty-state"><p>No photos uploaded yet.</p></div>
        ) : (
          <div style={{ padding: 20, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 14 }}>
            {photos.map((p, i) => (
              <PhotoTile key={`${p.uri}-${i}`} photo={p} index={i} signedUrls={signedUrls} errors={errors} onOpen={setLightbox} />
            ))}
          </div>
        )}
      </div>

      {lightbox && <PhotoLightbox shot={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

/**
 * The diary entries the crew logged, read-only.
 *
 * This is the half of the product the office uses and it had no way in: the
 * Overview tab counted entries and then offered nothing to click (AUDIT L47).
 * Everything here comes from `bootstrap.entries`, already filtered to this site
 * by the page — no endpoint was added and no route was added.
 *
 * Deliberately a list and not a detail route. `sites/[id]/entries/[entryId]`
 * with its own endpoint would establish a detail-route pattern the portal has
 * nowhere else, and that decision belongs with dashboard parity rather than
 * with a photograph fix.
 */
function EntriesTab({
  entries, signedUrls, errors, requestError, signing, onRetry, formatDate,
}: {
  entries: Entry[];
  signedUrls: Map<string, string>;
  errors: Map<string, string>;
  requestError: string | null;
  signing: boolean;
  onRetry: () => void;
  formatDate: (value?: string | null, options?: Intl.DateTimeFormatOptions) => string;
}) {
  const [lightbox, setLightbox] = useState<Shot | null>(null);

  // Newest first — the office reads the most recent day first. `date` is the
  // work date and `timestamp` when it was logged; the second breaks ties within
  // a day. Both compare as ISO strings.
  const ordered = useMemo(
    () => [...entries].sort(
      (a, b) =>
        (b.date ?? "").localeCompare(a.date ?? "") ||
        (b.timestamp ?? "").localeCompare(a.timestamp ?? "")
    ),
    [entries]
  );

  const allPhotos = entries.flatMap((e) => e.photos ?? []);
  const failedCount = allPhotos.filter((p) => errors.has(p.uri)).length;

  return (
    <>
      <div className="card">
        <div className="card-header">
          <span>📄</span>
          <span className="card-title">Diary Entries</span>
          <span className="card-count">{entries.length}</span>
          {signing && (
            <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-secondary)" }}>Loading photos…</span>
          )}
        </div>

        {!signing && (
          <PhotoFailureBanner failedCount={failedCount} total={allPhotos.length} requestError={requestError} onRetry={onRetry} />
        )}

        {entries.length === 0 ? (
          <div className="empty-state"><p>No diary entries logged yet.</p></div>
        ) : (
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 14 }}>
            {ordered.map((entry) => {
              const photos = entry.photos ?? [];
              return (
                <article
                  key={entry.id}
                  style={{
                    border: "1px solid var(--border)", borderRadius: 12,
                    padding: 16, background: "var(--surface)",
                  }}
                >
                  <header style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
                    <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>
                      {formatDate(entry.date, { weekday: "short", day: "numeric", month: "short", year: "numeric" })}
                    </span>
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      {entry.ownerEmail ? `Logged by ${entry.ownerEmail}` : "Logged by an unrecorded account"}
                    </span>
                    {entry.timestamp && (
                      <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                        · {formatDate(entry.timestamp, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </header>

                  {(entry.weather || entry.crewCount || entry.locationAddress) && (
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                      {entry.weather && <span className="badge">🌤️ {entry.weather}</span>}
                      {entry.crewCount && <span className="badge">👷 {entry.crewCount}</span>}
                      {entry.locationAddress && <span className="badge">📍 {entry.locationAddress}</span>}
                    </div>
                  )}

                  <p style={{
                    margin: 0, fontSize: 13, lineHeight: 1.55,
                    whiteSpace: "pre-wrap",
                    color: entry.notes?.trim() ? "var(--text)" : "var(--text-tertiary)",
                  }}>
                    {entry.notes?.trim() || "No notes recorded for this entry."}
                  </p>

                  {photos.length > 0 && (
                    <div style={{
                      marginTop: 12, display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(104px, 1fr))", gap: 10,
                    }}>
                      {photos.map((photo, i) => (
                        <figure key={`${photo.uri}-${i}`} style={{ margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                          <PhotoTile
                            photo={photo}
                            index={i}
                            signedUrls={signedUrls}
                            errors={errors}
                            compact
                            onOpen={setLightbox}
                          />
                          {photo.caption && (
                            <figcaption style={{ fontSize: 10, lineHeight: 1.3, color: "var(--text-secondary)" }}>
                              {photo.caption}
                            </figcaption>
                          )}
                        </figure>
                      ))}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>

      {lightbox && <PhotoLightbox shot={lightbox} onClose={() => setLightbox(null)} />}
    </>
  );
}

export default function SiteDetailPage() {
  const router = useRouter();
  const { id: siteId } = useParams<{ id: string }>();

  const [bootstrap, setBootstrap]     = useState<BootstrapData | null>(null);
  const [timecards, setTimecards]     = useState<Timecard[]>([]);
  const [incidents, setIncidents]     = useState<Incident[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [deliveries, setDeliveries]   = useState<Delivery[]>([]);
  const [loadingMain, setLoadingMain]   = useState(true);
  const [tab, setTab]                   = useState<Tab>("overview");
  const [approving, setApproving]       = useState<string | null>(null);
  /**
   * Two things that exist only in the browser, and the React hydration errors
   * they were causing (AUDIT L49: #418, #423, #425 in the production console).
   *
   * `getSavedUser()` reads `localStorage`, and returns `null` when there is no
   * `window`. It was being called DURING render, so the server rendered the
   * sidebar as "Manager" and the browser rendered the real name from the same
   * component on the same markup — a text mismatch, which is exactly what #418
   * and #425 report. Resolved after mount instead, matching the pattern already
   * in `components/ProfileDropdown.tsx`: server and first client render agree,
   * then the effect fills in what only the browser can know.
   *
   * `mounted` gates the dates for the same reason and is not the same fact. A
   * timestamp formatted with `toLocaleDateString` uses the formatting
   * environment's time zone: the server runs in UTC and a manager's browser
   * does not, so `generatedAt` rendered an hour and minute that differed
   * between the two renders every single time. The viewer's local time is the
   * right thing to show and is unknowable on the server, so the dates wait for
   * the browser rather than being forced to a fixed zone that would be wrong
   * for somebody.
   */
  const [user, setUser] = useState<User | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setUser(getSavedUser());
    setMounted(true);
  }, []);

  const [signedPhotoUrls, setSignedPhotoUrls] = useState<Map<string, string>>(new Map());
  const [signingPhotos, setSigningPhotos]     = useState(false);
  // Per-path refusals, and the whole-request failure, kept separately: one grey
  // tile among forty is a different message from forty grey tiles.
  const [photoErrors, setPhotoErrors]         = useState<Map<string, string>>(new Map());
  const [photoRequestError, setPhotoRequestError] = useState<string | null>(null);

  const site    = bootstrap?.sites.find((s) => s.id === siteId);
  const entries = bootstrap?.entries.filter((e) => e.siteId === siteId) ?? [];
  const diaries = bootstrap?.diaries.filter((d) => d.siteId === siteId) ?? [];

  useEffect(() => {
    if (!isAuthenticated()) { router.replace("/"); return; }
    Promise.all([
      fetchBootstrap(),
      fetchTimecards(siteId),
      fetchIncidents(siteId),
      fetchInspections(siteId),
      fetchDeliveries(siteId),
    ]).then(([boot, tc, inc, ins, del]) => {
      setBootstrap(boot);
      setTimecards(tc);
      setIncidents(inc);
      setInspections(ins);
      setDeliveries(del);
    }).catch(console.error).finally(() => setLoadingMain(false));
  }, [siteId]);

  const photos = useMemo(() => {
    return entries.flatMap((e) => (e.photos ?? []));
  }, [entries]);

  /**
   * What still needs signing, and a stable key for it.
   *
   * A path that has been attempted is excluded whether it succeeded or failed,
   * which is a correctness requirement and not an optimisation: `photos` is a
   * fresh array on every render, so the effect below would otherwise run on
   * every render, and the only thing that stops it re-requesting is a path
   * being accounted for. When failures were discarded they were never
   * accounted for, so a single path the server refuses put the portal into an
   * unbounded loop of sign requests.
   *
   * `pendingKey` is what the effect actually depends on. The array identity
   * changes every render; the key changes only when the SET of pending paths
   * does, so the effect fires on a real change rather than on a re-render.
   */
  const pendingPhotoPaths = useMemo(
    () => photos.map((p) => p.uri).filter((u) => u && !signedPhotoUrls.has(u) && !photoErrors.has(u)),
    [photos, signedPhotoUrls, photoErrors]
  );
  const pendingKey = pendingPhotoPaths.join("\u0000");

  /**
   * The in-flight guard, and why it is a ref rather than the `signingPhotos`
   * state it used to be.
   *
   * The old condition read `signingPhotos` inside the effect while declaring
   * only `[tab, photos]` as dependencies — the exact shape
   * `eslint-plugin-react-hooks` exists to flag (not installed here on purpose;
   * that is a repo-wide change for its own branch). It happened to work only
   * because `photos` changed identity on every render, so the effect re-ran
   * often enough to see fresh state. Remove that accident — which the
   * `pendingKey` dependency above deliberately does — and a stale `false`
   * would let a second request start while the first was still open, or a
   * stale `true` would wedge signing permanently.
   *
   * A ref is not reactive, so it is never stale and never a dependency. It is
   * the right tool for "is there a request open right now"; state is the right
   * tool for "should the header say Loading", and those are two different
   * questions that were being answered by one variable.
   */
  const signInFlight = useRef(false);
  // Bumped when a request settles, to re-check for work the completed round did
  // not cover. Without it, a pending set that changes while a request is open
  // would be dropped: the effect fires, the ref refuses it, and nothing fires
  // again. Each round strictly shrinks the pending set — every path asked for
  // is recorded — so this terminates.
  const [signRound, setSignRound] = useState(0);

  // Sign photo URLs when the Photos tab is opened.
  useEffect(() => {
    // Both tabs that display photographs, sharing one signing pass: a manager
    // who opens Entries after Photos re-signs nothing, because the results are
    // keyed by path and `pendingPhotoPaths` is already empty for them.
    if ((tab !== "photos" && tab !== "entries") || pendingPhotoPaths.length === 0) return;
    if (signInFlight.current) return;

    const batch = pendingPhotoPaths.slice(0, SIGN_BATCH_SIZE);
    signInFlight.current = true;
    let cancelled = false;
    setSigningPhotos(true);
    setPhotoRequestError(null);

    signUploadPaths(batch)
      .then((results) => {
        if (cancelled) return;
        const signed = new Map<string, string>();
        const refused = new Map<string, string>();
        results.forEach(({ path, url, error }) => {
          if (url) signed.set(path, url);
          else refused.set(path, error ?? "The server returned no address for this photo.");
        });
        // A path asked for and absent from the response is neither signed nor
        // refused; record it so it is not asked for again on the next render.
        const answered = new Set(results.map((r) => r.path));
        batch.forEach((path) => {
          if (!answered.has(path)) refused.set(path, "The server did not answer for this photo.");
        });
        if (signed.size > 0) setSignedPhotoUrls((prev) => new Map([...prev, ...signed]));
        if (refused.size > 0) setPhotoErrors((prev) => new Map([...prev, ...refused]));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // The whole request failed, so nothing is attributable to a path. Left
        // out of `photoErrors` on purpose: the retry below has to be able to ask
        // for all of them again.
        setPhotoRequestError(err instanceof Error ? err.message : "Could not load photos.");
      })
      .finally(() => {
        signInFlight.current = false;
        if (cancelled) return;
        setSigningPhotos(false);
        setSignRound((n) => n + 1);
      });

    // Leaving the tab or changing site abandons the result rather than writing
    // it into state that no longer belongs to it. The ref is cleared by
    // `finally` either way, so an abandoned request does not wedge the next one.
    return () => { cancelled = true; };
  }, [tab, pendingKey, signRound]);

  /**
   * A date as the viewer's browser would write it, or an em dash until the
   * browser is the one doing the writing. One helper for all three call sites
   * so a fourth cannot reintroduce the mismatch by formatting inline.
   */
  const localDate = (value?: string | null, options?: Intl.DateTimeFormatOptions) => {
    if (!value || !mounted) return "—";
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString("en-AU", options);
  };

  // Retry clears the record of what was attempted, which is what lets the effect
  // above ask again.
  const retryPhotos = () => {
    setPhotoErrors(new Map());
    setPhotoRequestError(null);
  };

  const totalHours = useMemo(() => ({
    regular: timecards.reduce((s, t) => s + t.hoursRegular, 0),
    overtime: timecards.reduce((s, t) => s + t.hoursOvertime, 0),
  }), [timecards]);

  const handleApprove = async (diary: Diary) => {
    if (diary.status === "approved") return;
    setApproving(diary.id);
    try {
      const updated = await approveDiary(diary.id);
      setBootstrap((prev) => prev ? {
        ...prev,
        diaries: prev.diaries.map((d) => d.id === updated.id ? updated : d),
      } : prev);
    } catch (e) {
      console.error(e);
    } finally {
      setApproving(null);
    }
  };

  return (
    <div className="app-shell">
      <Sidebar userName={user?.name ?? user?.email ?? "Manager"} />
      <div className="main">
        {/* Top bar */}
        <div className="topbar">
          <button onClick={() => router.back()} className="btn-ghost" style={{ marginRight: 8, padding: "6px 10px" }}>← Sites</button>
          <div className="topbar-title">{site?.name ?? "Site Detail"}</div>
          {site && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {site.client && <span style={{ fontSize: 12, color: "var(--text-secondary)", background: "var(--surface-secondary)", padding: "4px 10px", borderRadius: 8 }}>🏢 {site.client}</span>}
              {site.address && <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>📍 {site.address}</span>}
            </div>
          )}
          <div style={{ marginLeft: "auto" }}><ProfileDropdown /></div>
        </div>

        {/* Tab bar */}
        <div className="tab-bar" style={{
          background: "var(--surface)",
          borderBottom: "2px solid var(--border)",
          display: "flex",
          overflowX: "auto",
          overflowY: "hidden",
          paddingLeft: 16,
          paddingRight: 16,
          scrollbarWidth: "none",
          msOverflowStyle: "none",
        } as React.CSSProperties}>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              style={{
                position: "relative",
                padding: "0 16px",
                height: 44,
                background: "none",
                border: "none",
                color: tab === t.id ? "var(--accent)" : "var(--text-secondary)",
                fontWeight: tab === t.id ? 700 : 500,
                fontSize: 13,
                cursor: "pointer",
                whiteSpace: "nowrap",
                flexShrink: 0,
                letterSpacing: tab === t.id ? "-0.01em" : undefined,
              }}
            >
              {t.label}
              {tab === t.id && (
                <span style={{
                  position: "absolute",
                  bottom: -2,
                  left: 0,
                  right: 0,
                  height: 2,
                  background: "var(--accent)",
                  borderRadius: "2px 2px 0 0",
                }} />
              )}
            </button>
          ))}
        </div>

        <div className="page-body">
          {loadingMain && <SkeletonTable rows={5} />}

          {/* ── Overview ── */}
          {!loadingMain && tab === "overview" && site && (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
                {[
                  { label: "Entries", value: entries.length, icon: "📄", color: "var(--primary)" },
                  { label: "Timecards", value: timecards.length, icon: "⏱️", color: "#0ea5e9" },
                  { label: "Incidents", value: incidents.length, icon: "⚠️", color: "#EF4444" },
                  { label: "Diaries", value: diaries.length, icon: "📋", color: "var(--accent)" },
                ].map((m) => (
                  <div key={m.label} className="metric-card" style={{ borderLeftColor: m.color }}>
                    <div style={{ fontSize: 24, marginBottom: 6 }}>{m.icon}</div>
                    <div className="metric-value" style={{ color: m.color }}>{m.value}</div>
                    <div className="metric-label">{m.label}</div>
                  </div>
                ))}
              </div>

              <div className="card">
                <div className="card-header"><span>📋</span><span className="card-title">Site Information</span></div>
                <div className="card-body">
                  <table className="data-table">
                    <tbody>
                      {[
                        ["Site Name", site.name],
                        ["Client", site.client || "—"],
                        ["Address", site.address || "—"],
                        ["Start Date", localDate(site.startDate)],
                        ["Status", site.status],
                        ["Total Hours Logged", `${(totalHours.regular + totalHours.overtime).toFixed(1)}h (${totalHours.regular.toFixed(1)}h reg + ${totalHours.overtime.toFixed(1)}h OT)`],
                      ].map(([label, value]) => (
                        <tr key={label}>
                          <td style={{ fontWeight: 600, width: 200, color: "var(--text-secondary)", borderBottom: "1px solid var(--border)" }}>{label}</td>
                          <td style={{ borderBottom: "1px solid var(--border)" }}>{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {incidents.filter((i) => i.status === "open").length > 0 && (
                <div className="card" style={{ borderLeft: "3px solid #EF4444" }}>
                  <div className="card-header"><span>⚠️</span><span className="card-title">Open Incidents</span><span className="card-count" style={{ background: "#EF4444" }}>{incidents.filter((i) => i.status === "open").length}</span></div>
                  <table className="data-table">
                    <thead><tr><th>Date</th><th>Severity</th><th>Description</th></tr></thead>
                    <tbody>
                      {incidents.filter((i) => i.status === "open").map((inc) => {
                        const cfg = SEVERITY_CFG[inc.severity] ?? SEVERITY_CFG.minor;
                        return (
                          <tr key={inc.id}>
                            <td>{inc.date}</td>
                            <td><span className="badge" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span></td>
                            <td style={{ maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inc.description}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {/* ── Timesheets ── */}
          {!loadingMain && tab === "timesheets" && (
            <div className="card">
              <div className="card-header">
                <span>⏱️</span><span className="card-title">Crew Timesheets</span>
                <span className="card-count">{timecards.length}</span>
                <div style={{ marginLeft: "auto", fontSize: 13, color: "var(--text-secondary)" }}>
                  {totalHours.regular.toFixed(1)}h reg · <span style={{ color: "var(--accent)" }}>{totalHours.overtime.toFixed(1)}h OT</span> · <strong>{(totalHours.regular + totalHours.overtime).toFixed(1)}h total</strong>
                </div>
              </div>
              {timecards.length === 0
                ? <div className="empty-state"><p>No timecard records yet.</p></div>
                : (
                  <table className="data-table">
                    <thead><tr><th>Date</th><th>Worker</th><th>Trade</th><th>Start</th><th>End</th><th>Break</th><th>Regular</th><th>OT</th><th>Notes</th></tr></thead>
                    <tbody>
                      {timecards.map((tc) => (
                        <tr key={tc.id}>
                          <td>{tc.date}</td>
                          <td style={{ fontWeight: 600 }}>{tc.workerName}</td>
                          <td style={{ color: "var(--text-secondary)" }}>{tc.trade || "—"}</td>
                          <td>{formatTime(tc.startTime)}</td>
                          <td>{formatTime(tc.endTime)}</td>
                          <td>{tc.breakMinutes ? `${tc.breakMinutes}m` : "—"}</td>
                          <td>{tc.hoursRegular.toFixed(2)}h</td>
                          <td style={{ color: tc.hoursOvertime > 0 ? "var(--accent)" : "var(--text-tertiary)", fontWeight: tc.hoursOvertime > 0 ? 700 : 400 }}>{tc.hoursOvertime > 0 ? `${tc.hoursOvertime.toFixed(2)}h` : "—"}</td>
                          <td style={{ color: "var(--text-secondary)", fontSize: 12 }}>{tc.notes || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </div>
          )}

          {/* ── Incidents ── */}
          {!loadingMain && tab === "incidents" && (
            <div className="card">
              <div className="card-header"><span>⚠️</span><span className="card-title">Incident Reports</span><span className="card-count">{incidents.length}</span></div>
              {incidents.length === 0
                ? <div className="empty-state"><p>No incidents recorded.</p></div>
                : (
                  <table className="data-table">
                    <thead><tr><th>Date</th><th>Severity</th><th>Description</th><th>Injured Party</th><th>Corrective Action</th><th>Status</th></tr></thead>
                    <tbody>
                      {incidents.map((inc) => {
                        const cfg = SEVERITY_CFG[inc.severity] ?? SEVERITY_CFG.minor;
                        return (
                          <tr key={inc.id}>
                            <td>{inc.date}</td>
                            <td><span className="badge" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span></td>
                            <td style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>{inc.description}</td>
                            <td style={{ color: "var(--text-secondary)" }}>{inc.injuredParty || "—"}</td>
                            <td style={{ color: "var(--text-secondary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{inc.correctiveAction || "—"}</td>
                            <td>
                              <span className="badge" style={{ background: inc.status === "closed" ? "#F0FDF4" : "#FEF9C3", color: inc.status === "closed" ? "#22C55E" : "#CA8A04" }}>
                                {inc.status === "closed" ? "Closed" : "Open"}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )
              }
            </div>
          )}

          {/* ── Inspections ── */}
          {!loadingMain && tab === "inspections" && (
            <div className="card">
              <div className="card-header"><span>🔍</span><span className="card-title">Site Inspections</span><span className="card-count">{inspections.length}</span></div>
              {inspections.length === 0
                ? <div className="empty-state"><p>No inspections recorded.</p></div>
                : (
                  <table className="data-table">
                    <thead><tr><th>Date</th><th>Status</th><th>Score</th><th>Notes</th><th>Items</th></tr></thead>
                    <tbody>
                      {inspections.map((ins) => {
                        const passed = ins.results?.filter((r) => r.passed === true).length ?? 0;
                        const total  = ins.results?.length ?? 0;
                        return (
                          <tr key={ins.id}>
                            <td>{ins.date}</td>
                            <td>
                              <span className="badge" style={{ background: ins.status === "pass" ? "#F0FDF4" : ins.status === "fail" ? "#FEF2F2" : "#FFF7ED", color: ins.status === "pass" ? "#22C55E" : ins.status === "fail" ? "#EF4444" : "#F59E0B" }}>
                                {ins.status?.toUpperCase() ?? "—"}
                              </span>
                            </td>
                            <td>{total > 0 ? `${passed}/${total} passed` : "—"}</td>
                            <td style={{ color: "var(--text-secondary)", maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis" }}>{ins.notes || "—"}</td>
                            <td style={{ color: "var(--text-tertiary)", fontSize: 12 }}>{total} checklist items</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )
              }
            </div>
          )}

          {/* ── Dockets ── */}
          {!loadingMain && tab === "dockets" && (
            <div className="card">
              <div className="card-header"><span>📦</span><span className="card-title">Delivery Dockets</span><span className="card-count">{deliveries.length}</span></div>
              {deliveries.length === 0
                ? <div className="empty-state"><p>No deliveries recorded.</p></div>
                : (
                  <table className="data-table">
                    <thead><tr><th>Date</th><th>Supplier</th><th>Items</th><th>Quantity</th><th>Notes</th><th>Status</th></tr></thead>
                    <tbody>
                      {deliveries.map((d) => (
                        <tr key={d.id}>
                          <td>{d.date}</td>
                          <td style={{ fontWeight: 600 }}>{d.supplier || "—"}</td>
                          <td style={{ color: "var(--text-secondary)" }}>{d.items?.join(", ") || "—"}</td>
                          <td>{d.quantity || "—"}</td>
                          <td style={{ color: "var(--text-secondary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>{d.notes || "—"}</td>
                          <td>
                            <span className="badge" style={{ background: "#F0FDF4", color: "#22C55E" }}>
                              {d.status ?? "Received"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )
              }
            </div>
          )}

          {/* ── Entries ── */}
          {!loadingMain && tab === "entries" && (
            <EntriesTab
              entries={entries}
              signedUrls={signedPhotoUrls}
              errors={photoErrors}
              requestError={photoRequestError}
              signing={signingPhotos}
              onRetry={retryPhotos}
              formatDate={localDate}
            />
          )}

          {/* ── Photos ── */}
          {!loadingMain && tab === "photos" && (
            <PhotosTab
              photos={photos}
              signedUrls={signedPhotoUrls}
              errors={photoErrors}
              requestError={photoRequestError}
              signing={signingPhotos}
              onRetry={retryPhotos}
            />
          )}

          {/* ── Reports ── */}
          {!loadingMain && tab === "reports" && (
            <div className="card">
              <div className="card-header"><span>📋</span><span className="card-title">AI Diary Reports</span><span className="card-count">{diaries.length}</span></div>
              {diaries.length === 0
                ? (
                  <div className="empty-state">
                    <p>No reports generated for this site yet.</p>
                    <p style={{ fontSize: 12, marginTop: 8 }}>Workers generate reports from the mobile app.</p>
                  </div>
                )
                : diaries.map((diary) => (
                  <div key={diary.id} style={{ padding: "18px 20px", borderBottom: "1px solid var(--border)" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                          <span className="badge" style={{ background: diary.status === "approved" ? "#F0FDF4" : "#FFFBEB", color: diary.status === "approved" ? "#22C55E" : "#F59E0B", textTransform: "uppercase", fontSize: 10 }}>
                            {diary.status}
                          </span>
                          <span className="badge" style={{ background: "var(--surface-secondary)", color: "var(--text-secondary)", textTransform: "uppercase", fontSize: 10 }}>
                            {diary.reportPeriod ?? "daily"}
                          </span>
                          <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                            {localDate(diary.generatedAt, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        {diary.summary && <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0, maxWidth: 600 }}>{diary.summary}</p>}
                        {diary.signedBy && (
                          <div style={{ marginTop: 8, fontSize: 12, color: "var(--success)", fontWeight: 600 }}>
                            ✅ Approved by {diary.signedBy} · {localDate(diary.signedAt)}
                          </div>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexShrink: 0, alignItems: "center" }}>
                        {diary.status !== "approved" && (
                          <button
                            className="btn-accent"
                            style={{ padding: "8px 16px", fontSize: 13 }}
                            disabled={approving === diary.id}
                            onClick={() => void handleApprove(diary)}
                          >
                            {approving === diary.id ? "…" : "✓ Approve"}
                          </button>
                        )}
                        <button
                          className="btn-ghost"
                          style={{ padding: "8px 14px", fontSize: 13 }}
                          onClick={() => router.push(`/reports?siteId=${siteId}&diaryId=${diary.id}`)}
                        >
                          View Full Report
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              }
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
