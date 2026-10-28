import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_RETENTION_DAYS,
  photoIdsPinnedByQueue,
  planPhotoPayloadRetention,
  type RetentionCandidate,
  type RetentionPolicy,
} from "./photo-payload-retention";

/**
 * What these tests are defending.
 *
 * AUDIT L6 is unbounded growth: the device kept the base64 of every photograph
 * forever. The fix is an eviction policy, and an eviction policy on a
 * compliance product has one way of being catastrophically wrong — dropping a
 * photograph that exists nowhere else. A photograph still sitting in the
 * offline queue is exactly that: `offline-drain.ts` releases the local copy
 * only AFTER the op has left the queue, and `photo-uri.ts` states that on an
 * upload which did not complete "the bytes stay on the device".
 *
 * So the assertion that matters is not "old things are removed" but "unsent
 * things are not", and every test here carries both halves in the same test:
 * something must go AND something must stay. A test that only asserts the
 * survivor passes just as well against a planner that evicts nothing, which is
 * the version of this code that leaves L6 exactly where it was.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-20T09:00:00.000Z");

const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();

const candidate = (
  id: string,
  over: Partial<RetentionCandidate> = {}
): RetentionCandidate => ({ id, savedAt: daysAgo(1), bytes: 1000, ...over });

/** A ceiling a test can actually reach, in place of the 48 MiB product one. */
const tightCeiling: RetentionPolicy = {
  retentionDays: DEFAULT_RETENTION_DAYS,
  maxTotalBytes: 2500,
};

test("a payload past the retention window is evicted, and one inside it is kept", () => {
  const plan = planPhotoPayloadRetention(
    [
      candidate("stale", { savedAt: daysAgo(DEFAULT_RETENTION_DAYS + 1) }),
      candidate("recent", { savedAt: daysAgo(DEFAULT_RETENTION_DAYS - 1) }),
    ],
    [],
    NOW
  );

  assert.deepEqual(plan.evict, ["stale"]);
  // The positive control. Without it this test passes against a planner that
  // evicts everything it is given, which loses the entire backlog.
  assert.equal(plan.evict.includes("recent"), false);
  assert.equal(plan.keptBytes, 1000);
  assert.equal(plan.evictedBytes, 1000);
});

test("an unsent photograph is never aged out, while an identical sent one is", () => {
  // The two candidates differ in ONE respect: whether the queue still holds a
  // reference. Same age, same size, same everything else — so the only
  // explanation for a different outcome is the pin, and the only explanation
  // for the same outcome is that the pin is not being read.
  const stamp = daysAgo(DEFAULT_RETENTION_DAYS * 3);
  const plan = planPhotoPayloadRetention(
    [candidate("queued", { savedAt: stamp }), candidate("sent", { savedAt: stamp })],
    ["queued"],
    NOW
  );

  assert.equal(plan.evict.includes("queued"), false, "an unsent photograph was evicted — it exists nowhere else");
  assert.deepEqual(plan.evict, ["sent"]);
  assert.equal(plan.pinnedBytes, 1000);
});

test("the byte ceiling takes the oldest first and stops as soon as it fits", () => {
  const plan = planPhotoPayloadRetention(
    [
      candidate("oldest", { savedAt: daysAgo(5), bytes: 1000 }),
      candidate("middle", { savedAt: daysAgo(3), bytes: 1000 }),
      candidate("newest", { savedAt: daysAgo(1), bytes: 1000 }),
    ],
    [],
    NOW,
    tightCeiling
  );

  // 3000 over a 2500 ceiling: one payload goes, not two, and it is the oldest.
  assert.deepEqual(plan.evict, ["oldest"]);
  assert.equal(plan.keptBytes, 2000);
  assert.equal(plan.overCeilingAfterPlan, false);
});

test("the ceiling will not drop an unsent photograph, and says the device is still over", () => {
  // Every byte here is unsent. The honest answer is that this device needs to
  // sync, not that it needs a photograph deleted — so the plan keeps all of it
  // and reports the condition instead of resolving it.
  const plan = planPhotoPayloadRetention(
    [
      candidate("queued-a", { bytes: 2000 }),
      candidate("queued-b", { bytes: 2000 }),
      candidate("sent", { bytes: 2000 }),
    ],
    ["queued-a", "queued-b"],
    NOW,
    tightCeiling
  );

  assert.deepEqual(plan.evict, ["sent"], "the one droppable payload was not dropped");
  assert.equal(plan.keptBytes, 4000);
  assert.equal(plan.pinnedBytes, 4000);
  assert.equal(plan.overCeilingAfterPlan, true, "a device held over its ceiling by unsent photographs must say so");
});

test("an undated payload survives the age pass, is stamped instead, and is never both", () => {
  // The pre-upgrade backlog. Reading an absent date as "infinitely old" would
  // empty the device on first launch; the planner starts its clock instead.
  // The dated-stale candidate alongside it is the positive control: the age
  // pass really did run.
  const plan = planPhotoPayloadRetention(
    [
      candidate("legacy", { savedAt: undefined }),
      candidate("stale", { savedAt: daysAgo(DEFAULT_RETENTION_DAYS + 1) }),
    ],
    [],
    NOW
  );

  assert.deepEqual(plan.evict, ["stale"]);
  assert.deepEqual(plan.stamp, ["legacy"]);
});

test("the ceiling reaches for undated payloads before dated ones, and never stamps what it evicts", () => {
  // The other half of the undated reading: unknown age is treated as oldest
  // for the ceiling, because those payloads were written before the clock
  // existed. An id in both lists would mean the map was told to delete a row
  // and date it, so the disjointness is asserted rather than assumed.
  const plan = planPhotoPayloadRetention(
    [
      candidate("legacy-a", { savedAt: undefined, bytes: 1000 }),
      candidate("legacy-b", { savedAt: undefined, bytes: 1000 }),
      candidate("dated", { savedAt: daysAgo(10), bytes: 1000 }),
    ],
    [],
    NOW,
    tightCeiling
  );

  assert.deepEqual(plan.evict, ["legacy-a"]);
  assert.equal(plan.evict.includes("dated"), false, "a dated payload went before an undated one");
  assert.deepEqual(plan.stamp, ["legacy-b"]);
  assert.deepEqual(
    plan.stamp.filter((id) => plan.evict.includes(id)),
    []
  );
});

test("photoIdsPinnedByQueue finds photographs in every shape the queue holds, failed ops included", () => {
  // The four payload shapes that exist today, plus a nested one standing in for
  // the fifth that has not been invented yet. The deletes carry no photograph
  // and are the negative half: they must contribute nothing, or the pinned set
  // would be meaningless.
  const pinned = photoIdsPinnedByQueue([
    { payload: { id: "e1", photos: [{ id: "p-add" }, { id: "p-add-2" }] } },
    { payload: { id: "e2", patch: { photos: [{ id: "p-patch" }] } } },
    { payload: "e3" },
    { payload: { name: "A site" } },
    { payload: { results: [{ item: "x", photos: [{ id: "p-nested" }] }] } },
  ]);

  assert.deepEqual(pinned.sort(), ["p-add", "p-add-2", "p-nested", "p-patch"]);
});

test("a dead-lettered op's photographs are pinned, exactly as a pending op's are", () => {
  // A refused op is KEPT by offline-queue.ts so a person can retry it, and its
  // photographs are the ones the server demonstrably never took. Filtering the
  // pinned set to pending ops would delete precisely the evidence that failed
  // to arrive. Both ops asserted in one test so a collector that returned
  // nothing at all could not pass.
  const pinned = photoIdsPinnedByQueue([
    { payload: { id: "e1", photos: [{ id: "p-pending" }] } },
    { payload: { id: "e2", photos: [{ id: "p-failed" }] } },
  ]);

  assert.deepEqual(pinned.sort(), ["p-failed", "p-pending"]);
});

test("an id with no photographs and a malformed photograph entry are both ignored", () => {
  const pinned = photoIdsPinnedByQueue([
    { payload: { photos: [{ caption: "no id" }, { id: "" }, null, "string", { id: "real" }] } },
    { payload: undefined },
    {},
  ]);

  assert.deepEqual(pinned, ["real"]);
});
