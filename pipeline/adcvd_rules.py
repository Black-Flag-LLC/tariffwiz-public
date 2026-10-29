"""AD/CVD orders as the engine flags them (rules.json "adcvd"), from references/adcvd.json (pipeline/build_adcvd.py).

Used by build_rules.py and update_adcvd.py, so the monthly refresh and a full rebuild give the same result.
"""
import re
from collections import Counter, defaultdict


def adcvd_rules(ad: dict) -> tuple[list, int]:
    """(rules entries, number of country fixes). A case number prefix belongs to one country: fix stray parses."""
    by_prefix = defaultdict(Counter)
    for o in ad["orders"]:
        by_prefix[o["case"][:5]][o["country"]] += 1
    fixed = 0
    for o in ad["orders"]:
        top, n = by_prefix[o["case"][:5]].most_common(1)[0]
        if o["country"] != top and n >= 2:
            o["country"] = top
            fixed += 1
    return [{"case": o["case"], "type": o["type"], "country": o["country"],
             "product": re.sub(r"\[[A-Za-z]+\]", "", o["product"])[:120],
             "hts": sorted({h.replace(".", "")[:10] for h in o.get("hts", [])}),
             "fr": (o.get("source", {}).get("scope") or {}).get("fr_doc")} for o in ad["orders"] if o.get("hts")], fixed
