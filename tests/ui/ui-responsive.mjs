// Mobile tables and chart labels (local only; fresh local D1; demo seed; synthetic user):
//  tables — on phones (≤ 600px) columns keep their natural width instead of being squeezed to the narrowest word
//    (rows were 80–140px with names / departments over 4–6 lines): rows stay compact, the table scrolls inside its
//    wrapper, long text still wraps (≤ 16rem), rows stay clickable; from 768px up tables still fit their wrapper.
//  charts — the label column is as wide as the longest label (bars aligned), wraps only when it cannot fit, never
//    clips; a very narrow chart stacks label + value over a full-width bar.
// Light / dark at 320 / 375 / 768 / 1024 / 1440. usage: node tests/ui/ui-responsive.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('responsive');
mkdirSync(OUT, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `responsive-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const USER = 'r_staff';
const PW = `Rs-${randomBytes(9).toString('base64url')}-6p`;
run(['scripts/create-user.mjs', '--username', USER, '--display', 'ทดสอบ responsive', '--out', join(persist, 'u.sql'), '--cred-file', join(persist, 'c.txt'), '--role', 'hr_staff', '--role', 'hr_manager'], { NEW_USER_PASSWORD: PW });
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', join(persist, 'u.sql')]);
const port = await freePort();
const dev = spawn(process.execPath, [W, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', `MFA_ENCRYPTION_KEY:${randomBytes(32).toString('base64')}`, '--show-interactive-dev-session=false'], SERVER_SPAWN);
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const errors = [];
const browser = await chromium.launch({ executablePath: EXE });

async function session(viewport, theme) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, locale: 'th-TH' });
  await ctx.addInitScript((t) => { try { localStorage.setItem('hr.theme', t); } catch { /* none */ } }, theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE + '/login'); await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', USER); await page.fill('input[name=password]', PW); await page.click('button.auth-submit');
  await page.waitForSelector('nav.sidebar .nav-item');
  return { ctx, page };
}
const open = async (page, path, sel) => {
  await page.goto(BASE + path); await page.waitForSelector(sel); await page.waitForFunction(() => !document.querySelector('main .loading'));
};

// every table on a page: row heights, lines per cell, whether it fits or scrolls inside its own box
const tables = (page) => page.evaluate(() => [...document.querySelectorAll('main table.table')].map((t) => {
  let box = t.parentElement; while (box && box.tagName !== 'MAIN' && !/(auto|scroll)/.test(getComputedStyle(box).overflowX)) box = box.parentElement;
  const rows = [...t.querySelectorAll('tbody tr')].map((r) => r.getBoundingClientRect().height);
  const lines = (el) => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size; };
  return { rows: rows.length, maxRow: Math.round(Math.max(0, ...rows)), maxLines: Math.max(0, ...[...t.querySelectorAll('tbody td')].map(lines)), scroller: box && box.tagName !== 'MAIN', width: Math.round(t.getBoundingClientRect().width), boxWidth: box ? box.clientWidth : 0 };
}));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

try {
  // ---------- tables on phones ----------
  const { ctx, page } = await session({ width: 375, height: 740 }, 'light');
  const menu = await page.$$eval('nav.sidebar .nav-item', (as) => as.map((a) => a.getAttribute('href')));
  const listPages = [];
  for (const p of menu) {
    await page.goto(BASE + p); await page.waitForSelector('nav.sidebar .nav-item');
    await page.waitForFunction(() => !document.querySelector('main .loading')).catch(() => {});
    if (await page.$('main table.table tbody tr')) listPages.push(p);
  }
  check('found the pages with tables to check', listPages.length >= 25, String(listPages.length));
  for (const theme of ['light', 'dark']) {
    const s = theme === 'light' ? { ctx, page } : await session({ width: 375, height: 740 }, 'dark');
    const bad = [];
    for (const p of listPages) {
      await open(s.page, p, 'main table.table tbody tr');
      for (const t of await tables(s.page)) {
        if (t.maxRow > 64 || t.maxLines > 2 || !t.scroller || t.width < t.boxWidth - 1) bad.push(`${p} row=${t.maxRow} lines=${t.maxLines} scroller=${t.scroller} width=${t.width}/${t.boxWidth}`);
      }
      if ((await overflow(s.page)) > 0) bad.push(`${p} page overflow`);
    }
    check(`375 ${theme}: every table row ≤ 64px and ≤ 2 lines per cell, each table scrolls inside its own box, no page overflow (${listPages.length} pages)`, bad.length === 0, bad.slice(0, 4).join(' | '));
    if (theme === 'dark') await s.ctx.close();
  }

  // the employee list: compact one-line rows, the table scrolls sideways, a row still opens the record
  await open(page, '/employees', 'main table.table tbody tr');
  const emp = await page.evaluate(() => {
    const wrap = document.querySelector('main .table-wrap'); const t = wrap.querySelector('table');
    const before = wrap.scrollLeft; wrap.scrollLeft = 10000; const scrolled = wrap.scrollLeft > before; wrap.scrollLeft = 0;
    const rows = [...t.querySelectorAll('tbody tr')]; const visible = rows.filter((r) => r.getBoundingClientRect().bottom <= innerHeight).length;
    return { scrolled, rows: rows.length, visible, wider: t.scrollWidth > wrap.clientWidth };
  });
  check('375 employees: the table is wider than the screen and scrolls inside its wrapper', emp.wider && emp.scrolled, JSON.stringify(emp));
  check('375 employees: all 8 demo rows fit on the first screen (was 4)', emp.visible === emp.rows && emp.rows === 8, JSON.stringify(emp));
  await page.screenshot({ path: join(OUT, 'employees-375-light.png') });
  await page.click('main table.table tbody tr');
  check('375 employees: tapping a row still opens the record', !!(await page.waitForSelector('.modal', { timeout: 5000 }).catch(() => null)));
  await page.keyboard.press('Escape');

  // long text still wraps, at a readable width, inside the scroller
  const long = await page.evaluate(() => {
    const td = document.querySelector('main table.table tbody td:nth-child(5)');
    td.textContent = 'ฝ่ายทรัพยากรบุคคลและพัฒนาองค์กร สำนักงานใหญ่ กรุงเทพมหานคร อาคารสำนักงาน ชั้น 12 (ข้อความยาวสำหรับทดสอบการตัดบรรทัด)';
    const r = td.getBoundingClientRect(); const rg = document.createRange(); rg.selectNodeContents(td);
    const lines = new Set([...rg.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top))).size;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    return { width: Math.round(r.width), max: Math.round(16 * rem + 1), lines, clipped: td.scrollWidth > td.clientWidth + 1 };
  });
  check('375: a long text cell wraps at ≤ 16rem (readable width), nothing clipped', long.lines >= 2 && long.width <= long.max && long.width >= 150 && !long.clipped, JSON.stringify(long));
  await ctx.close();

  // ---------- tables from 768px up: unchanged, still fit their wrapper ----------
  for (const [w, h] of [[768, 1024], [1024, 768], [1440, 900]]) {
    const s = await session({ width: w, height: h }, w === 1024 ? 'dark' : 'light');
    const bad = [];
    for (const p of ['/employees', '/departments', '/performance', '/skills/matrix', '/leave', '/attendance']) {
      await open(s.page, p, 'main table.table tbody tr');
      for (const t of await tables(s.page)) if (t.width > t.boxWidth + 1 && t.width !== t.boxWidth) bad.push(`${p} ${t.width}/${t.boxWidth}`);
      if ((await overflow(s.page)) > 0) bad.push(`${p} page overflow`);
    }
    check(`${w}: tables keep the full-width layout (the phone rule does not apply), no page overflow`, bad.length === 0, bad.join(' | '));
    await s.ctx.close();
  }

  // ---------- chart labels ----------
  const bars = (page) => page.evaluate(() => [...document.querySelectorAll('main .bars')].map((b) => {
    const rows = [...b.querySelectorAll('.bar-row')];
    const lh = (e) => parseFloat(getComputedStyle(e).lineHeight);
    return {
      width: Math.round(b.getBoundingClientRect().width),
      labels: rows.map((r) => { const l = r.querySelector('.bar-label'); return { lines: Math.round(l.getBoundingClientRect().height / lh(l)), clipped: l.scrollWidth > l.clientWidth + 1 || l.getBoundingClientRect().right > b.getBoundingClientRect().right + 1 }; }),
      trackLefts: [...new Set(rows.map((r) => Math.round(r.querySelector('.bar-track').getBoundingClientRect().left)))],
      minTrack: Math.round(Math.min(...rows.map((r) => r.querySelector('.bar-track').getBoundingClientRect().width))),
      stacked: rows.every((r) => r.querySelector('.bar-track').getBoundingClientRect().top >= r.querySelector('.bar-label').getBoundingClientRect().bottom - 1),
      valuesRight: rows.every((r) => Math.abs(r.querySelector('.bar-value').getBoundingClientRect().right - b.getBoundingClientRect().right) <= 1),
    };
  }));
  for (const theme of ['light', 'dark']) {
    for (const [w, h] of [[375, 740], [768, 1024], [1024, 768], [1440, 900]]) {
      const s = await session({ width: w, height: h }, theme);
      for (const p of ['/dashboard', '/analytics']) {
        await open(s.page, p, 'main .bars .bar-row');
        const cs = await bars(s.page);
        const ok = cs.every((c) => c.labels.every((l) => l.lines === 1 && !l.clipped) && c.trackLefts.length === 1 && c.valuesRight);
        check(`${w} ${theme} ${p}: chart labels on one line, none clipped, bars aligned, values at the right edge`, ok && cs.length > 0, JSON.stringify(cs.map((c) => ({ w: c.width, lines: c.labels.map((l) => l.lines).join(''), lefts: c.trackLefts.length }))));
        if (p === '/dashboard' && w === 375) await (await s.page.$('main .card:has(.bars)')).screenshot({ path: join(OUT, `dashboard-bars-375-${theme}.png`) });
      }
      // a very long department name: wraps inside its column, never clipped, bars stay aligned and ≥ 5rem
      if (w === 375 || w === 1440) {
        await open(s.page, '/dashboard', 'main .bars .bar-row');
        await s.page.evaluate(() => { document.querySelector('main .bar-row .bar-label').textContent = 'ฝ่ายทรัพยากรบุคคลและพัฒนาองค์กรสำนักงานใหญ่ส่วนกลางและภูมิภาคตะวันออกเฉียงเหนือ'; });
        const [c] = await bars(s.page);
        const rem = await s.page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
        check(`${w} ${theme}: a very long chart label wraps (not clipped), bars stay aligned and ≥ 5rem wide`, c.labels[0].lines >= 2 && c.labels.every((l) => !l.clipped) && c.trackLefts.length === 1 && c.minTrack >= Math.floor(5 * rem), JSON.stringify({ lines: c.labels[0].lines, lefts: c.trackLefts, minTrack: c.minTrack }));
      }
      await s.ctx.close();
    }
  }
  // a very narrow chart (analytics at 320px, chart < 17.5rem): label + value on one line, the bar underneath
  for (const theme of ['light', 'dark']) {
    const s = await session({ width: 320, height: 700 }, theme);
    await open(s.page, '/analytics', 'main .bars .bar-row');
    const [c] = await bars(s.page);
    const full = await s.page.evaluate(() => { const b = document.querySelector('main .bars'); const t = b.querySelector('.bar-track'); return Math.abs(t.getBoundingClientRect().width - b.getBoundingClientRect().width) <= 1; });
    check(`320 ${theme} analytics (${c.width}px chart): stacked — bar under its label at full width, label not clipped, value at the right`, c.stacked && full && c.labels.every((l) => !l.clipped) && c.valuesRight, JSON.stringify({ w: c.width, stacked: c.stacked, full }));
    check(`320 ${theme}: no page overflow`, (await overflow(s.page)) <= 0);
    await (await s.page.$('main .card:has(.bars)')).screenshot({ path: join(OUT, `analytics-bars-320-${theme}.png`) });
    await s.ctx.close();
  }
} finally {
  await browser.close();
  stopServer(dev);
}
check('no console errors / page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-responsive pass=${results.length - fail} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
