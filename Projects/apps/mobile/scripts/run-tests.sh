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

# 27, MEASURED on this branch. The eleven-workstream batch that produced the
# comment this replaces has landed, so the number is no longer
# position-dependent across that batch: 26 on main, +1 for
# lib/client-site-counts.test.ts (AUDIT L114, the phone half of the site-count
# bug). The historical breakdown of the 26 is in
# docs/NINE-WORKSTREAMS-HANDOVER.md.
#
# This counter alone cannot catch a test file that was never COMPILED --
# tsconfig.test.json carries an explicit `files` list, so a new lib/*.test.ts
# omitted from it emits nothing, the count stays where it was and the counter
# passes. AUDIT L115. The equality below closes that, by deriving the
# population from the SOURCE tree rather than from this number.
#
# 28 on feat/pr2-job-number, MEASURED: +1 for lib/job-number.test.ts. The
# branches in this batch STACK, so this is measured at its real position in the
# stack and needs no back-porting when the branches ahead of it land.
#
# 30 on fix/pr2b-annotation-save, MEASURED: +2 for lib/annotation-render.test.ts
# and lib/annotation-render-audit.test.ts.
#
# 31 on feat/pr3-client-information, MEASURED: +1 for lib/client-details.test.ts.
# The guard refused this commit first, reporting 31 found against 30 expected,
# which is the number arriving by measurement rather than by my arithmetic.
EXPECTED_TEST_FILES=31
# 214, MEASURED on this branch: 207 on main, +7 from
# lib/client-site-counts.test.ts. The historical derivation of the 207 is in
# docs/NINE-WORKSTREAMS-HANDOVER.md.
#
# 222 on feat/pr2-job-number, MEASURED: 214 + 7 from lib/job-number.test.ts,
# +1 for the canSetSiteJobNumber test in lib/permissions.test.ts.
#
# 234 on fix/pr2b-annotation-save, MEASURED: 222 + 6 from
# lib/annotation-render.test.ts + 6 from lib/annotation-render-audit.test.ts.
#
# 241 on feat/pr3-client-information, MEASURED: 234 + 7 from
# lib/client-details.test.ts.
EXPECTED_TESTS=241

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

# ---------------------------------------------------------------------------
# AUDIT L115: the counter above cannot catch a test file that was never
# compiled.
#
# tsconfig.test.json carries an EXPLICIT `files` array -- deliberately, so that
# a module can only be added by someone who has checked it has no React Native
# import. The cost is that a new lib/*.test.ts omitted from it emits nothing,
# dist-test holds the same number of files as before, EXPECTED_TEST_FILES still
# matches, and the run goes green having never loaded the new tests. That is
# exactly what happened to lib/client-site-counts.test.ts: 26 files, 207 tests,
# exit 0, with seven tests on disk that had never executed.
#
# A hand-maintained number cannot close that, because the number and the
# omission are the same mistake. So this derives the population from the SOURCE
# tree -- the files a person actually wrote -- and requires an emitted twin for
# each one. Per AUDIT L112: an equality against a run-time-derived comparand,
# not a floor.
# ---------------------------------------------------------------------------
SOURCE_LIST=$(find . \( -name '*.test.ts' -o -name '*.test.tsx' \) \
  -not -path './node_modules/*' -not -path './dist-test/*' | sort)

if [ -z "$SOURCE_LIST" ]; then
  {
    echo ""
    echo "ERROR: found 0 *.test.ts files in the source tree."
    echo ""
    echo "  dist-test/ held $# compiled test file(s), so this is not an empty"
    echo "  package -- it is a broken find(1) invocation, a wrong working"
    echo "  directory, or a source tree that has lost its tests."
    echo ""
  } >&2
  exit 1
fi

UNCOMPILED=""
SOURCE_COUNT=0
for src in $SOURCE_LIST; do
  SOURCE_COUNT=$((SOURCE_COUNT + 1))
  emitted="dist-test/$(echo "$src" | sed -e 's|^\./||' -e 's|\.test\.tsx*$|.test.js|')"
  if [ ! -f "$emitted" ]; then
    UNCOMPILED="$UNCOMPILED
    $src -> expected $emitted"
  fi
done

if [ -n "$UNCOMPILED" ]; then
  {
    echo ""
    echo "ERROR: $SOURCE_COUNT test file(s) in the source tree, but these"
    echo "       emitted nothing to dist-test/:"
    echo "$UNCOMPILED"
    echo ""
    echo "  Almost always: the file is missing from the \"files\" array in"
    echo "  tsconfig.test.json. Add it, together with the module it tests, and"
    echo "  raise EXPECTED_TEST_FILES and EXPECTED_TESTS in the same commit."
    echo ""
    echo "  If the module genuinely cannot be compiled here -- it imports"
    echo "  react-native, expo-router or a .tsx screen -- then it does not"
    echo "  belong in lib/ as a *.test.ts; say so in review rather than"
    echo "  leaving a test file that never runs."
    echo ""
  } >&2
  exit 1
fi

if [ "$SOURCE_COUNT" -ne "$#" ]; then
  {
    echo ""
    echo "ERROR: $SOURCE_COUNT test file(s) in the source tree, $# in dist-test/."
    echo ""
    echo "  Every source test file has an emitted twin (checked above), so this"
    echo "  is the other direction: dist-test/ holds a compiled test with no"
    echo "  source. A stale dist-test should be impossible -- the test script"
    echo "  starts with 'rm -rf dist-test' -- so find out why before changing"
    echo "  any number."
    echo ""
  } >&2
  exit 1
fi

echo "run-tests.sh: $SOURCE_COUNT source test file(s), all compiled"

# Exit status out of a pipeline, the careful way. `$?` after a pipe is tee's
# status (always 0) and ${PIPESTATUS[0]} is a bashism that expands to nothing
# under dash — either mistake swallows every test failure and reports green.
# `set -e` must be off across the run or a failing node aborts the left-hand
# subshell before the status is written.
OUT=$(mktemp)
STATUS_FILE=$(mktemp)
trap 'rm -f "$OUT" "$STATUS_FILE"' EXIT

# --test-reporter=tap is EXPLICIT, not decorative (AUDIT L110). node picks its
# default reporter from whether stdout is a TTY, and the non-TTY default changed
# between node 20 (`tap`) and node 24 (`spec`). Every summary parser below greps
# for TAP counter lines such as "# pass 12", which node 24's spec reporter
# writes as "ℹ pass 12" instead. CI pins node 20 so CI never saw it; a local run
# on 24 fails with "could not find a '# pass' line" and looks like a broken
# parser rather than a reporter change. Passing it explicitly is correct under
# BOTH versions, so this is backward-safe, not a node-24 workaround.
set +e
{ node --require ./dist-test/lib/test-setup.js --test-reporter=tap --test "$@"; echo "$?" > "$STATUS_FILE"; } | tee "$OUT"
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
