#!/bin/sh
#
# Test runner for the mobile package, with the same empty-list guard as
# services/api/scripts/run-tests.sh and for the same reason:
#
#     $ node --test $(find dist-test -name '*.test.js')   # dist-test is empty
#     # pass 0
#     $ echo $?
#     0
#
# `node --test` with no file arguments prints a clean pass and exits 0. For this
# package that risk is higher than for the API, not lower: the compile is driven
# by an explicit `files` list in tsconfig.test.json, so a rename that drops a
# test from that list emits nothing and would otherwise go green.
#
# So two counters are pinned, both checked from the output rather than from the
# file system:
#
#   EXPECTED_TEST_FILES  how many *.test.js the build emits
#   EXPECTED_TESTS       how many top-level tests actually RUN
#
# The second is the one that matters. A file can compile, be selected, and
# register zero tests — for instance if its `test(...)` calls end up inside a
# describe block that throws during setup. Pinning the pass count makes that a
# red build. Both numbers are EXPECTED TO CHANGE; raise them in the same commit
# that adds a test, so the change is visible in review.
#
# POSIX sh, not bash: macOS ships bash 3.2 and CI runs dash.
set -eu

cd "$(dirname "$0")/.."

EXPECTED_TEST_FILES=5
EXPECTED_TESTS=35

FILE_LIST=$(find dist-test -name '*.test.js' | sort)

if [ -z "$FILE_LIST" ]; then
  {
    echo ""
    echo "ERROR: selected 0 test files from dist-test/."
    echo ""
    echo "  This is a FAILURE, not an empty pass. 'node --test' with no file"
    echo "  arguments prints '# pass 0' and exits 0, so without this guard the"
    echo "  build would go green having run nothing."
    echo ""
    echo "  Check that the compile step emitted to dist-test/, and that the test"
    echo "  file is still listed in tsconfig.test.json's \"files\" array."
    echo ""
  } >&2
  exit 1
fi

OLD_IFS=$IFS
IFS='
'
# shellcheck disable=SC2086
set -- $FILE_LIST
IFS=$OLD_IFS

echo "run-tests.sh: $# test file(s)"

if [ "$#" -ne "$EXPECTED_TEST_FILES" ]; then
  {
    echo ""
    echo "ERROR: found $# test file(s), expected $EXPECTED_TEST_FILES."
    for f in "$@"; do echo "    $f"; done
    echo ""
    echo "  If you added or removed a test file, update EXPECTED_TEST_FILES in"
    echo "  this script AND tsconfig.test.json in the same commit. If you did"
    echo "  not, a test file has stopped compiling — find it before changing"
    echo "  the number."
    echo ""
  } >&2
  exit 1
fi

# Exit status out of a pipeline, the careful way. `$?` after a pipe is tee's
# status (always 0) and ${PIPESTATUS[0]} is a bashism that expands to nothing
# under dash — either mistake swallows every test failure and reports green.
# `set -e` must be off across the run or a failing node aborts the left-hand
# subshell before the status is written.
OUT=$(mktemp)
STATUS_FILE=$(mktemp)
trap 'rm -f "$OUT" "$STATUS_FILE"' EXIT

set +e
{ node --require ./dist-test/lib/test-setup.js --test "$@"; echo "$?" > "$STATUS_FILE"; } | tee "$OUT"
set -e

STATUS=$(cat "$STATUS_FILE")
if [ -z "$STATUS" ]; then
  echo "ERROR: the test runner's exit status was not recorded — treating as failure." >&2
  exit 1
fi
if [ "$STATUS" -ne 0 ]; then
  exit "$STATUS"
fi

PASSED=$(awk '/^# pass /{print $3}' "$OUT" | tail -1)
if [ -z "$PASSED" ]; then
  echo "" >&2
  echo "ERROR: could not find a '# pass' line in the test output." >&2
  echo "  The runner's summary format changed; update this parser rather than" >&2
  echo "  dropping the check." >&2
  exit 1
fi

if [ "$PASSED" -ne "$EXPECTED_TESTS" ]; then
  {
    echo ""
    echo "ERROR: $PASSED test(s) passed, expected $EXPECTED_TESTS."
    echo ""
    echo "  A zero-failure run is not the same as a run that happened. If you"
    echo "  added or removed a test, update EXPECTED_TESTS in this script in the"
    echo "  same commit. If you did not, tests have stopped being registered."
    echo ""
  } >&2
  exit 1
fi

SKIPPED=$(awk '/^# skipped /{print $3}' "$OUT" | tail -1)
if [ "${SKIPPED:-0}" -ne 0 ]; then
  echo "" >&2
  echo "ERROR: ${SKIPPED} test(s) skipped. This package has no gated suites;" >&2
  echo "  a skip here is a test that stopped running. No skips without an" >&2
  echo "  explanation written into this script." >&2
  exit 1
fi

echo "run-tests.sh: $PASSED test(s) passed, 0 skipped"
