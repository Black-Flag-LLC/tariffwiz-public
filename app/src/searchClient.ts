// The page's side of the product search, which runs in a worker (src/search.worker.ts).
import type { Hit } from './search';
import type { Reply, Request } from './search.worker';

let worker: Worker | null = null;
let loaded: Promise<void> | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();

function ask(m: Omit<Request, 'id'>): Promise<Reply> {
  worker ??= start();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ ...m, id });
  });
}

function start() {
  const w = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
  w.onmessage = (e: MessageEvent<Reply>) => { pending.get(e.data.id)?.resolve(e.data); pending.delete(e.data.id); };
  w.onerror = () => { // the worker died: fail what is waiting, and let the next load start a new one
    for (const p of pending.values()) p.reject(new Error('search worker failed'));
    pending.clear(); w.terminate(); worker = null; loaded = null;
  };
  return w;
}

/** Load and index the product list (search.json at this absolute URL). Resolves when search() will answer. */
export function loadProductSearch(url: string): Promise<void> {
  loaded ??= ask({ load: url }).then((r) => { if (!r.ok) throw new Error(r.error); })
    .catch((e) => { loaded = null; throw e; }); // a later call retries
  return loaded;
}

/** The best matches for what was typed (an HTS code prefix or product words). */
export async function searchProducts(q: string, limit?: number): Promise<Hit[]> {
  const r = await ask({ q, limit });
  if (!r.ok) throw new Error(r.error);
  return r.hits ?? [];
}
