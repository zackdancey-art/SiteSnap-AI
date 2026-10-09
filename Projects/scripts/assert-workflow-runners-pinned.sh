#!/bin/sh
# Fails if any workflow floats its runner image or pins an action to a major
# that has been retired.
#
# WHY
#
# `runs-on: ubuntu-latest` is a moving target. GitHub began migrating the label
# to Ubuntu 26.04 on 19 October 2026, and the migration lands with no commit in
# this repository: the same ref builds on a different operating system, and the
# first symptom is a red build on a branch whose diff explains nothing. The
# same is true of the runner's preinstalled toolchain, which changes under the
# label too.
#
# Pinning the four workflow files once was a five-minute hand sweep. The thing
# that sweep cannot do is stop the FIFTH workflow -- added next month, copied
# from a blog post, floating again -- and nobody re-runs a hand sweep. That is
# the whole difference between fixing the instances and fixing the class, so
# this runs in CI instead.
#
# The action majors are checked for the same reason by a different mechanism:
# actions/checkout@v4 and friends run on Node 20, which GitHub has deprecated
# for actions. A deprecated runtime does not fail -- it warns, in a log nobody
# opens, until the day it stops.
set -eu

cd "$(dirname "$0")/.."
WORKFLOW_DIR="../.github/workflows"

if [ ! -d "$WORKFLOW_DIR" ]; then
  echo "assert-workflow-runners-pinned: $WORKFLOW_DIR not found." >&2
  echo "  If the workflows moved, update this check -- do not delete it." >&2
  exit 1
fi

# Vacuity guard, first and not last. Every assertion below is of the form
# "no file contains X", and that is satisfied perfectly by finding no files.
# This repo has been bitten four times by exactly that shape (AUDIT L36,
# docs/VACUITY-AUDIT.md M7), so count the population before trusting a clean
# result, and state what the count was expected to be.
EXPECTED_WORKFLOWS=3
FOUND="$(find "$WORKFLOW_DIR" -maxdepth 1 -name '*.yml' -o -maxdepth 1 -name '*.yaml' | sort)"
COUNT="$(printf '%s\n' "$FOUND" | sed '/^$/d' | wc -l | tr -d ' ')"

if [ "$COUNT" = "0" ]; then
  echo "assert-workflow-runners-pinned: found no workflow files at all." >&2
  echo "  Refusing to report a pass on a check that read nothing." >&2
  exit 1
fi

if [ "$COUNT" != "$EXPECTED_WORKFLOWS" ]; then
  echo "assert-workflow-runners-pinned: found $COUNT workflows, expected $EXPECTED_WORKFLOWS:" >&2
  printf '%s\n' "$FOUND" | sed 's/^/    /' >&2
  echo "" >&2
  echo "  A new workflow is not a failure -- but it has not been reviewed for a" >&2
  echo "  floating runner, so say so out loud rather than sweeping it in" >&2
  echo "  silently. Check it, then raise EXPECTED_WORKFLOWS in this script in" >&2
  echo "  the same commit." >&2
  exit 1
fi

FAIL=0

# 1. No floating runner label. Matched on the `runs-on:` key so the explanatory
#    comments in these files -- which necessarily contain the string
#    "ubuntu-latest" -- do not satisfy or trip the check. That distinction is
#    not hypothetical: assert-ci-single-definition.sh was once satisfied by its
#    own prose naming the script it was meant to verify.
FLOATING="$(grep -rnE '^[[:space:]]*runs-on:[[:space:]]*\S*-latest' "$WORKFLOW_DIR" || true)"
if [ -n "$FLOATING" ]; then
  echo "FAIL: a workflow floats its runner image:" >&2
  printf '%s\n' "$FLOATING" | sed 's/^/    /' >&2
  echo "" >&2
  echo "  Pin it (e.g. ubuntu-24.04). A floating label changes the build OS" >&2
  echo "  with no commit to attribute the change to." >&2
  FAIL=1
fi

# 2. Positive control for check 1. If the `runs-on:` pattern above were wrong --
#    a typo, or a YAML style it does not match -- it would find nothing and
#    report a pass. So require that it can see the pinned runners it is
#    supposed to be regulating.
PINNED="$(grep -rcE '^[[:space:]]*runs-on:[[:space:]]*ubuntu-[0-9]' "$WORKFLOW_DIR" \
          | awk -F: '{n+=$2} END {print n+0}')"
EXPECTED_PINNED=4
if [ "$PINNED" != "$EXPECTED_PINNED" ]; then
  echo "FAIL: matched $PINNED pinned 'runs-on:' lines, expected $EXPECTED_PINNED." >&2
  echo "  Either a job was added or removed -- update this number in the same" >&2
  echo "  commit -- or the pattern this check greps with has stopped matching" >&2
  echo "  the real files, in which case check 1 above is proving nothing." >&2
  FAIL=1
fi

# 3. Action majors that are known-retired. Keyed on specific actions rather
#    than "anything on v4", because v4 is perfectly current for other actions
#    and a blanket rule would be wrong the first time one is added.
#    v4 of these three runs on Node 20, deprecated for GitHub Actions.
for spec in "actions/checkout:4" "actions/setup-node:4" "actions/cache:4" "pnpm/action-setup:4"; do
  action="${spec%:*}"
  retired="${spec##*:}"
  HITS="$(grep -rnE "uses:[[:space:]]*${action}@v${retired}([^0-9]|$)" "$WORKFLOW_DIR" || true)"
  if [ -n "$HITS" ]; then
    echo "FAIL: ${action}@v${retired} is retired (Node 20 runtime):" >&2
    printf '%s\n' "$HITS" | sed 's/^/    /' >&2
    FAIL=1
  fi
done

[ "$FAIL" = "0" ] || exit 1
echo "assert-workflow-runners-pinned: $COUNT workflows, $PINNED pinned runners, no retired action majors"
