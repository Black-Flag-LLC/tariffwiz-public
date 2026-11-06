"""Three-way merge of app/public/data/rules.json as JSON, for git (so automated writers never collide on its one line).

rules.json is one minified line, so any two changes to it conflict as text: the daily "rules checked" date against a
rule fix, for example. As JSON they rarely touch the same value. Git uses this as a merge driver (.gitattributes):

  git config merge.json-rules.driver "python -I pipeline/json_merge.py %O %A %B"
  python -I pipeline/json_merge.py BASE OURS THEIRS    # merged JSON written to OURS; exit 1 on a real conflict
  python -I pipeline/json_merge.py selftest

Objects merge key by key, recursively. Anything else (a list, a number, a string) takes whichever side changed it;
when both sides changed the same value differently, that is a real conflict: the merge stops and nothing is guessed.
The result is written in the pipeline's exact format (json.dumps with separators=(",", ":")).
"""
import json
import sys

MISSING = object()


class Conflict(Exception):
    pass


def merge(base, ours, theirs, path="$"):
    if ours == theirs:
        return ours
    if base == ours:
        return theirs
    if base == theirs:
        return ours
    if all(isinstance(x, dict) for x in (ours, theirs)) and (base is MISSING or isinstance(base, dict)):
        b = {} if base is MISSING else base
        out = {}
        for k in list(ours) + [k for k in theirs if k not in ours]:
            v = merge(b.get(k, MISSING), ours.get(k, MISSING), theirs.get(k, MISSING), f"{path}.{k}")
            if v is not MISSING:
                out[k] = v
        return out
    raise Conflict(path)


def dump(x):
    return json.dumps(x, separators=(",", ":"))


def selftest():
    base = {"meta": {"checked": "2026-11-01", "revision": "R22"}, "lists": {"a": ["1", "2"]}, "programs": {"S": 1}}
    ours = {"meta": {"checked": "2026-11-05", "revision": "R22"}, "lists": {"a": ["1", "2"]}, "programs": {"S": 1}}
    theirs = {"meta": {"checked": "2026-11-01", "revision": "R22"}, "lists": {"a": ["1", "2", "3"]}, "programs": {"S": 1, "K": 2}}
    m = merge(base, ours, theirs)
    assert m == {"meta": {"checked": "2026-11-05", "revision": "R22"}, "lists": {"a": ["1", "2", "3"]}, "programs": {"S": 1, "K": 2}}, m
    assert list(m) == ["meta", "lists", "programs"]                                  # key order kept
    assert merge(base, {**base, "x": 1}, {**base, "x": 1}) == {**base, "x": 1}         # same change on both sides
    gone = {k: v for k, v in base.items() if k != "programs"}
    assert merge(base, gone, base) == gone                                            # one side removed a key
    try:
        merge(base, {**base, "lists": {"a": ["1"]}}, theirs)                          # both changed the same list
        raise AssertionError("expected a conflict")
    except Conflict as c:
        assert str(c) == "$.lists.a"
    try:
        merge(base, {**base, "meta": {"checked": "A", "revision": "R22"}}, {**base, "meta": {"checked": "B", "revision": "R22"}})
        raise AssertionError("expected a conflict")
    except Conflict:
        pass
    print("selftest ok")


if __name__ == "__main__":
    if sys.argv[1:2] == ["selftest"]:
        selftest()
        sys.exit(0)
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    base_p, ours_p, theirs_p = sys.argv[1:4]
    load = lambda p: json.loads(open(p, encoding="utf-8").read())  # noqa: E731
    try:
        merged = merge(load(base_p), load(ours_p), load(theirs_p))
    except Conflict as c:
        print(f"rules.json: both sides changed {c} differently; not merging it automatically", file=sys.stderr)
        sys.exit(1)
    except (ValueError, OSError) as e:
        print(f"rules.json: could not merge as JSON ({e})", file=sys.stderr)
        sys.exit(1)
    with open(ours_p, "w", encoding="utf-8", newline="") as f:
        f.write(dump(merged))
