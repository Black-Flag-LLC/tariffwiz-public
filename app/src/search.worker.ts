// Product search, off the page's main thread: parsing ~20,000 lines and indexing them takes most of a second on a
// phone, which would freeze taps and typing. Talks to src/searchClient.ts.
import { buildIndex, search } from './search';
import type { Leaf } from './data';

export type Request = { id: number; load: string } | { id: number; q: string; limit?: number };
export type Reply = { id: number; ok: true; hits?: ReturnType<typeof search> } | { id: number; ok: false; error: string };

const post = (m: Reply) => (self as unknown as { postMessage(m: Reply): void }).postMessage(m);

self.onmessage = async (e: MessageEvent<Request>) => {
  const m = e.data;
  try {
    if ('load' in m) {
      const r = await fetch(m.load);
      if (!r.ok) throw new Error(`search.json ${r.status}`);
      buildIndex((await r.json()) as Leaf[]);
      post({ id: m.id, ok: true });
    } else {
      post({ id: m.id, ok: true, hits: search(m.q, m.limit) });
    }
  } catch (err) {
    post({ id: m.id, ok: false, error: String(err) });
  }
};
