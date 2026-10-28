import { QueuedOp, isFailedOp } from "@/lib/offline-queue";

/**
 * Per-entry sync state, derived from the offline queue — AUDIT L37.
 *
 * WHAT L37 ACTUALLY ASKS FOR
 *
 * L37 was closed halfway by the sites-list banner and the Settings Offline Sync
 * screen. Its disposition names the remaining half and says why it is the more
 * useful one: "the question a person actually asks is 'has *this* entry
 * arrived', not 'is anything pending'". A count of outstanding ops cannot answer
 * that question for the entry the person is looking at.
 *
 * WHY THIS IS DERIVED FROM THE QUEUE AND NOT FROM `entry.isPending`
 *
 * `Entry.isPending` already exists and looks like the obvious source. It is not
 * usable, and the reason is worth writing down so nobody reaches for it again.
 * It is set once, in data-context's addEntry network-error branch, on the
 * optimistic entry it builds. Nothing ever clears it: `runDrain` dequeues a
 * successful op (offline-drain.ts) and never touches the entry, and the flag
 * survives in the local cache until a full `refresh()` happens to replace that
 * entry with the server's copy. So between a successful sync and the next
 * bootstrap, `isPending` is true on an entry that has already arrived.
 *
 * An indicator built on it would therefore say "waiting to send" about entries
 * that are safely on the server — and a sync indicator that cries wolf is worse
 * than none, because the next one that is telling the truth gets ignored too.
 *
 * The queue cannot go stale in that direction. An op leaves the queue exactly
 * when the server has accepted it, so an entry stops being listed here at the
 * moment it arrives, with no bookkeeping to forget.
 *
 * WHICH WAY TO BE WRONG
 *
 * Unlike the photograph retention pass, where over-collecting costs disk and
 * under-collecting destroys evidence, here:
 *
 *   - marking an arrived entry "not sent" is a false alarm — the user checks
 *     the Offline Sync screen, finds nothing outstanding, and is mildly
 *     misled;
 *   - marking an unsent entry "sent" is L28 and L37 all over again — it is the
 *     precise signal that made "it looks saved" unreliable, and the one thing
 *     this indicator exists to stop.
 *
 * So the bias is toward reporting unsent, and the unknown-op-type fallback
 * below is deliberately over-inclusive.
 */
export type EntrySyncState = "pending" | "failed";

/** Entry id → state. An id ABSENT from the map has reached the server. */
export type EntrySyncStates = Record<string, EntrySyncState>;

/**
 * The entry id an op is about, or null for an op that is not about an entry.
 *
 * Switched on the op type rather than guessed, because the three entry op types
 * carry the id in three different places — `addEntry` queues the whole Entry,
 * `updateEntry` queues `{ id, patch }`, and `deleteEntry` queues the bare id
 * string (offline-drain.ts reads them in exactly those shapes).
 *
 * The default branch is the forward guard. AUDIT L38 is that offline edits and
 * deletes are not queued yet; when they are, new op types arrive, and an op type
 * this function has never heard of must not silently read as "that entry is
 * safely on the server". So an unrecognised type still yields an id if its
 * payload carries a plausible one. That over-collects — `addSite` payloads have
 * an `id` too — and that is accepted: a site id in a map only ever looked up by
 * entry id matches nothing, whereas a missed entry id is a false "sent".
 */
function entryIdOf(op: QueuedOp): string | null {
  const payload = op.payload;
  const idFrom = (value: unknown): string | null => {
    if (typeof value === "string") return value.trim() || null;
    if (value && typeof value === "object") {
      const candidate = (value as { id?: unknown }).id;
      if (typeof candidate === "string") return candidate.trim() || null;
    }
    return null;
  };

  switch (op.type) {
    case "addEntry":
    case "updateEntry":
      return idFrom(payload);
    case "deleteEntry":
      return idFrom(payload);
    case "addSite":
    case "deleteSite":
      return null;
    default:
      return idFrom(payload);
  }
}

/**
 * Folds the whole queue into a per-entry verdict.
 *
 * Failed beats pending when both touch the same entry. "This did not send" is
 * both the more urgent thing to say and the safer way to be wrong: a person
 * shown "waiting" about work the server has already refused waits for a sync
 * that will never come, and the retry control they need is on the failed path.
 */
export function entrySyncStatesFromQueue(ops: readonly QueuedOp[]): EntrySyncStates {
  const states: EntrySyncStates = {};
  for (const op of ops) {
    const entryId = entryIdOf(op);
    if (!entryId) continue;
    if (isFailedOp(op)) {
      states[entryId] = "failed";
      continue;
    }
    if (states[entryId] !== "failed") states[entryId] = "pending";
  }
  return states;
}

/** How the state reads on a badge. Absent from the map means it arrived. */
export function describeEntrySyncState(state: EntrySyncState | undefined): string | null {
  if (state === "failed") return "Not sent";
  if (state === "pending") return "Waiting to send";
  return null;
}
