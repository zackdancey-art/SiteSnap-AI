import { test } from "node:test";
import assert from "node:assert/strict";

import { entrySyncStatesFromQueue, describeEntrySyncState } from "./entry-sync-state";
import type { QueuedOp } from "./offline-queue";

/**
 * What these tests defend.
 *
 * The indicator has two ways to be wrong and they are not symmetric. Telling
 * someone an arrived entry is still waiting is a false alarm. Telling someone an
 * unsent entry has arrived is AUDIT L28 and L37 again — it is the exact signal
 * that made "it looks saved" unreliable in the first place, and it is the only
 * reason this module exists.
 *
 * So every test here carries both halves in the same test: the entry that must
 * be reported outstanding, AND an entry in the same queue that must not be. A
 * test asserting only "this one is pending" passes just as well against a
 * function that marks everything, and a test asserting only "this one is
 * absent" passes against a function that marks nothing.
 */

const op = (over: Partial<QueuedOp> & Pick<QueuedOp, "type" | "payload">): QueuedOp => ({
  id: `op-${Math.random().toString(16).slice(2)}`,
  queuedAt: "2026-10-19T00:00:00.000Z",
  ...over,
});

test("a queued addEntry marks its own entry and nothing else", async () => {
  const states = entrySyncStatesFromQueue([
    op({ type: "addEntry", payload: { id: "queued-entry", notes: "pour slab" } }),
  ]);

  assert.equal(states["queued-entry"], "pending");
  // The control that matters: an entry the queue says nothing about must be
  // absent, which is how every caller reads "it arrived".
  assert.equal(states["some-other-entry"], undefined);
  assert.equal(Object.keys(states).length, 1);
});

test("an empty queue reports every entry as arrived", async () => {
  assert.deepEqual(entrySyncStatesFromQueue([]), {});
});

test("a refused op reads as not sent, while a waiting one reads as waiting", async () => {
  // Both in one queue, because the distinction is the whole point: one of these
  // will sync on its own when coverage returns and the other never will.
  const states = entrySyncStatesFromQueue([
    op({ type: "addEntry", payload: { id: "refused" }, status: "failed" }),
    op({ type: "addEntry", payload: { id: "waiting" }, status: "pending" }),
  ]);

  assert.equal(states.refused, "failed");
  assert.equal(states.waiting, "pending");
  assert.equal(describeEntrySyncState(states.refused), "Not sent");
  assert.equal(describeEntrySyncState(states.waiting), "Waiting to send");
});

test("an op with no status reads as waiting, not as arrived", async () => {
  // `QueuedOp.status` was added after ops were already on disk, and its own doc
  // comment says an op from an older build "must read as pending rather than as
  // anything else". Reading an undated op as arrived would quietly tell a user
  // their pre-upgrade backlog had synced.
  const states = entrySyncStatesFromQueue([
    op({ type: "addEntry", payload: { id: "legacy" } }),
    op({ type: "addEntry", payload: { id: "modern" }, status: "pending" }),
  ]);

  assert.equal(states.legacy, "pending", "an op from an older build was read as arrived");
  assert.equal(states.modern, "pending");
});

test("failed wins over pending for the same entry, whichever order they are in", async () => {
  // Asserted in both orders because a fold that simply overwrites would pass one
  // ordering and fail the other, and which order the queue happens to be in is
  // not a property anything guarantees.
  const failedFirst = entrySyncStatesFromQueue([
    op({ type: "addEntry", payload: { id: "e1" }, status: "failed" }),
    op({ type: "updateEntry", payload: { id: "e1", patch: {} }, status: "pending" }),
  ]);
  assert.equal(failedFirst.e1, "failed");

  const pendingFirst = entrySyncStatesFromQueue([
    op({ type: "updateEntry", payload: { id: "e1", patch: {} }, status: "pending" }),
    op({ type: "addEntry", payload: { id: "e1" }, status: "failed" }),
  ]);
  assert.equal(pendingFirst.e1, "failed", "a later pending op downgraded a refusal to a wait");
});

test("all three entry op shapes are read, and site ops mark no entry", async () => {
  // offline-drain.ts reads these three payloads in three different shapes: the
  // whole Entry, { id, patch }, and the bare id string. A shape this function
  // cannot read is an entry reported as arrived while it sits on the phone.
  const states = entrySyncStatesFromQueue([
    op({ type: "addEntry", payload: { id: "added" } }),
    op({ type: "updateEntry", payload: { id: "edited", patch: { notes: "x" } } }),
    op({ type: "deleteEntry", payload: "removed" }),
    // Negative half, same queue: site ops are not entry ops, so neither of
    // these site ids may appear.
    op({ type: "addSite", payload: { id: "site-a", name: "Site A" } }),
    op({ type: "deleteSite", payload: "site-b" }),
  ]);

  assert.equal(states.added, "pending");
  assert.equal(states.edited, "pending");
  assert.equal(states.removed, "pending");
  assert.equal(states["site-a"], undefined, "a queued site was reported as a pending entry");
  assert.equal(states["site-b"], undefined);
});

test("an op type this build has never heard of still reports its entry as unsent", async () => {
  // THE FORWARD GUARD. AUDIT L38 is that offline edits and deletes are not
  // queued yet; closing it adds op types. An op type added later whose entries
  // this function silently skipped would report them as arrived — reintroducing
  // exactly the defect L37 names, in the component built to prevent it.
  const states = entrySyncStatesFromQueue([
    op({ type: "approveTimesheet" as QueuedOp["type"], payload: { id: "future-entry" } }),
    // Negative half: an unknown type whose payload carries no id marks nothing,
    // so the fallback over-collects ids rather than inventing them.
    op({ type: "somethingElse" as QueuedOp["type"], payload: { notes: "no id here" } }),
    op({ type: "andAnother" as QueuedOp["type"], payload: null }),
  ]);

  assert.equal(states["future-entry"], "pending", "a future op type's entry was reported as arrived");
  assert.equal(Object.keys(states).length, 1);
});

test("a blank or non-string id marks nothing", async () => {
  const states = entrySyncStatesFromQueue([
    op({ type: "addEntry", payload: { id: "   " } }),
    op({ type: "addEntry", payload: { id: 42 } }),
    op({ type: "deleteEntry", payload: "" }),
    // Positive control, same queue: a real id in the same batch IS marked, so
    // the three absences above are about the ids and not about the function
    // having stopped working.
    op({ type: "addEntry", payload: { id: "real" } }),
  ]);

  assert.deepEqual(Object.keys(states), ["real"]);
});

test("describeEntrySyncState says nothing about an entry that arrived", async () => {
  // The badge renders on a truthy label, so this returning a string for the
  // arrived state would put a chip on every row in the app.
  assert.equal(describeEntrySyncState(undefined), null);
  assert.equal(describeEntrySyncState("pending"), "Waiting to send");
  assert.equal(describeEntrySyncState("failed"), "Not sent");
});
