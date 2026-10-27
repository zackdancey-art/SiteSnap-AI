import { Router } from "express";
import { z } from "zod";
import { asyncSafeRouter } from "../middleware/asyncRouter";
import { FIELD_ACCESS, requireAtLeast, AuthenticatedRequest } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import {
  listClients,
  getClient,
  createClient,
  updateClient,
  deleteClient,
  countSitesByClient,
  DuplicateClientNameError,
} from "../storage/clientsStore";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CLIENT FILING. MANAGER+ TO CHANGE, EVERYONE TO READ.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE TWO GATES, AND WHY THEY DIFFER
 *
 * `clientsRouter.use("/clients", ...FIELD_ACCESS)` is the identity requirement
 * for this router's own prefix — scoped, not pathless, so it cannot refuse
 * routers mounted after it (AUDIT L66). Identity rather than rank, because a
 * crew member reading the client list is the point: the site they are standing
 * on is filed under one of these names.
 *
 * Each write then carries `requireAtLeast("manager")` ON THE ROUTE, matching
 * POST and DELETE /projects/sites. The store does NOT repeat the rank check,
 * and that is deliberate rather than a missing second layer: ranks are an
 * `Actor` property that every store already carries, so a store-level rank test
 * would be a second copy of a rule with no independent source of truth. The
 * second layer that does exist is the one that matters — `company_id` in every
 * predicate AND Postgres RLS (migration 032) — which is the layer that fails
 * closed if a route is ever mounted without its gate.
 *
 * CLIENTS ARE NOT AN ACCESS BOUNDARY. No route here, and nothing it calls,
 * decides who may read or change a site, an entry or a diary. See the header of
 * storage/clientsStore.ts.
 */
export const clientsRouter: Router = asyncSafeRouter();
clientsRouter.use("/clients", ...FIELD_ACCESS);

function getActor(req: AuthenticatedRequest) {
  return { email: req.auth.email, role: req.auth.role, companyId: req.auth.companyId, companyRole: req.auth.companyRole };
}

/**
 * `name` is the only required field. A builder adding a client mid-job has the
 * name and nothing else to hand, and a form that refuses to save without an
 * email address is a form that does not get used.
 */
const ClientSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contactName: z.string().max(200).default(""),
  contactEmail: z.string().max(320).default(""),
  contactPhone: z.string().max(50).default(""),
  notes: z.string().max(5000).default(""),
});

/**
 * `.strict()` so an unknown key is a 400 rather than a silent no-op.
 *
 * Specifically: a client sending `{ clientId }` to this route — confusing
 * "edit the client" with "file a site under the client" — gets told, instead of
 * a 200 that changed nothing. Filing lives on PATCH /projects/sites/:id.
 */
const ClientPatchSchema = ClientSchema.partial().strict();

clientsRouter.get("/clients", async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  // Two queries for the whole list, not one per client: `siteCounts` is a
  // single GROUP BY. The list route is what the clients page renders, so an
  // N+1 here would be one request per client on every page load.
  const [clients, siteCounts] = await Promise.all([listClients(actor), countSitesByClient(actor)]);
  return res.json({
    clients: clients.map((c) => ({ ...c, siteCount: siteCounts[c.id] ?? 0 })),
  });
});

clientsRouter.post(
  "/clients",
  requireAtLeast("manager"),
  rateLimit("clients-post", 60, 60 * 60 * 1000),
  async (req, res) => {
    const parsed = ClientSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid client payload.", details: parsed.error.flatten() });
    }
    try {
      const client = await createClient(getActor(req as unknown as AuthenticatedRequest), parsed.data);
      return res.status(201).json({ client: { ...client, siteCount: 0 } });
    } catch (err) {
      if (err instanceof DuplicateClientNameError) {
        // 409 with the existing id, so the client can offer "open it" rather
        // than leaving the user to guess which of their clients it collided
        // with. The duplicate is refused by a unique index in the database as
        // well as by this check — the route is not the only writer.
        return res.status(409).json({ error: "A client with that name already exists.", clientId: err.existingId });
      }
      throw err;
    }
  }
);

clientsRouter.patch("/clients/:id", requireAtLeast("manager"), async (req, res) => {
  const parsed = ClientPatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid client patch.", details: parsed.error.flatten() });
  }
  try {
    const client = await updateClient(getActor(req as unknown as AuthenticatedRequest), req.params.id, parsed.data);
    if (!client) return res.status(404).json({ error: "Client not found." });
    return res.json({ client });
  } catch (err) {
    if (err instanceof DuplicateClientNameError) {
      return res.status(409).json({ error: "A client with that name already exists.", clientId: err.existingId });
    }
    throw err;
  }
});

/**
 * Delete a client. Its sites are UNFILED, never deleted.
 *
 * The response says how many sites were unfiled so the client can show it;
 * the confirmation BEFORE the call is the client's job and both surfaces fetch
 * `siteCount` from the list route for exactly that.
 */
clientsRouter.delete("/clients/:id", requireAtLeast("manager"), async (req, res) => {
  const actor = getActor(req as unknown as AuthenticatedRequest);
  const existing = await getClient(actor, req.params.id);
  if (!existing) return res.status(404).json({ error: "Client not found." });
  const result = await deleteClient(actor, req.params.id);
  if (!result) return res.status(404).json({ error: "Client not found." });
  return res.json({ ok: true, unfiledSites: result.unfiledSites });
});
