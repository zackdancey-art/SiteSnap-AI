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

# 5. No OTHER root workflow may run a gate either.
#
#    Checks 1-4 all read `ci.yml` or `package.json`, and that is how the gate
#    acquired a third definition without this script noticing: `deploy-api.yml`
#    ran its own Typecheck and Tests steps on every push to `main` that touched
#    the API. Worse than duplicated, they were vacuous -- both used
#    `pnpm --filter ./services/api`, and a bare relative path is a NAME pattern
#    to pnpm, not a path one, so it matched no projects and pnpm exited 0. Two
#    green checks named "Typecheck" and "Tests" that ran nothing at all:
#
#      $ pnpm -C Projects --filter ./services/api exec node -e 'console.log(1)'
#      No projects matched the filters in ".../Projects"
#      $ echo $?
#      0
#
#    That workflow is deleted. This check is what stops the next one, because
#    the lesson of checks 2 and 3 is that fixing the instance leaves the class.
#
#    build-mobile.yml is exempt and named here rather than pattern-matched. It
#    runs `pnpm run typecheck` before a release build, which is a duplicate
#    definition by this script's own standard, but it is also the last gate
#    before a store submission and consolidating it belongs with the owner's
#    pending decision on that workflow's release trigger (HALF-BUILT F11). An
#    exemption with a reason and an expiry beats a check nobody can keep green.
#
#    api-post-merge-checks.yml is exempt for the same reason and on the same
#    terms. It runs `pnpm --filter ./services/api run typecheck` and `... run
#    test` after a merge to main, which IS a second definition of the gate by
#    this script's standard. It is exempt rather than deleted because, unlike
#    the workflow named above, it actually runs: it sets
#    `defaults.run.working-directory: Projects`, so its relative-path filters
#    resolve and its steps do real work. Whether a post-merge re-run of the gate
#    is worth keeping now that `main` requires `validate` to pass pre-merge is
#    the owner's decision, pending alongside build-mobile.yml's.
#
#    That file does not exist on this branch -- it arrives with workstream 0.
#    The exemption is listed here anyway and is harmless if it never does: the
#    loop below iterates workflow files that EXIST and skips by basename, so an
#    exemption naming an absent file matches nothing. Naming it here is what
#    stops this check going red at the merge that brings the two together.
EXEMPT_GATE_WORKFLOWS="build-mobile.yml api-post-merge-checks.yml"
WORKFLOW_DIR="../.github/workflows"
for wf in "$WORKFLOW_DIR"/*.yml "$WORKFLOW_DIR"/*.yaml; do
  [ -f "$wf" ] || continue
  base=$(basename "$wf")
  [ "$base" = "ci.yml" ] && continue
  case " $EXEMPT_GATE_WORKFLOWS " in *" $base "*) continue ;; esac
  OTHER=$(grep -nE '^[[:space:]]*run:.*pnpm' "$wf" \
          | grep -vE 'pnpm install' \
          | grep -vE 'pnpm store path' \
          || true)
  if [ -n "$OTHER" ]; then
    echo "FAIL: $base runs pnpm gate steps of its own:" >&2
    echo "$OTHER" | sed 's/^/    /' >&2
    echo "" >&2
    echo "  Every gate step lives in scripts/ci.sh. A workflow that runs its own" >&2
    echo "  copy is a second definition that drifts silently -- and if it uses a" >&2
    echo "  --filter that matches nothing, it reports green having run nothing." >&2
    echo "  Call ./scripts/ci.sh, or add this file to EXEMPT_GATE_WORKFLOWS with" >&2
    echo "  a reason." >&2
    FAIL=1
  fi
done

[ "$FAIL" = "0" ] || exit 1
echo "assert-ci-single-definition: ci.yml and package.json both delegate to scripts/ci.sh"
