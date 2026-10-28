/**
 * The report window on the capture client — AUDIT L92, mobile half.
 *
 * Three jobs, and the middle one is the reason this file exists at all.
 *
 * 1. THE RULE IS THE SERVER'S RULE. `report-window.ts` duplicates the
 *    arithmetic in `services/api/src/utils/reportWindow.ts` because
 *    `@sitesnap/shared` is declaration-only and cannot carry runtime code (see
 *    that module's comment). `ANCHORED_VECTORS` below is the same table as
 *    `utils/reportWindow.test.ts:133`, by hand. Edit the rule on one side and
 *    the other side's copy of this table fails. It is a weaker guarantee than
 *    sharing the code and a much stronger one than the status quo, where the
 *    two copies disagreed and nothing reported it.
 *
 * 2. THE REFACTOR DOES NOT CHANGE WHICH ENTRIES A REPORT COVERS.
 *    `oldFilterEntriesByPeriod` below is the screen's own filter, transcribed
 *    verbatim from `app/diary/[siteId].tsx` before this change — local-time
 *    `Date` objects, `getMonth()` comparison and all. The sweep asserts the new
 *    window path selects exactly the same entries for every anchor date across
 *    two months and all three periods. Without this the refactor would be a
 *    rewrite of what a report contains, dressed as a UI change.
 *
 * 3. WHERE IT DOES CHANGE, THAT IS THE POINT, AND IT IS MEASURED NOT ASSUMED.
 *    One entry whose `date` is an empty string made the OLD filter return
 *    nothing — for all three periods, on a site with a month of valid entries.
 *    `date` is typed `string` and `""` is a `string`, so this needs no type
 *    violation to reach: any row arriving from the API with a blank date
 *    emptied the diary screen and disabled generation. The new path excludes
 *    that row, keeps the rest, and counts it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_REPORT_WINDOW_DAYS,
  ReportPeriod,
  anchoredWindowFor,
  completeWindowFor,
  describeWindow,
  filterEntriesByWindow,
  firstOfMonth,
  isReportDate,
  lastOfMonth,
  latestEntryDate,
  nextWindow,
  previousWindow,
  shiftDate,
  validateWindow,
  windowLengthInDays,
} from "./report-window";

const PERIODS: ReportPeriod[] = ["daily", "weekly", "monthly"];

/**
 * The diary screen's filter as it stood before this change, copied verbatim
 * from `app/diary/[siteId].tsx`. Do not tidy it: its value is being exactly
 * what shipped, including `dateOnly` building a LOCAL-time Date from a calendar
 * string and the monthly branch comparing `getMonth()` instead of the string.
 */
function dateOnly(value: string) {
  return new Date(`${value}T00:00:00`);
}
function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
function oldFilterEntriesByPeriod<T extends { date: string }>(entries: T[], period: ReportPeriod) {
  if (entries.length === 0) return [];
  const sorted = [...entries].sort((a, b) => dateOnly(a.date).getTime() - dateOnly(b.date).getTime());
  const latest = dateOnly(sorted[sorted.length - 1].date);
  if (period === "daily") {
    const key = sorted[sorted.length - 1].date || formatDateKey(latest);
    return sorted.filter((entry) => entry.date === key);
  }
  if (period === "weekly") {
    const start = new Date(latest);
    start.setDate(start.getDate() - 6);
    return sorted.filter((entry) => dateOnly(entry.date) >= start && dateOnly(entry.date) <= latest);
  }
  return sorted.filter((entry) => {
    const d = dateOnly(entry.date);
    return d.getFullYear() === latest.getFullYear() && d.getMonth() === latest.getMonth();
  });
}

/** The new path, as the screen now uses it. */
function newFilterByPeriod<T extends { date: string }>(entries: T[], period: ReportPeriod) {
  const anchor = latestEntryDate(entries);
  if (anchor === null) return { entries: [] as T[], undatedCount: entries.length };
  return filterEntriesByWindow(entries, anchoredWindowFor(period, anchor));
}

test("isReportDate accepts real calendar days and rejects everything else", () => {
  // Positive control first: if these stopped passing, the rejections below
  // would pass for the wrong reason.
  for (const good of ["2026-03-05", "2026-01-01", "2026-12-31", "2028-02-29"]) {
    assert.equal(isReportDate(good), true, `${good} is a real day`);
  }
  for (const bad of ["2026-02-31", "2026-13-01", "2026-00-10", "2027-02-29", "2026-2-5", "", "2026-03-05T00:00:00Z", 20260305, null, undefined]) {
    assert.equal(isReportDate(bad as unknown), false, `${String(bad)} must be refused`);
  }
});

test("date arithmetic is UTC and crosses month, year and leap boundaries", () => {
  assert.equal(shiftDate("2026-03-01", -1), "2026-02-28");
  assert.equal(shiftDate("2028-03-01", -1), "2028-02-29", "2028 is a leap year");
  assert.equal(shiftDate("2026-01-01", -1), "2025-12-31");
  assert.equal(shiftDate("2026-12-31", 1), "2027-01-01");
  assert.equal(firstOfMonth("2026-03-05"), "2026-03-01");
  assert.equal(lastOfMonth("2026-03-05"), "2026-03-31");
  assert.equal(lastOfMonth("2026-02-10"), "2026-02-28");
  assert.equal(lastOfMonth("2028-02-10"), "2028-02-29");
  assert.equal(windowLengthInDays("2026-03-05", "2026-03-05"), 1, "one day is one day");
  assert.equal(windowLengthInDays("2026-07-01", "2026-09-30"), 92, "a longest-quarter window");
});

/**
 * The cross-package agreement table. The same anchor and the same three
 * expected `from` dates as `utils/reportWindow.test.ts:133` in the API.
 */
const ANCHORED_VECTORS: Array<{ period: ReportPeriod; anchor: string; from: string; to: string }> = [
  { period: "daily", anchor: "2026-03-05", from: "2026-03-05", to: "2026-03-05" },
  { period: "weekly", anchor: "2026-03-05", from: "2026-02-27", to: "2026-03-05" },
  { period: "monthly", anchor: "2026-03-05", from: "2026-03-01", to: "2026-03-05" },
];

test("anchoredWindowFor matches the API's pinned vectors exactly", () => {
  for (const vector of ANCHORED_VECTORS) {
    const window = anchoredWindowFor(vector.period, vector.anchor);
    assert.deepEqual(
      { from: window.from, to: window.to },
      { from: vector.from, to: vector.to },
      `${vector.period} anchored on ${vector.anchor} must match the server`
    );
    assert.equal(window.mode, "anchored");
    assert.equal(window.anchoredOn, vector.anchor);
    // The anchor is ALWAYS the end of the window. This is what made the old
    // monthly predicate's open upper end unreachable.
    assert.equal(window.to, vector.anchor);
  }
  // The monthly anchored window is a PARTIAL month on purpose — the whole month
  // is what stepping gives you, not what the screen opens on.
  assert.equal(anchoredWindowFor("monthly", "2026-03-05").to, "2026-03-05");
  assert.equal(completeWindowFor("monthly", "2026-03-05").to, "2026-03-31");
});

test("the new window path selects the same entries as the old filter, every anchor, every period", () => {
  // Two months of dated entries, so weekly and monthly windows both have
  // boundaries to get wrong, including a month boundary inside a week.
  const allDates: string[] = [];
  for (let day = 1; day <= 28; day += 1) allDates.push(`2026-02-${String(day).padStart(2, "0")}`);
  for (let day = 1; day <= 31; day += 1) allDates.push(`2026-03-${String(day).padStart(2, "0")}`);

  let comparisons = 0;
  for (let cut = 1; cut <= allDates.length; cut += 1) {
    const entries = allDates.slice(0, cut).map((date) => ({ date }));
    for (const period of PERIODS) {
      const viaOld = oldFilterEntriesByPeriod(entries, period).map((e) => e.date);
      const viaNew = newFilterByPeriod(entries, period).entries.map((e) => e.date);
      assert.deepEqual(
        viaNew,
        viaOld,
        `${period} report anchored on ${entries[entries.length - 1].date} must cover the same days as before`
      );
      comparisons += 1;
    }
  }

  // The sweep must actually have swept. A loop that ran zero times would have
  // passed every assertion above it.
  assert.equal(comparisons, allDates.length * PERIODS.length);
  assert.equal(comparisons, 177);

  // And the comparison is not vacuous at the interesting boundary: a weekly
  // window anchored on 2 March reaches back into February.
  const acrossBoundary = allDates.slice(0, 28 + 2).map((date) => ({ date }));
  const weekly = newFilterByPeriod(acrossBoundary, "weekly").entries.map((e) => e.date);
  assert.equal(weekly[0], "2026-02-24");
  assert.equal(weekly[weekly.length - 1], "2026-03-02");
  assert.equal(weekly.length, 7);
});

test("one blank date emptied the whole report before this change, and now costs one row", () => {
  const dated = [{ date: "2026-03-01" }, { date: "2026-03-04" }, { date: "2026-03-05" }];
  const withBlank = [...dated, { date: "" }];

  for (const period of PERIODS) {
    // POSITIVE CONTROL, same period, same call: without the blank row the old
    // filter and the new path agree and both return entries. So the emptiness
    // below is the blank row, not a broken fixture.
    const controlOld = oldFilterEntriesByPeriod(dated, period).map((e) => e.date);
    const controlNew = newFilterByPeriod(dated, period).entries.map((e) => e.date);
    assert.deepEqual(controlNew, controlOld);
    assert.ok(controlNew.length > 0, `${period} must find entries in the clean fixture`);

    // THE DEFECT. `date: ""` sorts last, so the old filter's anchor became an
    // Invalid Date and every comparison against it was false.
    assert.deepEqual(
      oldFilterEntriesByPeriod(withBlank, period),
      [],
      `${period}: the old filter returned NOTHING for a site with three valid entries`
    );

    // THE FIX. The blank row is excluded and counted; the valid entries are
    // unaffected and match the clean control exactly.
    const fixed = newFilterByPeriod(withBlank, period);
    assert.deepEqual(fixed.entries.map((e) => e.date), controlOld, `${period}: the valid entries survive`);
    assert.equal(fixed.undatedCount, 1, "excluded, and reported rather than dropped quietly");
  }

  // latestEntryDate is what makes it work: it skips the unusable row instead of
  // letting it decide the window.
  assert.equal(latestEntryDate(withBlank), "2026-03-05");
  assert.equal(latestEntryDate([{ date: "" }, { date: "nonsense" }]), null);
});

test("stepping lands on complete periods and refuses to run into the future", () => {
  // Monthly: stepping back from a part-finished March gives the WHOLE of
  // February.
  //
  // Note what this pair does and does not prove. The step lands on February's
  // last day, and an ANCHORED window on a month's last day is that whole month
  // too — so the dates here would pass either way, and `mode` is the live
  // difference, because `mode` is what decides whether the screen sends the
  // range or lets the server anchor. The dates diverge going forward, asserted
  // below.
  const marchSoFar = anchoredWindowFor("monthly", "2026-03-05");
  const february = previousWindow(marchSoFar);
  assert.deepEqual({ from: february.from, to: february.to }, { from: "2026-02-01", to: "2026-02-28" });
  assert.equal(february.mode, "explicit", "a stepped window is the user's choice, so it is sent explicitly");

  // Weekly: the seven days ending the day before this window started.
  const week = anchoredWindowFor("weekly", "2026-03-05");
  assert.deepEqual(
    { from: previousWindow(week).from, to: previousWindow(week).to },
    { from: "2026-02-20", to: "2026-02-26" }
  );
  assert.equal(windowLengthInDays(previousWindow(week).from, previousWindow(week).to), 7);

  // Daily.
  assert.deepEqual(
    { from: previousWindow(anchoredWindowFor("daily", "2026-03-01")).from, to: previousWindow(anchoredWindowFor("daily", "2026-03-01")).to },
    { from: "2026-02-28", to: "2026-02-28" }
  );

  // Forward, with "today" supplied so the test does not depend on the clock.
  // POSITIVE CONTROL: a step that lands in the past is allowed.
  const backToMarch = nextWindow(february, "2026-04-10");
  assert.notEqual(backToMarch, null, "stepping forward into a month that has happened must work");
  assert.deepEqual({ from: backToMarch?.from, to: backToMarch?.to }, { from: "2026-03-01", to: "2026-03-31" });
  // THE DATES DIVERGE HERE, which is the half the backward step cannot show:
  // stepping forward gives all of March, where the anchored window the screen
  // opens on gives only the days up to the anchor.
  assert.notDeepEqual(
    { from: backToMarch?.from, to: backToMarch?.to },
    { from: marchSoFar.from, to: marchSoFar.to },
    "a stepped month is the whole month, not the part-finished one"
  );
  assert.equal(marchSoFar.to, "2026-03-05");

  // And one that lands entirely in the future is refused.
  assert.equal(nextWindow(february, "2026-02-20"), null, "a window of days that have not happened is empty by definition");
  assert.equal(nextWindow(completeWindowFor("daily", "2026-03-05"), "2026-03-05"), null);
  assert.notEqual(nextWindow(completeWindowFor("daily", "2026-03-05"), "2026-03-06"), null);
});

test("validateWindow refuses what the server would refuse, with the server's sentences", () => {
  // Positive control: a longest-possible quarter is accepted, so the refusals
  // below are the rule and not a function that refuses everything.
  const quarter = { from: "2026-07-01", to: "2026-09-30", period: "monthly" as ReportPeriod, mode: "explicit" as const };
  assert.equal(validateWindow(quarter).ok, true, `${MAX_REPORT_WINDOW_DAYS} days exactly must be allowed`);

  const tooLong = validateWindow({ ...quarter, to: "2026-10-01" });
  assert.equal(tooLong.ok, false);
  assert.match(
    tooLong.ok === false ? tooLong.message : "",
    /at most 92 days; this range covers 93/,
    "the message must name both numbers, as the API's does"
  );

  const backwards = validateWindow({ ...quarter, from: "2026-09-30", to: "2026-07-01" });
  assert.equal(backwards.ok, false);
  assert.match(backwards.ok === false ? backwards.message : "", /start on or before it ends/);

  const blank = validateWindow({ ...quarter, from: "" });
  assert.equal(blank.ok, false);
  assert.match(blank.ok === false ? blank.message : "", /YYYY-MM-DD/);
});

test("describeWindow reads as a date range, and a single day as a single day", () => {
  assert.equal(describeWindow({ from: "2026-03-05", to: "2026-03-05" }), "5 March 2026");
  assert.equal(describeWindow({ from: "2026-02-27", to: "2026-03-05" }), "27 February 2026 – 5 March 2026");
  // Not a date: shown as given rather than as "Invalid Date".
  assert.equal(describeWindow({ from: "", to: "" }), "");
});
