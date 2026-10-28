/**
 * Turning the consent records the API returns into lines a person can read.
 *
 * Separate from the screen, and free of React Native imports, for the reason
 * written out in lib/permissions.ts: mobile cannot be screenshotted from this
 * environment, so a unit test is the only verification available for anything
 * the app displays. Keeping the wording decisions here and the rendering in
 * app/settings/data-privacy.tsx is what makes them checkable at all.
 */

/** One row of GET /api/auth/consents, as the route returns it. */
export type ConsentRecord = {
  document: string;
  version: string;
  acceptedAt: string;
  source: string;
};

export type ConsentLine = {
  /** "Terms of Service" / "Privacy Policy", or the raw value if unrecognised. */
  label: string;
  /** "Accepted 4 October 2026 · Last updated: 3 October 2026" */
  detail: string;
};

/**
 * The two documents, in the order they are shown, which is the order they are
 * linked in on the same screen. Not derived from the records, because the
 * records' order is the database's and would reshuffle the list whenever the
 * two acceptances happened to be stored a millisecond apart.
 */
const DOCUMENT_LABELS: Record<string, string> = {
  terms: "Terms of Service",
  privacy: "Privacy Policy",
};
const DOCUMENT_ORDER = ["terms", "privacy"];

/**
 * What an account with no consent record is told.
 *
 * It is NOT "you have not accepted these". Every account that exists accepted
 * the terms when it was created -- that is what creating it meant -- and
 * telling someone otherwise would be the app asserting something false about
 * them. What is missing is the record, not the agreement, and the sentence says
 * exactly that. Accounts created before this shipped have no row; see
 * services/api/src/utils/signupConsent.ts.
 */
export const NO_RECORD_MESSAGE =
  "No acceptance is recorded for this account. SiteSnap began keeping that record " +
  "after this account was created; it does not mean the documents were not accepted.";

/**
 * Format an ISO timestamp as "4 October 2026".
 *
 * Day-month-year because the product is Australian and New Zealand, and every
 * other date in the app reads that way. Returns the input unchanged if it is
 * not a date, rather than printing "Invalid Date" at somebody: an unparseable
 * string from the server is a bug to see, not a word to show.
 *
 * `timeZone` exists for the test, and defaults to the device's own zone, which
 * is the right answer for the person reading it: the date they agreed is the
 * date it was where they were. It has to be injectable because an instant is a
 * different calendar date in different zones, so a test that pinned a formatted
 * string against the machine's local zone would pass in Auckland and fail in
 * CI's UTC -- and the failure would be the test's, not the code's.
 */
export function formatAcceptedDate(iso: string, timeZone?: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleDateString("en-NZ", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone,
  });
}

/**
 * The lines to show, most recent acceptance of each document.
 *
 * Records are an append-only ledger, so one document can have several rows --
 * a re-acceptance after the text changes. The newest is what is current, and
 * the earlier ones are history nobody needs on a settings screen.
 */
export function summariseConsents(records: ConsentRecord[], timeZone?: string): ConsentLine[] {
  const newest = new Map<string, ConsentRecord>();
  for (const record of records) {
    const existing = newest.get(record.document);
    // Strict `>` so that, given two rows with the same instant, the first wins
    // and the order is at least stable rather than dependent on iteration.
    if (!existing || record.acceptedAt > existing.acceptedAt) {
      newest.set(record.document, record);
    }
  }

  // Known documents first, in their fixed order; then anything the server knows
  // about and this build does not, rather than dropping it. A consent record
  // silently omitted because an older app did not recognise the document name
  // is the one outcome worth avoiding here.
  const seen = new Set<string>();
  const ordered: ConsentRecord[] = [];
  for (const document of DOCUMENT_ORDER) {
    const record = newest.get(document);
    if (record) {
      ordered.push(record);
      seen.add(document);
    }
  }
  for (const [document, record] of newest) {
    if (!seen.has(document)) ordered.push(record);
  }

  return ordered.map((record) => ({
    label: DOCUMENT_LABELS[record.document] ?? record.document,
    detail: `Accepted ${formatAcceptedDate(record.acceptedAt, timeZone)} · ${record.version}`,
  }));
}
