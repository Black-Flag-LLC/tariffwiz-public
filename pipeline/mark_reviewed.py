"""Record that a Federal Register document was reviewed (and encoded if it changes a duty).

  python -I pipeline/mark_reviewed.py DOC "what it does / what was encoded"   # e.g. 2026-22292 "PP 11076: ..."
  python -I pipeline/mark_reviewed.py --checked                               # only move rules.json meta.checked to today

Adds DOC to pipeline/reviewed.json, so the site's status banner stops listing it (pipeline/watch.py --status).
--checked moves rules.json meta.checked to today. Only use it once EVERY action published since the old date is reviewed:
the watcher only looks back to meta.checked, so anything unreviewed before it would drop off the banner.
"""
import datetime
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REVIEWED = ROOT / "pipeline" / "reviewed.json"
RULES = ROOT / "app" / "public" / "data" / "rules.json"


def main(argv):
    today = datetime.date.today().isoformat()
    if argv and argv[0] != "--checked":
        if len(argv) < 2:
            sys.exit(__doc__)
        r = json.loads(REVIEWED.read_text(encoding="utf-8"))
        if not any(x["doc"] == argv[0] for x in r["reviewed"]):
            r["reviewed"].append({"doc": argv[0], "date": today, "note": argv[1]})
            REVIEWED.write_text(json.dumps(r, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    if argv and argv[0] == "--checked":
        rules = json.loads(RULES.read_text(encoding="utf-8"))
        rules["meta"]["checked"] = today
        RULES.write_text(json.dumps(rules, separators=(",", ":")), encoding="utf-8")
        print(f"rules checked {today}")
    else:
        print(f"reviewed: {argv[0]} (meta.checked unchanged; --checked once everything since it is reviewed)")


if __name__ == "__main__":
    main(sys.argv[1:])
