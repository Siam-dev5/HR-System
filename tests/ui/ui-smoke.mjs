// Browser smoke test of the HR System SPA against a local wrangler dev + local D1.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const SHOTS = outDir('ui-shots');
mkdirSync(SHOTS, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const persist = join('.tmp', `ui-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const pw = {};
for (const [u, role, emp] of [['ui_admin', 'super_admin', null], ['ui_emp', 'employee', 'E007']]) {
  pw[u] = `Ui-${randomBytes(9).toString('base64url')}-7b`;
  const out = join(persist, `${u}.sql`);
  run(['scripts/create-user.mjs', '--username', u, '--role', role, ...(emp ? ['--employee', emp] : []), '--out', out, '--cred-file', join(persist, 'creds.txt')], { NEW_USER_PASSWORD: pw[u] });
  run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', out]);
}
const port = await freePort();
const dev = spawn(process.execPath, [W, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', `MFA_ENCRYPTION_KEY:${randomBytes(32).toString('base64')}`, '--show-interactive-dev-session=false'], SERVER_SPAWN);
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

function totp(secretB32) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secretB32.replace(/\s/g, '')) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', key).update(msg).digest(); const o = mac[19] & 15;
  return String(((mac.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}

const results = [];
let lastPage = null; const allErrors = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const browser = await chromium.launch({ executablePath: EXE, headless: true });
try {
  for (const who of ['ui_emp', 'ui_admin']) {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const page = await ctx.newPage(); lastPage = page;
    const errors = []; const failed = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => { errors.push(e.message); allErrors.push(e.message); });
    page.on('console', (m) => m.type() === 'error' && allErrors.push(m.text()));
    page.on('response', (r) => r.status() >= 500 && failed.push(`${r.status()} ${r.url()}`));
    await page.goto(BASE + '/');
    await page.fill('input[name=username]', who);
    await page.fill('input[name=password]', pw[who]);
    await page.click('button[type=submit]');
    if (who === 'ui_admin') {
      await page.waitForSelector('text=ตั้งค่า MFA ก่อนใช้งาน');
      check('admin: forced MFA enrolment screen shown', true);
      await page.click('text=เริ่มตั้งค่า MFA');
      const secret = await page.textContent('code.secret');
      check('admin: QR code rendered', await page.isVisible('img.qr'));
      await page.fill('.mfa-setup input', totp(secret));
      await page.click('text=ยืนยันและเปิดใช้');
    }
    await page.waitForSelector('nav.sidebar .nav-item', { timeout: 15000 });
    const menu = await page.$$eval('nav.sidebar .nav-item', (as) => as.map((a) => a.textContent));
    check(`${who}: logged in, menu items`, menu.length > 0, `${menu.length} items`);
    await page.waitForSelector('.kpis, .card', { timeout: 10000 });
    await page.screenshot({ path: join(SHOTS, `${who}-dashboard.png`) });

    // every menu entry opens without 403/404/error state
    const bad = [];
    for (const href of await page.$$eval('nav.sidebar .nav-item', (as) => as.map((a) => a.getAttribute('href')))) {
      await page.click(`nav.sidebar a[href="${href}"]`);
      await page.waitForFunction(() => !document.querySelector('main .loading'), null, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(150);
      const txt = await page.textContent('main');
      if (/403 ·|404 ·|ไม่พบหน้าที่ต้องการ|ไม่มีสิทธิ์เข้าถึง|เกิดข้อผิดพลาด|undefined|NaN|\[object Object\]/.test(txt ?? '')) bad.push(`${href}: ${(txt ?? '').slice(0, 80)}`);
    }
    check(`${who}: all ${menu.length} menu pages render without error/403/404/undefined`, bad.length === 0, bad.join(' | '));

    if (who === 'ui_emp') {
      await page.goto(BASE + '/talent');
      await page.waitForSelector('main h2');
      check('employee: direct /talent shows explicit 403 page (no dead link in menu)', (await page.textContent('main')).includes('403'));
      await page.goto(BASE + '/leave');
      await page.click('text=+ ยื่นคำขอ');
      const ownerVisible = await page.isVisible('.modal select[name=employee_id]');
      check('employee: leave form hides employee field (server fills own record)', !ownerVisible);
      await page.selectOption('.modal select[name=leave_type_id]', { index: 1 });
      await page.fill('.modal input[name=start_date]', '2026-11-20');
      await page.fill('.modal input[name=end_date]', '2026-11-20');
      await page.fill('.modal input[name=days]', '1');
      await page.fill('.modal input[name=reason]', 'UI test');
      await page.click('.modal .btn.primary');
      await page.waitForSelector('.toast');
      check('employee: submit leave request via UI', (await page.textContent('.toast')).includes('Workflow'));
      await page.goto(BASE + '/ess');
      await page.waitForSelector('text=ลงเวลาวันนี้');
      await page.click('text=ลงเวลาเข้า');
      await page.waitForSelector('.toast');
      check('employee: clock-in from ESS', (await page.textContent('.toast')).includes('ลงเวลาเข้า'));
    } else {
      await page.goto(BASE + '/employees');
      await page.waitForSelector('table.table');
      await page.click('text=+ เพิ่ม');
      await page.waitForSelector('.modal select[name=department_id] option:nth-child(3)', { state: 'attached' });
      const opts = await page.$$eval('.modal select[name=department_id] option', (o) => o.map((x) => x.textContent));
      check('admin: employee form department dropdown labels', !opts.some((t) => /undefined/.test(t)) && opts.length === 6, opts.slice(1).join(' / '));
      await page.screenshot({ path: join(SHOTS, 'admin-employee-form.png') });
      await page.keyboard.press('Escape');
      await page.goto(BASE + '/analytics');
      await page.waitForSelector('main select option:nth-child(2)', { state: 'attached' });
      const aopts = await page.$$eval('main select option', (o) => o.map((x) => x.textContent));
      check('admin: analytics department filter labels', !aopts.some((t) => /undefined/.test(t)), aopts.join(' / '));
      await page.goto(BASE + '/dashboard');
      await page.waitForSelector('.ninebox a.box');
      await page.click('.ninebox a.box-9');
      await page.waitForSelector('.ninebox .box.focus');
      check('admin: dashboard 9-box link opens Talent page', page.url().includes('/talent?box=9') && !(await page.textContent('main')).includes('403'));
      await page.goto(BASE + '/payroll');
      await page.click('text=+ สร้างงวด');
      await page.click('.modal .btn.primary');
      await page.waitForSelector('text=คำนวณ');
      check('admin: payroll period created from UI', true);
      await page.screenshot({ path: join(SHOTS, 'admin-payroll.png') });
    }
    check(`${who}: no console errors`, errors.length === 0, errors.slice(0, 3).join(' | '));
    check(`${who}: no 5xx responses`, failed.length === 0, failed.join(' | '));
    await ctx.close();
  }
} catch (e) {
  check('unexpected exception', false, e.message.split('\n')[0]);
  if (lastPage) {
    await lastPage.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => {});
    console.log('URL', lastPage.url());
    console.log('BODY', ((await lastPage.textContent('body').catch(() => '')) ?? '').slice(0, 400));
  }
  console.log('ERRORS', allErrors.slice(0, 5));
} finally {
  await browser.close();
  stopServer(dev);
}
const failedCount = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failedCount}/${results.length} checks passed`);
process.exit(failedCount ? 1 : 0);
