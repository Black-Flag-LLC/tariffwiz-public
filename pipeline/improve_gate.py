"""The self-improve workflow's gate: decides, without trusting the agent, whether a proposed change may be offered.

  python -I pipeline/improve_gate.py scope BASE_REF [--also PATH]...
                                                             # exit 1 when a change falls outside what may be edited
                                                             # (--also: one more file the caller may change)
  python -I pipeline/improve_gate.py census BEFORE AFTER [BEFORE_PREV AFTER_PREV]
                                                             # Markdown before/after table; exit 1 unless it improved
  python -I pipeline/improve_gate.py selftest

What may change: the rules (app/public/data/rules.json), the engine (app/src/engine/*.ts) and the golden tests, which
may gain cases but never lose or alter a line (they pin answers already known to be right). Never the Census
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


def git(*a):
    return subprocess.run(["git", *a], capture_output=True, text=True, check=True).stdout


def scope_problems(changes, also=()):
    """changes: [(status, path, added, deleted)] -> list of reasons the change set may not be offered."""
    bad = []
    for status, path, _added, deleted in changes:
        if TESTS.match(path):
            if status == "D" or deleted:
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
        problems = scope_problems(changes_since(sys.argv[2]), also)
        print("\n".join(f"- {p}" for p in problems) if problems else "Every change is inside the rules, the engine and added tests.")
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
