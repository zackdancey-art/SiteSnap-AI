import { Platform, Share } from "react-native";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";
import { File, Paths } from "expo-file-system";
import type { DiarySection, GeneratedDiary, HourlyNote, Photo, Site } from "@/lib/types";
import {
  describeUnavailable,
  isLoadableUri,
  resolvePhotoSource,
  type PhotoUnavailableReason,
} from "@/lib/photo-uri";
import { reportMediaFailure } from "@/lib/media-telemetry";
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

  const docUri = writeCacheFile(`${filenameBase}.doc`, args.html);
  await shareNativeFile(docUri, "application/msword", "Export Word Document");
}

/**
 * Writes into the cache directory and returns the file's uri.
 *
 * This used `FileSystem.writeAsStringAsync` from the "expo-file-system" root
 * import. On expo-file-system 19 that name is a deprecation stub whose body is
 * `throw errorOnLegacyMethodUse(...)` — it throws unconditionally, so the Word
 * export threw on every native invocation. The `File` class is the live API.
 */
function writeCacheFile(
  filename: string,
  content: string,
  encoding: "utf8" | "base64" = "utf8"
): string {
  const file = new File(Paths.cache, filename);
  // create() throws when the file already exists; a re-export of the same entry
  // on the same day hits exactly that path.
  if (file.exists) file.delete();
  file.create();
  file.write(content, { encoding });
  return file.uri;
}

/**
 * Materialises one photo as a real file in the cache so it can be shared as an
 * image. Returns null when there is no image to share.
 *
 * The gallery shared `photo.uri` directly. For a synced photo that is a signed
 * proxy URL that expires two hours later, so the recipient of a shared
 * "photograph" got a link that 403s the next day — and the signature itself is a
 * credential, sent to whoever the share sheet was pointed at.
 */
export async function writeSharablePhotoFile(
  photo: Photo,
  filenameBase: string
): Promise<string | null> {
  const [resolved] = await resolvePhotosForExport([photo]);
  const dataUri = resolved?.exportDataUri;
  if (!dataUri) return null;
  const match = /^data:([^;,]*);base64,(.*)$/s.exec(dataUri);
  if (!match) return null;
  const extension = match[1] === "image/png" ? "png" : "jpg";
  const name = `${normalizeFilename(filenameBase) || "sitesnap-photo"}.${extension}`;
  try {
    return writeCacheFile(name, match[2], "base64");
  } catch (error) {
    console.warn("[export] could not write photo to cache", error);
    return null;
  }
}

export async function sharePhotoFile(uri: string, mimeType: string) {
  await shareNativeFile(uri, mimeType, "Share Photo");
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

/**
 * A photo prepared for export: either an embeddable data URI, or a recorded
 * reason it has none.
 */
export type ExportPhoto = Photo & {
  exportDataUri?: string;
  exportUnavailableReason?: PhotoUnavailableReason;
};

/**
 * Turn a signed remote image into an embeddable data URI.
 *
 * Remote <img src> is not an option: Print.printToFileAsync snapshots the
 * WebView, and an image still in flight prints as a blank box — the paper
 * version of the bug this branch exists to fix. Everything is inlined before
 * any HTML is built.
 */
async function fetchAsDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) {
      reportMediaFailure({ kind: "export-fetch-failed", uri: url, status: res.status });
      return null;
    }
    const blob = await res.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => {
        reportMediaFailure({
          kind: "export-fetch-failed",
          uri: url,
          reason: "FileReader could not encode the fetched blob",
        });
        resolve(null);
      };
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.readAsDataURL(blob);
    });
  } catch (err) {
    reportMediaFailure({ kind: "export-fetch-failed", uri: url, cause: err });
    return null;
  }
}

/**
 * Resolve every photo to embeddable bytes BEFORE building the document.
 *
 * The export used to embed `photo.base64` and nothing else, so it depended
 * entirely on the local payload cache: an entry synced from another device, or
 * one whose payloads had been cleared, exported as a formal PDF headed
 * "Photos: 6" containing six lines of small grey italic text. That document is
 * the one that reaches a QS, an insurer or a lawyer, so it is the last place a
 * silent gap is acceptable. Signed remote media is now fetched and inlined, and
 * whatever still cannot be obtained is named in the document itself.
 */
export async function resolvePhotosForExport(photos: Photo[]): Promise<ExportPhoto[]> {
  return Promise.all(
    photos.map(async (photo): Promise<ExportPhoto> => {
      if (photo.base64) {
        return { ...photo, exportDataUri: `data:${photo.mimeType || "image/jpeg"};base64,${photo.base64}` };
      }
      if (isLoadableUri(photo.uri)) {
        const dataUri = await fetchAsDataUri(photo.uri);
        if (dataUri) return { ...photo, exportDataUri: dataUri };
        return { ...photo, exportUnavailableReason: "load-failed" };
      }
      const resolved = resolvePhotoSource(photo);
      return {
        ...photo,
        exportUnavailableReason: resolved.status === "unavailable" ? resolved.reason : "load-failed",
      };
    })
  );
}

/**
 * The image block for one exported photo — the picture, or a loud note that it
 * is absent. Shared by every export surface so none of them can quietly go back
 * to emitting an empty string for a photo it could not attach.
 */
export function buildExportImageMarkup(photo: ExportPhoto, maxHeight = 320): string {
  if (photo.exportDataUri) {
    return `<div style="position:relative;margin-bottom:12px;"><img src="${photo.exportDataUri}" style="width:100%;max-height:${maxHeight}px;object-fit:cover;border-radius:14px;display:block;" />${buildAnnotationOverlayHtml(photo)}</div>`;
  }
  // Deliberately loud. Small grey italic print — or, in the gallery export, an
  // empty string — is how a document understates a gap in the evidence it
  // claims to contain.
  return `<div style="margin:0 0 12px;padding:18px;border:2px dashed #fcd34d;border-radius:14px;background:#fef3c7;color:#92400e;">
             <div style="font-weight:700;font-size:14px;margin-bottom:4px;">&#9888; IMAGE NOT INCLUDED</div>
             <div style="font-size:12px;line-height:1.5;">${escapeHtml(describeUnavailable(photo.exportUnavailableReason || "load-failed"))} This photograph is recorded in the entry but its image could not be attached to this document.</div>
           </div>`;
}

/**
 * Stated once at the top of a document, before anything else, so a reader
 * cannot mistake it for a complete photographic record.
 */
export function buildIncompleteRecordNotice(unavailableCount: number, total: number): string {
  if (unavailableCount <= 0) return "";
  return `<section class="section" style="border:2px solid #fcd34d;background:#fef3c7;border-radius:14px;padding:16px;">
           <h2 style="color:#92400e;margin-top:0;">&#9888; Incomplete photo record</h2>
           <p style="color:#92400e;margin:0;font-size:13px;line-height:1.6;">
             ${unavailableCount} of ${total} photographs could not be included in this export.
             The missing images are marked individually below. This document is not a complete photographic record.
           </p>
         </section>`;
}

/** "6 (2 not included)" instead of a bare "6" that overstates what is attached. */
export function formatPhotoCountForExport(total: number, unavailableCount: number): string {
  return unavailableCount > 0 ? `${total} (${unavailableCount} not included)` : String(total);
}

export function buildEntryPhotosReportHtml(args: {
  site: Site;
  entryDate: string;
  notes: string;
  photos: ExportPhoto[];
  notesMode?: "free" | "hourly";
  hourlyNotes?: HourlyNote[];
}) {
  const unavailable = args.photos.filter((photo) => !photo.exportDataUri);

  const photoCards = args.photos
    .map((photo, index) => {
      const imageMarkup = buildExportImageMarkup(photo);
      return `
        <section class="section">
          <h2>Photo ${index + 1}${photo.kind === "annotated" ? " (Annotated)" : ""}</h2>
          ${imageMarkup}
          <table class="detail-table">
            <tr><th>Captured</th><td>${escapeHtml(new Date(photo.timestamp).toLocaleString("en-AU"))}</td></tr>
            <tr><th>Caption</th><td>${escapeHtml(photo.caption || "Not recorded")}</td></tr>
            <tr><th>Image</th><td>${photo.exportDataUri ? "Attached" : "NOT INCLUDED"}</td></tr>
          </table>
        </section>
      `;
    })
    .join("");

  const completenessNotice = buildIncompleteRecordNotice(unavailable.length, args.photos.length);

  const notesMarkup =
    args.notesMode === "hourly"
      ? buildHourlyLogTableHtml(args.hourlyNotes || [])
      : `<p>${escapeHtml(args.notes || "No notes recorded.")}</p>`;

  return buildHtmlDocument({
    title: `${args.site.name} Entry Photos`,
    subtitle: `${args.site.client} • ${args.entryDate}`,
    eyebrow: "Entry Photo Export",
    meta: [
      {
        label: "Photos",
        // The count alone was the lie: "6" next to six blank boxes.
        value: formatPhotoCountForExport(args.photos.length, unavailable.length),
      },
      { label: "Entry Date", value: args.entryDate },
      { label: "Site", value: args.site.name },
      { label: "Client", value: args.site.client },
    ],
    body: `
      ${completenessNotice}
      <section class="section">
        <h2>${args.notesMode === "hourly" ? "Hourly Log" : "Entry Notes"}</h2>
        ${notesMarkup}
      </section>
      ${photoCards || `<section class="section"><h2>No Photos</h2><p>No photos were attached to this entry.</p></section>`}
    `,
  });
}
