// Employee list and form (local only; fresh local D1; synthetic users and a synthetic company ZZE): company filter
// (reset to page 1, totals, own-scope users), page size 25 / 50 / 100 with search, the tenure column, the tenure /
// probation panel of the form recomputed when the hire date changes (nothing saved), opening a record from a
// notification link (?open=<id>), light / dark and 1440 / 375 without overflow.
// usage: node tests/ui/ui-employees.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('employees');
mkdirSync(OUT, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// the server counts days in Asia/Bangkok; the synthetic probation employee is on day 97 of that date
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `employees-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const seed = join(persist, 'zze.sql');
mkdirSync(persist, { recursive: true });
writeFileSync(join(ROOT, seed), [
  "INSERT INTO companies (code, name, active) VALUES ('ZZE', 'zz_test บริษัททดสอบ', 1);",
  `INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status) VALUES ${Array.from({ length: 30 }, (_, i) => `('ZE${String(i + 1).padStart(2, '0')}', 'zz_ui', 'p${i + 1}', (SELECT id FROM companies WHERE code = 'ZZE'), '2024-02-29', 'permanent', 'active')`).join(', ')};`,
  `INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status) VALUES ('ZEPROB', 'zz_ui', 'probation', (SELECT id FROM companies WHERE code = 'ZZE'), '${addDays(today, -96)}', 'probation', 'probation');`,
].join('\n'));
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', seed]);
const USERS = { e_staff: ['hr_staff', null], e_emp: ['employee', 'E007'] };
const pw = {};
for (const [u, [role, empCode]] of Object.entries(USERS)) {
  pw[u] = `Em-${randomBytes(9).toString('base64url')}-7q`;
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
const state = (page) => page.evaluate(() => {
  const heads = [...document.querySelectorAll('main thead th')].map((t) => t.textContent);
  const rows = [...document.querySelectorAll('main tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent));
  const sel = (label) => { const s = document.querySelector(`main .toolbar select[aria-label="${label}"]`); return s ? { value: s.value, options: [...s.options].map((o) => o.textContent) } : null; };
  return { heads, rows, company: sel('บริษัท'), size: sel('จำนวนรายการต่อหน้า'), pager: document.querySelector('main .pager')?.textContent ?? '' };
});
// waits for the list to reflect a change (the pager text changes on every reload of the table)
const settle = async (page, before) => { await page.waitForFunction((b) => document.querySelector('main .pager')?.textContent !== b && !document.querySelector('main .table-wrap .loading'), before); };
const settleRows = (page, n) => page.waitForFunction((k) => document.querySelectorAll('main tbody tr').length === k, n);

try {
  // ---- HR staff: every company --------------------------------------------------------------------------------
  const { ctx, page } = await session('e_staff');
  await page.goto(BASE + '/employees');
  await page.waitForSelector('main tbody tr');
  let s = await state(page);
  check('toolbar: company filter with "every company" and both companies', s.company && s.company.options.join('|') === 'บริษัท: ทุกบริษัท|บริษัท เดโม่ เอชอาร์ จำกัด|zz_test บริษัททดสอบ' && s.company.value === '', JSON.stringify(s.company));
  check('toolbar: page size 25 / 50 / 100, default 25', s.size && s.size.options.join('|') === '25 รายการ/หน้า|50 รายการ/หน้า|100 รายการ/หน้า' && s.size.value === '25', JSON.stringify(s.size));
  const ti = s.heads.indexOf('อายุงาน');
  const ci = s.heads.indexOf('บริษัท');
  check('table: company and tenure columns', ti > 0 && ci > 0, s.heads.join(','));
  check('all companies: 39 employees, 25 on page 1 of 2', s.pager.includes('ทั้งหมด 39 รายการ') && s.rows.length === 25 && s.pager.includes('1 / 2'), s.pager);
  const e001 = s.rows.find((r) => r[0] === 'E001');
  check('tenure text "X ปี X เดือน X วัน" for every row', s.rows.every((r) => /^\d+ ปี \d+ เดือน \d+ วัน$/.test(r[ti])), s.rows.map((r) => r[ti]).slice(0, 3).join(' / '));
  check('E001 (hired 2 Jan 2018) shows 8+ years', e001 && /^(8|9|1\d) ปี /.test(e001[ti]), e001?.[ti]);

  // page 2, then change the company: back to page 1, totals recalculated
  let before = s.pager;
  await page.click('main .pager button:has-text("›")');
  await settle(page, before);
  check('page 2 of all companies', (await state(page)).pager.includes('2 / 2'));
  before = (await state(page)).pager;
  await page.selectOption('main .toolbar select[aria-label="บริษัท"]', { label: 'zz_test บริษัททดสอบ' });
  await settle(page, before);
  s = await state(page);
  check('company ZZE: only its employees, 31 in total, back to page 1', s.pager.includes('ทั้งหมด 31 รายการ') && s.pager.includes('1 / 2') && s.rows.every((r) => r[ci] === 'zz_test บริษัททดสอบ (ZZE)'), s.pager);
  const leap = s.rows.find((r) => r[0] === 'ZE01');
  check('leap-day hire (29 Feb 2024) tenure is calendar based', leap && /^2 ปี \d+ เดือน \d+ วัน$/.test(leap[ti]), leap?.[ti]);

  // page size: 50 → one page; 100 → one page; back to 25
  before = s.pager;
  await page.click('main .pager button:has-text("›")');
  await settle(page, before);
  before = (await state(page)).pager;
  await page.selectOption('main .toolbar select[aria-label="จำนวนรายการต่อหน้า"]', '50');
  await settleRows(page, 31);
  s = await state(page);
  check('page size 50: all 31 on one page, back to page 1, same total', s.rows.length === 31 && s.pager.includes('ทั้งหมด 31 รายการ') && !s.pager.includes('/'), s.pager);
  await page.selectOption('main .toolbar select[aria-label="จำนวนรายการต่อหน้า"]', '100');
  await page.waitForTimeout(400);
  check('page size 100: 31 rows', (await state(page)).rows.length === 31);
  await page.selectOption('main .toolbar select[aria-label="จำนวนรายการต่อหน้า"]', '25');
  await settleRows(page, 25);
  // search together with the company filter
  await page.fill('main .toolbar input[type=search]', 'probation');
  await settleRows(page, 1);
  s = await state(page);
  check('search + company filter + page size work together', s.rows.length === 1 && s.rows[0][0] === 'ZEPROB' && s.pager.includes('ทั้งหมด 1 รายการ'), s.pager);

  // ---- form: tenure / probation panel ----------------------------------------------------------------------------
  await page.click('main tbody tr:has-text("ZEPROB")');
  await page.waitForSelector('.modal .tenure-box');
  const box = () => page.textContent('.modal .tenure-box');
  let t = await box();
  check('form: probation day 97 with the day-90 and day-120 dates', t.includes('ทดลองงาน') && t.includes('วันที่ 97') && t.includes('ครบ 90 วัน') && t.includes('ครบ 120 วัน') && t.includes('0 ปี 3 เดือน'), t);
  check('form: pay-round note (one round after day 90)', t.includes('จ่าย 1 งวด'), t);
  await page.fill('.modal input[name=hire_date]', today);
  t = await box();
  check('form: changing the hire date recalculates (day 1, 0 ปี 0 เดือน 0 วัน, two rounds)', t.includes('วันที่ 1 ') && t.includes('0 ปี 0 เดือน 0 วัน') && t.includes('จ่าย 2 งวด'), t);
  await page.click('.modal button:has-text("ปิด")');
  const saved = await page.evaluate(async () => (await (await fetch('/api/m/employees?q=ZEPROB')).json()).rows[0].hire_date);
  check('form: the panel itself saves nothing (hire date unchanged after closing)', saved === addDays(today, -96), saved);
  await page.screenshot({ path: join(OUT, 'list-1440-light.png') });

  // ---- notification link --------------------------------------------------------------------------------------
  const id = await page.evaluate(async () => (await (await fetch('/api/m/employees?q=ZEPROB')).json()).rows[0].id);
  await page.goto(BASE + `/employees?open=${id}`);
  await page.waitForSelector('.modal .tenure-box');
  check('?open=<id> opens the employee form (notification link)', (await page.inputValue('.modal input[name=emp_code]')) === 'ZEPROB');
  await page.screenshot({ path: join(OUT, 'form-1440-light.png') });
  await ctx.close();

  // ---- employee: own scope only ---------------------------------------------------------------------------------
  {
    const e = await session('e_emp');
    await e.page.goto(BASE + '/employees');
    await e.page.waitForSelector('main tbody tr');
    const x = await state(e.page);
    check('own-scope user: only their company, no "every company", only their record', x.company && !x.company.options.some((o) => o.includes('ทุกบริษัท')) && x.company.options.length === 1 && x.rows.length === 1 && x.pager.includes('ทั้งหมด 1 รายการ'), JSON.stringify(x.company) + ' ' + x.pager);
    await e.ctx.close();
  }

  // ---- sizes and themes ----------------------------------------------------------------------------------------
  for (const [vp, theme] of [[{ width: 1440, height: 900 }, 'dark'], [{ width: 768, height: 1024 }, 'light'], [{ width: 375, height: 740 }, 'dark']]) {
    const v = await session('e_staff', vp, theme);
    await v.page.goto(BASE + '/employees');
    await v.page.waitForSelector('main tbody tr');
    const o = await v.page.evaluate(() => {
      const bar = document.querySelector('main .toolbar').getBoundingClientRect();
      const sels = [...document.querySelectorAll('main .toolbar select')].map((s) => s.getBoundingClientRect());
      return { overflow: document.documentElement.scrollWidth - innerWidth, inside: sels.every((r) => r.left >= bar.left - 1 && r.right <= bar.right + 1) };
    });
    check(`${vp.width} ${theme}: toolbar selects fit, no page overflow`, o.overflow <= 0 && o.inside, JSON.stringify(o));
    await v.page.screenshot({ path: join(OUT, `list-${vp.width}-${theme}.png`) });
    await v.page.click('main tbody tr:has-text("E006")');
    await v.page.waitForSelector('.modal .tenure-box');
    const f = await v.page.evaluate(() => { const m = document.querySelector('.modal').getBoundingClientRect(); const b = document.querySelector('.modal .tenure-box').getBoundingClientRect(); return { inside: b.left >= m.left && b.right <= m.right, overflow: document.documentElement.scrollWidth - innerWidth }; });
    check(`${vp.width} ${theme}: tenure panel fits the dialog`, f.inside && f.overflow <= 0, JSON.stringify(f));
    await v.page.screenshot({ path: join(OUT, `form-${vp.width}-${theme}.png`) });
    await v.ctx.close();
  }
} finally {
  await browser.close();
  stopServer(dev);
}
check('no console errors / page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-employees pass=${results.length - fail} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
