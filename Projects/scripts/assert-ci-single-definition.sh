#!/bin/sh
# Fails if the CI gate is defined anywhere other than scripts/ci.sh.
#
# ci.sh is only "the single definition" for as long as nothing else quietly
# becomes a second one. The realistic way that happens is not malice: someone
# debugging a flaky step adds `- name: Tests (database)` back into ci.yml to
# re-run it in isolation, and it stays. From then on CI and local differ again,
# and nothing says so. This check is what says so.
set -eu

cd "$(dirname "$0")/.."
WORKFLOW="../.github/workflows/ci.yml"
FAIL=0

if [ ! -f "$WORKFLOW" ]; then
  echo "assert-ci-single-definition: $WORKFLOW not found." >&2
  echo "  If CI moved, update this check — do not delete it." >&2
  exit 1
fi

# 1. ci.yml must actually invoke ci.sh. Without this, deleting the invocation
#    would leave a workflow that runs nothing and a check that passes.
#
#    It must match a `run:` LINE, not the file anywhere. A bare
#    `grep -q scripts/ci.sh` was tried first and passed against a workflow whose
#    run step had been replaced with `echo nothing` — because ci.yml's own
#    explanatory comment names the script. The check was being satisfied by
#    prose describing the thing it was supposed to verify.
if ! grep -qE '^[[:space:]]*run:[[:space:]]*\./scripts/ci\.sh' "$WORKFLOW"; then
  echo "FAIL: $WORKFLOW has no 'run: ./scripts/ci.sh' step." >&2
  echo "  A mention in a comment does not count." >&2
  FAIL=1
fi

# 2. ci.yml must not run any gate itself. `pnpm install` and the pnpm store
#    path lookup are infrastructure and stay; anything that lints, typechecks,
#    tests or builds is a gate and belongs inside ci.sh.
STRAY=$(grep -nE '^[[:space:]]*run:.*pnpm' "$WORKFLOW" \
        | grep -vE 'pnpm install' \
        | grep -vE 'pnpm store path' \
        || true)
if [ -n "$STRAY" ]; then
  echo "FAIL: $WORKFLOW runs pnpm gate steps of its own:" >&2
  echo "$STRAY" | sed 's/^/    /' >&2
  echo "" >&2
  echo "  Move them into scripts/ci.sh. Every gate step must live in one file," >&2
  echo "  or local and CI can disagree without either one reporting it." >&2
  FAIL=1
fi

# 3. No workflow directory anywhere but the repo root.
#
#    GitHub only reads `.github/workflows/` at the REPOSITORY ROOT. A workflow
#    file placed anywhere else is inert — it never runs, nothing reports on it,
#    and so nothing ever tells you it has drifted. `Projects/.github/workflows/
#    ci.yml` was exactly that: a fourth definition of the gate, with no Postgres
#    service, no Redis service, and no call to ci.sh, sitting unexecuted for
#    months while reading like the real thing.
#
#    Inert is not harmless. It is a trap for the next person who opens it to see
#    "what CI does", and worse for anyone who fixes the inertness by moving it
#    to the root — which would replace the real gate with the weaker one and
#    report green.
if [ -d "../Projects/.github/workflows" ] || [ -d ".github/workflows" ]; then
  echo "FAIL: a .github/workflows directory exists below the repository root." >&2
  echo "  GitHub only reads the root one, so this is an inert second definition" >&2
  echo "  of the gate that can drift without ever failing. Delete it; the real" >&2
  echo "  workflow is at the repo root and runs scripts/ci.sh." >&2
  FAIL=1
fi

# 4. The root "ci" script must delegate too, so `pnpm run ci` and CI agree.
#    This one was already wrong when written: it ran lint+typecheck+test and
#    omitted test:db, so it passed a strictly weaker check than CI did.
CI_SCRIPT=$(node -e 'process.stdout.write(String(require("./package.json").scripts.ci ?? ""))')
case "$CI_SCRIPT" in
  *scripts/ci.sh*) ;;
  *)
    echo "FAIL: root package.json \"ci\" script does not delegate to ./scripts/ci.sh." >&2
    echo "    found: $CI_SCRIPT" >&2
    FAIL=1
    ;;
esac

[ "$FAIL" = "0" ] || exit 1
echo "assert-ci-single-definition: ci.yml and package.json both delegate to scripts/ci.sh"
