# CLAUDE.md — SiteSnap AI

Orientation for any agent working in this repo. Read this fully before touching code. Two companion documents are the source of truth for *what* and *why*: `docs/ARCHITECTURE.md` (how the system is built) and `docs/AUDIT.md` (findings, each with an ID like C1/H2/M4). When a task names a finding ID, open that section of `docs/AUDIT.md` yourself — do not act on a paraphrase.

---

## 1. Working directory — read this first, it will bite you otherwise

Claude Code is **normally** launched from the git repo root — `/Users/zackdancey/Dev/SiteSnap/`, where `CLAUDE.md`, `docs/`, and `.claude/` live — but do not assume it. Sessions have started one level up in `~/Dev`, where every `git` command reports **"not a git repository"** and every relative path in this file resolves to nothing. Confirm before relying on it:

```
git rev-parse --show-toplevel
```

If that errors you are outside the repo — that means the wrong directory, **never** a missing repo. Use absolute paths, or scope a single command with `git -C /Users/zackdancey/Dev/SiteSnap …`. Misreading this is not hypothetical: it has produced a whole session's worth of confidently reported, three-week-stale project state.

The **pnpm workspace is one level down**, in `Projects/`. That is where `pnpm-workspace.yaml`, the root `package.json`, and the three deployables live.

**All pnpm commands must use `pnpm -C Projects <cmd>`.** For example:

```
pnpm -C Projects run typecheck
pnpm -C Projects --filter services-api run test
```

**Do NOT `cd Projects && …`.** The `cd` does not persist between separate Bash tool calls — each call starts a fresh shell at the repo root — so a `cd` in one call is gone by the next. Always pass `-C Projects` (or `--filter` from the workspace) instead. This applies to typecheck, test, lint, install — everything pnpm.

Paths to `docs/`, `.claude/`, and `CLAUDE.md` are relative to the repo root (no `Projects/` prefix). Paths to source code are under `Projects/`.

---

## 2. Monorepo layout and the three deployables

**This is a `pnpm` workspace — NOT Yarn.** Some external notes/prompts describe it as a Yarn workspace; that is wrong. There is a `Projects/pnpm-lock.yaml` and no `yarn.lock`. Use pnpm exclusively (`pnpm install`, `pnpm --filter <pkg> …`); never run `yarn`. Render build/start commands for these services must use pnpm too.

pnpm workspace (`Projects/pnpm-workspace.yaml`) with packages `apps/*`, `services/*`, `shared`.

| Package | Path | What it is |
|---|---|---|
| **API** | `Projects/services/api` | Express + TypeScript backend. The only server. Auth, projects/entries/diaries, AI diary generation, uploads, RBAC. Listens on `PORT`, default `4000` (`server.ts`). |
| **Mobile** | `Projects/apps/mobile` | Expo / React Native field app (expo-router). The primary capture client. Sends `Authorization: Bearer <token>`. |
| **Supervisor web** | `Projects/apps/supervisor-web` | Next.js portal (app router), port `3001` (its `dev`/`start` scripts). Auth via **httpOnly cookie**, not bearer token. |
| **Shared** | `Projects/shared` | Zod schemas + shared TS types, published to the workspace as `@sitesnap/shared`. Emits `.d.ts` only — build it before the API (`pnpm -C Projects --filter @sitesnap/shared run build:types`) or project references won't resolve. |

**Framework and runtime versions are deliberately not recorded here** — they drift on every upgrade and a stale version in this file is worse than no version. Read them from source:

```
grep -n '"\(express\|expo\|next\|react\|react-native\)":' Projects/services/api/package.json Projects/apps/mobile/package.json Projects/apps/supervisor-web/package.json
```

Data layer: **Postgres** in production (via `DATABASE_URL`), with a **file-backed / in-memory JSON fallback** used automatically when `DATABASE_URL` is unset (dev and tests). No ORM — stores are hand-written SQL modules in `Projects/services/api/src/storage/`. Photos go to S3/R2 in prod, local disk in dev (`storage/mediaStorage.ts`). Deployed to Render via the root `Dockerfile`; migrations run at API boot.

---

## 3. Multi-tenancy: RLS-enforced in Postgres, via the `withTenant` wrapper

Every operational table carries a `company_id TEXT` column. There are **no foreign keys** back to `companies` (deliberate — soft-cancel + 7-year retention compliance), but tenant isolation **is enforced by the database**: the tenanted tables run `FORCE ROW LEVEL SECURITY` with a `company_id = current_setting('app.company_id', true)` policy. Which tables are covered changes as migrations land — do not trust a list written here or anywhere else, find out:

```
grep -l "FORCE ROW LEVEL SECURITY" Projects/services/api/src/storage/migrations/*.sql
```
```sql
-- definitive, against a live database:
SELECT relname FROM pg_class WHERE relforcerowsecurity;
```

**`storage/tenant.ts` → `withTenant(actor, fn)` supplies the tenant context.** It opens one transaction and sets `app.company_id` with `SET LOCAL` semantics for the life of that transaction. **Every query that touches an RLS-forced table MUST run through it.** Read the doc comment at the top of that file before writing any store query — it explains why a transaction rather than a bare `pool.query` (a pooled connection would otherwise leak the previous request's company into the next checkout).

**Fail-closed is the symptom you will actually hit.** A query that runs on the bare pool (`getPgPool()`) instead of `withTenant` has no `app.company_id` set; `current_setting('app.company_id', true)` returns NULL, and `company_id = NULL` matches no rows. So a forgotten wrapper presents as **zero rows on read and a `WITH CHECK` violation on insert — never as another tenant's data, and never as an error at the call site.** If a store query returns nothing against a database you know is populated, suspect a missing `withTenant` before you suspect the data.

**Both layers stay.** Stores also filter `WHERE company_id = $1` and/or check `canAccessRow` / `canAccess` / `assertSameCompany` (`storage/actor.ts`, `utils/companyScope.ts`), and an `Actor` (`{ email, role, companyId, companyRole }`, defined in `storage/actor.ts`) is threaded into every store call. RLS is the backstop, not a licence to drop the filter — not every table is RLS-forced (check, per above), and **the in-memory / JSON fallback store has no RLS at all**, so the hand-written scoping is the only thing protecting the dev and test paths. If you write or edit any store query it MUST still scope by `actor.companyId`; if you are unsure whether a query is properly scoped, stop and flag it.

Finding **H1** (the original "convention only" gap) was closed by **H1b**; `docs/AUDIT.md` carries the disposition.

Company roles rank `owner > manager > viewer > crew` (`utils/authToken.ts`, `middleware/auth.ts` → `requireAtLeast`, `requireCompanyRole`). A legacy `role` (`worker/supervisor/admin`) still exists in parallel and is deprecated — do not add new logic keyed on it.

---

## 4. Database migrations — ONLY THE ORCHESTRATOR ASSIGNS NUMBERS

Migrations live in `Projects/services/api/src/storage/migrations/` as `NNN_description.sql`, applied in filename order at API boot by `storage/migrate.ts`. The version string recorded in `schema_migrations` is the filename minus `.sql` (`migrate.ts`: `file.replace(/\.sql$/, "")`).

**Never trust a migration number written in this file, in a note, or in a session transcript — they drift. List the directory:**

```
ls Projects/services/api/src/storage/migrations/ | tail -3
```

The next number to assign is the highest + 1. What a *deployed* database has actually applied is a different question, answered by `GET /api/health/ready`: it returns `{ migrations: { applied, expected } }` and 503s when `applied < expected`.

**If you are a subagent: do not create, rename, or renumber a migration unless your task explicitly hands you a specific number.** Multiple agents working in parallel will otherwise all reach for the same next number, and a duplicate/misordered migration corrupts the boot sequence. The orchestrator owns the numbering. If your change seems to need a new migration and none was assigned, STOP and report that — do not invent a number.

Migrations must be additive and idempotent (`IF NOT EXISTS` / guarded `DO` blocks) — they run against databases at varying states.

---

## 5. How to run typecheck, tests, and lint

From the repo root, always with `-C Projects`. **Filter by package NAME, not path** — under `-C Projects`, path filters like `--filter ./services/api` match nothing; use the package name from each `package.json` (`grep '"name"' Projects/shared/package.json Projects/{services,apps}/*/package.json` prints the current mapping):

| Package | `--filter` name |
|---|---|
| API | `services-api` |
| Mobile | `apps-mobile` |
| Web | `sitesnap-supervisor-web` |
| Shared | `@sitesnap/shared` |

```
# Typecheck one package (fast, no build):
pnpm -C Projects --filter services-api run typecheck

# Typecheck everything:
pnpm -C Projects run typecheck

# API tests — NOTE: this compiles TS to dist/ first, then runs node --test:
pnpm -C Projects --filter services-api run test

# Lint:
pnpm -C Projects run lint
```

The API `test` script cleans `dist/`, compiles, and then runs `node --test` over a **`find` enumeration** of the compiled test files — read its current text in `Projects/services/api/package.json` rather than trusting a copy here. That shape has three consequences worth knowing:
- Tests run against **compiled output in `dist/`**, not the `.ts` source. A test file that doesn't compile won't run. Always typecheck before assuming a test failure is a logic problem.
- The runner enumerates files with **`find dist -name '*.test.js'`, not a shell glob.** Do **not** revert this to `node --test dist/**/*.test.js`: `pnpm`/npm run scripts under `sh`, which has no globstar, so `**` collapses to `*` and the pattern silently matches only files exactly one directory deep — a test at the `dist/` root, or two-plus directories deep, never runs *and is never reported as skipped*. `find` is depth-independent and matches the files on disk exactly. (`node --test dist` directory recursion is also wrong — its broad default patterns re-pick-up `dist/test-setup.js`, the `--require` preload.)
- The leading `rm -rf dist tsconfig.tsbuildinfo` forces a clean full compile every run. The project is `composite: true` (incremental), so deleting `dist` alone leaves the buildinfo and tsc under-emits; and without the clean a renamed/deleted test can linger in `dist` as a stale, still-passing copy.

**Two test runs, not one — `test` (in-memory) and `test:db` (Postgres).** The `test` script above runs **without** `TEST_DATABASE_URL`: the DB-gated suites register a skip and everything else runs against the in-memory store. The `test:db` script runs the **DB-gated** suites against a real Postgres (`TEST_DATABASE_URL` set). They are deliberately separate because some stores are **test-aware** (`useDatabase()` returns true when `TEST_DATABASE_URL` is set under `NODE_ENV=test`, e.g. `projectsStore`), so setting `TEST_DATABASE_URL` for the *whole* suite flips those stores to the DB and breaks tests that assume the in-memory store. Two rules for `test:db`:
- It targets **exactly** the files guarded by `if (!process.env.TEST_DATABASE_URL)` — `grep -rl '!process.env.TEST_DATABASE_URL' dist`. A test that merely *mentions* `TEST_DATABASE_URL` in a comment (comments are stripped in `dist`) or `delete`s it is an in-memory test and must **not** be swept in.
- It runs **`--test-concurrency=1`**. `node --test` runs files in parallel by default; DB suites all migrate/seed the same database, so parallel runs race and fail spuriously. Sequential is mandatory for the DB path.

**Both suites refuse to pass vacuously.** `services/api/scripts/run-tests.sh` enumerates the files, and a selector that matches **nothing** is a failure rather than the exit-0 clean pass `node --test` gives it. It also pins `EXPECTED_DB_SUITES=5`, checked from both sides: `db` mode must select exactly 5 files, and the in-memory run must report exactly 5 skips. Adding or removing a DB-gated suite means raising that number **in the same commit** — that is the point, so the change is deliberate and visible in review rather than a count drifting unobserved.

The DB round-trip guard (`storage/store-roundtrip.test.ts`) lives here: it drives each store's real full-column INSERT against a boot-migrated Postgres and reads it back, so a store-vs-schema column drift (L10 timecards, L11 diaries) fails CI instead of 500ing in prod. Static column audits can't catch a `CREATE TABLE IF NOT EXISTS` no-op column (see L11) — only a real round-trip can.

All of the real test files live under `Projects/services/api/src/`. Mobile and web have historically had **no tests and no `test` script** — confirm rather than assume, and if this command now prints something, this sentence is out of date:

```
find Projects/apps -name '*.test.ts*' -not -path '*/node_modules/*'
```

---

## 6. API test conventions (follow these exactly — do not invent new patterns)

The existing suite (e.g. `services/api/src/routes/company-rbac.test.ts`, `change-password.test.ts`) is the template:

- **Runner:** `node:test` — `import { test, before, after, beforeEach } from "node:test"` and `import assert from "node:assert/strict"`. No Jest, no Vitest, no supertest.
- **Location:** test files sit next to the code they test, named `*.test.ts`, under `src/` (at any depth — the runner finds them by `find` enumeration, see §5, so a file at the `src/` root is fine). They compile to a matching `dist/…/*.test.js`.
- **HTTP:** tests boot the real app with `createApp()` from `../server`, listen on an ephemeral port, and drive it with a hand-rolled `http.request` helper (typically named `req`) that returns `{ status, body }`. Copy that helper's shape; don't add a dependency.
- **In-memory mode:** at the top of the file, `delete process.env.DATABASE_URL` (forces the JSON/in-memory store), set `process.env.AUTH_TOKEN_SECRET = "<something>-test-secret"` and `process.env.NODE_ENV = "test"`. **Consequence:** the in-memory suite cannot exercise anything Postgres-only — NOT NULL constraints, foreign keys, or Row-Level Security. Tests that must prove RLS or a DB constraint have to run against a real Postgres via `TEST_DATABASE_URL` and skip when it is unset (this environment has no local Postgres).
- **Isolation between tests:** reset store state with the exported helpers — `resetAuthStoreForTests()`, `resetProjectStoreForTests()`, `resetRateLimitStoreForTests()` — in `before`/`beforeEach`.
- **Unique identities:** phone numbers must be globally unique within a run; use the incrementing `nextPhone()` pattern (`+614` + zero-padded counter). Follow the existing `registerUser(email, name, companyName?)` helper style to get an auth token.
- **No external calls in tests:** never hit real Twilio, real S3, real OpenAI, or any network. Mock at the boundary. (Making this true for SMS/email is finding **H3a** — until it lands, be aware the pre-commit hook can fail on Twilio quota.)

---

## 7. Providers and how absence degrades

`server.ts` → `validateProviderConfig()` hard-fails production boot when a required provider is missing or looks like a placeholder; in dev the same gaps degrade to warnings + local fallbacks. The required list grows — read it from the function rather than from a copy here:

```
sed -n '/export function validateProviderConfig/,/^}/p' Projects/services/api/src/server.ts
```

**`OPENAI_API_KEY` is a hard production boot requirement** (added by X2). It was historically the one *un*validated provider — absent, the AI diary generator fell back to the deterministic rule-based generator on every request, an unrecorded downgrade of the product's headline feature (finding **C1**). Boot now fails fast instead. The rule-based generator is deliberately **retained as a runtime fallback** for a reachable-but-erroring API (bad key, 401, 429, 5xx, timeout) — that path returns 200 with a `warning` — but it is no longer a substitute for a missing key at boot. It only rearranges user-entered text; it never invents content. **C1 is only half closed:** a saved diary still records no generator, model, or prompt version, so the provenance half remains open.

There is exactly **one LLM call site**: `routes/ai.ts` → `tryGenerateWithOpenAI()` (OpenAI Responses API). **The model that actually runs is the `OPENAI_MODEL` environment variable** — `gpt-4o` is only the fallback literal in code (`process.env.OPENAI_MODEL || "gpt-4o"`). To know what a given deployment is using, read that variable on the deployment; do not infer it from this file or from the source literal. The system prompt is an inline string literal in `routes/ai.ts`.

---

## 8. Working style for subagents

- You start with a fresh context window: you see this file, git status, and the task prompt — nothing else. Read the files your task names, in full.
- The file list in your task is a **hard boundary**. If doing the job correctly requires editing a file not on the list, STOP and report it — do not expand scope silently.
- The approach in your task has already been decided by the orchestrator. Don't re-litigate it. If it's genuinely unimplementable or contradicts the code, STOP and report the contradiction rather than improvising a different design.
- Match surrounding conventions over general best practice. Prefer deleting code over adding it. Do not add dependencies without being told to.
- Do not edit `docs/AUDIT.md` or `docs/ARCHITECTURE.md`.

## 9. Worktree isolation caveat (mostly for the orchestrator)

A subagent spawned with `isolation: worktree` gets a **fresh checkout with no `node_modules`** — so `pnpm -C Projects … typecheck`/`test` will fail there until dependencies are installed (`pnpm -C Projects install`). Either install first inside the worktree, or don't use worktree isolation for test-running work and serialise it instead. Never spawn parallel worktree agents expected to run tests without accounting for this.

---

## 10. Working method for high-risk changes

This is how the tenancy/security remediation (X1, H3a, H4–H8) was done, and the standard to hold future work of the same kind to. It is not ceremony — it caught real cross-tenant bugs that reasoning alone missed.

- **Findings are the source of truth.** Everything traces to a finding ID in `docs/AUDIT.md` (e.g. `H1`, `H7`). Reference the ID and read that section — never act on a paraphrase. Record new discoveries there as they surface (H4–H8 were all found mid-implementation).

- **Split judgement from execution.** The orchestrator keeps the parts where a subtle error is invisible in review and catastrophic in prod: tenancy/RLS design, the `withTenant` wrapper, security-critical authorization logic, and **every migration** (the orchestrator alone assigns migration numbers — see §4 for how to find the current highest; never cite one from memory). Mechanical execution against a decided spec is delegated (implementer), as are tests (test-author), dead-code removal (janitor), and docs regeneration (docs-scribe). If subagents aren't available, do the same work inline — the *division* matters more than the tooling.

- **Adversarial verification is mandatory, not optional.** Every structural or security change goes through a read-only, adversarial review *before* acceptance, and **never by whoever wrote it**. Treat a `Partial` / `Not fixed` verdict as authoritative. Concretely, this review rejected two live cross-tenant bypasses in H7 — a forgeable "infer ownership from caller-writable entry JSON" design, and a path-traversal decoupling — either of which would have shipped as "fixed" on self-attestation. When the reviewer flags a hole, fix and re-review; don't argue it down.

- **Security fixes on sensitive data (media, auth, tenancy) require a red-on-revert test.** Prove the guard fails when removed — don't rest on code reasoning. Where the path isn't reachable in the in-memory harness (e.g. the OpenAI vision path), mock at the boundary (see the `openaiClient` / `notificationService` `NODE_ENV==="test"` guards) rather than exporting internals or skipping the test.

- **Migrations** are additive and idempotent (`IF NOT EXISTS` / `DROP POLICY IF EXISTS` … `CREATE`), run at boot. RLS uses `FORCE` (the app connects as the DB owner) and fail-closed `current_setting('app.company_id', true)`. A migration that must read another RLS-forced table cross-company (e.g. the H7 backfill reading `project_entries`) lifts `FORCE` for the read inside its own transaction and restores it.

- **Git & secrets.** Feature branches only, never `main`. Real credentials live only in gitignored `.env`; scan the diff before committing.
- **What actually gates a commit vs. a merge.** The pre-commit hook (`.git/hooks/pre-commit`) is **branch-aware**: on feature branches it runs **`typecheck` + `lint` only** (tests are kept out to keep the commit loop fast); on `main`/`master` it additionally runs `test`. So on a feature branch a `--no-verify` is justified only when an intermediate logical-split commit doesn't individually pass **typecheck/lint** — tests are *not* the blocker there, and the earlier belief that "the hook's full-suite check can't pass on intermediate commits" was false. The **full suite is gated by CI, not the hook**. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on **every `pull_request`** (and on push to `main`/`master`), but it no longer lists the gate steps itself — it has **one** step, `run: ./scripts/ci.sh`. **[`Projects/scripts/ci.sh`](Projects/scripts/ci.sh) is the single definition of "the build passes"**: shared types, `lint`, `typecheck`, `test` (in-memory) and `test:db` (DB-gated suites against a `postgres:16` service container). Run the identical program locally with `pnpm -C Projects run ci`. Do not add gate steps to `ci.yml` or re-expand the root `ci` script — `scripts/assert-ci-single-definition.sh` fails the build if either grows a second definition, because two definitions drift and nothing reports the disagreement. (The root `ci` script had already drifted this way: it ran lint+typecheck+test and silently omitted `test:db`.) Without a local Postgres, `./scripts/ci.sh --no-db` is the deliberate partial run; the plain invocation **refuses to skip the DB suites**, and in CI a missing `TEST_DATABASE_URL` is a hard failure rather than a green run full of skips. Treat green CI on the PR as the real pre-merge gate; the branch tip must pass typecheck + lint locally and the full suite in CI before merge.
