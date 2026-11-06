#!/usr/bin/env bash
# Every check a change must pass to go live without a person: lint, typecheck, the golden tests, the filing audit
# (heading coverage) and the Census check on the newest released month within its limits. Run from the repository
# root after `npm ci --prefix app`. Prints Markdown; exits 1 when any check fails. Logs: data/build/checks/.
#   .github/scripts/checks.sh [YYMM]
set -u
L=data/build/checks; mkdir -p "$L"
ok=0
for c in lint typecheck test audit:headings; do
  if npm --prefix app run "$c" > "$L/${c//:/_}.txt" 2>&1; then echo "- $c: ✅"
  else echo "- $c: ❌"; { echo "::group::$c failed"; tail -40 "$L/${c//:/_}.txt"; echo "::endgroup::"; } >&2; ok=1; fi
done
m=${1:-$(python -I pipeline/census_gate.py latest)}
if [ -n "$m" ] && npm --prefix app run census --silent -- --month "$m" > "$L/census.txt" 2>&1; then
  echo; python -I pipeline/census_gate.py check "data/validation/census_20${m:0:2}-${m:2:2}_summary.json" || ok=1
else
  echo "- Census check: ❌ did not run (month '${m}')"; tail -20 "$L/census.txt" >&2; ok=1
fi
exit $ok
