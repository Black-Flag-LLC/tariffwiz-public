// Every theme, with every accent colour, keeps its text readable: WCAG AA 4.5:1 for every pairing of text and
// background the app uses. The colours are read from App.css the way the browser cascades them, so a new theme or a
// tweaked colour that slips below AA fails here (Lighthouse only ever sees the default theme).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACCENTS, THEMES } from './settings';

const css = readFileSync(new URL('./App.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Top-level rules (selectors and custom properties); @media and @keyframes blocks are skipped. */
function rules() {
  const out: { sel: string[]; vars: Record<string, string> }[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) break;
    const sel = css.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (depth && j < css.length) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
    if (!sel.startsWith('@')) {
      const vars: Record<string, string> = {};
      for (const m of css.slice(open + 1, j - 1).matchAll(/(--[\w-]+)\s*:\s*([^;]+)/g)) vars[m[1]] = m[2].trim();
      out.push({ sel: sel.split(',').map((s) => s.trim()), vars });
    }
    i = j;
  }
  return out;
}
const RULES = rules();

/** The custom properties on <html> for a theme and accent, in cascade order (:root, theme, accent, theme+accent). */
function tokens(theme: string, accent: string) {
  const t: Record<string, string> = {};
  const take = (sels: string[]) => { for (const r of RULES) if (r.sel.some((s) => sels.includes(s))) Object.assign(t, r.vars); };
  take([':root']);
  take([`[data-theme='${theme}']`]);
  take([`[data-accent='${accent}']`]);
  take([`[data-theme='${theme}'][data-accent='${accent}']`, `[data-theme='${theme}'][data-accent]`]);
  return t;
}

const rgb = (hex: string) => {
  const h = hex.replace('#', '');
  const f = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  return [0, 2, 4].map((k) => parseInt(f.slice(k, k + 2), 16));
};
const lum = (hex: string) => {
  const [r, g, b] = rgb(hex).map((c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [text, background]: every pairing the stylesheet uses for text
const BACKGROUNDS = ['--bg', '--bg2', '--panel', '--hover'];
const PAIRS: [string, string][] = [
  ...['--ink', '--muted', '--subtle'].flatMap((t) => BACKGROUNDS.map((b) => [t, b] as [string, string])),
  ['--accent', '--panel'], ['--accent', '--bg'], ['--accent', '--hover'], ['--accent', '--accent-bg'],   // links, badges
  ['--on-accent', '--accent'],                                                                       // primary buttons
  ['--ink', '--accent-bg'], ['--muted', '--accent-bg'],                                              // highlighted search hit
  ['--warn', '--warn-bg'], ['--good', '--good-bg'], ['--err', '--panel'], ['--err', '--bg'],         // notices, errors
  ['--good', '--hover'], ['--up', '--hover'],                                                        // "the other answer saves / adds"
  ['--ink', '--mark'], ['--bg', '--ink'],                                                            // highlights, toast and total bar
];

describe('theme contrast (WCAG AA, 4.5:1)', () => {
  for (const theme of THEMES) {
    const accents = 'fun' in theme ? ['blue'] : ACCENTS;
    for (const accent of accents) {
      it(`${theme.label}${'fun' in theme ? '' : ` + ${accent}`}`, () => {
        const t = tokens(theme.id, accent);
        const bad: string[] = [];
        for (const [fg, bg] of PAIRS) {
          const a = t[fg], b = t[bg];
          if (!/^#[\da-f]{3,6}$/i.test(a ?? '') || !/^#[\da-f]{3,6}$/i.test(b ?? '')) { bad.push(`${fg} on ${bg}: missing (${a} / ${b})`); continue; }
          const c = contrast(a, b);
          if (c < 4.5) bad.push(`${fg} ${a} on ${bg} ${b}: ${c.toFixed(2)}`);
        }
        expect(bad).toEqual([]);
      });
    }
  }
  it('a fun theme brings its own accent, whatever accent is picked', () => {
    for (const theme of THEMES.filter((t) => 'fun' in t)) {
      const first = tokens(theme.id, ACCENTS[0]);
      for (const a of ACCENTS) expect(tokens(theme.id, a)['--accent'], `${theme.id} ${a}`).toBe(first['--accent']);
    }
  });
  it('every fun theme sets every colour itself, so nothing leaks in from Light', () => {
    const light = RULES.find((r) => r.sel.includes(`[data-theme='light']`))!.vars;
    const colours = Object.keys(light).filter((k) => /^#/.test(light[k]));
    for (const theme of THEMES.filter((t) => 'fun' in t)) {
      const own = RULES.find((r) => r.sel.includes(`[data-theme='${theme.id}'][data-accent]`))?.vars ?? {};
      expect(colours.filter((k) => !(k in own)), theme.id).toEqual([]);
    }
  });
});
