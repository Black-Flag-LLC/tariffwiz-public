"""Record that a Federal Register document was reviewed (and encoded if it changes a duty).

  python -I pipeline/mark_reviewed.py DOC "what it does / what was encoded"   # e.g. 2026-22292 "PP 11076: ..."
  python -I pipeline/mark_reviewed.py --checked                               # only move rules.json meta.checked to today

Adds DOC to pipeline/reviewed.json, so the site's status banner stops listing it (pipeline/watch.py --status), and sets
rules.json meta.checked to today: the date the rules were last reviewed against every published action.
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
    rules = json.loads(RULES.read_text(encoding="utf-8"))
    rules["meta"]["checked"] = today
    RULES.write_text(json.dumps(rules, separators=(",", ":")), encoding="utf-8")
    print(f"reviewed: {argv[0] if argv and argv[0] != '--checked' else '-'}; rules checked {today}")


if __name__ == "__main__":
    main(sys.argv[1:])
