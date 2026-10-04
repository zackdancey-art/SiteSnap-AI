"use client";

import { useEffect, useState, useMemo } from "react";
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
  BootstrapData, Diary,
  Timecard, Incident, Inspection, Delivery,
} from "@/lib/api";

type Tab = "overview" | "timesheets" | "incidents" | "inspections" | "dockets" | "photos" | "reports";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "overview",    label: "Overview",    icon: "🏗️" },
  { id: "timesheets",  label: "Timesheets",  icon: "⏱️" },
  { id: "incidents",   label: "Incidents",   icon: "⚠️" },
  { id: "inspections", label: "Inspections", icon: "🔍" },
  { id: "dockets",     label: "Dockets",     icon: "📦" },
  { id: "photos",      label: "Photos",      icon: "📷" },
  { id: "reports",     label: "Reports",     icon: "📋" },
];

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

function PhotosTab({
  photos, signedUrls, errors, requestError, signing, onRetry,
}: {
  photos: { uri: string; caption?: string }[];
  signedUrls: Map<string, string>;
  errors: Map<string, string>;
  requestError: string | null;
  signing: boolean;
  onRetry: () => void;
}) {
  const [lightbox, setLightbox] = useState<{ url: string; caption?: string } | null>(null);
  const failedCount = photos.filter((p) => errors.has(p.uri)).length;

  return (
    <>
      <div className="card">
        <div className="card-header">
          <span>📷</span>
          <span className="card-title">Site Photos</span>
          <span className="card-count">{photos.length}</span>
          {signing && <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-secondary)" }}>Loading…</span>}
        </div>

        {/* A manager looking at grey squares is told what went wrong and can ask
            again. Shown whether the failure was per-path or whole-request. */}
        {!signing && (requestError || failedCount > 0) && (
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
                : `${failedCount} of ${photos.length} photo${photos.length === 1 ? "" : "s"} could not be loaded.`}
            </span>
            <button className="btn-ghost" onClick={onRetry} style={{ fontSize: 12, padding: "5px 12px" }}>
              Try again
            </button>
          </div>
        )}

        {photos.length === 0 ? (
          <div className="empty-state"><p>No photos uploaded yet.</p></div>
        ) : (
          <div style={{ padding: 20, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 14 }}>
            {photos.map((p, i) => {
              const signedUrl = signedUrls.get(p.uri);
              const failure = signedUrl ? undefined : errors.get(p.uri);
              return (
                <div
                  key={i}
                  onClick={() => signedUrl && setLightbox({ url: signedUrl, caption: p.caption })}
                  style={{
                    borderRadius: 12, overflow: "hidden",
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
                      alt={p.caption ?? `Photo ${i + 1}`}
                      style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                    />
                  ) : (
                    // "Loading…" under a load that has finished and failed is the
                    // defect, not the styling: it tells a manager to wait for
                    // something that is never coming.
                    <div
                      style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, padding: 10, textAlign: "center" }}
                      title={failure ?? undefined}
                    >
                      <span style={{ fontSize: 32, opacity: 0.4 }}>{failure ? "⚠" : "📷"}</span>
                      <span style={{ fontSize: 11, color: failure ? "var(--error)" : "var(--text-tertiary)" }}>
                        {failure ? "Unavailable" : "Loading…"}
                      </span>
                      {failure && (
                        <span style={{ fontSize: 10, color: "var(--text-tertiary)", lineHeight: 1.3 }}>{failure}</span>
                      )}
                    </div>
                  )}
                  {p.caption && signedUrl && (
                    <div style={{
                      position: "absolute", bottom: 0, left: 0, right: 0,
                      background: "linear-gradient(transparent, rgba(15,43,70,0.75))",
                      padding: "20px 10px 8px",
                      fontSize: 11, color: "#fff", fontWeight: 500,
                    }}>
                      {p.caption}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 1000,
            background: "rgba(10,18,30,0.92)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 24,
          }}
          onClick={() => setLightbox(null)}
        >
          <button
            onClick={() => setLightbox(null)}
            style={{ position: "absolute", top: 20, right: 20, background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", borderRadius: 10, width: 38, height: 38, fontSize: 20, cursor: "pointer" }}
          >
            ✕
          </button>
          <img
            src={lightbox.url}
            alt={lightbox.caption ?? "Site photo"}
            style={{ maxWidth: "90vw", maxHeight: "85vh", borderRadius: 12, objectFit: "contain", boxShadow: "0 20px 60px rgba(0,0,0,0.5)" }}
            onClick={(e) => e.stopPropagation()}
          />
          {lightbox.caption && (
            <div style={{ position: "absolute", bottom: 28, left: "50%", transform: "translateX(-50%)", color: "#fff", fontSize: 14, fontWeight: 500, background: "rgba(0,0,0,0.5)", padding: "6px 16px", borderRadius: 20 }}>
              {lightbox.caption}
            </div>
          )}
        </div>
      )}
    </>
  );
}

export default function SiteDetailPage() {
  const router = useRouter();
  const { id: siteId } = useParams<{ id: string }>();
  const user = getSavedUser();

  const [bootstrap, setBootstrap]     = useState<BootstrapData | null>(null);
  const [timecards, setTimecards]     = useState<Timecard[]>([]);
  const [incidents, setIncidents]     = useState<Incident[]>([]);
  const [inspections, setInspections] = useState<Inspection[]>([]);
  const [deliveries, setDeliveries]   = useState<Delivery[]>([]);
  const [loadingMain, setLoadingMain]   = useState(true);
  const [tab, setTab]                   = useState<Tab>("overview");
  const [approving, setApproving]       = useState<string | null>(null);
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

  // Sign photo URLs when the Photos tab is opened.
  //
  // A path that has been attempted is excluded whether it succeeded or failed,
  // which is a correctness requirement and not an optimisation: `photos` is a
  // fresh array on every render, so this effect runs on every render, and the
  // only thing that stops it re-requesting is a path being accounted for. When
  // failures were discarded they were never accounted for, so a single path the
  // server refuses put the portal into an unbounded loop of sign requests —
  // invisible until the CSP fix above made any of this reachable at all.
  useEffect(() => {
    if (tab !== "photos" || photos.length === 0 || signingPhotos) return;
    const unattempted = photos
      .map((p) => p.uri)
      .filter((u) => u && !signedPhotoUrls.has(u) && !photoErrors.has(u));
    if (unattempted.length === 0) return;
    setSigningPhotos(true);
    setPhotoRequestError(null);
    signUploadPaths(unattempted)
      .then((results) => {
        const signed = new Map<string, string>();
        const refused = new Map<string, string>();
        results.forEach(({ path, url, error }) => {
          if (url) signed.set(path, url);
          else refused.set(path, error ?? "The server returned no address for this photo.");
        });
        // A path asked for and absent from the response is neither signed nor
        // refused; record it so it is not asked for again on the next render.
        const answered = new Set(results.map((r) => r.path));
        unattempted.forEach((path) => {
          if (!answered.has(path)) refused.set(path, "The server did not answer for this photo.");
        });
        if (signed.size > 0) setSignedPhotoUrls((prev) => new Map([...prev, ...signed]));
        if (refused.size > 0) setPhotoErrors((prev) => new Map([...prev, ...refused]));
      })
      .catch((err: unknown) => {
        // The whole request failed, so nothing is attributable to a path. Left
        // out of `photoErrors` on purpose: the retry below has to be able to ask
        // for all of them again.
        setPhotoRequestError(err instanceof Error ? err.message : "Could not load photos.");
      })
      .finally(() => setSigningPhotos(false));
  }, [tab, photos]);

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
        <div style={{
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
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14 }}>
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
                        ["Start Date", site.startDate ? new Date(site.startDate).toLocaleDateString("en-AU") : "—"],
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
                            {new Date(diary.generatedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </div>
                        {diary.summary && <p style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.6, margin: 0, maxWidth: 600 }}>{diary.summary}</p>}
                        {diary.signedBy && (
                          <div style={{ marginTop: 8, fontSize: 12, color: "var(--success)", fontWeight: 600 }}>
                            ✅ Approved by {diary.signedBy} · {diary.signedAt ? new Date(diary.signedAt).toLocaleDateString("en-AU") : ""}
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
