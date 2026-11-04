// Runs the browser suites one after another (they each start their own local wrangler dev + local D1) and records
// every suite's own exit code. Results: .tmp/ui-results/summary.json and one log per suite.
// usage: node tests/ui/run-all.mjs [--baseline <dir>] [--only ui-smoke,ui-auth,...]
//   --baseline is passed to ui-c3 and ui-d (see tests/ui/make-baseline.mjs); without it their comparisons are skipped.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, EXE, arg, outDir } from './lib/env.mjs';

const SUITES = ['ui-smoke', 'ui-auth', 'ui-header', 'ui-footer', 'ui-workstreams', 'ui-period-admin', 'ui-org', 'ui-avatar', 'ui-c3', 'ui-d'];
const only = arg('only');
const baseline = arg('baseline');
const selected = typeof only === 'string' ? only.split(',').map((s) => s.trim()) : SUITES;
const unknown = selected.filter((s) => !SUITES.includes(s));
if (unknown.length) {
  console.error(`unknown suite(s): ${unknown.join(', ')}`);
  process.exit(2);
}
if (!EXE) console.warn('no Chromium found: set CHROMIUM_PATH or run `npx playwright-core install chromium`');

const logs = outDir('logs');
const summary = [];
for (const name of selected) {
  const args = [join(ROOT, 'tests', 'ui', `${name}.mjs`)];
  if (baseline && (name === 'ui-c3' || name === 'ui-d')) args.push('--baseline', baseline);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const log = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  writeFileSync(join(logs, `${name}.log`), log);
  const count = (re) => (log.match(re) || []).length;
  const row = { suite: name, exit: r.status ?? (r.signal ? `signal ${r.signal}` : 'unknown'), pass: count(/^PASS /gm), fail: count(/^FAIL /gm), skip: count(/^SKIP /gm), seconds: Math.round((Date.now() - t0) / 1000) };
  summary.push(row);
  console.log(`${row.exit === 0 ? 'OK  ' : 'FAIL'} ${name.padEnd(16)} exit=${row.exit} pass=${row.pass} fail=${row.fail} skip=${row.skip} ${row.seconds}s`);
}
writeFileSync(join(outDir(''), 'summary.json'), JSON.stringify({ baseline: baseline ?? null, chromium: EXE ?? null, suites: summary }, null, 1));
process.exitCode = summary.every((r) => r.exit === 0) ? 0 : 1;
