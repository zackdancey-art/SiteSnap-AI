/**
 * Window arithmetic for AUDIT L92. Pure logic, no store, so it runs in the
 * in-memory suite.
 *
 * The centrepiece is the equivalence test near the bottom. Replacing the
 * anchored period filter with an explicit window is only safe if the anchored
 * path still behaves EXACTLY as it did, because the API deploys ahead of both
 * clients and every caller is a no-range caller until they ship. So this file
 * carries a verbatim copy of the old `routes/ai.ts` filter — the real one, Date
 * objects and all — and asserts the new code agrees with it on every date in a
 * three-month fixture, for all three periods. If the two ever disagree the test
 * names the date they disagree on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_REPORT_WINDOW_DAYS,
  ReportPeriod,
  anchoredWindow,
  describeWindow,
  explicitWindow,
  filterEntriesByWindow,
  firstOfMonth,
  isReportDate,
  latestEntryDate,
  shiftDate,
  windowLengthInDays,
} from "./reportWindow";

// ─────────────────────────────────────────────────────────────────────────────
// The OLD filter, copied verbatim from routes/ai.ts before this module existed.
// Do not tidy it. Its job is to be the thing the new code is compared against.
// ─────────────────────────────────────────────────────────────────────────────
type OldEntry = { date?: string };

function dateOnly(value: string) {
  return new Date(`${value}T00:00:00`);
}

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function oldFilterEntriesByPeriod(entries: OldEntry[], period: ReportPeriod) {
  if (entries.length === 0) return [];
  const sorted = [...entries].sort(
    (a, b) => dateOnly(String(a.date || "")).getTime() - dateOnly(String(b.date || "")).getTime()
  );
  const latest = dateOnly(String(sorted[sorted.length - 1].date || new Date().toISOString().slice(0, 10)));
  if (period === "daily") {
    const key = String(sorted[sorted.length - 1].date || formatDateKey(latest));
    return sorted.filter((e) => e.date === key);
  }
  if (period === "weekly") {
    const start = new Date(latest);
    start.setDate(start.getDate() - 6);
    return sorted.filter((e) => {
      const d = dateOnly(String(e.date || formatDateKey(latest)));
      return d >= start && d <= latest;
    });
  }
  return sorted.filter((e) => {
    const d = dateOnly(String(e.date || formatDateKey(latest)));
    return d.getFullYear() === latest.getFullYear() && d.getMonth() === latest.getMonth();
  });
}

// ─────────────────────────────────────────────────────────────────────────────

test("isReportDate accepts real calendar days and rejects the rest", () => {
  assert.equal(isReportDate("2026-03-01"), true);
  assert.equal(isReportDate("2026-02-28"), true);
  assert.equal(isReportDate("2024-02-29"), true, "2024 is a leap year");

  // The regex alone would pass all of these.
  assert.equal(isReportDate("2026-02-29"), false, "2026 is not a leap year");
  assert.equal(isReportDate("2026-02-31"), false);
  assert.equal(isReportDate("2026-13-01"), false);
  assert.equal(isReportDate("2026-00-10"), false);
  assert.equal(isReportDate("2026-03-00"), false);

  assert.equal(isReportDate("2026-3-1"), false, "unpadded does not sort lexicographically");
  assert.equal(isReportDate("2026-03-01T00:00:00Z"), false, "a window boundary is a day, not an instant");
  assert.equal(isReportDate(""), false);
  assert.equal(isReportDate(undefined), false);
  assert.equal(isReportDate(20260301), false);
});

test("date arithmetic is UTC and crosses month and year boundaries", () => {
  assert.equal(shiftDate("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDate("2024-03-01", -1), "2024-02-29");
  assert.equal(shiftDate("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDate("2026-03-05", -6), "2026-02-27");
  assert.equal(firstOfMonth("2026-03-27"), "2026-03-01");

  assert.equal(windowLengthInDays("2026-03-01", "2026-03-01"), 1, "a single day is one day");
  assert.equal(windowLengthInDays("2026-03-01", "2026-03-07"), 7);
  assert.equal(windowLengthInDays("2026-07-01", "2026-09-30"), 92, "the longest calendar quarter");
});

test("explicitWindow refuses the ranges a caller cannot have meant", () => {
  const ok = explicitWindow("weekly", "2026-03-02", "2026-03-08");
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.window, {
    from: "2026-03-02",
    to: "2026-03-08",
    period: "weekly",
    mode: "explicit",
  });

  const reversed = explicitWindow("weekly", "2026-03-08", "2026-03-02");
  assert.equal(reversed.ok, false);
  assert.match(reversed.ok === false ? reversed.message : "", /on or before/);

  const halfRange = explicitWindow("weekly", "2026-03-02", undefined);
  assert.equal(halfRange.ok, false, "a half range has two readings a week apart; refuse it");

  const nonsense = explicitWindow("monthly", "2026-02-31", "2026-03-02");
  assert.equal(nonsense.ok, false);

  // The ceiling, from both sides.
  const atLimit = explicitWindow("monthly", "2026-07-01", "2026-09-30");
  assert.equal(atLimit.ok, true, `${MAX_REPORT_WINDOW_DAYS} days is allowed`);
  const overLimit = explicitWindow("monthly", "2026-07-01", "2026-10-01");
  assert.equal(overLimit.ok, false);
  assert.match(overLimit.ok === false ? overLimit.message : "", /at most 92 days; this range covers 93/);
});

test("anchoredWindow writes the legacy behaviour out as dates", () => {
  assert.deepEqual(anchoredWindow("daily", "2026-03-05"), {
    from: "2026-03-05",
    to: "2026-03-05",
    period: "daily",
    mode: "anchored",
    anchoredOn: "2026-03-05",
  });
  assert.deepEqual(anchoredWindow("weekly", "2026-03-05").from, "2026-02-27", "the anchor and six days before");
  assert.deepEqual(anchoredWindow("monthly", "2026-03-05").from, "2026-03-01");
  // The anchor is always the end of the window, which is what made the old
  // monthly predicate's open end unreachable.
  for (const period of ["daily", "weekly", "monthly"] as ReportPeriod[]) {
    assert.equal(anchoredWindow(period, "2026-03-05").to, "2026-03-05");
  }
});

test("latestEntryDate ignores undated rows instead of defaulting them to today", () => {
  assert.equal(latestEntryDate([{ date: "2026-03-02" }, { date: "2026-03-05" }]), "2026-03-05");
  assert.equal(latestEntryDate([{ date: "2026-03-05" }, {}, { date: "bogus" }]), "2026-03-05");
  assert.equal(latestEntryDate([]), null);
  assert.equal(latestEntryDate([{}, { date: "" }]), null, "no usable date means no window, not today's");
});

test("filterEntriesByWindow excludes undated rows and counts them", () => {
  const entries = [
    { id: "a", date: "2026-03-01" },
    { id: "b", date: "2026-03-15" },
    { id: "c", date: "2026-04-01" },
    { id: "d" },
    { id: "e", date: "2026-02-31" },
  ];
  const result = filterEntriesByWindow(entries, { from: "2026-03-01", to: "2026-03-31" });

  assert.deepEqual(result.entries.map((e) => e.id), ["a", "b"], "inclusive at the from end");
  assert.equal(result.undatedCount, 2, "the dateless row and the impossible date are both counted");

  // Positive control for the exclusion of "c": widen the window and it appears,
  // so the absence above is the predicate rather than the mapping.
  const wider = filterEntriesByWindow(entries, { from: "2026-03-01", to: "2026-04-30" });
  assert.deepEqual(wider.entries.map((e) => e.id), ["a", "b", "c"]);
  assert.equal(wider.undatedCount, 2, "widening the window does not change what is undated");
});

test("the anchored path agrees with the old filter on every date, for all three periods", () => {
  // Three months of entries, deliberately uneven: gaps, a doubled day, dates
  // either side of a month boundary and either side of a year boundary.
  const dates = [
    "2025-12-29", "2025-12-30", "2025-12-31",
    "2026-01-01", "2026-01-02", "2026-01-02", "2026-01-15", "2026-01-31",
    "2026-02-01", "2026-02-02", "2026-02-27", "2026-02-28",
    "2026-03-01", "2026-03-02", "2026-03-05", "2026-03-05", "2026-03-31",
  ];

  // Every prefix of the list is its own fixture, so each date in turn gets to
  // be the anchor. 17 prefixes × 3 periods = 51 comparisons.
  let comparisons = 0;
  for (let end = 1; end <= dates.length; end += 1) {
    const entries = dates.slice(0, end).map((date) => ({ date }));
    for (const period of ["daily", "weekly", "monthly"] as ReportPeriod[]) {
      const anchor = latestEntryDate(entries);
      assert.notEqual(anchor, null);
      const viaWindow = filterEntriesByWindow(entries, anchoredWindow(period, anchor as string)).entries;
      const viaOld = oldFilterEntriesByPeriod(entries, period);
      assert.deepEqual(
        viaWindow.map((e) => e.date),
        viaOld.map((e) => e.date),
        `anchored ${period} window disagrees with the old filter for entries ending ${dates[end - 1]}`
      );
      comparisons += 1;
    }
  }
  // Pinned so that a future edit shrinking the fixture cannot quietly turn this
  // into a test of one date. Measured, not estimated: 17 prefixes × 3 periods.
  assert.equal(comparisons, 51);
});

test("the anchored path deliberately DIFFERS from the old filter on undated rows", () => {
  // Not an oversight, and the divergence is the whole point. The old filter
  // substituted the anchor for a missing date, and the anchor was the LAST
  // element of a sort whose comparator returns NaN for an undated row — so the
  // original array order survived and decided the report. These six outcomes
  // are measured against the verbatim copy below, not reasoned about:
  //
  //   entries                       period   old filter returned
  //   [dated, undated]              daily    NOTHING AT ALL
  //   [dated, undated]              weekly   the undated row only
  //   [dated, undated]              monthly  the undated row only
  //   [undated, dated]              daily    the dated row
  //   [undated, dated]              weekly   both
  //   [undated, dated]              monthly  both
  //
  // So a single entry filed without a date could empty a daily report — the
  // route then answered "No entries are available", with a dated entry sitting
  // right there — or displace the real one from a weekly, depending only on
  // which of the two `listEntries` happened to return first.
  const dated = { date: "2026-03-05" };
  const undated = {} as { date?: string };

  assert.deepEqual(oldFilterEntriesByPeriod([dated, undated], "daily"), []);
  assert.deepEqual(oldFilterEntriesByPeriod([dated, undated], "weekly"), [undated]);
  assert.deepEqual(oldFilterEntriesByPeriod([dated, undated], "monthly"), [undated]);
  assert.deepEqual(oldFilterEntriesByPeriod([undated, dated], "daily"), [dated]);
  assert.deepEqual(oldFilterEntriesByPeriod([undated, dated], "weekly"), [undated, dated]);
  assert.deepEqual(oldFilterEntriesByPeriod([undated, dated], "monthly"), [undated, dated]);

  // The new path gives the same answer for both orderings, and it is the one a
  // reader would expect: the dated entry is in the window, the undated one is
  // excluded and counted.
  for (const entries of [[dated, undated], [undated, dated]]) {
    for (const period of ["daily", "weekly", "monthly"] as ReportPeriod[]) {
      const result = filterEntriesByWindow(entries, anchoredWindow(period, "2026-03-05"));
      assert.deepEqual(result.entries, [dated], `${period} should hold the dated entry regardless of order`);
      assert.equal(result.undatedCount, 1, "excluded, and reported rather than dropped quietly");
    }
  }
});

test("describeWindow reads as a date range in the report header", () => {
  assert.equal(describeWindow({ from: "2026-03-05", to: "2026-03-05" }), "5 March 2026");
  assert.equal(
    describeWindow({ from: "2026-02-27", to: "2026-03-05" }),
    "27 February 2026 – 5 March 2026"
  );
});
