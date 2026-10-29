// Coverage rules added 2026-10-28 (references: narrow_232.json, quotas_safeguards.json, described_exemptions.json,
// nicaragua_301.json). Each case names the heading it proves.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calculate, digitsOf, ListIndex } from './calc';
import type { Answers, HtsLine, Input, Rules } from './types';

const DATA = new URL('../../public/data/', import.meta.url);
const rules: Rules = JSON.parse(readFileSync(new URL('rules.json', DATA), 'utf8'));
const idx = new ListIndex(rules.lists);
const shards = new Map<string, HtsLine[]>();
const line = (hts: string) => {
  const ch = digitsOf(hts).slice(0, 2);
  if (!shards.has(ch)) shards.set(ch, JSON.parse(readFileSync(new URL(`hts/ch${ch}.json`, DATA), 'utf8')));
  return shards.get(ch)!.find((l) => l.digits === digitsOf(hts));
};
const run = (hts: string, origin: string, value: number, extra: Partial<Input> = {}, answers: Answers = {}) =>
  calculate({ hts, origin, value, entryDate: '2026-10-28', mode: 'ocean', ...extra, answers }, line(hts), rules, idx);
const lineOf = (r: ReturnType<typeof run>, h: string) => r.lines.find((l) => l.heading === h);
/** first 10-digit code in the schedule under any of these list entries */
const firstLeaf = (listKey: string) => {
  for (const code of rules.lists[listKey]) {
    const d = digitsOf(code);
    const l = JSON.parse(readFileSync(new URL(`hts/ch${d.slice(0, 2)}.json`, DATA), 'utf8')) as HtsLine[];
    const hit = l.find((x) => x.digits.length === 10 && x.digits.startsWith(d));
    if (hit) return hit.code;
  }
  throw new Error('no leaf for ' + listKey);
};

describe('Section 232 narrow headings (narrow_232.json)', () => {
  // 8302.30.30 is on both 33(g) and 38(i): "not a car part" -> 9903.94.06 and "not a truck part" -> 9903.74.11, both reported
  it('code on both vehicle-parts lists, answered No to both: 9903.94.06 and 9903.74.11 filed', () => {
    const r = run('8302.30.30.60', 'CA', 10000, { mode: 'truck' }, { vehiclePart: false, truckPart: false, metalWeight15: true });
    expect(lineOf(r, '9903.94.06')).toBeTruthy();
    expect(lineOf(r, '9903.74.11')).toBeTruthy();
    expect(r.duty).toBe(2700);
  });
  // Zac 2026-10-28: 8708.29.51.90 from Poland, car part Yes -> 9903.94.53 (EU 15% all-in) and 9903.74.11 (not a truck part)
  it('code on both vehicle-parts lists, answered Yes car part: car heading plus 9903.74.11', () => {
    const r = run('8708.29.51.90', 'PL', 10000, { mode: 'truck' }, { vehiclePart: true });
    expect(lineOf(r, '9903.94.53')).toBeTruthy();
    expect(lineOf(r, '9903.74.11')).toBeTruthy();
    expect(r.lines.some((l) => l.heading === '9903.74.08')).toBe(false);
    expect(r.duty).toBe(1500);
    const us = run('8708.29.51.90', 'VN', 10000, { mode: 'truck' }, { vehiclePart: true });
    expect(lineOf(us, '9903.94.05')).toBeTruthy();
    expect(lineOf(us, '9903.74.11')).toBeTruthy();
  });
  // Zero-rate "not covered" headings are still filed (Zac 2026-10-28)
  it('semiconductor codes always file a note 39 heading: .02 when not qualifying, .03–.09 for US end uses', () => {
    const code = firstLeaf('s232:n39_b_semis');
    expect(lineOf(run(code, 'TW', 10000), '9903.79.02')).toBeTruthy();
    const dc = run(code, 'TW', 10000, {}, { chipQualifies: true, chipUse: '9903.79.03' });
    expect(lineOf(dc, '9903.79.03')).toBeTruthy();
    expect(dc.lines.some((l) => l.heading === '9903.79.01')).toBe(false);
    expect(lineOf(run(code, 'TW', 10000, {}, { chipQualifies: true }), '9903.79.01')?.amount).toBe(2500);
  });
  it('pharmaceutical codes always file a note 40 heading: generic .67, not a drug .69, clinical trials .70', () => {
    const code = firstLeaf('s232:n40_c_pharma');
    expect(lineOf(run(code, 'IN', 10000), '9903.04.67')).toBeTruthy();
    expect(lineOf(run(code, 'IN', 10000, {}, { pharmaType: 'not_pharma' }), '9903.04.69')).toBeTruthy();
    expect(lineOf(run(code, 'IN', 10000, {}, { pharmaType: 'clinical' }), '9903.04.70')).toBeTruthy();
  });
  it('USMCA vehicle files its US content on 9903.94.02 next to the non-US content on 9903.94.03', () => {
    const r = run('8703.23.01.60', 'CA', 40000, { claim: 'S', mode: 'truck' }, { usContent: 12000 });
    expect(lineOf(r, '9903.94.03')?.amount).toBe(7000);
    expect(lineOf(r, '9903.94.02')?.basisValue).toBe(12000);
  });
  it('STS crane from Korea after 2026-11-10: no China link files 9903.91.15; pre-2025 contract files 9903.91.16', () => {
    const code = firstLeaf('s301:9903.91.14');
    const clean = run(code, 'KR', 1e6, { entryDate: '2026-11-20' }, { stsCrane: true });
    expect(lineOf(clean, '9903.91.15')).toBeTruthy();
    const old = run(code, 'KR', 1e6, { entryDate: '2026-11-20' }, { stsCrane: true, chineseCraneLink: true, craneOldContract: true });
    expect(lineOf(old, '9903.91.16')).toBeTruthy();
    expect(old.lines.some((l) => l.heading === '9903.91.14')).toBe(false);
  });
  it('books from Brazil claimed as informational materials file 9903.05.09', () => {
    const r = run('4901.99.00.93', 'BR', 10000, {}, { infoMaterial: true });
    expect(lineOf(r, '9903.05.09')).toBeTruthy();
  });
  // found by scripts/audit_headings.ts (Zac 2026-10-28: "no more gaps like this")
  it('drone-list code not used for drones files 9903.08.20', () => {
    const code = firstLeaf('s232:n43_c3_uas_thermal');
    expect(lineOf(run(code, 'CN', 10000, {}, { droneUse: false }), '9903.08.20')).toBeTruthy();
  });
  it('metals-list code with no metal at all files 9903.82.01; some metal under 15% files 9903.82.03', () => {
    const code = '8203.40.60.00'; // derivative outside ch.72/73/74/76, so the 15% weight test applies
    expect(lineOf(run(code, 'VN', 10000, {}, { metalWeight15: false, anyMetal: false }), '9903.82.01')).toBeTruthy();
    expect(lineOf(run(code, 'VN', 10000, {}, { metalWeight15: false }), '9903.82.03')).toBeTruthy();
  });
  it('8704.60 electric truck: medium/heavy files 9903.74.01; light truck files the car heading plus 9903.74.05', () => {
    const heavy = run('8704.60.00.00', 'DE', 100000);
    expect(lineOf(heavy, '9903.74.01')?.amount).toBe(25000);
    const light = run('8704.60.00.00', 'DE', 100000, {}, { isMhdv: false });
    expect(lineOf(light, '9903.94.50')).toBeTruthy(); // 25% base already above the EU 15% deal rate
    expect(lineOf(light, '9903.74.05')).toBeTruthy();
  });
  it('25+ year old road tractor files 9903.74.07 and still pays the metals tariff', () => {
    const r = run('8701.21.00.80', 'DE', 100000, {}, { oldVehicle: true });
    expect(lineOf(r, '9903.74.07')).toBeTruthy();
    expect(r.lines.some((l) => /^9903\.82\./.test(l.heading))).toBe(true);
  });
  it('Canada note 51 list goods blocked by Section 232 file 9903.03.15', () => {
    const code = (rules.lists['n51:14'] ?? []).map((x) => line(x.length > 8 ? x : x + '.00.00')).find(Boolean);
    if (!code) return;
    const r = run(code.code, 'CA', 10000, { mode: 'truck' });
    if (r.lines.some((l) => l.family === 's232' && l.amount > 0)) expect(lineOf(r, '9903.03.15')).toBeTruthy();
  });
  it('listed Russian goods file 9903.90.08 / .09 with the commodity line', () => {
    const r = run(firstLeaf('n30:b'), 'RU', 10000);
    expect(r.lines.some((l) => /^9903\.90\.0[89]$/.test(l.heading))).toBe(true);
  });
  it('Japanese leather footwear files 9903.41.10 at +40% unless an excluded type', () => {
    expect(lineOf(run('6403.99.60.75', 'JP', 10000), '9903.41.10')?.amount).toBe(4000);
    expect(lineOf(run('6403.99.60.75', 'JP', 10000, {}, { japanLeather: false }), '9903.41.10')).toBeUndefined();
  });
  it('FTA in-quota claim files the quota provision (9822.04.35) with the commodity line', () => {
    const r = run('0406.10.08.00', 'AU', 10000, { claim: 'AU' }, { ftaInQuota: true });
    expect(lineOf(r, '9822.04.35')).toBeTruthy();
  });
  // found by the Census Aug 2026 validation (scripts/validate_census.ts)
  it('pharma claim K from Ireland: free base, note 52 pharma exemption, 0% total like CBP collected', () => {
    const r = run('2933.99.53.00', 'IE', 10000, { claim: 'K' });
    expect(r.duty).toBe(0);
    expect(lineOf(r, '9903.05.89')).toBeTruthy();
  });
  it('import adjustment offset reduces the Section 232 auto-parts duty', () => {
    const full = run('8708.29.51.90', 'VN', 10000, {}, { vehiclePart: true });
    const off = run('8708.29.51.90', 'VN', 10000, {}, { vehiclePart: true, autoOffset: 1000 });
    expect(lineOf(full, '9903.94.05')!.amount - lineOf(off, '9903.94.05')!.amount).toBe(1000);
  });
  it('works truck (not a road vehicle) → 9903.74.05, no truck tariff', () => {
    const code = firstLeaf('s232:n38_b_mhdv');
    const r = run(code, 'DE', 50000, {}, { isMhdv: false, metalWeight15: false });
    expect(lineOf(r, '9903.74.05')).toBeTruthy();
    expect(r.lines.some((l) => l.heading === '9903.74.01')).toBe(false);
  });
  it('USMCA steel under a Commerce allocation → 9903.82.18 25%; without → 9903.82.02 50%', () => {
    expect(lineOf(run('7208.51.00.30', 'CA', 100000, { claim: 'S', mode: 'truck' }, { usmcaMetalAllocation: true }), '9903.82.18')?.amount).toBe(25000);
    expect(lineOf(run('7208.51.00.30', 'CA', 100000, { claim: 'S', mode: 'truck' }), '9903.82.02')?.amount).toBe(50000);
  });
  it('parts used only for farm/industrial equipment → 15% all-in (9903.82.25)', () => {
    const code = firstLeaf('s232:n16_k_parts');
    const r = run(code, 'DE', 10000, {}, { metalWeight15: true, equipmentUse: true, vehiclePart: false, truckPart: false });
    const l = r.lines.find((x) => x.heading === '9903.82.25' || x.heading === '9903.82.26');
    expect(l).toBeTruthy();
  });
  it('motorcycle-making parts → 9903.82.13, no metals tariff', () => {
    const code = firstLeaf('s232:n16_g_motorcycle_candidates');
    const r = run(code, 'DE', 10000, {}, { metalWeight15: true, motorcycleUse: true, vehiclePart: false, truckPart: false, equipmentUse: false });
    expect(lineOf(r, '9903.82.13')?.amount).toBe(0);
  });
  it('non-China ship-to-shore crane with Chinese components, from 2026-11-10 → 9903.91.14 +100%', () => {
    const r = run('8426.19.00.00', 'KR', 1000000, { entryDate: '2026-11-15' }, { stsCrane: true, chineseCraneLink: true, metalWeight15: false });
    expect(lineOf(r, '9903.91.14')?.amount).toBe(1000000);
    expect(lineOf(run('8426.19.00.00', 'KR', 1000000, { entryDate: '2026-11-15' }, { stsCrane: true, metalWeight15: false }), '9903.91.14')).toBeUndefined();
  });
});

describe('Nicaragua Section 301 (note 29)', () => {
  // the heading is in force at +0% in 2026 and must be filed; CAFTA-DR goods are outside it (29(a)) and file nothing
  it('filed at 0% in 2026, +10% from 2027-01-01; CAFTA-DR claim files nothing', () => {
    expect(lineOf(run('6109.10.00.12', 'NI', 10000), '9903.89.01')?.amount).toBe(0);
    expect(lineOf(run('6109.10.00.12', 'NI', 10000, { entryDate: '2027-02-01' }), '9903.89.01')?.amount).toBe(1000);
    expect(lineOf(run('6109.10.00.12', 'NI', 10000, { entryDate: '2027-02-01', claim: 'P' }), '9903.89.01')).toBeUndefined();
  });
  it('dates past 2027-06-22 are refused (9903.91.05 increase not yet published)', () =>
    expect(run('6109.10.00.12', 'NI', 10000, { entryDate: '2027-07-01' }).ok).toBe(false));
});

describe('described exemptions (note 52(c))', () => {
  it('etrogs: the 52(c) question exempts the country tariff when answered yes', () => {
    const it0 = rules.described.find((d) => d.id === 'n52c:0805.90.01')!;
    const code = (JSON.parse(readFileSync(new URL('hts/ch08.json', DATA), 'utf8')) as HtsLine[])
      .find((x) => x.digits.startsWith('08059001') && x.digits.length >= 8)!.code;
    const no = run(code, 'IL', 10000);
    const yes = run(code, 'IL', 10000, {}, { [`x:${it0.id}`]: true } as Answers);
    expect(no.questions.some((q) => q.id === `x:${it0.id}`)).toBe(true);
    expect(lineOf(yes, '9903.05.87')?.amount).toBe(0);
    expect(yes.duty).toBeLessThan(no.duty);
  });
});

describe('quotas and safeguards (quotas_safeguards.json)', () => {
  it('trade-agreement quota: in-quota never costs more than over-quota', () => {
    const [code, ptrs] = Object.entries(rules.trq.pointers).find(([k, v]) => k.length === 13 && v.some((p) => p.program === 'IL'))!;
    expect(ptrs.length).toBeGreaterThan(0);
    const over = run(code, 'IL', 10000, { claim: 'IL', quantity: 1000, quantity2: 1000 });
    const inq = run(code, 'IL', 10000, { claim: 'IL', quantity: 1000, quantity2: 1000 }, { ftaInQuota: true });
    expect(over.questions.some((q) => q.id === 'ftaInQuota')).toBe(true);
    expect(inq.duty).toBeLessThanOrEqual(over.duty);
  });
  it('price-based agricultural safeguard bites on a very cheap shipment', () => {
    const b = rules.sg.brackets.find((x) => x.usd > 0 && x.unit === 'kg')!;
    const code = b.codes.map((c) => {
      const d = digitsOf(c);
      return (JSON.parse(readFileSync(new URL(`hts/ch${d.slice(0, 2)}.json`, DATA), 'utf8')) as HtsLine[]).find((x) => x.digits.startsWith(d) && x.units.includes('kg'));
    }).find(Boolean)!.code;
    const qty = 1000;
    const value = Math.max(1, Math.round(((b.min + b.max) / 2) * qty)); // unit value inside this bracket
    const r = run(code, 'AR', value, { quantity: qty, quantity2: qty });
    const sg = r.lines.find((l) => l.family === 's201');
    expect(sg?.amount).toBeGreaterThan(0);
  });
});
