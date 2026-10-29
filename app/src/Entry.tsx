// Multi-line entry workspace for brokers: paste an invoice, price every line, fees once per entry,
// export CSV or a 7501-style text block. Saved in this browser only.
import { useEffect, useMemo, useState } from 'react';
import { COUNTRIES, countryName } from './countries';
import { loadLine, type Pga } from './data';
import { digitsOf, ListIndex } from './engine/calc';
import { calculateEntry, entryCsv, entryText, entryXlsx, ENTRY_TYPES, FEE_CLASS, parseLines, type EntryType } from './engine/entry';
import type { Answers, Ch98Provision, HtsLine, Mode, Question, Rules } from './engine/types';
import { parseMoney } from './settings';

interface Row { id: number; hts: string; origin: string; value: string; quantity: string; quantity2: string; claim: string; answers: Answers;
  loadingDate?: string; ch98?: Ch98Provision | ''; ch98Deduct?: string }
interface EntryState { mode: Mode; entryDate: string; loadingDate: string; rows: Row[]; containerized?: boolean; entryType?: EntryType | ''; exportCountry?: string }
const CH98_OPTIONS: { value: Ch98Provision | ''; label: string }[] = [{ value: '', label: 'None' },
  { value: '9801.00.10', label: '9801.00.10 US goods returned' }, { value: '9802.00.50', label: '9802.00.50 Repaired abroad' },
  { value: '9802.00.80', label: '9802.00.80 US components assembled abroad' }];

const KEY = 'tariffwiz.entry.v1';
const usd = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const MODES: { value: Mode; label: string }[] = [
  { value: 'ocean', label: 'Ocean' }, { value: 'air', label: 'Air' }, { value: 'truck', label: 'Truck' },
  { value: 'rail', label: 'Rail' }, { value: 'mail', label: 'Mail' }, { value: 'other', label: 'Other' },
];
let nextId = 1;
// id last: copies of an existing row (duplicate, paste, reload) always get a fresh id
const newRow = (p: Partial<Row> = {}): Row => ({ hts: '', origin: '', value: '', quantity: '', quantity2: '', claim: '', answers: {}, ...p, id: nextId++ });

function load(today: string, defaults: { mode: Mode; origin: string }): EntryState {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '') as EntryState;
    if (s && Array.isArray(s.rows)) { s.rows = s.rows.map((r) => newRow({ ...r, answers: r.answers && typeof r.answers === 'object' ? r.answers : {} })); return s; }
  } catch { /* fresh */ }
  return { mode: defaults.mode, entryDate: today, loadingDate: '', rows: [newRow({ origin: defaults.origin }), newRow({ origin: defaults.origin })] };
}

/** Agencies flagged for a code in CBP's partner-agency lists (any of its 4–10 digit keys). */
function agenciesFor(pga: Pga | null, code: string): string[] {
  if (!pga) return [];
  const d = digitsOf(code);
  const flags = [...new Set([d, d.slice(0, 8), d.slice(0, 6), d.slice(0, 4)].flatMap((k) => pga.hts[k] ?? []))];
  return [...new Set(flags.map((f) => pga.flags[f]?.agency).filter(Boolean))] as string[];
}

export default function EntryView({ rules, idx, today, defaults, notify, pga }: { rules: Rules; idx: ListIndex; today: string;
  defaults: { mode: Mode; origin: string }; notify: (m: string) => void; pga: Pga | null }) {
  const [st, setSt] = useState<EntryState>(() => load(today, defaults));
  const [lines, setLines] = useState<Record<string, HtsLine | null>>({});
  const [paste, setPaste] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* ignore */ } }, [st]);

  // load each distinct HTS line once
  useEffect(() => {
    const want = [...new Set(st.rows.map((r) => digitsOf(r.hts)).filter((d) => d.length >= 8 && !(d in lines)))];
    let live = true;
    for (const d of want) loadLine(d).then((l) => live && setLines((m) => ({ ...m, [d]: l ?? null }))).catch(() => live && setLines((m) => ({ ...m, [d]: null })));
    return () => { live = false; };
  }, [st.rows, lines]);

  const setRow = (id: number, p: Partial<Row>) => setSt((s) => ({ ...s, rows: s.rows.map((r) => (r.id === id ? { ...r, ...p } : r)) }));
  // new line keeps the previous country, and the cursor lands in its HTS box
  const addRow = (after?: Row) => {
    const row = newRow({ origin: after?.origin ?? st.rows.at(-1)?.origin ?? defaults.origin });
    setSt((s) => ({ ...s, rows: [...s.rows, row] }));
    setTimeout(() => (document.querySelector(`[aria-label="Line ${st.rows.length + 1} HTS"]`) as HTMLInputElement | null)?.focus(), 0);
  };
  const ready = st.rows.filter((r) => digitsOf(r.hts).length >= 8 && r.origin && Number(r.value) > 0 && lines[digitsOf(r.hts)] !== undefined);
  const entry = useMemo(() => calculateEntry(ready.map((r) => ({
    input: { hts: r.hts, origin: r.origin, value: Number(r.value), entryDate: st.entryDate, loadingDate: r.loadingDate || st.loadingDate || undefined, mode: st.mode,
      quantity: r.quantity ? Number(r.quantity) : undefined, quantity2: r.quantity2 ? Number(r.quantity2) : undefined, claim: r.claim || null, answers: r.answers,
      ch98: r.ch98 ? { provision: r.ch98, deduct: r.ch98Deduct ? Number(r.ch98Deduct) : 0 } : null },
    line: lines[digitsOf(r.hts)] ?? undefined,
  })), rules, idx, { entryType: st.entryType }), [ready, st, lines, rules, idx]);
  const meta = { revision: rules.meta.revision, checked: rules.meta.checked, exportCountry: st.exportCountry || undefined, mot: motCode(st), entryDate: st.entryDate };
  const resultFor = (r: Row) => entry.lines[ready.indexOf(r)];

  const doPaste = () => {
    const rows = parseLines(paste ?? '');
    if (!rows.length) { notify('No lines found: paste HTS, country, value (and optional qty, qty2, SPI) per row'); return; }
    setSt((s) => ({ ...s, rows: [...s.rows.filter((r) => r.hts || r.value), ...rows.map((r) => newRow(r))] }));
    const gaps = rows.filter((r) => !r.origin || !r.value).length; // unknown country names and split values are left blank, not guessed
    setPaste(null); notify(`${rows.length} line${rows.length > 1 ? 's' : ''} added${gaps ? ` · ${gaps} need a country or value` : ''}`);
  };
  const save = (data: BlobPart, type: string, ext: string) => {
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], { type })); a.download = `tariffwiz-entry-${st.entryDate}.${ext}`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const download = () => save(entryCsv(entry, meta), 'text/csv', 'csv');
  const downloadXlsx = () => save(entryXlsx(entry, meta) as BlobPart, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx');
  const copyText = async () => {
    try { await navigator.clipboard.writeText(entryText(entry, { ...st, ...meta })); notify('Entry copied as text'); } catch { notify('Copy failed: your browser blocked the clipboard'); }
  };

  return (
    <div className="entry">
      <section className="panel">
        <div className="formhead">
          <span className="formtitle">Entry · {st.rows.length} line{st.rows.length === 1 ? '' : 's'}</span>
          <div className="actions">
            <button className="ghost small" onClick={() => setPaste('')}>Paste lines</button>
            <button className="ghost small" onClick={() => setSt((s) => ({ ...s, rows: [newRow({ origin: defaults.origin })] }))}>Clear</button>
          </div>
        </div>
        <div className="row wrap">
          <div className="field"><span className="label">Shipping by</span>
            <div className="seg" role="radiogroup" aria-label="Shipping by">
              {MODES.map((m) => <button key={m.value} role="radio" aria-checked={st.mode === m.value} className={st.mode === m.value ? 'on' : ''} onClick={() => setSt((s) => ({ ...s, mode: m.value }))}>{m.label}</button>)}
            </div></div>
          <label className="toggle compact"><span><b>Containerized</b><small>MOT {motCode(st)}</small></span>
            <input type="checkbox" role="switch" checked={!!st.containerized} onChange={(e) => setSt((s) => ({ ...s, containerized: e.target.checked }))} /><i aria-hidden="true" /></label>
          <div className="field narrow"><label className="label" htmlFor="e-entry">Entry date</label>
            <input id="e-entry" type="date" value={st.entryDate} min="2026-07-24" max="2027-06-22" onChange={(e) => setSt((s) => ({ ...s, entryDate: e.target.value || today }))} /></div>
          <div className="field narrow"><label className="label" htmlFor="e-loaded">Loaded on vessel <em>optional</em></label>
            <input id="e-loaded" type="date" value={st.loadingDate} onChange={(e) => setSt((s) => ({ ...s, loadingDate: e.target.value }))} /></div>
          <div className="field narrow"><label className="label" htmlFor="e-type">Entry type</label>
            <select id="e-type" className="qselect" value={st.entryType ?? ''} onChange={(e) => setSt((s) => ({ ...s, entryType: e.target.value as EntryType | '' }))}>
              <option value="">Auto ({entry.autoType})</option>
              {ENTRY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select></div>
          <div className="field xnarrow"><label className="label" htmlFor="e-export">Export country</label>
            <input id="e-export" list="iso" maxLength={2} placeholder="CN" value={st.exportCountry ?? ''} title={st.exportCountry ? countryName(st.exportCountry) : 'Country the goods were exported from (7501 box 15)'}
              onChange={(e) => setSt((s) => ({ ...s, exportCountry: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') }))} /></div>
        </div>

        <div className="entrygrid">
          <div className="elines">
            <div className="ehead" aria-hidden="true"><span>#</span><span>HTS</span><span>Country</span><span>Value (USD)</span><span>Qty 1</span><span>Qty 2</span><span>SPI</span><span className="num">Duty</span><span /></div>
            {st.rows.map((r, i) => {
              const l = lines[digitsOf(r.hts)];
              const res = resultFor(r);
              const qs = res?.ok ? res.questions : [];
              return (
                <div key={r.id} className={`eline ${res && !res.ok ? 'bad' : ''}`} role="group" aria-label={`Line ${i + 1}`}>
                  <span className="n">{i + 1}</span>
                  <label className="c-hts"><span className="mini">HTS</span>
                    <input className="code" value={r.hts} placeholder="6109.10.00.12" aria-label={`Line ${i + 1} HTS`}
                      onChange={(e) => setRow(r.id, { hts: e.target.value.trim(), answers: {} })} />
                    <small className={l === null ? 'err' : ''} title={l ? l.desc : ''}>{l === null ? 'Not found in the schedule' : l ? `${l.desc}${l.units.length ? ` · ${l.units.join(', ')}` : ''}` : ''}</small></label>
                  <label className="c-cty"><span className="mini">Country</span>
                    <input list="iso" value={r.origin} placeholder="CN" maxLength={2} aria-label={`Line ${i + 1} country`} title={r.origin ? countryName(r.origin) : ''}
                      onChange={(e) => setRow(r.id, { origin: e.target.value.toUpperCase() })} /></label>
                  <label className="c-val"><span className="mini">Value (USD)</span>
                    <input inputMode="decimal" value={r.value} placeholder="10,000" aria-label={`Line ${i + 1} value`}
                      onChange={(e) => setRow(r.id, { value: e.target.value.replace(/[^\d.,kKmM$]/g, '') })} onBlur={(e) => setRow(r.id, { value: parseMoney(e.target.value) })} /></label>
                  <label className="c-q1"><span className="mini">Qty 1{l?.units[0] ? ` (${l.units[0]})` : ''}</span>
                    <input inputMode="decimal" value={r.quantity} placeholder={l?.units[0] ?? ''} aria-label={`Line ${i + 1} quantity 1`} onChange={(e) => setRow(r.id, { quantity: e.target.value.replace(/[^\d.]/g, '') })} /></label>
                  <label className="c-q2"><span className="mini">Qty 2{l?.units[1] ? ` (${l.units[1]})` : ''}</span>
                    <input inputMode="decimal" value={r.quantity2} placeholder={l?.units[1] ?? ''} aria-label={`Line ${i + 1} quantity 2`} onChange={(e) => setRow(r.id, { quantity2: e.target.value.replace(/[^\d.]/g, '') })} /></label>
                  <label className="c-spi"><span className="mini">SPI</span>
                    <input value={r.claim} placeholder="S" maxLength={3} aria-label={`Line ${i + 1} special program indicator`} onChange={(e) => setRow(r.id, { claim: e.target.value.toUpperCase() })}
                      onKeyDown={(e) => { if (e.key === 'Enter' && i === st.rows.length - 1) { e.preventDefault(); addRow(r); } }} title="Enter on the last line adds a new line" /></label>
                  <div className="c-duty"><span className="mini">Duty</span>
                    <span className="amt">{res?.ok ? usd(res.duty) : res ? <span className="err" title={res.error}>error</span> : '—'}
                      {qs.length > 0 && <button className="qbadge" onClick={() => setOpen(open === r.id ? null : r.id)} aria-expanded={open === r.id} title="Questions answered with defaults">{qs.length}?</button>}
                      {(r.ch98 || r.loadingDate) && <span className="tag" title={[r.ch98, r.loadingDate && `loaded ${r.loadingDate}`].filter(Boolean).join(' · ')}>{r.ch98 ? '98' : 'L'}</span>}</span></div>
                  <div className="c-act">
                    <button className="icon small" aria-label={`Line ${i + 1} details`} aria-expanded={open === r.id} title="Loading date, Chapter 98 claim, questions"
                      onClick={() => setOpen(open === r.id ? null : r.id)}>⋯</button>
                    <button className="icon small" aria-label={`Duplicate line ${i + 1}`} title="Duplicate line"
                      onClick={() => setSt((s) => { const at = s.rows.findIndex((x) => x.id === r.id); const rows = [...s.rows]; rows.splice(at + 1, 0, newRow({ ...r, id: undefined })); return { ...s, rows }; })}>⧉</button>
                    <button className="icon small" aria-label={`Remove line ${i + 1}`} title="Remove line" onClick={() => setSt((s) => ({ ...s, rows: s.rows.filter((x) => x.id !== r.id) }))}>×</button></div>
                  {res && !res.ok && <div className="c-full err">{res.error}</div>}
                  {open === r.id && (
                    <div className="c-full">
                      <div className="lq"><span>Loaded on vessel (this line; blank uses the entry's date)</span>
                        <input type="date" aria-label={`Line ${i + 1} loading date`} value={r.loadingDate ?? ''} onChange={(e) => setRow(r.id, { loadingDate: e.target.value })} /></div>
                      <div className="lq"><span>Chapter 98 claim</span>
                        <select className="qselect" aria-label={`Line ${i + 1} Chapter 98 claim`} value={r.ch98 ?? ''} onChange={(e) => setRow(r.id, { ch98: e.target.value as Ch98Provision | '' })}>
                          {CH98_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                        {(r.ch98 === '9802.00.50' || r.ch98 === '9802.00.80') && <input inputMode="decimal" aria-label={r.ch98 === '9802.00.50' ? 'Value of the repairs' : 'Value of the US components'}
                          placeholder={r.ch98 === '9802.00.50' ? 'Repairs value' : 'US components value'} value={r.ch98Deduct ?? ''}
                          onChange={(e) => setRow(r.id, { ch98Deduct: e.target.value.replace(/[^\d.]/g, '') })} />}</div>
                      {res?.ok && qs.map((q) => <LineQuestion key={q.id} q={q} answers={r.answers} quantities={r} set={(p) => setRow(r.id, p)} />)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <datalist id="iso">{COUNTRIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</datalist>
        </div>
        <button className="ghost addline" onClick={() => addRow()}>+ Add line</button>
      </section>

      <section className="panel receipt" aria-live="polite">
        <div className="headline">
          <div><div className="label">Entry total</div><div className="big">{usd(entry.total)}</div>
            <div className="sub">{usd(entry.duty)} duty + {usd(entry.feesTotal)} fees and taxes · {ready.length} priced line{ready.length === 1 ? '' : 's'} · value {usd(entry.value)}
              {entry.dueNow !== entry.total && <> · <b>due at entry {usd(entry.dueNow)}</b> (duty deferred)</>}</div></div>
          <div className="eff"><div className="label">Entry type · MOT</div><div className="mid">{entry.entryType} · {motCode(st)}</div></div>
        </div>
        <div className="tabs">
          <span className="spacer" />
          <button className="ghost" onClick={copyText} disabled={!ready.length}>Copy as text</button>
          <button className="ghost" onClick={downloadXlsx} disabled={!ready.length}>Excel</button>
          <button className="ghost" onClick={download} disabled={!ready.length}>CSV</button>
          <button className="ghost" onClick={() => print()} disabled={!ready.length}>Print</button>
        </div>
        {entry.warnings.length > 0 && <div className="defaults" role="note"><ul>{entry.warnings.map((w) => <li key={w}>{w}</li>)}</ul></div>}
        <table className="brokertable">
          <thead><tr><th>Line</th><th>Number</th><th>Rate</th><th>Qty</th><th>Duty</th></tr></thead>
          <tbody>
            {entry.lines.filter((l) => l.ok).map((l) => l.lines.map((x, j) => (
              <tr key={`${l.n}-${x.heading}`} className={j === 0 ? 'first' : ''}>
                <td>{j === 0 ? l.n : ''}</td><td className="code">{x.heading}</td>
                <td>{x.rate}{x.family === 'base' && l.input.claim ? ` · SPI ${l.input.claim}` : ''}</td>
                <td>{x.family === 'base' ? [l.input.quantity !== undefined ? `${l.input.quantity} ${l.line?.units[0] ?? ''}` : '', l.input.quantity2 !== undefined ? `${l.input.quantity2} ${l.line?.units[1] ?? ''}` : ''].filter(Boolean).join(' / ') : ''}</td>
                <td>{usd(x.amount)}</td></tr>
            )))}
            {entry.fees.map((f) => (
              <tr key={f.heading} className="fee"><td /><td>{f.heading}{FEE_CLASS[f.heading] ? ` · ${FEE_CLASS[f.heading]}` : ''}</td><td>{f.rate}</td><td /><td>{usd(f.amount)}{f.assumed ? ' *' : ''}</td></tr>
            ))}
          </tbody>
          <tfoot><tr><td colSpan={5}>Per line: Chapter 99 numbers first, the commodity number last (CSMS #69326983). MPF min/max applied once per entry. * needs quantities.</td></tr></tfoot>
        </table>
        {entry.lines.some((l) => l.ok && l.adcvd.some((o) => !o.broad)) && (
          <div className="adcvd"><div className="label">AD/CVD orders may apply (entry type 03)</div>
            <ul>{entry.lines.flatMap((l) => (l.ok ? l.adcvd.filter((o) => !o.broad).map((o) => <li key={`${l.n}-${o.case}`}>Line {l.n}: <b>{o.case}</b> ({o.type}) {o.product}</li>) : []))}</ul>
            <p>Deposit rates depend on the exporter and are not in the total.</p></div>
        )}
      </section>

      {pga && entry.lines.some((l) => l.ok && agenciesFor(pga, l.input.hts).length) && (
        <section className="panel agencies-entry">
          <div className="label">Partner agencies flagged by line</div>
          <ul>{entry.lines.filter((l) => l.ok && agenciesFor(pga, l.input.hts).length).map((l) => (
            <li key={l.n}>Line {l.n} <span className="code">{l.input.hts}</span>: {agenciesFor(pga, l.input.hts).map((a) => <span key={a} className="badge may">{a}</span>)}</li>
          ))}</ul>
          <p className="muted">From CBP's public partner-agency lists. FDA and some agencies don't publish complete lists, so check food, drugs, devices, cosmetics, vehicles and chemicals even when nothing is flagged.</p>
        </section>
      )}
      {paste !== null && (
        <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setPaste(null); }}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Paste lines">
            <div className="sheethead"><h2>Paste lines</h2><button className="icon" onClick={() => setPaste(null)} aria-label="Close">×</button></div>
            <p className="muted">One line per row: <b>HTS, country, value</b>, then optional <b>qty 1, qty 2, SPI</b>. Copy straight from Excel or Google Sheets (tabs), or use commas/semicolons. A header row is skipped.</p>
            <textarea autoFocus value={paste} onChange={(e) => setPaste(e.target.value)} rows={12} placeholder={'6109.10.00.12\tCN\t10000\t1200\t150\n9503.00.00.90\tTH\t2500'} />
            <div className="tabs"><span className="spacer" /><button className="ghost" onClick={() => setPaste(null)}>Cancel</button><button className="primary" onClick={doPaste}>Add lines</button></div>
          </div>
        </div>
      )}
    </div>
  );
}

/** ACE mode-of-transport code: vessel 10/11, rail 20/21, truck 30/31, air 40/41 (container = second), mail 50. */
function motCode(st: EntryState) {
  const base: Record<string, number> = { ocean: 10, rail: 20, truck: 30, air: 40 };
  return st.mode === 'mail' ? '50' : base[st.mode] !== undefined ? String(base[st.mode] + (st.containerized ? 1 : 0)) : '—';
}


function LineQuestion({ q, answers, quantities, set }: { q: Question; answers: Answers; quantities: Row; set: (p: Partial<Row>) => void }) {
  if (q.id === 'quantity' || q.id === 'quantity2') return (
    <div className="lq"><span>{q.text}</span><input inputMode="decimal" value={quantities[q.id]} onChange={(e) => set({ [q.id]: e.target.value.replace(/[^\d.]/g, '') })} /></div>
  );
  const id = q.id as keyof Answers;
  const cur = answers[id] ?? q.defaultValue;
  const setA = (v: unknown) => set({ answers: { ...answers, [id]: v } });
  return (
    <div className="lq"><span>{q.text}</span>
      {q.kind === 'yesno' && <div className="seg small" role="radiogroup" aria-label={q.text}>{[true, false].map((v) =>
        <button key={String(v)} role="radio" aria-checked={cur === v} className={cur === v ? 'on' : ''} onClick={() => setA(v)}>{v ? 'Yes' : 'No'}</button>)}</div>}
      {q.kind === 'choice' && (q.options ?? []).length > 4 && <select className="qselect" aria-label={q.text} value={String(cur ?? q.defaultValue)} onChange={(e) => setA(e.target.value)}>
        {(q.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}
      {q.kind === 'choice' && (q.options ?? []).length <= 4 && <div className="seg small" role="radiogroup" aria-label={q.text}>{(q.options ?? []).map((o) =>
        <button key={o.value} role="radio" aria-checked={cur === o.value} className={cur === o.value ? 'on' : ''} onClick={() => setA(o.value)}>{o.label}</button>)}</div>}
      {q.kind === 'text' && <input value={typeof answers[id] === 'string' ? (answers[id] as string) : ''} maxLength={2} placeholder="CN" style={{ width: 70 }}
        onChange={(e) => setA(e.target.value.toUpperCase().replace(/[^A-Z]/g, '') || undefined)} />}
      {q.kind === 'number' && <input inputMode="decimal" value={answers[id] === undefined ? '' : String(answers[id])} placeholder={String(q.defaultValue)}
        onChange={(e) => { const v = e.target.value.replace(/[^\d.]/g, ''); setA(v === '' ? undefined : Number(v)); }} />}
    </div>
  );
}
