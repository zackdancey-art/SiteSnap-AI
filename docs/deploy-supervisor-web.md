# Deploying the supervisor dashboard (`app.getsitesnapai.com`)

**This runbook's opening sentence used to read "has never been deployed". That
was false, and had been for some time.** The dashboard is live at
`https://app.getsitesnapai.com` (verified 4 October 2026: `curl -I` returns 200
and the response carries a `Content-Security-Policy` built from a correctly set
`NEXT_PUBLIC_API_URL`, so it is a real deploy of this app rather than a
placeholder). A runbook that describes a first deployment is the wrong document
to hand someone diagnosing a live one, and AUDIT L36 is about exactly this: a
document asserting a state of the world that nobody re-checks.

This is the exact, ordered runbook for deploying the Next.js supervisor
dashboard (`Projects/apps/supervisor-web`) on Render and attaching the custom
domains. It is kept for a rebuild from scratch, for a second environment, and
because the hazards below apply to every deploy and not only the first.
**Follow it top to bottom — the ordering is load-bearing.**

Package manager is **pnpm** (not Yarn). The app is self-contained (no workspace
`@sitesnap/*` deps), but the lockfile and `.nvmrc` live at `Projects/`, so Render's
**Root Directory must be `Projects`**.

---

## ⚠️ Read this first — the two ways this fails silently

1. **THREE CSP directives are built from `NEXT_PUBLIC_API_URL` at BUILD time —
   `connect-src`, `img-src` and `media-src`.** If the dashboard is built without
   `NEXT_PUBLIC_API_URL=https://api.getsitesnapai.com`, all three fall back to
   `'self'` and the browser **blocks every call to the API, every photograph and
   every video with no visible UI error** — the app just looks broken. This value
   is *baked into the bundle*; fixing it later means a **rebuild**, not a restart.
   **Verification step 2 below checks the browser console for CSP violations
   before you conclude anything else is wrong.**

   This paragraph used to name `connect-src` alone, and that was accurate at the
   time: `img-src` was a hardcoded literal that omitted the API origin entirely,
   so every photograph on the portal was refused by the browser regardless of
   how the variable was set (AUDIT L48 — confirmed against the live deploy on
   4 October 2026, whose served `img-src` reads
   `'self' data: blob: https://*.tile.openstreetmap.org` with no API origin).
   All three now interpolate one `API_ORIGIN` constant, so they cannot disagree
   about where the API lives.

   **The build now warns when the variable is absent** rather than silently
   baking `'self'`. If a build log carries
   `[next.config] NEXT_PUBLIC_API_URL is not set at build time`, stop and set it
   before attaching anything.

   **Refusals are now reported.** The policy carries `report-to`/`report-uri`
   pointing at `/api/csp-report`, which logs each refusal (URLs reduced to
   origin + path, so no signed-media `?sig=`/`?exp=` pair reaches the log).
   After a deploy, a burst of lines there naming a blocked directive is the
   fastest confirmation that this hazard has bitten.

2. **The session cookie `sitesnap.session` is host-only, `SameSite=Lax`.** It is set
   by whatever host the API answers from (`api.getsitesnapai.com`) and sent back
   only to that exact host. `app.` → `api.` is same-site (both under
   `getsitesnapai.com`), so it works — **but only if you first log in via
   `https://app.getsitesnapai.com`.** Logging in through the `*.onrender.com` URL
   sets/sends the cookie cross-site and produces an endless 401 loop. **Never do the
   first login on the onrender URL.** This is why both custom domains are attached
   *before* any authenticated use.

---

## Prerequisites
- Both `app.getsitesnapai.com` (dashboard) and `api.getsitesnapai.com` (API) are
  attached **in this same pass**, before any login. Do not stop halfway.
- The live marketing site (`getsitesnapai.com` + `www`) stays up throughout — see
  the DNS guard below.

---

## Step 1 — API service: env first (no domain dependency)

On the **existing API service** (`sitesap-ai.onrender.com`) in Render → Environment,
add/confirm these **runtime** vars, then let it redeploy:

| Var | Value | When | Secret |
|---|---|---|---|
| `CORS_ALLOWED_ORIGINS` | must **include** `https://app.getsitesnapai.com` (comma-separated, exact, **no trailing slash**) | runtime | no |
| `PASSWORD_RESET_WEB_URL` | `https://app.getsitesnapai.com/reset-password` | runtime | no |

These are read at runtime, so a restart/redeploy is enough (no rebuild). Do **not**
touch the existing API secrets (listed by name only, values never here):
`AUTH_TOKEN_SECRET`, `DATABASE_URL`, `OPENAI_API_KEY`, `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `RESEND_API_KEY`/`SENDGRID_API_KEY`,
`EMAIL_FROM`, `S3_*`.

## Step 2 — API service: attach `api.getsitesnapai.com`

Render → the API service → Settings → Custom Domains → **Add `api.getsitesnapai.com`**.
Render shows the DNS record to create (a **CNAME** for the subdomain → the API
service's `*.onrender.com` host). Note it for Step 4.

## Step 3 — Create the dashboard Web Service

Render → New → **Web Service** (not Static Site — Next SSR needs a running server),
connect this repo:

| Setting | Value |
|---|---|
| Root Directory | `Projects` |
| Build Command | `pnpm install --frozen-lockfile && pnpm --filter sitesnap-supervisor-web run build` |
| Start Command | `pnpm --filter sitesnap-supervisor-web run start` |
| Node version | auto from `Projects/.nvmrc` (20.14.0); also pinned in the app's `engines`/`.nvmrc` |

Environment for the dashboard service:

| Var | Value | When | Secret |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.getsitesnapai.com` | **BUILD** (baked into bundle **and** CSP) | no |
| `NODE_ENV` | `production` (Render default) | runtime | no |
| `NEXT_PUBLIC_SHOW_DEV_TOOLS` | leave **unset** (baked; must be off in prod) | build | no |

**The dashboard has no secrets** — it is a thin client that talks to the API.
`NEXT_PUBLIC_API_URL` must be set **before the first build** (it is baked in). Deploy.

## Step 4 — Attach `app.getsitesnapai.com` + add BOTH DNS records

Render → the dashboard service → Custom Domains → **Add `app.getsitesnapai.com`**.
Note its CNAME target.

### Squarespace DNS — ADD ONLY. Do not modify existing records.
In Squarespace → Settings → Domains → `getsitesnapai.com` → DNS Settings, add exactly
**two** new records (use the exact targets Render displayed):

| Host | Type | Value |
|---|---|---|
| `app` | CNAME | `<dashboard-service>.onrender.com` |
| `api` | CNAME | `<api-service>.onrender.com` |

**Do not edit, delete, or reorder:**
- the root **`@` A record `216.24.57.1`** (your live marketing site), and
- the **`www` CNAME** (your live marketing site).

After saving, confirm the record list still shows the untouched root-A and www-CNAME.

## Step 5 — Wait, then verify (in order)

Wait for both subdomains to resolve and Render to auto-provision TLS (up to ~1 hour).
Then, from a clean browser session with DevTools open:

1. **Dashboard loads** at `https://app.getsitesnapai.com` (the login page renders).
2. **CSP check — do this before assuming anything else is broken.** Open DevTools →
   Console and Network. There must be **no** `Refused to connect … violates the
   … Content Security Policy` errors and no blocked requests to
   `https://api.getsitesnapai.com`. If you see them, the build had the wrong/empty
   `NEXT_PUBLIC_API_URL` → **rebuild** the dashboard with the correct value (Step 3).
3. **Log in via `https://app.getsitesnapai.com`** (never the onrender URL). In
   DevTools → Application → Cookies, confirm `sitesnap.session` is set on host
   **`api.getsitesnapai.com`**, `HttpOnly`, `Secure`, `SameSite=Lax`.
4. **Authenticated call succeeds:** the dashboard loads sites/data (HTTP 200, not a
   401 loop).
5. **Password reset host:** trigger a reset; the email link points to
   `https://app.getsitesnapai.com/reset-password?token=…`.
6. **CORS rejects an unlisted origin:**
   ```
   curl -sS -i -X OPTIONS https://api.getsitesnapai.com/api/auth/login \
     -H "Origin: https://not-allowed.example" \
     -H "Access-Control-Request-Method: POST" | grep -i "access-control-allow-origin"
   ```
   There must be **no** `access-control-allow-origin` for the bogus origin, while
   `https://app.getsitesnapai.com` is allowed.

---

## Rollback — if the dashboard does not come up

The dashboard is not a system of record, so there is no data risk.
- The marketing site (`getsitesnapai.com` + `www`) is untouched and stays live —
  the DNS guard means nothing you added can take it down.
- In Squarespace, remove the two new `app` / `api` CNAME records (or leave them; they
  only point at Render).
- In Render, detach the custom domains from both services. The API stays reachable at
  `sitesap-ai.onrender.com`; the dashboard can be deleted and recreated.
- If the API env changes caused a problem, revert `CORS_ALLOWED_ORIGINS` /
  `PASSWORD_RESET_WEB_URL` to their previous values and redeploy the API.
- Note: while `api.getsitesnapai.com` is detached, the mobile **production** build
  (`eas.json` → `EXPO_PUBLIC_API_URL=https://api.getsitesnapai.com`) would have no
  API to reach — but the mobile app is not shipped yet, so this is not user-facing.
