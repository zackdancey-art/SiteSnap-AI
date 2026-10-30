import { test } from "node:test";
import assert from "node:assert/strict";
import { clientsAfterSiteBinned, clientsAfterSiteRefiled } from "./client-site-counts";
import type { Client } from "./types";

/**
 * WHY THESE TESTS EXIST AT ALL
 *
 * There is no simulator and no device attached to this environment, and
 * `lib/data-context.tsx` — where this arithmetic used to live inline — cannot
 * be loaded by `node --test` at all, because it imports react-native and
 * expo-router transitively. So before the rule was extracted into a module
 * with no react-native import, the phone's half of AUDIT L114 could only be
 * verified by reading it. Same arrangement, and same reason, as
 * lib/site-grouping.test.ts and lib/permissions.test.ts.
 *
 * What is still unverified here is that the provider CALLS these functions on
 * the right lines; that is read, not executed, and is stated as unverified in
 * the PR's device checklist. The functions themselves are executed below.
 */

function client(id: string, siteCount: number): Client {
  return {
    id,
    name: `Client ${id}`,
    contactName: "",
    contactEmail: "",
    contactPhone: "",
    // The migration-036 fields, all empty. Spelled out rather than cast,
    // because a cast here is what let a missing column go unnoticed in L118:
    // adding a field to `Client` must break this fixture and make someone
    // decide what the fixture's value for it is.
    physicalAddress: "",
    postalAddress: "",
    taxNumber: "",
    companyNumber: "",
    notes: "",
    xeroContactId: null,
    createdAt: "2026-01-05T00:00:00.000Z",
    updatedAt: "2026-01-05T00:00:00.000Z",
    siteCount,
  };
}

const counts = (clients: Client[]) => clients.map((c) => [c.id, c.siteCount]);

test("binning a filed site takes one off that client's count and leaves the others alone", () => {
  const before = [client("a", 3), client("b", 1)];

  const after = clientsAfterSiteBinned(before, "a");

  // The assertion that is the bug: 3 → 2. Before L114 the phone kept 3.
  assert.deepEqual(counts(after), [
    ["a", 2],
    ["b", 1],
  ]);
  // The positive control on the same call: "b" was NOT touched, and the
  // untouched value is a real number rather than an absence. A function that
  // returned its input unchanged would pass the "b" assertion alone.
  assert.equal(after[1].siteCount, 1);
  // And the input is not mutated — the provider holds `clients` in state and
  // compares by reference, so a mutating version would skip the re-render.
  assert.deepEqual(counts(before), [
    ["a", 3],
    ["b", 1],
  ]);
});

test("binning an unfiled site changes nothing, and the list comes back by reference", () => {
  const before = [client("a", 3)];

  // null is a site that was never filed under a client.
  assert.equal(clientsAfterSiteBinned(before, null), before);
  // Positive control: the same list with a real client id DOES change, so the
  // no-op above is the null case and not a function that never does anything.
  assert.deepEqual(counts(clientsAfterSiteBinned(before, "a")), [["a", 2]]);
});

test("a count already at zero stays at zero rather than going negative", () => {
  // Reachable: a site filed in the portal since this phone's last refresh, then
  // binned from the phone. The local number is behind the server's.
  const before = [client("a", 0)];

  assert.deepEqual(counts(clientsAfterSiteBinned(before, "a")), [["a", 0]]);
  // Positive control: the clamp is a clamp, not a freeze. The same client's
  // count still moves when it has somewhere to move to.
  assert.deepEqual(counts(clientsAfterSiteBinned([client("a", 1)], "a")), [["a", 0]]);
});

test("binning a site filed under a client this phone has not seen yet is a no-op, not a crash", () => {
  // Reachable the same way: the client was created on another device after this
  // phone's last refresh, so the cached list does not contain it.
  const before = [client("a", 2)];

  const after = clientsAfterSiteBinned(before, "c-created-elsewhere");

  assert.deepEqual(counts(after), [["a", 2]]);
  // Positive control: an id the list DOES contain is decremented, so the above
  // is "unknown id" and not "decrements nothing".
  assert.deepEqual(counts(clientsAfterSiteBinned(before, "a")), [["a", 1]]);
});

test("refiling a site moves one site from the old client's count to the new one's", () => {
  const before = [client("a", 3), client("b", 1)];

  const after = clientsAfterSiteRefiled(before, "a", "b");

  assert.deepEqual(counts(after), [
    ["a", 2],
    ["b", 2],
  ]);
  // The total is conserved, which is the property the two halves share and the
  // one a single-sided bug would break.
  assert.equal(
    after.reduce((n, c) => n + c.siteCount, 0),
    4
  );
});

test("filing a previously unfiled site only increments, and unfiling only decrements", () => {
  const before = [client("a", 3), client("b", 1)];

  assert.deepEqual(counts(clientsAfterSiteRefiled(before, null, "b")), [
    ["a", 3],
    ["b", 2],
  ]);
  assert.deepEqual(counts(clientsAfterSiteRefiled(before, "a", null)), [
    ["a", 2],
    ["b", 1],
  ]);
});

test("re-selecting the client a site is already filed under does not touch the count", () => {
  // The provider used to guard this at the call site. It is guarded here now
  // because the clamp makes +1 and -1 non-commutative at zero: a client at 0
  // re-selected would come back as 1 if the decrement clamped first.
  const before = [client("a", 0), client("b", 2)];

  assert.equal(clientsAfterSiteRefiled(before, "a", "a"), before);
  assert.equal(clientsAfterSiteRefiled(before, null, null), before);
  // Positive control: a genuine move off "a" at zero still clamps.
  assert.deepEqual(counts(clientsAfterSiteRefiled(before, "a", "b")), [
    ["a", 0],
    ["b", 3],
  ]);
});
