// Approval actions in the browser follow the API's maker-checker rule (local only; fresh local D1; synthetic users and
// holidays): the HR Leader sees a note instead of "อนุมัติ" on a holiday they created and approves one created by
// someone else; a Super Admin approving their own holiday is asked for an approval note and the holiday leaves Draft
// (the reported bug); on the payroll page HR Payroll has no approve button and the HR Leader no calculate button;
// no console errors.
// usage: node tests/ui/ui-approvals.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('approvals');
mkdirSync(OUT, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `approvals-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const USERS = { a_super: 'super_admin', a_leader: 'hr_leader', a_pay: 'hr_payroll' };
const pw = {};
for (const [u, role] of Object.entries(USERS)) {
  pw[u] = `Ap-${randomBytes(9).toString('base64url')}-3x`;
  const f = join(persist, `${u}.sql`);
  run(['scripts/create-user.mjs', '--username', u, '--display', `ทดสอบ ${u}`, '--out', f, '--cred-file', join(persist, 'c.txt'), '--role', role], { NEW_USER_PASSWORD: pw[u] });
  run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', f]);
}
const Y = new Date().getUTCFullYear() + 1;
// verified draft holidays in the central calendar, created by the Super Admin and by the HR Leader
writeFileSync(join(ROOT, persist, 'holidays.sql'), `INSERT INTO holidays (calendar_id, holiday_date, year, name, holiday_type, status, verification, source_reference, created_by) VALUES
  (1, '${Y}-06-01', ${Y}, 'วันของ Super Admin (uitest)', 'traditional', 'draft', 'verified', 'uitest ประกาศ', (SELECT id FROM users WHERE username = 'a_super')),
  (1, '${Y}-06-02', ${Y}, 'วันของ HR Leader (uitest)', 'traditional', 'draft', 'verified', 'uitest ประกาศ', (SELECT id FROM users WHERE username = 'a_leader')),
  (1, '${Y}-06-03', ${Y}, 'วันที่ผู้อื่นสร้าง (uitest)', 'traditional', 'draft', 'verified', 'uitest ประกาศ', (SELECT id FROM users WHERE username = 'a_super'));`);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', join(persist, 'holidays.sql')]);
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
const secrets = {};
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const errors = [];
const browser = await chromium.launch({ executablePath: EXE });

async function session(user) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'th-TH' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${user}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${user}: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500) errors.push(`${user}: HTTP ${r.status()} ${r.url()}`); });
  await page.goto(BASE + '/login'); await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw[user]); await page.click('button.auth-submit');
  // every role here is privileged: MFA is enrolled on the first login
  await page.waitForSelector('nav.sidebar, button:has-text("เริ่มตั้งค่า MFA"), input[name=totp]:visible');
  if (await page.$('button:has-text("เริ่มตั้งค่า MFA")')) {
    await page.click('button:has-text("เริ่มตั้งค่า MFA")');
    secrets[user] = (await page.textContent('code.secret')).trim();
    await page.fill('.mfa-setup input', totp(secrets[user]));
    await page.click('text=ยืนยันและเปิดใช้');
  }
  await page.waitForSelector('nav.sidebar');
  return { ctx, page };
}
const openHoliday = async (page, name) => {
  await page.goto(`${BASE}/holidays?year=${Y}&month=6`);
  await page.waitForSelector(`.hol-chip:has-text("${name}")`);
  await page.click(`.hol-chip:has-text("${name}")`);
  await page.waitForSelector('.modal .dl');
  return page.$eval('.modal', (m) => ({ text: m.textContent, actions: [...m.querySelectorAll('.modal-actions button')].map((b) => b.textContent) }));
};
const status = (name) => sql(`SELECT status FROM holidays WHERE name = '${name}'`)[0]?.status;

try {
  // ---- HR Leader --------------------------------------------------------------------------------------------------
  const l = await session('a_leader');
  let d = await openHoliday(l.page, 'วันของ HR Leader (uitest)');
  check('HR Leader, own holiday: no approve button, the maker note instead', !d.actions.some((a) => a.startsWith('อนุมัติ')) && d.text.includes('คุณเป็นผู้สร้างรายการนี้'), d.actions.join());
  await l.page.keyboard.press('Escape');
  d = await openHoliday(l.page, 'วันที่ผู้อื่นสร้าง (uitest)');
  check('HR Leader, holiday created by someone else: "อนุมัติ"', d.actions.includes('อนุมัติ'), d.actions.join());
  await l.page.click('.modal .modal-actions button:text-is("อนุมัติ")');
  await l.page.waitForFunction(() => !document.querySelector('.modal .modal-actions button.primary') || document.querySelector('.toast'));
  await l.page.waitForTimeout(500);
  check('HR Leader approved it (Draft → approved)', status('วันที่ผู้อื่นสร้าง (uitest)') === 'approved');
  // payroll page: approve without calculate
  await l.page.goto(BASE + '/payroll');
  await l.page.waitForSelector('main');
  await l.page.waitForFunction(() => !document.querySelector('main .loading'));
  const leaderButtons = await l.page.$$eval('main button', (b) => b.map((x) => x.textContent.trim()));
  check('HR Leader on the payroll page: no "สร้างงวด / คำนวณ"', !leaderButtons.some((t) => /คำนวณ|สร้างงวด/.test(t)), leaderButtons.join('|').slice(0, 160));
  await l.ctx.close();

  // ---- HR Payroll: creates and calculates a period; no approve button --------------------------------------------
  const p = await session('a_pay');
  const made = await p.page.evaluate(async (y) => {
    const call = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hr-requested': '1' }, body: JSON.stringify(body ?? {}) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const created = await call('/api/payroll/periods', { code: `UI-${y}-01`, name: 'uitest period', start_date: `${y}-01-01`, end_date: `${y}-01-31`, pay_date: `${y}-01-31` });
    const calc = await call(`/api/payroll/periods/${created.body.id}/calculate`);
    return { created: created.status, calc: calc.status, id: created.body.id };
  }, Y);
  check('HR Payroll created and calculated a period through the API', made.created === 201 && made.calc === 200, JSON.stringify(made));
  await p.page.goto(BASE + '/payroll');
  await p.page.waitForSelector(`main tr:has-text("UI-${Y}-01")`);
  const payRow = await p.page.$eval(`main tr:has-text("UI-${Y}-01")`, (r) => [...r.querySelectorAll('button')].map((b) => b.textContent.trim()));
  check('HR Payroll on the payroll page: no "อนุมัติ" for the calculated period', !payRow.includes('อนุมัติ'), payRow.join('|'));
  await p.ctx.close();

  // ---- Super Admin: own holiday ---------------------------------------------------------------------------------
  const s = await session('a_super');
  d = await openHoliday(s.page, 'วันของ Super Admin (uitest)');
  check('Super Admin, own holiday: "อนุมัติ (Super Admin)"', d.actions.includes('อนุมัติ (Super Admin)'), d.actions.join());
  await s.page.click('.modal button:has-text("อนุมัติ (Super Admin)")');
  const prompt = s.page.locator('.modal[aria-label="อนุมัติรายการที่คุณสร้างเอง (Super Admin)"]');
  await prompt.waitFor();
  await prompt.locator('textarea').fill('uitest ตรวจกับประกาศแล้ว ไม่มีผู้อนุมัติอื่น');
  await prompt.locator('button:has-text("อนุมัติ")').click();
  await s.page.waitForTimeout(800);
  check('the reported bug: the Super Admin\'s own holiday leaves Draft', status('วันของ Super Admin (uitest)') === 'approved');
  const a = sql("SELECT details FROM audit_logs WHERE action = 'holiday.approved' ORDER BY id DESC LIMIT 1")[0];
  check('audit: self-approval with the note', JSON.parse(a.details).self_approved === true && JSON.parse(a.details).note.includes('uitest'));
  // the Super Admin approves the period HR Payroll calculated (a normal approval: no note asked)
  await s.page.goto(BASE + '/payroll');
  await s.page.waitForSelector(`main tr:has-text("UI-${Y}-01") button:has-text("อนุมัติ")`);
  check('Super Admin sees "อนุมัติ" for a period calculated by HR Payroll', true);
  await s.ctx.close();
} finally {
  await browser.close();
  stopServer(dev);
}
check('no console errors / page errors / HTTP 5xx', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-approvals pass=${results.length - fail} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
