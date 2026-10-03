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
#   ./scripts/ci.sh              full gate (requires TEST_DATABASE_URL and
#                                REDIS_TEST_URL)
#   ./scripts/ci.sh --no-db      everything except the DB suites, deliberately
#   ./scripts/ci.sh --no-redis   everything except the Redis suite, deliberately
set -eu

cd "$(dirname "$0")/.."

RUN_DB=1
RUN_REDIS=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-db) RUN_DB=0 ;;
    --no-redis) RUN_REDIS=0 ;;
    *) echo "ci.sh: unknown argument '$1' (expected --no-db and/or --no-redis)" >&2; exit 2 ;;
  esac
  shift
done

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

# Same reasoning as TEST_DATABASE_URL, applied to the other backend that has a
# success path only a real server can exercise. The Redis tests prove that a
# REACHABLE Redis produces no boot-time degradation alert and that the counter
# lands in Redis at the value the endpoint produced — neither of which any
# unreachable-Redis test can show. Allowing them to skip in CI would leave that
# success path permanently untested, which is the condition this work removed.
if [ -z "${REDIS_TEST_URL:-}" ]; then
  if [ "${CI:-}" = "true" ]; then
    echo "ci.sh: REDIS_TEST_URL is not set in CI." >&2
    echo "  The Redis-gated tests would register as skips and the build would" >&2
    echo "  pass having proved nothing about the reachable-Redis path. Fix the" >&2
    echo "  redis service wiring in ci.yml; do not pass --no-redis in CI." >&2
    exit 1
  fi
  if [ "$RUN_REDIS" = "1" ]; then
    echo "ci.sh: REDIS_TEST_URL is not set." >&2
    echo "" >&2
    echo "  This machine has no local Redis, so the reachable-Redis tests cannot" >&2
    echo "  run. Re-run as './scripts/ci.sh --no-redis' to acknowledge that the" >&2
    echo "  result is WEAKER than CI, or start one:" >&2
    echo "    docker run --rm -p 6379:6379 redis:7-alpine" >&2
    echo "    REDIS_TEST_URL=redis://127.0.0.1:6379 ./scripts/ci.sh" >&2
    echo "" >&2
    exit 1
  fi
fi

step "Structural: ci.yml defines no gate of its own"
./scripts/assert-ci-single-definition.sh

# The mobile Babel preset is declared by hand (AUDIT L19) rather than inherited,
# so it can silently fall out of step with the SDK. Cheap, and it runs before the
# slow gates because a drifted preset invalidates everything downstream of it.
step "Structural: mobile Babel preset matches the SDK"
node ./scripts/assert-babel-preset-expo.mjs

# The Privacy Policy and the Terms each exist in three copies: the canonical
# markdown in docs/legal/, a data module the mobile app renders, and a page on
# the marketing site. AUDIT A6 is what happens without this check — the copies
# had already drifted into different section orders, different retention claims
# and two different answers to whether the company was incorporated, and
# nothing anywhere reported the disagreement because each copy was internally
# consistent. Three copies is the cost of having the text in an app binary, in
# a static site, and in version control; silent drift between them is not.
#
# The comparison is a normalised word stream, so wrapping, indentation,
# punctuation, markup and TypeScript syntax are all invisible to it and only a
# change in the words themselves fails the build. The "Last updated" date is a
# word stream like any other, which is how one date stays one date.
legal_words() {
  # $1 file, $2 begin marker, $3 end marker. The markers must be matched as
  # whole lines: the phrase "BEGIN LEGAL TEXT" also appears in the canonical
  # files' own header prose, and a substring match starts the range there and
  # drags the header table into the comparison.
  sed -n "\|$2|,\|$3|p" "$1" \
    | sed -e '1d' -e '$d' \
    | sed -e 's/<[^>]*>/ /g' -e 's/&#\{0,1\}[a-z0-9]*;/ /g' -e 's/\\n/ /g' \
    | tr 'A-Z' 'a-z' \
    | tr -cs 'a-z0-9_' '\n' \
    | grep -vxE 'export|const|legaldocument|privacy_policy|terms_of_service|title|lastupdated|intro|sections|paragraphs' \
    | sed -e '/^$/d'
}

MD_BEGIN='^<!-- BEGIN LEGAL TEXT -->$'
MD_END='^<!-- END LEGAL TEXT -->$'
TS_BEGIN='^// BEGIN LEGAL TEXT$'
TS_END='^// END LEGAL TEXT$'

assert_legal_copies() {
  canon="../docs/legal/$1.md"
  mobile="apps/mobile/constants/legal/$1-content.ts"
  site="../website/$2/index.html"
  tmp="$(mktemp -d)"

  legal_words "$canon" "$MD_BEGIN" "$MD_END" > "$tmp/canon"

  # A renamed or deleted marker makes an extraction empty, and two empty word
  # streams compare equal — the check would pass having read nothing. Refuse a
  # canonical body that is implausibly short before trusting any comparison
  # against it.
  words="$(wc -l < "$tmp/canon" | tr -d ' ')"
  if [ "$words" -lt 400 ]; then
    echo "ci.sh: extracted only $words words from $canon (expected >400)." >&2
    echo "  Either the document was gutted or the BEGIN/END LEGAL TEXT markers" >&2
    echo "  moved. Not comparing anything against it." >&2
    rm -rf "$tmp"; exit 1
  fi

  legal_words "$mobile" "$TS_BEGIN" "$TS_END" > "$tmp/mobile"
  legal_words "$site" "$MD_BEGIN" "$MD_END" > "$tmp/site"

  failed=0
  for target in mobile site; do
    if ! diff -u "$tmp/canon" "$tmp/$target" > "$tmp/$target.diff"; then
      eval "path=\$$target"
      echo "ci.sh: $path has drifted from $canon." >&2
      sed -n '3,40p' "$tmp/$target.diff" >&2
      failed=1
    fi
  done
  rm -rf "$tmp"
  [ "$failed" = "0" ] || exit 1
  echo "  $1: $words words, both copies match."
}

step "Structural: the legal documents have not drifted from their source"
assert_legal_copies privacy-policy privacy
assert_legal_copies terms-of-service terms

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
# REDIS_TEST_URL is unset here for the same reason: rate-limit-redis-live.test.ts
# promotes it to REDIS_URL, which would move the in-memory run's counters into
# Redis and change the skip count the runner pins.
env -u TEST_DATABASE_URL -u REDIS_TEST_URL pnpm run test

if [ "$RUN_REDIS" = "1" ]; then
  step "Tests (Redis — the reachable-Redis path)"
  pnpm --filter services-api run test:redis
fi

if [ "$RUN_DB" = "1" ]; then
  step "Tests (database — RLS + store round-trip)"
  pnpm --filter services-api run test:db
fi

if [ "$RUN_DB" = "0" ] || [ "$RUN_REDIS" = "0" ]; then
  echo ""
  echo "═══════════════════════════════════════════════════════════════════"
  echo " PARTIAL PASS — gates were deliberately skipped:"
  [ "$RUN_DB" = "0" ] && echo "   --no-db     RLS and store/schema drift are unproven."
  [ "$RUN_REDIS" = "0" ] && echo "   --no-redis  the reachable-Redis path is unproven."
  echo " This is NOT equivalent to CI."
  echo "═══════════════════════════════════════════════════════════════════"
  exit 0
fi

echo ""
echo "✅ ci.sh: full gate passed."
