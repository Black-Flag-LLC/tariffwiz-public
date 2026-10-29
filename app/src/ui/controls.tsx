import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { COUNTRIES, countryName, resolveCountry } from '../countries';
import { parseMoney } from '../settings';
import { COMMON } from '../form';

/** Number field with a text draft: "13." stays while typing, only valid numbers reach the engine. */
export function NumInput({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder?: string; label?: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input inputMode="decimal" value={draft ?? value} placeholder={placeholder} aria-label={label}
      onFocus={() => setDraft(value)} onBlur={() => setDraft(null)}
      onChange={(e) => { const t = e.target.value.replace(/[^\d.]/g, ''); setDraft(t); if (/^\d*\.?\d*$/.test(t) && t !== '.') onChange(t.replace(/\.$/, '')); }} />
  );
}

export function MoneyInput({ id, value, onChange, inputRef, placeholder = '10,000' }: { id?: string; value: string; onChange: (v: string) => void;
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
export function CountryPicker({ id, value, onPick, recent, inputRef }: { id: string; value: string; onPick: (iso: string) => void; recent: string[];
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

/** Count up to a number (skipped when motion is reduced). */
export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
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

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => <button key={o.v} role="radio" aria-checked={value === o.v} className={value === o.v ? 'on' : ''} onClick={() => onChange(o.v)}>{o.label}</button>)}
    </div>
  );
}

export function Toggle({ on, onChange, label, sub }: { on: boolean; onChange: (v: boolean) => void; label: string; sub?: string }) {
  return (
    <label className="toggle"><span><b>{label}</b>{sub && <small>{sub}</small>}</span>
      <input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} /><i aria-hidden="true" /></label>
  );
}

export function Logo() {
  return (
    <svg viewBox="0 0 32 32" className="logo" aria-hidden="true">
      <rect x="3" y="3" width="26" height="26" rx="8" fill="var(--accent)" />
      <path d="M10 11h12M16 11v11M11 17.5l2.5 4.5M21 17.5 18.5 22" stroke="var(--on-accent)" strokeWidth="2.4" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="gear"><circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
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
