import type { Ref } from 'react';
import { GearIcon, Logo } from './controls';

type View = 'quote' | 'entry';

/** The header. index.html carries this markup, unrendered, as the app shell (with the intro line, which is static and
 *  stays there), so the page paints before the JavaScript has loaded; App swaps this in before its first paint.
 *  src/shell.test.ts fails when the two differ and prints the markup to paste in. */
export function Masthead({ view, setView, checked, onHelp, onSettings, ref }: {
  view: View; setView?: (v: View) => void; checked?: string; onHelp?: () => void; onSettings?: () => void; ref?: Ref<HTMLElement>;
}) {
  return (
    <header className="top" ref={ref}>
      <div className="brand"><Logo /><span>tariffwiz</span></div>
      <div className="seg viewswitch" role="tablist" aria-label="Mode">
        <button role="tab" aria-selected={view === 'quote'} className={view === 'quote' ? 'on' : ''} onClick={() => setView?.('quote')} title="One product (Q)">Quote</button>
        <button role="tab" aria-selected={view === 'entry'} className={view === 'entry' ? 'on' : ''} onClick={() => setView?.('entry')} title="Multi-line entry for brokers (E)">Entry</button>
      </div>
      <div className="topright">
        <Fresh checked={checked} title="Rates come from the official tariff schedule plus Federal Register and CBP guidance" />
        <button className="icon" onClick={onHelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)">?</button>
        <button className="icon" onClick={onSettings} aria-label="Settings" title="Settings (,)"><GearIcon /></button>
      </div>
    </header>
  );
}

/** "Rules current to …": in the header, or (className "fresh line") under the intro on phones, where the header has no room. */
export function Fresh({ checked, title, className = 'fresh' }: { checked?: string; title?: string; className?: string }) {
  return <span className={className} title={title}><i aria-hidden="true" />{` Rules current to ${checked ?? '…'}`}</span>;
}
