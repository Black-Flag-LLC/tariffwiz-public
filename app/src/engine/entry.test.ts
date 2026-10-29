// Multi-line entries: MPF min/max once per entry (19 CFR 24.23; ACE CATAIR), informal threshold on the entry value.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { digitsOf, ListIndex } from './calc';
import { calculateEntry, entryCsv, entryXlsx, parseLines } from './entry';
import { calculate } from './calc';
import type { HtsLine, Input, Rules } from './types';

const DATA = new URL('../../public/data/', import.meta.url);
const rules: Rules = JSON.parse(readFileSync(new URL('rules.json', DATA), 'utf8'));
const idx = new ListIndex(rules.lists);
const line = (hts: string) => {
  try { return (JSON.parse(readFileSync(new URL(`hts/ch${digitsOf(hts).slice(0, 2)}.json`, DATA), 'utf8')) as HtsLine[]).find((l) => l.digits === digitsOf(hts)); }
  catch { return undefined; }
};
const item = (hts: string, origin: string, value: number, extra: Partial<Input> = {}) =>
  ({ input: { hts, origin, value, entryDate: '2026-10-28', mode: 'ocean' as const, answers: {}, ...extra }, line: line(hts) });
const mpf = (e: ReturnType<typeof calculateEntry>) => e.fees.find((f) => f.heading === 'MPF')!.amount;

describe('multi-line entries', () => {
  it('sums line duties; MPF capped once per entry, not per line', () => {
    const e = calculateEntry([item('6109.10.00.12', 'CN', 100000), item('6403.99.60.75', 'BR', 100000), item('9503.00.00.90', 'TH', 100000)], rules, idx);
    expect(e.duty).toBe(36500 + 46000 + 12500);
    expect(mpf(e)).toBe(670.86); // 0.3464% × $300k = $1,039 → entry max
    expect(e.fees.find((f) => f.heading === 'HMF')!.amount).toBe(375);
  });
  it('MPF minimum applies to the entry, not each small line', () => {
    const e = calculateEntry([item('9503.00.00.90', 'TH', 3000), item('9503.00.00.90', 'VN', 3000)], rules, idx);
    expect(mpf(e)).toBe(34.58); // 0.3464% × $6,000 = $20.78 → one minimum
  });
  it('USMCA-claimed lines are left out of the MPF base', () => {
    const e = calculateEntry([item('8708.29.51.90', 'MX', 200000, { claim: 'S', mode: 'truck' }), item('9503.00.00.90', 'CN', 50000, { mode: 'truck' })], rules, idx);
    expect(mpf(e)).toBe(173.2); // only the $50,000 non-exempt line
  });
  it('Chapter 98 lines: MPF only on the dutiable part of 9802.00.80, none on 9801.00.10 / 9802.00.50 (19 CFR 24.23(c))', () => {
    const asm = calculateEntry([item('8708.30.50.20', 'MX', 500000, { mode: 'truck', ch98: { provision: '9802.00.80', deduct: 450000 } })], rules, idx);
    expect(mpf(asm)).toBe(173.2); // 0.3464% × $50,000 dutiable
    const ret = calculateEntry([item('6109.10.00.12', 'CN', 50000, { ch98: { provision: '9801.00.10' } }),
      item('6109.10.00.12', 'CN', 50000, { ch98: { provision: '9802.00.50', deduct: 2000 } })], rules, idx);
    expect(mpf(ret)).toBe(0);
  });
  it('mail lines that must be formal make the whole entry formal (19 CFR 145.12(a)(2)), with the reason', () => {
    const e = calculateEntry([item('6110.20.20.20', 'CN', 1000, { mode: 'mail', entryDate: '2027-02-01' })], rules, idx);
    expect(e.entryType).toBe('01');
    expect(e.warnings.join(' ')).toMatch(/145\.12/);
  });
  it('a banned line keeps its questions so the Entry view can ask "arrived before?"', () => {
    const e = calculateEntry([item('2204.21.50.40', 'CA', 10000, { mode: 'truck', entryDate: '2026-10-29' })], rules, idx);
    expect(e.lines[0].ok).toBe(false);
    expect(e.lines[0].questions.map((q) => q.id)).toContain('arrivedBeforeBan');
  });
  it('pasted numbers: decimal commas in any delimiter, US thousands, no guessing on "100,250"', () => {
    const T = '\t';
    const rows = parseLines([`8471.30.01.00${T}CN${T}10000,50${T}5`, `8471.30.01.00${T}DE${T}10.000,50`, '8471.30.01.00;DE;10.000;5',
      '8471.30.01.00,CN,100,250', '8471.30.01.00,CN,10,000'].join('\n'));
    expect(rows.map((r) => [r.value, r.quantity])).toEqual([['10000.50', '5'], ['10000.50', ''], ['10000', '5'], ['100', '250'], ['', '']]);
  });
  it('entry type 23 (TIB) is MPF-exempt', () => {
    const e = calculateEntry([item('6110.20.20.20', 'VN', 50000)], rules, idx, { entryType: '23' });
    expect(mpf(e)).toBe(0);
  });
  it('a 9802 line keeps a formal entry when only its dutiable part is small', () => {
    const r = calculate(item('6109.10.00.12', 'CN', 100000, { ch98: { provision: '9802.00.50', deduct: 2000 } }).input,
      line('6109.10.00.12'), rules, idx);
    expect(r.entryType).toBe('01');
    expect(r.fees.find((f) => f.heading === 'HMF')!.amount).toBe(125);
  });
  it('entry value ≤ $2,500 is informal: one flat fee, type 11', () => {
    const e = calculateEntry([item('9503.00.00.90', 'TH', 1000), item('9503.00.00.90', 'TH', 1000)], rules, idx);
    expect(e.entryType).toBe('11');
    expect(mpf(e)).toBe(2.77);
  });
  it('cotton fee on a small line inside a formal entry is still charged', () => {
    const e = calculateEntry([item('9503.00.00.90', 'CN', 15000), item('6109.10.00.12', 'CN', 2000, { quantity: 100, quantity2: 120 })], rules, idx);
    expect(e.fees.find((f) => f.heading === 'Cotton')?.amount).toBeGreaterThan(1.5);
  });
  it('bad lines are reported, good lines still priced', () => {
    const e = calculateEntry([item('0000.00.00.00', 'CN', 1000), item('9503.00.00.90', 'TH', 10000)], rules, idx);
    expect(e.errors.length).toBe(1);
    expect(e.duty).toBe(1250);
  });
  it('parses pasted spreadsheet rows and exports CSV', () => {
    // country names, decimal commas with semicolons, and no guessing on an unquoted thousands comma or an unknown name
    expect(parseLines('6110.20.20.20\tChina\t$10,000\n6110.20.20.20;Viet Nam;10.000,50\n6110.20.20.20,Germany,10,000\n6110.20.20.20,Atlantis,500')
      .map((r) => [r.origin, r.value])).toEqual([['CN', '10000'], ['VN', '10000.50'], ['DE', ''], ['', '500']]);
    const rows = parseLines('HTS\tCountry\tValue\n6109.10.00.12\tcn\t$10,000\t1200\t150\n9503.00.00.90,TH,2500');
    expect(rows).toEqual([
      { hts: '6109.10.00.12', origin: 'CN', value: '10000', quantity: '1200', quantity2: '150', claim: '' },
      { hts: '9503.00.00.90', origin: 'TH', value: '2500', quantity: '', quantity2: '', claim: '' },
    ]);
    const csv = entryCsv(calculateEntry([item('6109.10.00.12', 'CN', 10000)], rules, idx));
    expect(csv).toContain('"9903.88.15"');
    expect(csv).toContain('"MPF (499)"');
  });
});

describe('broker fields', () => {
  it('9802.00.80: every duty on the value less US components; HMF on the full value', () => {
    const it0 = item('6109.10.00.12', 'CN', 10000, { ch98: { provision: '9802.00.80', deduct: 4000 } });
    const r = calculate(it0.input, it0.line, rules, idx);
    const plain = calculate({ ...it0.input, ch98: null, value: 6000 }, it0.line, rules, idx);
    expect(r.duty).toBe(plain.duty);
    expect(r.lines.find((l) => l.heading === '9802.00.80')).toBeTruthy();
    expect(r.fees.find((f) => f.heading === 'HMF')!.amount).toBe(12.5);
  });
  it('9802.00.50: duty only on the value of the repairs', () => {
    const it0 = item('6109.10.00.12', 'CN', 10000, { ch98: { provision: '9802.00.50', deduct: 1000 } });
    const plain = calculate({ ...it0.input, ch98: null, value: 1000 }, it0.line, rules, idx);
    expect(calculate(it0.input, it0.line, rules, idx).duty).toBe(plain.duty);
  });
  it('9801.00.10: US goods returned are free with no Chapter 99 lines', () => {
    const it0 = item('6109.10.00.12', 'CN', 10000, { ch98: { provision: '9801.00.10' } });
    const r = calculate(it0.input, it0.line, rules, idx);
    expect(r.duty).toBe(0);
    expect(r.lines.map((l) => l.heading)).toEqual(['9801.00.10', '6109.10.00.12']);
  });
  it('entry-type override: warehouse defers duty; informal over $2,500 warns', () => {
    const items = [item('6109.10.00.12', 'CN', 10000)];
    const w = calculateEntry(items, rules, idx, { entryType: '21' });
    expect(w.entryType).toBe('21');
    expect(w.dueNow).toBe(w.feesTotal);
    expect(calculateEntry(items, rules, idx, { entryType: '11' }).warnings.join(' ')).toMatch(/2,500/);
    expect(calculateEntry(items, rules, idx).entryType).toBe('01');
  });
  it('XLSX export is a valid zip holding the sheet', () => {
    const e = calculateEntry([item('6109.10.00.12', 'CN', 10000)], rules, idx);
    const b = entryXlsx(e, { revision: 'r', checked: 'c', exportCountry: 'CN' });
    expect([...b.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder().decode(b);
    expect(text).toContain('xl/worksheets/sheet1.xml');
    expect(text).toContain('9903.88.15');
  });
});
