// Browser test of the Login / Registration UI. BASE defaults to a fresh local wrangler dev; pass a URL to test elsewhere.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const SHOTS = outDir('ui-auth-shots');
mkdirSync(SHOTS, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const persist = join('.tmp', `uiauth-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const pw = {};
for (const [u, role, emp] of [['ua_admin', 'super_admin', null], ['ua_mgr', 'hr_manager', 'E002'], ['ua_emp', 'employee', 'E007']]) {
  pw[u] = `Ua-${randomBytes(9).toString('base64url')}-7c`;
  const out = join(persist, `${u}.sql`);
  run(['scripts/create-user.mjs', '--username', u, '--role', role, ...(emp ? ['--employee', emp] : []), '--out', out, '--cred-file', join(persist, 'c.txt')], { NEW_USER_PASSWORD: pw[u] });
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
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const browser = await chromium.launch({ executablePath: EXE, headless: true });
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/status of (401|403|409|429)/.test(m.text()) && errors.push(m.text()));
};
try {
  // ---- Login page: desktop ----------------------------------------------------------------
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  watch(page);
  await page.goto(BASE + '/');
  await page.waitForSelector('.auth-card');
  check('login: brand panel, title and form render', await page.isVisible('.auth-brand') && (await page.textContent('.auth-title')) === 'ยินดีต้อนรับกลับ' && await page.isVisible('input[name=username]'));
  check('login: link to registration', await page.isVisible('.auth-switch a[href="/register"]'));
  await page.screenshot({ path: join(SHOTS, 'login-desktop.png') });
  await page.fill('input[name=password]', 'Secret-123');
  check('password hidden by default', (await page.getAttribute('input[name=password]', 'type')) === 'password');
  await page.click('.pw-toggle');
  check('show password toggle → text', (await page.getAttribute('input[name=password]', 'type')) === 'text' && (await page.getAttribute('.pw-toggle', 'aria-pressed')) === 'true');
  await page.click('.pw-toggle');
  check('hide password toggle → password', (await page.getAttribute('input[name=password]', 'type')) === 'password');
  await page.fill('input[name=password]', '');
  await page.click('button.auth-submit');
  check('client validation: empty username', (await page.textContent('.auth-alert')).includes('กรุณากรอกชื่อผู้ใช้') && (await page.getAttribute('input[name=username]', 'aria-invalid')) === 'true');
  await page.fill('input[name=username]', 'ua_emp');
  await page.fill('input[name=password]', 'Wrong-Password-1');
  await page.click('button.auth-submit');
  await page.waitForFunction(() => document.querySelector('.auth-alert')?.textContent?.includes('ไม่ถูกต้อง'));
  check('wrong password: clear error message', (await page.textContent('.auth-alert')).includes('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง') && (await page.inputValue('input[name=password]')) === '');
  await page.screenshot({ path: join(SHOTS, 'login-error.png') });

  // ---- Registration ------------------------------------------------------------------------
  await page.click('.auth-switch a');
  await page.waitForSelector('input[name=confirmPassword]');
  check('register page reachable via link (/register)', page.url().endsWith('/register') && (await page.textContent('.auth-title')) === 'ลงทะเบียนผู้ใช้ใหม่');
  await page.fill('input[name=displayName]', 'ผู้สมัคร ทดสอบ UI');
  await page.fill('input[name=username]', 'ui_reg_user');
  await page.fill('input[name=password]', 'short');
  check('live password rules show unmet rules', (await page.$$eval('.pw-rules li.ok', (l) => l.length)) < 3);
  await page.click('button.auth-submit');
  check('register validation: weak password blocked', (await page.textContent('.auth-alert')).includes('รหัสผ่านยังไม่ผ่านเงื่อนไข'));
  await page.fill('input[name=password]', 'Ui-Register-Pass-2026');
  await page.fill('input[name=confirmPassword]', 'Ui-Register-Pass-2027');
  check('confirm mismatch hint', (await page.textContent('.auth-field .auth-hint.bad')).includes('ไม่ตรงกัน'));
  await page.click('button.auth-submit');
  check('register validation: mismatch blocked', (await page.textContent('.auth-alert')).includes('ยืนยันรหัสผ่านไม่ตรงกัน'));
  await page.fill('input[name=confirmPassword]', 'Ui-Register-Pass-2026');
  check('all password rules satisfied', (await page.$$eval('.pw-rules li.ok', (l) => l.length)) === 3);
  await page.fill('input[name=employeeCode]', 'E006');
  await page.screenshot({ path: join(SHOTS, 'register-desktop.png') });
  await page.click('button.auth-submit');
  await page.waitForSelector('text=ส่งคำขอลงทะเบียนแล้ว');
  check('registration submitted → pending message', (await page.textContent('.auth-subtitle')).includes('รอผู้ดูแลระบบ'));
  await page.click('.auth-submit.as-link');
  await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', 'ui_reg_user');
  await page.fill('input[name=password]', 'Ui-Register-Pass-2026');
  await page.click('button.auth-submit');
  await page.waitForFunction(() => !!document.querySelector('.auth-alert-error:not([hidden])') && !document.querySelector('button.auth-submit')?.disabled);
  check('pending account cannot log in (clear message)', (await page.textContent('.auth-alert')).includes('รอการอนุมัติ'));
  await page.goto(BASE + '/register');
  await page.waitForSelector('input[name=confirmPassword]');
  await page.fill('input[name=displayName]', 'ซ้ำ');
  await page.fill('input[name=username]', 'ui_reg_user');
  await page.fill('input[name=password]', 'Ui-Register-Pass-2026');
  await page.fill('input[name=confirmPassword]', 'Ui-Register-Pass-2026');
  await page.click('button.auth-submit');
  await page.waitForFunction(() => !!document.querySelector('.auth-alert-error:not([hidden])') && !document.querySelector('button.auth-submit')?.disabled);
  check('duplicate username error shown on field', (await page.textContent('.auth-alert')).includes('ถูกใช้แล้ว') && (await page.getAttribute('input[name=username]', 'aria-invalid')) === 'true');
  await ctx.close();

  // ---- Mobile layout ------------------------------------------------------------------------
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mp = await m.newPage();
  watch(mp);
  await mp.goto(BASE + '/');
  await mp.waitForSelector('.auth-card');
  const noScroll = await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const stacked = await mp.evaluate(() => document.querySelector('.auth-brand').getBoundingClientRect().bottom <= document.querySelector('.auth-card').getBoundingClientRect().top + 1);
  check('mobile: no horizontal scroll, brand stacked above form', noScroll && stacked);
  await mp.screenshot({ path: join(SHOTS, 'login-mobile.png'), fullPage: true });
  await mp.goto(BASE + '/register');
  await mp.waitForSelector('input[name=confirmPassword]');
  check('mobile register: single-column fields, no horizontal scroll', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await mp.screenshot({ path: join(SHOTS, 'register-mobile.png'), fullPage: true });
  await m.close();

  // ---- Super Admin: forced MFA via new UI, approve the registration -------------------------
  const a = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ap = await a.newPage();
  watch(ap);
  await ap.goto(BASE + '/');
  await ap.fill('input[name=username]', 'ua_admin');
  await ap.fill('input[name=password]', pw.ua_admin);
  await ap.click('button.auth-submit');
  await ap.waitForSelector('text=ตั้งค่า MFA ก่อนใช้งาน');
  check('first login of Super Admin → forced MFA screen (new layout)', await ap.isVisible('.auth-card'));
  await ap.click('text=เริ่มตั้งค่า MFA');
  const secret = await ap.textContent('code.secret');
  await ap.fill('.mfa-setup input', totp(secret));
  await ap.click('text=ยืนยันและเปิดใช้');
  await ap.waitForSelector('nav.sidebar');
  const menu = await ap.$$eval('nav.sidebar .nav-item', (x) => x.map((e) => e.textContent));
  check('Super Admin sees ผู้ใช้ระบบ and บทบาท & สิทธิ์', menu.includes('ผู้ใช้ระบบ') && menu.includes('บทบาท & สิทธิ์'));
  await ap.click('nav.sidebar a[href="/admin/users"]');
  await ap.waitForSelector('.pending-card');
  check('pending registration listed for Super Admin', (await ap.textContent('.pending-card')).includes('ui_reg_user'));
  await ap.click('.pending-card button.primary');
  await ap.waitForSelector('.modal');
  const checkedRoles = await ap.$$eval('.modal .checks input:checked', (x) => x.map((i) => i.value));
  check('approve dialog defaults to least privilege (employee)', JSON.stringify(checkedRoles) === '["employee"]');
  await ap.click('.modal .btn.primary');
  await ap.waitForSelector('.toast');
  await ap.screenshot({ path: join(SHOTS, 'admin-users.png') });
  // logout and re-login with TOTP through the new form
  await ap.click('[aria-controls=user-menu]'); await ap.click('#user-menu >> text=ออกจากระบบ');
  await ap.waitForSelector('.auth-card input[name=username]');
  await ap.fill('input[name=username]', 'ua_admin');
  await ap.fill('input[name=password]', pw.ua_admin);
  await ap.click('button.auth-submit');
  await ap.waitForSelector('input[name=totp]', { state: 'visible' });
  check('second login asks for 6-digit MFA code in the login card', (await ap.textContent('.auth-alert')).includes('MFA'));
  await ap.fill('input[name=totp]', totp(secret));
  await ap.click('button.auth-submit');
  await ap.waitForSelector('nav.sidebar');
  check('MFA login completes', true);
  await a.close();

  // ---- Approved user and Manager -------------------------------------------------------------
  for (const [user, password, expectAdmin] of [['ui_reg_user', 'Ui-Register-Pass-2026', false], ['ua_mgr', pw.ua_mgr, false]]) {
    const c = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const p = await c.newPage();
    watch(p);
    await p.goto(BASE + '/');
    await p.fill('input[name=username]', user);
    await p.fill('input[name=password]', password);
    await p.click('button.auth-submit');
    await p.waitForSelector('nav.sidebar');
    const items = await p.$$eval('nav.sidebar .nav-item', (x) => x.map((e) => e.getAttribute('href')));
    check(`${user}: logs in; no user/role management menu`, !items.includes('/admin/users') && !items.includes('/admin/roles') === !expectAdmin);
    await p.goto(BASE + '/admin/users');
    await p.waitForSelector('main h2');
    check(`${user}: direct /admin/users shows 403`, (await p.textContent('main')).includes('403'));
    await p.goto(BASE + '/admin/roles');
    await p.waitForSelector('main h2');
    check(`${user}: direct /admin/roles shows 403`, (await p.textContent('main')).includes('403'));
    await c.close();
  }
  check('no unexpected console/page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('unexpected exception', false, e.message.split('\n')[0]);
} finally {
  await browser.close();
  stopServer(dev);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
