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
import { createCompanyInvite } from "../storage/projectsStore";
import { normalizeEmail } from "../utils/emailAddresses";

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
    const results = inviteResults.map((r, i) => ({
      email: parsed.data.emails[i],
      ...(typeof r === "string" ? { status: "error" } : { status: "sent", token: r.token }),
    }));
    return res.status(201).json({ results });
  } catch (err) {
    console.error("[company] invite failed", err);
    return res.status(500).json({ error: "Failed to send invitations." });
  }
});

// ── Change role ───────────────────────────────────────────────────────────────

const RolePatchSchema = z.object({
  companyRole: z.enum(["manager", "viewer", "crew"]),
});

companyRouter.patch("/company/members/:email/role", requireCompanyRole("owner"), async (req, res) => {
  try {
    const actor = getActor(req as unknown as AuthenticatedRequest);
    const targetEmail = req.params.email;
    const parsed = RolePatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid role.", details: parsed.error.flatten() });
    }
    // Last-owner protection: if the target is currently an owner, check count first.
    const members = await listCompanyMembers(actor.companyId);
    const target = members.find((m) => m.email === targetEmail);
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
    const targetEmail = req.params.email;
    if (targetEmail === actor.email) {
      return res.status(400).json({ error: "You cannot remove yourself. Transfer ownership first." });
    }
    const members = await listCompanyMembers(actor.companyId);
    const target = members.find((m) => m.email === targetEmail);
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
