import { RequestHandler } from "express";
import { AuthenticatedRequest } from "./auth";
import { Actor } from "../storage/actor";
import { RecordKind, canEditRow } from "../storage/recordScope";
import { findProjectRowOwner } from "../storage/projectsStore";
import { findIncidentOwner } from "../storage/incidentStore";
import { findInspectionOwner, findInspectionTemplateOwner } from "../storage/inspectionStore";
import { findDeliveryOwner } from "../storage/deliveriesStore";
import { findTimecardOwner } from "../storage/crewStore";

/**
 * "Crew change only what they created", as a route-level refusal.
 *
 * WHY THIS IS A MIDDLEWARE AND NOT A STORE RETURN VALUE
 *
 * Every store in this service signals "no row you may touch" by returning null
 * or false, and every route maps that to 404. That is the right answer for a
 * row in another company — `assertSameCompany`'s reasoning: never confirm an
 * outsider's resource exists. It is the WRONG answer here. A crew member can
 * now READ every record in their company, so the row's existence is not a
 * secret from them, and a 404 on a record they are looking at reads as a bug
 * rather than as a refusal. 403 is the honest code, and it is also the one the
 * decision asks to be measurable.
 *
 * The alternative — throwing from the store — was rejected: Sentry's Express
 * error handler sits in front of the fallback handler in `server.ts`, so every
 * ordinary authorisation refusal would be reported as a server error.
 *
 * BOTH LAYERS STAY
 *
 * The stores keep their own ownership narrowing (`editOwnershipSql`), per
 * CLAUDE.md §3. Removing this middleware therefore degrades the refusal from
 * 403 to 404; it does not open the row. That is deliberate — a gate whose
 * removal is silent is not a gate.
 */

/**
 * The same four fields every route file builds by hand (`getActor`). Repeated
 * here rather than exported from one of them, because this runs BEFORE the
 * handler and importing a route module from a middleware would invert the
 * dependency.
 */
function actorFrom(req: unknown): Actor {
  const r = req as AuthenticatedRequest;
  return { email: r.auth.email, role: r.auth.role, companyId: r.auth.companyId, companyRole: r.auth.companyRole };
}

type OwnerLookup = (actor: Actor, id: string) => Promise<{ companyId: string; ownerEmail: string } | null>;

/**
 * Where each record kind's authorship is read from. Closed and exhaustive over
 * `RecordKind` so that adding a kind to the rule without wiring a lookup fails
 * to compile rather than silently gating nothing.
 *
 * `site` is present and deliberately null: a site's `owner_email` is the
 * manager who created it, so ownership is not the question on a site. What
 * guards sites is the route-level `requireAtLeast("manager")` on creation and
 * deletion, and progress is a shared attribute anyone on the job may update.
 * See RECORD_CLASS in storage/recordScope.ts.
 */
const OWNER_LOOKUP: Readonly<Record<RecordKind, OwnerLookup | null>> = Object.freeze({
  entry: (actor, id) => findProjectRowOwner(actor, "entry", id),
  diary: (actor, id) => findProjectRowOwner(actor, "diary", id),
  diaryTemplate: (actor, id) => findProjectRowOwner(actor, "diaryTemplate", id),
  incident: findIncidentOwner,
  inspection: findInspectionOwner,
  inspectionTemplate: findInspectionTemplateOwner,
  delivery: findDeliveryOwner,
  timesheet: findTimecardOwner,
  site: null,
});

/**
 * Refuse a write to a record the actor did not author.
 *
 * `idParam` names the route parameter holding the record id, because the routes
 * are not consistent about it (`:id` mostly, `:sigId` elsewhere) and guessing
 * would make the gate silently vacuous on the one route that differs.
 */
export function requireOwnRecord(kind: RecordKind, idParam = "id"): RequestHandler {
  const lookup = OWNER_LOOKUP[kind];
  if (!lookup) throw new Error(`requireOwnRecord: ${kind} has no ownership to check — see OWNER_LOOKUP`);
  return async (req, res, next) => {
    try {
      const actor = actorFrom(req);
      const id = req.params[idParam];
      if (!id) return next();
      const row = await lookup(actor, id);
      // No such row in this company. Pass through: the handler answers 404, and
      // this gate does not become a way to probe for ids.
      if (!row) return next();
      if (!canEditRow(actor, kind, row)) {
        return res.status(403).json({ error: "You can only change records you created." });
      }
      return next();
    } catch (err) {
      console.error("[recordOwnership] ownership check failed", { kind, err });
      return res.status(500).json({ error: "Failed to check record ownership." });
    }
  };
}
