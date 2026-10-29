"""List Chapter 99 headings whose row is shaded (yellow) in the Rev PDF — USITC's marker for
expired/terminated provisions, which pdftotext and the USITC JSON both lose.

Run with the tools venv (PyMuPDF):  .venv-tools/Scripts/python -I pipeline/shaded_headings.py [--pdf PDF] [--out FILE]
Default PDF is the full Rev 21 schedule; a revision's "Chapter 99" PDF alone gives the same Ch.99 result.
Writes data/build/shaded_headings.json: {"shaded": [...], "unshaded": [...]}.
"""
import argparse
import json
import re
import sys
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "data" / "source" / "2026HTSRev21.pdf"
OUT = ROOT / "data" / "build" / "shaded_headings.json"
HEAD = re.compile(r"^99\d\d\.\d\d\.\d\d$")


def is_yellow(fill):
    return fill is not None and fill[0] > 0.9 and fill[1] > 0.9 and fill[2] < 0.6


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf", type=Path, default=PDF)
    ap.add_argument("--out", type=Path, default=OUT)
    a = ap.parse_args()
    doc = pymupdf.open(a.pdf)
    shaded, unshaded = set(), set()
    for page in doc:
        words = [w for w in page.get_text("words") if HEAD.match(w[4]) and w[0] < 120]  # heading column only
        if not words:
            continue
        rects = [d["rect"] for d in page.get_drawings() if is_yellow(d.get("fill"))]
        for x0, y0, x1, y1, text, *_ in words:
            mid = (y0 + y1) / 2
            (shaded if any(r.y0 - 1 <= mid <= r.y1 + 1 for r in rects) else unshaded).add(text)
    unshaded -= shaded
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps({"shaded": sorted(shaded), "unshaded": sorted(unshaded)}, indent=0), encoding="utf-8")
    print(f"shaded {len(shaded)}  unshaded {len(unshaded)}  -> {a.out}")


if __name__ == "__main__":
    sys.exit(main())
