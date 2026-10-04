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

const cspDirectives = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'", // unsafe-eval needed for Next.js dev HMR; tighten in prod if possible
  "style-src 'self' 'unsafe-inline'",
  `connect-src 'self' ${API_ORIGIN} https://*.tile.openstreetmap.org`,
  // The API origin is required here, not optional: signed photograph URLs are
  // served by the API, so omitting it blocks every photograph in the portal.
  `img-src 'self' data: blob: ${API_ORIGIN} https://*.tile.openstreetmap.org`,
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
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
