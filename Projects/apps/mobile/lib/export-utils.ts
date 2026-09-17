import { Platform, Share } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system";
import { Paths } from "expo-file-system";
import type { DiarySection, GeneratedDiary, HourlyNote, Photo, Site } from "@/lib/types";
import { describeGeneration } from "@/lib/provenance";
import { LOGO_DATA_URI } from "@/lib/logo";

export type ReportExportFormat = "pdf" | "doc";

export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeFilename(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export function buildAnnotationOverlayHtml(photo: Photo) {
  if (photo.kind !== "annotated" || !photo.annotationVector) return "";
  const { viewBox, strokes } = photo.annotationVector;
  const paths = strokes
    .map((s) => `<path d="${escapeHtml(s.path)}" fill="none" stroke="${escapeHtml(s.color)}" stroke-width="${s.width}"/>`)
    .join("");
  return `<svg viewBox="${escapeHtml(viewBox)}" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%">${paths}</svg>`;
}

function buildHourlyLogTableHtml(hourlyNotes: HourlyNote[]) {
  const rows = hourlyNotes
    .filter((h) => h.note && h.note.trim())
    .map(
      (h) => `
        <tr>
          <td>${escapeHtml(`${String(h.hour).padStart(2, "0")}:00`)}</td>
          <td>${escapeHtml(h.note)}</td>
        </tr>
      `
    )
    .join("");

  if (!rows) return `<p>No hourly notes recorded.</p>`;

  return `
    <table class="data-table">
      <thead><tr><th>Time</th><th>Note</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function buildSectionTable(section: DiarySection) {
  const rows = [
    ["Date", section.date],
    ["Weather", section.weather || "Not recorded"],
    ["Crew", section.crewCount || "Not recorded"],
    ["Work Completed", section.workCompleted || "N/A"],
    ["Safety", section.safetyObservations || "N/A"],
    ["Materials", section.materialsUsed || "N/A"],
    ["Issues", section.issues || "N/A"],
    ["Photo Observations", section.photoAnalysis || "N/A"],
  ]
    .filter(([, value]) => value && value !== "N/A")
    .map(
      ([label, value]) => `
        <tr>
          <th>${escapeHtml(label)}</th>
          <td>${escapeHtml(value)}</td>
        </tr>
      `
    )
    .join("");

  return `<table class="detail-table">${rows}</table>`;
}

export function buildHtmlDocument(args: {
  title: string;
  subtitle?: string;
  eyebrow?: string;
  meta?: Array<{ label: string; value: string }>;
  body: string;
}) {
  const metaBlock = (args.meta || [])
    .map(
      (item) => `
        <div class="meta-card">
          <div class="meta-label">${escapeHtml(item.label)}</div>
          <div class="meta-value">${escapeHtml(item.value)}</div>
        </div>
      `
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(args.title)}</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #0f2b46;
        background: #eef2f7;
      }
      .page {
        padding: 32px;
      }
      .shell {
        background: #ffffff;
        border-radius: 22px;
        overflow: hidden;
        box-shadow: 0 18px 60px rgba(15, 43, 70, 0.08);
      }
      .hero {
        background: linear-gradient(135deg, #0f2b46 0%, #143a5b 100%);
        color: #ffffff;
        padding: 28px 32px;
        display: flex;
        align-items: center;
        gap: 20px;
      }
      .hero-logo {
        width: 56px;
        height: 56px;
        border-radius: 14px;
        flex-shrink: 0;
      }
      .hero-text { min-width: 0; }
      .eyebrow {
        letter-spacing: 0.18em;
        text-transform: uppercase;
        font-size: 11px;
        opacity: 0.7;
        margin-bottom: 10px;
      }
      h1 {
        margin: 0;
        font-size: 30px;
        line-height: 1.1;
      }
      .subtitle {
        margin-top: 10px;
        font-size: 14px;
        line-height: 1.6;
        color: rgba(255,255,255,0.84);
      }
      .meta-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        padding: 24px 32px 0;
      }
      .meta-card {
        background: #f6f8fb;
        border: 1px solid #dde5ef;
        border-radius: 16px;
        padding: 14px 16px;
      }
      .meta-label {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #6f8095;
        margin-bottom: 6px;
      }
      .meta-value {
        font-size: 15px;
        color: #0f2b46;
        line-height: 1.5;
        font-weight: 600;
      }
      .content {
        padding: 24px 32px 32px;
      }
      .section {
        border: 1px solid #e3eaf2;
        border-radius: 18px;
        padding: 18px;
        margin-bottom: 16px;
        page-break-inside: avoid;
      }
      .section h2 {
        margin: 0 0 12px;
        font-size: 18px;
        color: #0f2b46;
      }
      .section p {
        margin: 0 0 12px;
        color: #31455d;
        line-height: 1.65;
        white-space: pre-wrap;
      }
      .checklist {
        margin: 0;
        padding-left: 18px;
      }
      .checklist li {
        margin-bottom: 8px;
        color: #31455d;
        line-height: 1.55;
      }
      .detail-table {
        width: 100%;
        border-collapse: collapse;
      }
      .detail-table th,
      .detail-table td {
        border-top: 1px solid #e6edf5;
        text-align: left;
        vertical-align: top;
        padding: 10px 0;
        font-size: 13px;
        line-height: 1.55;
      }
      .detail-table th {
        width: 170px;
        color: #6f8095;
        font-weight: 600;
        padding-right: 16px;
      }
      /* Multi-column data table (timesheets, registers). */
      .data-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 13px;
      }
      .data-table thead th {
        background: #f6f8fb;
        padding: 10px 12px;
        text-align: left;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: #6f8095;
        border-bottom: 2px solid #dde5ef;
      }
      .data-table tbody td {
        padding: 10px 12px;
        border-bottom: 1px solid #edf1f7;
        vertical-align: middle;
      }
      .data-table tbody tr:last-child td { border-bottom: none; }
      .footer {
        padding-top: 6px;
        color: #6f8095;
        font-size: 11px;
      }
      @page {
        margin: 24px;
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="shell">
        <div class="hero">
          <img class="hero-logo" src="${LOGO_DATA_URI}" alt="SiteSnap AI" />
          <div class="hero-text">
            ${args.eyebrow ? `<div class="eyebrow">${escapeHtml(args.eyebrow)}</div>` : ""}
            <h1>${escapeHtml(args.title)}</h1>
            ${args.subtitle ? `<div class="subtitle">${escapeHtml(args.subtitle)}</div>` : ""}
          </div>
        </div>
        ${metaBlock ? `<div class="meta-grid">${metaBlock}</div>` : ""}
        <div class="content">
          ${args.body}
          <div class="footer">Generated by SiteSnap AI</div>
        </div>
      </div>
    </div>
  </body>
</html>`;
}

function downloadBlob(filename: string, mimeType: string, content: string) {
  if (Platform.OS !== "web" || typeof document === "undefined") return false;
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
  return true;
}

async function shareNativeFile(uri: string, mimeType: string, dialogTitle: string) {
  const canShare = await Sharing.isAvailableAsync();
  if (canShare) {
    await Sharing.shareAsync(uri, { mimeType, dialogTitle });
    return;
  }
  await Share.share({ title: dialogTitle, message: uri });
}

export async function exportReportDocument(args: {
  filenameBase: string;
  html: string;
  format: ReportExportFormat;
  fallbackText?: string;
}) {
  const filenameBase = normalizeFilename(args.filenameBase) || "sitesnap-report";

  if (Platform.OS === "web") {
    if (args.format === "doc") {
      const downloaded = downloadBlob(`${filenameBase}.doc`, "application/msword", args.html);
      if (downloaded) return;
    }
    const downloaded = downloadBlob(`${filenameBase}.html`, "text/html;charset=utf-8", args.html);
    if (downloaded) return;
  }

  if (args.format === "pdf") {
    const { uri } = await Print.printToFileAsync({ html: args.html });
    await shareNativeFile(uri, "application/pdf", "Export PDF");
    return;
  }

  const docUri = `${Paths.cache.uri || Paths.document.uri || ""}${filenameBase}.doc`;
  await FileSystem.writeAsStringAsync(docUri, args.html, {
    encoding: "utf8",
  });
  await shareNativeFile(docUri, "application/msword", "Export Word Document");
}

function csvCell(value: string) {
  return `"${value.replace(/"/g, '""').replace(/\n/g, " ")}"`;
}

export function buildDiariesCsv(diaries: GeneratedDiary[], sites: Site[]): string {
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const header = ["Site", "Client", "Address", "Report Period", "Status", "Generated", "Generator", "Summary", "Safety Checklist Items", "Sections"];
  const rows = diaries.map((diary) => {
    const site = siteById.get(diary.siteId);
    return [
      csvCell(site?.name ?? ""),
      csvCell(site?.client ?? ""),
      csvCell(site?.address ?? ""),
      csvCell(diary.reportPeriod ?? "daily"),
      csvCell(diary.status),
      csvCell(new Date(diary.generatedAt).toLocaleDateString("en-AU")),
      csvCell(describeGeneration(diary.generation).label),
      csvCell(diary.summary ?? ""),
      csvCell(String(diary.safetyChecklist?.length ?? 0)),
      csvCell(String(diary.sections.length)),
    ].join(",");
  });
  return [header.map(csvCell).join(","), ...rows].join("\n");
}

export async function shareOrDownloadText(filename: string, content: string) {
  const downloaded = downloadBlob(filename, "text/plain;charset=utf-8", content);
  if (downloaded) return;
  await Share.share({ title: filename, message: content });
}

export function buildDiariesText(diaries: GeneratedDiary[], sites: Site[]) {
  if (diaries.length === 0) return "No diaries available.";
  const siteById = new Map(sites.map((site) => [site.id, site]));
  return diaries
    .map((diary, index) => {
      const site = siteById.get(diary.siteId);
      const title = site ? `${site.name} (${site.client})` : `Site ${diary.siteId}`;
      const lines = [
        `Diary ${index + 1}: ${title}`,
        `Status: ${diary.status}`,
        `Period: ${(diary.reportPeriod || "daily").toUpperCase()}`,
        `Generated: ${new Date(diary.generatedAt).toLocaleString("en-AU")}`,
        `Generator: ${describeGeneration(diary.generation).label}`,
        "",
        "Summary:",
        diary.summary || "No summary",
        "",
      ];
      diary.sections.forEach((section, sectionIndex) => {
        lines.push(`Section ${sectionIndex + 1} - ${section.date}`);
        lines.push(`Weather: ${section.weather || "Not recorded"}`);
        lines.push(`Crew: ${section.crewCount || "Not recorded"}`);
        lines.push(`Work: ${section.workCompleted || "N/A"}`);
        lines.push(`Safety: ${section.safetyObservations || "N/A"}`);
        lines.push(`Materials: ${section.materialsUsed || "N/A"}`);
        lines.push(`Issues: ${section.issues || "N/A"}`);
        lines.push(`Photo Notes: ${section.photoAnalysis || "N/A"}`);
        lines.push("");
      });
      return lines.join("\n");
    })
    .join("\n\n");
}

export function buildDiaryReportHtml(args: { diary: GeneratedDiary; site: Site; summary: string; fullReport: string; checklist: string[] }) {
  const { diary, site, summary, fullReport, checklist } = args;
  const sectionsHtml = diary.sections
    .map(
      (section, index) => `
        <section class="section">
          <h2>Daily Record ${index + 1}</h2>
          ${buildSectionTable(section)}
        </section>
      `
    )
    .join("");

  const body = `
    <section class="section">
      <h2>Executive Summary</h2>
      <p>${escapeHtml(summary || "No executive summary available.")}</p>
    </section>
    ${fullReport ? `<section class="section"><h2>Detailed Report</h2><p>${escapeHtml(fullReport)}</p></section>` : ""}
    <section class="section">
      <h2>Safety Checklist</h2>
      ${
        checklist.length > 0
          ? `<ol class="checklist">${checklist.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`
          : "<p>No explicit safety observations were recorded for this report period.</p>"
      }
    </section>
    ${sectionsHtml}
  `;

  return buildHtmlDocument({
    title: site.name,
    subtitle: `${site.client} • ${site.address}`,
    eyebrow: `Site Diary • ${(diary.reportPeriod || "daily").toUpperCase()}`,
    meta: [
      { label: "Status", value: diary.status.toUpperCase() },
      { label: "Generated", value: new Date(diary.generatedAt).toLocaleString("en-AU") },
      // The in-app banner does not travel. Once this is a PDF on a QS's or an
      // insurer's desk it is the only copy they will ever see.
      { label: "Generator", value: describeGeneration(diary.generation).label },
      { label: "Client", value: site.client },
      { label: "Report Period", value: (diary.reportPeriod || "daily").toUpperCase() },
    ],
    body,
  });
}

export function buildDiariesReportHtml(diaries: GeneratedDiary[], sites: Site[], title: string, subtitle: string) {
  const siteById = new Map(sites.map((site) => [site.id, site]));
  const body = diaries
    .map((diary, index) => {
      const site = siteById.get(diary.siteId);
      return `
        <section class="section">
          <h2>${escapeHtml(`${index + 1}. ${site?.name || "Unknown Site"}`)}</h2>
          <p>${escapeHtml(diary.summary || "No summary recorded.")}</p>
          <table class="detail-table">
            <tr><th>Client</th><td>${escapeHtml(site?.client || "Not recorded")}</td></tr>
            <tr><th>Address</th><td>${escapeHtml(site?.address || "Not recorded")}</td></tr>
            <tr><th>Status</th><td>${escapeHtml(diary.status.toUpperCase())}</td></tr>
            <tr><th>Period</th><td>${escapeHtml((diary.reportPeriod || "daily").toUpperCase())}</td></tr>
            <tr><th>Generated</th><td>${escapeHtml(new Date(diary.generatedAt).toLocaleString("en-AU"))}</td></tr>
            <tr><th>Generator</th><td>${escapeHtml(describeGeneration(diary.generation).label)}</td></tr>
            <tr><th>Sections</th><td>${escapeHtml(String(diary.sections.length))}</td></tr>
          </table>
        </section>
      `;
    })
    .join("");

  return buildHtmlDocument({
    title,
    subtitle,
    eyebrow: "SiteSnap Portfolio Export",
    meta: [
      { label: "Generated", value: new Date().toLocaleString("en-AU") },
      { label: "Diaries Included", value: String(diaries.length) },
    ],
    body: body || `<section class="section"><h2>No Diaries</h2><p>No diaries are available for export.</p></section>`,
  });
}

export function buildEntryPhotosReportHtml(args: {
  site: Site;
  entryDate: string;
  notes: string;
  photos: Photo[];
  notesMode?: "free" | "hourly";
  hourlyNotes?: HourlyNote[];
}) {
  const photoCards = args.photos
    .map((photo, index) => {
      const imageMarkup = photo.base64
        ? `<div style="position:relative;margin-bottom:12px;"><img src="data:${escapeHtml(photo.mimeType || "image/jpeg")};base64,${photo.base64}" style="width:100%;max-height:320px;object-fit:cover;border-radius:14px;display:block;" />${buildAnnotationOverlayHtml(photo)}</div>`
        : `<p style="color:#6f8095;font-style:italic;margin:0 0 12px;">Image unavailable</p>`;
      return `
        <section class="section">
          <h2>Photo ${index + 1}${photo.kind === "annotated" ? " (Annotated)" : ""}</h2>
          ${imageMarkup}
          <table class="detail-table">
            <tr><th>Captured</th><td>${escapeHtml(new Date(photo.timestamp).toLocaleString("en-AU"))}</td></tr>
            <tr><th>Caption</th><td>${escapeHtml(photo.caption || "Not recorded")}</td></tr>
          </table>
        </section>
      `;
    })
    .join("");

  const notesMarkup =
    args.notesMode === "hourly"
      ? buildHourlyLogTableHtml(args.hourlyNotes || [])
      : `<p>${escapeHtml(args.notes || "No notes recorded.")}</p>`;

  return buildHtmlDocument({
    title: `${args.site.name} Entry Photos`,
    subtitle: `${args.site.client} • ${args.entryDate}`,
    eyebrow: "Entry Photo Export",
    meta: [
      { label: "Photos", value: String(args.photos.length) },
      { label: "Entry Date", value: args.entryDate },
      { label: "Site", value: args.site.name },
      { label: "Client", value: args.site.client },
    ],
    body: `
      <section class="section">
        <h2>${args.notesMode === "hourly" ? "Hourly Log" : "Entry Notes"}</h2>
        ${notesMarkup}
      </section>
      ${photoCards || `<section class="section"><h2>No Photos</h2><p>No photos were attached to this entry.</p></section>`}
    `,
  });
}
