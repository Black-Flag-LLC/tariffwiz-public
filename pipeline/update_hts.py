"""Take a new HTS revision into the app's data, and say what still needs a person (or a Claude session).

Run after fetch_hts.py --release NAME and build_hts.py (and shaded_headings.py on the new Chapter 99 PDF):
  python -I pipeline/update_hts.py --release 2026HTSRev22 [--shaded FILE] [--change-record FILE]
                                   [--report OUT.md] [--status OUT.json] [--apply]

What is automatic (written with --apply):
  - every HTS row: descriptions, units, base rates (general / special / column 2), footnotes -> app/public/data/hts/
  - the offline search index -> app/public/data/search.json
  - the list of expired Chapter 99 headings (yellow shading in the new PDF) -> rules.json "expired"
  - rules.json meta: revision and revisionApplied (not checked: that is the review date, see mark_reviewed.py)
What is not: Chapter 99 rules come from note text anchored to Rev 21 line numbers (build_rules.py). Any change to
Chapter 99 rows, shading, list codes or a Change Record line about Chapter 99 sets needs_rule_work, and the report
lists exactly what changed so the rules can be updated by hand (us-import-duty skill, "New HTS revision").
"""
import argparse
import bisect
import datetime
import json
import re
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # python -I leaves the script folder off sys.path
from search_index import write_search  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "app" / "public" / "data"
HEADING = re.compile(r"\b99\d\d\.\d\d\.\d\d\b")
# Change Record lines that touch Chapter 99 (headings, its notes or subchapters)
CH99_LINE = re.compile(r"\b99\d\d\.\d\d|\bch(?:apter|\.)? ?99\b|\bsubch(?:apter)? (?:III|IV|VI)\b|affected:.*\b99\b", re.I)
SHOW = 40  # rows shown per table in the report


def load_shards(d):
    out = {}
    for f in sorted(d.glob("ch*.json")):
        for l in json.loads(f.read_text(encoding="utf-8")):
            out[l["code"]] = l
    return out


def raw(r):
    return (r or {}).get("raw", "") if isinstance(r, dict) else (r or "")


def rates(l):
    return raw(l["general"]), l.get("special_raw") or "", raw(l["other"])


def table(head, rows):
    if not rows:
        return []
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join(str(c).replace("|", "/").replace("\n", " ")[:160] for c in r) + " |" for r in rows[:SHOW]]
    if len(rows) > SHOW:
        out.append(f"\n…and {len(rows) - SHOW} more.")
    return out + [""]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--release", required=True)
    ap.add_argument("--shards", type=Path, default=ROOT / "data" / "build" / "shards")
    ap.add_argument("--shaded", type=Path, help="shaded_headings.py output for the new Chapter 99 PDF")
    ap.add_argument("--change-record", type=Path, help="pdftotext of the new revision's Change Record")
    ap.add_argument("--report", type=Path, default=ROOT / "data" / "build" / "update_report.md")
    ap.add_argument("--status", type=Path, default=ROOT / "data" / "build" / "update_status.json")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    rules = json.loads((DATA / "rules.json").read_text(encoding="utf-8"))
    old, new = load_shards(DATA / "hts"), load_shards(a.shards)
    if len(new) < 0.9 * len(old):
        raise SystemExit(f"new revision has {len(new)} rows against {len(old)} now: fetch looks incomplete, stopping")

    added = sorted(set(new) - set(old))
    removed = sorted(set(old) - set(new))
    rate_chg, desc_chg = [], []
    for c in sorted(set(old) & set(new)):
        if rates(old[c]) != rates(new[c]):
            rate_chg.append((c, old[c], new[c]))
        elif old[c]["desc"] != new[c]["desc"] or old[c]["footnotes"] != new[c]["footnotes"]:
            desc_chg.append((c, old[c], new[c]))
    ch99 = lambda c: c.startswith("99")  # noqa: E731

    # headings and codes the rules use
    rules_text = json.dumps({k: v for k, v in rules.items() if k != "expired"})
    used = set(HEADING.findall(rules_text))
    def exists(digits, code):  # a list code (4-10 digits) is fine while any line starts with it
        d = code.replace(".", "")
        i = bisect.bisect_left(digits, d)
        return i < len(digits) and digits[i].startswith(d)
    old_d, new_d = sorted(l["digits"] for l in old.values()), sorted(l["digits"] for l in new.values())
    # only codes this revision removed: some list codes were already gone from the HTS the rules were built on
    gone = sorted({(k, c) for k, codes in rules["lists"].items() for c in codes
                   if not ch99(c) and exists(old_d, c) and not exists(new_d, c)})

    shaded_new = shaded_gone = []
    if a.shaded:
        sh = set(json.loads(a.shaded.read_text(encoding="utf-8"))["shaded"])
        shaded_new, shaded_gone = sorted(sh - set(rules["expired"])), sorted(set(rules["expired"]) - sh)

    cr_lines, cr_note = [], "not available"
    if a.change_record and a.change_record.exists():
        txt = a.change_record.read_text(encoding="utf-8", errors="replace").splitlines()
        cr_lines = [t.strip() for t in txt if CH99_LINE.search(t)]
        cr_note = f"{len(txt)} lines, {len(cr_lines)} about Chapter 99"
        if len([t for t in txt if t.strip()]) < 5:  # the PDF yielded no text (scanned or failed): treat as unreadable
            a.change_record = None

    ch99_rows = [c for c in added + removed if ch99(c)] + [c for c, *_ in rate_chg + desc_chg if ch99(c)]
    reasons = []
    if ch99_rows:
        reasons.append(f"{len(ch99_rows)} Chapter 99 row(s) added, removed or changed")
    if gone:
        reasons.append(f"{len(gone)} code(s) on Chapter 99 lists no longer exist")
    if shaded_new or shaded_gone:
        reasons.append(f"expired-heading shading changed ({len(shaded_new)} new, {len(shaded_gone)} no longer shaded)")
    if cr_lines:
        reasons.append(f"the Change Record has {len(cr_lines)} line(s) about Chapter 99")
    if not (a.change_record and a.change_record.exists()):
        reasons.append("the Change Record could not be read, so Chapter 99 note changes are unknown")
    # a new 10-digit line beside a listed 10-digit code: the list may need it too (lists pin exact statistical lines)
    listed10 = {c.replace(".", "") for codes in rules["lists"].values() for c in codes if len(c.replace(".", "")) == 10}
    split = sorted(c for c in added if not ch99(c) and len(c.replace(".", "")) == 10
                   and any(x[:8] == c.replace(".", "")[:8] for x in listed10))
    if split:
        reasons.append(f"{len(split)} new statistical line(s) beside listed codes ({', '.join(split[:5])}{'…' if len(split) > 5 else ''})")
    affected = sorted(used & set(ch99_rows))

    today = datetime.date.today().isoformat()
    md = [f"## HTS {a.release}: automatic update", "",
          f"Rules were built from **{rules['meta']['revision']}**. Rows: {len(old)} now, {len(new)} in {a.release}. "
          f"Change Record: {cr_note}.", ""]
    if reasons:
        md += ["### ⚠️ Rule work needed before merging", "",
               "Chapter 99 rules are written from the note text by hand (us-import-duty skill, \"New HTS revision\"). "
               "This pull request is a draft until that is done. Why:", ""] + [f"- {r}" for r in reasons] + [""]
        if affected:
            md += ["Headings the engine uses that changed: " + ", ".join(affected), ""]
    else:
        md += ["### ✅ No Chapter 99 changes", "",
               "Only base rates, descriptions or codes in chapters 1-98 changed; those are taken over automatically.", ""]
    md += ["### Base rates changed (chapters 1-98)", ""]
    md += table(["code", "old general / special / col 2", "new general / special / col 2"],
                [(c, " / ".join(rates(o)), " / ".join(rates(n))) for c, o, n in rate_chg if not ch99(c)]) or ["None.", ""]
    md += ["### Codes added and removed (chapters 1-98)", ""]
    md += table(["added", "description"], [(c, new[c]["desc"]) for c in added if not ch99(c)]) or ["No codes added.", ""]
    md += table(["removed", "description"], [(c, old[c]["desc"]) for c in removed if not ch99(c)]) or ["No codes removed.", ""]
    nd = sum(1 for c, *_ in desc_chg if not ch99(c))
    md += [f"Descriptions or footnotes changed on {nd} other line(s).", ""]
    md += ["### Chapter 99 rows", ""]
    md += table(["heading", "change", "now"],
                [(c, "added", f"{raw(new[c]['general'])} {new[c]['desc'][:120]}") for c in added if ch99(c)]
                + [(c, "removed", old[c]["desc"][:120]) for c in removed if ch99(c)]
                + [(c, "rate", f"{raw(o['general'])} -> {raw(n['general'])}") for c, o, n in rate_chg if ch99(c)]
                + [(c, "text", n["desc"][:160]) for c, o, n in desc_chg if ch99(c)]) or ["No Chapter 99 row changed.", ""]
    md += ["### Expired (shaded) headings", ""]
    if not a.shaded:
        md += ["Not checked (no shading file).", ""]
    else:
        md += [f"Newly shaded: {', '.join(shaded_new) or 'none'}", "",
               f"No longer shaded: {', '.join(shaded_gone) or 'none'}", ""]
    md += ["### List codes that no longer exist", ""]
    md += table(["list", "code"], gone) or ["None.", ""]
    md += ["### Change Record lines about Chapter 99", ""]
    md += (["```"] + cr_lines[:120] + (["…"] if len(cr_lines) > 120 else []) + ["```", ""]) if cr_lines else ["None.", ""]

    a.report.parent.mkdir(parents=True, exist_ok=True)
    a.report.write_text("\n".join(md), encoding="utf-8")
    status = {"release": a.release, "needs_rule_work": bool(reasons), "reasons": reasons,
              "changed": bool(added or removed or rate_chg or desc_chg or shaded_new or shaded_gone
                              or a.release != rules["meta"]["revision"]),
              "counts": {"added": len(added), "removed": len(removed), "rates": len(rate_chg), "text": len(desc_chg),
                         "ch99_rows": len(ch99_rows), "gone_list_codes": len(gone)}}
    a.status.write_text(json.dumps(status, indent=1), encoding="utf-8")
    print(json.dumps(status, indent=1))

    if a.apply and status["changed"]:
        hts = DATA / "hts"
        for f in hts.glob("ch*.json"):
            f.unlink()
        for f in a.shards.glob("ch*.json"):
            shutil.copy(f, hts / f.name)
        write_search(a.shards, DATA / "search.json")
        if a.shaded:
            rules["expired"] = sorted(json.loads(a.shaded.read_text(encoding="utf-8"))["shaded"])
        # meta.checked is NOT moved: it is the date the rules were last reviewed against published actions (mark_reviewed.py)
        rules["meta"].update(revision=a.release, revisionApplied=today,
                             note=f"HTS rows from {a.release} (pipeline/update_hts.py); Chapter 99 rules from "
                                  f"pipeline/build_rules.py")
        (DATA / "rules.json").write_text(json.dumps(rules, separators=(",", ":")), encoding="utf-8")
        print("applied to", DATA)


if __name__ == "__main__":
    sys.exit(main())
