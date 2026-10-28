/**
 * Which photograph payloads the device keeps, and which it lets go of.
 *
 * AUDIT L6: `photo-payload-store.ts` persists compressed base64 alongside the
 * S3 copy, per photograph, FOREVER. The only removal path is the entry or
 * photograph being deleted; nothing ages anything out. On a six-month project
 * that is hundreds of megabytes of AsyncStorage on a low-end Android device,
 * and AsyncStorage on Android is a single SQLite row-per-key store that the
 * platform will refuse writes to long before the disk is full. The finding's
 * own prescription is the spec for this module:
 *
 *     "cap payload retention to entries not yet synced + last N days;
 *      hydrate older photos from signed URLs (already implemented)"
 *
 * WHY THIS IS A SEPARATE, PURE MODULE
 *
 * Because it is the half that can be tested. The mobile test suite runs under
 * plain `node --test`; it cannot import a module that reaches AsyncStorage, and
 * it cannot render a screen. The decision — given a map, a pinned set, a clock
 * and a policy, which ids go — is pure, and this is where it lives so that the
 * assertion that matters can actually be made:
 *
 *     AN UNSYNCED PHOTOGRAPH IS NEVER EVICTED.
 *
 * That is not a tidiness rule. A photograph still in the offline queue exists
 * NOWHERE ELSE — the drain releases the local copy only after the op has left
 * the queue (see offline-drain.ts, which cites L6 by name for exactly this).
 * Evicting one is permanent loss of site evidence on a compliance product. So
 * the pinned set is honoured unconditionally, even when honouring it means
 * staying over the byte ceiling, and the plan says so out loud rather than
 * quietly trading a photograph for disk.
 */

/** One payload considered for eviction, described by what the map knows. */
export type RetentionCandidate = {
  id: string;
  /**
   * When the payload was written, ISO 8601.
   *
   * ABSENT ON EVERY PAYLOAD WRITTEN BEFORE THIS MODULE EXISTED. The stored
   * shape was `{ base64, mimeType }` with no clock, so on the first run after
   * an upgrade the entire existing backlog arrives here undated, and its real
   * age is unknowable — it could be this morning's or it could be March's.
   */
  savedAt?: string;
  /**
   * The payload's cost in bytes, MEASURED from the stored string rather than
   * estimated from an image dimension. `base64.length` is the character count
   * of what is actually held in the map and written back out as JSON, which is
   * the number the ceiling is about. It is not the size of the original photo
   * and is not meant to be.
   */
  bytes: number;
};

export type RetentionPolicy = {
  /** Payloads older than this, and not pinned, are let go of. */
  retentionDays: number;
  /** Ceiling on the total kept, enforced oldest-first after the age pass. */
  maxTotalBytes: number;
};

export type RetentionPlan = {
  /** Ids to remove from the map. Never contains a pinned id. */
  evict: string[];
  /**
   * Surviving ids that carry no `savedAt` and need one written.
   *
   * Disjoint from `evict` by construction: an id cannot be both dropped and
   * given a date.
   */
  stamp: string[];
  keptBytes: number;
  evictedBytes: number;
  /** Of `keptBytes`, how much is unsynced and therefore not droppable. */
  pinnedBytes: number;
  /**
   * True when the plan ends STILL over the ceiling, which can only happen
   * because pinned payloads alone exceed it.
   *
   * Surfaced rather than resolved. The honest remedy is a sync, not a deletion,
   * and this is the flag a "you have unsent photographs and this device is
   * full" prompt would be built on.
   */
  overCeilingAfterPlan: boolean;
};

/**
 * Fourteen days.
 *
 * A fortnight covers a two-week pay cycle and a long weekend either side of
 * it, which is the window in which someone actually reopens an entry to check
 * what they photographed. Past that the signed-URL path is the one that gets
 * used anyway.
 *
 * THIS NUMBER IS A JUDGEMENT, NOT A MEASUREMENT. Nothing in this repo records
 * how far back field users scroll, so it is set where a wrong answer is cheap:
 * too short costs a signed-URL round trip on an older photograph, and the
 * photograph is still there.
 */
export const DEFAULT_RETENTION_DAYS = 14;

/**
 * 48 MiB of base64.
 *
 * At the ~0.35 JPEG quality the capture paths use, a payload runs a few hundred
 * kilobytes, so this is a couple of hundred photographs held locally — far more
 * than a fortnight of normal work, and roughly two orders of magnitude below
 * the "hundreds of MB" L6 describes. Also a judgement; also set where being
 * wrong is cheap in the same direction.
 */
export const DEFAULT_MAX_TOTAL_BYTES = 48 * 1024 * 1024;

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  retentionDays: DEFAULT_RETENTION_DAYS,
  maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
};

/** How deep the pinned-id walk will go before it stops looking. */
const MAX_PAYLOAD_DEPTH = 8;

/**
 * Every photograph id mentioned anywhere in a set of queued operations.
 *
 * WHY THIS WALKS THE PAYLOAD INSTEAD OF READING `payload.photos`
 *
 * Because the queue holds four different payload shapes today — an `Entry` for
 * `addEntry`, a `{ id, patch }` pair for `updateEntry`, a bare id string for
 * the deletes — and the shape has changed before. A collector that knows only
 * this week's shape does not fail loudly when a fifth arrives; it returns a
 * short list, and a short pinned list is a deleted photograph. So it looks for
 * `photos` arrays wherever they are, and over-collecting is the safe error:
 * an id pinned that need not be only costs disk until the next pass.
 *
 * Deliberately NOT filtered to pending ops. A dead-lettered op's photographs
 * are precisely the ones the server never took — `offline-queue.ts` keeps a
 * refused op so a person can retry it, and `photo-uri.ts` says plainly that on
 * an upload that did not complete "the bytes stay on the device". Pass the
 * whole queue, failed ops included.
 */
export function photoIdsPinnedByQueue(ops: readonly { payload?: unknown }[]): string[] {
  const pinned = new Set<string>();

  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_PAYLOAD_DEPTH || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item) => walk(item, depth + 1));
      return;
    }
    const record = node as Record<string, unknown>;
    const photos = record.photos;
    if (Array.isArray(photos)) {
      for (const photo of photos) {
        if (photo && typeof photo === "object") {
          const id = (photo as Record<string, unknown>).id;
          if (typeof id === "string" && id) pinned.add(id);
        }
      }
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") walk(value, depth + 1);
    }
  };

  ops.forEach((op) => walk(op.payload, 0));
  return [...pinned];
}

/**
 * Oldest first, with an undated payload counting as older than any dated one.
 *
 * The empty string sorts before every ISO 8601 timestamp, so the pre-upgrade
 * backlog is what the byte ceiling reaches for first. That is the correct
 * reading of an unknown age FOR THE CEILING — those payloads were written
 * before the clock existed, so they are genuinely the oldest things here — and
 * it is the opposite of how the age pass treats them. See the age pass below
 * for why the two differ.
 *
 * Tie-broken by id so the plan is deterministic and a test can pin it.
 */
function oldestFirst(a: RetentionCandidate, b: RetentionCandidate): number {
  const byDate = (a.savedAt ?? "").localeCompare(b.savedAt ?? "");
  return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
}

export function planPhotoPayloadRetention(
  candidates: readonly RetentionCandidate[],
  pinnedIds: readonly string[],
  now: Date,
  policy: RetentionPolicy = DEFAULT_RETENTION_POLICY
): RetentionPlan {
  const pinned = new Set(pinnedIds);
  const cutoff = now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000;

  const evict: RetentionCandidate[] = [];
  const keep: RetentionCandidate[] = [];

  // ── Pass one: age ────────────────────────────────────────────────────────
  //
  // An UNDATED payload survives this pass and is stamped with `now` instead,
  // which starts its clock rather than ending it. The alternative — reading an
  // absent date as "infinitely old" — would delete the device's whole existing
  // backlog on the first launch after the upgrade that introduced this file.
  // Most of that backlog is recoverable from a signed URL, but not provably
  // all of it: AUDIT L39 records that the API accepts a photograph with no
  // storage key at all, so somewhere out there are photographs whose only copy
  // is the local one and whose record cannot say so. Starting the clock gives
  // the ceiling pass immediate relief while costing at most one retention
  // window of disk, and it is the reversible half of the two readings.
  for (const candidate of candidates) {
    if (pinned.has(candidate.id)) {
      keep.push(candidate);
      continue;
    }
    if (candidate.savedAt && Date.parse(candidate.savedAt) < cutoff) {
      evict.push(candidate);
      continue;
    }
    keep.push(candidate);
  }

  // ── Pass two: ceiling ────────────────────────────────────────────────────
  //
  // Age alone does not bound anything: a fortnight of heavy capture on one site
  // is as much disk as six months of light capture. So whatever survived pass
  // one is trimmed oldest-first until it fits — skipping pinned payloads, which
  // are not for trading.
  let keptBytes = keep.reduce((total, candidate) => total + candidate.bytes, 0);
  if (keptBytes > policy.maxTotalBytes) {
    const droppable = keep.filter((candidate) => !pinned.has(candidate.id)).sort(oldestFirst);
    const dropped = new Set<string>();
    for (const candidate of droppable) {
      if (keptBytes <= policy.maxTotalBytes) break;
      dropped.add(candidate.id);
      evict.push(candidate);
      keptBytes -= candidate.bytes;
    }
    if (dropped.size > 0) {
      for (let i = keep.length - 1; i >= 0; i -= 1) {
        if (dropped.has(keep[i].id)) keep.splice(i, 1);
      }
    }
  }

  const pinnedBytes = keep
    .filter((candidate) => pinned.has(candidate.id))
    .reduce((total, candidate) => total + candidate.bytes, 0);

  return {
    evict: evict.map((candidate) => candidate.id),
    stamp: keep.filter((candidate) => !candidate.savedAt).map((candidate) => candidate.id),
    keptBytes,
    evictedBytes: evict.reduce((total, candidate) => total + candidate.bytes, 0),
    pinnedBytes,
    overCeilingAfterPlan: keptBytes > policy.maxTotalBytes,
  };
}
