"""Print Ch.99 heading rows (htsno, general/special/other, description) for a heading range.
usage: python -I pipeline/ch99_rows.py 9903.04.60 9903.04.70 [--full]"""
import json
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
rows = json.load(open(ROOT / "data/raw/usitc/current/ch99.json", encoding="utf-8"))
lo, hi = sys.argv[1], sys.argv[2]
full = "--full" in sys.argv
sys.stdout.reconfigure(encoding="utf-8")
for r in rows:
    h = r["htsno"]
    if h and lo <= h <= hi:
        d = r["description"] or ""
        print(f"{h} | gen={r['general']} | spec={r['special']} | oth={r['other']}")
        print("   ", d if full else d[:600])
