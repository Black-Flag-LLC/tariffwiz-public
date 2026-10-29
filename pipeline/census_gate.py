"""Census check helpers for the update and monthly workflows.

  python -I pipeline/census_gate.py latest            # prints YYMM of the newest Census import file out (or nothing)
  python -I pipeline/census_gate.py check SUMMARY.json # prints a Markdown verdict; exit 1 when worse than the limits

Baseline (August 2026, Rev 21 rules): 87.8% of sampled value matched exactly, 1.8% unexplained (MISMATCH).
Limits leave room for normal month-to-month noise; a broken rule moves several points at once.
"""
import datetime
import json
import sys
import urllib.request

MIN_MATCH = 82.0      # % of sampled value where the engine equals the collected rate
MAX_MISMATCH = 3.0    # % of sampled value with no explanation
FIRST = (2026, 8)     # first full month inside the engine's date window (from 2026-07-24)


def exists(yy, mm):
    url = f"https://www.census.gov/trade/downloads/20{yy:02d}/Merch/im_m/IMDB{yy:02d}{mm:02d}.ZIP"
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "tariffwiz-census-check"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status == 200
    except Exception:
        return False


def latest():
    d = datetime.date.today().replace(day=1)
    for _ in range(4):  # Census publishes about 5 weeks after the month ends
        d = (d - datetime.timedelta(days=1)).replace(day=1)
        if (d.year, d.month) < FIRST:
            return ""
        if exists(d.year % 100, d.month):
            return f"{d.year % 100:02d}{d.month:02d}"
    return ""


def check(path):
    s = json.loads(open(path, encoding="utf-8").read())
    sh = s["share"]
    match, mism = sh.get("MATCH", 0.0), sh.get("MISMATCH", 0.0)
    ok = match >= MIN_MATCH and mism <= MAX_MISMATCH
    print(f"**Census {s['month']}** (rules {s['revision']}, {s['pairs']} code × country pairs, ${s['valueB']}B): "
          f"{'✅ within limits' if ok else '❌ worse than the limits'}\n")
    print("| result | value share | limit |\n|---|---|---|")
    print(f"| exact match | {match}% | at least {MIN_MATCH}% (August baseline 87.8%) |")
    for k in ("MATCH_BLEND", "EXPLAINED", "EXPLAINED_MIXED"):
        print(f"| {k.lower().replace('_', ' ')} | {sh.get(k, 0.0)}% | |")
    print(f"| unexplained | {mism}% | at most {MAX_MISMATCH}% (August baseline 1.8%) |")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if sys.argv[1:2] == ["latest"]:
        print(latest())
    elif sys.argv[1:2] == ["check"]:
        sys.exit(check(sys.argv[2]))
    else:
        sys.exit(__doc__)
