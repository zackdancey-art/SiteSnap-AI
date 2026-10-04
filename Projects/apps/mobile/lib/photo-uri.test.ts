import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canonicalUploadPathFromResponse,
  UploadAddressMissingError,
} from "@/lib/photo-uri";

/**
 * The upload response contract.
 *
 * These exist because of a specific defect: the mapping from an upload
 * response to a photograph's address used to be an inline expression with two
 * fallbacks, the second of which produced the empty string. A 200 with no
 * `url` therefore marked the photograph uploaded, at an address of "", and
 * emitted nothing — a record asserting it held evidence it did not hold.
 *
 * Note what this file does and does not cover. It covers the RESPONSE
 * MAPPING — the branch the defect lived in — because that is pure and can be
 * driven directly. It does not cover `uploadPhotoOnce`'s surrounding network
 * call, React Native's multipart serialisation, or whether bytes reach S3;
 * those sit behind the dependency seam the drain tests inject through, and
 * closing them needs a stub HTTP server and an extraction out of
 * `data-context.tsx`. Said plainly here so the coverage is not mistaken for
 * more than it is.
 */

const PHOTO_ID = "photo-7";

test("a canonical relative path is returned unchanged", () => {
  const path = canonicalUploadPathFromResponse("/api/uploads/1736-ab12/photo-7.jpg", PHOTO_ID);
  assert.equal(path, "/api/uploads/1736-ab12/photo-7.jpg");
});

test("an absolute, signed URL is reduced to the canonical path", () => {
  // Signatures expire, so what gets stored must never be the signed form.
  const path = canonicalUploadPathFromResponse(
    "https://api.example.test/api/uploads/1736-ab12/photo-7.jpg?sig=abc&exp=123",
    PHOTO_ID
  );
  assert.equal(path, "/api/uploads/1736-ab12/photo-7.jpg");
  assert.doesNotMatch(path, /sig=|exp=/);
  // Positive control for that negative: the signing params were really there.
  assert.match("https://api.example.test/api/uploads/x/y.jpg?sig=abc&exp=123", /sig=/);
});

test("a response with no address throws instead of returning an empty path", () => {
  // The defect, stated as a test. Each of these used to yield "".
  for (const absent of [undefined, null, "", "   "]) {
    assert.throws(
      () => canonicalUploadPathFromResponse(absent, PHOTO_ID),
      UploadAddressMissingError,
      `${JSON.stringify(absent)} must not pass as an address`
    );
  }
  // Positive control: the same call with a real address does not throw, so the
  // assertions above are testing the guard rather than a broken function.
  assert.equal(
    canonicalUploadPathFromResponse("/api/uploads/1736-ab12/photo-7.jpg", PHOTO_ID),
    "/api/uploads/1736-ab12/photo-7.jpg"
  );
});

test("an address that is not one of ours throws", () => {
  const notOurs = [
    "file:///var/mobile/Containers/Data/Application/x/Library/Caches/sitesnap-queued-7.jpg",
    "https://api.example.test/healthz",
    "/api/upload/1736-ab12/photo-7.jpg",
    "data:image/jpeg;base64,AAAA",
  ];
  for (const url of notOurs) {
    assert.throws(
      () => canonicalUploadPathFromResponse(url, PHOTO_ID),
      UploadAddressMissingError,
      `${url} must not pass as an upload address`
    );
  }
  assert.equal(
    canonicalUploadPathFromResponse("/api/uploads/1736-ab12/photo-7.jpg", PHOTO_ID),
    "/api/uploads/1736-ab12/photo-7.jpg"
  );
});

test("a non-string address throws rather than being coerced", () => {
  for (const value of [0, 1, true, {}, [], { url: "/api/uploads/a/b.jpg" }]) {
    assert.throws(
      () => canonicalUploadPathFromResponse(value, PHOTO_ID),
      UploadAddressMissingError,
      `${JSON.stringify(value)} must not pass as an address`
    );
  }
  assert.equal(
    canonicalUploadPathFromResponse("/api/uploads/1736-ab12/photo-7.jpg", PHOTO_ID),
    "/api/uploads/1736-ab12/photo-7.jpg"
  );
});

test("the throw is the typed error, so the retry wrapper can recognise it", () => {
  // uploadPhoto breaks its retry loop on this type specifically: a 200 with no
  // address is not transient, and each retry orphans another object in the
  // bucket. An untyped Error here would silently restore the retries.
  let caught: unknown;
  try {
    canonicalUploadPathFromResponse(undefined, PHOTO_ID);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof UploadAddressMissingError);
  assert.ok(caught instanceof Error, "it must still be an Error for telemetry's cause check");
  assert.equal((caught as Error).name, "UploadAddressMissingError");
  // Positive control: a plain Error is NOT this type, so the instanceof check
  // above discriminates rather than passing for anything thrown.
  assert.ok(!(new Error("something else") instanceof UploadAddressMissingError));
});

test("the message names the photograph and carries no uri", () => {
  // sync-telemetry-redaction transmits a cause's message when there is no HTTP
  // status, and this error has none — so the message reaches Sentry. A media
  // uri can carry ?sig= and ?exp=, two hours of read access to site evidence,
  // and the report has no field for a uri precisely so one cannot travel. The
  // message must not reintroduce it.
  const offending = "https://api.example.test/api/uploads/1736-ab12/photo-7.jpg?sig=secret&exp=9";
  let message = "";
  try {
    canonicalUploadPathFromResponse(offending.replace("/api/uploads/", "/nope/"), PHOTO_ID);
  } catch (err) {
    message = (err as Error).message;
  }
  assert.match(message, /photo-7/, "the photograph's id is what makes it investigable");
  assert.doesNotMatch(message, /sig=|exp=|https?:|file:/);
  // Positive control for that negative: the value withheld really did contain
  // the things asserted absent, so this is not passing on an empty haystack.
  assert.ok(message.length > 20);
  assert.match(offending, /sig=secret/);
});

test("a photograph with no id still produces a readable message", () => {
  let message = "";
  try {
    canonicalUploadPathFromResponse(undefined, undefined);
  } catch (err) {
    message = (err as Error).message;
  }
  assert.doesNotMatch(message, /undefined|\[object/);
  assert.ok(message.length > 20, message);
});
