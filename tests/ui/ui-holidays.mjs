// Holiday Calendar page (local only; fresh local D1; synthetic users and holidays): month / year calendar with Thai
// Buddhist years, list and filters, add holiday (draft), import with preview (errors shown, drafts only), export link,
// work / rule tabs, controls hidden from view-only users, light / dark and 1440 / 768 / 375 without overflow.
// usage: node tests/ui/ui-holidays.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('holidays');
mkdirSync(OUT, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `holidays-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const Y = new Date().getUTCFullYear() + 1;
const BE = Y + 543;
// synthetic holidays in the central calendar: one approved (source verified), one draft
writeFileSync(join(ROOT, persist, 'fixtures.sql'), `INSERT INTO holidays (calendar_id, holiday_date, year, name, holiday_type, status, verification, source_reference) VALUES
  (1, '${Y}-05-01', ${Y}, 'วันแรงงานแห่งชาติ (uitest)', 'national_labour', 'approved', 'verified', 'uitest source'),
  (1, '${Y}-05-04', ${Y}, 'วันร่าง (uitest)', 'traditional', 'draft', 'unverified', NULL);`);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', join(persist, 'fixtures.sql')]);
const USERS = { h_staff: ['hr_staff', null], h_emp: ['employee', 'E007'] };
const pw = {};
for (const [u, [role, empCode]] of Object.entries(USERS)) {
  pw[u] = `Ho-${randomBytes(9).toString('base64url')}-4k`;
  const f = join(persist, `${u}.sql`);
  run(['scripts/create-user.mjs', '--username', u, '--display', `ทดสอบ ${u}`, '--out', f, '--cred-file', join(persist, 'c.txt'), '--role', role, ...(empCode ? ['--employee', empCode] : [])], { NEW_USER_PASSWORD: pw[u] });
  run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', f]);
}
const port = await freePort();
const dev = spawn(process.execPath, [W, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', `MFA_ENCRYPTION_KEY:${randomBytes(32).toString('base64')}`, '--show-interactive-dev-session=false'], SERVER_SPAWN);
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const errors = [];
const browser = await chromium.launch({ executablePath: EXE });

async function session(user, viewport = { width: 1440, height: 900 }, theme = 'light') {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, locale: 'th-TH' });
  await ctx.addInitScript((t) => { try { localStorage.setItem('hr.theme', t); } catch { /* none */ } }, theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${user}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${user}: ${m.text()}`); });
  await page.goto(BASE + '/login'); await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw[user]); await page.click('button.auth-submit');
  await page.waitForSelector('nav.sidebar');
  return { ctx, page };
}
const open = async (page, query) => {
  await page.goto(BASE + `/holidays?${query}`);
  await page.waitForSelector('.holiday-toolbar');
  await page.waitForFunction(() => !document.querySelector('main .loading'));
};
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

try {
  const { ctx, page } = await session('h_staff');
  const nav = await page.$('nav.sidebar a[href="/holidays"]');
  check('menu: "ปฏิทินวันหยุด" is listed for HR staff', !!nav);

  await open(page, `year=${Y}&month=5`);
  const month = await page.evaluate(() => ({
    title: document.querySelector('.hol-month-title')?.textContent,
    chips: [...document.querySelectorAll('.hol-chip')].map((c) => c.textContent),
    holidayCells: document.querySelectorAll('.hol-day.is-holiday').length,
    draftCells: document.querySelectorAll('.hol-day.is-draft').length,
    yearOption: document.querySelector('.holiday-toolbar select')?.selectedOptions[0]?.textContent,
    buttons: [...document.querySelectorAll('.holiday-toolbar button, .holiday-toolbar a.btn')].map((b) => b.textContent),
  }));
  check('month view: Thai month name with the Buddhist year', month.title === `พฤษภาคม ${BE}`, month.title);
  check('year selector shows พ.ศ. (ค.ศ.)', month.yearOption === `${BE} (${Y})`, month.yearOption);
  check('approved and draft holidays are marked differently', month.chips.length === 2 && month.holidayCells === 2 && month.draftCells === 1, JSON.stringify(month));
  check('HR staff sees add / import / export (no approve permission needed for these)', ['+ เพิ่มวันหยุด', 'นำเข้า Excel/CSV', 'Export Excel'].every((b) => month.buttons.includes(b)), month.buttons.join());
  await page.screenshot({ path: join(OUT, 'month-1440-light.png') });
  const comp = await page.evaluate(() => ({ text: document.querySelector('.holiday-compliance')?.textContent ?? '', warn: document.querySelectorAll('.holiday-compliance .compliance-row.is-warn').length }));
  check('compliance: fewer than 13 approved traditional holidays is a warning; labour day shown separately; nothing is auto-approved',
    comp.warn >= 1 && comp.text.includes('นับรวม 1 / ขั้นต่ำ 13') && comp.text.includes('วันแรงงานแห่งชาติ (uitest)') && comp.text.includes('ร่างที่ยังไม่นับ') && comp.text.includes('ไม่สร้างหรืออนุมัติวันหยุดแทน'), comp.text.slice(0, 160));

  await page.click('.hol-chip:has-text("uitest")');
  await page.waitForSelector('.modal .dl');
  const detail = await page.$eval('.modal', (m) => ({ text: m.textContent, actions: [...m.querySelectorAll('.modal-actions button')].map((b) => b.textContent) }));
  check('detail dialog: Thai date, type, verified source, no approve / verify button for HR staff', detail.text.includes(`1 พ.ค. ${BE}`) && detail.text.includes('วันแรงงานแห่งชาติ') && detail.text.includes('uitest source') && !detail.actions.some((a) => a === 'อนุมัติ' || a === 'ตรวจสอบแหล่งที่มา'), detail.actions.join());
  check('detail dialog: a holiday on a weekly rest day suggests a substitute day', detail.text.includes('ควรกำหนดวันหยุดชดเชย'));
  await page.keyboard.press('Escape');

  // add a holiday → draft
  await page.click('.holiday-toolbar button:has-text("+ เพิ่มวันหยุด")');
  await page.waitForSelector('.modal .grid-form');
  await page.fill('.modal input[type=date]', `${Y}-05-20`);
  await page.fill('.modal .grid-form label:has-text("ชื่อวันหยุด") input', 'วันทดสอบหน้าเว็บ (uitest)');
  await page.fill('.modal .grid-form label:has-text("แหล่งที่มา") input', 'uitest notice');
  await page.click('.modal button.primary:has-text("บันทึก")');
  await page.waitForSelector('.hol-chip:has-text("วันทดสอบหน้าเว็บ")');
  check('add holiday: saved as a draft and shown in the month', await page.$eval('.hol-chip:has-text("วันทดสอบหน้าเว็บ")', (c) => c.classList.contains('st-draft')));

  // year view
  await page.click('button:has-text("รายปี")');
  await page.waitForSelector('.hol-year');
  check('year view: 12 months', (await page.$$eval('.hol-year .hol-month', (x) => x.length)) === 12);

  // list + search
  await open(page, `year=${Y}&tab=list`);
  const rows = await page.$$eval('main table tbody tr', (r) => r.map((x) => x.textContent));
  check('list view: Thai dates and statuses', rows.length === 3 && rows.some((r) => r.includes(`1 พ.ค. ${BE}`) && r.includes('อนุมัติ')) && rows.some((r) => r.includes('ร่าง')), String(rows.length));
  await page.fill('main input[type=search]', 'ร่าง');
  await page.press('main input[type=search]', 'Enter');
  await page.waitForFunction(() => document.querySelectorAll('main table tbody tr').length === 1);
  check('search filters the list', (await page.$$eval('main table tbody tr', (r) => r.length)) === 1);

  // import with preview
  const csv = `date,name,type,source_reference\n${Y}-12-05,วันพ่อ (uitest),traditional,ประกาศ\n${Y}-02-30,วันที่ผิด,traditional,x\n`;
  writeFileSync(join(ROOT, persist, 'import.csv'), '﻿' + csv);
  await open(page, `year=${Y}&tab=list`); // without the search filter above
  await page.click('.holiday-toolbar button:has-text("นำเข้า")');
  await page.waitForSelector('.modal input[type=file]');
  await page.setInputFiles('.modal input[type=file]', join(ROOT, persist, 'import.csv'));
  await page.click('.modal button:has-text("ตรวจสอบไฟล์")');
  await page.waitForSelector('.modal table tbody tr');
  const prev = await page.evaluate(() => ({ rows: document.querySelectorAll('.modal table tbody tr').length, errorRows: document.querySelectorAll('.modal tr.row-error').length, text: document.querySelector('.modal').textContent }));
  check('import preview: every row validated, the invalid date is flagged', prev.rows === 2 && prev.errorRows === 1 && prev.text.includes('วันที่ไม่ถูกต้อง'), JSON.stringify({ rows: prev.rows, errorRows: prev.errorRows }));
  await page.check('.modal label:has-text("นำเข้าเฉพาะแถวที่ถูกต้อง") input');
  await page.click('.modal button.primary:has-text("นำเข้า 1")');
  await page.click('.modal:has-text("ยืนยันนำเข้า") button.primary');
  await page.waitForFunction(() => [...document.querySelectorAll('main table tbody tr')].some((r) => r.textContent.includes('วันพ่อ (uitest)')) || document.querySelector('.toast-error'));
  const imported = await page.evaluate(() => [...document.querySelectorAll('main table tbody tr')].find((r) => r.textContent.includes('วันพ่อ (uitest)'))?.textContent ?? '');
  check('import: valid row imported as a draft from file', imported.includes('ร่าง') && imported.includes('นำเข้าจากไฟล์'), imported);

  // export link downloads an xlsx
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.holiday-toolbar a:has-text("Export Excel")')]);
  check('export downloads an Excel file', /\.xlsx$/.test(dl.suggestedFilename()), dl.suggestedFilename());

  // other tabs
  await open(page, `year=${Y}&tab=work`);
  check('holiday work tab renders (evidence explanation + add button)', (await page.textContent('main')).includes('หลักฐานเวลาทำงาน') && !!(await page.$('main button:has-text("บันทึกการทำงานวันหยุด")')));
  await open(page, `year=${Y}&tab=rules`);
  const rules = await page.textContent('main');
  check('pay rules tab shows the statutory minimums', rules.includes('ไม่น้อยกว่า 1 เท่า') && rules.includes('ไม่น้อยกว่า 2 เท่า') && rules.includes('ไม่น้อยกว่า 3 เท่า'));
  await ctx.close();

  // view-only employee
  const e = await session('h_emp');
  await open(e.page, `year=${Y}&month=5`);
  const eb = await e.page.$$eval('.holiday-toolbar button, .holiday-toolbar a.btn', (b) => b.map((x) => x.textContent));
  check('employee: sees the calendar, no add / import / export controls', (await e.page.$$('.hol-chip')).length >= 1 && !eb.some((t) => /เพิ่มวันหยุด|นำเข้า|Export/.test(t)), eb.join());
  await e.ctx.close();

  // themes and sizes
  for (const [vp, theme, q] of [[{ width: 1440, height: 900 }, 'dark', 'month=5'], [{ width: 768, height: 1024 }, 'light', 'view=year'], [{ width: 375, height: 740 }, 'dark', 'month=5'], [{ width: 375, height: 740 }, 'light', 'tab=list']]) {
    const s = await session('h_staff', vp, theme);
    await open(s.page, `year=${Y}&${q}`);
    const o = await overflow(s.page);
    check(`${vp.width} ${theme} ${q}: no horizontal page overflow`, o <= 0, String(o));
    await s.page.screenshot({ path: join(OUT, `${q.replace('=', '-')}-${vp.width}-${theme}.png`) });
    await s.ctx.close();
  }
} finally {
  await browser.close();
  stopServer(dev);
}
check('no console errors / page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-holidays pass=${results.length - fail} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
