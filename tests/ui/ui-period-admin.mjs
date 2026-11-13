// Browser test (Chromium): Super Admin payroll period management UI — reopen closed / edit / delete / restore,
// impact counts and warnings before confirmation, controls hidden from Payroll Officer and HR Admin; 1440 + 375.
// Fresh local D1 with demo seed and synthetic users only.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, outDir, freePort, stopServer, seedAccountingSignOff } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const SHOTS = outDir('period-admin-shots');
mkdirSync(SHOTS, { recursive: true });

const USERS = { w_admin: ['super_admin'], w_pay: ['payroll_officer'], w_hra: ['hr_admin'] };
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const persist = join('.tmp', `pa-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const pw = {};
for (const [u, roles] of Object.entries(USERS)) {
  pw[u] = `Pa-${randomBytes(9).toString('base64url')}-7c`;
  const out = join(persist, `${u}.sql`);
  const args = ['scripts/create-user.mjs', '--username', u, '--display', `ทดสอบ ${u}`, '--out', out, '--cred-file', join(persist, 'c.txt')];
  for (const r of roles) args.push('--role', r);
  run(args, { NEW_USER_PASSWORD: pw[u] });
  run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', out]);
}
const port = await freePort();
const dev = spawn(process.execPath, [W, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', `MFA_ENCRYPTION_KEY:${randomBytes(32).toString('base64')}`, '--show-interactive-dev-session=false'], SERVER_SPAWN);
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

function totp(secret, step = 0) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secret.replace(/\s/g, '')) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + step));
  const mac = createHmac('sha1', key).update(msg).digest(); const o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// step-up codes are single-use per user: take a time step (current, +1) not used yet, or wait for the next one
const usedSteps = new Set();
async function stepCode(secret) {
  for (;;) {
    const now = Math.floor(Date.now() / 30000);
    for (const s of [0, 1]) if (!usedSteps.has(now + s)) { usedSteps.add(now + s); return totp(secret, s); }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const secrets = {};
const allErrors = [];
function watch(page, label) {
  page.on('pageerror', (e) => allErrors.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) allErrors.push(`${label} console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500) allErrors.push(`${label} HTTP ${r.status()} ${r.url()}`); });
}
async function login(page, user) {
  await page.goto(BASE + '/');
  await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', user);
  await page.fill('input[name=password]', pw[user]);
  await page.click('button.auth-submit');
  await page.waitForSelector('nav.sidebar, button:has-text("เริ่มตั้งค่า MFA"), input[name=totp]:visible');
  if (await page.$('button:has-text("เริ่มตั้งค่า MFA")')) {
    await page.click('button:has-text("เริ่มตั้งค่า MFA")');
    secrets[user] = (await page.textContent('code.secret')).trim();
    await page.fill('.mfa-setup input', totp(secrets[user]));
    await page.click('text=ยืนยันและเปิดใช้');
  } else if (await page.$('input[name=totp]:visible')) {
    await page.fill('input[name=totp]', totp(secrets[user]));
    await page.click('button.auth-submit');
  }
  await page.waitForSelector('nav.sidebar');
}
const settle = (page) => page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .loading')).then(() => page.waitForTimeout(300));
const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, headers: { 'content-type': 'application/json', 'x-hr-requested': '1' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, path, body]);
const row = (page, code) => page.locator('main tbody tr', { has: page.locator(`td:text-is("${code}")`) });
const noHScroll = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const browser = await chromium.launch({ executablePath: EXE });
try {
  const admin = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  const pay = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  watch(admin, 'admin'); watch(pay, 'pay');
  await login(admin, 'w_admin');
  await login(pay, 'w_pay');
  // a closed (published) period and an empty draft, through the normal workflow
  const a = await api(admin, 'POST', '/api/payroll/periods', { company_id: 1, code: 'UI-2026-10', name: 'ui ต.ค.', start_date: '2026-09-26', end_date: '2026-10-25', pay_date: '2026-10-31' });
  const d = await api(admin, 'POST', '/api/payroll/periods', { company_id: 1, code: 'UI-2027-02', name: 'ui draft', start_date: '2027-01-26', end_date: '2027-02-25', pay_date: '2027-02-28' });
  await api(admin, 'POST', `/api/payroll/periods/${a.body.id}/calculate`);
  const ap = await api(pay, 'POST', `/api/payroll/periods/${a.body.id}/approve`);
  seedAccountingSignOff(persist, a.body.id); // ACC review + sign-off fixture (publish gate, migration 0018)
  const pb = await api(pay, 'POST', `/api/payroll/periods/${a.body.id}/publish`);
  check('setup: published period + empty draft', a.status === 201 && d.status === 201 && ap.status === 200 && pb.status === 200);

  // ---- Super Admin, 1440 -----------------------------------------------------------------------
  await admin.goto(BASE + '/payroll');
  await settle(admin);
  const ra = row(admin, 'UI-2026-10');
  check('admin: closed period shows เปิดงวดที่ปิดแล้ว / แก้ไขงวด / ลบงวด', (await ra.locator('button:has-text("เปิดงวดที่ปิดแล้ว")').count()) === 1 && (await ra.locator('button:has-text("แก้ไขงวด")').count()) === 1 && (await ra.locator('button:has-text("ลบงวด")').count()) === 1);
  check('admin: toolbar shows งวดที่ลบแล้ว', (await admin.locator('button:has-text("งวดที่ลบแล้ว")').count()) === 1);

  await ra.locator('button:has-text("เปิดงวดที่ปิดแล้ว")').click();
  await admin.waitForSelector('.modal');
  const body = await admin.textContent('.modal');
  check('reopen dialog: affected counts, totals, archive, attendance, dependencies shown', ['สลิปที่ได้รับผลกระทบ', 'รวมเงินได้ / สุทธิ', 'Archive', 'ข้อมูลเวลาทำงาน', 'งวดที่เกี่ยวข้อง'].every((t) => body.includes(t)));
  check('reopen dialog: warning about archive / unpublish / no auto recalculation', body.includes('Archive') && body.includes('ยกเลิกการเผยแพร่') && body.includes('ไม่คำนวณใหม่'));
  check('reopen dialog: reason, period-code confirmation and MFA fields', (await admin.locator('.modal textarea').count()) === 1 && body.includes('พิมพ์รหัสงวด') && body.includes('รหัส MFA'));
  await admin.screenshot({ path: join(SHOTS, 'reopen-dialog-1440.png') });
  await admin.click('.modal-actions button:has-text("ยืนยันเปิดงวด")');
  await admin.waitForTimeout(500);
  check('reopen without reason / code / MFA → error shown, dialog stays', (await admin.locator('.modal .form-msg').textContent()).length > 0 && (await admin.locator('.modal').count()) === 1);
  await admin.fill('.modal textarea', 'ทดสอบเปิดงวดจากหน้าจอ');
  await admin.locator('.modal input').nth(0).fill('UI-2026-10');
  await admin.locator('.modal input').nth(1).fill(await stepCode(secrets.w_admin));
  await admin.click('.modal-actions button:has-text("ยืนยันเปิดงวด")');
  await admin.waitForSelector('.modal', { state: 'detached' });
  await settle(admin);
  const ra2 = row(admin, 'UI-2026-10');
  const rowText = await ra2.textContent();
  check('after reopen: status คำนวณแล้ว + badge "เปิดโดย Super Admin" + Super Admin recalculation buttons', rowText.includes('เปิดโดย Super Admin') && (await ra2.locator('button:has-text("คำนวณใหม่ (Super Admin)")').count()) === 1 && (await ra2.locator('button:has-text("อนุมัติ")').count()) === 1);

  // delete dialog on a period with payslips: blockers listed, confirm disabled
  await ra2.locator('button:has-text("ลบงวด")').click();
  await admin.waitForSelector('.modal');
  check('delete dialog (period with payslips): blocker shown and confirm disabled', (await admin.locator('.modal .alert-error').count()) === 1 && (await admin.locator('.modal-actions button:has-text("ยืนยันลบงวด")').isDisabled()));
  await admin.click('.modal-actions button:has-text("ยกเลิก")');

  // edit the draft name
  await row(admin, 'UI-2027-02').locator('button:has-text("แก้ไขงวด")').click();
  await admin.waitForSelector('.modal');
  check('edit dialog: dates editable on an empty draft', !(await admin.locator('.modal input[type=date]').first().isDisabled()));
  await admin.locator('.modal input').nth(0).fill('ui draft (แก้ชื่อ)');
  await admin.fill('.modal textarea', 'แก้ชื่องวดจากหน้าจอ');
  await admin.locator('.modal input[maxlength="6"]').fill(await stepCode(secrets.w_admin));
  await admin.click('.modal-actions button:has-text("บันทึกการแก้ไข")');
  await admin.waitForSelector('.modal', { state: 'detached' });
  await settle(admin);
  check('edit saved: new name in the list', (await row(admin, 'UI-2027-02').textContent()).includes('ui draft (แก้ชื่อ)'));

  // delete the draft, then restore it
  await row(admin, 'UI-2027-02').locator('button:has-text("ลบงวด")').click();
  await admin.waitForSelector('.modal');
  const delBody = await admin.textContent('.modal');
  check('delete dialog (empty draft): soft-delete warning, no blocker', delBody.includes('กู้คืนได้') && (await admin.locator('.modal .alert-error').count()) === 0);
  await admin.fill('.modal textarea', 'สร้างงวดผิด ทดสอบลบ');
  await admin.locator('.modal input').nth(0).fill('UI-2027-02');
  await admin.locator('.modal input').nth(1).fill(await stepCode(secrets.w_admin));
  await admin.click('.modal-actions button:has-text("ยืนยันลบงวด")');
  await admin.waitForSelector('.modal', { state: 'detached' });
  await settle(admin);
  check('deleted draft disappears from the list', (await row(admin, 'UI-2027-02').count()) === 0);
  await admin.click('button:has-text("งวดที่ลบแล้ว")');
  await admin.waitForSelector('.modal');
  check('deleted list shows the period with reason', (await admin.textContent('.modal')).includes('UI-2027-02') && (await admin.textContent('.modal')).includes('สร้างงวดผิด'));
  await admin.click('.modal button:has-text("กู้คืน")');
  await admin.waitForSelector('.modal >> nth=1');
  const restoreModal = admin.locator('.modal').nth(1);
  await restoreModal.locator('textarea').fill('กู้คืนจากหน้าจอ');
  await restoreModal.locator('input').fill(await stepCode(secrets.w_admin));
  await restoreModal.locator('button:has-text("กู้คืน")').click();
  await admin.waitForSelector('.modal', { state: 'detached' });
  await settle(admin);
  check('restored period is back in the list', (await row(admin, 'UI-2027-02').count()) === 1);

  // ---- Payroll Officer and HR Admin: no Super Admin controls ---------------------------------------
  for (const [user, page] of [['w_pay', pay], ['w_hra', null]]) {
    let p = page;
    if (!p) { p = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage(); watch(p, user); await login(p, user); }
    await p.goto(BASE + '/payroll');
    await settle(p);
    const t = await p.textContent('main');
    check(`${user}: no เปิดงวดที่ปิดแล้ว / แก้ไขงวด / ลบงวด / งวดที่ลบแล้ว`, !['เปิดงวดที่ปิดแล้ว', 'แก้ไขงวด', 'ลบงวด', 'งวดที่ลบแล้ว'].some((x) => t.includes(x)));
    const r = row(p, 'UI-2026-10');
    check(`${user}: reopened period has no คำนวณใหม่ / เปิดแก้ไข buttons`, (await r.locator('button:has-text("คำนวณ")').count()) === 0 && (await r.locator('button:has-text("เปิดแก้ไข")').count()) === 0);
    const apis = await p.evaluate(async (id) => Promise.all([`/api/payroll/periods/${id}/impact`, '/api/payroll/deleted-periods'].map(async (u) => (await fetch(u)).status)), a.body.id);
    check(`${user}: admin APIs refused`, apis.every((s) => s === 403), apis.join(','));
  }

  // ---- Super Admin, 375 --------------------------------------------------------------------------
  const m = await (await browser.newContext({ viewport: { width: 375, height: 800 } })).newPage();
  watch(m, 'admin375');
  await login(m, 'w_admin');
  await m.goto(BASE + '/payroll');
  await settle(m);
  check('375: payroll page has no horizontal page scroll', await noHScroll(m));
  await row(m, 'UI-2026-10').locator('button:has-text("ลบงวด")').click();
  await m.waitForSelector('.modal');
  check('375: management dialog fits (no horizontal scroll)', await noHScroll(m));
  await m.screenshot({ path: join(SHOTS, 'delete-dialog-375.png') });

  check('no console errors / page errors / HTTP 5xx', allErrors.length === 0, allErrors.slice(0, 5).join(' || '));
} finally {
  await browser.close();
  stopServer(dev);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
