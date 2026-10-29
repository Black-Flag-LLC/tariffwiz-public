// The TARIFFWIZ duty engine. Pure: (input, HTS line, rules) -> result.
// Domain rules and citations: .claude/skills/us-import-duty (SKILL.md §2, references/stacking.md).
import { compKey, parseComponentRate } from './component';
import { excise } from './excise';
import type { Answers, HtsLine, Input, Line, Question, Rate, Result, Rules } from './types';

const SUPPORTED_FROM = '2026-07-24'; // current country regime (note 52); earlier entries not modelled yet

// MPF limits per fiscal year (19 CFR 24.23; CBP Dec. 25-10, 26-14). FY starts Oct 1.
const MPF = [
  { from: '2025-10-01', min: 33.58, max: 651.5, informal: 2.69 },
  { from: '2026-10-01', min: 34.58, max: 670.86, informal: 2.77 },
];
const MPF_RATE = 0.003464;
const SUPPORTED_TO = '2027-06-22'; // 9903.91.05 rises on 2027-06-23 by an amount not yet published
const HMF_RATE = 0.00125;
// Programs whose claim exempts MPF (19 U.S.C. 58c(b); fees reference §1.4). Jordan and Morocco are not exempt.
const MPF_EXEMPT = new Set(['S', 'S+', 'IL', 'SG', 'CL', 'AU', 'BH', 'OM', 'PE', 'KR', 'CO', 'PA', 'P', 'P+', 'E', 'E*', 'R']);

const DEAL_15 = new Set(['JP', 'KR', 'CH', 'LI', 'TW']); // plus EU members, see isEU()

export const cents = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
const fmtPct = (p: number) => `${Number(p.toFixed(4))}%`;

export function digitsOf(code: string) {
  return code.replace(/\D/g, '');
}

/** Prefix index over every list in rules.json: does an HTS10 fall in a list (4/6/8/10-digit entries)? */
export class ListIndex {
  private sets = new Map<string, Set<string>>();
  constructor(lists: Record<string, string[]>) {
    for (const [k, codes] of Object.entries(lists)) this.sets.set(k, new Set(codes.map(digitsOf)));
  }
  has(list: string, hts: string): boolean {
    const s = this.sets.get(list);
    if (!s) return false;
    const d = digitsOf(hts);
    for (const n of [4, 6, 8, 10]) if (d.length >= n && s.has(d.slice(0, n))) return true;
    return false;
  }
}

interface Ctx {
  input: Input;
  line: HtsLine;
  rules: Rules;
  idx: ListIndex;
  a: Answers;
  questions: Question[];
  notes: string[];
  base: { amount: number; avePct: number; rateText: string; program: string | null };
  quotaHeading?: string;  // FTA in-quota provision claimed (filed with the commodity line)
}

function isEU(rules: Rules, iso: string) {
  return iso === 'EU' || rules.groups.EU.includes(iso);
}

function onOrAfter(d: string, from: string | null) {
  return !from || d >= from;
}
function onOrBefore(d: string, to: string | null) {
  return !to || d <= to;
}

/** Ask a follow-up question once; return the answer or its default. */
function ask<K extends keyof Answers>(c: Ctx, q: Omit<Question, 'id'> & { id: K }): { value: NonNullable<Answers[K]>; assumed: boolean } {
  if (!c.questions.some((x) => x.id === q.id)) c.questions.push(q as Question);
  const raw = c.a[q.id] as unknown;
  const v = q.kind === 'yesno' ? (typeof raw === 'boolean' ? raw : undefined)
    : q.kind === 'number' ? (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : undefined)
      : q.kind === 'choice' ? ((q.options ?? []).some((o) => o.value === raw) ? raw : undefined)
        : typeof raw === 'string' ? raw : undefined;
  return v === undefined || v === null
    ? { value: q.defaultValue as NonNullable<Answers[K]>, assumed: true }
    : { value: v as NonNullable<Answers[K]>, assumed: false };
}

// ---------------------------------------------------------------- base rate

function rateAmount(c: Ctx, rate: Rate): { amount: number; ok: boolean } {
  let amount = 0;
  let ok = true;
  for (const p of rate.parts) {
    if (p.type === 'adv') amount += (c.input.value * p.pct) / 100;
    else {
      const r = unitQty(c, p.per, p.basis);
      if (!r.known) ok = false;
      amount += p.usd * r.qty;
    }
  }
  return { amount, ok };
}

const UNIT_WORDS: Record<string, string> = { 'no': 'pieces', 'doz': 'dozen', 'kg': 'kilograms', 'g': 'grams', 'liter': 'liters',
  'pf.liter': 'proof liters', 'm2': 'square meters', 'pr': 'pairs', 'doz.pr': 'dozen pairs', 'thousand': 'thousands', 't': 'metric tons' };
const unitNorm = (u: string) => u.toLowerCase().replace(/\s+/g, '').replace(/\.$/, '').replace(/s$/, '').replace(/^1000$/, 'thousand');

/** Map a rate's "per" unit onto one of the line's reporting units: index and factor (rate-unit qty = line qty × factor). */
export function unitMap(lineUnits: string[], per: string): { i: number; factor: number } | null {
  const p = unitNorm(per.replace(/\s+(of|on|including)\b.*$/i, ''));
  const units = lineUnits.map(unitNorm);
  const at = (...names: string[]) => units.findIndex((u) => names.includes(u));
  const hit = (i: number, factor = 1) => (i >= 0 ? { i, factor } : null);
  if (['each', 'article', 'no', 'piece'].includes(p)) return hit(at('no'));
  if (p === 'thousand') return hit(at('thousand')) ?? hit(at('no'), 1 / 1000);
  if (p === 'kg' || p === 'cleankg') return hit(at('kg')) ?? hit(at('g'), 1 / 1000) ?? hit(at('t'), 1000);
  if (p === 'pf.liter' || p === 'proofliter') return hit(at('pf.liter', 'proofliter'));
  if (p === 'liter') return hit(at('liter'));
  if (p === 'gros') return hit(at('gros')) ?? hit(at('no'), 1 / 144);
  if (p === 'doz') return hit(at('doz')) ?? hit(at('no'), 1 / 12);
  return hit(units.indexOf(p));
}

/** Quantity in the rate's unit: from the line's reporting units when they match (converted), else asked for directly. */
function unitQty(c: Ctx, per: string, basis?: string): { qty: number; known: boolean } {
  const why = `This line has a duty per ${per}${basis ? ` (${basis})` : ''}.`;
  // 8-digit lines carry no reporting units: the quantity the user entered is the one to use
  const m = !c.line.units.length ? { i: 0, factor: 1 } : unitMap(c.line.units, per);
  if (m && (m.i === 0 || m.i === 1)) {
    const v = m.i === 1 ? c.input.quantity2 : c.input.quantity;
    if (v !== undefined) return { qty: v * m.factor, known: true };
    const id = m.i === 1 ? 'quantity2' : 'quantity';
    const u = c.line.units[m.i];
    if (!c.questions.some((q) => q.id === id))
      c.questions.push({ id, kind: 'number', defaultValue: 0, text: `How many ${u ? UNIT_WORDS[unitNorm(u)] ?? u : per === 'piece' ? 'pieces' : per}?`, why });
    return { qty: 0, known: false };
  }
  const q = ask(c, { id: compKey(per), kind: 'number', defaultValue: 0, text: `How many ${UNIT_WORDS[unitNorm(per)] ?? per + ' units'}?`, why });
  return { qty: q.value, known: !q.assumed };
}

/** Base duty for component-priced rates (see component.ts). */
function componentAmount(c: Ctx, raw: string): { amount: number } | { refer: string } | null {
  const p = parseComponentRate(raw);
  if (!p || 'refer' in p) return p;
  const ons = p.parts.filter((x) => x.kind === 'pct' && x.on);
  let amount = 0;
  for (const part of p.parts) {
    if (part.kind === 'pct') {
      if (!part.on) { amount += (c.input.value * part.pct) / 100; continue; }
      // one component: assume it carries the whole value until answered; several: ask each
      const q = ask(c, { id: compKey(part.on), kind: 'number', money: true, defaultValue: ons.length === 1 ? c.input.value : 0,
        text: `Value of the ${part.on} (USD)?`, why: `This line charges ${part.pct}% on the ${part.on}.` });
      amount += (q.value * part.pct) / 100;
    } else if (part.kind === 'sugar') {
      const deg = ask(c, { id: compKey('degrees'), kind: 'number', defaultValue: 100, text: 'Polarity (degrees) of the sugar?',
        why: 'The duty per kg falls for each degree under 100.' }).value;
      const centsPerKg = Math.max(part.floor, part.base - part.less * Math.max(0, 100 - deg));
      amount += (unitQty(c, 'kg').qty * centsPerKg) / 100;
    } else if (part.per === 'jewel') {
      const n = ask(c, { id: compKey('jewel'), kind: 'number', defaultValue: 0, text: 'How many jewels does the movement have?',
        why: `This line charges per jewel${part.over ? ` over ${part.over}` : ''}.` }).value;
      amount += Math.max(0, n - (part.over ?? 0)) * part.usd;
    } else amount += unitQty(c, part.per).qty * part.usd;
  }
  return { amount };
}

function rateText(rate: Rate | null) {
  return rate ? rate.raw : '—';
}

function computeBase(c: Ctx): Line {
  const { line, input, rules } = c;
  let rate = line.general;
  let program: string | null = null;
  let why = 'Normal (column 1 general) duty rate.';
  let cite = `HTS ${line.code}, column 1 general`;

  if (rules.groups.column2.includes(input.origin)) {
    rate = line.other;
    why = 'Column 2 rate: the origin country is denied normal trade relations (GN 3(b)).';
    cite = `HTS ${line.code}, column 2`;
    // Russia note 30: 35% / 70% in lieu of column 2 for listed goods (L229606)
    const r30 = rules.n30.origin.includes(input.origin) ? rules.n30.measures.find((m) => c.idx.has(m.list, input.hts)) : undefined;
    if (r30) {
      rate = { kind: 'adv', parts: [{ type: 'adv', pct: r30.pct }], raw: `${r30.pct}%` };
      why = `Russia: ${r30.pct}% under ${r30.heading} replaces the column 2 rate for this product.`;
      cite = `HTS ch.99 note 30; heading ${r30.heading}`;
    }
  } else if (input.claim) {
    const claim = input.claim;
    const prog = rules.programs[claim];
    // "See 9908.04.10 (IL)" is a pointer to a quota line, not a rate
    const match = line.special.find((s) => (s.program === claim || s.program.replace(/[*+]$/, '') === claim) && !/^see /i.test(s.rate?.raw ?? ''));
    if (!prog || !prog.in_force) {
      c.notes.push(`Claim ${claim} ignored: that program is not in force.`);
    } else if (!(prog.countries.includes(input.origin) || (prog.countries.includes('*COL1') && !rules.groups.column2.includes(input.origin)))) {
      c.notes.push(`Claim ${claim} ignored: ${input.origin} is not an eligible country for ${prog.name}.`);
    } else if ((!match || !match.rate) && line.special.length > 0
      && !(rules.trq.pointers[line.code] ?? rules.trq.pointers[line.code.slice(0, 10)] ?? []).some((x) => x.program.replace(/[*+]$/, '') === claim)) {
      // The line lists special programs, but not this one: the goods don't qualify for it here.
      c.notes.push(`Claim ${claim} ignored: this line has no ${claim} rate.`);
    } else if (!match || !match.rate) {
      // No special rate printed (often because the general rate is already Free): the claim still
      // counts for the rules that key on it (USMCA content rules, MPF exemption, note 52 carve-outs).
      program = claim;
      why = `Normal (column 1 general) rate; ${prog.name} claimed for the rules that depend on it.`;
      // "See 99xx.xx (X)": a trade-agreement quota. Quota fill is unknown to us, so default to over-quota (general rate).
      const ptr = (rules.trq.pointers[line.code] ?? rules.trq.pointers[line.code.slice(0, 10)] ?? [])
        .find((x) => x.program.replace(/[*+]$/, '') === claim);
      if (ptr) {
        const q = ask(c, { id: 'ftaInQuota', kind: 'yesno', defaultValue: false,
          text: `Is this shipment within the ${prog.name} quota (${ptr.headings[0]})?`,
          why: 'In-quota goods pay the agreement rate; over-quota goods pay the normal rate. Quota fill changes daily at CBP.' });
        const raw = (rules.trq.lines[ptr.headings[0]] ?? '').replace(/\s*\([A-Z+*, ]+\)\s*$/, '').trim();
        if (q.value && raw) {
          rate = /^free$/i.test(raw) ? { kind: 'free', parts: [], raw: 'Free' } : { kind: 'text', parts: [], raw };
          why = `In-quota rate under ${prog.name} (quota line ${ptr.headings[0]}).`;
          c.quotaHeading = ptr.headings[0];
          cite = `HTS ${ptr.headings[0]}`;
        } else why = `Over the ${prog.name} quota (or quota not confirmed): normal rate applies.`;
      }
    } else {
      rate = match.rate;
      program = claim;
      why = `Special rate claimed under ${prog.name} (origin rules must be met).`;
      cite = `HTS ${line.code}, column 1 special (${match.program})`;
    }
  }

  let amount = 0;
  if (!rate || rate.kind === 'free' || rate.kind === 'nochange') amount = 0;
  else if (rate.kind === 'text') {
    const r = componentAmount(c, rate.raw);
    if (r === null) c.notes.push(`The base rate "${rate.raw}" isn't computed automatically; check it for your product.`);
    else if ('refer' in r) c.notes.unshift(r.refer);
    else amount = r.amount;
  } else amount = rateAmount(c, rate).amount;

  c.base = { amount: cents(amount), avePct: input.value > 0 ? (amount / input.value) * 100 : 0, rateText: rateText(rate), program };
  return { family: 'base', heading: line.code, label: 'Base duty', rate: rate?.kind === 'free' ? 'Free' : rateText(rate),
    amount: cents(amount), why, cite };
}

// ---------------------------------------------------------------- Section 232

interface S232 { lines: Line[]; blocksCountry: boolean }

/** UK / Japan / Taiwan civil-aircraft carve-outs from the metals headings (note 35), when the use is claimed. */
function civilAircraftCarveOut(c: Ctx): string | null {
  const lists: Record<string, [string, string]> = { GB: ['s232:n35_a_uk_aircraft', '9903.96.01'], JP: ['s232:n35_b_jp_aircraft', '9903.96.02'],
    TW: ['s232:n35_c_tw_aircraft', '9903.96.03'] };
  const l = lists[c.input.origin];
  if (!l || !c.idx.has(l[0], c.input.hts)) return null;
  return ask(c, { ...aircraftQ, defaultValue: civilDefault(c) }).value ? l[1] : null;
}

function allIn(c: Ctx, target: number): { pct: number; amount: number } {
  const extra = Math.max(0, target - c.base.avePct);
  return { pct: extra, amount: (c.input.value * extra) / 100 };
}

function add232(heading: string, label: string, pct: number, value: number, why: string, cite: string, extra?: Partial<Line>): Line {
  return { family: 's232', heading, label, rate: `+${fmtPct(pct)}`, amount: cents((value * pct) / 100), why, cite, ...extra };
}

function allInLine(c: Ctx, heading: string, label: string, target: number, cite: string, extra?: Partial<Line>): Line {
  const r = allIn(c, target);
  return { family: 's232', heading, label, rate: `${fmtPct(target)} all-in (+${fmtPct(Number(r.pct.toFixed(4)))})`, amount: cents(r.amount),
    why: `Total duty is set to ${fmtPct(target)}: the base rate (${fmtPct(Number(c.base.avePct.toFixed(4)))}) is topped up by ${fmtPct(Number(r.pct.toFixed(4)))}.`,
    cite, ...extra };
}

/** 33(g) / 38(i): the parts duty is "subject to a manufacturer's import adjustment offset amount" set by Commerce
 *  (Procl. 10925 autos, 10984 trucks). The importer applies its own offset dollars; we reduce that line by them. */
function applyOffset(c: Ctx, l: Line | undefined, procl: string) {
  if (!l || !(l.amount > 0)) return;
  const q = ask(c, { id: 'autoOffset', kind: 'number', money: true, defaultValue: 0,
    text: 'Import adjustment offset you will apply to this line (USD)?',
    why: `Vehicle makers with a Commerce offset (${procl}) can reduce the Section 232 parts duty; leave 0 if you have none.` });
  const off = Math.min(q.value, l.amount);
  if (off > 0) { l.amount = cents(l.amount - off); l.why += ` Reduced by a $${off.toLocaleString('en-US')} import adjustment offset (${procl}).`; }
}

export const CHIP_NOTICE = 'Chip tariff not applied: we assumed no advanced AI chip. If this contains a logic chip in the note 39 performance window (e.g. AI accelerators or servers built on them), answer Yes: +25% under 9903.79.01.';

function section232(c: Ctx): S232 {
  const { input, idx, line } = c;
  const h = input.hts;
  const o = input.origin;
  const usmca = c.base.program === 'S' || c.base.program === 'S+';
  const eu = isEU(c.rules, o);
  const deal = eu || DEAL_15.has(o);

  const lines: Line[] = [];
  let blocks = false;

  // 1. Semiconductors (note 39). Every code on the list files one of 9903.79.01–.09, even at 0%.
  if (idx.has('s232:n39_b_semis', h)) {
    const q = ask(c, { id: 'chipQualifies', kind: 'yesno', defaultValue: false, // Defaults B: lopsided no (Census Aug 2026: ~2.3% of $46B of listed computer value paid it)
      text: 'Does it contain a logic chip in the note 39 performance window?',
      why: 'Qualifying semiconductors pay +25% under Section 232 unless a US end use applies; others pay nothing extra.' });
    const cite = 'HTS ch.99 note 39; L231833–231955';
    if (!q.value) {
      lines.push(add232('9903.79.02', 'Section 232 semiconductors (not covered)', 0, input.value, 'Does not meet the note 39(b) technical test.', cite,
        q.assumed ? { assumed: 'no qualifying AI chip' } : {}));
      // Zac 2026-10-29: keep the default "no" (real data) but say so plainly
      if (q.assumed) c.notes.unshift(CHIP_NOTICE);
    }
    else {
      const use = ask(c, { id: 'chipUse', kind: 'choice', defaultValue: 'none',
        options: [{ value: 'none', label: 'None of these' }, { value: '9903.79.03', label: 'US data center (>100 MW new AI load)' },
          { value: '9903.79.04', label: 'US repairs or replacements' }, { value: '9903.79.05', label: 'US research and development' },
          { value: '9903.79.06', label: 'US startup (emerging growth company)' }, { value: '9903.79.07', label: 'US consumer electronics, gaming, PC, automotive' },
          { value: '9903.79.08', label: 'US civil industrial use' }, { value: '9903.79.09', label: 'US public sector' }],
        text: 'Is the chip for one of these US end uses?', why: 'Chips for these US end uses are exempt from the +25% but file their own heading.' });
      if (use.value !== 'none') lines.push(add232(String(use.value), 'Section 232 semiconductors (US end use)', 0, input.value, 'Exempt US end use under note 39(d).', cite));
      else return { blocksCountry: true, lines: [add232('9903.79.01', 'Section 232 semiconductors', 25, input.value,
        'Advanced computing chips covered by the 2026 semiconductor action.', 'HTS ch.99 note 39(b); L231833–231919',
        q.assumed ? { assumed: 'chip qualifies' } : {})] };
    }
  }

  // 2. Pharmaceuticals (note 40)
  if (idx.has('s232:n40_c_pharma', h)) {
    const q = ask(c, { id: 'pharmaType', kind: 'choice', defaultValue: 'generic', // most imports under these codes are generics; the stake shows the patented cost
      options: [{ value: 'patented', label: 'Patented drug or its ingredient' }, { value: 'generic', label: 'Generic' },
        { value: 'clinical', label: 'Only for clinical trials' }, { value: 'other_pharma', label: 'Drug, neither patented nor generic' },
        { value: 'not_pharma', label: 'Not a pharmaceutical' }],
      text: 'Is this a patented pharmaceutical, a generic, or not a pharmaceutical?',
      why: 'Patented drugs pay up to 100% under Section 232; generics pay nothing extra.' });
    const assumed = q.assumed ? { assumed: 'patented pharmaceutical' } : {};
    const cite = 'HTS ch.99 note 40; L231959–232103';
    // every code on the 40(c) list files exactly one of 9903.04.60–.70, even when nothing is added (40(a), L231959–231964)
    const free: Record<string, [string, string]> = { generic: ['9903.04.67', 'Generic pharmaceutical: no additional duty.'],
      clinical: ['9903.04.70', 'Solely for use in clinical trials: no additional duty.'],
      other_pharma: ['9903.04.69', 'Neither patented nor generic (40(i)): no additional duty.'],
      not_pharma: ['9903.04.69', 'Not a pharmaceutical article (40(i)): no additional duty.'] };
    if (free[String(q.value)]) lines.push(add232(free[String(q.value)][0], 'Section 232 pharmaceuticals (not covered)', 0, input.value, free[String(q.value)][1], cite));
    if (q.value === 'patented') {
      if (o === 'GB') return { blocksCountry: true, lines: [...lines, add232('9903.04.63', 'Section 232 pharmaceuticals (UK)', 0, input.value,
        'UK patented pharmaceuticals: no additional duty.', cite, assumed)] };
      if (eu || ['JP', 'KR', 'CH', 'LI'].includes(o))
        return { blocksCountry: true, lines: [...lines, allInLine(c, '9903.04.62', 'Section 232 pharmaceuticals (deal rate)', 15, cite, assumed)] };
      return { blocksCountry: true, lines: [...lines, allInLine(c, '9903.04.60', 'Section 232 patented pharmaceuticals', 100, cite, assumed)] };
    }
  }

  // 3. Drones (note 43) — not a country-measure carve-out, so it does not block them.
  // (c)(3) "with thermal imaging" and (c)(4) "without" list the same codes, so thermal must be asked (L232281–232288)
  const always100 = ['s232:n43_c1_uas', 's232:n43_c2_uas_parts'].some((l) => idx.has(l, h));
  const thermalSplit = idx.has('s232:n43_c3_uas_thermal', h) || idx.has('s232:n43_c4_uas_nonthermal', h);
  if (always100 || thermalSplit) {
    const q = ask(c, { id: 'droneUse', kind: 'yesno', defaultValue: line.digits.startsWith('8806') /* Defaults B (Zac 2026-10-29): parts default to aircraft use */, text: 'Is this a drone (UAS) or a part for one?',
      why: 'Drones pay +25% to +100% under the 2026 drone action; the same codes used for other things do not.' });
    const thermal = !always100 && q.value ? ask(c, { id: 'droneThermal', kind: 'yesno', defaultValue: false,
      text: 'Does the drone have a thermal-imaging camera?', why: 'Thermal drones pay +100%; others +25%.' }).value : false;
    const droneList = always100 || thermal ? 100 : 25;
    if (q.value) {
      const cite = 'HTS ch.99 note 43; L232245–232299';
      const assumed = q.assumed ? { assumed: 'it is for a drone' } : {};
      if (o === 'GB') lines.push(add232('9903.08.23', 'Drones (UK)', 10, input.value, 'UK drones meeting the components test.', cite,
        { ...assumed, interpretation: 'Assumes substantially all critical components come from allied countries.' }));
      else if (deal) lines.push(allInLine(c, '9903.08.24', 'Drones (deal rate)', 15, cite,
        { ...assumed, interpretation: 'Assumes the allied-components test is met.' }));
      else lines.push(add232(droneList === 100 ? '9903.08.21' : '9903.08.22', 'Drones', droneList, input.value,
        droneList === 100 ? 'Drones, docking stations, thermal drones and large-drone parts.' : 'Drones without thermal imaging.', cite, assumed));
    } else lines.push(add232('9903.08.20', 'Drones (not for drone use)', 0, input.value, 'Not a drone or for use with one: no drone tariff.', 'HTS ch.99 note 43(c); 9903.08.20'));
  }

  // 4–5. Vehicles and vehicle parts (notes 33, 38) — block metals, wood and country measures.
  const usContent = () => {
    const q = ask(c, { id: 'usContent', kind: 'number', money: true, defaultValue: 0, text: 'Value of approved US content (USD)?',
      why: 'For USMCA vehicles the 25% applies only to the non-US content.' });
    return Math.min(q.value, input.value);
  };
  const vehCite = 'HTS ch.99 note 33; L230602–231249';
  const oldVehicle = () => ask(c, { id: 'oldVehicle', kind: 'yesno', defaultValue: false,
    text: 'Was the vehicle made 25 or more years ago?', why: 'Vehicles 25+ years old are outside the Section 232 vehicle tariff.' }).value;
  const onCar = idx.has('s232:n33_b_vehicles', h), onTruck = idx.has('s232:n38_b_mhdv', h);
  // 25+ year old vehicles: each list the code is on files its own 25-year heading. They are outside the vehicle duties, and
  // the metals carve-out only covers vehicles paying them (33(f), 38(a)), so metals and country measures still apply below.
  const old = (onCar || onTruck) && oldVehicle();
  if (old) {
    if (onCar) lines.push(add232('9903.94.04', 'Section 232 vehicles (25+ years old)', 0, input.value, 'Vehicles made 25 or more years ago are outside the vehicle tariff.', vehCite));
    if (onTruck) lines.push(add232('9903.74.07', 'Section 232 trucks (25+ years old)', 0, input.value, 'Vehicles made 25 or more years ago are outside the truck tariff.', 'HTS ch.99 note 38; L231714–231716'));
    if (idx.has('s232:n33_g_parts', h)) lines.push(add232('9903.94.06', 'Section 232 auto parts (not a vehicle part)', 0, input.value, 'A 25+ year old vehicle, not a car part.', vehCite));
  }
  const mhdvQ = () => ask(c, { id: 'isMhdv', kind: 'yesno', defaultValue: true,
    text: 'Is this a medium- or heavy-duty road vehicle (truck, road tractor, truck chassis)?',
    why: 'Road trucks pay 25%; works trucks, airport tugs and off-highway dumpers under the same codes do not.' }).value;
  // 8704.60 is on both lists: a medium/heavy truck goes to note 38, a light truck to note 33 plus 9903.74.05
  const carVehicle = !old && onCar && !(onTruck && mhdvQ());
  if (carVehicle && onTruck)
    lines.push(add232('9903.74.05', 'Section 232 trucks (not medium/heavy)', 0, input.value, 'A passenger vehicle or light truck, not a medium/heavy vehicle.', 'HTS ch.99 note 38(e); L231708–231709'));
  if (carVehicle) {
    blocks = true;
    if (o === 'GB' && idx.has('s232:n33_i_uk_vehicles', h)) {
      const q = ask(c, { id: 'ukQuota', kind: 'yesno', defaultValue: true, text: 'Is this car within the UK vehicle quota?',
        why: 'UK cars in quota pay +7.5%; over quota +25%.' });
      lines.push(q.value
        ? add232('9903.94.31', 'Section 232 autos (UK quota)', 7.5, input.value, 'UK passenger vehicles within the 100,000-a-year quota.', vehCite, q.assumed ? { assumed: 'in quota' } : {})
        : add232('9903.94.01', 'Section 232 autos', 25, input.value, 'Passenger vehicles and light trucks.', vehCite));
    } else if (o === 'JP' || eu || o === 'KR') {
      const [hi, lo] = o === 'JP' ? ['9903.94.40', '9903.94.41'] : o === 'KR' ? ['9903.94.60', '9903.94.61'] : ['9903.94.50', '9903.94.51'];
      lines.push(c.base.avePct >= 15
        ? add232(hi, 'Section 232 autos (deal rate)', 0, input.value, 'Base rate is already at least 15%: nothing added.', vehCite)
        : allInLine(c, lo, 'Section 232 autos (deal rate)', 15, vehCite));
    } else if (usmca) {
      const us = usContent();
      lines.push(add232('9903.94.03', 'Section 232 autos (USMCA, non-US content)', 25, input.value - us,
        '25% applies only to the non-US content of a USMCA vehicle.', vehCite, { basisValue: cents(input.value - us) }));
      // the US content is filed on its own heading (33(c), L230658–230667)
      if (us > 0) lines.push(add232('9903.94.02', 'Section 232 autos (USMCA, US content)', 0, us, 'Approved US content: no additional duty.', vehCite, { basisValue: cents(us) }));
    } else lines.push(add232('9903.94.01', 'Section 232 autos', 25, input.value, 'Passenger vehicles and light trucks.', vehCite));
    return { lines, blocksCountry: true };
  }
  // 33(g)/38(i) list whole subheadings (8471 computers, 8507 batteries, 8501 motors…); only actual vehicle parts pay.
  // Others go to 9903.94.06 / 9903.74.11 and stay subject to metals and country measures (33(h)(ii) L230788–230795).
  const isVehChapter = line.chapter === '87';
  let carPart = false;
  if (!old && idx.has('s232:n33_g_parts', h)) {
    carPart = ask(c, { id: 'vehiclePart', kind: 'yesno', defaultValue: isVehChapter,
      text: 'Is this a part for a passenger car or light truck?', why: 'Car and light-truck parts pay the 25% auto-parts tariff; the same codes used for other goods do not.' }).value;
    // report 9903.94.06 even when the code is also on 38(i): each list needs its own "not covered" heading
    if (!carPart)
      lines.push(add232('9903.94.06', 'Section 232 auto parts (not a vehicle part)', 0, input.value, 'Not a car or light-truck part: no auto-parts tariff.', vehCite));
  }
  if (carPart) {
    const deals: Record<string, [string, string]> = { JP: ['9903.94.42', '9903.94.43'], KR: ['9903.94.62', '9903.94.63'], TW: ['9903.94.66', '9903.94.67'] };
    const pair = eu ? ['9903.94.52', '9903.94.53'] : deals[o];
    if (o === 'GB' && idx.has('s232:n33_j_uk_parts', h)) lines.push(allInLine(c, '9903.94.32', 'Section 232 auto parts (UK)', 10, vehCite));
    else if (pair) lines.push(c.base.avePct >= 15
      ? add232(pair[0], 'Section 232 auto parts (deal rate)', 0, input.value, 'Base rate is already at least 15%: nothing added.', vehCite)
      : allInLine(c, pair[1], 'Section 232 auto parts (deal rate)', 15, vehCite));
    else if (usmca) lines.push(add232('9903.94.06', 'Section 232 auto parts (USMCA)', 0, input.value, 'USMCA-qualifying auto parts: no additional duty.', vehCite));
    else lines.push(add232('9903.94.05', 'Section 232 auto parts', 25, input.value, 'Auto parts on the note 33(g) list.', vehCite));
    applyOffset(c, lines[lines.length - 1], 'Proclamation 10925');
    // also on the 38(i) truck-parts list: a car part still declares the truck list's "not covered" heading
    if (idx.has('s232:n38_i_mhdv_parts', h))
      lines.push(add232('9903.74.11', 'Section 232 truck parts (not a truck part)', 0, input.value, 'A car or light-truck part, not a medium/heavy truck or bus part.', 'HTS ch.99 note 38(l); L231828–231829'));
    if (onTruck)
      lines.push(add232('9903.74.05', 'Section 232 trucks (not medium/heavy)', 0, input.value, 'A car or light-truck part, not a medium/heavy vehicle.', 'HTS ch.99 note 38(e); L231708–231709'));
    return { lines, blocksCountry: true };
  }
  const mhdvCite = 'HTS ch.99 note 38; L231631–231829';
  const isMhdv = !old && onTruck && mhdvQ();
  if (!old && onTruck && !isMhdv)
    lines.push(add232('9903.74.05', 'Section 232 trucks (not a road vehicle)', 0, input.value, 'Not a medium/heavy road vehicle: no truck tariff.', mhdvCite));
  if (isMhdv) {
    if (usmca) {
      const us = usContent();
      lines.push(add232('9903.74.03', 'Section 232 trucks (USMCA, non-US content)', 25, input.value - us,
        '25% applies only to the non-US content of a USMCA truck.', mhdvCite, { basisValue: cents(input.value - us) }));
      // the US content is filed on its own heading (38(f), L231711–231712)
      if (us > 0) lines.push(add232('9903.74.06', 'Section 232 trucks (USMCA, US content)', 0, us, 'Approved US content: no additional duty.', mhdvCite, { basisValue: cents(us) }));
    } else lines.push(add232('9903.74.01', 'Section 232 medium/heavy trucks', 25, input.value, 'Medium- and heavy-duty vehicles.', mhdvCite));
    return { lines, blocksCountry: true };
  }
  if (idx.has('s232:n38_c_buses', h)) {
    lines.push(add232('9903.74.02', 'Section 232 buses', 10, input.value, 'Buses.', mhdvCite));
    c.notes.push('Buses: whether the metals duties also apply is unclear in the text; not added.');
    return { lines, blocksCountry: true };
  }
  const truckPart = idx.has('s232:n38_i_mhdv_parts', h) && ask(c, { id: 'truckPart', kind: 'yesno', defaultValue: isVehChapter,
    text: 'Is this a part for a medium/heavy truck or bus?', why: 'Truck and bus parts pay 25%; the same codes used for other goods do not.' }).value;
  if (idx.has('s232:n38_i_mhdv_parts', h) && !truckPart)
    lines.push(add232('9903.74.11', 'Section 232 truck parts (not a truck part)', 0, input.value, 'Not a medium/heavy truck or bus part.', mhdvCite));
  if (truckPart) {
    lines.push(usmca
      ? add232('9903.74.10', 'Section 232 truck parts (USMCA)', 0, input.value, 'USMCA-qualifying truck parts: no additional duty.', mhdvCite)
      : add232('9903.74.08', 'Section 232 truck parts', 25, input.value, 'Medium/heavy truck parts on the note 38(i) list.', mhdvCite));
    applyOffset(c, lines[lines.length - 1], 'Proclamation 10984');
    return { lines, blocksCountry: true };
  }

  // 5‴. Other vehicle parts (chapter 87, not on the 33(g)/38(i) lists) pay only if certified for US vehicle making or repair
  if (isVehChapter && !['n33_g_parts', 'n38_i_mhdv_parts', 'n33_b_vehicles', 'n38_b_mhdv', 'n38_c_buses'].some((k) => idx.has(`s232:${k}`, h))) {
    const use = ask(c, { id: 'certVehicleUse', kind: 'choice', defaultValue: 'no',
      options: [{ value: 'no', label: 'No certification' }, { value: 'car', label: 'Cars / light trucks' }, { value: 'truck', label: 'Heavy trucks / buses' }],
      text: 'Will you certify to CBP that this part is for building or repairing vehicles in the US?',
      why: 'Certified vehicle parts pay the 25% vehicle-parts tariff (or a deal rate); uncertified parts don\'t.' }).value;
    const certCite = 'HTS ch.99 notes 33(p)–(r), 38(j); L231044–231164, L231805–231813';
    if (use === 'truck') return { blocksCountry: true, lines: [...lines, add232('9903.74.09', 'Section 232 truck parts (certified)', 25, input.value, 'Certified for US truck or bus making/repair.', certCite)] };
    if (use === 'car') {
      const deal15: Record<string, [string, string]> = { JP: ['9903.94.54', '9903.94.55'], KR: ['9903.94.64', '9903.94.65'], TW: ['9903.94.68', '9903.94.69'] };
      const pair = eu ? ['9903.94.44', '9903.94.45'] : deal15[o];
      const l = o === 'GB' ? allInLine(c, '9903.94.33', 'Section 232 auto parts (UK, certified)', 10, certCite)
        : pair ? (c.base.avePct >= 15 ? add232(pair[0], 'Section 232 auto parts (certified, deal rate)', 0, input.value, 'Base rate already at least 15%.', certCite)
          : allInLine(c, pair[1], 'Section 232 auto parts (certified, deal rate)', 15, certCite))
          : add232('9903.94.07', 'Section 232 auto parts (certified)', 25, input.value, 'Certified for US car or light-truck making/repair.', certCite);
      return { blocksCountry: true, lines: [...lines, l] };
    }
  }

  // 6. Metals (note 16) — full value; outside ch.72/73/74/76 only if metal ≥15% of weight.
  const L = (k: string) => idx.has(`s232:n16_c_${k}`, h);
  const groupA = ['i', 'ii', 'iii', 'iv', 'v'].filter(L);
  const groupB = ['vi', 'vii', 'viii', 'xi'].filter(L);
  const groupC = ['ix', 'x'].filter(L);
  const metCite = 'HTS ch.99 note 16(c); L210902–211280';
  if (o === 'RU' && (idx.has('s232:n19_g_aluminum', h) || ['i', 'j', 'k'].some((k) => idx.has(`s232:n19_${k}_derivative`, h)))) {
    const g = idx.has('s232:n19_g_aluminum', h);
    lines.push(add232(g ? '9903.85.67' : '9903.85.68', 'Section 232 Russian aluminum', 200, input.value,
      'Aluminum of Russian origin or smelt.', 'HTS ch.99 note 19(m); L212208–212255'));
  } else if ((groupA.length || groupB.length || groupC.length) && civilAircraftCarveOut(c)) {
    lines.push(add232(civilAircraftCarveOut(c)!, 'Section 232 metals (civil aircraft)', 0, input.value,
      'Civil-aircraft articles from this country are exempt from the metals tariff.', 'HTS ch.99 note 35; L231261–231438'));
  } else if (groupA.length || groupB.length || groupC.length) {
    let applies = true;
    let assumed: string | undefined;
    if (!['72', '73', '74', '76'].includes(line.chapter)) {
      const q = ask(c, { id: 'metalWeight15', kind: 'yesno', defaultValue: true,
        text: 'Is steel, aluminum or copper at least 15% of the product\'s weight?',
        why: 'Below 15% the metals tariff (25–50% of the full value) does not apply.' });
      applies = q.value;
      if (q.assumed) assumed = 'metal is at least 15% of weight';
    }
    if (applies) {
      blocks = true;
      // ACE wants the melt/pour (steel) and smelt/cast (aluminum) countries on these lines; they don't change the rate here
      const steel = ['iii', 'iv', 'vii', 'x', 'xi'].some(L);
      const alum = ['i', 'ii', 'vi', 'ix'].some(L);
      void [steel ? ask(c, { id: 'meltCountry', kind: 'text', defaultValue: '', text: 'Country where the steel was melted and poured (2-letter code)?',
        why: 'Required on Section 232 steel lines in ACE.' }) : null, alum ? ask(c, { id: 'smeltCountry', kind: 'text', defaultValue: '',
        text: 'Country where the aluminum was smelted and cast (2-letter code)?', why: 'Required on Section 232 aluminum lines in ACE.' }) : null];
      const ex = assumed ? { assumed } : {};
      const ukQ = () => ask(c, { id: 'ukMelt95', kind: 'yesno', defaultValue: false,
        text: 'Was at least 95% of the metal melted/poured (or smelted/cast) in the UK?', why: 'UK metal meeting this test pays half.' }).value;
      const usQ = () => ask(c, { id: 'usMelt85', kind: 'yesno', defaultValue: false,
        text: 'Was at least 85% of the metal melted/poured (or smelted/cast) in the US?', why: 'Goods made from US metal pay a lower rate.' }).value;
      if (o === 'RU') {
        if (['iii', 'iv', 'v'].some(L)) lines.push(add232('9903.82.14', 'Section 232 metals (Russia)', 50, input.value, 'Russian steel and copper articles.', metCite, ex));
        else if (L('x')) lines.push(add232('9903.82.17', 'Section 232 metals (Russia)', 25, input.value, 'Russian equipment of steel.', metCite, ex));
        else lines.push(add232('9903.82.16', 'Section 232 metals (Russia)', 25, input.value, 'Russian derivative metal articles.', metCite, ex));
      } else if (groupA.length && usmca && (L('iii') || L('i')) && ask(c, { id: 'usmcaMetalAllocation', kind: 'yesno', defaultValue: false,
        text: 'Is this Canadian/Mexican steel or aluminum covered by a Commerce allocation for US vehicle makers?',
        why: 'Allocated USMCA steel and aluminum pay 25% instead of 50%.' }).value) {
        lines.push(add232(L('iii') ? '9903.82.18' : '9903.82.19', 'Section 232 metals (USMCA allocation)', 25, input.value,
          'USMCA steel/aluminum within a Commerce-authorized quantity.', metCite, ex));
      } else if (groupA.length) {
        if (o === 'GB' && groupA.some((k) => k !== 'v') && ukQ()) lines.push(add232('9903.82.04', 'Section 232 metals (UK)', 25, input.value, 'UK-melted metal articles.', metCite, ex));
        else if (['ii', 'iv'].some(L) && usQ()) lines.push(add232('9903.82.06', 'Section 232 metals (US metal)', 10, input.value, 'Made from ≥85% US metal.', metCite, ex));
        else lines.push(add232('9903.82.02', 'Section 232 metals', 50, input.value, 'Steel, aluminum and copper articles: 50% of the full value.', metCite, ex));
      } else if (groupC.length) {
        if (c.rules.groups.column2.includes(o)) lines.push(add232('9903.82.12', 'Section 232 metals (equipment)', 25, input.value, 'Equipment from column 2 countries.', metCite, ex));
        else if (usQ()) lines.push(c.base.avePct >= 10 ? add232('9903.82.08', 'Section 232 metals (equipment, US metal)', 0, input.value, 'Base rate already at least 10%.', metCite, ex)
          : allInLine(c, '9903.82.07', 'Section 232 metals (equipment, US metal)', 10, metCite, ex));
        else lines.push(c.base.avePct >= 15 ? add232('9903.82.11', 'Section 232 metals (equipment)', 0, input.value, 'Base rate already at least 15%.', metCite, ex)
          : allInLine(c, '9903.82.10', 'Section 232 metals (agricultural/industrial equipment)', 15, metCite, ex));
      } else if (idx.has('s232:n16_g_motorcycle_candidates', h) && ask(c, { id: 'motorcycleUse', kind: 'yesno', defaultValue: false,
        text: 'Will this part be used to manufacture motorcycles in the US?', why: 'Motorcycle-making parts are exempt from the 25% metals tariff.' }).value) {
        lines.push(add232('9903.82.13', 'Section 232 metals (US motorcycle making)', 0, input.value, 'Parts for US motorcycle manufacturing: no metals tariff.', metCite));
      } else if (idx.has('s232:n16_k_parts', h) && !c.rules.groups.column2.includes(o) && ask(c, { id: 'equipmentUse', kind: 'yesno', defaultValue: false,
        text: 'Will this part be used only to make farm equipment or industrial machinery?', why: 'Parts for that equipment pay a 10–15% total instead of 25%.' }).value) {
        const us = usQ();
        const t = us ? 10 : 15;
        lines.push(c.base.avePct >= t ? add232(us ? '9903.82.24' : '9903.82.26', 'Section 232 metals (equipment parts)', 0, input.value, `Base rate already at least ${t}%.`, metCite, ex)
          : allInLine(c, us ? '9903.82.23' : '9903.82.25', 'Section 232 metals (equipment parts)', t, metCite, ex));
      } else {
        if (L('xi') && usmca) {
          const us = usContent();
          const exempt = Math.min(us, input.value * 0.4);
          lines.push(add232('9903.82.20', 'Section 232 metals (USMCA mobile equipment)', 25, input.value - exempt,
            '25% on the value above the exempt US content (up to 40% of value).', metCite, { ...ex, basisValue: cents(input.value - exempt) }));
        } else if (L('xi') && (deal || ['AR', 'EC', 'SV', 'GT', 'GB'].includes(o))) lines.push(allInLine(c, '9903.82.22', 'Section 232 metals (mobile equipment, deal rate)', 15, metCite, ex));
        else if (o === 'GB' && ['vi', 'vii'].some(L) && ukQ()) lines.push(add232('9903.82.05', 'Section 232 metals (UK)', 15, input.value, 'UK-melted derivative articles.', metCite, ex));
        else if (usQ()) lines.push(add232('9903.82.06', 'Section 232 metals (US metal)', 10, input.value, 'Made from ≥85% US metal.', metCite, ex));
        else lines.push(add232('9903.82.09', 'Section 232 metals', 25, input.value, 'Derivative steel, aluminum and copper articles: 25% of the full value.', metCite, ex));
      }
    } else {
      const anyMetal = ask(c, { id: 'anyMetal', kind: 'yesno', defaultValue: true, text: 'Does it contain any steel, aluminum or copper at all?',
        why: 'Goods with no steel, aluminum or copper file 9903.82.01; goods with some (under 15%) file 9903.82.03.' }).value;
      lines.push(anyMetal ? add232('9903.82.03', 'Section 232 metals (under 15% metal)', 0, input.value, 'Metal is under 15% of the weight: no metals tariff.', metCite, { assumed })
        : add232('9903.82.01', 'Section 232 metals (no metal)', 0, input.value, 'Contains no steel, aluminum or copper: no metals tariff.', metCite));
    }
  }

  // note the declared metal origins (or that they're missing) on the metals line
  const metal = lines.find((l) => l.family === 's232' && /^9903\.8[25]/.test(l.heading) && l.amount > 0);
  if (metal) {
    const melt = c.a.meltCountry, smelt = c.a.smeltCountry;
    const steelAsked = c.questions.some((q) => q.id === 'meltCountry'), alAsked = c.questions.some((q) => q.id === 'smeltCountry');
    const parts = [steelAsked ? `melted/poured: ${melt || '—'}` : '', alAsked ? `smelted/cast: ${smelt || '—'}` : ''].filter(Boolean);
    if (parts.length) metal.why += ` Metal origin ${parts.join(', ')}.`;
    if ((steelAsked && !melt) || (alAsked && !smelt)) metal.assumed ??= 'metal melt/smelt country not entered (ACE requires it)';
  }

  // 7. Wood (note 37)
  const woodCite = 'HTS ch.99 note 37; L231441–231629';
  if (idx.has('s232:n37_b_softwood', h)) {
    lines.push(add232('9903.76.01', 'Section 232 softwood lumber', 10, input.value, 'Softwood timber and lumber.', woodCite));
    blocks = true;
  } else if (idx.has('s232:n37_f_cabinets', h) && !idx.has('s232:n37_d_upholstered', h)
    && !ask(c, { id: 'kitchenCabinet', kind: 'yesno', defaultValue: /cabinet|vanit/i.test(`${line.desc} ${line.path}`),
      text: 'Is it a wooden kitchen cabinet or bathroom vanity (or a part of one)?',
      why: 'Only cabinets and vanities pay the 25% wood tariff; other furniture under the same code does not.' }).value) {
    lines.push(add232('9903.76.04', 'Section 232 wood (not a cabinet or vanity)', 0, input.value, 'Other wooden furniture: no wood tariff.', woodCite));
  } else if (idx.has('s232:n37_d_upholstered', h) || idx.has('s232:n37_f_cabinets', h)) {
    const furniture = idx.has('s232:n37_d_upholstered', h);
    const deals: Record<string, string> = { JP: '9903.76.21', KR: '9903.76.23', TW: '9903.76.24' };
    const dh = eu ? '9903.76.22' : deals[o];
    if (o === 'GB') lines.push(add232('9903.76.20', 'Section 232 wood products (UK)', 10, input.value, 'UK upholstered furniture and cabinets.', woodCite));
    else if (dh) lines.push(allInLine(c, dh, 'Section 232 wood products (deal rate)', 15, woodCite));
    else lines.push(add232(furniture ? '9903.76.02' : '9903.76.03', furniture ? 'Section 232 upholstered furniture' : 'Section 232 kitchen cabinets and vanities',
      25, input.value, furniture ? 'Upholstered wooden seats.' : 'Wooden kitchen cabinets, vanities and parts.', woodCite));
    blocks = true;
  }

  return { lines, blocksCountry: blocks };
}

// ---------------------------------------------------------------- country and 301 measures

function inTransit(c: Ctx, t: { loadedBefore: string; enteredBefore: string; modes: string[] }) {
  const ld = c.input.loadingDate;
  return !!ld && ld < t.loadedBefore && c.input.entryDate < t.enteredBefore && t.modes.includes(c.input.mode);
}

function section301China(c: Ctx): Line[] {
  const { input, rules, idx } = c;
  if (!rules.s301.origin.includes(input.origin)) return [];
  const d = input.entryDate;
  const hits = rules.s301.measures.filter((m) => !m.suspended && onOrAfter(d, m.from) && onOrBefore(d, m.to)
    && idx.has(m.list, input.hts) && !m.carve10.map(digitsOf).includes(digitsOf(input.hts)));
  let n20 = hits.filter((m) => m.note === '20');
  let n31 = hits.filter((m) => m.note === '31');
  const out: Line[] = [];
  const zero = (heading: string, why: string, cite: string) =>
    out.push({ family: 's301_china', heading, label: 'Section 301 China (not applied)', rate: 'exempt', amount: 0, why, cite });
  // Cranes and chassis headings cover only ship-to-shore cranes / intermodal chassis, not every crane or trailer (31(k)-(l))
  if (n31.some((m) => ['9903.92.10', '9903.91.14'].includes(m.heading))
    && !ask(c, { id: 'stsCrane', kind: 'yesno', defaultValue: false, text: 'Is this a ship-to-shore gantry crane?',
      why: 'Ship-to-shore cranes from China pay +25% (and +100% more from 10 Nov 2026); other cranes do not.' }).value) {
    n31 = n31.filter((m) => !['9903.92.10', '9903.91.14'].includes(m.heading));
    zero('9903.92.80', 'Not a ship-to-shore crane.', 'HTS ch.99 note 31(l); 9903.92.80');
  }
  if (n31.some((m) => m.heading === '9903.91.12')
    && !ask(c, { id: 'chassis', kind: 'yesno', defaultValue: false, text: 'Is this an intermodal chassis (for shipping containers)?',
      why: 'From 10 Nov 2026 Chinese intermodal chassis pay +100%; other trailers do not.' }).value) {
    n31 = n31.filter((m) => m.heading !== '9903.91.12');
    zero('9903.91.13', 'Not an intermodal chassis.', 'HTS ch.99 note 31(k)(ii); L230401');
  }
  // 9903.91.16: China-linked STS cranes under a sale contract dated before 2025-04-17, entered before 2027-04-18
  if (n31.some((m) => m.heading === '9903.91.14') && d < '2027-04-18' && ask(c, craneContractQ).value) {
    n31 = n31.filter((m) => m.heading !== '9903.91.14');
    zero('9903.91.16', 'Attested pre-17 Apr 2025 sale contract: the +100% does not apply.', 'HTS ch.99 note 31(l); 9903.91.16');
  }
  const chassis = n31.some((m) => m.heading === '9903.91.12');
  const replacing = n31.filter((m) => !['9903.91.12', '9903.91.13', '9903.92.10', '9903.91.14'].includes(m.heading));
  if (replacing.length) n20 = [];
  // Exclusions: a bare code excludes every product under it; a described item only products matching the description
  const live = rules.s301.exclusions.filter((e) => onOrAfter(d, e.from) && d <= e.to);
  const match = live.flatMap((e) => e.items.filter((it) => it.codes.some((x) => digitsOf(input.hts).startsWith(digitsOf(x)))).map((it) => ({ e, it })));
  const bare = match.find((m) => m.it.bare);
  const described = match.find((m) => !m.it.bare);
  const exHit = bare ?? (described && n20.length && ask(c, { id: 's301Exclusion', kind: 'yesno', defaultValue: false,
    text: `Does your product match this exclusion: "${described.it.text.replace(/\s+/g, ' ').trim().slice(0, 220)}"?`,
    why: `Products matching it are excluded from the Section 301 China tariff until ${described.e.to}.` }).value ? described : undefined);
  if (exHit && n20.length) {
    out.push({ family: 's301_china', heading: exHit.e.heading, label: 'Section 301 China exclusion', rate: 'excluded', amount: 0,
      why: `Covered by a product exclusion until ${exHit.e.to}.`, cite: `HTS ch.99 note 20(${exHit.e.subdivision})${exHit.it.line ? `; L${exHit.it.line}` : ''}` });
    n20 = [];
  }
  const names: Record<string, string> = { '9903.88.01': 'List 1', '9903.88.02': 'List 2', '9903.88.03': 'List 3', '9903.88.04': 'List 3',
    '9903.88.15': 'List 4A' };
  for (const m of [...n20, ...n31]) {
    out.push({ family: 's301_china', heading: m.heading, label: `Section 301 China${names[m.heading] ? ` (${names[m.heading]})` : ''}`,
      rate: `+${fmtPct(m.pct)}`, amount: cents((input.value * m.pct) / 100),
      why: m.note === '31' ? 'Section 301 increases from the 2024 review (strategic sectors).' : 'Section 301 tariffs on products of China.',
      cite: `HTS ch.99 note ${m.note}; heading ${m.heading}`,
      ...(chassis && m.note === '20' ? { interpretation: 'Chassis: List 3 kept alongside 9903.91.12 (literal reading; the text does not say whether they stack).' } : {}) });
  }
  return out;
}

function note50Brazil(c: Ctx, blocked232: boolean): Line[] {
  const { input, rules, idx } = c;
  const n = rules.n50;
  if (!n.origin.includes(input.origin) || input.entryDate < n.from) return [];
  const z = (heading: string, why: string): Line[] => [{ family: 's301_brazil', heading, label: 'Section 301 Brazil (not applied)', rate: 'exempt', amount: 0, why, cite: 'HTS ch.99 note 50' }];
  if (inTransit(c, n.inTransit)) return z(n.inTransit.heading, 'Loaded before the start date and entered within the grace period.');
  if (blocked232) return z('9903.05.07', 'Goods subject to Section 232 are exempt.');
  for (const e of n.exempt) if (idx.has(e.list, input.hts)) return z(e.heading, 'Product is on the note 50 exemption list.');
  const d50 = describedExempt(c, '50');
  if (d50) return z(d50, 'Matches a product described in the note 50 exemptions.');
  if (infoMaterial(c)) return z('9903.05.09', 'Informational materials are exempt.');
  if (idx.has('n50:iv_aircraft', input.hts) && ask(c, { ...aircraftQ, defaultValue: civilDefault(c) }).value) return z('9903.05.05', 'Civil-aircraft use claimed.');
  if (idx.has('n50:v_pharma', input.hts) && ask(c, { ...pharmaAppQ, defaultValue: c.base.program === 'K' }).value) return z('9903.05.06', 'For pharmaceutical applications.');
  return [{ family: 's301_brazil', heading: n.heading, label: 'Section 301 Brazil', rate: `+${fmtPct(n.pct)}`, amount: cents((input.value * n.pct) / 100),
    why: 'Section 301 action on Brazil (from 22 Jul 2026).', cite: 'HTS ch.99 note 50; FR Doc 2026-14542' }];
}

/** Described-product exemptions (note 52(c), per-country 52(j)(ii), note 50(iii)): ask whether the product matches. */
function describedExempt(c: Ctx, note: string): string | null {
  const d = digitsOf(c.input.hts);
  for (const it of c.rules.described) {
    if (!it.note.startsWith(note) || (it.country && it.country !== c.input.origin && !(it.country === 'EU' && isEU(c.rules, c.input.origin)))) continue;
    if (!it.hts.some((x) => d.startsWith(digitsOf(x)))) continue;
    if (it.autoNo.some((x) => d.startsWith(digitsOf(x)))) continue;
    if (it.autoYes.some((x) => d.startsWith(digitsOf(x)))) return it.heading;
    const q = ask(c, { id: `x:${it.id}` as const, kind: 'yesno', defaultValue: false, text: it.question,
      why: 'Products matching this description are exempt from this country tariff.' });
    if (q.value) return it.heading;
  }
  return null;
}

/** Informational materials (publications, films, recordings, artworks) are exempt from notes 50 and 52
 *  (9903.05.09 / 9903.05.92). Asked only where such goods are classified: ch.49, ch.97, 3704–3706, 8523. */
function infoMaterial(c: Ctx): boolean {
  const d = digitsOf(c.input.hts);
  if (!['49', '97'].includes(c.line.chapter) && !['3704', '3705', '3706', '8523'].some((p) => d.startsWith(p))) return false;
  return ask(c, { id: 'infoMaterial', kind: 'yesno', defaultValue: false,
    text: 'Is this informational material (a publication, film, recording, photograph, artwork or similar)?',
    why: 'Informational materials are exempt from this country tariff.' }).value;
}

/** Defaults B (Zac 2026-10-29, Census Aug 2026): aircraft (8802), their engines (8407.10, 8411) and parts (8803, 8807, 8409.10)
 *  entered almost entirely as civil aircraft; a C claim is that declaration too. */
const civilDefault = (c: Ctx) => c.base.program === 'C' || ['8802', '8803', '8807', '8411', '840710', '840910'].some((p) => c.line.digits.startsWith(p));
const aircraftQ = { id: 'civilAircraft' as const, kind: 'yesno' as const, defaultValue: false,
  text: 'Is this for use in civil aircraft (claimed under GN 6)?', why: 'Civil-aircraft goods are exempt from some country tariffs.' };
const pharmaAppQ = { id: 'pharmaApplication' as const, kind: 'yesno' as const, defaultValue: false,
  text: 'Is this for pharmaceutical applications?', why: 'Listed goods for pharmaceutical use are exempt from some country tariffs.' };

function note52(c: Ctx, blocked232: boolean): Line[] {
  const { input, rules, idx } = c;
  const n = rules.n52;
  const k = n.countries[input.origin];
  // Russia's row (9903.05.66, L239778) also charges on the column 2 rate, so column 2 is no exemption.
  if (!k || input.entryDate < n.from) return [];
  const cafta = c.base.program === 'P' || c.base.program === 'P+';
  const label = 'Section 301 forced-labor tariff';
  const z = (heading: string, why: string): Line[] => [{ family: 's301_forced_labor', heading, label: `${label} (not applied)`, rate: 'exempt', amount: 0, why, cite: 'HTS ch.99 note 52' }];
  if (inTransit(c, n.inTransit)) return z(n.inTransit.heading, 'Loaded before 24 Jul 2026 and entered by 27 Jul 2026.');
  if (blocked232) return z('9903.05.90', 'Goods subject to Section 232 are exempt.');
  if (k.usmcaExempt && (c.base.program === 'S' || c.base.program === 'S+'))
    return z(input.origin === 'CA' ? '9903.05.93' : '9903.05.94', 'USMCA duty-free goods are exempt.');
  // 52(i): CAFTA-DR duty-free textile and apparel goods (chapters 50–63) of the six CAFTA-DR countries (L234057–234061)
  if (cafta && ['CR', 'DO', 'SV', 'GT', 'HN', 'NI'].includes(input.origin) && Number(c.line.chapter) >= 50 && Number(c.line.chapter) <= 63)
    return z('9903.05.95', 'CAFTA-DR duty-free textiles and apparel are exempt.');
  if (idx.has('n52:b', input.hts)) return z('9903.05.86', 'Product is on the note 52(b) exemption list.');
  const d52 = describedExempt(c, '52');
  if (d52) return z(d52, 'Matches a product described in the note 52 exemptions.');
  for (const e of k.exempt) {
    if (!idx.has(e.list, input.hts)) continue;
    if (/CAFTA-DR-claimed/i.test(e.text) && !cafta) continue; // these lists need a CAFTA-DR claim (L234282–234285)
    return z(e.heading, 'Product is on this country\'s exemption list.');
  }
  if (infoMaterial(c)) return z('9903.05.92', 'Informational materials are exempt.');
  if (idx.has('n52:d_aircraft', input.hts) && ask(c, { ...aircraftQ, defaultValue: civilDefault(c) }).value) return z('9903.05.88', 'Civil-aircraft use claimed.');
  if (idx.has('n52:e_pharma', input.hts) && ask(c, { ...pharmaAppQ, defaultValue: c.base.program === 'K' }).value) return z('9903.05.89', 'For pharmaceutical applications.');
  const cite = 'HTS ch.99 note 52; USTR action 2026-07-23; CSMS #69326983';
  if (k.rule === 'all_in' && k.target !== null) {
    if (c.base.avePct >= k.target)
      return [{ family: 's301_forced_labor', heading: k.atOrAbove!, label, rate: `${fmtPct(k.target)} all-in`, amount: 0,
        why: `Base rate is already at least ${fmtPct(k.target)}: nothing added.`, cite }];
    const r = allIn(c, k.target);
    return [{ family: 's301_forced_labor', heading: k.below!, label, rate: `${fmtPct(k.target)} all-in (+${fmtPct(Number(r.pct.toFixed(4)))})`, amount: cents(r.amount),
      why: `Total duty is set to ${fmtPct(k.target)} for this country: the base rate is topped up by ${fmtPct(Number(r.pct.toFixed(4)))}.`, cite }];
  }
  const pct = k.pct ?? 0;
  return [{ family: 's301_forced_labor', heading: k.heading!, label, rate: `+${fmtPct(pct)}`, amount: cents((input.value * pct) / 100),
    why: 'Section 301 forced-labor action on 60 economies (from 24 Jul 2026).', cite }];
}

function note51Canada(c: Ctx, blocked232: boolean): Line[] {
  const { input, rules, idx } = c;
  const n = rules.n51;
  if (!n.origin.includes(input.origin) || input.entryDate < n.from) return [];
  const z = (heading: string, why: string): Line[] => [{ family: 's338', heading, label: 'Section 338 Canada (not applied)', rate: 'exempt', amount: 0, why, cite: 'HTS ch.99 note 51' }];
  const covered = n.measures.find((m) => idx.has(m.list, input.hts));
  if (covered && idx.has('n51:16_aircraft', input.hts) && ask(c, { ...aircraftQ, defaultValue: civilDefault(c) }).value) return z('9903.03.16', 'Civil-aircraft articles are exempt.');
  for (const m of n.measures) {
    if (!idx.has(m.list, input.hts)) continue;
    if (m.blockedBy232 && blocked232) return z('9903.03.15', 'Goods subject to Section 232 are exempt.');
    return [{ family: 's338', heading: m.heading, label: 'Section 338 Canada', rate: `+${fmtPct(n.pct)}`, amount: cents((input.value * n.pct) / 100),
      why: 'Section 338 duty on listed Canadian goods. A USMCA claim does not remove it.', cite: 'HTS ch.99 note 51; CSMS #69606660, #69851916' }];
  }
  return [];
}

/** Subchapter III note 3: Japanese leather (9903.41.05) and leather footwear (9903.41.10) pay a cumulative 40%.
 *  Unshaded and not among the note 5 suspensions in Rev 21; the question shows its stake so the user can confirm scope. */
function japanLeather(c: Ctx): Line[] {
  const { input } = c;
  if (input.origin !== 'JP') return [];
  const d = digitsOf(input.hts);
  const leather = ['4104', '4107', '4105', '4112'].some((p) => d.startsWith(p)) || ['41061', '411310'].some((p) => d.startsWith(p));
  const shoes = d.startsWith('6403');
  if (!leather && !shoes) return [];
  const q = ask(c, { id: 'japanLeather', kind: 'yesno', defaultValue: true,
    text: leather ? 'Is the leather dyed, colored, stamped or embossed?'
      : 'Is it ordinary leather footwear (not indoor slip-ons with soles under 5 mm, and not spiked sports shoes, ski, skating, wrestling, boxing or cycling boots)?',
    why: 'Japanese leather and leather footwear of this kind pay an extra 40% under 9903.41.05 / 9903.41.10.' });
  if (!q.value) return [];
  const heading = leather ? '9903.41.05' : '9903.41.10';
  return [{ family: 'japan_leather', heading, label: 'Japan leather retaliation', rate: '+40%', amount: cents(input.value * 0.4),
    why: `${leather ? 'Japanese leather' : 'Japanese leather footwear'}: 40% on top of the normal duty (subch. III note 3).`, cite: `HTS ch.99 ${heading}; subch. III notes 3, 5`,
    ...(q.assumed ? { assumed: leather ? 'leather is dyed/colored/stamped/embossed' : 'footwear is not an excluded type' } : {}),
    interpretation: 'In force per HTS Rev 21 text (unshaded, not suspended by note 5); no recent CBP guidance found either way.' }];
}

/** Note 30: listed Russian goods pay 35% (9903.90.08) or 70% (9903.90.09) in lieu of column 2. The rate is charged on the
 *  commodity line (computeBase); the Chapter 99 number must still be filed with it. */
function russiaNote30(c: Ctx): Line[] {
  const { input, rules, idx } = c;
  const m = rules.n30.origin.includes(input.origin) ? rules.n30.measures.find((x) => idx.has(x.list, input.hts)) : undefined;
  if (!m) return [];
  return [{ family: 'russia', heading: m.heading, label: 'Russia (in lieu of column 2)', rate: `${fmtPct(m.pct)} in lieu of column 2`, amount: 0,
    why: `Filed with the commodity line, which carries the ${fmtPct(m.pct)} duty.`, cite: `HTS ch.99 note 30; heading ${m.heading}` }];
}

/** Note 29: Section 301 Nicaragua — 0% in 2026, 10% from 2027, 15% from 2028; CAFTA-DR originating goods exempt. */
function nicaragua301(c: Ctx): Line[] {
  const { input, rules } = c;
  if (!rules.nic.origin.includes(input.origin)) return [];
  const s = rules.nic.schedule.find((x) => input.entryDate >= x.from && (!x.to || input.entryDate <= x.to));
  if (!s) return [];
  // 29(a): applies to goods under column 1-general only; CAFTA-DR (or any other preference) claims are outside it, with no heading
  if (c.base.program) return [];
  // filed even while the rate is 0% (2026): the heading is in force at "+0%"
  return [{ family: 's301_nicaragua', heading: rules.nic.heading, label: 'Section 301 Nicaragua', rate: `+${fmtPct(s.pct)}`,
    amount: cents((input.value * s.pct) / 100), why: s.pct ? 'Section 301 action on Nicaragua, phased in from 2027.' : 'Section 301 action on Nicaragua: 0% in 2026, 10% in 2027, 15% from 2028.',
    cite: 'HTS ch.99 note 29; L229567–229604' }];
}

/** Ch.99 subchapter IV: price-based agricultural safeguards — extra duty when the unit value is below a trigger. */
function agSafeguard(c: Ctx): Line[] {
  const { input, rules } = c;
  if (rules.sg.exempt.includes(input.origin)) return [];
  const d = digitsOf(input.hts);
  const group = rules.sg.brackets.filter((b) => b.codes.some((x) => d.startsWith(digitsOf(x))));
  if (!group.length) return [];
  const unit = group[0].unit;
  const { qty, known } = unitQty(c, unit);
  if (!known || qty <= 0) return [];
  const uv = input.value / qty;
  const b = group.find((x) => uv >= x.min && uv < x.max);
  if (!b || !b.usd) return [];
  return [{ family: 's201', heading: b.heading, label: 'Agricultural safeguard', rate: `+$${b.usd}/${unit}`, amount: cents(b.usd * qty),
    why: `Unit value $${uv.toFixed(2)}/${unit} is below the trigger price, so a safeguard duty applies.`, cite: 'HTS ch.99 subchapter IV, U.S. notes 1–3' }];
}

const craneContractQ = { id: 'craneOldContract' as const, kind: 'yesno' as const, defaultValue: false,
  text: 'Is the crane delivered under a sale contract signed before 17 April 2025?',
  why: 'Cranes under contracts signed before 17 Apr 2025 and entered before 18 Apr 2027 are exempt from the +100% (9903.91.16).' };

/** 9903.91.14: ship-to-shore cranes from outside China with Chinese key components or a China-linked maker (from 2026-11-10). */
function craneChinaLink(c: Ctx): Line[] {
  const { input } = c;
  if (input.origin === 'CN' || !digitsOf(input.hts).startsWith('84261900') || input.entryDate < '2026-11-10') return [];
  if (!ask(c, { id: 'stsCrane', kind: 'yesno', defaultValue: false, text: 'Is this a ship-to-shore gantry crane?',
    why: 'Ship-to-shore cranes with Chinese key parts or a China-linked maker pay +100% from 10 Nov 2026.' }).value) return [];
  const z = (heading: string, why: string): Line[] => [{ family: 's301_china', heading, label: 'Section 301 ship-to-shore cranes (not applied)',
    rate: 'exempt', amount: 0, why, cite: `HTS ch.99 note 31(l); ${heading}` }];
  if (!ask(c, { id: 'chineseCraneLink', kind: 'yesno', defaultValue: false,
    text: 'Does it contain a Chinese-made boom, trolley, spreader, cabin, legs, power supply or control system, or is the maker China-owned or controlled?',
    why: 'If yes, the crane pays +100% under Section 301 even though it was made outside China.' }).value)
    return z('9903.91.15', 'Importer attests no Chinese origin, components or ownership.');
  if (input.entryDate < '2027-04-18' && ask(c, craneContractQ).value) return z('9903.91.16', 'Attested pre-17 Apr 2025 sale contract: the +100% does not apply.');
  return [{ family: 's301_china', heading: '9903.91.14', label: 'Section 301 ship-to-shore cranes (China link)', rate: '+100%',
    amount: cents(input.value), why: 'Crane with Chinese key components or a China-linked maker.', cite: 'HTS ch.99 note 31(l); 9903.91.14' }];
}

/** Note 41: Section 201 safeguard on quartz surface products (countertops, slabs), from 2026-08-15. */
function quartzSafeguard(c: Ctx): Line[] {
  const { input, rules, idx } = c;
  const n = rules.n41;
  if (!idx.has(n.list, input.hts) || n.exempt.includes(input.origin)) return [];
  const yr = [...n.years].reverse().find((y) => input.entryDate >= y.from);
  if (!yr || input.entryDate > n.to) return [];
  const q = ask(c, { id: 'quartzInQuota', kind: 'yesno', defaultValue: false, // quota fill is unknown: never under-charge
    text: 'Is this shipment within the quartz safeguard quota?',
    why: `Within the quarterly quota the safeguard is ${yr.in}%; over it, ${yr.over}%.` });
  const pct = q.value ? yr.in : yr.over;
  return [{ family: 's201', heading: q.value ? '9903.45.30' : '9903.45.31', label: `Section 201 quartz safeguard (${q.value ? 'in quota' : 'over quota'})`,
    rate: `+${fmtPct(pct)}`, amount: cents((input.value * pct) / 100), why: 'Safeguard on quartz surface products such as countertops and slabs.',
    cite: 'HTS ch.99 note 41; L232105–232243', ...(q.assumed ? { assumed: q.value ? 'within the quota' : 'over the quota' } : {}) }];
}

/** Codes split by unit value ("Valued over $1.05/liter"): warn when the entered value and quantity don't fit the bracket. */
function valueBracketCheck(c: Ctx) {
  const text = `${c.line.path} > ${c.line.desc}`;
  const m = [...text.matchAll(/valued (not over|over) \$([\d.]+)\s*(?:\/|per)\s*([a-z.]+)/gi)].at(-1);
  if (!m) return;
  const map = unitMap(c.line.units, m[3]);
  const qty = map ? (map.i === 0 ? c.input.quantity : c.input.quantity2) : undefined;
  if (!map || !qty) return;
  const uv = c.input.value / (qty * map.factor);
  const lim = Number(m[2]);
  const fits = /not/i.test(m[1]) ? uv <= lim : uv > lim;
  if (!fits) c.notes.unshift(`Check the code: it's for goods valued ${m[1].toLowerCase()} $${lim}/${m[3]}, but yours work out to $${uv.toFixed(2)}/${m[3]}.`);
}

// ---------------------------------------------------------------- fees and other charges

function fees(c: Ctx, formal: boolean): Line[] {
  const { input } = c;
  const out: Line[] = [];
  const program = c.base.program;
  const fy = [...MPF].reverse().find((f) => input.entryDate >= f.from) ?? MPF[0];
  if (input.mode === 'mail' && !formal) {
    out.push({ family: 'fee', heading: 'MPF', label: 'Merchandise processing fee', rate: 'none', amount: 0,
      why: 'Mail shipments of $2,500 or less clear on a postal informal entry with no processing fee.', cite: '19 CFR 24.23(c); references/postal.md' });
  } else if (program && MPF_EXEMPT.has(program)) {
    out.push({ family: 'fee', heading: 'MPF', label: 'Merchandise processing fee', rate: 'exempt', amount: 0,
      why: `Exempt for goods claimed under ${c.rules.programs[program]?.name ?? program}.`, cite: '19 U.S.C. 58c(b); 19 CFR 24.23(c)' });
  } else if (!formal) {
    out.push({ family: 'fee', heading: 'MPF', label: 'Merchandise processing fee (informal entry)', rate: 'flat', amount: fy.informal,
      why: 'Shipments of $2,500 or less can use an informal entry with a flat fee.', cite: '19 CFR 24.23(b)(2)' });
  } else {
    const raw = input.value * MPF_RATE;
    const amt = Math.min(fy.max, Math.max(fy.min, raw));
    out.push({ family: 'fee', heading: 'MPF', label: 'Merchandise processing fee', rate: '0.3464%', amount: cents(amt),
      why: raw < fy.min ? `Raised to the minimum of $${fy.min}.` : raw > fy.max ? `Capped at the maximum of $${fy.max}.` : `0.3464% of value (min $${fy.min}, max $${fy.max}).`,
      cite: '19 CFR 24.23(b)(1); CBP Dec. 26-14' });
  }
  // Cotton Board assessment: formal entries of goods in the 7 CFR 1205.510 table (cents per kg of the article)
  const cot = c.rules.cotton[c.line.digits];
  if (cot && formal) {
    const exempt = ask(c, { id: 'x:cotton_exempt', kind: 'yesno', defaultValue: false,
      text: 'Is this exempt from the Cotton Board fee (no cotton content, certified organic, or you hold an exemption number)?',
      why: 'Cotton goods pay a small research-and-promotion assessment by weight.' }).value;
    if (!exempt) {
      const kgIdx = c.line.units.findIndex((u) => u.toLowerCase() === 'kg');
      const kg = kgIdx === 0 ? input.quantity : kgIdx === 1 ? input.quantity2 : undefined;
      const w = kg ?? ask(c, { id: 'comp:net_kg', kind: 'number', defaultValue: 0, text: 'Net weight in kg?', why: 'The Cotton Board fee is charged by weight.' }).value;
      out.push({ family: 'fee', heading: 'Cotton', label: 'Cotton Board assessment', rate: `${cot}¢/kg`, amount: cents((w * cot) / 100),
        why: w ? `${w} kg at ${cot}¢ per kg.` : 'Enter the net weight to compute this small fee.', cite: '7 CFR 1205.510(b)',
        ...(w ? {} : { assumed: 'net weight not entered yet' }) });
    }
  }
  // Federal excise tax on alcohol and tobacco (collected by CBP at entry)
  const unitIdx = (u: string) => c.line.units.findIndex((x) => x.toLowerCase() === u);
  const q = (i: number) => (i === 0 ? input.quantity : i === 1 ? input.quantity2 : undefined);
  const li = unitIdx('liters');
  if (li >= 0 && q(li) === undefined && /^22(03|04|05|06|07|08)/.test(c.line.digits)) {
    // volume comes from the line's own quantity: ask for it once (the base rate may already have)
    if (!c.questions.some((x) => x.id === (li === 1 ? 'quantity2' : 'quantity')))
      c.questions.push({ id: li === 1 ? 'quantity2' : 'quantity', kind: 'number', defaultValue: 0, text: 'How many liters?', why: 'Federal excise tax on alcohol is charged by volume.' });
    out.push({ family: 'tax', heading: 'Excise', label: 'Federal excise tax', rate: 'by volume', amount: 0,
      why: 'Enter the quantity in liters to compute the excise tax.', cite: '26 U.S.C. 5001, 5041, 5051', assumed: 'quantity not entered yet' });
  } else {
    const ex = excise(input.hts, (qq) => ask(c, qq as Parameters<typeof ask>[1]).value as number | boolean, q(li), q(unitIdx('kg')),
      q(c.line.units.findIndex((x) => /^pf\.?\s*liters?$/i.test(x))), q(c.line.units.findIndex((x) => /^thousands?$/i.test(x))));
    if (ex) out.push({ family: 'tax', heading: 'Excise', label: ex.label, rate: ex.rate, amount: cents(ex.amount), why: ex.why, cite: ex.cite });
  }
  if (input.mode === 'ocean' && formal) {
    const hmf = cents(input.value * HMF_RATE);
    out.push({ family: 'fee', heading: 'HMF', label: 'Harbor maintenance fee', rate: '0.125%', amount: hmf,
      why: 'Charged on cargo arriving by ship.', cite: '19 CFR 24.24' });
  }
  return out;
}

/** Anti-dumping / countervailing orders whose scope lists this HTS for this origin (rates are per exporter). */
function adcvdOrders(c: Ctx) {
  const d = c.line.digits;
  return c.rules.adcvd.filter((o) => o.country === c.input.origin && o.hts.some((h) => d.startsWith(h) || h.startsWith(d)))
    .map((o) => ({ case: o.case, type: o.type, product: o.product, url: o.fr ? `https://www.federalregister.gov/d/${o.fr}` : null,
      // only a 4–6 digit scope code matched: probably a different product under the same heading
      broad: !o.hts.some((h) => h.length >= 8 && (d.startsWith(h) || h.startsWith(d))) }));
}

// ---------------------------------------------------------------- main

// CBP filing order (CSMS #69326983): additional duties, then 301 -> 122 -> 232 -> 201, commodity line last
const ORDER: Record<string, number> = { s338: 0, s301_china: 1, s301_brazil: 2, s301_forced_labor: 3, s301_nicaragua: 3.5, russia: 3.7, japan_leather: 3.8, quota: 3.9, s232: 4, s201: 5, ch98: 8, base: 9, adcvd: 10 };

const CH98: Record<string, string> = {
  '9801.00.10': 'US goods returned (not advanced in value)', '9802.00.50': 'Repaired or altered abroad', '9802.00.80': 'Assembled abroad from US components' };

/** Chapter 98 claims. 9801.00.10: US goods returned are free and outside every Chapter 99 duty. 9802.00.50 / 9802.00.80: every
 *  duty (base and Chapter 99) is assessed on the value of the repairs, or on the value less the US components; the notes
 *  reserve full-value assessment for 9802.00.60 only (e.g. 33(f) L230705–230707, 38(a), 29(a)). HMF stays on the full cargo value. */
export function calculate(input: Input, line: HtsLine | undefined, rules: Rules, idx = new ListIndex(rules.lists)): Result {
  const claim = input.ch98;
  if (!claim) return calculateCore(input, line, rules, idx);
  const plain = { ...input, ch98: null };
  const full = calculateCore(plain, line, rules, idx);
  if (!full.ok || !CH98[claim.provision]) return CH98[claim.provision] ? full : { ...full, ok: false, error: `Unknown Chapter 98 provision ${claim.provision}.` };
  const deduct = claim.deduct ?? 0;
  if (claim.provision !== '9801.00.10' && !(Number.isFinite(deduct) && deduct >= 0 && deduct <= input.value))
    return { ...full, ok: false, error: `Enter the ${claim.provision === '9802.00.50' ? 'value of the repairs' : 'value of the US components'} (0 to the line value).` };
  const dutiable = claim.provision === '9801.00.10' ? 0 : claim.provision === '9802.00.50' ? deduct : input.value - deduct;
  const ch98Line: Line = { family: 'ch98', heading: claim.provision, label: CH98[claim.provision],
    rate: claim.provision === '9801.00.10' ? 'Free' : `dutiable $${dutiable.toLocaleString('en-US')}`, amount: 0, basisValue: cents(dutiable),
    why: claim.provision === '9801.00.10' ? 'US goods returned without being advanced in value: free, and no Chapter 99 duties apply to US goods.'
      : claim.provision === '9802.00.50' ? 'Duty is charged only on the value of the repairs or alterations made abroad.'
        : 'Duty is charged on the full value less the value of the US-made components.',
    cite: `HTS ${claim.provision}; ch.98 subch. II notes` };
  const hmf = full.fees.find((f) => f.heading === 'HMF');
  if (dutiable <= 0) {
    const fees = full.fees.filter((f) => f.heading !== 'MPF' || f.rate === 'exempt').concat(full.fees.filter((f) => f.heading === 'MPF' && f.rate !== 'exempt').map((f) => ({ ...f,
      why: `${f.why} Check whether your Chapter 98 claim is MPF-exempt (19 CFR 24.23(c)).`, assumed: f.assumed ?? 'MPF charged on a duty-free Chapter 98 line' })));
    const base = full.lines.find((l) => l.family === 'base')!;
    const lines = [ch98Line, { ...base, rate: 'Free', amount: 0, why: `Free under ${claim.provision}.` }];
    const feesTotal = cents(fees.reduce((s, f) => s + f.amount, 0));
    return { ...full, lines, fees, duty: 0, feesTotal, total: feesTotal, effectivePct: 0, questions: [], defaults: [],
      notes: [`${claim.provision}: ${CH98[claim.provision]}. Keep the export and return documents (19 CFR 10.1).`] };
  }
  const part = calculateCore({ ...plain, value: dutiable }, line, rules, idx);
  if (!part.ok) return part;
  const fees = part.fees.map((f) => (f.heading === 'HMF' && hmf ? hmf : f));
  const feesTotal = cents(fees.reduce((s, f) => s + f.amount, 0));
  const lines = [...part.lines, ch98Line].sort((x, y) => ORDER[x.family] - ORDER[y.family]);
  return { ...part, lines, fees, feesTotal, total: cents(part.duty + feesTotal), effectivePct: Number(((part.duty / input.value) * 100).toFixed(2)),
    notes: [`${claim.provision}: duties figured on $${dutiable.toLocaleString('en-US')} of the $${input.value.toLocaleString('en-US')} value.`, ...part.notes] };
}

function calculateCore(input: Input, line: HtsLine | undefined, rules: Rules, idx: ListIndex): Result {
  const empty: Result = { ok: false, lines: [], fees: [], duty: 0, feesTotal: 0, total: 0, effectivePct: 0, questions: [], notes: [], adcvd: [], entryType: '11', defaults: [],
    revision: rules.meta.revision };
  if (!line) return { ...empty, error: `HTS ${input.hts} was not found in ${rules.meta.revision}.` };
  if (!(input.value > 0) || !Number.isFinite(input.value)) return { ...empty, line, error: 'Enter a customs value above $0.' };
  const realDate = (d: string) => {
    if (!/^\d{4}-\d\d-\d\d$/.test(d)) return false;
    const t = new Date(`${d}T00:00:00Z`);
    return Number.isFinite(t.getTime()) && t.toISOString().slice(0, 10) === d; // rejects 2026-13-45 and 2026-02-30
  };
  if (!realDate(input.entryDate)) return { ...empty, line, error: 'Enter a real entry date (YYYY-MM-DD).' };
  if (line.digits.length < 8) return { ...empty, line, error: `${line.code} is a heading, not a tariff line: pick an 8- or 10-digit code.` };
  // Ch.99 numbers are add-on duties the engine files itself; Ch.98 numbers are claimed beside the goods' own code
  // (note 52 and the other country notes treat them differently from goods), so neither can stand in for a product.
  if (line.chapter === '99') return { ...empty, line, error: `${line.code} is a Chapter 99 number (an additional duty), not a product. Enter the product's own code from chapters 1–97; its Chapter 99 numbers are added automatically.` };
  if (line.chapter === '98') return { ...empty, line, error: `${line.code} is a Chapter 98 provision, not a product. Enter the product's own code from chapters 1–97; US goods returned, repairs and US-component assembly (9801.00.10, 9802.00.50, 9802.00.80) can be claimed per line in the Entry view.` };
  if (input.loadingDate && !realDate(input.loadingDate)) return { ...empty, line, error: 'Enter a real loading date (YYYY-MM-DD).' };
  if (input.loadingDate && input.loadingDate > input.entryDate) return { ...empty, line, error: 'The loading date is after the entry date.' };
  for (const q of [input.quantity, input.quantity2]) if (q !== undefined && !(Number.isFinite(q) && q >= 0))
    return { ...empty, line, error: 'Quantities must be zero or more.' };
  for (const [k, v] of Object.entries(input.answers ?? {})) if (typeof v === 'number' && !(Number.isFinite(v) && v >= 0))
    return { ...empty, line, error: `The answer to "${k}" must be a number of zero or more.` };
  if (input.entryDate < SUPPORTED_FROM) return { ...empty, line, error: `Entries before ${SUPPORTED_FROM} aren't supported yet.` };
  if (input.entryDate > SUPPORTED_TO) return { ...empty, line, error: `Entries after ${SUPPORTED_TO} aren't supported yet: announced changes take effect then.` };

  const c: Ctx = { input, line, rules, idx, a: input.answers ?? {}, questions: [], notes: [],
    base: { amount: 0, avePct: 0, rateText: '', program: null } };
  const baseLine = computeBase(c);
  const s232 = section232(c);
  const lines = [
    ...note51Canada(c, s232.blocksCountry),
    ...section301China(c),
    ...note50Brazil(c, s232.blocksCountry),
    ...note52(c, s232.blocksCountry),
    ...s232.lines,
    ...quartzSafeguard(c),
    ...nicaragua301(c),
    ...agSafeguard(c),
    ...craneChinaLink(c),
    ...russiaNote30(c),
    ...japanLeather(c),
    ...(c.quotaHeading ? [{ family: 'quota' as const, heading: c.quotaHeading, label: 'Trade-agreement quota (in quota)', rate: 'in-quota rate', amount: 0,
      why: 'The in-quota provision is filed with the commodity line, which carries the in-quota rate.', cite: `HTS ${c.quotaHeading}` }] : []),
    baseLine,
  ].sort((x, y) => ORDER[x.family] - ORDER[y.family])
    // safety net: never charge a heading the PDF shades as expired (pipeline/shaded_headings.py)
    .filter((l) => {
      if (l.amount > 0 && l.family !== 'base' && rules.expired.includes(l.heading)) {
        c.notes.push(`${l.heading} is marked expired in the tariff schedule and was not charged.`);
        return false;
      }
      return true;
    });
  const ad = adcvdOrders(c);
  const exact = ad.filter((o) => !o.broad);
  if (exact.length) {
    // AD/CVD goods go on a formal type 03 entry; deposits use the exporter's company-specific rates
    const adPct = exact.some((o) => o.type === 'AD') ? ask(c, { id: 'adRate', kind: 'number', defaultValue: 0,
      text: `Anti-dumping cash-deposit rate for your exporter (%)? Case ${exact.filter((o) => o.type === 'AD').map((o) => o.case).join(', ')}`,
      why: 'AD deposit rates are set per producer/exporter in Commerce\'s latest results; use the "all others" rate if yours isn\'t listed.' }) : null;
    const cvdPct = exact.some((o) => o.type === 'CVD') ? ask(c, { id: 'cvdRate', kind: 'number', defaultValue: 0,
      text: `Countervailing cash-deposit rate for your exporter (%)? Case ${exact.filter((o) => o.type === 'CVD').map((o) => o.case).join(', ')}`,
      why: 'CVD deposit rates are set per producer/exporter.' }) : null;
    for (const [pct, type] of [[adPct, 'AD'], [cvdPct, 'CVD']] as const) {
      if (!pct || !(pct.value > 0)) continue; // no rate entered yet: the question and the AD/CVD card already flag it
      lines.push({ family: 'adcvd', heading: exact.filter((o) => o.type === type).map((o) => o.case).join(', '), label: `${type} cash deposit (estimate)`,
        rate: `${fmtPct(pct.value)}`, amount: cents((input.value * pct.value) / 100),
        why: `Estimated ${type} deposit at the rate you entered; final duties are set when Commerce reviews the order.`,
        cite: '19 CFR 351.402(f) (file the non-reimbursement certificate)', ...(pct.assumed ? { assumed: `${type} deposit rate not entered (0% used)` } : {}) });
    }
    c.notes.push('AD/CVD goods need a formal type 03 entry, and the importer must file the non-reimbursement certificate (19 CFR 351.402(f)).');
  }
  const formal = !!input.inEntry || input.value > 2500 || exact.length > 0;
  const feeLines = fees(c, formal);
  const entryType: Result['entryType'] = exact.length ? '03' : formal ? '01' : '11';
  valueBracketCheck(c);
  const answeredQty = (id: string) => (id === 'quantity' ? input.quantity !== undefined : id === 'quantity2' ? input.quantity2 !== undefined : c.a[id as keyof Answers] !== undefined);
  const defaults = c.questions.filter((q) => !answeredQty(q.id)).map((q) => ({ id: q.id, text: q.text, value: q.defaultValue }));

  const duty = cents(lines.reduce((s, l) => s + l.amount, 0));
  const hmf = feeLines.find((f) => f.heading === 'HMF');
  if (hmf && hmf.amount <= 3 && duty === 0 && feeLines.every((f) => f === hmf || f.amount === 0))
    Object.assign(hmf, { amount: 0, why: 'Not collected: $3 or less with nothing else due.' });
  const feesTotal = cents(feeLines.reduce((s, l) => s + l.amount, 0));
  return { ok: true, line, lines, fees: feeLines, duty, feesTotal, total: cents(duty + feesTotal),
    effectivePct: Number(((duty / input.value) * 100).toFixed(2)), questions: c.questions, notes: c.notes, adcvd: ad, entryType, defaults, revision: rules.meta.revision };
}
