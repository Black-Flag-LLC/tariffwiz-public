// Component-priced base rates (base_rates_and_other_measures.md §3 and §7).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calculate, digitsOf, ListIndex } from './calc';
import type { Answers, HtsLine, Input, Rules } from './types';

const DATA = new URL('../../public/data/', import.meta.url);
const rules: Rules = JSON.parse(readFileSync(new URL('rules.json', DATA), 'utf8'));
const idx = new ListIndex(rules.lists);
const line = (hts: string): HtsLine | undefined => {
  const d = digitsOf(hts);
  return (JSON.parse(readFileSync(new URL(`hts/ch${d.slice(0, 2)}.json`, DATA), 'utf8')) as HtsLine[]).find((l) => l.digits === d);
};
const base = (hts: string, origin: string, value: number, extra: Partial<Input> = {}, answers: Answers = {}) => {
  const r = calculate({ hts, origin, value, entryDate: '2026-10-28', mode: 'air', ...extra, answers }, line(hts), rules, idx);
  return { r, base: r.lines.find((l) => l.family === 'base')!.amount };
};

describe('component-priced base rates', () => {
  it('felt hats: 13.5¢/kg + 6.3% + 1.9¢/article', () =>
    expect(base('6505.00.08.00', 'GB', 10000, { quantity: 1000, quantity2: 200 }).base).toBe(676));
  it('quartz watch: per-piece + case/strap + battery components (ref §7 #8)', () => {
    const { base: b, r } = base('9102.11.25', 'CH', 2050, { quantity: 100 }, { 'comp:case': 1000, 'comp:strap_band_or_bracelet': 1000, 'comp:battery': 50 } as Answers);
    expect(r.ok).toBe(true);
    expect(b).toBe(267.65); // 40¢ × 100 + 8.5% × 1,000 + 14% × 1,000 + 5.3% × 50 (L for 9102.11.25)
  });
  it('sugar by degree: lower polarity lowers the per-kg rate, not below the floor', () => {
    const at100 = base('1701.14.10.20', 'BR', 10000, { quantity: 10000 }, { 'comp:degrees': 100 } as Answers).base;
    const at96 = base('1701.14.10.20', 'BR', 10000, { quantity: 10000 }, { 'comp:degrees': 96 } as Answers).base;
    expect(at100).toBe(146.06); // 1.4606¢ × 10,000 kg
    expect(at96).toBe(cents(10000 * (1.4606 - 4 * 0.020668) / 100));
  });
  it('ensembles point to each garment instead of a number', () => {
    const r = calculate({ hts: '6103.22.00.10', origin: 'VN', value: 10000, entryDate: '2026-10-28', mode: 'air' }, line('6103.22.00.10'), rules, idx);
    expect(r.notes.some((n) => /ensemble/i.test(n))).toBe(true);
  });
});
function cents(x: number) { return Math.round(x * 100) / 100; }
