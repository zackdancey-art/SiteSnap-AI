import { Router } from "express";
import { z } from "zod";
import { FIELD_ACCESS, AuthenticatedRequest } from "../middleware/auth";
import { listTemplates, createTemplate, deleteTemplate } from "../storage/templateStore";

// ── Australian WHS built-in checklists (Safe Work Australia compliant) ────────
const WHS_CHECKLISTS = [
  {
    id: "pre-start-daily",
    name: "Daily Pre-Start Safety Checklist",
    category: "pre-start",
    items: [
      "Site access is safe and free from hazards",
      "All workers have received today's site safety briefing",
      "Personal Protective Equipment (PPE) is worn correctly",
      "Plant and equipment pre-start checks completed",
      "Emergency evacuation plan is understood by all workers",
      "First aid kit is stocked and location known",
      "Emergency contact numbers are posted on site",
      "Weather conditions assessed — no extreme heat, storm, or lightning risk",
      "Work area secured against unauthorised entry",
      "Housekeeping completed — walkways and work areas clear",
    ],
  },
  {
    id: "hazard-identification",
    name: "Hazard Identification & Risk Assessment",
    category: "hazard",
    items: [
      "Working at heights — fall prevention measures in place (AS/NZS 1891)",
      "Excavation or trenching — ground stability confirmed, no underground services nearby",
      "Electrical hazards identified — safe distances maintained (AS/NZS 3000)",
      "Manual handling risks assessed — mechanical aids available where needed",
      "Hazardous chemicals identified — SDS on site, appropriate PPE used",
      "Noise levels assessed — hearing protection provided where > 85 dB(A)",
      "Dust and airborne particles controlled — silica dust management in place",
      "Traffic management plan in place if applicable",
      "Hot work permit obtained if welding, cutting or grinding",
      "Confined space entry permit obtained if applicable",
    ],
  },
  {
    id: "incident-near-miss",
    name: "Incident & Near Miss Report",
    category: "incident",
    items: [
      "Incident date, time and exact location recorded",
      "All injured or affected persons identified and names recorded",
      "Nature of injury or illness classified (per Safe Work Australia codes)",
      "Immediate first aid provided and medical treatment arranged if required",
      "Incident site preserved for investigation (do not disturb unless safety risk)",
      "Regulator notified if notifiable incident (death, serious injury, dangerous incident)",
      "Direct and contributing causes identified",
      "Witness statements collected",
      "Corrective actions assigned with responsible person and due date",
      "Return-to-work plan initiated if worker requires medical leave",
    ],
  },
  {
    id: "whs-inspection",
    name: "Weekly WHS Site Inspection",
    category: "inspection",
    items: [
      "Site entry and egress routes are clear and well-lit",
      "All scaffolding tagged and inspected by a competent person",
      "Fall protection: guardrails, covers, and safety nets in place",
      "Ladders secured and in good condition (tagged, not painted)",
      "Electrical tools tested and tagged (AS/NZS 3760)",
      "Fire extinguishers accessible and within service date",
      "Waste disposal areas maintained — no combustibles near ignition sources",
      "Chemical storage compliant with GHS/SDS requirements",
      "Amenities (toilets, wash facilities, lunch room) clean and serviceable",
      "Safety signage visible and up to date",
      "Worker inductions recorded for all new personnel",
      "Tool box talk records up to date",
    ],
  },
  {
    id: "swms-review",
    name: "Safe Work Method Statement (SWMS) Review",
    category: "swms",
    items: [
      "SWMS prepared for all High Risk Construction Work (HRCW) activities",
      "SWMS reviewed and signed by principal contractor",
      "All workers performing HRCW have read and understood the SWMS",
      "SWMS is site-specific and describes the actual sequence of work",
      "Control measures in SWMS are implemented on site",
      "SWMS version is current — reviewed after any incident or change in work",
      "Copies of SWMS available on site and accessible to workers",
      "Workers have been consulted on the SWMS content",
    ],
  },
];

export const templatesRouter: Router = Router();
// Explicit requirement for this router's own paths — AUDIT L66. This line used
// to be a PATHLESS `use(requireAuth)`, the same shape that made projects.ts
// refuse 31 routes belonging to other routers. It did no harm here only because
// everything mounted after it happens to require authentication anyway, which
// is luck rather than design. Scoped now. Operational work, so the requirement
// is identity, not rank: see FIELD_ACCESS.
templatesRouter.use(["/whs-checklists", "/entry-templates"], ...FIELD_ACCESS);

function getActor(req: AuthenticatedRequest) {
  return { email: req.auth.email, role: req.auth.role, companyId: req.auth.companyId, companyRole: req.auth.companyRole };
}

const TemplateSchema = z.object({
  name: z.string().min(1).max(100),
  notes: z.string().default(""),
  crewCount: z.string().default(""),
  weather: z.string().default(""),
});

templatesRouter.get("/whs-checklists", (_req, res) => {
  return res.json({ checklists: WHS_CHECKLISTS });
});

templatesRouter.get("/whs-checklists/:id", (req, res) => {
  const checklist = WHS_CHECKLISTS.find((c) => c.id === req.params.id);
  if (!checklist) return res.status(404).json({ error: "Checklist not found." });
  return res.json({ checklist });
});

templatesRouter.get("/entry-templates", async (req, res) => {
  try {
    const templates = await listTemplates(getActor(req as unknown as AuthenticatedRequest));
    return res.json({ templates });
  } catch (err) {
    console.error("[templates] list failed", err);
    return res.status(500).json({ error: "Failed to list templates." });
  }
});

templatesRouter.post("/entry-templates", async (req, res) => {
  try {
    const parsed = TemplateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid template payload.", details: parsed.error.flatten() });
    const template = await createTemplate(getActor(req as unknown as AuthenticatedRequest), parsed.data);
    return res.status(201).json({ template });
  } catch (err) {
    console.error("[templates] create failed", err);
    return res.status(500).json({ error: "Failed to create template." });
  }
});

templatesRouter.delete("/entry-templates/:id", async (req, res) => {
  try {
    const removed = await deleteTemplate(getActor(req as unknown as AuthenticatedRequest), req.params.id);
    if (!removed) return res.status(404).json({ error: "Template not found." });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[templates] delete failed", err);
    return res.status(500).json({ error: "Failed to delete template." });
  }
});
