import { resolveCountry } from './countries';
import { calculate, ListIndex } from './engine/calc';
import type { Answers, HtsLine, Input, Mode, Question, Result, Rules } from './engine/types';
import { readLast, type Settings } from './settings';

export const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
export const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
export const usd0 = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
export const MODES: { value: Mode; label: string; key: string }[] = [
  { value: 'ocean', label: 'Ocean', key: '1' }, { value: 'air', label: 'Air', key: '2' }, { value: 'truck', label: 'Truck', key: '3' },
  { value: 'rail', label: 'Rail', key: '4' }, { value: 'mail', label: 'Mail', key: '5' }, { value: 'other', label: 'Other', key: '6' },
];
export const COMMON = ['CN', 'MX', 'CA', 'VN', 'DE', 'JP', 'KR', 'IN', 'TW', 'GB', 'IT', 'TH', 'BR', 'FR'];
export const FAMILY: Record<string, { color: string; name: string }> = {
  base: { color: 'var(--c-base)', name: 'Base duty' },
  s301_china: { color: 'var(--c-301)', name: 'Section 301' },
  s301_brazil: { color: 'var(--c-301)', name: 'Section 301' },
  s301_forced_labor: { color: 'var(--c-country)', name: 'Country tariffs' },
  s301_nicaragua: { color: 'var(--c-country)', name: 'Country tariffs' },
  russia: { color: 'var(--c-country)', name: 'Country tariffs' },
  ch98: { color: 'var(--c-base)', name: 'Base duty' },
  quota: { color: 'var(--c-base)', name: 'Base duty' },
  japan_leather: { color: 'var(--c-country)', name: 'Country tariffs' },
  s338: { color: 'var(--c-country)', name: 'Country tariffs' },
  s232: { color: 'var(--c-232)', name: 'Section 232' },
  s201: { color: 'var(--c-232)', name: 'Safeguard' },
  fee: { color: 'var(--c-fee)', name: 'Fees' },
  tax: { color: 'var(--c-fee)', name: 'Excise tax' },
};
export const EXAMPLES = [
  { label: 'Cotton t-shirts · China', hts: '6109.10.00.12', origin: 'CN', value: '10000', mode: 'ocean' as Mode },
  { label: 'Wine · Canada', hts: '2204.21.50.40', origin: 'CA', value: '10000', mode: 'truck' as Mode, claim: 'S', quantity: '1000' },
  { label: 'Steel plate · Germany', hts: '7208.51.00.30', origin: 'DE', value: '100000', mode: 'ocean' as Mode },
  { label: 'Car · Japan', hts: '8703.23.01.60', origin: 'JP', value: '40000', mode: 'ocean' as Mode },
];

export interface Form { hts: string; origin: string; value: string; entryDate: string; loadingDate: string; mode: Mode;
  quantity: string; quantity2: string; claim: string; answers: Answers }

export const blank = (s: Settings): Form => ({ hts: '', origin: s.defaultCountry, value: s.defaultValue, entryDate: today(), loadingDate: '',
  mode: s.defaultMode, quantity: '', quantity2: '', claim: '', answers: {} });

export function readUrl(s: Settings): Form {
  const qs = location.search || (s.rememberLast ? readLast() : '');
  const p = new URLSearchParams(qs);
  let answers: Answers = {};
  try { const a = JSON.parse(p.get('a') ?? '{}'); if (a && typeof a === 'object' && !Array.isArray(a)) answers = a; } catch { /* ignore bad links */ }
  const b = blank(s);
  const mode = p.get('mode') as Mode | null;
  return { hts: p.get('hts') ?? '', origin: resolveCountry(p.get('from') ?? b.origin), value: p.get('value') ?? b.value,
    entryDate: p.get('entry') ?? b.entryDate, loadingDate: p.get('loaded') ?? '',
    mode: mode && MODES.some((m) => m.value === mode) ? mode : b.mode,
    quantity: p.get('qty') ?? '', quantity2: p.get('qty2') ?? '', claim: p.get('claim') ?? '', answers };
}

export function toQuery(f: Form, s: Settings) {
  const p = new URLSearchParams();
  const b = blank(s);
  if (f.hts) p.set('hts', f.hts);
  if (f.origin && (f.hts || f.origin !== b.origin)) p.set('from', f.origin);
  if (f.value && (f.hts || f.value !== b.value)) p.set('value', f.value);
  if (f.entryDate !== b.entryDate) p.set('entry', f.entryDate);
  if (f.hts || f.mode !== b.mode) p.set('mode', f.mode);
  if (f.loadingDate) p.set('loaded', f.loadingDate);
  if (f.quantity) p.set('qty', f.quantity);
  if (f.quantity2) p.set('qty2', f.quantity2);
  if (f.claim) p.set('claim', f.claim);
  if (Object.keys(f.answers).length) p.set('a', JSON.stringify(f.answers));
  return p.toString();
}

export type Data = { rules: Rules; idx: ListIndex };
export function compute(form: Form, line: HtsLine, data: Data, patch: Partial<Form> = {}): Result {
  const f = { ...form, ...patch, answers: { ...form.answers, ...(patch.answers ?? {}) } };
  const input: Input = { hts: f.hts, origin: f.origin, value: Number(f.value), entryDate: f.entryDate,
    loadingDate: f.loadingDate || undefined, mode: f.mode, quantity: f.quantity ? Number(f.quantity) : undefined,
    quantity2: f.quantity2 ? Number(f.quantity2) : undefined, claim: f.claim || null, answers: f.answers };
  return calculate(input, line, data.rules, data.idx);
}

export function fmtDate(d: string) {
  return new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** What answering the other way would do to the total. */
export function stakeOf(q: Question, form: Form, line: HtsLine, data: Data, cur: Result): number | null {
  if (q.kind === 'number') return null;
  const now = form.answers[q.id as keyof Answers] ?? q.defaultValue;
  const others = q.kind === 'yesno' ? [!now] : (q.options ?? []).map((o) => o.value).filter((v) => v !== now);
  const deltas = others.map((v) => compute(form, line, data, { answers: { [q.id]: v } as unknown as Answers }))
    .filter((r) => r.ok).map((r) => r.total - cur.total);
  if (!deltas.length) return null;
  return deltas.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
}
