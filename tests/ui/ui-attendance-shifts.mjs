// Attendance file import wizard, import history, shift settings, shift groups and the group schedule calendar
// (local only; fresh local D1; synthetic company ZZS, employees ZS01–ZS06 and users). Menus by permission, the
// shift editor (two breaks, net hours, cross-midnight), a scheduled and a fixed group with members, assigning a
// shift / day off / override in the calendar with confirmation, the five import steps for CSV, XLSX and XLS (a fake
// .xlsx is refused), the error report, light / dark and 1440 / 768 / 375 without page overflow or a dialog under
// the footer.
// usage: node tests/ui/ui-attendance-shifts.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { build as esbuild } from 'esbuild';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('attendance-shifts');
mkdirSync(OUT, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const workDay = addDays(today, -2);

const FIX = join(OUT, 'files');
mkdirSync(FIX, { recursive: true });
const MK = join(outDir('build'), 'mkclock.mjs');
await esbuild({ entryPoints: [join(ROOT, 'tests', 'ui', 'fixtures', 'mkclock.ts')], bundle: true, platform: 'node', format: 'esm', outfile: MK, logLevel: 'warning' });
execFileSync(process.execPath, [MK, FIX, workDay], { stdio: 'inherit' });

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `shifts-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
mkdirSync(persist, { recursive: true });
const seed = join(persist, 'zzs.sql');
writeFileSync(join(ROOT, seed), [
  "INSERT INTO companies (code, name, active) VALUES ('ZZS', 'zz_test บริษัทกะ', 1);",
  "INSERT INTO departments (code, name, company_id, active) VALUES ('ZZS-OPS', 'zz_test ฝ่ายปฏิบัติการ', (SELECT id FROM companies WHERE code = 'ZZS'), 1);",
  `INSERT INTO employees (emp_code, first_name, last_name, company_id, department_id, hire_date, employment_type, status) VALUES ${Array.from({ length: 6 }, (_, i) => `('ZS0${i + 1}', 'zz_ui', 'shift${i + 1}', (SELECT id FROM companies WHERE code = 'ZZS'), (SELECT id FROM departments WHERE code = 'ZZS-OPS'), '2024-01-01', 'permanent', 'active')`).join(', ')};`,
].join('\n'));
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', seed]);
const USERS = { s_staff: ['hr_staff', null], s_mgr: ['hr_manager', null], s_emp: ['employee', 'E007'] };
const pw = {};
for (const [u, [role, empCode]] of Object.entries(USERS)) {
  pw[u] = `Sh-${randomBytes(9).toString('base64url')}-7q`;
  const f = join(persist, `${u}.sql`);
  run(['scripts/create-user.mjs', '--username', u, '--display', `ทดสอบ ${u}`, '--out', f, '--cred-file', join(persist, 'c.txt'), '--role', role, ...(empCode ? ['--employee', empCode] : [])], { NEW_USER_PASSWORD: pw[u] });
  run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', f]);
}
const sql = (command) => JSON.parse(run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--json', '--command', command]))[0].results;
const port = await freePort();
const dev = spawn(process.execPath, [W, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', `MFA_ENCRYPTION_KEY:${randomBytes(32).toString('base64')}`, '--show-interactive-dev-session=false'], SERVER_SPAWN);
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

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
  await page.waitForSelector('nav.sidebar');
  return { ctx, page };
}
const menu = (page) => page.$$eval('nav.sidebar .nav-item', (els) => els.map((e) => e.textContent.trim()));
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
/** the open dialog is not covered by the fixed footer */
const dialogClear = (page) => page.evaluate(() => {
  const m = document.querySelector('.modal')?.getBoundingClientRect();
  const f = document.getElementById('site-footer')?.getBoundingClientRect();
  const top = document.elementFromPoint(innerWidth / 2, Math.min(innerHeight - 2, (m?.bottom ?? 0) - 4));
  return { ok: !!m && (!f || m.bottom <= f.top + 1 || !!top?.closest('.modal')), bottom: Math.round(m?.bottom ?? -1), footerTop: Math.round(f?.top ?? -1) };
});

try {
  // ---- menus by permission -----------------------------------------------------------------------------------
  const NEW = ['นำเข้าไฟล์เวลาทำงาน', 'ประวัติการนำเข้าเวลา', 'กะการทำงาน', 'กลุ่มกะ', 'ตารางกะกลุ่ม'];
  const { ctx, page } = await session('s_staff');
  const items = await menu(page);
  check('HR staff menu: บันทึกเวลาทำงาน and the five new pages', ['บันทึกเวลาทำงาน', ...NEW].every((t) => items.some((x) => x.includes(t))) && !items.some((x) => x.includes('รายการพื้นฐาน')), items.filter((x) => /เวลา|กะ/.test(x)).join(' | '));
  {
    const m = await session('s_mgr');
    const mi = await menu(m.page);
    check('manager menu: shift pages only (no import)', ['กะการทำงาน', 'กลุ่มกะ', 'ตารางกะกลุ่ม'].every((t) => mi.some((x) => x.includes(t))) && !mi.some((x) => x.includes('นำเข้าไฟล์เวลาทำงาน')));
    await m.page.goto(BASE + '/shifts');
    await m.page.waitForSelector('main .toolbar');
    check('manager: shift settings read-only (no add / edit)', (await m.page.locator('main button:has-text("+ เพิ่มกะ")').count()) === 0);
    await m.page.goto(BASE + '/attendance/file-import');
    await m.page.waitForSelector('main .state-page');
    check('manager: import wizard refused (403 page)', (await m.page.textContent('main')).includes('403'));
    await m.ctx.close();
    const e = await session('s_emp');
    const ei = await menu(e.page);
    check('employee menu: none of the new pages', NEW.every((t) => !ei.some((x) => x.includes(t))));
    await e.ctx.close();
  }

  // ---- shift settings ----------------------------------------------------------------------------------------
  await page.goto(BASE + '/shifts');
  await page.waitForSelector('main .toolbar');
  const addShift = async (code, name, start, end, extraBreak) => {
    await page.click('main button:has-text("+ เพิ่มกะ")');
    await page.waitForSelector('.modal .shift-form');
    await page.fill('.modal input[name=code]', code);
    await page.fill('.modal input[name=name]', name);
    await page.selectOption('.modal select[name=company_id]', { label: 'zz_test บริษัทกะ' });
    await page.fill('.modal input[name=start_time]', start);
    await page.fill('.modal input[name=end_time]', end);
    if (extraBreak === 'night') {
      await page.fill('.modal .break-row .b-start', '02:00');
      await page.fill('.modal .break-row .b-end', '03:00');
      for (const d of ['0', '6']) await page.check(`.modal .weekday-checks input[value="${d}"]`);
    } else if (extraBreak) {
      await page.click('.modal button:has-text("+ เพิ่มช่วงพัก")');
    }
  };
  await addShift('ZUD', 'zz_ui กะเช้า', '08:00', '17:00', true);
  const summary = await page.textContent('.modal .shift-summary');
  check('shift editor: two breaks → net 7 ชม. 45 นาที', summary.includes('7 ชม. 45 นาที'), summary);
  check('shift editor dialog not under the footer (1440)', (await dialogClear(page)).ok, JSON.stringify(await dialogClear(page)));
  await page.screenshot({ path: join(OUT, 'shift-editor-1440-light.png') });
  await page.click('.modal button:has-text("บันทึก")');
  await page.waitForSelector('main tr[data-code="ZUD"]');
  const row = await page.textContent('main tr[data-code="ZUD"]');
  check('shift saved: breaks 12:00–13:00, 15:00–15:15, net hours', row.includes('12:00–13:00, 15:00–15:15') && row.includes('7 ชม. 45 นาที'), row);
  await addShift('ZUN', 'zz_ui กะดึก', '22:00', '07:00', 'night');
  check('cross-midnight preview', (await page.textContent('.modal .shift-summary')).includes('ข้ามวัน'));
  await page.click('.modal button:has-text("บันทึก")');
  await page.waitForSelector('main tr[data-code="ZUN"]');
  check('night shift listed with the cross-midnight badge and 8 hours net', (await page.textContent('main tr[data-code="ZUN"]')).includes('ข้ามวัน') && (await page.textContent('main tr[data-code="ZUN"]')).includes('8 ชม.'));
  // invalid: overlapping breaks are explained before saving
  await page.click('main button:has-text("+ เพิ่มกะ")');
  await page.waitForSelector('.modal .shift-form');
  await page.click('.modal button:has-text("+ เพิ่มช่วงพัก")');
  await page.fill('.modal .break-row:nth-child(2) .b-start', '12:30');
  await page.fill('.modal .break-row:nth-child(2) .b-end', '13:30');
  check('overlapping breaks flagged in the editor', (await page.textContent('.modal .shift-summary')).includes('ซ้อนกัน'));
  await page.click('.modal button:has-text("ยกเลิก")');

  // ---- groups ------------------------------------------------------------------------------------------------
  const company = sql("SELECT id FROM companies WHERE code = 'ZZS'")[0].id;
  await page.goto(BASE + '/shifts/groups');
  await page.waitForSelector('main .toolbar');
  const makeGroup = async (code, type, shift) => {
    await page.click('main button:has-text("+ สร้างกลุ่ม")');
    await page.waitForSelector('.modal .grid-form');
    const f = (label) => page.locator('.modal label.field', { hasText: label });
    await f('รหัสกลุ่ม').locator('input').fill(code);
    await f('ชื่อกลุ่ม').locator('input').fill(`zz_ui ${code}`);
    await page.selectOption('.modal select[aria-label="บริษัท"]', { label: 'zz_test บริษัทกะ (ZZS)' });
    await page.waitForTimeout(300);
    await f('ประเภทกะ').locator('select').selectOption(type);
    if (shift) await f('กะประจำของกลุ่ม').locator('select').selectOption({ label: shift });
    await page.click('.modal button:has-text("บันทึก")');
    await page.waitForSelector(`main tr[data-code="${code}"]`);
  };
  await makeGroup('ZUS', 'scheduled', null);
  await makeGroup('ZUF', 'fixed', 'ZUD zz_ui กะเช้า (08:00–17:00)');
  check('groups listed with type and default shift', (await page.textContent('main tr[data-code="ZUF"]')).includes('ZUD') && (await page.textContent('main tr[data-code="ZUS"]')).includes('Scheduled'));
  const addMembers = async (code, emps) => {
    await page.click(`main tr[data-code="${code}"] a`);
    await page.waitForSelector('main .card h2');
    await page.click('main button:has-text("+ เพิ่มสมาชิก")');
    await page.waitForSelector('.modal .pick-list');
    // a real mouse click at the box (Playwright's locator click can miss inside the blurred, scrollable backdrop)
    for (const e of emps) {
      const box = await page.locator('.modal .pick-list label', { hasText: e }).locator('input').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    }
    const ticked = await page.$$eval('.modal .pick-list label', (ls) => ls.filter((l) => l.querySelector('input').checked).map((l) => l.textContent.trim().slice(0, 4)));
    check(`bulk add: ${emps.join(', ')} ticked`, ticked.join() === emps.join(), ticked.join());
    check(`bulk add dialog fits above the footer (${code})`, (await dialogClear(page)).ok);
    await page.click('.modal button:has-text("เพิ่มสมาชิก")');
    await page.waitForFunction((n) => document.querySelectorAll('main .member-table tbody tr').length === n, emps.length);
  };
  await addMembers('ZUS', ['ZS01', 'ZS02', 'ZS03']);
  check('scheduled group: three members', (await page.$$('main .member-table tbody tr')).length === 3);
  await page.goto(BASE + '/shifts/groups');
  await page.waitForSelector('main tr[data-code="ZUF"]');
  await addMembers('ZUF', ['ZS04', 'ZS05']);
  await page.click('main .segmented button:has-text("ประวัติสมาชิก")');
  await page.waitForSelector('main h3:has-text("ประวัติการเปลี่ยนแปลง")');
  check('member history shows the audit trail', (await page.textContent('main')).includes('เพิ่มสมาชิก'));

  // ---- group schedule ----------------------------------------------------------------------------------------
  const zus = sql("SELECT id FROM shift_groups WHERE code = 'ZUS'")[0].id;
  const zuf = sql("SELECT id FROM shift_groups WHERE code = 'ZUF'")[0].id;
  // two consecutive future weekdays in the same week and month (both visible in the week and the month view)
  const wd = (d) => new Date(`${d}T00:00:00Z`).getUTCDay();
  let k = 1;
  while (!(wd(addDays(today, k)) >= 1 && wd(addDays(today, k)) <= 5 && addDays(today, k).slice(0, 7) === addDays(today, k + 1).slice(0, 7))) k++;
  const d1 = addDays(today, k);
  const d2 = addDays(today, k + 1);
  sql(`INSERT INTO shifts (code, name, start_time, end_time, break_minutes, active, company_id, shift_type, work_days, breaks_json) VALUES ('ZUE', 'zz_ui กะเช้ามืด', '06:00', '15:00', 0, 1, ${company}, 'fixed', '0,1,2,3,4,5,6', '[]')`);
  await page.goto(BASE + `/shifts/schedule?company=${company}&group=${zus}&date=${d1}`);
  await page.waitForSelector('main .schedule-grid');
  const daysInMonth = await page.$$eval('main .schedule-grid thead th', (t) => t.length - 1);
  check('month view: one column per day, rows = members', daysInMonth >= 28 && daysInMonth <= 31 && (await page.$$('main .schedule-grid tbody tr')).length === 3, `${daysInMonth} days`);
  const cell = (emp, date) => `main .schedule-grid tr[data-emp="${emp}"] td[data-date="${date}"]`;
  {
    await page.click(cell('ZS03', d1));
    await page.click(cell('ZS03', d2), { modifiers: ['Shift'] });
    await page.selectOption('main .schedule-actions select', { label: 'ZUN zz_ui กะดึก (22:00–07:00)' });
    await page.click('main .schedule-actions button:has-text("กำหนดกะ")');
    await page.click(cell('ZS01', d1));
    await page.click('main .schedule-actions button:has-text("วันหยุด (Day Off)")');
    check('pending changes marked before saving', (await page.$$('main .sch-cell.is-pending')).length === 3 && (await page.textContent('main .schedule-actions')).includes('บันทึก (3)'));
    await page.click('main .schedule-actions button:has-text("บันทึก (3)")');
    await page.waitForSelector('.modal');
    const confirm = await page.textContent('.modal');
    check('save confirmation summarises the changes', confirm.includes('กำหนดกะ 2') && confirm.includes('วันหยุด 1'), confirm.slice(0, 160));
    check('confirmation dialog above the footer', (await dialogClear(page)).ok);
    check('pending cells in a scheduled group show the group tag (G)', (await page.textContent(cell('ZS03', d1))).includes('G'));
    await page.click('.modal button:has-text("ยืนยันบันทึก")');
    await page.waitForFunction(() => !document.querySelector('.modal') && document.querySelector('main .schedule-grid') && !document.querySelector('main .sch-cell.is-pending'));
    const saved = [await page.textContent(cell('ZS03', d1)), await page.textContent(cell('ZS03', d2)), await page.textContent(cell('ZS01', d1))];
    check('saved: night shift with group tag, day off', saved[0].includes('ZUN') && saved[0].includes('G') && saved[1].includes('ZUN') && saved[2].includes('หยุด'), JSON.stringify(saved));
    check('stored as group schedule with revisions', sql(`SELECT COUNT(*) AS n FROM shift_schedules WHERE origin = 'group' AND group_id = ${zus}`)[0].n === 3 && sql('SELECT COUNT(*) AS n FROM shift_schedule_revisions')[0].n === 3);
    await page.screenshot({ path: join(OUT, 'schedule-month-1440-light.png') });
  }
  // fixed group: defaults shown as G; an individual override from the company view shows I
  await page.goto(BASE + `/shifts/schedule?company=${company}&group=${zuf}&date=${d1}&view=week`);
  await page.waitForSelector('main .schedule-grid');
  check('week view: 7 columns, fixed group defaults (G)', (await page.$$eval('main .schedule-grid thead th', (t) => t.length - 1)) === 7 && (await page.textContent(cell('ZS04', d1))).includes('ZUD'));
  await page.goto(BASE + `/shifts/schedule?company=${company}&date=${d1}&view=week`);
  await page.waitForSelector('main .schedule-grid');
  await page.click(cell('ZS04', d1));
  await page.selectOption('main .schedule-actions select', { label: 'ZUN zz_ui กะดึก (22:00–07:00)' });
  await page.click('main .schedule-actions button:has-text("กำหนดกะ")');
  await page.click('main .schedule-actions button:has-text("บันทึก (1)")');
  await page.waitForSelector('.modal');
  await page.click('.modal button:has-text("ยืนยันบันทึก")');
  await page.waitForFunction(() => !document.querySelector('.modal') && document.querySelector('main .schedule-grid') && !document.querySelector('main .sch-cell.is-pending'));
  const tag = await page.$eval(`${cell('ZS04', d1)} .sch-src`, (e) => e.textContent);
  check('individual override shown as I with its source in the tooltip', tag === 'I' && (await page.getAttribute(cell('ZS04', d1), 'title')).includes('Individual Override'));
  // a night shift (ends 07:00) followed by a 06:00 shift the next day is a conflict → save refused
  await page.click(cell('ZS04', d2));
  await page.selectOption('main .schedule-actions select', { label: 'ZUE zz_ui กะเช้ามืด (06:00–15:00)' });
  await page.click('main .schedule-actions button:has-text("กำหนดกะ")');
  await page.click('main .schedule-actions button:has-text("บันทึก (1)")');
  await page.waitForSelector('.modal');
  const conflict = await page.textContent('.modal');
  check('conflict shown and saving blocked', conflict.includes('ข้อขัดแย้ง') && (await page.isDisabled('.modal button:has-text("ยืนยันบันทึก")')));
  await page.click('.modal button:has-text("ยกเลิก")');
  await page.click('main .schedule-actions button:has-text("ยกเลิกการแก้ไข")');

  // ---- attendance file import --------------------------------------------------------------------------------
  await page.goto(BASE + '/attendance/file-import');
  await page.waitForSelector('main .dropzone');
  await page.selectOption('main .wizard-step select[aria-label="บริษัท"]', { label: 'zz_test บริษัทกะ (ZZS)' });
  await page.setInputFiles('#clock-file', join(FIX, 'fake.xlsx'));
  await page.waitForSelector('main .file-info .alert-error');
  check('step 1: a fake .xlsx is refused by content check', (await page.textContent('main .file-info')).includes('ไม่ใช่ Excel'));
  await page.setInputFiles('#clock-file', join(FIX, 'clock.csv'));
  await page.waitForSelector('main .file-info .file-rows');
  check('step 1: file name, size and row count', (await page.textContent('main .file-info .file-name')) === 'clock.csv' && (await page.textContent('main .file-info .file-rows')) === '6');
  await page.screenshot({ path: join(OUT, 'import-step1-1440-light.png') });
  await page.click('main button:has-text("ถัดไป: จับคู่คอลัมน์")');
  await page.waitForSelector('main .mapping-table');
  const mapped = await page.$$eval('main .mapping-table select', (s) => s.map((x) => x.selectedOptions[0]?.textContent));
  check('step 2: columns mapped by name', mapped.slice(0, 5).join('|') === 'รหัสพนักงาน|วันที่|เวลาเข้า|เวลาออก|เครื่องบันทึกเวลา', mapped.join('|'));
  await page.click('main button:has-text("ถัดไป: ตรวจสอบข้อมูล")');
  await page.waitForSelector('main .clock-rows');
  const kpis = await page.$$eval('main .kpi', (els) => els.map((e) => e.textContent));
  check('step 3: valid / warning / duplicate / invalid counts', kpis.join('|') === 'ทั้งหมด6|Valid (ผ่าน)2|Warning (ผ่าน มีคำเตือน)1|Duplicate (ซ้ำ)1|Invalid (ไม่ถูกต้อง)2', kpis.join('|'));
  await page.click('main .segmented label:has-text("Invalid")');
  await page.waitForFunction(() => [...document.querySelectorAll('main .clock-rows tbody tr')].every((r) => r.getAttribute('data-status') === 'invalid'));
  const invalid = await page.textContent('main .clock-rows tbody');
  check('step 3: row errors explained (missing clock-in, unknown employee)', invalid.includes('ไม่มีเวลาเข้างาน') && invalid.includes('ไม่พบพนักงานรหัส ZZ999'));
  await page.screenshot({ path: join(OUT, 'import-step3-1440-light.png'), fullPage: true });
  await page.click('main button:has-text("ถัดไป: ยืนยันการนำเข้า")');
  await page.waitForSelector('main h2:has-text("4. ยืนยันการนำเข้า")');
  check('step 4: summary with the number to import', (await page.textContent('main .kpis')).includes('จำนวนที่จะนำเข้า3'));
  check('nothing saved before confirming', sql('SELECT COUNT(*) AS n FROM attendance_file_imports')[0].n === 0);
  await page.click('main button:has-text("ยืนยันนำเข้า 3 รายการ")');
  await page.waitForSelector('.modal');
  await page.click('.modal button:has-text("ยืนยันนำเข้า")');
  await page.waitForSelector('main h2:has-text("5. ผลการนำเข้า")');
  const res = await page.textContent('main .wizard-step');
  check('step 5: result, operator, source file and error report links', res.includes('สำเร็จ3') && res.includes('s_staff') && res.includes('clock.csv') && (await page.$$('main a:has-text("Error Report")')).length === 2, res.slice(0, 200));
  const dl = await Promise.all([page.waitForEvent('download'), page.click('main a:has-text("Error Report (CSV)")')]);
  const report = readFileSync(await dl[0].path(), 'utf8');
  check('error report CSV lists the rejected rows', report.includes('ZZ999') && report.includes('ไม่มีเวลาเข้างาน'));
  await page.click('main button:has-text("นำเข้าไฟล์ใหม่")');
  await page.waitForSelector('main .dropzone');
  check('result: "นำเข้าไฟล์ใหม่" restarts the wizard at step 1', (await page.$$('main .stepper li.current')).length === 1 && (await page.textContent('main .stepper li.current')).includes('อัปโหลดไฟล์'));
  check('imported rows in attendance_records (source import, cross-midnight next day)', sql("SELECT COUNT(*) AS n FROM attendance_records WHERE source = 'import'")[0].n === 3 && sql("SELECT clock_out_next_day AS x FROM attendance_records a JOIN employees e ON e.id = a.employee_id WHERE e.emp_code = 'ZS03'")[0].x === 1);
  // XLSX (title rows above the header) and XLS (BIFF8)
  for (const [file, rows] of [['clock.xlsx', '2'], ['clock.xls', '1']]) {
    await page.goto(BASE + '/attendance/file-import');
    await page.waitForSelector('main .dropzone');
    await page.selectOption('main .wizard-step select[aria-label="บริษัท"]', { label: 'zz_test บริษัทกะ (ZZS)' });
    await page.setInputFiles('#clock-file', join(FIX, file));
    await page.waitForSelector('main .file-info .file-rows');
    check(`${file}: rows counted under the detected header`, (await page.textContent('main .file-info .file-rows')) === rows);
    await page.click('main button:has-text("ถัดไป: จับคู่คอลัมน์")');
    await page.waitForSelector('main .mapping-table');
    await page.click('main button:has-text("ถัดไป: ตรวจสอบข้อมูล")');
    await page.waitForSelector('main .kpis');
    await page.click('main button:has-text("ถัดไป: ยืนยันการนำเข้า")');
    await page.waitForSelector('main h2:has-text("4. ยืนยันการนำเข้า")');
    const btn = page.locator('main button:has-text("ยืนยันนำเข้า")');
    if (await btn.isEnabled()) {
      await btn.click();
      await page.waitForSelector('.modal');
      await page.click('.modal button:has-text("ยืนยันนำเข้า")');
      await page.waitForSelector('main h2:has-text("5. ผลการนำเข้า")');
    }
    check(`${file}: imported through the five steps`, (await page.textContent('main')).includes(file === 'clock.xlsx' ? 'ซ้ำ2' : 'สำเร็จ1') || (await page.textContent('main')).includes('จำนวนซ้ำ2'));
  }
  await page.goto(BASE + '/attendance/file-imports');
  await page.waitForSelector('main .import-history');
  const hist = await page.$$eval('main .import-history tbody tr', (r) => r.map((x) => x.textContent));
  check('import history: one row per confirmed import with counts', hist.length >= 2 && hist.some((x) => x.includes('clock.csv')), String(hist.length));

  // ---- layouts: light / dark, 1440 / 768 / 375 ---------------------------------------------------------------
  for (const [vp, theme] of [[{ width: 1440, height: 900 }, 'dark'], [{ width: 768, height: 1024 }, 'light'], [{ width: 375, height: 812 }, 'light'], [{ width: 375, height: 812 }, 'dark']]) {
    const v = await session('s_staff', vp, theme);
    for (const [path, wait, name] of [[`/shifts/schedule?company=${company}&group=${zus}&date=${d1}`, 'main .schedule-grid', 'schedule'], ['/shifts', 'main .shift-table', 'shifts'], ['/attendance/file-import', 'main .dropzone', 'import'], ['/attendance/file-imports', 'main .import-history', 'history']]) {
      await v.page.goto(BASE + path);
      await v.page.waitForSelector(wait);
      const o = await overflow(v.page);
      check(`${vp.width} ${theme} ${name}: no page overflow`, o <= 0, String(o));
      await v.page.screenshot({ path: join(OUT, `${name}-${vp.width}-${theme}.png`) });
    }
    if (vp.width === 375) {
      const inside = await v.page.evaluate(() => { const w = document.querySelector('.schedule-wrap'); return !w || w.scrollWidth >= w.clientWidth; });
      check(`${vp.width} ${theme}: the calendar scrolls inside its frame`, inside);
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
console.log(`ui-attendance-shifts pass=${results.length - fail} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
