import { describe, expect, it } from 'vitest';
import { resolveCountry } from './countries';
import { DEFAULT_SETTINGS, exportFile, importFile, parseMoney, resolveTheme, validHistory, validSettings } from './settings';

describe('input parsing (bug hunt #2)', () => {
  it('parseMoney accepts real amounts and shortcuts', () => {
    expect(parseMoney('10k')).toBe('10000');
    expect(parseMoney('$12,000')).toBe('12000');
    expect(parseMoney('1,234.56')).toBe('1234.56');
    expect(parseMoney('12.5k')).toBe('12500');
    expect(parseMoney('2.5m')).toBe('2500000');
  });
  it('parseMoney rejects ambiguous or invalid text', () => {
    for (const bad of ['1e5', '-5', '1.2.3', '1,2', '12k5', '$', '  ', 'abc']) expect(parseMoney(bad), bad).toBe('');
  });
  it('country aliases and codes resolve to valid ISO codes', () => {
    expect(resolveCountry('uk')).toBe('GB');
    expect(resolveCountry('UK')).toBe('GB');
    expect(resolveCountry('korea')).toBe('KR');
    expect(resolveCountry('turkey')).toBe('TR');
    expect(resolveCountry('vn')).toBe('VN');
    expect(resolveCountry('zz')).toBe('');
  });
});

describe('settings are robust to whatever is stored', () => {
  it('a bad value falls back on its own, keeping the good ones, and unknown fields are dropped', () => {
    const s = validSettings({ theme: 'synthwave', accent: 'plaid', textSize: 'xlarge', reduceMotion: 'yes', showHints: false,
      defaultCountry: 'ZZ', defaultValue: '-5', defaultMode: 'air', systemDark: 'paper', extra: 1 });
    expect(s).toEqual({ ...DEFAULT_SETTINGS, theme: 'synthwave', textSize: 'xlarge', showHints: false, defaultMode: 'air' });
    expect(Object.keys(s)).toEqual(Object.keys(DEFAULT_SETTINGS));
  });
  it('anything that is not a settings object gives the defaults', () => {
    for (const x of [null, undefined, 'dark', 42, [], ['theme'], true]) expect(validSettings(x), String(x)).toEqual(DEFAULT_SETTINGS);
  });
  it('version 1 settings (before day/night picks) keep everything they had', () => {
    const v1 = { theme: 'midnight', accent: 'teal', density: 'compact', textSize: 'large', reduceMotion: true, defaultCountry: 'CN',
      defaultMode: 'truck', defaultValue: '2500.50', defaultView: 'broker', rememberLast: true, keepHistory: false, showHints: false };
    expect(validSettings(v1)).toEqual({ ...v1, systemLight: 'light', systemDark: 'dark' });
  });
  it('"System" uses the day pick by day and the night pick at night', () => {
    const s = validSettings({ theme: 'system', systemLight: 'sunset', systemDark: 'terminal' });
    expect([resolveTheme(s, false), resolveTheme(s, true)]).toEqual(['sunset', 'terminal']);
    expect(resolveTheme({ ...s, theme: 'blueprint' }, false)).toBe('blueprint');
  });
  it('an exported file imports back to the same settings and history', () => {
    const s = validSettings({ theme: 'bubblegum', defaultCountry: 'VN', textSize: 'xlarge' });
    const h = { products: [{ code: '6109.10.00.12', desc: "Men's (338)" }], countries: ['VN', 'CN'] };
    expect(importFile(exportFile(s, h))).toEqual({ settings: s, history: h });
  });
  it('import refuses files that are not tariffwiz settings, and cleans what it accepts', () => {
    for (const t of ['', 'nope', '{}', '[]', '{"app":"other","kind":"settings","settings":{}}', '{"app":"tariffwiz","kind":"settings"}'])
      expect(importFile(t), t).toBeNull();
    const r = importFile(JSON.stringify({ app: 'tariffwiz', kind: 'settings', settings: { theme: 'nope', accent: 'rose' },
      history: { products: [{ code: '6109', desc: 5 }, { code: 'DROP TABLE', desc: 'x' }, { code: '8517.13', desc: 'phones' }], countries: ['CN', 'XX'] } }));
    expect(r?.settings).toEqual({ ...DEFAULT_SETTINGS, accent: 'rose' });
    expect(r?.history).toEqual({ products: [{ code: '8517.13', desc: 'phones' }], countries: ['CN'] });
  });
  it('history from storage drops malformed entries instead of breaking the page', () => {
    expect(validHistory({ products: [null, 'x', { code: '0101.21', desc: 'Horses' }], countries: 'CN' }))
      .toEqual({ products: [{ code: '0101.21', desc: 'Horses' }], countries: [] });
    expect(validHistory('junk')).toEqual({ products: [], countries: [] });
  });
});
