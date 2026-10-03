import type { Entry, Photo } from "./types";
import type { QueuedOp } from "./offline-queue";

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

  /** Mirrors the inline loop's `setPendingCount(queue.length)` before the first op. */
  onPending: (count: number) => void;
  warn: (...args: unknown[]) => void;
}

export interface DrainResult {
  /** Ops removed from the queue because the server accepted them. */
  synced: number;
  /** Ops still in the queue when the drain stopped. */
  remaining: number;
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
    photos[i] = await deps.uploadPhoto(photos[i]);
    await deps.updateQueuedPayload(
      op.id,
      deps.stripPhotoPayloads({ ...entry, photos } as Entry)
    );
  }

  return photos;
}

export async function drainQueue(deps: DrainDeps): Promise<DrainResult> {
  const queue = await deps.peekQueue();
  if (queue.length === 0) return { synced: 0, remaining: 0 };
  deps.onPending(queue.length);

  let synced = 0;

  for (const op of queue) {
    // Photograph ids whose local copy the server has taken over. Released only
    // after the op has left the queue, so a crash in between orphans bytes
    // (AUDIT L6, recoverable) rather than losing them (L28, not recoverable).
    let releasable: string[] = [];
    try {
      if (op.type === "addEntry") {
        const data = op.payload as Entry;
        const photos = await uploadEntryPhotos(op, data, deps);
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
      if (!deps.isNetworkError(err)) {
        // Non-network error (e.g. 4xx): drop the op to avoid infinite retry
        await deps.dequeue(op.id);
        deps.warn("[queue] Dropping unrecoverable queued op", op.type, err);
      }
      // Network error: leave in queue for next refresh
      break;
    }
  }

  const remaining = await deps.peekQueue();
  deps.onPending(remaining.length);
  return { synced, remaining: remaining.length };
}
