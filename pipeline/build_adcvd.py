"""Rebuild .claude/skills/us-import-duty/references/adcvd.json from the Federal Register API.

Stdlib only. Run:  python -I pipeline/build_adcvd.py [--cache DIR] [--out FILE] [--max-docs N]

What it does
1. Active orders: parses the last 12 monthly ITA notices "Antidumping or Countervailing Duty Order,
   Finding, or Suspended Investigation; Opportunity To Request Administrative Review" (every order
   is listed once a year in its anniversary month), then adds orders published after the oldest of
   those notices (FR titles "...: Antidumping/Countervailing Duty Order(s)").
2. Drops orders whose newest case-specific FR notice is a full revocation.
3. HTS: for each case, walks the case-specific FR notices that mention the case number (newest
   first), cuts out the "Scope of the Order(s)/Investigation" section and collects the HTSUS
   numbers it cites. HTS numbers in an AD/CVD scope are "for convenience and customs purposes";
   the written scope is dispositive. The calculator only FLAGS "an order may apply".

Source: Federal Register API (no key), https://www.federalregister.gov/developers/documentation/api/v1
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

API = "https://www.federalregister.gov/api/v1/documents.json"
UA = "TARIFFWIZ-adcvd-builder/1.0 (research; stdlib urllib)"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_OUT = os.path.join(ROOT, ".claude", "skills", "us-import-duty", "references", "adcvd.json")

OPP_TITLE = "Opportunity To Request Administrative Review"
CASE_RE = re.compile(r"\b([AC])-\s*(\d{3})-\s*(\d{3})\b")
HTS_RE = re.compile(r"(?<![\d.])(\d{4}\.\d{2}(?:\.\d{2,4})?(?:\.\d{2})?)(?![\d])")
HEADING_RE = re.compile(r"\bheadings?\s+((?:\d{4}(?:,\s*|\s+and\s+|\s+or\s+)?)+)", re.I)

# Country name fragments (as ITA writes them) -> ISO2. Order matters: longer/more specific first.
COUNTRIES = [
    ("people's republic of china", "CN"), ("china", "CN"), ("hong kong", "HK"),
    ("republic of korea", "KR"), ("korea", "KR"), ("taiwan", "TW"), ("japan", "JP"),
    ("socialist republic of vietnam", "VN"), ("vietnam", "VN"), ("viet nam", "VN"),
    ("india", "IN"), ("indonesia", "ID"), ("malaysia", "MY"), ("thailand", "TH"),
    ("philippines", "PH"), ("cambodia", "KH"), ("laos", "LA"), ("lao", "LA"),
    ("sri lanka", "LK"), ("bangladesh", "BD"), ("pakistan", "PK"), ("kazakhstan", "KZ"),
    ("turkiye", "TR"), ("turkey", "TR"), ("israel", "IL"),
    ("saudi arabia", "SA"), ("united arab emirates", "AE"), ("oman", "OM"), ("bahrain", "BH"),
    ("qatar", "QA"), ("kuwait", "KW"), ("iran", "IR"), ("egypt", "EG"), ("morocco", "MA"),
    ("tunisia", "TN"), ("south africa", "ZA"), ("nigeria", "NG"), ("kenya", "KE"),
    ("russian federation", "RU"), ("russia", "RU"), ("ukraine", "UA"), ("belarus", "BY"),
    ("moldova", "MD"), ("georgia", "GE"), ("armenia", "AM"), ("azerbaijan", "AZ"),
    ("uzbekistan", "UZ"),
    ("germany", "DE"), ("france", "FR"), ("italy", "IT"), ("spain", "ES"), ("portugal", "PT"),
    ("netherlands", "NL"), ("belgium", "BE"), ("luxembourg", "LU"), ("austria", "AT"),
    ("switzerland", "CH"), ("sweden", "SE"), ("finland", "FI"), ("norway", "NO"),
    ("denmark", "DK"), ("poland", "PL"), ("czech", "CZ"), ("slovakia", "SK"),
    ("hungary", "HU"), ("romania", "RO"), ("bulgaria", "BG"), ("greece", "GR"),
    ("croatia", "HR"), ("slovenia", "SI"), ("serbia", "RS"), ("bosnia", "BA"),
    ("north macedonia", "MK"), ("macedonia", "MK"), ("estonia", "EE"), ("latvia", "LV"),
    ("lithuania", "LT"), ("ireland", "IE"), ("united kingdom", "GB"), ("cyprus", "CY"),
    ("canada", "CA"), ("mexico", "MX"), ("brazil", "BR"), ("argentina", "AR"), ("chile", "CL"),
    ("colombia", "CO"), ("ecuador", "EC"), ("peru", "PE"), ("venezuela", "VE"),
    ("trinidad and tobago", "TT"), ("dominican republic", "DO"), ("guatemala", "GT"),
    ("el salvador", "SV"), ("honduras", "HN"), ("costa rica", "CR"), ("uruguay", "UY"),
    ("australia", "AU"), ("new zealand", "NZ"), ("singapore", "SG"), ("algeria", "DZ"),
    ("iceland", "IS"), ("burma", "MM"), ("myanmar", "MM"), ("kosovo", "XK"), ("serbia", "RS"),
]

# Commerce case-number country codes not learned from the opportunity notices (fallback only).
CODE_FALLBACK = {"721": ("DZ", "Algeria"), "553": ("LA", "Laos"), "555": ("KH", "Cambodia"),
                 "570": ("CN", "China"), "580": ("KR", "Korea"), "583": ("TW", "Taiwan")}


def iso2(name: str) -> str | None:
    n = html.unescape(name).lower().replace("[uuml]", "u").replace("ü", "u")
    for frag, code in COUNTRIES:
        if frag in n:
            return code
    return None


class FR:
    def __init__(self, cache: str, delay: float = 0.25):
        self.cache = cache
        self.delay = delay
        self.calls = 0
        os.makedirs(cache, exist_ok=True)

    def _get(self, url: str) -> bytes:
        key = re.sub(r"[^A-Za-z0-9]+", "_", url)[-60:] + "_" + hashlib.sha1(url.encode()).hexdigest()[:16]
        path = os.path.join(self.cache, key)
        if os.path.exists(path):
            with open(path, "rb") as f:
                return f.read()
        for attempt in range(5):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept-Encoding": "identity"})
                with urllib.request.urlopen(req, timeout=60) as r:
                    data = r.read()
                break
            except Exception as e:  # noqa: BLE001 - network retry
                if attempt == 4:
                    raise
                time.sleep(2 + attempt * 3)
                print(f"  retry {url[:90]} ({e})", file=sys.stderr)
        self.calls += 1
        time.sleep(self.delay)
        with open(path, "wb") as f:
            f.write(data)
        return data

    def search(self, **conds) -> list[dict]:
        q = [("per_page", "100"), ("order", conds.pop("order", "newest"))]
        for f in ("title", "publication_date", "document_number", "raw_text_url", "html_url", "type", "citation"):
            q.append(("fields[]", f))
        for k, v in conds.items():
            if isinstance(v, list):
                for x in v:
                    q.append((f"conditions[{k}][]", x))
            elif isinstance(v, dict):
                for kk, vv in v.items():
                    q.append((f"conditions[{k}][{kk}]", vv))
            else:
                q.append((f"conditions[{k}]", v))
        url = API + "?" + urllib.parse.urlencode(q)
        out = []
        while url and len(out) < 2000:
            d = json.loads(self._get(url))
            out += d.get("results", [])
            url = d.get("next_page_url")
        return out

    def text(self, raw_url: str) -> str:
        t = self._get(raw_url).decode("utf-8", "replace")
        t = re.sub(r"<[^>]+>", "", t)
        return html.unescape(t).replace("[uuml]", "ü")


# ---------------------------------------------------------------- step 1: active order list
def parse_opportunity(text: str, doc: dict) -> list[dict]:
    out = []
    i = text.find("Antidumping Duty Proceedings")
    if i < 0:
        return out
    block = text[i:]
    end = re.search(r"\n-{20,}\n\s*\n\s{4}(All requests|In accordance|Commerce|Note:)", block)
    if end:
        block = block[: end.start()]
    section = "AD"
    group = None
    buf = ""
    indent_entry = False
    date_tail = re.compile(r"\s+\d{1,2}/\d{1,2}/\d{2,4}\s*-\s*\d{1,2}/\d{1,2}/\d{2,4}\s*$")
    for raw in block.split("\n"):
        line = raw.rstrip()
        if not line.strip() or set(line.strip()) <= set("-"):
            continue
        s = line.strip()
        if s.startswith("Antidumping Duty Proceedings"):
            section, group, buf = "AD", None, ""
            continue
        if s.startswith("Countervailing Duty Proceedings"):
            section, group, buf = "CVD", None, ""
            continue
        if s.startswith("Suspension Agreement"):
            section, group, buf = "SA", None, ""
            continue
        if s.startswith("[[Page") or s == "Period":
            continue
        line = date_tail.sub("", line)
        line = re.sub(r"\.{3,}\s*$", "", line).rstrip()
        if not buf:
            if line.startswith("    ") and group:
                indent_entry = True
            else:
                indent_entry = False
                group = None
            if line.strip().endswith(":") and not CASE_RE.search(line):
                group = line.strip()[:-1]
                continue
        piece = line.strip()
        buf = (buf + piece) if buf.endswith("-") else (buf + " " + piece).strip()
        m = CASE_RE.search(buf)
        if m and re.search(r"\d{3}-\s*\d{3}\s*\.*\s*$", buf):
            case = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
            body = buf[: m.start()].rstrip(" ,")
            if indent_entry and group:
                country, product = group, body
            else:
                country, _, product = body.partition(":")
            if not (indent_entry and group):
                group = country.strip()
            if section in ("AD", "CVD"):
                out.append({
                    "case": case,
                    "type": "AD" if case.startswith("A") else "CVD",
                    "country_name": country.strip(),
                    "country": iso2(country),
                    "product": re.sub(r"\s+", " ", product).strip(),
                    "listed_in": {"fr_doc": doc["document_number"], "date": doc["publication_date"]},
                })
            buf = ""
    return out


NEW_ORDER_TITLE = re.compile(
    r"(Antidumping|Countervailing) Duty Orders?(\s*$|;|\s+and\s)|"
    r"and (Antidumping|Countervailing) Duty Orders?\s*$|"
    r"(Antidumping|Countervailing) Duty Orders?$", re.I)
NOT_NEW = re.compile(r"Continuation|Revocation|Opportunity|Advance Notification|Sunset|Rescission|"
                     r"Initiation|Amended Final Results|Administrative Review|Scope Ruling|Circumvention|"
                     r"Court Decision|Changed Circumstances|Partial", re.I)
TITLE_FROM = re.compile(r"^(?P<product>.+?)\s+From\s+(?P<countries>.+?):", re.I)


def find_new_orders(fr: FR, since: str, code_map: dict) -> list[dict]:
    docs = fr.search(agencies=["international-trade-administration"], term='"duty order"',
                     publication_date={"gte": since}, type=["NOTICE"])
    out = []
    for d in docs:
        t = re.sub(r"\s+", " ", d["title"])
        if not NEW_ORDER_TITLE.search(t) or NOT_NEW.search(t):
            continue
        head = fr.text(d["raw_text_url"])[:6000]
        m = TITLE_FROM.search(t)
        product = m.group("product") if m else t
        countries_txt = m.group("countries") if m else ""
        for a_, b_, c_ in sorted(set(CASE_RE.findall(head))):
            case = f"{a_}-{b_}-{c_}"
            code, name = code_map.get(b_) or CODE_FALLBACK.get(b_) or (None, None)
            if not code and countries_txt and " and " not in countries_txt and "," not in countries_txt:
                code, name = iso2(countries_txt), countries_txt
            out.append({
                "case": case, "type": "AD" if case.startswith("A") else "CVD",
                "country_name": name or countries_txt, "country": code, "product": product.strip(),
                "listed_in": {"fr_doc": d["document_number"], "date": d["publication_date"], "new_order": True},
            })
    return out


# ---------------------------------------------------------------- step 2/3: per-case scope + HTS
OMNIBUS = re.compile(r"^(Initiation of|Rescission of|Antidumping or Countervailing Duty Order, Finding|"
                     r"Notice of Scope Rulings|Initiation of Five-Year|Final Results of Expedited Sunset Reviews$|"
                     r"Continuation of Antidumping and Countervailing Duty Orders$)", re.I)
FULL_REVOKE = re.compile(r"Revocation of (the )?(Antidumping|Countervailing)( Duty)? (Order|Orders)|"
                         r"Revocation of (Antidumping|Countervailing) and (Antidumping|Countervailing)", re.I)
PARTIAL = re.compile(r"in Part|Partial|Rescission", re.I)
SCOPE_HEAD = re.compile(r"\n\s*(?:Appendix[^\n]*\n\s*)?Scope of (?:the )?(?:Antidumping |Countervailing |AD |CVD )?"
                        r"(?:Duty )?(?:and Countervailing Duty |and Antidumping Duty )?"
                        r"(Orders?|Investigations?|Reviews?|the Orders?)\b[^\n]*\n", re.I)
NEXT_HEAD = re.compile(r"\n\n(?! {2})[A-Z][^\n]{2,120}\n\n")


def scope_sections(text: str) -> list[str]:
    out = []
    for m in SCOPE_HEAD.finditer(text):
        rest = text[m.end(): m.end() + 30000]
        n = NEXT_HEAD.search(rest, 150)
        out.append(rest[: n.start()] if n else rest[:15000])
    return out


def norm_hts(h: str) -> str:
    d = h.replace(".", "")
    if len(d) <= 4:
        return d
    if len(d) <= 6:
        return d[:4] + "." + d[4:]
    if len(d) <= 8:
        return d[:4] + "." + d[4:6] + "." + d[6:]
    return d[:4] + "." + d[4:6] + "." + d[6:]


def hts_from(section: str) -> list[str]:
    if not re.search(r"HTS|Harmonized Tariff|tariff schedule|subheading", section, re.I):
        return []
    found = []
    for h in HTS_RE.findall(section):
        if h.startswith("99"):
            continue
        found.append(norm_hts(h))
    for grp in HEADING_RE.findall(section):
        for h in re.findall(r"\d{4}", grp):
            if not h.startswith("99") and 2500 < int(h) < 9800:
                found.append(h)
    seen, out = set(), []
    for h in found:
        if h not in seen:
            seen.add(h)
            out.append(h)
    return out


def case_hts(fr: FR, case: str, max_docs: int) -> dict:
    docs = fr.search(agencies=["international-trade-administration"], term=f'"{case}"')
    specific = [d for d in docs if not OMNIBUS.search(d["title"])]
    res = {"hts": [], "scope_doc": None, "revoked": None, "fr_docs": len(docs)}
    if specific:
        newest = specific[0]
        t = newest["title"]
        if FULL_REVOKE.search(t) and not PARTIAL.search(t) and "Continuation" not in t:
            res["revoked"] = {"fr_doc": newest["document_number"], "date": newest["publication_date"],
                              "title": newest["title"]}
    prio = re.compile(r"Duty Orders?\b|Continuation|Sunset|Covered Merchandise|Scope", re.I)
    ordered = [d for d in specific if prio.search(d["title"])] + [d for d in specific if not prio.search(d["title"])]
    tried = 0
    for d in ordered:
        if tried >= max_docs:
            break
        tried += 1
        text = fr.text(d["raw_text_url"])
        if case not in text.replace("–", "-"):
            continue
        hts = []
        for sec in scope_sections(text):
            hts += [h for h in hts_from(sec) if h not in hts]
        if hts:
            res["hts"] = hts
            res["scope_doc"] = {"fr_doc": d["document_number"], "date": d["publication_date"],
                                "citation": d.get("citation"), "title": d["title"], "url": d.get("html_url")}
            break
    return res


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(os.environ.get("TEMP", "/tmp"), "tariffwiz_adcvd_cache"))
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--max-docs", type=int, default=40)
    ap.add_argument("--limit", type=int, default=0, help="debug: only first N cases")
    a = ap.parse_args()
    fr = FR(a.cache)

    opp = [d for d in fr.search(agencies=["international-trade-administration"], term=f'"{OPP_TITLE}"',
                                publication_date={"gte": (dt.date.today() - dt.timedelta(days=430)).isoformat()})
           if d["title"].startswith("Antidumping or Countervailing Duty Order, Finding")
           and OPP_TITLE.lower() in d["title"].lower()]
    opp = sorted(opp, key=lambda d: d["publication_date"], reverse=True)[:12]
    print(f"opportunity notices: {len(opp)} ({opp[-1]['publication_date']} .. {opp[0]['publication_date']})")
    orders: dict[str, dict] = {}
    for d in opp:
        rows = parse_opportunity(fr.text(d["raw_text_url"]), d)
        print(f"  {d['publication_date']} {d['document_number']}: {len(rows)} orders")
        for r in rows:
            orders.setdefault(r["case"], r)
    votes: dict[str, dict] = {}
    for r in orders.values():
        if r["country"]:
            k = r["case"][2:5]
            votes.setdefault(k, {}).setdefault((r["country"], r["country_name"].title()), 0)
            votes[k][(r["country"], r["country_name"].title())] += 1
    code_map = {k: max(v, key=v.get) for k, v in votes.items()}
    since = opp[-1]["publication_date"]
    new = find_new_orders(fr, since, code_map)
    added = 0
    for r in new:
        if r["case"] not in orders:
            orders[r["case"]] = r
            added += 1
    print(f"orders from opportunity notices + new orders since {since}: {len(orders)} (+{added} new)")

    cases = sorted(orders)
    if a.limit:
        cases = cases[: a.limit]
    out, revoked, no_hts = [], [], []
    for i, c in enumerate(cases, 1):
        r = orders[c]
        info = case_hts(fr, c, a.max_docs)
        if info["revoked"]:
            revoked.append({"case": c, **info["revoked"]})
            continue
        rec = {
            "case": c, "type": r["type"], "country": r["country"], "country_name": r["country_name"],
            "product": r["product"], "hts": info["hts"],
            "source": {
                "active_per": r["listed_in"],
                "scope": info["scope_doc"],
            },
        }
        maj = code_map.get(c[2:5])
        if maj and rec["country"] and maj[0] != rec["country"] and votes[c[2:5]][maj] >= 3:
            rec["note"] = (f"ITA notice names {rec['country_name']} but case code {c[2:5]} is "
                           f"{maj[0]} elsewhere; likely a typo in the notice -- verify")
        if not info["hts"]:
            no_hts.append(c)
        out.append(rec)
        if i % 25 == 0:
            print(f"  {i}/{len(cases)} cases, FR calls so far {fr.calls}")
    meta = {
        "schema": "tariffwiz.adcvd/1",
        "built": dt.date.today().isoformat(),
        "builder": "pipeline/build_adcvd.py (python -I)",
        "method": "Active list = last 12 ITA 'Opportunity To Request Administrative Review' notices + orders "
                  "published since; HTS = numbers cited in the newest case-specific FR notice that prints the "
                  "scope. HTS lists are prefixes as written (4/6/8/10 digits); scope text is dispositive.",
        "counts": {"orders": len(out), "with_hts": len(out) - len(no_hts), "without_hts": len(no_hts),
                   "revoked_dropped": len(revoked), "fr_calls": fr.calls},
        "use": "FLAG ONLY: 'An AD/CVD order may apply (case, link)'. Rates are company-specific cash deposits.",
        "revoked_dropped": revoked,
        "without_hts": no_hts,
    }
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "orders": out}, f, ensure_ascii=False, indent=1)
    print(json.dumps(meta["counts"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
