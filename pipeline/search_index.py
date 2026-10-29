"""Offline search index for the app: every rate-bearing leaf line of chapters 1-97.

Used by build_rules.py and update_hts.py. Writes app/public/data/search.json as [code, desc, path, general rate].
"""
import json
from pathlib import Path


def write_search(shards: Path, out: Path):
    # search index: every rate-bearing leaf line (10-digit, or 8-digit without stat suffixes)
    leaves = []
    for f in sorted(shards.glob("ch*.json")):
        ls = json.loads(f.read_text(encoding="utf-8"))
        if f.stem in ("ch98", "ch99"):
            continue
        has_kids = {l["digits"][:8] for l in ls if len(l["digits"]) == 10}
        for l in ls:
            if len(l["digits"]) == 10 or (len(l["digits"]) == 8 and l["digits"] not in has_kids):
                path = l["path"].split(" > ")
                segs = [p for p in path if p]
                full = " > ".join(segs)
                # keep the heading (names the product) and the nearest levels; drop the middle if long
                short = full if len(full) <= 260 else " > ".join([segs[0][:110], "…"] + segs[-2:])[:320]
                leaves.append([l["code"], l["desc"], short, (l["general"] or {}).get("raw", "")[:40]])
    out.write_text(json.dumps(leaves, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return len(leaves)
