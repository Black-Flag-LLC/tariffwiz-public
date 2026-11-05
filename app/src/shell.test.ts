// index.html holds the page frame and paints before the JavaScript loads: the header as React first renders it (React
// swaps in the live one) and the intro line (static). If the header shell drifts from the component, the page visibly
// changes on load, so this compares them.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DARK_THEMES, THEMES, resolveTheme, themeInfo, validSettings } from './settings';
import { Masthead } from './ui/Masthead';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

describe('app shell', () => {
  it('index.html carries the header exactly as React first renders it', () => {
    const shell = html.match(/<!-- shell -->([\s\S]*?)<!-- \/shell -->/)?.[1].replace(/>\s+</g, '><').trim();
    const rendered = renderToStaticMarkup(createElement(Masthead, { view: 'quote' }));
    expect(shell, `paste this between <!-- shell --> and <!-- /shell --> in index.html:\n${rendered}\n`).toBe(rendered);
  });
  it('the header shell sits in #masthead, before the static intro and the React root', () => {
    expect(html).toMatch(/<div id="masthead">\s*<!-- shell -->[\s\S]*<!-- \/shell -->\s*<\/div>\s*<p class="lede">[^<]+<\/p>[\s\S]*<div id="root"><\/div>/);
  });
  it('applies the saved theme before the first paint, from the key the settings use', () => {
    const settings = readFileSync(new URL('./settings.ts', import.meta.url), 'utf8');
    const key = settings.match(/const KEY = '([^']+)'/)?.[1];
    expect(key).toBeTruthy();
    expect(html).toContain(`localStorage.getItem('${key}')`);
  });
  it('the inline theme script picks the same theme as settings.ts, for every kind of saved value', () => {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
    const list = (name: string) => JSON.parse(script.match(new RegExp(`var ${name} = (\\[[^\\]]*\\])`))![1].replace(/'/g, '"'));
    expect(list('THEMES')).toEqual(THEMES.map((t) => t.id));
    expect(list('DARK')).toEqual(DARK_THEMES);
    const saved: unknown[] = [null, 'not json', '"a string"', [], {}, { theme: 'synthwave' }, { theme: 'sunset', accent: 'rose' },
      { theme: 'system', systemLight: 'bubblegum', systemDark: 'terminal' }, { theme: 'system', systemLight: 'dark', systemDark: 'paper' },
      { theme: 'gone-theme', systemDark: 'blueprint' }, { theme: 'midnight', textSize: 'xlarge', reduceMotion: 'yes' }];
    for (const night of [false, true]) for (const v of saved) {
      const raw = v === null ? null : typeof v === 'string' ? v : JSON.stringify(v);
      const root = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
      runInNewContext(script, {
        localStorage: { getItem: () => raw }, document: { documentElement: root },
        matchMedia: (q: string) => ({ matches: q.includes('color-scheme: dark') ? night : false }),
      });
      let parsed: unknown = null;
      try { parsed = raw ? JSON.parse(raw) : null; } catch { /* stays null */ }
      const want = resolveTheme(validSettings(parsed), night);
      expect(root.dataset.theme, `${raw} night=${night}`).toBe(want);
      expect(root.style.colorScheme).toBe(themeInfo(want).dark ? 'dark' : 'light');
      expect(root.dataset.motion).toBe(validSettings(parsed).reduceMotion ? 'reduced' : 'full');
    }
  });
});
