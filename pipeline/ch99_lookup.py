"""Look up everything the HTS says about a Chapter 99 heading or an HTS code.

  python -I pipeline/ch99_lookup.py 9903.88.03        # heading row + every note line citing it
  python -I pipeline/ch99_lookup.py 6109.10.00.40     # the line, its rates, Ch.99 footnote refs,
                                                      # and every Ch.99 note line listing it
Options: --context N (lines around each hit, default 1), --max N (hits shown, default 40)

Reads data/build/hts_rev21.txt (make it with pipeline/verify_pdf.py) and data/build/hts.sqlite.
"""
import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TXT = ROOT / "data" / "build" / "hts_rev21.txt"
DB = ROOT / "data" / "build" / "hts.sqlite"
CH99_NOTES_START = 207323  # first line of Ch.99 Subchapter III in hts_rev21.txt (Rev 21)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("code")
    ap.add_argument("--context", type=int, default=1)
    ap.add_argument("--max", type=int, default=40)
    a = ap.parse_args()
    code = a.code.strip()
    sys.stdout.reconfigure(encoding="utf-8")

    con = sqlite3.connect(DB)
    # the line itself, or its 8-digit parent for statistical suffixes
    digits = code.replace(".", "")
    for d in dict.fromkeys([digits, digits[:8]]):
        row = con.execute("select code, descr, path, general, special_raw, other, ch99_refs, footnotes "
                          "from lines where digits=?", (d,)).fetchone()
        if row:
            c, desc, path, g, sp, o, refs, fns = row
            print(f"== {c}  {desc}\n   path: {path}")
            print(f"   general: {(json.loads(g) or {}).get('raw')}   special: {sp}   col2: {(json.loads(o) or {}).get('raw')}")
            if json.loads(refs):
                print(f"   footnote Ch.99 refs: {', '.join(json.loads(refs))}")
            for fn in json.loads(fns):
                print(f"   footnote: {fn}")
            break

    # text search: 8-digit form appears in note product lists; also match 10-digit form
    forms = {code}
    if len(digits) >= 8:
        forms.add(f"{digits[:4]}.{digits[4:6]}.{digits[6:8]}")
    pat = re.compile("|".join(re.escape(f) for f in sorted(forms, key=len, reverse=True)))
    # split on "\n" only: splitlines() also breaks on the PDF form feeds (\f) and other
    # separators, which shifted every printed line number away from grep/sed numbering
    lines = TXT.read_text(encoding="utf-8", errors="replace").split("\n")
    hits = [i for i in range(CH99_NOTES_START - 1, len(lines)) if pat.search(lines[i])]
    print(f"\n== {len(hits)} Chapter 99 text lines mention {' / '.join(sorted(forms))}")
    for i in hits[:a.max]:
        for j in range(max(0, i - a.context), min(len(lines), i + a.context + 1)):
            mark = ">" if j == i else " "
            print(f"{mark}{j + 1:>7}: {lines[j][:170]}")
        print("        ---")
    if len(hits) > a.max:
        print(f"   ... {len(hits) - a.max} more (use --max)")


if __name__ == "__main__":
    main()
