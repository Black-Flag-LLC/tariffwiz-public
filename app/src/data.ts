// Static data loading (files built by pipeline/build_rules.py into public/data/).
import { digitsOf, findLine, ListIndex } from './engine/calc';
import type { HtsLine, Rules } from './engine/types';

const BASE = `${import.meta.env.BASE_URL}data/`;

let rulesP: Promise<{ rules: Rules; idx: ListIndex }> | null = null;
export function loadRules() {
  rulesP ??= fetch(`${BASE}rules.json`).then((r) => { if (!r.ok) throw new Error(`rules.json ${r.status}`); return r.json(); })
    .then((rules: Rules) => ({ rules, idx: new ListIndex(rules.lists) }))
    .catch((e) => { rulesP = null; throw e; }); // let a later call retry
  return rulesP;
}

const shards = new Map<string, Promise<HtsLine[]>>();
export async function loadLine(hts: string): Promise<HtsLine | undefined> {
  const d = digitsOf(hts);
  const ch = d.slice(0, 2);
  if (!shards.has(ch)) shards.set(ch, fetch(`${BASE}hts/ch${ch}.json`).then((r) => (r.ok ? r.json() : []))
    .catch((e) => { shards.delete(ch); throw e; }));
  return findLine(await shards.get(ch)!, d);
}

export type Leaf = [code: string, desc: string, path: string, rate: string];
let searchP: Promise<Leaf[]> | null = null;
export function loadSearch() {
  searchP ??= fetch(`${BASE}search.json`).then((r) => { if (!r.ok) throw new Error(`search.json ${r.status}`); return r.json(); })
    .catch((e) => { searchP = null; throw e; });
  return searchP;
}

export interface PgaFlag { agency: string; agencyName: string; program: string; level: string; meaning: string; url?: string }
export interface Pga { flags: Record<string, PgaFlag>; hts: Record<string, string[]>; checked: string }
let pgaP: Promise<Pga | null> | null = null;
/** Partner Government Agency flags by HTS (display only). */
/** Written daily by the tariff-watch workflow (pipeline/watch.py --status): actions published since the rules were reviewed. */
export interface Status {
  rulesChecked: string;
  revision: string;
  latestRevision: { name: string; title: string; from: string } | null;
  pending: { doc: string; title: string; type: string; date: string; url: string; inspection: boolean }[];
}
let statusP: Promise<Status | null> | null = null;
export function loadStatus() {
  statusP ??= fetch(`${BASE}status.json`, { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return statusP;
}

export function loadPga() {
  pgaP ??= fetch(`${BASE}pga.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return pgaP;
}
