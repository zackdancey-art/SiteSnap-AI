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
 * included, so that the test proving AUDIT L28 fails against the behaviour
 * `main` actually ships rather than against a strawman.
 */

export interface DrainDeps {
  peekQueue: () => Promise<QueuedOp[]>;
  dequeue: (id: string) => Promise<void>;
  apiJson: (path: string, init: { method: string; body?: string }) => Promise<unknown>;
  isNetworkError: (err: unknown) => boolean;
  stripPhotoPayloads: <T extends { photos: Photo[] }>(entry: T) => T;

  // ───────────────────────────────────────────────────────────────────────────
  // The photograph half of the drain's capabilities.
  //
  // These are listed here deliberately, and in the first version of this file
  // NONE of them is called. That is not an oversight in the interface — it is
  // the defect, stated precisely: every function needed to get a queued
  // photograph onto the server already exists in this app and is reachable
  // from this loop, and the loop POSTs the entry without touching any of them.
  //
  //   hydratePhotos        reads the base64 back out of AsyncStorage
  //   uploadPhoto          POSTs one photograph to /api/uploads, returns its key
  //   deletePhotoPayloads  releases the local copy once the server has it
  //   isManagedMediaUri    true once a photograph is stored server-side
  //   updateQueuedPayload  records partial progress so a retry resumes
  //
  // AUDIT L28. `lib/offline-drain.test.ts` turns this comment into a failing
  // assertion.
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

export async function drainQueue(deps: DrainDeps): Promise<DrainResult> {
  const queue = await deps.peekQueue();
  if (queue.length === 0) return { synced: 0, remaining: 0 };
  deps.onPending(queue.length);

  let synced = 0;

  for (const op of queue) {
    try {
      if (op.type === "addEntry") {
        const data = op.payload as Omit<Entry, "id" | "timestamp" | "createdAt">;
        await deps.apiJson("/projects/entries", {
          method: "POST",
          body: JSON.stringify(deps.stripPhotoPayloads({ ...data } as Entry)),
        });
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
