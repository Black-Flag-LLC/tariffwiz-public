// Federal excise tax CBP collects at entry on alcohol and tobacco (26 U.S.C. 5001, 5041, 5051, 5701;
// 27 CFR parts 27 and 41). Rates and rules: .claude/skills/us-import-duty/references/excise.json.
// Importers pay the full rate at entry; small-producer (CBMA) relief is a later TTB refund, never netted here.

export type ExciseAsk = (q: { id: `comp:${string}` | `x:${string}`; kind: 'number' | 'yesno'; text: string; why: string;
  defaultValue: number | boolean; money?: boolean }) => number | boolean;

export interface ExciseLine { label: string; amount: number; rate: string; why: string; cite: string }

const L_PER_GAL = 3.785411784;
const L_PER_BBL = 117.347765304;
const LB_PER_KG = 2.20462262185;
const round1 = (x: number) => Math.floor(x * 10 + 0.5 + 1e-9) / 10; // nearest 0.1, .05 up (27 CFR 27.41-27.42)

export function excise(hts: string, ask: ExciseAsk, qtyLiters: number | undefined, qtyKg: number | undefined,
  qtyProofLiters?: number, qtyThousands?: number): ExciseLine | null {
  const d = hts.replace(/\D/g, '');
  const starts = (...p: string[]) => p.some((x) => d.startsWith(x));
  const liters = () => qtyLiters ?? (ask({ id: 'comp:liters', kind: 'number', defaultValue: 0, text: 'How many liters in total?',
    why: 'Federal excise tax on alcohol is charged by volume.' }) as number);
  const abv = () => ask({ id: 'comp:abv', kind: 'number', defaultValue: starts('2207', '2208') ? 40 : 13, text: 'Alcohol by volume (%)?',
    why: 'The excise rate depends on alcohol strength (16%, 21% and 24% thresholds).' }) as number;
  const kg = () => qtyKg ?? (ask({ id: 'comp:net_kg', kind: 'number', defaultValue: 0, text: 'Net weight in kg?',
    why: 'Federal excise tax on this tobacco product is charged by weight.' }) as number);
  const wine = (rate: number, what: string): ExciseLine => {
    const wg = round1(liters() / L_PER_GAL);
    return { label: 'Federal excise tax (wine)', amount: wg * rate, rate: `$${rate}/wine gallon`, why: `${what}: ${wg} wine gallons.`,
      cite: '26 U.S.C. 5041; 27 CFR 27.42' };
  };
  const spirits = (a: number): ExciseLine => {
    // HTS reports spirits in proof liters: proof gallons = proof liters / liters per gallon
    const pg = round1(qtyProofLiters !== undefined ? qtyProofLiters / L_PER_GAL : (liters() / L_PER_GAL) * (a * 2) / 100);
    return { label: 'Federal excise tax (spirits)', amount: pg * 13.5, rate: '$13.50/proof gallon',
      why: qtyProofLiters !== undefined ? `${pg} proof gallons (from ${qtyProofLiters} proof liters).` : `${pg} proof gallons at ${a}% alcohol.`,
      cite: '26 U.S.C. 5001; 27 CFR 27.41' };
  };
  const beer = (): ExciseLine => {
    const bbl = liters() / L_PER_BBL;
    return { label: 'Federal excise tax (beer)', amount: bbl * 18, rate: '$18/barrel', why: `${bbl.toFixed(3)} barrels.`, cite: '26 U.S.C. 5051, 5052' };
  };
  const stillByAbv = (): ExciseLine => {
    const a = abv();
    if (a > 24) return spirits(a);
    if (a > 21) return wine(3.15, 'Still wine over 21% alcohol');
    if (a > 16) return wine(1.57, 'Still wine over 16% alcohol');
    return wine(1.07, 'Still wine up to 16% alcohol');
  };
  const sparkling = (): ExciseLine => {
    const a = abv();
    if (a > 24) return spirits(a);
    const artificial = ask({ id: 'x:artificially_carbonated', kind: 'yesno', defaultValue: false, text: 'Is the wine artificially carbonated (not naturally sparkling)?',
      why: 'Naturally sparkling wine is taxed at $3.40 a gallon; artificially carbonated at $3.30.' }) as boolean;
    return artificial ? wine(3.3, 'Artificially carbonated wine') : wine(3.4, 'Sparkling wine');
  };

  // alcohol
  if (starts('2203')) return beer();
  if (starts('22060045')) return beer(); // sake is "beer" for excise (5052(a))
  if (starts('220410', '22042120', '22060060')) return sparkling();
  if (starts('22061510')) {
    const a = abv();
    const apple = ask({ id: 'x:apple_pear_only', kind: 'yesno', defaultValue: true, text: 'Made only from apples or pears, lightly carbonated at most?',
      why: 'Qualifying hard cider (0.5%–8.5% alcohol) is taxed at $0.226 a gallon.' }) as boolean;
    if (apple && a >= 0.5 && a < 8.5) return wine(0.226, 'Hard cider');
    return stillByAbv();
  }
  if (starts('22060090')) {
    const malt = ask({ id: 'x:malt_base', kind: 'yesno', defaultValue: false, text: 'Is it malt-based (a flavored malt beverage)?',
      why: 'Malt beverages are taxed as beer; fruit wines and meads as wine.' }) as boolean;
    return malt ? beer() : stillByAbv();
  }
  if (starts('2204', '2205', '2206')) return stillByAbv();
  if (starts('2207', '2208')) return spirits(qtyProofLiters !== undefined ? 0 : abv());

  // tobacco
  if (starts('240220')) {
    const n = qtyThousands !== undefined ? qtyThousands * 1000
      : ask({ id: 'comp:sticks', kind: 'number', defaultValue: 0, text: 'How many cigarettes?', why: 'Cigarettes are taxed $50.33 per thousand.' }) as number;
    return { label: 'Federal excise tax (cigarettes)', amount: (n / 1000) * 50.33, rate: '$50.33/1,000', why: `${n} cigarettes.`, cite: '26 U.S.C. 5701(b)' };
  }
  if (starts('240210')) {
    const n = ask({ id: 'comp:cigars', kind: 'number', defaultValue: 0, text: 'How many cigars?', why: 'Cigars are taxed per cigar.' }) as number;
    if (d.length >= 10 && d.endsWith('30')) // stat suffix .30 = small cigars (≤ 3 lb per thousand)
      return { label: 'Federal excise tax (small cigars)', amount: (n / 1000) * 50.33, rate: '$50.33/1,000', why: `${n} small cigars.`, cite: '26 U.S.C. 5701(a)(1)' };
    const price = ask({ id: 'comp:cigar_sale_price', kind: 'number', money: true, defaultValue: 1, text: 'Your US sale price per cigar (USD)?',
      why: 'Large cigars are taxed at 52.75% of the importer\'s sale price, capped at $0.4026 each.' }) as number;
    const each = Math.min(0.5275 * price, 0.4026);
    return { label: 'Federal excise tax (large cigars)', amount: n * each, rate: '52.75%, max $0.4026 each', why: `${n} cigars at $${each.toFixed(4)} each.`, cite: '26 U.S.C. 5701(a)(2)' };
  }
  const perLb: [string[], number, string][] = [
    [['240311', '2403192020'], 2.8311, 'pipe tobacco'], [['2403192050'], 24.78, 'roll-your-own tobacco'],
    [['2403992130'], 0.5033, 'chewing tobacco'], [['2403992140'], 1.51, 'snuff'],
  ];
  for (const [p, rate, what] of perLb) if (starts(...p)) {
    const lb = kg() * LB_PER_KG;
    return { label: `Federal excise tax (${what})`, amount: lb * rate, rate: `$${rate}/lb`, why: `${lb.toFixed(2)} lb of ${what}.`, cite: '26 U.S.C. 5701' };
  }
  return null;
}
