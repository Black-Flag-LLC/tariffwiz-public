"""Download HTS source data from USITC (public domain).

- Current revision, every chapter, as JSON  -> data/raw/usitc/current/chNN.json
- Every 2025-2026 revision's Chapter 99 + Change Record PDFs
                                            -> data/raw/usitc/revisions/<release>/
Re-runnable: skips files already on disk.
  python -I pipeline/fetch_hts.py                     # all of the above
  python -I pipeline/fetch_hts.py --release NAME      # current JSON + only that release's PDFs (update job)
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


def fetch_revisions(years=("2025", "2026"), only=None):
    releases = json.loads(get(f"{API}/releaseList"))
    (ROOT / "releases.json").write_text(json.dumps(releases, indent=1))
    for rel in releases:
        name = rel["name"]
        if (name != only) if only else not name.startswith(years):  # --release ignores the years (2027HTSBasic…)
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
    release = sys.argv[sys.argv.index("--release") + 1] if "--release" in sys.argv else None
    if release:
        current = next((r["name"] for r in json.loads(get(f"{API}/releaseList")) if r.get("status") == "current"), None)
        if release != current:
            sys.exit(f"--release {release}: the USITC API only serves the current revision ({current}) as JSON")
    fetch_current()
    fetch_revisions(only=release)
