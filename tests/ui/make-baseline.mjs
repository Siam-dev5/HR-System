// Builds a visual-regression baseline for ui-c3 / ui-d from a git ref: the SPA bundle (app.js, built exactly like
// scripts/build-web.mjs) and styles.css as they were at <ref>. Files are read with `git show` into .tmp — the index and
// the working tree are never touched.
// usage: node tests/ui/make-baseline.mjs <git-ref> [outDir]      (default outDir: .tmp/ui-baselines/<ref>)
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ROOT } from './lib/env.mjs';

const ref = process.argv[2];
if (!ref) {
  console.error('usage: node tests/ui/make-baseline.mjs <git-ref> [outDir]');
  process.exit(2);
}
const git = (args, opts = {}) => execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, ...opts });
const sha = git(['rev-parse', '--verify', `${ref}^{commit}`], { encoding: 'utf8' }).trim();
const out = process.argv[3] || join(ROOT, '.tmp', 'ui-baselines', ref.replace(/[^\w.-]/g, '_'));
const tree = join(out, 'tree');
rmSync(tree, { recursive: true, force: true });

const files = git(['ls-tree', '-r', '--name-only', sha, '--', 'src', 'public/assets/styles.css'], { encoding: 'utf8' }).split('\n').filter(Boolean);
for (const f of files) {
  const dest = join(tree, f);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, git(['show', `${sha}:${f}`]));
}
await build({
  entryPoints: [join(tree, 'src', 'web', 'main.ts')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  outfile: join(out, 'app.js'),
  nodePaths: [join(ROOT, 'node_modules')],   // dependencies resolve from this checkout
  logLevel: 'warning',
});
copyFileSync(join(tree, 'public', 'assets', 'styles.css'), join(out, 'styles.css'));
writeFileSync(join(out, 'SOURCE.txt'), `${ref} ${sha}\n`);
console.log(`baseline ${ref} (${sha.slice(0, 7)}) -> ${out}`);
