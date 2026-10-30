/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE PORTAL HALF — THE SAME ASSERTIONS AS THE MOBILE FILE, DELIBERATELY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The twin of `apps/mobile/lib/client-details.test.ts`, and not covered by
 * ci.sh's shared-logic diff: only the MODULE's marked region is diffed, not
 * its tests. The duplication is wanted anyway — `pnpm --filter
 * sitesnap-supervisor-web run test` is what a person runs while editing this
 * package, and a module whose only test lives in another package is a module
 * their run does not exercise.
 *
 * These tests do NOT prove ClientsPanel.tsx calls any of this. That component
 * imports react and cannot be loaded here; it is read, not executed, and said
 * so in the PR body.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_DETAIL_ORDER,
  clientDetailRows,
  hasClientDetails,
  type ClientDetailKey,
} from "./client-details";

/**
 * The population, pinned as an EQUALITY rather than a floor (L112). Eight is
 * knowable: it is every writable field on a client bar `name`, which is the
 * card's heading and never a detail row. A `>= 8` here would pass a ninth
 * field being added and never rendered anywhere, which is the exact failure
 * this module exists to stop.
 */
const EVERY_KEY: readonly ClientDetailKey[] = [
  "contactName",
  "contactEmail",
  "contactPhone",
  "physicalAddress",
  "postalAddress",
  "taxNumber",
  "companyNumber",
  "notes",
];

test("CLIENT_DETAIL_ORDER is exactly the eight detail fields, in order", () => {
  assert.deepEqual([...CLIENT_DETAIL_ORDER], [...EVERY_KEY]);
  assert.equal(CLIENT_DETAIL_ORDER.length, 8);
  assert.equal(new Set(CLIENT_DETAIL_ORDER).size, 8, "a duplicated key would render a row twice");
});

test("a fully populated client yields every row, in CLIENT_DETAIL_ORDER", () => {
  const client: Record<ClientDetailKey, string> = {
    contactName: "Dale Harper",
    contactEmail: "dale@harper.test",
    contactPhone: "+6421000111",
    physicalAddress: "12 Quarry Road\nOtaki",
    postalAddress: "PO Box 44\nOtaki 5512",
    taxNumber: "123-456-789",
    companyNumber: "9429041234567",
    notes: "Invoices monthly.",
  };
  const rows = clientDetailRows(client);
  // Equality on the keys AND on the length: a rule that returned the right
  // rows in the wrong order is a card where the GST number sits above the
  // address, and nothing else in either client asserts the order.
  assert.deepEqual(rows.map((r) => r.key), [...EVERY_KEY]);
  assert.equal(rows.length, 8);
  // And the values come through untouched, which is the half a key-only
  // assertion would pass vacuously.
  assert.equal(rows[0]!.value, "Dale Harper");
  assert.equal(rows[3]!.value, "12 Quarry Road\nOtaki");
  assert.equal(rows[7]!.value, "Invoices monthly.");
  assert.equal(hasClientDetails(client), true);
});

test("empty, whitespace-only, null and absent fields are all skipped — with the positive control", () => {
  const rows = clientDetailRows({
    contactName: "Dale Harper", // POSITIVE CONTROL: proves the rule ran at all
    contactEmail: "",
    contactPhone: "   ",
    physicalAddress: "\n\t ",
    postalAddress: null,
    // taxNumber, companyNumber and notes are absent, not empty — an older
    // server that predates migration 036 returns a client with no such keys.
  });
  assert.deepEqual(rows, [{ key: "contactName", value: "Dale Harper" }]);
});

test("a client with nothing to show yields no rows and hasClientDetails is false", () => {
  const blank = { contactName: "", contactEmail: "", contactPhone: "", notes: "   " };
  assert.deepEqual(clientDetailRows(blank), []);
  assert.equal(hasClientDetails(blank), false);
  // BOTH CONTROLS IN THE SAME TEST. `[]` and `false` pass just as happily if
  // the function throws nothing and returns a constant, so the same two calls
  // are made again with one field filled and must come back different.
  const filled = { ...blank, contactName: "Dale Harper" };
  assert.equal(clientDetailRows(filled).length, 1);
  assert.equal(hasClientDetails(filled), true);
});

test("a value is trimmed for the emptiness test and for display", () => {
  const rows = clientDetailRows({ taxNumber: "  123-456-789  " });
  assert.deepEqual(rows, [{ key: "taxNumber", value: "123-456-789" }]);
});

test("`name` is not a detail row", () => {
  // The card renders the name as its heading. If it were also in the order
  // array it would appear twice, which is why this is asserted rather than
  // left to the reader of CLIENT_DETAIL_ORDER.
  assert.equal(CLIENT_DETAIL_ORDER.includes("name" as ClientDetailKey), false);
  assert.deepEqual(clientDetailRows({ name: "Harper Builders" } as never), []);
});

test("no bank or financial field is renderable — there is nowhere for one to go", () => {
  // The schema has no such column (migration 036 says so in its header) and
  // this is the client-side half of the same statement: even if a server
  // started returning one, neither surface would draw it, because both render
  // from CLIENT_DETAIL_ORDER and nothing else.
  for (const banned of ["bankAccount", "accountNumber", "bsb", "iban", "sortCode"]) {
    assert.equal(
      CLIENT_DETAIL_ORDER.includes(banned as ClientDetailKey),
      false,
      `${banned} must not be a client detail row`
    );
  }
  const rows = clientDetailRows({
    contactName: "Dale Harper", // POSITIVE CONTROL
    bankAccount: "00-0000-0000000-00",
  } as never);
  assert.deepEqual(rows, [{ key: "contactName", value: "Dale Harper" }]);
});
