// App shell verification (local only, synthetic users). With --baseline <dir> (styles.css + app.js, see
// tests/ui/make-baseline.mjs) it also compares the working tree ("after") with that baseline ("before", served via route).
//  A. app shell: light + dark x 1440/1024/768/375 x 8 pages — overflow, sidebar 260px, logo <=150px (never upscaled,
//     white plate in dark), exactly one aria-current = current path, rendered contrast >= 4.5 (text, group, active,
//     hover), header tap targets >= 40px on mobile, footer solid + fixed + z 50, console errors
//  B. <main> content identical to the baseline (shell hidden in both captures, so only module content is compared)
//  C. sign-in screens identical to the baseline with the same footer style in both captures
//  D. drawer (<=900), skip link, keyboard focus, reduced motion, print, high-DPI logo (2x image on 2x screens)
//  B and C need --baseline; without it they are SKIPPED and reported as such.
// usage: node tests/ui/ui-d.mjs [--baseline <dir>] [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, pixelDiff, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('d');
const SNAP = arg('baseline');
mkdirSync(OUT, { recursive: true });
const snapCss = SNAP ? readFileSync(join(SNAP, 'styles.css'), 'utf8') : null;
const snapJs = SNAP ? readFileSync(join(SNAP, 'app.js'), 'utf8') : null;
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `d-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const pw = `Dd-${randomBytes(9).toString('base64url')}-7q`;
const uf = join(persist, 'u.sql');
run(['scripts/create-user.mjs', '--username', 'd_admin', '--display', 'ทดสอบ d_admin', '--out', uf, '--cred-file', join(persist, 'c.txt'), '--role', 'super_admin'], { NEW_USER_PASSWORD: pw });
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', uf]);
const port = await freePort();
const dev = spawn(process.execPath, [W, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', `MFA_ENCRYPTION_KEY:${randomBytes(32).toString('base64')}`, '--show-interactive-dev-session=false'], SERVER_SPAWN);
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

const b32 = (s) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of s.replace(/\s/g, '')) bits += A.indexOf(c).toString(2).padStart(5, '0'); return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2))); };
let lastStep = 0;
async function totp(secret) {   // each 30 s step is single-use: wait for a fresh one
  let step = Math.floor(Date.now() / 30000);
  while (step <= lastStep) { await new Promise((r) => setTimeout(r, 1000)); step = Math.floor(Date.now() / 30000); }
  lastStep = step;
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', b32(secret)).update(msg).digest(); const o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const rgb = (s) => (s.match(/[\d.]+/g) || []).map(Number);
const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
const contrast = (fg, bg) => { const [a, b] = [lum(rgb(fg)), lum(rgb(bg))].sort((x, y) => y - x); return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100; };

const VIEWPORTS = [['1440', 1440, 900], ['1024', 1024, 768], ['768', 768, 1024], ['375', 375, 740]];
const PAGES = [['dashboard', '/dashboard'], ['employees', '/employees'], ['payroll', '/payroll'], ['attendance-import', '/attendance/import'], ['users', '/admin/users'], ['settings', '/admin/settings'], ['audit', '/audit'], ['leave', '/leave']];
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const skipped = [];
const skip = (name, why) => { skipped.push(name); console.log(`SKIP  ${name}  — ${why}`); };
const errors = [];
const browser = await chromium.launch({ executablePath: EXE });
const watch = (page, tag) => { page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); }); };
const useSnapshot = async (target) => {
  await target.route('**/assets/styles.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: snapCss }));
  await target.route('**/assets/app.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: snapJs }));
};
const settled = async (p) => { await p.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .loading')); await p.waitForTimeout(350); };

let secret = null;
async function signIn(page) {
  await page.goto(BASE + '/login'); await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', 'd_admin'); await page.fill('input[name=password]', pw);
  await page.click('button.auth-submit');
  await page.waitForSelector('nav.sidebar, button:has-text("เริ่มตั้งค่า MFA"), input[name=totp]:visible');
  if (await page.$('button:has-text("เริ่มตั้งค่า MFA")')) {
    await page.click('button:has-text("เริ่มตั้งค่า MFA")');
    secret = (await page.textContent('code.secret')).trim();
    await page.fill('.mfa-setup input', await totp(secret)); await page.click('text=ยืนยันและเปิดใช้');
  } else if (await page.$('input[name=totp]:visible')) { await page.fill('input[name=totp]', await totp(secret)); await page.click('button.auth-submit'); }
  await page.waitForSelector('nav.sidebar');
}

try {
  // ---------- C. sign-in screens vs baseline ----------
  if (!SNAP) skip('sign-in screens vs baseline (8 comparisons)', 'no --baseline given');
  // The approved footer change is neutralised by giving BOTH captures the same footer style: the old glass footer's
  // backdrop-filter changes page compositing (text anti-aliasing everywhere), so excluding its box is not enough.
  // With identical footers the whole screen, footer included, must match the baseline exactly.
  const SAME_FOOTER = '#site-footer{background:#1e3a5f!important;-webkit-backdrop-filter:none!important;backdrop-filter:none!important;border-top-color:rgb(255 255 255/10%)!important}';
  for (const theme of ['light', 'dark']) for (const [vp, w, h] of [VIEWPORTS[0], VIEWPORTS[3]]) for (const path of ['/login', '/register']) {
    const shots = [];
    for (const variant of SNAP ? ['before', 'after'] : ['after']) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, locale: 'th-TH' });
      await ctx.addInitScript((t) => { try { localStorage.setItem('hr.theme', t); } catch { /* none */ } }, theme);
      if (variant === 'before') await useSnapshot(ctx);
      const p = await ctx.newPage(); watch(p, `auth-${variant}`);
      await p.goto(BASE + path); await p.waitForSelector('.auth-card'); await p.waitForTimeout(600);
      if (variant === 'after') writeFileSync(join(OUT, `after-${theme}-${vp}${path.replace('/', '-')}.png`), await p.screenshot());
      await p.addStyleTag({ content: SAME_FOOTER });
      await p.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur()); await p.waitForTimeout(250);
      shots.push(await p.screenshot());
      await ctx.close();
    }
    if (!SNAP) continue;
    const d = await pixelDiff(browser, shots[0], shots[1]);
    check(`auth ${theme} ${vp} ${path}: identical to baseline (same footer style in both)`, d.same && d.n === 0, d.same ? `${d.n} px differ` : d.size);
    if (!d.same || d.n) { writeFileSync(join(OUT, `auth-${theme}-${vp}${path.replace('/', '-')}-baseline.png`), shots[0]); writeFileSync(join(OUT, `auth-${theme}-${vp}${path.replace('/', '-')}-after-samefooter.png`), shots[1]); }
  }

  // ---------- A + B + D. signed-in shell ----------
  for (const theme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, locale: 'th-TH' });
    await ctx.addInitScript((t) => { try { localStorage.setItem('hr.theme', t); } catch { /* none */ } }, theme);
    const page = await ctx.newPage(); watch(page, `after-${theme}`);
    await signIn(page);
    const before = SNAP ? await ctx.newPage() : null;
    if (before) { await useSnapshot(before); watch(before, `before-${theme}`); }
    for (const [vp, w, h] of VIEWPORTS) {
      await page.setViewportSize({ width: w, height: h }); if (before) await before.setViewportSize({ width: w, height: h });
      for (const [name, path] of PAGES) {
        if (vp !== '1440' && vp !== '375' && !['dashboard', 'employees', 'payroll'].includes(name)) continue;
        await page.goto(BASE + path); await settled(page);
        const m = await page.evaluate(() => {
          const sb = document.querySelector('.sidebar'), logo = document.querySelector('.brand-logo'), cs = (e) => getComputedStyle(e);
          const lr = logo.getBoundingClientRect(), lcs = cs(logo);
          const cur = [...document.querySelectorAll('[aria-current="page"]')];
          const item = document.querySelector('.nav-item:not(.active)'), active = document.querySelector('.nav-item.active'), group = document.querySelector('.nav-group-title');
          const f = document.getElementById('site-footer'), fcs = cs(f);
          const taps = [...document.querySelectorAll('.topbar button')].filter((b) => b.offsetParent).map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
          return {
            overflow: document.documentElement.scrollWidth - innerWidth,
            sidebarW: Math.round(sb.getBoundingClientRect().width * 100) / 100, sbBg: cs(sb).backgroundColor,
            logo: { natural: logo.naturalWidth, content: Math.round((lr.width - parseFloat(lcs.paddingLeft) - parseFloat(lcs.paddingRight)) * 10) / 10, plate: lcs.backgroundColor, loaded: logo.complete && logo.naturalWidth > 0, alt: logo.alt },
            current: cur.map((e) => e.getAttribute('href')), path: location.pathname,
            item: item && { fg: cs(item).color, bg: cs(item).backgroundColor }, active: active && { fg: cs(active).color, bg: cs(active).backgroundColor },
            group: group && cs(group).color,
            footer: { bg: fcs.backgroundColor, pos: fcs.position, z: fcs.zIndex, blur: fcs.backdropFilter, text: f.textContent.replace(/\s+/g, ' ').trim() },
            taps, oldMark: !!document.querySelector('.brand-mark'),
          };
        });
        const tag = `${theme} ${vp} ${name}`;
        const tr = (c) => (rgb(c)[3] === 0 ? m.sbBg : c);
        check(`${tag}: no horizontal overflow`, m.overflow <= 0, `overflow=${m.overflow}`);
        check(`${tag}: exactly one aria-current = current page`, m.current.length === 1 && m.current[0] === m.path, JSON.stringify(m.current));
        if (vp === '1440' || vp === '1024') check(`${tag}: sidebar exactly 260px`, m.sidebarW === 260, String(m.sidebarW));
        check(`${tag}: logo loaded, ≤150px, not upscaled, alt, old HR mark gone`, m.logo.loaded && m.logo.content <= 150 && m.logo.content <= m.logo.natural && m.logo.alt === 'โลโก้ SIAM HRBP' && !m.oldMark, JSON.stringify(m.logo));
        if (theme === 'dark') check(`${tag}: logo on a white plate`, m.logo.plate === 'rgb(255, 255, 255)', m.logo.plate);
        if (name === 'dashboard') {
          const ci = contrast(m.item.fg, tr(m.item.bg)), ca = contrast(m.active.fg, m.active.bg), cg = contrast(m.group, m.sbBg);
          check(`${tag}: rendered contrast ≥ 4.5 (item ${ci}, active ${ca}, group ${cg})`, ci >= 4.5 && ca >= 4.5 && cg >= 4.5);
          const fb = theme === 'light' ? 'rgb(30, 58, 95)' : 'rgb(2, 6, 23)';
          check(`${tag}: footer solid navy, fixed, z-index 50, exact text`, m.footer.bg === fb && m.footer.pos === 'fixed' && m.footer.z === '50' && m.footer.blur === 'none' && m.footer.text.startsWith('© 2026 Siam HRBP Soft'), JSON.stringify(m.footer));
          if (vp === '375') check(`${tag}: header tap targets ≥ 40px`, m.taps.every(([tw, th]) => tw >= 40 && th >= 40), JSON.stringify(m.taps));
        }
        // B. module content: shell hidden (layout kept) in both captures, then clipped to <main>
        const shot = async (p) => {
          if (p !== page) { await p.goto(BASE + path); await settled(p); }
          // same as ui-c3: shell hidden, background gradient image off (Chrome dithers it ±1 level depending on tab history)
          await p.addStyleTag({ content: '.sidebar,.topbar,#site-footer,.skip-link,#toasts{visibility:hidden!important}body{background-image:none!important}' });
          const box = await p.evaluate(() => { const r = document.querySelector('main').getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), width: Math.round(r.width), height: Math.round(r.height) }; });
          return { img: await p.screenshot({ fullPage: true, clip: box, animations: 'disabled', caret: 'hide' }), box };
        };
        if (before) {
        const a = await shot(page), b = await shot(before);
        const d = await pixelDiff(browser, a.img, b.img);
        check(`${tag}: <main> content identical to baseline`, d.same && d.n === 0 && JSON.stringify(a.box) === JSON.stringify(b.box), d.same ? `${d.n} px differ, box ${JSON.stringify(a.box)}` : d.size);
        if (!d.same || d.n) { writeFileSync(join(OUT, `main-${theme}-${vp}-${name}-after.png`), a.img); writeFileSync(join(OUT, `main-${theme}-${vp}-${name}-baseline.png`), b.img); }
        }
        // before/after evidence (normal rendering, viewport)
        if (['dashboard', 'employees', 'payroll'].includes(name)) {
          await page.goto(BASE + path); await settled(page);
          await page.screenshot({ path: join(OUT, `after-${theme}-${vp}-${name}.png`) });
          if (before) { await before.goto(BASE + path); await settled(before); await before.screenshot({ path: join(OUT, `before-${theme}-${vp}-${name}.png`) }); }
        }
      }
    }

    // ---------- D. behaviour ----------
    // the "before" page was opened later, so this one is a background tab: headless Chromium does not run CSS
    // transitions there (the drawer would stay at its start position). Bring it to the front first.
    if (before) await before.close();
    await page.bringToFront();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE + '/dashboard'); await settled(page);
    await page.hover('.nav-item:not(.active)');
    const hov = await page.evaluate(() => { const e = document.querySelector('.nav-item:not(.active):hover'); const s = getComputedStyle(e); return { fg: s.color, bg: s.backgroundColor }; });
    check(`${theme}: hover state contrast ≥ 4.5`, contrast(hov.fg, hov.bg) >= 4.5, `${contrast(hov.fg, hov.bg)}`);
    await page.mouse.move(700, 450);
    // the app focuses <main> after every route render, so keyboard users already start in the content; the skip link
    // is the first tab stop of the document (before the menu) for users tabbing from the top / browser chrome
    const firstTab = await page.evaluate(() => {
      const f = [...document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]')].filter((e) => e.tabIndex >= 0 && !e.disabled);
      return f[0]?.className;
    });
    // the first tab stop inside the menu is the sidebar collapse toggle (brand header), then the menu items
    await page.focus('.sidebar .sidebar-collapse-toggle'); await page.keyboard.press('Shift+Tab');
    const sk = await page.evaluate(() => { const e = document.activeElement; const r = e.getBoundingClientRect(); return { cls: e.className, text: e.textContent, top: Math.round(r.top), tf: getComputedStyle(e).transform }; });
    check(`${theme}: skip link is the first tab stop, before the menu, visible when focused`, firstTab?.includes('skip-link') && sk.cls.includes('skip-link') && sk.text === 'ข้ามไปยังเนื้อหาหลัก' && sk.top >= 0 && sk.tf === 'none', JSON.stringify({ firstTab, ...sk }));
    await page.keyboard.press('Enter');
    check(`${theme}: skip link moves focus to <main>, URL unchanged`, await page.evaluate(() => document.activeElement?.id === 'main' && location.pathname === '/dashboard' && !location.hash));
    await page.focus('.nav-item:not(.active)');
    await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    const fo = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { cls: document.activeElement.className, ow: s.outlineWidth, os: s.outlineStyle }; });
    check(`${theme}: keyboard focus on a menu item is visible`, fo.cls.includes('nav-item') && fo.os !== 'none' && parseFloat(fo.ow) >= 2, JSON.stringify(fo));
    await page.focus('.hdr-btn'); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    const fh = await page.evaluate(() => getComputedStyle(document.activeElement).boxShadow);
    check(`${theme}: keyboard focus on a header button is visible (focus ring)`, fh !== 'none', fh.slice(0, 50));
    // drawer
    await page.setViewportSize({ width: 375, height: 740 }); await page.goto(BASE + '/employees'); await settled(page);
    await page.click('.menu-toggle'); await page.waitForTimeout(350);
    const dr = await page.evaluate(async () => {
      const s = document.querySelector('.sidebar'); const r = s.getBoundingClientRect();
      const onTop = s.contains(document.elementFromPoint(100, 300));   // drawer actually painted above the scrim
      const shot = { left: Math.round(r.left), w: Math.round(r.width), onTop };
      const list = s.querySelector('.sidebar-menu-scroll'); // only the menu list scrolls; the brand header stays
      list.scrollTop = list.scrollHeight; await new Promise((res) => setTimeout(res, 200));
      const items = [...s.querySelectorAll('.nav-item')]; const last = items[items.length - 1].getBoundingClientRect();
      return { open: document.body.classList.contains('nav-open'), ...shot, lastBottom: Math.round(last.bottom), footerTop: Math.round(document.getElementById('site-footer').getBoundingClientRect().top) };
    });
    check(`${theme} 375: drawer opens on screen (left 0, on top of the scrim), < 300px wide, last item above footer`, dr.open && dr.left === 0 && dr.onTop && dr.w < 300 && dr.lastBottom <= dr.footerTop, JSON.stringify(dr));
    await page.evaluate(() => { document.querySelector('.sidebar-menu-scroll').scrollTop = 0; });
    await page.screenshot({ path: join(OUT, `after-${theme}-375-drawer.png`) });
    await page.keyboard.press('Escape');
    check(`${theme} 375: Escape closes the drawer`, !(await page.evaluate(() => document.body.classList.contains('nav-open'))));
    await page.click('.menu-toggle'); await page.waitForTimeout(300); await page.mouse.click(360, 300);
    check(`${theme} 375: tap outside closes the drawer`, !(await page.evaluate(() => document.body.classList.contains('nav-open'))));
    await page.click('.menu-toggle'); await page.waitForTimeout(300);
    await page.click('.sidebar .nav-item[href="/payroll"]'); await settled(page);
    check(`${theme} 375: choosing a menu item navigates and closes the drawer`, new URL(page.url()).pathname === '/payroll' && !(await page.evaluate(() => document.body.classList.contains('nav-open'))));
    // reduced motion + print
    await page.emulateMedia({ reducedMotion: 'reduce' });
    check(`${theme}: reduced motion disables the drawer transition`, (await page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).transitionDuration)) === '0s');
    await page.emulateMedia({ reducedMotion: 'no-preference', media: 'print' });
    const pr = await page.evaluate(() => ['.sidebar', '.topbar', '#site-footer', '.skip-link'].map((s) => getComputedStyle(document.querySelector(s)).display));
    check(`${theme}: print hides sidebar, header, footer, skip link`, pr.every((d) => d === 'none'), JSON.stringify(pr));
    await page.emulateMedia({ media: 'screen' });
    // high-DPI logo: the sidebar offers the 2x file; on this 1x screen the browser keeps the 1x file
    const sl = await page.evaluate(() => { const i = document.querySelector('.brand-logo'); return { srcset: i.getAttribute('srcset'), current: new URL(i.currentSrc).pathname }; });
    check(`${theme}: sidebar logo offers 1x + 2x, uses 1x on a 1x screen`, sl.srcset === '/assets/siamhrbp-logo.png 1x, /assets/siamhrbp-logo@2x.png 2x' && sl.current === '/assets/siamhrbp-logo.png', JSON.stringify(sl));
    await ctx.close();
  }

  // ---------- high-DPI: a 2x screen gets the 2x logo, at the same layout size ----------
  const hi = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const hp = await hi.newPage(); watch(hp, 'dpr2');
  await hp.goto(BASE + '/login'); await hp.waitForSelector('.auth-logo-img');
  await hp.waitForFunction(() => { const i = document.querySelector('.auth-logo-img'); return i.complete && i.naturalWidth > 0; });
  // naturalWidth of a "2x" srcset candidate is density-corrected (508 / 2 = 254); the file's own pixels are decoded separately
  const hl = await hp.evaluate(async () => {
    const i = document.querySelector('.auth-logo-img'); const r = i.getBoundingClientRect();
    const bmp = await createImageBitmap(await (await fetch(i.currentSrc)).blob());
    return { current: new URL(i.currentSrc).pathname, natural: [i.naturalWidth, i.naturalHeight], filePx: [bmp.width, bmp.height], shown: [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10] };
  });
  check('2x screen: Login logo uses the 2x file (508×256 px, density-corrected 254×128) at the same 200px layout width',
    hl.current === '/assets/siamhrbp-logo@2x.png' && hl.natural[0] === 254 && hl.natural[1] === 128 && hl.filePx[0] === 508 && hl.filePx[1] === 256 && hl.shown[0] === 200, JSON.stringify(hl));
  const asset = await hp.evaluate(async () => { const r = await fetch('/assets/siamhrbp-logo@2x.png'); return { status: r.status, type: r.headers.get('content-type') }; });
  check('2x logo asset served as image/png', asset.status === 200 && /image\/png/.test(asset.type), JSON.stringify(asset));
  await hp.screenshot({ path: join(OUT, 'after-light-1440-login-dpr2.png'), clip: { x: 0, y: 0, width: 720, height: 260 } });
  await hi.close();
} finally {
  await browser.close();
  stopServer(dev);
}
check('no console errors / page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-d pass=${results.length - fail} fail=${fail} skip=${skipped.length}`);
process.exitCode = fail ? 1 : 0;
