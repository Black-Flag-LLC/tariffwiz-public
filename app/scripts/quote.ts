// One quote from the command line, using the same engine and data as the site.
//   npm --prefix app run quote -- --hts 6110.20.20.20 --from VN --value 5000 --mode air [--entry 2026-10-28]
//     [--qty 100] [--qty2 20] [--claim S] [--loaded 2026-10-01] [--answers '{"metalWeight15":true}']
import { readFileSync } from 'node:fs';
import { calculate, digitsOf, ListIndex } from '../src/engine/calc';
import type { HtsLine, Input, Mode, Rules } from '../src/engine/types';

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined; };
const DATA = new URL('../public/data/', import.meta.url);
const rules: Rules = JSON.parse(readFileSync(new URL('rules.json', DATA), 'utf8'));
const hts = arg('hts') ?? '';
const line = (JSON.parse(readFileSync(new URL(`hts/ch${digitsOf(hts).slice(0, 2)}.json`, DATA), 'utf8')) as HtsLine[])
  .find((l) => l.digits === digitsOf(hts));
const input: Input = { hts, origin: (arg('from') ?? '').toUpperCase(), value: Number(arg('value')), entryDate: arg('entry') ?? new Date().toISOString().slice(0, 10),
  loadingDate: arg('loaded'), mode: (arg('mode') ?? 'ocean') as Mode, quantity: arg('qty') ? Number(arg('qty')) : undefined,
  quantity2: arg('qty2') ? Number(arg('qty2')) : undefined, claim: arg('claim') ?? null, answers: arg('answers') ? JSON.parse(arg('answers')!) : {} };
const r = calculate(input, line, rules, new ListIndex(rules.lists));
if (!r.ok) { console.error(r.error); process.exit(1); }
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
console.log(`${r.line!.code} ${r.line!.desc}\n${r.line!.path}\n`);
for (const l of [...r.lines, ...r.fees]) console.log(`${l.heading.padEnd(14)} ${l.rate.padEnd(16)} ${usd(l.amount).padStart(12)}  ${l.label} — ${l.why} [${l.cite}]${l.assumed ? ` (assumed: ${l.assumed})` : ''}`);
console.log(`\nDuty ${usd(r.duty)} + fees/taxes ${usd(r.feesTotal)} = TOTAL ${usd(r.total)}  (effective ${r.effectivePct}%)  rules ${r.revision}`);
if (r.questions.length) console.log('\nQuestions (defaults used):\n' + r.questions.map((q) => `- ${q.id}: ${q.text} [default ${q.defaultValue}]`).join('\n'));
if (r.adcvd.length) console.log('\nAD/CVD orders that may apply: ' + r.adcvd.map((o) => `${o.case} ${o.product}`).join('; '));
if (r.notes.length) console.log('\nNotes:\n' + r.notes.map((n) => `- ${n}`).join('\n'));
