"""Daily watcher: is there anything new that could change a duty?

Checks (no keys needed):
  1. USITC releaseList — a newer HTS revision than the one rules.json was built from.
  2. Federal Register API — presidential documents and notices about tariffs / the HTS since the
     rules' check date.
  3. CBP CSMS messages (GovDelivery RSS, "Automated Broker Interface" and "Ocean Manifest" topics; each keeps
     only ~25 items, so it must run daily) whose title is about duties, tariffs, the HTS or quotas.

  python -I pipeline/watch.py [--seen FILE] [--json FILE]
--seen: text of what was already reported (the watch issues); items whose link appears there are skipped.
--json: writes {"new_revision": NAME or null, "items": N} for the workflow (the update job keys off new_revision).
Prints a Markdown report and exits 1 when something new is found (the workflow then comments on the issue).
A new revision is also taken in by the update job (pipeline/update_hts.py), which opens a pull request.
"""
import argparse
import email.utils
import json
import re
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RULES = ROOT / "app" / "public" / "data" / "rules.json"
CSMS_FEEDS = ["https://public.govdelivery.com/topics/USDHSCBP_3/feed.rss",   # Automated Broker Interface
              "https://public.govdelivery.com/topics/USDHSCBP_7/feed.rss"]   # Ocean Manifest
CSMS_TOPIC = re.compile(r"tariff|duty|duties|section (?:122|201|232|301|338)|chapter 99|99\d\d\.\d\d|harmonized|\bHTS"
                        r"|IEEPA|proclamation|exclusion|reciprocal|in-transit|quota|safeguard|merchandise processing"
                        r"|\bMPF\b|antidumping|countervailing|AD/CVD|de minimis|USMCA|trade agreement|drawback", re.I)
UA = {"User-Agent": "Mozilla/5.0 (tariffwiz-watcher)"}  # GovDelivery answers 406 to bare clients


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()


def csms(since):
    out, seen = [], set()
    for feed in CSMS_FEEDS:
        for it in ET.fromstring(get(feed)).iter("item"):
            title, link = (it.findtext("title") or "").strip(), (it.findtext("link") or "").strip()
            day = email.utils.parsedate_to_datetime(it.findtext("pubDate")).date().isoformat()
            if link in seen or day < since or not CSMS_TOPIC.search(title):
                continue
            seen.add(link)
            out.append((day, f"- {day} · CBP CSMS · [{title}]({link})", link))
    return [(line, link) for _, line, link in sorted(out, reverse=True)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seen", type=Path)
    ap.add_argument("--json", type=Path)
    a = ap.parse_args()
    already = a.seen.read_text(encoding="utf-8", errors="replace") if a.seen and a.seen.exists() else ""

    meta = json.loads(RULES.read_text(encoding="utf-8"))["meta"]
    built, since = meta["revision"], meta["checked"]
    found = []  # (markdown line, link used to skip it next time)

    releases = json.loads(get("https://hts.usitc.gov/reststop/releaseList"))
    current = next((r for r in releases if r.get("status") == "current"), None)
    new_revision = current["name"] if current and current["name"] != built else None
    if new_revision:
        link = f"https://hts.usitc.gov/reststop/file?release={new_revision}&filename=Change%20Record"
        found.append((f"- **New HTS revision:** {current['title']} (in force {current['releaseStartDate']}); rules are "
                      f"built from {built}. [Change Record]({link}). The update job opens a pull request for it.", link))

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
        for d in json.loads(get(f"https://www.federalregister.gov/api/v1/documents.json?{q}")).get("results", []):
            if d["html_url"] not in seen:
                seen.add(d["html_url"])
                found.append((f"- {d['publication_date']} · {d['type']} · [{d['title']}]({d['html_url']})", d["html_url"]))
    found += csms(since)

    fresh = [line for line, link in found if link not in already]
    print(f"## Tariff watch — rules built from {built}, checked {since}\n")
    print("\n".join(fresh) if fresh else "Nothing new.")
    if a.json:
        a.json.write_text(json.dumps({"new_revision": new_revision, "items": len(fresh)}), encoding="utf-8")
    return 1 if fresh else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        sys.exit(main())
    except Exception as e:  # network or API failure: exit 2 so the workflow fails instead of filing an empty issue
        print(f"watch failed: {e}", file=sys.stderr)
        sys.exit(2)
