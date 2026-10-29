import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { COUNTRIES, countryName, resolveCountry } from './countries';
import { loadLine, loadPga, loadRules, loadSearch, loadStatus, type Pga, type Status } from './data';
import { calculate, ListIndex } from './engine/calc';
import type { Answers, HtsLine, Input, Line, Mode, Question, Result, Rules } from './engine/types';
import EntryView from './Entry';
import { FEE_CLASS, MOT } from './engine/entry';
import { buildIndex, highlight, highlightTerms, search } from './search';
import {
  clearHistory, DEFAULT_SETTINGS, parseMoney, readHistory, readLast, remember, saveLast, useSettings,
  type Accent, type History, type Settings, type Theme,
} from './settings';

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const usd0 = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const MODES: { value: Mode; label: string; key: string }[] = [
  { value: 'ocean', label: 'Ocean', key: '1' }, { value: 'air', label: 'Air', key: '2' }, { value: 'truck', label: 'Truck', key: '3' },
  { value: 'rail', label: 'Rail', key: '4' }, { value: 'mail', label: 'Mail', key: '5' }, { value: 'other', label: 'Other', key: '6' },
];
const COMMON = ['CN', 'MX', 'CA', 'VN', 'DE', 'JP', 'KR', 'IN', 'TW', 'GB', 'IT', 'TH', 'BR', 'FR'];
const FAMILY: Record<string, { color: string; name: string }> = {
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
const EXAMPLES = [
  { label: 'Cotton t-shirts · China', hts: '6109.10.00.12', origin: 'CN', value: '10000', mode: 'ocean' as Mode },
  { label: 'Wine · Canada', hts: '2204.21.50.40', origin: 'CA', value: '10000', mode: 'truck' as Mode, claim: 'S', quantity: '1000' },
  { label: 'Steel plate · Germany', hts: '7208.51.00.30', origin: 'DE', value: '100000', mode: 'ocean' as Mode },
  { label: 'Car · Japan', hts: '8703.23.01.60', origin: 'JP', value: '40000', mode: 'ocean' as Mode },
];

interface Form { hts: string; origin: string; value: string; entryDate: string; loadingDate: string; mode: Mode;
  quantity: string; quantity2: string; claim: string; answers: Answers }

const blank = (s: Settings): Form => ({ hts: '', origin: s.defaultCountry, value: s.defaultValue, entryDate: today(), loadingDate: '',
  mode: s.defaultMode, quantity: '', quantity2: '', claim: '', answers: {} });

function readUrl(s: Settings): Form {
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

function toQuery(f: Form, s: Settings) {
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

type Data = { rules: Rules; idx: ListIndex };
function compute(form: Form, line: HtsLine, data: Data, patch: Partial<Form> = {}): Result {
  const f = { ...form, ...patch, answers: { ...form.answers, ...(patch.answers ?? {}) } };
  const input: Input = { hts: f.hts, origin: f.origin, value: Number(f.value), entryDate: f.entryDate,
    loadingDate: f.loadingDate || undefined, mode: f.mode, quantity: f.quantity ? Number(f.quantity) : undefined,
    quantity2: f.quantity2 ? Number(f.quantity2) : undefined, claim: f.claim || null, answers: f.answers };
  return calculate(input, line, data.rules, data.idx);
}

const isTyping = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, select, textarea, [contenteditable]');

export default function App() {
  const [settings, setSettings] = useSettings();
  const [form, setForm] = useState<Form>(() => readUrl(settings));
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState<Status | null>(null);
  const [ready, setReady] = useState(false);
  // the line loaded for a code, kept with that code so a newer pick never shows an older line
  const [loaded, setLoaded] = useState<{ hts: string; line?: HtsLine; fallback: boolean }>();
  const current = form.hts && loaded?.hts === form.hts ? loaded : undefined;
  const line = current?.line;
  const fallback = !!current?.fallback;
  const loadingLine = !!form.hts && !current;
  const [query, setQueryState] = useState('');
  const [active, setActive] = useState(0);
  const setQuery = useCallback((q: string) => { setQueryState(q); setActive(0); }, []);
  const [broker, setBroker] = useState(settings.defaultView === 'broker');
  const [pga, setPga] = useState<Pga | null>(null);
  const [history, setHistory] = useState<History>(readHistory);
  const [panel, setPanel] = useState<'none' | 'settings' | 'help'>('none');
  const [view, setViewState] = useState<'quote' | 'entry'>(() => (localStorage.getItem('tariffwiz.view') === 'entry' ? 'entry' : 'quote'));
  const setView = (v: 'quote' | 'entry') => { setViewState(v); try { localStorage.setItem('tariffwiz.view', v); } catch { /* ignore */ } };
  const panelRef = useRef(panel);
  const viewRef = useRef(view);
  useLayoutEffect(() => { panelRef.current = panel; viewRef.current = view; }, [panel, view]);
  const [toast, setToast] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  const countryRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));
  const toastTimer = useRef(0);
  const notify = useCallback((m: string) => { setToast(m); clearTimeout(toastTimer.current); toastTimer.current = window.setTimeout(() => setToast(''), 1800); }, []);

  useEffect(() => {
    loadRules().then(setData).catch(() => setLoadError('The tariff data could not be loaded. Check your connection and reload.'));
    loadPga().then(setPga);
    loadStatus().then(setStatus);
    loadSearch().then((l) => { buildIndex(l); setReady(true); }).catch(() => setLoadError('Product search could not be loaded. Reload to try again.'));
    if (matchMedia('(min-width: 861px)').matches && !location.search) searchRef.current?.focus();
  }, []);
  useEffect(() => {
    if (!form.hts) return;
    let live = true;
    const hts = form.hts, d = hts.replace(/\D/g, '');
    (async () => {
      const l = await loadLine(hts);
      // a 10-digit code missing from the schedule falls back to its 8-digit line, flagged
      const parent = !l && d.length === 10 ? await loadLine(d.slice(0, 8)) : undefined;
      return { hts, line: l ?? parent, fallback: !!parent };
    })()
      .catch(() => ({ hts, line: undefined, fallback: false }))
      .then((r) => { if (live) setLoaded(r); });
    return () => { live = false; };
  }, [form.hts]);
  useEffect(() => {
    const q = toQuery(form, settings);
    window.history.replaceState(null, '', q ? `?${q}` : location.pathname);
    if (settings.rememberLast) saveLast(q);
  }, [form, settings]);

  const hits = useMemo(() => (ready && query.trim().length > 1 ? search(query) : []), [query, ready]);
  const terms = useMemo(() => highlightTerms(query), [query]);

  const complete = !!form.origin && Number(form.value) > 0;
  // the loaded line is this code, its 8-digit parent (fallback), or its only .00 line (8-digit code typed)
  const lineMatches = !!line && (form.hts.replace(/\D/g, '').startsWith(line.digits) || line.digits.startsWith(form.hts.replace(/\D/g, '')));
  const result = useMemo(() => (data && line && lineMatches && complete ? compute(form, line, data) : null), [data, line, form, complete, lineMatches]);

  const claims = useMemo(() => {
    if (!data || !line || !result?.ok) return [];
    return Object.entries(data.rules.programs)
      .filter(([k, p]) => p.in_force && !(p.to && form.entryDate > p.to) && p.countries.includes(form.origin)
        && (line.special.some((s) => s.program.replace(/[*+]$/, '') === k) || k === 'S' || !!p.anyLine))
      .map(([code, p]) => {
        const alt = code === form.claim ? null : compute(form, line, data, { claim: code });
        return { code, name: p.name, save: alt?.ok ? result.total - alt.total : 0 };
      });
  }, [data, line, form, result]);
  const bestClaim = claims.filter((c) => c.save > 0.005).sort((a, b) => b.save - a.save)[0];
  // what the other answer to each question would cost: computed once per result, not on every keystroke
  const stakes = useMemo<Record<string, number | null>>(() => (result?.ok && line && data
    ? Object.fromEntries(result.questions.map((q) => [q.id, stakeOf(q, form, line, data, result)])) : {}), [result, form, line, data]);

  const pick = (code: string, desc = '') => {
    set({ hts: code, answers: {}, claim: '', quantity: '', quantity2: '' });
    setQuery('');
    if (settings.keepHistory) setHistory((h) => remember(h, { code, desc }));
    // fastest next step: the first empty field
    setTimeout(() => (form.origin ? valueRef.current : countryRef.current)?.focus(), 0);
  };
  const pickCountry = (iso: string) => {
    set({ origin: iso, claim: '' });
    if (settings.keepHistory) setHistory((h) => remember(h, undefined, iso));
  };
  const reset = useCallback(() => {
    setForm(blank(settings)); setQuery(''); setBroker(settings.defaultView === 'broker'); searchRef.current?.focus();
  }, [settings, setQuery]);
  const dirty = toQuery(form, settings) !== '' || !!query;

  const copySummary = useCallback(async () => {
    if (!result?.ok || !result.line) return;
    const lines = [...result.lines, ...result.fees].map((l) => `${(l.heading + (FEE_CLASS[l.heading] ? ` ${FEE_CLASS[l.heading]}` : '')).padEnd(18)} ${l.rate.padEnd(22)} ${usd(l.amount).padStart(13)}${l.assumed ? '  (assumed: ' + l.assumed + ')' : ''}`);
    const text = [`${result.line.code} ${result.line.desc}`,
      `Entry type ${result.entryType} · MOT ${MOT[form.mode] || form.mode} · COO ${form.origin}${form.claim ? ` · SPI ${form.claim}` : ''} · value ${usd(Number(form.value))}`
        + `${form.quantity ? ` · ${form.quantity} ${result.line.units[0] ?? ''}` : ''}${form.quantity2 ? ` · ${form.quantity2} ${result.line.units[1] ?? ''}` : ''} · entry ${form.entryDate}`,
      '', ...lines, '', `TOTAL ${usd(result.total)} (duty ${usd(result.duty)} + fees/taxes ${usd(result.feesTotal)})`,
      ...(result.defaults.length ? ['', 'Answered with defaults:', ...result.defaults.map((d) => `- ${d.text} ${String(d.value)}`)] : []),
      ...(result.adcvd.filter((o) => !o.broad).length ? ['', `AD/CVD: ${result.adcvd.filter((o) => !o.broad).map((o) => o.case).join(', ')} (deposit rates per exporter)`] : []),
      '', `Rules ${result.revision} (checked ${data?.rules.meta.checked ?? ''}) · order per CSMS #69326983 · tariffwiz`, 'Estimate for planning only, not legal or customs advice. The filer remains responsible for classification, valuation, origin and ACE transmission.', (() => { const u = new URL(location.href); u.searchParams.set('entry', form.entryDate); return u.toString(); })()].join('\n');
    try { await navigator.clipboard.writeText(text); notify('Summary copied'); } catch { notify('Copy failed: your browser blocked the clipboard'); }
  }, [result, form, notify, data]);
  const copyLink = useCallback(async () => {
    const u = new URL(location.href);
    if (form.hts) u.searchParams.set('entry', form.entryDate); // a link opened another day keeps this quote's date
    try { await navigator.clipboard.writeText(u.toString()); notify('Link copied'); } catch { notify('Copy failed: your browser blocked the clipboard'); }
  }, [notify, form]);

  // keyboard: / or Ctrl+K search · R reset · B broker view · C copy summary · L copy link · P print · , settings · ? help · 1–6 transport
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); searchRef.current?.focus(); return; }
      if (e.key === 'Escape') { setPanel('none'); return; }
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (panelRef.current !== 'none') return; // shortcuts are off while a sheet is open
      const k = e.key.toLowerCase();
      const common: Record<string, () => void> = { ',': () => setPanel('settings'), '?': () => setPanel('help'), q: () => setView('quote'), e: () => setView('entry') };
      const quote: Record<string, () => void> = {
        '/': () => searchRef.current?.focus(), r: reset, b: () => setBroker((x) => !x), c: copySummary, l: copyLink, p: () => print(),
      };
      const act = { ...common, ...(viewRef.current === 'quote' ? quote : {}) };
      const mode = viewRef.current === 'quote' ? MODES.find((m) => m.key === k) : undefined;
      if (act[k]) { e.preventDefault(); act[k](); } else if (mode) { e.preventDefault(); set({ mode: mode.value }); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [reset, copySummary, copyLink]);

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setQuery(''); return; }
    if (!hits.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(hits.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(hits[active].code, hits[active].desc); }
  };
  const example = (x: (typeof EXAMPLES)[number]) => setForm((f) => ({ ...f, hts: x.hts, origin: x.origin, value: x.value, mode: x.mode,
    claim: x.claim ?? '', quantity: x.quantity ?? '', quantity2: '', answers: {}, loadingDate: '' }));
  const hint = (k: string) => (settings.showHints ? <kbd className="hintkey" aria-hidden="true">{k}</kbd> : null);

  return (
    <div className="page">
      <header className="top">
        <div className="brand"><Logo /><span>tariffwiz</span></div>
        <div className="seg viewswitch" role="tablist" aria-label="Mode">
          <button role="tab" aria-selected={view === 'quote'} className={view === 'quote' ? 'on' : ''} onClick={() => setView('quote')} title="One product (Q)">Quote</button>
          <button role="tab" aria-selected={view === 'entry'} className={view === 'entry' ? 'on' : ''} onClick={() => setView('entry')} title="Multi-line entry for brokers (E)">Entry</button>
        </div>
        <div className="topright">
          <span className="fresh" title="Rates come from the official tariff schedule plus Federal Register and CBP guidance">
            <i aria-hidden="true" /> Rules current to {data ? fmtDate(data.rules.meta.checked) : '…'}
          </span>
          <button className="icon" onClick={() => setPanel('help')} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</button>
          <button className="icon" onClick={() => setPanel('settings')} aria-label="Settings" title="Settings (,)"><GearIcon /></button>
        </div>
      </header>
      <p className="lede">What you'll pay to bring goods into the US, with every charge explained.</p>
      {loadError && <p className="error banner" role="alert">{loadError}</p>}
      {status && <StaleBanner s={status} />}

      {view === 'entry' && (data
        ? <main><EntryView rules={data.rules} idx={data.idx} today={today()} defaults={{ mode: settings.defaultMode, origin: settings.defaultCountry }} notify={notify} pga={pga} /></main>
        : <div className="skeleton tall" />)}
      <main className="grid" hidden={view !== 'quote'}>
        <section className="panel form" aria-label="Shipment">
          <div className="formhead">
            <span className="formtitle">Your shipment</span>
            <button className="ghost small" onClick={reset} disabled={!dirty} title="Clear everything (R)">Reset {hint('R')}</button>
          </div>

          <div className="search">
            <label htmlFor="q" className="label">Product or HTS code</label>
            <div className="searchbox">
              <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <input id="q" ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onSearchKey}
                placeholder={line ? 'Search for a different product' : 'cotton t-shirts, steel bolts, 8517.13…'}
                autoComplete="off" spellCheck={false} role="combobox" aria-expanded={hits.length > 0} aria-controls="hits"
                aria-activedescendant={hits.length ? `hit-${active}` : undefined} />
              {settings.showHints && <kbd aria-hidden="true">/</kbd>}
            </div>
            {hits.length > 0 && (
              <ul className="hits" id="hits" role="listbox">
                {hits.map((h, i) => (
                  <li key={h.code} id={`hit-${i}`} role="option" aria-selected={i === active}
                    className={i === active ? 'active' : ''} onMouseEnter={() => setActive(i)} onMouseDown={(e) => { e.preventDefault(); pick(h.code, h.desc); }}>
                    <span className="code">{h.code}</span>
                    <span className="desc">{highlight(h.desc, terms).map((r, j) => (r.m ? <mark key={j}>{r.t}</mark> : r.t))}</span>
                    <span className="rate">{h.rate || '—'}</span>
                    <span className="path">{h.path.split(' > ').slice(-3).join(' › ')}</span>
                  </li>
                ))}
              </ul>
            )}
            {query.trim().length > 1 && ready && !hits.length && <p className="hint">No match. Try a simpler word, or the first 4–6 digits of the code.</p>}
            {query && !ready && <p className="hint">Loading product search…</p>}
            {settings.keepHistory && !query && !line && history.products.length > 0 && (
              <div className="chips" aria-label="Recent products">
                <span className="chiplabel">Recent</span>
                {history.products.slice(0, 5).map((p) => (
                  <button key={p.code} className="chip" onClick={() => pick(p.code, p.desc)} title={p.desc}><span className="code">{p.code}</span> {p.desc.slice(0, 28)}</button>
                ))}
              </div>
            )}
          </div>

          {line && (
            <div className="picked">
              <div className="pickedtop">
                <span className="code">{line.code}</span>
                <span className="chip static">{line.general?.raw || 'Free'}</span>
                <button className="link" onClick={() => searchRef.current?.focus()}>Change</button>
              </div>
              <div className="pickeddesc">{/^other\b/i.test(line.desc) ? `${line.path.split(' > ').at(-1)?.replace(/:$/, '') ?? ''}: ${line.desc}` : line.desc}</div>
              {fallback && <p className="warn">{form.hts} isn't in the current schedule; using its 8-digit line {line.code}. Search to pick the current 10-digit code.</p>}
              <details><summary>Full classification</summary><p>{line.path}</p></details>
            </div>
          )}
          {!line && loadingLine && <div className="picked skeleton" />}
          {form.hts && !line && !loadingLine && <p className="error">HTS {form.hts} wasn't found in the current schedule. Search for the product instead.</p>}

          <div className="row">
            <div className="field"><label className="label" htmlFor="value">Customs value</label>
              <MoneyInput id="value" inputRef={valueRef} value={form.value} onChange={(v) => set({ value: v })} /></div>
            <div className="field"><label className="label" htmlFor="country">Country of origin</label>
              <CountryPicker id="country" inputRef={countryRef} value={form.origin} recent={history.countries} onPick={pickCountry} /></div>
          </div>
          <div className="field"><span className="label">Shipping by</span>
            <div className="seg" role="radiogroup" aria-label="Shipping by">
              {MODES.map((m) => (
                <button key={m.value} role="radio" aria-checked={form.mode === m.value} className={form.mode === m.value ? 'on' : ''}
                  onClick={() => set({ mode: m.value })} title={`${m.label} (${m.key})`}>{m.label}</button>
              ))}
            </div>
          </div>
          <div className="row">
            <div className="field"><label className="label" htmlFor="entry">Entry date</label>
              <input id="entry" type="date" value={form.entryDate} min="2026-07-24" max="2027-06-22" onChange={(e) => set({ entryDate: e.target.value || today() })} /></div>
            <div className="field"><label className="label" htmlFor="loaded">Loaded on vessel <em>optional</em></label>
              <input id="loaded" type="date" value={form.loadingDate} onChange={(e) => set({ loadingDate: e.target.value })} /></div>
          </div>
          {claims.length > 0 && (
            <div className="field"><label className="label" htmlFor="claim">Trade agreement claim</label>
              <select id="claim" value={form.claim} onChange={(e) => set({ claim: e.target.value })}>
                <option value="">None</option>
                {claims.map((c) => <option key={c.code} value={c.code}>{c.name}{c.save > 0.005 ? ` (saves ${usd0(c.save)})` : ''}</option>)}
              </select>
              {bestClaim && !form.claim && (
                <button className="tip" onClick={() => set({ claim: bestClaim.code })}>
                  Claiming {bestClaim.name} would save {usd(bestClaim.save)} if your goods meet its origin rules. <u>Apply</u>
                </button>
              )}
            </div>
          )}

          {result && result.questions.length > 0 && data && line && ( /* also when blocked (an import ban asks what decides it) */
            <div className="questions">
              <h2>Questions that change the number</h2>
              {result.questions.map((q) => <QuestionField key={q.id} q={q} form={form} set={set} stake={stakes[q.id] ?? null} />)}
            </div>
          )}
        </section>

        <section className="panel receipt" id="result" aria-label="Result">
          <span className="sr" aria-live="polite">{result?.ok ? `Total ${usd(result.total)}` : ''}</span>
          {!form.hts && <Empty onPick={example} />}
          {form.hts && line && !complete && (
            <div className="empty"><h2>Almost there</h2><p>Add the {!form.origin ? 'country of origin' : 'customs value'} to see your total.</p></div>
          )}
          {form.hts && complete && !result && (loadingLine || !data) && <div className="skeleton tall" />}
          {result && !result.ok && <p className="error">{result.error}</p>}
          {view === 'quote' && result?.ok && (
            <Receipt r={result} form={form} broker={broker} setBroker={setBroker} copySummary={copySummary} copyLink={copyLink}
              reduceMotion={settings.reduceMotion} hint={hint} />
          )}
          {line && <Agencies pga={pga} code={line.code} />}
        </section>
      </main>

      {view === 'quote' && result?.ok && (
        <a className="mobilebar" href="#result"><span>Total at the border</span><b>{usd(result.total)}</b></a>
      )}

      <footer className="foot">
        Estimate for planning only, not legal or customs advice. The filer remains responsible for classification, valuation, origin and ACE transmission.
        Sources: HTS {data?.rules.meta.revision.replace('2026HTSRev', '2026 Revision ') ?? '…'}, Federal Register and CBP guidance.
        Settings and history stay in this browser.
      </footer>

      {panel === 'settings' && (
        <SettingsPanel s={settings} set={setSettings} onClose={() => setPanel('none')} data={data}
          clear={() => { setHistory(clearHistory()); notify('History cleared'); }} />
      )}
      {panel === 'help' && <HelpPanel onClose={() => setPanel('none')} />}
      <div className={`toast ${toast ? 'show' : ''}`} role="status" aria-live="polite">{toast}</div>
    </div>
  );
}

function fmtDate(d: string) {
  return new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** What answering the other way would do to the total. */
function stakeOf(q: Question, form: Form, line: HtsLine, data: Data, cur: Result): number | null {
  if (q.kind === 'number') return null;
  const now = form.answers[q.id as keyof Answers] ?? q.defaultValue;
  const others = q.kind === 'yesno' ? [!now] : (q.options ?? []).map((o) => o.value).filter((v) => v !== now);
  const deltas = others.map((v) => compute(form, line, data, { answers: { [q.id]: v } as unknown as Answers }))
    .filter((r) => r.ok).map((r) => r.total - cur.total);
  if (!deltas.length) return null;
  return deltas.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a));
}

/** Number field with a text draft: "13." stays while typing, only valid numbers reach the engine. */
function NumInput({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input inputMode="decimal" value={draft ?? value} placeholder={placeholder} aria-label={label}
      onFocus={() => setDraft(value)} onBlur={() => setDraft(null)}
      onChange={(e) => { const t = e.target.value.replace(/[^\d.]/g, ''); setDraft(t); if (/^\d*\.?\d*$/.test(t) && t !== '.') onChange(t.replace(/\.$/, '')); }} />
  );
}

/** Tariff actions published (or filed for publication) since the rules were last reviewed, and a newer HTS revision.
 *  Shown on every view so a quote never silently misses a change. */
function StaleBanner({ s }: { s: Status }) {
  const rev = s.latestRevision && s.latestRevision.name !== s.revision ? s.latestRevision : null;
  if (!s.pending.length && !rev) return null;
  return (
    <div className="warn stale" role="status">
      <strong>Not in these results yet.</strong> Quotes for goods these cover may be out of date until they're reviewed and added:
      <ul>
        {s.pending.map((p) => (
          <li key={p.doc}><a href={p.url} target="_blank" rel="noreferrer">{p.title}</a> ({p.inspection ? 'to be published' : 'published'} {fmtDate(p.date)})</li>
        ))}
        {rev && <li>Tariff schedule {rev.title}, in force {rev.from}: these results use {s.revision.replace('2026HTSRev', '2026 Revision ')}.</li>}
      </ul>
    </div>
  );
}

function MoneyInput({ id, value, onChange, inputRef, placeholder = '10,000' }: { id?: string; value: string; onChange: (v: string) => void;
  inputRef?: React.Ref<HTMLInputElement>; placeholder?: string }) {
  const [draft, setDraft] = useState<string | null>(null); // raw text while focused ("12k" is fine)
  const n = Number(value); // a share link can carry anything: show nothing rather than "NaN"
  const shown = draft ?? (value && Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '');
  return (
    <div className="money">
      <span aria-hidden="true">$</span>
      <input id={id} ref={inputRef} inputMode="decimal" value={shown} placeholder={placeholder} autoComplete="off"
        onFocus={(e) => { setDraft(value); requestAnimationFrame(() => e.target.select()); }}
        onBlur={() => { if (draft !== null) onChange(parseMoney(draft)); setDraft(null); }}
        onChange={(e) => { setDraft(e.target.value); const p = parseMoney(e.target.value); if (p !== '' && /^[\d.,$\s]+$/.test(e.target.value)) onChange(p); }}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        aria-label="Amount in US dollars. Shortcuts like 12k or 1.5m work." />
    </div>
  );
}

/** Type-to-filter country box: names, ISO codes ("VN"), recent countries first. */
function CountryPicker({ id, value, onPick, recent, inputRef }: { id: string; value: string; onPick: (iso: string) => void; recent: string[];
  inputRef?: React.RefObject<HTMLInputElement | null> }) {
  const [q, setQ] = useState<string | null>(null);
  const [act, setAct] = useState(0);
  const [moved, setMoved] = useState(false); // user arrowed through the list
  const list = useMemo(() => {
    const t = (q ?? '').trim().toLowerCase();
    if (!t) {
      const top = [...new Set([...recent, ...COMMON])];
      return [...top.map((c) => ({ code: c, name: countryName(c) })), ...COUNTRIES.filter((c) => !top.includes(c.code))];
    }
    const alias = resolveCountry(t);
    const score = (c: { code: string; name: string }) => (c.code === alias ? 3 : 0) + (c.code.toLowerCase() === t ? 2 : 0) + (c.name.toLowerCase().startsWith(t) ? 1 : 0);
    return COUNTRIES.filter((c) => c.code === alias || c.code.toLowerCase() === t || c.name.toLowerCase().includes(t))
      .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
  }, [q, recent]);
  const open = q !== null;
  const choose = (code: string) => { onPick(code); setQ(null); setMoved(false); };
  useEffect(() => { if (open) document.getElementById(`${id}-${act}`)?.scrollIntoView({ block: 'nearest' }); }, [act, open, id]);
  return (
    <div className="combo">
      <input id={id} ref={inputRef} value={open ? q : value ? `${countryName(value)} (${value})` : ''} placeholder="Type a country or code"
        autoComplete="off" spellCheck={false} role="combobox" aria-expanded={open} aria-controls={`${id}-list`}
        aria-activedescendant={open && list.length ? `${id}-${act}` : undefined}
        onFocus={() => { setQ(''); setAct(0); setMoved(false); }}
        onBlur={() => { const exact = resolveCountry(q ?? ''); if (exact) onPick(exact); setQ(null); }}
        onChange={(e) => { setQ(e.target.value); setAct(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setMoved(true); setAct((i) => Math.min(list.length - 1, i + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setMoved(true); setAct((i) => Math.max(0, i - 1)); }
          else if (e.key === 'Enter' && open && list[act]) { e.preventDefault(); choose(list[act].code); }
          else if (e.key === 'Tab' && open && list[act] && (q || moved)) choose(list[act].code);
          else if (e.key === 'Escape') { setQ(null); (e.target as HTMLInputElement).blur(); }
        }} />
      {open && (
        <ul className="hits small" id={`${id}-list`} role="listbox">
          {list.map((c, i) => (
            <li key={c.code} id={`${id}-${i}`} role="option" aria-selected={i === act} className={i === act ? 'active' : ''}
              onMouseEnter={() => setAct(i)} onMouseDown={(e) => { e.preventDefault(); choose(c.code); }}>
              <span className="desc">{c.name}</span><span className="rate">{c.code}</span>
            </li>
          ))}
          {!list.length && <li className="nohit">No country matches</li>}
        </ul>
      )}
    </div>
  );
}

function QuestionField({ q, form, set, stake }: { q: Question; form: Form; set: (p: Partial<Form>) => void; stake: number | null }) {
  const stakeText = stake && Math.abs(stake) >= 0.01
    ? <span className={`stake ${stake > 0 ? 'up' : 'down'}`}>The other answer {stake > 0 ? 'adds' : 'saves'} {usd0(Math.abs(stake))}</span> : null;
  if (q.id === 'quantity' || q.id === 'quantity2') {
    const key = q.id;
    return (
      <label className="field q"><span className="qtext">{q.text}</span>
        <input inputMode="decimal" value={form[key]} onChange={(e) => set({ [key]: e.target.value.replace(/[^\d.]/g, '') })} />
        <small>{q.why}</small></label>
    );
  }
  const id = q.id as keyof Answers;
  const cur = form.answers[id];
  const setA = (v: unknown) => set({ answers: { ...form.answers, [id]: v } });
  return (
    <div className="field q">
      <span className="qtext">{q.text}</span>
      {q.kind === 'yesno' && (
        <div className="seg" role="radiogroup" aria-label={q.text}>
          {[true, false].map((v) => (
            <button key={String(v)} role="radio" aria-checked={(cur ?? q.defaultValue) === v}
              className={(cur ?? q.defaultValue) === v ? 'on' : ''} onClick={() => setA(v)}>{v ? 'Yes' : 'No'}</button>
          ))}
        </div>
      )}
      {q.kind === 'choice' && (q.options ?? []).length > 4 && (
        <select className="qselect" aria-label={q.text} value={String(cur ?? q.defaultValue)} onChange={(e) => setA(e.target.value)}>
          {(q.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
      {q.kind === 'choice' && (q.options ?? []).length <= 4 && (
        <div className="seg" role="radiogroup" aria-label={q.text}>
          {(q.options ?? []).map((o) => (
            <button key={o.value} role="radio" aria-checked={(cur ?? q.defaultValue) === o.value}
              className={(cur ?? q.defaultValue) === o.value ? 'on' : ''} onClick={() => setA(o.value)}>{o.label}</button>
          ))}
        </div>
      )}
      {q.kind === 'text' && (
        <input value={typeof cur === 'string' ? cur : ''} maxLength={2} placeholder="CN" style={{ width: 90, textTransform: 'uppercase' }}
          onChange={(e) => setA(e.target.value.toUpperCase().replace(/[^A-Z]/g, '') || undefined)} aria-label={q.text} />
      )}
      {q.kind === 'number' && (q.money
        ? <MoneyInput value={cur === undefined ? '' : String(cur)} placeholder={String(q.defaultValue)} onChange={(v) => setA(v === '' ? undefined : Number(v))} />
        : <NumInput value={cur === undefined ? '' : String(cur)} placeholder={String(q.defaultValue)} label={q.text} onChange={(v) => setA(v === '' ? undefined : Number(v))} />)}
      <small>{q.why} {cur === undefined && <b>Using the default until you answer.</b>} {stakeText}</small>
    </div>
  );
}

/** Count up to a number (skipped when motion is reduced). */
function useCountUp(target: number, off: boolean) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const reduced = off || document.documentElement.dataset.motion === 'reduced';
    if (reduced || from.current === target) { setV(target); from.current = target; return; }
    const start = performance.now(); const a = from.current; let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / 320); const e = 1 - (1 - k) ** 3;
      setV(a + (target - a) * e);
      if (k < 1) raf = requestAnimationFrame(tick); else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); from.current = target; };
  }, [target, off]);
  return v;
}

function Receipt({ r, form, broker, setBroker, copySummary, copyLink, reduceMotion, hint }: { r: Result; form: Form; broker: boolean;
  setBroker: (b: boolean) => void; copySummary: () => void; copyLink: () => void; reduceMotion: boolean; hint: (k: string) => React.ReactNode }) {
  const total = useCountUp(r.total, reduceMotion);
  const charged = r.lines.filter((l) => l.amount > 0);
  const legend = [...new Set(charged.map((l) => FAMILY[l.family]?.name ?? l.family))];
  const shown: Line[] = [...r.lines.filter((l) => l.amount > 0 || l.family === 'base'), ...r.fees];
  const skipped = r.lines.filter((l) => l.amount === 0 && l.family !== 'base');
  return (
    <>
      <div className="printhead">
        <b>tariffwiz duty estimate</b> · {r.line?.code} {r.line?.desc} · from {countryName(form.origin)} · {usd(Number(form.value))} · entry {form.entryDate}
      </div>
      <div className="headline">
        <div>
          <div className="label">Total at the border</div>
          <div className="big" aria-label={usd(r.total)}>{usd(total)}</div>
          <div className="sub">{usd(r.duty)} duty + {usd(r.feesTotal)} fees and taxes · {countryName(form.origin)} · {MODES.find((m) => m.value === form.mode)?.label}</div>
        </div>
        <div className="eff"><div className="label">Effective duty rate</div><div className="mid">{r.effectivePct}%</div></div>
      </div>
      {r.duty > 0 && (
        <>
          <div className="bar" aria-hidden="true">
            {charged.map((l) => <span key={l.family + l.heading} title={`${l.label}: ${usd(l.amount)}`}
              style={{ width: `${(l.amount / r.duty) * 100}%`, background: FAMILY[l.family]?.color ?? 'var(--c-fee)' }} />)}
          </div>
          <div className="legend">{legend.map((n) => {
            const fam = Object.values(FAMILY).find((f) => f.name === n);
            return <span key={n}><i style={{ background: fam?.color ?? 'var(--c-fee)' }} />{n}</span>;
          })}</div>
        </>
      )}

      <div className="tabs">
        <div className="seg small" role="tablist">
          <button role="tab" aria-selected={!broker} className={!broker ? 'on' : ''} onClick={() => setBroker(false)}>Explained</button>
          <button role="tab" aria-selected={broker} className={broker ? 'on' : ''} onClick={() => setBroker(true)}>Broker view {hint('B')}</button>
        </div>
        <span className="spacer" />
        <button className="ghost" onClick={copySummary} title="Copy a text summary (C)">Copy {hint('C')}</button>
        <button className="ghost" onClick={copyLink} title="Copy a link to this quote (L)">Link {hint('L')}</button>
        <button className="ghost" onClick={() => print()} title="Print (P)">Print</button>
      </div>

      {!broker ? (
        <ul className="lines">
          {shown.map((l) => (
            <li key={l.family + l.heading}>
              <details>
                <summary>
                  <i style={{ background: FAMILY[l.family]?.color ?? 'var(--c-fee)' }} />
                  <span className="name">{l.label}<small>{l.rate}{l.family !== 'base' && l.family !== 'fee' && l.family !== 'tax' ? ` · ${l.heading}` : ''}</small></span>
                  {(l.assumed || l.interpretation) && <span className="flag" title={l.assumed ? `Assumed: ${l.assumed}` : 'Interpretation'}>!<span className="sr">{l.assumed ? `Assumed: ${l.assumed}` : 'Interpretation'}</span></span>}
                  <span className="amt">{usd(l.amount)}</span>
                  <svg className="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                </summary>
                <div className="why">
                  <p>{l.why}</p>
                  {l.basisValue !== undefined && <p>Applied to {usd(l.basisValue)}.</p>}
                  {l.assumed && <p className="warn">Assumed {l.assumed}. Answer the question on the left to confirm.</p>}
                  {l.interpretation && <p className="warn">{l.interpretation}</p>}
                  <p className="cite">{l.cite}</p>
                </div>
              </details>
            </li>
          ))}
        </ul>
      ) : (
        <>
        <div className="brokerhead">Entry type <b>{r.entryType}</b> · MOT <b>{MOT[form.mode] || '—'}</b> · COO <b>{form.origin}</b>{form.claim ? <> · SPI <b>{form.claim}</b></> : null} · entry {form.entryDate}</div>
        <table className="brokertable">
          <thead><tr><th>Line 001</th><th>Rate</th><th>Basis</th><th>Qty</th><th>Duty</th></tr></thead>
          <tbody>
            {r.lines.map((l) => (
              <tr key={l.family + l.heading} className={l.family === 'base' ? 'baserow' : ''}>
                <td className="code">{l.heading}{(l.assumed || l.interpretation) && <span className="flag inline" title={l.assumed ?? l.interpretation}>!</span>}</td>
                <td>{l.rate}{l.family === 'base' && form.claim ? ` · SPI ${form.claim}` : ''}</td>
                <td>{l.amount || l.family === 'base' ? usd(l.basisValue ?? Number(form.value)) : ''}</td>
                <td>{l.family === 'base' ? [form.quantity && `${form.quantity} ${r.line?.units[0] ?? ''}`, form.quantity2 && `${form.quantity2} ${r.line?.units[1] ?? ''}`].filter(Boolean).join(' / ') || (r.line?.units.length ? `(${r.line.units.join(', ')})` : '') : ''}</td>
                <td>{usd(l.amount)}</td>
              </tr>
            ))}
            {r.fees.map((l) => <tr key={l.heading} className="fee"><td>{l.heading}{FEE_CLASS[l.heading] ? ` · ${FEE_CLASS[l.heading]}` : ''}</td><td>{l.rate}</td><td /><td /><td>{usd(l.amount)}{l.assumed ? ' *' : ''}</td></tr>)}
          </tbody>
          <tfoot><tr><td colSpan={5}>Chapter 99 numbers first, the commodity number last (CSMS #69326983; Section 338 placed first by our convention). Units in brackets are the HTS reporting units to declare.</td></tr></tfoot>
        </table>
        {r.defaults.length > 0 && (
          <div className="defaults"><div className="label">Answered with defaults — confirm before filing</div>
            <ul>{r.defaults.map((d) => <li key={d.id}>{d.text} <b>{d.value === true ? 'Yes' : d.value === false ? 'No' : d.value === '' ? '(blank)' : String(d.value)}</b></li>)}</ul></div>
        )}
        </>
      )}

      {r.adcvd.some((o) => !o.broad) && (
        <div className="adcvd" role="note">
          <div className="label">Anti-dumping / countervailing orders may apply</div>
          <p>These orders cover this product from {countryName(form.origin)}. Their rates depend on the exporter and are not in the total.</p>
          <ul>{r.adcvd.filter((o) => !o.broad).slice(0, 6).map((o) => (
            <li key={o.case}><b>{o.case}</b> ({o.type}) {o.product}{o.url && <> · <a href={o.url} target="_blank" rel="noreferrer noopener">scope</a></>}</li>
          ))}</ul>
          {r.adcvd.filter((o) => !o.broad).length > 6 && <p>…and {r.adcvd.filter((o) => !o.broad).length - 6} more.</p>}
        </div>
      )}
      {r.adcvd.some((o) => o.broad) && (
        <p className="muted">Orders on related products under the same heading: {r.adcvd.filter((o) => o.broad).map((o) => `${o.case} (${o.product})`).join('; ')}. They apply only if your product is in their scope.</p>
      )}
      {skipped.length > 0 && !broker && (
        <div className="skipped">
          <div className="label">Checked and not charged</div>
          {skipped.map((l) => <div key={l.family + l.heading}><span>{l.label.replace(' (not applied)', '')}</span> <small>{l.why}</small></div>)}
        </div>
      )}
      {r.notes.length > 0 && (
        <div className="notes"><div className="label">Good to know</div><ul>{r.notes.map((n) => <li key={n}>{n}</li>)}</ul></div>
      )}
    </>
  );
}

function Empty({ onPick }: { onPick: (x: (typeof EXAMPLES)[number]) => void }) {
  return (
    <div className="empty">
      <h2>Start with your product</h2>
      <p>Search by name or HTS code. You'll see the total, the effective rate, and why each charge applies.</p>
      <div className="label">Or try one</div>
      <div className="examples">{EXAMPLES.map((x) => <button key={x.label} onClick={() => onPick(x)}>{x.label}</button>)}</div>
    </div>
  );
}

/** Partner Government Agencies that may (or must) clear this product, from CBP's HTS flags. */
function Agencies({ pga, code }: { pga: Pga | null; code: string }) {
  if (!pga) return null;
  const d = code.replace(/\D/g, '');
  const hints = likelyAgencies(d);
  const fdaHint = hints.length > 0;
  const keys = [...new Set([d, d.slice(0, 8), d.slice(0, 6), d.slice(0, 4)])];
  const flags = [...new Set(keys.flatMap((k) => pga.hts[k] ?? []))].map((f) => ({ code: f, ...pga.flags[f] })).filter((f) => f.agency);
  if (!flags.length && !fdaHint) return (
    <div className="agencies none"><div className="label">Other agencies</div>
      <p>No partner-agency flags found for this code in the public lists. Some agencies (FDA among them) don't publish complete lists, so check if your product is food, a drug, a device, a cosmetic, a vehicle or a chemical.</p></div>
  );
  const byAgency = new Map<string, typeof flags>();
  for (const f of flags) byAgency.set(f.agency, [...(byAgency.get(f.agency) ?? []), f]);
  return (
    <div className="agencies">
      <div className="label">Agencies that may need to clear this</div>
      <ul>
        {[...byAgency.entries()].map(([agency, fs]) => {
          const required = fs.some((f) => /^required$/i.test(f.level));
          return (
            <li key={agency}>
              <span className={`badge ${required ? 'req' : 'may'}`}>{required ? 'Required' : 'May apply'}</span>
              <b>{fs[0].agencyName || agency}</b>
              <small>{fs.map((f) => `${f.code}: ${f.meaning}`).join(' · ')}</small>
              {fs[0].url && <a href={fs[0].url} target="_blank" rel="noreferrer noopener">Filing guidance</a>}
            </li>
          );
        })}
        {hints.filter((h) => !byAgency.has(h.agency)).map((h) => (
          <li key={h.agency}><span className="badge may">Likely</span><b>{h.name}</b>
            <small>{h.text} Based on the product type: this agency's public flag list is incomplete.</small>
            <a href={h.url} target="_blank" rel="noreferrer noopener">Requirements</a></li>
        ))}
      </ul>
      <p className="muted">From CBP's partner-agency flags{pga.checked ? `, checked ${pga.checked}` : ''}. A flag means the agency may need data or a permit at entry; what to file depends on your exact product.</p>
    </div>
  );
}

const THEMES: { v: Theme; label: string }[] = [
  { v: 'system', label: 'System' }, { v: 'light', label: 'Light' }, { v: 'paper', label: 'Paper' },
  { v: 'dark', label: 'Dark' }, { v: 'midnight', label: 'Midnight' },
];
const ACCENTS: Accent[] = ['blue', 'violet', 'teal', 'amber', 'rose'];

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => back?.focus?.();
  }, []);
  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const f = [...ref.current.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.hasAttribute('disabled'));
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onKeyDown={trap}>
        <div className="sheethead"><h2>{title}</h2><button className="icon" onClick={onClose} aria-label="Close">×</button></div>
        {children}
      </div>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => <button key={o.v} role="radio" aria-checked={value === o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>{o.label}</button>)}
    </div>
  );
}

function Toggle({ on, onChange, label, sub }: { on: boolean; onChange: (v: boolean) => void; label: string; sub?: string }) {
  return (
    <label className="toggle"><span><b>{label}</b>{sub && <small>{sub}</small>}</span>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} /><i aria-hidden="true" /></label>
  );
}

function SettingsPanel({ s, set, onClose, clear, data }: { s: Settings; set: (p: Partial<Settings>) => void; onClose: () => void;
  clear: () => void; data: Data | null }) {
  return (
    <Sheet title="Settings" onClose={onClose}>
      <section className="setgroup">
        <h3>Appearance</h3>
        <div className="setrow"><span>Theme</span><Seg label="Theme" value={s.theme} options={THEMES.map((t) => ({ v: t.v, label: t.label }))} onChange={(v) => set({ theme: v })} /></div>
        <div className="setrow"><span>Accent</span>
          <div className="swatches" role="radiogroup" aria-label="Accent colour">
            {ACCENTS.map((a) => <button key={a} role="radio" aria-checked={s.accent === a} aria-label={a} className={`swatch ${a} ${s.accent === a ? 'on' : ''}`} onClick={() => set({ accent: a })} />)}
          </div></div>
        <div className="setrow"><span>Density</span><Seg label="Density" value={s.density} options={[{ v: 'comfortable', label: 'Comfortable' }, { v: 'compact', label: 'Compact' }]} onChange={(v) => set({ density: v })} /></div>
        <div className="setrow"><span>Text size</span><Seg label="Text size" value={s.textSize} options={[{ v: 'normal', label: 'Normal' }, { v: 'large', label: 'Large' }]} onChange={(v) => set({ textSize: v })} /></div>
        <Toggle on={s.reduceMotion} onChange={(v) => set({ reduceMotion: v })} label="Reduce motion" sub="No animated totals or transitions." />
        <Toggle on={s.showHints} onChange={(v) => set({ showHints: v })} label="Show keyboard hints" />
      </section>
      <section className="setgroup">
        <h3>Defaults for a new shipment</h3>
        <div className="setrow"><span>Country</span>
          <select value={s.defaultCountry} onChange={(e) => set({ defaultCountry: e.target.value })}>
            <option value="">None</option>{COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select></div>
        <div className="setrow"><span>Shipping by</span>
          <select value={s.defaultMode} onChange={(e) => set({ defaultMode: e.target.value as Mode })}>
            {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select></div>
        <div className="setrow"><span>Customs value</span><MoneyInput value={s.defaultValue} onChange={(v) => set({ defaultValue: v || DEFAULT_SETTINGS.defaultValue })} /></div>
        <div className="setrow"><span>Result view</span><Seg label="Result view" value={s.defaultView} options={[{ v: 'explained', label: 'Explained' }, { v: 'broker', label: 'Broker' }]} onChange={(v) => set({ defaultView: v })} /></div>
      </section>
      <section className="setgroup">
        <h3>Memory</h3>
        <Toggle on={s.rememberLast} onChange={(v) => set({ rememberLast: v })} label="Reopen my last shipment" sub="Instead of a blank form when you come back." />
        <Toggle on={s.keepHistory} onChange={(v) => set({ keepHistory: v })} label="Remember recent products and countries" />
        <div className="setrow"><span /><button className="ghost" onClick={clear}>Clear history</button></div>
      </section>
      <section className="setgroup about">
        <h3>About the data</h3>
        <p>Tariff schedule {data?.rules.meta.revision ?? '…'}, rules checked {data?.rules.meta.checked ?? '…'}. Everything runs in your browser; settings and history never leave this device.</p>
        <button className="ghost" onClick={() => set({ ...DEFAULT_SETTINGS })}>Restore default settings</button>
      </section>
    </Sheet>
  );
}

function HelpPanel({ onClose }: { onClose: () => void }) {
  const keys: [string, string][] = [
    ['/ or Ctrl K', 'Search for a product'], ['↑ ↓ Enter', 'Pick a search result'], ['Tab', 'Next field'],
    ['1 – 6', 'Ocean, air, truck, rail, mail, other'], ['B', 'Explained / broker view'], ['C', 'Copy a text summary'],
    ['L', 'Copy a link to this quote'], ['P', 'Print'], ['R', 'Reset'], [',', 'Settings'], ['?', 'This list'], ['Esc', 'Close'],
  ];
  return (
    <Sheet title="Keyboard shortcuts" onClose={onClose}>
      <table className="keys"><tbody>{keys.map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td>{v}</td></tr>)}</tbody></table>
      <p className="muted">Values accept shortcuts: 12k, 1.5m, $12,000.</p>
    </Sheet>
  );
}

function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="logo" aria-hidden="true">
      <rect x="3" y="3" width="26" height="26" rx="8" fill="var(--accent)" />
      <path d="M10 11h12M16 11v11M11 17.5l2.5 4.5M21 17.5 18.5 22" stroke="var(--on-accent)" strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="gear"><circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

/** Agencies whose public HTS flag lists are missing or stale: hint by product type (labelled as a hint, never as a flag). */
function likelyAgencies(d: string): { agency: string; name: string; text: string; url: string }[] {
  const ch = Number(d.slice(0, 2));
  const out: { agency: string; name: string; text: string; url: string }[] = [];
  const fda = { agency: 'FDA', name: 'Food and Drug Administration', url: 'https://www.fda.gov/industry/import-program-food-and-drug-administration-fda' };
  if ((ch >= 1 && ch <= 24 && ch !== 6) || ch === 21) out.push({ ...fda, text: 'Food and drink need FDA prior notice (facility registration for the maker) and may be examined.' });
  else if (ch === 30) out.push({ ...fda, text: 'Drugs need FDA listing and approval.' });
  else if (ch === 33) out.push({ ...fda, text: 'Cosmetics are FDA-regulated (facility registration and product listing).' });
  else if (/^90(18|19|20|21|22)/.test(d)) out.push({ ...fda, text: 'Medical devices need FDA registration and listing.' });
  else if (/^(8516|8528|8539|8543|9013)/.test(d)) out.push({ ...fda, text: 'Electronics that emit radiation (microwaves, TVs, lasers) need FDA radiation-safety reporting.' });
  if (/^22(03|04|05|06|08)/.test(d) || ch === 24) out.push({ agency: 'TTB', name: 'Alcohol and Tobacco Tax and Trade Bureau', text: 'Importer permit, label approval (COLA) for alcohol; tobacco permits.', url: 'https://www.ttb.gov/importers' });
  if (/^(8703|8704|8711|8407|8408)/.test(d)) {
    out.push({ agency: 'EPA', name: 'Environmental Protection Agency', text: 'Vehicles and engines need EPA emissions conformity (EPA Form 3520-1 or 3520-21).', url: 'https://www.epa.gov/importing-vehicles-and-engines' });
    if (/^(8703|8704|8711)/.test(d)) out.push({ agency: 'NHTSA', name: 'National Highway Traffic Safety Administration', text: 'Vehicles need safety-standard conformity (HS-7 declaration).', url: 'https://www.nhtsa.gov/importing-vehicle' });
  }
  return out;
}

// arrow keys move between options in any button radiogroup (WAI-ARIA radio pattern)
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement;
    if (el?.getAttribute?.('role') !== 'radio' || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const group = [...(el.closest('[role="radiogroup"]')?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])];
    const i = group.indexOf(el);
    const next = group[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1) + group.length) % group.length];
    if (next) { e.preventDefault(); next.focus(); next.click(); }
  });
}

