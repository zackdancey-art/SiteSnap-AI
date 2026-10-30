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
  // `.trim()` on every field, not just `name`. Two reasons, and the second is
  // the one that caught this: a value the user typed a trailing space into is
  // the same client as the one without it, and the client-details rule — in
  // both copies, apps/mobile/lib/client-details.ts and
  // apps/supervisor-web/lib/client-details.ts — decides whether to render a
  // row by trimming and testing for empty. That rule's header claimed "both
  // routes .trim() on the way in", which was true of `name` alone. Either the comment was wrong or the schema was; the schema was the
  // half worth changing, because a whitespace-only address stored verbatim is
  // a row that renders on one surface and not the other depending on which
  // of them trims.
  contactName: z.string().trim().max(200).default(""),
  contactEmail: z.string().trim().max(320).default(""),
  contactPhone: z.string().trim().max(50).default(""),
  // The Xero-shaped fields (migration 036). Every one optional, for the same
  // reason `name` is the only required field: an invoice address is something
  // the office fills in later, not something the person standing on the site
  // has to hand.
  //
  // The addresses are one free-text block each rather than four columns, and
  // the lengths are generous because a rural postal address with a RD number
  // and a courier instruction is longer than it looks. 500 is well past any
  // real address and well short of anything worth storing in a TEXT column.
  physicalAddress: z.string().trim().max(500).default(""),
  postalAddress: z.string().trim().max(500).default(""),
  // Unvalidated by format, deliberately. A GST number's shape differs by
  // country; refusing a number the user is reading off a real invoice is
  // worse than storing it, and Xero's own rejection is the authority on what
  // Xero accepts.
  taxNumber: z.string().trim().max(50).default(""),
  companyNumber: z.string().trim().max(50).default(""),
  notes: z.string().trim().max(5000).default(""),
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT IS NOT IN THAT SCHEMA, AND WILL NOT BE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * NO BANK ACCOUNT DETAILS. No account number, no BSB, no sort code, no IBAN.
 * The Xero integration does not need them: Xero works off a contact record it
 * holds itself, and the bank details live on its side of that boundary. The
 * whole of this schema's integration footprint is `xero_contact_id`, which
 * this router does not accept either.
 *
 * `xeroContactId` is absent from `ClientSchema` on purpose, which means
 * `ClientPatchSchema`'s `.strict()` below turns an attempt to set it into a
 * 400 rather than a silent no-op. The store returns it so a future screen can
 * show whether a client is linked; nothing can write it through HTTP. The same
 * statement appears in migration 036 and in storage/clientsStore.ts, in all
 * three places a person would look before adding a column.
 */

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
