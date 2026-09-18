#!/bin/sh
#
# Guard for the workspace-root `test` script.
#
# The root script is `pnpm -r --if-present run test`. `--if-present` is there so
# that packages without tests (mobile, supervisor-web, shared) don't fail the
# run — but it means the command's success does not depend on any test existing.
# Rename or drop `services-api`'s `test` script and pnpm cheerfully matches zero
# packages and exits 0. Same failure as the empty file list in
# services/api/scripts/run-tests.sh: a green result reporting work that never
# happened.
#
# So the set of packages that declare a `test` script is pinned here. Adding
# tests to a package is then a deliberate one-line change to EXPECTED below,
# and losing them is a red build.
set -eu

cd "$(dirname "$0")/.."

# Packages expected to declare a "test" script, one per line, sorted.
# Update this when a package gains or loses a test suite — that is the point.
EXPECTED="services-api"

ACTUAL=$(
  for f in package.json shared/package.json services/*/package.json apps/*/package.json; do
    [ -f "$f" ] || continue
    # Skip the workspace root itself: its own `test` script is the one running this.
    [ "$f" = "package.json" ] && continue
    node -e '
      const fs = require("fs");
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (p.scripts && p.scripts.test) console.log(p.name);
    ' "$f"
  done | sort
)

if [ "$ACTUAL" != "$EXPECTED" ]; then
  {
    echo ""
    echo "ERROR: the set of packages declaring a \"test\" script has changed."
    echo ""
    echo "  expected:"
    echo "$EXPECTED" | sed 's/^/    /'
    echo "  actual:"
    if [ -z "$ACTUAL" ]; then echo "    (none)"; else echo "$ACTUAL" | sed 's/^/    /'; fi
    echo ""
    echo "  The root test script uses 'pnpm -r --if-present run test', which exits 0"
    echo "  when it matches no packages. Without this check, deleting or renaming a"
    echo "  package's test script would turn CI green rather than red."
    echo ""
    echo "  If this change is intended, update EXPECTED in $0"
    echo ""
  } >&2
  exit 1
fi

echo "assert-test-packages.sh: ok — $(echo "$ACTUAL" | wc -l | tr -d ' ') package(s) declare tests"
