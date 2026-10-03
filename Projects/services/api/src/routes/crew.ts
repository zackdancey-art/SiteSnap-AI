import { Router } from "express";
import { z } from "zod";
import { requireAuth, AuthenticatedRequest } from "../middleware/auth";
import { listTimecards, createTimecard, deleteTimecard } from "../storage/crewStore";

export const crewRouter: Router = Router();

function getActor(req: unknown) {
  const r = req as AuthenticatedRequest;
  return { email: r.auth.email, role: r.auth.role, companyId: r.auth.companyId, companyRole: r.auth.companyRole };
}

// A start/finish time on a 24-hour clock. Deliberately tolerant of a
// single-digit hour ("7:05") because stored rows are not reliably zero-padded,
// and strict about everything else — the range check in parseClockMinutes is
// what rejects "25:00" and "07:99", which this pattern alone would accept.
const CLOCK_TIME_PATTERN = /^\d{1,2}:\d{2}$/;

/** Minutes since midnight, or null if the value is not a usable clock time. */
function parseClockMinutes(value: string): number | null {
  if (!CLOCK_TIME_PATTERN.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

const TimecardSchema = z
  .object({
    siteId: z.string().min(1),
    entryId: z.string().nullable().optional(),
    workerName: z.string().min(1),
    date: z.string().min(1),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    breakMinutes: z.number().min(0).max(480).default(0),
    hoursRegular: z.number().min(0).max(24),
    hoursOvertime: z.number().min(0).max(24).default(0),
    trade: z.string().default(""),
    notes: z.string().default(""),
  })
  // Nothing anywhere validated the span, which is how a finish time BEFORE the
  // start time became a payroll row reading 0.0h. The mobile client's calcHours
  // clamps a negative span with `Math.max(0, ...)`, so the nonsense arrives here
  // already laundered into a plausible number — and `hoursRegular` allows 0.
  // This is the authoritative half of the fix; the client mirrors it.
  //
  // Overnight shifts are NOT supported today: calcHours is plain subtraction
  // with no day rollover, so an overnight shift already records 0.0h. Rejecting
  // a non-positive span therefore breaks nothing that currently works.
  .superRefine((card, ctx) => {
    const start = card.startTime?.trim() ?? "";
    const finish = card.endTime?.trim() ?? "";

    // Both absent stays legal: a timecard may record hours without a clocked
    // span, and that path predates this validation.
    if (!start && !finish) return;

    if (!start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startTime"],
        message: "Add a start time, or clear the finish time.",
      });
      return;
    }
    if (!finish) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: "Add a finish time, or clear the start time.",
      });
      return;
    }

    const startMinutes = parseClockMinutes(start);
    const finishMinutes = parseClockMinutes(finish);
    if (startMinutes === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["startTime"],
        message: "Start time must be a time of day in HH:MM form, e.g. 07:00.",
      });
    }
    if (finishMinutes === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: "Finish time must be a time of day in HH:MM form, e.g. 15:30.",
      });
    }
    if (startMinutes === null || finishMinutes === null) return;

    if (finishMinutes <= startMinutes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: `Finish time ${finish} is not after the start time ${start}. Overnight shifts are not supported.`,
      });
      return;
    }

    const netMinutes = finishMinutes - startMinutes - card.breakMinutes;
    if (netMinutes <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["breakMinutes"],
        message:
          `A ${card.breakMinutes} minute break leaves no worked time between ` +
          `${start} and ${finish}.`,
      });
    }
  });

crewRouter.get("/crew/timecards", requireAuth, async (req, res) => {
  try {
    const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
    const timecards = await listTimecards(getActor(req), siteId);
    return res.json({ timecards });
  } catch (err) {
    console.error("[crew] list timecards failed", err);
    return res.status(500).json({ error: "Failed to list timecards." });
  }
});

crewRouter.post("/crew/timecards", requireAuth, async (req, res) => {
  try {
    const parsed = TimecardSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      // Name the offending field in `error` as well as in `details`: the person
      // entering a timecard needs to know which field to change, and the mobile
      // client surfaces `error`.
      const flattened = parsed.error.flatten();
      const firstField = Object.entries(flattened.fieldErrors).find(
        ([, messages]) => messages && messages.length > 0
      );
      const detail = firstField ? ` ${firstField[0]}: ${firstField[1]![0]}` : "";
      return res.status(400).json({ error: `Invalid timecard payload.${detail}`, details: flattened });
    }
    const timecard = await createTimecard(getActor(req), {
      ...parsed.data,
      entryId: parsed.data.entryId ?? null,
    });
    return res.status(201).json({ timecard });
  } catch (err) {
    console.error("[crew] create timecard failed", err);
    return res.status(500).json({ error: "Failed to create timecard." });
  }
});

crewRouter.delete("/crew/timecards/:id", requireAuth, async (req, res) => {
  try {
    const removed = await deleteTimecard(getActor(req), req.params.id);
    if (!removed) return res.status(404).json({ error: "Timecard not found." });
    return res.json({ ok: true });
  } catch (err) {
    console.error("[crew] delete timecard failed", err);
    return res.status(500).json({ error: "Failed to delete timecard." });
  }
});
