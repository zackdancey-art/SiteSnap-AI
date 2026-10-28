/**
 * The words next to a site in the bin, decided in one place and free of React
 * Native imports so a test can execute them.
 *
 * WHY THIS IS NOT IN THE SCREEN
 *
 * Mobile cannot be screenshotted from this environment — no simulator, no
 * device — so a string built inside a .tsx is a string nothing can check. The
 * same reasoning put lib/permissions.ts here, and the note at the top of that
 * file is the longer version.
 *
 * WHAT IT WILL NOT DO
 *
 * It will not compute `daysInBin` itself. That number arrives from the API,
 * which computes it next to the retention period it is measured against
 * (services/api/src/storage/softDelete.ts). A client subtracting a server
 * timestamp from the phone's own clock is how two surfaces come to disagree
 * about when something will be destroyed, and the phone's clock is the one that
 * can be wrong by a year. So a null `daysInBin` produces no countdown rather
 * than a locally derived one: no number is better than a wrong number when what
 * it counts down to is permanent destruction.
 */

/** Only the fields the words are built from — not the whole BinnedSite. */
export interface BinAge {
  deletedAt: string;
  daysInBin: number | null;
}

/**
 * "Deleted 3 days ago · 87 days left".
 *
 * `retentionDays` is null when the API did not send one, and then the second
 * half is omitted rather than defaulted. A hardcoded 90 here that disagreed
 * with the server's BIN_RETENTION_DAYS would be the same class of defect as the
 * hand-written SQL predicate this phase exists to remove.
 */
export function describeBinAge(site: BinAge, retentionDays: number | null): string {
  const parts: string[] = [];

  if (site.daysInBin === null) {
    const when = formatDeletedAt(site.deletedAt);
    parts.push(when === "" ? "Deleted" : `Deleted ${when}`);
  } else if (site.daysInBin <= 0) {
    parts.push("Deleted today");
  } else {
    parts.push(`Deleted ${site.daysInBin} ${site.daysInBin === 1 ? "day" : "days"} ago`);
  }

  if (site.daysInBin !== null && retentionDays !== null) {
    // Clamped at zero: a site past its retention period is still here, because
    // nothing in the shipping API deletes it. "−3 days left" would be reporting
    // arithmetic rather than the state of the record.
    const left = Math.max(0, retentionDays - site.daysInBin);
    parts.push(left === 0 ? "due to be cleared" : `${left} ${left === 1 ? "day" : "days"} left`);
  }

  return parts.join(" · ");
}

/** Absolute date, used only when there is no day count to show instead. */
export function formatDeletedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}
