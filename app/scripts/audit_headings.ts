// Exhaustive filing audit: for every code on every tariff list, every origin the measure reaches and every path through
// the questions, the entry must carry at least one heading of that measure (a 0% "not covered" / exempt heading counts).
//   npx tsx scripts/audit_headings.ts [--max 200]   -> prints violations grouped by family and path; exit 1 if any
import { readFileSync, readdirSync } from 'node:fs';
import { calculate, digitsOf, ListIndex } from '../src/engine/calc';
import type { Answers, HtsLine, Input, Question, Result, Rules } from '../src/engine/types';

const DATA = new URL('../public/data/', import.meta.url);
const rules: Rules = JSON.parse(readFileSync(new URL('rules.json', DATA), 'utf8'));
const idx = new ListIndex(rules.lists);
const all: HtsLine[] = readdirSync(new URL('hts/', DATA)).filter((f) => /^ch\d\d\.json$/.test(f) && f !== 'ch99.json')
  .flatMap((f) => JSON.parse(readFileSync(new URL(`hts/${f}`, DATA), 'utf8')) as HtsLine[]);
const leaves = all.filter((l) => l.digits.length === 10);
const byDigits = new Map(all.map((l) => [l.digits, l]));
const MAX = Number(process.argv[process.argv.indexOf('--max') + 1]) || 120;

const leavesOf = (keys: string[]) => {
  const pre = keys.flatMap((k) => rules.lists[k] ?? []).map(digitsOf);
  return leaves.filter((l) => pre.some((p) => l.digits.startsWith(p)));
};
const keysLike = (re: RegExp) => Object.keys(rules.lists).filter((k) => re.test(k));
const sample = (n: number) => leaves.filter((_, i) => i % n === 0);

type Fam = { name: string; codes: HtsLine[]; origins: { o: string; claim?: string }[]; heads: RegExp; dates?: string[];
  /** the only lawful reasons to file nothing for this measure, each with its source */
  excused?: (r: Result, o: string, a: Answers) => boolean };
// 232 headings whose notes say the goods "shall not be subject to" the metals duties 9903.82.02/.04–.26:
// autos/parts (33, L230718–231244), MHDV and MHDV parts (38, L231648–231657, L231733–231744), chips (39, L231848), civil aircraft (35)
const DISPLACES_METALS = /^9903\.(94\.(0[13457]|3[1-3]|4\d|5\d|6\d)|74\.(0[1-489]|10)|79\.01|96\.0[1-3])$/;
// USMCA car parts on 9903.94.06 are also outside metals (note 16, L210521–210523: "9903.94.06 (as applied to ... USMCA)")
const metalsDisplaced = (r: Result) => r.lines.some((l) => DISPLACES_METALS.test(l.heading) || (l.heading === '9903.94.06' && /USMCA/.test(l.label)));
// 9903.79.01 chips are not subject to the auto and auto-parts duties (39(a), L231848–231860)
const chipDisplaces = (r: Result) => r.lines.some((l) => l.heading === '9903.79.01');
const O232 = ['CN', 'DE', 'FR', 'JP', 'KR', 'GB', 'TW', 'IN', 'BR', 'VN', 'CH', 'MX', 'CA'].map((o) => ({ o }))
  .concat([{ o: 'CA', claim: 'S' }, { o: 'MX', claim: 'S' }]);
const FAMS: Fam[] = [
  { name: 'note 16 metals', codes: leavesOf(keysLike(/^s232:n16_c_/)), origins: O232, heads: /^9903\.(82|85)\./, excused: metalsDisplaced },
  { name: 'note 19 Russian aluminum', codes: leavesOf(keysLike(/^s232:n19_/)), origins: [{ o: 'RU' }], heads: /^9903\.85\./, excused: metalsDisplaced },
  // 8704.60 is on 33(b) and 38(b); a medium/heavy truck files note 38 only (note 33 has no "not covered" vehicle heading)
  { name: 'note 33 vehicles', codes: leavesOf(['s232:n33_b_vehicles']), origins: O232, heads: /^9903\.94\./,
    excused: (r) => r.lines.some((l) => /^9903\.74\.0[13]$/.test(l.heading)) },
  { name: 'note 33 parts', codes: leavesOf(['s232:n33_g_parts']), origins: O232, heads: /^9903\.94\./, excused: chipDisplaces },
  { name: 'note 38 vehicles', codes: leavesOf(['s232:n38_b_mhdv', 's232:n38_c_buses']), origins: O232, heads: /^9903\.74\./ },
  { name: 'note 38 parts', codes: leavesOf(['s232:n38_i_mhdv_parts']), origins: O232, heads: /^9903\.74\./ },
  { name: 'note 37 wood', codes: leavesOf(keysLike(/^s232:n37_/)), origins: O232, heads: /^9903\.76\./ },
  { name: 'note 39 semis', codes: leavesOf(['s232:n39_b_semis']), origins: O232, heads: /^9903\.79\./ },
  { name: 'note 40 pharma', codes: leavesOf(['s232:n40_c_pharma']), origins: O232, heads: /^9903\.04\.(6\d|70)$/ },
  { name: 'note 43 drones', codes: leavesOf(keysLike(/^s232:n43_/)), origins: O232, heads: /^9903\.08\./ },
  { name: 'note 41 quartz', codes: leavesOf(['n41:qsp']), origins: O232, heads: /^9903\.45\./,
    excused: (_r, o) => rules.n41.exempt.includes(o) }, // 41(c) exempt countries: no heading exists for them
  { name: 'note 20/31 China 301', codes: leavesOf(keysLike(/^s301:/)).filter((l) => rules.s301.measures.some((m) => !m.suspended && idx.has(m.list, l.code) && !m.carve10.map(digitsOf).includes(l.digits))), origins: [{ o: 'CN' }], heads: /^9903\.(88|91|92)\./, dates: ['2026-10-28', '2026-11-20'] },
  { name: 'note 50 Brazil', codes: [...sample(40), ...leavesOf(keysLike(/^n50:/))], origins: [{ o: 'BR' }], heads: /^9903\.05\.0\d$/ },
  { name: 'note 52 forced labor', codes: sample(60), origins: Object.keys(rules.n52.countries).filter((k) => k.length === 2 && k !== 'EU').map((o) => ({ o })), heads: /^9903\.0[56]\./ },
  { name: 'note 29 Nicaragua', codes: sample(40), origins: [{ o: 'NI' }], heads: /^9903\.89\.01$/ },
  { name: 'note 30 Russia', codes: leavesOf(['n30:b', 'n30:d']), origins: [{ o: 'RU' }], heads: /^9903\.90\./ },
  // Japan leather / footwear (subch. III note 3): excluded kinds have no heading to file
  { name: 'Japan leather 9903.41', codes: leaves.filter((l) => /^(4104|4107|4105|4112|41061|411310|6403)/.test(l.digits)), origins: [{ o: 'JP' }],
    heads: /^9903\.41\.(05|10)$/, excused: (_r, _o, a) => a.japanLeather === false },
  { name: 'note 51 Canada', codes: leavesOf(['n51:12', 'n51:13', 'n51:14']), origins: [{ o: 'CA' }, { o: 'CA', claim: 'S' }], heads: /^9903\.03\./ },
];

function valuesFor(q: Question, value: number): unknown[] {
  if (q.kind === 'yesno') return [!q.defaultValue];
  if (q.kind === 'choice') return (q.options ?? []).map((o) => o.value).filter((v) => v !== q.defaultValue);
  if (q.kind === 'number') return [q.money ? Math.round(value * 0.3) : 50];
  if (q.kind === 'text') return ['CN', 'US', 'CA'].filter((v) => v !== q.defaultValue);
  return [];
}

const viol = new Map<string, { n: number; ex: string }>();
let runs = 0, cases = 0;
for (const f of FAMS) {
  let famCases = 0;
  for (const line of f.codes) for (const { o, claim } of f.origins) for (const date of f.dates ?? ['2026-10-28']) {
    famCases++;
    const base: Input = { hts: line.code, origin: o, value: 100000, entryDate: date, mode: 'ocean', claim: claim ?? null, quantity: 1000, quantity2: 1000, answers: {} };
    const seen = new Set<string>(); const stack: Answers[] = [{}];
    while (stack.length && seen.size < MAX) {
      const a = stack.pop()!; const key = JSON.stringify(Object.entries(a).sort());
      if (seen.has(key)) continue; seen.add(key);
      const r: Result = calculate({ ...base, answers: a }, byDigits.get(line.digits), rules, idx); runs++;
      if (!r.ok) continue; // claim not available for this code, etc.
      if (f.name === 'note 52 forced labor' && !rules.n52.countries[o]) continue;
      if (!r.lines.some((l) => f.heads.test(l.heading)) && !f.excused?.(r, o, a)) {
        const path = Object.entries(a).map(([k, v]) => `${k}=${String(v)}`).sort().join(',') || '(defaults)';
        const sig = `${f.name} | ${o}${claim ? '+' + claim : ''} | ${path} | filed: ${r.lines.map((l) => l.heading).join(' ')}`;
        const shape = `${f.name} | ${path.replace(/=[^,]*/g, '')}`;
        const v = viol.get(shape + ' | ' + sig.split(' | ').slice(1, 2)) ?? { n: 0, ex: `${line.code} ${date} :: ${sig}` };
        v.n++; viol.set(shape + ' | ' + sig.split(' | ').slice(1, 2), v);
      }
      for (const q of r.questions) {
        if (q.id in a || q.id === 'quantity' || q.id === 'quantity2' || q.id === 'claim') continue;
        for (const v of valuesFor(q, base.value)) stack.push({ ...a, [q.id]: v });
      }
    }
  }
  cases += famCases;
  console.error(`${f.name}: ${f.codes.length} codes, ${famCases} code×origin cases`);
}
console.log(`\n${cases} cases, ${runs} calculations, ${viol.size} violation shapes`);
for (const [k, v] of [...viol.entries()].sort()) console.log(`${String(v.n).padStart(6)}  ${k}\n        e.g. ${v.ex}`);
process.exit(viol.size ? 1 : 0);
