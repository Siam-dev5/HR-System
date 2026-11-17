// Bundles the SPA (src/web) into public/assets/app.js and publishes the UI dictionaries
// (src/web/i18n/<lang>.json → public/assets/i18n/<lang>.json, loaded only when that language is chosen).
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

await build({
  entryPoints: ['src/web/main.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  outfile: 'public/assets/app.js',
  logLevel: 'info',
});

mkdirSync('public/assets/i18n', { recursive: true });
for (const lang of ['en', 'zh']) {
  const src = `src/web/i18n/${lang}.json`;
  const dict = existsSync(src) ? JSON.parse(readFileSync(src, 'utf8')) : {};
  writeFileSync(`public/assets/i18n/${lang}.json`, JSON.stringify(dict));
  console.log(`  public/assets/i18n/${lang}.json  ${Object.keys(dict).length} strings`);
}
