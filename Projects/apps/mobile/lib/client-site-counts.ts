import type { Client } from "./types";

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE PHONE'S LOCAL `siteCount` ARITHMETIC. ONE TESTABLE PLACE.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS IS NOT INSIDE THE PROVIDER
 *
 * Same reason as `lib/site-grouping.ts`, `lib/permissions.ts` and
 * `lib/offline-drain.ts`: there is no simulator and no device attached to this
 * environment, so a rule written inside a hook in `lib/data-context.tsx` could
 * only be verified by reading it — and `data-context.tsx` has no test file at
 * all, because it imports react-native and expo-router transitively and cannot
 * be loaded by `node --test`. This module imports a type and nothing else, so
 * `lib/client-site-counts.test.ts` can drive every case: the client missing
 * from the cached list, a count already at zero, an unfiled site, and the two
 * directions of a refile.
 *
 * WHAT THE NUMBER IS
 *
 * `siteCount` is not stored. `GET /clients` recomputes it from one GROUP BY on
 * every read (see the note on `Client` in `lib/types.ts`), so everything here
 * is a local anticipation of what the next refresh will say — never the
 * authority. Two screens quote it: the clients list, and the delete
 * confirmation that tells a user how many sites are about to be unfiled.
 *
 * WHY IT IS ADJUSTED LOCALLY RATHER THAN REFETCHED
 *
 * Binning a site and filing a site are both local prunes/patches in the
 * provider — the site lists are updated in place, without a round trip. A
 * refetch of `GET /clients` on either would make the action slower than it is
 * now, for a number that is already derivable from the act just performed.
 * `restoreSite` is the exception and deliberately calls `refresh()`, because
 * restoring brings entries and diaries back too; it needs nothing from here.
 *
 * AUDIT L114. The server half of that finding was a GROUP BY that counted
 * binned sites; this is the phone half, where the cached `siteCount` was never
 * adjusted when a site was binned, so the clients screen kept showing the
 * pre-delete number even after the server's count was corrected.
 */

/**
 * Add `delta` to one client's count, clamped at zero, leaving every other
 * client untouched and returning a new array.
 *
 * The clamp is not defensive noise: the local number CAN legitimately be
 * behind the server's, because another device or the portal may have filed a
 * site under this client since this phone's last refresh. Showing one too few
 * for a few seconds beats showing `-1`, which is not a number of sites.
 *
 * A `clientId` the cached list does not contain is a no-op rather than an
 * error, for the same reason: a client created elsewhere since the last
 * refresh is absent here, and the next refresh will carry both the client and
 * its correct count.
 */
function withCountDelta(clients: Client[], clientId: string, delta: number): Client[] {
  return clients.map((c) =>
    c.id === clientId ? { ...c, siteCount: Math.max(0, (c.siteCount ?? 0) + delta) } : c
  );
}

/**
 * The client list as it should read after a site filed under `binnedClientId`
 * has been binned.
 *
 * `null` — a site that was not filed under any client — returns the list
 * unchanged and identical by reference, so the caller can hand the result
 * straight to its setter without a needless re-render.
 */
export function clientsAfterSiteBinned(
  clients: Client[],
  binnedClientId: string | null
): Client[] {
  if (!binnedClientId) return clients;
  return withCountDelta(clients, binnedClientId, -1);
}

/**
 * The client list as it should read after a site moved from one client's
 * filing to another's. Either end may be `null`: filing a previously unfiled
 * site, or unfiling it.
 *
 * `from === to` is the case the provider used to guard at the call site, and
 * it is handled here instead: a PATCH that does not change the filing — the
 * same client re-selected — must not increment and decrement the same count,
 * because the clamp makes those two operations non-commutative at zero.
 */
export function clientsAfterSiteRefiled(
  clients: Client[],
  from: string | null,
  to: string | null
): Client[] {
  if (from === to) return clients;
  let next = clients;
  if (to) next = withCountDelta(next, to, 1);
  if (from) next = withCountDelta(next, from, -1);
  return next;
}
