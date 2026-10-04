import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// Extract the origin from NEXT_PUBLIC_API_URL for the CSP; fall back to 'self'
// if it isn't set (rather than assuming a dev default the CSP shouldn't hardcode).
function apiOrigin(url) {
  if (!url) return "'self'";
  try { return new URL(url).origin; } catch { return "'self'"; }
}

/**
 * The API origin, resolved ONCE and interpolated into every directive that
 * needs it.
 *
 * It used to be called inline in `connect-src` only, and `img-src` was written
 * as a bare literal — so the portal could reach the API to ask for a signed
 * photograph URL and was then forbidden to load the image the API handed back.
 * Every photograph in the portal was a grey tile, and because a CSP refusal is
 * reported to the console by the browser rather than to the `fetch`, nothing in
 * the app could tell it had happened (AUDIT L48, and the fifth state added to
 * L43). One constant, so a directive cannot silently disagree with its
 * neighbour about where the API lives.
 *
 * Note the build-time hazard this does NOT fix: `next.config.mjs` is evaluated
 * at BUILD time, so an environment that supplies NEXT_PUBLIC_API_URL only at
 * runtime bakes `'self'` here and blocks the API outright, with no build error.
 * Hence the warning below rather than a silent fallback.
 */
const API_ORIGIN = apiOrigin(process.env.NEXT_PUBLIC_API_URL);

if (!process.env.NEXT_PUBLIC_API_URL) {
  console.warn(
    "[next.config] NEXT_PUBLIC_API_URL is not set at build time. " +
      "The Content-Security-Policy will fall back to 'self', which blocks API " +
      "requests and photograph loads from any other origin. Set it in the build " +
      "environment, not only at runtime."
  );
}

// The path the browser posts refusals to. One constant, because it appears in
// three places: `report-to`'s endpoint group, `report-uri`, and the route
// handler at `app/api/csp-report/route.ts` that receives them.
const CSP_REPORT_PATH = "/api/csp-report";
const CSP_REPORT_GROUP = "csp-endpoint";

const cspDirectives = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // unsafe-eval needed for Next.js dev HMR; tighten in prod if possible
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${API_ORIGIN} https://*.tile.openstreetmap.org`,
  // The API origin is required here, not optional: signed photograph URLs are
  // served by the API, so omitting it blocks every photograph in the portal.
  `img-src 'self' data: blob: ${API_ORIGIN} https://*.tile.openstreetmap.org`,
  // `media-src` is written out for the same reason `img-src` had to be fixed,
  // and BEFORE it bites rather than after. It is not currently exercised — the
  // portal renders no audio or video — so it was inheriting `default-src
  // 'self'`, which means the first time this product serves a video walkthrough
  // or a voice note as site evidence it fails exactly as the photographs did
  // and exactly as silently: a successful signing call, a refused GET, a grey
  // rectangle, and nothing in the application able to tell. Stated explicitly
  // so that the day it is used is not also the day it is debugged.
  `media-src 'self' blob: ${API_ORIGIN}`,
  // No frames are embedded today. `frame-ancestors 'none'` below governs who
  // may embed US; this governs what WE may embed, which `default-src` would
  // otherwise decide by accident. 'none' is the honest current answer, and it
  // will produce a report rather than a mystery if that changes.
  "frame-src 'none'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  // Both generations, deliberately. Chromium honours `report-to` against the
  // `Reporting-Endpoints` header; Safari and Firefox still use the deprecated
  // `report-uri`. Configuring only one leaves the same blind spot in a smaller
  // size — and this portal's one known CSP defect went unreported for months
  // precisely because there was no endpoint of either kind (AUDIT L48).
  `report-to ${CSP_REPORT_GROUP}`,
  `report-uri ${CSP_REPORT_PATH}`,
].join("; ");

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_API_URL: API_URL,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: cspDirectives },
          { key: "Reporting-Endpoints", value: `${CSP_REPORT_GROUP}="${CSP_REPORT_PATH}"` },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default withBundleAnalyzer(nextConfig);
