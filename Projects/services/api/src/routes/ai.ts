import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { rateLimitByCompany, LIMITS } from "../middleware/rateLimit";
import { getMediaStorage } from "../storage/mediaStorage";
import { listEntries, listSites } from "../storage/projectsStore";
import { uploadBelongsToActorCompany } from "../storage/uploadsStore";
import { Actor } from "../storage/actor";
import type OpenAI from "openai";
import { getOpenAIClient } from "../services/openaiClient";
import { DiaryProvenance, signProvenance } from "../services/diaryProvenance";

/** Extract the upload id (<digits>-<hex>) from a storageKey or storagePath. */
function extractUploadId(ref: string): string | null {
  const m = ref.match(/(\d+-[0-9a-f]+)-/);
  return m ? m[1] : null;
}

type ReportPeriod = "daily" | "weekly" | "monthly";

const DiaryPhotoSchema = z.object({
  id: z.string().optional(),
  uri: z.string().optional(),
  caption: z.string().optional(),
  timestamp: z.string().optional(),
  base64: z.string().optional(),
  mimeType: z.string().optional(),
  storagePath: z.string().optional(),
  storageKey: z.string().optional(),
});

const DiaryEntrySchema = z.object({
  date: z.string().optional(),
  locationAddress: z.string().optional(),
  weather: z.string().optional(),
  crewCount: z.string().optional(),
  notes: z.string().optional(),
  photos: z.array(DiaryPhotoSchema).optional(),
  timestamp: z.string().optional(),
});

const GenerateDiaryBodySchema = z.object({
  siteId: z.string().optional(),
  site: z
    .object({
      name: z.string().optional(),
      client: z.string().optional(),
      address: z.string().optional(),
      startDate: z.string().optional(),
    })
    .optional(),
  period: z.enum(["daily", "weekly", "monthly"]).optional(),
  entries: z.array(DiaryEntrySchema).max(50).optional(),
});

type GenerateDiaryPhoto = z.infer<typeof DiaryPhotoSchema>;
type GenerateDiaryEntry = z.infer<typeof DiaryEntrySchema>;
type GenerateDiaryBody = z.infer<typeof GenerateDiaryBodySchema>;

type OpenAIErrorLike = {
  status?: number;
  message?: string;
  error?: { message?: string };
  response?: {
    status?: number;
    data?: { error?: { message?: string } };
  };
};

/**
 * The provider's own description of what was wrong, e.g.
 *   "Unsupported parameter: 'temperature' is not supported with this model."
 *
 * The SDK surfaces this in more than one shape depending on how the failure
 * arose, so all of them are checked. Truncated because it ends up in a
 * user-visible warning string and the useful part is always at the front.
 */
function rawOpenAIMessage(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as OpenAIErrorLike;
  const raw =
    e.error?.message ??
    e.response?.data?.error?.message ??
    e.message ??
    null;
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

type DiarySection = {
  date: string;
  weather: string;
  crewCount: string;
  workCompleted: string;
  safetyObservations: string;
  materialsUsed: string;
  issues: string;
  photoAnalysis: string;
};

type DiaryOutput = {
  summary: string;
  fullReport: string;
  safetyChecklist: string[];
  reportPeriod: ReportPeriod;
  sections: DiarySection[];
};

/** A diary plus the record of what actually produced it. */
type GenerationResult = {
  diary: DiaryOutput;
  provenance: DiaryProvenance;
};

/**
 * Bumped whenever SYSTEM_PROMPT changes in a way that could alter output.
 * Stamped into every generated diary so a report can be traced to the prompt
 * that wrote it.
 */
export const PROMPT_VERSION = "2026-09-v1";

const FALLBACK_NOTICE =
  "Written by the built-in template generator, not AI.";

type OpenAIContentItem =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail: "auto" | "low" | "high" };

export const aiRouter: Router = Router();
const mediaStorage = getMediaStorage();

function normalizePeriod(period: unknown): ReportPeriod {
  if (period === "weekly" || period === "monthly") return period;
  return "daily";
}

function cleanString(value: unknown, fallback: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function formatDisplayDate(dateStr: string) {
  try {
    return new Date(`${dateStr}T00:00:00`).toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

function normalizeEntry(entry: GenerateDiaryEntry): DiarySection {
  const photos = Array.isArray(entry.photos) ? entry.photos : [];
  const captionNotes = photos
    .map((p) => String(p.caption || "").trim())
    .filter(Boolean);

  const workParts: string[] = [];
  if (entry.notes?.trim()) workParts.push(entry.notes.trim());
  if (entry.locationAddress?.trim()) workParts.push(`Location: ${entry.locationAddress.trim()}`);
  const workCompleted = workParts.join("\n") || "Site activities recorded. See photo observations for detail.";

  const photoAnalysis =
    captionNotes.length > 0
      ? captionNotes.map((c, i) => `Photo ${i + 1}: ${c}`).join("\n")
      : "N/A";

  return {
    date: String(entry.date ?? new Date().toISOString().slice(0, 10)),
    weather: String(entry.weather ?? "Not recorded"),
    crewCount: String(entry.crewCount ?? "Not recorded"),
    workCompleted,
    safetyObservations: "N/A",
    materialsUsed: "Refer to site records.",
    issues: "None reported.",
    photoAnalysis,
  };
}

function normalizeSection(section: Partial<DiarySection> | undefined, fallback: DiarySection): DiarySection {
  return {
    date: cleanString(section?.date, fallback.date),
    weather: cleanString(section?.weather, fallback.weather),
    crewCount: cleanString(section?.crewCount, fallback.crewCount),
    workCompleted: cleanString(section?.workCompleted, fallback.workCompleted),
    safetyObservations: cleanString(section?.safetyObservations, fallback.safetyObservations),
    materialsUsed: cleanString(section?.materialsUsed, fallback.materialsUsed),
    issues: cleanString(section?.issues, fallback.issues),
    photoAnalysis: cleanString(section?.photoAnalysis, fallback.photoAnalysis),
  };
}

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00`);
}

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function filterEntriesByPeriod(entries: GenerateDiaryEntry[], period: ReportPeriod) {
  if (entries.length === 0) return [];
  const sorted = [...entries].sort(
    (a, b) => dateOnly(String(a.date || "")).getTime() - dateOnly(String(b.date || "")).getTime()
  );
  const latest = dateOnly(String(sorted[sorted.length - 1].date || new Date().toISOString().slice(0, 10)));
  if (period === "daily") {
    const key = String(sorted[sorted.length - 1].date || formatDateKey(latest));
    return sorted.filter((e) => e.date === key);
  }
  if (period === "weekly") {
    const start = new Date(latest);
    start.setDate(start.getDate() - 6);
    return sorted.filter((e) => {
      const d = dateOnly(String(e.date || formatDateKey(latest)));
      return d >= start && d <= latest;
    });
  }
  return sorted.filter((e) => {
    const d = dateOnly(String(e.date || formatDateKey(latest)));
    return d.getFullYear() === latest.getFullYear() && d.getMonth() === latest.getMonth();
  });
}

function buildFullReport(args: {
  sections: DiarySection[];
  period: ReportPeriod;
  siteName?: string;
  client?: string;
  address?: string;
  summary?: string;
  safetyChecklist?: string[];
}) {
  const { sections, period, siteName, client, address, summary, safetyChecklist } = args;
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  const dateRange =
    sections.length > 1
      ? `${formatDisplayDate(sections[0].date)} – ${formatDisplayDate(sections[sections.length - 1].date)}`
      : sections.length === 1
        ? formatDisplayDate(sections[0].date)
        : today;

  const lines: string[] = [
    "CONSTRUCTION SITE DIARY REPORT",
    "═".repeat(50),
    `Project:      ${siteName || "Unspecified Project"}`,
    `Client:       ${client || "—"}`,
    `Site Address: ${address || "—"}`,
    `Report Period: ${period.charAt(0).toUpperCase() + period.slice(1)} — ${dateRange}`,
    `Prepared:     ${today}`,
    "",
  ];

  if (summary) {
    lines.push("EXECUTIVE SUMMARY");
    lines.push("─".repeat(50));
    lines.push(summary);
    lines.push("");
  }

  lines.push("DAILY ACTIVITY RECORDS");
  lines.push("─".repeat(50));

  sections.forEach((section) => {
    lines.push(`DATE: ${formatDisplayDate(section.date)}`);
    lines.push(`Weather Conditions: ${section.weather}`);
    lines.push(`Crew on Site: ${section.crewCount}`);
    lines.push("");
    lines.push("Work Completed:");
    lines.push(section.workCompleted);
    lines.push("");
    lines.push("Materials & Resources Deployed:");
    lines.push(section.materialsUsed);
    lines.push("");
    lines.push("Photo Evidence — Site Observations:");
    lines.push(section.photoAnalysis);
    lines.push("");
    lines.push("Safety Observations:");
    lines.push(section.safetyObservations);
    lines.push("");
    lines.push("Issues & Actions:");
    lines.push(section.issues);
    lines.push("─".repeat(50));
    lines.push("");
  });

  if (safetyChecklist && safetyChecklist.length > 0) {
    lines.push("SAFETY & COMPLIANCE CHECKLIST");
    lines.push("─".repeat(50));
    safetyChecklist.forEach((item) => lines.push(`• ${item}`));
    lines.push("");
  }

  lines.push("END OF REPORT");

  return lines.join("\n");
}

async function normalizeBase64Image(photo: GenerateDiaryPhoto, actor: Pick<Actor, "companyId">) {
  const raw = String(photo.base64 || "").trim();
  const mimeType = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
    cleanString(photo.mimeType, "image/jpeg")
  )
    ? cleanString(photo.mimeType, "image/jpeg")
    : "image/jpeg";

  if (raw) {
    if (raw.startsWith("data:")) {
      const [, base64Part] = raw.split(",", 2);
      return base64Part ? `data:${mimeType};base64,${base64Part}` : null;
    }
    return `data:${mimeType};base64,${raw}`;
  }

  const storageKey = cleanString(photo.storageKey, "");
  if (storageKey) {
    // H7: reading a server-stored file from a CLIENT-supplied reference is a
    // cross-tenant leak. Require the canonical `uploads/<id>-<filename>` form
    // (no path traversal / extra separators), verify the caller owns <id>, and
    // read strictly by that validated key. The raw client `storagePath` is
    // intentionally NOT used — the ownership check cannot bind it, so a
    // traversal like `<owned-id>-x/../<victim-id>-f.jpg` would read another
    // tenant's file despite passing the check.
    const uploadId = extractUploadId(storageKey);
    const canonical = /^uploads\/\d+-[0-9a-f]+-[A-Za-z0-9._-]+$/.test(storageKey);
    if (!uploadId || !canonical || !(await uploadBelongsToActorCompany(actor, uploadId))) {
      return null;
    }
    try {
      const filename = storageKey.slice(`uploads/${uploadId}-`.length);
      const file = await mediaStorage.readFile(storageKey, filename);
      return `data:${mimeType};base64,${file.toString("base64")}`;
    } catch (error) {
      console.warn("[ai] Failed to read stored photo for analysis", { storageKey, error });
    }
  }
  return null;
}

async function buildVisionInputs(entries: GenerateDiaryEntry[], actor: Pick<Actor, "companyId">) {
  const content: OpenAIContentItem[] = [];
  let includedImages = 0;
  const maxImages = 12;

  for (const [entryIndex, entry] of entries.entries()) {
    const photos = Array.isArray(entry.photos) ? entry.photos : [];
    for (const [photoIndex, photo] of photos.entries()) {
      if (includedImages >= maxImages) break;
      const imageUrl = await normalizeBase64Image(photo, actor);
      if (!imageUrl) continue;
      includedImages += 1;
      content.push({
        type: "input_text",
        text: JSON.stringify({
          imageRef: `entry-${entryIndex + 1}-photo-${photoIndex + 1}`,
          entryDate: entry.date || "",
          entryLocation: entry.locationAddress || "",
          photoTimestamp: photo.timestamp || "",
          userCaption: photo.caption || "",
          instruction: [
            "Analyse this construction site photograph thoroughly.",
            "Describe exactly what is visible: construction stage and progress, structural elements, plant and equipment, scaffolding and access systems, materials on site, PPE and safety compliance, signage, weather conditions, and any visible hazards or issues.",
            "Write specific professional observations using construction industry terminology.",
            "Reference this image in the photoAnalysis field as 'Photo " + includedImages + "'.",
          ].join(" "),
        }),
      });
      content.push({
        type: "input_image",
        image_url: imageUrl,
        detail: "auto",
      });
    }
  }

  return { content, imageCount: includedImages };
}

export function buildDiaryFromEntries(entries: GenerateDiaryEntry[], period: ReportPeriod = "daily"): DiaryOutput {
  const sections = entries.map((entry) => normalizeEntry(entry));
  const siteName = "";

  const totalPhotos = entries.reduce((n, e) => n + (e.photos?.length ?? 0), 0);
  const totalCrew = entries
    .map((e) => parseInt(e.crewCount || "0", 10))
    .filter((n) => !isNaN(n) && n > 0);
  const avgCrew = totalCrew.length > 0 ? Math.round(totalCrew.reduce((a, b) => a + b, 0) / totalCrew.length) : null;

  const summaryParts = [
    `This ${period} site diary covers ${entries.length} work record${entries.length !== 1 ? "s" : ""} for the reporting period.`,
  ];
  if (avgCrew) summaryParts.push(`An average crew of ${avgCrew} operatives was deployed on site.`);
  if (totalPhotos > 0) summaryParts.push(`${totalPhotos} site photograph${totalPhotos !== 1 ? "s" : ""} were recorded.`);
  summaryParts.push("Full activity details are recorded in the daily activity section below.");

  const summary = summaryParts.join(" ");
  // Collect explicit safety observations verbatim — never invent checklist items.
  // Notes are included only when photos accompany them (crew is documenting safety with evidence).
  // Photo captions are always included when present. AI mode generates a richer, context-specific list.
  const safetyChecklist: string[] = [];
  for (const entry of entries) {
    const photos = entry.photos ?? [];
    if (entry.notes?.trim() && photos.length > 0) safetyChecklist.push(entry.notes.trim());
    for (const photo of photos) {
      const caption = (photo as { caption?: string }).caption?.trim();
      if (caption) safetyChecklist.push(caption);
    }
  }

  return {
    summary,
    fullReport: buildFullReport({ sections, period, siteName, summary, safetyChecklist }),
    safetyChecklist,
    reportPeriod: period,
    sections,
  };
}

export const SYSTEM_PROMPT = `You are a professional quantity surveyor and construction site manager writing a formal construction site diary report.

Your task is to produce a detailed, accurate, and professionally written site diary based on:
1. Site photographs (your PRIMARY source — analyse each image carefully)
2. Field notes and captions provided by the site team
3. Structured entry data (date, weather, crew count, location)

PHOTO ANALYSIS REQUIREMENTS:
- Study every photograph in detail before writing
- Identify and describe: construction stage and structural progress, plant and equipment in use, scaffolding and access systems, materials stored or being installed, ground conditions, weather visibility, PPE compliance among visible workers, safety signage and barriers, any visible defects or concerns
- Use precise construction industry terminology (e.g. "reinforced concrete pad foundation", "structural steelwork erection", "blockwork cavity wall construction", "formwork striking", "mechanical and electrical first fix")
- Each photo reference must appear in the photoAnalysis field as "Photo 1:", "Photo 2:", etc.
- Never write "N/A" for photoAnalysis when images have been provided

PROFESSIONAL WRITING STANDARDS:
- Write in formal, professional British English suitable for a client, engineer, or QS report
- Use complete sentences with specific detail — avoid vague or generic statements
- workCompleted must describe actual activities observed with professional precision
- safetyObservations must detail visible PPE compliance, hazards, barriers, and signage
- materialsUsed must list specific materials, products, or plant observed or referenced
- issues must document any concerns, delays, defects, or non-conformances visible or noted
- fullReport must be a complete, well-structured report document including all sections
- summary must be a professional executive paragraph suitable for a project manager or client

SAFETY CHECKLIST REQUIREMENTS:
- Generate 6–10 specific, actionable safety checklist items
- Base items on what is actually visible in the photos and the nature of the work observed
- Include relevant items covering: PPE for the specific tasks visible, plant and equipment safety, access and working at height (if applicable), material handling, environmental controls, and specific hazards present on this site
- Write each item as an active, specific statement (e.g. "Operatives working at height to be secured with fall arrest harness and lanyard at all times" rather than "Wear PPE")

OUTPUT FORMAT:
Return strict JSON with exactly these fields:
{
  "summary": "Professional executive summary paragraph (3-5 sentences)",
  "fullReport": "Complete formatted report text with all sections",
  "safetyChecklist": ["item1", "item2", ...],
  "sections": [
    {
      "date": "YYYY-MM-DD",
      "weather": "Detailed weather description",
      "crewCount": "Number and trades present",
      "workCompleted": "Detailed professional description of all work activities",
      "safetyObservations": "Specific safety compliance observations from photos and notes",
      "materialsUsed": "Specific materials, products and plant deployed",
      "issues": "Any issues, concerns, delays or actions required",
      "photoAnalysis": "Detailed analysis of each photo: Photo 1: ... Photo 2: ..."
    }
  ]
}`;

/**
 * Which models accept the sampling parameters (`temperature`, `top_p`).
 *
 * MEASURED against the live API on 2026-09-21, not inferred from the name:
 *   gpt-4o, gpt-4o-mini, gpt-4.1, gpt-4.1-mini, gpt-4-turbo   temperature accepted
 *   gpt-5.6-terra                                             HTTP 400
 *     "Unsupported parameter: 'temperature' is not supported with this model."
 *
 * The default for an UNRECOGNISED model is to OMIT them, because the two
 * directions of error are not symmetric:
 *
 *   omitting on a model that supports them -> the model samples at its own
 *       default instead of our 0.3. A slightly less deterministic report.
 *       Degraded output, still a report.
 *   sending on a model that rejects them   -> HTTP 400 on every request, so
 *       every generation silently becomes a template diary. That is the
 *       outage this table exists because of (Sentry SITESNAP-API-9).
 *
 * So an unknown model still produces a WORKING request, and only a model we
 * have positively verified gets the tuned temperature. To add one, send it a
 * request with `temperature` against the real API and add it here only if that
 * returns 200 — do not add a name because it looks like it belongs.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * IF YOU ARE HERE BECAUSE A NEW MODEL APPEARED: before setting OPENAI_MODEL in
 * Render, run the live contract suite against it. Nothing in CI will catch a
 * parameter incompatibility for you, because the boundary mock in
 * services/openaiClient.ts returns a canned success for ANY argument object:
 *
 *     OPENAI_MODEL=<the-new-model> OPENAI_LIVE_TEST_KEY=sk-... \
 *       pnpm -C Projects --filter services-api run test:openai
 *
 * That is the whole reason this table is hand-maintained rather than inferred.
 * See §1 of docs/SiteSnap-Release-Runbook.md for the full procedure and the
 * post-deploy check that `generator` is "openai" and not "fallback".
 * ───────────────────────────────────────────────────────────────────────────
 */
const MODELS_SUPPORTING_SAMPLING_PARAMS: ReadonlySet<string> = new Set([
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4-turbo",
]);

/**
 * Build the exact request body sent to the Responses API.
 *
 * Extracted as a pure function for one reason: the boundary mock in
 * openaiClient.ts cannot tell us whether OpenAI ACCEPTS these parameters, only
 * that we sent them. ai-openai-contract.test.ts takes the object this returns
 * and posts it to the real API, so "the parameter set is valid for the
 * configured model" is checked against the provider rather than against our own
 * assumptions. Keep this the single construction path — an inline object at the
 * call site would be untested by that contract test.
 */
export function buildDiaryRequest(
  model: string,
  systemPrompt: string,
  userContent: OpenAIContentItem[]
): OpenAI.Responses.ResponseCreateParamsNonStreaming {
  return {
    model,
    input: [
      { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
      { role: "user", content: userContent },
    ],
    // `temperature` is attached per-model rather than unconditionally. Stripping
    // it globally would work for gpt-5.6-terra and quietly de-tune gpt-4o if
    // OPENAI_MODEL is ever set back; see MODELS_SUPPORTING_SAMPLING_PARAMS.
    ...(supportsSamplingParams(model) ? { temperature: 0.3 } : {}),
    // NOT conditional — accepted by both families. It does require the word
    // "json" to appear in the input messages, which SYSTEM_PROMPT satisfies;
    // that is a property of the parameter, not of the model.
    text: { format: { type: "json_object" } },
  };
}

/**
 * Dated snapshots inherit from their base model: "gpt-4o-2024-11-20" -> "gpt-4o".
 * Exported for tests.
 */
/**
 * The model this process will actually use. Single source of truth: the catch
 * block reports the model in its warning and log line, and if it re-derived the
 * name independently the two could disagree about what just failed.
 */
export function resolveModel(): string {
  return process.env.OPENAI_MODEL || "gpt-4o";
}

export function supportsSamplingParams(model: string): boolean {
  if (MODELS_SUPPORTING_SAMPLING_PARAMS.has(model)) return true;
  // Strip a trailing -YYYY-MM-DD snapshot suffix and retry once.
  const base = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  return base !== model && MODELS_SUPPORTING_SAMPLING_PARAMS.has(base);
}

function fallbackProvenance(warning: string): DiaryProvenance {
  return {
    generator: "fallback",
    model: null,
    promptVersion: PROMPT_VERSION,
    warning,
    generatedAtMs: Date.now(),
    tokenUsage: null,
  };
}

async function tryGenerateWithOpenAI(
  body: GenerateDiaryBody,
  actor: Pick<Actor, "companyId">
): Promise<GenerationResult> {
  const entries = Array.isArray(body.entries) ? body.entries : [];
  const period = normalizePeriod(body.period);

  if (!process.env.OPENAI_API_KEY) {
    // Previously this returned the template output with NO warning at all —
    // byte-for-byte indistinguishable from an AI report, and quieter than the
    // error paths below, which at least set one. A missing key is a
    // misconfiguration, not a non-event.
    return {
      diary: buildDiaryFromEntries(entries, period),
      provenance: fallbackProvenance(`${FALLBACK_NOTICE} No OpenAI API key is configured.`),
    };
  }

  const fallback = buildDiaryFromEntries(entries, period);
  const model = resolveModel();
  const client = getOpenAIClient();

  const { content: visionInputs, imageCount } = await buildVisionInputs(entries, actor);

  const structuredPayload = {
    reportContext: {
      site: body.site || {},
      period,
      totalEntries: entries.length,
      totalPhotosAttached: imageCount,
    },
    entries: entries.map((entry) => ({
      date: entry.date || "",
      locationAddress: entry.locationAddress || "",
      weather: entry.weather || "",
      crewCount: entry.crewCount || "",
      notes: entry.notes || "",
      photoCount: (entry.photos || []).length,
      photoCaptions: (entry.photos || [])
        .map((p) => p.caption || "")
        .filter(Boolean),
    })),
  };

  const userContent: OpenAIContentItem[] = [
    {
      type: "input_text",
      text: JSON.stringify(structuredPayload),
    },
    ...visionInputs,
  ];

  const response = await client.responses.create(
    buildDiaryRequest(model, SYSTEM_PROMPT, userContent)
  );

  const usage = response.usage
    ? { input: response.usage.input_tokens ?? 0, output: response.usage.output_tokens ?? 0 }
    : null;

  const outputText = String(response.output_text || "").trim();
  if (!outputText) {
    return {
      diary: fallback,
      provenance: fallbackProvenance(`${FALLBACK_NOTICE} The AI returned an empty response.`),
    };
  }

  let parsed: Partial<DiaryOutput> = {};
  try {
    parsed = JSON.parse(outputText) as Partial<DiaryOutput>;
  } catch {
    return {
      diary: fallback,
      provenance: fallbackProvenance(`${FALLBACK_NOTICE} The AI response could not be parsed.`),
    };
  }

  const modelSections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const safeSections = fallback.sections.map((section, index) =>
    normalizeSection(modelSections[index], section)
  );

  const parsedChecklist = Array.isArray(parsed.safetyChecklist)
    ? parsed.safetyChecklist.map((item) => cleanString(item, "")).filter((item) => item.length > 10)
    : [];

  const finalChecklist = parsedChecklist.length >= 3 ? parsedChecklist.slice(0, 10) : fallback.safetyChecklist;

  const summary = cleanString(parsed.summary, fallback.summary);
  const fullReport = cleanString(
    parsed.fullReport,
    buildFullReport({
      sections: safeSections,
      period,
      siteName: body.site?.name,
      client: body.site?.client,
      address: body.site?.address,
      summary,
      safetyChecklist: finalChecklist,
    })
  );

  return {
    diary: {
      summary,
      fullReport,
      safetyChecklist: finalChecklist,
      reportPeriod: period,
      sections: safeSections,
    },
    provenance: {
      generator: "openai",
      model,
      promptVersion: PROMPT_VERSION,
      warning: null,
      generatedAtMs: Date.now(),
      tokenUsage: usage,
    },
  };
}

async function resolveDiaryRequest(req: AuthenticatedRequest, body: GenerateDiaryBody) {
  const period = normalizePeriod(body.period);
  if (Array.isArray(body.entries) && body.entries.length > 0) {
    return { site: body.site || {}, period, entries: filterEntriesByPeriod(body.entries, period) };
  }

  const siteId = cleanString(body.siteId, "");
  if (!siteId) {
    throw new Error("A siteId or entries payload is required.");
  }

  const actor = { email: req.auth.email, role: req.auth.role, companyId: req.auth.companyId, companyRole: req.auth.companyRole };
  const [sites, entries] = await Promise.all([listSites(actor), listEntries(actor, siteId)]);
  const site = sites.find((item) => item.id === siteId);
  if (!site) {
    throw new Error("Site not found.");
  }

  const scopedEntries = filterEntriesByPeriod(
    entries.map((entry) => ({
      date: entry.date,
      locationAddress: entry.locationAddress,
      weather: entry.weather,
      crewCount: entry.crewCount,
      notes: entry.notes,
      photos: Array.isArray(entry.photos)
        ? entry.photos.map((photo) => ({
            id: typeof photo.id === "string" ? photo.id : undefined,
            uri: typeof photo.uri === "string" ? photo.uri : undefined,
            caption: typeof photo.caption === "string" ? photo.caption : undefined,
            timestamp: typeof photo.timestamp === "string" ? photo.timestamp : undefined,
            mimeType: typeof photo.mimeType === "string" ? photo.mimeType : undefined,
            storagePath: typeof photo.storagePath === "string" ? photo.storagePath : undefined,
            storageKey: typeof photo.storageKey === "string" ? photo.storageKey : undefined,
          }))
        : [],
      timestamp: entry.timestamp,
    })),
    period
  );

  return {
    site: {
      name: site.name,
      client: site.client,
      address: site.address,
      startDate: site.startDate,
    },
    period,
    entries: scopedEntries,
  };
}

/**
 * One line per generation, so the rate of silent downgrades is answerable from
 * the logs rather than by asking users whether their diaries looked AI-written.
 */
function logGeneration(
  req: AuthenticatedRequest,
  body: GenerateDiaryBody,
  p: DiaryProvenance,
  startedAt: number
): void {
  const entries = Array.isArray(body.entries) ? body.entries : [];
  console.log("[ai] generate-diary", {
    reqid: (req.headers["x-request-id"] as string) || null,
    generator: p.generator,
    model: p.model,
    promptVersion: p.promptVersion,
    warning: p.warning,
    tokenUsage: p.tokenUsage,
    durationMs: Date.now() - startedAt,
    photoCount: entries.reduce((n, e) => n + (Array.isArray(e.photos) ? e.photos.length : 0), 0),
    companyId: req.auth.companyId,
    siteId: cleanString(body.siteId, "") || null,
  });
}

// Keyed on the authenticated actor's COMPANY, not their IP. Keyed on IP this
// was wrong in both directions: a whole crew behind one site router shared a
// single budget, while an attacker with an account and a few proxies had no
// effective limit at all on an endpoint that spends OpenAI credit. The spend
// is authenticated, so the payer is known — charge them. The threshold is
// env-overridable (RATE_LIMIT_GENERATE_DIARY_PER_COMPANY) and sized so no
// legitimate crew meets it; the prepaid OpenAI balance is the real ceiling.
aiRouter.post("/generate-diary", requireAuth, rateLimitByCompany("generate-diary", LIMITS.generateDiaryPerCompany.max, LIMITS.generateDiaryPerCompany.windowMs), async (req, res) => {
  const parsed = GenerateDiaryBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid request payload.", details: parsed.error.flatten() });
  }
  const body = parsed.data;
  const payloadBytes = Buffer.byteLength(JSON.stringify(body), "utf8");
  const startedAt = Date.now();

  try {
    const resolved = await resolveDiaryRequest(req as AuthenticatedRequest, body);
    if (resolved.entries.length === 0) {
      return res.status(400).json({ error: "No entries are available for the selected report period." });
    }
    const { diary, provenance } = await tryGenerateWithOpenAI(resolved, (req as AuthenticatedRequest).auth);
    logGeneration(req as AuthenticatedRequest, body, provenance, startedAt);
    return res.json({
      success: true,
      diary,
      // Signed so the save request that follows cannot claim a generator that
      // never ran. Surfaced as `warning` too, because existing clients read
      // that field and would otherwise show a degraded run as a clean one.
      generation: signProvenance(provenance, (req as AuthenticatedRequest).auth.companyId),
      warning: provenance.warning ?? undefined,
    });
  } catch (err: unknown) {
    const statusFromOpenAI =
      typeof err === "object" && err !== null
        ? ((err as OpenAIErrorLike).status ?? (err as OpenAIErrorLike).response?.status)
        : undefined;

    console.error("[ai] generate-diary failed", {
      path: req.originalUrl,
      payloadBytes,
      siteId: body.siteId || null,
      // The model is logged because a 400 is almost always about THIS value,
      // and the HTTP response deliberately does not echo configuration back.
      model: resolveModel(),
      message: err instanceof Error ? err.message : String(err),
      statusFromOpenAI: statusFromOpenAI ?? null,
      // The provider's own words. Without this a 400 reaches Sentry as a bare
      // status and the actual parameter name is lost.
      openAIError: rawOpenAIMessage(err) ?? null,
    });

    try {
      const resolved = await resolveDiaryRequest(req as AuthenticatedRequest, body);
      const fallbackDiary = buildDiaryFromEntries(resolved.entries, resolved.period);
      // A 400 is the provider telling us the REQUEST is wrong — an unsupported
      // parameter, a model name that does not exist, a malformed input. It is a
      // configuration fault on our side and it will repeat on every single
      // request until someone changes something. Reporting it as "the AI service
      // was unavailable" points the reader at OpenAI's status page for a problem
      // that is entirely ours, which is exactly what happened with
      // SITESNAP-API-9: a rejected `temperature` parameter spent a deploy
      // looking like an outage.
      const warning =
        statusFromOpenAI === 400
          ? `${FALLBACK_NOTICE} The AI request was rejected as invalid (400) for model ` +
            `"${resolveModel()}". This is a configuration problem, not an outage — ` +
            `check OPENAI_MODEL and the request parameters. ` +
            `OpenAI said: ${rawOpenAIMessage(err) ?? "no detail provided"}`
          : statusFromOpenAI === 401
            ? `${FALLBACK_NOTICE} The OpenAI API key was rejected (401).`
            : statusFromOpenAI === 429
              ? `${FALLBACK_NOTICE} OpenAI quota or credits are exhausted (429).`
              : `${FALLBACK_NOTICE} The AI service was unavailable.`;
      const provenance = fallbackProvenance(warning);
      logGeneration(req as AuthenticatedRequest, body, provenance, startedAt);
      return res.json({
        success: true,
        diary: fallbackDiary,
        generation: signProvenance(provenance, (req as AuthenticatedRequest).auth.companyId),
        warning,
      });
    } catch (fallbackError) {
      return res.status(400).json({
        error: fallbackError instanceof Error ? fallbackError.message : "Failed to generate diary.",
      });
    }
  }
});
