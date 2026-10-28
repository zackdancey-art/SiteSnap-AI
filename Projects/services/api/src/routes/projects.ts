import { Router, type RequestHandler } from "express";
import { asyncSafeRouter } from "../middleware/asyncRouter";
import { z } from "zod";
import { verifyProvenance } from "../services/diaryProvenance";
import { FIELD_ACCESS, requireAtLeast, AuthenticatedRequest } from "../middleware/auth";
import { getClient } from "../storage/clientsStore";
import { requireOwnRecord } from "../middleware/recordOwnership";
import { createAuthToken } from "../utils/authToken";
import { findUserByEmail } from "../storage/authStore";
import { setSessionCookie } from "../utils/sessionCookie";
import {
  acceptSiteInvite,
  isAcceptInviteSuccess,
  isAcceptInviteWrongUser,
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
  listBinnedSites,
  listSites,
  listTemplates,
  removeSiteMember,
  updateDiary,
  updateEntry,
  updateSiteProgress,
  updateSiteClient,
  updateTemplate,
  restoreSite,
} from "../storage/projectsStore";
import { isRateLimitedByAccount, LIMITS } from "../middleware/rateLimit";
import { sendSiteInvite } from "../services/notificationService";
import { normalizeEmail } from "../utils/emailAddresses";
import { BIN_RETENTION_DAYS, daysInBin } from "../storage/softDelete";

function parsePagination(query: Record<string, unknown>) {
  const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 500);
  const offset = Math.max(Number(query.offset) || 0, 0);
  return { limit, offset };
}

const SiteSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  // Still required, still free text. Migration 032 added `client_id` but did
  // not retire this: every existing site has a name typed into it, the report
  // header and the mobile search box read it, and making it optional would mean
  // a site created by a client that has not shipped the clients UI yet arrives
  // with no client name at all. `clientId` below is the filing; this is the
  // label. When both are present the label is kept in step with the client's
  // canonical name — see updateSiteClient in projectsStore.
  client: z.string().min(1),
  startDate: z.string().min(1),
  status: z.enum(["active", "completed", "on-hold"]),
  // Optional and nullable: a site created before the clients UI ships, or by a
  // client that never sends it, is Unfiled rather than rejected.
  clientId: z.string().min(1).nullish(),
});

/**
 * Filing a site under a client, as its own route and its own schema.
 *
 * `.strict()` and one field. This is NOT the missing general site-edit route:
 * there is still no way to change a site's name, address or status anywhere in
 * this product, which is a real gap and deliberately not closed here — a PATCH
 * that accepted the whole site would be a bigger surface than this workstream
 * asked for, and `requireAtLeast("manager")` on a wide-open patch is exactly
 * the kind of route that quietly grows. One field, one meaning.
 *
 * `clientId: null` unfiles.
 */
const SiteFilingSchema = z.object({
  clientId: z.string().min(1).nullable(),
}).strict();

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

export const projectsRouter: Router = asyncSafeRouter();

/**
 * WHAT THIS ROUTER REQUIRES, AND WHY IT IS SCOPED TO "/projects" — AUDIT L66.
 *
 * This used to be one PATHLESS `projectsRouter.use(requireAuth,
 * requireAtLeast("viewer"))`, plus a carve-out for the invitation-accept path.
 * A pathless `use` on a router mounted with `apiRouter.use(projectsRouter)`
 * runs for EVERY request that reaches it, not only for this router's own
 * routes — and seven routers are mounted AFTER this one in routes/index.ts
 * (push, crew, incidents, inspections, deliveries, templates, location). So a
 * crew member was 403'd out of all 31 of their routes by a line written to
 * protect the supervisor dashboard: no clocking in, no incident, no inspection,
 * no delivery, no location ping. Measured, with an owner positive control on
 * the same route in the same run.
 *
 * The path argument is the whole fix for that: the gate now runs for the paths
 * this router actually serves and for nothing downstream of it.
 *
 * WHY NOT PROMOTE CREW TO VIEWER INSTEAD
 *
 * Because a rank promotion grants whatever else viewer implies, on every route
 * that gates on viewer today and every one added later, none of which anybody
 * would re-examine. The requirement belongs on the route, said out loud. So the
 * router states the operational requirement once — an authenticated company
 * member, see FIELD_ACCESS — and the routes that need more than that carry it
 * themselves, each with the reason:
 *
 *   requireAtLeast("viewer")   /projects/summary, /projects/reports/supervisor
 *                              — supervisor aggregates, not field work.
 *   requireAtLeast("manager")  POST+DELETE /projects/sites, the three site
 *                              invitation routes, DELETE site member
 *                              — the decided exceptions: crew do not invite
 *                                anyone and do not remove a site.
 *
 * One requirement is finer than a route, and is stated at the route instead:
 * APPROVING a diary is manager+ while EDITING one is not, so POST and PATCH
 * /projects/diaries gate on the `status` FIELD rather than on the path. See
 * requireManagerToAttestDiaryStatus below — a route-level gate there would read
 * as "diary editing is manager-only", which is a worse defect than the one it
 * would be fixing.
 *
 * The carve-out is gone because nothing is left to carve out of: accepting an
 * invitation is how somebody STOPS being an outsider, so gating it on the rank
 * they only acquire by accepting was circular, and with the blanket gate
 * removed the accept route needs no exception — it needs identity, which is
 * what it now asks for. routes/invite-accept-access.test.ts holds the proof
 * that the orphan state it stranded is still reachable.
 */
projectsRouter.use("/projects", ...FIELD_ACCESS);

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

projectsRouter.get("/projects/summary", requireAtLeast("viewer"), async (req, res) => {
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
  // Validate the filing HERE rather than relying on the foreign key. Two
  // reasons: against Postgres a bad id is a 23503 the caller reads as a 500,
  // and the in-memory store has no foreign keys at all, so this is the only
  // check on the dev and test path. `getClient` is company-scoped, so another
  // company's client id is "not found" rather than a cross-tenant filing.
  const { clientId, ...siteFields } = parsed.data;
  let clientName: string | undefined;
  if (clientId) {
    const client = await getClient(actor, clientId);
    if (!client) return res.status(400).json({ error: "Client not found." });
    clientName = client.name;
  }
  const site = await createSite(actor, {
    ...siteFields,
    clientId: clientId ?? null,
    // Keep the free-text label in step with the client's canonical name, the
    // same way updateSiteClient does — otherwise a site created with a clientId
    // prints whatever the form happened to have in the client text box.
    client: clientName ?? siteFields.client,
  });
  return res.status(201).json({ site });
});

/**
 * File a site under a client, or unfile it. Manager+, matching POST and DELETE.
 *
 * Mounted before `/projects/sites/:id/progress` reads no differently to Express
 * — the paths are distinct — but it sits next to the site routes it belongs
 * with rather than next to progress, which is a field update by any role.
 */
projectsRouter.patch("/projects/sites/:id", requireAtLeast("manager"), async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const parsed = SiteFilingSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid site patch.", details: parsed.error.flatten() });
  }
  let clientName: string | undefined;
  if (parsed.data.clientId) {
    const client = await getClient(actor, parsed.data.clientId);
    if (!client) return res.status(400).json({ error: "Client not found." });
    clientName = client.name;
  }
  const site = await updateSiteClient(actor, req.params.id, { clientId: parsed.data.clientId, clientName });
  if (!site) return res.status(404).json({ error: "Site not found." });
  return res.json({ site });
});

// Still DELETE, and still 404 when it does nothing, so no client changes to
// keep working. What changed is underneath: this now bins the site instead of
// hard-deleting it and nine cascading tables with it. The response gains
// `binned: true` and the retention period so a client can say what happened;
// `ok: true` is kept for the callers that only check that.
projectsRouter.delete("/projects/sites/:id", requireAtLeast("manager"), async (req, res) => {
  const removed = await deleteSite(getActor(req as unknown as AuthenticatedRequest), req.params.id);
  if (!removed) return res.status(404).json({ error: "Site not found." });
  return res.json({ ok: true, binned: true, retentionDays: BIN_RETENTION_DAYS });
});

// The bin. Manager and above, matching the gate on DELETE: whoever can put a
// site in the bin can see what is in it and take it back out. A viewer cannot,
// and crew cannot — neither can delete a site in the first place.
projectsRouter.get("/projects/sites/bin", requireAtLeast("manager"), async (req, res) => {
  const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
  const sites = await listBinnedSites(getActor(req as unknown as AuthenticatedRequest), limit, offset);
  return res.json({
    sites: sites.map((site) => ({ ...site, daysInBin: daysInBin(site.deletedAt) })),
    retentionDays: BIN_RETENTION_DAYS,
    limit,
    offset,
  });
});

projectsRouter.post("/projects/sites/:id/restore", requireAtLeast("manager"), async (req, res) => {
  const site = await restoreSite(getActor(req as unknown as AuthenticatedRequest), req.params.id);
  // 404 covers both "no such site" and "that site is not in the bin". They are
  // the same answer to the caller — there is nothing at that address to restore
  // — and distinguishing them would tell a manager in company A that a site id
  // belonging to company B exists.
  if (!site) return res.status(404).json({ error: "Site not found in the bin." });
  return res.json({ site });
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

projectsRouter.patch("/projects/entries/:id", requireOwnRecord("entry"), async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const parsed = EntryPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid entry patch.", details: parsed.error.flatten() });
  }
  const entry = await updateEntry(actor, req.params.id, parsed.data);
  if (!entry) return res.status(404).json({ error: "Entry not found." });
  return res.json({ entry });
});

projectsRouter.delete("/projects/entries/:id", requireOwnRecord("entry"), async (req, res) => {
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

/**
 * APPROVING a diary is manager+. EDITING one is not. — AUDIT L81.
 *
 * This is a FIELD-level gate, and the distinction is the whole of it. Crew keep
 * full write access to a diary's content: notes, summary, the full report, the
 * safety checklist, the sections, the report period. What they may not do is
 * move it to `approved`.
 *
 * The reason is that the two are different acts on a seven-year compliance
 * record. A submitted diary is a claim; an approved one is the record. The
 * supervisor dashboard computes an "approval rate" from this field and presents
 * it as oversight, and a rate that counts the author's own approvals is a
 * misleading number on a document somebody may have to stand behind. Timesheets
 * are gated the same way and for the same reason.
 *
 * WHY IT ALLOWLISTS `draft` RATHER THAN REFUSING `approved`
 *
 * An exact `status === "approved"` test is correct today and stops being correct
 * the moment the enum grows a third value, silently and with no failing test —
 * a new terminal state the portal treats as oversight would be the same hole
 * under another name. So the gate permits the one status that asserts nothing
 * (`draft`, which is where a diary already is) and sends every other value,
 * known or not, through the manager check. It fails CLOSED on anything new.
 *
 * An absent `status` is the common case — a content edit — and passes straight
 * through, which is the half that stops this becoming "diary editing is now
 * manager-only". Both halves are asserted on the same route in the same test;
 * see routes/crew-permissions-db.test.ts, where a gate that locked the whole
 * route would fail the first row.
 *
 * It is applied to POST as well as PATCH, deliberately and beyond the letter of
 * the decision, because `DiarySchema.status` is REQUIRED on create: without it
 * a crew member refused the transition could simply create the diary already
 * approved, and the PATCH gate would be decoration. Both clients send
 * `status: "draft"` on create today (apps/mobile/app/diary/[siteId].tsx), so
 * nothing in the product is affected. Flagged for the owner in the PR body.
 */
const DIARY_STATUS_ASSERTING_NOTHING = "draft";
const managerToAttest = requireAtLeast("manager");

const requireManagerToAttestDiaryStatus: RequestHandler = (req, res, next) => {
  const body: unknown = req.body;
  const status =
    body !== null && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).status
      : undefined;
  // No status in the body at all: a content edit, which is crew's daily work.
  if (status === undefined) return next();
  // Still a draft: nothing is being attested to.
  if (status === DIARY_STATUS_ASSERTING_NOTHING) return next();
  // `approved`, or any value the enum grows later. Fails closed.
  return managerToAttest(req, res, next);
};

projectsRouter.post("/projects/diaries", requireManagerToAttestDiaryStatus, async (req, res) => {
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

projectsRouter.patch("/projects/diaries/:id", requireOwnRecord("diary"), requireManagerToAttestDiaryStatus, async (req, res) => {
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

projectsRouter.patch("/projects/templates/:id", requireOwnRecord("diaryTemplate"), async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const parsed = TemplatePatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid template patch.", details: parsed.error.flatten() });
  }
  const template = await updateTemplate(actor, req.params.id, parsed.data);
  if (!template) return res.status(404).json({ error: "Template not found." });
  return res.json({ template });
});

projectsRouter.delete("/projects/templates/:id", requireOwnRecord("diaryTemplate"), async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const removed = await deleteTemplate(actor, req.params.id);
  if (!removed) return res.status(404).json({ error: "Template not found." });
  return res.json({ ok: true });
});

// ─── Site invites ─────────────────────────────────────────────────────────────

// AUDIT L46: normalised in the schema, so the echoed `results[].email` and the
// stored `invited_email` are the same string the account will have after
// registration lowercases it. The transform runs AFTER .email(), so an address
// is still validated as typed; only its stored form is folded.
const InviteSchema = z.object({
  emails: z.array(z.string().email().transform(normalizeEmail)).min(1).max(50),
  role: z.enum(["manager", "viewer", "crew"]).default("crew"),
});

projectsRouter.post("/projects/sites/:siteId/invites", requireAtLeast("manager"), async (req, res) => {
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

projectsRouter.get("/projects/sites/:siteId/invites", requireAtLeast("manager"), async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const invites = await listSiteInvites(actor, req.params.siteId);
  if (invites === null) {
    return res.status(403).json({ error: "Insufficient permissions to manage this site." });
  }
  return res.json({ invites });
});

projectsRouter.delete("/projects/sites/:siteId/invites/:inviteId", requireAtLeast("manager"), async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const removed = await deleteSiteInvite(actor, req.params.siteId, req.params.inviteId);
  if (!removed) return res.status(404).json({ error: "Invite not found." });
  return res.json({ ok: true });
});

// ─── Site members ─────────────────────────────────────────────────────────────

// manager+, to match what actually happens rather than what the decision's
// headline rule implies. The decision gives crew everything a manager has
// except three named things, and a site's member roster is not one of them —
// but listSiteMembers() refuses through canManageSite(), which admits owners,
// managers, and a crew/viewer who personally owns the site. So an auth-only
// gate here would state "any member" and behave as "managers only". A gate that
// says something untrue is the defect this phase is about, so the gate states
// the effective requirement. If crew should see the roster, the change is in
// projectsStore.canManageSite, not here — flagged in the PR body.
projectsRouter.get("/projects/sites/:siteId/members", requireAtLeast("manager"), async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const members = await listSiteMembers(actor, req.params.siteId);
  if (members === null) {
    return res.status(403).json({ error: "Insufficient permissions to manage this site." });
  }
  return res.json({ members });
});

projectsRouter.delete("/projects/sites/:siteId/members/:email", requireAtLeast("manager"), async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const removed = await removeSiteMember(actor, req.params.siteId, req.params.email);
  if (!removed) return res.status(404).json({ error: "Member not found." });
  return res.json({ ok: true });
});

// ─── Invite accept ────────────────────────────────────────────────────────────

const AcceptInviteSchema = z.object({
  token: z.string().min(1),
});

// Deliberately NOT requireOwnRecord("site"). Progress is a shared attribute of
// the site, not an authored record: `owner_email` on project_sites is the
// manager who created it, and crew create none, so an ownership gate here would
// refuse crew every progress update and delete a working field capability
// rather than close a gap. RECORD_CLASS calls this `shared-site-attribute`.
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
  if (isAcceptInviteWrongUser(result)) {
    // Name BOTH addresses and the action. The old wording -- "This invitation
    // was sent to a different email address." -- was literally true and
    // operationally useless: it did not say which address, it did not say which
    // account you were signed in as, and it did not say that the remedy is to
    // sign out. Reported as a bug on a device where it was in fact correct
    // behaviour, which is the measure of how badly it read.
    //
    // The two addresses are returned as fields as well as prose so a client can
    // offer sign-out without parsing the sentence; app/invite.tsx does. `code`
    // exists for the same reason -- the mobile screen used to decide what to
    // render with a substring match on this very string.
    return res.status(403).json({
      error: `This invitation is for ${result.invitedEmail}. You're signed in as ${actor.email} — sign out, then open the invitation link again to accept it.`,
      code: "invite_wrong_user",
      invitedEmail: result.invitedEmail,
      signedInAs: actor.email,
    });
  }
  if (result === "already_in_company") {
    return res.status(409).json({ status: "already_in_company", error: "You are already a member of a different company." });
  }
  if (!isAcceptInviteSuccess(result)) {
    // Unreachable today -- every refusal above returns, so `result` is narrowed
    // to AcceptInviteSuccess and the `never` assignment holds. That assignment
    // is the point: a new member added to AcceptInviteResult and not refused
    // above fails THIS LINE at typecheck, instead of reaching the 200 below and
    // answering `{"siteId":undefined,"role":undefined}`.
    const unhandled: never = result;
    console.error("[projects] unhandled acceptSiteInvite result", unhandled);
    return res.status(500).json({ error: "Could not accept the invitation." });
  }
  // Issue a fresh token so the caller's updated role takes effect immediately
  // without requiring a separate login step.
  //
  // THIS TOKEN IS A CONVENIENCE, AND SAYING SO IS THE POINT
  //
  // An earlier revision of this branch had `setUserCompany` increment the
  // token generation, on the reasoning that a changed companyId makes the
  // tokens on the holder's other devices address the wrong tenant. That made
  // this replacement load-bearing -- and it also meant the caller's CURRENT
  // credential stopped being accepted at the moment they used it, including at
  // `/auth/refresh`, which is the mobile client's only recovery path. An
  // invitee accepting an invitation landed on the login screen. Measured, not
  // theorised.
  //
  // Under the model now in force (see THE SESSION MODEL at
  // `storage/authStore.ts`) that cannot happen: the stale claim is never
  // consulted for a decision, because `requireAuth` takes the acting company
  // and rank from the row. The caller's existing token keeps working through
  // the acceptance and afterwards. So this token is a cache refresh, not a
  // rescue: the client that stores it stops carrying claims it knows are
  // behind, which is worth doing and is not worth revoking anything for.
  //
  // It is minted from the RECORD, not from `result` and not from the claims.
  // `result` carries what the handler intended to write; the record carries
  // what the database actually has. AUDIT L65 was accept reporting success for
  // attaching nobody to anything, and a token asserting a membership the row
  // disagrees with is the same lie one layer along. Reading the row is free
  // here -- it is the same query the generation needs.
  const reqAuth = (req as unknown as AuthenticatedRequest).auth;
  const record = await findUserByEmail(reqAuth.email);
  const effectiveCompanyId = record?.companyId ?? result.companyId ?? reqAuth.companyId;
  const effectiveCompanyRole = record?.companyRole ?? result.companyRole ?? reqAuth.companyRole;
  const freshToken = createAuthToken({
    email: reqAuth.email,
    fullName: record?.fullName ?? reqAuth.fullName,
    role: record?.role ?? reqAuth.role,
    companyId: effectiveCompanyId,
    companyRole: effectiveCompanyRole,
    tokenGeneration: record?.tokenGeneration ?? reqAuth.tokenGeneration,
  });
  // The portal cannot read the token out of the body -- its session cookie is
  // httpOnly, which is the whole point of it -- so for a cookie caller the
  // replacement has to arrive as a Set-Cookie or not at all. Bearer callers get
  // it in the body, as they always have; setting a cookie for them as well
  // would leave the device holding two credentials at two generations.
  if ((req as unknown as AuthenticatedRequest).authTransport === "cookie") {
    setSessionCookie(res, freshToken);
  }
  return res.json({ token: freshToken, siteId: result.siteId, siteName: result.siteName, role: result.role, companyId: effectiveCompanyId, companyRole: effectiveCompanyRole });
});
