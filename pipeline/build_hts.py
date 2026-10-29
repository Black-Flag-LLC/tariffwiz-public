"""Normalize the USITC JSON export into one tidy table + per-chapter shards.

In:  data/raw/usitc/current/chNN.json
Out: data/build/hts.sqlite            (lines, special_rates)
     data/build/shards/chNN.json      (what the browser loads)
     data/build/parse_report.json     (rate strings we could not parse)

Every 10-digit statistical line inherits the duty rates of its 8-digit parent.
"""
import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "usitc" / "current"
OUT = ROOT / "data" / "build"

NUM = r"(\d+(?:\.\d+)?)"
# one component: "6.5%", "4.4¢/kg", "$1.03/kg", "37.5¢ each", "1.5¢/kg on drained weight"
COMP_PCT = re.compile(rf"^{NUM}\s*%$")
UNIT = r"(kg|g|liter|bbl|doz\.?|doz\. pr\.|pr\.|gross|each|article|head|m2|m3|m|t|No\.|pf\. liter|proof liter|thousand|1000|kg clean|clean kg)"
# "4.4¢/kg", "$1.03/kg", "37.5¢ each", "1.5¢/kg on drained weight", "1.7¢/kg on lead content"
COMP_SPEC = re.compile(rf"^(\$)?{NUM}\s*(¢)?\s*(?:/\s*|\s+(?=each))({UNIT})(?:\s+on\s+(.+))?$")


def clean(s):
    return re.sub(r"\s+", " ", (s or "").replace(" ", " ")).strip()


def parse_component(c):
    c = c.strip()
    if m := COMP_PCT.match(c):
        return {"type": "adv", "pct": float(m[1])}
    if m := COMP_SPEC.match(c):
        dollars = float(m[2]) / (100 if m[3] else 1)
        if not m[1] and not m[3]:
            return None
        part = {"type": "spec", "usd": round(dollars, 6), "per": m[4].strip()}
        if m[6]:
            part["basis"] = m[6].strip()  # e.g. "drained weight", "lead content"
        return part
    return None


def parse_rate(s):
    """Rate text -> {'kind': free|adv|spec|compound|text, 'parts': [...], 'raw': s}."""
    s = clean(s)
    if not s:
        return None
    if s.lower() == "free":
        return {"kind": "free", "parts": [], "raw": s}
    if s.rstrip(".").lower() == "no change":
        return {"kind": "nochange", "parts": [], "raw": s}
    # Ch. 99 additional duty: "The duty provided in the applicable subheading + 25%"
    if m := re.match(rf"^The duty provided in the applicable subheading(?:\s*\+\s*{NUM}\s*%)?$", s):
        return {"kind": "additional", "parts": [{"type": "adv", "pct": float(m[1] or 0)}], "raw": s}
    # fractions: "33 1/3%"
    s_num = re.sub(r"(\d+)\s+(\d)/(\d)(?=\s*%)", lambda m: f"{int(m[1]) + int(m[2]) / int(m[3]):.6g}", s)
    if s_num != s:
        r = parse_rate(s_num)
        return r and {**r, "raw": s}
    parts = [parse_component(p) for p in re.split(r"\s*\+\s*", s)]
    if parts and all(parts):
        kinds = {p["type"] for p in parts}
        kind = "compound" if len(parts) > 1 else kinds.pop()
        return {"kind": kind, "parts": parts, "raw": s}
    return {"kind": "text", "parts": [], "raw": s}


SPECIAL_GROUP = re.compile(r"(.+?)\s*\(([A-Z0-9+*,\s]+)\)")


def parse_special(s):
    """'Free (AU,BH,..) 8.8¢/liter (JO)' -> [{'program': 'AU', 'rate': {...}}, ...]."""
    s = clean(s)
    out = []
    for rate_txt, progs in SPECIAL_GROUP.findall(s):
        rate = parse_rate(rate_txt)
        for p in re.split(r"[,\s]+", progs):
            if p:
                out.append({"program": p, "rate": rate})
    return out


REF_99 = re.compile(r"99\d\d\.\d\d\.\d\d")


def build():
    rows = []
    for f in sorted(RAW.glob("ch*.json")):
        rows += json.loads(f.read_text(encoding="utf-8") or "[]")

    lines, unparsed = [], Counter()
    stack = []          # description path by indent
    parent8 = None      # last 8-digit line with rates (for stat inheritance)
    for r in rows:
        indent = int(r["indent"] or 0)
        desc = clean(r["description"])
        stack = stack[:indent] + [desc]
        code = clean(r["htsno"])
        if not code:
            continue
        digits = code.replace(".", "")
        g, sp, o = clean(r["general"]), clean(r["special"]), clean(r["other"])
        if len(digits) == 8 or g or o:
            parent8 = {"code": code, "general": g, "special": sp, "other": o}
        inherits = len(digits) == 10 and not (g or o) and parent8 and digits.startswith(
            parent8["code"].replace(".", ""))
        if inherits:
            g, sp, o = parent8["general"], parent8["special"], parent8["other"]
        refs = sorted({m for fn in (r["footnotes"] or []) for m in REF_99.findall(fn.get("value", ""))})
        rec = {
            "code": code,
            "digits": digits,
            "chapter": digits[:2],
            "indent": indent,
            "desc": desc,
            "path": " > ".join(x for x in stack[:-1] if x),
            "units": r["units"] or [],
            "general": parse_rate(g),
            "special": parse_special(sp),
            "other": parse_rate(o),
            "special_raw": sp,
            "ch99_refs": refs,
            "footnotes": [clean(fn.get("value")) for fn in (r["footnotes"] or [])],
            "rate_from": parent8["code"] if inherits else None,
        }
        for k in ("general", "other"):
            if rec[k] and rec[k]["kind"] == "text" and rec["chapter"] not in ("98", "99"):
                unparsed[rec[k]["raw"]] += 1
        lines.append(rec)

    OUT.mkdir(parents=True, exist_ok=True)
    db = OUT / "hts.sqlite"
    db.unlink(missing_ok=True)
    con = sqlite3.connect(db)
    con.execute("""create table lines(code text primary key, digits text, chapter text, indent int,
        descr text, path text, units text, general text, special text, other text,
        special_raw text, ch99_refs text, footnotes text, rate_from text)""")
    con.executemany("insert or replace into lines values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
        (l["code"], l["digits"], l["chapter"], l["indent"], l["desc"], l["path"],
         json.dumps(l["units"]), json.dumps(l["general"]), json.dumps(l["special"]),
         json.dumps(l["other"]), l["special_raw"], json.dumps(l["ch99_refs"]),
         json.dumps(l["footnotes"]), l["rate_from"]) for l in lines])
    con.commit()
    con.close()

    shards = OUT / "shards"
    shards.mkdir(exist_ok=True)
    by_ch = {}
    for l in lines:
        by_ch.setdefault(l["chapter"], []).append(l)
    for ch, ls in by_ch.items():
        (shards / f"ch{ch}.json").write_text(json.dumps(ls, ensure_ascii=False, separators=(",", ":")),
                                             encoding="utf-8")

    rated = [l for l in lines if l["general"] and l["chapter"] not in ("98", "99")]
    parsed = [l for l in rated if l["general"]["kind"] != "text"]
    report = {
        "lines": len(lines),
        "lines_10digit": sum(len(l["digits"]) == 10 for l in lines),
        "with_general_rate": len(rated),
        "general_parsed_pct": round(100 * len(parsed) / max(1, len(rated)), 2),
        "with_ch99_refs": sum(bool(l["ch99_refs"]) for l in lines),
        "top_unparsed": unparsed.most_common(40),
    }
    (OUT / "parse_report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    print(json.dumps({k: v for k, v in report.items() if k != "top_unparsed"}, indent=1))
    print("unparsed samples:", report["top_unparsed"][:15])


if __name__ == "__main__":
    sys.exit(build())
