"""Refresh the AD/CVD order flags from the Federal Register (monthly job, or by hand).

  python -I pipeline/update_adcvd.py [--max-docs N] [--status OUT.json]

Runs build_adcvd.py into references/adcvd.json, then rewrites only rules.json "adcvd" (same transform as build_rules.py,
via adcvd_rules.py). Prints and writes what changed (orders added / revoked). The flags only say "an order may apply";
deposit rates are always the importer's to enter, so a refresh can go live once tests and the heading audit pass.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # python -I leaves the script folder off sys.path
from adcvd_rules import adcvd_rules  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / ".claude" / "skills" / "us-import-duty" / "references" / "adcvd.json"
RULES = ROOT / "app" / "public" / "data" / "rules.json"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-docs", type=int, default=40)
    ap.add_argument("--status", type=Path)
    a = ap.parse_args()
    rules = json.loads(RULES.read_text(encoding="utf-8"))
    before = {(o["case"], o["country"]) for o in rules["adcvd"]}
    subprocess.run([sys.executable, "-I", str(ROOT / "pipeline" / "build_adcvd.py"), "--out", str(REF), "--max-docs", str(a.max_docs)],
                   check=True)
    new, fixed = adcvd_rules(json.loads(REF.read_text(encoding="utf-8")))
    after = {(o["case"], o["country"]) for o in new}
    if len(after) < 0.8 * len(before):
        raise SystemExit(f"refresh found {len(after)} orders against {len(before)} now: Federal Register fetch looks incomplete, stopping")
    added, gone = sorted(after - before), sorted(before - after)
    rules["adcvd"] = new
    RULES.write_text(json.dumps(rules, separators=(",", ":")), encoding="utf-8")
    report = {"orders": len(after), "added": [f"{c} {k}" for c, k in added], "removed": [f"{c} {k}" for c, k in gone], "countryFixes": fixed}
    print(json.dumps(report, indent=1))
    if a.status:
        a.status.write_text(json.dumps(report, indent=1), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
