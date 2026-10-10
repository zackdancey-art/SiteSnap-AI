import { Router } from "express";
import { z } from "zod";
import { FIELD_ACCESS, AuthenticatedRequest } from "../middleware/auth";
import { listDeliveries, createDelivery, updateDelivery, deleteDelivery } from "../storage/deliveriesStore";
import { rateLimit } from "../middleware/rateLimit";

export const deliveriesRouter: Router = Router();
// Explicit requirement for this router's own paths — AUDIT L66. This line used
// to be a PATHLESS `use(requireAuth)`, the same shape that made projects.ts
// refuse 31 routes belonging to other routers. It did no harm here only because
// everything mounted after it happens to require authentication anyway, which
// is luck rather than design. Scoped now. Operational work, so the requirement
// is identity, not rank: see FIELD_ACCESS.
deliveriesRouter.use("/deliveries", ...FIELD_ACCESS);

function getActor(req: AuthenticatedRequest) {
  return { email: req.auth.email, role: req.auth.role, companyId: req.auth.companyId, companyRole: req.auth.companyRole };
}

const DeliverySchema = z.object({
  siteId: z.string().min(1),
  date: z.string().min(1),
  supplier: z.string().default(""),
  items: z.array(z.string()).default([]),
  quantity: z.string().default(""),
  notes: z.string().default(""),
});

const DeliveryPatchSchema = DeliverySchema.omit({ siteId: true }).partial();

deliveriesRouter.get("/deliveries", async (req, res) => {
  try {
    const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
    const deliveries = await listDeliveries(getActor(req as unknown as AuthenticatedRequest), siteId);
    return res.json({ deliveries });
  } catch (err) {
    console.error("[deliveries] list failed", err);
    return res.status(500).json({ error: "Failed to list deliveries." });
  }
});

deliveriesRouter.post("/deliveries", rateLimit("deliveries-post", 60, 60 * 60 * 1000), async (req, res) => {
  try {
    const parsed = DeliverySchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid delivery payload.", details: parsed.error.flatten() });
    const delivery = await createDelivery(getActor(req as unknown as AuthenticatedRequest), parsed.data);
    return res.status(201).json({ delivery });
  } catch (err) {
    console.error("[deliveries] create failed", err);
    return res.status(500).json({ error: "Failed to create delivery." });
  }
});

deliveriesRouter.patch("/deliveries/:id", async (req, res) => {
  try {
    const parsed = DeliveryPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "Invalid delivery patch.", details: parsed.error.flatten() });
    const delivery = await updateDelivery(getActor(req as unknown as AuthenticatedRequest), req.params.id, parsed.data);
    if (!delivery) return res.status(404).json({ error: "Delivery not found." });
    return res.json({ delivery });
  } catch (err) {
    console.error("[deliveries] update failed", err);
    return res.status(500).json({ error: "Failed to update delivery." });
  }
});

deliveriesRouter.delete("/deliveries/:id", async (req, res) => {
  try {
    const removed = await deleteDelivery(getActor(req as unknown as AuthenticatedRequest), req.params.id);
    if (!removed) return res.status(404).json({ error: "Delivery not found." });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[deliveries] delete failed", err);
    return res.status(500).json({ error: "Failed to delete delivery." });
  }
});
