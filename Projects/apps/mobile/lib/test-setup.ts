/**
 * Preload for the mobile package's tests, mirroring `services/api/src/test-setup.ts`.
 *
 * The modules under test are ordinary TypeScript, but two of them —
 * `offline-queue.ts` and `photo-payload-store.ts` — import
 * `@react-native-async-storage/async-storage`, which has no implementation
 * outside a React Native runtime. The choice was between testing the real
 * modules against a substitute store, or testing reimplementations of them.
 * A reimplementation would be a test of the test, so: substitute the store.
 *
 * Interception is at `Module._load` rather than by injecting an AsyncStorage
 * parameter into those modules, because changing their signatures to suit the
 * harness would be the harness dictating the shape of the app.
 *
 * `@/…` is also mapped here. tsc resolves that alias at compile time but does
 * not rewrite the emitted `require`, so any file that imports a VALUE through
 * `@/` would resolve at build and fail at run. Today every `@/` import in the
 * test program is type-only and erased; this makes the harness survive the
 * first one that is not, rather than failing in a way that looks like a bug in
 * the code under test.
 */
import Module from "node:module";
import path from "node:path";

const ASYNC_STORAGE = "@react-native-async-storage/async-storage";

const store = new Map<string, string>();

/**
 * How many times the substitute's `getItem` has been called.
 *
 * Counted because "how many times did this read storage" is itself a
 * correctness property on a phone, not a performance footnote: the photograph
 * payload map holds the device's whole base64 backlog in one key, so a read of
 * it costs megabytes and a loop of reads costs megabytes times the loop.
 * AUDIT L56 was exactly that, and nothing could have failed over it.
 */
let getItemCalls = 0;

/** The substitute. Same surface the two modules under test actually use. */
export const memoryAsyncStorage = {
  getItem: async (key: string): Promise<string | null> => {
    getItemCalls += 1;
    return store.has(key) ? store.get(key)! : null;
  },
  setItem: async (key: string, value: string): Promise<void> => {
    store.set(key, value);
  },
  removeItem: async (key: string): Promise<void> => {
    store.delete(key);
  },
  clear: async (): Promise<void> => {
    store.clear();
  },
  getAllKeys: async (): Promise<string[]> => [...store.keys()],
  multiGet: async (keys: string[]): Promise<[string, string | null][]> =>
    keys.map((key) => [key, store.get(key) ?? null]),
};

export function resetAsyncStorageForTests(): void {
  store.clear();
  getItemCalls = 0;
}

/** Read count since the last reset. See `getItemCalls`. */
export function asyncStorageGetItemCount(): number {
  return getItemCalls;
}

/** Byte count held in the substitute store, per key. Used to prove cleanup. */
export function asyncStorageKeys(): string[] {
  return [...store.keys()].sort();
}

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;

const moduleInternals = Module as unknown as { _load: Loader };
const originalLoad = moduleInternals._load;

moduleInternals._load = (request: string, parent: unknown, isMain: boolean) => {
  if (request === ASYNC_STORAGE) {
    // Returned unwrapped: the emitted `__importDefault` helper wraps a module
    // with no `__esModule` marker as `{ default: mod }`, which is exactly the
    // shape `import AsyncStorage from …` then reads.
    return memoryAsyncStorage;
  }
  if (request.startsWith("@/")) {
    return originalLoad.call(
      moduleInternals,
      path.join(__dirname, "..", request.slice(2)),
      parent,
      isMain
    );
  }
  return originalLoad.call(moduleInternals, request, parent, isMain);
};
