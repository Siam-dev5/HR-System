// Sign-in screens + page content (local only, synthetic users):
//  1. sign-in screens (login, register, forced MFA, forced password), light + dark, 1440 / 1024 / 768 / 375: overflow,
//     logo metrics, test hooks, stacking, dark logo plate, console errors; with a baseline also the baseline's overflow
//  2. page CONTENT of the signed-in app must be pixel-identical to the baseline (light + dark, 1440 + 375, 8 pages, plus
//     a dialog and the empty state). The app shell (sidebar, header, footer, skip link) is hidden in BOTH captures, so a
//     shell redesign is not compared here (ui-d covers the shell); the content must match to the pixel, and the <main>
//     box must be identical. Without --baseline these checks are SKIPPED and reported as such.
//  3. with --ref <png>: side-by-side image of the Login reference and the current Login (no assertion, evidence only)
// usage: node tests/ui/ui-c3.mjs [--baseline <dir with styles.css + app.js>] [--ref <png>] [--out <dir>]
//        a baseline dir comes from tests/ui/make-baseline.mjs
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, pixelDiff, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('c3');
const SNAP = arg('baseline');
const REF = arg('ref');
mkdirSync(OUT, { recursive: true });
const snapCss = SNAP ? readFileSync(join(SNAP, 'styles.css'), 'utf8') : null;
const snapJs = SNAP ? readFileSync(join(SNAP, 'app.js'), 'utf8') : null;
// content comparison, applied to BOTH captures: the shell around page content is hidden (layout kept), and the page's
// background gradient image is switched off (its background colour stays). Chrome dithers that gradient by ±1 level
// depending on earlier rasterisation in the tab, which made identical content differ by 1 level in the light theme.
const HIDE_SHELL = '.sidebar,.topbar,#site-footer,.skip-link,#toasts{visibility:hidden!important}body{background-image:none!important}';
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `c3-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const pw = {};
for (const [user, extra] of [['c_admin', ['--role', 'super_admin']], ['c_mfa', ['--role', 'super_admin']], ['c_pw', ['--role', 'hr_manager', '--must-change']]]) {
  pw[user] = `Cc-${randomBytes(9).toString('base64url')}-7q`;
  const f = join(persist, `${user}.sql`);
  run(['scripts/create-user.mjs', '--username', user, '--display', 'ทดสอบ ' + user, '--out', f, '--cred-file', join(persist, `${user}.txt`), ...extra], { NEW_USER_PASSWORD: pw[user] });
  run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', f]);
}
const port = await freePort();
const dev = spawn(process.execPath, [W, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', `MFA_ENCRYPTION_KEY:${randomBytes(32).toString('base64')}`, '--show-interactive-dev-session=false'], SERVER_SPAWN);
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

const b32 = (secret) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of secret.replace(/\s/g, '')) bits += A.indexOf(c).toString(2).padStart(5, '0'); return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2))); };
let lastStep = 0;
async function totp(secret) {   // each 30 s step is single-use: wait for a fresh one
  let step = Math.floor(Date.now() / 30000);
  while (step <= lastStep) { await new Promise((r) => setTimeout(r, 1000)); step = Math.floor(Date.now() / 30000); }
  lastStep = step;
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', b32(secret)).update(msg).digest(); const o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

const VIEWPORTS = [['1440', 1440, 900], ['1024', 1024, 768], ['768', 768, 1024], ['375', 375, 740]];
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const skipped = [];
const skip = (name, why) => { skipped.push(name); console.log(`SKIP  ${name}  — ${why}`); };
const errors = [];
const browser = await chromium.launch({ executablePath: EXE });

async function newPage(variant, theme, viewport) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, locale: 'th-TH' });
  await ctx.addInitScript((t) => { try { localStorage.setItem('hr.theme', t); } catch { /* none */ } }, theme);
  if (variant === 'before') {
    await ctx.route('**/assets/styles.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: snapCss }));
    await ctx.route('**/assets/app.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: snapJs }));
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${variant}/${theme}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${variant}/${theme}: ${m.text()}`); });
  return { ctx, page };
}
const settle = async (page) => { await page.waitForTimeout(600); await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur()); await page.waitForTimeout(200); };
const metrics = (page) => page.evaluate(() => {
  const img = document.querySelector('.auth-logo-img'); const box = document.querySelector('.auth-logo');
  const r = img?.getBoundingClientRect();
  return {
    overflow: document.documentElement.scrollWidth - innerWidth,
    logo: img ? { loaded: img.complete && img.naturalWidth > 0, natural: [img.naturalWidth, img.naturalHeight], shown: [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10], alt: img.alt, plate: getComputedStyle(box).backgroundColor, plateImg: getComputedStyle(box).backgroundImage.slice(0, 40) } : null,
    oldMark: !!document.querySelector('.auth-logo-mark, .auth-logo-text'),
    hooks: ['input[name=username]', 'input[name=password]', 'button.auth-submit', '.auth-card'].filter((s) => document.querySelector(s)).length,
    stacked: innerWidth <= 960 ? document.querySelector('.auth-brand').getBoundingClientRect().bottom <= document.querySelector('.auth-card').getBoundingClientRect().top + 1 : null,
  };
});

try {
  // ---- 1. sign-in screens ----
  if (!SNAP) skip('baseline sign-in screens (overflow)', 'no --baseline given');
  for (const variant of SNAP ? ['before', 'after'] : ['after']) {
    for (const theme of ['light', 'dark']) {
      for (const path of ['/login', '/register']) {
        const { ctx, page } = await newPage(variant, theme, { width: 1440, height: 900 });
        await page.goto(BASE + path); await page.waitForSelector('.auth-card');
        for (const [vp, w, h] of VIEWPORTS) {
          await page.setViewportSize({ width: w, height: h }); await settle(page);
          const m = await metrics(page);
          await page.screenshot({ path: join(OUT, `${variant}-${theme}-${vp}${path.replace('/', '-')}.png`), fullPage: true });
          check(`${variant} ${theme} ${vp} ${path}: no horizontal overflow`, m.overflow <= 0, `overflow=${m.overflow}`);
          if (variant === 'after') {
            check(`after ${theme} ${vp} ${path}: logo loaded, ≤200px, never upscaled, alt text, no old HR mark`, m.logo?.loaded && m.logo.shown[0] <= 200 && m.logo.shown[0] <= m.logo.natural[0] && m.logo.alt === 'โลโก้ SIAM HRBP' && !m.oldMark, JSON.stringify(m.logo));
            if (theme === 'dark') check(`after dark ${vp} ${path}: logo sits on a white plate`, m.logo?.plate === 'rgb(255, 255, 255)', m.logo?.plate);
            if (path === '/login') check(`after ${theme} ${vp} login: test hooks present`, m.hooks === 4);
            if (m.stacked !== null) check(`after ${theme} ${vp} ${path}: brand stacked above the card`, m.stacked);
          }
        }
        await ctx.close();
      }
      // forced password (hr_manager with must-change) and forced MFA (super_admin, not enrolled)
      for (const [user, name, sel] of [['c_pw', 'forced-password', 'input[type=password]'], ['c_mfa', 'forced-mfa', 'button:has-text("เริ่มตั้งค่า MFA")']]) {
        const { ctx, page } = await newPage(variant, theme, { width: 1440, height: 900 });
        await page.goto(BASE + '/login'); await page.waitForSelector('input[name=username]');
        await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw[user]);
        await page.click('button.auth-submit');
        await page.waitForSelector(`.auth-card ${sel}`);
        await page.waitForTimeout(400);
        for (const [vp, w, h] of VIEWPORTS) {
          await page.setViewportSize({ width: w, height: h }); await settle(page);
          const m = await metrics(page);
          await page.screenshot({ path: join(OUT, `${variant}-${theme}-${vp}-${name}.png`), fullPage: true });
          check(`${variant} ${theme} ${vp} ${name}: no horizontal overflow`, m.overflow <= 0, `overflow=${m.overflow}`);
          if (variant === 'after') check(`after ${theme} ${vp} ${name}: logo ≤200px on the shared brand panel`, m.logo?.loaded && m.logo.shown[0] <= 200);
        }
        await ctx.close();
      }
    }
  }

  // ---- 2. page content: working tree vs baseline, same session ----
  let secret = null;
  const PAGES = [['dashboard', '/dashboard'], ['employees', '/employees'], ['payroll', '/payroll'], ['users', '/admin/users'], ['settings', '/admin/settings'], ['audit', '/audit'], ['leave', '/leave'], ['attendance-import', '/attendance/import']];
  if (!SNAP) skip('page content vs baseline (36 comparisons)', 'no --baseline given');
  for (const theme of SNAP ? ['light', 'dark'] : []) {
    const { ctx, page } = await newPage('after', theme, { width: 1440, height: 900 });
    await page.goto(BASE + '/login'); await page.waitForSelector('input[name=username]');
    await page.fill('input[name=username]', 'c_admin'); await page.fill('input[name=password]', pw.c_admin);
    await page.click('button.auth-submit');
    await page.waitForSelector('nav.sidebar, button:has-text("เริ่มตั้งค่า MFA"), input[name=totp]:visible');
    if (await page.$('button:has-text("เริ่มตั้งค่า MFA")')) {
      await page.click('button:has-text("เริ่มตั้งค่า MFA")');
      secret = (await page.textContent('code.secret')).trim();
      await page.fill('.mfa-setup input', await totp(secret)); await page.click('text=ยืนยันและเปิดใช้');
    } else { await page.fill('input[name=totp]', await totp(secret)); await page.click('button.auth-submit'); }
    await page.waitForSelector('nav.sidebar');
    const before = await ctx.newPage();   // same session, baseline assets
    await before.route('**/assets/styles.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: snapCss }));
    await before.route('**/assets/app.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: snapJs }));
    // content capture: shell hidden (layout kept); a dialog is captured over the whole viewport, a page as its <main> box
    const shoot = async (p, vp, path, extra, dialog) => {
      await p.setViewportSize({ width: vp[1], height: vp[2] });
      await p.goto(BASE + path);
      await p.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .loading'));
      if (extra) await extra(p);
      await p.addStyleTag({ content: HIDE_SHELL });
      await p.waitForTimeout(400);
      const box = await p.evaluate(() => { const r = document.querySelector('main').getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) }; });
      const img = dialog ? await p.screenshot({ animations: 'disabled', caret: 'hide' }) : await p.screenshot({ fullPage: true, clip: box, animations: 'disabled', caret: 'hide' });
      return { img, box };
    };
    const cases = [];
    for (const vp of [VIEWPORTS[0], VIEWPORTS[3]]) for (const [name, path] of PAGES) cases.push([`${name}-${vp[0]}`, vp, path, null, false]);
    cases.push(['dialog-1440', VIEWPORTS[0], '/employees', async (p) => { await p.waitForFunction(() => document.querySelector('main .table, main .empty')); await p.click('main .toolbar .btn.primary'); await p.waitForSelector('.modal'); }, true]);
    cases.push(['empty-1440', VIEWPORTS[0], '/employees', async (p) => { await p.fill('main .toolbar input[type=search]', 'zz-no-such-row-xyz'); await p.waitForTimeout(800); }, false]);
    for (const [name, vp, path, extra, dialog] of cases) {
      const a = await shoot(page, vp, path, extra, dialog), b = await shoot(before, vp, path, extra, dialog);
      const d = await pixelDiff(browser, a.img, b.img);
      const sameBox = JSON.stringify(a.box) === JSON.stringify(b.box);
      check(`content ${theme} ${name}: identical to baseline (${dialog ? 'dialog over hidden shell' : '<main>'})`, d.same && d.n === 0 && sameBox,
        d.same ? `${d.n} px differ, box ${sameBox ? 'same' : `${JSON.stringify(a.box)} vs ${JSON.stringify(b.box)}`}` : d.size);
      if (!d.same || d.n || !sameBox) { writeFileSync(join(OUT, `content-${theme}-${name}-current.png`), a.img); writeFileSync(join(OUT, `content-${theme}-${name}-baseline.png`), b.img); }
    }
    await ctx.close();
  }

  // ---- 3. reference comparison (evidence only): page area of the reference is 1766 x 805 (browser chrome above y=86) ----
  if (REF && existsSync(REF)) {
    const { ctx, page } = await newPage('after', 'light', { width: 1766, height: 805 });
    await page.goto(BASE + '/login'); await page.waitForSelector('.auth-card'); await settle(page);
    const ours = (await page.screenshot()).toString('base64');
    const ref = readFileSync(REF).toString('base64');
    await page.setViewportSize({ width: 1766, height: 805 * 2 + 20 });
    await page.setContent(`<body style="margin:0;background:#888"><div style="width:1766px;height:805px;overflow:hidden"><img style="display:block;margin-top:-86px" src="data:image/png;base64,${ref}"></div><img style="display:block;margin-top:20px" src="data:image/png;base64,${ours}"></body>`);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    await page.screenshot({ path: join(OUT, 'compare-reference-vs-current-1766.png') });
    await ctx.close();
  } else skip('reference side-by-side image', REF ? `${REF} not found` : 'no --ref given');
} finally {
  await browser.close();
  stopServer(dev);
}
check('no console errors / page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-c3 pass=${results.length - fail} fail=${fail} skip=${skipped.length}`);
process.exitCode = fail ? 1 : 0;
