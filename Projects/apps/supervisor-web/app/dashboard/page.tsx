"use client";

import { useState, useMemo } from "react";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import { SkeletonMetrics, SkeletonTable } from "@/components/Skeleton";
import { getSavedUser } from "@/lib/api";
import { useBootstrap } from "@/lib/useBootstrap";
import { usePortfolioSummary } from "@/lib/usePortfolioSummary";
import { useRole } from "@/lib/useRole";
import { siteStatusCfg } from "@/lib/siteStatus";

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
  const { canSeeSupervisorDashboard, isUnknownRole } = useRole();
  const bootstrap = useBootstrap();
  const data = bootstrap.status === "ok" ? bootstrap.data : null;
  const loading = bootstrap.status === "loading";
  const error = bootstrap.status === "error" ? bootstrap.message : "";
  const [search, setSearch] = useState("");

  /**
   * The metric cards count in the DATABASE, not in this component. AUDIT L98.
   *
   * Every figure here used to be measured off the `useBootstrap()` arrays —
   * `data.sites.filter(...).length`, `data.entries.length` and so on. Those
   * arrays arrive capped at the API's default `limit = 200`, because
   * `/projects/bootstrap` passes no limit to `listSites`/`listEntries`/
   * `listDiaries`. So a company with five thousand entries read "200", and the
   * derived figures were worse than the raw ones: an approval rate of
   * `approved / diaries.length` is the rate across the most recent two hundred
   * diaries, rendered as a percentage of all of them, with a progress bar and a
   * red/amber/green colour behind it.
   *
   * `usePortfolioSummary` asks `GET /projects/summary`, which counts in SQL.
   *
   * When that request has not succeeded, these cards show an em dash rather
   * than falling back to the bootstrap arrays. Falling back is the tempting
   * option and it is the wrong one: it would restore exactly the silently-wrong
   * number this change exists to remove, on the one path nobody tests. A
   * missing number is visibly missing; a capped one is not.
   */
  const summary = usePortfolioSummary(canSeeSupervisorDashboard);
  const totals = summary.status === "ok" ? summary.data : null;
  const totalsError = summary.status === "error" ? summary.message : "";

  const metrics = useMemo(() => {
    if (!totals) return null;
    const approvalRate = totals.diaries > 0 ? Math.round((totals.approvedDiaries / totals.diaries) * 100) : 0;
    return {
      approved:   totals.approvedDiaries,
      pending:    totals.draftDiaries,
      active:     totals.activeSites,
      completed:  totals.completedSites,
      sites:      totals.sites,
      entries:    totals.entries,
      diaries:    totals.diaries,
      approvalRate,
    };
  }, [totals]);

  const filteredSites = useMemo(() => {
    if (!data) return [];
    const q = search.toLowerCase();
    if (!q) return data.sites;
    return data.sites.filter(
      (s) => s.name.toLowerCase().includes(q) || s.client?.toLowerCase().includes(q) || s.address?.toLowerCase().includes(q)
    );
  }, [data, search]);

  const firstName = user?.name?.split(" ")[0] ?? "Manager";

  /**
   * Hiding the sidebar link is not the permission. `/dashboard` is a URL
   * anybody can type, so the screen refuses on its own, and says something
   * true while doing it: not "failed to load", not an empty shell, not a
   * spinner that never resolves. Reporting a refusal as a breakage is the
   * habit AUDIT L73 named, and it is exactly as available here as it was
   * there.
   *
   * The sidebar still renders, so this is a wrong turn rather than a dead end.
   *
   * `useBootstrap()` above still runs — it is a hook and cannot be made
   * conditional, and `/projects/bootstrap` is a route crew are entitled to in
   * any case, since the whole field product reads it. What is withheld is the
   * supervision VIEW of that data, which is what the decision names. The
   * route this screen's figures come from, GET /projects/summary, is viewer+ and
   * refuses CREW at the API regardless of what this component does — but it
   * does answer a viewer, who no longer sees this screen. So for a viewer this
   * is a screen withheld, not data withheld, and the PR body says so rather
   * than letting the refusal imply otherwise.
   *
   * GET /projects/reports/supervisor is viewer+ too and is often described as
   * this screen's other route. It is not: nothing in either client calls it.
   * Both export their report HTML locally from bootstrap data. Checked with
   * `grep -rn "reports/supervisor" Projects/apps`, which returns only comments.
   *
   * TWO REFUSALS, NOT ONE
   *
   * An absent or unrecognised role is refused here, same as crew — the
   * predicate names the two roles it admits. But it is a different problem with
   * a different fix: `companyRole` is optional on the saved user, so a session
   * stored by an older build can carry none, and telling a manager the
   * dashboard is for managers would be both untrue and unactionable. The second
   * branch tells them the one thing that fixes it.
   */
  if (!canSeeSupervisorDashboard) {
    return (
      <div className="app-shell">
        <Sidebar userName={user?.name ?? user?.email ?? "Manager"} />
        <div className="main">
          <Topbar title="Dashboard" />
          <div className="page-body">
            <div className="card" style={{ padding: 28, maxWidth: 560 }}>
              {isUnknownRole ? (
                <>
                  <h1 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
                    Sign in again to see this
                  </h1>
                  <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 0 }}>
                    We can&apos;t tell what your account&apos;s role is from this browser&apos;s saved
                    session, so the dashboard is held back. Signing out and back in will settle it.
                    Everything else in the portal still works in the meantime.
                  </p>
                </>
              ) : (
                <>
                  <h1 style={{ fontSize: 18, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>
                    You don&apos;t have access to this
                  </h1>
                  <p style={{ fontSize: 14, color: "var(--text-secondary)", marginBottom: 0 }}>
                    The dashboard is for managers and owners. Everything else you need — sites,
                    diaries, photos, timesheets and deliveries — is yours, and the quickest place
                    to do it is the SiteSnap app on your phone.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar userName={user?.name ?? user?.email ?? "Manager"} />

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
                🏗️ {metrics.active} active · {metrics.sites} total projects
              </div>
            )}
          </div>

          {/* KPIs */}
          {loading && <><SkeletonMetrics count={4} /><SkeletonTable rows={4} /></>}
          {error   && <p style={{ color: "var(--error)" }}>{error}</p>}

          {/*
            Gated on `data`, not on `metrics`. The site table below reads the
            bootstrap payload, so gating the whole block on the totals request
            would make a failed count take the table down with it — a second
            screen lost to a number.
          */}
          {data && (
            <>
              <div className="metrics-grid">
                <MetricCard label="Active Sites"      value={metrics?.active ?? "—"}   accent="#22C55E" iconBg="#F0FDF4" icon="🏗️" sub={metrics ? `${metrics.completed} completed` : undefined} />
                <MetricCard label="Total Entries"     value={metrics?.entries ?? "—"} accent="var(--primary)" iconBg="#EFF6FF" icon="📄" />
                <MetricCard label="Approved Diaries"  value={metrics?.approved ?? "—"} accent="var(--accent)" iconBg="#FFF7ED" icon="✅" sub={metrics ? `${metrics.approvalRate}% approval rate` : undefined} />
                <MetricCard label="Pending Review"    value={metrics?.pending ?? "—"}  accent="var(--warning)" iconBg="#FFFBEB" icon="⏳" />
              </div>

              {totalsError && (
                <p style={{ fontSize: 13, color: "var(--text-secondary)", marginTop: 4 }}>
                  Portfolio totals are unavailable — {totalsError}
                </p>
              )}

              {/* Approval health */}
              {metrics && metrics.diaries > 0 && (
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
                  <span className="health-sub">{metrics.approved} of {metrics.diaries} diaries approved</span>
                </div>
              )}

              {/* Sites table */}
              <div className="card">
                <div className="card-header">
                  <span style={{ fontSize: 16 }}>🏢</span>
                  <span className="card-title">Site Portfolio</span>
                  <span className="card-count">{metrics?.sites ?? data.sites.length}</span>
                  {metrics && metrics.sites > data.sites.length && (
                    <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
                      showing {data.sites.length}
                    </span>
                  )}
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
                        const cfg = siteStatusCfg(site.status);
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
