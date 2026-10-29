// Golden tests: every expected value comes from .claude/skills/us-import-duty/references
// (country_measures.md §5, section232.md §7, section301_china.md §6), each with its proof lines there.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calculate, digitsOf, findLine, ListIndex } from './calc';
import type { Answers, HtsLine, Input, Rules } from './types';

const DATA = new URL('../../public/data/', import.meta.url);
const rules: Rules = JSON.parse(readFileSync(new URL('rules.json', DATA), 'utf8'));
const idx = new ListIndex(rules.lists);
const shards = new Map<string, HtsLine[]>();
function lineFor(hts: string): HtsLine | undefined {
  const d = digitsOf(hts);
  const ch = d.slice(0, 2);
  if (!shards.has(ch)) {
    try { shards.set(ch, JSON.parse(readFileSync(new URL(`hts/ch${ch}.json`, DATA), 'utf8'))); } catch { return undefined; }
  }

  return shards.get(ch)!.find((l) => l.digits === d);
}

const TODAY = '2026-10-28';
function run(hts: string, origin: string, value: number, extra: Partial<Input> = {}, answers: Answers = {}) {
  const input: Input = { hts, origin, value, entryDate: TODAY, mode: 'ocean', ...extra, answers };
  return calculate(input, lineFor(hts), rules, idx);
}
/** Ch.99 + base lines as "heading=amount", excluding $0 informational lines. */
const charged = (r: ReturnType<typeof run>) => r.lines.filter((l) => l.amount !== 0).map((l) => `${l.heading}=${l.amount}`).sort();
const headings = (r: ReturnType<typeof run>) => r.lines.map((l) => l.heading);

describe('country measures (country_measures.md §5, $10,000, entered 2026-10-28)', () => {
  it('1 CN cotton T-shirts: base + 301 List 4A + note 52, no IEEPA', () => {
    const r = run('6109.10.00.12', 'CN', 10000);
    expect(r.duty).toBe(3650);
    expect(charged(r)).toEqual(['6109.10.00.12=1650', '9903.05.31=1250', '9903.88.15=750'].sort());
    expect(headings(r).some((h) => h.startsWith('9903.01'))).toBe(false);
    expect(r.total).toBe(3697.14);
  });
  // packaged Canadian wine is banned from 2026-09-29 (PP 11061): these price wine that arrived before the ban
  it('2 CA wine with USMCA claim: 338 +50% only, MPF exempt, no HMF by truck', () => {
    const r = run('2204.21.50.40', 'CA', 10000, { claim: 'S', mode: 'truck', quantity: 1000 }, { arrivedBeforeBan: true });
    expect(r.duty).toBe(5000);
    expect(headings(r)).toContain('9903.05.93');
    // + federal excise tax: 1,000 L = 264.2 wine gallons x $1.07 (26 U.S.C. 5041(b)(1); excise.json)
    expect(r.total).toBe(5282.69);
  });
  it('2b CA wine without claim: 6.3¢/L + 338 + note 52', () => {
    const r = run('2204.21.50.40', 'CA', 10000, { mode: 'truck', quantity: 1000 }, { arrivedBeforeBan: true });
    expect(r.duty).toBe(6063);
  });
  it('3 CA denim trousers, no claim', () => expect(run('6203.42.07.11', 'CA', 10000).duty).toBe(2660));
  it('4 MX leather footwear, no claim / with USMCA', () => {
    expect(run('6403.99.60.75', 'MX', 10000).duty).toBe(1850);
    expect(run('6403.99.60.75', 'MX', 10000, { claim: 'S' }).duty).toBe(0);
  });
  it('5 BR leather footwear: note 50 + note 52 stack', () => {
    const r = run('6403.99.60.75', 'BR', 10000);
    expect(r.duty).toBe(4600);
    expect(r.total).toBe(4647.14);
  });
  it('6 VN cotton knit tops, women (6110.20.20.79, "other"); VN smartphone exempt via 52(b)', () => {
    expect(run('6110.20.20.79', 'VN', 10000).duty).toBe(2900);
    const p = run('8517.13.00.00', 'VN', 10000);
    expect(p.duty).toBe(0);
    expect(headings(p)).toContain('9903.05.86');
  });
  it('7 FR cosmetics: EU all-in 10%', () => expect(run('3304.99.50.00', 'FR', 10000).duty).toBe(1000));
  it('8 JP game consoles: all-in 12.5%', () => expect(run('9504.50.00.00', 'JP', 10000).duty).toBe(1250));
  it('9 GB cosmetics: +10%', () => expect(run('3304.99.50.00', 'GB', 10000).duty).toBe(1000));
  it('10 IN cotton towels', () => expect(run('6302.60.00.20', 'IN', 10000).duty).toBe(1910));
  it('11 CH handbags: all-in 12.5% tops up 9%', () => expect(run('4202.21.90.00', 'CH', 10000).duty).toBe(1250));
  it('12 TH toys', () => expect(run('9503.00.00.90', 'TH', 10000).duty).toBe(1250));
});

describe('Section 232 (section232.md §7)', () => {
  it('1 DE steel plate: 50% full value, note 52 blocked', () => {
    const r = run('7208.51.00.30', 'DE', 100000);
    expect(charged(r)).toEqual(['9903.82.02=50000']);
    expect(headings(r)).toContain('9903.05.90');
  });
  it('2 GB steel plate, ≥95% UK melt', () => expect(run('7208.51.00.30', 'GB', 100000, {}, { ukMelt95: true }).duty).toBe(25000));
  it('3 CN steel plate: 232 50% + 301 note 31 25%', () => {
    const r = run('7208.51.00.30', 'CN', 100000);
    expect(charged(r)).toEqual(['9903.82.02=50000', '9903.91.01=25000']);
  });
  it('4 KR fridge, metal 40% of weight → 25%; at 10% weight → country measure applies', () => {
    const r = run('8418.10.00.30', 'KR', 10000, {}, { metalWeight15: true });
    expect(r.lines.find((l) => l.family === 's232')?.heading).toBe('9903.82.09');
    expect(r.lines.find((l) => l.family === 's232')?.amount).toBe(2500);
    const low = run('8418.10.00.30', 'KR', 10000, {}, { metalWeight15: false });
    expect(low.lines.some((l) => l.heading === '9903.82.03')).toBe(true);
    expect(low.lines.some((l) => l.family === 's301_forced_labor' && l.heading !== '9903.05.90')).toBe(true);
  });
  it('5 BR plow: 15% all-in, Brazil 301 blocked', () => {
    const r = run('8432.10.00.20', 'BR', 100000, {}, { metalWeight15: true });
    expect(r.lines.find((l) => l.family === 's232')?.heading).toBe('9903.82.10');
    expect(r.duty).toBe(15000);
  });
  it('6 MX wheel loader USMCA with $60k US content', () => {
    const r = run('8429.51.10.05', 'MX', 200000, { claim: 'S' }, { metalWeight15: true, usContent: 60000 });
    expect(r.lines.find((l) => l.family === 's232')?.amount).toBe(35000);
  });
  it('7 JP car: 15% all-in replaces base', () => expect(run('8703.23.01.60', 'JP', 40000).duty).toBe(6000));
  it('8 JP pickup at 25% base: nothing added', () => expect(run('8704.21.01.00', 'JP', 40000).duty).toBe(10000));
  it('9 MX car USMCA, $12k US content: 25% on $28k', () => {
    const r = run('8703.23.01.60', 'MX', 40000, { claim: 'S' }, { usContent: 12000 });
    expect(r.lines.find((l) => l.family === 's232')?.amount).toBe(7000);
  });
  it('10 KR bumper with KORUS: auto part 15% all-in, no metals', () => {
    const r = run('8708.10.30.50', 'KR', 10000, { claim: 'KR' });
    expect(r.duty).toBe(1500);
    expect(headings(r).some((h) => h.startsWith('9903.82'))).toBe(false);
  });
  it('11 VN upholstered chair 25%; IT 15% all-in; GB +10%', () => {
    expect(run('9401.61.60.11', 'VN', 20000).duty).toBe(5000);
    expect(run('9401.61.60.11', 'IT', 20000).duty).toBe(3000);
    expect(run('9401.61.60.11', 'GB', 20000).duty).toBe(2000);
  });
  it('12 patented drug: IN 100% all-in; IE 15%; generic 0', () => {
    expect(run('3004.90.92.60', 'IN', 50000, {}, { pharmaType: 'patented' }).duty).toBe(50000);
    expect(run('3004.90.92.60', 'IE', 50000, {}, { pharmaType: 'patented' }).duty).toBe(7500);
    expect(run('3004.90.92.60', 'IN', 50000, {}, { pharmaType: 'generic' }).duty).toBe(0);
  });
  // Corrected by the 2026-10-28 audit: 7601.10.60 is on note 30(d) (L230023) -> 70% in lieu of column 2; + 9903.85.67 200%;
  // + note 52 Russia 12.5% (row 9903.05.66 L239778; 52(f) does not list 9903.85.67/.68).
  it('S1 Russian aluminum: note 30 70% + 200% + note 52', () => expect(run('7601.10.60.40', 'RU', 10000).duty).toBe(28250));
  it('S3 SE road tractor: 4% + 25%', () => expect(run('8701.21.00.15', 'SE', 150000).duty).toBe(43500));
  it('S4 CA softwood lumber +10%', () => expect(run('4407.11.00.01', 'CA', 100000).lines.find((l) => l.family === 's232')?.amount).toBe(10000));
  it('S5 GB bumper 10% all-in', () => expect(run('8708.10.30.50', 'GB', 10000).duty).toBe(1000));
  it('S6 GB car in quota: 2.5% + 7.5%', () => expect(run('8703.23.01.60', 'GB', 40000).duty).toBe(4000));
});

describe('Section 301 China', () => {
  it('CN EV: 2.5% + 9903.91.03 100% + 232 autos 25%, no note 52', () => {
    const r = run('8703.80.00.20', 'CN', 40000);
    expect(charged(r)).toEqual(['8703.80.00.20=1000', '9903.91.03=40000', '9903.94.01=10000'].sort());
  });
  it('CN toys: List 4B suspended, note 52 only', () => expect(charged(run('9503.00.00.90', 'CN', 10000))).toEqual(['9903.05.31=1250']));
  it('HK origin: no 301', () => expect(run('6109.10.00.12', 'HK', 10000).lines.some((l) => l.family === 's301_china')).toBe(false));
});

describe('fees and guards', () => {
  it('MPF minimum and informal entry', () => {
    expect(run('9503.00.00.90', 'TH', 5000).fees.find((f) => f.heading === 'MPF')?.amount).toBe(34.58);
    expect(run('9503.00.00.90', 'TH', 2000).fees.find((f) => f.heading === 'MPF')?.amount).toBe(2.77);
  });
  it('MPF maximum', () => expect(run('9503.00.00.90', 'TH', 500000).fees.find((f) => f.heading === 'MPF')?.amount).toBe(670.86));
  it('rejects unsupported dates and unknown codes', () => {
    expect(run('9503.00.00.90', 'TH', 1000, { entryDate: '2026-01-15' }).ok).toBe(false);
    expect(run('0000.00.00.00', 'TH', 1000).ok).toBe(false);
  });
  it('charges content-weight rates on the content, not the gross weight', () => {
    const base = (r: ReturnType<typeof run>) => r.lines.find((l) => l.family === 'base')!.amount;
    // 18.7¢/clean kg on 5,000 clean-yield kg (units cy kg, kg)
    expect(base(run('5101.11.60.30', 'ZA', 100000, { quantity: 5000, quantity2: 10000 }))).toBe(935);
    // 12.8¢/kg on 5,000 kg molybdenum content + 1.8% of $100,000 (units kg, Mo kg)
    expect(base(run('2613.10.00.00', 'CL', 100000, { quantity: 10000, quantity2: 5000 }))).toBe(2440);
    // 16.9¢/kg of total sugars: asked; unanswered it assumes all 10,000 kg are sugar (+5.1%)
    const s = run('1702.30.28.00', 'MX', 10000, { quantity: 10000 });
    expect(base(s)).toBe(2200);
    expect(base(run('1702.30.28.00', 'MX', 10000, { quantity: 10000 }, { 'comp:kg_total_sugars': 6000 } as unknown as Answers))).toBe(1524);
  });
  it('note 52(g): USMCA over-quota goods are not "entered free of duty", so they pay note 52', () => {
    // 0402.10.50 CA, USMCA claimed, over quota (default): 86.5¢/kg base + 338 + note 52 +10% (9903.05.29)
    const r = run('0402.10.50.00', 'CA', 100000, { mode: 'truck', quantity: 20000, claim: 'S' });
    expect(charged(r)).toContain('9903.05.29=10000');
    // in quota: free under USMCA, so exempt (9903.05.93)
    const q = run('0402.10.50.00', 'CA', 100000, { mode: 'truck', quantity: 20000, claim: 'S' }, { ftaInQuota: true });
    expect(headings(q)).toContain('9903.05.93');
  });
  it('an 8-digit code whose only statistical line is .00 resolves to that line', () => {
    const ch04: HtsLine[] = JSON.parse(readFileSync(new URL('hts/ch04.json', DATA), 'utf8'));
    expect(findLine(ch04, '0402.10.05')?.code).toBe('0402.10.05.00');
    expect(findLine(ch04, '0402.10.10')?.code).toBe('0402.10.10.00');
    expect(findLine(ch04, '0402.99.99')).toBeUndefined();
  });
  it('Canada note 51 lists follow their dates (PP 11064/11065 from 9/15, PP 11076 from 10/30)', () => {
    const ca = (hts: string, entryDate: string) => headings(run(hts, 'CA', 10000, { mode: 'truck', entryDate }));
    expect(ca('4819.10.00.40', '2026-10-29')).toContain('9903.03.14');      // removed 10/30
    expect(ca('4819.10.00.40', '2026-10-30')).not.toContain('9903.03.14');
    expect(ca('1806.10.43.00', '2026-10-29')).not.toContain('9903.03.14');  // added 10/30
    expect(ca('1806.10.43.00', '2026-10-30')).toContain('9903.03.14');
    expect(ca('9401.41.00.00', '2026-09-14')).not.toContain('9903.03.14');  // added 9/15
    expect(ca('9401.41.00.00', '2026-09-15')).toContain('9903.03.14');
  });
  it('before 9/15, 9903.03.15 exempted Section 232 goods from all three Canada headings; since, only .13', () => {
    const ca = (entryDate: string) => headings(run('9403.20.00.82', 'CA', 10000, { mode: 'truck', entryDate }));
    expect(ca('2026-09-01')).toContain('9903.03.15');
    expect(ca('2026-10-20')).toContain('9903.03.14');
  });
  it('Canadian goods banned from 9/29 (PP 11061-11063) are refused unless they arrived earlier', () => {
    const whey = (entryDate: string, answers = {}) => run('0404.10.05.00', 'CA', 10000, { mode: 'truck', entryDate }, answers);
    expect(whey('2026-09-28').ok).toBe(true);
    const banned = whey('2026-10-01');
    expect(banned.ok).toBe(false);
    expect(banned.error).toMatch(/Can't be imported/);
    expect(banned.questions.map((q) => q.id)).toContain('arrivedBeforeBan');
    expect(whey('2026-10-01', { arrivedBeforeBan: true }).ok).toBe(true);
    // packaged-only alcohol: bulk is not banned
    expect(run('2203.00.00.30', 'CA', 10000, { mode: 'truck', entryDate: '2026-10-01' }, { banPackaged: false }).ok).toBe(true);
    expect(run('0404.10.05.00', 'US', 10000, { entryDate: '2026-10-01' }).ok).toBe(true);
  });
  it('Section 232 polysilicon from 2026-12-04 (PP 11052; worked examples in references/polysilicon_232.json)', () => {
    const at = (hts: string, origin: string, value: number, extra: Partial<Input>, answers = {}) =>
      run(hts, origin, value, { entryDate: '2026-12-10', ...extra }, answers).duty;
    const docs = { polyDocs: 'resale_at_or_above' };
    expect(at('8541.43.00.10', 'CN', 45000, { quantity: 1000, quantity2: 450000 })).toBe(205875);          // 1: no documentation
    expect(at('8541.43.00.10', 'DE', 320000, { quantity: 2000, quantity2: 800000 }, docs)).toBe(80000);     // 2: EU deal, MIP met
    expect(at('2804.61.00.00', 'DE', 180000, { quantity: 10000 }, docs)).toBe(30000);                     // 3: polysilicon shortfall
    expect(at('3818.00.00.45', 'MY', 40000, { quantity: 500 })).toBe(56000);                                // 4: wafers, no documentation
    expect(at('8541.42.00.10', 'IN', 150000, { quantity: 1, quantity2: 1000000 }, { polyDocs: 'pre_aug6_contract' })).toBe(107500); // 5
    expect(at('8541.43.00.10', 'MX', 70000, { quantity: 1, quantity2: 200000, claim: 'S' }, docs)).toBe(16500);      // 6: USMCA
    // not before 12:01 a.m. 2026-12-04, and not GaAs wafers (3818.00.0010)
    expect(headings(run('8541.43.00.10', 'CN', 45000, { entryDate: '2026-12-03', quantity: 1000, quantity2: 450000 }))).not.toContain('9903.45.36');
    expect(headings(run('3818.00.00.10', 'MY', 40000, { entryDate: '2026-12-10', quantity: 500 })).some((h) => h.startsWith('9903.45.3'))).toBe(false);
  });
  it('AGOA ends 2026-12-31 (GN16(c)): the claim is refused for later entries', () => {
    expect(run('6401.10.00.00', 'KE', 10000, { claim: 'D', entryDate: '2026-12-31' }).duty).toBe(0);
    const r = run('6401.10.00.00', 'KE', 10000, { claim: 'D', entryDate: '2027-01-04' });
    expect(r.duty).toBe(3750);
    expect(r.notes.join(' ')).toMatch(/ended on 2026-12-31/);
  });
  it('claim-only programs Y/Z/N are free on any line except their exclusions; Nepal ended 2025-12-31', () => {
    expect(run('8501.10.40.20', 'MH', 10000, { claim: 'Z' }).duty).toBe(0);
    expect(run('6110.20.20.20', 'MH', 10000, { claim: 'Z' }).duty).toBe(1650);          // GN10(d) apparel excluded
    const gu = run('8501.10.40.20', 'GU', 10000, { claim: 'Y' });
    expect(gu.duty).toBe(0);
    expect(gu.fees.find((f) => f.heading === 'MPF')?.rate).toBe('exempt');              // 24.23(c)(1)(ii)
    expect(run('8501.10.40.20', 'JO', 10000, { claim: 'N' }).lines.find((l) => l.family === 'base')!.amount).toBe(440); // not from a zone
    expect(run('8501.10.40.20', 'JO', 10000, { claim: 'N' }, { qizMade: true }).lines.find((l) => l.family === 'base')!.amount).toBe(0);
    expect(run('6117.10.60.10', 'NP', 10000, { claim: 'NP' }).duty).toBe(950);
  });
  it('mail: formal from 2027-01-20 when Chapter 99 duty applies; no MPF on mail unless Inbound EMS; gifts within $100 free', () => {
    const m = (value: number, entryDate: string, answers = {}) => run('6110.20.20.20', 'VN', value, { mode: 'mail', entryDate }, answers);
    expect(m(2000, '2026-11-01').entryType).toBe('11');
    const late = m(2000, '2027-02-01');
    expect(late.entryType).toBe('01');
    expect(late.fees.find((f) => f.heading === 'MPF')?.amount).toBe(0);
    expect(m(2000, '2027-02-01', { inboundEms: true }).fees.find((f) => f.heading === 'MPF')?.amount).toBe(34.58); // FY2027 minimum
    expect(m(80, '2026-11-01', { mailGift: true }).total).toBe(0);
  });
  it('donations file 9903.05.91 (note 52) and 9903.05.08 (note 50) instead of the country duty', () => {
    expect(headings(run('6109.10.00.12', 'VN', 10000, {}, { donation: true }))).toContain('9903.05.91');
    expect(run('6109.10.00.12', 'VN', 10000, {}, { donation: true }).duty).toBe(1650);
    expect(headings(run('6109.10.00.12', 'BR', 10000, {}, { donation: true }))).toEqual(expect.arrayContaining(['9903.05.08', '9903.05.91']));
  });
  it('patented pharma company headings 9903.04.61/.64/.65/.66 and US-API dosage form 9903.04.68 (note 40(e), (h))', () => {
    const p = (o: string, answers: object, entryDate = '2026-10-28') => run('2918.99.30.00', o, 10000, { entryDate }, answers as Answers);
    expect(charged(p('IN', { pharmaType: 'patented', pharmaCompany: 'onshoring' }))).toContain('9903.04.64=2000');
    expect(headings(p('IN', { pharmaType: 'patented', pharmaCompany: 'specialty' }))).toContain('9903.04.66');
    expect(p('IN', { pharmaType: 'patented', pharmaCompany: 'specialty' }).duty).toBe(650);       // .66 also lifts note 52 (52(f))
    expect(headings(p('IN', { pharmaType: 'patented', pharmaCompany: 'listed' }, '2026-09-20'))).toContain('9903.04.61');
    expect(headings(p('IN', { pharmaType: 'patented', pharmaCompany: 'listed' }, '2026-10-01'))).toContain('9903.04.60'); // expired 9/29
    expect(headings(p('DE', { pharmaType: 'patented', pharmaCompany: 'onshoring' }))).toContain('9903.04.62');  // 15% deal is lower
    expect(headings(p('IN', { pharmaType: 'us_api' }))).toContain('9903.04.68');
  });
  it('note 20(z)-(gg): a derived rate files 9903.88.21-.28 instead of its own List 3 / 4A duty', () => {
    expect(headings(run('6103.22.00.10', 'CN', 10000))).toContain('9903.88.15');
    const d = run('6103.22.00.10', 'CN', 10000, {}, { s301Derived: '9903.88.03' } as Answers);
    expect(headings(d)).toContain('9903.88.27');
    expect(headings(d)).not.toContain('9903.88.15');
  });
  it('polysilicon minimum-price shortfall uses the entered value, also under a Chapter 98 claim (PP 11052 cl. (2)(c))', () => {
    const mip = (ch98?: Input['ch98']) => run('8541.43.00.10', 'MY', 100000, { entryDate: '2026-12-10', quantity: 1, quantity2: 200000, ch98 },
      { polyDocs: 'resale_at_or_above' } as Answers).lines.find((l) => l.heading === '9903.45.36')?.amount;
    expect(mip()).toBe(0);
    expect(mip({ provision: '9802.00.80', deduct: 60000 })).toBe(0);   // entered value $100,000 is above $76,000
  });
  it('proof-liter rates on alcohol content use the line proof liters (no duplicate question)', () => {
    const r = run('2206.00.30.00', 'DE', 5000, { quantity: 1000, quantity2: 120 });
    expect(r.questions.some((q) => /proof liters of/.test(q.text))).toBe(false);
  });
  it('no gift exemption on goods under an AD/CVD order', () => {
    const r = run('2828.10.00.00', 'CN', 80, { mode: 'mail', entryDate: '2026-11-01' });
    expect(r.questions.some((q) => q.id === 'mailGift')).toBe(false);
  });
  it('rejects Chapter 98 and 99 numbers typed as the product (they are claims and add-ons, not goods)', () => {
    for (const code of ['9903.88.01', '9817.00.60.00', '9801.00.10.12']) {
      const r = run(code, 'CN', 1000);
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/product's own code/);
    }
  });
});
