"""Download HTS source data from USITC (public domain).

- Current revision, every chapter, as JSON  -> data/raw/usitc/current/chNN.json
- Every 2025-2026 revision's Chapter 99 + Change Record PDFs
                                            -> data/raw/usitc/revisions/<release>/
Re-runnable: skips files already on disk.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://hts.usitc.gov/reststop"
ROOT = Path(__file__).resolve().parent.parent / "data" / "raw" / "usitc"


def get(url, tries=4):
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                return r.read()
        except Exception as e:  # network hiccups: back off and retry
            if i == tries - 1:
                raise
            print(f"  retry {url}: {e}", file=sys.stderr)
            time.sleep(3 * (i + 1))


def fetch_current():
    out = ROOT / "current"
    out.mkdir(parents=True, exist_ok=True)
    total = 0
    for ch in range(1, 100):
        f = out / f"ch{ch:02d}.json"
        if not f.exists():
            q = urllib.parse.urlencode(
                {"from": f"{ch:02d}01", "to": f"{ch:02d}99", "format": "JSON", "styles": "false"})
            f.write_bytes(get(f"{API}/exportList?{q}"))
        n = len(json.loads(f.read_bytes() or b"[]"))
        total += n
        print(f"ch{ch:02d}: {n} rows")
    print(f"current total rows: {total}")


def fetch_revisions(years=("2025", "2026")):
    releases = json.loads(get(f"{API}/releaseList"))
    (ROOT / "releases.json").write_text(json.dumps(releases, indent=1))
    for rel in releases:
        name = rel["name"]
        if not name.startswith(years):
            continue
        d = ROOT / "revisions" / name
        d.mkdir(parents=True, exist_ok=True)
        for fn in ("Chapter 99", "Change Record"):
            f = d / (fn.replace(" ", "_") + ".pdf")
            if f.exists() and f.stat().st_size > 1000:
                continue
            q = urllib.parse.urlencode({"release": name, "filename": fn})
            data = get(f"{API}/file?{q}")
            f.write_bytes(data)
            print(f"{name} {fn}: {len(data)} bytes")


if __name__ == "__main__":
    fetch_current()
    fetch_revisions()
