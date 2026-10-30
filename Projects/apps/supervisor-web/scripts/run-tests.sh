#!/bin/sh
#
# Test runner for the supervisor-web package.
#
# This package had no test script and no tests at all. It now has both, for one
# specific reason: the portal has to apply the same rules about a photograph's
# capture time and provenance that mobile applies, and those rules are
# DUPLICATED here rather than shared, because `@sitesnap/shared` emits .d.ts
# only and neither client depends on it. A duplicated compliance rule with no
# test on one of its two copies is a rule that will diverge silently, and the
# divergence would surface as the two surfaces stating different things about
# the same photograph.
#
# So this is deliberately the smallest harness that can defend that:
#   - `node:test`, which is built into node 20. NO new dependency.
#   - an explicit `files` list in tsconfig.test.json, like mobile's.
#   - the same empty-list guard and the same pinned counters as
#     apps/mobile/scripts/run-tests.sh and services/api/scripts/run-tests.sh.
#
# The guard exists because:
#
#     $ node --test $(find dist-test -name '*.test.js')   # dist-test is empty
#     # pass 0
#     $ echo $?
#     0
#
# `node --test` with no file arguments prints a clean pass and exits 0. With an
# explicit `files` list driving the compile, a rename that drops a test from
# that list emits nothing and would otherwise go green.
#
# Two counters, both read from the OUTPUT rather than from the file system:
#
#   EXPECTED_TEST_FILES  how many *.test.js the build emits
#   EXPECTED_TESTS       how many top-level tests actually RUN
#
# The second is the one that matters: a file can compile, be selected, and
# register zero tests. Both are EXPECTED TO CHANGE; raise them in the same
# commit that adds a test, so the change is visible in review.
#
# There is no `--require` preload, unlike mobile's runner. Mobile needs one to
# blank the environment; everything compiled here is a pure function with no
# environment, no store and no network, and a preload that did nothing would
# only suggest otherwise.
#
# POSIX sh, not bash: macOS ships bash 3.2 and CI runs dash.
set -eu

cd "$(dirname "$0")/.."

# 4 and 36, MEASURED on this branch.
#
# EXPECTED_TEST_FILES alone cannot catch a test file that was never COMPILED --
# tsconfig.test.json carries an explicit `files` list, so a new lib/*.test.ts
# omitted from it emits nothing, the count stays where it was, and this counter
# passes having run the new tests nowhere. AUDIT L115, where exactly that
# happened on the mobile side. The equality further down closes it, by deriving
# the population from the SOURCE tree rather than from this number.
#
# 5 on feat/pr2-job-number, MEASURED: +1 for lib/job-number.test.ts, the portal
# half of the job-number rule. This is also the first file added to this package
# since the L115 guard below was ported to it -- so the guard's first real job
# was refusing the commit that registered the file in tsconfig.test.json but
# had not yet raised this number.
#
# 6 on fix/pr2b-annotation-save, MEASURED: +1 for lib/annotation-render.test.ts,
# the portal half of the annotation overlay rule. The guard refused this commit
# too, in exactly the same way, and for the same reason: the file was registered
# in tsconfig.test.json before this number was raised.
#
# 7 on feat/pr3-client-information, MEASURED: +1 for lib/client-details.test.ts,
# the portal's copy of the detail-row rule. Refused this commit too, 7 against
# 6 — three branches running, three refusals, which is the guard doing its job
# rather than three mistakes.
EXPECTED_TEST_FILES=7
#
# 43 on feat/pr2-job-number, MEASURED: 36 + 7 from lib/job-number.test.ts.
#
# 48 on fix/pr2b-annotation-save, MEASURED: 43 + 5 from
# lib/annotation-render.test.ts.
#
# 55 on feat/pr3-client-information, MEASURED: 48 + 7 from
# lib/client-details.test.ts. Seven, the same as the mobile copy's, because
# the two test files hold the same assertions deliberately — see either
# file's header.
EXPECTED_TESTS=55

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
# AUDIT L115, ported from apps/mobile/scripts/run-tests.sh.
#
# The counter above counts what the compiler EMITTED. It cannot count what a
# person WROTE, so it cannot notice the gap between the two. tsconfig.test.json
# carries an explicit `files` array -- deliberately, so that a module can only
# be added by someone who has checked it has no React, next/* or DOM import --
# and the cost is that a new lib/*.test.ts omitted from it emits nothing,
# dist-test/ holds the same number of files as before, EXPECTED_TEST_FILES
# still matches, and the run goes green having never loaded the new tests.
#
# On mobile that was not hypothetical: apps/mobile/lib/client-site-counts.test.ts sat on
# disk through a full green run of 26 files and 207 tests, with seven tests that
# had never executed. Nothing about that mechanism is specific to mobile, and
# this package's `files` array is the same shape. It is ported here BEFORE it
# bites rather than after, because the portal's suite is about to grow.
#
# A hand-maintained number cannot close this, because the number and the
# omission are the same mistake. So the population comes from the SOURCE tree --
# the files a person actually wrote -- and each one must have an emitted twin.
# Per AUDIT L112: an equality against a run-time-derived comparand, not a floor.
#
# `.test.tsx` is included in the sweep even though this package currently has
# none. A component test would be the obvious first one somebody writes, and a
# guard that silently ignores the file extension it was not written for is the
# same defect in a new coat.
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
    echo "  If the module genuinely cannot be compiled here -- it imports React,"
    echo "  next/* or a browser global -- then it does not belong in lib/ as a"
    echo "  *.test.ts; say so in review rather than leaving a test file that"
    echo "  never runs."
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
# between node 20 (`tap`) and node 24 (`spec`). The parsers below grep for TAP
# counter lines such as "# pass 12", which node 24's spec reporter writes as
# "ℹ pass 12" instead. CI pins node 20, so CI never saw it; a local run on 24
# failed with "could not find a '# pass' line" and looked like a broken parser
# rather than a reporter change. Passing it explicitly is correct under BOTH
# versions, so this is backward-safe, not a node-24 workaround.
#
# This site was MISSED by the L110 sweep in PR 0, which said "all three node
# --test invocation sites" and meant the API's two and mobile's one. There are
# four. The portal's was overlooked for the same reason AUDIT L115 wrongly
# recorded that this package has no test suite at all -- see L117.
set +e
{ node --test-reporter=tap --test "$@"; echo "$?" > "$STATUS_FILE"; } | tee "$OUT"
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
