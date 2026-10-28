"use client";

import { useState, useMemo, useEffect, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import { SkeletonCard } from "@/components/Skeleton";
import { getSavedUser, listClients } from "@/lib/api";
import type { Client, Site } from "@/lib/api";
import { useBootstrap } from "@/lib/useBootstrap";
import { groupSitesByClient, shouldShowGroupHeadings } from "@/lib/site-grouping";
import {
  SITE_STATUS_FILTERS,
  canonicalSiteStatus,
  matchesSiteStatusFilter,
  siteStatusCfg,
  siteStatusFilterLabel,
  type SiteStatusFilter,
} from "@/lib/siteStatus";


const GRID: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
  gap: 16,
};

function SitesPageInner() {
  const user = getSavedUser();
  const bootstrap = useBootstrap();
  const data = bootstrap.status === "ok" ? bootstrap.data : null;
  const loading = bootstrap.status === "loading";
  const [search, setSearch] = useState("");
  const [filterStatus, setFilterStatus] = useState<SiteStatusFilter>("all");

  /**
   * The client list, fetched separately from the bootstrap.
   *
   * GET /api/projects/bootstrap does not carry clients and was not widened to:
   * it is the one call every screen in the portal waits on, and this page is
   * the only one that needs the client names. So a second request, and a page
   * that still works without it.
   *
   * THREE STATES, NOT TWO. `null` + not failed is "still arriving", `[]` is a
   * company with no clients, and `clientsFailed` is a request that did not
   * answer. They are distinguished because the ?clientId= banner below has to
   * tell "there is no client with that id" apart from "I could not find out",
   * and because grouping degrades differently: without names, a filed site is
   * headed by its own `client` label, which the API rewrites on every filing
   * for exactly this reason. A failed client fetch therefore costs the
   * canonical heading and nothing else — no site disappears from this list.
   */
  const [clients, setClients] = useState<Client[] | null>(null);
  const [clientsFailed, setClientsFailed] = useState(false);

  useEffect(() => {
    let live = true;
    listClients()
      .then((list) => { if (live) { setClients(list); setClientsFailed(false); } })
      .catch(() => { if (live) { setClients(null); setClientsFailed(true); } });
    return () => { live = false; };
  }, []);

  /**
   * ?clientId= — the link the clients page puts on each card's site count.
   *
   * Read from the URL rather than held in state so the filtered view is a
   * shareable address: a manager can send "these are the sites we have for
   * this client" to another manager and have it still mean that when opened.
   */
  const searchParams = useSearchParams();
  const activeClientId = searchParams.get("clientId");
  const activeClient = activeClientId
    ? clients?.find((c) => c.id === activeClientId) ?? null
    : null;

  const nameById = useMemo(
    () => new Map((clients ?? []).map((c) => [c.id, c.name])),
    [clients]
  );

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.sites.filter((s) => {
      const q = search.toLowerCase();
      // The canonical client name is matched as well as the site's own label,
      // because after a rename the two disagree until the next filing writes
      // the label again — and the name on the clients screen is the one
      // somebody will type.
      const clientName = s.clientId ? nameById.get(s.clientId) : undefined;
      const matchSearch =
        !q ||
        s.name.toLowerCase().includes(q) ||
        s.client?.toLowerCase().includes(q) ||
        clientName?.toLowerCase().includes(q) ||
        s.address?.toLowerCase().includes(q);
      const matchStatus = matchesSiteStatusFilter(s.status, filterStatus);
      // An unresolvable ?clientId= still filters. It must not fall through to
      // an unfiltered list that looks exactly like a page with no filter on
      // it — that is how somebody concludes a client has every site.
      const matchClient = !activeClientId || s.clientId === activeClientId;
      return matchSearch && matchStatus && matchClient;
    });
  }, [data, search, filterStatus, nameById, activeClientId]);

  /**
   * The grouped view, from the module CI holds byte-identical to the phone's.
   * Suppressed while ?clientId= is on: every card is then in one group whose
   * heading would repeat the banner directly above it.
   */
  const groups = useMemo(
    () => groupSitesByClient(filtered, clients ?? []),
    [filtered, clients]
  );
  const showHeadings = !activeClientId && shouldShowGroupHeadings(groups);

  // Tallied by canonical status, so a site stored as `on-hold` is counted under
  // the On Hold tab. The previous version compared against the literal
  // `"on_hold"` and so always reported 0 — see lib/siteStatus.ts.
  const counts = useMemo(() => {
    const tally: Record<SiteStatusFilter, number> = { all: 0, active: 0, completed: 0, "on-hold": 0 };
    if (!data) return tally;
    // Counted over the client filter but not over the search or the status, so
    // the chips say how many sites each status HAS rather than how many are
    // showing — a chip reading "(0)" that you cannot click to anything is the
    // alternative.
    const pool = activeClientId ? data.sites.filter((s) => s.clientId === activeClientId) : data.sites;
    tally.all = pool.length;
    for (const site of pool) {
      const key = canonicalSiteStatus(site.status);
      // `inactive` is the fallback for an unrecognised status and has no tab;
      // those sites are reachable under All, which is why `all` is the length.
      if (key !== "inactive") tally[key] += 1;
    }
    return tally;
  }, [data, activeClientId]);

  function renderCard(site: Site) {
    const cfg = siteStatusCfg(site.status);
    const entries = data!.entries.filter((e) => e.siteId === site.id);
    const diaries = data!.diaries.filter((d) => d.siteId === site.id);
    const approved = diaries.filter((d) => d.status === "approved").length;
    const rate = diaries.length > 0 ? Math.round((approved / diaries.length) * 100) : 0;
    // The canonical name first, then the site's stored label. Both are shown
    // on the card even inside a client's own group: the grouping is a heading
    // somebody may have scrolled past.
    const clientLabel = (site.clientId ? nameById.get(site.clientId) : undefined) || site.client;
    return (
      <Link key={site.id} href={`/sites/${site.id}`} style={{ textDecoration: "none" }}>
      <div className="card" style={{ display: "flex", flexDirection: "column", cursor: "pointer", transition: "box-shadow 0.15s" }}>
        <div style={{ padding: "16px 18px", flex: 1 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, marginBottom: 8 }}>
            <h3 style={{ fontSize: 15, fontWeight: 700, margin: 0, flex: 1 }}>{site.name}</h3>
            <span className="badge" style={{ background: cfg.bg, color: cfg.color, flexShrink: 0 }}>{cfg.label}</span>
          </div>
          {clientLabel && (
            <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 3px", display: "flex", alignItems: "center", gap: 5 }}>
              🏢 {clientLabel}
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
  }

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

          {/* The ?clientId= banner. Always drawn when the parameter is set, so
              a filtered page can never be mistaken for the whole list. */}
          {activeClientId && (
            <div
              className="card"
              style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
            >
              <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                {activeClient ? (
                  <>Filed under <strong style={{ color: "var(--text)" }}>{activeClient.name}</strong></>
                ) : clients === null && !clientsFailed ? (
                  <>Filtering by one client…</>
                ) : clientsFailed ? (
                  // Not "no such client": we do not know that. Say which of
                  // the two it is.
                  <>Filtering by one client — the client list could not be loaded, so it cannot be named here.</>
                ) : (
                  <>No client with that id — it may have been deleted. Its sites are not lost; they are unfiled.</>
                )}
              </span>
              <Link href="/sites" style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600, textDecoration: "none" }}>
                Show all sites →
              </Link>
            </div>
          )}

          {bootstrap.status === "error" && (
            <p style={{ color: "var(--error, #ef4444)", gridColumn: "1/-1", padding: "24px 0" }}>
              ⚠️ {bootstrap.message} — <a href="/" style={{ color: "inherit" }}>Sign in again</a>
            </p>
          )}

          {loading && (
            <div style={GRID}>
              {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} rows={3} />)}
            </div>
          )}

          {/* Site cards, grouped by client with the unfiled ones last */}
          {!loading && filtered.length === 0 && (
            <p style={{ color: "var(--text-secondary)" }}>No sites match your filters.</p>
          )}
          {!loading && filtered.length > 0 && !showHeadings && (
            <div style={GRID}>{filtered.map(renderCard)}</div>
          )}
          {!loading && filtered.length > 0 && showHeadings && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              {groups.map((group) => (
                <section key={group.key}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10 }}>
                    <h2 style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", color: "var(--text-secondary)", margin: 0 }}>
                      {group.title}
                    </h2>
                    <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
                      {group.data.length} {group.data.length === 1 ? "site" : "sites"}
                    </span>
                    {group.clientId && (
                      <Link
                        href={`/sites?clientId=${encodeURIComponent(group.clientId)}`}
                        style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600, textDecoration: "none", marginLeft: "auto" }}
                      >
                        Only this client →
                      </Link>
                    )}
                  </div>
                  <div style={GRID}>{group.data.map(renderCard)}</div>
                </section>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * `useSearchParams` requires a Suspense boundary under the app router, matching
 * app/reports/page.tsx, app/invite/page.tsx and app/signup/page.tsx. Without it
 * the build bails out of static rendering for the whole route.
 */
export default function SitesPage() {
  return (
    <Suspense
      fallback={
        <div className="app-shell">
          <div className="main">
            <div className="page-body"><p>Loading…</p></div>
          </div>
        </div>
      }
    >
      <SitesPageInner />
    </Suspense>
  );
}
