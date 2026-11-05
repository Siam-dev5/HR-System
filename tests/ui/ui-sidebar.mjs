// Collapsible sidebar with a fixed brand header (local only; fresh local D1; synthetic user): expanded by default,
// collapse / expand with the toggle (aria-expanded, labels, tooltip), the choice kept in localStorage across reloads
// (and safe when storage throws), the logo header fixed while only the menu list scrolls, active item and navigation
// in both modes, content width follows the sidebar, mobile drawer unaffected by the desktop choice, no overflow.
// usage: node tests/ui/ui-sidebar.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('sidebar');
mkdirSync(OUT, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `sidebar-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const USER = 's_staff';
const PW = `Sb-${randomBytes(9).toString('base64url')}-7m`;
const uf = join(persist, `${USER}.sql`);
run(['scripts/create-user.mjs', '--username', USER, '--display', 'ทดสอบ sidebar', '--out', uf, '--cred-file', join(persist, 'c.txt'), '--role', 'hr_staff'], { NEW_USER_PASSWORD: PW });
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', uf]);
const port = await freePort();
const dev = spawn(process.execPath, [W, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', `MFA_ENCRYPTION_KEY:${randomBytes(32).toString('base64')}`, '--show-interactive-dev-session=false'], SERVER_SPAWN);
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const errors = [];
const browser = await chromium.launch({ executablePath: EXE });
const KEY = 'hr.sidebar.collapsed';

async function session({ viewport = { width: 1440, height: 900 }, theme = 'light', init } = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, locale: 'th-TH' });
  await ctx.addInitScript((t) => { try { localStorage.setItem('hr.theme', t); } catch { /* none */ } }, theme);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE + '/login'); await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', USER); await page.fill('input[name=password]', PW); await page.click('button.auth-submit');
  await page.waitForSelector('nav.sidebar .nav-item');
  return { ctx, page };
}
const settle = (page) => page.waitForFunction(() => !document.querySelector('main .loading')).then(() => page.waitForTimeout(350)); // > 0.2s width transition
const go = async (page, path) => { await page.goto(BASE + path); await page.waitForSelector('nav.sidebar .nav-item'); await settle(page); };
// one snapshot of the sidebar's state and geometry
const state = (page) => page.evaluate((key) => {
  const r = (e) => e.getBoundingClientRect();
  const sb = document.querySelector('.sidebar'), head = document.querySelector('.sidebar-brand-header'), list = document.querySelector('.sidebar-menu-scroll');
  const t = document.querySelector('.sidebar-collapse-toggle'), main = document.querySelector('main'), logo = document.querySelector('.brand-logo');
  const labels = [...document.querySelectorAll('.nav-item .nav-label')], titles = [...document.querySelectorAll('.nav-group-title')];
  const active = document.querySelector('.nav-item.active');
  const saved = (() => { try { return localStorage.getItem(key); } catch { return 'unavailable'; } })();
  return {
    collapsed: document.querySelector('.shell').classList.contains('sidebar-collapsed'),
    width: Math.round(r(sb).width), mainLeft: Math.round(r(main).left), mainWidth: Math.round(r(main).width), sidebarRight: Math.round(r(sb).right),
    expanded: t.getAttribute('aria-expanded'), label: t.getAttribute('aria-label'), controls: t.getAttribute('aria-controls'), type: t.getAttribute('type'), controlsOk: !!document.getElementById(t.getAttribute('aria-controls')),
    labelsShown: labels.every((l) => r(l).width > 20), labelsHidden: labels.every((l) => r(l).width <= 1), labelText: labels.every((l) => l.textContent.trim().length > 0),
    titlesShown: titles.every((g) => r(g).width > 20), titlesHidden: titles.every((g) => r(g).width <= 1),
    links: [...document.querySelectorAll('.nav-item')].every((a) => a.title && a.getAttribute('aria-label') === a.title && a.dataset.path),
    centered: [...document.querySelectorAll('.nav-item')].every((a) => { const i = a.querySelector('.nav-ico'); return Math.abs((r(i).left + r(i).width / 2) - (r(a).left + r(a).width / 2)) <= 1; }),
    active: active && { path: active.dataset.path, bg: getComputedStyle(active).backgroundColor, current: active.getAttribute('aria-current') },
    sidebarOverflowY: getComputedStyle(sb).overflowY, listOverflowY: getComputedStyle(list).overflowY,
    headTop: Math.round(r(head).top), logoTop: Math.round(r(logo).top), logoW: Math.round(r(logo).width),
    overflow: document.documentElement.scrollWidth - innerWidth, saved,
  };
}, KEY);

try {
  // ---------- A. expanded by default ----------
  const { ctx, page } = await session();
  await go(page, '/dashboard');
  let s = await state(page);
  check('A. starts expanded by default (no saved preference): 260px, labels and group titles shown', !s.collapsed && s.width === 260 && s.labelsShown && s.titlesShown && s.saved === null, JSON.stringify({ w: s.width, saved: s.saved }));
  check('A. toggle: button type=button, aria-expanded=true, aria-controls the menu list, label describes the action', s.type === 'button' && s.expanded === 'true' && s.controlsOk && s.controls === 'sidebar-menu' && s.label === 'ย่อเมนูด้านข้าง', JSON.stringify({ e: s.expanded, l: s.label, c: s.controls }));
  check('A. every menu link keeps data-path, and has title + aria-label = its menu title', s.links);
  const expandedActiveBg = s.active.bg;
  const expandedMain = s.mainWidth;
  await page.screenshot({ path: join(OUT, 'expanded-1440-light.png') });

  // ---------- B. collapse ----------
  await page.click('.sidebar-collapse-toggle'); await page.waitForTimeout(350);
  s = await state(page);
  check('B. collapse: ≈76px, aria-expanded=false, label switches to expand', s.collapsed && s.width === 76 && s.expanded === 'false' && s.label === 'ขยายเมนูด้านข้าง', JSON.stringify({ w: s.width, e: s.expanded, l: s.label }));
  check('B. collapsed: labels and group titles hidden visually, still in the DOM (accessible name kept)', s.labelsHidden && s.titlesHidden && s.labelText);
  check('B. collapsed: icons centred in every link', s.centered);
  check('B. collapsed: the choice is saved immediately', s.saved === '1', String(s.saved));
  check('B / J. main content follows the sidebar (starts at its edge, 184px wider), no horizontal overflow', s.mainLeft === s.sidebarRight && s.mainWidth === expandedMain + 184 && s.overflow <= 0, JSON.stringify({ left: s.mainLeft, right: s.sidebarRight, w: s.mainWidth, before: expandedMain, o: s.overflow }));
  check('B. collapsed: logo still shown at the top, scaled down', s.logoW > 0 && s.logoW <= 60 && s.headTop === 0, JSON.stringify({ w: s.logoW, top: s.headTop }));

  // tooltip: hover and keyboard focus
  await page.hover('.nav-item[data-path="/employees"]');
  const tipHover = await page.evaluate(() => { const t = document.querySelector('.nav-tooltip'); const a = document.querySelector('.nav-item[data-path="/employees"]'); return { shown: !t.hidden && t.getBoundingClientRect().width > 0, text: t.textContent, title: a.title, left: Math.round(t.getBoundingClientRect().left), edge: Math.round(document.querySelector('.sidebar').getBoundingClientRect().right) }; });
  check('B. collapsed: hovering an icon shows a tooltip with the full menu title, beside the sidebar', tipHover.shown && tipHover.text === tipHover.title && tipHover.left >= tipHover.edge, JSON.stringify(tipHover));
  await page.mouse.move(800, 450);
  check('B. tooltip hides when the pointer leaves the menu', await page.evaluate(() => document.querySelector('.nav-tooltip').hidden));
  await page.focus('.sidebar-collapse-toggle'); await page.keyboard.press('Tab');
  const tipFocus = await page.evaluate(() => { const t = document.querySelector('.nav-tooltip'); const a = document.activeElement; const s = getComputedStyle(a); return { cls: a.className, shown: !t.hidden, text: t.textContent, title: a.title, ow: s.outlineWidth, os: s.outlineStyle }; });
  check('B. collapsed: keyboard focus on an icon is visible and shows its tooltip', tipFocus.cls.includes('nav-item') && tipFocus.shown && tipFocus.text === tipFocus.title && tipFocus.os !== 'none' && parseFloat(tipFocus.ow) >= 2, JSON.stringify(tipFocus));
  await page.keyboard.press('Shift+Tab');
  check('B. keyboard: the toggle is reachable and has a visible focus outline', await page.evaluate(() => { const a = document.activeElement; return a.classList.contains('sidebar-collapse-toggle') && getComputedStyle(a).outlineStyle !== 'none'; }));
  await page.screenshot({ path: join(OUT, 'collapsed-1440-light.png') });

  // ---------- F. active item in collapsed mode ----------
  check('F. collapsed: active item keeps its highlight and aria-current', s.active.path === '/dashboard' && s.active.bg === expandedActiveBg && s.active.current === 'page', JSON.stringify(s.active));

  // ---------- G. navigation in collapsed mode ----------
  await page.click('.nav-item[data-path="/employees"]'); await settle(page);
  s = await state(page);
  check('G. collapsed: clicking an icon navigates, the active item moves, the sidebar stays collapsed', new URL(page.url()).pathname === '/employees' && s.active?.path === '/employees' && s.active.bg === expandedActiveBg && s.collapsed, JSON.stringify(s.active));

  // ---------- D. reload restores the saved preference ----------
  await page.reload(); await page.waitForSelector('nav.sidebar .nav-item');
  const early = await page.evaluate(() => document.querySelector('.shell').classList.contains('sidebar-collapsed'));
  await settle(page);
  s = await state(page);
  check('D. reload: collapsed state restored on startup (aria-expanded=false, 76px)', early && s.collapsed && s.width === 76 && s.expanded === 'false');
  const themeKept = await page.evaluate(() => localStorage.getItem('hr.theme'));
  check('D. other preferences untouched (theme key unchanged)', themeKept === 'light', String(themeKept));

  // ---------- E. fixed brand header, only the menu list scrolls (collapsed + expanded) ----------
  for (const mode of ['collapsed', 'expanded']) {
    if (mode === 'expanded') { await page.click('.sidebar-collapse-toggle'); await page.waitForTimeout(350); }
    await page.setViewportSize({ width: 1440, height: 560 }); // a short window: the menu list must overflow
    await go(page, '/employees');
    const e = await page.evaluate(async () => {
      const sb = document.querySelector('.sidebar'), list = document.querySelector('.sidebar-menu-scroll'), head = document.querySelector('.sidebar-brand-header'), logo = document.querySelector('.brand-logo');
      const before = { head: Math.round(head.getBoundingClientRect().top), logo: Math.round(logo.getBoundingClientRect().top) };
      const overflowing = list.scrollHeight > list.clientHeight;
      list.scrollTop = list.scrollHeight; await new Promise((r) => setTimeout(r, 150));
      const items = [...list.querySelectorAll('.nav-item')]; const last = items[items.length - 1].getBoundingClientRect();
      // the page itself scrolled too (long content): the sidebar is sticky, its header stays at the top
      window.scrollTo(0, document.documentElement.scrollHeight); await new Promise((r) => setTimeout(r, 150));
      const x = (px, py) => document.elementFromPoint(px, py);
      const lr = logo.getBoundingClientRect();
      return {
        overflowing, listScrolled: list.scrollTop > 0, sidebarScroll: sb.scrollTop, before,
        after: { head: Math.round(head.getBoundingClientRect().top), logo: Math.round(lr.top) },
        logoOnTop: logo.contains(x(lr.left + lr.width / 2, lr.top + lr.height / 2)) || x(lr.left + lr.width / 2, lr.top + lr.height / 2) === logo,
        toggleTop: (() => { const t = document.querySelector('.sidebar-collapse-toggle').getBoundingClientRect(); return document.querySelector('.sidebar-collapse-toggle').contains(x(t.left + t.width / 2, t.top + t.height / 2)); })(),
        lastBottom: Math.round(last.bottom), footerTop: Math.round(document.getElementById('site-footer').getBoundingClientRect().top), headBottom: Math.round(head.getBoundingClientRect().bottom), lastTop: Math.round(last.top),
      };
    });
    check(`E. ${mode}: menu list overflows and scrolls on its own; the sidebar itself does not scroll`, e.overflowing && e.listScrolled && e.sidebarScroll === 0, JSON.stringify({ o: e.overflowing, l: e.listScrolled, s: e.sidebarScroll }));
    check(`E. ${mode}: brand header and logo stay at the top (not covered) while the list and page scroll`, e.before.head === 0 && e.after.head === 0 && e.after.logo === e.before.logo && e.logoOnTop && e.toggleTop, JSON.stringify({ b: e.before, a: e.after, on: e.logoOnTop, t: e.toggleTop }));
    check(`E. ${mode}: last menu item reachable below the header and above the footer`, e.lastBottom <= e.footerTop && e.lastTop >= e.headBottom, JSON.stringify({ last: [e.lastTop, e.lastBottom], head: e.headBottom, footer: e.footerTop }));
    await page.screenshot({ path: join(OUT, `scrolled-${mode}-1440x560.png`) });
    const css = await state(page);
    check(`E. ${mode}: overflow-y is on the menu list only`, css.sidebarOverflowY === 'hidden' && css.listOverflowY === 'auto', `${css.sidebarOverflowY}/${css.listOverflowY}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await go(page, '/dashboard');

  // ---------- C. expand restores labels ----------
  s = await state(page);
  check('C. expand: 260px, labels and group titles back, aria-expanded=true, saved as expanded', !s.collapsed && s.width === 260 && s.labelsShown && s.titlesShown && s.expanded === 'true' && s.label === 'ย่อเมนูด้านข้าง' && s.saved === '0', JSON.stringify({ w: s.width, saved: s.saved }));
  check('C / F. expanded: active item highlighted, as before', s.active?.path === '/dashboard' && s.active.bg === expandedActiveBg && s.active.current === 'page');
  check('C. expanded: no tooltip on hover', await page.hover('.nav-item[data-path="/employees"]').then(() => page.evaluate(() => document.querySelector('.nav-tooltip').hidden)));
  await page.reload(); await page.waitForSelector('nav.sidebar .nav-item'); await settle(page);
  check('C. reload after expanding: stays expanded', !(await state(page)).collapsed);

  // reduced motion: no width transition
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const rm = await page.evaluate(() => [getComputedStyle(document.querySelector('.shell')).transitionDuration, getComputedStyle(document.querySelector('.sidebar-collapse-toggle .ico')).transitionDuration]);
  check('reduced motion: no collapse transition', rm.every((d) => d === '0s'), rm.join());
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await ctx.close();

  // ---------- K. menu groups: independent toggle, saved, icon-only shows everything, restored on expand ----------
  const GK = 'hr.sidebar.groups';
  const g = await session();
  await go(g.page, '/dashboard');
  const groups = (page) => page.evaluate((key) => {
    const vis = (e) => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0;
    const out = {};
    for (const grp of document.querySelectorAll('.nav-group')) {
      const t = grp.querySelector('.nav-group-toggle'), items = [...grp.querySelectorAll('.nav-item')];
      out[grp.dataset.group] = { expanded: t.getAttribute('aria-expanded'), toggleShown: vis(t), shown: items.filter(vis).length, total: items.length, controls: document.getElementById(t.getAttribute('aria-controls'))?.parentElement === grp, labelled: grp.getAttribute('aria-labelledby') === t.id, type: t.getAttribute('type'), name: t.textContent.trim() };
    }
    let saved; try { saved = localStorage.getItem(key); } catch { saved = 'unavailable'; }
    return { groups: out, saved, hrefs: [...document.querySelectorAll('.nav-item')].map((a) => a.getAttribute('href')).sort().join() };
  }, GK);
  let k = await groups(g.page);
  const keys = Object.keys(k.groups);
  const [ga, gb] = [keys[1], keys[2]]; // two groups below "ภาพรวม" (the dashboard's own group stays open)
  const hrefs = k.hrefs;
  check('K. every group header is a button (type=button, aria-expanded, aria-controls its items, names the group)', keys.length >= 3 && Object.values(k.groups).every((x) => x.type === 'button' && x.expanded === 'true' && x.controls && x.labelled && x.name.length > 0 && x.shown === x.total && x.toggleShown) && k.saved === null, JSON.stringify(keys));
  await g.page.click(`.nav-group[data-group="${ga}"] .nav-group-toggle`);
  k = await groups(g.page);
  check(`K. closing "${ga}" hides only its items; every other group stays open`, k.groups[ga].expanded === 'false' && k.groups[ga].shown === 0 && keys.filter((x) => x !== ga).every((x) => k.groups[x].shown === k.groups[x].total && k.groups[x].expanded === 'true'), JSON.stringify(k.groups[ga]));
  check('K. the closed group is saved immediately', k.saved === JSON.stringify([ga]), String(k.saved));
  await g.page.focus(`.nav-group[data-group="${gb}"] .nav-group-toggle`); await g.page.keyboard.press('Enter');
  k = await groups(g.page);
  check(`K. keyboard: Enter on "${gb}" closes it, independently of "${ga}"`, k.groups[gb].expanded === 'false' && k.groups[gb].shown === 0 && k.groups[ga].shown === 0 && JSON.parse(k.saved).sort().join() === [ga, gb].sort().join(), String(k.saved));
  const gf = await g.page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { cls: document.activeElement.className, os: s.outlineStyle, ow: s.outlineWidth }; });
  check('K. keyboard focus on a group header is visible', gf.cls.includes('nav-group-toggle') && gf.os !== 'none' && parseFloat(gf.ow) >= 2, JSON.stringify(gf));
  await g.page.keyboard.press('Space');
  await g.page.click(`.nav-group[data-group="${ga}"] .nav-group-toggle`);
  await g.page.click(`.nav-group[data-group="${gb}"] .nav-group-toggle`);
  k = await groups(g.page);
  check(`K. Space reopens "${gb}"; reopening "${ga}" and closing "${gb}" leaves only "${gb}" closed`, k.groups[ga].expanded === 'true' && k.groups[ga].shown === k.groups[ga].total && k.groups[gb].expanded === 'false' && k.saved === JSON.stringify([gb]), String(k.saved));
  check('K. permissions unchanged: the same menu links exist whatever the group state', k.hrefs === hrefs);
  await g.page.reload(); await g.page.waitForSelector('nav.sidebar .nav-item'); await settle(g.page);
  k = await groups(g.page);
  check(`K. reload restores each group's state ("${gb}" closed, the rest open)`, k.groups[gb].expanded === 'false' && k.groups[gb].shown === 0 && keys.filter((x) => x !== gb).every((x) => k.groups[x].expanded === 'true' && k.groups[x].shown === k.groups[x].total));
  const firstA = await g.page.$eval(`.nav-group[data-group="${ga}"] .nav-item`, (a) => a.dataset.path);
  await g.page.click(`.nav-group[data-group="${ga}"] .nav-item`); await settle(g.page);
  check('K. navigation and active highlight work with a group closed elsewhere', await g.page.evaluate((p) => { const a = document.querySelector('.nav-item.active'); return a?.dataset.path === p && a.getAttribute('aria-current') === 'page' && location.pathname === p; }, firstA));
  // icon-only mode
  await g.page.click('.sidebar-collapse-toggle'); await g.page.waitForTimeout(350);
  k = await groups(g.page);
  check(`K. icon-only: every item of every group is shown (including closed "${gb}"), no group headers`, Object.values(k.groups).every((x) => x.shown === x.total && !x.toggleShown), JSON.stringify(Object.fromEntries(Object.entries(k.groups).map(([n, x]) => [n, `${x.shown}/${x.total}`]))));
  check('K. icon-only: saved group states are kept, not overwritten', k.saved === JSON.stringify([gb]), String(k.saved));
  await g.page.click(`.nav-group[data-group="${gb}"] .nav-item`); await settle(g.page);
  check(`K. icon-only: an item of the closed group "${gb}" is reachable and navigates`, await g.page.evaluate((key) => document.querySelector('.nav-item.active')?.closest('.nav-group')?.dataset.group === key, gb));
  await g.page.focus('.sidebar-collapse-toggle'); await g.page.keyboard.press('Tab');
  check('K. icon-only: Tab from the sidebar toggle lands on a menu item (hidden group headers are not tab stops)', await g.page.evaluate(() => document.activeElement.classList.contains('nav-item')));
  // back to expanded
  await g.page.click('.sidebar-collapse-toggle'); await g.page.waitForTimeout(350);
  k = await groups(g.page);
  check(`K. expanded again: saved states restored ("${gb}" closed, headers back)`, k.groups[gb].expanded === 'false' && k.groups[gb].shown === 0 && Object.values(k.groups).every((x) => x.toggleShown) && keys.filter((x) => x !== gb).every((x) => k.groups[x].shown === k.groups[x].total));
  check('K. expanded again: the active item (in the closed group) keeps its highlight in the DOM', await g.page.evaluate((key) => { const a = document.querySelector('.nav-item.active'); return a?.closest('.nav-group')?.dataset.group === key && a.getAttribute('aria-current') === 'page'; }, gb));
  await g.page.screenshot({ path: join(OUT, 'groups-expanded-1440-light.png') });
  await g.ctx.close();
  // mobile drawer keeps working with saved group states; corrupt storage falls back to all open
  const gm = await session({ viewport: { width: 375, height: 740 }, init: { content: `try { localStorage.setItem('${GK}', '${JSON.stringify([gb])}'); localStorage.setItem('hr.sidebar.collapsed', '1'); } catch { /* none */ }` } });
  await go(gm.page, '/dashboard');
  await gm.page.click('.menu-toggle'); await gm.page.waitForTimeout(350);
  k = await groups(gm.page);
  check(`K. drawer 375: saved group state applies ("${gb}" closed), headers shown`, k.groups[gb].shown === 0 && Object.values(k.groups).every((x) => x.toggleShown));
  await gm.page.click(`.nav-group[data-group="${gb}"] .nav-group-toggle`);
  k = await groups(gm.page);
  check('K. drawer 375: a group opens in the drawer and the drawer stays open', k.groups[gb].shown === k.groups[gb].total && (await gm.page.evaluate(() => document.body.classList.contains('nav-open'))));
  await gm.page.keyboard.press('Escape');
  check('K. drawer 375: Escape still closes the drawer', !(await gm.page.evaluate(() => document.body.classList.contains('nav-open'))));
  await gm.ctx.close();
  const gc = await session({ init: { content: `try { localStorage.setItem('${GK}', 'not json'); } catch { /* none */ }` } });
  await go(gc.page, '/dashboard');
  k = await groups(gc.page);
  check('K. unreadable saved group state: every group open, no error', Object.values(k.groups).every((x) => x.expanded === 'true' && x.shown === x.total));
  await gc.ctx.close();

  // ---------- storage unavailable: defaults to expanded, the toggle still works ----------
  // only this key throws (as a blocked / private-mode storage would); the theme preference still works
  const blocked = await session({ init: { content: `{
    const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
    const deny = () => { throw new DOMException('denied', 'SecurityError'); };
    Storage.prototype.getItem = function (k) { if (k === 'hr.sidebar.collapsed') deny(); return get.call(this, k); };
    Storage.prototype.setItem = function (k, v) { if (k === 'hr.sidebar.collapsed') deny(); return set.call(this, k, v); };
  }` } });
  await go(blocked.page, '/dashboard');
  const b0 = await state(blocked.page);
  await blocked.page.click('.sidebar-collapse-toggle'); await blocked.page.waitForTimeout(350);
  const b1 = await state(blocked.page);
  check('storage errors: starts expanded and still collapses (no crash)', !b0.collapsed && b1.collapsed && b1.width === 76);
  await blocked.ctx.close();

  // ---------- H / I. mobile drawer with a saved collapsed preference ----------
  for (const theme of ['light', 'dark']) {
    const m = await session({ viewport: { width: 375, height: 740 }, theme, init: () => { try { localStorage.setItem('hr.sidebar.collapsed', '1'); } catch { /* none */ } } });
    await go(m.page, '/employees');
    const closed = await m.page.evaluate(() => ({ left: Math.round(document.querySelector('.sidebar').getBoundingClientRect().right), toggle: getComputedStyle(document.querySelector('.sidebar-collapse-toggle')).display, menu: getComputedStyle(document.querySelector('.menu-toggle')).display, overflow: document.documentElement.scrollWidth - innerWidth }));
    check(`H. ${theme} 375: drawer hidden off-screen, desktop collapse toggle hidden, mobile menu button shown, no overflow`, closed.left <= 0 && closed.toggle === 'none' && closed.menu !== 'none' && closed.overflow <= 0, JSON.stringify(closed));
    await m.page.click('.menu-toggle'); await m.page.waitForTimeout(350);
    const open = await state(m.page);
    const drawer = await m.page.evaluate(() => { const r = document.querySelector('.sidebar').getBoundingClientRect(); return { open: document.body.classList.contains('nav-open'), left: Math.round(r.left), w: Math.round(r.width) }; });
    check(`H. ${theme} 375: drawer opens full width (260px) with labels and group titles despite the desktop collapsed preference`, drawer.open && drawer.left === 0 && drawer.w === 260 && open.labelsShown && open.titlesShown, JSON.stringify(drawer));
    await m.page.hover('.nav-item[data-path="/dashboard"]');
    check(`H. ${theme} 375: no collapsed tooltip in the drawer`, await m.page.evaluate(() => getComputedStyle(document.querySelector('.nav-tooltip')).display === 'none'));
    await m.page.screenshot({ path: join(OUT, `drawer-375-${theme}.png`) });
    await m.page.keyboard.press('Escape');
    check(`I. ${theme} 375: Escape closes the drawer`, !(await m.page.evaluate(() => document.body.classList.contains('nav-open'))));
    await m.page.click('.menu-toggle'); await m.page.waitForTimeout(300); await m.page.mouse.click(360, 300);
    check(`H. ${theme} 375: tap outside (scrim) closes the drawer`, !(await m.page.evaluate(() => document.body.classList.contains('nav-open'))));
    await m.page.click('.menu-toggle'); await m.page.waitForTimeout(300);
    await m.page.click('.sidebar .nav-item[data-path="/dashboard"]'); await settle(m.page);
    check(`H. ${theme} 375: choosing a menu item navigates and closes the drawer`, new URL(m.page.url()).pathname === '/dashboard' && !(await m.page.evaluate(() => document.body.classList.contains('nav-open'))));
    check(`H. ${theme} 375: the desktop preference is left as saved`, (await state(m.page)).saved === '1');
    await m.ctx.close();
  }

  // ---------- J. no horizontal overflow, both states, desktop / tablet / mobile, light / dark ----------
  for (const [w, hgt] of [[1440, 900], [1024, 768], [768, 1024], [375, 740]]) {
    for (const collapsed of ['0', '1']) {
      const theme = collapsed === '1' ? 'dark' : 'light';
      const v = await session({ viewport: { width: w, height: hgt }, theme, init: { content: `try { localStorage.setItem('hr.sidebar.collapsed', '${collapsed}'); } catch { /* none */ }` } });
      for (const path of ['/dashboard', '/employees', '/payroll']) {
        await go(v.page, path);
        const x = await state(v.page);
        const desktop = w > 900;
        const widthOk = !desktop || x.width === (collapsed === '1' ? 76 : 260);
        check(`J. ${w} ${theme} ${collapsed === '1' ? 'collapsed' : 'expanded'} ${path}: no horizontal overflow${desktop ? ', sidebar width per state, content starts at its edge' : ''}`, x.overflow <= 0 && widthOk && (!desktop || x.mainLeft === x.sidebarRight), JSON.stringify({ o: x.overflow, w: x.width, l: x.mainLeft, r: x.sidebarRight }));
      }
      if (w === 1024) await v.page.screenshot({ path: join(OUT, `${collapsed === '1' ? 'collapsed' : 'expanded'}-1024-${theme}.png`) });
      await v.ctx.close();
    }
  }
} finally {
  await browser.close();
  stopServer(dev);
}
check('no console errors / page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-sidebar pass=${results.length - fail} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
