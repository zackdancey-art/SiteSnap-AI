/**
 * Rate limiter with:
 * - Per-account (email) primary limit for login — so a crew on one shared IP each gets their own budget
 * - Per-identifier limits (phone, email-or-phone) where the cost lands on a PERSON, not a bill
 * - Per-company limits for authenticated spend (AI generation)
 * - Per-IP generous backstop — blocks bots/scanners without throttling legitimate crews
 * - All thresholds configurable via env vars (no code change needed to tune)
 * - Redis backend when REDIS_URL is set; in-memory fallback otherwise, LOUDLY
 * - Test-mode bypass: only when NODE_ENV === "test" AND RATE_LIMIT_DISABLE === "1"
 */

import { Request, Response, NextFunction } from "express";
import { Sentry } from "../instrument";
import type { AuthenticatedRequest } from "./auth";

// ─── Configuration ──────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v !== undefined ? parseInt(v, 10) : NaN;
  return isNaN(n) ? fallback : n;
}

export const LIMITS = {
  // Login: per-account (primary brute-force protection)
  loginPerAccount: {
    max: envInt("RATE_LIMIT_LOGIN_PER_ACCOUNT", 10),
    windowMs: envInt("RATE_LIMIT_LOGIN_PER_ACCOUNT_WINDOW_MS", 15 * 60 * 1000),
  },
  // Login: per-IP (generous backstop — stops scanners, not crews)
  loginPerIp: {
    max: envInt("RATE_LIMIT_LOGIN_PER_IP", 300),
    windowMs: envInt("RATE_LIMIT_LOGIN_PER_IP_WINDOW_MS", 15 * 60 * 1000),
  },
  // Registration initiate: per-IP (one network can onboard a whole crew)
  registerPerIp: {
    max: envInt("RATE_LIMIT_REGISTER_PER_IP", 30),
    windowMs: envInt("RATE_LIMIT_REGISTER_PER_IP_WINDOW_MS", 60 * 60 * 1000),
  },
  // Registration verify: per-IP (slightly higher — retries are common)
  registerVerifyPerIp: {
    max: envInt("RATE_LIMIT_REGISTER_VERIFY_PER_IP", 60),
    windowMs: envInt("RATE_LIMIT_REGISTER_VERIFY_PER_IP_WINDOW_MS", 10 * 60 * 1000),
  },
  // OTP send: per-account burst — prevents an address from being repeatedly spammed
  otpSendPerAccount: {
    max: envInt("RATE_LIMIT_OTP_SEND_PER_ACCOUNT", 5),
    windowMs: envInt("RATE_LIMIT_OTP_SEND_PER_ACCOUNT_WINDOW_MS", 15 * 60 * 1000),
  },
  // OTP send: per-account daily ceiling — belt-and-suspenders against sustained abuse
  otpSendPerAccountDaily: {
    max: envInt("RATE_LIMIT_OTP_SEND_PER_ACCOUNT_DAILY", 20),
    windowMs: envInt("RATE_LIMIT_OTP_SEND_PER_ACCOUNT_DAILY_WINDOW_MS", 24 * 60 * 60 * 1000),
  },
  /**
   * OTP send: per PHONE NUMBER.
   *
   * Every other OTP limit here keys on the email, which is the attacker's
   * choice, not the victim's. Cycling throwaway mailboxes against one real
   * phone number therefore bought unbounded SMS to a person who never signed
   * up for anything — an SMS-bombing vector aimed at a human being, not merely
   * a Twilio bill. The phone is the thing being harmed, so the phone is what
   * has to be counted.
   *
   * Deliberately tight: a legitimate signup needs ONE code, and a resend or two
   * if the first is slow. Three in fifteen minutes is generous for the honest
   * case and useless for the abusive one.
   */
  otpSendPerPhone: {
    max: envInt("RATE_LIMIT_OTP_SEND_PER_PHONE", 3),
    windowMs: envInt("RATE_LIMIT_OTP_SEND_PER_PHONE_WINDOW_MS", 15 * 60 * 1000),
  },
  // OTP send: per-phone daily ceiling. This is the cap that actually protects a
  // victim over a sustained campaign — see the note on durability in
  // getRateLimiterStatus(): it only holds if the counter survives a restart.
  otpSendPerPhoneDaily: {
    max: envInt("RATE_LIMIT_OTP_SEND_PER_PHONE_DAILY", 10),
    windowMs: envInt("RATE_LIMIT_OTP_SEND_PER_PHONE_DAILY_WINDOW_MS", 24 * 60 * 60 * 1000),
  },
  // OTP send: per-IP — stops a bot cycling through addresses from one host
  otpSendPerIp: {
    max: envInt("RATE_LIMIT_OTP_SEND_PER_IP", 20),
    windowMs: envInt("RATE_LIMIT_OTP_SEND_PER_IP_WINDOW_MS", 60 * 60 * 1000),
  },
  // OTP verify: max failed attempts before the pending registration is invalidated
  otpVerifyMaxAttempts: envInt("RATE_LIMIT_OTP_VERIFY_MAX_ATTEMPTS", 5),
  // Password reset send: per-IP
  forgotPasswordPerIp: {
    max: envInt("RATE_LIMIT_FORGOT_PASSWORD_PER_IP", 8),
    windowMs: envInt("RATE_LIMIT_FORGOT_PASSWORD_PER_IP_WINDOW_MS", 10 * 60 * 1000),
  },
  /**
   * Password reset send: per IDENTIFIER (the normalized email or phone asked for).
   *
   * /auth/forgot-password accepts channel=sms and will text a registered user's
   * phone. With only a per-IP limit, an attacker who knows one victim's email
   * could text them from as many IPs as they cared to rent. Keying on the
   * identifier makes the victim's own address the budget, which is the thing
   * that needs protecting.
   */
  forgotPasswordPerIdentifier: {
    max: envInt("RATE_LIMIT_FORGOT_PASSWORD_PER_IDENTIFIER", 3),
    windowMs: envInt("RATE_LIMIT_FORGOT_PASSWORD_PER_IDENTIFIER_WINDOW_MS", 15 * 60 * 1000),
  },
  forgotPasswordPerIdentifierDaily: {
    max: envInt("RATE_LIMIT_FORGOT_PASSWORD_PER_IDENTIFIER_DAILY", 10),
    windowMs: envInt("RATE_LIMIT_FORGOT_PASSWORD_PER_IDENTIFIER_DAILY_WINDOW_MS", 24 * 60 * 60 * 1000),
  },
  // Password reset confirm: per-IP
  resetPasswordPerIp: {
    max: envInt("RATE_LIMIT_RESET_PASSWORD_PER_IP", 12),
    windowMs: envInt("RATE_LIMIT_RESET_PASSWORD_PER_IP_WINDOW_MS", 10 * 60 * 1000),
  },
  /**
   * AI diary generation: per COMPANY, not per IP.
   *
   * Keyed on IP this was worse than useless on both sides: a whole crew behind
   * one site router shared a single budget, while an attacker with an account
   * and a handful of proxies had none. The spend is authenticated, so the payer
   * is known — key on them.
   *
   * Sized so no legitimate crew ever meets it. It exists to stop ONE account
   * hammering, not to cap total exposure; the prepaid OpenAI balance with
   * auto-recharge off is what actually bounds the spend.
   */
  generateDiaryPerCompany: {
    max: envInt("RATE_LIMIT_GENERATE_DIARY_PER_COMPANY", 30),
    windowMs: envInt("RATE_LIMIT_GENERATE_DIARY_PER_COMPANY_WINDOW_MS", 60 * 60 * 1000),
  },
  // Bulk invite: per-account (prevents invite spam from a single account)
  bulkInvitePerAccount: {
    max: envInt("RATE_LIMIT_BULK_INVITE_PER_ACCOUNT", 20),
    windowMs: envInt("RATE_LIMIT_BULK_INVITE_PER_ACCOUNT_WINDOW_MS", 10 * 60 * 1000),
  },
};

// ─── Test-mode bypass ───────────────────────────────────────────────────────

// HARD GATE: both conditions must be true. Production code can never satisfy both
// because NODE_ENV is always "production" in the deployed environment.
function isTestBypassActive(): boolean {
  return process.env.NODE_ENV === "test" && process.env.RATE_LIMIT_DISABLE === "1";
}

// ─── Store abstraction ──────────────────────────────────────────────────────

type RateLimitRecord = { count: number; resetAt: number };
const inMemoryStore = new Map<string, RateLimitRecord>();

function incrementMemory(key: string, windowMs: number): number {
  const now = Date.now();
  const current = inMemoryStore.get(key);
  if (!current || now > current.resetAt) {
    inMemoryStore.set(key, { count: 1, resetAt: now + windowMs });
    return 1;
  }
  current.count += 1;
  inMemoryStore.set(key, current);
  return current.count;
}

function peekMemory(key: string): number {
  const current = inMemoryStore.get(key);
  if (!current || Date.now() > current.resetAt) return 0;
  return current.count;
}

// ─── Redis backend state ────────────────────────────────────────────────────

/**
 * Why this is a state machine and not a boolean.
 *
 * The previous version fell back to in-memory counting on any Redis error and
 * said nothing an operator would ever see. A rate limiter that has quietly
 * stopped sharing state across instances still returns 200s and still looks
 * healthy — you find out from a bill or from a victim, which is the whole
 * failure mode this work exists to remove. Degraded is a state worth naming,
 * reporting once, and exposing on /health/ready.
 */
export type RateLimiterState = "disabled" | "connected" | "degraded" | "unavailable";

let redisClient: unknown | null = null;
let redisConnectAttempted = false;
let redisState: RateLimiterState = "disabled";
let redisLastError: string | null = null;
let redisDegradedSince: number | null = null;
let redisFallbackCount = 0;
/**
 * How many times the limiter has ANNOUNCED a degradation (transitions), as
 * distinct from redisFallbackCount (individual fallen-back operations).
 *
 * This exists because the announcement is otherwise unobservable. Sentry is
 * deliberately never initialised in test mode (see instrument.ts — init() wires
 * real network transport), so captureMessage is a no-op there, and @sentry/node
 * exports it as a non-configurable getter that cannot be stubbed. Counting at
 * the call site is what makes "reported once, not once per request" a property a
 * test can actually check.
 */
let redisDegradationReports = 0;

/**
 * Strip credentials before a REDIS_URL goes anywhere a human or a log sink can
 * read it. The previous boot line printed process.env.REDIS_URL verbatim, which
 * put the instance password into the log stream on every start.
 */
export function redactRedisUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    if (u.username) u.username = "***";
    return u.toString();
  } catch {
    return "<unparseable REDIS_URL>";
  }
}

function markDegraded(reason: string): void {
  redisFallbackCount += 1;
  redisLastError = reason;
  // Report the TRANSITION, not every request. A Redis outage on a busy path
  // would otherwise emit one Sentry event per request and bury itself.
  if (redisState === "degraded") return;
  redisState = "degraded";
  redisDegradedSince = Date.now();
  redisDegradationReports += 1;
  console.error(
    `[ratelimit] DEGRADED: Redis is unreachable — counting in process memory. ` +
      `Limits no longer apply across instances and will reset on restart. Reason: ${reason}`
  );
  Sentry.captureMessage(`[ratelimit] degraded to in-memory counting: ${reason}`, "error");
}

function markConnected(): void {
  const wasDegraded = redisState === "degraded";
  redisState = "connected";
  redisDegradedSince = null;
  redisLastError = null;
  if (wasDegraded) {
    console.warn("[ratelimit] RECOVERED: Redis is reachable again — counting in Redis.");
  }
}

/** Rate limiter backend state, for /health/ready. */
export function getRateLimiterStatus(): {
  backend: "redis" | "memory";
  state: RateLimiterState;
  degradedSince: string | null;
  fallbackCount: number;
  degradationReports: number;
  lastError: string | null;
} {
  return {
    backend: redisState === "connected" ? "redis" : "memory",
    state: redisState,
    degradedSince: redisDegradedSince ? new Date(redisDegradedSince).toISOString() : null,
    fallbackCount: redisFallbackCount,
    degradationReports: redisDegradationReports,
    lastError: redisLastError,
  };
}

/** One line at boot so the backend in use is never a mystery. */
export function logRateLimiterBackendAtBoot(): void {
  if (!process.env.REDIS_URL) {
    console.warn(
      "[ratelimit] REDIS_URL is not set — rate limits are counted in process memory. " +
        "They do NOT apply across instances and reset on every restart, so the 24h " +
        "ceilings (OTP-per-phone, forgot-password-per-identifier) do not survive a deploy."
    );
    return;
  }
  console.log(`[ratelimit] REDIS_URL is set (${redactRedisUrl(process.env.REDIS_URL)}) — using Redis for rate limits.`);
}

async function getRedisClient(): Promise<unknown | null> {
  if (!process.env.REDIS_URL) return null;
  if (redisConnectAttempted) return redisClient;
  redisConnectAttempted = true;

  try {
    // Dynamic import so ioredis is optional — falls back to in-memory if absent.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { default: Redis } = require("ioredis") as {
      default: new (url: string, opts: Record<string, unknown>) => {
        on: (evt: string, cb: (arg: Error) => void) => void;
      };
    };
    const client = new Redis(process.env.REDIS_URL, {
      // Fail fast instead of queueing. With the default (true), commands issued
      // while the connection is down are QUEUED rather than rejected, so
      // `await incr()` hangs on the login path until the socket recovers —
      // turning a limiter fault into an availability outage. We would rather
      // get an error we can catch and answer from memory.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
    });
    // Keep the client on error: ioredis reconnects on its own, and throwing the
    // instance away (as the previous version did) meant one blip pinned the
    // process to in-memory counting until someone restarted it.
    client.on("error", (err: Error) => markDegraded(err.message));
    client.on("ready", () => markConnected());
    redisClient = client;
    redisState = "connected";
  } catch (err) {
    redisState = "unavailable";
    redisLastError = err instanceof Error ? err.message : String(err);
    console.error(
      "[ratelimit] ioredis could not be loaded — rate limits will be counted in process memory only.",
      redisLastError
    );
    Sentry.captureMessage(`[ratelimit] ioredis unavailable: ${redisLastError}`, "error");
  }

  return redisClient;
}

async function incrementRedis(redis: unknown, key: string, windowMs: number): Promise<number> {
  const r = redis as {
    incr: (k: string) => Promise<number>;
    expire: (k: string, s: number) => Promise<number>;
    pttl: (k: string) => Promise<number>;
  };
  const count = await r.incr(key);
  if (count === 1) {
    await r.expire(key, Math.ceil(windowMs / 1000));
  } else if (count === 2) {
    // Safety: re-set TTL on second increment in case the first expire didn't land
    const ttl = await r.pttl(key);
    if (ttl < 0) await r.expire(key, Math.ceil(windowMs / 1000));
  }
  return count;
}

/**
 * Increment a key and return the new count.
 *
 * Every Redis call is wrapped: an unwrapped failure here used to propagate out
 * of the limiter and 500 the request it was supposed to be protecting. Counting
 * in memory is a worse limit but a working login.
 */
async function increment(key: string, windowMs: number): Promise<number> {
  const redis = await getRedisClient();
  if (redis) {
    try {
      const count = await incrementRedis(redis, key, windowMs);
      markConnected();
      return count;
    } catch (err) {
      markDegraded(err instanceof Error ? err.message : String(err));
    }
  }
  return incrementMemory(key, windowMs);
}

/** Read a key's current count WITHOUT consuming budget. Same fallback contract. */
async function peek(key: string): Promise<number> {
  const redis = await getRedisClient();
  if (redis) {
    try {
      const raw = await (redis as { get: (k: string) => Promise<string | null> }).get(key);
      markConnected();
      const n = raw === null ? 0 : parseInt(raw, 10);
      return isNaN(n) ? 0 : n;
    } catch (err) {
      markDegraded(err instanceof Error ? err.message : String(err));
    }
  }
  return peekMemory(key);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * The client IP every per-IP limit is keyed on.
 *
 * This deliberately does NOT read `X-Forwarded-For` itself. The previous version
 * took the FIRST entry of that header, which is the one furthest from us and
 * entirely attacker-supplied: varying one header gave a fresh counter per
 * request and made every per-IP limit in this file decorative.
 *
 * `req.ip` is Express's proxy-aware value, resolved by walking in from the
 * socket end and skipping exactly `trust proxy` hops (set in server.ts). Forged
 * entries sit beyond that boundary and cannot move it, however many are sent.
 */
function getClientIp(req: Request): string {
  return req.ip || "unknown";
}

/** Namespace for a keyed limit. Distinct namespaces cannot collide. */
export type LimitKeyKind = "ip" | "acct" | "phone" | "identifier" | "company";

export type LimitCheckOptions = {
  /**
   * Check the budget WITHOUT consuming any of it.
   *
   * For limits whose cost is incurred later in a multi-stage flow: the stage
   * that spends the resource increments, and earlier stages peek so an
   * already-exhausted caller is turned away without the counter meaning two
   * different things. Incrementing at both would halve the real budget and
   * would punish an abandoned attempt that never cost anything.
   */
  peek?: boolean;
};

/**
 * Check (and by default consume) a rate-limit budget for an arbitrary key.
 * Returns true when the caller is over the limit.
 */
export async function isRateLimitedByKey(
  kind: LimitKeyKind,
  identifier: string,
  action: string,
  max: number,
  windowMs: number,
  opts: LimitCheckOptions = {}
): Promise<boolean> {
  if (isTestBypassActive()) return false;
  // Normalise casing so one identifier cannot hold several counters.
  const key = `rl:${action}:${kind}:${identifier.toLowerCase()}`;
  if (opts.peek) {
    const count = await peek(key);
    // `>=`, not `>`. The increment path blocks when the NEW count exceeds max,
    // so a budget of `max` is fully spent once the stored count reaches `max`.
    // Peeking with `>` would let exactly one extra caller through the early
    // gate — which on this flow is one more SMS to the victim.
    return count >= max;
  }
  const count = await increment(key, windowMs);
  return count > max;
}

/**
 * Check if an IP-keyed action is rate-limited.
 * Returns true (blocked) if over the limit.
 */
export async function isRateLimitedByIp(
  req: Request,
  action: string,
  max: number,
  windowMs: number
): Promise<boolean> {
  return isRateLimitedByKey("ip", getClientIp(req), action, max, windowMs);
}

/**
 * Check if an account-keyed action is rate-limited.
 * Use for login: each user account gets its own counter, independent of IP.
 * Returns true (blocked) if over the limit.
 */
export async function isRateLimitedByAccount(
  identifier: string,
  action: string,
  max: number,
  windowMs: number
): Promise<boolean> {
  return isRateLimitedByKey("acct", identifier, action, max, windowMs);
}

/**
 * Check if a phone-keyed action is rate-limited. The phone must already be
 * normalized by the caller (normalizePhone runs before validation in auth.ts),
 * so "+61 400 000 000" and "+61400000000" share one counter rather than two.
 */
export async function isRateLimitedByPhone(
  phone: string,
  action: string,
  max: number,
  windowMs: number,
  opts: LimitCheckOptions = {}
): Promise<boolean> {
  return isRateLimitedByKey("phone", phone, action, max, windowMs, opts);
}

/**
 * Legacy / generic rate limit keyed by IP + action.
 * Kept for backward compatibility with other middleware uses.
 */
export async function isRateLimited(
  req: Request,
  action: string,
  max: number,
  windowMs: number
): Promise<boolean> {
  return isRateLimitedByIp(req, action, max, windowMs);
}

/**
 * Express middleware factory, keyed on IP.
 * Only appropriate for UNauthenticated routes — if the caller is authenticated,
 * the payer is known and rateLimitByCompany is the correct key.
 */
export function rateLimit(action: string, maxRequests: number, windowMs: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (await isRateLimitedByIp(req, action, maxRequests, windowMs)) {
      return res.status(429).json({ error: "Too many requests. Please try again shortly." });
    }
    return next();
  };
}

/**
 * Express middleware factory, keyed on the authenticated actor's company.
 *
 * MUST be mounted after requireAuth. If it somehow runs unauthenticated there
 * is no company to charge, so it fails CLOSED with a 401 rather than silently
 * falling back to a shared "unknown" bucket that every caller would share.
 */
export function rateLimitByCompany(action: string, maxRequests: number, windowMs: number) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const companyId = (req as AuthenticatedRequest).auth?.companyId;
    if (!companyId) {
      return res.status(401).json({ error: "Authentication required." });
    }
    if (await isRateLimitedByKey("company", companyId, action, maxRequests, windowMs)) {
      return res.status(429).json({
        error: "Your company has reached its limit for this action. Please try again later.",
      });
    }
    return next();
  };
}

/**
 * Reset in-memory store — for use in integration tests only.
 * Has no effect on Redis contents (a test using Redis should flush it itself).
 */
export function resetRateLimitStoreForTests(): void {
  inMemoryStore.clear();
  // Hang up before dropping the reference. ioredis retries a failed connection
  // forever on a timer, so a client that is merely forgotten keeps the event
  // loop alive and keeps reconnecting — the test process then never exits, and
  // each reset leaks another retrying client on top of the last.
  const previous = redisClient as { disconnect?: () => void } | null;
  if (previous && typeof previous.disconnect === "function") {
    try { previous.disconnect(); } catch { /* already gone */ }
  }
  redisClient = null;
  redisConnectAttempted = false;
  redisState = "disabled";
  redisLastError = null;
  redisDegradedSince = null;
  redisFallbackCount = 0;
  redisDegradationReports = 0;
}
