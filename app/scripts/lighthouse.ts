// Lighthouse on the built site (app/dist, served by `vite preview`) as a phone: performance, accessibility and best
// practices. Three runs: performance takes the median (it is a timing and wobbles); accessibility and best practices
// must be 100 on every run. Exits 1 when a score is below its floor.
// Usage (after `npx vite build`): npm run lighthouse   (CI: .github/workflows/ci.yml, job lighthouse)
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const LIGHTHOUSE = 'lighthouse@12.6.1';
const PORT = 4173;
const URL = `http://localhost:${PORT}/`;
const RUNS = 3;
const FLOOR = { performance: 0.9, accessibility: 1, 'best-practices': 1 } as const;
type Cat = keyof typeof FLOOR;
const win = process.platform === 'win32';

async function main() {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { shell: win, detached: !win, stdio: 'ignore' });
  const stop = () => {
    try { if (win) execFileSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' }); else process.kill(-server.pid!); } catch { /* gone */ }
  };
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(URL)).ok) break; } catch { /* not up yet */ }
      if (i > 60) throw new Error(`vite preview did not start on ${URL}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const runs: Record<Cat, number>[] = [];
    for (let i = 0; i < RUNS; i++) {
      const out = execFileSync('npx', ['--yes', LIGHTHOUSE, URL, '--quiet', '--output=json', '--output-path=stdout',
        '--only-categories=performance,accessibility,best-practices', '--chrome-flags=--headless=new --no-sandbox'],
      { shell: win, maxBuffer: 64 << 20, encoding: 'utf8' });
      const r = JSON.parse(out) as { categories: Record<Cat, { score: number }>; audits: Record<string, { score: number | null; title: string }> };
      runs.push(Object.fromEntries(Object.keys(FLOOR).map((k) => [k, r.categories[k as Cat].score])) as Record<Cat, number>);
      const failing = Object.values(r.audits).filter((a) => a.score !== null && a.score < 0.9).map((a) => a.title);
      console.log(`run ${i + 1}:`, runs[i], failing.length ? `\n  below 90: ${failing.join('; ')}` : '');
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const got: Record<Cat, number> = {
      performance: median(runs.map((r) => r.performance)),
      accessibility: Math.min(...runs.map((r) => r.accessibility)),
      'best-practices': Math.min(...runs.map((r) => r['best-practices'])),
    };
    const rows = (Object.keys(FLOOR) as Cat[]).map((k) => ({ k, got: Math.round(got[k] * 100), floor: FLOOR[k] * 100, ok: got[k] >= FLOOR[k] }));
    const table = ['| Lighthouse (phone) | Score | Floor |', '|---|---|---|', ...rows.map((r) => `| ${r.k} | ${r.ok ? '' : '❌ '}${r.got} | ${r.floor} |`)].join('\n');
    console.log(table);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n\nPerformance is the median of ${RUNS} runs; the others are the lowest.\n`);
    if (rows.some((r) => !r.ok)) process.exitCode = 1;
  } finally {
    stop();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
