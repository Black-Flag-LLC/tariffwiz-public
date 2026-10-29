import { describe, expect, it } from 'vitest';
import { resolveCountry } from './countries';
import { parseMoney } from './settings';

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
