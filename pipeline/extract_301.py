"""Extract Section 301 (China) coverage from the HTSUS Rev 21 text.

Stdlib only. Run from anywhere with:  python -I pipeline/extract_301.py [--json OUT] [--date YYYY-MM-DD]

Sources (paths relative to the project root, found from this file's location):
  data/build/hts_rev21.txt             pdftotext -layout of the HTSUS 2026 Rev 21 PDF
  data/raw/usitc/current/ch99.json     structured Chapter 99 rows (heading rates and date windows)
  data/build/hts.sqlite                table `lines` (codes and footnote ch99_refs) for cross-checks

What it extracts
  * U.S. note 20 (9903.88.xx): the 8-digit lists for 9903.88.01/.02/.03/.15/.16, the described
    items with 10-digit carve-outs for 9903.88.04 / 9903.88.15(ii) / 9903.88.16(ii), and every
    exclusion subdivision (h)...(www) with its 10-digit stat numbers, date-split variants and
    live/expired status.
  * U.S. note 31 (9903.91.xx, 9903.92.10): the code list for every heading.
It prints counts per heading, list overlaps, validity against hts.sqlite and agreement with the
footnote ch99_refs.
"""
import argparse
import datetime as dt
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TXT = ROOT / "data" / "build" / "hts_rev21.txt"
CH99 = ROOT / "data" / "raw" / "usitc" / "current" / "ch99.json"
DB = ROOT / "data" / "build" / "hts.sqlite"

# ---------------------------------------------------------------- patterns
# Page furniture repeated on every PDF page; must be skipped inside lists.
NOISE = re.compile(
    r"^\s*(Harmonized Tariff Schedule of the United States Revision \d+ \(\d{4}\)"
    r"|Annotated for Statistical Reporting Purposes|XXII|99\s*-\s*III\s*-\s*\d+"
    r"|U\.S\. Notes \(con\.\))\s*$")
C8 = r"\d{4}\.\d{2}\.\d{2}"            # 8-digit subheading, e.g. 8401.10.00
C10 = r"\d{4}\.\d{2}\.\d{4}"           # 10-digit stat number as printed, e.g. 8517.62.0090
RE_C8 = re.compile(r"(?<![\d.])" + C8 + r"(?![\d])")
RE_C10 = re.compile(r"(?<![\d.])" + C10 + r"(?![\d])")
RE_ODD = re.compile(r"(?<![\d.])\d{4}\.\d{3}\.\d{4}(?![\d])")  # typo form, e.g. 9403.770.4001
# A "grid" line: nothing but 8-digit codes (the 4-across tables of note 20 / 31(b)).
RE_GRID = re.compile(r"^\s*(?:" + C8 + r"\s*)+$")
RE_COMPILER = re.compile(r"\[Compiler['’]s notes?:?.*?\]", re.S | re.I)
MONTHS = {m: i for i, m in enumerate(
    ["January", "February", "March", "April", "May", "June", "July", "August",
     "September", "October", "November", "December"], 1)}
RE_DATE = r"(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})"


def pdate(m):
    return dt.date(int(m[3]), MONTHS[m[1]], int(m[2]))


def code8(c):   # '8401.10.00' -> '8401.10.00'
    return c


def code10(c):  # '8517.62.0090' -> '8517.62.00.90' (sqlite form)
    return c[:10] + "." + c[10:]


# ---------------------------------------------------------------- load
def load_lines():
    return TXT.read_text(encoding="utf-8", errors="replace").split("\n")


def find_line(L, pat, start=0, end=None):
    rx = re.compile(pat)
    for i in range(start, end if end is not None else len(L)):
        if rx.search(L[i]):
            return i
    raise SystemExit("anchor not found: " + pat)


def letter_labels():
    a = [chr(c) for c in range(ord("a"), ord("z") + 1)]
    return a + [x * 2 for x in a] + [x * 3 for x in a]


def split_subdivisions(L, start, end):
    """Return {label: (first_idx, last_idx)} for lettered subdivisions (a)...(www) of a note.

    Roman sub-items (i)/(ii)/(v)/(x) collide with letters, so a label is only accepted if it is
    one of the next few expected letters (labels hh-kk do not exist in Rev 21; '(II)' is a
    misprint of '(ll)'; '(mmm)The' has no space)."""
    seq = letter_labels()
    rx = re.compile(r"^\s{0,10}(?:\d{1,2}\.\s+)?\(([A-Za-z]{1,3})\)\s*\S")
    found, pos = [], 0
    for i in range(start, end):
        m = rx.match(L[i])
        if not m:
            continue
        lab = "ll" if m[1] == "II" else m[1].lower()
        if lab in seq[pos:pos + 6]:
            found.append((lab, i))
            pos = seq.index(lab) + 1
    out = {}
    for k, (lab, i) in enumerate(found):
        j = found[k + 1][1] - 1 if k + 1 < len(found) else end - 1
        out[lab] = (i, j)
    return out


def body(L, a, b):
    """Lines a..b with page furniture removed."""
    return [(i, L[i]) for i in range(a, b + 1) if L[i].strip() and not NOISE.match(L[i])]


def grid_codes(L, a, b):
    codes, lines = [], 0
    for i, s in body(L, a, b):
        if RE_GRID.match(s):
            codes += RE_C8.findall(s)
            lines += 1
    return codes, lines


def numbered_items(L, a, b, style):
    """Collect items. style 'dot' = '1. text', 'paren' = '(1) text'. Returns [(n, first_line, text)]."""
    rx = re.compile(r"^\s*(\d+)\.\s" if style == "dot" else r"^\s*\((\d+)\)\s*")
    stop = re.compile(r"^\s*(Notwithstanding|Products of China|The additional duties)")
    items, cur = [], None
    for i, s in body(L, a, b):
        m = rx.match(s)
        if m:
            cur = [int(m[1]), i, s[m.end():].strip()]
            items.append(cur)
        elif stop.match(s):
            cur = None
        elif cur is not None:
            cur[2] += " " + s.strip()
    return [tuple(x) for x in items]


def described_item(text):
    """'..., provided for in [subheading] 9401.71.00, except for ... 9401.71.0001, 9401.71.0005 ...'"""
    t = RE_COMPILER.sub(" ", text)
    base = RE_C8.findall(t.split("except", 1)[0]) or RE_C8.findall(t)
    exc = []
    if "except" in t:
        tail = t.split("except", 1)[1]
        # second 'except' clause (e.g. 4A item 5) also lists carve-outs
        exc = [code10(c) for c in RE_C10.findall(tail)]
    odd = RE_ODD.findall(text)
    return {"subheading": base[0] if base else None, "except10": exc, "typos": odd}


def date_segments(text):
    """Split an exclusion item into code groups with validity windows.
    '5603.92.0090 prior to July 1, 2022; 5603.92.0070 or 5603.92.0095 effective July 1, 2022'"""
    segs = []
    inner = text
    m = re.search(r"\((described in .*)\)\s*$", text, re.S)
    if m:
        inner = m[1]
    for part in re.split(r";", inner):
        codes = RE_C10.findall(part) or RE_C8.findall(part)
        if not codes:
            continue
        frm = to = None
        mp = re.search(r"prior to " + RE_DATE, part)
        mt = re.search(r"through " + RE_DATE, part)
        me = re.search(r"effective " + RE_DATE, part)
        if mp:
            to = pdate(mp) - dt.timedelta(days=1)
        if me:
            frm = pdate(me)
        if mt:
            to = pdate(mt)
        segs.append({"codes": [code10(c) if len(c) == 12 else c for c in codes], "from": frm, "to": to})
    # an open-ended 'effective A' segment is closed by a later 'effective B' segment
    for k, sg in enumerate(segs):
        if sg["from"] and sg["to"] is None:
            later = [x["from"] for x in segs[k + 1:] if x["from"] and x["from"] > sg["from"]]
            if later:
                sg["to"] = min(later) - dt.timedelta(days=1)
    for sg in segs:
        sg["from"] = sg["from"].isoformat() if sg["from"] else None
        sg["to"] = sg["to"].isoformat() if sg["to"] else None
    return segs


# ---------------------------------------------------------------- ch99 headings
def load_ch99():
    rows = json.loads(CH99.read_text(encoding="utf-8"))
    out = {}
    for r in rows:
        h = r.get("htsno") or ""
        if not h.startswith("9903."):
            continue
        g = r.get("general") or ""
        m = re.search(r"(?:\+|plus)\s*(?:a duty of\s*)?(\d+(?:\.\d+)?)\s*%", g)
        d = r.get("description") or ""
        win_from = win_to = None
        mf = re.search(r"on or after " + RE_DATE, d)
        if mf:
            win_from = pdate(mf)
        mt = re.search(r"(through|before|prior to) " + RE_DATE, d)
        if mt and re.search(r"(Effective|effective) with respect to entries", d[:200]):
            mm = re.search(r"(through|before|prior to) " + RE_DATE, d)
            dd = dt.date(int(mm[4]), MONTHS[mm[2]], int(mm[3]))
            win_to = dd if mm[1] == "through" else dd - dt.timedelta(days=1)
        out[h] = {"rate_add_pct": float(m[1]) if m else (0.0 if "applicable subheading" in g else None),
                  "general": g, "from": win_from, "to": win_to, "desc": d,
                  "suspended": "suspended" in (d + json.dumps(r.get("footnotes"))).lower()}
    return out


# ---------------------------------------------------------------- note 20
LIST_SUBDIV = {"b": "9903.88.01", "d": "9903.88.02", "f": "9903.88.03", "s": "9903.88.15", "u": "9903.88.16"}
INTRO_SUBDIV = {"a": "9903.88.01", "c": "9903.88.02", "e": "9903.88.03", "g": "9903.88.04", "r": "9903.88.15"}
LIST_NAMES = {
    "9903.88.01": "List 1 ($34B), +25%",
    "9903.88.02": "List 2 ($16B), +25%",
    "9903.88.03": "List 3 ($200B), +25%",
    "9903.88.04": "List 3 described items with 10-digit carve-outs, +25%",
    "9903.88.09": "List 3 in-transit window at 10% (May 10 - Jun 14, 2019 entries)",
    "9903.88.15": "List 4A, +7.5%",
    "9903.88.16": "List 4B, +15% (suspended)",
}


def parse_note20(L, ch99):
    s = find_line(L, r"^20\.\s+\(a\)\s+For the purposes of heading 9903\.88\.01")
    e = find_line(L, r"^\s*\(21\)\s*\(a\)", s)
    sub = split_subdivisions(L, s, e)
    res = {"range": (s + 1, e), "subdivisions": {k: (a + 1, b + 1) for k, (a, b) in sub.items()},
           "lists": {}, "described": {}, "exclusions": {}, "excl_map": {}}

    # 8-digit lists (and the (ii) described items of 4A/4B)
    for lab, head in LIST_SUBDIV.items():
        a, b = sub[lab]
        split = None
        if lab in ("s", "u"):
            split = find_line(L, r"^\s*\(?ii\)\s+the following products of China", a, b + 1)
        codes, nlines = grid_codes(L, a, (split - 1) if split else b)
        res["lists"][head] = {"codes": codes, "grid_lines": nlines, "lines": (a + 1, b + 1)}
        if split:
            res["described"][head] = [dict(n=n, line=i + 1, **described_item(t))
                                      for n, i, t in numbered_items(L, split, b, "dot")]
    a, b = sub["g"]
    res["described"]["9903.88.04"] = [dict(n=n, line=i + 1, **described_item(t))
                                      for n, i, t in numbered_items(L, a, b, "dot")]
    res["lists"]["9903.88.04"] = {"codes": [], "grid_lines": 0, "lines": (a + 1, b + 1)}

    # exclusion heading <-> subdivision map, read from the intro paragraphs (a)(c)(e)(g)(r)
    rx = re.compile(r"heading\s+(9903[.:]88\.\d\d)\s+and\s+U\.S\.\s+note\s+20\(([a-z]+)\)(?:\((i{1,3}|iv)\))?")
    for lab, base in INTRO_SUBDIV.items():
        a, b = sub[lab]
        txt = " ".join(x.strip() for _, x in body(L, a, min(b, a + 40)))
        for h, sd, rom in rx.findall(txt):
            key = sd + (f"({rom})" if rom else "")
            res["excl_map"].setdefault(key, {"heading": h.replace(":", "."), "bases": set()})
            res["excl_map"][key]["bases"].add(base)

    # exclusion subdivisions
    # (l) = 9903.88.09 rate provision; (z)-(gg) = 9903.88.21-.28 derived-rate carve-outs (not USTR exclusions)
    not_excl = set(LIST_SUBDIV) | set(INTRO_SUBDIV) | {"l", "t", "z", "aa", "bb", "cc", "dd", "ee", "ff", "gg"}
    excl_labels = [k for k in sub if k not in not_excl]
    for lab in excl_labels:
        a, b = sub[lab]
        parts = [(lab, a, b)]
        # (sss)-(vvv) have roman parts (i)-(iv)
        rom = [(m[1], i) for i in range(a, b + 1)
               for m in [re.match(r"^\s*(?:\([a-z]{3}\)\s*)?\((i{1,3}|iv)\)\s+The U\.S\. Trade", L[i])] if m]
        if rom and lab in ("sss", "ttt", "uuu", "vvv"):
            parts = []
            for k, (r, i) in enumerate(rom):
                j = rom[k + 1][1] - 1 if k + 1 < len(rom) else b
                parts.append((f"{lab}({r})", i, j))
        for key, pa, pb in parts:
            head_txt = " ".join(x.strip() for _, x in body(L, pa, min(pb, pa + 12)))
            expired_flag = bool(re.search(r"Compiler['’]s note:\s*expired", head_txt))
            mh = re.search(r"as provided in heading (9903\.88\.\d\d)", head_txt)
            heading = (res["excl_map"].get(key) or res["excl_map"].get(lab) or {}).get("heading") or (mh[1] if mh else None)
            if heading is None:
                # fall back to ch99 descriptions 'U.S. note 20(x)'
                for h, info in ch99.items():
                    if re.search(r"note 20\(" + lab + r"\)", info["desc"]) and h.startswith("9903.88"):
                        heading = h
            items = []
            for n, i, t in numbered_items(L, pa, pb, "paren"):
                t2 = RE_COMPILER.sub(" ", t)
                bare = bool(re.fullmatch(r"\s*" + C10 + r"\s*", t2))
                items.append({"n": n, "line": i + 1, "bare": bare, "segments": date_segments(t2),
                              "text": None if bare else t2[:160]})
            hinfo = ch99.get(heading, {})
            res["exclusions"][key] = {"heading": heading, "lines": (pa + 1, pb + 1), "expired_note": expired_flag,
                                      "from": hinfo.get("from"), "to": hinfo.get("to"), "items": items,
                                      "bases": sorted((res["excl_map"].get(key) or res["excl_map"].get(lab) or {}).get("bases", []))}
    return res


# ---------------------------------------------------------------- note 31
def parse_note31(L):
    s = find_line(L, r"^31\.\s+\(a\)\s+As provided in headings 9903\.91\.01")
    e = find_line(L, r"^32\.\s", s)
    marks = [(m[1], i) for i in range(s, e) for m in [re.search(r"Heading (9903\.91\.\d\d) applies to", L[i])] if m]
    out = {"range": (s + 1, e), "headings": {}}
    for k, (h, i) in enumerate(marks):
        j = marks[k + 1][1] - 1 if k + 1 < len(marks) else e - 1
        # stop the segment at the next lettered subdivision line '(x)' with nothing else (e.g. '(f)', '(k)', '(l)')
        for t in range(i + 1, j + 1):
            if re.match(r"^\(([a-l])\)\s*$", L[t].strip()) or re.match(r"^\(([c-l])\) Heading", L[t].strip()):
                j = t - 1
                break
        txt = "\n".join(x for _, x in body(L, i, j))
        txt = RE_COMPILER.sub(" ", txt)
        if h == "9903.91.14":   # only (l)(i) sentence 1 carries the scope
            txt = txt.split("Heading 9903.91.14 shall not apply")[0]
        c10 = [code10(c) for c in RE_C10.findall(txt)]
        c8 = [c for c in RE_C8.findall(txt) if not c.startswith("9903.")]  # drop the heading's own number
        out["headings"][h] = {"lines": (i + 1, j + 1), "codes8": sorted(set(c8), key=c8.index),
                              "codes10": sorted(set(c10), key=c10.index)}
    return out


# ---------------------------------------------------------------- checks
def db_sets():
    con = sqlite3.connect(DB)
    c8, c10, refs = set(), set(), {}
    for code, digits, r in con.execute("select code, digits, ch99_refs from lines"):
        # an 8-digit line with a single stat suffix is printed only as its 10-digit row, so derive
        # the 8-digit set from prefixes as well
        if len(digits) >= 8:
            c8.add(code[:10])
        if len(digits) == 10:
            c10.add(code)
        if r and r != "[]":
            hs = [h for h in json.loads(r) if h.startswith(("9903.88", "9903.91", "9903.92"))]
            if hs:
                refs[code] = hs
    return c8, c10, refs


def resolve10(c10db, cov8, cov10, carve, heads):
    """For every 10-digit line, which (live) 301 headings cover it. Returns {code: [heads]}."""
    out = {}
    for code in c10db:
        hs = [h for h in heads if covered(code, h, cov8, cov10, carve)]
        if hs:
            out[code] = hs
    return out


def covered(code, head, cov8, cov10, carve):
    """Is sqlite code (8 or 10 digit dotted) covered by heading per the extracted text?"""
    if code in cov10.get(head, set()):
        return True
    p8 = code[:10]
    if p8 in cov8.get(head, set()):
        return code not in carve.get(head, set())
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", help="write the extracted rules to this JSON file")
    ap.add_argument("--date", default="2026-10-28", help="entry date for live/expired status")
    args = ap.parse_args()
    asof = dt.date.fromisoformat(args.date)

    L = load_lines()
    ch99 = load_ch99()
    n20 = parse_note20(L, ch99)
    n31 = parse_note31(L)
    c8db, c10db, refs = db_sets()

    print(f"Note 20 lines {n20['range'][0]}-{n20['range'][1]}, {len(n20['subdivisions'])} lettered subdivisions")
    print(f"Note 31 lines {n31['range'][0]}-{n31['range'][1]}")
    print()
    print("== Product coverage (heading -> codes) ==")
    cov8, cov10, carve = defaultdict(set), defaultdict(set), defaultdict(set)
    rows = []
    for h, d in n20["lists"].items():
        cov8[h] |= set(d["codes"])
        rows.append((h, LIST_NAMES.get(h, ""), len(d["codes"]), len(set(d["codes"])), d["grid_lines"], d["lines"]))
    for h, items in n20["described"].items():
        for it in items:
            if it["subheading"]:
                cov8[h].add(it["subheading"])
                carve[h] |= set(it["except10"])
    for h, d in n31["headings"].items():
        cov8[h] |= set(d["codes8"])
        cov10[h] |= set(d["codes10"])
    # 9903.92.10 scope is in its heading text (8426.19.00)
    cov8["9903.92.10"].add("8426.19.00")

    print(f"{'heading':12} {'add%':>6} {'8-dig':>6} {'10-dig':>6} {'carve10':>7}  status@{asof}  text lines / name")
    allheads = sorted(set(cov8) | set(cov10))
    for h in allheads:
        info = ch99.get(h, {})
        st = "LIVE"
        if info.get("suspended"):
            st = "SUSPENDED"
        elif info.get("to") and asof > info["to"]:
            st = "EXPIRED"
        elif info.get("from") and asof < info["from"]:
            st = "FUTURE " + info["from"].isoformat()
        ln = (n20["lists"].get(h) or {}).get("lines") or (n31["headings"].get(h) or {}).get("lines") or ""
        print(f"{h:12} {info.get('rate_add_pct')!s:>6} {len(cov8[h]):6} {len(cov10[h]):6} {len(carve[h]):7}  {st:14} {ln} {LIST_NAMES.get(h, '')}")
    for h, items in n20["described"].items():
        for it in items:
            if it["typos"]:
                print(f"  note: {h} item {it['n']} (line {it['line']}) contains malformed code(s) {it['typos']}")

    print()
    print("== Exclusion subdivisions ==")
    live = 0
    for key, ex in n20["exclusions"].items():
        to, frm = ex["to"], ex["from"]
        is_live = (not ex["expired_note"]) and (to is None or asof <= to) and (frm is None or asof >= frm)
        if ex["heading"] in ("9903.88.69", "9903.88.70"):
            is_live = asof <= (to or asof)
        live += is_live
        nbare = sum(1 for i in ex["items"] if i["bare"])
        print(f"20({key:8}) {ex['heading'] or '?':11} items={len(ex['items']):4} (bare 10-digit {nbare:3}) "
              f"lines {ex['lines'][0]}-{ex['lines'][1]}  window {frm or '-'}..{to or '-'}  "
              f"{'LIVE' if is_live else 'expired'}  carves {','.join(ex['bases'])}")
    print(f"live exclusion subdivisions on {asof}: {live}")

    print()
    print("== Integrity checks ==")
    # numbering continuity
    for key, ex in n20["exclusions"].items():
        ns = [i["n"] for i in ex["items"]]
        if ns and ns != list(range(1, max(ns) + 1)):
            missing = sorted(set(range(1, max(ns) + 1)) - set(ns))
            print(f"  20({key}) numbering gap/dup: missing {missing[:10]} dups {[n for n, c in Counter(ns).items() if c > 1][:10]}")
    print(f"  note 31(b) count {len(cov8['9903.91.01'])} (implementing notice numbered (5)-(352) = 348)")
    # validity vs sqlite
    tot = bad = 0
    bad_by = defaultdict(list)
    for h in allheads:
        for c in cov8[h]:
            tot += 1
            if c not in c8db:
                bad += 1
                bad_by[h].append(c)
        for c in cov10[h] | carve[h]:
            tot += 1
            if c not in c10db:
                bad += 1
                bad_by[h].append(c)
    print(f"  codes present in hts.sqlite: {tot - bad}/{tot} = {100 * (tot - bad) / tot:.2f}%")
    for h, v in bad_by.items():
        print(f"    {h}: {len(v)} not in Rev 21 nomenclature, e.g. {v[:6]}")
    ex_tot = ex_ok = 0
    for key, ex in n20["exclusions"].items():
        if key.startswith(("vvv", "www")):
            for it in ex["items"]:
                cur = [s for s in it["segments"] if s["to"] is None or s["to"] >= args.date]
                for s in cur:
                    for c in s["codes"]:
                        ex_tot += 1
                        ex_ok += (c in c10db) or (c in c8db)
    print(f"  live exclusion (vvv/www) current stat numbers present in hts.sqlite: {ex_ok}/{ex_tot}")
    # overlaps between lists
    print("  overlaps between 8-digit coverage sets:")
    hs = [h for h in allheads if cov8[h]]
    for i, a in enumerate(hs):
        for b in hs[i + 1:]:
            ov = cov8[a] & cov8[b]
            if ov:
                print(f"    {a} & {b}: {len(ov)} e.g. {sorted(ov)[:5]}")

    # 10-digit resolution for the subheadings split between List 3 (04) and 4A (15)
    live_heads = ["9903.88.01", "9903.88.02", "9903.88.03", "9903.88.04", "9903.88.15"]
    r10 = resolve10(c10db, cov8, cov10, carve, live_heads)
    multi = {c: h for c, h in r10.items() if len(h) > 1}
    print(f"  10-digit lines covered by Lists 1-3/4A: {len(r10)}; covered by more than one list: {len(multi)}")
    for c, h in sorted(multi.items())[:10]:
        print(f"    {c}: {h}")
    split = sorted({it['subheading'] for h in ('9903.88.04', '9903.88.15') for it in n20['described'].get(h, [])})
    for sh in split:
        kids = sorted(c for c in c10db if c.startswith(sh))
        print(f"    {sh}: " + ", ".join(f"{c[-2:]}->{'/'.join(x[-2:] for x in r10.get(c, [])) or 'none'}" for c in kids))
    allc10_cov = {c for c in r10}
    print(f"  share of all {len(c10db)} Rev 21 10-digit lines hit by a live List 1-4A heading: "
          f"{100 * len(allc10_cov) / len(c10db):.1f}%")

    print()
    print("== Cross-check vs footnote ch99_refs in hts.sqlite ==")
    agree = 0
    for code, hs_ in refs.items():
        ok = all(covered(code, h, cov8, cov10, carve) or h == code for h in hs_)
        agree += ok
        if not ok:
            print(f"  disagree: {code} footnote {hs_}")
    print(f"  lines whose footnotes cite a 301 heading: {len(refs)}; consistent with extracted text: "
          f"{agree}/{len(refs)} = {100 * agree / max(1, len(refs)):.1f}%")
    n_all = sum(len(v) for v in cov8.values())
    hit = sum(1 for h, v in cov8.items() for c in v if h in refs.get(c, []))
    print(f"  reverse: extracted 8-digit (heading,code) pairs that carry a matching footnote: {hit}/{n_all} = "
          f"{100 * hit / max(1, n_all):.2f}%  -> footnotes are NOT a usable source for 301 coverage")

    if args.json:
        def ser(o):
            if isinstance(o, (dt.date,)):
                return o.isoformat()
            if isinstance(o, set):
                return sorted(o)
            raise TypeError(type(o))
        out = {"source": "HTSUS 2026 Rev 21", "coverage8": cov8, "coverage10": cov10, "carve_out10": carve,
               "exclusions": n20["exclusions"], "described": n20["described"],
               "headings": {h: {k: v for k, v in ch99[h].items() if k != "desc"} for h in ch99
                            if h.startswith(("9903.88", "9903.91", "9903.92"))}}
        Path(args.json).write_text(json.dumps(out, default=ser, indent=1), encoding="utf-8")
        print("wrote", args.json)


if __name__ == "__main__":
    sys.exit(main())
