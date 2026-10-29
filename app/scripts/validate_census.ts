// Validate the duty engine against duties CBP actually collected (Census merchandise trade, imports by
// HTS10 x country x rate provision, one month).
//
//   cd app && npx tsx scripts/validate_census.ts [--month 2608] [--top 60] [--random 70] [--min 100000] [--seed 7]
//
// Data: Census "Merchandise Trade Imports" monthly bulk file IMDBYYMM.ZIP (free, no key, no account):
//   https://www.census.gov/trade/downloads/20YY/Merch/im_m/IMDBYYMM.ZIP  (layout: .../reference/products/layouts/imdb.html)
// The Census data API (api.census.gov/data/timeseries/intltrade/imports/hs) holds the same numbers but now
// requires a key (302 -> missing_key.html), so this script reads the bulk file instead.
// Rate provision (RP) codes: https://www.census.gov/foreign-trade/reference/codes/rp.html
//   free:      10 MFN/ch.98 free, 18 free under special programs (FTA/GSP) or ch.99 free items, 19 free under ch.99 rates
//   dutiable:  61 general column, 62 column 2, 64 special column (FTA reduced), 69 chapter 99 rates (duty reported)
//   excluded:  00 bonded warehouse/FTZ, 11 USVI, 13/14/16 special free, 70/79 no duty calculated
//
// Output: data/validation/census_20YY-MM.csv and data/validation/census_20YY-MM_groups.md (auto summary).
// Raw data is cached under data/validation/raw/ (gitignored).
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { calculate, ListIndex } from '../src/engine/calc';
import type { Answers, HtsLine, Input, Mode, Result, Rules } from '../src/engine/types';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const YYMM = arg('month', '2608');
const MONTH = `20${YYMM.slice(0, 2)}-${YYMM.slice(2)}`;
const TOP = Number(arg('top', '60'));
const RANDOM = Number(arg('random', '70'));
const MIN_VAL = Number(arg('min', '100000'));
const SEED = Number(arg('seed', '7'));
const NCOUNTRIES = Number(arg('countries', '16'));
const VALUE = 100000;
const ENTRY = `${MONTH}-20`;
const MONTH_DATES = [`${MONTH}-01`, `${MONTH}-14`, `${MONTH}-20`, `${MONTH}-${new Date(Date.UTC(Number('20' + YYMM.slice(0, 2)), Number(YYMM.slice(2)), 0)).getUTCDate()}`];

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(ROOT, 'data/validation');
const RAW = path.join(OUT, 'raw', `IMDB${YYMM}`);
const DATA = path.join(ROOT, 'app/public/data');

// ------------------------------------------------------------------ 1. raw data
async function ensureRaw() {
  mkdirSync(RAW, { recursive: true });
  const ig = path.join(OUT, 'raw', '.gitignore');
  if (!existsSync(ig)) writeFileSync(ig, '*\n!.gitignore\n');
  const zip = path.join(RAW, `IMDB${YYMM}.ZIP`);
  const cached = existsSync(path.join(OUT, 'raw', `imdb${YYMM}_agg.json`)) && existsSync(path.join(RAW, 'COUNTRY.TXT'));
  if (!cached && !existsSync(path.join(RAW, 'IMP_DETL.TXT'))) {
    if (!existsSync(zip)) {
      const url = `https://www.census.gov/trade/downloads/20${YYMM.slice(0, 2)}/Merch/im_m/IMDB${YYMM}.ZIP`;
      console.log(`downloading ${url}`);
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status} (month not released yet?)`);
      writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
    }
    // data files only: the zip also carries a Windows viewer (exe/dll) that is never extracted
    const u = spawnSync('unzip', ['-o', '-q', zip, 'IMP_DETL.TXT', 'COUNTRY.TXT', 'CONCORD.TXT', '-d', RAW], { stdio: 'inherit' });
    if (u.status !== 0) throw new Error('unzip failed: extract IMP_DETL.TXT, COUNTRY.TXT, CONCORD.TXT into ' + RAW);
  }
}

// value fields we keep: [cards, conVal, dutVal, calDut, q1, q2, genVal, airVal, vesVal]
type Agg = number[];
const RP_NP = ['10', '19', '61', '62', '69'];   // general, column 2 and chapter 99 provisions
const RP_PR = ['18', '64'];                     // special programs (FTA/GSP); USMCA claims mostly show up as 19 now
const RP_USED = [...RP_NP, ...RP_PR];

async function aggregate(): Promise<Map<string, Map<string, Agg>>> {
  const cache = path.join(OUT, 'raw', `imdb${YYMM}_agg.json`);
  if (existsSync(cache)) {
    const o = JSON.parse(readFileSync(cache, 'utf8')) as Record<string, Record<string, Agg>>;
    return new Map(Object.entries(o).map(([k, v]) => [k, new Map(Object.entries(v))]));
  }
  const m = new Map<string, Map<string, Agg>>();   // "hs10|cty" -> rp -> agg
  const rl = createInterface({ input: createReadStream(path.join(RAW, 'IMP_DETL.TXT'), { encoding: 'latin1' }), crlfDelay: Infinity });
  const f = (s: string, a: number, b: number) => Number(s.slice(a - 1, b));
  let n = 0;
  for await (const s of rl) {
    if (s.length < 283) continue;
    n++;
    const conVal = f(s, 74, 88), genVal = f(s, 179, 193);
    if (!conVal && !genVal) continue;   // YTD-only record
    if (s.slice(22, 28) !== `20${YYMM}`) continue;
    const key = `${s.slice(0, 10)}|${s.slice(10, 14)}`, rp = s.slice(20, 22);
    const vals = [f(s, 29, 43), conVal, f(s, 89, 103), f(s, 104, 118), f(s, 44, 58), f(s, 59, 73), genVal, f(s, 224, 238), f(s, 269, 283)];
    let byRp = m.get(key);
    if (!byRp) m.set(key, (byRp = new Map()));
    const a = byRp.get(rp);
    if (a) vals.forEach((v, i) => (a[i] += v)); else byRp.set(rp, vals);
  }
  console.log(`read ${n} detail records, ${m.size} HTS10 x country cells`);
  writeFileSync(cache, JSON.stringify(Object.fromEntries([...m].map(([k, v]) => [k, Object.fromEntries(v)]))));
  return m;
}

// Census Schedule C country names (COUNTRY.TXT) -> ISO2. Checked against COUNTRY.TXT at run time.
const NAME_ISO: Record<string, string> = {
  'CHINA': 'CN', 'MEXICO': 'MX', 'CANADA': 'CA', 'VIETNAM': 'VN', 'GERMANY': 'DE', 'JAPAN': 'JP', 'KOREA, SOUTH': 'KR',
  'TAIWAN': 'TW', 'INDIA': 'IN', 'IRELAND': 'IE', 'ITALY': 'IT', 'THAILAND': 'TH', 'UNITED KINGDOM': 'GB', 'SWITZERLAND': 'CH',
  'BRAZIL': 'BR', 'MALAYSIA': 'MY', 'SINGAPORE': 'SG', 'INDONESIA': 'ID', 'FRANCE': 'FR', 'NETHERLANDS': 'NL', 'ISRAEL': 'IL',
  'PHILIPPINES': 'PH', 'SPAIN': 'ES', 'BELGIUM': 'BE', 'AUSTRIA': 'AT', 'AUSTRALIA': 'AU', 'CHILE': 'CL', 'COLOMBIA': 'CO',
  'CAMBODIA': 'KH', 'BANGLADESH': 'BD', 'SWEDEN': 'SE', 'DENMARK': 'DK', 'TURKEY': 'TR', 'POLAND': 'PL', 'SAUDI ARABIA': 'SA',
  'ARGENTINA': 'AR', 'PERU': 'PE', 'COSTA RICA': 'CR', 'DOMINICAN REPUBLIC': 'DO', 'GUATEMALA': 'GT', 'NORWAY': 'NO', 'FINLAND': 'FI',
  'CZECH REPUBLIC': 'CZ', 'CZECHIA': 'CZ', 'HUNGARY': 'HU', 'PAKISTAN': 'PK', 'SOUTH AFRICA': 'ZA', 'UNITED ARAB EMIRATES': 'AE',
  'ECUADOR': 'EC', 'NEW ZEALAND': 'NZ', 'SRI LANKA': 'LK', 'HONDURAS': 'HN', 'EL SALVADOR': 'SV', 'NICARAGUA': 'NI', 'HONG KONG': 'HK',
  'PORTUGAL': 'PT', 'TRINIDAD AND TOBAGO': 'TT', 'NIGERIA': 'NG', 'IRAQ': 'IQ', 'KAZAKHSTAN': 'KZ', 'GUYANA': 'GY', 'MOROCCO': 'MA',
};
function countryMap(): Map<string, { iso: string; name: string }> {
  const m = new Map<string, { iso: string; name: string }>();
  for (const s of readFileSync(path.join(RAW, 'COUNTRY.TXT'), 'latin1').split(/\r?\n/)) {
    const code = s.slice(0, 4), name = s.slice(11).trim();
    if (/^\d{4}$/.test(code) && NAME_ISO[name]) m.set(code, { iso: NAME_ISO[name], name });
  }
  return m;
}

// ------------------------------------------------------------------ 2. engine
const rules: Rules = JSON.parse(readFileSync(path.join(DATA, 'rules.json'), 'utf8'));
const idx = new ListIndex(rules.lists);
const shards = new Map<string, Map<string, HtsLine>>();
function htsLine(d: string): { line?: HtsLine; parent8: boolean } {
  const ch = d.slice(0, 2);
  if (!shards.has(ch)) {
    const f = path.join(DATA, 'hts', `ch${ch}.json`);
    shards.set(ch, new Map(existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as HtsLine[]).map((l) => [l.digits, l]) : []));
  }
  const s = shards.get(ch)!;
  if (s.has(d)) return { line: s.get(d), parent8: false };
  return { line: s.get(d.slice(0, 8)), parent8: true };
}
const pct = (r: Result) => (r.ok ? (r.duty / VALUE) * 100 : NaN);
const close = (a: number, b: number) => Math.abs(a - b) <= 1.5 || Math.abs(a - b) <= 0.1 * Math.max(Math.abs(a), Math.abs(b));
const within = (x: number, lo: number, hi: number) => (x >= lo - 1.5 && x <= hi + 1.5) || close(x, lo) || close(x, hi);
const f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '');

// the program a country's FTA claims use in the engine (none for GSP: lapsed)
function claimFor(iso: string): string | null {
  if (iso === 'CA' || iso === 'MX') return 'S';
  for (const [k, p] of Object.entries(rules.programs))
    if (p.in_force === true && !['C', 'K', 'L', 'N', 'W', 'Y', 'Z', 'P+', 'S+', 'E*', 'B'].includes(k) && p.countries.includes(iso)) return k;
  return null;
}

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// ------------------------------------------------------------------ 3. main
await ensureRaw();
const agg = await aggregate();
const ctys = countryMap();

const sum = (byRp: Map<string, Agg>, rps: string[]) => {
  const t = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const rp of rps) { const a = byRp.get(rp); if (a) a.forEach((v, i) => (t[i] += v)); }
  return t;
};
const ctyTot = new Map<string, number>();
for (const [k, byRp] of agg) {
  const c = k.slice(11);
  ctyTot.set(c, (ctyTot.get(c) ?? 0) + sum(byRp, [...byRp.keys()])[1]);
}
const ranked = [...ctyTot].sort((a, b) => b[1] - a[1]);
console.log('top origins by consumption value:', ranked.slice(0, 22).map(([c, v]) => `${c}:${ctys.get(c)?.iso ?? '??'}:${(v / 1e9).toFixed(1)}B`).join(' '));
const chosen = ranked.filter(([c]) => ctys.has(c)).slice(0, NCOUNTRIES).map(([c]) => c);

// sample: per country, top TOP HTS10 by value + RANDOM from the rest with value >= MIN_VAL
const rand = rng(SEED);
const sample: string[] = [];
for (const c of chosen) {
  const cells = [...agg].filter(([k]) => k.endsWith(`|${c}`) && !/^(98|99)/.test(k))
    .map(([k, byRp]) => [k, sum(byRp, RP_USED)[1]] as const).filter(([, v]) => v >= MIN_VAL).sort((a, b) => b[1] - a[1]);
  const top = cells.slice(0, TOP).map(([k]) => k);
  const rest = cells.slice(TOP).map(([k]) => k);
  for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
  sample.push(...top, ...rest.slice(0, RANDOM));
}
console.log(`countries: ${chosen.map((c) => ctys.get(c)!.iso).join(', ')}; sample ${sample.length} pairs`);

type Row = Record<string, string | number>;
const rows: Row[] = [];
for (const key of sample) {
  const [hs, cty] = key.split('|');
  const { iso } = ctys.get(cty)!;
  const byRp = agg.get(key)!;
  const all = sum(byRp, RP_USED), pr = sum(byRp, RP_PR);
  const excl = sum(byRp, [...byRp.keys()].filter((r) => !RP_USED.includes(r)));
  const s69 = sum(byRp, ['69']), s61 = sum(byRp, ['61']);
  const rAll = (all[3] / all[1]) * 100;
  const { line, parent8 } = htsLine(hs);
  const mode: Mode = iso === 'CA' || iso === 'MX' ? 'truck' : 'ocean';
  // quantities per $100,000 at the cell's real unit value, so specific rates price like the real entries
  const q1 = all[4] > 0 ? (all[4] * VALUE) / all[1] : undefined, q2 = all[5] > 0 ? (all[5] * VALUE) / all[1] : undefined;
  const run = (entryDate: string, claim: string | null, answers: Answers = {}) =>
    calculate({ hts: hs, origin: iso, value: VALUE, entryDate, mode, claim, quantity: q1, quantity2: q2, answers } as Input, line, rules, idx);
  const row: Row = { hs10: hs, country: iso, cty_code: cty, con_val: all[1], dut_val: all[2], cal_dut: all[3], cards: all[0],
    excluded_val: excl[1], rp18_64_share: f2((pr[1] / all[1]) * 100), rp69_share: f2((s69[1] / all[1]) * 100), rp61_share: f2((s61[1] / all[1]) * 100),
    rp10_share: f2((sum(byRp, ['10'])[1] / all[1]) * 100), rp19_share: f2((sum(byRp, ['19'])[1] / all[1]) * 100), real_all: f2(rAll),
    real_rp69_on_dutval: s69[2] ? f2((s69[3] / s69[2]) * 100) : '', parent8: parent8 ? 1 : 0 };
  if (!line) { rows.push({ ...row, status: 'NO_LINE', note: 'HTS10 and its 8-digit parent missing from Rev 21 data' }); continue; }
  const e0 = run(ENTRY, null);
  if (!e0.ok) { rows.push({ ...row, status: 'ENGINE_ERROR', note: e0.error ?? '' }); continue; }
  const E0 = pct(e0);
  const base = e0.lines.find((l) => l.family === 'base')!;
  const claim = claimFor(iso);
  const eC = claim ? run(ENTRY, claim) : null;
  const EC = eC && eC.ok ? pct(eC) : NaN;
  const dates = MONTH_DATES.map((d) => pct(run(d, null)));
  const dLo = Math.min(...dates), dHi = Math.max(...dates);
  Object.assign(row, {
    engine_np: f2(E0), engine_claim: f2(EC), claim: claim ?? '', engine_base: f2((base.amount / VALUE) * 100),
    engine_date_lo: f2(dLo), engine_date_hi: f2(dHi),
    engine_lines: e0.lines.filter((l) => l.family !== 'base' && l.amount > 0).map((l) => `${l.heading}:${f2((l.amount / VALUE) * 100)}`).join(' '),
    engine_zero_lines: e0.lines.filter((l) => l.family !== 'base' && l.amount === 0).map((l) => l.heading).join(' '),
    defaults: e0.defaults.map((d) => `${d.id}=${d.value}`).join(' '),
    adcvd: e0.adcvd.filter((o) => !o.broad).map((o) => o.case).join(' '),
    blend_ok: claim && Number.isFinite(EC) ? (within(rAll, Math.min(E0, EC), Math.max(E0, EC)) ? 1 : 0) : '',
  });
  {
    // signed distance (pct points) from the engine's no-claim..claim band to the real rate, and the dollars it represents
    const blo = Number.isFinite(EC) ? Math.min(E0, EC) : E0, bhi = Number.isFinite(EC) ? Math.max(E0, EC) : E0;
    const g = rAll > bhi ? rAll - bhi : rAll < blo ? rAll - blo : 0;
    row.gap_pp = f2(g);
    row.gap_usd = Math.round((g * all[1]) / 100);
    // entries that reported a ch.99 rate (RP 69): what they paid on dutiable value vs the engine's rate
    if (s69[1] >= 0.2 * all[1] && e0.lines.some((l) => l.family !== 'base' && l.amount > 0)) {
      const r69 = (s69[3] / s69[2]) * 100;
      row.rp69_check = close(r69, E0) || (Number.isFinite(EC) && close(r69, EC)) ? 'same' : r69 > E0 ? 'rp69-higher' : 'rp69-lower';
    }
  }

  // Judge on all consumption entries (RP 10/18/19/61/62/64/69). The RP split cannot isolate USMCA claims any more:
  // in 2026 most claimed CA/MX value sits in RP 19 (free under a ch.99 heading) next to unclaimed exemptions.
  // Countries with an FTA: the real rate is a blend of claimed and unclaimed entries, so any rate between the
  // engine's claim and no-claim results is consistent (MATCH_BLEND).
  const R = rAll;
  const lo = Number.isFinite(EC) ? Math.min(E0, EC) : E0, hi = Number.isFinite(EC) ? Math.max(E0, EC) : E0;
  if (close(E0, R) || (Number.isFinite(EC) && close(EC, R))) { rows.push({ ...row, status: 'MATCH' }); continue; }
  if (Number.isFinite(EC) && within(R, lo, hi)) { rows.push({ ...row, status: 'MATCH_BLEND' }); continue; }
  let why = '', mixed = '';
  // a. a rule that starts or ends inside the month (note 51 Canada 08-22, quartz safeguard 08-15)
  const ddC = claim ? MONTH_DATES.map((d) => pct(run(d, claim))) : [];
  const span = [...dates, ...ddC].filter(Number.isFinite);
  if (dHi - dLo > 0.5 && within(R, Math.min(...span), Math.max(...span))) why = `mid-month(${dates.map(f2).join('/')})`;
  // b. a follow-up question answered the other way (one question at a time), or a mix of importers answering both
  //    ways. oldVehicle (25+ years old) can't explain bulk trade and is skipped; usContent (USMCA vehicles) is tried
  //    at 25/50/75% of the value and counts only as "mixed", since the real US-content share is unknown.
  if (!why) {
    const flips: [string, Answers][] = [];
    for (const q of e0.questions) {
      if (q.id === 'oldVehicle') continue;
      if (q.kind === 'yesno') flips.push([`${q.id}=${!q.defaultValue}`, { [q.id]: !q.defaultValue } as Answers]);
      else if (q.kind === 'choice') for (const o of q.options ?? []) if (o.value !== q.defaultValue) flips.push([`${q.id}=${o.value}`, { [q.id]: o.value } as Answers]);
    }
    const usc = [...e0.questions, ...(eC?.questions ?? [])].some((q) => q.id === 'usContent');
    for (const [label, ans] of flips) {
      const e = pct(run(ENTRY, null, ans)), ec = claim ? pct(run(ENTRY, claim, ans)) : NaN;
      if (!Number.isFinite(e)) continue;
      if (close(e, R) || (Number.isFinite(ec) && close(ec, R))) { why = `answer ${label} -> ${f2(e)}${Number.isFinite(ec) ? `/claim ${f2(ec)}` : ''}`; break; }
      const inMix = (x: number, y: number) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) > 0.5 && within(R, Math.min(x, y), Math.max(x, y));
      if (!mixed && (inMix(e, E0) || inMix(ec, EC))) mixed = `mixed(between default ${f2(E0)}${claim ? `/${f2(EC)}` : ''} and ${label} ${f2(e)}${claim ? `/${f2(ec)}` : ''})`;
    }
    if (!why && !mixed && usc) {
      const ecs = [0.25, 0.5, 0.75].map((x) => pct(run(ENTRY, claim, { usContent: x * VALUE })));
      if (within(R, Math.min(...ecs, EC), Math.max(...ecs, EC))) mixed = `mixed(US content 0-75%: ${[EC, ...ecs].map(f2).join('/')})`;
    }
  }
  const status = why ? 'EXPLAINED' : mixed ? 'EXPLAINED_MIXED' : 'MISMATCH';
  rows.push({ ...row, status, note: `real ${f2(R)} vs engine ${f2(E0)}${claim ? ` / claim ${claim} ${f2(EC)}` : ''}${why || mixed ? ` [${why || mixed}]` : ''}`,
    hypothesis: status === 'MISMATCH' ? hypothesis(row, R < lo && Number.isFinite(EC) && EC <= E0 ? eC! : e0, R, line) : '' });
}

// First-pass hypothesis for a mismatch. Specific patterns first (checked by hand on the examples in the report),
// then generic: which engine line, if dropped, reproduces the real rate; else the size of the gap.
function hypothesis(row: Row, r: Result, real: number, line: HtsLine): string {
  const ctry = row.country, eng = pct(r);
  const ch99 = r.lines.filter((l) => l.family !== 'base' && l.amount > 0);
  const basePct = ((r.lines.find((l) => l.family === 'base')?.amount ?? 0) / VALUE) * 100;
  const has = (re: RegExp) => ch99.some((l) => re.test(l.heading));
  const rp19 = Number(row.rp19_share), rp61 = Number(row.rp61_share), r69 = Number(row.real_rp69_on_dutval);
  if (eng > real) {
    if (line.chapter === '88' && has(/^9903\.08\.2/)) return 'Ch.88 aircraft part charged the drone 232 (droneUse defaults to yes for all of ch.88) and note 52 (civilAircraft defaults to no)';
    const col1 = line.special.find((x) => ['K', 'C', 'L'].includes(x.program) && x.rate?.kind === 'free');
    if (col1 && real < basePct - 1) return `Base rate free under program ${col1.program} (open to all column-1 countries), but the engine rejects ${col1.program} claims for every country`;
    const VEH = /^9903\.94\.(0[1-4]|40|41|50|51|60|61)$|^9903\.74\.(0[1-3]|06)$/;
    const PARTS = /^9903\.94\.(0[5-7]|3[23]|4[2-5]|5[2-5]|6[2-9])$|^9903\.74\.(0[89]|10)$/;
    if (ch99.some((l) => VEH.test(l.heading)) && (ctry === 'MX' || ctry === 'CA'))
      return 'USMCA vehicle: Section 232 vehicle duty charged on the full value (usContent defaults to 0); collected duty implies most value is US content';
    if (ch99.some((l) => PARTS.test(l.heading)) && (close(real, basePct) || real < basePct + 0.5 * (eng - basePct)))
      return 'Section 232 auto-parts duty charged in full; collected duty is near the base rate (or free), consistent with a manufacturer import-adjustment offset (note 33(g)) the engine does not ask about';
    if (ch99.some((l) => PARTS.test(l.heading))) return 'Section 232 auto-parts duty partly collected (offset or non-auto use on part of the entries)';
    if (has(/^9903\.82\./)) return 'Section 232 metals charged on the full value; collected duty is lower';
    if (ch99.some((l) => l.family === 's301_forced_labor') && rp19 + rp61 >= 30 && Number.isFinite(r69) && close(r69, eng))
      return 'Note 52 rate matches what RP 69 entries paid, but a large share entered free/base-only under an exemption the engine does not apply by default';
    for (const l of ch99) if (close(eng - (l.amount / VALUE) * 100, real)) return `${l.family} (${l.heading}) charged by the engine but not collected`;
    if (ch99.some((l) => l.family === 's301_forced_labor') && Number(row.rp69_share) >= 70 && Number.isFinite(r69) && r69 > basePct && r69 < eng)
      return 'Note 52 partly collected: entries reporting a ch.99 rate paid between the base rate and the engine rate (mixed treatment within the code)';
    if (ch99.length && close(basePct, real)) return `All ch.99 lines (${ch99.map((l) => l.family).join('+')}) charged by the engine but not collected`;
    if (!ch99.length) return 'Base rate higher than collected';
    return `Collected less than the engine's ${ch99.map((l) => l.family).join('+')} (partial)`;
  }
  if (Object.keys(row).length && String(row.defaults).includes('comp:')) return 'Base rate depends on component values/counts the engine defaults to 0 (watches, sets): engine base too low';
  if (!ch99.length && rp19 + rp61 < 90 && Number(row.rp69_share) > 10) return 'Some entries paid a ch.99 duty the engine does not charge by default';
  const gap = real - eng;
  const near = [2.5, 5, 7.5, 10, 12.5, 15, 20, 25, 30, 35, 40, 50, 60, 100].find((x) => Math.abs(gap - x) <= 0.15 * x);
  return `Collected more than the engine: ~${near ?? 'n/a'} pct points (engine ch.99: ${ch99.map((l) => l.family).join('+') || 'none'})`;
}

// ------------------------------------------------------------------ 4. output
mkdirSync(OUT, { recursive: true });
const cols = ['hs10', 'country', 'cty_code', 'status', 'con_val', 'excluded_val', 'dut_val', 'cal_dut', 'cards',
  'real_all', 'real_rp69_on_dutval', 'rp69_share', 'rp61_share', 'rp10_share', 'rp19_share', 'rp18_64_share', 'engine_np', 'engine_claim', 'claim',
  'engine_base', 'engine_date_lo', 'engine_date_hi', 'gap_pp', 'gap_usd', 'rp69_check', 'engine_lines', 'engine_zero_lines', 'defaults', 'adcvd', 'blend_ok', 'parent8', 'note', 'hypothesis'];
const esc = (v: unknown) => { const s = v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
writeFileSync(path.join(OUT, `census_${MONTH}.csv`), [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n');

const by = (k: (r: Row) => string) => { const m = new Map<string, Row[]>(); for (const r of rows) { const g = k(r); m.set(g, [...(m.get(g) ?? []), r]); } return m; };
const val = (rs: Row[]) => rs.reduce((s, r) => s + Number(r.con_val), 0);
const totVal = val(rows);
const counts = by((r) => String(r.status));
const md: string[] = [`# Census ${MONTH} validation: automatic summary`, '',
  `Pairs: ${rows.length}; value $${(totVal / 1e9).toFixed(2)}B. Entry date ${ENTRY}, value $${VALUE}, ocean (truck CA/MX).`, '',
  '| status | pairs | value share |', '|---|---|---|',
  ...[...counts].map(([k, rs]) => `| ${k} | ${rs.length} | ${((val(rs) / totVal) * 100).toFixed(1)}% |`), ''];
// value-weighted comparison by country: real rate vs engine no-claim and claim rates
md.push('| country | pairs | value $M | real rate | engine no-claim | engine claim | MATCH | BLEND | EXPL | MIXED | MISMATCH | mismatch value share |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
const wavg = (rs: Row[], k: string) => { const ok = rs.filter((r) => r[k] !== '' && r[k] !== undefined); const v = val(ok); return v ? ok.reduce((s, r) => s + Number(r.con_val) * Number(r[k]), 0) / v : NaN; };
const ok = rows.filter((r) => r.engine_np !== undefined && r.engine_np !== '');
for (const [c, rs] of [...by((r) => String(r.country)), ['all', rows] as [string, Row[]]]) {
  const n = (st: string) => rs.filter((r) => r.status === st).length;
  const okc = rs.filter((r) => ok.includes(r));
  md.push(`| ${c} | ${rs.length} | ${(val(rs) / 1e6).toFixed(0)} | ${f2(wavg(okc, 'real_all'))}% | ${f2(wavg(okc, 'engine_np'))}% | ${okc.some((r) => r.engine_claim !== '') ? f2(wavg(okc.filter((r) => r.engine_claim !== ''), 'engine_claim')) + '%' : '-'} | ${n('MATCH')} | ${n('MATCH_BLEND')} | ${n('EXPLAINED')} | ${n('EXPLAINED_MIXED')} | ${n('MISMATCH')} | ${((val(rs.filter((r) => r.status === 'MISMATCH')) / val(rs)) * 100).toFixed(1)}% |`);
}
md.push('');
const usd = (rs: Row[]) => rs.reduce((t, r) => t + Number(r.gap_usd ?? 0), 0);
const groupTable = (title: string, key: (r: Row) => string) => {
  md.push(`## ${title}`, '', '| group | pairs | value share of sample | gap $M (real minus engine band) | largest example | real | engine (no claim / claim) | engine ch.99 lines |', '|---|---|---|---|---|---|---|---|');
  const g = by(key); g.delete('');
  for (const [h, rs] of [...g].sort((x, y) => Math.abs(usd(y[1])) - Math.abs(usd(x[1])))) {
    const ex = [...rs].sort((x, y) => Math.abs(Number(y.gap_usd)) - Math.abs(Number(x.gap_usd)))[0];
    md.push(`| ${h} | ${rs.length} | ${((val(rs) / totVal) * 100).toFixed(2)}% | ${(usd(rs) / 1e6).toFixed(1)} | ${ex.hs10} ${ex.country} | ${ex.real_all} | ${ex.engine_np}${ex.engine_claim !== '' ? ` / ${ex.claim} ${ex.engine_claim}` : ''} | ${ex.engine_lines} |`);
  }
  md.push('');
};
groupTable('Mismatch groups (first-pass hypothesis)', (r) => (r.status === 'MISMATCH' ? String(r.hypothesis) : ''));
groupTable('Explained / mixed groups (which default answer moves it)', (r) => {
  if (r.status !== 'EXPLAINED' && r.status !== 'EXPLAINED_MIXED') return '';
  const m = /\[(answer ([^ ]+)|mixed\(between default [^ ]+ and ([^ ]+)|mixed\((US content)|mid-month)/.exec(String(r.note));
  return `${r.status}: ${m ? (m[2] ?? m[3] ?? m[4] ?? 'mid-month') : '?'}`;
});
const chk = by((r) => String(r.rp69_check ?? ''));
chk.delete('');
md.push('## RP 69 check (entries that reported a ch.99 rate: rate paid on dutiable value vs engine)', '', '| result | pairs | value share |', '|---|---|---|',
  ...[...chk].map(([k, rs]) => `| ${k} | ${rs.length} | ${((val(rs) / totVal) * 100).toFixed(1)}% |`), '');
writeFileSync(path.join(OUT, `census_${MONTH}_groups.md`), md.join('\n') + '\n');
// machine-readable totals for the update and monthly jobs (pipeline/census_gate.py)
writeFileSync(path.join(OUT, `census_${MONTH}_summary.json`), JSON.stringify({ month: MONTH, revision: rules.meta.revision,
  pairs: rows.length, valueB: Number((totVal / 1e9).toFixed(2)),
  share: Object.fromEntries([...counts].map(([k, rs]) => [k, Number(((val(rs) / totVal) * 100).toFixed(2))])),
  count: Object.fromEntries([...counts].map(([k, rs]) => [k, rs.length])) }, null, 1) + '\n');
console.log(md.slice(0, 12 + by((r) => String(r.country)).size + 4).join('\n'));
