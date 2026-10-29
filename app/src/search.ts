// Offline product search over HTS descriptions. No library: word-prefix matching with simple ranking.
import type { Leaf } from './data';
import { SYNONYMS } from './synonyms';

export interface Hit { code: string; desc: string; path: string; rate: string; score: number }

// "t-shirt" -> "tshirt" so the hyphenated product name stays one word
const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/\b([a-z])-(?=[a-z])/g, '$1').replace(/[^a-z0-9 ]+/g, ' ');
// crude plural folding so "shirts" finds "shirt" and "boxes" finds "box"
const stem = (w: string) => (w.length > 4 && w.endsWith('es') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

// stemmed everyday word -> list of stemmed phrases the schedule uses
let SYN: Map<string, string[][]> | null = null;
function syn() {
  SYN ??= new Map(Object.entries(SYNONYMS).map(([k, v]) => [stem(norm(k).trim()), v.map((p) => norm(p).split(' ').filter(Boolean).map(stem))]));
  return SYN;
}

interface Doc { leaf: Leaf; digits: string; desc: string[]; path: string[]; head: string[]; tail: string[]; parts: boolean }
let docs: Doc[] = [];

// "Other aircraft (…, except unmanned aircraft of heading 8806)" must not match "unmanned aircraft"
const dropExcept = (p: string) => p.replace(/\([^)]*\b(except|other than)\b[^)]*\)/gi, ' ').replace(/\b(except|other than)\b[^;:>]*/gi, ' ');

export function buildIndex(leaves: Leaf[]) {
  docs = leaves.map((leaf) => ({ leaf, digits: leaf[0].replace(/\D/g, ''),
    desc: norm(leaf[1]).split(' ').filter(Boolean).map(stem), path: norm(dropExcept(leaf[2])).split(' ').filter(Boolean).map(stem),
    head: norm(dropExcept(leaf[2].split(' > ')[0] ?? '')).split(' ').filter(Boolean).map(stem),
    tail: norm(dropExcept(leaf[2].split(' > ').slice(-2).join(' '))).split(' ').filter(Boolean).map(stem),
    parts: /\bparts?\b|accessories/i.test(leaf[2] + ' ' + leaf[1]) }));
}

export function search(q: string, limit = 25): Hit[] {
  const digits = q.replace(/[\s.]/g, '');
  if (/^\d{2,10}$/.test(digits)) {
    return docs.filter((d) => d.digits.startsWith(digits)).slice(0, limit)
      .map((d) => ({ code: d.leaf[0], desc: d.leaf[1], path: d.leaf[2], rate: d.leaf[3], score: 0 }));
  }
  const terms = queryTerms(q);
  if (!terms.length) return [];
  const wantsParts = terms.some((t) => t.startsWith('part') || t.startsWith('accessor'));
  const has = (ws: string[], t: string) => ws.some((w) => w.startsWith(t));
  // score one term against one line: description 3, nearest headings 2, wider path 1, everyday-word phrase +2
  const termScore = (d: Doc, t: string): number => {
    let best = has(d.desc, t) ? 4 : has(d.tail, t) ? 2 : has(d.path, t) ? 1 : 0;
    let inHead = has(d.head, t);
    for (const [i, alt] of (syn().get(t) ?? []).entries()) {
      if (!alt.every((a) => has(d.desc, a) || has(d.path, a))) continue;
      const where = alt.some((a) => has(d.desc, a)) ? 4 : alt.some((a) => has(d.tail, a)) ? 2 : 1;
      best = Math.max(best, where + Math.max(0.5, 2.5 - i)); // earlier phrases are the more specific meaning
      inHead ||= alt.some((a) => has(d.head, a));
    }
    if (best && inHead) best += 2; // the heading itself names the product
    if (best && (d.desc.includes(t) || d.path.includes(t))) best += 1; // whole-word bonus
    return best;
  };
  const rank = (minTerms: number) => {
    const out: Hit[] = [];
    for (const d of docs) {
      let score = 0;
      let matched = 0;
      for (const t of terms) {
        const s1 = termScore(d, t);
        if (s1) { matched++; score += s1; } else if (minTerms === terms.length) break;
      }
      if (matched < minTerms) continue;
      if (/^other\b/i.test(d.leaf[1])) score -= 0.5; // prefer named lines over "Other"
      if (d.parts && !wantsParts) score -= 3; // people searching a product rarely mean its parts
      out.push({ code: d.leaf[0], desc: d.leaf[1], path: d.leaf[2], rate: d.leaf[3], score: score - d.path.length / 200 });
    }
    return out;
  };
  let out = rank(terms.length);
  // nothing matches every word (e.g. "red wine": the schedule's "Red" heading is missing) -> best partial matches
  if (!out.length && terms.length > 1) out = rank(Math.ceil(terms.length / 2));
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Normalised search terms, also used to highlight matches. */
export function queryTerms(q: string) {
  return norm(q).split(' ').filter((t) => t.length > 1).map(stem);
}

/** Query terms plus the schedule words they stand for — for highlighting. */
export function highlightTerms(q: string) {
  const t = queryTerms(q);
  return [...t, ...t.flatMap((x) => (syn().get(x) ?? []).flat())];
}

/** Split text into [plain, matched] runs for highlighting words that start with a search term. */
export function highlight(text: string, terms: string[]): { t: string; m: boolean }[] {
  if (!terms.length) return [{ t: text, m: false }];
  return text.split(/(\s+)/).map((w) => {
    const n = stem(norm(w).trim());
    return { t: w, m: !!n && terms.some((t) => n.startsWith(t)) };
  });
}
