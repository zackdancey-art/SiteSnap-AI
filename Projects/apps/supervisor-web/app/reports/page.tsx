"use client";

import { useState, useMemo, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import EmailServicePicker from "@/components/EmailServicePicker";
import { getSavedUser, generateDiary, approveDiary } from "@/lib/api";
import type { Diary, Site } from "@/lib/api";
import { useBootstrap } from "@/lib/useBootstrap";
import { analytics } from "@/lib/analytics";
import { SkeletonTable } from "@/components/Skeleton";
import { describeGeneration } from "@/lib/provenance";

// ── Helpers ─────────────────────────────────────────────────────────────────

function esc(str: string | undefined | null): string {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
}
function fmtDateShort(iso: string) {
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}

function buildHtml(diary: Diary, site: Site, orgName: string): string {
  const sections = diary.sections ?? [];
  const checklist = diary.safetyChecklist ?? [];
  // The in-app banner does not travel. Once this is a PDF on a QS's or an
  // insurer's desk it is the only copy they will ever see, so the marking has to
  // be in the document itself, next to the generated date.
  const provenance = describeGeneration(diary.generation);

  const sectionsHtml = sections.map((s, i) => `
    <div class="section">
      <h3>Entry ${i + 1}${s.date ? ` — ${esc(s.date)}` : ""}</h3>
      <table><tbody>
        ${s.weather        ? `<tr><th>Weather</th><td>${esc(s.weather)}</td></tr>` : ""}
        ${s.crewCount      ? `<tr><th>Crew Count</th><td>${esc(s.crewCount)}</td></tr>` : ""}
        ${s.workCompleted  ? `<tr><th>Work Completed</th><td>${esc(s.workCompleted)}</td></tr>` : ""}
        ${s.safetyObservations && s.safetyObservations !== "N/A" ? `<tr><th>Safety</th><td>${esc(s.safetyObservations)}</td></tr>` : ""}
        ${s.materialsUsed  && s.materialsUsed !== "N/A" ? `<tr><th>Materials</th><td>${esc(s.materialsUsed)}</td></tr>` : ""}
        ${s.issues         && s.issues !== "N/A" ? `<tr><th>Issues / Risks</th><td>${esc(s.issues)}</td></tr>` : ""}
      </tbody></table>
    </div>
  `).join("");

  const checklistHtml = checklist.length > 0 ? `
    <div class="section">
      <h3>Safety Checklist</h3>
      <ul>${checklist.map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
    </div>
  ` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Site Diary — ${site.name}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, sans-serif; color: #0F2B46; font-size: 12px; padding: 40px; }
  .header { background: #0F2B46; color: #fff; padding: 24px 28px; border-radius: 8px; margin-bottom: 24px; }
  .header h1 { font-size: 22px; margin-bottom: 6px; }
  .header p  { font-size: 12px; opacity: 0.7; }
  .meta { display: flex; gap: 32px; margin-bottom: 24px; padding: 14px 18px; background: #F5F7FA; border-radius: 8px; }
  .meta dt { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #6B7C93; margin-bottom: 3px; }
  .meta dd { font-size: 13px; font-weight: 600; }
  .summary { background: #FFF7ED; border-left: 3px solid #E8731A; padding: 14px 16px; border-radius: 0 8px 8px 0; margin-bottom: 24px; font-size: 13px; line-height: 1.6; }
  .section { margin-bottom: 20px; border: 1px solid #DDE3EB; border-radius: 8px; overflow: hidden; }
  .section h3 { background: #EDF0F4; padding: 8px 14px; font-size: 12px; font-weight: 700; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 8px 14px; border-bottom: 1px solid #EDF0F4; text-align: left; }
  th { width: 160px; font-weight: 600; color: #6B7C93; font-size: 11px; }
  ul { padding: 10px 14px 10px 28px; }
  li { margin-bottom: 4px; }
  .footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid #DDE3EB; font-size: 11px; color: #9EAFC2; display: flex; justify-content: space-between; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; }
  .approved { background: #F0FDF4; color: #22C55E; }
  .pending  { background: #FFFBEB; color: #F59E0B; }
  .provenance-detail { margin-top: 4px; font-size: 11px; opacity: 0.85; }
  @media print { body { padding: 20px; } .header { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style>
</head>
<body>
  <div class="header">
    <h1>${esc(site.name)} — Site Diary</h1>
    <p>${orgName ? esc(orgName) + " · " : ""}Generated ${fmtDate(diary.generatedAt)} · ${esc(provenance.label)}</p>
    ${provenance.detail ? `<p class="provenance-detail">${esc(provenance.detail)}</p>` : ""}
  </div>
  <div class="meta">
    <div><dt>Site</dt><dd>${esc(site.name)}</dd></div>
    <div><dt>Client</dt><dd>${esc(site.client) || "—"}</dd></div>
    <div><dt>Period</dt><dd style="text-transform:capitalize">${esc(diary.reportPeriod ?? "Daily")}</dd></div>
    <div><dt>Status</dt><dd><span class="badge ${diary.status === "approved" ? "approved" : "pending"}">${diary.status === "approved" ? "Approved" : "Pending Review"}</span></dd></div>
    ${diary.signedBy ? `<div><dt>Signed by</dt><dd>${esc(diary.signedBy)}</dd></div>` : ""}
  </div>
  ${diary.summary ? `<div class="summary"><strong>Summary</strong><br/>${esc(diary.summary)}</div>` : ""}
  ${sectionsHtml}
  ${diary.fullReport && sections.length === 0 ? `<div class="section"><h3>Full Report</h3><div style="padding:14px;line-height:1.7;">${esc(diary.fullReport).replace(/\n/g, "<br/>")}</div></div>` : ""}
  ${checklistHtml}
  <div class="footer">
    <span>SiteSnap AI — Supervisor Portal</span>
    <span>Printed ${new Date().toLocaleDateString("en-AU")}</span>
  </div>
</body>
</html>`;
}

function exportPdf(html: string, _filename: string) {
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => { win.print(); }, 500);
}

function exportWord(html: string, filename: string) {
  const blob = new Blob(["﻿" + html], { type: "application/msword" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${filename}.doc`; a.click();
  URL.revokeObjectURL(url);
}

function exportHtml(html: string, filename: string) {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `${filename}.html`; a.click();
  URL.revokeObjectURL(url);
}

function exportCsv(diaries: Diary[], sites: Site[]) {
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? id;
  const rows = [
    // Generator column for the same reason the HTML header carries one: a CSV
    // leaves the app just as unmarked as a PDF does.
    ["Site", "Period", "Status", "Generated", "Generator", "Summary"],
    ...diaries.map((d) => [
      `"${siteName(d.siteId)}"`,
      d.reportPeriod ?? "daily",
      d.status,
      fmtDateShort(d.generatedAt),
      `"${describeGeneration(d.generation).label}"`,
      `"${(d.summary ?? "").replace(/"/g, "'")}"`,
    ]),
  ];
  const csv = rows.map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `sitesnap-diaries-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
  URL.revokeObjectURL(url);
}


// ── Viewer Modal ─────────────────────────────────────────────────────────────

function DiaryModal({ diary, site, orgName, onClose }: {
  diary: Diary; site: Site; orgName: string; onClose: () => void;
}) {
  const filename = `sitediary-${site.name.replace(/\s+/g, "-").toLowerCase()}-${diary.generatedAt.slice(0, 10)}`;
  const html = buildHtml(diary, site, orgName);
  const sections = diary.sections ?? [];
  const provenance = describeGeneration(diary.generation);
  const [showEmailPicker, setShowEmailPicker] = useState(false);

  const emailSubject = `Site Diary — ${site.name} (${diary.reportPeriod ?? "Daily"} — ${fmtDateShort(diary.generatedAt)})`;
  const emailBody = `Site Diary Report\n\nSite: ${site.name}\nClient: ${site.client ?? "—"}\nPeriod: ${diary.reportPeriod ?? "Daily"}\nGenerated: ${fmtDate(diary.generatedAt)}\nStatus: ${diary.status === "approved" ? "Approved" : "Pending Review"}\n\n${diary.summary ?? "No summary available."}\n\n---\nSent from SiteSnap AI`;

  return (
    <>
    <div style={{
      position: "fixed", inset: 0, zIndex: 1000,
      background: "rgba(15,43,70,0.55)", display: "flex", alignItems: "flex-start", justifyContent: "flex-end",
    }} onClick={onClose}>
      <div style={{
        width: "min(680px, 95vw)", height: "100vh", background: "#fff", overflow: "auto",
        boxShadow: "-8px 0 40px rgba(15,43,70,0.18)",
        display: "flex", flexDirection: "column",
      }} onClick={(e) => e.stopPropagation()}>

        {/* Drawer header */}
        <div style={{ background: "var(--primary)", padding: "20px 24px", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <div>
              <h2 style={{ color: "#fff", fontSize: 18, fontWeight: 700, margin: 0 }}>{site.name}</h2>
              <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, marginTop: 4 }}>
                {(diary.reportPeriod ?? "Daily").charAt(0).toUpperCase() + (diary.reportPeriod ?? "daily").slice(1)} Diary · {fmtDate(diary.generatedAt)}
              </p>
            </div>
            <button onClick={onClose} style={{ background: "rgba(255,255,255,0.1)", border: "none", color: "#fff", borderRadius: 8, width: 32, height: 32, fontSize: 18, cursor: "pointer", flexShrink: 0 }}>×</button>
          </div>
          {/* Export toolbar */}
          <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
            {[
              { label: "🖨️ Print / PDF", action: () => { analytics.reportExported("pdf", diary.siteId); exportPdf(html, filename); } },
              { label: "📄 Word (.doc)", action: () => { analytics.reportExported("word", diary.siteId); exportWord(html, filename); } },
              { label: "🌐 HTML file",   action: () => { analytics.reportExported("html", diary.siteId); exportHtml(html, filename); } },
              { label: "📧 Email",       action: () => { analytics.reportExported("email", diary.siteId); setShowEmailPicker(true); } },
            ].map(({ label, action }) => (
              <button key={label} onClick={action} style={{
                background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.2)",
                color: "#fff", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Diary content */}
        <div style={{ flex: 1, overflow: "auto", padding: "24px" }}>
          {/* Provenance banner. Deliberately a banner and not a toast: a toast is
              gone by the time anyone reads the diary, and "was this written by
              the AI?" is a question asked of the document, not of the moment it
              was generated. */}
          <div style={{
            display: "flex", gap: 10, alignItems: "flex-start",
            background: provenance.tone === "ai" ? "#F0FDF4" : provenance.tone === "fallback" ? "#FFFBEB" : "var(--surface-secondary)",
            borderLeft: `3px solid ${provenance.tone === "ai" ? "#22C55E" : provenance.tone === "fallback" ? "#F59E0B" : "#9EAFC2"}`,
            borderRadius: "0 10px 10px 0", padding: "12px 14px", marginBottom: 20,
          }}>
            <span style={{ fontSize: 15, lineHeight: 1.2 }}>
              {provenance.tone === "ai" ? "✨" : provenance.tone === "fallback" ? "⚠️" : "❔"}
            </span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text-primary)" }}>{provenance.label}</div>
              {provenance.detail && (
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 3 }}>{provenance.detail}</div>
              )}
            </div>
          </div>

          {/* Meta pills */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 20 }}>
            {[
              { label: site.client || "No client", color: "var(--text-secondary)", bg: "var(--surface-secondary)" },
              { label: (diary.reportPeriod ?? "Daily").charAt(0).toUpperCase() + (diary.reportPeriod ?? "daily").slice(1), color: "var(--primary)", bg: "#EFF6FF" },
              {
                label: diary.status === "approved" ? "✓ Approved" : "⏳ Pending Review",
                color: diary.status === "approved" ? "#22C55E" : "#F59E0B",
                bg: diary.status === "approved" ? "#F0FDF4" : "#FFFBEB",
              },
            ].map(({ label, color, bg }) => (
              <span key={label} style={{ fontSize: 12, fontWeight: 600, color, background: bg, padding: "3px 10px", borderRadius: 8 }}>{label}</span>
            ))}
          </div>

          {/* Summary */}
          {diary.summary && (
            <div style={{ background: "#FFF7ED", borderLeft: "3px solid var(--accent)", borderRadius: "0 10px 10px 0", padding: "14px 16px", marginBottom: 20 }}>
              <p style={{ fontSize: 12, fontWeight: 700, color: "var(--accent)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>Summary</p>
              <p style={{ fontSize: 14, lineHeight: 1.6, color: "var(--text)" }}>{diary.summary}</p>
            </div>
          )}

          {/* Sections */}
          {sections.map((s, i) => (
            <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 10, marginBottom: 14, overflow: "hidden" }}>
              <div style={{ background: "var(--surface-secondary)", padding: "8px 14px", fontWeight: 700, fontSize: 13 }}>
                Entry {i + 1}{s.date ? ` — ${s.date}` : ""}
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <tbody>
                  {[
                    ["Weather",         s.weather],
                    ["Crew Count",      s.crewCount],
                    ["Work Completed",  s.workCompleted],
                    ["Safety",          s.safetyObservations !== "N/A" ? s.safetyObservations : null],
                    ["Materials",       s.materialsUsed !== "N/A" ? s.materialsUsed : null],
                    ["Issues / Risks",  s.issues !== "N/A" ? s.issues : null],
                  ].filter(([, v]) => v).map(([label, value]) => (
                    <tr key={label as string} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "8px 14px", width: 140, fontSize: 11, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.04em", verticalAlign: "top" }}>
                        {label}
                      </td>
                      <td style={{ padding: "8px 14px", fontSize: 13, lineHeight: 1.6 }}>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {/* Full report fallback */}
          {diary.fullReport && sections.length === 0 && (
            <div style={{ background: "var(--surface-secondary)", borderRadius: 10, padding: 16, fontSize: 13, lineHeight: 1.8, whiteSpace: "pre-wrap" }}>
              {diary.fullReport}
            </div>
          )}

          {/* Safety checklist */}
          {(diary.safetyChecklist?.length ?? 0) > 0 && (
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, marginTop: 14, overflow: "hidden" }}>
              <div style={{ background: "#F0FDF4", padding: "8px 14px", fontWeight: 700, fontSize: 13, color: "#22C55E" }}>
                ✓ Safety Checklist
              </div>
              <ul style={{ padding: "12px 16px 12px 32px" }}>
                {diary.safetyChecklist!.map((item, i) => (
                  <li key={i} style={{ fontSize: 13, marginBottom: 4 }}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Signature */}
          {diary.signedBy && (
            <div style={{ marginTop: 20, padding: "12px 16px", background: "var(--surface-secondary)", borderRadius: 10, fontSize: 13 }}>
              <strong>Signed by:</strong> {diary.signedBy} {diary.signedAt ? `on ${fmtDate(diary.signedAt)}` : ""}
            </div>
          )}

          {/* No content fallback */}
          {!diary.summary && sections.length === 0 && !diary.fullReport && (
            <p style={{ color: "var(--text-tertiary)", textAlign: "center", padding: 32 }}>No diary content available.</p>
          )}
        </div>
      </div>
    </div>

    {showEmailPicker && (
      <EmailServicePicker
        subject={emailSubject}
        body={emailBody}
        onClose={() => setShowEmailPicker(false)}
      />
    )}
    </>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

function ReportsPageInner() {
  const searchParams = useSearchParams();
  const user = getSavedUser();
  const bootstrap = useBootstrap();
  const [localDiaries, setLocalDiaries] = useState<import("@/lib/api").Diary[]>([]);
  const bootstrapData = bootstrap.status === "ok" ? bootstrap.data : null;
  // Merge: use localDiaries if we have any (created/approved this session), else use bootstrap diaries
  const data = bootstrapData
    ? { ...bootstrapData, diaries: localDiaries.length > 0 ? localDiaries : bootstrapData.diaries }
    : null;
  const loading = bootstrap.status === "loading";
  const [selectedSite, setSelectedSite] = useState<string>(() => searchParams?.get("siteId") ?? "all");
  const [statusFilter, setStatusFilter] = useState<"all" | "approved" | "pending">("all");
  const [activeDiary, setActiveDiary] = useState<Diary | null>(null);
  const [orgName] = useState(() => typeof window !== "undefined" ? (localStorage.getItem("sitesnap.orgName") ?? "") : "");

  // ── Generate panel state ──
  const [genSiteId, setGenSiteId]   = useState<string>(() => searchParams?.get("siteId") ?? "");
  const [genPeriod, setGenPeriod]   = useState<"daily" | "weekly" | "monthly">("daily");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError]     = useState("");
  const [genSuccess, setGenSuccess] = useState("");
  const [approving, setApproving]   = useState<string | null>(null);

  const handleGenerate = async () => {
    if (!genSiteId) { setGenError("Please select a site."); return; }
    const siteEntries = data?.entries.filter((e) => e.siteId === genSiteId) ?? [];
    if (siteEntries.length === 0) { setGenError("This site has no entries to generate a report from."); return; }
    setGenerating(true); setGenError(""); setGenSuccess("");
    try {
      const diary = await generateDiary({ siteId: genSiteId, period: genPeriod, entries: siteEntries });
      setLocalDiaries((prev) => [diary, ...(prev.length > 0 ? prev : (bootstrapData?.diaries ?? []))]);
      setGenSuccess(`✓ ${genPeriod.charAt(0).toUpperCase() + genPeriod.slice(1)} report generated successfully. Scroll down to view it.`);
      setSelectedSite(genSiteId);
      setActiveDiary(diary);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : "Failed to generate report.");
    } finally {
      setGenerating(false);
    }
  };

  const handleApprove = async (diary: Diary) => {
    if (diary.status === "approved") return;
    setApproving(diary.id);
    try {
      const updated = await approveDiary(diary.id);
      setLocalDiaries((prev) => {
        const base = prev.length > 0 ? prev : (bootstrapData?.diaries ?? []);
        return base.map((d: import("@/lib/api").Diary) => d.id === updated.id ? updated : d);
      });
      if (activeDiary?.id === diary.id) setActiveDiary(updated);
    } catch (e) { console.error(e); }
    finally { setApproving(null); }
  };

  const visibleDiaries = useMemo(() => {
    if (!data) return [];
    return [...data.diaries]
      .filter((d) => {
        const matchSite   = selectedSite === "all" || d.siteId === selectedSite;
        const matchStatus = statusFilter === "all" || (statusFilter === "approved" ? d.status === "approved" : d.status !== "approved");
        return matchSite && matchStatus;
      })
      .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
  }, [data, selectedSite, statusFilter]);

  const siteName = useCallback((id: string) => data?.sites.find((s) => s.id === id)?.name ?? id, [data]);
  const getSite   = useCallback((id: string) => data?.sites.find((s) => s.id === id), [data]);

  const approved = visibleDiaries.filter((d) => d.status === "approved").length;
  const pending  = visibleDiaries.length - approved;

  return (
    <div className="app-shell">
      <Sidebar userName={user?.name ?? user?.email ?? "Supervisor"} />
      <div className="main">
        <Topbar title="Reports" right={data ? (
          <button className="btn-ghost" style={{ fontSize: 13 }} onClick={() => exportCsv(visibleDiaries, data.sites)}>
            ⬇ Export CSV
          </button>
        ) : undefined} />

        <div className="page-body">
          {/* KPI strip */}
          {data && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 14 }}>
              <div className="metric-card" style={{ borderLeftColor: "var(--primary)" }}>
                <div className="metric-value">{visibleDiaries.length}</div>
                <div className="metric-label">Total Diaries</div>
              </div>
              <div className="metric-card" style={{ borderLeftColor: "#22C55E" }}>
                <div className="metric-value" style={{ color: "#22C55E" }}>{approved}</div>
                <div className="metric-label">Approved</div>
              </div>
              <div className="metric-card" style={{ borderLeftColor: "var(--warning)" }}>
                <div className="metric-value" style={{ color: "var(--warning)" }}>{pending}</div>
                <div className="metric-label">Pending Review</div>
              </div>
            </div>
          )}

          {/* Filters */}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            {(["all", "approved", "pending"] as const).map((s) => (
              <button key={s} onClick={() => setStatusFilter(s)} style={{
                padding: "6px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer",
                background: statusFilter === s ? "var(--primary)" : "var(--surface)",
                color: statusFilter === s ? "#fff" : "var(--text-secondary)",
                border: statusFilter === s ? "none" : "1.5px solid var(--border)",
              }}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
            {data && (
              <select value={selectedSite} onChange={(e) => setSelectedSite(e.target.value)}
                style={{ marginLeft: "auto", maxWidth: 200, height: 36, fontSize: 13 }}>
                <option value="all">All Sites</option>
                {data.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </div>

          {/* Generate Report Panel */}
          <div className="card">
            <div className="card-header">
              <span style={{ fontSize: 16 }}>⚡</span>
              <span className="card-title">Generate New Report</span>
            </div>
            <div style={{ padding: "16px 20px" }}>
              <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 14 }}>
                Select a site and reporting period. The AI will analyse all logged entries, timecards, photos and observations to produce an engineering-grade site diary.
              </p>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "1 1 180px" }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Site</label>
                  <select
                    value={genSiteId}
                    onChange={(e) => setGenSiteId(e.target.value)}
                    style={{ height: 38, fontSize: 13, borderRadius: 8, border: "1.5px solid var(--border)", padding: "0 10px", background: "var(--surface)", color: "var(--text)" }}
                  >
                    {data?.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: "0 0 160px" }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>Period</label>
                  <select
                    value={genPeriod}
                    onChange={(e) => setGenPeriod(e.target.value as "daily" | "weekly" | "monthly")}
                    style={{ height: 38, fontSize: 13, borderRadius: 8, border: "1.5px solid var(--border)", padding: "0 10px", background: "var(--surface)", color: "var(--text)" }}
                  >
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>
                <button
                  onClick={handleGenerate}
                  disabled={generating || !data}
                  style={{
                    height: 38, padding: "0 20px", borderRadius: 8, fontSize: 13, fontWeight: 700,
                    background: generating ? "var(--border)" : "var(--accent)",
                    color: generating ? "var(--text-secondary)" : "#fff",
                    border: "none", cursor: generating ? "not-allowed" : "pointer",
                    flexShrink: 0, display: "flex", alignItems: "center", gap: 8,
                  }}
                >
                  {generating ? (
                    <>
                      <span style={{ display: "inline-block", width: 14, height: 14, border: "2px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
                      Generating…
                    </>
                  ) : "⚡ Generate Report"}
                </button>
              </div>
              {genError   && <p style={{ marginTop: 10, fontSize: 13, color: "#EF4444", fontWeight: 600 }}>{genError}</p>}
              {genSuccess && <p style={{ marginTop: 10, fontSize: 13, color: "#22C55E", fontWeight: 600 }}>{genSuccess}</p>}
            </div>
          </div>

          {/* Table */}
          <div className="card">
            <div className="card-header">
              <span style={{ fontSize: 16 }}>📋</span>
              <span className="card-title">Diary Log</span>
              <span className="card-count">{visibleDiaries.length}</span>
            </div>
            {loading ? (
              <SkeletonTable rows={5} />
            ) : visibleDiaries.length === 0 ? (
              <div className="empty-state"><p>No diaries match your filters.</p></div>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Site</th>
                    <th>Period</th>
                    <th>Generated</th>
                    <th>Summary</th>
                    <th>Status</th>
                    <th style={{ width: 140 }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDiaries.map((diary) => (
                    <tr key={diary.id}>
                      <td style={{ fontWeight: 600 }}>{siteName(diary.siteId)}</td>
                      <td style={{ textTransform: "capitalize", color: "var(--text-secondary)" }}>
                        {diary.reportPeriod ?? "Daily"}
                      </td>
                      <td style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                        {fmtDateShort(diary.generatedAt)}
                      </td>
                      <td style={{ maxWidth: 280 }}>
                        <span style={{
                          display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical",
                          overflow: "hidden", fontSize: 12, color: "var(--text-secondary)",
                        } as React.CSSProperties}>
                          {diary.summary ?? "—"}
                        </span>
                      </td>
                      <td>
                        <span className="badge" style={diary.status === "approved"
                          ? { background: "#F0FDF4", color: "#22C55E" }
                          : { background: "#FFFBEB", color: "#F59E0B" }}>
                          {diary.status === "approved" ? "✓ Approved" : "⏳ Pending"}
                        </span>
                      </td>
                      <td>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            className="btn-ghost"
                            style={{ fontSize: 12, padding: "4px 10px" }}
                            onClick={() => setActiveDiary(diary)}
                          >
                            View →
                          </button>
                          {diary.status !== "approved" && (
                            <button
                              disabled={approving === diary.id}
                              style={{
                                fontSize: 12, padding: "4px 10px", borderRadius: 8,
                                background: approving === diary.id ? "var(--border)" : "#F0FDF4",
                                color: approving === diary.id ? "var(--text-secondary)" : "#22C55E",
                                border: "1.5px solid #22C55E", fontWeight: 600, cursor: approving === diary.id ? "not-allowed" : "pointer",
                              }}
                              onClick={() => handleApprove(diary)}
                            >
                              {approving === diary.id ? "…" : "✓ Approve"}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Slide-over diary viewer */}
      {activeDiary && getSite(activeDiary.siteId) && (
        <DiaryModal
          diary={activeDiary}
          site={getSite(activeDiary.siteId)!}
          orgName={orgName}
          onClose={() => setActiveDiary(null)}
        />
      )}
    </div>
  );
}

export default function ReportsPage() {
  return (
    <Suspense fallback={<div className="app-shell" style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100vh" }}><p>Loading…</p></div>}>
      <ReportsPageInner />
    </Suspense>
  );
}
