// User settings and history, kept in this browser only (localStorage). No account, nothing sent anywhere.
import { useEffect, useState } from 'react';
import type { Mode } from './engine/types';

export type Theme = 'system' | 'light' | 'dark' | 'midnight' | 'paper';
export type Accent = 'blue' | 'violet' | 'teal' | 'amber' | 'rose';

export interface Settings {
  theme: Theme;
  accent: Accent;
  density: 'comfortable' | 'compact';
  textSize: 'normal' | 'large';
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
  theme: 'system', accent: 'blue', density: 'comfortable', textSize: 'normal', reduceMotion: false,
  defaultCountry: '', defaultMode: 'ocean', defaultValue: '10000', defaultView: 'explained',
  rememberLast: false, keepHistory: true, showHints: true,
};

const KEY = 'tariffwiz.settings.v1';
const pick = <T,>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
function validSettings(x: Settings): Settings {
  const d = DEFAULT_SETTINGS;
  return { ...x, theme: pick(x.theme, ['system', 'light', 'dark', 'midnight', 'paper'] as const, d.theme),
    accent: pick(x.accent, ['blue', 'violet', 'teal', 'amber', 'rose'] as const, d.accent),
    density: pick(x.density, ['comfortable', 'compact'] as const, d.density), textSize: pick(x.textSize, ['normal', 'large'] as const, d.textSize),
    defaultMode: pick(x.defaultMode, ['ocean', 'air', 'truck', 'rail', 'mail', 'other'] as const, d.defaultMode),
    defaultView: pick(x.defaultView, ['explained', 'broker'] as const, d.defaultView),
    defaultCountry: typeof x.defaultCountry === 'string' && /^[A-Z]{2}$|^$/.test(x.defaultCountry) ? x.defaultCountry : '',
    defaultValue: typeof x.defaultValue === 'string' && /^\d+(\.\d+)?$/.test(x.defaultValue) ? x.defaultValue : d.defaultValue };
}
/** Apply the saved theme before React renders (no light flash for dark-theme users). */
export function applySavedTheme() {
  const s = validSettings(read(KEY, DEFAULT_SETTINGS));
  const dark = s.theme === 'dark' || s.theme === 'midnight' || (s.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.theme = s.theme === 'system' ? (dark ? 'dark' : 'light') : s.theme;
  root.dataset.accent = s.accent; root.dataset.density = s.density; root.dataset.text = s.textSize;
}
const HIST = 'tariffwiz.history.v1';
const LAST = 'tariffwiz.last.v1';

const read = <T,>(k: string, fallback: T): T => {
  try { const v = localStorage.getItem(k); return v ? { ...fallback, ...JSON.parse(v) } : fallback; } catch { return fallback; }
};
const write = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: ignore */ } };

export function useSettings() {
  const [s, setS] = useState<Settings>(() => validSettings(read(KEY, DEFAULT_SETTINGS)));
  useEffect(() => {
    write(KEY, s);
    if (!s.rememberLast) { try { localStorage.removeItem(LAST); } catch { /* ignore */ } }
    const root = document.documentElement;
    const dark = s.theme === 'dark' || s.theme === 'midnight' || (s.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
    root.dataset.theme = s.theme === 'system' ? (dark ? 'dark' : 'light') : s.theme;
    root.dataset.accent = s.accent;
    root.dataset.density = s.density;
    root.dataset.text = s.textSize;
    root.dataset.motion = s.reduceMotion || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduced' : 'full';
    root.style.colorScheme = dark ? 'dark' : 'light';
  }, [s]);
  // follow the OS when theme is "system"
  useEffect(() => {
    if (s.theme !== 'system') return;
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setS((x) => ({ ...x }));
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [s.theme]);
  return [s, (patch: Partial<Settings>) => setS((x) => ({ ...x, ...patch }))] as const;
}

export interface History { products: { code: string; desc: string }[]; countries: string[] }
export const readHistory = (): History => {
  const h = read<History>(HIST, { products: [], countries: [] });
  return { products: Array.isArray(h.products) ? h.products.filter((p) => p && typeof p.code === 'string').slice(0, 8) : [],
    countries: Array.isArray(h.countries) ? h.countries.filter((c) => typeof c === 'string').slice(0, 6) : [] };
};
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
