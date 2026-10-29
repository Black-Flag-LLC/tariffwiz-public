// Plain-English search: everyday product words must surface the right tariff heading in the top results.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildIndex, search } from './search';

buildIndex(JSON.parse(readFileSync(new URL('../public/data/search.json', import.meta.url), 'utf8')));

const CASES: [query: string, prefixes: string[]][] = [
  ['laptop', ['8471.30']], ['smartphone', ['8517.13']], ['sneakers', ['6404.11', '6402.91', '6402.99', '6403.91', '6403.99']], ['hoodie', ['6110']],
  ['jeans', ['6203.42', '6204.62']], ['sofa', ['9401.61', '9401.71']], ['solar panel', ['8541.43']],
  ['lithium battery', ['8507.60']], ['drone', ['8806']], ['red wine', ['2204']], ['steel bolts', ['7318.15']],
  ['cotton t-shirts', ['6109.10']], ['upholstered wooden chairs', ['9401.61']], ['video game console', ['9504.50']],
  ['coffee', ['0901']], ['handbag leather', ['4202.21']], ['tires', ['4011']], ['bicycle', ['8712']],
  ['refrigerator', ['8418']], ['6109', ['6109']],
];

describe('plain-English search', () => {
  for (const [q, prefixes] of CASES) {
    it(`"${q}" → ${prefixes.join(' / ')} in top 8`, () => {
      const top = search(q, 8).map((h) => h.code);
      expect(top.some((c) => prefixes.some((p) => c.startsWith(p))), `top: ${top.join(', ')}`).toBe(true);
    });
  }
});
