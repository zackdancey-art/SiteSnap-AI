import type { Entry, Photo } from "./types";
import type { QueuedOp, QueuedOpFailure } from "./offline-queue";
// Type-only: this module stays free of anything with a runtime, so it can be
// loaded by node --test. The reporter itself is injected.
import type { SyncFailureReport } from "./sync-telemetry-redaction";

/**
 * The offline queue drain, lifted out of DataProvider so it can be tested.
 *
 * WHY THIS IS A SEPARATE MODULE
 *
 * This logic used to live inline in `data-context.tsx` as `drainOfflineQueue`,
 * closed over React state setters, `apiJson`, `AsyncStorage` and four Expo
 * modules. Nothing in that file can be loaded by `node --test`, so the one
 * behaviour in the app with the clearest data-loss consequence — what becomes
 * of work captured with no coverage — had no test and could not have had one.
 *
 * Everything with an effect is injected. The module itself imports only types.
 * That is the whole reason it exists: the drain's decisions become inspectable
 * without a simulator.
 *
 * It was introduced as a VERBATIM transcription of the inline loop, faults
 * included, so that the test proving AUDIT L28 failed against the behaviour
 * `main` actually shipped rather than against a strawman. That red state is
 * the parent commit of this one; the loop below is the fix.
 */

export interface DrainDeps {
  peekQueue: () => Promise<QueuedOp[]>;
  dequeue: (id: string) => Promise<void>;
  apiJson: (path: string, init: { method: string; body?: string }) => Promise<unknown>;
  isNetworkError: (err: unknown) => boolean;
  stripPhotoPayloads: <T extends { photos: Photo[] }>(entry: T) => T;

  // ───────────────────────────────────────────────────────────────────────────
  // The photograph half of the drain's capabilities. AUDIT L28 was that every
  // one of these already existed in the app, was reachable from this loop, and
  // was called by none of it — so the loop POSTed the entry with its
  // photographs still addressed `file:///var/mobile/…`, the server accepted it,
  // and the sync badge cleared having uploaded nothing.
  //
  //   hydratePhotos        reads the base64 back out of AsyncStorage
  //   uploadPhoto          puts one photograph on the server, returns its key
  //   deletePhotoPayloads  releases the local copy once the server has it
  //   isManagedMediaUri    true once a photograph is stored server-side
  //   updateQueuedPayload  records partial progress so a retry resumes
  // ───────────────────────────────────────────────────────────────────────────
  hydratePhotos: (photos: Photo[]) => Promise<Photo[]>;
  uploadPhoto: (photo: Photo) => Promise<Photo>;
  deletePhotoPayloads: (photoIds: string[]) => Promise<void>;
  isManagedMediaUri: (uri: string | undefined | null) => boolean;
  updateQueuedPayload: (id: string, payload: unknown) => Promise<void>;

  /**
   * Dead-letters one op instead of deleting it. AUDIT L30 — the old loop
   * dequeued anything the server refused, so the work vanished and the only
   * record was a console line on a device with no console.
   */
  markOpFailed: (id: string, failure: Omit<QueuedOpFailure, "failedAt">) => Promise<void>;

  /**
   * Telemetry for the failures below. Identifiers and counts only — see
   * `sync-telemetry.ts` for why the report has no field a uri or a note could
   * go in. Must never throw.
   */
  report: (report: SyncFailureReport) => void;

  /** Ops still waiting for coverage. */
  onPending: (count: number) => void;
  /** Ops the drain has given up on, which the user must be shown. */
  onFailed: (count: number) => void;
  warn: (...args: unknown[]) => void;
}

export interface DrainResult {
  /** Ops removed from the queue because the server accepted them. */
  synced: number;
  /** Ops still pending when the drain stopped — waiting for coverage. */
  remaining: number;
  /** Ops dead-lettered: retained, not retried, and needing a person. */
  failed: number;
}

/** `apiJson` attaches the response status to the error it throws. */
function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * The message shown to the user beside a failed sync.
 *
 * Truncated because the API returns a JSON body for some errors and the whole
 * of it is neither readable in a row nor wanted in telemetry.
 */
function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const collapsed = raw.replace(/\s+/g, " ").trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 199)}…` : collapsed || "Unknown error";
}

/**
 * Gets every photograph on a queued entry onto the server, and returns the
 * photographs as the server should now be told about them.
 *
 * Three things about the shape of this function are load-bearing.
 *
 * It reads the bytes from the payload store rather than from `photo.uri`. The
 * uri a captured photograph carries is an ImageManipulator path in the cache
 * directory, which iOS may purge at any time and certainly does not promise
 * across a restart. The base64 in AsyncStorage is the durable copy, which is
 * why it is written at capture time; injecting `uploadPhoto` keeps the decision
 * about how to turn those bytes back into a request out of this module.
 *
 * It skips any photograph already addressed by a managed uri. After a partial
 * run, the queued payload names real objects for the photographs that got
 * through, so a retry uploads only the remainder — no duplicate objects in the
 * bucket for a phone driving in and out of coverage.
 *
 * It persists progress after every single upload rather than at the end. The
 * process can be killed between any two iterations; what it has written to the
 * queue by then is all the next launch will know.
 */
async function uploadEntryPhotos(
  op: QueuedOp,
  entry: Entry,
  deps: DrainDeps
): Promise<Photo[]> {
  const queued = entry.photos ?? [];
  if (queued.length === 0) return [];
  if (queued.every((photo) => deps.isManagedMediaUri(photo.uri))) return queued;

  const photos = await deps.hydratePhotos(queued);

  for (let i = 0; i < photos.length; i += 1) {
    if (deps.isManagedMediaUri(photos[i].uri)) continue;
    // Throws on failure, deliberately: the caller's catch decides whether the
    // op waits for coverage or is dead-lettered, and either way the entry is
    // not POSTed. An entry must never claim a photograph the server lacks.
    try {
      photos[i] = await deps.uploadPhoto(photos[i]);
    } catch (err) {
      // Reported here rather than in the caller's catch because this is the
      // only frame that knows WHICH photograph it was and how many were
      // already up. The error is rethrown unchanged.
      deps.report({
        kind: "queued-photo-upload-failed",
        opType: op.type,
        opId: op.id,
        photoId: photos[i].id,
        stage: "upload",
        status: statusOf(err),
        photoCount: photos.length,
        photosUploaded: photos.filter((photo) => deps.isManagedMediaUri(photo.uri)).length,
        cause: err,
      });
      throw err;
    }
    await deps.updateQueuedPayload(
      op.id,
      deps.stripPhotoPayloads({ ...entry, photos } as Entry)
    );
  }

  return photos;
}

export async function drainQueue(deps: DrainDeps): Promise<DrainResult> {
  const all = await deps.peekQueue();
  // A dead-lettered op is not retried and does not hold the badge open. It sits
  // in the failed list until a person asks for it to be tried again.
  const queue = all.filter((op) => op.status !== "failed");
  const failedBefore = all.length - queue.length;
  deps.onPending(queue.length);
  deps.onFailed(failedBefore);
  if (queue.length === 0) return { synced: 0, remaining: 0, failed: failedBefore };

  let synced = 0;

  for (const op of queue) {
    // Photograph ids whose local copy the server has taken over. Released only
    // after the op has left the queue, so a crash in between orphans bytes
    // (AUDIT L6, recoverable) rather than losing them (L28, not recoverable).
    let releasable: string[] = [];
    // Which half of the work was in flight when it threw. Reported on a failure
    // because "the photographs would not upload" and "the server refused the
    // entry" need different things done about them.
    let stage: QueuedOpFailure["stage"] = "request";
    let photosUploaded = 0;
    try {
      if (op.type === "addEntry") {
        const data = op.payload as Entry;
        stage = "upload";
        const photos = await uploadEntryPhotos(op, data, deps);
        photosUploaded = photos.filter((photo) => deps.isManagedMediaUri(photo.uri)).length;
        stage = "request";
        await deps.apiJson("/projects/entries", {
          method: "POST",
          body: JSON.stringify(deps.stripPhotoPayloads({ ...data, photos } as Entry)),
        });
        releasable = photos.map((photo) => photo.id).filter(Boolean);
      } else if (op.type === "addSite") {
        await deps.apiJson("/projects/sites", {
          method: "POST",
          body: JSON.stringify(op.payload),
        });
      } else if (op.type === "updateEntry") {
        const { id, patch } = op.payload as { id: string; patch: Partial<Entry> };
        await deps.apiJson(`/projects/entries/${id}`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        });
      } else if (op.type === "deleteEntry") {
        await deps.apiJson(`/projects/entries/${op.payload as string}`, { method: "DELETE" });
      } else if (op.type === "deleteSite") {
        await deps.apiJson(`/projects/sites/${op.payload as string}`, { method: "DELETE" });
      }
      await deps.dequeue(op.id);
      synced += 1;
      if (releasable.length > 0) await deps.deletePhotoPayloads(releasable);
    } catch (err) {
      if (deps.isNetworkError(err)) {
        // Coverage is gone. The op stays exactly as it is, with whatever
        // per-photograph progress was written back, and so does every op behind
        // it — there is nothing to be gained by trying them without a network.
        break;
      }

      // The server answered and refused. Retrying will get the same answer, so
      // the op stops consuming attempts — but it is KEPT, with enough context
      // to say what happened, and the user is shown that it did not sync.
      // AUDIT L30; previously this was a dequeue and a console.warn.
      await deps.markOpFailed(op.id, {
        stage,
        status: statusOf(err),
        message: messageOf(err),
        ...(op.type === "addEntry" ? { photosUploaded } : {}),
      });
      deps.report({
        kind: "queued-op-dead-lettered",
        opType: op.type,
        opId: op.id,
        stage,
        status: statusOf(err),
        ...(op.type === "addEntry"
          ? { photoCount: (op.payload as Entry).photos?.length ?? 0, photosUploaded }
          : {}),
        attempts: (op.attempts ?? 0) + 1,
        cause: err,
      });
      deps.warn("[queue] Retained a queued op the server refused", op.type, err);
      // Continue rather than break: one refused op must not stop the ops behind
      // it from syncing, which is the other half of why the old loop lost work.
      continue;
    }
  }

  const after = await deps.peekQueue();
  const stillPending = after.filter((op) => op.status !== "failed");
  deps.onPending(stillPending.length);
  deps.onFailed(after.length - stillPending.length);
  return {
    synced,
    remaining: stillPending.length,
    failed: after.length - stillPending.length,
  };
}
