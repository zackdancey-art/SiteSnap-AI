import { Router } from "express";
import { z } from "zod";
import { verifyProvenance } from "../services/diaryProvenance";
import { requireAuth, requireAtLeast, AuthenticatedRequest } from "../middleware/auth";
import { createAuthToken } from "../utils/authToken";
import {
  acceptSiteInvite,
  createDiary,
  createEntry,
  createSite,
  createSiteInvites,
  INVITE_ROLE_TOO_HIGH,
  createTemplate,
  deleteEntry,
  deleteSite,
  deleteSiteInvite,
  deleteTemplate,
  getScopedBootstrap,
  getSupervisorReport,
  listDiaries,
  listEntries,
  listSiteInvites,
  listSiteMembers,
  listSites,
  listTemplates,
  removeSiteMember,
  updateDiary,
  updateEntry,
  updateSiteProgress,
  updateTemplate,
} from "../storage/projectsStore";
import { isRateLimitedByAccount, LIMITS } from "../middleware/rateLimit";
import { sendSiteInvite } from "../services/notificationService";

function parsePagination(query: Record<string, unknown>) {
  const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);
  const offset = Math.max(Number(query.offset) || 0, 0);
  return { limit, offset };
}

const SiteSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  client: z.string().min(1),
  startDate: z.string().min(1),
  status: z.enum(["active", "completed", "on-hold"]),
});

const EntrySchema = z.object({
  siteId: z.string().min(1),
  date: z.string().min(1),
  locationAddress: z.string().default(""),
  weather: z.string().default(""),
  crewCount: z.string().default(""),
  notes: z.string().default(""),
  photos: z.array(z.record(z.unknown())).default([]),
  swmsRef: z.string().optional(),
  hazardNotes: z.string().optional(),
  toolboxTalk: z.boolean().optional(),
  // 5b: optional hourly-notes template. hour is 0-23; empty-note hours are kept
  // as-is (exports hide them). notesMode selects which field the UI/export uses.
  notesMode: z.enum(["free", "hourly"]).optional(),
  hourlyNotes: z.array(z.object({ hour: z.number().int().min(0).max(23), note: z.string() })).optional(),
});

const EntryPatchSchema = EntrySchema.omit({ siteId: true }).partial();

const DiarySchema = z.object({
  siteId: z.string().min(1),
  status: z.enum(["draft", "approved"]),
  summary: z.string().default(""),
  reportPeriod: z.enum(["daily", "weekly", "monthly"]).default("daily"),
  fullReport: z.string().default(""),
  safetyChecklist: z.array(z.string()).default([]),
  sections: z.array(z.record(z.unknown())).default([]),
  /**
   * Signed provenance, exactly as /generate-diary returned it. Typed as unknown
   * because the schema is not what makes it trustworthy — verifyProvenance is.
   * Anything that fails verification is stored as NULL ("unknown"), never as
   * the generator it claimed to be.
   */
  generation: z.unknown().optional(),
});

/**
 * Note the absence of `generation`. Provenance describes what produced the
 * original text and is never patchable: zod strips unknown keys, so a
 * `generation` field in a PATCH body is discarded rather than honoured. If a
 * diary's text is edited the provenance still describes who wrote the draft,
 * which is what the edit_log is for. Guarded by a test.
 */
const DiaryPatchSchema = z.object({
  status: z.enum(["draft", "approved"]).optional(),
  summary: z.string().optional(),
  reportPeriod: z.enum(["daily", "weekly", "monthly"]).optional(),
  fullReport: z.string().optional(),
  safetyChecklist: z.array(z.string()).optional(),
  sections: z.array(z.record(z.unknown())).optional(),
  note: z.string().optional(),
});

const TemplateSchema = z.object({
  siteId: z.string().min(1),
  name: z.string().min(1).default("Default"),
  weather: z.string().default(""),
  crewCount: z.string().default(""),
  notesTemplate: z.string().default(""),
});

const TemplatePatchSchema = TemplateSchema.omit({ siteId: true }).partial();

export const projectsRouter: Router = Router();

// Crew (rank 0) are blocked from the entire dashboard router — only viewer+ may proceed.
projectsRouter.use(requireAuth, requireAtLeast("viewer"));

function getActor(req: AuthenticatedRequest) {
  return {
    email: req.auth.email,
    role: req.auth.role,
    companyId: req.auth.companyId,
    companyRole: req.auth.companyRole,
  };
}

projectsRouter.get("/projects/bootstrap", async (req, res) => {
  const payload = await getScopedBootstrap(getActor(req as unknown as AuthenticatedRequest));
  res.json(payload);
});

projectsRouter.get("/projects/summary", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const [sites, entries, diaries] = await Promise.all([
    listSites(actor),
    listEntries(actor),
    listDiaries(actor),
  ]);

  const approvedDiaries = diaries.filter((diary) => diary.status === "approved").length;
  res.json({
    sites: sites.length,
    entries: entries.length,
    diaries: diaries.length,
    approvedDiaries,
    draftDiaries: diaries.length - approvedDiaries,
    actorRole: actor.role,
  });
});

projectsRouter.get("/projects/sites", async (req, res) => {
  const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
  const sites = await listSites(getActor(req as unknown as AuthenticatedRequest), limit, offset);
  res.json({ sites, limit, offset });
});

projectsRouter.post("/projects/sites", requireAtLeast("manager"), async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const parsed = SiteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid site payload.", details: parsed.error.flatten() });
  }
  const site = await createSite(actor, parsed.data);
  return res.status(201).json({ site });
});

projectsRouter.delete("/projects/sites/:id", requireAtLeast("manager"), async (req, res) => {
  const removed = await deleteSite(getActor(req as unknown as AuthenticatedRequest), req.params.id);
  if (!removed) return res.status(404).json({ error: "Site not found." });
  return res.json({ ok: true });
});

projectsRouter.get("/projects/entries", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
  const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
  const entries = await listEntries(actor, siteId, limit, offset);
  return res.json({ entries, limit, offset });
});

projectsRouter.post("/projects/entries", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const parsed = EntrySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid entry payload.", details: parsed.error.flatten() });
  }
  const entry = await createEntry(actor, parsed.data);
  return res.status(201).json({ entry });
});

projectsRouter.patch("/projects/entries/:id", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const parsed = EntryPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid entry patch.", details: parsed.error.flatten() });
  }
  const entry = await updateEntry(actor, req.params.id, parsed.data);
  if (!entry) return res.status(404).json({ error: "Entry not found." });
  return res.json({ entry });
});

projectsRouter.delete("/projects/entries/:id", async (req, res) => {
  const removed = await deleteEntry(getActor(req as unknown as AuthenticatedRequest), req.params.id);
  if (!removed) return res.status(404).json({ error: "Entry not found." });
  return res.json({ ok: true });
});

projectsRouter.get("/projects/diaries", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
  const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
  const diaries = await listDiaries(actor, siteId, limit, offset);
  return res.json({ diaries, limit, offset });
});

projectsRouter.post("/projects/diaries", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const parsed = DiarySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid diary payload.", details: parsed.error.flatten() });
  }
  const { generation, ...diaryInput } = parsed.data;
  // The client receives provenance from /generate-diary and saves the diary in
  // a separate request, so an unverified `generation` would let any
  // authenticated user stamp `generator: "openai"` onto template output. The
  // HMAC is bound to companyId, so another tenant's valid record is refused too.
  const verified = generation === undefined ? null : verifyProvenance(generation, actor.companyId);
  if (generation !== undefined && verified === null) {
    console.warn("[diary] rejected unverified provenance", {
      companyId: actor.companyId,
      siteId: diaryInput.siteId,
    });
  }
  const diary = await createDiary(actor, { ...diaryInput, generation: verified });
  return res.status(201).json({ diary });
});

projectsRouter.patch("/projects/diaries/:id", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const parsed = DiaryPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid diary patch.", details: parsed.error.flatten() });
  }
  const { note, ...diaryPatch } = parsed.data;
  const diary = await updateDiary(actor, req.params.id, diaryPatch, note);
  if (!diary) return res.status(404).json({ error: "Diary not found." });
  return res.json({ diary });
});

projectsRouter.get("/projects/reports/supervisor", requireAtLeast("viewer"), async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const perSite = await getSupervisorReport(actor);
  return res.json({ generatedAt: new Date().toISOString(), perSite });
});

projectsRouter.get("/projects/templates", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
  const templates = await listTemplates(actor, siteId);
  return res.json({ templates });
});

projectsRouter.post("/projects/templates", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const parsed = TemplateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid template payload.", details: parsed.error.flatten() });
  }
  const template = await createTemplate(actor, parsed.data);
  return res.status(201).json({ template });
});

projectsRouter.patch("/projects/templates/:id", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const parsed = TemplatePatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid template patch.", details: parsed.error.flatten() });
  }
  const template = await updateTemplate(actor, req.params.id, parsed.data);
  if (!template) return res.status(404).json({ error: "Template not found." });
  return res.json({ template });
});

projectsRouter.delete("/projects/templates/:id", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const removed = await deleteTemplate(actor, req.params.id);
  if (!removed) return res.status(404).json({ error: "Template not found." });
  return res.json({ ok: true });
});

// ─── Site invites ─────────────────────────────────────────────────────────────

const InviteSchema = z.object({
  emails: z.array(z.string().email()).min(1).max(50),
  role: z.enum(["manager", "viewer", "crew"]).default("crew"),
});

projectsRouter.post("/projects/sites/:siteId/invites", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);

  if (await isRateLimitedByAccount(actor.email, "bulk-invite", LIMITS.bulkInvitePerAccount.max, LIMITS.bulkInvitePerAccount.windowMs)) {
    return res.status(429).json({ error: "Too many invitations sent. Please try again shortly." });
  }

  const parsed = InviteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid invite payload.", details: parsed.error.flatten() });
  }

  const results = await createSiteInvites(actor, req.params.siteId, parsed.data.emails, parsed.data.role, parsed.data.role);
  if (results === null) {
    return res.status(403).json({ error: "Insufficient permissions to manage this site." });
  }
  if (results === INVITE_ROLE_TOO_HIGH) {
    return res.status(403).json({ error: "Only an owner can invite managers or viewers. You can invite crew only." });
  }
  if (typeof results === "string") {
    return res.status(400).json({ error: "Invalid invite: owner role cannot be assigned via invite." });
  }

  // Send invite emails best-effort; look up current invites once for all tokens
  const actorAuth = (req as unknown as AuthenticatedRequest).auth;
  const invites = await listSiteInvites(actor, req.params.siteId);
  const sites = await listSites(actor);
  const site = sites.find((s) => s.id === req.params.siteId);
  const siteName = site?.name ?? req.params.siteId;
  const inviteByEmail = new Map((invites ?? []).map((i) => [i.invitedEmail, i]));

  for (const result of results) {
    if (result.status === "already_member") continue;
    const invite = inviteByEmail.get(result.email);
    if (!invite) continue;
    sendSiteInvite({
      to: result.email,
      inviterName: actorAuth.fullName || actor.email,
      siteName,
      role: invite.role,
      token: invite.token,
    }).catch(() => {/* best-effort */});
  }

  return res.status(201).json({ results });
});

projectsRouter.get("/projects/sites/:siteId/invites", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const invites = await listSiteInvites(actor, req.params.siteId);
  if (invites === null) {
    return res.status(403).json({ error: "Insufficient permissions to manage this site." });
  }
  return res.json({ invites });
});

projectsRouter.delete("/projects/sites/:siteId/invites/:inviteId", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const removed = await deleteSiteInvite(actor, req.params.siteId, req.params.inviteId);
  if (!removed) return res.status(404).json({ error: "Invite not found." });
  return res.json({ ok: true });
});

// ─── Site members ─────────────────────────────────────────────────────────────

projectsRouter.get("/projects/sites/:siteId/members", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const members = await listSiteMembers(actor, req.params.siteId);
  if (members === null) {
    return res.status(403).json({ error: "Insufficient permissions to manage this site." });
  }
  return res.json({ members });
});

projectsRouter.delete("/projects/sites/:siteId/members/:email", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const removed = await removeSiteMember(actor, req.params.siteId, req.params.email);
  if (!removed) return res.status(404).json({ error: "Member not found." });
  return res.json({ ok: true });
});

// ─── Invite accept ────────────────────────────────────────────────────────────

const AcceptInviteSchema = z.object({
  token: z.string().min(1),
});

projectsRouter.patch("/projects/sites/:id/progress", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const raw = req.body?.progressPercent;
  const pct = Number(raw);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return res.status(400).json({ error: "progressPercent must be a number between 0 and 100." });
  }
  const site = await updateSiteProgress(actor, req.params.id, pct);
  if (!site) return res.status(404).json({ error: "Site not found." });
  return res.json({ site });
});

projectsRouter.post("/projects/invites/accept", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const parsed = AcceptInviteSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Missing invite token." });
  }
  const result = await acceptSiteInvite(actor.email, parsed.data.token);
  if (result === "not_found" || result === "expired" || result === "already_used") {
    return res.status(404).json({ error: "Invite not found or has expired." });
  }
  if (result === "wrong_user") {
    return res.status(403).json({ error: "This invitation was sent to a different email address." });
  }
  if (result === "already_in_company") {
    return res.status(409).json({ status: "already_in_company", error: "You are already a member of a different company." });
  }
  // Issue a fresh token so the caller's updated role takes effect immediately
  // without requiring a separate login step.
  const reqAuth = (req as unknown as AuthenticatedRequest).auth;
  const effectiveCompanyId = result.companyId ?? reqAuth.companyId;
  const effectiveCompanyRole = result.companyRole ?? reqAuth.companyRole;
  const freshToken = createAuthToken({
    email: reqAuth.email,
    fullName: reqAuth.fullName,
    role: reqAuth.role,
    companyId: effectiveCompanyId,
    companyRole: effectiveCompanyRole,
  });
  return res.json({ token: freshToken, siteId: result.siteId, siteName: result.siteName, role: result.role, companyId: effectiveCompanyId, companyRole: effectiveCompanyRole });
});
