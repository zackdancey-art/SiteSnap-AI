import { Router } from "express";
import { z } from "zod";
import { requireAuth, requireAtLeast, requireCompanyRole, AuthenticatedRequest } from "../middleware/auth";
import {
  getCompany,
  updateCompanyProfile,
  listCompanyMembers,
  countCompanyOwners,
  setUserCompany,
  setUserCompanyRole,
} from "../storage/authStore";
import { createCompanyInvite, listCompanyInvites } from "../storage/projectsStore";
import { sendCompanyInvite } from "../services/notificationService";
import { normalizeEmail, sameEmail } from "../utils/emailAddresses";

export const companyRouter: Router = Router();
companyRouter.use(requireAuth);

function getActor(req: AuthenticatedRequest) {
  return {
    email: req.auth.email,
    role: req.auth.role,
    companyId: req.auth.companyId,
    companyRole: req.auth.companyRole,
  };
}

// ── Company profile ──────────────────────────────────────────────────────────

companyRouter.get("/company/profile", requireAtLeast("viewer"), async (req, res) => {
  try {
    const actor = getActor(req as unknown as AuthenticatedRequest);
    const company = await getCompany(actor.companyId);
    if (!company) return res.status(404).json({ error: "Company not found." });
    return res.json({ company });
  } catch (err) {
    console.error("[company] get profile failed", err);
    return res.status(500).json({ error: "Failed to retrieve company profile." });
  }
});

const ProfilePatchSchema = z.object({
  name: z.string().min(1).optional(),
  country: z.string().optional(),
});

companyRouter.patch("/company/profile", requireCompanyRole("owner"), async (req, res) => {
  try {
    const actor = getActor(req as unknown as AuthenticatedRequest);
    const parsed = ProfilePatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload.", details: parsed.error.flatten() });
    }
    const company = await updateCompanyProfile(actor.companyId, parsed.data);
    return res.json({ company });
  } catch (err) {
    console.error("[company] update profile failed", err);
    return res.status(500).json({ error: "Failed to update company profile." });
  }
});

// ── Member listing ────────────────────────────────────────────────────────────

companyRouter.get("/company/members", requireAtLeast("manager"), async (req, res) => {
  try {
    const actor = getActor(req as unknown as AuthenticatedRequest);
    const rows = await listCompanyMembers(actor.companyId);
    const members = rows.map(({ email, fullName, companyRole }) => ({ email, name: fullName, companyRole }));
    return res.json({ members });
  } catch (err) {
    console.error("[company] list members failed", err);
    return res.status(500).json({ error: "Failed to list members." });
  }
});

// ── Invite ────────────────────────────────────────────────────────────────────

// AUDIT L46: see the matching comment in routes/projects.ts. This is the route
// the portal's Team page and mobile's company-invite screen both call, and the
// one whose input field was the single uncovered email input in the product.
const InviteSchema = z.object({
  emails: z.array(z.string().email().transform(normalizeEmail)).min(1),
  companyRole: z.enum(["manager", "viewer", "crew"]),
});

companyRouter.post("/company/members/invite", requireCompanyRole("owner"), async (req, res) => {
  try {
    const actor = getActor(req as unknown as AuthenticatedRequest);
    const parsed = InviteSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid invite payload.", details: parsed.error.flatten() });
    }
    const inviteResults = await Promise.all(
      parsed.data.emails.map((email) =>
        createCompanyInvite(actor, email, parsed.data.companyRole)
      )
    );
    if (inviteResults.some((r) => r === "owner_role_not_assignable")) {
      return res.status(400).json({ error: "Owner role cannot be assigned via invite." });
    }

    // The company name, for the email. A company that cannot be read falls back
    // to a neutral phrase rather than failing the invitation — the invitation is
    // the valuable thing here, not the greeting.
    const company = await getCompany(actor.companyId);
    const companyName = company?.name?.trim() || "your team";
    const inviterName = (req as unknown as AuthenticatedRequest).auth.fullName?.trim() || actor.email;

    const results = await Promise.all(
      inviteResults.map(async (r, i) => {
        const email = parsed.data.emails[i];
        if (typeof r === "string") return { email, status: "error" as const };
        if (r.status === "already_member") {
          // Not an error. See CompanyInviteOutcome in projectsStore.ts.
          return { email, status: "already_member" as const };
        }

        const delivery = await sendCompanyInvite({
          to: email,
          inviterName,
          companyName,
          companyRole: parsed.data.companyRole,
          token: r.record.token,
        });

        // The token is returned ONLY when the email did not go out — the same
        // convention routes/auth.ts uses for `devCodes`. In production with a
        // mail provider configured, delivery succeeds and the bearer token stays
        // on the server, where it belongs; without one (local dev, and the test
        // harness, which has no inbox) it is the only way to proceed at all.
        // Returning it unconditionally, as this route used to, puts a
        // credential that grants company membership into every response and
        // into any log that records one.
        return {
          email,
          status: r.status,
          delivered: delivery.ok,
          ...(delivery.ok ? {} : { token: r.record.token, deliveryError: delivery.error }),
        };
      })
    );
    return res.status(201).json({ results });
  } catch (err) {
    console.error("[company] invite failed", err);
    return res.status(500).json({ error: "Failed to send invitations." });
  }
});

// ── Pending invitations ───────────────────────────────────────────────────────

/**
 * What the sender has sent, and its state.
 *
 * Before this there was no way to find out. `GET /company/members` lists people
 * who have already joined, and an invitation that has not been accepted appears
 * nowhere on either surface — so an owner chasing a crew member who has not
 * turned up could not tell whether the invitation had lapsed, had never been
 * created, or was sitting unread. Expired rows are included and labelled for
 * exactly that reason; they are the case worth seeing.
 *
 * Gated at manager, matching GET /company/members rather than the owner gate on
 * the invite route: seeing who has been asked to join is the same class of
 * information as seeing who is in the company, and a manager who cannot see a
 * pending invitation will issue a duplicate.
 */
companyRouter.get("/company/invites", requireAtLeast("manager"), async (req, res) => {
  try {
    const actor = getActor(req as unknown as AuthenticatedRequest);
    const invites = await listCompanyInvites(actor);
    return res.json({ invites });
  } catch (err) {
    console.error("[company] list invites failed", err);
    return res.status(500).json({ error: "Failed to retrieve invitations." });
  }
});

// ── Change role ───────────────────────────────────────────────────────────────

const RolePatchSchema = z.object({
  companyRole: z.enum(["manager", "viewer", "crew"]),
});

companyRouter.patch("/company/members/:email/role", requireCompanyRole("owner"), async (req, res) => {
  try {
    const actor = getActor(req as unknown as AuthenticatedRequest);
    // AUDIT L36/L46, the read side. `req.params.email` is whatever is in the
    // URL; stored addresses are lowercased (registration folds them, and
    // migration 031 folded the rows that predated it). Comparing the two with
    // `===` refuses the right member for a casing difference alone.
    //
    // Today that fails CLOSED -- the `find` below misses and the 404 fires --
    // so this is a usability bug rather than an authorisation hole. It is fixed
    // here anyway because normalising only the write side is exactly the split
    // that produced L36, and because `setUserCompanyRole` further down takes
    // this same value and does its own `WHERE email = $1`.
    const targetEmail = normalizeEmail(req.params.email);
    const parsed = RolePatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid role.", details: parsed.error.flatten() });
    }
    // Last-owner protection: if the target is currently an owner, check count first.
    const members = await listCompanyMembers(actor.companyId);
    const target = members.find((m) => sameEmail(m.email, targetEmail));
    if (!target || target.companyId !== actor.companyId) {
      return res.status(404).json({ error: "Member not found." });
    }
    if (target.companyRole === "owner") {
      const ownerCount = await countCompanyOwners(actor.companyId);
      if (ownerCount <= 1) {
        return res.status(409).json({ error: "Cannot demote the last owner of a company." });
      }
    }
    const updated = await setUserCompanyRole(targetEmail, parsed.data.companyRole);
    if (!updated) return res.status(404).json({ error: "Member not found." });
    return res.json({ member: { email: updated.email, name: updated.fullName, companyRole: updated.companyRole } });
  } catch (err) {
    console.error("[company] change role failed", err);
    return res.status(500).json({ error: "Failed to change role." });
  }
});

// ── Remove member ─────────────────────────────────────────────────────────────

companyRouter.delete("/company/members/:email", requireCompanyRole("owner"), async (req, res) => {
  try {
    const actor = getActor(req as unknown as AuthenticatedRequest);
    // Normalised for the same reason as the role route above -- and here the
    // order matters. Making the member lookup case-insensitive WITHOUT folding
    // this comparison in the same change would open a bypass of the guard
    // immediately below: an owner stored as `owner@x`, passing `Owner@x`, would
    // fail the self-check, then be FOUND by the case-insensitive lookup, and in
    // a company with two or more owners pass `ownerCount <= 1` as well and
    // remove themselves -- exactly what the 400 forbids. (A sole owner is still
    // stopped by the owner-count check, so the hole that would have been opened
    // is self-removal, not last-owner removal.) Both halves move together.
    const targetEmail = normalizeEmail(req.params.email);
    if (sameEmail(targetEmail, actor.email)) {
      return res.status(400).json({ error: "You cannot remove yourself. Transfer ownership first." });
    }
    const members = await listCompanyMembers(actor.companyId);
    const target = members.find((m) => sameEmail(m.email, targetEmail));
    if (!target || target.companyId !== actor.companyId) {
      return res.status(404).json({ error: "Member not found." });
    }
    if (target.companyRole === "owner") {
      const ownerCount = await countCompanyOwners(actor.companyId);
      if (ownerCount <= 1) {
        return res.status(409).json({ error: "Cannot remove the last owner of a company." });
      }
    }
    // Soft-remove: detach from company but retain data (compliance).
    await setUserCompany(targetEmail, null, "crew");
    return res.json({ ok: true });
  } catch (err) {
    console.error("[company] remove member failed", err);
    return res.status(500).json({ error: "Failed to remove member." });
  }
});
