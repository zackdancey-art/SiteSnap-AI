#!/usr/bin/env python3
"""Assert docs/DEBT-TRIAGE.md has a row for every open finding it is responsible for.

Workstream 8's spec is "everything open in docs/AUDIT.md not covered by
workstreams 1-7, and everything docs/HALF-BUILT-MECHANISMS.md turned up".
That is a measurable claim, so it is measured here rather than asserted in
prose. The first version of the triage derived its population with a hand
sweep for "open in prose" findings and missed L51, whose open half sits inside
a Disposition label rather than in unlabelled prose -- the same class of error
as a hand-written pinned count.

Run:  python3 Projects/scripts/assert-triage-covers-open-findings.py
Exit: 0 when every open, uncovered finding has exactly one row; 1 otherwise.

Deliberately NOT wired into Projects/scripts/ci.sh. Wiring it in would fail the
build the moment a new audit finding lands without a triage row, which is a new
gate nobody asked for; the owner decides whether to turn it on.
"""
import os, re, subprocess, sys

ROOT = subprocess.run(["git", "rev-parse", "--show-toplevel"],
                      capture_output=True, text=True, check=True).stdout.strip()

AUDIT = os.path.join(ROOT, "docs", "AUDIT.md")
TRIAGE = os.path.join(ROOT, "docs", "DEBT-TRIAGE.md")

# docs/HALF-BUILT-MECHANISMS.md is not on main -- it lives on the branch that
# recorded it. Read it from there by ref rather than assuming a working copy.
HALF_BUILT_REF = "origin/docs/half-built-mechanisms-audit"
HALF_BUILT_PATH = "docs/HALF-BUILT-MECHANISMS.md"

# The branches that are workstreams 0-7. A finding these fix is "covered" and so
# is outside this document's population. Coverage is measured from the commit
# messages on each branch, which is why every commit there names its finding IDs.
WORKSTREAM_REFS = [
    "origin/fix/workstream-0-safety",
    "origin/feat/clients-sites-entries",
    "origin/feat/timesheets-approval",
    "origin/feat/whs-checklists",
    "origin/feat/storage-ceiling",
    "origin/feat/report-periods",
    "origin/feat/photo-viewer",
    "origin/feat/bin-retention",
    "origin/feat/consent-and-native",
]

# Findings outside the population, each with the measurement that puts it there.
# A finding is listed here only when a command settles it -- "closed on a merged
# branch", "the literal the finding names is gone". Prose that reads closed is
# not enough: L45, L50 and L51 all read as "Fixed" in their first clause and all
# three have an open second clause, which is how they came to be missing rows.
ADJUDICATED = {
    # Not defects.
    "L29": "reserved placeholder, deliberately unused; no finding behind it",
    "L84": "a DECISION record -- its own first line is 'Not a defect'",
    "L25": "Disposition: no code change; adopted as a convention for dispositions",
    # Closed in main's own history, by measurement.
    "H8":  "title records FIXED in X1; locationStore in-memory branch filters companyId",
    "M7":  "d9235e8 added /health/ready; routes/health.ts:45,74 SELECT COUNT(*) FROM schema_migrations",
    "L2":  "d9235e8: portal lib/api.ts:2 and mobile api-base-url.ts:45 both default to 4000",
    # Closed on branches that are merged into main (git merge-base --is-ancestor).
    "L66": "second disposition closed on feat/crew-permissions, merged into main",
    "L102": "FIXED on feat/sessions-and-tokens, merged into main",
    "L87": "fixed on feat/crew-permissions (merged); canAccessRow and its site_members hatch are gone",
    "L88": "resolved on feat/crew-permissions (merged); RECORD_CLASS shared-site-attribute",
    "L89": "fixed on feat/crew-permissions (merged); both paths append editOwnershipSql",
    "L90": "fixed on feat/crew-permissions (merged); readVisibility returns own-rows for crew",
    # Covered by workstreams 1-7, so outside THIS document's population by the spec's
    # own wording. Measured from commit messages, same as the branch sweep below.
    "L6":  "workstream 3, feat/storage-ceiling: photo-payload-store cap",
    "L92": "workstream 4, feat/report-periods: anchoredWindow and an explicit range",
    "L93": "workstream 4, feat/report-periods: photographs spread across the window",
    "L94": "workstream 4, feat/report-periods: counts reconciled",
    "L95": "workstream 4, feat/report-periods: the five silent returns are named",
    "L96": "workstream 4, feat/report-periods: the author is in the payload",
    "L97": "workstream 4, feat/report-periods: the five dropped fields are in the payload",
    "L98": "workstream 4, feat/report-periods: the range goes into the WHERE clause",
}

# Two IDs that name one mechanism get one row. Keyed by the ID that may be
# absent, valued by the ID whose row covers it.
ALIASES = {"F1": "L60", "F9": "L91"}

# A status signal is a bolded label (**Disposition:** ...) or a bolded verdict
# phrase standing alone (**Not fixed.**). The colon lives INSIDE the bold in
# this document -- "**Disposition:**" -- so the closing ** cannot be required
# immediately after the word. Getting that wrong reported 121 unlabelled
# findings out of 121, which is how the pattern came to be written this way.
LABEL = re.compile(r"\*\*\s*(?:Status|Disposition|Resolution|Verdict)\s*:?\s*\*\*(.{0,400})",
                   re.S | re.I)
BOLD = re.compile(r"\*\*([^*]{1,120}?)\*\*")

OPEN_WORDS = re.compile(
    r"\b(not fixed|unfixed|still open|open as|is open|remains open|remain open|deferred|"
    r"partial|partially|still owed|not scheduled|unresolved|queued|awaiting|not yet|"
    r"outstanding|half (?:remains|is open)|not closed)\b", re.I)
CLOSED_WORDS = re.compile(
    r"\b(fixed|closed|resolved|done|no action|not worth|won'?t fix|wontfix|"
    r"superseded|withdrawn|invalid|n/?a)\b", re.I)


def sections(text, heading_re):
    """Yield (id, body) for each finding heading, body running to the next one."""
    hits = list(heading_re.finditer(text))
    for i, m in enumerate(hits):
        end = hits[i + 1].start() if i + 1 < len(hits) else len(text)
        yield m.group(1), text[m.start():end]


def classify(body):
    """OPEN / CLOSED / UNKNOWN from every status signal in the section.

    Any open signal anywhere makes the finding OPEN even when a closed signal
    sits beside it: that is the L51 shape -- "Fixed for the nine layout defects
    above. Tap-target sizing is open" -- and treating it as closed is the bug
    this script exists to catch.
    """
    signals = [m.group(1) for m in LABEL.finditer(body)]
    for m in BOLD.finditer(body):
        phrase = m.group(1)
        if OPEN_WORDS.search(phrase) or CLOSED_WORDS.search(phrase):
            signals.append(phrase)
    if not signals:
        return "UNKNOWN"
    blob = " ".join(signals)
    if OPEN_WORDS.search(blob):
        return "OPEN"
    if CLOSED_WORDS.search(blob):
        return "CLOSED"
    return "UNKNOWN"


def git_show(ref_path):
    r = subprocess.run(["git", "-C", ROOT, "show", ref_path],
                       capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def covered_by_workstreams():
    """IDs named by a commit on any workstream 0-7 branch."""
    out = {}
    for ref in WORKSTREAM_REFS:
        if subprocess.run(["git", "-C", ROOT, "rev-parse", "--verify", "-q", ref],
                          capture_output=True).returncode != 0:
            print(f"  note: {ref} not present, skipped")
            continue
        msgs = subprocess.run(
            ["git", "-C", ROOT, "log", "--format=%B", f"origin/main..{ref}"],
            capture_output=True, text=True, check=True).stdout
        for fid in set(re.findall(r"\b([CHLMFX]\d{1,3}[a-z]?)\b", msgs)):
            out.setdefault(fid, []).append(ref.replace("origin/", ""))
    return out


def main():
    audit = open(AUDIT).read()
    triage = open(TRIAGE).read()
    half = git_show(f"{HALF_BUILT_REF}:{HALF_BUILT_PATH}")

    audit_secs = dict(sections(audit, re.compile(r"^### ([CHLMFX]\d{1,3}[a-z]?)\b", re.M)))
    half_secs = dict(sections(half, re.compile(r"^#{2,4} (F\d{1,3})\b", re.M))) if half else {}

    print(f"audit findings:      {len(audit_secs)}")
    print(f"half-built findings: {len(half_secs)}"
          + ("" if half else f"  (ref {HALF_BUILT_REF} unavailable)"))

    states = {fid: classify(body) for fid, body in audit_secs.items()}
    # Every half-built finding is in the population by the spec's own wording
    # ("everything docs/HALF-BUILT-MECHANISMS.md turned up"), so they are OPEN
    # regardless of what their own section says.
    for fid in half_secs:
        states.setdefault(fid, "OPEN")
        if states[fid] == "UNKNOWN":
            states[fid] = "OPEN"

    tally = {}
    for s in states.values():
        tally[s] = tally.get(s, 0) + 1
    print("by status:           " + "  ".join(f"{k}={v}" for k, v in sorted(tally.items())))

    covered = covered_by_workstreams()

    stale = sorted(set(ADJUDICATED) - set(states))
    if stale:
        print(f"\nADJUDICATED names {len(stale)} finding(s) that no longer exist: "
              + " ".join(stale))

    population = sorted(fid for fid, s in states.items()
                        if s == "OPEN" and fid not in covered and fid not in ADJUDICATED)
    print(f"\nopen:                {sum(1 for s in states.values() if s == 'OPEN')}")
    print(f"of those, covered by workstreams 0-7: "
          f"{sum(1 for fid, s in states.items() if s == 'OPEN' and fid in covered)}")
    print(f"population (open, uncovered):         {len(population)}")

    # "Has a row" means an ID in the FIRST CELL of a table row -- not an ID
    # mentioned anywhere in the file. Counting every backticked ID was the first
    # version of this, and it over-counted by two because this document discusses
    # findings in its prose; worse, it would have let a finding merely *named* in
    # a paragraph satisfy the check and hide a real gap. That is the same vacuity
    # this script exists to refuse.
    rowed = set()
    for line in triage.splitlines():
        if not line.startswith("|"):
            continue
        first = line.split("|")[1] if line.count("|") >= 2 else ""
        rowed |= set(re.findall(r"[`*]{1,2}([CHLMFX]\d{1,3}[a-z]?)[`*]{1,2}", first))
    for fid, alias in ALIASES.items():
        if alias in rowed:
            rowed.add(fid)

    # Every bucket heading states its own row count. Those are pinned counts, so
    # they are measured here rather than trusted: a heading reading "- 14" over a
    # table of 15 rows is EXPECTED_WRITE_STEPS = 13 against a sequence of 14.
    bucket_ok = True
    for head in ("## 1. Fixed here",
                 "### Blocked on a decision that is not mine",
                 "### Blocked on work with a named precondition",
                 "### Portal and mobile work with no blocker but no caller yet",
                 "## 3. Not worth doing, with the reason"):
        i = triage.find(head)
        if i < 0:
            print(f"  bucket heading not found: {head}")
            bucket_ok = False
            continue
        m = re.search(r"\u2014 (\d+)", triage[i:i + 140])
        stated = int(m.group(1)) if m else -1
        n = 0
        for ln in triage[i:].split("\n")[1:]:
            if ln.startswith("|"):
                if re.search(r"[`*]{1,2}[CHLMFX]\d", ln.split("|")[1]):
                    n += 1
            elif n and ln.strip() == "":
                break
        if stated != n:
            print(f"  BUCKET MISMATCH: '{head}' states {stated}, has {n} rows")
            bucket_ok = False
    print(f"bucket headings:     {'all match their row counts' if bucket_ok else 'MISMATCH, see above'}")

    missing = [fid for fid in population if fid not in rowed]
    unknown = sorted(fid for fid, st in states.items() if st == "UNKNOWN")

    print(f"IDs in a table row:  {len(rowed)}")
    if unknown:
        print(f"\nno status signal ({len(unknown)}) -- outside the population, "
              f"listed so the omission is visible, not silent:")
        print("  " + " ".join(unknown))

    # The residual risk: no status signal AND no row. A finding here is either a
    # Phase-1 fix whose section never got a label, or an open finding nobody has
    # triaged -- and the two are indistinguishable without reading it. Printed so
    # that distinction is made by a person once, not assumed by a script.
    unknown_unrowed = [fid for fid in unknown
                       if fid not in rowed and fid not in covered and fid not in ADJUDICATED]
    # This is a HARD failure, not a notice. A finding leaves this document by
    # exactly three doors: it gets a row, it is covered by a workstream, or it is
    # named in ADJUDICATED with the measurement that closes it. "Its section has
    # no status label" is not a door -- treating it as one is what hid eighteen
    # open findings, H2's data-loss path among them, behind a green VERDICT: PASS.
    if unknown_unrowed:
        print(f"\nNO SIGNAL AND NO ROW ({len(unknown_unrowed)}) -- each needs a row,"
              f" a workstream, or an ADJUDICATED entry with its measurement:")
        print("  " + " ".join(unknown_unrowed))

    print("\nMISSING (open, uncovered, no row):")
    print("  " + (" ".join(missing) if missing else "(none)"))

    for fid in missing:
        reason = [m.group(1).strip().split("\n")[0][:90]
                  for m in LABEL.finditer(audit_secs.get(fid, ""))]
        print(f"    {fid}: {reason[0] if reason else '(verdict in prose)'}")

    print(f"\nadjudicated out of the population: {len(ADJUDICATED)} "
          f"(each with its measurement, see ADJUDICATED above)")
    fail = []
    if unknown_unrowed:
        fail.append(f"{len(unknown_unrowed)} finding(s) with no status signal and no row")
    if missing:
        fail.append(f"{len(missing)} open finding(s) unrowed")
    if not bucket_ok:
        fail.append("a bucket heading disagrees with its row count")
    print("\nVERDICT: " + ("PASS" if not fail else "FAIL -- " + "; ".join(fail)))
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
