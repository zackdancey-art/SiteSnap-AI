#!/bin/sh
# THE definition of "the build passes". There is deliberately only one.
#
# Why this file exists: the gate used to be defined in three places that were
# free to drift — .github/workflows/ci.yml listed four steps, the root
# package.json "ci" script listed three (it omitted test:db entirely, so anyone
# running `pnpm run ci` locally got a green result from a strictly weaker
# check), and CLAUDE.md described a fourth version in prose. Nothing detected
# the disagreement, because each one passed on its own terms.
#
# Now ci.yml runs exactly one command: this script. Local and CI run the same
# program by construction rather than by two lists happening to match, and
# scripts/assert-ci-single-definition.sh fails the build if ci.yml ever grows a
# second gate step behind this one's back.
#
# Usage:
#   ./scripts/ci.sh              full gate (requires TEST_DATABASE_URL)
#   ./scripts/ci.sh --no-db      everything except the DB suites, deliberately
set -eu

cd "$(dirname "$0")/.."

RUN_DB=1
case "${1:-}" in
  --no-db) RUN_DB=0 ;;
  "") ;;
  *) echo "ci.sh: unknown argument '$1' (expected --no-db or nothing)" >&2; exit 2 ;;
esac

step() {
  echo ""
  echo "═══ $1 ═══"
}

# The DB suites are the ones that prove RLS and store/schema agreement, so
# skipping them is the single most valuable way to get a meaningless green.
# In CI that must be impossible; locally it must be deliberate, never implicit.
if [ -z "${TEST_DATABASE_URL:-}" ]; then
  if [ "${CI:-}" = "true" ]; then
    echo "ci.sh: TEST_DATABASE_URL is not set in CI." >&2
    echo "  The DB-gated suites would register as skips and the build would pass" >&2
    echo "  having proved nothing about RLS or store/schema drift. Fix the" >&2
    echo "  postgres service wiring in ci.yml; do not pass --no-db in CI." >&2
    exit 1
  fi
  if [ "$RUN_DB" = "1" ]; then
    echo "ci.sh: TEST_DATABASE_URL is not set." >&2
    echo "" >&2
    echo "  This machine has no local Postgres, so the DB-gated suites cannot run." >&2
    echo "  Re-run as './scripts/ci.sh --no-db' to acknowledge that the result is" >&2
    echo "  WEAKER than CI, or point TEST_DATABASE_URL at a scratch database." >&2
    echo "" >&2
    echo "  Refusing to skip silently: a silent skip here is exactly how a green" >&2
    echo "  local run stops meaning anything." >&2
    exit 1
  fi
fi

step "Structural: ci.yml defines no gate of its own"
./scripts/assert-ci-single-definition.sh

step "Build shared types"
# @sitesnap/shared emits .d.ts only; TypeScript project references in the API
# and both apps fail to resolve until this has run.
pnpm --filter ./shared run build:types

step "Lint"
pnpm run lint

step "Typecheck"
pnpm run typecheck

step "Tests (in-memory)"
# TEST_DATABASE_URL must be UNSET here even when we have one. Some stores are
# test-aware (projectsStore switches to the DB path whenever it is present),
# so leaking it into this run silently changes which code the suite exercises.
env -u TEST_DATABASE_URL pnpm run test

if [ "$RUN_DB" = "0" ]; then
  echo ""
  echo "═══════════════════════════════════════════════════════════════════"
  echo " PARTIAL PASS — the DB-gated suites did NOT run (--no-db)."
  echo " This is NOT equivalent to CI. RLS and store/schema drift are unproven."
  echo "═══════════════════════════════════════════════════════════════════"
  exit 0
fi

step "Tests (database — RLS + store round-trip)"
pnpm --filter services-api run test:db

echo ""
echo "✅ ci.sh: full gate passed."
