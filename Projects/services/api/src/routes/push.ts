import { Router } from "express";
import { asyncSafeRouter } from "../middleware/asyncRouter";
import { z } from "zod";
import { FIELD_ACCESS, AuthenticatedRequest } from "../middleware/auth";
import { rateLimit } from "../middleware/rateLimit";
import { upsertPushToken, deletePushToken, getTokensForUser } from "../storage/pushStore";

export const pushRouter: Router = asyncSafeRouter();
// Explicit requirement for this router's own paths — AUDIT L66. Scoped to the
// prefix rather than pathless, because a pathless `use` here would also run for
// every router mounted after this one in routes/index.ts; that is exactly how
// projects.ts came to refuse 31 routes it had never heard of. Operational work,
// so the requirement is identity, not rank: see FIELD_ACCESS.
pushRouter.use("/push", ...FIELD_ACCESS);

function getActor(req: unknown) {
  const r = req as AuthenticatedRequest;
  return { email: r.auth.email, role: r.auth.role, companyId: r.auth.companyId, companyRole: r.auth.companyRole };
}

const RegisterSchema = z.object({
  token: z.string().min(1),
  platform: z.enum(["expo", "apns", "fcm"]).default("expo"),
});

pushRouter.post(
  "/push/tokens",
  rateLimit("push-register", 10, 60 * 60 * 1000),
  async (req, res) => {
    const parsed = RegisterSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid payload.", details: parsed.error.flatten() });
    }
    const record = await upsertPushToken(getActor(req), parsed.data.token, parsed.data.platform);
    return res.status(201).json({ token: record });
  }
);

pushRouter.delete("/push/tokens/:token", async (req, res) => {
  const removed = await deletePushToken(getActor(req), decodeURIComponent(req.params.token));
  if (!removed) return res.status(404).json({ error: "Token not found." });
  return res.json({ ok: true });
});

pushRouter.get("/push/tokens", async (req, res) => {
  const tokens = await getTokensForUser(getActor(req));
  return res.json({ tokens });
});
