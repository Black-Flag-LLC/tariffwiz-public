# TARIFFWIZ

<p align="center">
  <a href="https://black-flag-llc.github.io/tariffwiz-public/"><img alt="Use TARIFFWIZ now" src="https://img.shields.io/badge/USE%20NOW-Open%20the%20calculator%20%E2%86%92-2357d6?style=for-the-badge"></a>
</p>
<p align="center"><a href="https://black-flag-llc.github.io/tariffwiz-public/">https://black-flag-llc.github.io/tariffwiz-public/</a> · free · no account · runs in your browser</p>

A free US import-duty calculator for importers and customs brokers. Pick an HTS code, enter origin, value, mode and
dates, and get the duty with every line explained: the base rate, every Chapter 99 measure in force on the entry date
(Sections 232, 301 and 338, country measures, safeguards, quotas), stacked in CBP filing order, plus MPF, HMF and
other charges. Everything runs in the browser; nothing you type leaves your device.

> Estimate for planning only, not legal or customs advice. The filer remains responsible for classification,
> valuation, origin and ACE transmission.

## Layout

| Path | What it is |
|---|---|
| `app/` | The site: Vite + React + TypeScript. `src/engine/` is the duty engine (pure functions, golden-tested). |
| `app/public/data/` | Data the site loads: HTS rows per chapter, `rules.json` (every Chapter 99 measure as data), search index. |
| `app/scripts/` | Command-line tools on the same engine: `quote`, the filing audit, the Census validation. |
| `pipeline/` | Python (standard library) that builds the data from USITC, Federal Register and CBP sources, and watches them. |
| `.github/workflows/` | CI + Pages deploy, the daily tariff watch and update job, the monthly AD/CVD refresh and Census check. |

## Run it on your own computer

Node 22+ (and Python 3.11+ only for the data pipeline). Download or clone this repository, then:

```bash
cd app && npm ci
npm run dev        # http://localhost:5173
npm run check      # lint, typecheck, golden tests, filing audit
npm run build      # static site in app/dist
```

Quote from the command line:

```bash
npm --prefix app run quote --silent -- --hts 8708.29.51.90 --from PL --value 10000 --mode truck
```

## How the data stays current

Everything runs from this repository's GitHub Actions, with no one in the loop: there is no other copy and nothing
waits for a person. A change goes live when it passes every automated check; one that fails a check is never
published, the site keeps the last good version, and an issue says what failed.

**The checks a change must pass to go live** (`.github/scripts/checks.sh`): lint, typecheck, the golden tests (which
may gain cases but never lose or change one, except that a test pinned to a legal date the law moved has only that
date moved, to a date the same change adds to the rules), the filing audit (1.9 million calculations), and the Census check: the
engine against the duties CBP actually collected in the newest month, within its limits. Automated changes may touch
only the rules, the engine and added tests (`pipeline/improve_gate.py`). `rules.json` merges as JSON
(`pipeline/json_merge.py`), so automated writers never collide on its single line.

- **Twice a day (`tariff-watch`, 14:17 and 02:47 UTC):** checks USITC for a new HTS revision, the Federal Register
  (published and on public inspection) for tariff proclamations and notices, and CBP CSMS messages. GitHub often starts
  scheduled runs hours late and can drop one; the second slot keeps the check daily, and a run with nothing new
  changes nothing. New items go to the "Tariff watch" log issue, and any published action not yet reviewed shows in
  a banner above every result on the site.
- **Daily review (after the watch):** Claude reads the verbatim text of each new Federal Register action
  (`.github/review/prompt.md`). One that changes no duty is recorded and goes live. One that changes a duty is encoded
  and goes live once it passes every check. One Claude cannot settle, or whose change fails a check, waits on a
  `review/<document>` branch and is tried again the next day. When nothing is left unreviewed, the "rules checked" date
  moves to today and the log issue closes.
- **New HTS revision:** the data is rebuilt and checked. If no Chapter 99 row, note or list moved, it goes live.
  Otherwise self-improve does the rule work (`.github/improve/hts.md`) and it goes live through go-live.
- **Self-improve (`self-improve`, after each Census check and each HTS revision that needs rule work):** Claude looks
  for rule or engine errors behind the Census mismatches (`.github/improve/census.md`), each fix backed by a legal
  source, never just fitted to the numbers. The workflow decides: a Census fix must raise accuracy on the newest month
  without slipping on the month before. A fix that qualifies goes to go-live.
- **Go-live (`go-live`):** merges a qualifying change into `main`, runs every check again on the merged result,
  publishes it and closes the issue it settles. A merge conflict or a failed check moves it to `held/<name>` with an
  issue. The daily watch restarts go-live for any change still waiting.
- **Monthly:** AD/CVD order flags are refreshed from the Federal Register (3rd); an order leaves only when a revocation
  notice is found, and one simply not found that month is kept. The Census check re-runs on the newest month (12th),
  starts self-improve, and closes its drift issue when accuracy is back within the limits.
- **Daily guardian (`guardian`, 07:29 UTC):** re-enables any disabled workflow and pushes a heartbeat commit when
  `main` has been quiet for 30 days (GitHub pauses schedules after 60 quiet days), restarts `tariff-watch` if it has not
  succeeded in 36 hours, and opens a "Stale" issue (which emails the owner) if "rules checked" is over 3 days old,
  closing it once the date is current.
- **Every push to `main`:** CI and, when it passes, a GitHub Pages deploy. A Lighthouse check of the built site runs
  beside it (phone performance at least 90 on a CPU-calibrated median of five runs, accessibility and best practices
  100) and fails visibly without holding back the deploy; the tests also check every theme's text contrast.
- **Monthly (Dependabot):** grouped updates for the pinned GitHub Actions and the app's npm packages, merged by
  `dependabot-merge` as soon as CI passes on them.

### Settings

| Where | Name | What it does |
|---|---|---|
| Secret | `ANTHROPIC_API_KEY` | Turns on the review and self-improve. Without it the banner keeps listing actions and the log issue stays open. |
| Variable | `REVIEW_MODEL` | Model for the review (default `claude-opus-5-5`). |
| Variable | `REVIEW_BUDGET_USD` | Spending cap per document (default `3`). |
| Variable | `REVIEW_MAX_DOCS` | Documents reviewed per day (default `6`); the rest wait for the next run. |
| Variable | `IMPROVE_MODEL` | Model for self-improve (default: `REVIEW_MODEL`, else `claude-opus-5-5`). |
| Variable | `IMPROVE_BUDGET_USD` | Spending cap per self-improve run (default `10`; about one run a month). |

Set them under Settings → Secrets and variables → Actions, or with `gh secret set` / `gh variable set`.

### By hand (never required)

Test the review on one document without publishing anything (the result is in the run summary):

```bash
gh workflow run watch.yml -f review_doc=2026-12345
```

Run self-improve or go-live as a dry run (every step, nothing pushed):

```bash
gh workflow run improve.yml -f task=census -f dry_run=true
```

```bash
gh workflow run golive.yml -f branch=golive/<name> -f dry_run=true
```

A change held as broken stays on its `held/…` or `review/…` branch; deleting the branch drops it (a review is tried
again the next day).

## Sources

US government data, public domain: the Harmonized Tariff Schedule (USITC), the Federal Register, CBP CSMS messages
and Census merchandise trade data. Each result shows the HTS revision and the date the rules were last checked.
