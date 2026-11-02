// Bundles the SPA (src/web) into public/assets/app.js.
import { build } from 'esbuild';

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
