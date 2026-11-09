// App Management in the browser (local only; fresh local D1; synthetic users): the menu item is shown to the Super
// Admin only; ACC Staff and ACC Manager neither see it nor open it by URL (403 page); the page shows its loading,
// empty, error and success states; the Super Admin creates a user (temporary password shown once), filters users and
// opens the permission matrix; no console errors.
// usage: node tests/ui/ui-app-management.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('app-management');
mkdirSync(OUT, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `app-mgmt-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const USERS = { m_super: 'super_admin', m_accstaff: 'acc_staff', m_accmgr: 'acc_manager' };
const pw = {};
for (const [u, role] of Object.entries(USERS)) {
  pw[u] = `Am-${randomBytes(9).toString('base64url')}-7q`;
  const f = join(persist, `${u}.sql`);
  run(['scripts/create-user.mjs', '--username', u, '--display', `ทดสอบ ${u}`, '--out', f, '--cred-file', join(persist, 'c.txt'), '--role', role], { NEW_USER_PASSWORD: pw[u] });
  run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', f]);
}
const sql = (command) => JSON.parse(run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--json', '--command', command]))[0].results;
const port = await freePort();
const dev = spawn(process.execPath, [W, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', `MFA_ENCRYPTION_KEY:${randomBytes(32).toString('base64')}`, '--show-interactive-dev-session=false'], SERVER_SPAWN);
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
const browser = await chromium.launch({ executablePath: EXE });
// responses the test forces on purpose (error state) are not counted as errors
const forced = new Set();

async function session(user) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'th-TH' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${user}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${user}: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500 && !forced.has(r.url())) errors.push(`${user}: HTTP ${r.status()} ${r.url()}`); });
  await page.goto(BASE + '/login'); await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw[user]); await page.click('button.auth-submit');
  await page.waitForSelector('nav.sidebar, button:has-text("เริ่มตั้งค่า MFA"), input[name=totp]:visible');
  if (await page.$('button:has-text("เริ่มตั้งค่า MFA")')) {
    await page.click('button:has-text("เริ่มตั้งค่า MFA")');
    const secret = (await page.textContent('code.secret')).trim();
    await page.fill('.mfa-setup input', totp(secret));
    await page.click('text=ยืนยันและเปิดใช้');
  }
  await page.waitForSelector('nav.sidebar');
  return { ctx, page };
}
const settled = (page) => page.waitForFunction(() => !document.querySelector('main .loading'));
const menuHas = (page) => page.$$eval('nav.sidebar a', (as) => as.some((a) => a.getAttribute('href')?.endsWith('/admin/app-management')));

try {
  // ---- ACC Staff / ACC Manager: no menu, direct URL refused -------------------------------------------------------
  for (const u of ['m_accstaff', 'm_accmgr']) {
    const s = await session(u);
    check(`${u}: App Management not in the menu`, !(await menuHas(s.page)));
    await s.page.goto(BASE + '/admin/app-management');
    await s.page.waitForSelector('main .state-page, main .am-tabs');
    const text = await s.page.textContent('main');
    check(`${u}: direct URL shows the 403 page and no admin data`, text.includes('403') && !(await s.page.$('main .am-tabs')) && !text.includes('m_super'), text.slice(0, 80));
    const api = await s.page.evaluate(() => fetch('/api/admin/app/users').then((r) => r.status));
    check(`${u}: the API refuses the same data (403)`, api === 403, String(api));
    await s.ctx.close();
  }

  // ---- Super Admin --------------------------------------------------------------------------------------------------
  const s = await session('m_super');
  const page = s.page;
  check('Super Admin: App Management in the menu', await menuHas(page));
  // loading state: hold the overview response for a moment
  await page.route('**/api/admin/app/overview', async (route) => { await new Promise((r) => setTimeout(r, 1200)); await route.continue(); });
  await page.click('nav.sidebar a[href$="/admin/app-management"]');
  await page.waitForSelector('main .am-body .loading');
  check('loading state shown while the overview loads', true);
  await page.waitForSelector('main .kpis .kpi');
  await page.unroute('**/api/admin/app/overview');
  const kpis = await page.$$eval('main .kpis .kpi', (k) => k.length);
  check('overview: KPI cards rendered from the API', kpis >= 6, String(kpis));
  await page.screenshot({ path: join(OUT, 'overview.png'), fullPage: true });

  // users tab: rows, then an empty result
  await page.click('.am-tabs button[data-tab="users"]');
  await page.waitForSelector('main tr[data-user="m_accstaff"]');
  const accRow = await page.textContent('main tr[data-user="m_accstaff"]');
  check('users: ACC Staff row shows role, all-company scope and MFA status', accRow.includes('acc_staff') && accRow.includes('ทุกบริษัท') && accRow.includes('MFA'), accRow.slice(0, 160));
  await page.fill('main input[type=search]', 'no-such-user-zz');
  await page.press('main input[type=search]', 'Enter');
  await page.waitForSelector('main td.empty');
  check('users: empty state for a search without results', (await page.textContent('main td.empty')).includes('ไม่พบผู้ใช้'));

  // success state: create a user through the form, temporary password shown once
  await page.goto(BASE + '/admin/app-management?tab=users');
  await page.waitForSelector('main button[data-action="add-user"]');
  await page.click('main button[data-action="add-user"]');
  await page.waitForSelector('.modal .grid-form input');
  const inputs = await page.$$('.modal .grid-form input');
  await inputs[0].fill('zz_ui_created');
  await inputs[1].fill('ผู้ใช้ทดสอบ UI');
  await page.check('.modal .checks input[value="employee"]');
  await page.click('.modal button[data-action="save-user"]');
  await page.waitForSelector('.modal code.secret');
  const created = sql("SELECT u.must_change_password, (SELECT group_concat(r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) roles FROM users u WHERE username = 'zz_ui_created'")[0];
  check('success: user created with a one-time temporary password and a forced change', created?.must_change_password === 1 && created?.roles === 'employee', JSON.stringify(created));
  const audit = sql("SELECT details FROM audit_logs WHERE action = 'user.created' ORDER BY id DESC LIMIT 1")[0];
  const shown = (await page.textContent('.modal code.secret')).trim();
  check('audit records the creation without the password', audit && !audit.details.includes(shown));
  await page.keyboard.press('Escape');
  await page.waitForSelector('main tr[data-user="zz_ui_created"]');
  check('users list refreshed after creation', true);

  // permission matrix
  await page.goto(BASE + '/admin/app-management?tab=matrix&role=acc_manager');
  await page.waitForSelector('main table.am-matrix');
  const preview = await page.$eval('main tr[data-resource="payroll_preview"] input[value="payroll_preview.export"]', (i) => i.checked);
  const exportCsv = await page.$eval('main tr[data-resource="payroll"] input[value="payroll.export"]', (i) => i.checked);
  check('matrix: ACC Manager has payroll_preview.export and not payroll.export', preview && !exportCsv);
  await page.screenshot({ path: join(OUT, 'matrix.png'), fullPage: false });

  // error state: the API answers with an error
  const target = `${BASE}/api/admin/app/security`;
  forced.add(target);
  await page.route('**/api/admin/app/security', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unavailable', message: 'ทดสอบ: บริการไม่พร้อม' } }) }));
  await page.goto(BASE + '/admin/app-management?tab=security');
  await page.waitForSelector('main .alert-error');
  check('error state: the API error is shown in an alert', (await page.textContent('main .alert-error')).includes('ทดสอบ: บริการไม่พร้อม'));
  await page.unroute('**/api/admin/app/security');
  await page.goto(BASE + '/admin/app-management?tab=security');
  await settled(page);
  await page.waitForSelector('main tr[data-user="m_accmgr"]');
  check('security tab lists accounts with MFA status', (await page.textContent('main tr[data-user="m_accmgr"]')).includes('MFA'));

  // mobile width: no horizontal page scroll
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '/admin/app-management?tab=users');
  await page.waitForSelector('main tr[data-user]');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('390px wide: no horizontal page scroll', overflow <= 1, String(overflow));
  await s.ctx.close();
} finally {
  await browser.close();
  stopServer(dev);
}
check('no console errors / page errors / HTTP 5xx', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-app-management pass=${results.length - fail} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
