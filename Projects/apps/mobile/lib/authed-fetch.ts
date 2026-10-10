import AsyncStorage from "@react-native-async-storage/async-storage";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { SessionExpiredError, isSessionErrorCode, notifySessionExpired } from "@/lib/session";

/**
 * The one authenticated `fetch` for the app.
 *
 * It replaces seven near-identical private helpers — one per screen, each
 * reading the token out of AsyncStorage, resolving the base URL and merging the
 * Authorization header by hand. They agreed on all of that and disagreed on the
 * only part that mattered: six of the seven turned a 401 into a feature error
 * ("API 401", "Failed to save signature"), and one ignored the status entirely.
 * See the header of lib/session.ts for what that cost.
 *
 * Everything here is mechanical except the 401 branch, which is the point: a
 * refused credential is reported once, through lib/session.ts, and the caller
 * receives a SessionExpiredError it is expected NOT to describe in its own
 * words. Every other status keeps its existing behaviour, so a feature error is
 * still a feature error.
 *
 * Deliberately not a JSON helper. Two call sites send FormData and one reads a
 * Response it does not parse, so this returns the Response and `authedJson`
 * below adds parsing for the callers that want it.
 */
export async function authedFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await AsyncStorage.getItem("sitesnap.token");
  const base = getApiBaseUrl();
  const url = path.startsWith("http") ? path : `${base}${path}`;

  // A request with no token at all is not a dead session — it is a signed-out
  // app, or a race during startup — so it is NOT reported as an expiry. It is
  // still sent, because the server's 401 is the authority on that and because
  // every previous helper sent it too; changing that would change behaviour
  // this commit has no evidence about.
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });

  // Only a token we actually sent can have expired. A 401 on a request that
  // carried no credential means the app is signed out - which is the state the
  // sign-in screen is already in - and announcing an expiry there would tell
  // someone registering an account that their session had ended.
  if (res.status === 401 && token && isSessionErrorCode(await read401Code(res))) {
    notifySessionExpired();
    throw new SessionExpiredError();
  }
  return res;
}

/**
 * The `code` off a 401 body, or undefined.
 *
 * Read from a CLONE so the caller still has an unconsumed Response: a 401 that
 * turns out NOT to be an expiry (a mistyped current password) is handed back to
 * the feature, which needs the body to show the server's message. If cloning or
 * parsing fails the answer is undefined, which isSessionErrorCode reads as a
 * session failure — the same conclusion this code reached before the server had
 * codes at all.
 */
async function read401Code(res: Response): Promise<string | undefined> {
  try {
    const data = (await res.clone().json()) as { code?: unknown };
    return typeof data?.code === "string" ? data.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `authedFetch` plus the response parsing the screen helpers used to do.
 *
 * Keeps the shape the helpers it replaces had — reject on a non-2xx, resolve
 * with the parsed body otherwise — but prefers the server's own `error` string
 * to the bare `API <status>` those helpers threw, because that string is written
 * for the person reading it and "API 409" is not.
 */
export async function authedJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await authedFetch(path, init);
  if (!res.ok) {
    // A body is not guaranteed on an error, and a parse failure here must not
    // replace a meaningful status with a JSON syntax error.
    let serverMessage: string | undefined;
    let serverCode: string | undefined;
    let serverBody: Record<string, unknown> | undefined;
    try {
      const data = (await res.json()) as { error?: string; message?: string; code?: unknown };
      serverMessage = data?.error || data?.message;
      // The whole parsed body, for the refusals that carry structured detail a
      // sentence cannot (the accept route's invitedEmail/signedInAs pair).
      // data-context's doFetch carries the same field; the two helpers agreeing
      // is the point, since seven screens disagreeing is what produced item 1.
      serverBody = data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
      // Carried onto the thrown error so isSessionExpired() downstream can tell
      // a dead session from a refused credential. Without this the code stops
      // here and every 401 reads as an expiry again.
      serverCode = typeof data?.code === "string" ? data.code : undefined;
    } catch {
      serverMessage = undefined;
    }
    const err = new Error(serverMessage || `API ${res.status}`) as Error & {
      status?: number;
      code?: string;
      body?: Record<string, unknown>;
    };
    err.status = res.status;
    err.code = serverCode;
    err.body = serverBody;
    throw err;
  }
  return res.json() as Promise<T>;
}
