// index.html holds the page frame and paints before the JavaScript loads: the header as React first renders it (React
// swaps in the live one) and the intro line (static). If the header shell drifts from the component, the page visibly
// changes on load, so this compares them.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
});
