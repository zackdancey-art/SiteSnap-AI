"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import { getSavedUser, isAuthenticated } from "@/lib/api";
import {
  MAP_PREFS_DEFAULTS, readMapPrefs, describeInterval, describeCutoff,
  type MapPrefs,
} from "@/lib/mapPrefs";

const WorkerMap = dynamic(() => import("@/components/WorkerMap"), { ssr: false });

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type WorkerLocation = {
  id: string;
  userEmail: string;
  userName?: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  siteId?: string;
  timestamp: string;
};

function minutesAgo(ts: string) {
  return Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
}

function freshLabel(ts: string) {
  const m = minutesAgo(ts);
  if (m < 1) return "Just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/**
 * Green while a ping is fresh, amber until the stale cutoff, grey after it.
 *
 * The middle boundary used to be a hardcoded 60 minutes, which happened to
 * equal the default cutoff and so looked correct while ignoring the setting
 * entirely. The ten-minute "active" boundary stays fixed: no control offers it,
 * and inventing one here would be the same defect in the other direction.
 */
function statusColor(ts: string, staleCutoffMinutes: number) {
  const m = minutesAgo(ts);
  if (m < 10) return "#22C55E";
  if (m < staleCutoffMinutes) return "#F59E0B";
  return "#9EAFC2";
}

export default function LocationsPage() {
  const router = useRouter();
  const user = getSavedUser();
  const [locations, setLocations] = useState<WorkerLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /**
   * The Live Map settings, which this page used to ignore completely: it polled
   * on a hardcoded 30 seconds and coloured workers against a hardcoded hour,
   * while the settings page offered three controls over exactly those numbers
   * and wrote them to localStorage (AUDIT L50).
   *
   * Starts at the shared defaults so the first render matches the server's, and
   * is replaced from localStorage on mount — the pattern L49 is about.
   */
  const [mapPrefs, setMapPrefs] = useState<MapPrefs>(MAP_PREFS_DEFAULTS);

  const fetchLocations = async () => {
    try {
      const token = typeof window !== "undefined" ? localStorage.getItem("sitesnap.token") : null;
      const res = await fetch(`${API_URL}/api/location/workers`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) {
        const data = await res.json() as { locations: WorkerLocation[] };
        setLocations(data.locations);
        setLastRefresh(new Date());
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isAuthenticated()) { router.replace("/"); return; }
    setMapPrefs(readMapPrefs());
  }, [router]);

  // Separate from the mount effect so that changing the interval restarts the
  // timer rather than needing a reload, and so the cleanup cannot leave two
  // timers running. Re-reading on mount is the one fetch everyone gets; the
  // interval is whatever the manager chose.
  useEffect(() => {
    if (!isAuthenticated()) return;
    void fetchLocations();
    intervalRef.current = setInterval(() => void fetchLocations(), mapPrefs.refreshInterval * 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [mapPrefs.refreshInterval]);


  /**
   * What the map and the list show. "Show inactive workers" was the third dead
   * control: it persisted, it re-displayed, and nothing anywhere filtered on
   * it. Derived once so the map, the header count and the table cannot
   * disagree about who is on screen.
   */
  const visibleLocations = mapPrefs.showInactiveWorkers
    ? locations
    : locations.filter((l) => minutesAgo(l.timestamp) < mapPrefs.staleCutoffMinutes);
  const hiddenCount = locations.length - visibleLocations.length;

  return (
    <div className="app-shell">
      <Sidebar userName={user?.name ?? user?.email ?? "Manager"} />
      <div className="main">
        <Topbar title="Live Locations" right={
          <>
            <span style={{ fontSize: 12, color: "var(--text-tertiary)" }}>
              Refreshed {lastRefresh.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
            </span>
            <button
              className="btn-ghost"
              style={{ padding: "6px 12px", fontSize: 13 }}
              onClick={() => void fetchLocations()}
            >
              ↻ Refresh
            </button>
          </>
        } />

        <div className="page-body">
          {/* Legend. Every number in it comes from the settings, including the
              two that used to be written out as "1 hour" beside a threshold a
              manager could set to four. */}
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            {[
              { color: "#22C55E", label: "Active (< 10 min)" },
              { color: "#F59E0B", label: `Recent (< ${describeCutoff(mapPrefs.staleCutoffMinutes)})` },
              ...(mapPrefs.showInactiveWorkers
                ? [{ color: "#9EAFC2", label: `Stale (> ${describeCutoff(mapPrefs.staleCutoffMinutes)})` }]
                : []),
            ].map(({ color, label }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-secondary)" }}>
                <div style={{ width: 12, height: 12, borderRadius: "50%", background: color }} />
                {label}
              </div>
            ))}
            <div style={{ marginLeft: "auto", fontSize: 13, color: "var(--text-tertiary)" }}>
              Auto-refreshes every {describeInterval(mapPrefs.refreshInterval)}
              {!mapPrefs.showInactiveWorkers && " · inactive workers hidden"}
            </div>
          </div>

          {/* Map */}
          <div className="card" style={{ overflow: "hidden", padding: 0 }}>
            {loading ? (
              <div style={{ height: 480, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-tertiary)" }}>
                Loading map…
              </div>
            ) : (
              <WorkerMap locations={visibleLocations} height={480} />
            )}
          </div>

          {/* Worker list */}
          <div className="card">
            <div className="card-header">
              <span style={{ fontSize: 16 }}>👷</span>
              <span className="card-title">Field Workers</span>
              <span className="card-count">{visibleLocations.length}</span>
              {hiddenCount > 0 && (
                <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-tertiary)" }}>
                  {hiddenCount} inactive hidden — change this under Settings → Live Map
                </span>
              )}
            </div>
            {visibleLocations.length === 0 ? (
              <div className="empty-state">
                <p>
                  {hiddenCount > 0
                    ? `No active workers. ${hiddenCount} worker${hiddenCount === 1 ? " has" : "s have"} not pinged in ${describeCutoff(mapPrefs.staleCutoffMinutes)} and are hidden by your Live Map settings.`
                    : "No workers have shared their location recently."}
                </p>
                <p style={{ fontSize: 12, marginTop: 8 }}>Workers enable tracking in the mobile app under Settings → Location Tracking.</p>
              </div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th>Coordinates</th>
                    <th>Accuracy</th>
                    <th>Last Seen</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...visibleLocations]
                    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                    .map((loc) => {
                      const color = statusColor(loc.timestamp, mapPrefs.staleCutoffMinutes);
                      const initials = (loc.userName ?? loc.userEmail).split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
                      return (
                        <tr key={loc.id}>
                          <td>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <div style={{ width: 36, height: 36, borderRadius: "50%", background: color, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 700, fontSize: 13, flexShrink: 0 }}>
                                {initials}
                              </div>
                              <div>
                                <div style={{ fontWeight: 600 }}>{loc.userName ?? "Unknown"}</div>
                                <div style={{ fontSize: 12, color: "var(--text-tertiary)" }}>{loc.userEmail}</div>
                              </div>
                            </div>
                          </td>
                          <td style={{ fontFamily: "monospace", fontSize: 12 }}>
                            {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)}
                          </td>
                          <td style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                            {loc.accuracy ? `±${Math.round(loc.accuracy)}m` : "—"}
                          </td>
                          <td style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                            {new Date(loc.timestamp).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}
                          </td>
                          <td>
                            <span className="badge" style={{ background: color + "22", color }}>
                              {freshLabel(loc.timestamp)}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
