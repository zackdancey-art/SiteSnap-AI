import morgan from "morgan";

morgan.token("reqid", (req) => req.headers["x-request-id"] as string || "-");

/**
 * Query-string keys whose VALUES are credentials or personal data.
 *
 * `sig` and `exp` are the signed-media credentials (`routes/media.ts` reads
 * `req.query.sig` / `req.query.exp`); together they are a bearer grant for a
 * photograph. `token` is not read from the query string by any route today,
 * and is listed so that it cannot start being logged by the addition of one
 * route elsewhere — the invitation flow is the obvious candidate.
 *
 * The key is kept and only the value replaced, so a log line still shows the
 * SHAPE of the request. "Which parameters were sent" is what you read logs for;
 * "what the signature was" is not.
 */
const REDACTED_QUERY_KEYS = new Set(["sig", "exp", "token", "signature", "key", "code", "secret"]);

/**
 * Path segments that are personal data or credentials rather than opaque ids.
 *
 * Matched by the segment BEFORE them, because that is what is stable:
 *   /company/members/alice@example.com/role  -> /company/members/[redacted]/role
 *   /projects/sites/<id>/members/alice@...   -> .../members/[redacted]
 *   /push/tokens/<device push token>         -> /push/tokens/[redacted]
 *
 * Deliberately NOT redacted: site, entry, diary and upload ids. They are
 * random identifiers, they are what makes a log line useful for tracing a
 * request, and they are not credentials — a request still needs a bearer token
 * to do anything with one.
 */
const REDACTED_AFTER_SEGMENT = new Set(["members", "tokens"]);

/** An email anywhere in a path, including one that is URL-encoded. */
const EMAIL_IN_PATH = /[^/?#@\s]+(?:@|%40)[^/?#\s]+\.[^/?#\s]+/gi;

export function redactUrl(raw: string): string {
  if (!raw) return raw;
  const [pathPart, ...queryParts] = raw.split("?");
  const query = queryParts.join("?");

  const segments = pathPart.split("/").map((segment, index, all) => {
    if (index > 0 && REDACTED_AFTER_SEGMENT.has(all[index - 1])) return "[redacted]";
    return segment;
  });
  // The segment-position rule above is the precise one; this is the backstop
  // for an email arriving in a path shape nobody listed, which is how this
  // kind of redaction usually fails.
  const path = segments.join("/").replace(EMAIL_IN_PATH, "[redacted]");

  if (!query) return path;

  // Hand-parsed rather than via URLSearchParams: morgan is given the raw
  // request URL, which may not be valid enough to parse, and re-serialising it
  // would silently change what the log says was requested.
  const redactedQuery = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      return REDACTED_QUERY_KEYS.has(key.toLowerCase()) ? `${key}=[redacted]` : pair;
    })
    .join("&");

  return `${path}?${redactedQuery}`;
}

/**
 * `:url` wrote member emails, device push tokens and signed-media credentials
 * into Render's persistent logs on every request. Those logs are retained,
 * searchable, and outside the database's tenant isolation — and they are the
 * one copy of customer personal data nothing in the product can delete. This
 * token is the same string with those values replaced.
 */
morgan.token("safeurl", (req) => redactUrl(req.url ?? ""));

export const httpLogger = morgan(":method :safeurl :status :res[content-length] - :response-time ms reqid=:reqid");
