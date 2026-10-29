"""Cross-check the parsed database against the official PDF (2026HTSRev21.pdf).

For a random sample of 8-digit rate lines, find the code in the PDF text and check that
the general-rate string appears on the same PDF line. Writes data/build/verify_report.json.
Needs `pdftotext` (poppler) on PATH.
"""
import json
import random
import re
import sqlite3
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "2026HTSRev21.pdf"
TXT = ROOT / "data" / "build" / "hts_rev21.txt"
DB = ROOT / "data" / "build" / "hts.sqlite"


def norm(s):
    return re.sub(r"\s+", "", s or "")


def main(n=300, seed=21):
    if not TXT.exists():
        subprocess.run(["pdftotext", "-layout", "-enc", "UTF-8", str(PDF), str(TXT)], check=True)
    pdf_lines = TXT.read_text(encoding="utf-8", errors="replace").splitlines()
    index = {}
    for i, line in enumerate(pdf_lines):
        m = re.match(r"^\s*(\d{4}\.\d\d\.\d\d)\b", line)
        if m:
            index.setdefault(m[1], []).append(i)

    con = sqlite3.connect(DB)
    rows = con.execute("""select code, general from lines where length(digits)=8
        and chapter not in ('98','99') and json_extract(general,'$.kind') in ('adv','spec','compound','free')""").fetchall()
    random.seed(seed)
    sample = random.sample(rows, min(n, len(rows)))
    ok, missing, mismatch = 0, [], []
    for code, g in sample:
        raw = json.loads(g)["raw"]
        hits = index.get(code)
        if not hits:
            missing.append(code)
            continue
        # the rate may sit on the code line or a few lines below (wrapped descriptions)
        window = "".join(norm(pdf_lines[j]) for i in hits for j in range(max(0, i - 3), min(i + 16, len(pdf_lines))))
        if norm(raw) in window:
            ok += 1
        else:
            mismatch.append({"code": code, "db": raw, "pdf": pdf_lines[hits[0]].strip()[:160]})
    report = {"sample": len(sample), "match": ok, "missing_in_pdf": missing, "mismatch": mismatch,
              "match_pct_of_found": round(100 * ok / max(1, ok + len(mismatch)), 2)}
    (ROOT / "data" / "build" / "verify_report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False),
                                                                encoding="utf-8")
    print(f"sample {len(sample)}  match {ok}  not-found {len(missing)}  mismatch {len(mismatch)}"
          f"  -> {report['match_pct_of_found']}% of found lines agree")
    for m in mismatch[:10]:
        print("  MISMATCH", ascii(m))


if __name__ == "__main__":
    sys.exit(main())
