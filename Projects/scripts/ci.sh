#!/bin/sh
# THE definition of "the build passes". There is deliberately only one.
#
# Why this file exists: the gate used to be defined in three places that were
# free to drift — .github/workflows/ci.yml listed four steps, the root
# package.json "ci" script listed three (it omitted test:db entirely, so anyone
# running `pnpm run ci` locally got a green result from a strictly weaker
# check), and CLAUDE.md described a fourth version in prose. Nothing detected
# the disagreement, because each one passed on its own terms.
#
# Now ci.yml runs exactly one command: this script. Local and CI run the same
# program by construction rather than by two lists happening to match, and
# scripts/assert-ci-single-definition.sh fails the build if ci.yml ever grows a
# second gate step behind this one's back.
#
# Usage:
#   ./scripts/ci.sh              full gate (requires TEST_DATABASE_URL and
#                                REDIS_TEST_URL)
#   ./scripts/ci.sh --no-db      everything except the DB suites, deliberately
#   ./scripts/ci.sh --no-redis   everything except the Redis suite, deliberately
set -eu

cd "$(dirname "$0")/.."

RUN_DB=1
RUN_REDIS=1
while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-db) RUN_DB=0 ;;
    --no-redis) RUN_REDIS=0 ;;
    *) echo "ci.sh: unknown argument '$1' (expected --no-db and/or --no-redis)" >&2; exit 2 ;;
  esac
  shift
done

step() {
  echo ""
  echo "═══ $1 ═══"
}

# The DB suites are the ones that prove RLS and store/schema agreement, so
# skipping them is the single most valuable way to get a meaningless green.
# In CI that must be impossible; locally it must be deliberate, never implicit.
if [ -z "${TEST_DATABASE_URL:-}" ]; then
  if [ "${CI:-}" = "true" ]; then
    echo "ci.sh: TEST_DATABASE_URL is not set in CI." >&2
    echo "  The DB-gated suites would register as skips and the build would pass" >&2
    echo "  having proved nothing about RLS or store/schema drift. Fix the" >&2
    echo "  postgres service wiring in ci.yml; do not pass --no-db in CI." >&2
    exit 1
  fi
  if [ "$RUN_DB" = "1" ]; then
    echo "ci.sh: TEST_DATABASE_URL is not set." >&2
    echo "" >&2
    echo "  This machine has no local Postgres, so the DB-gated suites cannot run." >&2
    echo "  Re-run as './scripts/ci.sh --no-db' to acknowledge that the result is" >&2
    echo "  WEAKER than CI, or point TEST_DATABASE_URL at a scratch database." >&2
    echo "" >&2
    echo "  Refusing to skip silently: a silent skip here is exactly how a green" >&2
    echo "  local run stops meaning anything." >&2
    exit 1
  fi
fi

# Same reasoning as TEST_DATABASE_URL, applied to the other backend that has a
# success path only a real server can exercise. The Redis tests prove that a
# REACHABLE Redis produces no boot-time degradation alert and that the counter
# lands in Redis at the value the endpoint produced — neither of which any
# unreachable-Redis test can show. Allowing them to skip in CI would leave that
# success path permanently untested, which is the condition this work removed.
if [ -z "${REDIS_TEST_URL:-}" ]; then
  if [ "${CI:-}" = "true" ]; then
    echo "ci.sh: REDIS_TEST_URL is not set in CI." >&2
    echo "  The Redis-gated tests would register as skips and the build would" >&2
    echo "  pass having proved nothing about the reachable-Redis path. Fix the" >&2
    echo "  redis service wiring in ci.yml; do not pass --no-redis in CI." >&2
    exit 1
  fi
  if [ "$RUN_REDIS" = "1" ]; then
    echo "ci.sh: REDIS_TEST_URL is not set." >&2
    echo "" >&2
    echo "  This machine has no local Redis, so the reachable-Redis tests cannot" >&2
    echo "  run. Re-run as './scripts/ci.sh --no-redis' to acknowledge that the" >&2
    echo "  result is WEAKER than CI, or start one:" >&2
    echo "    docker run --rm -p 6379:6379 redis:7-alpine" >&2
    echo "    REDIS_TEST_URL=redis://127.0.0.1:6379 ./scripts/ci.sh" >&2
    echo "" >&2
    exit 1
  fi
fi

step "Structural: ci.yml defines no gate of its own"
./scripts/assert-ci-single-definition.sh

# The mobile Babel preset is declared by hand (AUDIT L19) rather than inherited,
# so it can silently fall out of step with the SDK. Cheap, and it runs before the
# slow gates because a drifted preset invalidates everything downstream of it.
step "Structural: mobile Babel preset matches the SDK"
node ./scripts/assert-babel-preset-expo.mjs

# The Privacy Policy and the Terms each exist in three copies: the canonical
# markdown in docs/legal/, a data module the mobile app renders, and a page on
# the marketing site. AUDIT A6 is what happens without this check — the copies
# had already drifted into different section orders, different retention claims
# and two different answers to whether the company was incorporated, and
# nothing anywhere reported the disagreement because each copy was internally
# consistent. Three copies is the cost of having the text in an app binary, in
# a static site, and in version control; silent drift between them is not.
#
# The comparison is a normalised word stream, so wrapping, indentation,
# punctuation, markup and TypeScript syntax are all invisible to it and only a
# change in the words themselves fails the build. The "Last updated" date is a
# word stream like any other, which is how one date stays one date.
legal_words() {
  # $1 file, $2 begin marker, $3 end marker. The markers must be matched as
  # whole lines: the phrase "BEGIN LEGAL TEXT" also appears in the canonical
  # files' own header prose, and a substring match starts the range there and
  # drags the header table into the comparison.
  sed -n "\|$2|,\|$3|p" "$1" \
    | sed -e '1d' -e '$d' \
    | sed -e 's/<[^>]*>/ /g' -e 's/&#\{0,1\}[a-z0-9]*;/ /g' -e 's/\\n/ /g' \
    | tr 'A-Z' 'a-z' \
    | tr -cs 'a-z0-9_' '\n' \
    | grep -vxE 'export|const|legaldocument|privacy_policy|terms_of_service|title|lastupdated|intro|sections|paragraphs' \
    | sed -e '/^$/d'
}

MD_BEGIN='^<!-- BEGIN LEGAL TEXT -->$'
MD_END='^<!-- END LEGAL TEXT -->$'
TS_BEGIN='^// BEGIN LEGAL TEXT$'
TS_END='^// END LEGAL TEXT$'

assert_legal_copies() {
  canon="../docs/legal/$1.md"
  mobile="apps/mobile/constants/legal/$1-content.ts"
  site="../website/$2/index.html"
  tmp="$(mktemp -d)"

  legal_words "$canon" "$MD_BEGIN" "$MD_END" > "$tmp/canon"

  # A renamed or deleted marker makes an extraction empty, and two empty word
  # streams compare equal — the check would pass having read nothing. Refuse a
  # canonical body that is implausibly short before trusting any comparison
  # against it.
  words="$(wc -l < "$tmp/canon" | tr -d ' ')"
  if [ "$words" -lt 400 ]; then
    echo "ci.sh: extracted only $words words from $canon (expected >400)." >&2
    echo "  Either the document was gutted or the BEGIN/END LEGAL TEXT markers" >&2
    echo "  moved. Not comparing anything against it." >&2
    rm -rf "$tmp"; exit 1
  fi

  legal_words "$mobile" "$TS_BEGIN" "$TS_END" > "$tmp/mobile"
  legal_words "$site" "$MD_BEGIN" "$MD_END" > "$tmp/site"

  failed=0
  for target in mobile site; do
    if ! diff -u "$tmp/canon" "$tmp/$target" > "$tmp/$target.diff"; then
      eval "path=\$$target"
      echo "ci.sh: $path has drifted from $canon." >&2
      sed -n '3,40p' "$tmp/$target.diff" >&2
      failed=1
    fi
  done
  rm -rf "$tmp"
  [ "$failed" = "0" ] || exit 1
  echo "  $1: $words words, both copies match."
}

# ── The census: how many copies there are, not just whether the known ones agree
#
# `assert_legal_copies` above compares THREE copies per document, because three
# is what somebody enumerated. The portal was carrying a fourth of each at
# `app/privacy/page.tsx` and `app/terms/page.tsx` the entire time this check was
# green, and they had drifted: the portal's privacy page claimed compliance with
# the Information Privacy Principles and the Australian Privacy Principles — a
# sentence in no other copy — and its Terms had "Acceptable Use" and
# "Limitation of Liability" sections the canonical document does not contain.
# The check reported nothing, correctly, because it was never told they existed.
# That is AUDIT L36: a check proves only what it enumerates.
#
# Those two are now 307 redirects to the marketing site (see the supervisor-web
# `next.config.mjs`), so there are six copies. This step asserts that there are
# six and names them — so a seventh appearing fails the build on the commit
# that adds it, instead of waiting for someone to notice. Adding a legitimate
# new copy means adding its path here AND to `assert_legal_copies`, which is
# the intended friction.
#
# WHAT THIS DOES NOT PROVE — and the first item is the uncomfortable one, said
# plainly here because the finding this closes is about checks that overstate
# themselves:
#
#   - IT WOULD NOT HAVE CAUGHT THE TWO PAGES THAT MOTIVATED IT. The portal's
#     privacy and terms pages were not copies of the canonical text, they were
#     independent rewrites: not one of the six marker phrases below appears in
#     either of them (checked against the deleted blobs, 4 October 2026 —
#     `git show HEAD:...app/privacy/page.tsx | grep -F <phrase>`, no match for
#     any of the three, same for terms). So this catches the ordinary way a
#     seventh copy appears — somebody pastes the canonical text, or one of the
#     existing copies, into a new file — and does not catch somebody writing
#     their own privacy policy from scratch.
#   - A check that WOULD catch a rewrite has to key on something weaker than
#     the words: the document's title, or a /privacy route. That was measured
#     and rejected. Fourteen tracked files contain the string "Privacy Policy"
#     and nine contain "Terms of Service"; nearly all are links, navigation
#     labels, route registrations and screen wrappers rather than copies. A
#     fourteen-entry allowlist gets appended to reflexively, which is L36's
#     failure mode with extra ceremony.
#   - So what actually prevents a seventh rewrite is not a check at all: it is
#     that there is no longer a page to copy the pattern from, and that both
#     routes are now 307s declared next to each other in one config block. The
#     removal is the structural fix; this step is a tripwire on the easy case.
#   - A paraphrase, a translation, a summary, a screenshot, a PDF, or text
#     fetched from a URL at runtime is invisible to it. Three phrases per
#     document rather than one, so a PARTIAL copy — somebody lifting the
#     retention section alone — is still caught.
#   - It sees tracked files only (`git grep`). A generated or gitignored copy is
#     out of scope, as is anything a build step emits.
#   - It proves the file count, not that each copy is correct. The word-stream
#     diff above proves that, and it runs only on enumerated copies — so the
#     two checks are each other's blind spot and both are needed.

PRIVACY_COPIES="docs/legal/privacy-policy.md
Projects/apps/mobile/constants/legal/privacy-policy-content.ts
website/privacy/index.html"

TERMS_COPIES="docs/legal/terms-of-service.md
Projects/apps/mobile/constants/legal/terms-of-service-content.ts
website/terms/index.html"

# Section headings from the canonical documents, chosen because they are
# unmistakable prose rather than legal boilerplate: a verbatim copy cannot omit
# all three, and no unrelated file has reason to contain any.
PRIVACY_PHRASES="Three kinds of people appear in SiteSnap
How long we keep things, and what deleting really does
Security, as it actually stands"

TERMS_PHRASES="The AI drafts, and what they are not
Your content is yours
What we do not promise"

assert_legal_copy_census() {
  label="$1"; expected_list="$2"; phrases="$3"

  # The census is a `git grep`, so a checkout without a git directory would
  # find nothing and compare it against the expected list. That fails rather
  # than passes, but say why.
  if ! git -C .. rev-parse --git-dir >/dev/null 2>&1; then
    echo "ci.sh: not a git checkout, so the $label copy census cannot run." >&2
    echo "  Refusing to report a pass on a check that read nothing." >&2
    exit 1
  fi

  tmp="$(mktemp -d)"
  printf '%s\n' "$expected_list" | sed '/^$/d' | sort > "$tmp/expected"
  : > "$tmp/found"
  # This script is excluded because it CONTAINS the marker phrases, by
  # necessity. Nothing else is excluded: a legal paragraph pasted into a doc, a
  # README or a component is a copy, and the point is to hear about it.
  printf '%s\n' "$phrases" | sed '/^$/d' | while IFS= read -r phrase; do
    git -C .. grep -l -F -e "$phrase" -- . ':(exclude)Projects/scripts/ci.sh' \
      >> "$tmp/found" 2>/dev/null || true
  done
  sort -u "$tmp/found" -o "$tmp/found"

  # Positive control. If every phrase had been reworded in the canonical
  # document, nothing would match and `found` would be empty; an empty found
  # against a non-empty expected does fail, but the message below would blame
  # the wrong thing. Name the real cause.
  if [ ! -s "$tmp/found" ]; then
    echo "ci.sh: none of the $label marker phrases matched any file." >&2
    echo "  The canonical document was almost certainly reworded. Update the" >&2
    echo "  phrases in this script in the same commit." >&2
    rm -rf "$tmp"; exit 1
  fi

  if ! diff -u "$tmp/expected" "$tmp/found" > "$tmp/diff"; then
    echo "ci.sh: the set of files carrying the $label text is not the set this" >&2
    echo "  script enumerates. A '+' line is a copy nobody told the drift check" >&2
    echo "  about; a '-' line is an enumerated copy that no longer holds the" >&2
    echo "  text." >&2
    sed -n '3,40p' "$tmp/diff" >&2
    rm -rf "$tmp"; exit 1
  fi
  count="$(wc -l < "$tmp/found" | tr -d ' ')"
  rm -rf "$tmp"
  echo "  $label: $count copies, exactly the ones enumerated."
}

step "Structural: the legal documents have not drifted from their source"
assert_legal_copies privacy-policy privacy
assert_legal_copies terms-of-service terms

step "Structural: no unenumerated copy of a legal document has appeared"
assert_legal_copy_census privacy-policy "$PRIVACY_COPIES" "$PRIVACY_PHRASES"
assert_legal_copy_census terms-of-service "$TERMS_COPIES" "$TERMS_PHRASES"

step "Build shared types"
# @sitesnap/shared emits .d.ts only; TypeScript project references in the API
# and both apps fail to resolve until this has run.
pnpm --filter ./shared run build:types

step "Lint"
pnpm run lint

step "Typecheck"
pnpm run typecheck

step "Tests (in-memory)"
# TEST_DATABASE_URL must be UNSET here even when we have one. Some stores are
# test-aware (projectsStore switches to the DB path whenever it is present),
# so leaking it into this run silently changes which code the suite exercises.
# REDIS_TEST_URL is unset here for the same reason: rate-limit-redis-live.test.ts
# promotes it to REDIS_URL, which would move the in-memory run's counters into
# Redis and change the skip count the runner pins.
env -u TEST_DATABASE_URL -u REDIS_TEST_URL pnpm run test

if [ "$RUN_REDIS" = "1" ]; then
  step "Tests (Redis — the reachable-Redis path)"
  pnpm --filter services-api run test:redis
fi

if [ "$RUN_DB" = "1" ]; then
  step "Tests (database — RLS + store round-trip)"
  pnpm --filter services-api run test:db
fi

if [ "$RUN_DB" = "0" ] || [ "$RUN_REDIS" = "0" ]; then
  echo ""
  echo "═══════════════════════════════════════════════════════════════════"
  echo " PARTIAL PASS — gates were deliberately skipped:"
  [ "$RUN_DB" = "0" ] && echo "   --no-db     RLS and store/schema drift are unproven."
  [ "$RUN_REDIS" = "0" ] && echo "   --no-redis  the reachable-Redis path is unproven."
  echo " This is NOT equivalent to CI."
  echo "═══════════════════════════════════════════════════════════════════"
  exit 0
fi

echo ""
echo "✅ ci.sh: full gate passed."
