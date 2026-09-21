# SiteSnap — Release Runbook

Last updated: September 2026  
Applies to: Expo SDK 54 / React Native (iOS + Android) + Express API

---

## 1. Pre-release checklist

Run these from `Projects/` before triggering any build:

```bash
pnpm install          # ensure lockfile is clean
pnpm -r run typecheck # zero errors required
pnpm -r run test      # review failures — none on non-AI paths acceptable
pnpm audit            # review new vulnerabilities; address criticals before shipping
```

Expected state after the June 2026 engineering push:
- `pnpm -r run typecheck` → clean
- `pnpm audit` → 15 remaining (9 moderate / 6 high, all in dev tools or requiring major-version human decisions — see [dependency audit PR](https://github.com/zackdancey-art/SiteSap-AI/pulls) for details)
- 4 AI unit tests failing on `main` (pre-existing; fixed in PR #1 pending merge)

### Before changing `OPENAI_MODEL`

**Run the live contract suite against the new model before setting it in
Render.** This is a separate, opt-in step and it is not covered by CI:

```bash
OPENAI_MODEL=<the-new-model> OPENAI_LIVE_TEST_KEY=sk-... \
  pnpm -C Projects --filter services-api run test:openai
```

Why this exists, rather than trusting a green build: models differ in which
request parameters they accept, and the ordinary suite cannot see the
difference. The OpenAI client is mocked at the boundary in `NODE_ENV=test`
(`services/openaiClient.ts`), and that mock returns a canned success for *any*
argument object — so a request carrying a parameter the real model rejects
passes every test we have.

That is not hypothetical. Switching `OPENAI_MODEL` to `gpt-5.6-terra`
(2026-09-21) sent `temperature: 0.3`, which that model rejects with a 400. Every
diary silently became a rule-based template, the full suite stayed green
throughout, and the failure reached Sentry as "The AI service was unavailable"
— pointing at OpenAI for a fault that was entirely in our own configuration
(SITESNAP-API-9).

If the new model needs a different parameter set, update
`MODELS_SUPPORTING_SAMPLING_PARAMS` in `services/api/src/routes/ai.ts` in the
same change. Add a model to that table only after a request carrying
`temperature` has returned 200 for it against the real API — never because the
name looks like it belongs to a family that supports it.

After deploying a model change, confirm the path really is AI-backed rather than
falling back. `generator` must be `openai`, not `fallback`:

```bash
curl -s -X POST https://api.getsitesnapai.com/api/generate-diary \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"period":"daily","entries":[{"date":"2026-01-01","notes":"Test entry.","weather":"Fine","crewCount":"2"}]}' \
  | jq '{generator: .generation.generator, model: .generation.model, warning: .warning}'
```

A `generator` of `fallback` with a 400-shaped warning means the parameter set is
wrong for the configured model. Revert `OPENAI_MODEL` to restore service, then
fix the table.

Then confirm the rate limiter is actually using Redis — configuring `REDIS_URL`
and *using* Redis are two different facts. If it cannot connect, the limiter
falls back to process memory by design so a Redis outage never locks users out;
it announces that once (error log + one Sentry event), but the requests still
succeed, so nothing about the API's behaviour will tell you on its own.

```bash
curl -s https://api.getsitesnapai.com/api/health/ready | jq .rateLimiter
```

**Read `state` before `backend`.** The connection is opened lazily, on the first
rate-limited request — so immediately after a deploy, on a quiet service, the
honest answer is that nothing has been attempted yet. That is not a fault, and
the field says so rather than guessing:

| `state` | Means | Action |
|---|---|---|
| `disabled` | `REDIS_URL` is not set. In-memory by **configuration**, not by fault. | Set `REDIS_URL` if you expected Redis. |
| `configured` | `REDIS_URL` is set; no rate-limited request has run yet. | Not an error. Exercise a limited endpoint (below) and re-read. |
| `connecting` | The socket is opening. Commands in this window fall back to memory. | Re-read in a few seconds. |
| `connected` | Counting in Redis. **This is the state to ship on.** | — |
| `degraded` | It worked (or the connect window expired) and now does not. | Check `lastError`. Do **not** ship on this. |
| `unavailable` | The `ioredis` module could not be loaded at all. | A build/dependency problem, not a network one. |

To move it off `configured`, make one request against a rate-limited endpoint —
a login for an address that does not exist is enough, and costs nothing:

```bash
curl -s -o /dev/null -X POST https://api.getsitesnapai.com/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"readiness-probe@invalid.test","password":"x"}'
curl -s https://api.getsitesnapai.com/api/health/ready | jq .rateLimiter
# want: {"backend":"redis","state":"connected","degradedSince":null,...}
```

`fallbackCount` counts operations that fell back to memory and `degradationReports`
counts announced incidents. A small non-zero `fallbackCount` with `state:"connected"`
and `degradationReports:0` is normal — those are requests that arrived during the
handshake. A rising `degradationReports` is the signal that matters.

---

## 2. Environment variables required in production

### API (`services/api`)

| Variable | Purpose | Required |
|---|---|---|
| `NODE_ENV=production` | Enables prod-mode validations and strict CORS | Yes |
| `AUTH_TOKEN_SECRET` | JWT signing key — min 32 chars, no placeholder | Yes |
| `DATABASE_URL` | PostgreSQL connection string | Yes |
| `RESEND_API_KEY` or `SENDGRID_API_KEY` | Transactional email | Yes (one) |
| `EMAIL_FROM` | Verified sender address | Yes |
| `TWILIO_ACCOUNT_SID` | SMS delivery | Yes |
| `TWILIO_AUTH_TOKEN` | SMS delivery | Yes |
| `TWILIO_FROM_NUMBER` | SMS sender number | Yes |
| `MEDIA_STORAGE_PROVIDER` | `s3`, `r2`, or `aws` | Yes |
| `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3/R2 storage | Yes |
| `S3_ENDPOINT` | Custom endpoint for R2/MinIO | If using R2 |
| `OPENAI_API_KEY` | GPT-4o vision diary generation | Yes |
| `OPENAI_MODEL` | Override model, default `gpt-4o`. **Never change this without running `test:openai` against the new model first — see §1.** Models differ in which request parameters they accept, and a rejected parameter fails *every* generation silently | No |
| `CORS_ALLOWED_ORIGINS` | Comma-separated allowed origins | Yes in prod |
| `UPLOAD_SIGNING_SECRET` | HMAC key for signed upload URLs | Yes |
| `SENTRY_DSN` | Error tracking | Recommended |
| `REDIS_URL` | Rate-limit counter store (Render Key Value). Without it, limits are per-process and reset on every deploy | Recommended — see §11 |
| `RATE_LIMIT_*` | Per-limit thresholds and windows; all optional, defaults in `.env.example` | No |
| `PORT` | HTTP port, default 4000 | No |

### Mobile (`apps/mobile`)

| Variable | Purpose |
|---|---|
| `EXPO_PUBLIC_API_BASE_URL` | Production API base URL (HTTPS required) |
| `APP_ENV=production` | Disables NSAllowsArbitraryLoads, enables OTA updates |

---

## 3. Database migrations

Migrations run automatically on API startup via `runMigrations()`. Never run them manually against a live database.

Current migrations:
- `001_initial_schema.sql` — auth + project tables
- `002_add_updated_at.sql` — updated_at column
- `003_perf_indexes.sql` — composite indexes for list queries (merged in June 2026 perf PR)

To add a new migration: create `NNN_description.sql` in `services/api/src/storage/migrations/`. It runs once, in filename order, inside a transaction.

---

## 4. Docker / API deployment

A multi-stage `Dockerfile` lives at the repo root. Build context must be the repo root:

```bash
docker build -t sitesnap-api:latest .
docker run -p 4000:4000 \
  -e NODE_ENV=production \
  -e AUTH_TOKEN_SECRET=... \
  -e DATABASE_URL=... \
  sitesnap-api:latest
```

The image runs `node Projects/services/api/dist/server.js`. It responds to `SIGTERM` with a 10 s graceful drain.

Health check: `GET /health` → `{"status":"ok"}`

---

## 5. EAS builds (iOS + Android)

Prerequisite: `eas.json` is present at `apps/mobile/eas.json` and `eas.projectId` is set in `app.config.ts`.

### Development build (device)
```bash
cd Projects/apps/mobile
eas build --profile development --platform all
```

### Preview / TestFlight / Internal Testing
```bash
eas build --profile preview --platform all
```

### Production build
```bash
eas build --profile production --platform all
```

### Submit to stores
```bash
# iOS — App Store Connect
eas submit --profile production --platform ios

# Android — Google Play
eas submit --profile production --platform android
```

Store credentials are stored in EAS credentials store, not in this repo.

---

## 6. iOS-specific checklist

- [ ] Bundle ID: `com.sitesnapai.app` (set in `app.config.ts`)
- [ ] `ITSAppUsesNonExemptEncryption: false` set in infoPlist
- [ ] All NSUsageDescription strings are human-readable and accurate
- [ ] `NSAllowsArbitraryLoads` is `false` in production builds (gated by `APP_ENV !== "production"`)
- [ ] Screenshots captured for all required device sizes
- [ ] TestFlight build tested before production release
- [ ] App Review notes: explain camera/photo/location usage

---

## 7. Android-specific checklist

- [ ] Package name: `com.sitesnapai.app`
- [ ] Adaptive icon set (foreground + `#0F2B46` background)
- [ ] Upload key / keystore stored securely — not in source control
- [ ] Internal testing track promoted to production after sign-off

---

## 8. OTA updates (expo-updates)

OTA updates are enabled in production builds only (`APP_ENV=production`). They check for updates on launch.

To publish an OTA update without a new store submission:
```bash
eas update --channel production --message "describe what changed"
```

OTA updates are limited to JS/assets only. Any native module change requires a full store build.

---

## 9. Rollback procedures

### API rollback
Re-deploy the previous Docker image tag. Migrations are irreversible once applied — roll forward with a new migration instead.

### Mobile rollback
OTA: publish a previous bundle to the `production` EAS channel.  
Store binary: submit a previous build to TestFlight / Play Internal Testing and promote it.

---

## 10. Security hardening (June 2026)

The following controls are active in production:

- **HTTP security headers**: via `helmet` (X-Content-Type-Options, X-Frame-Options, HSTS, Referrer-Policy, COOP, CORP)
- **CORS**: allow-list via `CORS_ALLOWED_ORIGINS`; blocks all origins in production if not configured
- **Rate limiting**: per-route in-memory limits (generate-diary: 10/h, uploads: 30/h, auth routes: 5/15min)
- **Body size limit**: 25 MB JSON cap; multipart capped at 10 MB per file
- **Upload validation**: MIME type allow-list (jpeg/png/webp/gif/heic/heif) + file size enforced by multer
- **Auth tokens**: scrypt password hashing; `crypto.randomBytes` for reset tokens; `crypto.randomInt` for OTP codes
- **Sentry PII scrubbing**: `authorization` and `cookie` headers stripped; sig/token/key query params redacted

**Needs human action before go-live:**
- Set `AUTH_TOKEN_SECRET` to a securely generated 32+ char value
- Configure `CORS_ALLOWED_ORIGINS` with the production app origin(s)
- Set `UPLOAD_SIGNING_SECRET` to a securely generated value
- Rotate all secrets every 90 days (see production-readiness.md)

---

## 11. Rate limiting and the Key Value tier

The limiter counts in Redis (Render Key Value) when `REDIS_URL` is set, and in
process memory otherwise. The fallback is deliberate: on a login path,
availability beats perfect counting, so an unreachable Redis degrades to
in-memory counting rather than failing requests. It is not silent about it —
it logs at error, raises one Sentry event on the transition, and reports state
on `/health/ready`.

**Current state: the Key Value instance is on the FREE tier, which has no disk
persistence.** Render's docs are explicit that "data persistence is not
available for free Key Value instances" (25 MB, 50 connections).

What that means in practice, stated precisely because the halfway position is
easy to misread in both directions:

- **It is still an improvement over no Redis.** Counters now survive API
  deploys and restarts, and are shared across API instances. Before this, every
  deploy reset every limit.
- **But the 24-hour caps are not true daily caps.** `RATE_LIMIT_OTP_SEND_PER_PHONE_DAILY`
  and `RATE_LIMIT_FORGOT_PASSWORD_PER_IDENTIFIER_DAILY` exist to stop a real
  person's phone being used as an SMS target over a day. On the free tier those
  counters are lost whenever the Key Value instance restarts — Render
  maintenance, a plan change, or any instance restart — and an attacker who
  waits out a restart gets a fresh budget. The 15-minute burst caps are largely
  unaffected, since a restart is unlikely to fall inside any given window.
- **Eviction is a second, quieter reset path.** With `maxmemory-policy=allkeys-lru`
  the instance drops the oldest keys under memory pressure instead of erroring.
  At this workload — short counter strings, all with TTLs — 25 MB is far more
  than needed, so this should not trigger in practice. It is listed because if
  it ever does, it looks like nothing at all.
- **50 connections is the free-tier ceiling.** Fine for a single API instance;
  remember it before scaling out.

**To close this:** upgrade to the `256mb` plan (256 MB, 250 connections),
persistence set to journal + snapshot, `maxmemory-policy=allkeys-lru`. You are
buying persistence and the connection limit, not the memory. Nothing in the
application needs to change — the limiter code is identical on both tiers, so
this is a dashboard change and a restart.

---

## 12. Known deferred items (needs human decision)

| Item | Risk | Action required |
|---|---|---|
| `uuid` dep (v9→v11) in services/api | Security advisory; named `v4` import may be compat | Verify `{ v4 }` import works in uuid v11, then bump |
| `minimatch` / `picomatch` / `brace-expansion` in dev tools | Moderate CVEs in dev-only transitive deps | Upgrade `@typescript-eslint` to v7+ (breaking lint rules) |
| `path-to-regexp` in express | CVE fixed in 0.1.13; now resolved automatically via express `~0.1.12` | Monitor; upgrade to express v5 when ready |
| express v4 → v5 | breaking changes to router and middleware API | Scheduled for next major refactor |
| Key Value instance is on the FREE tier | Free tier has no disk persistence, so the 24h SMS caps reset whenever the Key Value instance restarts — they are not true daily caps. See §12. | Upgrade to the `256mb` plan with journal+snapshot persistence before the SMS caps are relied on |
| EAS projectId placeholder | OTA updates disabled until filled in | Run `eas init` and replace `FILL-AFTER-eas-init` |
| Apple submission credentials | Placeholder Apple ID in eas.json | Fill `appleId`, `ascAppId`, `teamId` in eas.json |
