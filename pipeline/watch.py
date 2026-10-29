"""Daily watcher: is there anything new that could change a duty?

Checks (no keys needed):
  1. USITC releaseList — a newer HTS revision than the one rules.json was built from.
  2. Federal Register API — presidential documents and notices about tariffs / the HTS since the
     rules' check date.
  3. CBP CSMS messages (GovDelivery RSS, "Automated Broker Interface" and "Ocean Manifest" topics; each keeps
     only ~25 items, so it must run daily) whose title is about duties, tariffs, the HTS or quotas.
  4. Federal Register public inspection: tariff proclamations and notices filed for tomorrow's issue.

  python -I pipeline/watch.py [--seen FILE] [--json FILE] [--status FILE]
--seen: text of what was already reported (the watch issues); items whose link appears there are skipped.
--json: writes {"new_revision": NAME or null, "items": N} for the workflow (the update job keys off new_revision).
--status: writes the site's status file (app/public/data/status.json): Federal Register actions published or on public
  inspection since the rules' check date and not yet in pipeline/reviewed.json, and the newest HTS revision. The site
  shows them above every result, so a quote never silently misses a published change.
Prints a Markdown report and exits 1 when something new is found (the workflow then comments on the issue).
A new revision is also taken in by the update job (pipeline/update_hts.py), which opens a pull request.
"""
import argparse
import datetime
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
REVIEWED = ROOT / "pipeline" / "reviewed.json"   # Federal Register documents already reviewed (and encoded if needed)
# a Federal Register document that can change a duty: presidential actions on imports, USTR/CBP/Commerce tariff notices
FR_TOPIC = re.compile(r"tariff|dut(y|ies)|imports?\b|harmonized|section (122|201|232|301|338)|proclamation|exclusion|quota|safeguard", re.I)
FR_AGENCIES = {"executive-office-of-the-president", "trade-representative-office-of-united-states",
               "u-s-customs-and-border-protection", "international-trade-administration", "industry-and-security-bureau",
               "commerce-department", "international-trade-commission"}
AD_CVD = re.compile(r"antidumping|countervailing|administrative review|sunset review|scope ruling", re.I)  # flagged, not priced
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


def public_inspection():
    """Documents filed for the next Federal Register issues that could change a duty."""
    out = []
    for d in json.loads(get("https://www.federalregister.gov/api/v1/public-inspection-documents/current.json")).get("results", []):
        slugs = {x.get("slug") for x in d.get("agencies") or []}
        title = " ".join(filter(None, [d.get("title"), d.get("toc_subject"), d.get("toc_doc")]))
        if slugs & FR_AGENCIES and FR_TOPIC.search(title) and not AD_CVD.search(title):
            out.append({"doc": d["document_number"], "title": (d.get("title") or "").strip(), "type": d.get("type") or "",
                        "date": d.get("publication_date") or "", "url": d["html_url"], "inspection": True})
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seen", type=Path)
    ap.add_argument("--json", type=Path)
    ap.add_argument("--status", type=Path)
    a = ap.parse_args()
    reviewed = {r["doc"] for r in json.loads(REVIEWED.read_text(encoding="utf-8"))["reviewed"]} if REVIEWED.exists() else set()
    actions = []   # Federal Register documents for the status file
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
        # Commerce, BIS and ITA Section 232 notices (inclusion processes, list changes, stockpiling rules)
        [("conditions[agencies][]", "commerce-department"), ("conditions[term]", "\"Section 232\"")],
        [("conditions[agencies][]", "industry-and-security-bureau"), ("conditions[term]", "\"Section 232\"")],
        [("conditions[agencies][]", "international-trade-administration"), ("conditions[term]", "\"Section 232\"")],
    ]
    seen = set()
    for extra in queries:
        q = urllib.parse.urlencode(extra + [
            ("conditions[publication_date][gte]", since), ("order", "newest"), ("per_page", "50"),
            ("fields[]", "title"), ("fields[]", "publication_date"), ("fields[]", "html_url"), ("fields[]", "type"),
            ("fields[]", "document_number")])
        for d in json.loads(get(f"https://www.federalregister.gov/api/v1/documents.json?{q}")).get("results", []):
            if d["html_url"] not in seen:
                seen.add(d["html_url"])
                found.append((f"- {d['publication_date']} · {d['type']} · [{d['title']}]({d['html_url']})", d["html_url"]))
                if not AD_CVD.search(d["title"]):
                    actions.append({"doc": d["document_number"], "title": d["title"], "type": d["type"],
                                    "date": d["publication_date"], "url": d["html_url"], "inspection": False})
    published = {x["doc"] for x in actions}
    for d in public_inspection():
        if d["doc"] not in published:
            actions.append(d)
            found.append((f"- {d['date']} (on public inspection) · {d['type']} · [{d['title']}]({d['url']})", d["url"]))
    found += csms(since)
    # the engine refuses entries after SUPPORTED_TO (calc.ts): say so 45 days ahead, every day until it is moved
    m = re.search(r"const SUPPORTED_TO = '(\d{4}-\d\d-\d\d)'", (ROOT / "app/src/engine/calc.ts").read_text(encoding="utf-8"))
    if m and (datetime.date.fromisoformat(m.group(1)) - datetime.date.today()).days <= 45:
        found.append((f"- **The calculator stops quoting entries after {m.group(1)}** (SUPPORTED_TO in app/src/engine/calc.ts): "
                      "encode the changes announced from then and move the date.", f"supported-to-{m.group(1)}-{datetime.date.today()}"))

    fresh = [line for line, link in found if link not in already]
    print(f"## Tariff watch — rules built from {built}, checked {since}\n")
    print("\n".join(fresh) if fresh else "Nothing new.")
    if a.json:
        a.json.write_text(json.dumps({"new_revision": new_revision, "items": len(fresh)}), encoding="utf-8")
    if a.status:  # no timestamp: the file only changes (and the site redeploys) when something changes
        pending = sorted((x for x in actions if x["doc"] not in reviewed), key=lambda x: (x["date"], x["doc"]))
        a.status.write_text(json.dumps({
            "rulesChecked": since, "revision": built,
            "latestRevision": {"name": current["name"], "title": current["title"], "from": current["releaseStartDate"]} if current else None,
            "pending": pending}, indent=1) + "\n", encoding="utf-8")
    return 1 if fresh else 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    try:
        sys.exit(main())
    except Exception as e:  # network or API failure: exit 2 so the workflow fails instead of filing an empty issue
        print(f"watch failed: {e}", file=sys.stderr)
        sys.exit(2)
