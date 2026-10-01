import * as Sentry from "@sentry/react-native";

import { toCanonicalPath } from "@/lib/photo-uri";

/**
 * Reports the media failures this app used to swallow.
 *
 * WHY THIS EXISTS
 *
 * The six-grey-tiles bug was not a logic error anyone would have caught by
 * reading the code. It was a SILENT failure: React Native's <Image> fails an
 * unresolvable relative uri with no throw, no log and no user-visible error, so
 * six broken tiles were indistinguishable from six slow ones. The app is wired
 * to Sentry and has been since before that regression, and it had produced zero
 * events in ninety days — because nothing in it ever called captureException.
 * Instrumented, but deaf. The regression was reported by a human, and so would
 * the next one have been.
 *
 * Every call site that reaches this module already KNOWS it has failed. All that
 * was missing was telling anyone.
 *
 * WHY THE URI IS NEVER PASSED THROUGH AS GIVEN
 *
 * A displayable photo uri is `…/api/uploads/<id>/<name>?sig=…&exp=…`. The `sig`
 * is an HMAC that grants anyone holding it read access to that object for two
 * hours — it is a bearer credential in query-string form. Sending it to an
 * external service, where it is stored and indexed, would leak site evidence,
 * and the Sentry `beforeSend` in app/_layout.tsx scrubs request HEADERS only,
 * so it would not catch this.
 *
 * So uris are reduced to their canonical path here, before anything is sent, and
 * a uri that is not a managed media path is reduced to its scheme alone. A
 * `data:` uri is the reason for that last rule: it is the photograph itself,
 * inline, and it is exactly what must never be uploaded to a third party.
 */

export type MediaFailureKind =
  /** POST /api/uploads/sign returned a non-2xx. */
  | "sign-request-failed"
  /** The signer answered, but returned `url: null` for some paths. */
  | "sign-refused"
  /** The signing request threw (offline, DNS, TLS). */
  | "sign-threw"
  /** There was no auth token, so nothing could be signed at all. */
  | "sign-no-token"
  /** <Image> raised onError for a uri we believed was displayable. */
  | "image-load-failed"
  /** An export could not fetch the bytes it needed to embed. */
  | "export-fetch-failed";

type MediaFailureReport = {
  kind: MediaFailureKind;
  /** Photos affected, and how many were in the batch, where it is a batch. */
  count?: number;
  total?: number;
  /** HTTP status, where there was a response. */
  status?: number;
  /** A photo uri. SCRUBBED by this module — never transmitted as given. */
  uri?: string | null;
  /** Why the UI gave up, for a load failure. */
  reason?: string;
  /** The underlying error, where one was thrown. */
  cause?: unknown;
};

/**
 * One line of human-readable text per kind, used as the Sentry issue title.
 * Written so the issue list is readable without opening anything.
 */
function describeFailure(report: MediaFailureReport): string {
  const { kind, count, total, status } = report;
  const n = count ?? 1;
  switch (kind) {
    case "sign-request-failed":
      return `Media signing request failed (${status ?? "no status"}) for ${n} photo(s)`;
    case "sign-refused":
      return `Media signing refused ${n} of ${total ?? n} photo(s)`;
    case "sign-threw":
      return `Media signing threw for ${n} photo(s)`;
    case "sign-no-token":
      return `No auth token — ${n} photo(s) cannot be signed`;
    case "image-load-failed":
      return "Evidence image failed to load";
    case "export-fetch-failed":
      return "Export could not fetch photo bytes";
  }
}

/**
 * Reduce a uri to something safe to transmit.
 *
 * A managed media uri becomes its canonical path — `/api/uploads/<id>/<name>`,
 * which toCanonicalPath has already stripped of `sig`, `exp` and `authToken`.
 * That path is not fetchable without a fresh signature or a bearer token, and it
 * is the one piece of information needed to find the object again.
 *
 * Anything else becomes its scheme and nothing more. `file:` and `content:` uris
 * carry a device path, and a `data:` uri IS the photograph.
 */
function describeUri(uri: string | null | undefined): string {
  if (!uri) return "(none)";
  const canonical = toCanonicalPath(uri);
  if (canonical) return canonical;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(uri)?.[1]?.toLowerCase();
  return scheme ? `${scheme}:(withheld)` : "(opaque)";
}

/**
 * Per-session de-duplication.
 *
 * A gallery of fifty photos whose signatures have all expired would otherwise
 * raise fifty identical events on one screen, which is how useful alerting gets
 * switched off. The key deliberately includes the scrubbed path, so a DIFFERENT
 * broken photo is still reported; only the same photo failing the same way twice
 * is dropped. Bounded so a long session cannot grow it without limit.
 */
const MAX_REPORTED_KEYS = 200;
const reported = new Set<string>();

/**
 * Report a media failure. Never throws, and never rejects — every call site is
 * already on a failure path and must not be made worse by its own telemetry.
 *
 * Still logs to the console as before. The console line is what a developer
 * sees with the app in front of them; the Sentry event is what reaches anyone
 * when it happens on a roof in Penrith at 4pm.
 */
export function reportMediaFailure(report: MediaFailureReport): void {
  const message = describeFailure(report);
  const scrubbedUri = describeUri(report.uri);

  try {
    console.warn(`[media] ${message}${report.uri ? ` — ${scrubbedUri}` : ""}`, report.cause ?? "");
  } catch {
    // A console that throws is not a reason to lose the event.
  }

  try {
    const key = `${report.kind}|${scrubbedUri}|${report.status ?? ""}|${report.reason ?? ""}`;
    if (reported.has(key)) return;
    if (reported.size >= MAX_REPORTED_KEYS) reported.clear();
    reported.add(key);

    // An Error is what Sentry groups on. Where the call site caught a real one,
    // that is used so its stack survives; otherwise one is synthesised here.
    const error = report.cause instanceof Error ? report.cause : new Error(message);

    Sentry.withScope((scope) => {
      scope.setTag("media_failure", report.kind);
      scope.setLevel("warning");
      scope.setContext("media", {
        kind: report.kind,
        message,
        path: scrubbedUri,
        ...(report.count !== undefined ? { count: report.count } : {}),
        ...(report.total !== undefined ? { total: report.total } : {}),
        ...(report.status !== undefined ? { status: report.status } : {}),
        ...(report.reason !== undefined ? { reason: report.reason } : {}),
      });
      // Set explicitly: when `cause` was a real Error its own message is the
      // title, and "Network request failed" would not say what broke.
      scope.setFingerprint(["media-failure", report.kind]);
      Sentry.captureException(error);
    });
  } catch {
    // Sentry is not initialised when no DSN is configured, and telemetry must
    // never be able to break the path it is reporting on.
  }
}

/** Test seam: clears the de-duplication set. */
export function resetMediaTelemetryForTests(): void {
  reported.clear();
}
