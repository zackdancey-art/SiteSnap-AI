#!/bin/sh
#
# Test runner with an empty-file-list guard.
#
# Both test suites select their files by shell expansion and pass the result to
# `node --test`. That is fine until the expansion yields nothing, because:
#
#     $ node --test $(find dist -name '*.test.js')     # dist is empty
#     # tests 0
#     # pass 0
#     # fail 0
#     $ echo $?
#     0
#
# `node --test` with zero file arguments reports a clean pass and exits 0. So a
# build that emits nothing, a renamed directory, or a changed guard expression
# produces a GREEN CI run in which no test executed at all. Nothing in the
# output says "0 files" loudly enough to notice in a scrolling log, and the exit
# code — the thing CI actually gates on — is indistinguishable from success.
#
# The db mode is the more exposed of the two: it selects files by grepping
# COMPILED output for the literal string `!process.env.TEST_DATABASE_URL`. Any
# refactor of how that guard is written (a helper function, a destructured
# read, a named constant) silently empties the list. Those are the suites that
# catch store-vs-schema column drift and RLS regressions — exactly the failures
# that otherwise only appear as a 500 in production.
#
# So: enumerate, assert non-empty, then run. An empty list is a failure, never
# a pass.
#
# POSIX sh, not bash. macOS ships bash 3.2, which has no `mapfile`, and a script
# that only runs on the CI runner's bash 5 would reintroduce the local-vs-CI
# divergence this work exists to remove. Word splitting is done with IFS set to
# newline only, so paths containing spaces stay intact.
set -eu

MODE="${1:-}"
[ -n "$MODE" ] || { echo "usage: run-tests.sh <memory|db|redis|openai>" >&2; exit 2; }
cd "$(dirname "$0")/.."

# How many suites are gated on TEST_DATABASE_URL. Both modes check against this
# one number, because it is the same invariant seen from two sides:
#
#   db mode     must SELECT exactly this many files, or the grep selector has
#               stopped matching some of them.
#   memory mode must report exactly this many SKIPS, or a suite that is
#               supposed to defer to the db run has stopped doing so.
#
# A non-empty-but-short list is the case the empty-list guard below cannot see:
# if the selector matches 3 of 5, the run is green and 2 suites vanished. That
# is the same silent-success failure in a quieter form, so it is pinned.
#
# This number is EXPECTED TO CHANGE — raise it in the same commit that adds a
# DB-gated suite. That is the point: the change has to be deliberate and shows
# up in review, rather than a count drifting unobserved.
EXPECTED_DB_SUITES=5

# How many individual TESTS are gated on REDIS_TEST_URL.
#
# Note the unit: db gating is per-SUITE (each file registers one skip), Redis
# gating is per-TEST (one file, four gated tests). Do not merge the two numbers —
# they count different things and drift for different reasons.
#
#   memory mode must report EXPECTED_DB_SUITES + EXPECTED_REDIS_TESTS skips,
#                since neither TEST_DATABASE_URL nor REDIS_TEST_URL is set.
#   redis mode   must report exactly this many PASSES and zero skips. That is the
#                positive control: a Redis job whose service container never came
#                up would otherwise skip all four and exit 0 — a green run
#                proving nothing about the success path it exists to cover.
EXPECTED_REDIS_TESTS=4

# How many individual TESTS are gated on OPENAI_LIVE_TEST_KEY.
#
# These call the real OpenAI API and cost real money, so unlike the db and redis
# modes this one is NEVER run in CI — ci.sh does not invoke it. It exists because
# the boundary mock accepts any parameter set at all, so it cannot tell us
# whether the provider accepts the request we build (Sentry SITESNAP-API-9: a
# `temperature` the mock was happy with and gpt-5.6-terra rejected with a 400).
# Run it by hand when changing the request shape or OPENAI_MODEL.
EXPECTED_LIVE_OPENAI_TESTS=3

case "$MODE" in
  memory)
    DESCRIPTION="in-memory suite"
    # Depth-independent enumeration. Do NOT replace with node --test 'dist/**/*.test.js':
    # npm/pnpm run scripts execute under sh, which has no globstar, so ** collapses
    # to * and silently matches only files exactly one directory deep.
    FILE_LIST=$(find dist -name '*.test.js' | sort)
    CONCURRENCY=""
    ;;
  openai)
    DESCRIPTION="live OpenAI contract tests"
    if [ -z "${OPENAI_LIVE_TEST_KEY:-}" ]; then
      {
        echo ""
        echo "ERROR: openai mode requires OPENAI_LIVE_TEST_KEY to be set."
        echo ""
        echo "  Without it every contract test skips and the run exits 0, which is"
        echo "  the exact silent-success this script exists to prevent."
        echo ""
        echo "  NOTE: these calls are BILLABLE and hit the real API. This mode is"
        echo "  deliberately not part of CI."
        echo "    OPENAI_LIVE_TEST_KEY=sk-... pnpm run test:openai"
        echo ""
      } >&2
      exit 1
    fi
    FILE_LIST=$(grep -rl 'OPENAI_LIVE_TEST_KEY' dist --include='*.test.js' | sort || true)
    CONCURRENCY="--test-concurrency=1"
    ;;
  redis)
    DESCRIPTION="Redis-gated tests"
    if [ -z "${REDIS_TEST_URL:-}" ]; then
      {
        echo ""
        echo "ERROR: redis mode requires REDIS_TEST_URL to be set."
        echo ""
        echo "  Without it every Redis test skips and the run exits 0, which is"
        echo "  the exact silent-success this script exists to prevent. Start a"
        echo "  Redis and point REDIS_TEST_URL at it, e.g."
        echo "    REDIS_TEST_URL=redis://127.0.0.1:6379 pnpm run test:redis"
        echo ""
      } >&2
      exit 1
    fi
    FILE_LIST=$(grep -rl 'REDIS_TEST_URL' dist --include='*.test.js' | sort || true)
    # These share one Redis keyspace; parallel runs would cross-count.
    CONCURRENCY="--test-concurrency=1"
    ;;
  db)
    DESCRIPTION="database-gated suites"
    FILE_LIST=$(grep -rl '!process.env.TEST_DATABASE_URL' dist --include='*.test.js' | sort || true)
    # node --test runs files in parallel by default; these suites all migrate and
    # seed the same database, so parallel runs race. Sequential is mandatory here.
    CONCURRENCY="--test-concurrency=1"
    ;;
  *)
    echo "run-tests.sh: unknown mode '$MODE' (expected 'memory', 'db', 'redis' or 'openai')" >&2
    exit 2
    ;;
esac

if [ -z "$FILE_LIST" ]; then
  {
    echo ""
    echo "ERROR: selected 0 files for the $DESCRIPTION."
    echo ""
    echo "  This is a FAILURE, not an empty pass. 'node --test' with no file"
    echo "  arguments prints '# pass 0' and exits 0, so without this guard the"
    echo "  build would go green having run nothing."
    echo ""
    if [ "$MODE" = "db" ]; then
      echo "  The db suites are selected by grepping dist/ for the literal string"
      echo "  '!process.env.TEST_DATABASE_URL'. If that guard was rewritten, update"
      echo "  the selector in this script to match."
    elif [ "$MODE" = "redis" ]; then
      echo "  The Redis tests are selected by grepping dist/ for 'REDIS_TEST_URL'."
      echo "  If that env var was renamed, update the selector in this script."
    elif [ "$MODE" = "openai" ]; then
      echo "  The contract tests are selected by grepping dist/ for"
      echo "  'OPENAI_LIVE_TEST_KEY'. If that env var was renamed, update the"
      echo "  selector in this script."
    else
      echo "  Check that 'pnpm run build' emitted to dist/ before this ran."
    fi
    echo ""
  } >&2
  exit 1
fi

# Split on newlines only — never on spaces — so the file list survives paths
# that contain them.
OLD_IFS=$IFS
IFS='
'
# shellcheck disable=SC2086
set -- $FILE_LIST
IFS=$OLD_IFS

echo "run-tests.sh: $DESCRIPTION — $# file(s)"

if [ "$MODE" = "db" ] && [ "$#" -ne "$EXPECTED_DB_SUITES" ]; then
  {
    echo ""
    echo "ERROR: selected $# db-gated file(s), expected $EXPECTED_DB_SUITES."
    echo ""
    echo "  Selected:"
    for f in "$@"; do echo "    $f"; done
    echo ""
    echo "  If you added or removed a DB-gated suite, update EXPECTED_DB_SUITES"
    echo "  in this script in the same commit. If you did not, the grep selector"
    echo "  has stopped matching a suite that still exists — find it before"
    echo "  changing the number."
    echo ""
  } >&2
  exit 1
fi

if [ "$MODE" = "db" ]; then
  exec env NODE_ENV=test node --require ./dist/test-setup.js "$CONCURRENCY" --test "$@"
fi

# Memory and redis modes run through `tee` so the skip count can be checked afterwards
# while the output still streams live.
#
# Getting node's exit status out of that pipeline is the delicate part, and it
# is delicate in a way that fails SILENTLY AND GREEN, so read before editing:
#
#   * `$?` after a pipeline is the LAST command's status — tee's, always 0.
#     Using it would swallow every test failure.
#   * ${PIPESTATUS[0]} is a bashism; this script runs under dash on the CI
#     runner, where it expands to nothing.
#   * `set -e` must be OFF around the run. With it on, a failing node aborts
#     the pipeline's left-hand subshell BEFORE the status is recorded, leaving
#     it empty — and an empty status silently skips the failure check below.
#     That exact mistake was made here first and caught only by deliberately
#     failing a test: the suite reported a real failure and the script still
#     exited 0.
#
# So: status to a file, with `set -e` disabled across the run.
OUT=$(mktemp)
STATUS_FILE=$(mktemp)
trap 'rm -f "$OUT" "$STATUS_FILE"' EXIT

set +e
{ env NODE_ENV=test node --require ./dist/test-setup.js ${CONCURRENCY:+"$CONCURRENCY"} --test "$@"; echo "$?" > "$STATUS_FILE"; } | tee "$OUT"
set -e

STATUS=$(cat "$STATUS_FILE")
if [ -z "$STATUS" ]; then
  echo "ERROR: the test runner's exit status was not recorded — treating as failure." >&2
  exit 1
fi
if [ "$STATUS" -ne 0 ]; then
  exit "$STATUS"
fi

# node --test prints one TAP summary line per counter, e.g. "# skipped 5".
SKIPPED=$(awk '/^# skipped /{print $3}' "$OUT" | tail -1)
if [ -z "$SKIPPED" ]; then
  echo "" >&2
  echo "ERROR: could not find a '# skipped' line in the test output." >&2
  echo "  The runner's summary format changed; update this parser rather than" >&2
  echo "  dropping the check." >&2
  exit 1
fi

if [ "$MODE" = "redis" ] || [ "$MODE" = "openai" ]; then
  EXPECTED_SKIPS=0
else
  EXPECTED_SKIPS=$((EXPECTED_DB_SUITES + EXPECTED_REDIS_TESTS + EXPECTED_LIVE_OPENAI_TESTS))
fi

if [ "$SKIPPED" -ne "$EXPECTED_SKIPS" ]; then
  {
    echo ""
    echo "ERROR: $MODE run reported $SKIPPED skip(s), expected $EXPECTED_SKIPS."
    echo ""
    if [ "$MODE" = "redis" ]; then
      echo "  A Redis test skipped while REDIS_TEST_URL was set. The client could"
      echo "  not reach the server, so the success path went untested and the run"
      echo "  would otherwise have gone green having proved nothing."
    elif [ "$MODE" = "openai" ]; then
      echo "  A contract test skipped while OPENAI_LIVE_TEST_KEY was set, so the"
      echo "  request shape went unverified against the real API."
    else
      echo "  Expected $EXPECTED_DB_SUITES TEST_DATABASE_URL-gated suite(s), plus"
      echo "  $EXPECTED_REDIS_TESTS REDIS_TEST_URL-gated test(s), plus"
      echo "  $EXPECTED_LIVE_OPENAI_TESTS OPENAI_LIVE_TEST_KEY-gated test(s), each of"
      echo "  which must register a skip here and then actually run in its own pass."
      echo ""
      echo "  FEWER than expected: a suite stopped skipping — it may now be running"
      echo "  its assertions against the in-memory store, where RLS does not exist"
      echo "  and would pass vacuously."
      echo "  MORE than expected:  something else started skipping. A skip is not a"
      echo "  pass; find out what stopped running."
    fi
    echo ""
  } >&2
  exit 1
fi

# The positive control for the Redis pass. Zero skips alone is satisfied by a
# selector that matched nothing meaningful; this pins the number that ran.
if [ "$MODE" = "redis" ] || [ "$MODE" = "openai" ]; then
  if [ "$MODE" = "redis" ]; then
    EXPECTED_PASSES=$EXPECTED_REDIS_TESTS; COUNTER_NAME=EXPECTED_REDIS_TESTS; TARGET=$REDIS_TEST_URL
  else
    EXPECTED_PASSES=$EXPECTED_LIVE_OPENAI_TESTS; COUNTER_NAME=EXPECTED_LIVE_OPENAI_TESTS; TARGET="the live OpenAI API"
  fi
  PASSED=$(awk '/^# pass /{print $3}' "$OUT" | tail -1)
  if [ "${PASSED:-0}" -ne "$EXPECTED_PASSES" ]; then
    {
      echo ""
      echo "ERROR: $MODE run passed ${PASSED:-0} test(s), expected $EXPECTED_PASSES."
      echo ""
      echo "  Update $COUNTER_NAME in the same commit that adds or removes such a"
      echo "  test. If you did not change one, tests stopped being selected —"
      echo "  find out which before changing the number."
      echo ""
    } >&2
    exit 1
  fi
  echo "run-tests.sh: $PASSED $MODE test(s) ran against $TARGET, 0 skipped"
  exit 0
fi

echo "run-tests.sh: $SKIPPED skip(s), as expected — each runs for real under test:db / test:redis / test:openai"
