import { COUNTRIES } from '../countries';
import type { Answers, Mode, Question } from '../engine/types';
import { useEffect, useRef, useState } from 'react';
import { ACCENTS, DARK_THEMES, DEFAULT_SETTINGS, LIGHT_THEMES, TEXT_SIZES, THEMES, resolveTheme, themeInfo, type Accent, type Settings, type ThemeId } from '../settings';
import { usd0, MODES, EXAMPLES, type Form, type Data } from '../form';
import { NumInput, MoneyInput, Sheet, Seg, Toggle } from './controls';

export function QuestionField({ q, form, set, stake }: { q: Question; form: Form; set: (p: Partial<Form>) => void; stake: number | null }) {
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

export function Empty({ onPick }: { onPick: (x: (typeof EXAMPLES)[number]) => void }) {
  return (
    <div className="empty">
      <h2>Start with your product</h2>
      <p>Search by name or HTS code. You'll see the total, the effective rate, and why each charge applies.</p>
      <div className="label">Or try one</div>
      <div className="examples">{EXAMPLES.map((x) => <button key={x.label} onClick={() => onPick(x)}>{x.label}</button>)}</div>
    </div>
  );
}

/** A theme as a card that previews itself: data-theme (and the chosen accent) on the card applies that theme's colours. */
function ThemeCard({ id, accent, on, onPick }: { id: ThemeId; accent: Accent; on: boolean; onPick: () => void }) {
  const t = themeInfo(id);
  return (
    <button type="button" role="radio" aria-checked={on} className="themecard" data-theme={id} data-accent={accent} onClick={onPick}>
      <span className="tc-panel" aria-hidden="true"><b>$3,697</b><i /><span /></span>
      <span className="tc-name">{t.label}{t.fun && <small>{t.fun}</small>}</span>
    </button>
  );
}

export function SettingsPanel({ s, set, saved, onClose, clear, data, onExport, onImport }: {
  s: Settings; set: (p: Partial<Settings>) => void; saved: boolean; onClose: () => void; clear: () => void; data: Data | null;
  onExport: () => void; onImport: (text: string) => void;
}) {
  const shown = themeInfo(resolveTheme(s, matchMedia('(prefers-color-scheme: dark)').matches));
  const [confirmReset, setConfirmReset] = useState(false);
  useEffect(() => {
    if (!confirmReset) return;
    const t = setTimeout(() => setConfirmReset(false), 4000);
    return () => clearTimeout(t);
  }, [confirmReset]);
  const file = useRef<HTMLInputElement>(null);
  return (
    <Sheet title="Settings" onClose={onClose}>
      {!saved && <p className="setnote warn" role="status">This browser isn't saving settings (a private window, or storage is turned off), so they reset when it closes.</p>}
      <section className="setgroup">
        <h3>Theme</h3>
        <div className="themes" role="radiogroup" aria-label="Theme">
          <button type="button" role="radio" aria-checked={s.theme === 'system'} className="themecard system" onClick={() => set({ theme: 'system' })}
            aria-label={`System: ${themeInfo(s.systemLight).label} by day, ${themeInfo(s.systemDark).label} at night`}>
            {[s.systemLight, s.systemDark].map((id, i) => (
              <span key={i} data-theme={id} data-accent={s.accent} aria-hidden="true">
                <span className="tc-panel"><b>{i ? '☾' : '☀'}</b><i /><span /></span>
                <span className="tc-name">{i ? <small>follows your device</small> : 'System'}</span>
              </span>
            ))}
          </button>
          {THEMES.map((t) => <ThemeCard key={t.id} id={t.id} accent={s.accent} on={s.theme === t.id} onPick={() => set({ theme: t.id })} />)}
        </div>
        {s.theme === 'system' && <>
          <div className="setrow"><span>By day</span>
            <select value={s.systemLight} onChange={(e) => set({ systemLight: e.target.value as ThemeId })} aria-label="Theme by day">
              {LIGHT_THEMES.map((id) => <option key={id} value={id}>{themeInfo(id).label}</option>)}
            </select></div>
          <div className="setrow"><span>At night</span>
            <select value={s.systemDark} onChange={(e) => set({ systemDark: e.target.value as ThemeId })} aria-label="Theme at night">
              {DARK_THEMES.map((id) => <option key={id} value={id}>{themeInfo(id).label}</option>)}
            </select></div>
        </>}
        <div className="setrow"><span>Accent</span>
          <div className="swatches" role="radiogroup" aria-label="Accent colour">
            {ACCENTS.map((a) => <button key={a} role="radio" aria-checked={s.accent === a} aria-label={a} disabled={!!shown.fun}
              className={`swatch ${a} ${s.accent === a ? 'on' : ''}`} onClick={() => set({ accent: a })} />)}
          </div></div>
        {shown.fun && <p className="setnote">{shown.label} brings its own colours; the accent applies to Light, Paper, Dark and Midnight.</p>}
        <div className="setrow"><span>Density</span><Seg label="Density" value={s.density} options={[{ v: 'comfortable', label: 'Comfortable' }, { v: 'compact', label: 'Compact' }]} onChange={(v) => set({ density: v })} /></div>
        <div className="setrow"><span>Text size</span><Seg label="Text size" value={s.textSize} options={TEXT_SIZES.map((t) => ({ v: t.v, label: t.label }))} onChange={(v) => set({ textSize: v })} /></div>
        <Toggle on={s.reduceMotion} onChange={(v) => set({ reduceMotion: v })} label="Reduce motion" sub="No animated totals, transitions or blinking." />
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
      <section className="setgroup">
        <h3>Your settings</h3>
        <p className="setnote">They stay in this browser and follow you between its tabs. To use them in another browser, save them to a file and load it there.</p>
        <div className="setactions">
          <button className="ghost" onClick={onExport}>Save to a file</button>
          <button className="ghost" onClick={() => file.current?.click()}>Load from a file</button>
          <input ref={file} type="file" accept=".json,application/json" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void f.text().then(onImport); }} />
          <button className={`ghost ${confirmReset ? 'danger' : ''}`} aria-live="polite"
            onClick={() => { if (confirmReset) { set({ ...DEFAULT_SETTINGS }); setConfirmReset(false); } else setConfirmReset(true); }}>
            {confirmReset ? 'Click again to restore defaults' : 'Restore default settings'}
          </button>
        </div>
      </section>
      <section className="setgroup about">
        <h3>About the data</h3>
        <p>Tariff schedule {data?.rules.meta.revision ?? '…'}, rules checked {data?.rules.meta.checked ?? '…'}. Everything runs in your browser; settings and history never leave this device.</p>
      </section>
    </Sheet>
  );
}

export function HelpPanel({ onClose }: { onClose: () => void }) {
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
