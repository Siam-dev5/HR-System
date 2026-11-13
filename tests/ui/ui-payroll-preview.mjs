// Browser test (Chromium): Payroll Preview frozen columns and row selection. Local wrangler dev + fresh local D1
// (synthetic demo data, nothing remote). Checks: a checkbox on every row; select one / several; select-all of the
// rows shown, indeterminate header, clear; the selection kept through search; frozen checkbox / code / name while
// scrolling right and back; sticky header rows not overlapping; no layout defect at 1440 / 1024 / 768 / 375; no console
// errors or HTTP 5xx; selecting rows never changes an amount. `--before` only takes screenshots (for the old page).
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, outDir, freePort, stopServer, arg } from './lib/env.mjs';

const BEFORE = process.argv.includes('--before');
const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const SHOTS = arg('--shots', outDir(BEFORE ? 'preview-before' : 'preview-after'));
mkdirSync(SHOTS, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const persist = join('.tmp', `pv-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const pw = `Pv-${randomBytes(9).toString('base64url')}-7c`;
const out = join(persist, 'pv_pay.sql');
run(['scripts/create-user.mjs', '--username', 'pv_pay', '--display', 'ทดสอบ pv_pay', '--role', 'payroll_officer', '--employee', 'E003', '--out', out, '--cred-file', join(persist, 'c.txt')], { NEW_USER_PASSWORD: pw });
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', out]);
const port = await freePort();
const dev = spawn(process.execPath, [W, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', `MFA_ENCRYPTION_KEY:${randomBytes(32).toString('base64')}`, '--show-interactive-dev-session=false'], { ...SERVER_SPAWN, cwd: ROOT, env: { ...process.env, CI: '1' } });
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

function totp(secret) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secret.replace(/\s/g, '')) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', key).update(msg).digest(); const o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const errors = [];
const requests = [];

const browser = await chromium.launch({ executablePath: EXE });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('response', (r) => { if (r.url().includes('/api/')) requests.push(`${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`); if (r.status() >= 500) errors.push(`HTTP ${r.status()} ${r.url()}`); });

  await page.goto(BASE + '/');
  await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', 'pv_pay');
  await page.fill('input[name=password]', pw);
  await page.click('button.auth-submit');
  await page.waitForSelector('nav.sidebar, button:has-text("เริ่มตั้งค่า MFA")');
  if (await page.$('button:has-text("เริ่มตั้งค่า MFA")')) {
    await page.click('button:has-text("เริ่มตั้งค่า MFA")');
    const secret = (await page.textContent('code.secret')).trim();
    await page.fill('.mfa-setup input', totp(secret));
    await page.click('text=ยืนยันและเปิดใช้');
  }
  await page.waitForSelector('nav.sidebar');
  const api = (method, path, body) => page.evaluate(async ([m, p, b]) => {
    const r = await fetch(p, { method: m, headers: { 'content-type': 'application/json', 'x-hr-requested': '1' }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, [method, path, body]);
  const created = await api('POST', '/api/payroll/periods', { code: 'PV-2027-05', name: 'zz preview', kind: 'monthly', company_id: 1, start_date: '2027-05-01', end_date: '2027-05-31', pay_date: '2027-05-31' });
  const pid = created.body?.id;
  check('test period created', created.status === 201, String(created.status));
  check('test period calculated', (await api('POST', `/api/payroll/periods/${pid}/calculate`)).status === 200);
  const previewBefore = await api('GET', `/api/payroll/periods/${pid}/preview?company=1`);

  const open = async (w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(BASE + `/payroll/preview?period_id=${pid}&company=1`);
    await page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .loading'));
    await page.waitForSelector('.preview-table tbody tr');
    await page.waitForTimeout(300);
  };
  const scroll = (x) => page.evaluate((left) => { const w = document.querySelector('.preview-wrap'); w.scrollLeft = left === 'end' ? w.scrollWidth : left; return { left: w.scrollLeft, max: w.scrollWidth - w.clientWidth }; }, x);

  await open(1440, 900);
  await page.screenshot({ path: join(SHOTS, 'preview-1440-left.png') });
  await scroll('end');
  await page.waitForTimeout(150);
  await page.screenshot({ path: join(SHOTS, 'preview-1440-scrolled-right.png') });
  await scroll(0);
  if (BEFORE) {
    console.log(`BEFORE screenshots in ${SHOTS}`);
  } else {
    // 1. a checkbox on every row
    const rows = await page.$$eval('.preview-table tbody tr', (x) => x.length);
    const boxes = await page.$$eval('.preview-table tbody tr td.fz-check input[type=checkbox]', (x) => x.length);
    check('1. a checkbox on every row', rows > 1 && boxes === rows, `${boxes}/${rows}`);
    const countText = () => page.textContent('.pick-count');
    const head = () => page.$eval('.pick-all', (e) => ({ checked: e.checked, indeterminate: e.indeterminate }));
    // 2. one, 3. several
    await page.check('.preview-table tbody tr:nth-child(1) td.fz-check input');
    check('2. one employee selected → count 1, row marked', (await countText()).startsWith('เลือกแล้ว 1 คน') && (await page.$('.preview-table tbody tr:nth-child(1).is-picked')) !== null);
    await page.check('.preview-table tbody tr:nth-child(2) td.fz-check input');
    await page.check('.preview-table tbody tr:nth-child(3) td.fz-check input');
    check('3. several selected → count 3', (await countText()).startsWith('เลือกแล้ว 3 คน'));
    // 5. some selected → indeterminate header
    const h1 = await head();
    check('5. some selected → header checkbox indeterminate', h1.indeterminate && !h1.checked);
    // 4. select all / deselect all
    await page.click('.pick-all');
    const h2 = await head();
    check('4a. select all (rows shown) → all checked, not indeterminate', h2.checked && !h2.indeterminate && (await countText()).startsWith(`เลือกแล้ว ${rows} คน`));
    await page.click('.pick-all');
    check('4b. clear via header → none selected', (await countText()).startsWith('เลือกแล้ว 0 คน'));
    await page.check('.preview-table tbody tr:nth-child(2) td.fz-check input');
    await page.click('.pick-bar button:has-text("ล้างการเลือกทั้งหมด")');
    check('4c. "clear all" button → none selected', (await countText()).startsWith('เลือกแล้ว 0 คน'));
    // search keeps the selection; select-all covers the rows shown only
    await page.check('.preview-table tbody tr:nth-child(1) td.fz-check input');
    const firstCode = (await page.textContent('.preview-table tbody tr:nth-child(1) td.fz-code')).trim();
    const otherCode = (await page.textContent('.preview-table tbody tr:nth-child(4) td.fz-code')).trim();
    await page.fill('.pick-search', otherCode);
    check('search filters the rows', (await page.$$eval('.preview-table tbody tr', (x) => x.length)) === 1 && (await countText()).includes('แสดง 1 จาก'));
    await page.click('.pick-all');
    check('select-all with a search selects the row shown only (2 = earlier + shown)', (await countText()).startsWith('เลือกแล้ว 2 คน'));
    await page.fill('.pick-search', '');
    check('the selection survives the search', (await page.$eval(`.preview-table tbody tr:has(td.fz-code:text-is("${firstCode}")) td.fz-check input`, (e) => e.checked)) && (await countText()).startsWith('เลือกแล้ว 2 คน'));
    await page.screenshot({ path: join(SHOTS, 'preview-1440-selected.png') });

    // 6–8. frozen columns and sticky header
    const pos = () => page.evaluate(() => {
      const r = (sel) => { const e = document.querySelector(sel); const b = e.getBoundingClientRect(); return { left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
      return { check: r('.preview-table tbody tr td.fz-check'), code: r('.preview-table tbody tr td.fz-code'), name: r('.preview-table tbody tr td.fz-name'), head1: r('.preview-table thead tr:first-child th'), head2: r('.preview-table thead tr:last-child th.fz-code') };
    });
    const p0 = await pos();
    const s = await scroll('end');
    await page.waitForTimeout(150);
    const p1 = await pos();
    check('6. scrolled to the far right: checkbox, code and name stay in place', s.max > 200 && s.left >= s.max - 1 && p1.check.left === p0.check.left && p1.code.left === p0.code.left && p1.name.left === p0.name.left, `scroll ${s.left}/${s.max}`);
    check('frozen columns are contiguous (offsets = widths)', p0.code.left === p0.check.right && p0.name.left === p0.code.right, JSON.stringify({ c: p0.check, k: p0.code, n: p0.name }));
    const hit = await page.evaluate(() => {
      const name = document.querySelector('.preview-table tbody tr td.fz-name').getBoundingClientRect();
      const e = document.elementFromPoint(name.left + name.width / 2, name.top + name.height / 2);
      return e?.closest('td')?.classList.contains('fz-name') ?? false;
    });
    check('frozen name is on top (no scrolled column painted over it)', hit);
    const headHit = await page.evaluate(() => ['.preview-table thead tr:last-child th.fz-check', '.preview-table thead tr:last-child th.fz-code', '.preview-table thead tr:last-child th.fz-name', '.preview-table thead tr:first-child th.fz-group'].map((sel) => {
      const el = document.querySelector(sel);
      const b = el.getBoundingClientRect();
      return document.elementFromPoint(b.left + Math.min(12, b.width / 2), b.top + b.height / 2)?.closest('th') === el;
    }));
    check('frozen header cells (checkbox, code, name, group) are on top while scrolled right', headHit.every(Boolean), JSON.stringify(headHit));
    await page.screenshot({ path: join(SHOTS, 'preview-1440-selected-scrolled-right.png') });
    await scroll(0);
    const p2 = await pos();
    check('7. scrolling back left works', (await page.$eval('.preview-wrap', (e) => e.scrollLeft)) === 0 && p2.code.left === p0.code.left);
    check('8. header rows do not overlap (2nd row starts where the group row ends)', p0.head2.top >= p0.head1.bottom - 1, JSON.stringify({ h1: p0.head1, h2: p0.head2 }));
    // vertical scroll inside the table: the sticky header stays above the rows
    const vs = await page.evaluate(() => { const w = document.querySelector('.preview-wrap'); w.scrollTop = 120; const hd = document.querySelector('.preview-table thead tr:last-child th.fz-code').getBoundingClientRect(); const wb = w.getBoundingClientRect(); return { scrolled: w.scrollTop, headTop: Math.round(hd.top - wb.top) }; });
    check('sticky header stays at the top while the table scrolls vertically', vs.scrolled === 0 || vs.headTop <= 60, JSON.stringify(vs));

    // 9. resize
    for (const [w, hgt] of [[1024, 768], [768, 1024], [375, 812]]) {
      await open(w, hgt);
      const m = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, view: window.innerWidth }));
      await scroll('end');
      await page.waitForTimeout(150);
      const q = await pos();
      await page.screenshot({ path: join(SHOTS, `preview-${w}-scrolled-right.png`) });
      check(`9. ${w}px: no page-level horizontal scroll; frozen columns stay contiguous`, m.page <= m.view + 1 && q.code.left === q.check.right && q.name.left === q.code.right, `page ${m.page} / view ${m.view}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });

    // 12. amounts unchanged (selection is local; the preview data is the server's, unchanged)
    const previewAfter = await api('GET', `/api/payroll/periods/${pid}/preview?company=1`);
    check('12. selecting rows does not change any amount', JSON.stringify(previewAfter.body?.totals) === JSON.stringify(previewBefore.body?.totals) && JSON.stringify(previewAfter.body?.rows) === JSON.stringify(previewBefore.body?.rows));
    // 10. selection API availability on this system (and scope enforced server-side)
    const note = (await page.textContent('.pick-note').catch(() => '')) ?? '';
    console.log(`INFO  selection API on this system: ${note.trim() || 'available'}`);
    // 11. requests and console
    console.log(`INFO  API requests: ${[...new Set(requests)].join(' | ')}`);
    check('11. no console errors and no HTTP 5xx', errors.length === 0, errors.join(' | '));
  }
} finally {
  await browser.close();
  stopServer(dev);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
