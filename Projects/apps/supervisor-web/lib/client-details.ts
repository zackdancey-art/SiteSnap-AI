/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHICH CLIENT DETAILS SHOW, AND IN WHAT ORDER — THE PORTAL COPY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The twin of apps/mobile/lib/client-details.ts. The marked region below is
 * byte-identical to that file's and `Projects/scripts/ci.sh` proves it on every
 * run; everything outside the markers is this package's own.
 *
 * Read the mobile copy's header for why the rule was extracted at all. The
 * short version: eight fields rendered as conditional rows on two surfaces
 * meant naming every field twice per surface, and a field left out of one `&&`
 * hides a populated row with no error.
 *
 * The portal's own reason for caring: it is the surface where somebody copies
 * an invoice address out of SiteSnap and into their accounting system, so a
 * row that silently does not render is a line missing off an invoice.
 *
 * Presentation stays in ClientsPanel.tsx — this returns a `key`, and the panel
 * maps it to a label. The mobile copy maps the same key to an icon.
 */

// SHARED-LOGIC-BEGIN
// Duplicated, byte for byte, in apps/mobile/lib/client-details.ts and
// apps/supervisor-web/lib/client-details.ts, and diffed by
// Projects/scripts/ci.sh. @sitesnap/shared emits .d.ts only, so a runtime rule
// cannot live there; see the header above this marker.
//
// Types are declared inside the region rather than imported, so the two copies
// can be identical while each package's own `Client` type stays where it is.

/** Every client field that can appear as a detail row, in no particular order. */
export type ClientDetailKey =
  | "contactName"
  | "contactEmail"
  | "contactPhone"
  | "physicalAddress"
  | "postalAddress"
  | "taxNumber"
  | "companyNumber"
  | "notes";

/**
 * What this rule needs of a client, which is less than either package's
 * `Client` type. Every field optional and nullable: a response from an older
 * API — a phone running against a server that predates migration 036 — has no
 * `taxNumber` at all, and `undefined` must read as "nothing to show" rather
 * than printing "undefined" into a card.
 */
export type ClientDetailsSource = {
  [K in ClientDetailKey]?: string | null;
};

export type ClientDetailRow = { key: ClientDetailKey; value: string };

/**
 * THE ORDER THE ROWS APPEAR IN, and the reason it is a constant rather than
 * the order somebody happened to write the JSX in: the two surfaces render
 * from this array, so they cannot disagree, and adding a field means adding it
 * here once instead of twice in two different places in two files.
 *
 * Contact first because it is who you call. Then where you send the invoice,
 * then the numbers that have to appear on it. Notes last because they are
 * prose and everything above them is a fact.
 */
export const CLIENT_DETAIL_ORDER: readonly ClientDetailKey[] = [
  "contactName",
  "contactEmail",
  "contactPhone",
  "physicalAddress",
  "postalAddress",
  "taxNumber",
  "companyNumber",
  "notes",
];

/**
 * The non-empty detail rows, in `CLIENT_DETAIL_ORDER`.
 *
 * Whitespace-only counts as empty. A field the user typed a space into would
 * otherwise render a row with an icon beside nothing, which reads as missing
 * data rather than as data nobody entered — and both routes `.trim()` on the
 * way in, so a value that is all whitespace can only arrive from a record
 * written before they did.
 */
export function clientDetailRows(client: ClientDetailsSource): ClientDetailRow[] {
  const rows: ClientDetailRow[] = [];
  for (const key of CLIENT_DETAIL_ORDER) {
    const raw = client[key];
    if (typeof raw !== "string") continue;
    const value = raw.trim();
    if (value === "") continue;
    rows.push({ key, value });
  }
  return rows;
}

/**
 * Whether a client has anything to show below its name.
 *
 * Derived from `clientDetailRows` rather than written as its own chain of ORs,
 * which is what the two surfaces had before: eight fields on two clients is
 * sixteen chances for one of them to forget a field and hide a populated row
 * behind a false condition.
 */
export function hasClientDetails(client: ClientDetailsSource): boolean {
  return clientDetailRows(client).length > 0;
}
// SHARED-LOGIC-END
