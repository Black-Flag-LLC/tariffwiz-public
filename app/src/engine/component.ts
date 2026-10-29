// Base rates the pipeline can't reduce to "% + per-unit": component values (watch cases, rifle sights,
// lead content), per-piece amounts, odd units (per jewel, per lin. m, per m2 of recording surface,
// per kg of total sugars), sugar priced by polarity degree, and rates that point at another article.
// Each needs a value the importer knows; we ask for it and compute.

export interface CompPart { kind: 'pct'; pct: number; on: string | null }       // on = component, null = full value
export interface CompSpec { kind: 'spec'; usd: number; per: string; over?: number } // per unit text; "over 7" for jewels
export interface Sugar { kind: 'sugar'; base: number; less: number; floor: number } // ¢/kg less ¢/kg per degree under 100, floor
export type Parsed = { parts: (CompPart | CompSpec | Sugar)[] } | { refer: string } | null;

const num = (s: string) => Number(s.replace(/\s/g, ''));
const usdOf = (dollar: string | undefined, n: string, cent: string | undefined) => (cent ? num(n) / 100 : dollar ? num(n) : num(n));

export function parseComponentRate(rawIn: string): Parsed {
  const raw = rawIn.replace(/\s+/g, ' ').replace(/¢ \//g, '¢/').trim();
  if (/ensemble/i.test(raw)) return { refer: 'This is a garment ensemble: each garment pays the rate of its own code. Price each garment separately.' };
  if (/article of which it is (a part|an accessory)|of which it is a part or accessory/i.test(raw))
    return { refer: 'This part pays the rate of the article it belongs to. Price it under that article\'s code.' };
  if (/in the set subject to the highest rate/i.test(raw)) return { refer: 'This set pays the rate of its highest-duty item. Price it under that item\'s code.' };
  if (/natural juice/i.test(raw)) return { refer: 'This pays the rate of the natural juice in heading 2009. Price it under that juice\'s code.' };
  if (/^See additional U\.S\. note/i.test(raw)) return { refer: `The rate is set by a chapter note (${raw}). Check that note for this product.` };
  if (/^Free, under bond/i.test(raw)) return { parts: [] };

  const sugar = raw.match(/^([\d.]+)¢\/kg less ([\d.]+)¢\/kg for each degree under 100 degrees.*not less than ([\d.]+)¢\/kg$/i);
  if (sugar) return { parts: [{ kind: 'sugar', base: num(sugar[1]), less: num(sugar[2]), floor: num(sugar[3]) }] };

  const parts: (CompPart | CompSpec)[] = [];
  for (const p of raw.split(/\s*\+\s*/)) {
    let m: RegExpMatchArray | null;
    if ((m = p.match(/^([\d.]+)%$/))) parts.push({ kind: 'pct', pct: num(m[1]), on: null });
    else if ((m = p.match(/^([\d.]+)% on (?:the )?(?:value of (?:the )?)?(.+?)(?:,? if any)?$/i))) parts.push({ kind: 'pct', pct: num(m[1]), on: m[2] });
    else if ((m = p.match(/^(\$)?([\d.]+) ?(¢|cents)? each$/i))) parts.push({ kind: 'spec', usd: usdOf(m[1], m[2], m[3]), per: 'piece' });
    else if ((m = p.match(/^(\$)?([\d.]+) ?(¢)?\/ ?jewel(?: over (\d+))?$/i)))
      parts.push({ kind: 'spec', usd: usdOf(m[1], m[2], m[3]), per: 'jewel', over: m[4] ? Number(m[4]) : 0 });
    else if ((m = p.match(/^(\$)?([\d.]+) ?(¢)?\/ ?(.+)$/))) parts.push({ kind: 'spec', usd: usdOf(m[1], m[2], m[3]), per: m[4].trim() });
    else return null;
  }
  return { parts };
}

/** A stable answer key for a component or unit, e.g. "comp:case", "comp:jewel". */
export const compKey = (name: string) => `comp:${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}` as const;
