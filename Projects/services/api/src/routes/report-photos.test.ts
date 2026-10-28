/**
 * What `buildVisionInputs` does with a photograph it cannot use — AUDIT L95,
 * the half that needs no store.
 *
 * Five of the six drop reasons are decided before the uploads table is
 * consulted, so they are measurable here with nothing persisted: a malformed
 * `data:` URL, a photograph carrying neither bytes nor a key, a `storageKey`
 * that yields no upload id, and one that is not in the canonical form. The
 * sixth, `not-owned-by-company`, is the H7 cross-tenant refusal and is the one
 * that must be measured against real Postgres — it is in
 * `storage/report-photos-db.test.ts`.
 *
 * WHY THIS IS NOT AN HTTP TEST. The route reaches `buildVisionInputs` only on
 * the OpenAI path, and a test suite cannot generate a live report
 * deterministically; with no API key the route returns the template before any
 * image is considered. So the function is called directly. The thing being
 * proven is not an HTTP contract, it is that six distinct conditions that used
 * to share one silent `continue` now each produce a counted, named outcome.
 *
 * BOTH CONTROLS IN THE SAME CALL, every time. Each test below puts a usable
 * photograph in the same `buildVisionInputs` call as the unusable ones, because
 * "nothing was attached and three were dropped" is also what deleting the
 * attachment code would produce.
 *
 * RED ON REVERT. Restore `if (!imageUrl) continue;` in place of the reason
 * counting and every assertion on `droppedByReason` goes red while the attached
 * counts stay correct — which is exactly the shape of the defect: the images
 * that worked went on working and the failures said nothing.
 */

process.env.NODE_ENV = "test";
process.env.AUTH_TOKEN_SECRET = "report-photos-route-test-secret";

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildVisionInputs } from "./ai";
import { MAX_REPORT_IMAGES } from "../utils/reportPhotos";

const actor = { companyId: "photos-route-test-company" };

/** A 1x1 transparent GIF, small enough to sit in a test file. */
const TINY_GIF = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const entry = (date: string, photos: Array<Record<string, unknown>>) => ({
  date,
  locationAddress: "4 Payload Parade",
  photos,
});

test("a photograph with no usable image data is counted by reason, not skipped silently — L95", async () => {
  const { content, accounting } = await buildVisionInputs(
    [
      entry("2026-03-02", [
        // POSITIVE CONTROL, in the same call: raw base64 attaches.
        { base64: TINY_GIF, mimeType: "image/gif", caption: "slab" },
        // A `data:` URL with no comma-separated body.
        { base64: "data:image/jpeg;base64", mimeType: "image/jpeg" },
        // Neither bytes nor a key. The old code and the new code both decline
        // it; only the new one says so.
        { caption: "a photograph that never uploaded" },
      ]),
    ],
    actor
  );

  assert.equal(accounting.available, 3);
  assert.equal(accounting.selected, 3, "under the ceiling, every photograph is considered");
  assert.equal(accounting.attached, 1);
  assert.equal(accounting.droppedTotal, 2);
  assert.deepEqual(accounting.droppedByReason, {
    "malformed-data-url": 1,
    "no-image-data": 1,
  });

  // The attachment is real: one image item, and one text item describing it.
  assert.equal(content.filter((item) => item.type === "input_image").length, 1);
  assert.equal(accounting.attached + accounting.droppedTotal, accounting.selected);
});

test("a storage key the server will not read is refused by shape, with the reason kept — L95", async () => {
  const { accounting } = await buildVisionInputs(
    [
      entry("2026-03-03", [
        { base64: TINY_GIF, mimeType: "image/gif" },
        // No upload id extractable at all.
        { storageKey: "uploads/" },
        // An id, but not the canonical `uploads/<id>-<filename>` form. This is
        // the traversal shape H7 refuses, and it is refused before the store is
        // asked anything — which is why it belongs in this file.
        { storageKey: "uploads/1700000000-abc123-x/../../etc/passwd" },
      ]),
    ],
    actor
  );

  assert.equal(accounting.attached, 1, "the usable photograph in the same call still attaches");
  assert.equal(accounting.droppedByReason["unresolvable-storage-key"], 1);
  assert.equal(accounting.droppedByReason["non-canonical-storage-key"], 1);
  // The two are NOT the same code. A client sending the wrong shape and a key
  // that resolves to nothing are different operational problems, and the point
  // of L95's fix is that an operator can tell them apart.
  assert.notEqual(
    accounting.droppedByReason["unresolvable-storage-key"],
    accounting.droppedByReason["non-canonical-storage-key"] + 1
  );
  assert.equal(accounting.droppedTotal, 2);
});

test("the ceiling and the failures are counted separately — L94", async () => {
  // Fourteen days, two photographs each: 28 available, 12 selected, and one of
  // the selected cannot be loaded. The old payload could not express the
  // difference between "capped" and "failed" at all; it reported one number.
  const entries = Array.from({ length: 14 }, (_, i) =>
    entry(`2026-03-${String(i + 1).padStart(2, "0")}`, [
      i === 0
        ? { base64: "data:image/jpeg;base64", mimeType: "image/jpeg" }
        : { base64: TINY_GIF, mimeType: "image/gif" },
      { base64: TINY_GIF, mimeType: "image/gif" },
    ])
  );

  const { content, accounting, attachedByEntry } = await buildVisionInputs(entries, actor);

  assert.equal(accounting.available, 28);
  assert.equal(accounting.ceiling, MAX_REPORT_IMAGES);
  assert.equal(accounting.selected, 12);
  assert.equal(accounting.droppedToCeiling, 16, "capped, not failed");
  assert.equal(accounting.droppedByReason["malformed-data-url"], 1, "failed, not capped");
  assert.equal(accounting.attached, 11);

  // Every photograph recorded is accounted for exactly once. This is the
  // identity L94's payload broke by reporting 12 beside counts summing to 47.
  assert.equal(
    accounting.attached + accounting.droppedToCeiling + accounting.droppedTotal,
    accounting.available
  );

  // The per-entry tally the payload sends agrees with the total — same source,
  // so it cannot drift. The first entry's photograph is the one that failed, so
  // it attached nothing while still having two recorded.
  assert.equal(
    attachedByEntry.reduce((n, c) => n + c, 0),
    accounting.attached
  );
  assert.equal(attachedByEntry[0], 0);

  // And the images the model gets match the count, with the citations naming
  // dates rather than attachment positions.
  assert.equal(content.filter((item) => item.type === "input_image").length, 11);
  const refs = content
    .filter((item) => item.type === "input_text")
    .map((item) => JSON.parse(String((item as { text: string }).text)).imageRef as string);
  assert.equal(refs.length, 11);
  assert.ok(refs.every((ref) => /^2026-03-\d{2} photo \d+$/.test(ref)), refs.join(", "));
  // The selection reaches the end of the window, which is L93.
  assert.ok(refs.some((ref) => ref.startsWith("2026-03-14")), refs.join(", "));
});
