import * as Sentry from "@sentry/react-native";

import {
  describeSyncFailure,
  mayTransmitCause,
  transmittablePayload,
  type SyncFailureReport,
} from "@/lib/sync-telemetry-redaction";

export type { SyncFailureKind, SyncFailureReport } from "@/lib/sync-telemetry-redaction";

/**
 * Reports the offline-sync failures that used to leave no trace at all.
 *
 * WHY A SECOND TELEMETRY MODULE
 *
 * `media-telemetry.ts` says in its own header that a third non-media caller is
 * the point at which it should be renamed rather than stretched again. These are
 * not media-display failures — they are a queue losing work — so they get their
 * own module rather than a widened `MediaFailureKind`.
 *
 * WHAT MAY BE SENT, AND WHY IT IS SHAPED THIS WAY
 *
 * Identifiers and counts. No photographs, no note text, no addresses, no email.
 * The rule is enforced by the shape of `SyncFailureReport` rather than by a
 * scrubbing pass: there is no field on it that can hold entered content, and
 * there is no field for a uri. That second point is deliberate — a displayable
 * media uri carries `?sig=` and `?exp=`, an HMAC granting two hours of read
 * access to site evidence, and the surest way to keep a credential out of an
 * external service is to give its payload nowhere to put one.
 *
 * The one judgement call is the error message, and it is resolved by where the
 * message came from. That decision, and the shape of the report, live in
 * `sync-telemetry-redaction.ts` — which imports nothing with a runtime, so the
 * rule is covered by tests rather than by this comment. This module is only the
 * part that talks to Sentry.
 */

/**
 * Per-session de-duplication, same reasoning as media-telemetry: a drain that
 * runs on every refresh must not raise the same event every time coverage
 * flickers. Keyed on the op rather than the kind, so a DIFFERENT op failing the
 * same way is still reported.
 */
const MAX_REPORTED_KEYS = 200;
const reported = new Set<string>();

/** Never throws. Every call site is already on a failure path. */
export function reportSyncFailure(report: SyncFailureReport): void {
  const message = describeSyncFailure(report);

  try {
    console.warn(`[sync] ${message}`, report.cause ?? "");
  } catch {
    // A console that throws is not a reason to lose the event.
  }

  try {
    const key = `${report.kind}|${report.opId ?? ""}|${report.photoId ?? ""}|${report.status ?? ""}`;
    if (reported.has(key)) return;
    if (reported.size >= MAX_REPORTED_KEYS) reported.clear();
    reported.add(key);

    // A server-originated Error must not be the transmitted exception: Sentry
    // titles the issue with the exception's own message, which would send the
    // server's wording immediately after the redaction withheld it.
    const error = mayTransmitCause(report) ? (report.cause as Error) : new Error(message);

    Sentry.withScope((scope) => {
      scope.setTag("sync_failure", report.kind);
      scope.setLevel(report.kind === "queued-photo-bytes-missing" ? "error" : "warning");
      scope.setContext("sync", transmittablePayload(report));
      // Grouped by kind and op type, not by the server's wording, so one issue
      // per failure mode rather than one per message variant.
      scope.setFingerprint(["sync-failure", report.kind, report.opType ?? "op"]);
      Sentry.captureException(error);
    });
  } catch {
    // Sentry is not initialised without a DSN, and telemetry must never break
    // the path it is reporting on.
  }
}

/** Test seam: clears the de-duplication set. */
export function resetSyncTelemetryForTests(): void {
  reported.clear();
}
