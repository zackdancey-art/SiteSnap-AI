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

# rules-of-hooks is enforced through path-globbed `overrides` entries, every
# part of which can stop matching without anything failing — there are
# currently zero violations, so losing the rule costs zero errors. This proves
# the rule actually fires by making it fire.
step "Structural: rules-of-hooks is actually enforced on the React packages"
./scripts/assert-hooks-lint-active.sh

# `ubuntu-latest` starts migrating to Ubuntu 26.04 on 19 October 2026. Pinning
# the existing workflows was a hand sweep; this is what stops the next workflow
# floating again.
step "Structural: workflow runners are pinned and action majors are current"
./scripts/assert-workflow-runners-pinned.sh

# Two @types/react majors in the tree leave pnpm's hidden hoist slot with two
# eligible candidates, and the winner is picked per install rather than by the
# lockfile -- so the mobile typecheck passed here and failed on the runner. The
# override collapses it to one version; this proves it stayed collapsed. It runs
# before Typecheck because a flipped slot invalidates that result rather than
# failing it.
step "Structural: exactly one @types/react in the installed tree"
node ./scripts/assert-single-react-types.mjs

# `project_sites.status` is declared six times in three packages with nothing
# connecting any declaration to another, and the portal's two copies spelled
# On Hold `on_hold` against the API's `on-hold` for the life of the feature —
# three user-visible defects from one character, invisible to tsc because the
# portal types that field as `string`. The portal has no test runner, so this is
# the only thing that can hold the six in agreement. It now also compares the
# two clients' LABELS, which is what let a finished site read "Complete" on the
# portal and "Completed" on the phone.
step "Structural: the site/diary status vocabularies and labels agree across all packages"
node ./scripts/assert-site-status-vocabulary.mjs

# One sentence of policy — the supervisor dashboard is manager+ on every
# surface, invisible to crew — implemented twice, in two packages. They had
# already disagreed for the life of the portal: mobile manager+, portal viewer+.
# Mobile's half is a real test (lib/permissions.test.ts, all four roles both
# ways); the portal's half has nothing, because apps/supervisor-web has no test
# program, and reverting its predicate to viewer+ was measured to leave
# typecheck, lint and both other suites green.
step "Structural: both clients agree on who may see the supervisor dashboard"
node ./scripts/assert-dashboard-rank.mjs

# AUDIT L63. The exported diary/inspection PDF is the compliance evidence, and
# its templates carried their own undocumented 14-colour palette — five frozen
# copies of a design token, nine colours governed by nothing. The export values
# stay frozen on purpose (restyling the app must not restyle a signed document);
# this is what makes a token moving away from its twin loud instead of silent.
# The hex pattern is quote-independent: L63's own first measurement was wrong
# because it required the quote, and the export CSS writes `color:#6f8095`.
step "Structural: the export palette has not drifted, and no raw hex has returned"
node ./scripts/assert-export-palette.mjs

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

# ── Rules that exist twice, so prove each pair of copies agrees
#
# Two client rules are written out in both clients rather than imported from
# one module: site grouping and job numbers. They are not one module because
# @sitesnap/shared resolves `main`, `types` and every `exports` entry to a
# `.d.ts` file — it carries types and no runtime JavaScript — and making it
# emit JS is an install-resolution change belonging to docs/DECISIONS.md.
#
# Each pair's region between the markers is byte-identical by construction (the
# portal copy was generated from the mobile one). This diffs it, so editing one
# side alone fails the build naming both paths, instead of the phone and the
# portal quietly disagreeing about whether a site is filed, or about how long a
# job number may be.
#
# WHAT THIS DOES NOT PROVE: that either copy is correct. Tests prove that, and
# where those tests live differs per rule:
#
#   site-grouping  apps/mobile/lib/site-grouping.test.ts only, eight tests
#                  against the mobile copy. For this rule the diff is what
#                  carries that result across to the portal copy.
#   job-number     BOTH sides — apps/mobile/lib/job-number.test.ts and
#                  apps/supervisor-web/lib/job-number.test.ts, seven tests
#                  each. Two identical copies of a WRONG rule diff clean, so
#                  here the diff proves agreement and each package's own suite
#                  proves behaviour.
#
# An earlier version of this comment said the portal "has no test harness".
# That was false when written — apps/supervisor-web/scripts/run-tests.sh
# existed and was green — and the same false belief is what kept the portal's
# runner out of the AUDIT L110 and L115 sweeps, two real holes left open by a
# sentence in a comment. Corrected here rather than quietly deleted; the record
# is AUDIT L117.
#
# It also does not notice a THIRD copy appearing somewhere else — unlike the
# legal census, there is no marker phrase to grep for, and a function body is
# not prose.

# label|sentinel the marked region must contain|comma-separated paths
#
# The sentinel is what makes a renamed or deleted marker a failure instead of a
# vacuous pass: an extract missing its region is empty, and two empty extracts
# diff clean.
SHARED_LOGIC_GROUPS="site-grouping|export function groupSitesByClient|apps/mobile/lib/site-grouping.ts,apps/supervisor-web/lib/site-grouping.ts
job-number|export const JOB_NUMBER_MAX_LENGTH|apps/mobile/lib/job-number.ts,apps/supervisor-web/lib/job-number.ts"

# $1 label, $2 sentinel, $3 comma-separated paths
assert_shared_logic_copies() {
  label="$1"; sentinel="$2"; paths="$3"
  tmp="$(mktemp -d)"
  i=0
  prev=""
  prev_path=""
  # Deliberately a `for` over word-splitting rather than `while read`: a
  # `while` fed by a pipe runs in a subshell under sh, so its `exit 1` would
  # end the subshell and let this function return 0 — a check that reports a
  # pass after failing is worse than no check. The paths are repo-relative with
  # no spaces, which is what makes the splitting safe.
  for path in $(printf '%s\n' "$paths" | tr ',' '\n' | sed '/^$/d'); do
    if [ ! -f "$path" ]; then
      echo "ci.sh: $path is enumerated as a $label copy but does not exist." >&2
      echo "  Either it was renamed, or SHARED_LOGIC_GROUPS is stale. Fix both" >&2
      echo "  together." >&2
      rm -rf "$tmp"; exit 1
    fi
    i=$((i + 1))
    sed -n '/^\/\/ SHARED-LOGIC-BEGIN$/,/^\/\/ SHARED-LOGIC-END$/p' "$path" > "$tmp/r$i"
    # A marker that has been renamed or deleted extracts nothing, and an empty
    # file diffs clean against another empty file — exactly the vacuous pass
    # this script exists to refuse. So require the region to be present AND to
    # contain the declaration it is meant to be guarding.
    if ! grep -q "$sentinel" "$tmp/r$i"; then
      echo "ci.sh: $path has no SHARED-LOGIC region containing '$sentinel'." >&2
      echo "  The markers are '// SHARED-LOGIC-BEGIN' and '// SHARED-LOGIC-END'," >&2
      echo "  each alone on its line. Refusing to compare two empty extracts." >&2
      rm -rf "$tmp"; exit 1
    fi
    if [ -n "$prev" ] && ! diff -u "$prev" "$tmp/r$i" > "$tmp/d$i"; then
      echo "ci.sh: the $label rule has drifted between its copies." >&2
      echo "  $prev_path" >&2
      echo "  $path" >&2
      echo "  The marked region must be byte-identical in both. Apply the" >&2
      echo "  change to both files in the same commit." >&2
      sed -n '3,60p' "$tmp/d$i" >&2
      rm -rf "$tmp"; exit 1
    fi
    prev="$tmp/r$i"; prev_path="$path"
  done
  # The count is measured from what was actually compared, not written down. A
  # list trimmed to one entry would otherwise sail through: one file, no diff.
  if [ "$i" -lt 2 ]; then
    echo "ci.sh: only $i $label copy was examined, so nothing was compared." >&2
    echo "  Every SHARED_LOGIC_GROUPS entry must list at least two paths." >&2
    rm -rf "$tmp"; exit 1
  fi
  rm -rf "$tmp"
  echo "  $label: $i copies, marked regions byte-identical."
}

assert_all_shared_logic_copies() {
  groups=0
  # The same `for` rather than `while read`, for the same reason as above: an
  # `exit 1` from inside a piped `while` would only end its subshell. The
  # entries hold no spaces, which is what makes the line-splitting safe.
  OLD_IFS=$IFS
  IFS='
'
  # shellcheck disable=SC2086
  set -- $SHARED_LOGIC_GROUPS
  IFS=$OLD_IFS
  for entry in "$@"; do
    [ -n "$entry" ] || continue
    groups=$((groups + 1))
    assert_shared_logic_copies \
      "$(printf '%s' "$entry" | cut -d'|' -f1)" \
      "$(printf '%s' "$entry" | cut -d'|' -f2)" \
      "$(printf '%s' "$entry" | cut -d'|' -f3)"
  done
  # An equality, not a floor (AUDIT L112). Two groups are enumerated above; a
  # list emptied or truncated to one by an edit would otherwise pass having
  # checked less than it claims, and the per-group `$i -lt 2` guard cannot see
  # a group that is no longer there at all.
  if [ "$groups" -ne 2 ]; then
    echo "ci.sh: examined $groups shared-logic group(s), expected 2." >&2
    echo "  If you added or removed a duplicated client rule, change this" >&2
    echo "  number in the same commit as SHARED_LOGIC_GROUPS." >&2
    exit 1
  fi
  echo "  shared-logic: $groups group(s), every copy in agreement."
}

step "Structural: no duplicated client rule has drifted between its copies"
assert_all_shared_logic_copies

# ── The job-number cap is stated on three tiers, so prove the three agree
#
# The number appears in:
#
#   services/api/src/routes/projects.ts    the cap z.string().trim().max()
#                                          REFUSES with a 400
#   apps/mobile/lib/job-number.ts          the `maxLength` the input gets
#   apps/supervisor-web/lib/job-number.ts  the same, in the portal twin
#
# The two client copies are already proved equal by the shared-logic diff above
# — the declaration is inside their marked region, which is why the sentinel
# for that group is this very constant. This step is the one the diff cannot
# do: comparing them against the SERVER's literal, which lives in another
# package and is duplicated nowhere.
#
# WHY IT IS WORTH A CHECK. A cap that disagrees across tiers is invisible until
# somebody types a long job number: the form accepts up to the client's number,
# the save is refused by the server's, and the only symptom is "it won't save"
# with a message naming a limit the input did not enforce. Nothing in
# typecheck, lint or either test suite can see across the two packages.
#
# The comparands are DERIVED by reading each file (AUDIT L112), so this step
# has no number of its own to go stale — only the population of files does, and
# that is pinned by an equality below.

JOB_NUMBER_CAP_FILES="services/api/src/routes/projects.ts
apps/mobile/lib/job-number.ts
apps/supervisor-web/lib/job-number.ts"

assert_job_number_cap_agrees() {
  first=""
  first_path=""
  i=0
  for path in $(printf '%s\n' "$JOB_NUMBER_CAP_FILES" | sed '/^$/d'); do
    if [ ! -f "$path" ]; then
      echo "ci.sh: $path is enumerated as stating the job-number cap but does" >&2
      echo "  not exist. Either it was renamed, or JOB_NUMBER_CAP_FILES is" >&2
      echo "  stale. Fix both together." >&2
      exit 1
    fi
    i=$((i + 1))
    # Exactly one declaration per file. `sed` would silently take the last of
    # several, so count first: zero means it was renamed or the cap moved, and
    # more than one means this check cannot say which is authoritative.
    # `\(export \)*` and not `\(export \)\?`: BSD sed has no `\?`, so the
    # optional-group spelling GNU accepts made this sed match nothing on
    # macOS while the grep above still counted 1 -- the two patterns
    # disagreeing, which is the one failure mode this function can report
    # but not fix for itself. `*` is portable BRE in both sed and grep, and
    # the probe below was run under /bin/sh AND dash to prove it.
    found="$(grep -c '^\(export \)*const JOB_NUMBER_MAX_LENGTH = [0-9]\{1,\};$' "$path" || true)"
    if [ "$found" != "1" ]; then
      echo "ci.sh: $path declares JOB_NUMBER_MAX_LENGTH $found time(s), expected 1." >&2
      echo "  It must read 'const JOB_NUMBER_MAX_LENGTH = <n>;' on one line," >&2
      echo "  optionally exported, so that all three tiers can be compared." >&2
      exit 1
    fi
    value="$(sed -n 's/^\(export \)*const JOB_NUMBER_MAX_LENGTH = \([0-9]\{1,\}\);$/\2/p' "$path")"
    if [ -z "$value" ]; then
      echo "ci.sh: counted a JOB_NUMBER_MAX_LENGTH declaration in $path but" >&2
      echo "  could not read its value. The grep and the sed above disagree;" >&2
      echo "  fix the pattern rather than dropping the check." >&2
      exit 1
    fi
    if [ -z "$first" ]; then
      first="$value"; first_path="$path"
    elif [ "$value" != "$first" ]; then
      echo "ci.sh: the job-number cap disagrees across tiers." >&2
      echo "  $first_path: $first" >&2
      echo "  $path: $value" >&2
      echo "  A client cap above the server's lets a form accept what the save" >&2
      echo "  then refuses; below it, the form refuses what the server would" >&2
      echo "  have taken. Change all three in the same commit." >&2
      exit 1
    fi
  done
  # An equality on the population, not a floor (AUDIT L112). Three tiers state
  # this number; a list trimmed to one would otherwise pass having compared
  # nothing against anything.
  if [ "$i" -ne 3 ]; then
    echo "ci.sh: examined $i file(s) for the job-number cap, expected 3." >&2
    echo "  JOB_NUMBER_CAP_FILES must list the API's and both clients'." >&2
    exit 1
  fi
  echo "  job-number cap: $i tiers, all stating $first."
}

step "Structural: the job-number cap agrees across the API and both clients"
assert_job_number_cap_agrees

# ── The portal's version constant
#
# The portal has no copy of either document — the fourth copies it used to carry
# were removed, which is what closed A6 — so it links to the hosted pages and
# states the version it is linking to in one constant file. That constant is
# sent with a portal signup and written into the consent ledger, so a stale
# string there means a legal record naming text the person was never shown.
#
# This reads the `Last updated:` line OUT OF the canonical markdown and compares
# it. Nothing here is typed twice: the expected value is whatever the document
# says today.
#
# Why this is a separate check rather than a fourth entry in PRIVACY_COPIES:
# the constant is not a copy of the document, it is a copy of one LINE of it,
# and `assert_legal_copies` compares whole word streams — enumerating it there
# would fail on every one of the other four hundred words. The census is also
# unaffected, because the constant carries none of the marker phrases: a file
# holding a date is not a copy of a legal document, and should not be reported
# as one.
PORTAL_LEGAL_VERSIONS="apps/supervisor-web/lib/legal-versions.ts"

assert_legal_version_constant() {
  doc="$1"; constant="$2"
  canon="../docs/legal/$doc.md"

  # Anchored, so the header prose that mentions the `Last updated` line in
  # passing is not mistaken for the line itself.
  line="$(sed -n '/^Last updated: /p' "$canon" | head -1)"
  if [ -z "$line" ]; then
    echo "ci.sh: no 'Last updated:' line found in $canon." >&2
    echo "  Either the document lost it or its wording changed. This check" >&2
    echo "  compares against that line, so it will not report a pass having" >&2
    echo "  read nothing." >&2
    exit 1
  fi

  actual="$(grep -E "^export const $constant" "$PORTAL_LEGAL_VERSIONS" | head -1)"
  if [ -z "$actual" ]; then
    echo "ci.sh: $PORTAL_LEGAL_VERSIONS does not export $constant." >&2
    echo "  The portal signup sends it; without it the consent record would" >&2
    echo "  name no version." >&2
    exit 1
  fi

  case "$actual" in
    *"$line"*) ;;
    *)
      echo "ci.sh: $constant does not match $canon." >&2
      echo "  canonical: $line" >&2
      echo "  constant:  $actual" >&2
      echo "  A portal signup would record a version the person was not shown." >&2
      exit 1
      ;;
  esac
  echo "  $doc: the portal constant says '$line', which is what the document says."
}

step "Structural: the legal documents have not drifted from their source"
assert_legal_copies privacy-policy privacy
assert_legal_copies terms-of-service terms

step "Structural: no unenumerated copy of a legal document has appeared"
assert_legal_copy_census privacy-policy "$PRIVACY_COPIES" "$PRIVACY_PHRASES"
assert_legal_copy_census terms-of-service "$TERMS_COPIES" "$TERMS_PHRASES"

step "Structural: the portal's legal version constant matches the documents"
assert_legal_version_constant terms-of-service TERMS_VERSION
assert_legal_version_constant privacy-policy PRIVACY_VERSION

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
