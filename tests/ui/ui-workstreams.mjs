// Browser tests (Chromium): Feishu import, OT review, payroll preview + layout editor + export, payslip YTD,
// organization design; RBAC for Super Admin / Payroll / Manager / HR Staff / Employee; desktop 1440 + mobile 375.
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { build as esbuild } from 'esbuild';
import { ROOT, EXE, SERVER_SPAWN, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const SHOTS = outDir('ws-shots');
// synthetic Feishu-style files (no real personal data), generated fresh from tests/ui/fixtures/mkfixture.ts
const FIX = outDir('ws-fixtures');
mkdirSync(SHOTS, { recursive: true });
const MKFIX = join(outDir('build'), 'mkfixture.mjs');
await esbuild({ entryPoints: [join(ROOT, 'tests', 'ui', 'fixtures', 'mkfixture.ts')], bundle: true, platform: 'node', format: 'esm', outfile: MKFIX, logLevel: 'warning' });
execFileSync(process.execPath, [MKFIX, FIX], { stdio: 'inherit' });

const USERS = { w_admin: ['super_admin'], w_pay: ['payroll_officer'], w_mgr: ['hr_manager', 'employee'], w_staff: ['hr_staff'], w_emp: ['employee'] };
const EMP = { w_pay: 'E003', w_mgr: 'E002', w_staff: 'E005', w_emp: 'E007' };
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const persist = join('.tmp', `ws-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const pw = {};
for (const [u, roles] of Object.entries(USERS)) {
  pw[u] = `Ws-${randomBytes(9).toString('base64url')}-7c`;
  const out = join(persist, `${u}.sql`);
  const args = ['scripts/create-user.mjs', '--username', u, '--display', `ทดสอบ ${u}`, '--out', out, '--cred-file', join(persist, 'c.txt')];
  for (const r of roles) args.push('--role', r);
  if (EMP[u]) args.push('--employee', EMP[u]);
  run(args, { NEW_USER_PASSWORD: pw[u] });
  run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', out]);
}
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
const settle = (page) => page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .loading')).then(() => page.waitForTimeout(250));
const api = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, headers: { 'content-type': 'application/json', 'x-hr-requested': '1' }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { status: r.status, body: await r.json().catch(() => null) };
}, [method, path, body]);
async function pageAudit(page, label, path) {
  await page.goto(BASE + path);
  await settle(page);
  const r = await page.evaluate(() => ({ h: document.documentElement.scrollWidth <= innerWidth, text: document.querySelector('main').innerText, title: document.getElementById('page-title').textContent }));
  check(`${label} ${path}: renders, no h-scroll, no "undefined"/"NaN"`, r.h && !/\bundefined\b|\bNaN\b/.test(r.text) && !r.title.includes('403') && !r.text.includes('403 ·'), r.title);
  return r;
}
async function denied(page, label, path) {
  await page.goto(BASE + path);
  await settle(page);
  check(`${label} ${path} → 403 page`, (await page.textContent('main')).includes('403'));
}
const confirmModal = async (page, label) => { await page.click(`.modal-actions button:has-text("${label}")`); };

const browser = await chromium.launch({ executablePath: EXE });
let periodNov;
try {
  // ---- Super Admin, desktop 1440: full workflow ------------------------------------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage();
    watch(page, 'admin1440');
    await login(page, 'w_admin');
    const p1 = await api(page, 'POST', '/api/payroll/periods', { code: '2026-10', name: 'ต.ค. 69', start_date: '2026-09-26', end_date: '2026-10-25', pay_date: '2026-10-25' });
    const p2 = await api(page, 'POST', '/api/payroll/periods', { code: '2026-11', name: 'พ.ย. 69', start_date: '2026-10-26', end_date: '2026-11-25', pay_date: '2026-11-25' });
    periodNov = p2.body.id;
    check('admin: periods created through the API', p1.status === 201 && p2.status === 201);
    await api(page, 'POST', `/api/payroll/periods/${p1.body.id}/calculate`);

    // Payroll: create a mid-month period through the dialog
    await page.goto(BASE + '/payroll');
    await settle(page);
    await page.click('button:has-text("+ สร้างงวด")');
    await page.selectOption('.modal select', 'mid_month');
    const midVals = await page.evaluate(() => [...document.querySelectorAll('.modal input')].map((i) => i.value));
    check('new period dialog: mid-month preset 26 → 10, pay date 15', /-26$/.test(midVals[2]) && /-10$/.test(midVals[3]) && /-15$/.test(midVals[4]), midVals.join(' '));
    await page.fill('.modal input >> nth=0', 'X-MID');
    await page.fill('.modal input >> nth=2', '2026-10-26');
    await page.fill('.modal input >> nth=3', '2026-11-10');
    await page.fill('.modal input >> nth=4', '2026-11-15');
    await confirmModal(page, 'สร้าง');
    await page.waitForSelector('td:has-text("X-MID")');
    check('payroll list shows the mid-month round', (await page.textContent('main')).includes('กลางเดือน (ทดลองงาน)'));

    // Attendance import wizard (XLSX, Format A)
    await page.goto(BASE + `/attendance/import?period_id=${periodNov}`);
    await settle(page);
    await page.selectOption('main select >> nth=1', String(periodNov));
    await page.setInputFiles('main input[type=file]', join(FIX, 'For Payroll System_20261026_20261125.xlsx'));
    await page.click('button:has-text("วิเคราะห์ไฟล์")');
    await page.waitForSelector('h3:has-text("③ ตรวจจับรูปแบบไฟล์")');
    const t = await page.textContent('main');
    check('import: Format A detected with file period', t.includes('Format A') && t.includes('Expected Working Days'));
    check('import: validation KPIs (unknown / duplicate / OT pending)', /Employee ID ไม่พบ\s*1/.test(await page.innerText('.kpis')) && /ข้อมูลซ้ำ\s*1/.test(await page.innerText('.kpis')) && /OT รอยืนยัน\s*1/.test(await page.innerText('.kpis')));
    check('import: mapping table and reconciliation shown', t.includes('④ Column Mapping') && t.includes('⑦ Reconciliation'));
    await page.screenshot({ path: join(SHOTS, 'import-1440.png'), fullPage: true });
    await page.click('button:has-text("ยืนยันนำเข้า (เวอร์ชัน 1)")');
    check('import: confirm refused until "import valid rows only" is ticked', (await page.waitForSelector('.toast-error')) !== null);
    await page.check('section:has-text("⑧ ยืนยันการนำเข้า") input[type=checkbox]');
    await page.click('button:has-text("ยืนยันนำเข้า (เวอร์ชัน 1)")');
    await confirmModal(page, 'ยืนยันนำเข้า');
    await page.waitForSelector('td:has-text("v1")');
    check('import history shows version 1 as active', (await page.innerText('main')).includes('ใช้งาน/ปฏิบัติงาน') || (await page.$('.s-active')) !== null);

    // CSV re-import (Format B) then rollback through the UI
    await page.setInputFiles('main input[type=file]', join(FIX, 'For Payroll System+A_20261103_20261103.csv'));
    await page.click('button:has-text("วิเคราะห์ไฟล์")');
    await page.waitForSelector('text=Format B');
    await page.click('button:has-text("ยืนยันนำเข้า (เวอร์ชัน 2)")');
    await confirmModal(page, 'ยืนยันนำเข้า');
    await page.waitForSelector('td:has-text("v2")');
    await page.click('tr:has-text("v2") button:has-text("ย้อนกลับ")');
    await page.fill('.modal textarea', 'ทดสอบ rollback');
    await confirmModal(page, 'ย้อนกลับ');
    await page.waitForSelector('.s-rolled_back');
    check('rollback: v2 rolled back, v1 active again', (await page.$('tr:has-text("v1") .s-active')) !== null);

    // OT review
    await page.goto(BASE + '/attendance/ot-review');
    await settle(page);
    check('OT review lists the pending Feishu OT', (await page.innerText('main')).includes('E007'));
    await page.click('tr:has-text("E007") button:has-text("ปรับชั่วโมง")');
    await page.fill('.modal input[type=number]', '1.5');
    await page.click('.modal-actions button:has-text("ปรับชั่วโมง OT")');
    await page.waitForFunction(() => (document.querySelector('.modal .form-msg')?.textContent ?? '').length > 0);
    check('OT revise without a reason is refused', ((await page.textContent('.modal .form-msg')) ?? '').includes('เหตุผล'));
    await page.fill('.modal textarea', 'ปรับตามใบอนุมัติ');
    await page.click('.modal-actions button:has-text("ปรับชั่วโมง OT")');
    await page.waitForSelector('.empty:has-text("ไม่มี OT ที่รอตรวจสอบ")');
    check('OT revised → leaves the pending queue', true);

    // Calculate and preview
    const calc = await api(page, 'POST', `/api/payroll/periods/${periodNov}/calculate`);
    check('payroll calculated with Feishu attendance', calc.status === 200, String(calc.status));
    await page.goto(BASE + `/payroll/preview?period_id=${periodNov}&company=1`);
    await settle(page);
    const heads = await page.$$eval('.preview-table thead tr:last-child th', (x) => x.map((e) => e.textContent));
    check('preview: every required column group shown', ['รหัสพนักงาน', 'สถานะทดลองงาน', 'ชั่วโมง OT (ยืนยันแล้ว)', 'Commission', 'กองทุนสำรองเลี้ยงชีพ', 'หักเงินจ่ายกลางเดือน (Advance)', 'กองทุนสงเคราะห์ลูกจ้าง (นายจ้างสมทบ)', 'เงินได้สุทธิ'].every((x) => heads.includes(x)), `${heads.length} columns`);
    check('preview: E007 OT hours from the revised Feishu value', (await page.innerText('tr:has(td:text-is("E007"))')).includes('1.5'));
    await page.screenshot({ path: join(SHOTS, 'preview-1440.png') });

    // Layout editor: keyboard move, hide, drag & drop, save
    await page.click('button:has-text("จัดคอลัมน์ของบริษัทนี้")');
    await page.click('[data-down="emp_code"]');
    await page.uncheck('.layout-item[data-key="tax"] input[type=checkbox]');
    await page.dragAndDrop('.layout-item[data-key="company"]', '.layout-item[data-key="employee_name"]');
    const order = await page.$$eval('.layout-item', (x) => x.slice(0, 3).map((e) => e.dataset.key));
    check('layout editor: ↓ button and drag & drop reorder columns', order.join(',') === 'company,employee_name,emp_code', order.join(','));
    await confirmModal(page, 'บันทึก Layout');
    await page.waitForSelector('text=ใช้ Layout ของบริษัท');
    // code and name are frozen on the left (always); the saved layout orders the other columns and the export
    const frozenHeads = await page.$$eval('.preview-table thead tr:last-child th.fz-code, .preview-table thead tr:last-child th.fz-name', (x) => x.map((e) => e.textContent));
    const heads2 = await page.$$eval('.preview-table thead tr:last-child th:not(.fz)', (x) => x.map((e) => e.textContent));
    check('layout saved: frozen code + name, layout order for the other columns, hidden column removed', frozenHeads.join('|') === 'รหัสพนักงาน|ชื่อ-นามสกุล' && !heads2.includes('ภาษีหัก ณ ที่จ่าย') && heads2[0] === 'บริษัท', [...frozenHeads, ...heads2.slice(0, 3)].join(' | '));

    // Preview before export → CSV download that matches the table
    await page.click('button:has-text("Preview ก่อน Export")');
    await page.waitForSelector('.modal:has-text("ตรวจสอบก่อน Export")');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.modal a:has-text("ดาวน์โหลด CSV")')]);
    const csv = readFileSync(await dl.path(), 'utf8').replace(/^\uFEFF/, '');
    // the export keeps the saved layout exactly (company, name, code, …): the frozen columns are a screen aid only
    check('CSV export header = the saved layout', csv.split('\r\n')[0] === ['บริษัท', 'ชื่อ-นามสกุล', 'รหัสพนักงาน', ...heads2.slice(1)].join(','), csv.split('\r\n')[0].slice(0, 80));
    await page.keyboard.press('Escape');
    const [dlx] = await Promise.all([page.waitForEvent('download'), (async () => { await page.click('button:has-text("Preview ก่อน Export")'); await page.click('.modal a:has-text("ดาวน์โหลด Excel")'); })()]);
    check('Excel export downloads an .xlsx', dlx.suggestedFilename().endsWith('.xlsx'));
    await page.keyboard.press('Escape');
    // Reset
    await page.click('button:has-text("จัดคอลัมน์ของบริษัทนี้")');
    await confirmModal(page, 'Reset');
    await confirmModal(page, 'คืนค่ามาตรฐาน');
    await page.waitForSelector('text=Layout มาตรฐาน');
    check('layout reset to the default', true);

    // Organization design
    await page.goto(BASE + '/org-chart?company=1');
    await settle(page);
    const nodes = await page.$$eval('.org-canvas [data-id]', (x) => x.length);
    check('org chart: SVG nodes from real employees', nodes >= 7, String(nodes));
    await page.click('.org-canvas [data-id] >> nth=0');
    check('org chart: employee detail panel', (await page.innerText('.org-side')).includes('หัวหน้า (Reports To)'));
    await page.fill('input[type=search]', 'E007');
    await page.waitForTimeout(300);
    check('org chart: search highlights the match', await page.$$eval('.org-canvas rect[stroke="#f59e0b"]', (x) => x.length) >= 1);
    // zoom works on the SVG viewBox (Phase E): the scale is exposed as data-scale; full coverage in ui-org
    const w1 = await page.$eval('.org-canvas svg', (s) => Number(s.dataset.scale));
    await page.click('button[aria-label="ซูมเข้า"]');
    const w2 = await page.$eval('.org-canvas svg', (s) => Number(s.dataset.scale));
    check('org chart: zoom in', w2 > w1);
    await page.click('.org-zoombar button[aria-label="ย่อทั้งหมด"]');
    const collapsedNodes = await page.$$eval('.org-canvas [data-id]', (x) => x.length);
    await page.click('.org-zoombar button[aria-label="ขยายทั้งหมด"]');
    check('org chart: collapse / expand all', collapsedNodes < nodes && (await page.$$eval('.org-canvas [data-id]', (x) => x.length)) === nodes, `${collapsedNodes} → ${nodes}`);
    await page.click('summary:has-text("Export")');
    const [png] = await Promise.all([page.waitForEvent('download'), page.click('.menu-pop button:has-text("PNG")')]);
    check('org chart: PNG export', png.suggestedFilename().endsWith('.png'));
    await page.click('summary:has-text("Export")').catch(() => {});
    if (!(await page.isVisible('.menu-pop'))) await page.click('summary:has-text("Export")');
    const [svgDl] = await Promise.all([page.waitForEvent('download'), page.click('.menu-pop button:has-text("SVG")')]);
    check('org chart: SVG export', readFileSync(await svgDl.path(), 'utf8').includes('<svg'));
    await page.screenshot({ path: join(SHOTS, 'org-1440.png') });
    await page.click('button:has-text("ตาราง")');
    await settle(page);
    check('org table view: headcount Approved / Occupied / Vacant / Over', (await page.innerText('main')).includes('เกินอัตรา (Over)'));

    for (const path of ['/attendance/import', '/attendance/ot-review', `/payroll/preview?period_id=${periodNov}`, '/org-chart', '/org-chart?view=table', '/payroll/salary-history', '/payroll']) await pageAudit(page, 'admin 1440', path);
    await ctx.close();
  }

  // ---- Payroll officer approves / publishes; preview without layout control -------------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    watch(page, 'pay1440');
    await login(page, 'w_pay');
    for (const p of (await api(page, 'GET', '/api/payroll/periods')).body.filter((x) => x.kind === 'monthly')) {
      await api(page, 'POST', `/api/payroll/periods/${p.id}/approve`);
      await api(page, 'POST', `/api/payroll/periods/${p.id}/publish`);
    }
    await page.goto(BASE + `/payroll/preview?period_id=${periodNov}&company=1`);
    await settle(page);
    check('payroll officer: preview visible, no layout editor', (await page.$('.preview-table')) !== null && (await page.$('button:has-text("จัดคอลัมน์")')) === null);
    const put = await api(page, 'PUT', '/api/payroll/layouts/1', { columns: [{ key: 'net_pay', visible: true }] });
    check('payroll officer: layout API refused (403)', put.status === 403);
    await ctx.close();
  }

  // ---- Every role, desktop and mobile ---------------------------------------------------------
  const plan = {
    w_emp: { allow: [], deny: ['/attendance/import', '/attendance/ot-review', '/payroll/preview', '/org-chart', '/payroll/salary-history'] },
    w_mgr: { allow: ['/attendance/ot-review', '/org-chart'], deny: ['/attendance/import', '/payroll/preview', '/payroll/salary-history'] },
    w_staff: { allow: ['/attendance/import', '/attendance/ot-review', '/org-chart'], deny: ['/payroll/preview', '/payroll/salary-history'] },
    w_admin: { allow: ['/attendance/import', '/attendance/ot-review', `/payroll/preview?period_id=${periodNov}`, '/org-chart', '/payroll/salary-history'], deny: [] },
  };
  for (const [vw, label] of [[1440, '1440'], [375, '375']]) {
    for (const [user, p] of Object.entries(plan)) {
      const ctx = await browser.newContext({ viewport: { width: vw, height: vw === 375 ? 740 : 900 }, acceptDownloads: true });
      const page = await ctx.newPage();
      watch(page, `${user}${label}`);
      await login(page, user);
      for (const path of p.allow) await pageAudit(page, `${user} ${label}`, path);
      for (const path of p.deny) await denied(page, `${user} ${label}`, path);
      if (user === 'w_mgr') {
        await page.goto(BASE + '/attendance/ot-review?status=');
        await settle(page);
        check(`${user} ${label}: OT review read-only (no decision buttons)`, (await page.$('button:has-text("ยืนยัน")')) === null);
        await page.goto(BASE + '/org-chart');
        await settle(page);
        check(`${user} ${label}: org chart without Import / Export`, (await page.$('summary:has-text("Export")')) === null && (await page.$('button:has-text("Import")')) === null);
      }
      if (user === 'w_staff') {
        await page.goto(BASE + '/org-chart');
        await settle(page);
        check(`${user} ${label}: org chart Export yes, Import no`, (await page.$('summary:has-text("Export")')) !== null && (await page.$('button:has-text("Import")')) === null);
        await page.click('summary:has-text("Export")');
        const box = await page.$eval('.menu-pop', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, vw: innerWidth, h: document.documentElement.scrollWidth <= innerWidth }; });
        check(`${user} ${label}: export menu inside the screen`, box.l >= 0 && box.r <= box.vw + 0.5 && box.h, JSON.stringify(box));
        const r = await api(page, 'GET', `/api/payroll/periods/${periodNov}/preview`);
        check(`${user} ${label}: payroll preview API 403`, r.status === 403);
      }
      if (user === 'w_emp') {
        const mine = (await api(page, 'GET', '/api/my/payslips')).body.rows.find((x) => x.period_code === '2026-11');
        await page.goto(BASE + `/my/payslips/${mine.id}`);
        await settle(page);
        const txt = await page.innerText('main');
        check(`${user} ${label}: own payslip shows YTD (income, SSO, tax, EWF)`, txt.includes('ยอดสะสมตั้งแต่ต้นปี') && txt.includes('ประกันสังคมสะสม') && txt.includes('ภาษีสะสม') && txt.includes('กองทุนสงเคราะห์ลูกจ้างสะสม'));
        check(`${user} ${label}: no employer contribution on own payslip`, !txt.includes('เงินสมทบกองทุนสงเคราะห์ลูกจ้างของนายจ้าง'));
        check(`${user} ${label}: payslip page no h-scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const apis = await page.evaluate(async () => Promise.all(['/api/attendance/imports', '/api/attendance/ot', '/api/org-design', '/api/payroll/layouts/1'].map(async (u) => (await fetch(u)).status)));
        check(`${user} ${label}: new APIs refused`, apis.every((s) => s === 403), apis.join(','));
      }
      if (label === '375' && user === 'w_admin') {
        await page.goto(BASE + `/payroll/preview?period_id=${periodNov}&company=1`);
        await settle(page);
        await page.screenshot({ path: join(SHOTS, 'preview-375.png') });
        await page.goto(BASE + '/org-chart');
        await settle(page);
        await page.screenshot({ path: join(SHOTS, 'org-375.png') });
        await page.goto(BASE + '/attendance/import');
        await settle(page);
        await page.screenshot({ path: join(SHOTS, 'import-375.png'), fullPage: true });
      }
      await ctx.close();
    }
  }
  check('no console errors / page errors / HTTP 5xx in any run', allErrors.length === 0, allErrors.slice(0, 5).join(' || '));
} finally {
  await browser.close();
  stopServer(dev);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
