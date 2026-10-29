# TARIFFWIZ

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
| `.github/workflows/` | CI, the daily tariff watch and update job, the monthly Census check, publishing. |

## Develop

Node 22+ and Python 3.11+.

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

- **Daily:** a GitHub Actions job checks USITC for a new HTS revision, the Federal Register for tariff proclamations
  and notices, and CBP CSMS messages, and posts new items to an issue.
- **New HTS revision:** the job rebuilds the data, runs the golden tests, the filing audit and a check against the
  duties CBP actually collected (Census import data), then opens a pull request listing every change. Chapter 99
  rule changes are reviewed by hand before merging; nothing goes live until the pull request is merged.
- **Monthly:** the Census check re-runs on the newest month and opens an issue if accuracy drops.

## Sources

US government data, public domain: the Harmonized Tariff Schedule (USITC), the Federal Register, CBP CSMS messages
and Census merchandise trade data. Each result shows the HTS revision and the date the rules were last checked.
