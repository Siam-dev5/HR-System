// Browser tests: header menus (company / theme / user), RBAC, MFA, footer + mobile regressions.
// BASE = local wrangler dev (default; fresh D1 with demo seed + throwaway users).
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const SHOTS = outDir('header-shots');
mkdirSync(SHOTS, { recursive: true });
const FOOTER_TEXT = '© 2026 Siam HRBP Soft · HRM SYSTEM PRO (V1.0) | ติดต่อผู้พัฒนา LINE ID: dj_nodoubt';

const USERS = { h_admin: ['super_admin'], h_mgr: ['hr_manager', 'employee'], h_staff: ['hr_staff'], h_emp: ['employee'] };
const EMP = { h_mgr: 'E002', h_staff: 'E005', h_emp: 'E007' };
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const persist = join('.tmp', `header-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const pw = {};
for (const [u, roles] of Object.entries(USERS)) {
  pw[u] = `Hd-${randomBytes(9).toString('base64url')}-7c`;
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

function watch(page, label) {
  const errs = [];
  page.on('pageerror', (e) => errs.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(`${label} console: ${m.text()}`); });
  page.on('response', (r) => { if (r.status() >= 500) errs.push(`${label} HTTP ${r.status()} ${r.url()}`); });
  return errs;
}

async function login(page, user) {
  await page.goto(BASE + '/');
  await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', user);
  await page.fill('input[name=password]', pw[user]);
  await page.click('button.auth-submit');
  await page.waitForSelector('nav.sidebar, button:has-text("เริ่มตั้งค่า MFA"), input[name=totp]:visible');
  if (await page.$('text=เริ่มตั้งค่า MFA')) {
    await page.click('text=เริ่มตั้งค่า MFA');
    secrets[user] = (await page.textContent('code.secret')).trim();
    await page.fill('.mfa-setup input', totp(secrets[user]));
    await page.click('text=ยืนยันและเปิดใช้');
  } else if (await page.$('input[name=totp]:visible')) {
    await page.fill('input[name=totp]', totp(secrets[user]));
    await page.click('button.auth-submit');
  }
  await page.waitForSelector('nav.sidebar');
}
const settle = (page) => page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .loading')).then(() => page.waitForTimeout(200));

/** Geometry of an open dropdown: inside the viewport, above the footer, on top at its centre, no page h-scroll. */
async function panelAudit(page, id, label) {
  const g = await page.evaluate((pid) => {
    const p = document.getElementById(pid);
    const r = p.getBoundingClientRect();
    const f = document.getElementById('site-footer').getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 40));
    return { hidden: p.hidden, l: r.left, r: r.right, t: r.top, b: r.bottom, vw: window.innerWidth, footerTop: f.top, onTop: p.contains(top), hscroll: document.documentElement.scrollWidth > window.innerWidth };
  }, id);
  check(`${label}: #${id} open, within screen, above footer, not covered, no h-scroll`, !g.hidden && g.l >= 0 && g.r <= g.vw + 0.5 && g.b <= g.footerTop + 0.5 && g.onTop && !g.hscroll,
    `x=${Math.round(g.l)}..${Math.round(g.r)}/${g.vw} bottom=${Math.round(g.b)} footerTop=${Math.round(g.footerTop)}`);
}
const expanded = (page, sel) => page.getAttribute(sel, 'aria-expanded');
const anyOpen = (page) => page.$$eval('.dd-panel', (ps) => ps.filter((p) => !p.hidden).map((p) => p.id));

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const allErrors = [];
let zzb;
try {
  // seed a second company in the LOCAL test database (never production)
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    allErrors.push(...watch(page, 'setup'));
    await login(page, 'h_admin');
    zzb = await page.evaluate(async () => (await (await fetch('/api/m/companies', { method: 'POST', headers: { 'content-type': 'application/json', 'x-hr-requested': '1' }, body: JSON.stringify({ code: 'ZZB', name: 'บริษัท บี ทดสอบ จำกัด', active: true }) })).json()).id);
    check('setup: local test company created', zzb > 0);
    await ctx.close();
  }

  for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 375, height: 740 }]]) {
    const ctx = await browser.newContext({ viewport, isMobile: label === 'mobile', hasTouch: label === 'mobile', colorScheme: 'light' });
    const page = await ctx.newPage();
    const errs = watch(page, label);
    await login(page, 'h_admin');
    await page.goto(BASE + '/dashboard');
    await settle(page);
    const btns = await page.$$eval('.topbar-actions > *', (els) => els.map((e) => e.className));
    check(`${label}: header order = company, bell, theme, user`, JSON.stringify(btns) === JSON.stringify(['dd', 'icon-btn bell', 'dd', 'dd']), btns.join(' | '));
    check(`${label}: no page h-scroll with new header`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

    // ---- company switcher ----
    const cbtn = '.company-btn';
    check(`${label}: company button shows "ทุกบริษัท" by default`, (await page.getAttribute(cbtn, 'aria-label')) === 'บริษัท: ทุกบริษัท');
    if (label === 'mobile') check('mobile: company name text hidden, icon kept (fits 375px)', await page.$eval('.company-btn .hdr-label', (e) => getComputedStyle(e).display === 'none'));
    await page.click(cbtn);
    check(`${label}: company menu aria-expanded=true`, (await expanded(page, cbtn)) === 'true');
    await panelAudit(page, 'company-menu', `${label} company`);
    const items = await page.$$eval('#company-menu [role=menuitemradio]', (x) => x.map((e) => ({ t: e.querySelector('.dd-text span').textContent, c: e.getAttribute('aria-checked') })));
    check(`${label}: lists real companies (all + DEMO + ZZB), current checked`, items.map((i) => i.t).join('|') === 'ทุกบริษัท|บริษัท เดโม่ เอชอาร์ จำกัด|บริษัท บี ทดสอบ จำกัด' && items[0].c === 'true', JSON.stringify(items));
    check(`${label}: focus moves to the checked item`, await page.evaluate(() => document.activeElement?.getAttribute('aria-checked') === 'true'));
    await page.screenshot({ path: join(SHOTS, `${label}-company.png`) });
    const dashReq = page.waitForRequest((r) => r.url().includes('/api/dashboard?company='));
    await page.click('#company-menu >> text=บริษัท บี ทดสอบ จำกัด');
    const req = await dashReq;
    await settle(page);
    check(`${label}: selecting a company reloads dashboard with ?company=<id>`, req.url().endsWith(`company=${zzb}`), req.url());
    check(`${label}: button now shows the selected company`, (await page.getAttribute(cbtn, 'aria-label')) === 'บริษัท: บริษัท บี ทดสอบ จำกัด');
    check(`${label}: dashboard scope line + headcount 0 for company without employees`, (await page.textContent('.scope-line')).includes('บริษัท บี ทดสอบ จำกัด') && (await page.textContent('.kpis')).includes('พนักงานปัจจุบัน0'));
    check(`${label}: organisation-wide KPI is labelled "ทุกบริษัท"`, (await page.textContent('.kpis')).includes('ทุกบริษัท'));
    check(`${label}: menu closed after choosing`, (await anyOpen(page)).length === 0);
    await page.reload();
    await settle(page);
    check(`${label}: active company persists after refresh`, (await page.getAttribute(cbtn, 'aria-label')) === 'บริษัท: บริษัท บี ทดสอบ จำกัด');
    // tamper: a company id outside the scope in storage falls back safely
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('hr.company.')) localStorage.setItem(k, '999999'); });
    await page.reload();
    await settle(page);
    check(`${label}: invalid stored company falls back to "ทุกบริษัท"`, (await page.getAttribute(cbtn, 'aria-label')) === 'บริษัท: ทุกบริษัท');

    // ---- single-open, outside click, Escape ----
    await page.click(cbtn);
    await page.click('[aria-controls=theme-menu]');
    check(`${label}: opening theme closes company (one menu at a time)`, JSON.stringify(await anyOpen(page)) === '["theme-menu"]');
    await page.mouse.click(Math.round(viewport.width / 2), viewport.height - 140);
    check(`${label}: outside click closes`, (await anyOpen(page)).length === 0 && (await expanded(page, '[aria-controls=theme-menu]')) === 'false');
    await page.click('[aria-controls=user-menu]');
    await page.keyboard.press('Escape');
    check(`${label}: Escape closes and returns focus to the button`, (await anyOpen(page)).length === 0 && (await page.evaluate(() => document.activeElement?.getAttribute('aria-controls'))) === 'user-menu');
    await page.click('.bell');
    await page.waitForSelector('#notif-panel');
    await page.click(cbtn);
    check(`${label}: opening a menu closes the notification panel`, !(await page.$('#notif-panel')) && JSON.stringify(await anyOpen(page)) === '["company-menu"]');
    await page.keyboard.press('Escape');

    // ---- theme ----
    await page.focus('[aria-controls=theme-menu]');
    await page.keyboard.press('ArrowDown');
    check(`${label}: ArrowDown opens theme menu with the active option focused (อัตโนมัติ)`, await page.evaluate(() => document.activeElement?.textContent.includes('อัตโนมัติ') && document.activeElement.getAttribute('aria-checked') === 'true'));
    await panelAudit(page, 'theme-menu', `${label} theme`);
    const themeItems = await page.$$eval('#theme-menu [role=menuitemradio] .dd-text > span', (x) => x.map((e) => e.textContent));
    check(`${label}: theme options สว่าง / มืด / อัตโนมัติ`, themeItems.join('|') === 'สว่าง|มืด|อัตโนมัติ');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    const dark = await page.evaluate(() => ({ t: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, saved: localStorage.getItem('hr.theme') }));
    check(`${label}: keyboard select "มืด" applies immediately and is saved`, dark.t === 'dark' && dark.bg === 'rgb(11, 17, 32)' && dark.saved === 'dark', JSON.stringify(dark));
    await page.screenshot({ path: join(SHOTS, `${label}-dark-dashboard.png`) });
    await page.reload();
    await settle(page);
    check(`${label}: dark theme kept after refresh`, (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark');
    // dark-mode regressions: tables, forms, modal, footer, print
    await page.goto(BASE + '/employees');
    await settle(page);
    const tbl = await page.evaluate(() => { const th = document.querySelector('.table th'); const td = document.querySelector('.table td'); return { th: getComputedStyle(th).color, thBg: getComputedStyle(th).backgroundColor, td: getComputedStyle(td).color }; });
    check(`${label}: dark table text readable (light text on dark)`, tbl.td === 'rgb(229, 231, 235)' && tbl.thBg === 'rgb(15, 23, 42)', JSON.stringify(tbl));
    await page.click('main .toolbar .btn.primary');
    await page.waitForSelector('.modal');
    const modal = await page.evaluate(() => { const m = document.querySelector('.modal'); const i = m.querySelector('input'); const f = document.getElementById('site-footer'); return { bg: getComputedStyle(m).backgroundColor, input: getComputedStyle(i).backgroundColor, color: getComputedStyle(i).color, z: Number(getComputedStyle(m.closest('.backdrop')).zIndex), fz: Number(getComputedStyle(f).zIndex) }; });
    check(`${label}: dark modal + form inputs themed, modal above footer`, modal.bg === 'rgb(17, 24, 39)' && modal.color === 'rgb(229, 231, 235)' && modal.z > modal.fz, JSON.stringify(modal));
    await page.keyboard.press('Escape');
    await page.click('.modal-head button').catch(() => {});
    const foot = await page.evaluate(() => { const f = document.getElementById('site-footer'); const cs = getComputedStyle(f); return { text: f.textContent.replace(/\s+/g, ' ').trim(), pos: cs.position, z: cs.zIndex, bottom: Math.round(f.getBoundingClientRect().bottom), vh: innerHeight, href: f.querySelector('a').href, bg: cs.backgroundColor }; });
    // Phase D (approved decision D2-B): solid footer, dark theme = --footer-bg #020617 (was: glass blur)
    check(`${label}: footer intact in dark theme (text, fixed, z 50, LINE link, solid #020617)`, foot.text === FOOTER_TEXT && foot.pos === 'fixed' && foot.z === '50' && foot.bottom === foot.vh && foot.href === 'https://line.me/ti/p/~dj_nodoubt' && foot.bg === 'rgb(2, 6, 23)', `${foot.text} bg=${foot.bg}`);
    await page.emulateMedia({ media: 'print' });
    const pr = await page.evaluate(() => ({ bg: getComputedStyle(document.body).backgroundColor, text: getComputedStyle(document.body).color, footer: getComputedStyle(document.getElementById('site-footer')).display, topbar: getComputedStyle(document.querySelector('.topbar')).display, cell: getComputedStyle(document.querySelector('.table td')).color }));
    check(`${label}: print in dark theme = light paper, no footer, no header`, pr.bg === 'rgb(255, 255, 255)' && pr.footer === 'none' && pr.topbar === 'none' && ['rgb(0, 0, 0)', 'rgb(15, 23, 42)'].includes(pr.cell), JSON.stringify(pr));
    await page.emulateMedia({ media: 'screen' });
    // auto follows the system and reacts live
    await page.click('[aria-controls=theme-menu]');
    await page.click('#theme-menu >> text=อัตโนมัติ');
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForTimeout(150);
    const autoDark = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForTimeout(150);
    const autoLight = await page.evaluate(() => document.documentElement.dataset.theme);
    check(`${label}: อัตโนมัติ follows prefers-color-scheme live (dark → light)`, autoDark === 'dark' && autoLight === 'light' && (await page.evaluate(() => localStorage.getItem('hr.theme'))) === null);
    await page.click('[aria-controls=theme-menu]');
    await page.click('#theme-menu >> text=สว่าง');
    check(`${label}: สว่าง selected`, (await page.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem('hr.theme')].join())) === 'light,light');

    // ---- user menu ----
    await page.click('[aria-controls=user-menu]');
    await panelAudit(page, 'user-menu', `${label} user`);
    const um = await page.evaluate(() => {
      const m = document.getElementById('user-menu');
      return { who: m.querySelector('.dd-who strong').textContent, sub: m.querySelector('.dd-who small').textContent, roles: [...m.querySelectorAll('.role-badge')].map((e) => e.textContent), scope: m.querySelector('.scope-badge').textContent, items: [...m.querySelectorAll('[role=menuitem] .dd-text > span')].map((e) => e.textContent) };
    });
    check(`${label}: user menu shows name, account, Role badge, scope`, um.who === 'ทดสอบ h_admin' && um.sub === '@h_admin' && JSON.stringify(um.roles) === '["Role: Super Admin"]' && um.scope.includes('เข้าถึงได้ทุกบริษัท (2)'), JSON.stringify(um));
    check(`${label}: user menu items`, JSON.stringify(um.items) === JSON.stringify(['โปรไฟล์ของฉัน', 'ความปลอดภัย & MFA', 'คู่มือการใช้งาน', 'ออกจากระบบ']), um.items.join(' | '));
    await page.screenshot({ path: join(SHOTS, `${label}-user-menu.png`) });
    await page.click('#user-menu >> text=ความปลอดภัย & MFA');
    await settle(page);
    check(`${label}: security link navigates, menu closes`, new URL(page.url()).pathname === '/security' && (await anyOpen(page)).length === 0);
    await page.click('[aria-controls=user-menu]');
    await page.click('#user-menu >> text=โปรไฟล์ของฉัน');
    await settle(page);
    check(`${label}: profile link opens ESS`, new URL(page.url()).pathname === '/ess');

    // ---- mobile nav interplay + h-scroll on key pages ----
    if (label === 'mobile') {
      await page.click('[aria-controls=company-menu]');
      await page.click('.menu-toggle');
      check('mobile: opening the nav menu closes header menus', (await anyOpen(page)).length === 0 && (await page.evaluate(() => document.body.classList.contains('nav-open'))));
      await page.mouse.click(360, 300);
      check('mobile: tap outside closes nav menu', !(await page.evaluate(() => document.body.classList.contains('nav-open'))));
    }
    for (const path of ['/dashboard', '/employees', '/payroll', '/payroll/payslips', '/my/payslips', '/ess', '/admin/settings', '/admin/users', '/admin/roles', '/security']) {
      await page.goto(BASE + path);
      await settle(page);
      const r = await page.evaluate(() => ({ h: document.documentElement.scrollWidth <= innerWidth, title: document.getElementById('page-title').textContent, f: getComputedStyle(document.getElementById('site-footer')).position }));
      check(`${label} ${path}: renders, no h-scroll, footer fixed`, r.h && r.title && !r.title.includes('403') && r.f === 'fixed', r.title);
    }
    await page.goto(BASE + '/admin/settings');
    await page.waitForSelector('#ewf-settings');
    check(`${label}: EWF card still present on settings`, (await page.$$('#ewf-settings input')).length >= 12);

    // ---- logout via user menu, MFA on re-login ----
    await page.click('[aria-controls=user-menu]');
    await page.click('#user-menu >> text=ออกจากระบบ');
    await page.waitForSelector('.auth-card input[name=username]');
    check(`${label}: logout from user menu returns to login`, true);
    check(`${label}: session gone after logout (API 401)`, (await page.evaluate(async () => (await fetch('/api/meta')).status)) === 401);
    await login(page, 'h_admin');
    check(`${label}: re-login with MFA (TOTP) works`, !!(await page.$('nav.sidebar')));
    allErrors.push(...errs);
    await ctx.close();
  }

  // ---- other roles: scope, menus, RBAC on URL + API ----
  for (const [user, expectScope, badge] of [['h_mgr', 'all', ['Role: Manager (หัวหน้างาน / ผู้อนุมัติ)', 'Role: พนักงาน']], ['h_staff', 'all', null], ['h_emp', 'own', ['Role: พนักงาน']]]) {
    for (const [label, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 375, height: 740 }]]) {
      const ctx = await browser.newContext({ viewport, isMobile: label === 'mobile', hasTouch: label === 'mobile' });
      const page = await ctx.newPage();
      const errs = watch(page, `${user}-${label}`);
      await login(page, user);
      await settle(page);
      await page.click('[aria-controls=company-menu]');
      await panelAudit(page, 'company-menu', `${user} ${label} company`);
      const names = await page.$$eval('#company-menu [role=menuitemradio]', (x) => x.map((e) => `${e.getAttribute('aria-checked')}:${e.querySelector('.dd-text span').textContent}`));
      if (expectScope === 'own') check(`${user} ${label}: only own company, checked, with note`, JSON.stringify(names) === '["true:บริษัท เดโม่ เอชอาร์ จำกัด"]' && (await page.textContent('#company-menu')).includes('เฉพาะบริษัทต้นสังกัด'), names.join());
      else check(`${user} ${label}: organisation-wide role sees all active companies`, names.length === 3 && names[0] === 'true:ทุกบริษัท', names.join());
      await page.keyboard.press('Escape');
      await page.click('[aria-controls=user-menu]');
      const roles = await page.$$eval('#user-menu .role-badge', (x) => x.map((e) => e.textContent));
      if (badge) check(`${user} ${label}: role badges from real roles`, JSON.stringify(roles) === JSON.stringify(badge), roles.join());
      else check(`${user} ${label}: role badge present`, roles.length === 1 && roles[0].startsWith('Role: '), roles.join());
      const menuText = await page.textContent('#user-menu');
      check(`${user} ${label}: no admin entries in user menu`, !/ผู้ใช้ระบบ|บทบาท & สิทธิ์|ตั้งค่าระบบ/.test(menuText));
      await page.keyboard.press('Escape');
      const nav = await page.$$eval('nav.sidebar .nav-item', (x) => x.map((e) => e.textContent));
      check(`${user} ${label}: sidebar hides ผู้ใช้ระบบ / บทบาท & สิทธิ์ / ตั้งค่าระบบ`, !nav.some((t) => ['ผู้ใช้ระบบ', 'บทบาท & สิทธิ์', 'ตั้งค่าระบบ'].includes(t)));
      for (const path of ['/admin/users', '/admin/roles', '/admin/settings']) {
        await page.goto(BASE + path);
        await settle(page);
        check(`${user} ${label}: URL ${path} → 403 page`, (await page.textContent('main')).includes('403'));
      }
      const api = await page.evaluate(async (id) => {
        const h = { 'content-type': 'application/json', 'x-hr-requested': '1' };
        return {
          users: (await fetch('/api/admin/users')).status,
          roles: (await fetch('/api/admin/roles')).status,
          settings: (await fetch('/api/admin/settings')).status,
          putSettings: (await fetch('/api/admin/settings', { method: 'PUT', headers: h, body: '{"payroll.ewf_enabled":false}' })).status,
          newRole: (await fetch('/api/admin/roles', { method: 'POST', headers: h, body: '{"code":"zz_x","name":"x","permissions":["*"]}' })).status,
          dashOther: (await fetch(`/api/dashboard?company=${id}`)).status,
          dashBad: (await fetch('/api/dashboard?company=999999')).status,
        };
      }, zzb);
      check(`${user} ${label}: admin APIs 403 (users/roles/settings GET+PUT, create role)`, api.users === 403 && api.roles === 403 && api.settings === 403 && api.putSettings === 403 && api.newRole === 403, JSON.stringify(api));
      if (expectScope === 'own') check(`${user} ${label}: dashboard of another company → 403`, [403].includes(api.dashOther) && api.dashBad === 403, JSON.stringify(api));
      else check(`${user} ${label}: unknown company → 403`, api.dashBad === 403, JSON.stringify(api));
      for (const path of ['/dashboard', '/ess', '/my/payslips']) {
        await page.goto(BASE + path);
        await settle(page);
        check(`${user} ${label} ${path}: no h-scroll`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      await page.click('[aria-controls=user-menu]');
      await page.click('#user-menu >> text=ออกจากระบบ');
      await page.waitForSelector('.auth-card');
      allErrors.push(...errs);
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
