// User settings and history, kept in this browser only (localStorage). No account, nothing sent anywhere.
import { useEffect, useState } from 'react';
import { COUNTRIES } from './countries';
import type { Mode } from './engine/types';

/** Every theme. `dark` sets the browser's colour scheme (scrollbars, date pickers) and which themes "System" may use at
 *  night; `fun` themes bring their own accent colour. index.html's inline script repeats the ids and the dark ones,
 *  and src/shell.test.ts checks both lists match this one. Colours: App.css; src/themes.test.ts checks contrast. */
export const THEMES = [
  { id: 'light', label: 'Light', dark: false },
  { id: 'paper', label: 'Paper', dark: false },
  { id: 'dark', label: 'Dark', dark: true },
  { id: 'midnight', label: 'Midnight', dark: true },
  { id: 'synthwave', label: 'Synthwave', dark: true, fun: '80s neon, after dark' },
  { id: 'terminal', label: 'Terminal', dark: true, fun: 'Green phosphor, all monospace' },
  { id: 'blueprint', label: 'Blueprint', dark: true, fun: 'Drafting-table blue on a grid' },
  { id: 'bubblegum', label: 'Bubblegum', dark: false, fun: 'Pink, sweet and polka-dotted' },
  { id: 'sunset', label: 'Sunset', dark: false, fun: 'Golden hour, all day' },
] as const satisfies readonly { id: string; label: string; dark: boolean; fun?: string }[];
export type ThemeId = (typeof THEMES)[number]['id'];
export type Theme = 'system' | ThemeId;
export type ThemeInfo = { id: ThemeId; label: string; dark: boolean; fun?: string };
export const themeInfo = (id: ThemeId): ThemeInfo => (THEMES as readonly ThemeInfo[]).find((t) => t.id === id)!;
const THEME_IDS: ThemeId[] = THEMES.map((t) => t.id);
export const LIGHT_THEMES: ThemeId[] = THEMES.filter((t) => !t.dark).map((t) => t.id);
export const DARK_THEMES: ThemeId[] = THEMES.filter((t) => t.dark).map((t) => t.id);

export const ACCENTS = ['blue', 'violet', 'teal', 'amber', 'rose'] as const;
export type Accent = (typeof ACCENTS)[number];
export const TEXT_SIZES = [{ v: 'normal', label: 'Normal' }, { v: 'large', label: 'Large' }, { v: 'xlarge', label: 'Larger' }] as const;
type TextSize = (typeof TEXT_SIZES)[number]['v'];

export interface Settings {
  theme: Theme;
  systemLight: ThemeId;    // what "System" shows by day
  systemDark: ThemeId;     // and at night
  accent: Accent;
  density: 'comfortable' | 'compact';
  textSize: TextSize;
  reduceMotion: boolean;
  defaultCountry: string;
  defaultMode: Mode;
  defaultValue: string;
  defaultView: 'explained' | 'broker';
  rememberLast: boolean;   // reopen the last shipment instead of a blank form
  keepHistory: boolean;    // recent products and countries
  showHints: boolean;      // keyboard hints on buttons
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system', systemLight: 'light', systemDark: 'dark', accent: 'blue', density: 'comfortable', textSize: 'normal',
  reduceMotion: false, defaultCountry: '', defaultMode: 'ocean', defaultValue: '10000', defaultView: 'explained',
  rememberLast: false, keepHistory: true, showHints: true,
};

// The key's name is historical; `version` inside is the schema version (2 added systemLight/systemDark and xlarge text).
// index.html applies the saved theme before the first paint (an inline script reading KEY); useSettings keeps it current.
const KEY = 'tariffwiz.settings.v1';
const VERSION = 2;
const HIST = 'tariffwiz.history.v1';
const LAST = 'tariffwiz.last.v1';

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const one = <T,>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Settings from anything (storage, an imported file, an older version): every field is checked on its own, so one bad
 *  value falls back to its default without losing the rest, and unknown fields are dropped. */
export function validSettings(x: unknown): Settings {
  const o = isObj(x) ? x : {};
  const d = DEFAULT_SETTINGS;
  const value = o.defaultValue;
  return {
    theme: one<Theme>(o.theme, ['system', ...THEME_IDS], d.theme),
    systemLight: one(o.systemLight, LIGHT_THEMES, d.systemLight),
    systemDark: one(o.systemDark, DARK_THEMES, d.systemDark),
    accent: one(o.accent, ACCENTS, d.accent),
    density: one(o.density, ['comfortable', 'compact'] as const, d.density),
    textSize: one<TextSize>(o.textSize, TEXT_SIZES.map((t) => t.v), d.textSize),
    reduceMotion: bool(o.reduceMotion, d.reduceMotion),
    defaultCountry: o.defaultCountry === '' || COUNTRIES.some((c) => c.code === o.defaultCountry) ? (o.defaultCountry as string) : d.defaultCountry,
    defaultMode: one(o.defaultMode, ['ocean', 'air', 'truck', 'rail', 'mail', 'other'] as const, d.defaultMode),
    defaultValue: typeof value === 'string' && /^\d{1,12}(\.\d{1,2})?$/.test(value) && Number(value) > 0 ? value : d.defaultValue,
    defaultView: one(o.defaultView, ['explained', 'broker'] as const, d.defaultView),
    rememberLast: bool(o.rememberLast, d.rememberLast),
    keepHistory: bool(o.keepHistory, d.keepHistory),
    showHints: bool(o.showHints, d.showHints),
  };
}

/** The theme on screen: the chosen one, or for "System" the day or night pick. */
export const resolveTheme = (s: Pick<Settings, 'theme' | 'systemLight' | 'systemDark'>, night: boolean): ThemeId =>
  s.theme !== 'system' ? s.theme : night ? s.systemDark : s.systemLight;

const parse = (raw: string | null): unknown => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };
const read = <T,>(k: string, fallback: T): T => {
  try { const v = parse(localStorage.getItem(k)); return isObj(v) ? { ...fallback, ...v } : fallback; } catch { return fallback; }
};
/** false when the browser refuses to store (private mode, storage full or blocked). */
const write = (k: string, v: unknown): boolean => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } };
/** Whether this browser keeps what the page stores (checked once: it does not change during a visit). */
const storageWorks = () => { try { localStorage.setItem('tariffwiz.probe', '1'); localStorage.removeItem('tariffwiz.probe'); return true; } catch { return false; } };
const readSettings = (): Settings => { try { return validSettings(parse(localStorage.getItem(KEY))); } catch { return DEFAULT_SETTINGS; } };
/** The stored form: the same fields in the same order every time, so a tab writing back what another tab wrote is a no-op. */
const stored = (s: Settings) => ({ version: VERSION, ...validSettings(s) });

function applyToPage(s: Settings) {
  const theme = resolveTheme(s, matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.accent = s.accent;
  root.dataset.density = s.density;
  root.dataset.text = s.textSize;
  root.dataset.motion = s.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full';
  root.style.colorScheme = themeInfo(theme).dark ? 'dark' : 'light';
  // the phone's browser bar takes the theme's background (next frame: reading styles now would force a layout)
  requestAnimationFrame(() => {
    const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
    if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  });
}

/** Settings, a function to change some of them, and whether this browser is keeping them. */
export function useSettings() {
  const [s, setS] = useState<Settings>(readSettings);
  const [saved] = useState(storageWorks);
  useEffect(() => {
    write(KEY, stored(s));
    if (!s.rememberLast) { try { localStorage.removeItem(LAST); } catch { /* ignore */ } }
    applyToPage(s);
  }, [s]);
  // another tab changed them: follow it, so two open tabs never undo each other's changes
  useEffect(() => {
    const on = (e: StorageEvent) => { if (e.key === KEY || e.key === null) setS(readSettings()); };
    addEventListener('storage', on);
    return () => removeEventListener('storage', on);
  }, []);
  // "System" follows the OS between day and night
  useEffect(() => {
    if (s.theme !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => applyToPage(s);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [s]);
  const set = (patch: Partial<Settings>) => setS((x) => validSettings({ ...x, ...patch }));
  return [s, set, saved] as const;
}

/** A settings file: settings plus recent products and countries, to move them to another browser. */
export function exportFile(s: Settings, h: History): string {
  return JSON.stringify({ app: 'tariffwiz', kind: 'settings', version: VERSION, exported: new Date().toISOString().slice(0, 10),
    settings: stored(s), history: validHistory(h) }, null, 2);
}
/** The settings (and history, when present) in a file from exportFile; null when it is not one. */
export function importFile(text: string): { settings: Settings; history?: History } | null {
  const f = parse(text);
  if (!isObj(f) || f.app !== 'tariffwiz' || f.kind !== 'settings' || !isObj(f.settings)) return null;
  return { settings: validSettings(f.settings), history: isObj(f.history) ? validHistory(f.history) : undefined };
}

export interface History { products: { code: string; desc: string }[]; countries: string[] }
/** History from anything: products need a code and a text description, countries a known ISO code. */
export function validHistory(x: unknown): History {
  const h = isObj(x) ? x : {};
  return {
    products: Array.isArray(h.products)
      ? h.products.filter((p): p is History['products'][number] => isObj(p) && typeof p.code === 'string' && /^[\d.]{4,13}$/.test(p.code)
        && typeof p.desc === 'string').map((p) => ({ code: p.code, desc: p.desc.slice(0, 200) })).slice(0, 8) : [],
    countries: Array.isArray(h.countries) ? h.countries.filter((c): c is string => COUNTRIES.some((k) => k.code === c)).slice(0, 6) : [],
  };
}
export const readHistory = (): History => validHistory(read<unknown>(HIST, null));
export const saveHistory = (h: History): History => { const v = validHistory(h); write(HIST, v); return v; };
export function remember(h: History, product?: { code: string; desc: string }, country?: string): History {
  const next: History = {
    products: product ? [product, ...h.products.filter((p) => p.code !== product.code)].slice(0, 8) : h.products,
    countries: country ? [country, ...h.countries.filter((c) => c !== country)].slice(0, 6) : h.countries,
  };
  write(HIST, next);
  return next;
}
export const clearHistory = (): History => { write(HIST, { products: [], countries: [] }); return { products: [], countries: [] }; };
export const saveLast = (q: string) => { try { localStorage.setItem(LAST, q); } catch { /* ignore */ } };
export const readLast = () => { try { return localStorage.getItem(LAST) ?? ''; } catch { return ''; } };

/** "10k", "2.5m", "$12,000", "1,250.50" -> "10000", "2500000", "12000", "1250.5"; '' when not a number. */
export function parseMoney(s: string): string {
  const t = s.trim().toLowerCase().replace(/[$\s]/g, '');
  // commas only as thousands separators ("1,234.56"); "1,2", "1e5", "-5", "1.2.3" are rejected
  if (!/^(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?[km]?$/.test(t) || !/\d/.test(t)) return '';
  const m = t.replace(/,/g, '').match(/^(\d*\.?\d+)([km]?)$/);
  if (!m) return '';
  const n = Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '';
}
