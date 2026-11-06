// Probation job run log (System Settings, Super Admin only): last / next run, processed / notification / activation /
// error and retry counts, Dry Run (writes nothing), Manual Run after a confirmation, the run table; hidden from HR Admin;
// light / dark, 1440 / 375 without overflow. Fresh local D1 with demo seed, synthetic users and synthetic employees
// (company ZZJ) only.
// usage: node tests/ui/ui-jobs.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('jobs');
mkdirSync(OUT, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// the server counts days in Asia/Bangkok: ZJ120 is on day 120 and ZJ090 on day 90 of that date
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `jobs-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
mkdirSync(persist, { recursive: true });
const seed = join(persist, 'zzj.sql');
const emp = (code, day) => `('${code}', 'zz_ui', '${code}', (SELECT id FROM companies WHERE code = 'ZZJ'), '${addDays(today, -(day - 1))}', 'probation', 'probation')`;
writeFileSync(join(ROOT, seed), [
  "INSERT INTO companies (code, name, active) VALUES ('ZZJ', 'zz_test งานอัตโนมัติ', 1);",
  `INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status) VALUES ${[emp('ZJ090', 90), emp('ZJ120', 120)].join(', ')};`,
].join('\n'));
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', seed]);
const USERS = { j_admin: ['super_admin'], j_hra: ['hr_admin'] };
const pw = {};
for (const [u, roles] of Object.entries(USERS)) {
  pw[u] = `Jb-${randomBytes(9).toString('base64url')}-7c`;
  const f = join(persist, `${u}.sql`);
  const args = ['scripts/create-user.mjs', '--username', u, '--display', `ทดสอบ ${u}`, '--out', f, '--cred-file', join(persist, 'c.txt')];
  for (const r of roles) args.push('--role', r);
  run(args, { NEW_USER_PASSWORD: pw[u] });
  run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', f]);
}
const sql = (q) => JSON.parse(run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--command', q, '--json']))[0].results;
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
const card = '#probation-job';
const openCard = async (page) => {
  await page.goto(BASE + '/admin/settings');
  await page.waitForSelector(`${card} .kpis`);
};
const kpis = (page) => page.$$eval(`${card} .kpi`, (els) => Object.fromEntries(els.map((e) => [e.querySelector('.kpi-label').textContent, e.querySelector('.kpi-value').textContent.trim()])));
const counts = () => sql("SELECT (SELECT COUNT(*) FROM job_runs) AS runs, (SELECT COUNT(*) FROM probation_events) AS events, (SELECT COUNT(*) FROM notifications) AS notices, (SELECT status FROM employees WHERE emp_code = 'ZJ120') AS zj120")[0];

try {
  const { ctx, page } = await session('j_admin');
  await openCard(page);
  let k = await kpis(page);
  check('card: title and schedule (00:05 and 08:05 Thai time)', (await page.textContent(card)).includes('งานอัตโนมัติ: ทดลองงาน') && (await page.textContent(card)).includes('00:05 และ 08:05'));
  check('card: automatic change on by default, recipients HR + Super Admin', (await page.textContent(card)).includes('เปลี่ยนสถานะอัตโนมัติวันที่ 120: เปิด') && (await page.textContent(card)).includes('Super Admin'));
  check('KPIs: last run "-" before any run, next run shown, counts 0', k['ทำงานล่าสุด'] === '-' && /\d/.test(k['รอบถัดไป']) && k['พนักงานที่ประมวลผล'] === '0' && k['ผิดพลาด / ลองซ้ำ'] === '0 / 0', JSON.stringify(k));
  check('empty run log message', (await page.textContent(card)).includes('ยังไม่มีประวัติการทำงาน'));
  check('Dry Run and Manual Run buttons', (await page.locator(`${card} button:has-text("ทดลองรัน (Dry Run)")`).count()) === 1 && (await page.locator(`${card} button:has-text("รันทันที")`).count()) === 1);

  // ---- dry run: lists the actions, writes nothing -------------------------------------------------------------
  const before = counts();
  await page.click(`${card} button:has-text("ทดลองรัน (Dry Run)")`);
  await page.waitForSelector(`${card} .job-preview .alert`);
  const preview = await page.textContent(`${card} .job-preview`);
  check('dry run: ZJ090 day-90 notice and ZJ120 status change listed', preview.includes('ZJ090') && preview.includes('แจ้งครบ 90 วัน') && preview.includes('ZJ120') && preview.includes('เปลี่ยนเป็นปฏิบัติงาน') && preview.includes('จะทำ'), preview.slice(0, 200));
  check('dry run: says nothing is saved', preview.includes('ยังไม่บันทึกหรือแจ้งเตือนใด ๆ'));
  check('dry run: nothing written (runs, events, notices, status)', JSON.stringify(counts()) === JSON.stringify(before), JSON.stringify(counts()));
  await page.screenshot({ path: join(OUT, 'dry-run-1440-light.png'), fullPage: true });

  // ---- manual run: confirmation first -------------------------------------------------------------------------
  await page.click(`${card} button:has-text("รันทันที")`);
  await page.waitForSelector('.modal');
  check('manual run asks for confirmation', (await page.textContent('.modal')).includes('รันงานทดลองงานทันที'));
  await page.click('.modal button:has-text("ยกเลิก")');
  await page.waitForTimeout(300);
  check('cancelled: nothing written', JSON.stringify(counts()) === JSON.stringify(before));
  await page.click(`${card} button:has-text("รันทันที")`);
  await page.waitForSelector('.modal');
  await page.click('.modal button:has-text("รันทันที")');
  await page.waitForSelector(`${card} tbody tr`);
  const after = counts();
  check('manual run: one run logged, ZJ120 active', after.runs === 1 && after.zj120 === 'active', JSON.stringify(after));
  k = await kpis(page);
  check('KPIs after the run: last run with "สำเร็จ", processed ≥ 2, notifications > 0, activated ≥ 1, 0 / 0 errors', k['ทำงานล่าสุด'].includes('สำเร็จ') && Number(k['พนักงานที่ประมวลผล']) >= 2 && Number(k['แจ้งเตือนที่ส่ง']) > 0 && Number(k['เปลี่ยนสถานะอัตโนมัติ']) >= 1 && k['ผิดพลาด / ลองซ้ำ'] === '0 / 0', JSON.stringify(k));
  const row = await page.$$eval(`${card} tbody tr`, (rs) => rs.map((r) => [...r.cells].map((c) => c.textContent.trim())));
  check('run table: trigger "สั่งรันเอง", status "สำเร็จ", details "-"', row.length === 1 && row[0][1] === 'สั่งรันเอง' && row[0][2] === 'สำเร็จ' && row[0][10] === '-', JSON.stringify(row));
  await page.screenshot({ path: join(OUT, 'run-log-1440-light.png'), fullPage: true });

  // ---- a partial run shows its failed steps -------------------------------------------------------------------
  sql(`INSERT INTO job_runs (job, run_date, trigger, status, finished_at, summary, error) VALUES ('probation', '${today}', 'scheduled', 'partial', datetime('now'), '{"processed":2,"notifications":0,"activated":0,"retries":2,"failed":1}', '[{"employeeId":99,"kind":"activate","attempts":3,"error":"zz_test injected failure"}]')`);
  await openCard(page);
  k = await kpis(page);
  check('partial run: last run "สำเร็จบางส่วน", errors / retries 1 / 2', k['ทำงานล่าสุด'].includes('สำเร็จบางส่วน') && k['ผิดพลาด / ลองซ้ำ'] === '1 / 2', JSON.stringify(k));
  const details = await page.textContent(`${card} tbody tr:first-child td:last-child`);
  check('partial run: failed step with employee, action and attempts', details.includes('พนักงาน #99') && details.includes('เปลี่ยนเป็นปฏิบัติงาน') && details.includes('ลอง 3 ครั้ง') && details.includes('zz_test injected failure'), details);
  check('partial run row: trigger "ตามเวลา (Cron)"', (await page.textContent(`${card} tbody tr:first-child`)).includes('ตามเวลา (Cron)'));
  await ctx.close();

  // ---- HR Admin: no settings page, API refused ------------------------------------------------------------------
  {
    const s = await session('j_hra');
    await s.page.goto(BASE + '/admin/settings');
    await s.page.waitForTimeout(800);
    check('HR Admin: no run-log card', (await s.page.locator(card).count()) === 0);
    const st = await s.page.evaluate(async () => (await fetch('/api/admin/jobs/probation/run', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hr-requested': '1' }, body: '{"dryRun":true}' })).status);
    check('HR Admin: run API refused (403)', st === 403, String(st));
    await s.ctx.close();
  }

  // ---- sizes and themes ----------------------------------------------------------------------------------------
  for (const [vp, theme] of [[{ width: 1440, height: 900 }, 'dark'], [{ width: 375, height: 740 }, 'light'], [{ width: 375, height: 740 }, 'dark']]) {
    const v = await session('j_admin', vp, theme);
    await openCard(v.page);
    const o = await v.page.evaluate((sel) => {
      const c = document.querySelector(sel).getBoundingClientRect();
      const btns = [...document.querySelectorAll(`${sel} .toolbar button`)].map((b) => b.getBoundingClientRect());
      return { overflow: document.documentElement.scrollWidth - innerWidth, inside: btns.every((r) => r.left >= c.left - 1 && r.right <= c.right + 1) };
    }, card);
    check(`${vp.width} ${theme}: card and buttons fit, no page overflow`, o.overflow <= 0 && o.inside, JSON.stringify(o));
    await v.page.locator(card).screenshot({ path: join(OUT, `card-${vp.width}-${theme}.png`) });
    await v.ctx.close();
  }
} finally {
  await browser.close();
  stopServer(dev);
}
check('no console errors / page errors / HTTP 5xx', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-jobs pass=${results.length - fail} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
