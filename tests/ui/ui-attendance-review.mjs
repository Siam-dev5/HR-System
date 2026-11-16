// Browser test (Chromium): HR attendance review before Calculate (migration 0025) and the mid-month policy of 2026-11-16.
// Local wrangler dev + fresh local D1 (synthetic data only; nothing remote). Real API, real database: no mock data.
// Checks: Calculate refused with a clear reason before the review; the review lists per employee the salary
// entitlement, expected / actual days, hours, unpaid leave, absence, payable days, the deducted dates and the records
// waiting for review (missing clock-out, not deducted); HR confirms; a later attendance correction cancels the
// confirmation (shown) and Calculate is refused again; after a new confirmation Calculate works and the Preview shows
// the separate day columns and the amounts (23,000 → 12,266.67; 18,000 with one unpaid day → 9,000); a user without the
// permission cannot confirm; no page-level horizontal scroll at 375 px; no console errors / HTTP 5xx; screenshots at
// 1440 and 375.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const SHOTS = outDir('attendance-review');
mkdirSync(SHOTS, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const persist = join('.tmp', `uar-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
// synthetic probation employees of a new company ZUR, round 26 Oct – 10 Nov 2026 (rest Sat/Sun)
const weekdays = [];
for (let t = Date.parse('2026-10-26T00:00:00Z'); t <= Date.parse('2026-11-10T00:00:00Z'); t += 86_400_000) {
  const d = new Date(t);
  if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) weekdays.push(d.toISOString().slice(0, 10));
}
const att = (code, days) => days.map((d) => `((SELECT id FROM employees WHERE emp_code = '${code}'), '${d}', '09:00', '18:00', 'present', 'import', 480)`).join(', ');
const fixture = join(persist, 'fixture.sql');
writeFileSync(join(ROOT, fixture), `INSERT INTO companies (code, name, active) VALUES ('ZUR', 'ทดสอบ ตรวจเวลา', 1);
INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status, base_salary) VALUES
  ('ZW1', 'ทดสอบ', 'ผ่านทดลองงานในรอบ', (SELECT id FROM companies WHERE code = 'ZUR'), '2026-08-03', 'probation', 'probation', 23000),
  ('ZW2', 'ทดสอบ', 'ลาไม่รับค่าจ้าง', (SELECT id FROM companies WHERE code = 'ZUR'), '2026-08-06', 'probation', 'probation', 18000);
INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source, worked_minutes) VALUES ${att('ZW1', weekdays)}, ${att('ZW2', weekdays.filter((d) => d !== '2026-10-26' && d !== '2026-10-30'))};
INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source) VALUES ((SELECT id FROM employees WHERE emp_code = 'ZW2'), '2026-10-26', '08:42', NULL, 'present', 'import');
INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status)
  SELECT (SELECT id FROM employees WHERE emp_code = 'ZW2'), id, '2026-10-30', '2026-10-30', 1, 'ทดสอบ ลากิจไม่รับค่าจ้าง', 'approved' FROM leave_types WHERE code = 'UNPAID';`);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', fixture]);
const USERS = { u_pay: ['payroll_officer', 'E003'], u_hr: ['super_admin', null], u_staff: ['hr_staff', 'E005'] };
const pw = {};
for (const [u, [role, emp]] of Object.entries(USERS)) {
  pw[u] = `Ar-${randomBytes(9).toString('base64url')}-7c`;
  const out = join(persist, `${u}.sql`);
  run(['scripts/create-user.mjs', '--username', u, '--display', `ทดสอบ ${u}`, '--role', role, ...(emp ? ['--employee', emp] : []), '--out', out, '--cred-file', join(persist, 'c.txt')], { NEW_USER_PASSWORD: pw[u] });
  run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', out]);
}
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
const browser = await chromium.launch({ executablePath: EXE });
async function session(user) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${user} pageerror: ${e.message}`));
  // 409 answers of refused calculations are expected here; only script errors count
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${user} console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${user} HTTP ${r.status()} ${r.url()}`); });
  await page.goto(BASE + '/');
  await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', user);
  await page.fill('input[name=password]', pw[user]);
  await page.click('button.auth-submit');
  await page.waitForSelector('nav.sidebar, button:has-text("เริ่มตั้งค่า MFA"), input[name=new-password], input[type=password]:not([name=password])');
  if (await page.$('button:has-text("เริ่มตั้งค่า MFA")')) {
    await page.click('button:has-text("เริ่มตั้งค่า MFA")');
    const secret = (await page.textContent('code.secret')).trim();
    await page.fill('.mfa-setup input', totp(secret));
    await page.click('text=ยืนยันและเปิดใช้');
  }
  await page.waitForSelector('nav.sidebar');
  return page;
}
const settle = (page) => page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .loading')).then(() => page.waitForTimeout(300));
const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, headers: { 'content-type': 'application/json', 'x-hr-requested': '1' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, path, body]);
const row = (page) => page.locator('main table tbody tr', { hasText: 'ZUR-2026-11-M' });
const openReview = async (page) => {
  await page.goto(BASE + '/payroll');
  await settle(page);
  await row(page).locator('button:has-text("ตรวจสอบเวลาทำงาน")').click();
  await page.waitForSelector('.modal .attendance-review');
  await page.waitForTimeout(200);
};
const closeModals = async (page) => {
  while (await page.$('.modal .icon-btn[aria-label="ปิด"]')) { await page.click('.modal .icon-btn[aria-label="ปิด"] >> nth=-1'); await page.waitForTimeout(150); }
};
const cell = async (page, code, col) => {
  const headers = await page.$$eval('.attendance-review table:first-of-type thead th', (ths) => ths.map((t) => t.textContent));
  const i = headers.findIndex((t) => t?.startsWith(col));
  return (await page.locator(`.attendance-review tr:has(td:text-is("${code}")) td`).nth(i).textContent())?.trim();
};

try {
  const pay = await session('u_pay');
  const companyId = JSON.parse(run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--command', "SELECT id FROM companies WHERE code = 'ZUR'", '--json']))[0].results[0].id;
  const status = async () => ((await api(pay, 'GET', '/api/payroll/periods')).body ?? []).find((x) => x.id === pid)?.status;
  const created = await api(pay, 'POST', '/api/payroll/periods', { code: 'ZUR-2026-11-M', name: 'ทดสอบ กลางเดือน 11/2569', kind: 'mid_month', company_id: companyId, start_date: '2026-10-26', end_date: '2026-11-10', pay_date: '2026-11-15' });
  check('period created (company ZUR, round 26 Oct – 10 Nov)', created.status === 201, JSON.stringify(created.body).slice(0, 120));
  const pid = created.body.id;
  check('the period belongs to company ZUR only', created.body.company_id === companyId);

  // 1. Calculate before the review: refused with a clear reason
  await pay.goto(BASE + '/payroll');
  await settle(pay);
  check('the period list explains the step order (review before calculate)', ((await pay.textContent('main p.lead')) ?? '').includes('ตรวจสอบเวลาทำงาน (HR ยืนยัน) → คำนวณ'));
  await row(pay).locator('button:has-text("คำนวณ")').first().click();
  await pay.click('.modal-actions button:has-text("คำนวณ")');
  const refused = await pay.waitForSelector('.toast-error').then((t) => t.textContent());
  check('Calculate before the review is refused with the reason shown', /Attendance Review/.test(refused ?? ''), refused ?? '');
  check('nothing was calculated', (await status()) === 'draft');
  await pay.screenshot({ path: join(SHOTS, 'calculate-refused-1440.png') });

  // 2. the review: per employee figures and anomalies
  await openReview(pay);
  const text = (await pay.textContent('.modal .attendance-review')) ?? '';
  check('status: waiting for HR', text.includes('รอ HR ตรวจสอบ'));
  check('ZW1: entitlement 16 (calendar), expected 12, actual 12, payable 16', (await cell(pay, 'ZW1', 'วันมีสิทธิ์')) === '16 *' && (await cell(pay, 'ZW1', 'วันทำงานตามตาราง')) === '12' && (await cell(pay, 'ZW1', 'วันทำงานจริง')) === '12' && (await cell(pay, 'ZW1', 'วันจ่ายจริง')) === '16');
  check('ZW2: unpaid leave 1, payable 15, the deducted date shown with its leave', (await cell(pay, 'ZW2', 'ลาไม่รับค่าจ้าง')) === '1' && (await cell(pay, 'ZW2', 'วันจ่ายจริง')) === '15' && ((await cell(pay, 'ZW2', 'วันที่หัก')) ?? '').includes('ลาไม่รับค่าจ้าง'));
  check('ZW2: missing clock-out on 26 Oct listed as waiting for review, not deducted', ((await cell(pay, 'ZW2', 'รายการผิดปกติ')) ?? '').includes('รอตรวจสอบ 1') && text.includes('ไม่มีเวลาออกงาน') && (await cell(pay, 'ZW2', 'ขาดงาน')) === '0');
  await pay.screenshot({ path: join(SHOTS, 'review-pending-1440.png'), fullPage: true });

  // 3. HR confirms
  await pay.click('.attendance-review button:has-text("ยืนยันผลตรวจสอบ")');
  await pay.click('.modal-actions button:has-text("ยืนยันผลตรวจสอบ")');
  await pay.waitForSelector('.modal .attendance-review .s-approved');
  check('after confirming: status confirmed, reviewer shown', ((await pay.textContent('.modal .attendance-review')) ?? '').includes('ยืนยันโดย u_pay'));
  await pay.screenshot({ path: join(SHOTS, 'review-confirmed-1440.png'), fullPage: true });
  await closeModals(pay);

  // 4. attendance corrected after the confirmation: the confirmation is cancelled and Calculate refused again
  const zw1 = (await api(pay, 'GET', `/api/payroll/periods/${pid}/attendance-review`)).body.employees.find((e) => e.emp_code === 'ZW1');
  const hr = await session('u_hr');
  const fix = await api(hr, 'POST', `/api/attendance/records`, { employee_id: zw1.employee_id, work_date: '2026-10-31', clock_in: '09:00', clock_out: '12:00', reason: 'ทดสอบ เพิ่มวันทำงานเสาร์', reference: 'zz-ui-1' });
  check('an attendance record added after the confirmation (authorised correction API)', fix.status === 200 || fix.status === 201, JSON.stringify(fix.body).slice(0, 160));
  await openReview(pay);
  const changed = (await pay.textContent('.modal .attendance-review')) ?? '';
  check('the review shows the confirmation was cancelled by the change', changed.includes('ถูกยกเลิก เพราะข้อมูลเวลาทำงานเปลี่ยนหลังยืนยัน'));
  check('ZW1 actual days now 13; entitlement still 16 (actual days never multiply the salary)', (await cell(pay, 'ZW1', 'วันทำงานจริง')) === '13' && (await cell(pay, 'ZW1', 'วันจ่ายจริง')) === '16');
  await pay.screenshot({ path: join(SHOTS, 'review-changed-1440.png'), fullPage: true });
  // 5. confirm again, then calculate from the period list
  await pay.click('.attendance-review button:has-text("ยืนยันผลตรวจสอบ")');
  await pay.click('.modal-actions button:has-text("ยืนยันผลตรวจสอบ")');
  await pay.waitForSelector('.modal .attendance-review .s-approved');
  await closeModals(pay);
  await pay.goto(BASE + '/payroll');
  await settle(pay);
  await row(pay).locator('button:has-text("คำนวณ")').first().click();
  await pay.click('.modal-actions button:has-text("คำนวณ")');
  await pay.waitForSelector('.toast-ok');
  check('Calculate works after the confirmation', (await status()) === 'calculated');

  // 6. Preview: separate day columns and amounts
  await pay.goto(BASE + `/payroll/preview?period_id=${pid}`);
  await settle(pay);
  const preview = (await api(pay, 'GET', `/api/payroll/periods/${pid}/preview`)).body;
  const pr = Object.fromEntries((preview.rows ?? []).map((r) => [r.emp_code, r]));
  check('Preview ZW1: 12,266.67 (23,000 / 30 × 16), entitlement 16, payable 16, no SSO', pr.ZW1?.net_pay === 12266.67 && pr.ZW1?.entitlement_days === 16 && pr.ZW1?.payable_days === 16 && pr.ZW1?.sso === 0, JSON.stringify(pr.ZW1 ?? {}).slice(0, 200));
  check('Preview ZW2: 9,000 (18,000 / 30 × 15), unpaid 1 day = −600, review confirmed', pr.ZW2?.net_pay === 9000 && pr.ZW2?.unpaid_leave_days === 1 && pr.ZW2?.unpaid_leave_amount === -600 && String(pr.ZW2?.attendance_review).startsWith('ยืนยันแล้ว'), JSON.stringify(pr.ZW2 ?? {}).slice(0, 200));
  const head = (await pay.textContent('main')) ?? '';
  check('Preview page shows the separate day columns', ['วันมีสิทธิ์เงินเดือน', 'วันจ่ายจริง', 'วันขาดงาน', 'สถานะตรวจสอบเวลาทำงาน'].every((t) => head.includes(t)));
  await pay.screenshot({ path: join(SHOTS, 'preview-1440.png') });

  // 7. a user without the permission cannot confirm
  const staff = await session('u_staff');
  const denied = await api(staff, 'POST', `/api/payroll/periods/${pid}/attendance-review/confirm`, { company_id: companyId, version: 'x' });
  check('hr_staff cannot confirm (403)', denied.status === 403);

  // 8. mobile 375: the review opens without page-level horizontal scroll (tables scroll inside)
  await pay.setViewportSize({ width: 375, height: 812 });
  await pay.goto(BASE + '/payroll');
  await settle(pay);
  const listW = await pay.evaluate(() => ({ page: document.documentElement.scrollWidth, view: window.innerWidth }));
  check('375px: period list without page-level horizontal scroll', listW.page <= listW.view + 1, `${listW.page}/${listW.view}`);
  await openReview(pay);
  const m = await pay.evaluate(() => ({ page: document.documentElement.scrollWidth, view: window.innerWidth, modal: Math.round(document.querySelector('.modal').getBoundingClientRect().right) }));
  check('375px: review modal fits the screen (no page-level horizontal scroll)', m.page <= m.view + 1 && m.modal <= m.view + 1, `${m.page}/${m.view} modal right ${m.modal}`);
  await pay.screenshot({ path: join(SHOTS, 'review-375.png'), fullPage: true });

  check('no console errors and no HTTP 5xx', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  stopServer(dev);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
