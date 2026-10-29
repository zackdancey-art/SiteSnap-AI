import { test } from "node:test";
import assert from "node:assert/strict";
import {
  UNFILED_GROUP_KEY,
  UNFILED_GROUP_TITLE,
  groupSitesByClient,
  shouldShowGroupHeadings,
} from "./site-grouping";
import type { Site } from "./types";

/**
 * WHY THESE TESTS EXIST AT ALL
 *
 * There is no simulator and no device attached to this environment, so for the
 * site list's grouping this file is the only verification available — which is
 * why the rule lives in a module with no react-native import rather than inside
 * the screen. Same arrangement, and same reason, as lib/permissions.test.ts.
 *
 * The RENDERING still has to be checked by hand on a device; that is in the
 * PR's device checklist, stated as unverified.
 */

function site(id: string, clientId: string | null, client = ""): Site {
  return {
    id,
    name: `Site ${id}`,
    address: "1 Example Street",
    client,
    clientId,
    // Required on Site since PR 2, and "" here on purpose: grouping does not
    // read it, so a real value would suggest it does.
    jobNumber: "",
    startDate: "2026-01-05",
    status: "active",
    createdAt: "2026-01-05T00:00:00.000Z",
  };
}

const ACME = { id: "c-acme", name: "Acme Construction" };
const BRIDGE = { id: "c-bridge", name: "bridgeworks" };

test("sites group under their clients, and the unfiled ones are visible at the end", () => {
  const groups = groupSitesByClient(
    [site("1", ACME.id), site("2", null), site("3", BRIDGE.id), site("4", ACME.id)],
    [ACME, BRIDGE]
  );

  // Alphabetical, case-insensitively — "bridgeworks" lowercase must still sort
  // after "Acme", which a plain localeCompare without sensitivity does not
  // guarantee across locales.
  assert.deepEqual(
    groups.map((g) => g.title),
    ["Acme Construction", "bridgeworks", UNFILED_GROUP_TITLE]
  );

  // THE POSITIVE CONTROL ON THE WHOLE FEATURE: every site put in, exactly once,
  // somewhere. A grouping that silently drops a site is the failure that
  // matters here, and it is invisible in an assertion about headings.
  assert.deepEqual(
    groups.flatMap((g) => g.data.map((s) => s.id)).sort(),
    ["1", "2", "3", "4"]
  );
  assert.deepEqual(groups[0].data.map((s) => s.id), ["1", "4"], "order within a group is the order given");
  assert.deepEqual(groups[2].data.map((s) => s.id), ["2"]);
  assert.equal(groups[2].key, UNFILED_GROUP_KEY);
  assert.equal(groups[2].clientId, null);
  assert.equal(groups[0].clientId, ACME.id, "a filed group carries the id, so filing from the list is possible");
});

test("a site filed under a client the list has not got keeps its own group, and is NOT reported as unfiled", () => {
  // The case this module exists for. GET /clients failing is swallowed by
  // refresh() on purpose, another device can delete a client between two
  // fetches, and the cached site list outlives the cached client list. Dropping
  // such a site into "Unfiled" tells somebody their filing has been lost when
  // it has not.
  const groups = groupSitesByClient(
    [site("1", "c-gone", "Riverside Developments"), site("2", null)],
    [] // no clients known at all
  );

  assert.deepEqual(groups.map((g) => g.title), ["Riverside Developments", UNFILED_GROUP_TITLE]);
  assert.equal(groups[0].clientId, "c-gone", "it is still filed, and still filed under that id");
  assert.deepEqual(groups[0].data.map((s) => s.id), ["1"]);

  // The control that makes the above mean something: the genuinely unfiled site
  // IS in the unfiled group. Without it, a function that put everything in its
  // own group would pass the assertions above.
  assert.deepEqual(groups[1].data.map((s) => s.id), ["2"]);
  assert.equal(groups[1].clientId, null);
});

test("the client list wins over the stale label a site is carrying", () => {
  // Filing writes the client's canonical name into `site.client`, but a renamed
  // client leaves every one of its sites carrying the old spelling until the
  // next fetch of /projects/bootstrap. The heading must come from the client.
  const groups = groupSitesByClient([site("1", ACME.id, "Acme Constructions Pty")], [ACME]);
  assert.deepEqual(groups.map((g) => g.title), ["Acme Construction"]);
});

test("a filed site with no label and no known client is headed by its id, not by nothing", () => {
  // Reachable for a pre-032 row that was somehow filed. An id is ugly and true;
  // an empty heading reads as a rendering fault and a missing group loses the
  // site.
  const groups = groupSitesByClient([site("1", "c-mystery", "")], []);
  assert.deepEqual(groups.map((g) => g.title), ["c-mystery"]);
  assert.deepEqual(groups[0].data.map((s) => s.id), ["1"]);
});

test("clients with no sites do not appear in the site list", () => {
  // This is a list of sites. An empty heading in it is a client list drawn in
  // the wrong place; the clients screen is where a client with no sites belongs,
  // and it shows the count.
  const groups = groupSitesByClient([site("1", null)], [ACME, BRIDGE]);
  assert.deepEqual(groups.map((g) => g.title), [UNFILED_GROUP_TITLE]);
});

test("an empty list produces no groups, and no headings", () => {
  assert.deepEqual(groupSitesByClient([], [ACME]), []);
  assert.equal(shouldShowGroupHeadings([]), false);
});

test("the lone Unfiled heading is suppressed, and any real filing brings headings back", () => {
  // A company that has not started filing must not be shown one heading reading
  // "Unfiled" over its entire list.
  const nothingFiled = groupSitesByClient([site("1", null), site("2", null)], []);
  assert.equal(nothingFiled.length, 1);
  assert.equal(shouldShowGroupHeadings(nothingFiled), false);

  // The control, and the half that actually matters: as soon as one site is
  // filed, the headings appear AND the unfiled group keeps its own. A rule
  // written as "hide the heading when there is one group" would pass the line
  // above and hide the heading on a company with one client and nothing
  // unfiled, which is the opposite of the feature.
  const someFiled = groupSitesByClient([site("1", ACME.id), site("2", null)], [ACME]);
  assert.equal(shouldShowGroupHeadings(someFiled), true);
  assert.deepEqual(someFiled.map((g) => g.title), ["Acme Construction", UNFILED_GROUP_TITLE]);

  const allFiledUnderOne = groupSitesByClient([site("1", ACME.id)], [ACME]);
  assert.equal(
    shouldShowGroupHeadings(allFiledUnderOne),
    true,
    "one client and nothing unfiled still gets its heading — that heading is information"
  );
});

test("a site whose clientId is absent entirely reads as unfiled, like an explicit null", () => {
  // `clientId` is optional on Site because a site cached by a build from before
  // migration 032 has no such key. undefined and null must not group apart —
  // that would split one client's sites across two identical-looking groups.
  const withoutKey = { ...site("1", null) } as Site;
  delete (withoutKey as { clientId?: string | null }).clientId;
  const groups = groupSitesByClient([withoutKey, site("2", null)], []);
  assert.equal(groups.length, 1, "undefined and null are the same group");
  assert.deepEqual(groups[0].data.map((s) => s.id), ["1", "2"]);
  assert.equal(groups[0].clientId, null);
});
