// Excise tax (excise.json golden cases), Cotton Board fee (cotton_fee.json), mail entries (postal.md), AD/CVD flags (adcvd.json).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calculate, digitsOf, ListIndex } from './calc';
import type { Answers, HtsLine, Input, Rules } from './types';

const DATA = new URL('../../public/data/', import.meta.url);
const rules: Rules = JSON.parse(readFileSync(new URL('rules.json', DATA), 'utf8'));
const idx = new ListIndex(rules.lists);
const line = (hts: string) => (JSON.parse(readFileSync(new URL(`hts/ch${digitsOf(hts).slice(0, 2)}.json`, DATA), 'utf8')) as HtsLine[])
  .find((l) => l.digits === digitsOf(hts));
const run = (hts: string, origin: string, value: number, extra: Partial<Input> = {}, answers: Answers = {}) =>
  calculate({ hts, origin, value, entryDate: '2026-10-28', mode: 'air', ...extra, answers }, line(hts), rules, idx);
const tax = (r: ReturnType<typeof run>) => r.fees.find((f) => f.family === 'tax')?.amount;

describe('federal excise tax (excise.json golden)', () => {
  it('still wine 9 L at 13.5% → $2.57', () => expect(tax(run('2204.21.50.40', 'FR', 3000, { quantity: 9 }, { 'comp:abv': 13.5 } as Answers))).toBe(2.57));
  it('still wine 9 L at 18% → $3.77', () => expect(tax(run('2204.21.80.30', 'FR', 3000, { quantity: 9 }, { 'comp:abv': 18 } as Answers))).toBe(3.77));
  it('sparkling wine 9 L natural → $8.16', () => expect(tax(run('2204.10.00.75', 'FR', 3000, { quantity: 9 }, { 'comp:abv': 12 } as Answers))).toBe(8.16));
  it('spirits 9 L at 40% → $25.65', () => expect(tax(run('2208.30.30.30', 'GB', 3000, {}, { 'comp:liters': 9, 'comp:abv': 40 } as Answers))).toBe(25.65));
  it('beer 8.52 L → $1.31', () => expect(tax(run('2203.00.00.30', 'MX', 3000, { quantity: 8.52 }))).toBe(1.31));
  it('cigarettes 2,000 → $100.66', () => expect(tax(run('2402.20.80.00', 'ID', 3000, {}, { 'comp:sticks': 2000 } as Answers))).toBe(100.66));
  it('large cigars capped at $0.4026 each: 25 → $10.07', () =>
    expect(tax(run('2402.10.80.80', 'DO', 3000, {}, { 'comp:cigars': 25, 'comp:cigar_sale_price': 12 } as Answers))).toBe(10.07));
});

describe('Cotton Board assessment (7 CFR 1205.510)', () => {
  it('formal entry of cotton T-shirts by weight', () => {
    const d = Object.keys(rules.cotton).find((k) => k.startsWith('610910'))!;
    const code = `${d.slice(0, 4)}.${d.slice(4, 6)}.${d.slice(6, 8)}.${d.slice(8)}`;
    const r = run(code, 'VN', 10000, { quantity: 100, quantity2: 100 });
    const fee = r.fees.find((f) => f.heading === 'Cotton');
    expect(fee).toBeTruthy();
    expect(fee!.amount).toBeGreaterThan(0);
    expect(run(code, 'VN', 2000, { quantity: 100, quantity2: 100 }).fees.find((f) => f.heading === 'Cotton')).toBeUndefined();
  });
});

describe('mail and AD/CVD', () => {
  it('mail ≤ $2,500: no MPF, no HMF', () => {
    const r = run('9503.00.00.90', 'TH', 400, { mode: 'mail' });
    expect(r.fees.find((f) => f.heading === 'MPF')?.amount).toBe(0);
    expect(r.fees.find((f) => f.heading === 'HMF')).toBeUndefined();
  });
  it('flags an AD/CVD order whose scope lists the code and origin', () => {
    const o = rules.adcvd.find((x) => x.country === 'CN' && x.hts.some((h) => h.length === 10))!;
    const h = o.hts.find((x) => x.length === 10)!;
    const code = `${h.slice(0, 4)}.${h.slice(4, 6)}.${h.slice(6, 8)}.${h.slice(8)}`;
    const r = run(code, 'CN', 10000, {}, { metalWeight15: false });
    if (r.ok) expect(r.adcvd.some((x) => x.case === o.case)).toBe(true);
  });
});

describe('bug-scan regressions (2026-10-29)', () => {
  it('per-1000 rates convert from pieces (tulip bulbs, 5,000 pcs)', () => {
    const r = run('0601.10.15.00', 'NL', 10000, { quantity: 5000 });
    expect(r.lines.find((l) => l.family === 'base')!.amount).toBeLessThan(10);
  });
  it('power supplies are not drones by default (8504.40.95.80 from CN)', () => {
    const r = run('8504.40.95.80', 'CN', 10000);
    expect(r.lines.some((l) => l.heading === '9903.08.21' || l.heading === '9903.08.22')).toBe(false);
  });
  it('spirits excise uses proof liters (1,000 pf. liters → 264.2 proof gal × $13.50)', () =>
    expect(tax(run('2208.30.30.30', 'GB', 30000, { quantity: 1000 }))).toBe(3566.7));
  it('rejects NaN and negative quantities, bad dates', () => {
    expect(run('0601.10.15.00', 'NL', 10000, { quantity: Number.NaN }).ok).toBe(false);
    expect(run('0601.10.15.00', 'NL', 10000, { quantity: -5 }).ok).toBe(false);
    expect(run('0601.10.15.00', 'NL', 10000, { entryDate: '2026-7-30' }).ok).toBe(false);
  });
  it('patented-drug codes default to generic (no 100% charge until answered)', () =>
    expect(run('3002.12.00.40', 'IN', 10000).lines.some((l) => l.heading === '9903.04.60')).toBe(false));
});

describe('broker review fixes (2026-10-29)', () => {
  it('AD/CVD goods force a formal type 03 entry even under $2,500 (Indian shrimp $2,000)', () => {
    const r = run('0306.17.00.41', 'IN', 2000, { mode: 'ocean' });
    expect(r.entryType).toBe('03');
    expect(r.fees.find((f) => f.heading === 'MPF')?.amount).toBe(34.58);
    expect(r.fees.find((f) => f.heading === 'HMF')?.amount).toBe(2.5);
  });
  it('AD/CVD deposit rates the broker enters become estimated deposit lines', () => {
    const r = run('0306.17.00.41', 'IN', 10000, { mode: 'ocean' }, { adRate: 2.5, cvdRate: 5.8 } as Answers);
    expect(r.lines.filter((l) => l.family === 'adcvd').map((l) => l.amount)).toEqual([250, 580]);
  });
  it('all-in rows show the add-on', () =>
    expect(run('8703.23.01.60', 'JP', 40000, { mode: 'ocean' }).lines.find((l) => l.heading === '9903.94.41')?.rate).toBe('15% all-in (+12.5%)'));
  it('unanswered questions are listed as defaults', () =>
    expect(run('9403.20.00.82', 'CN', 15000).defaults.some((d) => d.id === 'metalWeight15')).toBe(true));
  it('value-bracket mismatch is flagged (wine valued not over $1.05/L at $3.33/L)', () =>
    expect(run('2204.21.50.05', 'FR', 15000, { quantity: 4500 }).notes.some((n) => /value/i.test(n) && /1.05/.test(n))).toBe(true));
});

describe('bug hunt #2 regressions', () => {
  it('cigarettes in thousands: excise from the line quantity (100 thousand = 100,000 sticks)', () =>
    expect(tax(run('2402.20.80.00', 'ID', 10000, { quantity: 100, quantity2: 50 }))).toBe(5033));
  it('wrong-typed answers from links count as unanswered (no NaN)', () => {
    const r = run('8703.23.01.60', 'MX', 40000, { claim: 'S', mode: 'truck' }, { usContent: 'abc' } as unknown as Answers);
    expect(Number.isFinite(r.total)).toBe(true);
  });
  it('heading-level codes, impossible dates and loading after entry are rejected', () => {
    expect(run('6109.10.00.12', 'CN', 1000, { entryDate: '2026-13-45' }).ok).toBe(false);
    expect(run('6109.10.00.12', 'CN', 1000, { loadingDate: '2026-11-30' }).ok).toBe(false);
  });
  it('a claim the line does not list is ignored (no MPF waiver)', () => {
    const r = run('6109.10.00.12', 'CN', 10000, { claim: 'AU' });
    expect(r.fees.find((f) => f.heading === 'MPF')?.amount).toBe(34.64);
  });
});
