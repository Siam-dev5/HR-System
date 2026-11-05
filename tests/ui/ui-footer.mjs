// Browser tests: fixed site footer on every layout + EWF settings card. BASE = local wrangler dev (default) or argv[2].
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const SHOTS = outDir('footer-shots');
mkdirSync(SHOTS, { recursive: true });
const LINE = 'https://line.me/ti/p/~dj_nodoubt';
const FOOTER_TEXT = '© 2026 Siam HRBP Soft · HRM SYSTEM PRO (V1.0) | ติดต่อผู้พัฒนา LINE ID: dj_nodoubt';

let BASE = process.argv[2];
// an explicit BASE must be a local server: these suites create users and change data
if (BASE && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(BASE)) {
  console.error(`ui-footer: refusing non-local BASE ${BASE}`);
  process.exit(2);
}
let dev = null;
const pw = {};
if (!BASE) {
  const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const persist = join('.tmp', `footer-${Date.now()}`);
  run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
  run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
  for (const [u, role] of [['f_admin', 'super_admin'], ['f_mgr', 'hr_manager']]) {
    pw[u] = `Ft-${randomBytes(9).toString('base64url')}-5d`;
    const out = join(persist, `${u}.sql`);
    run(['scripts/create-user.mjs', '--username', u, '--role', role, '--out', out, '--cred-file', join(persist, 'c.txt')], { NEW_USER_PASSWORD: pw[u] });
    run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', out]);
  }
  const port = await freePort();
  dev = spawn(process.execPath, [W, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', `MFA_ENCRYPTION_KEY:${randomBytes(32).toString('base64')}`, '--show-interactive-dev-session=false'], SERVER_SPAWN);
  BASE = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }
}

function totp(secret) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = '';
  for (const c of secret.replace(/\s/g, '')) bits += A.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', key).update(msg).digest(); const o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const results = [];
const check = (name, ok, info = '') => { results.push({ ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };

/** Footer geometry + "nothing is hidden behind it" checks for the current page. */
async function footerAudit(page, label, actionSelector) {
  const g = await page.evaluate(() => {
    const f = document.getElementById('site-footer');
    const r = f.getBoundingClientRect();
    const cs = getComputedStyle(f);
    return {
      text: f.textContent.replace(/\s+/g, ' ').trim(), position: cs.position, z: cs.zIndex, display: cs.display, bottom: Math.round(r.bottom), top: r.top,
      vh: window.innerHeight, vw: window.innerWidth, hscroll: document.documentElement.scrollWidth > window.innerWidth, blur: cs.backdropFilter || cs.webkitBackdropFilter,
      bg: cs.backgroundColor, textFits: f.scrollWidth <= f.clientWidth, var: getComputedStyle(document.documentElement).getPropertyValue('--footer-h').trim(), height: Math.round(r.height),
    };
  });
  check(`${label}: footer fixed at bottom, centered flex, z-index 50`, g.position === 'fixed' && g.bottom === g.vh && g.display === 'flex' && g.z === '50', `bottom=${g.bottom}/${g.vh} h=${g.height}`);
  // Phase D (approved decision D2-B): the footer is solid navy (--footer-bg #1e3a5f, opaque, no glass blur)
  check(`${label}: exact footer text, solid navy (#1e3a5f, opaque)`, g.text === FOOTER_TEXT && g.bg === 'rgb(30, 58, 95)', `${g.text} bg=${g.bg}`);
  check(`${label}: no horizontal scroll, text fully visible`, !g.hscroll && g.textFits);
  check(`${label}: layout reserves the measured footer height`, Math.abs(parseFloat(g.var) - g.height) <= 1, `--footer-h=${g.var} h=${g.height}`);
  // scroll to the very bottom: the last content must end above the footer, and the footer must not move
  const end = await page.evaluate(async () => {
    window.scrollTo(0, document.documentElement.scrollHeight);
    await new Promise((r) => setTimeout(r, 150));
    const container = document.querySelector('main') || document.querySelector('.auth-main');
    const kids = [...container.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden');
    const lastBottom = Math.max(...kids.map((e) => e.getBoundingClientRect().bottom));
    const f = document.getElementById('site-footer').getBoundingClientRect();
    return { lastBottom: Math.round(lastBottom), footerTop: Math.round(f.top), footerBottom: Math.round(f.bottom), vh: window.innerHeight };
  });
  check(`${label}: content end stays above footer after full scroll`, end.lastBottom <= end.footerTop && end.footerBottom === end.vh, `last=${end.lastBottom} footerTop=${end.footerTop}`);
  if (actionSelector) {
    await page.locator(actionSelector).first().scrollIntoViewIfNeeded();
    const hit = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { covered: !(top === el || el.contains(top)), y: Math.round(r.bottom), footerTop: Math.round(document.getElementById('site-footer').getBoundingClientRect().top) };
    }, actionSelector);
    check(`${label}: action button "${actionSelector}" is clickable (not under footer)`, !hit.covered && hit.y <= hit.footerTop, `btnBottom=${hit.y} footerTop=${hit.footerTop}`);
  }
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });
try {
  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 375, height: 740 }]]) {
    const ctx = await browser.newContext({ viewport, isMobile: label === 'mobile', hasTouch: label === 'mobile' });
    await ctx.route('https://line.me/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<title>LINE</title>ok' }));
    const page = await ctx.newPage();
    await page.goto(BASE + '/');
    await page.waitForSelector('.auth-card');
    await footerAudit(page, `${label} login`, 'button.auth-submit');
    await page.screenshot({ path: join(SHOTS, `${label}-login.png`), fullPage: false });
    await page.goto(BASE + '/register');
    await page.waitForSelector('input[name=confirmPassword]');
    await footerAudit(page, `${label} register`, 'button.auth-submit');
    // sign in as Super Admin (MFA enrolment on first login in a fresh DB)
    await page.goto(BASE + '/');
    await page.fill('input[name=username]', 'f_admin');
    await page.fill('input[name=password]', pw.f_admin);
    await page.click('button.auth-submit');
    if (label === 'desktop') {
      await page.waitForSelector('text=เริ่มตั้งค่า MFA');
      await page.click('text=เริ่มตั้งค่า MFA');
      pw.secret = await page.textContent('code.secret');
      await page.fill('.mfa-setup input', totp(pw.secret));
      await page.click('text=ยืนยันและเปิดใช้');
    } else {
      await page.waitForSelector('input[name=totp]', { state: 'visible' });
      await page.fill('input[name=totp]', totp(pw.secret));
      await page.click('button.auth-submit');
    }
    await page.waitForSelector('nav.sidebar');
    for (const [path, action] of [['/dashboard', null], ['/employees', '.pager'], ['/audit', '.pager button'], ['/admin/settings', '.form-actions button'], ['/help', null], ['/payroll', null]]) {
      await page.goto(BASE + path);
      await page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .loading'));
      await page.waitForTimeout(250);
      await footerAudit(page, `${label} ${path}`, action);
    }
    await page.goto(BASE + '/admin/settings');
    await page.waitForSelector('#ewf-settings');
    await page.screenshot({ path: join(SHOTS, `${label}-settings-bottom.png`), fullPage: false });
    // modal sits above the footer and its buttons stay clickable
    await page.goto(BASE + '/departments');
    await page.waitForSelector('main .toolbar');
    await page.click('text=+ เพิ่ม');
    await page.waitForSelector('.modal');
    const modal = await page.evaluate(() => {
      const f = document.getElementById('site-footer').getBoundingClientRect();
      const over = document.elementFromPoint(f.left + f.width / 2, f.top + f.height / 2);
      const btn = document.querySelector('.modal-actions .btn.primary');
      btn.scrollIntoView({ block: 'end' });
      const r = btn.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { backdropOnTop: !!over?.closest('.backdrop'), btnClickable: top === btn || btn.contains(top) };
    });
    check(`${label}: modal backdrop covers footer and modal Save is clickable`, modal.backdropOnTop && modal.btnClickable);
    await page.keyboard.press('Escape');
    if (label === 'mobile') {
      await page.click('.menu-toggle');
      const nav = await page.evaluate(async () => {
        const s = document.querySelector('.sidebar');
        const list = s.querySelector('.sidebar-menu-scroll'); // only the menu list scrolls; the brand header stays
        list.scrollTop = list.scrollHeight;
        await new Promise((r) => setTimeout(r, 300));
        const items = [...s.querySelectorAll('.nav-item')];
        const last = items[items.length - 1].getBoundingClientRect();
        return { lastBottom: Math.round(last.bottom), footerTop: Math.round(document.getElementById('site-footer').getBoundingClientRect().top) };
      });
      check('mobile: last sidebar item reachable above footer', nav.lastBottom <= nav.footerTop, JSON.stringify(nav));
      await page.mouse.click(360, 300); // tap the scrim outside the menu
      check('mobile: tapping outside closes the menu', !(await page.evaluate(() => document.body.classList.contains('nav-open'))));
    }
    // LINE link
    const link = await page.$eval('#site-footer a', (a) => ({ href: a.href, target: a.target, rel: a.rel }));
    check(`${label}: LINE link attributes`, link.href === LINE && link.target === '_blank' && link.rel.includes('noopener') && link.rel.includes('noreferrer'));
    const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('#site-footer a')]);
    await popup.waitForLoadState().catch(() => {});
    check(`${label}: LINE link opens ${LINE} in a new tab`, popup.url() === LINE, popup.url());
    await popup.close();
    // print
    await page.goto(BASE + '/employees');
    await page.waitForSelector('main table');
    await page.emulateMedia({ media: 'print' });
    const print = await page.evaluate(() => ({ footer: getComputedStyle(document.getElementById('site-footer')).display, pad: getComputedStyle(document.querySelector('main')).paddingBottom }));
    check(`${label}: print layout hides footer (no-print) and drops the reserved space`, print.footer === 'none' && print.pad === '0px', JSON.stringify(print));
    if (label === 'desktop') {
      const pdf = await page.pdf({ format: 'A4' });
      check('print preview (PDF) renders', pdf.length > 1000, `${pdf.length} bytes`);
    }
    await page.emulateMedia({ media: 'screen' });
    await ctx.close();
  }

  // ---- EWF settings card (Super Admin) and access by another role -----------------------------
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/');
  await page.fill('input[name=username]', 'f_admin');
  await page.fill('input[name=password]', pw.f_admin);
  await page.click('button.auth-submit');
  await page.waitForSelector('input[name=totp]', { state: 'visible' });
  await page.fill('input[name=totp]', totp(pw.secret));
  await page.click('button.auth-submit');
  await page.waitForSelector('nav.sidebar');
  await page.goto(BASE + '/admin/settings');
  await page.waitForSelector('#ewf-settings');
  const card = await page.$eval('#ewf-settings', (c) => c.textContent);
  check('EWF card: title, EN name, scope notice', card.includes('กองทุนสงเคราะห์ลูกจ้าง') && card.includes('Employee Welfare Fund (EWF)') && card.includes('การคำนวณกองทุนสงเคราะห์ลูกจ้างต้องอ้างอิงค่าจ้างและเงื่อนไขตามกฎหมายที่มีผลบังคับใช้'));
  const fields = await page.$$eval('#ewf-settings [name^="payroll.ewf_"]', (x) => x.map((e) => e.getAttribute('name')).sort());
  check('EWF card: all 12 settings present', fields.length === 12, fields.join(','));
  const position = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('main section.card h2')].map((h) => h.textContent);
    return cards.indexOf('กองทุนสงเคราะห์ลูกจ้าง') === cards.indexOf('เงินเดือน & ประกันสังคม') + 1;
  });
  check('EWF card placed right after the payroll & social-security card', position);
  check('EWF starts disabled', await page.isChecked('#ewf-settings input[name="ewf-status"][value="false"]'));
  await page.click('#ewf-settings .segmented label:has-text("เปิดใช้งาน")');
  await page.click('.form-actions button');
  await page.waitForFunction(() => document.querySelector('.form-msg')?.textContent?.includes('วันที่มีผลบังคับใช้'));
  check('UI shows validation: enabling requires an effective date', true);
  await page.fill('[name="payroll.ewf_effective_date"]', '2026-11-01');
  await page.fill('[name="payroll.ewf_employee_rate"]', '0.25');
  await page.fill('[name="payroll.ewf_employer_rate"]', '0.25');
  await page.fill('[name="payroll.ewf_next_rate_date"]', '2027-10-01');
  await page.fill('[name="payroll.ewf_next_employee_rate"]', '0.5');
  await page.fill('[name="payroll.ewf_next_employer_rate"]', '0.5');
  await page.fill('[name="payroll.ewf_min_employee_count"]', '10');
  await page.click('.form-actions button');
  await page.waitForSelector('.toast');
  await page.reload();
  await page.waitForSelector('#ewf-settings');
  const saved = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#ewf-settings [name^="payroll.ewf_"]')].map((e) => [e.name, e.type === 'checkbox' ? e.checked : e.value])));
  check('EWF values saved and read back', saved['payroll.ewf_enabled'] === true && saved['payroll.ewf_effective_date'] === '2026-11-01' && saved['payroll.ewf_employee_rate'] === '0.25' && saved['payroll.ewf_next_rate_date'] === '2027-10-01' && saved['payroll.ewf_min_employee_count'] === '10', JSON.stringify(saved));
  await page.screenshot({ path: join(SHOTS, 'ewf-card.png'), fullPage: true });
  await ctx.close();

  const m = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  const mp = await m.newPage();
  await mp.goto(BASE + '/');
  await mp.fill('input[name=username]', 'f_mgr');
  await mp.fill('input[name=password]', pw.f_mgr);
  await mp.click('button.auth-submit');
  await mp.waitForSelector('nav.sidebar');
  check('Manager: no settings menu', !(await mp.$$eval('nav.sidebar .nav-item', (x) => x.map((e) => e.getAttribute('href')))).includes('/admin/settings'));
  await mp.goto(BASE + '/admin/settings');
  await mp.waitForSelector('main h2');
  check('Manager: direct /admin/settings → 403 page, no EWF form', ((await mp.textContent('main')) ?? '').includes('403') && !(await mp.$('#ewf-settings')));
  const api = await mp.evaluate(async () => (await fetch('/api/admin/settings', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-hr-requested': '1' }, body: JSON.stringify({ 'payroll.ewf_enabled': false }) })).status);
  check('Manager: direct API PUT → 403', api === 403);
  await m.close();
} catch (e) {
  check('unexpected exception', false, e.message.split('\n')[0]);
} finally {
  await browser.close();
  if (dev) stopServer(dev);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
