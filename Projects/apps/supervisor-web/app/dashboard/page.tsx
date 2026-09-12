"use client";

import { useState, useMemo } from "react";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import { SkeletonMetrics, SkeletonTable } from "@/components/Skeleton";
import { getSavedUser } from "@/lib/api";
import { useBootstrap } from "@/lib/useBootstrap";

const STATUS_CFG: Record<string, { label: string; color: string; bg: string }> = {
  active:    { label: "Active",    color: "#22C55E", bg: "#F0FDF4" },
  inactive:  { label: "Inactive",  color: "#9EAFC2", bg: "#F1F5F9" },
  completed: { label: "Complete",  color: "#E8731A", bg: "#FFF7ED" },
  on_hold:   { label: "On Hold",   color: "#F59E0B", bg: "#FFFBEB" },
};

function statusCfg(s: string) { return STATUS_CFG[s] ?? STATUS_CFG.inactive; }

function formatDate() {
  return new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function ProgressBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="progress-track" style={{ marginTop: 6 }}>
      <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, value))}%`, background: color }} />
    </div>
  );
}

function MetricCard({ label, value, accent, iconBg, icon, sub }: {
  label: string; value: number | string; accent: string; iconBg: string; icon: string; sub?: string;
}) {
  return (
    <div className="metric-card" style={{ borderLeftColor: accent }}>
      <div className="metric-icon" style={{ background: iconBg }}>
        <span style={{ fontSize: 16 }}>{icon}</span>
      </div>
      <div className="metric-value" style={{ color: "var(--text)" }}>{value}</div>
      <div className="metric-label">{label}</div>
      {sub && <div className="metric-sub">{sub}</div>}
    </div>
  );
}

export default function DashboardPage() {
  const user = getSavedUser();
  const bootstrap = useBootstrap();
  const data = bootstrap.status === "ok" ? bootstrap.data : null;
  const loading = bootstrap.status === "loading";
  const error = bootstrap.status === "error" ? bootstrap.message : "";
  const [search, setSearch] = useState("");

  const metrics = useMemo(() => {
    if (!data) return null;
    const approved = data.diaries.filter((d) => d.status === "approved").length;
    const pending  = data.diaries.length - approved;
    const active   = data.sites.filter((s) => s.status === "active").length;
    const completed = data.sites.filter((s) => s.status === "completed").length;
    const approvalRate = data.diaries.length > 0 ? Math.round((approved / data.diaries.length) * 100) : 0;
    return { approved, pending, active, completed, approvalRate };
  }, [data]);

  const filteredSites = useMemo(() => {
    if (!data) return [];
    const q = search.toLowerCase();
    if (!q) return data.sites;
    return data.sites.filter(
      (s) => s.name.toLowerCase().includes(q) || s.client?.toLowerCase().includes(q) || s.address?.toLowerCase().includes(q)
    );
  }, [data, search]);

  const firstName = user?.name?.split(" ")[0] ?? "Supervisor";

  return (
    <div className="app-shell">
      <Sidebar userName={user?.name ?? user?.email ?? "Supervisor"} />

      <div className="main">
        {/* Top bar */}
        <Topbar title="Dashboard" right={<span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{formatDate()}</span>} />

        <div className="page-body">
          {/* Greeting header */}
          <div style={{ background: "var(--primary)", borderRadius: "var(--radius)", padding: "20px 24px", color: "#fff", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>{greeting()}, {firstName}</h1>
              <p style={{ fontSize: 13, color: "rgba(255,255,255,0.6)" }}>Here's your portfolio snapshot for today.</p>
            </div>
            {metrics && (
              <div style={{ background: "rgba(255,255,255,0.1)", borderRadius: 10, padding: "8px 14px", fontSize: 13, color: "rgba(255,255,255,0.8)", fontWeight: 500 }}>
                🏗️ {metrics.active} active · {data?.sites.length ?? 0} total projects
              </div>
            )}
          </div>

          {/* KPIs */}
          {loading && <><SkeletonMetrics count={4} /><SkeletonTable rows={4} /></>}
          {error   && <p style={{ color: "var(--error)" }}>{error}</p>}

          {metrics && (
            <>
              <div className="metrics-grid">
                <MetricCard label="Active Sites"      value={metrics.active}   accent="#22C55E" iconBg="#F0FDF4" icon="🏗️" sub={`${metrics.completed} completed`} />
                <MetricCard label="Total Entries"     value={data!.entries.length} accent="var(--primary)" iconBg="#EFF6FF" icon="📄" />
                <MetricCard label="Approved Diaries"  value={metrics.approved} accent="var(--accent)" iconBg="#FFF7ED" icon="✅" sub={`${metrics.approvalRate}% approval rate`} />
                <MetricCard label="Pending Review"    value={metrics.pending}  accent="var(--warning)" iconBg="#FFFBEB" icon="⏳" />
              </div>

              {/* Approval health */}
              {data!.diaries.length > 0 && (
                <div className="health-card">
                  <div className="health-row">
                    <span style={{ fontSize: 16 }}>📊</span>
                    <span className="health-title">Diary Approval Health</span>
                    <span className="health-pct">{metrics.approvalRate}%</span>
                  </div>
                  <ProgressBar
                    value={metrics.approvalRate}
                    color={metrics.approvalRate >= 80 ? "#22C55E" : metrics.approvalRate >= 50 ? "#F59E0B" : "#EF4444"}
                  />
                  <span className="health-sub">{metrics.approved} of {data!.diaries.length} diaries approved</span>
                </div>
              )}

              {/* Sites table */}
              <div className="card">
                <div className="card-header">
                  <span style={{ fontSize: 16 }}>🏢</span>
                  <span className="card-title">Site Portfolio</span>
                  <span className="card-count">{data!.sites.length}</span>
                  <input
                    type="search"
                    placeholder="Search sites…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    style={{ maxWidth: 220, marginLeft: "auto", height: 34, fontSize: 13 }}
                  />
                </div>
                {filteredSites.length === 0 ? (
                  <div className="empty-state">
                    <p>No sites match your search.</p>
                  </div>
                ) : (
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Site</th>
                        <th>Client</th>
                        <th>Status</th>
                        <th>Entries</th>
                        <th>Diaries</th>
                        <th>Approval</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredSites.map((site) => {
                        const siteEntries = data!.entries.filter((e) => e.siteId === site.id);
                        const siteDiaries = data!.diaries.filter((d) => d.siteId === site.id);
                        const approved = siteDiaries.filter((d) => d.status === "approved").length;
                        const rate = siteDiaries.length > 0 ? Math.round((approved / siteDiaries.length) * 100) : 0;
                        const cfg = statusCfg(site.status);
                        return (
                          <tr key={site.id}>
                            <td>
                              <div style={{ fontWeight: 600 }}>{site.name}</div>
                              {site.address && <div style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 2 }}>{site.address}</div>}
                            </td>
                            <td style={{ color: "var(--text-secondary)" }}>{site.client || "—"}</td>
                            <td>
                              <span className="badge" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
                            </td>
                            <td>{siteEntries.length}</td>
                            <td>{siteDiaries.length}</td>
                            <td style={{ minWidth: 100 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <div style={{ flex: 1 }}>
                                  <ProgressBar value={rate} color="var(--accent)" />
                                </div>
                                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)", width: 32, textAlign: "right" }}>{rate}%</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
