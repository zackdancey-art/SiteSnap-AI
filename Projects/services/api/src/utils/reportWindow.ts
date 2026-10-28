/**
 * The reporting window a diary covers, as an explicit pair of dates.
 *
 * AUDIT L92. `routes/ai.ts` used to decide what "weekly" or "monthly" meant by
 * looking at the entries it had just loaded: it sorted them, took the latest
 * one as the anchor, and counted backwards from there. Three things follow from
 * that, and all three were observed:
 *
 *   - The window moves with the data. A site whose last entry was the 3rd
 *     returns "the month containing the 3rd"; the same request a day later,
 *     after someone files an entry, returns a different month. Two "monthly"
 *     reports on the same site are not comparable, and nothing in either says
 *     which days it covered.
 *   - The window differs per caller. The anchor is the latest entry THE CALLER
 *     CAN SEE, and visibility is per-role (`storage/recordScope.ts`). A crew
 *     member and an owner asking for the same period on the same site get
 *     different reports, with no indication that they differ.
 *   - There was no way to ask for a specific period at all. "Last month" could
 *     not be requested, because the only thing the request carried was the word
 *     "monthly".
 *
 * So a window is a value now, `{ from, to }` inclusive, both `YYYY-MM-DD`, and
 * it travels with the request and comes back on the response. `mode` records
 * where it came from, which matters because the legacy behaviour is retained
 * EXACTLY as it was for callers that send no range — see `anchoredWindow`.
 *
 * Dates are ISO date-only strings and are compared as strings. `YYYY-MM-DD`
 * sorts lexicographically in calendar order, which is also how Postgres will
 * compare the `date` column on `project_entries` (declared TEXT, migration 001).
 * Comparing them as strings rather than as `Date` objects is deliberate: the
 * old code built `new Date(`${value}T00:00:00`)`, which parses in the SERVER's
 * local zone, so a report's boundaries depended on the timezone of whichever
 * Render instance answered. A date a crew member typed on a phone in Perth is
 * not a moment in time and should not be turned into one.
 */

export type ReportPeriod = "daily" | "weekly" | "monthly";

/** Where a window's dates came from. */
export type ReportWindowMode =
  /** The caller asked for these exact dates. */
  | "explicit"
  /** No range was sent; derived from the latest visible entry (legacy). */
  | "anchored";

export type ReportWindow = {
  from: string;
  to: string;
  period: ReportPeriod;
  mode: ReportWindowMode;
  /**
   * The entry date the window was counted back from. Present only for
   * `anchored` windows, and the thing that makes L92's old behaviour legible
   * when it is still in play: a client that sends no range can at least show
   * the reader which entry decided the boundaries.
   */
  anchoredOn?: string;
};

/**
 * The longest window a single report may cover.
 *
 * Not a performance limit — a bound on what one generated document can
 * honestly be. Every entry in the window is sent to the model, and a year of a
 * busy site is both unreadable as a diary and far past the context the request
 * can carry. A caller wanting a year asks for four quarters and gets four
 * documents, each of which says what it covers.
 *
 * 92 days is one calendar quarter at its longest (Jul+Aug+Sep = 92), so a
 * quarter boundary is never a day over.
 */
export const MAX_REPORT_WINDOW_DAYS = 92;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const MS_PER_DAY = 86_400_000;

/**
 * True for a `YYYY-MM-DD` string naming a real calendar day.
 *
 * The regex alone accepts `2026-02-31` and `2026-13-01`. Round-tripping
 * through UTC rejects both, and UTC rather than local time because these
 * strings are calendar days, not instants (see the module comment).
 */
export function isReportDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_ONLY.exec(value);
  if (!m) return false;
  const [, y, mo, d] = m;
  const asUtc = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(asUtc.getTime())) return false;
  return (
    asUtc.getUTCFullYear() === Number(y) &&
    asUtc.getUTCMonth() + 1 === Number(mo) &&
    asUtc.getUTCDate() === Number(d)
  );
}

/** Days from `from` to `to` inclusive. 1 for a single day. */
export function windowLengthInDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  return Math.round((b - a) / MS_PER_DAY) + 1;
}

/** `date` shifted by `days`, as a date-only string. UTC arithmetic throughout. */
export function shiftDate(date: string, days: number): string {
  const shifted = new Date(Date.parse(`${date}T00:00:00.000Z`) + days * MS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

/** The first day of `date`'s month. */
export function firstOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export type WindowResult =
  | { ok: true; window: ReportWindow }
  | { ok: false; message: string };

/**
 * The window a caller asked for by name.
 *
 * Both dates are required together. A half-range is refused rather than
 * completed from the period, because the two readings of `{ from }` alone —
 * "the week starting then" and "the week ending then" — are a week apart and
 * the caller knows which they meant.
 */
export function explicitWindow(period: ReportPeriod, from: unknown, to: unknown): WindowResult {
  if (!isReportDate(from) || !isReportDate(to)) {
    return { ok: false, message: "A report range needs `from` and `to` as YYYY-MM-DD dates." };
  }
  if (from > to) {
    return { ok: false, message: "A report range must start on or before it ends." };
  }
  const days = windowLengthInDays(from, to);
  if (days > MAX_REPORT_WINDOW_DAYS) {
    return {
      ok: false,
      message:
        `A report may cover at most ${MAX_REPORT_WINDOW_DAYS} days; this range covers ${days}. ` +
        "Generate the period in parts, so each report states the dates it covers.",
    };
  }
  return { ok: true, window: { from, to, period, mode: "explicit" } };
}

/**
 * The window the old code computed, written out as dates.
 *
 * THIS IS L92's BEHAVIOUR, KEPT ON PURPOSE. It is what a client that sends no
 * range still gets, and it must stay bug-for-bug identical to the arithmetic in
 * `routes/ai.ts` before this module existed, because the API deploys ahead of
 * the mobile and portal builds (see the PR body): for the whole gap between
 * those deploys, every caller is a no-range caller. Changing the default to
 * "the window ending today" would, in that gap, turn every monthly report on a
 * site whose last entry was last month into `400 No entries are available` —
 * the fix presenting as an outage.
 *
 * What does change is that the dates are now returned, so the report header and
 * the response say which days were covered, and `mode: "anchored"` marks them
 * as derived rather than asked for.
 *
 *   daily    the anchor day alone
 *   weekly   the anchor and the six days before it
 *   monthly  the first of the anchor's month to the anchor
 *
 * The monthly case is the old `getFullYear() === … && getMonth() === …` test
 * expressed as a range. They agree for every input: the anchor is the LATEST
 * date present, so no entry in that month can fall after it, and the open end
 * the old predicate allowed could never match anything.
 */
export function anchoredWindow(period: ReportPeriod, anchorDate: string): ReportWindow {
  const to = anchorDate;
  const from =
    period === "daily" ? to : period === "weekly" ? shiftDate(to, -6) : firstOfMonth(to);
  return { from, to, period, mode: "anchored", anchoredOn: anchorDate };
}

/**
 * The latest usable entry date in a list, or null if none is usable.
 *
 * Entries with a missing or malformed date are ignored here rather than
 * defaulted to today, which is what the old code did (`entry.date || new
 * Date()…`): defaulting pulled the anchor forward to today on a single bad row
 * and silently redefined the window for every other entry in the report.
 */
export function latestEntryDate(entries: Array<{ date?: unknown }>): string | null {
  let latest: string | null = null;
  for (const entry of entries) {
    const date = entry.date;
    if (!isReportDate(date)) continue;
    if (latest === null || date > latest) latest = date;
  }
  return latest;
}

/**
 * The entries inside a window.
 *
 * An entry whose date is missing or malformed is EXCLUDED. The old filter
 * substituted the anchor date for an absent one, so a dateless entry was always
 * in the window and appeared in every report of every period — see
 * `latestEntryDate`. Excluded rows are counted by the caller rather than
 * dropped quietly (AUDIT L95's rule applied to entries rather than photographs).
 */
export function filterEntriesByWindow<T extends { date?: unknown }>(
  entries: T[],
  window: Pick<ReportWindow, "from" | "to">
): { entries: T[]; undatedCount: number } {
  let undatedCount = 0;
  const kept: T[] = [];
  for (const entry of entries) {
    if (!isReportDate(entry.date)) {
      undatedCount += 1;
      continue;
    }
    if (entry.date >= window.from && entry.date <= window.to) kept.push(entry);
  }
  kept.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { entries: kept, undatedCount };
}

/** `12 August 2026`, or the raw string if it is not a date. */
export function formatWindowDate(date: string): string {
  if (!isReportDate(date)) return date;
  return new Date(`${date}T00:00:00.000Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The window as it appears in a report header. */
export function describeWindow(window: Pick<ReportWindow, "from" | "to">): string {
  return window.from === window.to
    ? formatWindowDate(window.from)
    : `${formatWindowDate(window.from)} – ${formatWindowDate(window.to)}`;
}
