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

- **Daily (`tariff-watch`, 14:17 UTC):** checks USITC for a new HTS revision, the Federal Register (published and on
  public inspection) for tariff proclamations and notices, and CBP CSMS messages. New items go to a "Tariff watch"
  issue, and any published action not yet reviewed shows in a banner above every result on the site.
- **New HTS revision:** the same job rebuilds the data and runs the golden tests, the filing audit and a check against
  the duties CBP actually collected (Census import data). When no Chapter 99 row, note or list moved and every check
  passes, it commits to `main` and the site redeploys by itself. Otherwise it holds the data on a
  `tariff-update/<revision>` branch and opens an issue saying what needs rule work.
- **Monthly:** AD/CVD order flags are refreshed from the Federal Register (3rd), and the Census check re-runs on the
  newest month and opens an issue if accuracy drops (12th).
- **Every push to `main`:** CI (lint, typecheck, tests, filing audit) and, when it passes, a GitHub Pages deploy.

Reviewing a Federal Register action (it leaves the banner):

```bash
python -I pipeline/mark_reviewed.py 2026-12345 "what it does / what was encoded"
```

## Sources

US government data, public domain: the Harmonized Tariff Schedule (USITC), the Federal Register, CBP CSMS messages
and Census merchandise trade data. Each result shows the HTS revision and the date the rules were last checked.
