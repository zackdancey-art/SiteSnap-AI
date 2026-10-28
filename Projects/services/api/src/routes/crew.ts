import { Router } from "express";
import { asyncSafeRouter } from "../middleware/asyncRouter";
import { z } from "zod";
import { FIELD_ACCESS, AuthenticatedRequest, requireAtLeast } from "../middleware/auth";
import { requireOwnRecord } from "../middleware/recordOwnership";
import {
  listTimecards,
  createTimecard,
  updateTimecard,
  deleteTimecard,
  setTimecardApproval,
  TIMECARD_APPROVAL_STATUSES,
  TimecardWriteResult,
} from "../storage/crewStore";

export const crewRouter: Router = asyncSafeRouter();
// Explicit requirement for this router's own paths — AUDIT L66. Scoped to the
// prefix rather than pathless, because a pathless `use` here would also run for
// every router mounted after this one in routes/index.ts; that is exactly how
// projects.ts came to refuse 31 routes it had never heard of. Operational work,
// so the requirement is identity, not rank: see FIELD_ACCESS.
crewRouter.use("/crew", ...FIELD_ACCESS);

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

/**
 * The hours themselves — the fields a timecard's author may set, and the only
 * fields an edit may touch.
 *
 * Shared between POST and PATCH rather than written twice. Written twice is how
 * an update route comes to accept a 25-hour day that creation rejects, and the
 * span validation below is the half most worth not duplicating.
 *
 * NOTHING ABOUT APPROVAL IS IN HERE. `approvalStatus`, `approvedBy`,
 * `approvedAt` and `approvalNote` are writable only through the approval route,
 * and both schemas built from this are `.strict()`, so sending one of those
 * names to the ordinary create or edit route is a 400 rather than a key that is
 * quietly dropped. Quietly dropped is worse: the caller is told it worked.
 */
const TIMECARD_FIELDS = {
  workerName: z.string().min(1),
  date: z.string().min(1),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  breakMinutes: z.number().min(0).max(480).default(0),
  hoursRegular: z.number().min(0).max(24),
  hoursOvertime: z.number().min(0).max(24).default(0),
  trade: z.string().default(""),
  notes: z.string().default(""),
};

/** The span rule, as a function so both schemas enforce the same one. */
function refineTimecardSpan(
  card: { startTime?: string; endTime?: string; breakMinutes: number },
  ctx: z.RefinementCtx
): void {
  // Nothing anywhere validated the span, which is how a finish time BEFORE the
  // start time became a payroll row reading 0.0h. The mobile client's calcHours
  // clamps a negative span with `Math.max(0, ...)`, so the nonsense arrives here
  // already laundered into a plausible number — and `hoursRegular` allows 0.
  // This is the authoritative half of the fix; the client mirrors it.
  //
  // Overnight shifts are NOT supported today: calcHours is plain subtraction
  // with no day rollover, so an overnight shift already records 0.0h. Rejecting
  // a non-positive span therefore breaks nothing that currently works.
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
}

/**
 * Creation: the site, the optional entry it hangs off, and the hours.
 *
 * `.strict()` on both this and the edit schema is the field-level approval
 * gate's loud half. The quiet half is in the store: `createTimecard` omits the
 * approval fields from its payload type and pins the status to "pending", and
 * `updateTimecard` writes a closed list of columns that contains no approval
 * column. Either layer alone would hold; the route's job is to say no out loud
 * instead of accepting a request it has silently emptied.
 */
const TimecardSchema = z
  .object({
    siteId: z.string().min(1),
    entryId: z.string().nullable().optional(),
    ...TIMECARD_FIELDS,
  })
  .strict()
  .superRefine(refineTimecardSpan);

/**
 * The three fields that describe a worked span. They move together — see the
 * trio rule on TimecardUpdateSchema.
 */
const TIMECARD_SPAN_KEYS = ["startTime", "endTime", "breakMinutes"] as const;

/**
 * An edit: the hours, and nothing else.
 *
 * `siteId` and `entryId` are absent deliberately. Moving a timecard to another
 * site is not a correction to the hours, it is a different record, and an edit
 * route that quietly accepts a new `siteId` would let an approved week be
 * reassembled under a site the approving manager never looked at. Nothing in
 * either client asks for it.
 *
 * `.partial()` AND WHY IT HAD TO BE
 * Without it every field was required or defaulted, so a client correcting one
 * finish time sent `trade: ""` and `notes: ""` by omission — `.default("")` in
 * TIMECARD_FIELDS fills an absent key — and the store wrote all nine columns.
 * One corrected field erased three others, which on a seven-year compliance
 * record is data loss performed by the save button. `.partial()` beats
 * `.default()` in zod (the optional wrapper short-circuits on undefined before
 * the default is reached), so an omitted key now arrives absent rather than
 * blank, and storage/crewStore.ts writes only the columns it was given.
 *
 * `.strict()` is unchanged and still the field gate's loud half: a payload
 * naming `approvalStatus`, `approvedBy`, `approvedAt`, `approvalNote` or
 * `siteId` is a 400, not a key that is quietly dropped.
 *
 * THE TRIO RULE
 * A partial edit creates a question the whole-object version never had: what
 * validates a finish time sent on its own, against a start time that is only in
 * the database? Nothing here can — refineTimecardSpan needs all three values —
 * and guessing is how a 23:00-to-06:00 pair gets stored as a positive span. So
 * start, finish and break move as a set: supply all three or none. A card that
 * records hours without a clocked span keeps doing so, because none is legal;
 * and there is deliberately no way to CLEAR a span through an edit, since the
 * schema has no null for those fields. Flagged as a limitation rather than
 * hidden: no client offers it, and adding it means adding the null, not
 * loosening this rule.
 */
const TimecardUpdateSchema = z
  .object({ ...TIMECARD_FIELDS })
  .partial()
  .strict()
  .superRefine((value, ctx) => {
    const supplied = (Object.keys(value) as Array<keyof typeof value>).filter(
      (key) => value[key] !== undefined
    );
    if (supplied.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [],
        message: "An edit must name at least one field to change.",
      });
      return;
    }

    const span = TIMECARD_SPAN_KEYS.filter((key) => value[key] !== undefined);
    if (span.length > 0 && span.length < TIMECARD_SPAN_KEYS.length) {
      const missing = TIMECARD_SPAN_KEYS.filter((key) => value[key] === undefined);
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [missing[0]],
        message:
          `Start time, finish time and break minutes have to be sent together. ` +
          `Missing: ${missing.join(", ")}.`,
      });
      return;
    }
    if (span.length === TIMECARD_SPAN_KEYS.length) {
      refineTimecardSpan(
        { startTime: value.startTime, endTime: value.endTime, breakMinutes: value.breakMinutes! },
        ctx
      );
    }
  });

/**
 * The approval payload. `status` is the whole decision; the note is optional
 * and only meaningful on a rejection, which the client enforces and this does
 * not — a manager attaching a note to an approval is reasonable and storing it
 * costs nothing.
 *
 * The enum is built from the store's exported list, so a status added there
 * without being added to migration 033's CHECK constraint is caught by the
 * DB-gated suite rather than by a 500.
 */
const TimecardApprovalSchema = z
  .object({
    status: z.enum(TIMECARD_APPROVAL_STATUSES),
    note: z.string().max(2000).optional(),
  })
  .strict();

/**
 * The one place a zod failure becomes a 400, so that both write routes name the
 * offending field the same way. The person entering a timecard needs to know
 * which field to change, and the mobile client surfaces `error`.
 */
function invalidPayload<T>(
  res: import("express").Response,
  parsed: z.SafeParseError<T>,
  what: string
) {
  const flattened = parsed.error.flatten();
  // Generic over the schema's input type rather than `unknown`: `flatten()` on
  // a ZodError<unknown> types `fieldErrors` as `{}`, so the field name and its
  // message are both unreachable and the 400 would carry no detail at all.
  const fieldErrors: Record<string, string[] | undefined> = flattened.fieldErrors;
  const firstField = Object.entries(fieldErrors).find(
    ([, messages]) => messages && messages.length > 0
  );
  // An issue raised with an empty `path` — the edit schema's "name at least one
  // field" refusal is one — lands in formErrors, not fieldErrors. Without this
  // fallback that 400 carried the generic sentence and no reason at all.
  const detail = firstField
    ? ` ${firstField[0]}: ${firstField[1]![0]}`
    : flattened.formErrors.length > 0
      ? ` ${flattened.formErrors[0]}`
      : "";
  return res.status(400).json({ error: `Invalid ${what} payload.${detail}`, details: flattened });
}

/**
 * The three-way store result, as three HTTP answers.
 *
 * `locked` is 409 and not 403: 403 would say the caller lacks the rank, and no
 * rank opens an approved timecard — the row's state is what refuses, and the
 * fix is to reopen it rather than to find somebody more senior. The `code` is
 * there so a client can branch without matching on the sentence.
 */
function sendWriteResult(res: import("express").Response, result: TimecardWriteResult, ok: () => void) {
  if (result.ok) return ok();
  if (result.reason === "locked") {
    return res.status(409).json({
      error:
        result.status === "approved"
          ? "This timecard has been approved and can no longer be changed. Ask a manager to reopen it."
          : `This timecard is ${result.status} and can no longer be changed.`,
      code: "timecard_approved",
      approvalStatus: result.status,
    });
  }
  return res.status(404).json({ error: "Timecard not found." });
}

crewRouter.get("/crew/timecards", async (req, res) => {
  try {
    const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
    const timecards = await listTimecards(getActor(req), siteId);
    return res.json({ timecards });
  } catch (err) {
    console.error("[crew] list timecards failed", err);
    return res.status(500).json({ error: "Failed to list timecards." });
  }
});

crewRouter.post("/crew/timecards", async (req, res) => {
  try {
    const parsed = TimecardSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalidPayload(res, parsed, "timecard");
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

/**
 * Correct a timecard's hours.
 *
 * `requireOwnRecord("timesheet")` is the 403 for a crew member reaching for
 * somebody else's row; the store narrows the same way again so that removing
 * the middleware degrades the refusal to 404 rather than opening the row
 * (CLAUDE.md §3's both-layers rule). The 409 for an approved row comes from
 * the store, because the state is the thing that refuses and only the store
 * can read it under a row lock.
 */
crewRouter.patch("/crew/timecards/:id", requireOwnRecord("timesheet"), async (req, res) => {
  try {
    const parsed = TimecardUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalidPayload(res, parsed, "timecard");
    const result = await updateTimecard(getActor(req), req.params.id, parsed.data);
    return sendWriteResult(res, result, () =>
      res.json({ timecard: (result as { ok: true; timecard: unknown }).timecard })
    );
  } catch (err) {
    console.error("[crew] update timecard failed", err);
    return res.status(500).json({ error: "Failed to update timecard." });
  }
});

/**
 * Approve a timecard, send it back, or reopen one.
 *
 * `requireAtLeast("manager")` and NOT `requireOwnRecord`: this is the one write
 * on a timesheet that is deliberately somebody else's. A crew member approving
 * their own hours is the defect this route exists to prevent, and it is the
 * only reason the rank gate is here rather than an ownership gate.
 *
 * A manager approving their own timecard IS allowed. They are the approver for
 * the company, and refusing it would leave a working manager unable to record
 * hours at all. Who approved what is recorded in `approved_by`, which is what
 * makes self-approval auditable rather than invisible — and `approved_by` is
 * taken from the session, never from the body.
 */
crewRouter.post("/crew/timecards/:id/approval", requireAtLeast("manager"), async (req, res) => {
  try {
    const parsed = TimecardApprovalSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalidPayload(res, parsed, "approval");
    const result = await setTimecardApproval(
      getActor(req),
      req.params.id,
      parsed.data.status,
      parsed.data.note
    );
    // No `locked` case reaches here: reopening an approved card is the whole
    // point of this route, so an approved row is not locked against it.
    return sendWriteResult(res, result, () =>
      res.json({ timecard: (result as { ok: true; timecard: unknown }).timecard })
    );
  } catch (err) {
    console.error("[crew] set timecard approval failed", err);
    return res.status(500).json({ error: "Failed to update timecard approval." });
  }
});

crewRouter.delete("/crew/timecards/:id", requireOwnRecord("timesheet"), async (req, res) => {
  try {
    const result = await deleteTimecard(getActor(req), req.params.id);
    return sendWriteResult(res, result, () => res.json({ ok: true }));
  } catch (err) {
    console.error("[crew] delete timecard failed", err);
    return res.status(500).json({ error: "Failed to delete timecard." });
  }
});
