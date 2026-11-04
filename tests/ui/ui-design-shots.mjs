// Design-review screenshot harness (local only, demo seed data; not a test suite, no assertions): the working tree
// ("after") and, with --baseline <dir> (styles.css + app.js from tests/ui/make-baseline.mjs), the same pages rendered
// with the baseline ("before", served through page.route), light + dark, 1440 / 1024 / 768 / 375.
// Also records console errors and horizontal overflow per page in report.json.
// usage: node tests/ui/ui-design-shots.mjs [--baseline <dir>] [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('design-shots');
const BASELINE = arg('baseline');
const WITH_BEFORE = Boolean(BASELINE);
mkdirSync(OUT, { recursive: true });

const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const oldCss = WITH_BEFORE ? readFileSync(join(BASELINE, 'styles.css'), 'utf8') : null;
const oldJs = WITH_BEFORE ? readFileSync(join(BASELINE, 'app.js'), 'utf8') : null;
run(['scripts/build-web.mjs']);
const persist = join('.tmp', `shots-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const pw = `Ds-${randomBytes(9).toString('base64url')}-7c`;
const out = join(persist, 'u.sql');
run(['scripts/create-user.mjs', '--username', 'd_admin', '--display', 'ทดสอบ ผู้ดูแล', '--out', out, '--cred-file', join(persist, 'c.txt'), '--role', 'super_admin'], { NEW_USER_PASSWORD: pw });
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', out]);
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

const PAGES = [['dashboard', '/dashboard'], ['employees', '/employees'], ['payroll', '/payroll'], ['attendance-import', '/attendance/import'], ['users', '/admin/users'], ['settings', '/admin/settings'], ['audit', '/audit'], ['leave', '/leave']];
const VIEWPORTS = [['1440', 1440, 900], ['1024', 1024, 768], ['768', 768, 1024], ['375', 375, 740]];
const report = [];
const browser = await chromium.launch({ executablePath: EXE });
let secret = null;
try {
  for (const variant of WITH_BEFORE ? ['before', 'after'] : ['after']) {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: theme, locale: 'th-TH' });
      if (variant === 'before') {
        await ctx.route('**/assets/styles.css', (r) => r.fulfill({ status: 200, contentType: 'text/css', body: oldCss }));
        await ctx.route('**/assets/app.js', (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: oldJs }));
      }
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(BASE + '/');
      await page.waitForSelector('input[name=username]');
      await page.evaluate((t) => localStorage.setItem('hr.theme', t), theme);
      await page.reload();
      await page.waitForSelector('input[name=username]');
      await page.screenshot({ path: join(OUT, `${variant}-${theme}-1440-login.png`) });
      await page.fill('input[name=username]', 'd_admin');
      await page.fill('input[name=password]', pw);
      await page.click('button.auth-submit');
      await page.waitForSelector('nav.sidebar, button:has-text("เริ่มตั้งค่า MFA"), input[name=totp]:visible');
      if (await page.$('button:has-text("เริ่มตั้งค่า MFA")')) {
        await page.click('button:has-text("เริ่มตั้งค่า MFA")');
        secret = (await page.textContent('code.secret')).trim();
        await page.fill('.mfa-setup input', totp(secret));
        await page.click('text=ยืนยันและเปิดใช้');
      } else if (await page.$('input[name=totp]:visible')) {
        await page.fill('input[name=totp]', totp(secret));
        await page.click('button.auth-submit');
      }
      await page.waitForSelector('nav.sidebar');
      for (const [vp, w, h] of VIEWPORTS) {
        await page.setViewportSize({ width: w, height: h });
        for (const [name, path] of PAGES) {
          if (vp !== '1440' && !['dashboard', 'employees', 'payroll'].includes(name)) continue;
          await page.goto(BASE + path);
          await page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .loading'));
          await page.waitForTimeout(300);
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
          report.push({ variant, theme, vp, name, overflow });
          await page.screenshot({ path: join(OUT, `${variant}-${theme}-${vp}-${name}.png`) });
        }
      }
      // a dialog (new employee form) and the empty state
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(BASE + '/employees');
      await page.waitForFunction(() => document.querySelector('main .table, main .empty'));
      const add = await page.$('main .toolbar .btn.primary');
      if (add) { await add.click(); await page.waitForSelector('.modal'); await page.waitForTimeout(250); await page.screenshot({ path: join(OUT, `${variant}-${theme}-1440-dialog.png`) }); await page.keyboard.press('Escape'); }
      await page.goto(BASE + '/employees?q=zz-no-such-row');
      await page.waitForTimeout(400);
      const search = await page.$('main .toolbar input[type=search]');
      if (search) { await search.fill('zz-no-such-row-xyz'); await page.waitForTimeout(800); await page.screenshot({ path: join(OUT, `${variant}-${theme}-1440-empty.png`) }); }
      report.push({ variant, theme, errors });
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  stopServer(dev);
}
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
const over = report.filter((r) => r.overflow > 0);
console.log('screens:', report.filter((r) => 'overflow' in r).length, 'overflow:', over.length ? JSON.stringify(over) : 'none');
console.log('console errors:', JSON.stringify(report.filter((r) => r.errors).map((r) => [r.variant, r.theme, r.errors])));
