import { Router } from "express";
import { asyncSafeRouter } from "../middleware/asyncRouter";
import { z } from "zod";
import { FIELD_ACCESS, AuthenticatedRequest, requireAtLeast } from "../middleware/auth";
import { requireOwnRecord } from "../middleware/recordOwnership";
import {
  listTemplates, createTemplate, deleteTemplate,
  listInspections, createInspection, updateInspection, deleteInspection, getInspection,
} from "../storage/inspectionStore";
import {
  createSignature, listSignatures, voidSignature, computeInspectionContentHash,
  InspectionSignatureRole,
} from "../storage/signatureStore";

export const inspectionsRouter: Router = asyncSafeRouter();
// Explicit requirement for this router's own paths — AUDIT L66. Scoped to the
// prefix rather than pathless, because a pathless `use` here would also run for
// every router mounted after this one in routes/index.ts; that is exactly how
// projects.ts came to refuse 31 routes it had never heard of. Operational work,
// so the requirement is identity, not rank: see FIELD_ACCESS.
inspectionsRouter.use(["/inspections", "/inspection-templates"], ...FIELD_ACCESS);

function getActor(req: unknown) {
  const r = req as AuthenticatedRequest;
  return { email: r.auth.email, role: r.auth.role, companyId: r.auth.companyId, companyRole: r.auth.companyRole };
}

const TemplateSchema = z.object({
  name: z.string().min(1),
  items: z.array(z.string().min(1)).min(1),
});

const ResultItemSchema = z.object({
  item: z.string(),
  passed: z.boolean().nullable().default(null),
  notes: z.string().default(""),
  // N/A is a distinct checklist outcome from unanswered (passed === null). It
  // lives inside results_json (JSONB) so it needs no DDL. It IS signed content —
  // computeInspectionContentHash includes it.
  na: z.boolean().default(false),
  // Per-item photo evidence (Part B). Loose passthrough (like entry photos) so
  // the Part 5a Photo fields (kind/derivedFromId/annotationVector) survive; base64
  // is stripped client-side before send. Signed content (by stable identity).
  photos: z.array(z.record(z.unknown())).default([]),
});

const DefectItemSchema = z.object({
  description: z.string(),
  severity: z.string(),
  owner: z.string(),
  dueDate: z.string().nullable(),
  status: z.string(),
});

const InspectionSchema = z.object({
  siteId: z.string().min(1),
  templateId: z.string().nullable().optional(),
  name: z.string().min(1),
  date: z.string().min(1),
  results: z.array(ResultItemSchema).default([]),
  status: z.enum(["pending", "complete"]).default("pending"),
  // Defensible-inspection fields (024):
  scope: z.string().default(""),
  areaInspected: z.string().default(""),
  time: z.string().default(""),
  inspectorName: z.string().default(""),
  inspectorRole: z.string().default(""),
  inspectorCompany: z.string().default(""),
  defects: z.array(DefectItemSchema).default([]),
  overallOutcome: z.string().default(""),
  followUpRequired: z.boolean().default(false),
});

const InspectionPatchSchema = z.object({
  results: z.array(ResultItemSchema).optional(),
  status: z.enum(["pending", "complete"]).optional(),
  scope: z.string().optional(),
  areaInspected: z.string().optional(),
  time: z.string().optional(),
  inspectorName: z.string().optional(),
  inspectorRole: z.string().optional(),
  inspectorCompany: z.string().optional(),
  defects: z.array(DefectItemSchema).optional(),
  overallOutcome: z.string().optional(),
  followUpRequired: z.boolean().optional(),
});

const SignatureCreateSchema = z.object({
  role: z.enum(["inspector", "manager", "client"]),
  signerName: z.string().min(1),
  path: z.string().min(1),
  viewBox: z.string().min(1),
});

const SignatureVoidSchema = z.object({
  reason: z.string().min(1),
});

// ─── Templates ──────────────────────────────────────────────────────────────

inspectionsRouter.get("/inspection-templates", async (req, res) => {
  try {
    const templates = await listTemplates(getActor(req));
    return res.json({ templates });
  } catch (err) {
    console.error("[inspections] list templates failed", err);
    return res.status(500).json({ error: "Failed to list inspection templates." });
  }
});

inspectionsRouter.post("/inspection-templates", async (req, res) => {
  try {
    const parsed = TemplateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid template payload.", details: parsed.error.flatten() });
    }
    const template = await createTemplate(getActor(req), parsed.data.name, parsed.data.items);
    return res.status(201).json({ template });
  } catch (err) {
    console.error("[inspections] create template failed", err);
    return res.status(500).json({ error: "Failed to create inspection template." });
  }
});

inspectionsRouter.delete("/inspection-templates/:id", requireOwnRecord("inspectionTemplate"), async (req, res) => {
  try {
    const removed = await deleteTemplate(getActor(req), req.params.id);
    if (!removed) return res.status(404).json({ error: "Template not found." });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[inspections] delete template failed", err);
    return res.status(500).json({ error: "Failed to delete inspection template." });
  }
});

// ─── Inspections ─────────────────────────────────────────────────────────────

inspectionsRouter.get("/inspections", async (req, res) => {
  try {
    const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
    const inspections = await listInspections(getActor(req), siteId);
    return res.json({ inspections });
  } catch (err) {
    console.error("[inspections] list failed", err);
    return res.status(500).json({ error: "Failed to list inspections." });
  }
});

inspectionsRouter.post("/inspections", async (req, res) => {
  try {
    const parsed = InspectionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid inspection payload.", details: parsed.error.flatten() });
    }
    const inspection = await createInspection(getActor(req), {
      ...parsed.data,
      templateId: parsed.data.templateId ?? null,
    });
    return res.status(201).json({ inspection });
  } catch (err) {
    console.error("[inspections] create failed", err);
    return res.status(500).json({ error: "Failed to create inspection." });
  }
});

inspectionsRouter.patch("/inspections/:id", requireOwnRecord("inspection"), async (req, res) => {
  try {
    const parsed = InspectionPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid patch.", details: parsed.error.flatten() });
    }
    const inspection = await updateInspection(getActor(req), req.params.id, parsed.data);
    if (!inspection) return res.status(404).json({ error: "Inspection not found." });
    return res.json({ inspection });
  } catch (err) {
    console.error("[inspections] update failed", err);
    return res.status(500).json({ error: "Failed to update inspection." });
  }
});

inspectionsRouter.delete("/inspections/:id", requireOwnRecord("inspection"), async (req, res) => {
  try {
    const removed = await deleteInspection(getActor(req), req.params.id);
    if (!removed) return res.status(404).json({ error: "Inspection not found." });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[inspections] delete failed", err);
    return res.status(500).json({ error: "Failed to delete inspection." });
  }
});

// ─── Signatures ─────────────────────────────────────────────────────────────

inspectionsRouter.post("/inspections/:id/signatures", async (req, res) => {
  try {
    const parsed = SignatureCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid signature payload.", details: parsed.error.flatten() });
    }
    const actor = getActor(req);
    const inspection = await getInspection(actor, req.params.id);
    if (!inspection) return res.status(404).json({ error: "Inspection not found." });
    const { hash, snapshot } = computeInspectionContentHash(inspection);
    const signature = await createSignature(actor, {
      inspectionId: req.params.id,
      role: parsed.data.role as InspectionSignatureRole,
      signerName: parsed.data.signerName,
      path: parsed.data.path,
      viewBox: parsed.data.viewBox,
      contentHash: hash,
      snapshot,
    });
    return res.status(201).json({ signature });
  } catch (err) {
    console.error("[inspections] create signature failed", err);
    return res.status(500).json({ error: "Failed to create signature." });
  }
});

inspectionsRouter.get("/inspections/:id/signatures", async (req, res) => {
  try {
    const signatures = await listSignatures(getActor(req), req.params.id);
    return res.json({ signatures });
  } catch (err) {
    console.error("[inspections] list signatures failed", err);
    return res.status(500).json({ error: "Failed to list signatures." });
  }
});

/**
 * Voiding a signature is manager+. AUDIT L91, the owner's decision.
 *
 * Everything else on this router is identity-only on purpose (FIELD_ACCESS
 * above): capturing an inspection, signing one, listing signatures -- that is
 * field work and rank has no business in it. Voiding is the one operation here
 * that destroys evidence rather than recording it. A signature is the claim
 * that a named person inspected a thing on a date; voiding it retracts that
 * claim on a document retained for seven years, and until this line existed any
 * crew member with a login could retract any signature on any inspection in
 * their company.
 *
 * It is a route-level gate rather than a field-level one, unlike the diary
 * status gate (AUDIT L81), because there is no benign version of this request:
 * the route does exactly one thing, and that thing is the restricted thing.
 *
 * The record survives either way -- voidSignature sets voided_at and
 * voided_reason, it does not delete the row -- so this gate decides who may
 * retract, not whether the retraction is auditable.
 */
inspectionsRouter.post("/inspections/:id/signatures/:sigId/void", requireAtLeast("manager"), async (req, res) => {
  try {
    const parsed = SignatureVoidSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid void payload.", details: parsed.error.flatten() });
    }
    const signature = await voidSignature(getActor(req), req.params.sigId, parsed.data.reason);
    if (!signature) return res.status(404).json({ error: "Signature not found." });
    return res.json({ signature });
  } catch (err) {
    console.error("[inspections] void signature failed", err);
    return res.status(500).json({ error: "Failed to void signature." });
  }
});
