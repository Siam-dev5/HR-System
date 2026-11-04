// Shared environment for the browser suites (tests/ui/*.mjs): repository root, browser, output folders, ports and
// screenshot comparison. Every suite starts its own local `wrangler dev` with a fresh local D1 under .tmp/ —
// nothing here talks to a remote database or to production.
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Browser executable, in order: CHROMIUM_PATH, the build that matches the installed playwright-core
 * (`npx playwright-core install chromium`, used in CI), else the newest Chromium already in the ms-playwright cache.
 * undefined lets playwright-core report its own "browser not installed" error.
 */
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    const own = chromium.executablePath();
    if (own && existsSync(own)) return own;
  } catch {
    /* not installed for this playwright-core version */
  }
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH
    || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')
      : process.platform === 'darwin' ? join(process.env.HOME ?? '', 'Library', 'Caches', 'ms-playwright')
        : join(process.env.HOME ?? '', '.cache', 'ms-playwright'));
  if (!existsSync(cache)) return undefined;
  const builds = readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  const rel = process.platform === 'win32' ? ['chrome-win64', 'chrome.exe'] : process.platform === 'darwin' ? ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'] : ['chrome-linux', 'chrome'];
  for (const b of builds) {
    const exe = join(cache, b, ...rel);
    if (existsSync(exe)) return exe;
  }
  return undefined;
}
export const EXE = findChromium();

/** Screenshots and other artefacts: .tmp/ui-results/<name> (gitignored), or $UI_RESULTS_DIR/<name>. */
export function outDir(name) {
  const dir = join(process.env.UI_RESULTS_DIR || join(ROOT, '.tmp', 'ui-results'), name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A free local TCP port, so suites never collide with each other or with a running dev server. */
export function freePort() {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => res(port));
    });
  });
}

/**
 * Pixel comparison of two PNG screenshots, decoded in the browser (no image library needed).
 * Returns { same: sizes equal, n: number of pixels whose RGB differs, size }; `exclude` = {x, y, w, h} is ignored.
 */
export async function pixelDiff(browser, pngA, pngB, exclude = null) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ({ a, b, exclude }) => {
      const load = (src) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
      const [x, y] = await Promise.all([load(a), load(b)]);
      const size = `${x.naturalWidth}x${x.naturalHeight} vs ${y.naturalWidth}x${y.naturalHeight}`;
      if (x.naturalWidth !== y.naturalWidth || x.naturalHeight !== y.naturalHeight) return { same: false, n: -1, size };
      const w = x.naturalWidth, h = x.naturalHeight;
      const px = (img) => { const c = new OffscreenCanvas(w, h); const g = c.getContext('2d', { colorSpace: 'srgb' }); g.drawImage(img, 0, 0); return g.getImageData(0, 0, w, h).data; };
      const da = px(x), db = px(y);
      let n = 0;
      for (let i = 0, p = 0; i < da.length; i += 4, p++) {
        if (exclude) { const cx = p % w, cy = (p / w) | 0; if (cx >= exclude.x && cx < exclude.x + exclude.w && cy >= exclude.y && cy < exclude.y + exclude.h) continue; }
        if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) n++;
      }
      return { same: true, n, size };
    }, { a: `data:image/png;base64,${pngA.toString('base64')}`, b: `data:image/png;base64,${pngB.toString('base64')}`, exclude });
  } finally {
    await page.close();
  }
}

/** Spawn options for the local `wrangler dev`: its own process group off Windows, so stopServer can end workerd too. */
export const SERVER_SPAWN = { cwd: ROOT, stdio: 'ignore', detached: process.platform !== 'win32' };

/** Stops a `wrangler dev` started with SERVER_SPAWN, including its workerd child. */
export function stopServer(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
}

/** Reads --name value / --flag arguments. */
export function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
}
