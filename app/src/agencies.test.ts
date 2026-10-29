import { describe, expect, it } from 'vitest';
import { likelyAgencies } from './agencies';

const ids = (hts: string) => likelyAgencies(hts.replace(/\D/g, '')).map((h) => h.agency);

describe('agency hints where public flag lists are missing', () => {
  it('EPA pesticides (PST, EP5/EP6) on pesticide and pesticide-device headings', () => {
    expect(ids('8421.99.01.80')).toContain('EPA-PST');   // Zac's test case: filter/purifier part
    expect(ids('3808.94.50.00')).toContain('EPA-PST');   // disinfectant
    expect(ids('8543.70.99.00')).toContain('EPA-PST');   // UV/ozone generators, pest repellers
    expect(ids('8539.49.00.40')).toContain('EPA-PST');   // UV lamps
    expect(ids('6109.10.00.12')).not.toContain('EPA-PST');
  });
  it('EPA engines and vehicles stay a separate hint', () => {
    expect(ids('8407.34.05.00')).toContain('EPA');
    expect(ids('8407.34.05.00')).not.toContain('EPA-PST');
  });
});
