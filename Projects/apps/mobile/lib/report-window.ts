/**
 * The report window on the capture client — AUDIT L92, the mobile half.
 *
 * The server owns the rule. `services/api/src/utils/reportWindow.ts` decides
 * what window a `POST /api/generate-diary` actually covers, validates it, and
 * returns it on the response as `reportWindow`. This module exists so the
 * screen can show the user which days they are about to ask for BEFORE the
 * request, and so `app/diary/[siteId].tsx` can filter its local entries by the
 * same window it is sending rather than by a second, differently-written copy
 * of the period arithmetic.
 *
 * THIS IS A DELIBERATE DUPLICATION AND IT IS THE WEAKEST POINT OF THIS CHANGE.
 * `@sitesnap/shared` is where a rule used by two deployables belongs, but it is
 * declaration-only — `build:types` emits `.d.ts` and no JavaScript — so it can
 * carry the TYPES of a window and not the arithmetic that computes one. Mobile
 * also does not depend on it today, and adding a dependency is not mine to
 * decide. So the rule is written twice, and the two copies are pinned to ONE
 * table of cases: `WINDOW_CASES` in `report-window.test.ts` is the same table
 * as `services/api/src/utils/reportWindow.test.ts`'s, by hand, with each file naming the other.
 * A divergence fails on whichever side was edited. That is weaker than sharing
 * the code and stronger than the status quo, where the two copies disagreed and
 * nothing said so.
 *
 * WHAT THE OLD CODE DID, AND WHY THE DEFAULT HERE KEEPS DOING IT.
 * `filterEntriesByPeriod` in the diary screen anchored every window on the
 * latest entry it could see locally, so "weekly" meant the seven days ending at
 * the last recorded entry and not the last seven days. Nothing displayed those
 * dates. `anchoredWindowFor` below is that behaviour, written out as two dates
 * the screen can print, and it is still what the screen opens on — anchoring on
 * TODAY instead would turn a monthly report on a site last worked a month ago
 * into "no entries are available", which is the fix presenting as an outage.
 * What changes is that the dates are now visible and the user can step off them.
 */

/** Matches the server's `ReportPeriod`. */
export type ReportPeriod = "daily" | "weekly" | "monthly";

/** Where a window's dates came from. Matches the server's `ReportWindowMode`. */
export type ReportWindowMode =
  /** Counted back from the latest locally visible entry — the legacy default. */
  | "anchored"
  /** The user stepped or chose it, so it is sent as an explicit range. */
  | "explicit";

export type ReportWindow = {
  from: string;
  to: string;
  period: ReportPeriod;
  mode: ReportWindowMode;
  /** The entry date an `anchored` window was counted back from. */
  anchoredOn?: string;
};

/**
 * Mirrors `MAX_REPORT_WINDOW_DAYS` in the API. Checked here so an over-long
 * window is refused on the device with the reason, instead of costing a round
 * trip to be told the same thing.
 */
export const MAX_REPORT_WINDOW_DAYS = 92;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

/**
 * True for a `YYYY-MM-DD` string naming a real calendar day.
 *
 * UTC, not local time, because these strings are calendar days rather than
 * instants — and because the server validates them in UTC. A device in Perth
 * and the API in Oregon must agree on whether `2026-02-29` exists.
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

/** The last day of `date`'s month. */
export function lastOfMonth(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  // Day 0 of the NEXT month is the last day of this one, which avoids a leap
  // year table.
  const end = new Date(Date.UTC(year, month, 0));
  return end.toISOString().slice(0, 10);
}

/** Today, as a date-only string in the device's own timezone. */
export function todayLocal(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * The latest usable entry date in a list, or null.
 *
 * A missing or malformed date is skipped rather than defaulted to today. The
 * old screen did `new Date(entry.date || Date.now())`, so one bad row pulled the
 * anchor forward to today and silently redefined the window for every other
 * entry in the report.
 */
export function latestEntryDate(entries: ReadonlyArray<{ date?: unknown }>): string | null {
  let latest: string | null = null;
  for (const entry of entries) {
    const date = entry?.date;
    if (!isReportDate(date)) continue;
    if (latest === null || date > latest) latest = date;
  }
  return latest;
}

/**
 * The window the screen opens on: the legacy anchored one.
 *
 * Bug-for-bug identical to `anchoredWindow` in the API, including the monthly
 * case being the first of the anchor's month to the anchor itself — a PARTIAL
 * month, not a whole one. That is what the old code computed and what the
 * server still falls back to for a client that sends no range, so the two paths
 * produce the same document.
 */
export function anchoredWindowFor(period: ReportPeriod, anchorDate: string): ReportWindow {
  const to = anchorDate;
  const from =
    period === "daily" ? to : period === "weekly" ? shiftDate(to, -6) : firstOfMonth(to);
  return { from, to, period, mode: "anchored", anchoredOn: anchorDate };
}

/**
 * The complete calendar period containing `date`.
 *
 * Used for every window the user steps to, and NOT for the one they start on.
 * The distinction is the point: the opening window has to match the server's
 * legacy default so that upgrading the app does not change what a report
 * contains, but once someone deliberately asks for "the previous month" they
 * mean all of it, not the first n days of it.
 *
 * `daily` is the day. `weekly` is the seven days ending on `date`, because a
 * site week is not anchored to a weekday the way a calendar month is anchored
 * to the 1st, and picking Monday here would be this module inventing a policy.
 * `monthly` is the 1st to the last day of the month.
 */
export function completeWindowFor(period: ReportPeriod, date: string): ReportWindow {
  if (period === "daily") return { from: date, to: date, period, mode: "explicit" };
  if (period === "weekly") {
    return { from: shiftDate(date, -6), to: date, period, mode: "explicit" };
  }
  return { from: firstOfMonth(date), to: lastOfMonth(date), period, mode: "explicit" };
}

/**
 * The window one period earlier.
 *
 * Stepping always lands on a COMPLETE period and, just as importantly, on an
 * `explicit` one — which is what makes the screen send the range rather than
 * let the server anchor.
 *
 * For `monthly` the dates alone would not have shown the difference: the step
 * lands on the last day of the previous month, and `anchoredWindowFor` on a
 * month's last day produces that whole month anyway. So the two differ only in
 * `mode` here, and `mode` is the part that changes what is sent. The dates
 * diverge going FORWARD, where `nextWindow` into the current month gives the
 * whole month and the anchored window would give only the days so far.
 */
export function previousWindow(window: ReportWindow): ReportWindow {
  if (window.period === "monthly") {
    return completeWindowFor("monthly", shiftDate(firstOfMonth(window.from), -1));
  }
  // The day before this window starts is the last day of the one before it, so
  // the complete period ending there is the previous window — for `daily` and
  // `weekly` alike, with no span arithmetic to get wrong.
  return completeWindowFor(window.period, shiftDate(window.from, -1));
}

/**
 * The window one period later.
 *
 * Returns null when the step would land entirely in the future, which is the
 * one direction worth refusing: a report covering days that have not happened
 * yet is empty by definition, and offering it invites the reader to conclude
 * that nothing was done.
 */
export function nextWindow(window: ReportWindow, today: string = todayLocal()): ReportWindow | null {
  const stepped =
    window.period === "monthly"
      ? completeWindowFor("monthly", shiftDate(lastOfMonth(window.to), 1))
      : completeWindowFor(
          window.period,
          shiftDate(window.to, window.period === "daily" ? 1 : 7)
        );
  if (stepped.from > today) return null;
  return stepped;
}

export type WindowRefusal = { ok: false; message: string };
export type WindowAccepted = { ok: true; window: ReportWindow };

/**
 * Whether this window may be sent, with the server's own reasons.
 *
 * The messages are deliberately the same sentences `explicitWindow` returns in
 * the API, because the user should not be told two different things about one
 * rule depending on which side noticed.
 */
export function validateWindow(window: ReportWindow): WindowAccepted | WindowRefusal {
  if (!isReportDate(window.from) || !isReportDate(window.to)) {
    return { ok: false, message: "A report range needs `from` and `to` as YYYY-MM-DD dates." };
  }
  if (window.from > window.to) {
    return { ok: false, message: "A report range must start on or before it ends." };
  }
  const days = windowLengthInDays(window.from, window.to);
  if (days > MAX_REPORT_WINDOW_DAYS) {
    return {
      ok: false,
      message:
        `A report may cover at most ${MAX_REPORT_WINDOW_DAYS} days; this range covers ${days}. ` +
        "Generate the period in parts, so each report states the dates it covers.",
    };
  }
  return { ok: true, window };
}

/**
 * The entries inside a window, and how many were excluded for having no usable
 * date.
 *
 * This replaces the screen's own `filterEntriesByPeriod`, which re-derived the
 * period boundaries from the entry list every time it ran. A window is now a
 * value the screen holds and sends, so filtering is a string comparison against
 * the same two dates the server is being given — there is no second arithmetic
 * to disagree with.
 *
 * `undatedCount` is returned rather than swallowed so the screen can say that
 * entries were left out. The old filter did the opposite: it substituted the
 * anchor for a missing date, so an undated entry appeared in every report of
 * every period.
 */
export function filterEntriesByWindow<T extends { date?: unknown }>(
  entries: ReadonlyArray<T>,
  window: Pick<ReportWindow, "from" | "to">
): { entries: T[]; undatedCount: number } {
  let undatedCount = 0;
  const kept: T[] = [];
  for (const entry of entries) {
    if (!isReportDate(entry?.date)) {
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

/**
 * The window in words, for the control and the report header.
 *
 * Same shape as the API's `describeWindow` so the label on the button and the
 * label in the generated document read the same.
 */
export function describeWindow(window: Pick<ReportWindow, "from" | "to">): string {
  return window.from === window.to
    ? formatWindowDate(window.from)
    : `${formatWindowDate(window.from)} – ${formatWindowDate(window.to)}`;
}
