/**
 * What the report is told about ONE entry: its author, its safety record, and
 * the whole of its notes.
 *
 * This module exists because of AUDIT L96 and L97, which are the same defect
 * twice: fields the capture form collects, the API persists and `mapEntry`
 * reads back were simply absent from the object `routes/ai.ts` built for the
 * report. Nothing failed. The document just did not contain them.
 *
 *   L96  every entry carries `ownerEmail`, and the payload listed seven fields
 *        of which that was not one. Before crew visibility was corrected a
 *        crew member's report contained only their own entries, so attribution
 *        was true by construction; it now routinely contains several people's
 *        work and says whose nowhere. The document a dispute would be settled
 *        with cannot answer who wrote which line.
 *   L97  `swmsRef`, `hazardNotes`, `toolboxTalk`, `notesMode` and `hourlyNotes`
 *        were all dropped. The first three are the safety record — the fields a
 *        regulator asks about. The last two are worse than a missing
 *        enrichment: for an entry captured hour by hour, `notes` is the
 *        free-text field, which is usually EMPTY, so the entry's own content
 *        never reached the model at all. An hourly entry could be generated
 *        from blank.
 *
 * It is a pure module with no imports on purpose. Every decision below is one
 * a report's reader can be wrong about, so each is testable without a store, a
 * socket or a model, and `reportPayload.test.ts` tests them that way. The
 * halves that DO touch the store — which company's members are consulted, and
 * whether the five fields survive a round trip through Postgres — are in
 * `storage/report-payload-db.test.ts`, because an in-memory store cannot
 * answer either question.
 */

/** One hour of an hourly-captured entry. `hour` is 0–23 local site time. */
export type HourlyNote = { hour: number; note: string };

/** How the entry was captured. Absent on every entry older than migration 024. */
export type NotesMode = "free" | "hourly";

/**
 * The hour label. `HH:00`, matching `formatHour` in the capture form
 * (`apps/mobile/app/new-entry.tsx`) so the report reads the way the screen
 * that recorded it read.
 *
 * An hour outside 0–23 is labelled rather than dropped. A note with a nonsense
 * hour is still the site team's note, and L97 is the defect of dropping
 * content; losing it a second time to a validation rule would be the same
 * mistake in a more defensible coat.
 */
export function formatHourLabel(hour: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return "Unrecorded hour";
  return `${String(hour).padStart(2, "0")}:00`;
}

/**
 * The hourly log as text, oldest hour first.
 *
 * Blank hours are omitted. The capture form writes EVERY hour in the chosen
 * window, empty ones included — a 07:00–17:00 day is eleven rows of which
 * perhaps three carry a note — so rendering them all would bury the content in
 * its own scaffolding. `recordedHours` counts the ones that said something,
 * which is the number worth putting in a report.
 *
 * This is deliberately the same rule as `buildHourlyLogTableHtml` in
 * `apps/mobile/lib/export-utils.ts:40` — filter blank notes, label `HH:00` —
 * because the mobile PDF export has been printing the hourly log all along
 * while the generated report dropped it. The two documents describing one
 * day's work disagreed, and in a compliance product the fix is for them to
 * agree, not merely for both to be non-empty.
 */
export function renderHourlyNotes(hourlyNotes: readonly HourlyNote[] | undefined): {
  text: string;
  recordedHours: number;
} {
  const rows = (hourlyNotes ?? [])
    .filter((row) => typeof row?.note === "string" && row.note.trim().length > 0)
    .slice()
    .sort((a, b) => a.hour - b.hour);
  return {
    text: rows.map((row) => `${formatHourLabel(row.hour)} — ${row.note.trim()}`).join("\n"),
    recordedHours: rows.length,
  };
}

export type EntryNotesInput = {
  notes?: string;
  notesMode?: NotesMode;
  hourlyNotes?: readonly HourlyNote[];
};

/**
 * Everything the entry says, and which field it came from.
 *
 * BOTH fields are included when both carry content, whatever `notesMode` says.
 * `notesMode` records which way the form was being used, not which text is
 * real: an entry switched from free to hourly mid-shift has content in both,
 * and L97 is exactly what happens when the payload picks one. So the mode
 * decides the ORDER and the labelling, never what survives.
 *
 * `source` is returned rather than inferred by the caller so the report can say
 * where the text came from, and so a test can tell "the hourly log was rendered"
 * from "the hourly log was empty and the free text happened to read the same".
 */
export function effectiveEntryNotes(entry: EntryNotesInput): {
  text: string;
  source: "free" | "hourly" | "both" | "none";
  recordedHours: number;
} {
  const free = typeof entry.notes === "string" ? entry.notes.trim() : "";
  const hourly = renderHourlyNotes(entry.hourlyNotes);

  if (free && hourly.text) {
    const freeFirst = entry.notesMode !== "hourly";
    const blocks = freeFirst
      ? [free, `Hourly log:\n${hourly.text}`]
      : [`Hourly log:\n${hourly.text}`, free];
    return { text: blocks.join("\n\n"), source: "both", recordedHours: hourly.recordedHours };
  }
  if (hourly.text) {
    return {
      text: `Hourly log:\n${hourly.text}`,
      source: "hourly",
      recordedHours: hourly.recordedHours,
    };
  }
  if (free) return { text: free, source: "free", recordedHours: 0 };
  return { text: "", source: "none", recordedHours: 0 };
}

export type SafetyRecordInput = {
  swmsRef?: string;
  hazardNotes?: string;
  toolboxTalk?: boolean;
};

/**
 * The entry's safety record as report text, or null when nothing was recorded.
 *
 * `toolboxTalk` has THREE states and the report must not flatten them.
 * `undefined` means the question was never answered — on every entry predating
 * the field, and on any client that does not send it. `false` means a person
 * answered it and the talk was not held. In a compliance document "not
 * recorded" and "not held" are different facts, and the second is the one a
 * regulator asks about, so `undefined` omits the line entirely rather than
 * printing a reassuring default either way.
 *
 * Returning null for an empty record, rather than "N/A", lets the caller decide
 * whether to print a heading at all — the template's old `safetyObservations:
 * "N/A"` was a hardcoded literal sitting on top of three populated columns.
 */
export function renderSafetyRecord(entry: SafetyRecordInput): string | null {
  const lines: string[] = [];
  const swms = typeof entry.swmsRef === "string" ? entry.swmsRef.trim() : "";
  const hazards = typeof entry.hazardNotes === "string" ? entry.hazardNotes.trim() : "";
  if (swms) lines.push(`SWMS reference: ${swms}`);
  if (hazards) lines.push(`Hazards noted: ${hazards}`);
  if (entry.toolboxTalk === true) lines.push("Toolbox talk: Held");
  if (entry.toolboxTalk === false) lines.push("Toolbox talk: Not held");
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * What a STORED `toolbox_talk` is allowed to assert in the document.
 *
 * `renderSafetyRecord` above keeps three states apart, and that is right for an
 * entry that arrived in the request body. It is wrong for an entry read back
 * out of Postgres, for a reason that is a measured property of the schema
 * rather than a style preference:
 *
 *   migrations/006_add_aunz_compliance.sql
 *     ADD COLUMN IF NOT EXISTS toolbox_talk BOOLEAN NOT NULL DEFAULT false;
 *
 * NOT NULL DEFAULT false. The column cannot hold "never answered". Every row
 * written before 006, and every row written since by a client that does not
 * send the field, reads back as `false` — indistinguishable from a person
 * answering "no". And no shipping client sends it: a search of `Projects/apps`
 * for `toolboxTalk` returns nothing, in the mobile app and in the portal both,
 * so as of this change EVERY row in production reads back `false` by default.
 *
 * Forwarding that straight through would put "Toolbox talk: Not held" on every
 * day of every report — a specific negative safety claim, in the document a
 * regulator reads, manufactured out of a column default. So a stored `false`
 * is reported as nothing at all, and only a stored `true` speaks.
 *
 * THIS FUNCTION IS MEANT TO BE DELETED. The moment a client captures the field
 * the column stops defaulting the answer, a stored `false` starts meaning "no",
 * and suppressing it becomes the lie instead. That needs the capture control,
 * `DROP NOT NULL` on the column so the three states are representable, and a
 * decision about the rows already written — none of which belong in a change
 * about what the report contains. `storage/report-payload-db.test.ts` pins the
 * default against the live schema, so the day it changes, that test says so.
 */
export function toolboxTalkFromStoredRow(value: boolean | undefined): boolean | undefined {
  return value === true ? true : undefined;
}

/**
 * email -> display name, for the one company the report is being generated for.
 *
 * Lower-cased on both sides because `ownerEmail` on an entry row and `email` on
 * the member row are written by different code paths and only one of them
 * normalises case; an attribution that works for `sam@x` and fails for `Sam@X`
 * would be the kind of defect that looks like missing data.
 *
 * WHAT IS DELIBERATELY NOT HERE: the email itself, anywhere in the output. The
 * resolved value is a display name or nothing. An email address is personal
 * content, it is sent to OpenAI with every generation if it reaches the payload,
 * and L96's own note says a display name is the right field. An entry whose
 * author cannot be named is reported as unattributed and COUNTED — see
 * `resolveAuthorName` — rather than falling back to the address.
 *
 * AMBIGUITY IS NOT RESOLVED HERE, and that is a known limitation rather than an
 * oversight: two members of one company with the same full name produce one
 * name for two people, and this index cannot tell them apart. Making that
 * honest needs a per-user display handle, which is a product decision. Until
 * then `duplicateNames` names them, so a caller can say so instead of
 * presenting the collision as fact.
 */
export function buildAuthorNameIndex(
  members: ReadonlyArray<{ email?: string; fullName?: string }>
): { byEmail: Map<string, string>; duplicateNames: string[] } {
  const byEmail = new Map<string, string>();
  const nameCounts = new Map<string, number>();
  for (const member of members) {
    const email = typeof member?.email === "string" ? member.email.trim().toLowerCase() : "";
    const fullName = typeof member?.fullName === "string" ? member.fullName.trim() : "";
    if (!email || !fullName) continue;
    byEmail.set(email, fullName);
    nameCounts.set(fullName, (nameCounts.get(fullName) ?? 0) + 1);
  }
  const duplicateNames = Array.from(nameCounts.entries())
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
  return { byEmail, duplicateNames };
}

/**
 * The display name for one entry's author, or undefined.
 *
 * Undefined covers every reason the name is not available — the member was
 * removed from the company, the member row has no name on it, the entry
 * predates ownership being recorded — and the caller treats them the same way,
 * as one unattributed entry. The reasons differ but the remedy does not, and a
 * report that distinguished them would be claiming to know which applied.
 */
export function resolveAuthorName(
  index: { byEmail: Map<string, string> },
  ownerEmail: unknown
): string | undefined {
  const email = typeof ownerEmail === "string" ? ownerEmail.trim().toLowerCase() : "";
  if (!email) return undefined;
  return index.byEmail.get(email);
}
