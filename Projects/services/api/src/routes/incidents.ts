import { Router } from "express";
import { asyncSafeRouter } from "../middleware/asyncRouter";
import { z } from "zod";
import { FIELD_ACCESS, AuthenticatedRequest } from "../middleware/auth";
import { requireOwnRecord } from "../middleware/recordOwnership";
import { listIncidents, createIncident, updateIncident, deleteIncident } from "../storage/incidentStore";
import { getAllTokensForEmails } from "../storage/pushStore";
import { sendExpoPushNotifications } from "../utils/expoPush";

export const incidentsRouter: Router = asyncSafeRouter();
// Explicit requirement for this router's own paths — AUDIT L66. Scoped to the
// prefix rather than pathless, because a pathless `use` here would also run for
// every router mounted after this one in routes/index.ts; that is exactly how
// projects.ts came to refuse 31 routes it had never heard of. Operational work,
// so the requirement is identity, not rank: see FIELD_ACCESS.
incidentsRouter.use("/incidents", ...FIELD_ACCESS);

function getActor(req: unknown) {
  const r = req as AuthenticatedRequest;
  return { email: r.auth.email, role: r.auth.role, companyId: r.auth.companyId, companyRole: r.auth.companyRole };
}

const ContributingFactorsSchema = z.object({
  environment: z.string().optional(),
  human: z.string().optional(),
  equipment: z.string().optional(),
  methods: z.string().optional(),
}).default({});

const CorrectiveActionItemSchema = z.object({
  action: z.string(),
  owner: z.string(),
  dueDate: z.string().nullable(),
  status: z.string(),
});

const IncidentSchema = z.object({
  siteId: z.string().min(1),
  date: z.string().min(1),
  severity: z.enum(["near-miss", "minor", "major", "critical"]),
  description: z.string().min(1),
  injuredParty: z.string().default(""),
  correctiveAction: z.string().default(""),
  status: z.enum(["open", "closed"]).default("open"),
  // Pre-existing-but-previously-dropped fields (024):
  time: z.string().default(""),
  type: z.string().default(""),
  locationArea: z.string().default(""),
  injuredRole: z.string().default(""),
  injuredEmployer: z.string().default(""),
  natureOfInjury: z.string().default(""),
  bodyPart: z.string().default(""),
  treatmentRequired: z.string().default(""),
  witnesses: z.string().default(""),
  immediateActions: z.string().default(""),
  rootCause: z.string().default(""),
  reportedBy: z.string().default(""),
  supervisorNotified: z.boolean().default(false),
  supervisorName: z.string().default(""),
  // New WorkSafe NZ investigation fields (024):
  propertyDamage: z.string().default(""),
  firstAiderName: z.string().default(""),
  contributingFactors: ContributingFactorsSchema,
  worksafeNotified: z.boolean().default(false),
  worksafeNotifiedAt: z.string().nullable().default(null),
  worksafeNotifiedHow: z.string().default(""),
  investigatorName: z.string().default(""),
  correctiveActions: z.array(CorrectiveActionItemSchema).default([]),
});

const IncidentPatchSchema = z.object({
  status: z.enum(["open", "closed"]).optional(),
  correctiveAction: z.string().optional(),
  severity: z.enum(["near-miss", "minor", "major", "critical"]).optional(),
});

incidentsRouter.get("/incidents", async (req, res) => {
  try {
    const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
    const incidents = await listIncidents(getActor(req), siteId);
    return res.json({ incidents });
  } catch (err) {
    console.error("[incidents] list failed", err);
    return res.status(500).json({ error: "Failed to list incidents." });
  }
});

incidentsRouter.post("/incidents", async (req, res) => {
  try {
    const parsed = IncidentSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid incident payload.", details: parsed.error.flatten() });
    }
    const actor = getActor(req);
    const incident = await createIncident(actor, parsed.data);

    // Notify supervisors for major/critical incidents
    if (["major", "critical"].includes(parsed.data.severity)) {
      try {
        const tokens = await getAllTokensForEmails(actor, [actor.email]);
        const pushTokens = tokens.map((t) => t.token).filter((t) => t.startsWith("ExponentPushToken"));
        if (pushTokens.length > 0) {
          await sendExpoPushNotifications([{
            to: pushTokens,
            title: `${parsed.data.severity.toUpperCase()} Incident Reported`,
            body: parsed.data.description.slice(0, 100),
            data: { incidentId: incident.id, siteId: incident.siteId },
            sound: "default",
          }]);
        }
      } catch (pushErr) {
        console.error("[incidents] push notification failed", pushErr);
      }
    }

    return res.status(201).json({ incident });
  } catch (err) {
    console.error("[incidents] create failed", err);
    return res.status(500).json({ error: "Failed to create incident." });
  }
});

incidentsRouter.patch("/incidents/:id", requireOwnRecord("incident"), async (req, res) => {
  try {
    const parsed = IncidentPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid patch.", details: parsed.error.flatten() });
    }
    const incident = await updateIncident(getActor(req), req.params.id, parsed.data);
    if (!incident) return res.status(404).json({ error: "Incident not found." });
    return res.json({ incident });
  } catch (err) {
    console.error("[incidents] update failed", err);
    return res.status(500).json({ error: "Failed to update incident." });
  }
});

incidentsRouter.delete("/incidents/:id", requireOwnRecord("incident"), async (req, res) => {
  try {
    const removed = await deleteIncident(getActor(req), req.params.id);
    if (!removed) return res.status(404).json({ error: "Incident not found." });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[incidents] delete failed", err);
    return res.status(500).json({ error: "Failed to delete incident." });
  }
});
