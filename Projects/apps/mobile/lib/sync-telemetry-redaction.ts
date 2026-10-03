import type { QueuedOpType } from "@/lib/offline-queue";

/**
 * What may leave the device when offline sync fails, and what may not.
 *
 * Separated from `sync-telemetry.ts` because that module imports the Sentry SDK
 * and so cannot be loaded by `node --test`. This one imports nothing with a
 * runtime, which means the rule about what is transmittable is testable
 * directly — and the rule is the part worth testing. A claim that no personal
 * content reaches an external service should not rest on reading the code.
 *
 * The rule: identifiers and counts. No photographs, no note text, no addresses,
 * no email. Enforced by the SHAPE of `SyncFailureReport` — it has no field that
 * can hold entered content and no field for a uri at all. The absence of a uri
 * field is deliberate: a displayable media uri carries `?sig=` and `?exp=`, an
 * HMAC granting two hours of read access to site evidence, and the surest way
 * to keep a credential out of a third party is to give its payload nowhere to
 * put one.
 */

export type SyncFailureKind =
  /** A queued op was refused by the server and dead-lettered. AUDIT L30. */
  | "queued-op-dead-lettered"
  /** A photograph on a queued entry could not be uploaded. AUDIT L28. */
  | "queued-photo-upload-failed"
  /**
   * The unrecoverable one: a queued photograph's cache file is gone AND no
   * base64 payload was stored, so there are no bytes left to send anywhere.
   * This should be impossible — `savePhotoPayloads` runs at capture — which is
   * exactly why it must be reported rather than assumed away.
   */
  | "queued-photo-bytes-missing";

export interface SyncFailureReport {
  kind: SyncFailureKind;
  /** Which kind of work it was. Not what was in it. */
  opType?: QueuedOpType;
  /** The queue's own id for the op, so two events can be tied together. */
  opId?: string;
  /** The photograph's id. An identifier, not the photograph. */
  photoId?: string;
  /** Which half of the drain was in flight. */
  stage?: "upload" | "request";
  /** HTTP status, where the server answered. */
  status?: number;
  /** Photographs on the op, and how many are already on the server. */
  photoCount?: number;
  photosUploaded?: number;
  /** Times the server has refused this op. */
  attempts?: number;
  /**
   * The thrown error. Its message is transmitted ONLY where this app wrote it —
   * see `transmittableDetail`. Never put a uri, a caption or a note in here.
   */
  cause?: unknown;
}

/** One line of app-authored text per kind, used as the issue title. */
export function describeSyncFailure(report: SyncFailureReport): string {
  switch (report.kind) {
    case "queued-op-dead-lettered":
      return `Queued ${report.opType ?? "op"} refused by the server${report.status ? ` (${report.status})` : ""}`;
    case "queued-photo-upload-failed":
      return `Queued photograph would not upload${report.status ? ` (${report.status})` : ""}`;
    case "queued-photo-bytes-missing":
      return "Queued photograph has no local bytes left to upload";
  }
}

/**
 * The error's own message, and only where this app wrote it.
 *
 * An error carrying an HTTP `status` came off a server response body. We do not
 * control what a 4xx says, and a validation error is exactly the kind of
 * message that quotes a submitted value back — so for those, only the status
 * travels. An error with no status was constructed in this repository
 * ("Authentication is required to upload photos."), so its message is a string
 * from source and is safe to send.
 *
 * This is the single decision point for that rule. If it is ever widened, the
 * test in `sync-telemetry-redaction.test.ts` is the thing that should have to
 * be argued with first.
 */
export function transmittableDetail(report: SyncFailureReport): string | undefined {
  if (report.status !== undefined) return undefined;
  if (!(report.cause instanceof Error)) return undefined;
  const collapsed = report.cause.message.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > 200 ? `${collapsed.slice(0, 199)}…` : collapsed;
}

/**
 * Whether the caught error itself may be the transmitted exception.
 *
 * Sentry uses the exception's own message as the issue title, so passing a
 * server-originated Error through would transmit the server's wording after
 * `transmittableDetail` had just withheld it. For those, an app-authored Error
 * is synthesised instead; the stack lost is the fetch helper's own.
 */
export function mayTransmitCause(report: SyncFailureReport): boolean {
  return report.status === undefined && report.cause instanceof Error;
}

/**
 * Exactly the fields that are transmitted, as one object.
 *
 * Built here rather than inline at the Sentry call so that what is sent is one
 * function's return value, and a test can assert over all of it at once instead
 * of over a list it has to be trusted to have kept in step.
 */
export function transmittablePayload(report: SyncFailureReport): Record<string, unknown> {
  const detail = transmittableDetail(report);
  return {
    kind: report.kind,
    message: describeSyncFailure(report),
    ...(report.opType !== undefined ? { opType: report.opType } : {}),
    ...(report.opId !== undefined ? { opId: report.opId } : {}),
    ...(report.photoId !== undefined ? { photoId: report.photoId } : {}),
    ...(report.stage !== undefined ? { stage: report.stage } : {}),
    ...(report.status !== undefined ? { status: report.status } : {}),
    ...(report.photoCount !== undefined ? { photoCount: report.photoCount } : {}),
    ...(report.photosUploaded !== undefined ? { photosUploaded: report.photosUploaded } : {}),
    ...(report.attempts !== undefined ? { attempts: report.attempts } : {}),
    ...(detail !== undefined ? { detail } : {}),
  };
}
