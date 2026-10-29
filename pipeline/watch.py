"""Daily watcher: is there anything new that could change a duty?

Checks (no keys needed):
  1. USITC releaseList — a newer HTS revision than the one rules.json was built from.
  2. Federal Register API — presidential documents and notices about tariffs / the HTS since the
     rules' check date.
Prints a Markdown report and exits 1 when something new is found (the workflow then opens an issue).
A new revision means re-running the pipeline and re-anchoring note line numbers — see the
us-import-duty skill, "New HTS revision".
"""
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RULES = ROOT / "app" / "public" / "data" / "rules.json"


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "tariffwiz-watcher"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    meta = json.loads(RULES.read_text(encoding="utf-8"))["meta"]
    built, since = meta["revision"], meta["checked"]
    found = []

    releases = get_json("https://hts.usitc.gov/reststop/releaseList")
    current = next((r for r in releases if r.get("status") == "current"), None)
    if current and current["name"] != built:
        found.append(f"- **New HTS revision:** {current['title']} (in force {current['releaseStartDate']}); rules are built from {built}.")

    queries = [
        # presidential actions on imports (Section 232 "Adjusting Imports…", 301, 338, 122 proclamations)
        [("conditions[type][]", "PRESDOCU"), ("conditions[term]", "imports")],
        # USTR / CBP notices about tariffs or HTS modifications
        [("conditions[agencies][]", "trade-representative-office-of-united-states"), ("conditions[term]", "tariff")],
        [("conditions[agencies][]", "u-s-customs-and-border-protection"), ("conditions[term]", "\"Harmonized Tariff Schedule\"")],
    ]
    seen = set()
    for extra in queries:
        q = urllib.parse.urlencode(extra + [
            ("conditions[publication_date][gte]", since), ("order", "newest"), ("per_page", "50"),
            ("fields[]", "title"), ("fields[]", "publication_date"), ("fields[]", "html_url"), ("fields[]", "type")])
        for d in get_json(f"https://www.federalregister.gov/api/v1/documents.json?{q}").get("results", []):
            if d["html_url"] not in seen:
                seen.add(d["html_url"])
                found.append(f"- {d['publication_date']} · {d['type']} · [{d['title']}]({d['html_url']})")

    print(f"## Tariff watch — rules built from {built}, checked {since}\n")
    print("\n".join(found) if found else "Nothing new.")
    return 1 if found else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # network or API failure: exit 2 so the workflow fails instead of filing an empty issue
        print(f"watch failed: {e}", file=sys.stderr)
        sys.exit(2)
