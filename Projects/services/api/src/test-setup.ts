/**
 * Preloaded test setup — loaded via `node --require ./dist/test-setup.js` BEFORE
 * the test runner imports any test file.
 *
 * Why this has to be a preload and not per-file code: several modules capture
 * environment-derived values in module-scope constants at first import
 * (e.g. `routes/auth.ts`'s `isProd`/`hasDatabase`, computed once when the
 * module is first required). A test file's own top-level
 * `delete process.env.DATABASE_URL` / `process.env.NODE_ENV = "test"` runs
 * too late to matter: `import { createApp } from "../server"` at the top of
 * that file is hoisted above the file's own statements and pulls in
 * `routes/auth.ts` (and other modules) first, so those constants are already
 * frozen with whatever `.env` set (production DB, live provider keys)
 * before the file's reset lines ever execute. A `--require` preload runs as
 * its own script before Node even begins loading the test file, so these
 * env vars are correct before any app module is ever imported.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ALLOWLIST, NOT DENYLIST. This file used to blank two keys by name —
 * DATABASE_URL and OPENAI_API_KEY — and let everything else through. That is
 * backwards, and the reason is not stylistic:
 *
 *   A denylist requires whoever adds an env var to remember to come here and
 *   add it. Nothing enforces that, nothing reports the omission, and the
 *   failure mode is a test suite that quietly talks to a real provider. The
 *   API's `.env` carries live RESEND, TWILIO, S3 and SENTRY credentials, all
 *   of which were reaching the suite. `routes/ai.ts` was covered only because
 *   OPENAI_API_KEY happened to be one of the two names someone thought of.
 *
 *   An allowlist needs the opposite knowledge: not a complete list of every
 *   dangerous key (unknowable — it includes the ones not written yet), but a
 *   complete list of the safe ones (short, and knowable). A new provider key
 *   is blanked the day it is added, by someone who has never read this file.
 *
 * The trade is that adding a var a test genuinely needs means adding it here.
 * That is the intended cost: it is one line, in review, with a reason.
 */

import fs from "fs";
import path from "path";
import dotenv from "dotenv";

process.env.NODE_ENV = "test";

/**
 * Environment variables the test suite is allowed to see.
 *
 * Everything here is either required for Node and pnpm to function, or is
 * inert configuration that cannot cause a network call or reach real data.
 * Nothing that authenticates to anything belongs in this list.
 */
const ALLOWED = new Set([
  // --- the suite's own switches ---
  "NODE_ENV",
  // The DB-gated suites (RLS, store round-trip) select themselves on this.
  // Blanking it would turn all 5 into permanent skips — a green build proving
  // nothing about tenancy — which is the precise failure this file's whole
  // neighbourhood exists to prevent. It points at a scratch database created
  // by CI, never at production.
  "TEST_DATABASE_URL",
  "CI",
  // Read at the bottom of this file. Must be allowed, or the loop below blanks
  // it before the debug check runs and the switch silently does nothing.
  "TEST_ENV_DEBUG",

  // --- NOT allowlisted, deliberately: ordinary app config ---
  //
  // PORT, TRUST_PROXY_HOPS, CORS_ALLOWED_ORIGINS, OPENAI_MODEL,
  // MEDIA_STORAGE_PROVIDER, SUPERVISOR_SIGNUP_EMAILS and the rest are all
  // blanked, even the ones that carry no credential. CI has no `.env` file at
  // all, so ANY value the suite picks up from one is a way for a local run and
  // a CI run to execute different code — the divergence class this work exists
  // to remove. Tests that need a value set it themselves, in the file, where a
  // reader can see it.
  //
  // MEDIA_STORAGE_PROVIDER is the worked example. `.env` sets it to "s3", and
  // mediaStorage.useS3Storage() has no NODE_ENV guard, so under the previous
  // two-name denylist — which left both the provider AND the S3 credentials
  // intact — every upload test wrote to the real bucket and passed because the
  // write genuinely succeeded. Blanking it drops uploads back to the local
  // disk adapter, which is what CLAUDE.md §6 requires and what CI already did.

  // --- OS / shell: Node, pnpm and child processes need these ---
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "COLORTERM",
  "FORCE_COLOR",
  "NO_COLOR",
  "SHLVL",
  "_",
]);

/**
 * Prefixes allowed wholesale. These are toolchain namespaces with many
 * generated members (pnpm alone injects dozens of `npm_package_*` keys), and
 * none of them carry application credentials.
 */
const ALLOWED_PREFIXES = ["npm_", "NPM_", "PNPM_", "NODE_", "__CF", "XPC_", "SSH_", "LC_"];

/**
 * Blanked with "", never `delete`d.
 *
 * `server.ts` and `instrument.ts` both call `dotenv.config()` when they are
 * imported, which happens AFTER this preload. dotenv only fills in keys that
 * are ABSENT from process.env; an empty string counts as present and is left
 * alone. So a `delete`d key is silently repopulated from `.env` — with the
 * real production DATABASE_URL and the real Twilio token — the moment the app
 * is imported, while a blanked one stays blank.
 *
 * Every consumer in the codebase tests these with a truthiness or
 * `.trim()`-style check (`Boolean(DATABASE_URL && DATABASE_URL.trim())`,
 * `if (!process.env.OPENAI_API_KEY)`), so "" behaves exactly like unset —
 * it just also survives dotenv. Numeric reads go through `utils/env.ts`,
 * which treats "" as "unset" rather than coercing it to 0.
 */
function isAllowed(key: string): boolean {
  return ALLOWED.has(key) || ALLOWED_PREFIXES.some((p) => key.startsWith(p));
}

/**
 * The keys to blank are the union of two sets, and the second one is the
 * reason this is not a five-line file.
 *
 *  1. What is in process.env right now — the inherited shell environment.
 *
 *  2. What `.env` DECLARES but has not injected yet. This is the subtle half.
 *     dotenv.config() runs later, on import of server.ts/instrument.ts, so at
 *     this moment the real TWILIO_AUTH_TOKEN is not in process.env at all and
 *     a loop over Object.keys(process.env) cannot see it. Blanking only what
 *     is already present would therefore be WEAKER than the two-name denylist
 *     this file replaced — the old code worked precisely because it blanked
 *     DATABASE_URL and OPENAI_API_KEY *pre-emptively*, reserving the key so
 *     dotenv would skip it.
 *
 *     This was measured, not reasoned about: the first version of this file
 *     blanked only set keys, and `dotenv.config()` afterwards put a real
 *     32-character Twilio auth token straight into the suite.
 *
 * So `.env` is parsed here with dotenv's own parser (same file, same grammar,
 * no second-guessing of the format) and every key it declares is reserved.
 */
const declaredInDotenv: string[] = (() => {
  const file = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(file)) return [];
  try {
    return Object.keys(dotenv.parse(fs.readFileSync(file)));
  } catch {
    // A malformed .env is the app's problem to report, not this preload's.
    return [];
  }
})();

const blanked: string[] = [];
for (const key of new Set([...Object.keys(process.env), ...declaredInDotenv])) {
  if (isAllowed(key)) continue;
  if (process.env[key] === "") continue;
  process.env[key] = "";
  blanked.push(key);
}

// Deliberately NOT allowlisted above, so the real signing secret from `.env`
// is blanked with everything else and this default always wins. Tests have no
// use for the production secret — they mint and verify their own tokens — and
// a suite holding the live one is a credential in a process that also runs
// arbitrary test code. Tests that want a specific secret set it themselves.
process.env.AUTH_TOKEN_SECRET = "test-suite-default-secret-do-not-use-in-prod";

// Opt-in visibility. Not printed by default — it would be thousands of lines
// across the suite — but `TEST_ENV_DEBUG=1` is how you find out why a test
// that needs a variable is not seeing it.
if (process.env.TEST_ENV_DEBUG) {
  console.error(`[test-setup] blanked ${blanked.length} env var(s): ${blanked.sort().join(", ")}`);
}
