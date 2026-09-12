"use client";

import { useState, useMemo } from "react";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import { SkeletonTable } from "@/components/Skeleton";
import { getSavedUser } from "@/lib/api";
import type { Entry } from "@/lib/api";
import { useBootstrap } from "@/lib/useBootstrap";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

type Grouped = { date: string; entries: (Entry & { siteName: string })[] };

export default function ActivityPage() {
  const user = getSavedUser();
  const bootstrap = useBootstrap();
  const data = bootstrap.status === "ok" ? bootstrap.data : null;
  const loading = bootstrap.status === "loading";
  const [selectedSite, setSelectedSite] = useState<string>("all");

  const grouped = useMemo((): Grouped[] => {
    if (!data) return [];
    const entries = (selectedSite === "all" ? data.entries : data.entries.filter((e) => e.siteId === selectedSite))
      .map((e) => ({ ...e, siteName: data.sites.find((s) => s.id === e.siteId)?.name ?? "Unknown Site" }))
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    const map = new Map<string, typeof entries>();
    for (const entry of entries) {
      const key = entry.date;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(entry);
    }
    return Array.from(map.entries()).map(([date, ents]) => ({ date, entries: ents }));
  }, [data, selectedSite]);

  const totalEntries = data
    ? selectedSite === "all" ? data.entries.length : data.entries.filter((e) => e.siteId === selectedSite).length
    : 0;

  return (
    <div className="app-shell">
      <Sidebar userName={user?.name ?? user?.email ?? "Supervisor"} />
      <div className="main">
        <Topbar title="Activity" />
        <div className="page-body">
          {/* Controls */}
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ fontSize: 14, color: "var(--text-secondary)" }}>
              <strong style={{ color: "var(--text)" }}>{totalEntries}</strong> site entries
            </div>
            {data && (
              <select
                value={selectedSite}
                onChange={(e) => setSelectedSite(e.target.value)}
                style={{ marginLeft: "auto", maxWidth: 220, height: 36, fontSize: 13 }}
              >
                <option value="all">All Sites</option>
                {data.sites.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
          </div>

          {loading && <SkeletonTable rows={6} />}

          {!loading && grouped.length === 0 && (
            <div className="empty-state card" style={{ padding: 48, textAlign: "center" }}>
              <p style={{ fontSize: 32, marginBottom: 8 }}>📋</p>
              <p style={{ fontWeight: 600, color: "var(--text)" }}>No entries yet</p>
              <p>Site diary entries will appear here once logged in the mobile app.</p>
            </div>
          )}

          {/* Timeline */}
          {grouped.map(({ date, entries: dayEntries }) => (
            <div key={date}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                <div style={{ height: 1, flex: 1, background: "var(--border)" }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                  {formatDate(date)}
                </span>
                <div style={{ height: 1, flex: 1, background: "var(--border)" }} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {dayEntries.map((entry) => (
                  <div key={entry.id} className="card" style={{ padding: "14px 18px" }}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                      <div style={{
                        width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                        background: "var(--primary)", color: "#fff",
                        display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16,
                      }}>📄</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <span style={{ fontWeight: 700, fontSize: 14 }}>{entry.siteName}</span>
                          {entry.weather && (
                            <span style={{ fontSize: 12, color: "var(--text-tertiary)", background: "var(--surface-secondary)", padding: "2px 8px", borderRadius: 8 }}>
                              ☁️ {entry.weather}
                            </span>
                          )}
                          {entry.crewCount && (
                            <span style={{ fontSize: 12, color: "var(--text-tertiary)", background: "var(--surface-secondary)", padding: "2px 8px", borderRadius: 8 }}>
                              👷 {entry.crewCount}
                            </span>
                          )}
                        </div>
                        {entry.notes && (
                          <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" } as React.CSSProperties}>
                            {entry.notes}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
