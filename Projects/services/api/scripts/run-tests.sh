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
[ -n "$MODE" ] || { echo "usage: run-tests.sh <memory|db>" >&2; exit 2; }
cd "$(dirname "$0")/.."

case "$MODE" in
  memory)
    DESCRIPTION="in-memory suite"
    # Depth-independent enumeration. Do NOT replace with node --test 'dist/**/*.test.js':
    # npm/pnpm run scripts execute under sh, which has no globstar, so ** collapses
    # to * and silently matches only files exactly one directory deep.
    FILE_LIST=$(find dist -name '*.test.js' | sort)
    CONCURRENCY=""
    ;;
  db)
    DESCRIPTION="database-gated suites"
    FILE_LIST=$(grep -rl '!process.env.TEST_DATABASE_URL' dist --include='*.test.js' | sort || true)
    # node --test runs files in parallel by default; these suites all migrate and
    # seed the same database, so parallel runs race. Sequential is mandatory here.
    CONCURRENCY="--test-concurrency=1"
    ;;
  *)
    echo "run-tests.sh: unknown mode '$MODE' (expected 'memory' or 'db')" >&2
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

if [ -n "$CONCURRENCY" ]; then
  exec env NODE_ENV=test node --require ./dist/test-setup.js "$CONCURRENCY" --test "$@"
fi
exec env NODE_ENV=test node --require ./dist/test-setup.js --test "$@"
