"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import { SkeletonCard } from "@/components/Skeleton";
import { getSavedUser } from "@/lib/api";
import { useBootstrap } from "@/lib/useBootstrap";
import {
  SITE_STATUS_FILTERS,
  canonicalSiteStatus,
  matchesSiteStatusFilter,
  siteStatusCfg,
  siteStatusFilterLabel,
  type SiteStatusFilter,
} from "@/lib/siteStatus";


export default function SitesPage() {
  const user = getSavedUser();
  const bootstrap = useBootstrap();
  const data = bootstrap.status === "ok" ? bootstrap.data : null;
  const loading = bootstrap.status === "loading";
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<SiteStatusFilter>("all");

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.sites.filter((s) => {
      const q = search.toLowerCase();
      const matchSearch = !q || s.name.toLowerCase().includes(q) || s.client?.toLowerCase().includes(q) || s.address?.toLowerCase().includes(q);
      const matchStatus = matchesSiteStatusFilter(s.status, filterStatus);
      return matchSearch && matchStatus;
    });
  }, [data, search, filterStatus]);

  // Tallied by canonical status, so a site stored as `on-hold` is counted under
  // the On Hold tab. The previous version compared against the literal
  // `"on_hold"` and so always reported 0 — see lib/siteStatus.ts.
  const counts = useMemo(() => {
    const tally: Record<SiteStatusFilter, number> = { all: 0, active: 0, completed: 0, "on-hold": 0 };
    if (!data) return tally;
    tally.all = data.sites.length;
    for (const site of data.sites) {
      const key = canonicalSiteStatus(site.status);
      // `inactive` is the fallback for an unrecognised status and has no tab;
      // those sites are reachable under All, which is why `all` is the length.
      if (key !== "inactive") tally[key] += 1;
    }
    return tally;
  }, [data]);

  return (
    <div className="app-shell">
      <Sidebar userName={user?.name ?? user?.email ?? "Manager"} />
      <div className="main">
        <Topbar title="Sites" />
        <div className="page-body">
          {/* Filter bar */}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {SITE_STATUS_FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => setFilterStatus(s)}
                style={{
                  padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer",
                  background: filterStatus === s ? "var(--primary)" : "var(--surface)",
                  color: filterStatus === s ? "#fff" : "var(--text-secondary)",
                  border: filterStatus === s ? "none" : "1.5px solid var(--border)",
                }}
              >
                {siteStatusFilterLabel(s)}&nbsp;
                <span style={{ opacity: 0.7 }}>({counts[s]})</span>
              </button>
            ))}
            <input
              type="search"
              placeholder="Search sites…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ marginLeft: "auto", maxWidth: 220, height: 36, fontSize: 13 }}
            />
          </div>

          {bootstrap.status === "error" && (
            <p style={{ color: "var(--error, #ef4444)", gridColumn: "1/-1", padding: "24px 0" }}>
              ⚠️ {bootstrap.message} — <a href="/" style={{ color: "inherit" }}>Sign in again</a>
            </p>
          )}

          {loading && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
              {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} rows={3} />)}
            </div>
          )}

          {/* Site cards grid */}
          {!loading && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
              {filtered.length === 0 ? (
                <p style={{ color: "var(--text-secondary)", gridColumn: "1/-1" }}>No sites match your filters.</p>
              ) : filtered.map((site) => {
                const cfg = siteStatusCfg(site.status);
                const entries = data!.entries.filter((e) => e.siteId === site.id);
                const diaries = data!.diaries.filter((d) => d.siteId === site.id);
                const approved = diaries.filter((d) => d.status === "approved").length;
                const rate = diaries.length > 0 ? Math.round((approved / diaries.length) * 100) : 0;
                return (
                  <Link key={site.id} href={`/sites/${site.id}`} style={{ textDecoration: "none" }}>
                  <div className="card" style={{ display: "flex", flexDirection: "column", cursor: "pointer", transition: "box-shadow 0.15s" }}>
                    <div style={{ padding: "16px 18px", flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
                        <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0, flex: 1 }}>{site.name}</h3>
                        <span className="badge" style={{ background: cfg.bg, color: cfg.color, flexShrink: 0 }}>{cfg.label}</span>
                      </div>
                      {site.client && (
                        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 3px", display: "flex", alignItems: "center", gap: 5 }}>
                          🏢 {site.client}
                        </p>
                      )}
                      {site.address && (
                        <p style={{ fontSize: 12, color: "var(--text-tertiary)", margin: "0 0 12px", display: "flex", alignItems: "center", gap: 5 }}>
                          📍 {site.address}
                        </p>
                      )}
                      <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 20, fontWeight: 700, color: "var(--primary)" }}>{entries.length}</div>
                          <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Entries</div>
                        </div>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 20, fontWeight: 700, color: "var(--accent)" }}>{diaries.length}</div>
                          <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Diaries</div>
                        </div>
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 20, fontWeight: 700, color: "#22C55E" }}>{approved}</div>
                          <div style={{ fontSize: 11, color: "var(--text-tertiary)" }}>Approved</div>
                        </div>
                      </div>
                      {diaries.length > 0 && (
                        <div>
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text-tertiary)", marginBottom: 4 }}>
                            <span>Diary approvals</span>
                            <span style={{ fontWeight: 700, color: "var(--accent)" }}>{rate}%</span>
                          </div>
                          <div className="progress-track">
                            <div className="progress-fill" style={{ width: `${rate}%`, background: "var(--accent)" }} />
                          </div>
                        </div>
                      )}
                    </div>
                    {site.startDate && (
                      <div style={{ padding: "10px 18px", borderTop: "1px solid var(--border)", fontSize: 12, color: "var(--text-tertiary)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span>Started {new Date(site.startDate).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}</span>
                        <span style={{ color: "var(--accent)", fontWeight: 600, fontSize: 12 }}>View details →</span>
                      </div>
                    )}
                  </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
