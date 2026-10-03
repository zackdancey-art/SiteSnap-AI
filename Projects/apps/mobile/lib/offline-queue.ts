import AsyncStorage from "@react-native-async-storage/async-storage";

export type QueuedOpType = "addEntry" | "updateEntry" | "deleteEntry" | "addSite" | "deleteSite";

export interface QueuedOp {
  id: string;
  type: QueuedOpType;
  payload: unknown;
  queuedAt: string;
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

export async function peekQueue(): Promise<QueuedOp[]> {
  return loadQueue();
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
