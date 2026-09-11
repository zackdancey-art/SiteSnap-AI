"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import { getSavedUser, isAuthenticated } from "@/lib/api";

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

function statusColor(ts: string) {
  const m = minutesAgo(ts);
  if (m < 10) return "#22C55E";
  if (m < 60) return "#F59E0B";
  return "#9EAFC2";
}

export default function LocationsPage() {
  const router = useRouter();
  const user = getSavedUser();
  const [locations, setLocations] = useState<WorkerLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    void fetchLocations();
    intervalRef.current = setInterval(() => void fetchLocations(), 30_000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, []);


  return (
    <div className="app-shell">
      <Sidebar userName={user?.name ?? user?.email ?? "Supervisor"} />
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
          {/* Legend */}
          <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            {[
              { color: "#22C55E", label: "Active (< 10 min)" },
              { color: "#F59E0B", label: "Recent (< 1 hour)" },
              { color: "#9EAFC2", label: "Stale (> 1 hour)" },
            ].map(({ color, label }) => (
              <div key={label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-secondary)" }}>
                <div style={{ width: 12, height: 12, borderRadius: "50%", background: color }} />
                {label}
              </div>
            ))}
            <div style={{ marginLeft: "auto", fontSize: 13, color: "var(--text-tertiary)" }}>
              Auto-refreshes every 30 seconds
            </div>
          </div>

          {/* Map */}
          <div className="card" style={{ overflow: "hidden", padding: 0 }}>
            {loading ? (
              <div style={{ height: 480, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-tertiary)" }}>
                Loading map…
              </div>
            ) : (
              <WorkerMap locations={locations} height={480} />
            )}
          </div>

          {/* Worker list */}
          <div className="card">
            <div className="card-header">
              <span style={{ fontSize: 16 }}>👷</span>
              <span className="card-title">Field Workers</span>
              <span className="card-count">{locations.length}</span>
            </div>
            {locations.length === 0 ? (
              <div className="empty-state">
                <p>No workers have shared their location in the last 4 hours.</p>
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
                  {locations
                    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                    .map((loc) => {
                      const color = statusColor(loc.timestamp);
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
