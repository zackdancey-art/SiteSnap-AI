"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import { getSavedUser, isAuthenticated, logout, changePassword, revokeAllSessions, fetchCompanyProfile, updateCompanyProfile } from "@/lib/api";
import { useRole } from "@/lib/useRole";

// ── Dev-tools gate ───────────────────────────────────────────────────────────
// The API Connection panel is only shown when NEXT_PUBLIC_SHOW_DEV_TOOLS=true.
// It must NEVER be set in production deployments.
const SHOW_DEV_TOOLS = process.env.NEXT_PUBLIC_SHOW_DEV_TOOLS === "true";

// ── Types ────────────────────────────────────────────────────────────────────

type NotifPrefs = {
  weeklyDigest: boolean;
  approvalAlerts: boolean;
  newEntryAlerts: boolean;
  incidentAlerts: boolean;
  pushEnabled: boolean;
};

type DisplayPrefs = {
  dateFormat: "dd/mm/yyyy" | "mm/dd/yyyy" | "yyyy-mm-dd";
  timezone: string;
  defaultPeriod: "daily" | "weekly" | "monthly";
  compactTables: boolean;
};

type ExportPrefs = {
  defaultFormat: "pdf" | "word" | "html" | "csv";
  includePhotos: boolean;
  includeSafetyChecklist: boolean;
  includeSignature: boolean;
};

type MapPrefs = {
  refreshInterval: number;
  showInactiveWorkers: boolean;
  staleCutoffMinutes: number;
};

type SettingsSection =
  | "account" | "organisation" | "notifications"
  | "display" | "tracking" | "exports"
  | "api" | "privacy" | "about" | "security";

const ALL_SECTIONS: { id: SettingsSection; label: string; icon: string; devOnly?: boolean }[] = [
  { id: "account",       label: "Account",         icon: "👤" },
  { id: "organisation",  label: "Organisation",     icon: "🏢" },
  { id: "notifications", label: "Notifications",    icon: "🔔" },
  { id: "display",       label: "Display",          icon: "🎨" },
  { id: "tracking",      label: "Live Map",         icon: "📍" },
  { id: "exports",       label: "Reports & Exports",icon: "📄" },
  { id: "api",           label: "API Connection",   icon: "🔌", devOnly: true },
  { id: "privacy",       label: "Data & Privacy",   icon: "🔒" },
  { id: "about",         label: "About",            icon: "ℹ️" },
  { id: "security",      label: "Security",         icon: "🛡️" },
];

const SECTIONS = ALL_SECTIONS.filter((s) => !s.devOnly || SHOW_DEV_TOOLS);

const TIMEZONES = [
  "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane",
  "Australia/Perth", "Australia/Adelaide", "Australia/Darwin",
  "Australia/Hobart", "Pacific/Auckland", "Asia/Singapore",
  "America/New_York", "America/Los_Angeles", "Europe/London",
];

// ── Sub-components ────────────────────────────────────────────────────────────

function Panel({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div style={{ padding: "18px 22px", borderBottom: "1px solid var(--border)" }}>
        <h2 style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", margin: 0 }}>{title}</h2>
        {description && <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "4px 0 0", lineHeight: 1.5 }}>{description}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Row({
  label, sub, children, last = false,
}: { label: string; sub?: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "14px 22px",
      borderBottom: last ? "none" : "1px solid var(--border)",
      gap: 24, minHeight: 56,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", lineHeight: 1.3 }}>{label}</div>
        {sub && <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 3, lineHeight: 1.45 }}>{sub}</div>}
      </div>
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        width: 44, height: 24, borderRadius: 12, border: "none", cursor: "pointer",
        background: checked ? "var(--accent)" : "var(--border)",
        position: "relative", transition: "background 0.2s",
      }}
    >
      <span style={{
        position: "absolute", top: 3, left: checked ? 23 : 3,
        width: 18, height: 18, borderRadius: "50%", background: "#fff",
        transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.25)",
        display: "block",
      }} />
    </button>
  );
}

function Select<T extends string>({
  value, onChange, options, width = 180,
}: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; width?: number }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      style={{
        height: 36, width, fontSize: 13, borderRadius: 8,
        border: "1.5px solid var(--border)", padding: "0 10px",
        background: "var(--surface)", color: "var(--text)", cursor: "pointer",
      }}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function BtnGhost({ onClick, children, danger }: { onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "7px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
        background: "none",
        color: danger ? "var(--error)" : "var(--text-secondary)",
        border: `1.5px solid ${danger ? "#FCA5A5" : "var(--border)"}`,
      }}
    >
      {children}
    </button>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const router = useRouter();
  const user = getSavedUser();
  const { companyRole, isOwner } = useRole();
  const [activeSection, setActiveSection] = useState<SettingsSection>("account");

  const [apiUrl, setApiUrl]   = useState(process.env.NEXT_PUBLIC_API_URL ?? "");
  const [apiSaved, setApiSaved] = useState(false);
  const [apiStatus, setApiStatus] = useState<"idle" | "checking" | "ok" | "error">("idle");

  const [notifs, setNotifs] = useState<NotifPrefs>({
    weeklyDigest: true, approvalAlerts: true,
    newEntryAlerts: false, incidentAlerts: true, pushEnabled: false,
  });

  const [display, setDisplay] = useState<DisplayPrefs>({
    dateFormat: "dd/mm/yyyy", timezone: "Australia/Sydney",
    defaultPeriod: "weekly", compactTables: false,
  });

  const [exportPrefs, setExportPrefs] = useState<ExportPrefs>({
    defaultFormat: "pdf", includePhotos: true,
    includeSafetyChecklist: true, includeSignature: true,
  });

  const [mapPrefs, setMapPrefs] = useState<MapPrefs>({
    refreshInterval: 30, showInactiveWorkers: true, staleCutoffMinutes: 60,
  });

  const [orgName, setOrgName]   = useState("");
  const [orgSaved, setOrgSaved] = useState(false);
  const [orgLoading, setOrgLoading] = useState(false);

  const [showPwForm, setShowPwForm] = useState(false);
  const [pwCurrent, setPwCurrent]   = useState("");
  const [pwNew, setPwNew]           = useState("");
  const [pwConfirm, setPwConfirm]   = useState("");
  const [pwLoading, setPwLoading]   = useState(false);
  const [pwError, setPwError]       = useState("");
  const [pwSuccess, setPwSuccess]   = useState(false);

  const [showDangerZone, setShowDangerZone] = useState(false);

  useEffect(() => {
    if (!isAuthenticated()) { router.replace("/"); return; }
    const stored = localStorage.getItem("sitesnap.apiUrl");
    if (stored) setApiUrl(stored);
    const sn = localStorage.getItem("sitesnap.notifPrefs");
    if (sn) { try { setNotifs(JSON.parse(sn) as NotifPrefs); } catch { /* */ } }
    const sd = localStorage.getItem("sitesnap.displayPrefs");
    if (sd) { try { setDisplay(JSON.parse(sd) as DisplayPrefs); } catch { /* */ } }
    const se = localStorage.getItem("sitesnap.exportPrefs");
    if (se) { try { setExportPrefs(JSON.parse(se) as ExportPrefs); } catch { /* */ } }
    const sm = localStorage.getItem("sitesnap.mapPrefs");
    if (sm) { try { setMapPrefs(JSON.parse(sm) as MapPrefs); } catch { /* */ } }
    fetchCompanyProfile().then((c) => setOrgName(c.name)).catch(() => {
      const stored = localStorage.getItem("sitesnap.orgName");
      if (stored) setOrgName(stored);
    });
  }, [router]);

  const saveApiUrl = async () => {
    localStorage.setItem("sitesnap.apiUrl", apiUrl);
    setApiSaved(true);
    setApiStatus("checking");
    try {
      const res = await fetch(`${apiUrl}/api/health`, { signal: AbortSignal.timeout(4000) });
      setApiStatus(res.ok ? "ok" : "error");
    } catch { setApiStatus("error"); }
    setTimeout(() => setApiSaved(false), 2500);
  };

  const updateNotif = (key: keyof NotifPrefs, val: boolean) => {
    const next = { ...notifs, [key]: val };
    setNotifs(next);
    localStorage.setItem("sitesnap.notifPrefs", JSON.stringify(next));
  };

  const updateDisplay = <K extends keyof DisplayPrefs>(key: K, val: DisplayPrefs[K]) => {
    const next = { ...display, [key]: val };
    setDisplay(next);
    localStorage.setItem("sitesnap.displayPrefs", JSON.stringify(next));
  };

  const updateExport = <K extends keyof ExportPrefs>(key: K, val: ExportPrefs[K]) => {
    const next = { ...exportPrefs, [key]: val };
    setExportPrefs(next);
    localStorage.setItem("sitesnap.exportPrefs", JSON.stringify(next));
  };

  const updateMap = <K extends keyof MapPrefs>(key: K, val: MapPrefs[K]) => {
    const next = { ...mapPrefs, [key]: val };
    setMapPrefs(next);
    localStorage.setItem("sitesnap.mapPrefs", JSON.stringify(next));
  };

  const saveOrg = async () => {
    if (!orgName.trim()) return;
    setOrgLoading(true);
    try {
      await updateCompanyProfile({ name: orgName.trim() });
      localStorage.setItem("sitesnap.orgName", orgName.trim());
      setOrgSaved(true);
      setTimeout(() => setOrgSaved(false), 2000);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Failed to save organisation name.");
    } finally {
      setOrgLoading(false);
    }
  };

  const handleSignOut = async () => { await logout(); router.replace("/"); };

  const handleSignOutAll = async () => {
    if (!confirm("This will rotate your session token. Existing tokens expire within 7 days. Continue?")) return;
    try { await revokeAllSessions(); alert("Session token rotated. Other sessions will expire at their natural TTL."); }
    catch (err: unknown) { alert(err instanceof Error ? err.message : "Failed to revoke sessions."); }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError("");
    if (pwNew.length < 12) { setPwError("New password must be at least 12 characters."); return; }
    if (pwNew !== pwConfirm) { setPwError("Passwords do not match."); return; }
    setPwLoading(true);
    try {
      await changePassword(pwCurrent, pwNew);
      setPwSuccess(true);
      setPwCurrent(""); setPwNew(""); setPwConfirm("");
      setTimeout(() => { setPwSuccess(false); setShowPwForm(false); }, 3000);
    } catch (err: unknown) {
      setPwError(err instanceof Error ? err.message : "Failed to change password.");
    } finally { setPwLoading(false); }
  };

  const handleExportData = () => {
    const u = getSavedUser();
    const blob = new Blob([JSON.stringify({ user: u, exportedAt: new Date().toISOString() }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sitesnap-data-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="app-shell">
      <Sidebar userName={user?.name ?? user?.email ?? "Supervisor"} />
      <div className="main">

        {/* Top bar */}
        <Topbar title="Settings" right={<span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{user?.email}</span>} />

        {/* Two-column layout */}
        <div className="page-body" style={{ display: "grid", gridTemplateColumns: "210px 1fr", gap: 24, alignItems: "start" }}>

          {/* ── Left nav ── */}
          <nav style={{
            background: "var(--surface)", borderRadius: "var(--radius)",
            border: "1px solid var(--border)", overflow: "hidden",
            position: "sticky", top: 24,
          }}>
            {SECTIONS.map((s, i) => (
              <button
                key={s.id}
                onClick={() => setActiveSection(s.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 10,
                  padding: "11px 16px", width: "100%",
                  background: activeSection === s.id ? "#F0F4FF" : "none",
                  border: "none",
                  borderBottom: i < SECTIONS.length - 1 ? "1px solid var(--border)" : "none",
                  borderLeft: `3px solid ${activeSection === s.id ? "var(--accent)" : "transparent"}`,
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: activeSection === s.id ? 700 : 500,
                  color: activeSection === s.id ? "var(--primary)" : "var(--text-secondary)",
                  textAlign: "left",
                  transition: "background 0.12s",
                }}
              >
                <span style={{ fontSize: 14, lineHeight: 1, flexShrink: 0 }}>{s.icon}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.label}</span>
              </button>
            ))}
            <button
              onClick={handleSignOut}
              style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "11px 16px", width: "100%",
                background: "none", border: "none",
                borderTop: "1px solid var(--border)",
                cursor: "pointer", fontSize: 13, fontWeight: 600,
                color: "var(--error)", textAlign: "left",
              }}
            >
              <span style={{ fontSize: 14 }}>↩</span>
              <span>Sign Out</span>
            </button>
          </nav>

          {/* ── Right content ── */}
          <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>

            {/* Account */}
            {activeSection === "account" && (
              <>
                <Panel title="Account" description="Your personal profile and login credentials.">
                  <Row label="Full name" sub="Displayed in reports and diary sign-offs">
                    <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>{user?.name ?? "—"}</span>
                  </Row>
                  <Row label="Email address" sub="Your login and notification email">
                    <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>{user?.email ?? "—"}</span>
                  </Row>
                  <Row label="Role" sub="Determines what you can view and action in the dashboard">
                    <span className="badge" style={{
                      background: companyRole === "owner" ? "#F5F3FF" : companyRole === "manager" ? "#FFF7ED" : companyRole === "viewer" ? "#F0F9FF" : "#F0FDF4",
                      color: companyRole === "owner" ? "#7C3AED" : companyRole === "manager" ? "#E8731A" : companyRole === "viewer" ? "#0EA5E9" : "#22C55E",
                    }}>
                      {companyRole.toUpperCase()}
                    </span>
                  </Row>
                  <Row label="Password" sub="Update your account password" last={!showPwForm}>
                    <BtnGhost onClick={() => { setShowPwForm((v) => !v); setPwError(""); setPwSuccess(false); }}>
                      {showPwForm ? "Cancel" : "Change password"}
                    </BtnGhost>
                  </Row>
                  {showPwForm && (
                    <form onSubmit={handleChangePassword} style={{ padding: "4px 22px 18px", display: "flex", flexDirection: "column", gap: 12 }}>
                      {pwError   && <div style={{ background: "#FEE2E2", color: "#991B1B", borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>{pwError}</div>}
                      {pwSuccess && <div style={{ background: "#F0FDF4", color: "#166534", borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>✓ Password changed successfully.</div>}
                      {[
                        { label: "Current password",  val: pwCurrent,  set: setPwCurrent,  ac: "current-password" },
                        { label: "New password (min 12 chars)", val: pwNew, set: setPwNew, ac: "new-password" },
                        { label: "Confirm new password", val: pwConfirm, set: setPwConfirm, ac: "new-password" },
                      ].map(({ label, val, set, ac }) => (
                        <div key={label}>
                          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</label>
                          <input type="password" value={val} onChange={(e) => set(e.target.value)}
                            autoComplete={ac} required style={{ height: 38, fontSize: 14, borderRadius: 8, width: "100%", maxWidth: 360 }} />
                        </div>
                      ))}
                      <button type="submit" className="btn-primary" style={{ alignSelf: "flex-start", padding: "8px 20px" }} disabled={pwLoading}>
                        {pwLoading ? "Saving…" : "Update password"}
                      </button>
                    </form>
                  )}
                </Panel>
              </>
            )}

            {/* Organisation */}
            {activeSection === "organisation" && (
              <Panel title="Organisation" description="Company details shown on exported reports and diary headers.">
                <div style={{ padding: "18px 22px" }}>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                    Organisation name
                  </label>
                  {isOwner ? (
                    <>
                      <div style={{ display: "flex", gap: 10 }}>
                        <input
                          type="text" value={orgName} onChange={(e) => setOrgName(e.target.value)}
                          placeholder="e.g. Acme Construction Ltd"
                          style={{ flex: 1, height: 38, fontSize: 14, borderRadius: 8, maxWidth: 380 }}
                        />
                        <button className="btn-primary" onClick={saveOrg} disabled={orgLoading} style={{ padding: "0 20px", whiteSpace: "nowrap" }}>
                          {orgSaved ? "✓ Saved" : orgLoading ? "Saving…" : "Save"}
                        </button>
                      </div>
                      <p style={{ fontSize: 12, color: "var(--text-tertiary)", marginTop: 8, lineHeight: 1.5 }}>
                        This name appears in the header of all PDF and Word exports, and in diary print-outs.
                      </p>
                    </>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <span style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>{orgName || "—"}</span>
                      <span style={{ fontSize: 12, color: "var(--text-secondary)", background: "var(--surface-secondary)", padding: "3px 10px", borderRadius: 6 }}>Owner-only edit</span>
                    </div>
                  )}
                </div>
              </Panel>
            )}

            {/* Notifications */}
            {activeSection === "notifications" && (
              <Panel title="Notifications" description="Control which events trigger alerts and digests.">
                <Row label="Weekly digest" sub="Summary of all site activity sent every Monday morning">
                  <Toggle checked={notifs.weeklyDigest} onChange={(v) => updateNotif("weeklyDigest", v)} />
                </Row>
                <Row label="Diary approval alerts" sub="Notify when a site diary is approved or sent back for review">
                  <Toggle checked={notifs.approvalAlerts} onChange={(v) => updateNotif("approvalAlerts", v)} />
                </Row>
                <Row label="New entry alerts" sub="Notify when a worker submits a new site entry">
                  <Toggle checked={notifs.newEntryAlerts} onChange={(v) => updateNotif("newEntryAlerts", v)} />
                </Row>
                <Row label="Incident alerts" sub="Immediate notification when an incident is logged — recommended on" last>
                  <Toggle checked={notifs.incidentAlerts} onChange={(v) => updateNotif("incidentAlerts", v)} />
                </Row>
              </Panel>
            )}

            {/* Display */}
            {activeSection === "display" && (
              <Panel title="Display" description="How dates, times and tables appear throughout the portal.">
                <Row label="Date format" sub="How dates are shown in reports and tables">
                  <Select<DisplayPrefs["dateFormat"]>
                    value={display.dateFormat}
                    onChange={(v) => updateDisplay("dateFormat", v)}
                    options={[
                      { value: "dd/mm/yyyy", label: "DD/MM/YYYY" },
                      { value: "mm/dd/yyyy", label: "MM/DD/YYYY" },
                      { value: "yyyy-mm-dd", label: "YYYY-MM-DD" },
                    ]}
                    width={160}
                  />
                </Row>
                <Row label="Timezone" sub="Used for report timestamps and scheduling">
                  <Select<string>
                    value={display.timezone}
                    onChange={(v) => updateDisplay("timezone", v)}
                    options={TIMEZONES.map((tz) => ({ value: tz, label: tz.replace("_", " ") }))}
                    width={210}
                  />
                </Row>
                <Row label="Default report period" sub="Pre-selected period when generating diary reports">
                  <Select<DisplayPrefs["defaultPeriod"]>
                    value={display.defaultPeriod}
                    onChange={(v) => updateDisplay("defaultPeriod", v)}
                    options={[
                      { value: "daily", label: "Daily" },
                      { value: "weekly", label: "Weekly" },
                      { value: "monthly", label: "Monthly" },
                    ]}
                    width={140}
                  />
                </Row>
                <Row label="Compact tables" sub="Reduce row height in all data tables for more on-screen content" last>
                  <Toggle checked={display.compactTables} onChange={(v) => updateDisplay("compactTables", v)} />
                </Row>
              </Panel>
            )}

            {/* Live Map */}
            {activeSection === "tracking" && (
              <Panel title="Live Map" description="Configure how the worker location map behaves in the dashboard.">
                <Row label="Show inactive workers" sub="Display workers whose last ping was more than 1 hour ago (shown in grey)">
                  <Toggle checked={mapPrefs.showInactiveWorkers} onChange={(v) => updateMap("showInactiveWorkers", v)} />
                </Row>
                <Row label="Map auto-refresh interval" sub="How often the supervisor map polls for updated worker positions">
                  <Select<string>
                    value={String(mapPrefs.refreshInterval)}
                    onChange={(v) => updateMap("refreshInterval", Number(v))}
                    options={[
                      { value: "15", label: "15 seconds" },
                      { value: "30", label: "30 seconds" },
                      { value: "60", label: "1 minute" },
                      { value: "120", label: "2 minutes" },
                      { value: "300", label: "5 minutes" },
                    ]}
                    width={160}
                  />
                </Row>
                <Row label="Stale location threshold" sub="Mark a worker as inactive after this many minutes without a ping" last>
                  <Select<string>
                    value={String(mapPrefs.staleCutoffMinutes)}
                    onChange={(v) => updateMap("staleCutoffMinutes", Number(v))}
                    options={[
                      { value: "30", label: "30 minutes" },
                      { value: "60", label: "1 hour" },
                      { value: "120", label: "2 hours" },
                      { value: "240", label: "4 hours" },
                    ]}
                    width={160}
                  />
                </Row>
              </Panel>
            )}

            {/* Reports & Exports */}
            {activeSection === "exports" && (
              <Panel title="Reports & Exports" description="Default options applied when generating and exporting site diaries.">
                <Row label="Default export format" sub="Format used when opening the export menu on a diary">
                  <Select<ExportPrefs["defaultFormat"]>
                    value={exportPrefs.defaultFormat}
                    onChange={(v) => updateExport("defaultFormat", v)}
                    options={[
                      { value: "pdf", label: "PDF (Print)" },
                      { value: "word", label: "Word (.doc)" },
                      { value: "html", label: "HTML file" },
                      { value: "csv", label: "CSV spreadsheet" },
                    ]}
                    width={180}
                  />
                </Row>
                <Row label="Include photo observations" sub="Embed AI photo analysis notes in exported reports">
                  <Toggle checked={exportPrefs.includePhotos} onChange={(v) => updateExport("includePhotos", v)} />
                </Row>
                <Row label="Include safety checklist" sub="Append the AI-generated safety checklist to every exported diary">
                  <Toggle checked={exportPrefs.includeSafetyChecklist} onChange={(v) => updateExport("includeSafetyChecklist", v)} />
                </Row>
                <Row label="Include signature block" sub="Show the 'Signed by' section at the bottom of exported reports" last>
                  <Toggle checked={exportPrefs.includeSignature} onChange={(v) => updateExport("includeSignature", v)} />
                </Row>
              </Panel>
            )}

            {/* API Connection — dev tools only; hidden in production */}
            {SHOW_DEV_TOOLS && activeSection === "api" && (
              <Panel title="API Connection" description="Backend server configuration. Set NEXT_PUBLIC_API_URL in .env.local for a permanent connection.">
                <div style={{ padding: "18px 22px", display: "flex", flexDirection: "column", gap: 12 }}>
                  <div>
                    <label style={{ display: "block", fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
                      API Base URL
                    </label>
                    <div style={{ display: "flex", gap: 10 }}>
                      <input
                        type="text" value={apiUrl} onChange={(e) => setApiUrl(e.target.value)}
                        placeholder="https://api.getsitesnapai.com"
                        style={{ flex: 1, height: 38, fontSize: 14, borderRadius: 8, maxWidth: 380 }}
                      />
                      <button className="btn-primary" onClick={saveApiUrl} style={{ padding: "0 20px", whiteSpace: "nowrap" }}>
                        {apiSaved ? "✓ Saved" : "Save & Test"}
                      </button>
                    </div>
                  </div>
                  {apiStatus !== "idle" && (
                    <div style={{
                      display: "flex", alignItems: "center", gap: 8, fontSize: 13, borderRadius: 8, padding: "9px 14px",
                      color: apiStatus === "ok" ? "#22C55E" : apiStatus === "error" ? "var(--error)" : "var(--text-secondary)",
                      background: apiStatus === "ok" ? "#F0FDF4" : apiStatus === "error" ? "#FEF2F2" : "var(--surface-secondary)",
                    }}>
                      {apiStatus === "checking" && "⏳ Checking connection…"}
                      {apiStatus === "ok"       && "✓ Connected to SiteSnap AI"}
                      {apiStatus === "error"    && "✗ Couldn't connect — check the address and your internet connection"}
                    </div>
                  )}
                </div>
              </Panel>
            )}

            {/* Data & Privacy */}
            {activeSection === "privacy" && (
              <Panel title="Data & Privacy" description="Your data rights and SiteSnap's data handling policies.">
                <Row label="Export my data" sub="Download a JSON copy of your account and session data">
                  <BtnGhost onClick={handleExportData}>Export</BtnGhost>
                </Row>
                <Row label="Data retention" sub="Site diary entries are retained for 7 years per AU & NZ WHS record-keeping requirements">
                  <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", background: "var(--surface-secondary)", padding: "4px 12px", borderRadius: 8 }}>7 years</span>
                </Row>
                <Row label="Privacy Policy" sub="How SiteSnap collects, uses and stores your data — AU & NZ compliant">
                  <a href="/privacy" style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600 }}>View →</a>
                </Row>
                <Row label="Terms of Service" sub="Usage terms, limitations of liability, and jurisdiction" last>
                  <a href="/terms" style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600 }}>View →</a>
                </Row>
              </Panel>
            )}

            {/* About */}
            {activeSection === "about" && (
              <Panel title="About SiteSnap AI" description="Version information and support contacts.">
                <Row label="Application" sub="SiteSnap AI Supervisor Portal">
                  <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text-secondary)" }}>v0.1.0</span>
                </Row>
                <Row label="Platform" sub="SiteSnap AI Supervisor Portal — web">
                  <span style={{ fontSize: 12, background: "var(--surface-secondary)", padding: "4px 12px", borderRadius: 8, color: "var(--text-secondary)", fontWeight: 600 }}>Web</span>
                </Row>
                <Row label="Compliance" sub="Privacy Act 1988 (AU) · Privacy Act 2020 (NZ) · WHS/HSWA 2015">
                  <span style={{ fontSize: 12, background: "#F0FDF4", color: "#22C55E", padding: "4px 12px", borderRadius: 8, fontWeight: 700 }}>AU & NZ</span>
                </Row>
                <Row label="Support" sub="Technical support and billing queries" last>
                  <a href="mailto:support@getsitesnapai.com" style={{ fontSize: 13, color: "var(--accent)", fontWeight: 600 }}>
                    support@getsitesnapai.com
                  </a>
                </Row>
              </Panel>
            )}

            {/* Security */}
            {activeSection === "security" && (
              <>
                <Panel title="Sessions" description="Active sessions for your account across all devices.">
                  <Row label="Current session" sub="You are signed in on this device">
                    <span className="badge" style={{ background: "#F0FDF4", color: "#22C55E" }}>Active</span>
                  </Row>
                  <Row label="Sign out all other devices" sub="Revoke tokens for every other session — your current session stays active" last>
                    <BtnGhost onClick={handleSignOutAll} danger>Sign Out All</BtnGhost>
                  </Row>
                </Panel>

                <Panel title="Danger Zone" description="Irreversible actions — proceed with caution.">
                  <div style={{ padding: "4px 0" }}>
                    <Row label="Delete all site data" sub="Permanently removes all sites, entries and diaries. Cannot be undone.">
                      <BtnGhost danger onClick={() => alert("Contact support@getsitesnapai.com to request data deletion.")}>Delete data</BtnGhost>
                    </Row>
                    <Row label="Close account" sub="Permanently deletes your account and all associated data" last>
                      <BtnGhost danger onClick={() => alert("Contact support@getsitesnapai.com to close your account.")}>Close account</BtnGhost>
                    </Row>
                  </div>
                </Panel>

                {!showDangerZone && (
                  <button
                    onClick={() => setShowDangerZone(true)}
                    style={{ display: "none" }}
                  />
                )}
              </>
            )}

          </div>
        </div>
      </div>
    </div>
  );
}
