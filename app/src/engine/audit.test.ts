// Independent accuracy audit of the duty engine (2026-10-28, HTS 2026 Rev 21).
// Every expected value is proven in the comment above its case:
//   "L123" = line 123 of data/build/hts_rev21.txt; "ref X §n" = .claude/skills/us-import-duty/references/X.
// Cases the engine gets wrong are written with the CORRECT expectation and marked `it.fails` plus
// "// FIXED (was ENGINE BUG):", so the suite stays green. When a bug is fixed its it.fails will start failing:
// flip it to `it`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calculate, digitsOf, ListIndex } from './calc';
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
type R = ReturnType<typeof run>;
/** Ch.99 + base lines as "heading=amount", excluding $0 informational lines. */
const charged = (r: R) => r.lines.filter((l) => l.amount !== 0).map((l) => `${l.heading}=${l.amount}`).sort();
const headings = (r: R) => r.lines.map((l) => l.heading);
const fee = (r: R, h: 'MPF' | 'HMF') => r.fees.find((f) => f.heading === h)?.amount;

// Shared proofs used below:
//  P52  note 52 stacks on column 1 and on 301 (L233413–233420); 232 goods exempt via 9903.05.90 (52(f) L234014–234045);
//       52(b) list exempt via 9903.05.86 (L233441, codes L233451–233642). Country rows: ref note52_country_rates.json.
//  P301 notes 20/31: 301 = column 1 + the 301 % on full value (L212426–212428, L230069–230073); adds on top of 232.
//  P232 metals note 16: one 9903.82 heading on full value; outside ch.72/73/74/76 only if metal ≥15% of weight
//       (L210902–210923). Country measures exempt (52(f)(1) L234016).
//  PMPF ref fees_dates_and_feeds.md §1.1 (FY2026 $33.58–$651.50, informal $2.69; FY2027 $34.58–$670.86, informal $2.77),
//       §1.4 (claimed FTA exemptions; JO not exempt), §1.3 (informal = not over $2,500, 19 CFR 143.21(a)); HMF §2.

describe('China — Section 301 lists and note 31 (all $10,000 unless stated)', () => {
  // List 1 8482.10.50 (L212600) +25%; base 9%; 8482.10.5068 on 16(c)(vii) (L211114) → 9903.82.09 +25% when metal ≥15%
  // of weight (P232), which blocks note 52. Below 15%: 9903.82.03 and note 52 9903.05.31 +12.5% (row L239357).
  it('CN ball bearings, List 1 + 232 derivative steel (≥15% steel) / note 52 (<15%)', () => {
    const r = run('8482.10.50.68', 'CN', 10000, {}, { metalWeight15: true });
    expect(charged(r)).toEqual(['8482.10.50.68=900', '9903.82.09=2500', '9903.88.01=2500']);
    expect(run('8482.10.50.68', 'CN', 10000, {}, { metalWeight15: false }).duty).toBe(4650);
  });
  // List 2 3920.10.00 (L212823) +25%; base 4.2% (ch39 JSON); note 52 +12.5% (P52).
  it('CN polyethylene film, List 2', () => expect(run('3920.10.00.00', 'CN', 10000).duty).toBe(4170));
  // List 4A 8528.72.64 (L217980) +7.5% (row L242100); base 3.9%; note 52 +12.5%.
  it('CN 40-inch TV, List 4A', () => {
    const r = run('8528.72.64.40', 'CN', 10000);
    expect(charged(r)).toEqual(['8528.72.64.40=390', '9903.05.31=1250', '9903.88.15=750']);
  });
  // 31(c)(1) 8541.42.00 (L230229) → 9903.91.02 +50% (row L242861); base Free; note 52 +12.5%.
  it('CN solar cells, 9903.91.02 50%', () => expect(run('8541.42.00.10', 'CN', 10000).duty).toBe(6250));
  // 31(f)(i) 8542.31.00 (L230303) → 9903.91.05 +50% (row L242875); 8542.31 on 52(b) (L233635) → no note 52.
  it('CN CPUs, 9903.91.05 50%, note 52(b) exempt', () => {
    const r = run('8542.31.00.45', 'CN', 10000);
    expect(r.duty).toBe(5000);
    expect(headings(r)).toContain('9903.05.86');
  });
  // 31(d)(9) 9018.31.00 (L230253) → 9903.91.03 +100%; note 52 applies (not on 52(b)/(e)).
  it('CN hypodermic syringes, 9903.91.03 100%', () => expect(run('9018.31.00.40', 'CN', 10000).duty).toBe(11250));
  // 31(i) 4015.12.10 (L230349) → 9903.91.08 +100% (row L242907); note 52 applies.
  it('CN medical gloves, 9903.91.08 100%', () => expect(run('4015.12.10.10', 'CN', 10000).duty).toBe(11250));
  // 31(b) 7207.11.00 (L230132) → 9903.91.01 +25%; 7207 in 16(c)(iii) (L210946) → 9903.82.02 +50%; note 52 blocked.
  it('CN steel billet, 9903.91.01 + 232 50%', () =>
    expect(charged(run('7207.11.00.00', 'CN', 10000))).toEqual(['9903.82.02=5000', '9903.91.01=2500']));
  // 31(h)(3) 6307.90.9870 (L230339) → 9903.91.07 +50% (row L242883); carved out of 4A (L218124–218126); base 7%.
  it('CN disposable face masks, 9903.91.07 50%', () => expect(run('6307.90.98.70', 'CN', 10000).duty).toBe(6950));
  // 20(g) item 2: 8517.62.00 except .0090 → 9903.88.04 +25% (L214649–214650); 8517.62 on 52(b) (L233631).
  it('CN routers 8517.62.00.20, 9903.88.04 25%, no note 52', () =>
    expect(charged(run('8517.62.00.20', 'CN', 10000))).toEqual(['9903.88.04=2500']));
  // 9401.71.0001 carved out of 9903.88.04 (L214658–214659) and 4A (L218120–218122); only in suspended 4B → note 52 only.
  it('CN high chairs: no live 301', () => expect(charged(run('9401.71.00.01', 'CN', 10000))).toEqual(['9903.05.31=1250']));
  // 31(g)(5) 8507.60.00 (L230329) → 9903.91.06 +25% from 2026-01-01; base 3.4%; note 52 +12.5%.
  // 33(g) lists 8507.60 (L230763) but 33(h)(ii) (L230788–230795) sends articles that are not car/light-truck parts to
  // 9903.94.06 ("applicable subheading"), which is NOT in 52(f)(3) (L234023–234026: 94.06 only "as applied to" USMCA parts).
  // FIXED (was ENGINE BUG): every 33(g) code is charged 9903.94.05 +25% with no "is it a car part?" question (power bank → +$2,500,
  // and note 52 wrongly switched off). Correct: 340 + 2,500 + 1,250 = 4,090.
  it('CN lithium-ion power bank (not a car part): 9903.91.06 + note 52, no 232 auto parts', () => {
    const r = run('8507.60.00.90', 'CN', 10000);
    expect(r.duty).toBe(4090);
    expect(headings(r)).not.toContain('9903.94.05');
  });
  // List 1 8501.52.80 (L212612) +25%; note 52 +12.5%. 8501.52 on 33(g) (L230763) and 38(i) (L231777) but an industrial
  // motor is neither a car part (33(h)(ii) → 9903.94.06) nor a truck part (38: 9903.74.11).
  // FIXED (was ENGINE BUG): charged 9903.94.05 +25% instead of note 52 → $5,000 instead of $3,750.
  it('CN industrial AC motor (not a vehicle part): List 1 + note 52', () =>
    expect(run('8501.52.80.40', 'CN', 10000).duty).toBe(3750));
  // 4B only (suspended, L218291); 8471.30 on 52(b) (L233625); 8471 on 33(g) (L230756) but a laptop is not a car part →
  // 9903.94.06 (33(h)(ii) L230794). Correct duty $0.
  // FIXED (was ENGINE BUG): laptops (and every 8471 computer) pay 9903.94.05 +25% = $2,500.
  it('CN laptop: no 301 (4B suspended), 52(b) exempt, not an auto part → $0', () => {
    const r = run('8471.30.01.00', 'CN', 10000);
    expect(r.duty).toBe(0);
    expect(headings(r)).not.toContain('9903.94.05');
  });
  // Drones: 43(c)(3) "with thermal imaging" and (c)(4) "without thermal imaging" list the SAME codes (L232281–232288);
  // non-thermal → 9903.08.22 +25% (row L240477), thermal → 9903.08.21 +100% (row L240448). 8806.22.00 is on List 1
  // (L212682) +25%; note 52 applies to drones (not in 52(f); civil-aircraft use not claimed — open question 2).
  // FIXED (was ENGINE BUG): (c)(3) is tested first, so every drone of 8806.21/.22/.23/.91–.93 pays +100% (no thermal question).
  it('CN consumer drone without thermal camera: 9903.08.22 25% + List 1 + note 52', () => {
    const r = run('8806.22.00.00', 'CN', 10000, {}, { droneUse: true });
    expect(charged(r)).toEqual(['9903.05.31=1250', '9903.08.22=2500', '9903.88.01=2500']);
  });
});

describe('China — exclusions and the 2026-11-09/10 switch', () => {
  // List 3 0304.72.50 (L212989); bare exclusion 20(vvv)(iii)(1) (L228843) via 9903.88.69 through 2026-11-09 (L242475–242479).
  it('CN frozen haddock: excluded on 11-09, List 3 from 11-10', () => {
    expect(run('0304.72.50.00', 'CN', 10000, { entryDate: '2026-11-09' }).duty).toBe(1250);
    const r = run('0304.72.50.00', 'CN', 10000, { entryDate: '2026-11-10' });
    expect(charged(r)).toEqual(['9903.05.31=1250', '9903.88.03=2500']);
  });
  // List 2 8486.10 (L212843); 20(www)(1) Czochralski furnace >700 kg for solar wafers (L229204–229206) via 9903.88.70
  // through 2026-11-09 (L242481–242485); 52(b) (L233629). $100,000.
  it('CN Czochralski solar furnace: 9903.88.70 to 11-09, List 2 from 11-10', () => {
    expect(run('8486.10.00.00', 'CN', 100000, {}, { s301Exclusion: true }).duty).toBe(0); // described exclusion: user confirms it matches
    expect(run('8486.10.00.00', 'CN', 100000, { entryDate: '2026-11-10' }, { s301Exclusion: true }).duty).toBe(25000);
  });
  // 20(www) items (8)–(12) for 8486.20.0000 are ONLY solar-cell/wafer machines (L229240–229264); a semiconductor-fab
  // etcher is not described, so List 2 8486.20 (L212844) +25% applies; 52(b) (L233630). $100,000.
  // FIXED (was ENGINE BUG): exclusions are matched by code alone — every 8486.20.00.00 machine is excluded until 11-09 (pays $0).
  it('CN semiconductor (non-solar) wafer etcher: List 2 25% on 2026-10-28', () =>
    expect(run('8486.20.00.00', 'CN', 100000).duty).toBe(25000));
  // List 1 9032.10.00 (L212726); exclusion 20(vvv)(i)(47) covers only thermostats "not designed to connect to the
  // internet" (L228747–228748). A Wi-Fi thermostat → 9903.88.01 +25%; base 1.7%; note 52 +12.5% → 170+2500+1250.
  // FIXED (was ENGINE BUG): the described exclusion is applied without asking → 301 dropped ($1,420 instead of $3,920).
  it('CN Wi-Fi smart thermostat: exclusion does not apply', () =>
    expect(run('9032.10.00.30', 'CN', 10000).duty).toBe(3920));
  // List 3 9401.61.60 (L214606); 37(d) 9401.61.6011 (L231498) → 9903.76.02 +25%.
  // Exclusion 20(vvv)(iii)(66) is only for seats 144–214 cm wide, 81–89 cm high, 81–163 cm deep (L229073–229075).
  // An 80 cm-wide armchair → List 3 + 76.02 = $5,000.
  // FIXED (was ENGINE BUG): every 9401.61.6011 seat is treated as excluded → List 3 dropped ($2,500).
  it('CN upholstered wooden armchair (outside exclusion 66 dimensions): List 3 + 232 wood', () =>
    expect(charged(run('9401.61.60.11', 'CN', 10000))).toEqual(['9903.76.02=2500', '9903.88.03=2500']));
  // STS crane: 9903.92.10 +25% from 2024-09-27 (L243029); from 2026-11-10 also 9903.91.14 +100% (L242961) and they
  // stack (31(l)(i) L230423–230425); note 52 applies. $1,000,000.
  it('CN ship-to-shore crane: 25% now, 125% from 11-10', () => {
    expect(run('8426.19.00.00', 'CN', 1000000, {}, { stsCrane: true }).duty).toBe(375000);
    expect(run('8426.19.00.00', 'CN', 1000000, { entryDate: '2026-11-10' }, { stsCrane: true }).duty).toBe(1375000);
  });
  // 9903.92.10 is ONLY ship-to-shore cranes; other 8426.19.00 cranes are 9903.92.80 "applicable subheading" (L243045);
  // 9903.91.14 is STS-only too (31(l)(i) L230406). Overhead gantry crane: base Free + note 52 12.5% = $125,000.
  // FIXED (was ENGINE BUG): every 8426.19.00 crane gets 9903.92.10 (+$250,000), and +100% more from 11-10.
  it('CN overhead gantry crane (not STS): 9903.92.80, note 52 only', () =>
    expect(run('8426.19.00.00', 'CN', 1000000).duty).toBe(125000));
  // Chassis: List 3 8716.39.00 (L214567) +25%; 8716.39.00 on 16(c)(vi)/(vii) (L211054, L211148) → 9903.82.09 +25%
  // (steel ≥15% of weight). From 2026-11-10 intermodal chassis add 9903.91.12 +100% (L242936–242942); stacking with
  // List 3 is the literal reading (ref open_questions.md #1, flagged interpretation).
  it('CN intermodal chassis: 11-09 vs 11-10', () => {
    expect(run('8716.39.00.90', 'CN', 10000, { entryDate: '2026-11-09' }, { metalWeight15: true, chassis: true }).duty).toBe(5000);
    const r = run('8716.39.00.90', 'CN', 10000, { entryDate: '2026-11-10' }, { metalWeight15: true, chassis: true });
    expect(r.duty).toBe(15000);
    expect(r.lines.find((l) => l.heading === '9903.88.03')?.interpretation).toBeTruthy();
  });
  // 31(k)(ii) (L230401–230405): 8716.39.0090 goods that are NOT intermodal chassis go to 9903.91.13 (no duty).
  // A flatbed equipment trailer on 2026-11-10: List 3 + 82.09 = $5,000.
  // FIXED (was ENGINE BUG): no chassis question; every 8716.39.0090 trailer gets +100% from 11-10 ($15,000).
  it('CN flatbed trailer (not an intermodal chassis) on 2026-11-10: 9903.91.13, no +100%', () =>
    expect(run('8716.39.00.90', 'CN', 10000, { entryDate: '2026-11-10' }, { metalWeight15: true }).duty).toBe(5000));
});

describe('Section 232 families', () => {
  // 40(c) list (3004.90.92 L232018–232025); patented → 9903.04.60 100% all-in (L232059–232063); CH → 9903.04.62 15%
  // all-in (L232068–232073); note 52 blocked (52(f)(8)). No 301 list covers 3004.90.92.
  it('patented drug: CN 100% all-in; CH 15% all-in', () => {
    expect(run('3004.90.92.60', 'CN', 10000, {}, { pharmaType: 'patented' }).duty).toBe(10000);
    expect(run('3004.90.92.60', 'CH', 10000, {}, { pharmaType: 'patented' }).duty).toBe(1500);
  });
  // 33(g) 8708.29 (L230737–230786) → 9903.94.05 +25% (row L243109) on base 2.5%; USMCA → 9903.94.06 (33(h)(i)) and
  // special Free; MPF exempt with S (PMPF §1.4).
  it('MX car body part: 94.05 25% without USMCA; $0 and no MPF with USMCA', () => {
    expect(run('8708.29.51.90', 'MX', 10000).duty).toBe(2750);
    const u = run('8708.29.51.90', 'MX', 10000, { claim: 'S' });
    expect(u.duty).toBe(0);
    expect(fee(u, 'MPF')).toBe(0);
  });
  // JP / TW brake parts 8708.30 on 33(g): 9903.94.43 / 9903.94.67 15% all-in (rows L243195, L243331) on base 2.5%.
  it('JP and TW brake parts: 15% all-in', () => {
    expect(run('8708.30.50.90', 'JP', 10000).duty).toBe(1500);
    expect(run('8708.30.50.90', 'TW', 10000).duty).toBe(1500);
  });
  // 33(b) 8703.23 → EU 9903.94.51 15% all-in (row L243238) on 2.5% base: $40,000 → $6,000.
  it('DE car: 15% all-in', () => expect(run('8703.23.01.60', 'DE', 40000).duty).toBe(6000));
  // USMCA car with Commerce-approved US content: 9903.94.03 25% on non-US content (L230658–230667); 8703.23 is not
  // on note 51 .14 (8703 entries there are only 8703.10.50 and 8703.21.01, L233160). 25% × $28,000.
  it('CA car, USMCA, $12k US content: $7,000', () =>
    expect(run('8703.23.01.60', 'CA', 40000, { claim: 'S', mode: 'truck' }, { usContent: 12000 }).duty).toBe(7000));
  // 16(c)(xi) 8429.51.10 (L211189) → Japan 9903.82.22 15% all-in (ref section232.md §1a row 82.22); base Free.
  it('JP wheel loader: 9903.82.22 15% all-in', () =>
    expect(run('8429.51.10.05', 'JP', 200000, {}, { metalWeight15: true }).duty).toBe(30000));
  // 16(c)(v) copper 7411.10.10 (L211019) → 9903.82.02 +50% on full value; base 1.5%; EU note 52 blocked.
  it('DE copper tube: 50% + base', () => expect(run('7411.10.10.30', 'DE', 10000).duty).toBe(5150));
  // 16(c)(i) 7604 → 82.02 50%; note 51 .14 lists 7604.10.10 (L233137) and 51(c) carves 232 only out of .13 (L233186):
  // both apply, USMCA does not remove 51 (ref country_measures.md §3.3; open question 3 = literal reading).
  it('CA aluminum profiles, USMCA: 232 50% + Section 338 50%', () =>
    expect(charged(run('7604.10.10.00', 'CA', 10000, { claim: 'S', mode: 'truck' }))).toEqual(['9903.03.14=5000', '9903.82.02=5000']));
  // 39(b) 8471.50 + technical test met → 9903.79.01 +25% (L231833–231919); note 52 blocked (L234043). $300,000.
  it('TW AI server with qualifying GPU: 9903.79.01 25%', () =>
    expect(run('8471.50.01.50', 'TW', 300000, {}, { chipQualifies: true }).duty).toBe(75000));
  // Fails the test → 9903.79.02 "applicable subheading" (L231921–231922). 8471 is on 33(g) but a server is not a car part
  // (33(h)(ii) → 9903.94.06); 8471.50 on 52(b) (L233625). Correct duty $0.
  // FIXED (was ENGINE BUG): falls through to the auto-parts list → 9903.94.67 15% all-in = $45,000.
  it('TW server, chip outside the note 39 window: $0', () =>
    expect(run('8471.50.01.50', 'TW', 300000, {}, { chipQualifies: false }).duty).toBe(0));
  // 37(f) kitchen cabinets 9403.40.9060 (L231524) → 9903.76.03 +25%; note 52 blocked (52(f)(4)).
  it('VN kitchen cabinets: 9903.76.03 25%', () => expect(run('9403.40.90.60', 'VN', 10000).duty).toBe(2500));
  // 37(f) lists the basket 9403.60.8093 (L231525) but 37(g) (L231528–231529) sends anything other than wooden kitchen
  // cabinets/vanities to 9903.76.04 (no 232). A wooden bookcase → note 52 VN +12.5% (row L239967) = $1,250.
  // FIXED (was ENGINE BUG): no cabinet question — all "other wooden furniture" 9403.60.8093 pays 25% 232 and skips note 52.
  it('VN wooden bookcase (9403.60.80.93, not a cabinet): 9903.76.04 + note 52', () =>
    expect(charged(run('9403.60.80.93', 'VN', 10000))).toEqual(['9903.05.84=1250']));
  // Same 33(h)(ii) point as the CN laptop: VN laptop → 52(b) exempt, no 232 → $0.
  // FIXED (was ENGINE BUG): 9903.94.05 +25%.
  it('VN laptop: $0', () => expect(run('8471.30.01.00', 'VN', 10000).duty).toBe(0));
  // Note 43 drones from deal partners take 9903.08.23/.24 only if "substantially all critical components" are allied
  // (43(d) L232291–232299); the engine assumes so and must flag it.
  it('JP drone: 9903.08.24 flagged as an interpretation', () => {
    const l = run('8806.22.00.00', 'JP', 10000, {}, { droneUse: true }).lines.find((x) => x.heading === '9903.08.24');
    expect(l?.interpretation).toBeTruthy();
  });
});

describe('Country measures, FTA claims and column 2 ($10,000)', () => {
  // Note 52 IN +10% (row L239521) on base 16.5%.
  it('IN cotton T-shirts', () => expect(run('6109.10.00.12', 'IN', 10000).duty).toBe(2650));
  // MX TV with USMCA: special Free; 52(h) → 9903.05.94 (L234052–234055); MPF exempt; HMF still due (0.125%).
  it('MX TV with USMCA: $0 duty, no MPF, HMF $12.50', () => {
    const r = run('8528.72.64.40', 'MX', 10000, { claim: 'S' });
    expect(r.duty).toBe(0);
    expect(headings(r)).toContain('9903.05.94');
    expect(fee(r, 'MPF')).toBe(0);
    expect(fee(r, 'HMF')).toBe(12.5);
  });
  // Note 51 .14 lists 9403.60.80 (L233171) +50%, no USMCA carve-out (L232957–232959); note 52 off (52(g) L234047).
  it('CA wooden dining table, USMCA: Section 338 50% only', () => {
    const r = run('9403.60.80.40', 'CA', 10000, { claim: 'S', mode: 'truck' });
    expect(charged(r)).toEqual(['9903.03.14=5000']);
    expect(r.total).toBe(5000);
  });
  // EU all-in 10% (52(k) L235807–235808), base 2.5% → +7.5%.
  it('DE ultrasonic cleaner: EU 10% all-in', () => expect(run('8479.89.95.85', 'DE', 10000).duty).toBe(1000));
  // Specific rate: 6.3¢/L × 1,000 L = $63 → AVE 0.63% (52(k) L235798–235804) → topped up to 10% = $1,000 total.
  it('IT wine 1,000 L: specific rate converted to AVE for the 10% all-in', () =>
    expect(run('2204.21.50.40', 'IT', 10000, { quantity: 1000 }).duty).toBe(1000));
  // KR all-in 12.5% (row L239843) on the claimed KORUS rate (Free); KORUS claim exempts MPF; HMF 12.50.
  it('KR cosmetics with KORUS: 12.5% all-in, no MPF', () => {
    const r = run('3304.99.50.00', 'KR', 10000, { claim: 'KR' });
    expect(r.duty).toBe(1250);
    expect(r.total).toBe(1262.5);
  });
  // TW all-in 10%; base 11% ≥ 10% → 9903.05.75, nothing added (row L239868).
  it('TW kids bicycles at 11%: nothing added', () => {
    const r = run('8712.00.15.10', 'TW', 10000);
    expect(r.duty).toBe(1100);
    expect(headings(r)).toContain('9903.05.75');
  });
  // Brazil steel: 232 blocks notes 50 and 52 (50(a)(vi)(1) L232915–232918, 52(f)(1)) → 82.02 only.
  it('BR steel billet: 232 only', () => expect(charged(run('7207.11.00.00', 'BR', 10000))).toEqual(['9903.82.02=5000']));
  // Coffee 0901.21 on 50(ii) (L232384) and 52(b) (L233478).
  it('BR roasted coffee: both Brazil measures exempt', () => expect(run('0901.21.00.40', 'BR', 10000).duty).toBe(0));
  // AU FTA Free (special column), note 52 AU +12.5% still applies (L233418–233420), MPF exempt (AU).
  it('AU wine with AUSFTA claim', () => {
    const r = run('2204.21.50.40', 'AU', 10000, { quantity: 1000, claim: 'AU' });
    expect(r.duty).toBe(1250);
    expect(fee(r, 'MPF')).toBe(0);
  });
  // CL FTA Free; note 52 CL +12.5% (row L239347); MPF exempt (CL).
  it('CL wine with Chile FTA claim', () => {
    const r = run('2204.21.50.40', 'CL', 10000, { quantity: 1000, claim: 'CL' });
    expect(r.duty).toBe(1250);
    expect(fee(r, 'MPF')).toBe(0);
  });
  // SG FTA Free; note 52 SG +12.5% (row L239800); MPF exempt (SG).
  it('SG food preparation with SG FTA claim', () => {
    const r = run('2106.90.58.90', 'SG', 10000, { claim: 'SG' });
    expect(r.duty).toBe(1250);
    expect(fee(r, 'MPF')).toBe(0);
  });
  // JO FTA Free; 52(j) JO list exempts 6109.10 (9903.06.20, L235348, code L235623) with no claim condition;
  // Jordan is NOT MPF-exempt (PMPF §1.4) → MPF $34.64.
  it('JO T-shirts with JO claim: $0 duty, MPF still due', () => {
    const r = run('6109.10.00.12', 'JO', 10000, { claim: 'JO' });
    expect(r.duty).toBe(0);
    expect(fee(r, 'MPF')).toBe(34.64);
  });
  // GT handbag with CAFTA-DR claim: special Free + 9903.06.06 ((j)(6)(iii) L234282–234285, code L234295).
  it('GT plastic handbag with CAFTA-DR claim: $0', () => expect(run('4202.22.15.00', 'GT', 10000, { claim: 'P' }).duty).toBe(0));
  // (j)(6)(iii) applies only to goods "for which entry is claimed under" CAFTA-DR (L234282–234285). Without the claim:
  // base 16% + 9903.05.40 +10% (row L239465) = $2,600.
  // FIXED (was ENGINE BUG): the GT/SV CAFTA-claimed lists (9903.06.06 / .06.09) are applied with no claim.
  it('GT plastic handbag without a CAFTA-DR claim: 16% + 10%', () =>
    expect(run('4202.22.15.00', 'GT', 10000).duty).toBe(2600));
  // 52(i) (L234057–234061, row L240099): CAFTA-DR duty-free textile/apparel goods (GN 29(d)(v) L26329) of CR, DO, SV,
  // GT, HN, NI are exempt via 9903.05.95. HN T-shirt with P claim: Free + exempt = $0.
  // FIXED (was ENGINE BUG): rules.json list n52:*:0 for 9903.05.95 is empty → +10% charged.
  it('HN cotton T-shirts with CAFTA-DR claim: 9903.05.95, $0', () => {
    const r = run('6109.10.00.12', 'HN', 10000, { claim: 'P' });
    expect(r.duty).toBe(0);
    expect(headings(r)).toContain('9903.05.95');
  });
  // Column 2 (GN 3(b) L836–842): 6109.10 column 2 = 90%. Belarus is not a note 52 economy.
  it('BY T-shirts: column 2, no note 52', () => expect(charged(run('6109.10.00.12', 'BY', 10000))).toEqual(['6109.10.00.12=9000']));
  // Russia row 9903.05.66 (L239778–239790) prints "+12.5%" in column 2 as well (ref note52_country_rates.json RU:
  // "+12.5% also on column-2 rate"). 6109 is on neither note 30 list. 90% + 12.5% = $10,250.
  // FIXED (was ENGINE BUG): note52() returns nothing for any column-2 origin, so Russia's +12.5% is never charged.
  it('RU T-shirts: column 2 + note 52 Russia 12.5%', () =>
    expect(run('6109.10.00.12', 'RU', 10000).duty).toBe(10250));
  // Note 30(a) (L229606–229613): RU goods in 30(b) (2501.00.00 at L229648) pay 35% via 9903.90.08 IN LIEU OF column 2
  // (26%). Plus 9903.05.66 +12.5% → $4,750.
  // ENGINE BUG + GAP: note 30 not modelled (column 2 26% used) and note 52 RU missing → $2,600.
  it('RU salt: note 30 35% + note 52 12.5%', () =>
    expect(run('2501.00.00.00', 'RU', 10000, { quantity: 100 }).duty).toBe(4750));
  // Compound rate 8.8¢/kg + 20% (L59863; ref base_rates §7 #2): 1,000 kg, $5,000 → 88 + 1,000; note 52 TR +12.5%
  // (row L239902) = 625. MPF 17.32 → raised to FY2027 minimum 34.58; HMF 6.25.
  it('TR chanterelles 1,000 kg: compound rate + note 52, MPF minimum', () => {
    const r = run('0709.53.00.00', 'TR', 5000, { quantity: 1000 });
    expect(r.duty).toBe(1713);
    expect(r.total).toBe(1753.83);
  });
  // 3-part compound 13.5¢/kg + 6.3% + 1.9¢/article (L143721; ref base_rates §7 #9): 1,000 hats, 200 kg, $10,000 →
  // 27.00 + 630.00 + 19.00 = 676; note 52 VN +12.5% = 1,250 → $1,926.
  // FIXED (was ENGINE BUG): the rate is stored as kind "text", base duty = $0 with a note asking for "component values"
  // (it needs kg and a piece count, not component values); quantity2 is never used for second-unit parts.
  it('VN felt hats 1,000 pcs / 200 kg: compound base 676 + note 52', () =>
    expect(run('6505.00.08.00', 'VN', 10000, { quantity: 1000, quantity2: 200 }).duty).toBe(1926));
});

describe('fees, informal entries and dates', () => {
  // Informal (not over $2,500, 19 CFR 143.21(a)) fee is per fiscal year: FY2026 (to 2026-09-30) = $2.69 (PMPF §1.1).
  // FIXED (was ENGINE BUG): MPF_INFORMAL is a single constant $2.77 (FY2027) for all supported dates.
  it('informal entry on 2026-09-15 pays the FY2026 $2.69 fee', () =>
    expect(fee(run('9503.00.00.90', 'TH', 2000, { entryDate: '2026-09-15' }), 'MPF')).toBe(2.69));
  // The informal fee does not apply to USMCA goods claimed at entry (24.23(c)(3); PMPF §1.4–1.5 "or $0 if every line
  // is exempt").
  // FIXED (was ENGINE BUG): the informal branch runs before the exemption check → $2.77 charged.
  it('informal USMCA entry pays no MPF', () =>
    expect(fee(run('9503.00.00.90', 'MX', 2000, { claim: 'S' }), 'MPF')).toBe(0));
  // Exactly $2,500 is "not over $2,500" → informal $2.77 (FY2027), no HMF on informal (PMPF §2, types 11/12/13).
  it('$2,500 exactly is informal: $2.77, no HMF', () => {
    const r = run('9503.00.00.90', 'TH', 2500);
    expect(fee(r, 'MPF')).toBe(2.77);
    expect(fee(r, 'HMF')).toBeUndefined();
  });
  // FY2026 min/max by entry date (PMPF §1.1–1.2).
  it('FY2026 MPF minimum and maximum', () => {
    expect(fee(run('9503.00.00.90', 'TH', 5000, { entryDate: '2026-09-15' }), 'MPF')).toBe(33.58);
    expect(fee(run('9503.00.00.90', 'TH', 500000, { entryDate: '2026-09-30' }), 'MPF')).toBe(651.5);
  });
  // HMF only on vessel cargo (PMPF §2): air → none; ocean → 0.125% = $12.50.
  it('air vs ocean HMF', () => {
    expect(fee(run('9503.00.00.90', 'TH', 10000, { mode: 'air' }), 'HMF')).toBeUndefined();
    expect(fee(run('9503.00.00.90', 'TH', 10000), 'HMF')).toBe(12.5);
  });
  // 9903.05.85 (row L239977): vessel loaded before 2026-07-24 AND entered before 2026-07-28; vessel only
  // (ref fees_dates_and_feeds.md §4.3, CSMS #69326983).
  it('note 52 in-transit relief: ocean only, entered before 07-28', () => {
    const base = { entryDate: '2026-07-27', loadingDate: '2026-07-20' } as const;
    expect(headings(run('9503.00.00.90', 'TH', 10000, base))).toContain('9903.05.85');
    expect(run('9503.00.00.90', 'TH', 10000, base).duty).toBe(0);
    expect(run('9503.00.00.90', 'TH', 10000, { ...base, mode: 'air' }).duty).toBe(1250);
    expect(run('9503.00.00.90', 'TH', 10000, { entryDate: '2026-07-28', loadingDate: '2026-07-20' }).duty).toBe(1250);
  });
  // Brazil 9903.05.02 (row L239109): loaded before 07-22 and entered before 07-29 → note 50 relieved; note 52 window
  // (entered before 07-28) already closed → 9903.05.27 +12.5%. Base 8.5%.
  it('BR shoes loaded 07-21, entered 07-28: note 50 relieved, note 52 charged', () => {
    const r = run('6403.99.60.75', 'BR', 10000, { entryDate: '2026-07-28', loadingDate: '2026-07-21' });
    expect(headings(r)).toContain('9903.05.02');
    expect(charged(r)).toEqual(['6403.99.60.75=850', '9903.05.27=1250']);
  });
});

describe('unmodelled measures (gaps)', () => {
  // Note 41 quartz surface products (L232105–232243): 6810.99.0020 slabs of non-exempt countries (CN is not in 41(c))
  // pay 9903.45.30 25% in-quota (row L241109) or 9903.45.31 50% over-quota, cumulative (41(b)). In-quota assumed:
  // List 3 2,500 + note 52 1,250 + quartz 2,500 = $6,250.
  // GAP: no quartz rule at all — engine charges $3,750.
  it('CN quartz countertop slabs: note 41 safeguard (in-quota 25%)', () =>
    expect(run('6810.99.00.20', 'CN', 10000, { quantity: 100 }, { quartzInQuota: true }).duty).toBe(6250));
  // Quota fill is unknown, so the default is over-quota (50%) — the answer that never under-charges.
  it('CN quartz slabs default to over-quota 50%', () =>
    expect(run('6810.99.00.20', 'CN', 10000, { quantity: 100 }).duty).toBe(8750));
});
