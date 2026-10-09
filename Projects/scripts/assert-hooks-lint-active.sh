#!/bin/sh
# Fails if `react-hooks/rules-of-hooks` is not actually being applied to the
# React packages.
#
# WHY THIS EXISTS, AND WHY IT IS NOT PARANOIA
#
# The rule is wired through two `overrides` entries in .eslintrc.js keyed on
# path globs — `apps/mobile/**` and `apps/supervisor-web/**`. Everything about
# that arrangement can fail silently:
#
#   - rename or move a package and its glob matches nothing (measured: renaming
#     the mobile glob to `apps/mobile-app/**` makes this script fail, and
#     `pnpm run lint` still exits 0);
#   - delete the rules from one override while leaving the other intact
#     (measured: dropping `...reactHooks.rules` from the supervisor-web entry
#     makes this script fail, and `pnpm run lint` still exits 0);
#   - add a broader `overrides` entry later in the array that resets the rule;
#   - uninstall the plugin and both overrides stop contributing anything.
#
# One thing that does NOT break it, checked rather than assumed: removing
# `plugins: ["react-hooks"]` from a single override. eslint 8 merges `plugins`
# from every config block into one registry, so the other override's
# declaration keeps the prefix resolvable for both. The duplicate declaration
# is therefore belt-and-braces, not load-bearing — worth knowing before
# someone "simplifies" it and trusts this check to have caught a change it
# would not have caught.
#
# In the failure modes that do bite, `pnpm run lint` still exits 0 and prints nothing,
# because there are currently zero violations to lose. A rule enforcing an
# invariant that holds vacuously is indistinguishable from a rule that is not
# running at all — and this repo has been bitten four times by checks that
# passed while proving nothing (AUDIT L36 and docs/VACUITY-AUDIT.md M7 are the
# two written up). So the check is not "is the config spelled right", which
# would be the config asserting about itself. It runs eslint against a file
# that genuinely violates the rule and requires the violation to be reported.
#
# The fixture is written into the package and removed again rather than kept on
# disk, because a permanent file containing a deliberate lint error has to be
# excluded from the lint glob to stop it failing the build — and a fixture
# excluded from linting is a fixture that proves nothing about the real run.
set -eu

cd "$(dirname "$0")/.."

# Both packages, because the overrides are separate entries and either can rot
# on its own. mediaStorage-style false positives in services/api are the
# reason the rule is not global; see the comment in .eslintrc.js.
PACKAGES="apps/mobile apps/supervisor-web"

FIXTURES=""
cleanup() { [ -z "$FIXTURES" ] || rm -f $FIXTURES; }
trap cleanup EXIT HUP INT TERM

FAIL=0
CHECKED=0

for pkg in $PACKAGES; do
  if [ ! -d "$pkg" ]; then
    echo "assert-hooks-lint-active: $pkg does not exist." >&2
    echo "  If a package moved, update this check AND the matching overrides" >&2
    echo "  entry in .eslintrc.js — do not delete either." >&2
    exit 1
  fi

  fixture="$pkg/eslint-hooks-probe.tsx"
  FIXTURES="$FIXTURES $fixture"

  # A conditional hook after an early return: the canonical rules-of-hooks
  # violation, and the shape that actually ships (AUDIT L42-L44 are all one
  # effect in the portal).
  cat > "$fixture" <<'TSX'
import { useState } from "react";

export default function HooksProbe({ on }: { on: boolean }) {
  if (!on) return null;
  const [n] = useState(0);
  return n;
}
TSX

  OUT="$(pnpm exec eslint "$fixture" -f json 2>/dev/null || true)"

  # The rule must be reported BY NAME. Asserting only that eslint exited
  # non-zero would pass on any unrelated error in the fixture — a parse
  # failure, or no-unused-vars — which is how a check ends up measuring its
  # own fixture instead of the rule.
  if printf '%s' "$OUT" | grep -q 'react-hooks/rules-of-hooks'; then
    CHECKED=$((CHECKED + 1))
  else
    echo "FAIL: react-hooks/rules-of-hooks did not fire on $fixture." >&2
    echo "  The rule is configured but is not reaching this package, so the" >&2
    echo "  React code in it is unprotected and lint still passes. Check the" >&2
    echo "  overrides entry for '$pkg' in .eslintrc.js and that" >&2
    echo "  eslint-plugin-react-hooks is installed." >&2
    echo "  eslint said:" >&2
    printf '%s\n' "$OUT" | head -c 2000 | sed 's/^/    /' >&2
    FAIL=1
  fi
done

# The loop above can only fail a package it iterated. An empty or mistyped
# PACKAGES list would run zero iterations and fall through to a pass, which is
# the exact failure mode this script was written to prevent — so assert the
# population, not just the absence of failures.
EXPECTED=2
if [ "$CHECKED" != "$EXPECTED" ] && [ "$FAIL" = "0" ]; then
  echo "FAIL: verified the rule on $CHECKED packages, expected $EXPECTED." >&2
  echo "  Nothing failed, but fewer packages were checked than this script" >&2
  echo "  claims to cover. A check that enumerates nothing passes." >&2
  exit 1
fi

[ "$FAIL" = "0" ] || exit 1
echo "assert-hooks-lint-active: rules-of-hooks fires in all $CHECKED React packages"
