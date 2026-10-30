import type { Client, Site } from "@/lib/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  GROUPING SITES UNDER CLIENTS — THE PORTAL'S COPY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The rule itself is in the marked region below and is byte-identical to
 * apps/mobile/lib/site-grouping.ts, which carries the long explanation of why
 * an unknown client id keeps its own group instead of falling into "Unfiled".
 * `assert_shared_logic_copies` in Projects/scripts/ci.sh diffs the two regions,
 * so editing one without the other fails the build.
 *
 * WHAT IS THE PORTAL'S OWN AND WHAT IS SHARED
 *
 * Shared: the grouping, the sort, the unfiled sentinel, and the
 * heading-suppression rule. Those have to agree, because a site that reads as
 * filed on the phone and unfiled in the portal is a filing product that
 * contradicts itself.
 *
 * The portal's own: the `Site` and `Client` types, imported from lib/api rather
 * than from a mobile module. They are structurally compatible in the fields
 * this uses (`clientId`, `client`, `id`, `name`) — which is what makes the
 * identical region compile in both packages — and the diff in ci.sh would fail
 * if somebody "fixed" that by rewriting the body on one side.
 *
 * THE HONEST LIMIT, stated because the portal has no test harness at all
 * (41 files, zero tests — the cost-out in workstream 8): the mobile copy is
 * covered by eight tests in apps/mobile/lib/site-grouping.test.ts, including
 * the unknown-client case proved red-on-revert. THIS copy is covered by those
 * tests only transitively, through the ci.sh byte-diff: the diff proves the two
 * bodies are the same text, and the mobile tests prove that text is right. It
 * does not prove the portal renders the result correctly.
 */

// SHARED-LOGIC-BEGIN
/**
 * The key and heading for sites filed under nobody.
 *
 * A SENTINEL rather than `null` as the key because these keys go into
 * SectionList's `keyExtractor` and React's `key`, which stringify whatever they
 * are given — `null` and the string "null" would collide with a client whose id
 * were literally "null", and more practically a null key is the kind of thing
 * that reads as "no key" to the next person. The double underscores make it
 * unmistakably not an id.
 */
export const UNFILED_GROUP_KEY = "__unfiled__";
export const UNFILED_GROUP_TITLE = "Unfiled";

export interface SiteGroup {
  /** Stable list key: the client's id, or UNFILED_GROUP_KEY. */
  key: string;
  /** The heading. A client's canonical name, or "Unfiled". */
  title: string;
  /** Null for the unfiled group. */
  clientId: string | null;
  /** The sites, in the order they arrived. */
  data: Site[];
}

/**
 * Group sites under their clients, with the unfiled ones last.
 *
 * THE CASE THIS GETS RIGHT AND THE OBVIOUS VERSION GETS WRONG
 *
 * A site can carry a `clientId` for a client that is not in `clients`. That is
 * not a corrupt state and it is not rare: `refresh()` swallows a failed
 * GET /clients (deliberately — see apps/mobile/lib/data-context.tsx), another
 * device can delete a client between two fetches, and a cached site list
 * outlives a cached client list. The obvious implementation looks the id up,
 * finds nothing, and
 * drops the site into "Unfiled" — which tells the person their filing has been
 * lost when it has not.
 *
 * So an unknown id keeps its own group and takes the heading from the site's
 * own `client` label, which the API writes to the client's canonical name on
 * every filing for exactly this reason. Only a site with no `clientId` at all
 * is unfiled.
 *
 * Headings sort by name, case-insensitively, matching GET /clients. "Unfiled"
 * is always last and never sorted into the alphabet, because it is not a name.
 * Clients with no sites do not appear at all — this is a list of sites, and an
 * empty heading in it would be a client list drawn in the wrong place. They are
 * on the clients screen, with their site count.
 */
export function groupSitesByClient(
  sites: Site[],
  clients: ReadonlyArray<Pick<Client, "id" | "name">>
): SiteGroup[] {
  const namesById = new Map(clients.map((c) => [c.id, c.name]));
  const filed = new Map<string, SiteGroup>();
  const unfiled: Site[] = [];

  for (const site of sites) {
    const clientId = site.clientId ?? null;
    if (clientId === null) {
      unfiled.push(site);
      continue;
    }
    const existing = filed.get(clientId);
    if (existing) {
      existing.data.push(site);
      continue;
    }
    filed.set(clientId, {
      key: clientId,
      // The client list first, then the site's own label, then the id. The last
      // fallback is reachable only for a site filed under an unknown client
      // whose label is also empty, which is a pre-032 row that was somehow
      // filed; an id is ugly but it is true, and an empty heading would read as
      // a rendering bug.
      title: namesById.get(clientId) || site.client || clientId,
      clientId,
      data: [site],
    });
  }

  const groups = [...filed.values()].sort((a, b) =>
    a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
  );
  if (unfiled.length > 0) {
    groups.push({ key: UNFILED_GROUP_KEY, title: UNFILED_GROUP_TITLE, clientId: null, data: unfiled });
  }
  return groups;
}

/**
 * Whether the list should draw headings at all.
 *
 * False in exactly one case: everything is unfiled, so the only heading would
 * be "Unfiled" over the whole list — a label that says nothing and makes a
 * company that has not started filing look like it has a problem. Any filed
 * site, and the headings appear, "Unfiled" included, because then the
 * distinction is real and hiding it is what loses sites.
 *
 * In this module rather than in the screen so it is covered by the same tests
 * as the grouping it belongs to.
 */
export function shouldShowGroupHeadings(groups: ReadonlyArray<SiteGroup>): boolean {
  if (groups.length === 0) return false;
  return !(groups.length === 1 && groups[0].clientId === null);
}
// SHARED-LOGIC-END
