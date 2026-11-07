// Feishu import separation in the browser (local only; fresh local D1; synthetic companies ZZF / ZZG, employees
// ZFA01–ZFA03 / ZFB01 and users). One workbook with the three worksheets of the Feishu export (Sheet1 / Leave /
// Overtime): each wizard lists the worksheets, preselects its own, refuses a worksheet of another domain and sends only
// the selected worksheet; the five steps for attendance (daily report → one row per employee and day), leave and OT
// (approval statuses as written); separate histories; menus by permission; 1440 / 768 light and dark without page
// overflow; no console errors.
// usage: node tests/ui/ui-feishu-imports.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build as esbuild } from 'esbuild';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('feishu-imports');
mkdirSync(OUT, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const start = addDays(today, -20);

const FIX = join(OUT, 'files');
mkdirSync(FIX, { recursive: true });
const MK = join(outDir('build'), 'mkfeishu.mjs');
await esbuild({ entryPoints: [join(ROOT, 'tests', 'ui', 'fixtures', 'mkfeishu.ts')], bundle: true, platform: 'node', format: 'esm', outfile: MK, logLevel: 'warning' });
execFileSync(process.execPath, [MK, FIX, start], { stdio: 'inherit' });
const FILE = join(FIX, 'feishu-report.xlsx');

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `feishu-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
mkdirSync(persist, { recursive: true });
const seed = join(persist, 'zzf.sql');
writeFileSync(join(ROOT, seed), [
  "INSERT INTO companies (code, name, active) VALUES ('ZZF', 'zz_test บริษัท Feishu', 1), ('ZZG', 'zz_test บริษัทอื่น', 1);",
  `INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status) VALUES ${['ZFA01', 'ZFA02', 'ZFA03'].map((c) => `('${c}', 'zz_ui', '${c}', (SELECT id FROM companies WHERE code = 'ZZF'), '2024-01-01', 'permanent', 'active')`).join(', ')},
    ('ZFB01', 'zz_ui', 'ZFB01', (SELECT id FROM companies WHERE code = 'ZZG'), '2024-01-01', 'permanent', 'active');`,
].join('\n'));
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', seed]);
const USERS = { f_staff: 'hr_staff', f_payroll: 'payroll_officer', f_mgr: 'hr_manager' };
const pw = {};
for (const [u, role] of Object.entries(USERS)) {
  pw[u] = `Fi-${randomBytes(9).toString('base64url')}-8w`;
  const f = join(persist, `${u}.sql`);
  run(['scripts/create-user.mjs', '--username', u, '--display', `ทดสอบ ${u}`, '--out', f, '--cred-file', join(persist, 'c.txt'), '--role', role], { NEW_USER_PASSWORD: pw[u] });
  run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', f]);
}
const sql = (command) => JSON.parse(run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--json', '--command', command]))[0].results;
const fingerprint = () => JSON.stringify(sql("SELECT (SELECT COUNT(*) FROM payslips) p, (SELECT COUNT(*) FROM payroll_periods) pp, (SELECT COUNT(*) FROM payslip_archive) pa, (SELECT COUNT(*) FROM leave_requests) lr, (SELECT COUNT(*) FROM overtime_requests) orq, (SELECT COUNT(*) FROM attendance_imports) ai"));
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
  const ctx = await browser.newContext({ viewport, colorScheme: theme, locale: 'th-TH', acceptDownloads: true });
  await ctx.addInitScript((t) => { try { localStorage.setItem('hr.theme', t); } catch { /* none */ } }, theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${user}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${user}: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${user}: HTTP ${r.status()} ${r.url()}`); });
  await page.goto(BASE + '/login'); await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw[user]); await page.click('button.auth-submit');
  // the payroll officer is a privileged role: MFA is enrolled on the first login
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
  await page.waitForSelector('nav.sidebar', { timeout: 15000 }).catch(async (e) => { await page.screenshot({ path: join(OUT, `login-${user}.png`) }); console.log('LOGIN PAGE TEXT:', (await page.textContent('body')).slice(0, 400)); throw e; });
  return { ctx, page };
}
const menu = (page) => page.$$eval('nav.sidebar .nav-item', (els) => els.map((e) => e.textContent.trim()));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
const kpis = (page, sel = 'main .wizard-step > .kpis') => page.$eval(sel, (k) => [...k.querySelectorAll('.kpi')].map((e) => e.textContent).join('|'));
const selectedSheet = (page) => page.$eval('main .sheet-option.is-selected', (e) => e.getAttribute('data-sheet'));
/** the grids posted to an import API (proves that only one worksheet leaves the browser) */
const posted = [];

/** Steps 1 → 3 of a wizard with the workbook; returns after the preview is shown. */
async function upload(page, path, inputId, company = 'zz_test บริษัท Feishu (ZZF)') {
  await page.goto(BASE + path);
  await page.waitForSelector('main .dropzone');
  // leave / OT: the company is chosen in step 1; attendance: in step 2 (Worksheet / บริษัท)
  if (!path.startsWith('/attendance')) await page.selectOption('main .wizard-step select[aria-label="บริษัท"]', { label: company });
  await page.setInputFiles(`#${inputId}`, FILE);
  await page.waitForSelector('main .sheet-picker');
}

try {
  // ---- menus by permission -----------------------------------------------------------------------------------
  const NEW = ['นำเข้าข้อมูลการลา', 'ประวัติการนำเข้าการลา', 'นำเข้าข้อมูล OT', 'ประวัติการนำเข้า OT'];
  const { ctx, page } = await session('f_staff');
  page.on('request', (r) => { if (/\/api\/(attendance-files|leave-imports|overtime-imports)(\/preview)?$/.test(new URL(r.url()).pathname) && r.method() === 'POST') posted.push({ path: new URL(r.url()).pathname, body: r.postDataJSON() }); });
  const items = await menu(page);
  check('HR staff menu: separate import + history for attendance, leave and OT', ['นำเข้าไฟล์เวลาทำงาน', 'ประวัติการนำเข้าเวลา', ...NEW].every((t) => items.includes(t)), items.filter((x) => /นำเข้า/.test(x)).join(' | '));
  const at = (t) => items.indexOf(t);
  check('menu order: leave import pages follow การลา, OT import pages follow คำขอ OT',
    at('นำเข้าข้อมูลการลา') === at('การลา') + 1 && at('ประวัติการนำเข้าการลา') === at('การลา') + 2 && at('นำเข้าข้อมูล OT') === at('คำขอ OT') + 1 && at('ประวัติการนำเข้า OT') === at('คำขอ OT') + 2);
  {
    const p = await session('f_payroll');
    const pi = await menu(p.page);
    check('payroll officer: histories only, no import wizards', pi.includes('ประวัติการนำเข้าการลา') && pi.includes('ประวัติการนำเข้า OT') && !pi.includes('นำเข้าข้อมูลการลา') && !pi.includes('นำเข้าข้อมูล OT'), pi.filter((x) => /นำเข้า/.test(x)).join(' | '));
    await p.page.goto(BASE + '/leave/import');
    await p.page.waitForSelector('main .state-page');
    check('payroll officer: leave import wizard refused (403 page)', (await p.page.textContent('main')).includes('403'));
    await p.ctx.close();
    const m = await session('f_mgr');
    const mi = await menu(m.page);
    check('manager: none of the leave / OT import pages', NEW.every((t) => !mi.includes(t)));
    await m.ctx.close();
  }

  // ---- attendance: Feishu daily report ------------------------------------------------------------------------
  await upload(page, '/attendance/file-import', 'clock-file');
  const sheetsShown = await page.$$eval('main .sheet-option', (els) => els.map((e) => `${e.getAttribute('data-sheet')}:${e.classList.contains('is-wrong') ? 'wrong' : 'ok'}`));
  check('attendance step 1: three worksheets listed; Leave / Overtime marked as another domain', sheetsShown.join(',') === 'Sheet1:ok,Leave:wrong,Overtime:wrong', sheetsShown.join(','));
  check('attendance step 1: Sheet1 preselected, Feishu Daily template, 6 rows', (await selectedSheet(page)) === 'Sheet1' && (await page.textContent('main .file-template')).includes('FEISHU_DAILY_ATTENDANCE_V1') && (await page.textContent('main .file-rows')) === '6');
  await page.click('main .sheet-option[data-sheet="Leave"] input');
  await page.waitForSelector('main .file-info .alert-error');
  check('attendance: choosing the Leave worksheet is refused and "next" is disabled', (await page.textContent('main .file-info .alert-error')).includes('การลา › นำเข้าข้อมูลการลา') && (await page.isDisabled('main button:has-text("ถัดไป: Worksheet / บริษัท")')));
  await page.click('main .sheet-option[data-sheet="Sheet1"] input');
  await page.waitForFunction(() => !document.querySelector('main .file-info .alert-error'));
  await page.screenshot({ path: join(OUT, 'attendance-step1-1440-light.png'), fullPage: true });
  await page.click('main button:has-text("ถัดไป: Worksheet / บริษัท")');
  await page.waitForSelector('main .company-step');
  await page.selectOption('main .company-step select[aria-label="บริษัท"]', { label: 'zz_test บริษัท Feishu (ZZF)' });
  await page.click('main button:has-text("ถัดไป: จับคู่คอลัมน์")');
  await page.waitForSelector('main .mapping-table');
  check('attendance step 2: worksheet badge and seven day columns found', (await page.textContent('main .sheet-badge-name')) === 'Sheet1' && (await page.getAttribute('main [data-day-columns]', 'data-day-columns')) === '7');
  const mappedA = await page.$$eval('main .mapping-table select', (s) => s.map((x) => x.selectedOptions[0]?.textContent));
  check('attendance step 2: identity columns mapped by name', mappedA.slice(0, 4).join('|') === 'Employee ID|Name|Department|Job', mappedA.join('|'));
  await page.click('main button:has-text("ถัดไป: ตรวจสอบข้อมูล")');
  await page.waitForSelector('main .daily-rows');
  check('attendance step 3: rows before / after validation', (await page.textContent('main .rows-before-after')).includes('6 แถวพนักงานในไฟล์ → 17 รายการรายวัน'), await page.textContent('main .rows-before-after'));
  check('attendance step 3: Valid / Warning / Duplicate / Invalid', (await kpis(page)).includes('ทั้งหมด17') && (await kpis(page)).includes('Duplicate (ซ้ำ)1') && (await kpis(page)).includes('Invalid (ไม่ถูกต้อง)3'), await kpis(page));
  const lateRow = await page.textContent(`main .daily-rows tr:has(td:text-is("ZFA01")):has(td:text-is("${new Intl.DateTimeFormat('th-TH').format(new Date(addDays(start, 1)))}"))`).catch(() => '');
  const body3 = await page.textContent('main .daily-rows tbody');
  check('attendance step 3: late, overtime event, leave event and No record shown per day', body3.includes('มาสาย 09:09') && body3.includes('OT 18:00-20:00') && body3.includes('Sick leave 4 ชม.') && body3.includes('ไม่มีบันทึก (No record)') && body3.includes('ไม่ถือเป็นขาดงาน'), lateRow.slice(0, 120));
  await page.screenshot({ path: join(OUT, 'attendance-step3-1440-light.png') });
  await page.click('main button:has-text("ถัดไป: ยืนยันการนำเข้า")');
  await page.waitForSelector('main h2:has-text("5. ยืนยันการนำเข้า")');
  await page.click('main button:has-text("ยืนยันนำเข้า 13 รายการ")');
  await page.waitForSelector('.modal');
  await page.click('.modal button:has-text("ยืนยันนำเข้า")');
  await page.waitForSelector('main h2:has-text("6. ผลการนำเข้า")');
  const resA = await page.textContent('main .wizard-step');
  check('attendance step 5: imported 13, 9 attendance records, worksheet shown', resA.includes('สำเร็จ13') && resA.includes('สร้างบันทึกเวลา9') && resA.includes('Sheet1'), resA.slice(0, 160));
  const attPosts = posted.filter((p) => p.path.startsWith('/api/attendance-files'));
  check('only the selected worksheet was sent (Sheet1 grid, never Leave / Overtime)', attPosts.length >= 2 && attPosts.every((p) => p.body.sheet_name === 'Sheet1' && p.body.grid.length === 9 && !JSON.stringify(p.body.grid).includes('Request No.')), attPosts.map((p) => `${p.body.sheet_name}:${p.body.grid.length}`).join(','));

  // ---- leave --------------------------------------------------------------------------------------------------
  await upload(page, '/leave/import', 'leave-file');
  check('leave step 1: the Leave worksheet is preselected', (await selectedSheet(page)) === 'Leave');
  await page.click('main .sheet-option[data-sheet="Overtime"] input');
  await page.waitForSelector('main .file-info .alert-error');
  check('leave: the Overtime worksheet is refused', (await page.textContent('main .file-info .alert-error')).includes('ข้อมูล OT ไม่ใช่ข้อมูลการลา') && (await page.isDisabled('main button:has-text("ถัดไป: จับคู่คอลัมน์")')));
  await page.click('main .sheet-option[data-sheet="Leave"] input');
  await page.waitForFunction(() => !document.querySelector('main .file-info .alert-error'));
  await page.click('main button:has-text("ถัดไป: จับคู่คอลัมน์")');
  await page.waitForSelector('main .mapping-table');
  const req = await page.$$eval('main .mapping-table tr', (rows) => rows.filter((r) => r.querySelector('.req')).length);
  check('leave step 2: required and optional fields shown, header row 2', req === 7 && (await page.inputValue('main input[aria-label="แถวหัวตาราง"]')) === '2', String(req));
  await page.click('main button:has-text("ถัดไป: ตรวจสอบข้อมูล")');
  await page.waitForSelector('main .leave-rows');
  check('leave step 3: approval statuses as written (2 approved, 1 pending, 1 rejected, 1 cancelled)', (await kpis(page, 'main .approval-kpis')) === 'อนุมัติ (Approved)2|รออนุมัติ (Pending)1|ไม่อนุมัติ (Rejected)1|ยกเลิก (Cancelled)1', await kpis(page, 'main .approval-kpis'));
  const leaveBody = await page.textContent('main .leave-rows tbody');
  check('leave step 3: duplicate Request ID, other company and invalid range explained', leaveBody.includes('ซ้ำกับแถวก่อนหน้าในไฟล์นี้') && leaveBody.includes('ไม่ได้อยู่ในบริษัท') && leaveBody.includes('วันเวลาสิ้นสุดต้องอยู่หลังวันเวลาเริ่ม'));
  await page.screenshot({ path: join(OUT, 'leave-step3-1440-light.png') });
  await page.click('main button:has-text("ถัดไป: ยืนยันการนำเข้า")');
  await page.click('main button:has-text("ยืนยันนำเข้า 5 รายการ")');
  await page.waitForSelector('.modal');
  await page.click('.modal button:has-text("ยืนยันนำเข้า")');
  await page.waitForSelector('main h2:has-text("5. ผลการนำเข้า")');
  check('leave step 5: imported 5', (await page.textContent('main .wizard-step')).includes('สำเร็จ5'));
  const dl = await Promise.all([page.waitForEvent('download'), page.click('main a:has-text("Error Report (CSV)")')]);
  const report = readFileSync(await dl[0].path(), 'utf8');
  check('leave error report lists the rejected rows with reasons', report.includes('7200L07') && report.includes('วันเวลาสิ้นสุดต้องอยู่หลังวันเวลาเริ่ม') && !report.includes('7200L02'));

  // ---- overtime -----------------------------------------------------------------------------------------------
  await upload(page, '/overtime/import', 'overtime-file');
  check('OT step 1: the Overtime worksheet is preselected', (await selectedSheet(page)) === 'Overtime');
  await page.click('main button:has-text("ถัดไป: จับคู่คอลัมน์")');
  await page.waitForSelector('main .mapping-table');
  const otMap = await page.$$eval('main .mapping-table select', (s) => Object.fromEntries(s.map((x) => [x.dataset.field, x.selectedOptions[0]?.textContent])));
  check('OT step 2: request "Start time" and detail "Start Time" mapped to different fields', otMap.start_at === 'Start time' && otMap.work_date === 'Start Time', JSON.stringify(otMap));
  await page.click('main button:has-text("ถัดไป: ตรวจสอบข้อมูล")');
  await page.waitForSelector('main .overtime-rows');
  const otBody = await page.textContent('main .overtime-rows tbody');
  check('OT step 3: overnight request shown in two details', (await page.$$('main .overtime-rows tr[data-request="7200O05"]')).length === 2 && otBody.includes('(ข้ามวัน)'));
  await page.click('main button:has-text("ถัดไป: ยืนยันการนำเข้า")');
  check('OT step 4: no OT pay, no OT request, no payroll item', (await page.textContent('main .wizard-step')).includes('ไม่คำนวณค่า OT'));
  await page.click('main button:has-text("ยืนยันนำเข้า 6 รายการ")');
  await page.waitForSelector('.modal');
  await page.click('.modal button:has-text("ยืนยันนำเข้า")');
  await page.waitForSelector('main h2:has-text("5. ผลการนำเข้า")');
  check('OT step 5: imported 6', (await page.textContent('main .wizard-step')).includes('สำเร็จ6'));
  check('each wizard posted only its own worksheet', posted.filter((p) => p.path.startsWith('/api/leave-imports')).every((p) => p.body.sheet_name === 'Leave') && posted.filter((p) => p.path.startsWith('/api/overtime-imports')).every((p) => p.body.sheet_name === 'Overtime'));

  // ---- histories are per type ---------------------------------------------------------------------------------
  await page.goto(BASE + '/leave/imports');
  await page.waitForSelector('main .import-history');
  const lh = await page.$$eval('main .import-history tbody tr', (r) => r.map((x) => x.textContent));
  await page.goto(BASE + '/overtime/imports');
  await page.waitForSelector('main .import-history');
  const oh = await page.$$eval('main .import-history tbody tr', (r) => r.map((x) => x.textContent));
  check('histories are per type: one leave batch (Leave), one OT batch (Overtime)', lh.length === 1 && lh[0].includes('Leave') && oh.length === 1 && oh[0].includes('Overtime'), `${lh.length}/${oh.length}`);
  await page.click('main .import-history tbody a');
  await page.waitForSelector('main .overtime-rows');
  check('OT batch detail lists every row of the worksheet', (await page.$$('main .overtime-rows tbody tr')).length === 10);
  await page.goto(BASE + '/attendance/file-imports');
  await page.waitForSelector('main .import-history');
  check('attendance history shows worksheet and template', (await page.textContent('main .import-history tbody')).includes('Feishu Daily'));

  // ---- data safety --------------------------------------------------------------------------------------------
  check('payroll, leave requests, OT requests and the Feishu summary import unchanged', fingerprint() === before, fingerprint());
  const stored = sql("SELECT (SELECT COUNT(*) FROM leave_import_records WHERE status IN ('valid','warning')) l, (SELECT COUNT(*) FROM overtime_import_records WHERE status IN ('valid','warning')) o, (SELECT COUNT(*) FROM attendance_records WHERE status = 'absent') a")[0];
  check('imported leave / OT stored in their own tables; no absence created', stored.l === 5 && stored.o === 6 && stored.a === 0, JSON.stringify(stored));

  // ---- layouts: light / dark, 1440 / 768 -------------------------------------------------------------------------
  for (const [vp, theme] of [[{ width: 1440, height: 900 }, 'dark'], [{ width: 768, height: 1024 }, 'light'], [{ width: 768, height: 1024 }, 'dark']]) {
    const v = await session('f_staff', vp, theme);
    for (const [path, inputId, name] of [['/leave/import', 'leave-file', 'leave-import'], ['/overtime/import', 'overtime-file', 'ot-import'], ['/attendance/file-import', 'clock-file', 'attendance-import']]) {
      await upload(v.page, path, inputId);
      const o = await overflow(v.page);
      check(`${vp.width} ${theme} ${name} (worksheet picker): no page overflow`, o <= 0, String(o));
      await v.page.screenshot({ path: join(OUT, `${name}-${vp.width}-${theme}.png`) });
    }
    for (const [path, name] of [['/leave/imports', 'leave-history'], ['/overtime/imports', 'ot-history']]) {
      await v.page.goto(BASE + path);
      await v.page.waitForSelector('main .import-history');
      const o = await overflow(v.page);
      check(`${vp.width} ${theme} ${name}: no page overflow`, o <= 0, String(o));
    }
    await v.ctx.close();
  }
  await ctx.close();
} finally {
  await browser.close();
  stopServer(dev);
}
check('no console errors / page errors / HTTP 5xx', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-feishu-imports pass=${results.length - fail} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
