import { Router, type RouterOptions } from "express";

/**
 * A `Router` whose async handlers cannot hang the request.
 *
 * THE BUG THIS EXISTS FOR
 *
 * Express 4 does not await route handlers. `router.patch(path, async (req, res)
 * => {...})` registers a function that returns a Promise, and Express throws
 * that return value away: it forwards an error only when a handler throws
 * SYNCHRONOUSLY or calls `next(err)` itself. So an `await` that rejects inside
 * an async handler with no try/catch produces an unhandled rejection, `next` is
 * never called, nothing writes to the response, and the socket stays open until
 * the client gives up.
 *
 * That is not a theoretical shape. `PATCH /projects/sites/:id/progress` ran an
 * UPDATE naming a column `project_sites` does not have; Postgres rejected the
 * statement in under a millisecond and the request hung for five minutes until
 * the test's fetch timed out. The access log line carries no status and no
 * duration, because the logger records on `res.finish` and the response never
 * finished. On a phone that is a spinner that never resolves — the exact
 * failure this project has been closing everywhere else (L73, L77, L85).
 *
 * WHY A ROUTER AND NOT 41 TRY/CATCH BLOCKS
 *
 * The sweep found 41 of 109 route registrations in this shape: 34 with no
 * try/catch at all and 7 where an `await` sits in front of the try (a rate-limit
 * check, usually, which is Redis-backed and can reject). Adding 41 near-identical
 * blocks fixes those 41 and does nothing about the 42nd route, which will be
 * written the same way, because the language makes the wrong thing shorter.
 *
 * This moves the guarantee to the place every route already passes through. A new
 * route is safe by default; a new route FILE that reaches for `express.Router()`
 * instead is a single visible line, and `async-router.test.ts` fails on it.
 *
 * WHY THIS CANNOT TURN A REFUSAL INTO A REPORTED SERVER ERROR
 *
 * `Sentry.setupExpressErrorHandler(app)` sits in front of the fallback error
 * middleware (`server.ts:177-178`), so anything forwarded with `next(err)` is
 * reported to Sentry as a server error and answered 500. That is correct for a
 * store failure and wrong for an authorisation refusal — so it matters that no
 * refusal in this API travels as an exception. Verified rather than assumed:
 * every 403 is a direct `res.status(403).json(...)` (`middleware/auth.ts:118,129,147`,
 * `middleware/recordOwnership.ts:93`, `routes/projects.ts:419,422,456,483,540`,
 * `routes/auth.ts:640`), `utils/companyScope.ts`'s `assertSameCompany` writes its
 * 404 and returns `false`, and `requireOwnRecord` catches its own lookup failures.
 * The one `throw` on the authorisation path — an unmapped `RecordKind` at
 * `recordOwnership.ts:82` — runs at module load, not per request, and SHOULD
 * reach Sentry. Keep it that way: a refusal that needs to become an exception
 * needs its own handler in front of Sentry's, not a 500.
 */

// Arity 4 means Express treats the function as error-handling middleware. The
// wrapper's own arity is 3, so wrapping one would silently reclassify it as an
// ordinary handler and the app would stop handling errors. A mounted Router is
// also a function — of arity 3 — and carries `.stack`/`.handle` that callers walk,
// so it is passed through untouched rather than hidden behind a plain closure.
function isPassThrough(fn: unknown): boolean {
  if (typeof fn !== "function") return true;
  if (fn.length >= 4) return true;
  const f = fn as { stack?: unknown; handle?: unknown };
  return f.stack !== undefined || f.handle !== undefined;
}

function wrapHandler(fn: unknown): unknown {
  if (Array.isArray(fn)) return fn.map(wrapHandler);
  if (isPassThrough(fn)) return fn;
  const handler = fn as (...args: unknown[]) => unknown;
  // `next` is the third argument whether or not the handler declared it.
  return function wrapped(this: unknown, ...args: unknown[]) {
    const next = args[2];
    try {
      const result = handler.apply(this, args);
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        Promise.resolve(result).catch((err: unknown) => {
          if (typeof next === "function") (next as (e: unknown) => void)(err);
        });
      }
      return result;
    } catch (err) {
      // A synchronous throw is already forwarded by Express, but only from a
      // non-async handler; an async one turns it into a rejection. Handling both
      // here means the two cases cannot diverge.
      if (typeof next === "function") (next as (e: unknown) => void)(err);
      return undefined;
    }
  };
}

const WRAPPED_METHODS = [
  "use", "all", "get", "post", "put", "patch", "delete", "options", "head",
] as const;

/**
 * Drop-in replacement for `express.Router()`. Every route file uses this.
 */
export function asyncSafeRouter(options?: RouterOptions): Router {
  const router = Router(options);
  for (const method of WRAPPED_METHODS) {
    const original = (router as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    if (typeof original !== "function") continue;
    const bound = original.bind(router);
    (router as unknown as Record<string, (...a: unknown[]) => unknown>)[method] = (...args: unknown[]) =>
      bound(...args.map(wrapHandler));
  }
  return router;
}
