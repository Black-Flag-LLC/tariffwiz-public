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

Everything runs from this repository's GitHub Actions; there is no other copy.

- **Twice a day (`tariff-watch`, 14:17 and 02:47 UTC):** checks USITC for a new HTS revision, the Federal Register
  (published and on public inspection) for tariff proclamations and notices, and CBP CSMS messages. GitHub often starts
  scheduled runs hours late and can drop one; the second slot keeps the check daily, and a run with nothing new
  changes nothing. New items go to a "Tariff watch"
  issue, and any published action not yet reviewed shows in a banner above every result on the site.
- **New HTS revision:** the same job rebuilds the data and runs the golden tests, the filing audit and a check against
  the duties CBP actually collected (Census import data). When no Chapter 99 row, note or list moved and every check
  passes, it commits to `main` and the site redeploys by itself. Otherwise it holds the data on a
  `tariff-update/<revision>` branch and opens an issue saying what needs rule work.
- **Monthly:** AD/CVD order flags are refreshed from the Federal Register (3rd), and the Census check re-runs on the
  newest month and opens an issue if accuracy drops (12th).
- **Daily review (`tariff-watch`, after the watch):** Claude reads the verbatim text of each Federal Register action on
  the banner (instructions: `.github/review/prompt.md`). An action that changes no duty is recorded in
  `pipeline/reviewed.json` and goes live. One that changes a duty is encoded on a `review/<document>` branch, tested,
  and left for a person with an issue; so is anything Claude cannot settle. Once nothing is left unreviewed, the
  "rules checked" date moves to today.
- **Every push to `main`:** CI (lint, typecheck, tests, filing audit) and, when it passes, a GitHub Pages deploy. A
  Lighthouse check of the built site runs beside it (phone performance at least 90, accessibility and best practices
  100) and fails visibly without holding back the deploy; the tests also check every theme's text contrast.
- **Monthly (Dependabot):** grouped pull requests for the pinned GitHub Actions and the app's npm packages.

### Settings

| Where | Name | What it does |
|---|---|---|
| Secret | `ANTHROPIC_API_KEY` | Turns the daily review on. Without it the banner keeps listing actions until reviewed by hand. |
| Variable | `REVIEW_MODEL` | Model for the review (default `claude-opus-5-5`). |
| Variable | `REVIEW_BUDGET_USD` | Spending cap per document (default `3`). |
| Variable | `REVIEW_MAX_DOCS` | Documents reviewed per day (default `6`); the rest wait for the next run. |

Set them under Settings → Secrets and variables → Actions, or with `gh secret set` / `gh variable set`.

### By hand

Record a review yourself (the action leaves the banner):

```bash
python -I pipeline/mark_reviewed.py 2026-12345 "what it does / what was encoded"
```

Test the review on one document without publishing anything (the result is in the run summary):

```bash
gh workflow run watch.yml -f review_doc=2026-12345
```

Taking a held change live: open a pull request from its `review/…` or `tariff-update/…` branch, check it, and merge;
the push to `main` deploys it. Deleting a `review/…` branch instead lets the next daily run review that action again.

## Sources

US government data, public domain: the Harmonized Tariff Schedule (USITC), the Federal Register, CBP CSMS messages
and Census merchandise trade data. Each result shows the HTS revision and the date the rules were last checked.
