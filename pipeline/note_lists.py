"""List the HTS code lists inside a Ch.99 U.S. note of hts_rev21.txt, by subdivision.
usage: python -I pipeline/note_lists.py START END [--codes] [--check CODE ...]
Prints: header line no, header text, first/last code line, count of codes.
--check: report which list(s) contain each given 10-digit code by prefix match."""
import re
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
lines = (ROOT / "data/build/hts_rev21.txt").read_text(encoding="utf-8").split(chr(10))
a = sys.argv[1:]
start, end = int(a[0]), int(a[1])
CODE = re.compile(r"(?<![\d.])(\d{4}(?:\.\d{2}(?:\.\d{2,4})?)?)(?![\d.])")
HDR = re.compile(r"^\s*(\((?:[a-z]{1,2}|[ivx]+|\d+|[A-Z])\))")
CODELINE = re.compile(r"^\s*(\d{4}(\.\d{2}(\.\d{2,4})?)?\s*)+$")
blocks, cur = [], None
for n in range(start, end + 1):
    t = lines[n - 1]
    if HDR.match(t) and not CODELINE.match(t):
        cur = {"hdr": n, "text": re.sub(r"\s+", " ", t.strip())[:110], "codes": [], "first": None, "last": None}
        blocks.append(cur)
    elif cur and CODELINE.match(t):
        cs = CODE.findall(t)
        cur["codes"] += cs
        cur["first"] = cur["first"] or n
        cur["last"] = n
if "--check" in a:
    for q in a[a.index("--check") + 1:]:
        qd = q.replace(".", "")
        hits = [f"L{b['hdr']} {b['text'][:60]}" for b in blocks if any(qd.startswith(c.replace(".", "")) for c in b["codes"])]
        print(q, "->", hits or "no list")
else:
    for b in blocks:
        if b["codes"]:
            print(f"L{b['hdr']}: {b['text']}\n    codes L{b['first']}-L{b['last']}  n={len(b['codes'])}" + (("\n    " + " ".join(b["codes"])) if "--codes" in a else ""))
