import { Sentry } from "./instrument";
import path from "path";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import dotenv from "dotenv";
import { httpLogger } from "./middleware/logger";
import { requestId } from "./middleware/requestId";
import { apiRouter } from "./routes";
import { initAuthSchema } from "./storage/authStore";
import { isProductionMediaStorageReady } from "./storage/mediaStorage";
import { initProjectSchema } from "./storage/projectsStore";
import { runMigrations } from "./storage/migrate";

dotenv.config();

function isConfigured(value?: string) {
  return Boolean(value && value.trim());
}

export function validateProviderConfig() {
  const isProd = process.env.NODE_ENV === "production";
  const hasDatabase = isConfigured(process.env.DATABASE_URL);
  const hasAuthSecret = isConfigured(process.env.AUTH_TOKEN_SECRET);
  const hasEmailProvider =
    (isConfigured(process.env.RESEND_API_KEY) || isConfigured(process.env.SENDGRID_API_KEY)) &&
    isConfigured(process.env.EMAIL_FROM);
  const hasSmsProvider =
    isConfigured(process.env.TWILIO_ACCOUNT_SID) &&
    isConfigured(process.env.TWILIO_AUTH_TOKEN) &&
    isConfigured(process.env.TWILIO_FROM_NUMBER);
  const hasMediaStorage = isProductionMediaStorageReady();
  // X2: OPENAI_API_KEY is now a hard boot requirement in production. Without it
  // AI diary generation would silently fall back to the rule-based generator for
  // EVERY request — an unrecorded downgrade of the product's headline feature
  // (finding C1). We keep the rule-based generator only as a RUNTIME fallback for
  // a reachable-but-erroring API (see routes/ai.ts), not as a substitute for a
  // missing key at boot.
  const hasOpenAI = isConfigured(process.env.OPENAI_API_KEY);

  if (isProd) {
    const secret = process.env.AUTH_TOKEN_SECRET ?? "";
    if (secret.length < 32 || /test|dev|secret|example|change.?me/i.test(secret)) {
      throw new Error(
        "AUTH_TOKEN_SECRET is too short or looks like a placeholder. " +
        "Generate 32+ random bytes (openssl rand -hex 32) and set it in production secrets."
      );
    }
    const missing = [
      !hasAuthSecret ? "AUTH_TOKEN_SECRET" : null,
      !hasDatabase ? "PostgreSQL DATABASE_URL" : null,
      !hasEmailProvider ? "email provider (RESEND/SENDGRID + EMAIL_FROM)" : null,
      !hasSmsProvider ? "Twilio SMS provider (SID, TOKEN, FROM_NUMBER)" : null,
      !hasMediaStorage ? "S3-compatible media storage (MEDIA_STORAGE_PROVIDER=s3 + S3_* env vars)" : null,
      !hasOpenAI ? "OPENAI_API_KEY (required for AI diary generation — set it in the Render service environment)" : null,
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new Error(`Missing production configuration: ${missing.join(", ")}`);
    }
    console.warn(
      "[auth] Production mode: rate limiting is in-memory and will reset on restart. " +
      "Use a reverse proxy (nginx/Cloudflare) or external rate limiter for multi-instance deployments."
    );
    return;
  }

  if (!hasAuthSecret) {
    console.warn("[auth] Dev mode warning: AUTH_TOKEN_SECRET is not set. Using insecure default — never use in production.");
  }
  if (!hasDatabase) {
    console.warn("[auth] Dev mode warning: DATABASE_URL is not set. Using in-memory auth fallback (data resets on restart).");
  }
  if (!hasMediaStorage) {
    console.warn("[uploads] Dev mode warning: media storage provider is not configured. Using local disk uploads.");
  }
  if (!hasEmailProvider || !hasSmsProvider) {
    console.warn(
      "[auth] Dev mode provider warning: using local code fallback. Configure RESEND/SENDGRID + EMAIL_FROM and TWILIO vars for real delivery."
    );
  }
}

const rawPort = process.env.PORT;
const PORT = rawPort && !isNaN(Number(rawPort)) ? Number(rawPort) : 4000;
const allowedOrigins = String(process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

/**
 * How many reverse proxies sit in front of this process.
 *
 * Every per-IP rate limit depends on this being right. Express counts hops from
 * the RIGHT of `X-Forwarded-For` (the socket end) inward, so the count is what
 * makes the client IP unspoofable: a client can prepend as many fake entries as
 * it likes and they all stay to the LEFT of the real one.
 *
 * Measured against the live deployment (2026-09-16), not assumed:
 *   dig api.getsitesnapai.com -> sitesap-ai.onrender.com
 *                             -> gcp-us-west1-1.origin.onrender.com
 *                             -> ...origin.onrender.com.cdn.cloudflare.net
 *   response headers carry BOTH `cf-ray`/`server: cloudflare` AND
 *   `x-render-origin-server: Render`.
 * So the chain is client -> Cloudflare (Render's own, not ours) -> Render
 * router -> this process: TWO hops. Render's docs do not state the count and
 * the community answer of `1` is for services without the CDN in front, which
 * is why this was measured rather than copied.
 *
 * Getting it wrong is asymmetric, so the direction of error matters:
 *   too LOW  -> req.ip is a Cloudflare/Render address, every user shares one
 *               bucket, limits over-block. Annoying, still fail-closed.
 *   too HIGH -> req.ip is read from client-supplied XFF -> every per-IP limit
 *               is bypassable. Fail-open. Never raise this to "just make it
 *               work".
 * Confirm with `GET /api/health/client-ip` (authenticated) after any change to
 * the hosting or domain setup; do not re-derive it from memory.
 */
const TRUST_PROXY_HOPS = (() => {
  const raw = process.env.TRUST_PROXY_HOPS;
  if (raw === undefined || raw.trim() === "") return 2;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `TRUST_PROXY_HOPS must be a non-negative integer (got ${JSON.stringify(raw)}). ` +
        "It is the number of proxies in front of the API; see server.ts for how to measure it."
    );
  }
  return parsed;
})();

export function createApp(): express.Express {
  const app = express();
  const isProdMode = process.env.NODE_ENV === "production";
  app.disable("x-powered-by");
  // Must be set before any middleware reads req.ip — rate limiting keys on it.
  app.set("trust proxy", TRUST_PROXY_HOPS);
  app.use(
    helmet({
      // CSP is intentionally disabled — the API serves JSON, not HTML.
      // Enable it if the API ever serves HTML pages.
      contentSecurityPolicy: false,
      // HSTS only applies over HTTPS; the header is harmless locally but
      // only set it in production where TLS is actually enforced.
      hsts: isProdMode ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    })
  );
  app.use(requestId);
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  // Public brand asset for transactional emails. Email clients can't load a
  // data: URI (Gmail strips them) or a repo file, so the logo is served here
  // as an absolute public URL; emailTemplates.ts LOGO_URL points at this path.
  // The file is copied into dist/assets by the Dockerfile (tsc doesn't copy
  // non-.ts files), mirroring how migrations are copied into dist/storage.
  app.get("/assets/logo.png", (_req, res) => {
    res.type("png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.sendFile(path.join(__dirname, "assets", "logo.png"));
  });
  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true); // same-origin or server-to-server
        if (allowedOrigins.length === 0) {
          if (isProdMode) return cb(new Error("CORS origin blocked: no CORS_ALLOWED_ORIGINS configured"));
          return cb(null, true); // dev: allow all (origin reflected back, not "*", so credentials work)
        }
        if (allowedOrigins.includes(origin)) return cb(null, true);
        return cb(new Error("CORS origin blocked"));
      },
      credentials: true, // required for httpOnly session cookie
    })
  );
  app.use(express.json({ limit: "25mb" }));
  app.use(httpLogger);
  app.use("/api", apiRouter);
  // Sentry error handler must come after routes and before any other error handler
  Sentry.setupExpressErrorHandler(app);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (typeof err === "object" && err !== null && "type" in err) {
      const kind = String((err as { type?: string }).type || "");
      if (kind === "entity.too.large") {
        return res.status(413).json({
          error: "Request payload is too large. Reduce photo count/size and retry.",
        });
      }
      if (kind === "entity.parse.failed") {
        return res.status(400).json({ error: "Malformed JSON request body." });
      }
    }
    console.error("[server] Unhandled request error", { reqId: _req.headers["x-request-id"], err });
    return res.status(500).json({ error: "Internal server error." });
  });
  return app;
}

export async function bootstrap() {
  validateProviderConfig();
  await runMigrations();
  await initAuthSchema();
  await initProjectSchema();
  const app = createApp();

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`✅ API running on http://0.0.0.0:${PORT}`);
  });

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${signal} received — shutting down gracefully`);
    server.close(async (err) => {
      if (err) console.error("[server] error closing HTTP server", err);
      try {
        const { getPgPool } = await import("./storage/postgres");
        await getPgPool().end();
        console.log("[server] database pool closed");
      } catch {
        // Pool may not be open in file-backed mode
      }
      process.exit(err ? 1 : 0);
    });
    // Force-exit if requests don't drain within 10 seconds
    setTimeout(() => {
      console.error("[server] force exit after 10s drain timeout");
      process.exit(1);
    }, 10_000).unref();
  }

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("uncaughtException", (err) => {
    console.error("[server] uncaughtException", err);
    Sentry.captureException(err);
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[server] unhandledRejection", reason);
    Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
  });

  return server;
}

if (require.main === module) {
  bootstrap().catch((error) => {
    console.error("❌ API startup failed", error);
    process.exit(1);
  });
}
