"""Build app/public/data/rules.json — every Chapter 99 measure the engine applies, as data.

Inputs (all produced by other pipeline scripts or the research in .claude/skills/us-import-duty):
  data/build/hts_rev21.txt                            Rev 21 text (pdftotext -layout -enc UTF-8)
  data/build/rules/s301_raw.json                      python -I pipeline/extract_301.py --json ...
  .claude/skills/us-import-duty/references/section232_lists.json
  .claude/skills/us-import-duty/references/note52_country_rates.json
Also copies data/build/shards/chNN.json -> app/public/data/hts/.

Line ranges below are Rev 21 line numbers in hts_rev21.txt; each comes from the references.
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REF = ROOT / ".claude" / "skills" / "us-import-duty" / "references"
TXT = ROOT / "data" / "build" / "hts_rev21.txt"
OUT = ROOT / "app" / "public" / "data"

# codes appear as 4/6/8/10 digits, and 10-digit ones sometimes as "XXXX.XX.XXXX"
CODE = re.compile(r"(?<![\d.])(\d{4}(?:\.\d{2}(?:\.\d{2}(?:\.\d{2})?|\.\d{4})?)?)(?![\d.])")


def norm_code(c):
    p = c.split(".")
    return ".".join(p[:2] + [p[2][:2], p[2][2:]]) if len(p) == 3 and len(p[2]) == 4 else c
CODELINE = re.compile(r"^\s*(\d{4}(\.\d{2}(\.\d{2,4})?)?\s*)+$")
LINES = TXT.read_text(encoding="utf-8").split("\n")


def codes_between(a, b):
    """Codes on pure code-list lines in [a, b] (1-based, inclusive). Lists mix 4-10 digits."""
    out = []
    for n in range(a, b + 1):
        t = re.sub(r"^\s*U\.S\. Notes \(con\.\)", "", LINES[n - 1])  # running header glued to a code line
        if CODELINE.match(t):
            out += [norm_code(c) for c in CODE.findall(t)]
    return sorted(set(out))


def ranges_in(text):
    return [(int(a), int(b)) for a, b in re.findall(r"L(\d{6})\s*[-–]\s*L?(\d{6})", text or "")]


EU27 = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV",
        "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"]


def build():
    raw301 = ROOT / "data" / "build" / "rules" / "s301_raw.json"
    raw301.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([sys.executable, "-I", str(ROOT / "pipeline" / "extract_301.py"), "--json", str(raw301)],
                   check=True, stdout=subprocess.DEVNULL)
    s301 = json.loads(raw301.read_text(encoding="utf-8"))
    l232 = json.loads((REF / "section232_lists.json").read_text(encoding="utf-8"))["lists"]
    n52 = json.loads((REF / "note52_country_rates.json").read_text(encoding="utf-8"))

    lists = {}

    # --- Section 301 China (notes 20, 31) ------------------------------------------------
    live_list_headings = ["9903.88.01", "9903.88.02", "9903.88.03", "9903.88.04", "9903.88.15"]
    note31 = [h for h, v in s301["headings"].items() if h.startswith(("9903.91", "9903.92.10")) and v["rate_add_pct"]]
    s301_measures = []
    for h in live_list_headings + note31:
        meta = s301["headings"][h]
        key = f"s301:{h}"
        lists[key] = sorted(set(s301["coverage8"].get(h, []) + s301["coverage10"].get(h, [])))
        for d in s301["described"].get(h, []):
            lists[key].append(d["subheading"])
        lists[key] = sorted(set(lists[key]))
        s301_measures.append({
            "heading": h, "pct": meta["rate_add_pct"], "from": meta["from"], "to": meta["to"],
            "suspended": meta["suspended"], "list": key,
            "carve10": s301["carve_out10"].get(h, []) + [c for d in s301["described"].get(h, []) for c in d["except10"]],
            "note": "31" if h.startswith("9903.9") else "20",
        })
    exclusions = []
    for k, ex in s301["exclusions"].items():
        if ex.get("expired_note") or not ex.get("to"):
            continue
        # bare items exclude every product under the code; described items need the user to confirm the description
        items = [{"codes": sorted({c for seg in it["segments"] for c in seg["codes"]}), "bare": bool(it.get("bare")),
                  "text": (it.get("text") or "")[:400], "line": it.get("line")} for it in ex["items"]]
        exclusions.append({"heading": ex["heading"], "from": ex.get("from"), "to": ex["to"], "items": items,
                           "subdivision": k, "lines": ex["lines"]})

    # --- Note 52 forced-labor 301 ------------------------------------------------------
    lists["n52:b"] = codes_between(233451, 233642)   # 9903.05.86 general exemption list
    lists["n52:d_aircraft"] = codes_between(233715, 233832)
    lists["n52:e_pharma"] = codes_between(233854, 234012)
    countries52 = {}
    for iso, v in n52.items():
        if iso.startswith("_"):
            continue
        v = dict(n52[v["see"]], **{k: x for k, x in v.items() if k != "see"}) if "see" in v else v
        exempt = []
        for i, ex in enumerate(v.get("country_specific_exemptions", [])):
            rs = ranges_in(ex)
            if rs:
                key = f"n52:{iso}:{i}"
                lists[key] = sorted({c for a, b in rs for c in codes_between(a, b)})
                exempt.append({"heading": ex.split()[0], "list": key, "text": ex})
        countries52[iso] = {
            "rule": v["rule"], "pct": v.get("rate_pct"), "heading": v.get("heading"),
            "target": v.get("target_pct"), "below": v.get("heading_below_target"),
            "atOrAbove": v.get("heading_at_or_above_target"), "exempt": exempt,
            "usmcaExempt": iso in ("CA", "MX"),
        }

    # --- Note 50 Brazil 301 --------------------------------------------------------------
    lists["n50:ii"] = codes_between(232359, 232549)
    lists["n50:iv_aircraft"] = codes_between(232612, 232731)
    lists["n50:v_pharma"] = codes_between(232755, 232913)

    # --- Note 51 Canada 338 --------------------------------------------------------------
    lists["n51:12"] = codes_between(232985, 233010)
    lists["n51:13"] = codes_between(233014, 233026)
    lists["n51:14"] = codes_between(233047, 233184)
    lists["n51:16_aircraft"] = codes_between(233235, 233406)

    # --- Section 232 lists (extracted with -raw by the research; layout text interleaves) --
    for k, v in l232.items():
        lists[f"s232:{k}"] = sorted(set(v["codes"]))

    # --- Russia note 30 (35% / 70% in lieu of column 2) --------------------------------------
    r30 = json.loads((REF / "russia_note30_lists.json").read_text(encoding="utf-8"))
    lists["n30:b"] = sorted(set(r30["note30b_subheadings"]))
    lists["n30:d"] = sorted(set(r30["note30d_subheadings"]))

    # --- Note 41 quartz surface products safeguard (Section 201) ----------------------------
    lists["n41:qsp"] = ["6810.99.00.20", "6810.99.00.40", "7020.00.60.00"]
    qsp_exempt = ("CA MX AU CO CR DO SV GT HN IL NI PA PE SG KR "  # 41(c)(i)-(ii), L232144-232148
                  "AF AL DZ AO AM AZ BZ BJ BT BO BA BW BR BF MM BI KH CM CV CF TD KM CG CD CI DJ DM EC EG ER SZ ET FJ GA "
                  "GM GE GH GD GN GW GY HT ID IQ JM JO KZ KE KI XK KG LB LS LR MG MW MV ML MR MU MD MN ME MZ NA NP NE NG "
                  "MK PK PG PY PH RW LC VC WS ST SN RS SL SB SO ZA SS LK SR TZ TL TG TO TN TV UG UA UZ VU YE ZM ZW "  # (iii)
                  "AG AW BS BB VG CW MS KN TT").split()  # (iv) CBERA

    # --- researched extras (references/*.json) ------------------------------------------
    qs = json.loads((REF / "quotas_safeguards.json").read_text(encoding="utf-8"))
    sg = qs["safeguards_subchIV"]
    sg_brackets = [{"heading": v["heading"], "codes": v["baseCodes"], "min": v["minUSD"], "max": v["maxUSD"], "unit": v["unit"],
                    "usd": (v["add"].get("usdPerUnit") or 0)} for g in sg["groups"] for v in g.get("valueBased", [])]
    trq_lines = {l["heading"]: l["rate"].get("raw", "") for l in qs["fta_trq"]["lines"] if not l["shadedExpired"]}
    trq_ptrs = {code: [{"program": p["program"], "headings": [h for h in p["headings"] if h in trq_lines]}
                       for p in ptrs if any(h in trq_lines for h in p["headings"])]
                for code, ptrs in qs["fta_trq"]["baseIndex"].items()}
    trq_ptrs = {k: v for k, v in trq_ptrs.items() if v}
    de = json.loads((REF / "described_exemptions.json").read_text(encoding="utf-8"))
    described = [{"id": it["id"], "heading": it["heading"], "note": it["note"], "country": it.get("country"), "hts": it["hts"],
                  "question": it["question"], "autoYes": (it.get("statHints") or {}).get("autoYes", []),
                  "autoNo": (it.get("statHints") or {}).get("autoNo", [])} for it in de["items"]]
    nic = json.loads((REF / "nicaragua_301.json").read_text(encoding="utf-8"))
    n232 = json.loads((REF / "narrow_232.json").read_text(encoding="utf-8"))
    for k in ("n16_k_parts", "n16_g_motorcycle_candidates"):
        lists[f"s232:{k}"] = sorted(set(n232["lists"][k]["codes"]))
    shaded_f = ROOT / "data" / "build" / "shaded_headings.json"
    expired = json.loads(shaded_f.read_text(encoding="utf-8"))["shaded"] if shaded_f.exists() else []

    cot = json.loads((REF / "cotton_fee.json").read_text(encoding="utf-8"))
    cotton = {k: float(v["cents_per_kg"]) for k, v in cot["table"].items()}
    ad = json.loads((REF / "adcvd.json").read_text(encoding="utf-8"))
    from collections import Counter, defaultdict
    by_prefix = defaultdict(Counter)
    for o in ad["orders"]:
        by_prefix[o["case"][:5]][o["country"]] += 1
    fixed = 0
    for o in ad["orders"]:
        top, n = by_prefix[o["case"][:5]].most_common(1)[0]
        if o["country"] != top and n >= 2:
            o["country"] = top
            fixed += 1
    print("adcvd country fixes:", fixed)
    adcvd = [{"case": o["case"], "type": o["type"], "country": o["country"],
              "product": __import__("re").sub(r"\[[A-Za-z]+\]", "", o["product"])[:120],
              "hts": sorted({h.replace(".", "")[:10] for h in o.get("hts", [])}),
              "fr": (o.get("source", {}).get("scope") or {}).get("fr_doc")} for o in ad["orders"] if o.get("hts")]

    rules = {
        "meta": {"revision": "2026HTSRev21", "checked": "2026-10-28",
                 "note": "Built by pipeline/build_rules.py from Rev 21 text + us-import-duty references"},
        "groups": {"EU": EU27, "column2": ["BY", "CU", "KP", "RU"]},
        "s301": {"origin": ["CN"], "measures": s301_measures, "exclusions": exclusions},
        "n52": {"from": "2026-07-24", "inTransit": {"loadedBefore": "2026-07-24", "enteredBefore": "2026-07-28",
                                                    "modes": ["ocean"], "heading": "9903.05.85"},
                "countries": countries52},
        "n50": {"heading": "9903.05.01", "pct": 25, "origin": ["BR"], "from": "2026-07-22",
                "inTransit": {"loadedBefore": "2026-07-22", "enteredBefore": "2026-07-29", "modes": ["ocean"],
                              "heading": "9903.05.02"},
                "exempt": [{"heading": "9903.05.03", "list": "n50:ii"}]},
        "n51": {"origin": ["CA"], "from": "2026-08-22", "pct": 50,
                "measures": [{"heading": "9903.03.12", "list": "n51:12", "blockedBy232": False},
                             {"heading": "9903.03.13", "list": "n51:13", "blockedBy232": True},
                             {"heading": "9903.03.14", "list": "n51:14", "blockedBy232": False}]},
        "n30": {"origin": ["RU"], "measures": [{"heading": "9903.90.08", "pct": 35, "list": "n30:b"},
                                                {"heading": "9903.90.09", "pct": 70, "list": "n30:d"}]},
        "n41": {"list": "n41:qsp", "exempt": sorted(set(qsp_exempt)),
                "years": [{"from": "2026-08-15", "in": 25, "over": 50}, {"from": "2027-08-15", "in": 23, "over": 49},
                          {"from": "2028-08-15", "in": 21, "over": 48}, {"from": "2029-08-15", "in": 19, "over": 47}],
                "to": "2030-08-14"},
        "sg": {"exempt": sg["exemptOrigins"], "brackets": sg_brackets},
        "trq": {"pointers": trq_ptrs, "lines": trq_lines},
        "described": described,
        "nic": {"heading": nic["heading"], "origin": nic["origin"],
                "schedule": [{"from": r["from"], "to": r["to"], "pct": r["rate"]["pct"]} for r in nic["rateSchedule"]]},
        "expired": expired,
        "cotton": cotton,
        "adcvd": adcvd,
        "programs": {k: {"name": v["name"], "countries": v.get("countries", []), "in_force": v.get("in_force", False)}
                     for k, v in json.loads((REF / "special_programs.json").read_text(encoding="utf-8"))["programs"].items()},
        "lists": lists,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "rules.json").write_text(json.dumps(rules, separators=(",", ":")), encoding="utf-8")
    hts = OUT / "hts"
    hts.mkdir(exist_ok=True)
    for f in (ROOT / "data" / "build" / "shards").glob("ch*.json"):
        shutil.copy(f, hts / f.name)
    # search index: every rate-bearing leaf line (10-digit, or 8-digit without stat suffixes)
    leaves = []
    for f in sorted((ROOT / "data" / "build" / "shards").glob("ch*.json")):
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
    (OUT / "search.json").write_text(json.dumps(leaves, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print("search leaves:", len(leaves), round((OUT / "search.json").stat().st_size / 1024), "KB")
    # PGA flags (display only, loaded lazily by the app): references/pga_flags.json -> data/pga.json
    pga_f = REF / "pga_flags.json"
    if pga_f.exists():
        pga = json.loads(pga_f.read_text(encoding="utf-8"))
        (OUT / "pga.json").write_text(json.dumps({"flags": pga["flags"], "hts": pga["hts"],
                                                  "checked": pga.get("_source", {}).get("checked", "")},
                                                 ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print("pga codes:", len(pga["hts"]))
    sizes = {k: len(v) for k, v in lists.items()}
    print(json.dumps({"lists": len(lists), "codes": sum(sizes.values()),
                      "rules_kb": round((OUT / 'rules.json').stat().st_size / 1024)}, indent=1))
    print({k: n for k, n in sizes.items() if k.startswith(("n5", "n50", "n51"))})


if __name__ == "__main__":
    build()
