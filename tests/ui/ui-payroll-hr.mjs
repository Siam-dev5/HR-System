// Browser test (Chromium): HR payroll screens (P4–P6) — employee list of a period, contract periods, pay frequency.
// Local wrangler dev + fresh local D1 (synthetic data only; nothing remote). Real API, real database: no mock data.
// Checks: list + summary + warnings + filters; take out (reason required, per-employee results); add from outside the
// list (per-employee results, eligibility shown, not paid automatically); HR confirmation of a review case (override
// permission); contract recorded → review reason in the list; pay frequency change with reason; permission-denied
// state for a user without access; no console errors / HTTP 5xx; screenshots at 1440 and 375.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const SHOTS = outDir('payroll-hr');
mkdirSync(SHOTS, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const persist = join('.tmp', `phr-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
// synthetic employees of the demo company 1: a suspended one (review), one without a salary (blocked), a contract one
const fixture = join(persist, 'fixture.sql');
writeFileSync(join(ROOT, fixture), `INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status, base_salary) VALUES
  ('ZU1', 'ทดสอบ', 'พักงาน', 1, '2026-01-01', 'permanent', 'suspended', 25000),
  ('ZU2', 'ทดสอบ', 'ไม่มีเงินเดือน', 1, '2026-01-01', 'permanent', 'active', NULL),
  ('ZU3', 'ทดสอบ', 'สัญญาจ้าง', 1, '2026-01-01', 'contract', 'active', 22000);`);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', fixture]);
const USERS = { u_pay: ['payroll_officer', 'E003'], u_lead: ['hr_leader', null], u_hr: ['hr_admin', null], u_staff: ['hr_staff', 'E005'] };
const pw = {};
for (const [u, [role, emp]] of Object.entries(USERS)) {
  pw[u] = `Ph-${randomBytes(9).toString('base64url')}-7c`;
  const out = join(persist, `${u}.sql`);
  const args = ['scripts/create-user.mjs', '--username', u, '--display', `ทดสอบ ${u}`, '--role', role, '--out', out, '--cred-file', join(persist, 'c.txt')];
  if (emp) args.push('--employee', emp);
  run(args, { NEW_USER_PASSWORD: pw[u] });
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

try {
  const pay = await session('u_pay');
  const created = await api(pay, 'POST', '/api/payroll/periods', { code: 'PH-2027-06', name: 'zz hr screens', kind: 'monthly', company_id: 1, start_date: '2027-06-01', end_date: '2027-06-30', pay_date: '2027-06-30' });
  const pid = created.body?.id;
  check('test period created', created.status === 201, String(created.status));

  // the periods page links to the employee list
  await pay.goto(BASE + '/payroll');
  await settle(pay);
  check('periods page: "รายชื่อพนักงาน" link per period', (await pay.$(`a[href$="/payroll/selection?period_id=${pid}"]`)) !== null);

  await pay.goto(BASE + `/payroll/selection?period_id=${pid}`);
  await settle(pay);
  await pay.waitForSelector('.sel-table tbody tr');
  const rows0 = await pay.$$eval('.sel-table tbody tr', (x) => x.length);
  check('employee list: standard list with eligibility badges and summary', rows0 > 1 && (await pay.$$eval('.sel-table tbody .badge-status', (x) => x.length)) >= rows0 && (await pay.textContent('.kpis')).includes('ในงวด'));
  await pay.screenshot({ path: join(SHOTS, 'selection-1440.png') });

  // filters and search
  await pay.fill('.pick-search', 'E001');
  check('search filters the list', (await pay.$$eval('.sel-table tbody tr', (x) => x.length)) === 1);
  await pay.fill('.pick-search', '');

  // take out: reason required, per-employee result
  await pay.check('.sel-table tbody tr:nth-child(1) td.fz-check input');
  const outCode = (await pay.textContent('.sel-table tbody tr:nth-child(1) td.fz-code')).trim();
  await pay.click('.pick-bar button:has-text("นำออกจากงวด")');
  await pay.click('.modal-actions button:has-text("ยืนยันนำออก")');
  check('take out without a reason is refused in the dialog', ((await pay.textContent('.modal .form-msg')) ?? '').includes('เหตุผล'));
  await pay.fill('.modal textarea', 'zz ไม่จ่ายงวดนี้ตามเอกสาร');
  await pay.click('.modal-actions button:has-text("ยืนยันนำออก")');
  await pay.waitForSelector('.modal .result-list li');
  check('take out: per-employee result shown', ((await pay.textContent('.modal .result-list')) ?? '').includes(`${outCode}: นำออกแล้ว`));
  await pay.click('.modal-actions button:has-text("ปิด")');
  await settle(pay);
  check('the list no longer shows the employee taken out', !(await pay.$$eval('.sel-table tbody td.fz-code', (x) => x.map((e) => e.textContent))).includes(outCode));

  // add from outside the list: ZU1 (suspended → review), ZU2 (no salary → blocked)
  await pay.click('.pick-bar button:has-text("เพิ่มพนักงานเข้างวด")');
  await pay.waitForSelector('.modal table tbody tr');
  const outside = await pay.$$eval('.modal table tbody tr', (x) => x.map((e) => e.textContent));
  check('add dialog: outside employees with the reason and the eligibility they would have', outside.some((t) => t.includes('ZU1') && t.includes('รอ HR ตรวจสอบ')) && outside.some((t) => t.includes('ZU2') && t.includes('ไม่มีสิทธิ์')));
  await pay.check('.modal tr:has-text("ZU1") input[type=checkbox]');
  await pay.check('.modal tr:has-text("ZU2") input[type=checkbox]');
  await pay.click('.modal-actions button:has-text("เพิ่มเข้างวด")');
  await settle(pay);
  await pay.waitForSelector('.sel-table td.fz-code:text-is("ZU1")');
  const zu1 = await pay.textContent('.sel-table tr:has(td.fz-code:text-is("ZU1"))');
  const zu2 = await pay.textContent('.sel-table tr:has(td.fz-code:text-is("ZU2"))');
  check('added employees keep the eligibility the API gives (selection is not approval)', zu1.includes('รอ HR ตรวจสอบ') && zu2.includes('ไม่มีสิทธิ์') && zu2.includes('ไม่มีเงินเดือนพื้นฐาน'));
  check('the payroll officer cannot confirm a review case (no override permission)', (await pay.$('.sel-table tr:has(td.fz-code:text-is("ZU1")) button:has-text("ยืนยันจ่าย")')) === null);
  const calc = await api(pay, 'POST', `/api/payroll/periods/${pid}/calculate`);
  check('calculation refused while selected employees are not payable', calc.status === 409 && calc.body?.error?.code === 'selection_not_ready');
  await pay.goto(BASE + `/payroll/selection?period_id=${pid}`);
  await settle(pay);
  check('the period warning shows the employees who cannot be calculated', ((await pay.textContent('main')) ?? '').includes('ยังคำนวณไม่ได้'));
  await pay.screenshot({ path: join(SHOTS, 'selection-review-1440.png') });

  // HR Leader confirms the review case
  const lead = await session('u_lead');
  await lead.goto(BASE + `/payroll/selection?period_id=${pid}`);
  await settle(lead);
  await lead.click('.sel-table tr:has(td.fz-code:text-is("ZU1")) button:has-text("ยืนยันจ่าย")');
  await lead.fill('.modal textarea', 'zz ยืนยันจ่ายตามคำสั่งผู้บริหาร');
  await lead.click('.modal-actions button:has-text("ยืนยันจ่าย")');
  await settle(lead);
  await lead.waitForSelector('.sel-table tr:has(td.fz-code:text-is("ZU1")) .badge-status:has-text("HR ยืนยันแล้ว")');
  check('HR Leader confirmed the review case (badge "HR ยืนยันแล้ว")', true);
  await lead.click('details.history summary');
  check('history lists the changes with actor and reason', ((await lead.textContent('details.history')) ?? '').includes('zz ยืนยันจ่ายตามคำสั่งผู้บริหาร'));

  // contract periods (HR Admin): a contract ending inside the period → review reason in the list
  const hr = await session('u_hr');
  await hr.goto(BASE + '/payroll/contracts');
  await settle(hr);
  await hr.selectOption('main select[aria-label="พนักงาน"]', { label: 'ZU3 · ทดสอบ สัญญาจ้าง' });
  await settle(hr);
  await hr.click('button:has-text("บันทึกสัญญา")');
  await hr.fill('.modal input[aria-label="วันเริ่มสัญญา"]', '2026-01-01');
  await hr.fill('.modal input[aria-label^="วันสิ้นสุดสัญญา"]', '2027-06-15');
  await hr.fill('.modal textarea', 'zz บันทึกตามสัญญาจ้าง');
  await hr.click('.modal-actions button:has-text("บันทึกสัญญา")');
  await settle(hr);
  check('contract recorded and listed', ((await hr.textContent('main table')) ?? '').includes('15'));
  await hr.screenshot({ path: join(SHOTS, 'contracts-1440.png') });
  await pay.goto(BASE + `/payroll/selection?period_id=${pid}`);
  await settle(pay);
  check('the contract employee now needs review (contract not covering the period)', ((await pay.textContent('.sel-table tr:has(td.fz-code:text-is("ZU3"))')) ?? '').includes('สัญญาจ้างที่บันทึกไว้ไม่ครอบคลุม'));

  // pay frequency (HR Admin)
  await hr.goto(BASE + '/payroll/pay-frequency');
  await settle(hr);
  await hr.click('tbody tr:first-child button:has-text("เปลี่ยน")');
  await hr.selectOption('.modal select', 'semi_monthly');
  await hr.fill('.modal textarea', 'zz ตั้งค่าตามนโยบายบริษัท');
  await hr.click('.modal-actions button:has-text("บันทึก")');
  await settle(hr);
  check('pay frequency changed with a reason and shown', ((await hr.textContent('tbody tr:first-child')) ?? '').includes('ครึ่งเดือน'));
  await hr.click('details.history summary');
  check('pay frequency history shows the change', ((await hr.textContent('details.history')) ?? '').includes('zz ตั้งค่าตามนโยบายบริษัท'));
  await hr.screenshot({ path: join(SHOTS, 'pay-frequency-1440.png') });

  // permission-denied state
  const staff = await session('u_staff');
  await staff.goto(BASE + `/payroll/selection?period_id=${pid}`);
  await settle(staff);
  const denied = ((await staff.textContent('main')) ?? '');
  check('a user without access sees a permission message, no list', (await staff.$('.sel-table')) === null && /สิทธิ์|ไม่พบ|ไม่อนุญาต/.test(denied), denied.slice(0, 80));
  check('the menu does not offer the screen to that user', (await staff.$('nav.sidebar a[href$="/payroll/selection"]')) === null);

  // mobile
  await pay.setViewportSize({ width: 375, height: 812 });
  await pay.goto(BASE + `/payroll/selection?period_id=${pid}`);
  await settle(pay);
  const m = await pay.evaluate(() => ({ page: document.documentElement.scrollWidth, view: window.innerWidth }));
  const wide = m.page > m.view + 1 ? await pay.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => (e.matches('.table-wrap, .table-scroll, details, main, .kpis, .toolbar, header, footer, .topbar') || !e.closest('.table-wrap, .table-scroll')) && e.getBoundingClientRect().right > window.innerWidth + 1).slice(0, 12).map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')} → ${Math.round(e.getBoundingClientRect().right)}`)) : [];
  const diag = m.page > m.view + 1 ? await pay.evaluate(() => {
    const all = [...document.querySelectorAll('body *')].filter((e) => !e.closest('.table-wrap, .table-scroll') || e.matches('.table-wrap, .table-scroll')).map((e) => ({ e, r: e.getBoundingClientRect(), pos: getComputedStyle(e).position })).filter((x) => x.r.right > 375.5).sort((a, b) => b.r.right - a.r.right).slice(0, 8);
    return `client ${document.documentElement.clientWidth} body.scroll ${document.body.scrollWidth} top: ` + all.map((x) => `${x.e.tagName.toLowerCase()}.${[...x.e.classList].join('.')}(${x.pos})[${Math.round(x.r.left)}..${Math.round(x.r.right)}]`).join(' ');
  }) : '';
  const culprit = m.page > m.view + 1 ? await pay.evaluate(() => {
    const out = [];
    const targets = [...document.querySelectorAll('main > *'), document.querySelector('nav.sidebar'), document.querySelector('.topbar'), document.querySelector('#site-footer')].filter(Boolean);
    for (const el of targets) {
      const prev = el.style.display;
      el.style.display = 'none';
      const w = document.documentElement.scrollWidth;
      el.style.display = prev;
      if (w <= window.innerWidth) out.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`);
    }
    return out.join(', ');
  }) : '';
  check('375px: no page-level horizontal scroll', m.page <= m.view + 1, `${m.page}/${m.view} ${wide.join(' | ')} ${diag} hiding fixes: ${culprit}`);
  await pay.screenshot({ path: join(SHOTS, 'selection-375.png'), fullPage: true });

  check('no console errors and no HTTP 5xx', errors.length === 0, errors.join(' | '));
} finally {
  await browser.close();
  stopServer(dev);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` — FAILED: ${failed.map((f) => f.name).join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
