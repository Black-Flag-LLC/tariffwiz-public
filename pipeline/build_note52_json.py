"""Build references/note52_country_rates.json from the Rev 21 heading rows (data/raw/usitc/current/ch99.json)
and heading-table line numbers in data/build/hts_rev21.txt.
Usage: python -I pipeline/build_note52_json.py"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
rows = {r["htsno"]: r for r in json.load(open(ROOT / "data/raw/usitc/current/ch99.json", encoding="utf-8")) if r["htsno"]}
txt = (ROOT / "data/build/hts_rev21.txt").read_text(encoding="utf-8").split("\n")  # "\n" only: keeps grep numbering
line_of = {}
for i, t in enumerate(txt, 1):
    m = re.match(r"^(9903\.0[56]\.\d\d)\b", t)
    if m and i > 235824:
        line_of.setdefault(m.group(1), i)

ISO = {"Algeria": "DZ", "Angola": "AO", "Argentina": "AR", "Australia": "AU", "the Bahamas": "BS", "Bahrain": "BH",
       "Bangladesh": "BD", "Brazil": "BR", "Cambodia": "KH", "Canada": "CA", "Chile": "CL", "China": "CN", "Colombia": "CO",
       "Costa Rica": "CR", "Dominican Republic": "DO", "Ecuador": "EC", "Egypt": "EG", "El Salvador": "SV",
       "Guatemala": "GT", "Guyana": "GY", "Honduras": "HN", "Hong Kong": "HK", "Hong Kong, China": "HK", "India": "IN", "Indonesia": "ID",
       "Iraq": "IQ", "Israel": "IL", "Japan": "JP", "Jordan": "JO", "Kazakhstan": "KZ", "Kuwait": "KW", "Libya": "LY",
       "Malaysia": "MY", "Mexico": "MX", "Morocco": "MA", "New Zealand": "NZ", "Nicaragua": "NI", "Nigeria": "NG",
       "Norway": "NO", "Oman": "OM", "Pakistan": "PK", "Peru": "PE", "the Philippines": "PH", "Qatar": "QA",
       "Russia": "RU", "Saudi Arabia": "SA", "Singapore": "SG", "South Africa": "ZA", "South Korea": "KR",
       "Sri Lanka": "LK", "Switzerland": "CH", "Taiwan": "TW", "Thailand": "TH", "Trinidad and Tobago": "TT",
       "Türkiye": "TR", "the United Arab Emirates": "AE", "the United Kingdom": "GB", "Uruguay": "UY",
       "Venezuela": "VE", "Vietnam": "VN", "a member state of the European Union": "EU"}
EU27 = "AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE".split()

# Country-specific exemption headings, note 52(g)-(j). The general ones (9903.05.85-.92) apply to every country.
SPECIFIC = {
    "CA": ["9903.05.93 (g) USMCA duty-free entries incl. S/S+ lines, L234047-L234050"],
    "MX": ["9903.05.94 (h) USMCA duty-free entries incl. S/S+ lines, L234052-L234055"],
    "CR": ["9903.05.95 (i) CAFTA-DR duty-free textiles/apparel, L234057-L234061"],
    "DO": ["9903.05.95 (i), L234057-L234061"],
    "HN": ["9903.05.95 (i), L234057-L234061"],
    "NI": ["9903.05.95 (i), L234057-L234061"],
    "SV": ["9903.05.95 (i), L234057-L234061", "9903.06.07 (j)(7)(i) list L234694-L234713",
           "9903.06.08 (j)(7)(ii) aloe/centella, L234715-L234718",
           "9903.06.09 (j)(7)(iii) CAFTA-DR-claimed list L234741-L235127"],
    "GT": ["9903.05.95 (i), L234057-L234061", "9903.06.04 (j)(6)(i) list L234242-L234263",
           "9903.06.05 (j)(6)(ii) psyllium/boswellia/aloe, L234265-L234272",
           "9903.06.06 (j)(6)(iii) CAFTA-DR-claimed list L234294-L234687"],
    "GB": ["9903.05.96 (j)(1) list L234076-L234085 (2208.30 whisky, 9018-9022 medical)"],
    "EU": ["9903.05.97 (j)(2) list L234090-L234098 (fatty alcohols, cork, silk, diamonds, 7205.10, 8112.92.07)"],
    "CH": ["9903.05.98 (j)(3) list L234103-L234129"],
    "MY": ["9903.05.99 (j)(4)(i) list L234144-L234164", "9903.06.01 (j)(4)(ii) psyllium/boswellia/argan, L234166-L234173"],
    "KH": ["9903.06.02 (j)(5)(i) list L234188-L234218", "9903.06.03 (j)(5)(ii) L234220-L234227"],
    "AR": ["9903.06.10 (j)(8)(i) list L235134-L235151", "9903.06.11 (j)(8)(ii) L235153-L235160"],
    "BD": ["9903.06.12 (j)(9)(i) list L235175-L235191", "9903.06.13 (j)(9)(ii) L235193-L235198"],
    "TW": ["9903.06.14 (j)(10)(i) list L235205-L235227", "9903.06.15 (j)(10)(ii) L235229-L235246"],
    "ID": ["9903.06.16 (j)(11)(i) list L235253-L235282", "9903.06.17 (j)(11)(ii) L235284-L235287"],
    "EC": ["9903.06.18 (j)(12)(i) list L235302-L235331", "9903.06.19 (j)(12)(ii) L235333-L235336"],
    "JO": ["9903.06.20 (j)(13)(i) list L235359-L235781", "9903.06.21 (j)(13)(ii) L235783-L235788"],
}

out = {"_source": {
    "revision": "2026HTSRev21",
    "note": "Ch.99 subch. III U.S. note 52, L233408-L235824; heading rows L239230-L240371",
    "authority": "Section 301, forced-labor import-ban investigations of 60 economies: USTR final action 2026-07-23, FR Doc 2026-15181 (published 2026-07-28); CBP CSMS #69326983",
    "effective": "goods entered (or withdrawn from warehouse) for consumption on/after 12:01 a.m. ET 2026-07-24 (CR 2026 Rev 13; CSMS #69326983)",
    "in_transit": "9903.05.85: loaded on a vessel and in transit on the final mode before 12:01 a.m. ET 2026-07-24 AND entered before 12:01 a.m. ET 2026-07-28 -> no note 52 duty (row L239977). Vessel only.",
    "general_exemptions": "9903.05.85 in-transit; .86 note 52(b) list L233451-L233642 (859 codes, prefix match); .87 (c) 16 particular articles L233644-L233691; .88 (d) civil aircraft (GN 6 criteria) list L233715-L233832; .89 (e) pharmaceutical-application list L233854-L234012; .90 (f) Section 232 goods and patented pharma L234014-L234045; .91 donations; .92 informational materials",
    "all_in_rule": "52(k) L235798-L235811: target 10% (EU, TW) or 12.5% (JP, KR, CH). If the column-1 rate (AVE = column-1 duty / customs value for specific or compound rates; for KR also a claimed column-1 Special rate) is below target, additional = target - column-1; otherwise the 'at or above' heading applies with no additional duty.",
    "stacking": "52(a) L233415-L233417: also subject to any additional duty in subchapter III or IV (Section 301 China, note 50 Brazil, note 51 Canada, note 43 drones, note 41 quartz, AD/CVD). FTA/GSP and subchapter II claims still pay (L233418-L233420), except USMCA duty-free CA/MX (g)/(h) and CAFTA-DR textiles (i). Never with 232 goods (52(f)).",
    "built_by": "pipeline/build_note52_json.py",
    "checked": "2026-10-28"}}

for h in sorted(k for k in rows if "9903.05.20" <= k <= "9903.05.84"):
    r = rows[h]
    name = re.search(r"articles the product of (.*?), (?:with an|as provided)", r["description"]).group(1)
    iso = ISO[name]
    g = r["general"].strip()
    plus = re.search(r"\+ ?([\d.]+)%", g)
    if plus:
        rec = {"heading": h, "rate_pct": float(plus.group(1)), "rule": "additive", "line": line_of.get(h)}
    elif re.fullmatch(r"[\d.]+%", g):
        rec = {"heading_below_target": h, "target_pct": float(g[:-1]), "line_below": line_of.get(h)}
    else:
        rec = {"heading_at_or_above_target": h, "line_at_or_above": line_of.get(h)}
    if iso in out:  # second row of an all-in pair
        out[iso].update(rec)
        out[iso]["rule"] = "all_in"
        continue
    rec.update({
        "country": re.sub(r"^(the |a member state of the )", "", name),
        "effective": "2026-07-24",
        "date_key": "entry date (in-transit relief 9903.05.85)",
        "column2": "+12.5% also on column-2 rate" if "+" in (r["other"] or "") else "no additional on column-2 rate",
        "row_exceptions": re.search(r"Except for products described in headings (.*?), articles", r["description"]).group(1),
        "country_specific_exemptions": SPECIFIC.get(iso, []),
    })
    out[iso] = rec

for iso in ("EU", "JP", "KR", "CH", "TW"):
    e = out[iso]
    e["notes"] = (f"all-in: column-1 + additional = {e['target_pct']}% when column-1 < {e['target_pct']}% "
                  f"(heading {e['heading_below_target']}); otherwise {e['heading_at_or_above_target']}, no additional "
                  "(52(k) L235798-L235811)")
out["EU"]["members"] = EU27
for iso in EU27:
    out[iso] = {"see": "EU", "heading_below_target": "9903.05.39", "heading_at_or_above_target": "9903.05.38",
                "target_pct": 10.0, "rule": "all_in"}
out["CA"]["notes"] = "Stacks with note 51 (9903.03.12-.14, +50% on listed goods, which has no USMCA carve-out)."
out["MX"]["notes"] = "USMCA duty-free entries (including S/S+ lines) take 9903.05.94 instead: no note 52 duty."
out["BR"]["notes"] = "Stacks with note 50 9903.05.01 +25% (both additive; each has its own exemption lists)."
out["CN"]["notes"] = "Stacks with Section 301 notes 20/31. Hong Kong is a separate heading (HK, 9903.05.43); Macau is not listed."
out["RU"]["notes"] = "Only note 52 row whose Other (column 2) rate also carries +12.5% (row L239778); Russia is a column-2 country."
out["SV"]["notes"] = ("Heading row 9903.05.37 names only .85-.92 as exceptions, but note 52(i) and (j)(7) add .95 and "
                      ".06.07-.09 (row L239434 vs note L234057, L234691). Apply the note.")
out["GT"]["notes"] = ("Heading row 9903.05.40 names only .85-.92 as exceptions, but note 52(i) and (j)(6) add .95 and "
                      ".06.04-.06 (row L239465 vs note L234057, L234239). Apply the note.")
out["_not_listed"] = ("Origins with no row here (for example AF, NP, ET, KE, UA, IR, CU, KP, BY, MO, and Liechtenstein) "
                      "pay no note 52 duty.")
dest = ROOT / "references/note52_country_rates.json"
dest.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
print(len([k for k, v in out.items() if not k.startswith("_") and "see" not in v]), "headed economies;", dest)
