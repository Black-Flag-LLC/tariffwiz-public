import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { countryName } from '../countries';
import type { Pga, Status } from '../data';
import { likelyAgencies } from '../agencies';
import type { Line, Result } from '../engine/types';
import { FEE_CLASS, MOT } from '../engine/entry';
import { usd, MODES, FAMILY, type Form, fmtDate } from '../form';

/** Tariff actions published (or filed for publication) since the rules were last reviewed, and a newer HTS revision.
 *  Shown on every view so a quote never silently misses a change. */
export function StaleBanner({ s }: { s: Status }) {
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


/** Animates the total toward its new value (off with reduced motion). */
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

export function Receipt({ r, form, broker, setBroker, copySummary, copyLink, reduceMotion, hint }: { r: Result; form: Form; broker: boolean;
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

/** Partner Government Agencies that may (or must) clear this product, from CBP's HTS flags. */
export function Agencies({ pga, code }: { pga: Pga | null; code: string }) {
  if (!pga) return null;
  const d = code.replace(/\D/g, '');
  const hints = likelyAgencies(d);
  const fdaHint = hints.length > 0;
  const keys = [...new Set([d, d.slice(0, 8), d.slice(0, 6), d.slice(0, 4)])];
  const flags = [...new Set(keys.flatMap((k) => pga.hts[k] ?? []))].map((f) => ({ code: f, ...pga.flags[f] })).filter((f) => f.agency);
  if (!flags.length && !fdaHint) return (
    <div className="agencies none"><div className="label">Other agencies</div>
      <p>No partner-agency flags found for this code in the public lists. Some agencies (FDA among them) don't publish complete lists, so check if your product is food, a drug, a device, a cosmetic, a vehicle, a chemical or a pesticide.</p></div>
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
