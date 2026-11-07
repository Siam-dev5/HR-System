// Feishu import V1.1 in the browser (local only; fresh local D1; synthetic companies ZQA / ZQB / ZQC, employees and
// users). Attendance exemption in the employee form (HR admin manages, HR staff views only, audit history), the
// six-step wizard with a combined file (company per row from the Group column, values matched to companies, detected
// companies and row counts, per-company results and filter, one batch per company, rows without a company kept apart)
// and a separate file (selected company; conflicting company values and other companies' employees refused);
// exempt employee without punch warnings; 1440 / 768 light and dark without page overflow; no console errors.
// usage: node tests/ui/ui-feishu-multicompany.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { build as esbuild } from 'esbuild';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('feishu-multicompany');
mkdirSync(OUT, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const start = addDays(today, -10);

const FIX = join(OUT, 'files');
mkdirSync(FIX, { recursive: true });
const MK = join(outDir('build'), 'mkmulticompany.mjs');
await esbuild({ entryPoints: [join(ROOT, 'tests', 'ui', 'fixtures', 'mkmulticompany.ts')], bundle: true, platform: 'node', format: 'esm', outfile: MK, logLevel: 'warning' });
execFileSync(process.execPath, [MK, FIX, start], { stdio: 'inherit' });
const FILE = join(FIX, 'multi-company.xlsx');

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `multico-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
mkdirSync(persist, { recursive: true });
const seed = join(persist, 'zzq.sql');
const emp = (code, co) => `('${code}', 'zz_ui', '${code}', (SELECT id FROM companies WHERE code = '${co}'), '2024-01-01', 'permanent', 'active')`;
writeFileSync(join(ROOT, seed), [
  "INSERT INTO companies (code, name, active) VALUES ('ZQA', 'zz_test บริษัท A', 1), ('ZQB', 'zz_test บริษัท B', 1), ('ZQC', 'zz_test บริษัท C', 1);",
  `INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status) VALUES ${[emp('ZQA01', 'ZQA'), emp('ZQA02', 'ZQA'), emp('ZQA90', 'ZQB'), emp('ZQB01', 'ZQB'), emp('ZQC01', 'ZQC'), emp('ZQC02', 'ZQC')].join(', ')};`,
].join('\n'));
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', seed]);
const USERS = { q_admin: 'hr_admin', q_staff: 'hr_staff' };
const pw = {};
for (const [u, role] of Object.entries(USERS)) {
  pw[u] = `Qm-${randomBytes(9).toString('base64url')}-4z`;
  const f = join(persist, `${u}.sql`);
  run(['scripts/create-user.mjs', '--username', u, '--display', `ทดสอบ ${u}`, '--out', f, '--cred-file', join(persist, 'c.txt'), '--role', role], { NEW_USER_PASSWORD: pw[u] });
  run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', f]);
}
const sql = (command) => JSON.parse(run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--json', '--command', command]))[0].results;
const ids = Object.fromEntries(sql("SELECT emp_code, id FROM employees WHERE emp_code LIKE 'ZQ%'").map((r) => [r.emp_code, r.id]));
const fingerprint = () => JSON.stringify(sql('SELECT (SELECT COUNT(*) FROM payslips) p, (SELECT COUNT(*) FROM payroll_periods) pp, (SELECT COUNT(*) FROM payslip_archive) pa, (SELECT COUNT(*) FROM leave_requests) lr, (SELECT COUNT(*) FROM overtime_requests) orq, (SELECT COUNT(*) FROM employee_pay_items) pi'));
const before = fingerprint();
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
const secrets = {};
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const errors = [];
const browser = await chromium.launch({ executablePath: EXE });

async function session(user, viewport = { width: 1440, height: 900 }, theme = 'light') {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, locale: 'th-TH' });
  await ctx.addInitScript((t) => { try { localStorage.setItem('hr.theme', t); } catch { /* none */ } }, theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${user}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${user}: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${user}: HTTP ${r.status()} ${r.url()}`); });
  await page.goto(BASE + '/login'); await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw[user]); await page.click('button.auth-submit');
  // HR admin is a privileged role: MFA is enrolled on the first login
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
  return { ctx, page };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const openEmployee = async (page, id) => {
  await page.goto(`${BASE}/employees?open=${id}`);
  await page.waitForSelector('.modal .exemption-panel .exemption-status, .modal .exemption-panel .alert-error');
};
async function toCompanyStep(page) {
  await page.goto(BASE + '/attendance/file-import');
  await page.waitForSelector('main .dropzone');
  await page.setInputFiles('#clock-file', FILE);
  await page.waitForSelector('main .file-info .file-rows');
  await page.click('main button:has-text("ถัดไป: Worksheet / บริษัท")');
  await page.waitForSelector('main .company-step');
}

try {
  // ---- attendance exemption (employee form) ---------------------------------------------------------------------
  const a = await session('q_admin');
  await openEmployee(a.page, ids.ZQA02);
  check('employee form: attendance exemption section, not exempt yet', (await a.page.textContent('.modal .exemption-status')).includes('ไม่ได้รับยกเว้น'));
  await a.page.fill('.modal .exemption-add input[name=effective_from]', start);
  await a.page.fill('.modal .exemption-add input[name=reason]', 'zz_test ผู้บริหารตามข้อตกลง');
  await a.page.click('.modal .exemption-add button:has-text("+ เพิ่มช่วงยกเว้น")');
  await a.page.waitForSelector('.modal .exemption-table tr[data-state="active"]');
  const row = await a.page.textContent('.modal .exemption-table tbody');
  check('HR admin adds an exemption: status, dates, reason and who created it', (await a.page.textContent('.modal .exemption-status')).includes('ได้รับยกเว้น') && row.includes('ไม่กำหนด') && row.includes('zz_test ผู้บริหาร') && row.includes('q_admin'), row.slice(0, 160));
  await a.page.fill('.modal .exemption-add input[name=effective_from]', addDays(start, 2));
  await a.page.fill('.modal .exemption-add input[name=reason]', 'zz_test ซ้อน');
  await a.page.click('.modal .exemption-add button:has-text("+ เพิ่มช่วงยกเว้น")');
  await a.page.waitForFunction(() => document.querySelector('.modal .exemption-panel .form-msg')?.textContent?.includes('ซ้อน'));
  check('overlapping exemption refused with the reason', true);
  await a.page.screenshot({ path: join(OUT, 'exemption-1440-light.png') });
  // a second, short exemption on another employee, then revoked: kept in the history
  await openEmployee(a.page, ids.ZQC01);
  await a.page.fill('.modal .exemption-add input[name=effective_from]', addDays(today, 30));
  await a.page.fill('.modal .exemption-add input[name=reason]', 'zz_test อนาคต');
  await a.page.click('.modal .exemption-add button:has-text("+ เพิ่มช่วงยกเว้น")');
  await a.page.waitForSelector('.modal .exemption-table tr[data-state="future"]');
  await a.page.click('.modal .exemption-table tr[data-state="future"] button:has-text("ยกเลิก")');
  const revoke = a.page.locator('.modal[aria-label="ยกเลิกช่วงยกเว้น"]');
  await revoke.locator('textarea').fill('zz_test ไม่ใช้แล้ว');
  await revoke.locator('button:has-text("ยกเลิกช่วงนี้")').click();
  await a.page.waitForSelector('.modal .exemption-table tr[data-state="revoked"]');
  check('revoked period kept with who / when / why', (await a.page.textContent('.modal .exemption-table tr[data-state="revoked"]')).includes('zz_test ไม่ใช้แล้ว'));
  check('audit trail: created ×2, revoked ×1', JSON.stringify(sql("SELECT action, COUNT(*) n FROM audit_logs WHERE action LIKE 'attendance_exemption.%' GROUP BY action ORDER BY action")) === JSON.stringify([{ action: 'attendance_exemption.created', n: 2 }, { action: 'attendance_exemption.revoked', n: 1 }]));
  await a.ctx.close();

  const { ctx, page } = await session('q_staff');
  await openEmployee(page, ids.ZQA02);
  check('HR staff: exemption visible, read-only (no add / revoke)', (await page.textContent('.modal .exemption-status')).includes('ได้รับยกเว้น') && (await page.$$('.modal .exemption-add, .modal .exemption-table button')).length === 0);

  // ---- combined file ---------------------------------------------------------------------------------------------
  const written = () => sql('SELECT (SELECT COUNT(*) FROM attendance_file_imports) + (SELECT COUNT(*) FROM import_groups) + (SELECT COUNT(*) FROM attendance_records) AS n')[0].n;
  const beforePreview = written();
  await toCompanyStep(page);
  check('step 2: stepper shows six steps with "Worksheet / บริษัท"', (await page.$$('main .stepper li')).length === 6 && (await page.textContent('main .stepper li.current')).includes('Worksheet / บริษัท'));
  await page.click('main .company-mode input[value="combined"]');
  check('combined: "next" disabled until a company column is chosen', await page.isDisabled('main button:has-text("ถัดไป: จับคู่คอลัมน์")'));
  await page.selectOption('main select[aria-label="คอลัมน์ที่ใช้ระบุบริษัท"]', { label: 'Group' });
  await page.waitForSelector('main .company-values');
  const values = await page.$$eval('main .company-values tbody tr', (rows) => rows.map((r) => r.getAttribute('data-value')));
  check('combined: every Group value listed once with its rows (empty value flagged)', values.join('|') === 'Team A|Team B|Team C||Somewhere', values.join('|'));
  check('combined: nothing preselected — "Team A" is not a company code or name', (await page.$$eval('main .company-values select', (s) => s.every((x) => x.value === ''))));
  for (const [v, co] of [['Team A', 'zz_test บริษัท A (ZQA)'], ['Team B', 'zz_test บริษัท B (ZQB)'], ['Team C', 'zz_test บริษัท C (ZQC)']]) await page.selectOption(`main .company-values select[aria-label="บริษัทของ ${v}"]`, { label: co });
  const detected = await page.$$eval('main .detected-companies li', (l) => l.map((x) => x.textContent));
  check('step 2: detected companies with row counts; rows without a company flagged', detected.length === 4 && detected[0].includes('ZQA') && detected[0].includes('3 แถว') && detected.at(-1).includes('ไม่ระบุบริษัท') && detected.at(-1).includes('2 แถว'), detected.join(' | '));
  await page.screenshot({ path: join(OUT, 'company-step-1440-light.png'), fullPage: true });
  await page.click('main button:has-text("ถัดไป: จับคู่คอลัมน์")');
  await page.waitForSelector('main .mapping-table');
  await page.click('main button:has-text("ถัดไป: ตรวจสอบข้อมูล")');
  await page.waitForSelector('main .company-summary');
  const summary = await page.$$eval('main .company-summary tbody tr', (r) => r.map((x) => `${x.getAttribute('data-company')}:${[...x.cells].map((c) => c.textContent).slice(1).join(',')}`));
  check('step 4: per-company Valid / Warning / Duplicate / Invalid and the unassigned rows', summary.length === 4 && summary.at(-1).startsWith('none:2,'), summary.join(' | '));
  const exemptNote = await page.textContent('main .exempt-note').catch(() => '');
  check('step 4: exempt employee — no missing-punch warning, punches kept', exemptNote.includes('ได้รับยกเว้น'));
  const zqb = String(sql("SELECT id FROM companies WHERE code = 'ZQB'")[0].id);
  await page.selectOption('main select[aria-label="ดูเฉพาะบริษัท"]', zqb);
  await page.waitForFunction((id) => [...document.querySelectorAll('main .daily-rows tbody tr')].every((r) => r.getAttribute('data-company') === id), zqb);
  const bRows = await page.textContent('main .daily-rows tbody');
  check('step 4: inspect one company (B): only its rows, ZQA90 not cross-matched under A', !bRows.includes('ZQA90') && bRows.includes('ZQB01'));
  await page.selectOption('main select[aria-label="ดูเฉพาะบริษัท"]', 'all');
  const all = await page.textContent('main .daily-rows tbody');
  check('step 4: ZQA90 under Team A refused (employee of another company)', all.includes('อยู่ในบริษัทอื่น'));
  await page.screenshot({ path: join(OUT, 'combined-preview-1440-light.png') });
  check('preview wrote nothing (batches, groups, attendance records)', written() === beforePreview, `${beforePreview} → ${written()}`);
  await page.click('main button:has-text("ถัดไป: ยืนยันการนำเข้า")');
  await page.waitForSelector('main h2:has-text("5. ยืนยันการนำเข้า")');
  const target = await page.textContent('main .confirm-target');
  check('step 5: the three target companies listed', ['ZQA', 'ZQB', 'ZQC'].every((c) => target.includes(`(${c})`)) && target.split(',').length === 3, target);
  await page.click('main .form-actions button.primary');
  await page.waitForSelector('.modal');
  await page.click('.modal button:has-text("ยืนยันนำเข้า")');
  await page.waitForSelector('main h2:has-text("6. ผลการนำเข้า")');
  const batches = await page.$$('main .group-batches tbody tr');
  check('step 6: one Import Batch per company, unassigned rows counted', batches.length === 3 && (await page.textContent('main .kpis')).includes('ไม่ระบุบริษัท2'));
  await page.click('main a:has-text("ดูรายละเอียด")');
  await page.waitForSelector('main .unassigned-rows');
  check('group page: batches per company and the rows without a company with reasons', (await page.$$('main .group-batches tbody tr')).length === 3 && (await page.textContent('main .unassigned-rows')).includes('Somewhere'));
  const db = sql("SELECT (SELECT COUNT(DISTINCT company_id) FROM attendance_file_imports WHERE group_id IS NOT NULL) companies, (SELECT COUNT(*) FROM attendance_records a JOIN employees e ON e.id = a.employee_id WHERE e.emp_code IN ('ZQA90', 'ZQC02')) wrong")[0];
  check('database: three company batches; no record for the refused / unassigned rows', db.companies === 3 && db.wrong === 0, JSON.stringify(db));

  // ---- separate file ---------------------------------------------------------------------------------------------
  await toCompanyStep(page);
  await page.selectOption('main .company-step select[aria-label="บริษัท"]', { label: 'zz_test บริษัท A (ZQA)' });
  await page.selectOption('main select[aria-label="คอลัมน์ที่ใช้ระบุบริษัท"]', { label: 'Group' });
  await page.waitForSelector('main .company-values');
  await page.selectOption('main .company-values select[aria-label="บริษัทของ Team A"]', { label: 'zz_test บริษัท A (ZQA)' });
  await page.selectOption('main .company-values select[aria-label="บริษัทของ Team B"]', { label: 'zz_test บริษัท B (ZQB)' });
  const conflict = await page.textContent('main .detected-companies');
  check('separate file: selected company shown, rows of other / unmatched companies flagged', conflict.includes('zz_test บริษัท A') && conflict.includes('ไม่ตรง'), conflict);
  await page.click('main button:has-text("ถัดไป: จับคู่คอลัมน์")');
  await page.waitForSelector('main .mapping-table');
  await page.click('main button:has-text("ถัดไป: ตรวจสอบข้อมูล")');
  await page.waitForSelector('main .daily-rows');
  await page.click('main .segmented label:has-text("Invalid")');
  await page.waitForFunction(() => [...document.querySelectorAll('main .daily-rows tbody tr')].every((r) => r.getAttribute('data-status') === 'invalid'));
  const inv = await page.textContent('main .daily-rows tbody');
  check('separate file: conflicting company value and other companies\' employees refused', inv.includes('ไม่ตรงกับบริษัทที่เลือก') && inv.includes('อยู่ในบริษัทอื่น'));

  check('payroll, leave / OT requests and pay items unchanged', fingerprint() === before);

  // ---- layouts ------------------------------------------------------------------------------------------------------
  for (const [vp, theme] of [[{ width: 1440, height: 900 }, 'dark'], [{ width: 768, height: 1024 }, 'light'], [{ width: 768, height: 1024 }, 'dark']]) {
    const v = await session('q_staff', vp, theme);
    await toCompanyStep(v.page);
    await v.page.click('main .company-mode input[value="combined"]');
    await v.page.selectOption('main select[aria-label="คอลัมน์ที่ใช้ระบุบริษัท"]', { label: 'Group' });
    await v.page.waitForSelector('main .company-values');
    let o = await overflow(v.page);
    check(`${vp.width} ${theme} company step: no page overflow`, o <= 0, String(o));
    await v.page.screenshot({ path: join(OUT, `company-step-${vp.width}-${theme}.png`) });
    await openEmployee(v.page, ids.ZQA02);
    o = await overflow(v.page);
    check(`${vp.width} ${theme} employee form with exemption: no page overflow`, o <= 0, String(o));
    await v.ctx.close();
  }
  await ctx.close();
} finally {
  await browser.close();
  stopServer(dev);
}
check('no console errors / page errors / HTTP 5xx', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-feishu-multicompany pass=${results.length - fail} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
