"""The self-improve workflow's gate: decides, without trusting the agent, whether a proposed change may be offered.

  python -I pipeline/improve_gate.py scope BASE_REF [--also PATH]...
                                                             # exit 1 when a change falls outside what may be edited
                                                             # (--also: one more file the caller may change)
  python -I pipeline/improve_gate.py census BEFORE AFTER [BEFORE_PREV AFTER_PREV]
                                                             # Markdown before/after table; exit 1 unless it improved
  python -I pipeline/improve_gate.py selftest

What may change: the rules (app/public/data/rules.json), the engine (app/src/engine/*.ts) and the golden tests, which
may gain cases but never lose or alter a line (they pin answers already known to be right). One exception, so a
legal date change (an exclusion extended, a measure postponed) can go live with no person: an existing test line may
change when only its dates change (every expected amount, code and word stays the same) and each new full date it
uses is a date the same change adds to the rules or the engine. Never the Census
validation, this gate, the workflows or the other data, so the measuring stick cannot move.

Census improvement: on the newest month the unexplained (MISMATCH) share falls or the exact-match share rises by at
least MIN_GAIN points of sampled value, with neither getting worse; on the month before, neither may slip by more than
NOISE. A change that only helps the month it was tuned on is not an improvement.
"""
import json
import re
import subprocess
import sys

MIN_GAIN = 0.10   # points of sampled value
NOISE = 0.10      # allowed slip on the month before (rounding, sampling)

ALLOWED = [
    re.compile(r"^app/public/data/rules\.json$"),
    re.compile(r"^app/src/engine/[\w.-]+\.ts$"),
]
TESTS = re.compile(r"^app/src/(engine/)?[\w.-]+\.test\.ts$")
_MON = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*"
DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b|\b\d{2}-\d{2}\b|\b\d{1,2} " + _MON + r" \d{4}\b|\b" + _MON + r" \d{1,2}, \d{4}\b")
ISO = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")


def date_only_problems(path, hunks, source_dates):
    """hunks: [(removed lines, added lines)] of one existing test file. -> reasons the edits are more than date moves."""
    bad = []
    for removed, added in hunks:
        if not removed:
            continue
        if len(removed) != len(added):
            bad.append(f"{path}: existing golden test lines changed or removed ({len(removed)} out, {len(added)} in)")
            continue
        for old, new in zip(removed, added, strict=True):
            if DATE.sub("D", old) != DATE.sub("D", new):
                bad.append(f"{path}: existing test line changed beyond its dates: {old.strip()[:100]}")
                continue
            missing = sorted(set(ISO.findall(new)) - set(ISO.findall(old)) - source_dates)
            if missing:
                bad.append(f"{path}: test moved to {', '.join(missing)}, a date the rules/engine change does not add")
    return bad


def git(*a):
    return subprocess.run(["git", *a], capture_output=True, text=True, check=True).stdout


def scope_problems(changes, also=(), test_hunks=None, source_dates=frozenset()):
    """changes: [(status, path, added, deleted)] -> list of reasons the change set may not be offered.
    test_hunks: {test path: [(removed, added)]} for date-only edits; source_dates: full dates added to rules/engine."""
    bad = []
    for status, path, _added, deleted in changes:
        if TESTS.match(path):
            if status != "D" and deleted and test_hunks is not None and path in test_hunks:
                bad += date_only_problems(path, test_hunks[path], source_dates)
            elif status == "D" or deleted:
                bad.append(f"{path}: existing golden tests may not be changed or removed ({deleted} line(s) taken out)")
        elif path in also and status != "D":
            continue
        elif not any(p.match(path) for p in ALLOWED):
            bad.append(f"{path}: outside what the improve step may edit")
        elif status == "D":
            bad.append(f"{path}: deleted")
    return bad


def changes_since(base):
    status = {}
    for line in git("diff", "--name-status", "--no-renames", base).splitlines():
        s, p = line.split("\t", 1)
        status[p] = s[0]
    for line in git("ls-files", "--others", "--exclude-standard").splitlines():
        status[line] = "A"
    num = {}
    for line in git("diff", "--numstat", "--no-renames", base).splitlines():
        a, d, p = line.split("\t", 2)
        num[p] = (int(a) if a != "-" else 0, int(d) if d != "-" else 0)
    return [(s, p, *num.get(p, (0, 0))) for p, s in sorted(status.items())]


def hunks_since(base, path):
    hunks, cur = [], None
    for line in git("diff", "-U0", "--no-renames", base, "--", path).splitlines():
        if line.startswith("@@"):
            cur = ([], [])
            hunks.append(cur)
        elif cur is not None and line.startswith("-") and not line.startswith("---"):
            cur[0].append(line[1:])
        elif cur is not None and line.startswith("+") and not line.startswith("+++"):
            cur[1].append(line[1:])
    return hunks


def dates_added_since(base, paths):
    """Full dates that appear in the new rules/engine but not the old: the dates this change brings in."""
    def all_dates(ref, p):
        try:
            return set(ISO.findall(git("show", f"{ref}:{p}") if ref else open(p, encoding="utf-8").read()))
        except (subprocess.CalledProcessError, OSError):
            return set()
    out = set()
    for p in paths:
        out |= all_dates(None, p) - all_dates(base, p)
    return out


def shares(path):
    s = json.loads(open(path, encoding="utf-8").read())
    return {"month": s["month"], "match": float(s["share"].get("MATCH", 0.0)), "mismatch": float(s["share"].get("MISMATCH", 0.0))}


def census_verdict(b, a, bp=None, ap=None):
    """-> (ok, reasons, markdown table)"""
    rows = [("exact match", "match", +1), ("unexplained", "mismatch", -1)]
    gain = max(a["match"] - b["match"], b["mismatch"] - a["mismatch"])
    reasons = []
    if gain < MIN_GAIN:
        reasons.append(f"{b['month']}: gain {gain:.2f} points, below the {MIN_GAIN} needed")
    for label, k, sign in rows:
        if (a[k] - b[k]) * sign < -0.005:
            reasons.append(f"{b['month']}: {label} got worse ({b[k]}% to {a[k]}%)")
    if bp and ap:
        for label, k, sign in rows:
            if (ap[k] - bp[k]) * sign < -NOISE:
                reasons.append(f"{bp['month']} (the month before): {label} slipped ({bp[k]}% to {ap[k]}%)")
    md = ["| Census month | result | before | after | change |", "|---|---|---|---|---|"]
    for bb, aa in [(b, a)] + ([(bp, ap)] if bp and ap else []):
        for label, k, _ in rows:
            md.append(f"| {bb['month']} | {label} | {bb[k]:.2f}% | {aa[k]:.2f}% | {aa[k] - bb[k]:+.2f} |")
    return not reasons, reasons, "\n".join(md)


def selftest():
    ok = lambda c: not scope_problems(c)  # noqa: E731
    assert ok([("M", "app/public/data/rules.json", 3, 3), ("M", "app/src/engine/calc.ts", 5, 1), ("A", "app/src/engine/new.test.ts", 20, 0)])
    assert ok([("M", "app/src/engine/calc.test.ts", 12, 0)])                         # cases added
    assert not ok([("M", "app/src/engine/calc.test.ts", 1, 1)])                      # an expectation changed
    t = [("M", "app/public/data/rules.json", 1, 1), ("M", "app/src/engine/audit.test.ts", 1, 1)]
    moved = {"app/src/engine/audit.test.ts": [(["  run(x, { entryDate: '2026-11-10' }).duty).toBe(1500); // from 11-10"],
                                               ["  run(x, { entryDate: '2027-01-10' }).duty).toBe(1500); // from 01-10"])]}
    assert not scope_problems(t, test_hunks=moved, source_dates={"2027-01-10"})      # a legal date moved, nothing else
    assert scope_problems(t, test_hunks=moved, source_dates=set())                   # date not backed by the rules
    amount = {"app/src/engine/audit.test.ts": [(["  run(x).duty).toBe(1500);"], ["  run(x).duty).toBe(1600);"])]}
    assert scope_problems(t, test_hunks=amount, source_dates={"2027-01-10"})         # an expected amount changed
    both = {"app/src/engine/audit.test.ts": [(["  run(x, { entryDate: '2026-11-10' }).duty).toBe(1500);"],
                                              ["  run(x, { entryDate: '2027-01-10' }).duty).toBe(500);"])]}
    assert scope_problems(t, test_hunks=both, source_dates={"2027-01-10"})           # date and amount together
    gone = {"app/src/engine/audit.test.ts": [(["  it('a', () => {", "  });"], [])]}
    assert scope_problems(t, test_hunks=gone, source_dates=set())                    # a test removed
    assert not ok([("D", "app/src/search.test.ts", 0, 40)])
    assert not ok([("M", "app/scripts/validate_census.ts", 1, 1)])                   # the measuring stick
    assert not ok([("M", "pipeline/improve_gate.py", 1, 0)])
    assert not ok([("M", ".github/workflows/improve.yml", 1, 0)])
    assert not ok([("M", "app/public/data/search.json", 1, 0)])
    assert not scope_problems([("M", "pipeline/reviewed.json", 5, 0)], also=("pipeline/reviewed.json",))  # a review records itself
    assert scope_problems([("M", "pipeline/watch.py", 1, 0)], also=("pipeline/reviewed.json",))
    b, a = {"month": "2026-09", "match": 88.0, "mismatch": 1.0}, {"month": "2026-09", "match": 88.3, "mismatch": 0.8}
    bp, ap = {"month": "2026-08", "match": 87.8, "mismatch": 1.8}, {"month": "2026-08", "match": 87.75, "mismatch": 1.85}
    assert census_verdict(b, a, bp, ap)[0]                                            # better now, steady before
    assert not census_verdict(b, {**a, "match": 87.9}, bp, ap)[0]                     # traded match for mismatch
    assert not census_verdict(b, {**b, "match": 88.05}, bp, ap)[0]                    # too small to count
    assert not census_verdict(b, a, bp, {**ap, "mismatch": 2.2})[0]                   # tuned to one month
    assert census_verdict(b, a)[0]                                                    # no month before: newest alone
    print("selftest ok")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    cmd = sys.argv[1:2]
    if cmd == ["scope"]:
        rest = sys.argv[3:]
        also = tuple(rest[i + 1] for i in range(len(rest) - 1) if rest[i] == "--also")
        base, changes = sys.argv[2], changes_since(sys.argv[2])
        tests = {p: hunks_since(base, p) for s_, p, _a, d in changes if TESTS.match(p) and s_ != "D" and d}
        src = [p for s_, p, _a, _d in changes if s_ != "D" and any(r.match(p) for r in ALLOWED)]
        problems = scope_problems(changes, also, tests, dates_added_since(base, src))
        print("\n".join(f"- {p}" for p in problems) if problems else "Every change is inside the rules, the engine, added tests and date-only test moves.")
        sys.exit(1 if problems else 0)
    elif cmd == ["census"]:
        files = [shares(p) for p in sys.argv[2:6]]
        good, why, table = census_verdict(*files)
        print(table)
        print()
        print("**Improved** on the newest month without slipping on the month before." if good else
              "**Not an improvement:**\n" + "\n".join(f"- {r}" for r in why))
        sys.exit(0 if good else 1)
    elif cmd == ["selftest"]:
        selftest()
    else:
        sys.exit(__doc__)
