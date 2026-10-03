import AsyncStorage from "@react-native-async-storage/async-storage";

export type QueuedOpType = "addEntry" | "updateEntry" | "deleteEntry" | "addSite" | "deleteSite";

/**
 * Why an op failed, kept on the op itself. AUDIT L30.
 *
 * The drain used to `dequeue` an op that failed with anything other than a
 * network error and `console.warn` about it. On a phone there is no console, so
 * a queued entry rejected by the server — a validation error, an expired
 * membership, a 413 — was deleted, and the only record that it had ever existed
 * was a log line nobody would ever read. Stage 1's timecard validation produces
 * exactly that class of 4xx, so merging it made this path more likely to fire.
 *
 * None of these fields holds entered content: a stage, a status, a count and
 * the error's own message. The message is shown to the user, so it is the one
 * field a future caller could put content into; keep it to what the server
 * said.
 */
export interface QueuedOpFailure {
  /** Whether it failed getting a photograph up, or sending the op itself. */
  stage: "upload" | "request";
  /** The server's HTTP status, where there was a response. */
  status?: number;
  /** The error as reported. Shown in the UI, so it must stay short. */
  message: string;
  failedAt: string;
  /** Photographs already on the server, for an op that failed mid-upload. */
  photosUploaded?: number;
}

export interface QueuedOp {
  id: string;
  type: QueuedOpType;
  payload: unknown;
  queuedAt: string;
  /**
   * Absent means pending. The field was added after ops were already being
   * written to storage, so an op queued by an older build has no `status` and
   * must read as pending rather than as anything else.
   */
  status?: "pending" | "failed";
  /** Drain attempts that reached the server and were refused by it. */
  attempts?: number;
  failure?: QueuedOpFailure;
}

/** The one place the pending/failed distinction is defined. */
export function isFailedOp(op: QueuedOp): boolean {
  return op.status === "failed";
}

const QUEUE_KEY = "sitesnap.offlineQueue";

async function loadQueue(): Promise<QueuedOp[]> {
  try {
    const raw = await AsyncStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as QueuedOp[]) : [];
  } catch {
    return [];
  }
}

async function saveQueue(queue: QueuedOp[]): Promise<void> {
  await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}

export async function enqueue(op: Omit<QueuedOp, "id" | "queuedAt">): Promise<string> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const entry: QueuedOp = { ...op, id, queuedAt: new Date().toISOString() };
  const queue = await loadQueue();
  queue.push(entry);
  await saveQueue(queue);
  return id;
}

export async function dequeue(id: string): Promise<void> {
  const queue = await loadQueue();
  await saveQueue(queue.filter((op) => op.id !== id));
}

/**
 * Replace one queued op's payload in place, keeping its id and queue position.
 *
 * The drain needs this to record per-photograph progress. Uploading four
 * photographs is four independent network calls; if the fourth fails the first
 * three are already on the server and their storage keys exist only in the
 * drain's local variable. Writing the partial result back means the retry sees
 * three photographs already carrying `/api/uploads/…` uris, which
 * `uploadPhotoOnce` returns early for — so the retry uploads one photograph,
 * not four, and the bucket does not accumulate a duplicate per attempt.
 *
 * A missing id is a no-op rather than an error: the op may have been dequeued
 * by a concurrent drain, and in that case there is nothing to record.
 */
export async function updateQueuedPayload(id: string, payload: unknown): Promise<void> {
  const queue = await loadQueue();
  const index = queue.findIndex((op) => op.id === id);
  if (index === -1) return;
  queue[index] = { ...queue[index], payload };
  await saveQueue(queue);
}

/**
 * Dead-letter one op: keep it, record why, and stop retrying it.
 *
 * Deliberately NOT a dequeue. The op holds the only copy of work the user did,
 * and a server that refuses it today may accept it after whatever was wrong is
 * put right — a membership restored, a validation rule relaxed, the entry
 * edited. Nothing in the app deletes a failed op; that decision is the user's,
 * and the retry below is how they take it.
 */
export async function markOpFailed(
  id: string,
  failure: Omit<QueuedOpFailure, "failedAt">
): Promise<void> {
  const queue = await loadQueue();
  const index = queue.findIndex((op) => op.id === id);
  if (index === -1) return;
  queue[index] = {
    ...queue[index],
    status: "failed",
    attempts: (queue[index].attempts ?? 0) + 1,
    failure: { ...failure, failedAt: new Date().toISOString() },
  };
  await saveQueue(queue);
}

/**
 * Hand a failed op back to the drain.
 *
 * A failed op can be retried by hand, and that is the right answer rather than
 * an automatic retry, for two reasons. The failures that land here are the ones
 * the server has already refused on their merits, so retrying on a timer would
 * consume the queue's attempts forever and tell the user nothing new. And the
 * thing that usually has to change is outside the app — a rule, a permission,
 * an entry someone has to go and correct — so the person who fixed it is the
 * one who knows the retry is now worth making.
 *
 * `failure` is cleared so a second refusal is recorded as fresh; `attempts`
 * survives, because how many times the server has said no is the number worth
 * knowing before trying a sixth time.
 */
export async function retryFailedOps(ids?: string[]): Promise<number> {
  const queue = await loadQueue();
  let retried = 0;
  const next = queue.map((op) => {
    if (!isFailedOp(op)) return op;
    if (ids && !ids.includes(op.id)) return op;
    retried += 1;
    return { ...op, status: "pending" as const, failure: undefined };
  });
  if (retried > 0) await saveQueue(next);
  return retried;
}

export async function peekQueue(): Promise<QueuedOp[]> {
  return loadQueue();
}

/** Ops the drain will attempt. */
export async function peekPendingQueue(): Promise<QueuedOp[]> {
  return (await loadQueue()).filter((op) => !isFailedOp(op));
}

/** Ops the drain has given up on, newest failure first. */
export async function peekFailedQueue(): Promise<QueuedOp[]> {
  return (await loadQueue())
    .filter(isFailedOp)
    .sort((a, b) => (b.failure?.failedAt ?? "").localeCompare(a.failure?.failedAt ?? ""));
}

export async function clearQueue(): Promise<void> {
  await AsyncStorage.removeItem(QUEUE_KEY);
}

export function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("network request failed") ||
    msg.includes("failed to fetch") ||
    msg.includes("network error") ||
    msg.includes("typeerror: failed") ||
    msg.includes("connection refused") ||
    msg.includes("econnrefused") ||
    msg.includes("etimedout")
  );
}
