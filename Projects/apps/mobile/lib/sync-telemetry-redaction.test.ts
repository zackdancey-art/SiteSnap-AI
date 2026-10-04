import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeSyncFailure,
  mayTransmitCause,
  transmittableDetail,
  transmittablePayload,
  type SyncFailureReport,
} from "./sync-telemetry-redaction";

/**
 * What leaves the device when offline sync fails.
 *
 * These tests exist because "no personal content in the telemetry payload" is
 * a claim about an external service, and the only honest way to make it is to
 * assert over the whole transmitted object rather than to read the call site
 * and agree with it. `transmittablePayload` returns exactly what is sent, so
 * these assertions cover all of it — including any field a later change adds.
 */

/** The kind of content that must never leave: a real entry's worth of it. */
const CONTENT = {
  notes: "Slab pour, grid C3–C7. Pump truck on site 0630. Foreman: Dave Nguyen.",
  address: "12 Kerrs Road, Lidcombe NSW 2141",
  email: "site.manager@example.com",
  caption: "Crack in the slab near the northeast column",
  base64: "/9j/4AAQSkZJRgABAQAAAQABAAD",
  signedUri:
    "https://api.example.com/api/uploads/up-1/photo-1.jpg?sig=4f3c1b9a8e7d6c5b&exp=1764812345",
};

function serialise(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

test("the transmitted payload carries identifiers and counts", () => {
  const payload = transmittablePayload({
    kind: "queued-op-dead-lettered",
    opType: "addEntry",
    opId: "1764800000000-ab12c",
    stage: "request",
    status: 422,
    photoCount: 4,
    photosUploaded: 4,
    attempts: 2,
  });

  // Positive control: the payload must actually be populated, or every negative
  // assertion below it would pass over an empty object.
  assert.equal(payload.opType, "addEntry");
  assert.equal(payload.opId, "1764800000000-ab12c");
  assert.equal(payload.status, 422);
  assert.equal(payload.photoCount, 4);
  assert.equal(payload.photosUploaded, 4);
  assert.equal(payload.attempts, 2);
  assert.equal(payload.stage, "request");
  assert.match(String(payload.message), /refused by the server \(422\)/);
});

test("a server's own wording is withheld, and ours is not", () => {
  const fromServer: SyncFailureReport = {
    kind: "queued-op-dead-lettered",
    opType: "addEntry",
    status: 422,
    cause: Object.assign(new Error(`notes must be shorter: "${CONTENT.notes}"`), { status: 422 }),
  };
  assert.equal(
    transmittableDetail(fromServer),
    undefined,
    "a message off a server response may quote back what was typed, so it must not travel"
  );
  assert.equal(mayTransmitCause(fromServer), false, "nor may the Error itself be the exception");
  assert.doesNotMatch(serialise(transmittablePayload(fromServer)), /Slab pour/);

  // The other direction, in the same test: a message this app wrote must
  // survive, or the rule above would be indistinguishable from sending nothing.
  const fromApp: SyncFailureReport = {
    kind: "queued-photo-upload-failed",
    opType: "addEntry",
    cause: new Error("Authentication is required to upload photos."),
  };
  assert.equal(transmittableDetail(fromApp), "Authentication is required to upload photos.");
  assert.equal(mayTransmitCause(fromApp), true);
  assert.match(serialise(transmittablePayload(fromApp)), /Authentication is required/);
});

test("no entered content reaches the payload, whatever a caller puts in the cause", () => {
  // A caller doing the worst thing available to it: stuffing an entry's content
  // into the one free-text field the report has.
  const reports: SyncFailureReport[] = [
    {
      kind: "queued-op-dead-lettered",
      opType: "addEntry",
      opId: "op-1",
      status: 400,
      photoCount: 2,
      cause: Object.assign(
        new Error(
          `${CONTENT.notes} ${CONTENT.address} ${CONTENT.email} ${CONTENT.caption} ${CONTENT.base64}`
        ),
        { status: 400 }
      ),
    },
    {
      kind: "queued-photo-upload-failed",
      opType: "addEntry",
      opId: "op-1",
      photoId: "photo-2",
      status: 413,
      cause: Object.assign(new Error(CONTENT.signedUri), { status: 413 }),
    },
    {
      kind: "queued-photo-bytes-missing",
      opType: "addEntry",
      opId: "op-1",
      photoId: "photo-3",
    },
  ];

  for (const report of reports) {
    const serialised = serialise(transmittablePayload(report));

    // Positive control per report: something was serialised, and it identifies
    // the failure. Without this the loop would pass over three empty strings.
    assert.match(serialised, /"kind":"queued-/, `nothing was serialised for ${report.kind}`);
    assert.ok(serialised.length > 40, `payload for ${report.kind} is suspiciously empty`);

    assert.doesNotMatch(serialised, /Slab pour|Dave Nguyen/, "note text must not travel");
    assert.doesNotMatch(serialised, /Kerrs Road|Lidcombe/, "an address must not travel");
    assert.doesNotMatch(serialised, /@example\.com/, "an email address must not travel");
    assert.doesNotMatch(serialised, /Crack in the slab/, "a caption must not travel");
    assert.doesNotMatch(serialised, /\/9j\/4AAQ/, "photograph bytes must not travel");

    // The rule carried over from the logger fix, asserted rather than assumed.
    assert.doesNotMatch(serialised, /sig=/, "a media signature must never reach telemetry");
    assert.doesNotMatch(serialised, /exp=/, "nor its expiry");
  }
});

test("every kind produces a readable, app-authored title", () => {
  const kinds: SyncFailureReport["kind"][] = [
    "queued-op-dead-lettered",
    "queued-photo-upload-failed",
    "queued-photo-bytes-missing",
    "photo-upload-address-missing",
  ];
  for (const kind of kinds) {
    const title = describeSyncFailure({ kind, opType: "addEntry" });
    assert.ok(title.length > 10, `${kind} must describe itself`);
    assert.doesNotMatch(title, /undefined|\[object/, `${kind} title is malformed: ${title}`);
  }
});
