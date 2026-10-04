/**
 * Where a Content-Security-Policy refusal gets recorded.
 *
 * WHY THIS EXISTS
 *
 * The portal shipped with no reporting directive at all, and the consequence
 * was AUDIT L48: `img-src` omitted the API origin, so every photograph on
 * every site was a grey tile, and the only place that fact was written down
 * was the browser console of whoever happened to open it. A CSP refusal is
 * delivered to the console by the browser, not to the `fetch` that triggered
 * it — there is no rejected promise, so no amount of error handling in the app
 * can see one. Months of a headline feature being wholly broken produced no
 * signal anywhere a developer would look.
 *
 * This endpoint is the signal. It does not make the policy stricter or looser;
 * it makes a future omission announce itself.
 *
 * WHAT IT DELIBERATELY DOES NOT LOG
 *
 * Signed media URLs carry `?sig=` and `?exp=`. Those are credentials: a logged
 * pair is a working link to another company's site photograph for as long as
 * the expiry allows. Every URL in a report is therefore reduced to origin plus
 * path before it reaches a log line, which is also what makes the line useful —
 * `/api/uploads/<id>/<name>` is the part that identifies the directive at
 * fault. Nothing else from the report is logged.
 *
 * TWO HEADER GENERATIONS, ON PURPOSE
 *
 * Chromium sends `application/reports+json` to a `Reporting-Endpoints` group
 * (`report-to`); Safari and Firefox send `application/csp-report` to a
 * `report-uri`. Both are configured in `next.config.mjs` and both shapes are
 * accepted here, because a policy that only hears from one browser family is
 * the same blind spot in a smaller size.
 */

/** Origin + path only. Query and fragment are discarded — see above. */
function redactUrl(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    // Not absolute (CSP sends bare keywords such as "inline" and "eval", and
    // relative paths), so cut at the first query or fragment by hand.
    return value.split(/[?#]/, 1)[0] ?? "";
  }
}

type ReportFields = {
  effectiveDirective: string;
  blockedUri: string;
  documentUri: string;
  disposition: string;
};

function readString(source: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

/** Normalise either generation's body into the four fields worth logging. */
function extractReports(parsed: unknown): ReportFields[] {
  const bodies: Record<string, unknown>[] = [];

  if (Array.isArray(parsed)) {
    // Reporting API: [{ type, url, body: { ... } }, ...]
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const body = (item as Record<string, unknown>).body;
      if (body && typeof body === "object") bodies.push(body as Record<string, unknown>);
    }
  } else if (parsed && typeof parsed === "object") {
    // report-uri: { "csp-report": { ... } }
    const legacy = (parsed as Record<string, unknown>)["csp-report"];
    if (legacy && typeof legacy === "object") bodies.push(legacy as Record<string, unknown>);
  }

  return bodies.map((body) => ({
    effectiveDirective:
      readString(body, "effectiveDirective", "effective-directive", "violatedDirective", "violated-directive") ||
      "unknown",
    blockedUri: redactUrl(readString(body, "blockedURL", "blocked-uri", "blockedUri")),
    documentUri: redactUrl(readString(body, "documentURL", "document-uri", "documentUri")),
    disposition: readString(body, "disposition") || "enforce",
  }));
}

/**
 * The endpoint is necessarily unauthenticated — reports arrive without
 * credentials — so it is also necessarily POST-floodable by anyone. Cap the
 * lines per process and say so once, rather than handing a stranger an
 * unbounded write to the deployment's logs.
 */
const LOG_BUDGET = 200;
let logged = 0;

export async function POST(request: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.text());
  } catch {
    // A malformed body is not worth a log line; it is also not worth an error
    // status that would make a browser retry.
    return new Response(null, { status: 204 });
  }

  for (const report of extractReports(parsed)) {
    if (logged >= LOG_BUDGET) break;
    logged += 1;
    console.warn("[csp] policy violation", report);
    if (logged === LOG_BUDGET) {
      console.warn("[csp] report budget reached for this process; further reports are not logged.");
    }
  }

  return new Response(null, { status: 204 });
}
