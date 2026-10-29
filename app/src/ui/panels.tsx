import { COUNTRIES } from '../countries';
import type { Answers, Mode, Question } from '../engine/types';
import { DEFAULT_SETTINGS, type Accent, type Settings, type Theme } from '../settings';
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

const THEMES: { v: Theme; label: string }[] = [
  { v: 'system', label: 'System' }, { v: 'light', label: 'Light' }, { v: 'paper', label: 'Paper' },
  { v: 'dark', label: 'Dark' }, { v: 'midnight', label: 'Midnight' },
];
const ACCENTS: Accent[] = ['blue', 'violet', 'teal', 'amber', 'rose'];

export function SettingsPanel({ s, set, onClose, clear, data }: { s: Settings; set: (p: Partial<Settings>) => void; onClose: () => void;
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
