// Multi-line entries: each line priced by calculate(); entry-level fees recomputed once per entry.
// MPF: sum of non-exempt lines' 0.3464%, then the fiscal-year min/max once per entry (19 CFR 24.23;
// ACE CATAIR). Informal entry (total value ≤ $2,500): one flat fee. HMF: 0.125% of ocean cargo value.
import { calculate, cents, CHIP_NOTICE, ListIndex } from './calc';
import type { HtsLine, Input, Line, Result, Rules } from './types';
import { xlsx } from './xlsx';
import { resolveCountry } from '../countries';

/** ACE entry types this tool prices: consumption 01, AD/CVD 03, FTZ consumption 06, informal 11, warehouse 21, TIB 23 */
export type EntryType = '01' | '03' | '06' | '11' | '21' | '23';
export const ENTRY_TYPES: { value: EntryType; label: string }[] = [
  { value: '01', label: '01 Consumption' }, { value: '03', label: '03 Consumption, AD/CVD' }, { value: '06', label: '06 FTZ consumption' },
  { value: '11', label: '11 Informal' }, { value: '21', label: '21 Warehouse' }, { value: '23', label: '23 Temporary importation bond' }];

export const FEE_CLASS: Record<string, string> = { MPF: '499', HMF: '501', Cotton: '056' }; // ACE fee class codes
export const MOT: Record<string, string> = { ocean: '10/11', air: '40/41', truck: '30/31', rail: '20/21', mail: '50', other: '' };

export interface EntryLine { input: Input; line: HtsLine | undefined }
export interface EntryResult {
  lines: (Result & { n: number; input: Input })[];
  fees: Line[];            // entry-level fees (MPF once, HMF summed, cotton/excise per line summed)
  duty: number;
  feesTotal: number;
  total: number;
  value: number;
  entryType: EntryType;
  autoType: '01' | '03' | '11';  // what the lines call for
  dueNow: number;          // cash due at entry (warehouse and TIB defer the duty)
  byFamily: Record<string, number>;
  errors: string[];
  warnings: string[];      // entry-type conflicts and what the chosen type means
}
export interface EntryOptions { entryType?: EntryType | '' }

const MPF_FY = [
  { from: '2025-10-01', min: 33.58, max: 651.5, informal: 2.69 },
  { from: '2026-10-01', min: 34.58, max: 670.86, informal: 2.77 },
];

export function calculateEntry(items: EntryLine[], rules: Rules, idx = new ListIndex(rules.lists), opts: EntryOptions = {}): EntryResult {
  const lines = items.map((it, i) => ({ ...calculate({ ...it.input, inEntry: true }, it.line, rules, idx), n: i + 1, input: it.input }));
  const ok = lines.filter((l) => l.ok);
  const errors = lines.filter((l) => !l.ok).map((l) => `Line ${l.n}: ${l.error}`);
  const value = cents(ok.reduce((s, l) => s + l.input.value, 0));
  const duty = cents(ok.reduce((s, l) => s + l.duty, 0));
  const entryDate = items[0]?.input.entryDate ?? '';
  const mode = items[0]?.input.mode;
  const fy = [...MPF_FY].reverse().find((f) => entryDate >= f.from) ?? MPF_FY[0];
  const fees: Line[] = [];

  // MPF once per entry
  // TIB (23) is MPF-exempt (CATAIR note m)
  const dutiable = opts.entryType === '23' ? [] : ok.filter((l) => l.fees.find((f) => f.heading === 'MPF')?.rate !== 'exempt');
  const adcvd = ok.some((l) => l.entryType === '03');
  const chosen = opts.entryType || undefined;
  const mustFormal = ok.find((l) => l.formalRequired);
  const informal = chosen ? chosen === '11' : value <= 2500 && !adcvd && !mustFormal;
  const warnings: string[] = [];
  if (mustFormal) warnings.push(`Line ${mustFormal.n}: ${mustFormal.formalRequired}`);
  if (chosen === '11' && value > 2500) warnings.push('Informal entry (11) is limited to $2,500 total value; this entry needs a formal entry.');
  if (chosen && adcvd && chosen !== '03') warnings.push('Lines covered by an AD/CVD order must be filed on a type 03 entry.');
  if (chosen === '03' && !adcvd) warnings.push('Type 03 is for AD/CVD goods; no line here matched an order.');
  if (chosen === '06') warnings.push('FTZ (06): goods subject to Section 232, 301 and other Chapter 99 duties generally had to be admitted in privileged foreign status, which fixes their classification and rates at admission. Check each line\'s zone status.');
  if (chosen === '21') warnings.push('Warehouse (21): duty is deferred until withdrawal for consumption (type 31/32) and charged at the rates in force on the withdrawal date.');
  if (chosen === '23') warnings.push('Temporary importation bond (23): no duty is paid if the goods are exported in time; the bond is usually set at twice the estimated duty (19 CFR 10.31(f)).');
  if (!dutiable.length) {
    fees.push({ family: 'fee', heading: 'MPF', label: 'Merchandise processing fee', rate: 'exempt', amount: 0,
      why: opts.entryType === '23' ? 'Temporary importation bond (23) entries are exempt.' : 'Every line is exempt (trade-agreement claims, Chapter 98 or mail).',
      cite: opts.entryType === '23' ? '19 CFR 24.23(c); CATAIR note (m)' : '19 CFR 24.23(c)' });
  } else if (informal) {
    fees.push({ family: 'fee', heading: 'MPF', label: 'Merchandise processing fee (informal entry)', rate: 'flat', amount: mode === 'mail' ? 0 : fy.informal,
      why: mode === 'mail' ? 'Postal informal entry: no fee.' : 'Entry value of $2,500 or less: informal entry, one flat fee.', cite: '19 CFR 24.23(b)(2)' });
  } else {
    const raw = dutiable.reduce((s, l) => s + (l.mpfBase ?? l.input.value) * 0.003464, 0);
    const amt = Math.min(fy.max, Math.max(fy.min, raw));
    fees.push({ family: 'fee', heading: 'MPF', label: 'Merchandise processing fee', rate: '0.3464%', amount: cents(amt),
      why: raw < fy.min ? `0.3464% of the dutiable lines is $${raw.toFixed(2)}: raised to the entry minimum of $${fy.min}.`
        : raw > fy.max ? `0.3464% of the dutiable lines is $${raw.toFixed(2)}: capped at the entry maximum of $${fy.max}.`
          : `0.3464% of $${cents(raw / 0.003464).toLocaleString('en-US')} in non-exempt lines (min $${fy.min}, max $${fy.max} per entry).`,
      cite: '19 CFR 24.23(b)(1); CBP Dec. 26-14' });
  }
  // HMF on the whole ocean entry (formal only), then per-line fees and taxes summed
  if (mode === 'ocean' && !informal) {
    const hmf = cents(value * 0.00125);
    fees.push({ family: 'fee', heading: 'HMF', label: 'Harbor maintenance fee', rate: '0.125%', amount: hmf, why: 'Charged on cargo arriving by ship.', cite: '19 CFR 24.24' });
  }
  // same rule as a single quote: HMF of $3 or less isn't collected when nothing else is due
  const hmfLine = fees.find((f) => f.heading === 'HMF');
  if (hmfLine && hmfLine.amount <= 3 && duty === 0 && fees.every((f) => f === hmfLine || f.amount === 0)
    && !ok.some((l) => l.fees.some((f) => (f.heading === 'Cotton' || f.heading === 'Excise') && f.amount > 0)))
    Object.assign(hmfLine, { amount: 0, why: 'Not collected: $3 or less with nothing else due.' });
  for (const head of ['Cotton', 'Excise']) {
    const parts = ok.flatMap((l) => l.fees.filter((f) => f.heading === head));
    if (!parts.length || (head === 'Cotton' && informal)) continue;
    const sum = cents(parts.reduce((s, f) => s + f.amount, 0));
    fees.push({ family: head === 'Excise' ? 'tax' : 'fee', heading: head, label: parts[0].label.replace(/ \(.*\)$/, ''), rate: `${parts.length} line${parts.length > 1 ? 's' : ''}`,
      amount: sum, why: parts.map((f) => f.why).join(' '), cite: parts[0].cite, ...(parts.some((f) => f.assumed) ? { assumed: 'some quantities not entered yet' } : {}) });
  }
  const feesTotal = cents(fees.reduce((s, f) => s + f.amount, 0));
  const byFamily: Record<string, number> = {};
  for (const l of ok) for (const x of l.lines) byFamily[x.family] = cents((byFamily[x.family] ?? 0) + x.amount);
  for (const l of ok) if (l.lines.some((x) => x.heading === '9903.79.02' && x.assumed)) warnings.push(`Line ${l.n}: ${CHIP_NOTICE}`);
  const autoType = adcvd ? '03' : informal ? '11' : '01';
  const deferred = chosen === '21' || chosen === '23';
  return { lines, fees, duty, feesTotal, total: cents(duty + feesTotal), value, entryType: chosen ?? autoType, autoType,
    dueNow: cents((deferred ? 0 : duty) + feesTotal), byFamily, errors, warnings };
}

export interface EntryMeta { revision: string; checked: string; exportCountry?: string; mot?: string; entryDate?: string }

/** Every filed number, line by line, as spreadsheet rows (numbers stay numbers for XLSX). */
export function entryRows(e: EntryResult, meta: EntryMeta = { revision: '', checked: '' }): (string | number)[][] {
  const rows: (string | number)[][] = [['Line', 'Number', 'Description', 'Origin', 'SPI', 'Value USD', 'Dutiable USD', 'Qty 1', 'Unit 1', 'Qty 2', 'Unit 2', 'Loaded', 'Rate', 'Duty USD', 'Flag']];
  rows.push(['', 'ENTRY', `Type ${e.entryType}${e.entryType !== e.autoType ? ` (lines call for ${e.autoType})` : ''}`, '', '', e.value, '', '', '', '', '',
    meta.entryDate ?? '', `MOT ${meta.mot ?? ''}`, '', meta.exportCountry ? `export ${meta.exportCountry}` : '']);
  for (const l of e.lines) {
    if (!l.ok || !l.line) { rows.push([l.n, l.input.hts, l.error ?? '', l.input.origin, '', l.input.value, '', '', '', '', '', '', '', '', 'error']); continue; }
    for (const x of l.lines) {
      const base = x.family === 'base';
      rows.push([l.n, x.heading, base ? l.line.desc : x.label, l.input.origin, base ? (l.input.claim ?? '') : '', base ? l.input.value : '',
        x.basisValue ?? '', base && l.input.quantity !== undefined ? l.input.quantity : '', base ? l.line.units[0] ?? '' : '',
        base && l.input.quantity2 !== undefined ? l.input.quantity2 : '', base ? l.line.units[1] ?? '' : '', base ? l.input.loadingDate ?? '' : '', x.rate, x.amount,
        x.assumed ? `assumed: ${x.assumed}` : x.interpretation ? 'interpretation' : '']);
    }
  }
  for (const f of e.fees) rows.push(['', `${f.heading}${FEE_CLASS[f.heading] ? ` (${FEE_CLASS[f.heading]})` : ''}`, f.label, '', '', '', '', '', '', '', '', '', f.rate, f.amount, '']);
  rows.push(['', 'TOTAL', `Entry type ${e.entryType}; due at entry ${e.dueNow.toFixed(2)}`, '', '', e.value, '', '', '', '', '', '', '', e.total, '']);
  for (const w of e.warnings) rows.push(['', 'NOTE', w]);
  for (const l of e.lines) for (const d of l.ok ? l.defaults : []) rows.push([l.n, 'DEFAULT', d.text, '', '', '', '', '', '', '', '', '', String(d.value), '', 'confirm before filing']);
  rows.push(['', 'SOURCE', `Rules ${meta.revision} (checked ${meta.checked}); order per CSMS #69326983; ${DISCLAIMER}`]);
  return rows;
}

/** CSV of every filed number, line by line (for ACE prep / spreadsheets). */
export function entryCsv(e: EntryResult, meta: EntryMeta = { revision: '', checked: '' }): string {
  const q = (s: string | number) => `"${String(typeof s === 'number' ? (Number.isInteger(s) ? s : s.toFixed(2)) : s).replace(/"/g, '""')}"`;
  return entryRows(e, meta).map((r) => r.map(q).join(',')).join('\r\n');
}

/** The same rows as a real .xlsx workbook. */
export const entryXlsx = (e: EntryResult, meta: EntryMeta = { revision: '', checked: '' }) => xlsx(entryRows(e, meta), 'Entry');

/** Plain-text, 7501-style layout for email or notes. */
const DISCLAIMER = 'Estimate for planning only, not legal or customs advice. The filer remains responsible for classification, valuation, origin and ACE transmission.';

export function entryText(e: EntryResult, meta: { mode: string; entryDate: string; mot?: string; revision?: string; checked?: string; exportCountry?: string }): string {
  const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  const out = [`Entry type ${e.entryType} · MOT ${meta.mot ?? MOT[meta.mode] ?? ''} · entry ${meta.entryDate}${meta.exportCountry ? ` · export ${meta.exportCountry}` : ''} · ${e.lines.length} line(s) · value ${usd(e.value)}`,
    ...e.warnings.map((w) => `! ${w}`), ''];
  // the 7501 shows MPF and HMF per line: share the entry totals by line value (MPF only over non-exempt lines)
  const mpf = e.fees.find((f) => f.heading === 'MPF')?.amount ?? 0;
  const hmf = e.fees.find((f) => f.heading === 'HMF')?.amount ?? 0;
  const mpfBase = e.lines.filter((l) => l.ok && l.fees.find((f) => f.heading === 'MPF')?.rate !== 'exempt').reduce((s, l) => s + l.input.value, 0);
  for (const l of e.lines) {
    if (!l.ok || !l.line) { out.push(`${String(l.n).padStart(3)}  ${l.input.hts}  ERROR: ${l.error}`); continue; }
    out.push(`${String(l.n).padStart(3)}  ${l.line.desc.slice(0, 60)}  · ${l.input.origin}${l.input.claim ? ` · SPI ${l.input.claim}` : ''}${l.input.loadingDate ? ` · loaded ${l.input.loadingDate}` : ''} · ${usd(l.input.value)}`
      + (l.input.quantity !== undefined ? ` · ${l.input.quantity} ${l.line.units[0] ?? ''}` : '') + (l.input.quantity2 !== undefined ? ` · ${l.input.quantity2} ${l.line.units[1] ?? ''}` : ''));
    for (const x of l.lines) out.push(`       ${x.heading.padEnd(14)} ${x.rate.padEnd(22)} ${usd(x.amount).padStart(13)}${x.assumed ? `  ! assumed: ${x.assumed}` : ''}`);
    const ex = l.fees.find((f) => f.heading === 'MPF')?.rate === 'exempt';
    out.push(`       ${'499 / 501 share'.padEnd(14)} ${''.padEnd(22)} ${usd(ex || !mpfBase ? 0 : (mpf * l.input.value) / mpfBase).padStart(13)} / ${usd(e.value ? (hmf * l.input.value) / e.value : 0)}`);
    for (const d of l.defaults) out.push(`       ! default: ${d.text} ${String(d.value)}`);
  }
  out.push('');
  for (const f of e.fees) out.push(`       ${(f.heading + (FEE_CLASS[f.heading] ? ` ${FEE_CLASS[f.heading]}` : '')).padEnd(14)} ${f.rate.padEnd(16)} ${usd(f.amount).padStart(13)}`);
  out.push(`       ${'TOTAL'.padEnd(37)} ${usd(e.total).padStart(13)}   (duty ${usd(e.duty)} + fees/taxes ${usd(e.feesTotal)})`);
  if (e.dueNow !== e.total) out.push(`       ${'DUE AT ENTRY'.padEnd(37)} ${usd(e.dueNow).padStart(13)}   (duty deferred)`);
  out.push('', `Rules ${meta.revision ?? ''} (checked ${meta.checked ?? ''}) · Chapter 99 numbers first, commodity line last (CSMS #69326983)`, DISCLAIMER);
  return out.join('\n');
}

/** Parse pasted spreadsheet rows: HTS, country, value[, qty[, qty2[, SPI]]] separated by tabs, commas or semicolons. */
export function parseLines(text: string): { hts: string; origin: string; value: string; quantity: string; quantity2: string; claim: string }[] {
  // "10.000,50" / "10000,50" with semicolons (European spreadsheets): comma is the decimal mark; otherwise commas group thousands
  // Number formats: "10,000.50" (US), "10.000,50" or "10000,50" (decimal comma: 1-2 digits after the last comma),
  // "10.000" in a semicolon row (European thousands). A comma followed by 3 digits is always a thousands mark.
  const num = (s: string | undefined, semi: boolean) => {
    const t = (s ?? '').replace(/[$\s]/g, '');
    if (/^\d{1,3}(\.\d{3})*,\d{1,2}$|^\d+,\d{1,2}$/.test(t)) return t.replace(/\./g, '').replace(',', '.');
    if (semi && /^\d{1,3}(\.\d{3})+$/.test(t)) return t.replace(/\./g, '');
    return t.replace(/,/g, '').replace(/[^\d.]/g, '');
  };
  // one delimiter per row: tab (spreadsheet paste) > semicolon > comma outside quotes ("$10,000" stays whole when tab-separated)
  const delim = (r: string) => (r.includes('\t') ? 'tab' : r.includes(';') ? 'semi' : 'comma');
  const split = (r: string) => (r.includes('\t') ? r.split('\t') : r.includes(';') ? r.split(';') : r.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/));
  return text.split(/\r?\n/).map((r) => r.trim()).filter(Boolean)
    .map((r) => ({ d: delim(r), c: split(r).map((x) => x.replace(/^"|"$/g, '').trim()) }))
    .filter(({ c }) => /\d{4}\.?\d{2}/.test(c[0] ?? ''))
    .map(({ d, c }) => {
      const semi = d === 'semi';
      // unquoted "$10,000" or "10,000" in comma-separated text splits into "10" and "000": leave the value empty rather
      // than guess. Only when unmistakable ($ sign, or a "000" group): "100,250" is a value and a quantity.
      const broken = d === 'comma' && /^\$?\d{1,3}$/.test(c[2] ?? '') && /^\d{3}(\.\d+)?$/.test(c[3] ?? '')
        && ((c[2] ?? '').startsWith('$') || /^000/.test(c[3] ?? ''));
      // a name ("China") or code ("cn"); unknown text stays empty instead of becoming its first two letters
      return { hts: c[0], origin: resolveCountry(c[1] ?? ''), value: broken ? '' : num(c[2], semi),
        quantity: broken ? '' : num(c[3], semi), quantity2: broken ? '' : num(c[4], semi), claim: (c[5] ?? '').toUpperCase() };
    });
}
