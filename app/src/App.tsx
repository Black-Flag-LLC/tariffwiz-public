import './App.css';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { loadLine, loadPga, loadRules, loadSearch, loadStatus, type Pga, type Status } from './data';
import type { HtsLine } from './engine/types';
import { FEE_CLASS, MOT } from './engine/entry';
import { buildIndex, highlight, highlightTerms, search } from './search';
import { clearHistory, readHistory, remember, saveLast, useSettings, type History } from './settings';
import { today, usd, usd0, MODES, EXAMPLES, type Form, blank, readUrl, toQuery, type Data, compute, fmtDate, stakeOf } from './form';
import { MoneyInput, CountryPicker, Logo, GearIcon } from './ui/controls';
import { StaleBanner, Receipt, Agencies } from './ui/Receipt';
import { QuestionField, Empty, SettingsPanel, HelpPanel } from './ui/panels';
import EntryView from './Entry';

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
