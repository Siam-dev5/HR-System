// Browser tests: UI language (ไทย / English / 中文). Language picker (search, close, flag cards) on the sign-in page and
// in the header, switching and persistence, menus / titles / buttons translated on every menu page, Thai restored,
// no console errors. Writes the Thai text still visible per language to <results>/i18n-shots/untranslated-<lang>.txt
// (data such as names stays Thai on purpose). BASE = local wrangler dev (fresh D1 with demo seed + a throwaway user).
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const SHOTS = outDir('i18n-shots');
mkdirSync(SHOTS, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const persist = join('.tmp', `i18n-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
const USER = 'i_admin';
const PW = `Ln-${randomBytes(9).toString('base64url')}-7c`;
{
  const out = join(persist, `${USER}.sql`);
  run(['scripts/create-user.mjs', '--username', USER, '--display', 'Lang Tester', '--out', out, '--cred-file', join(persist, 'c.txt'), '--role', 'super_admin'], { NEW_USER_PASSWORD: PW });
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
const THAI = /[฀-๿]/;

const browser = await chromium.launch({ executablePath: EXE });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(`console: ${m.text()}`); });
page.on('response', (r) => { if (r.status() >= 500) errs.push(`HTTP ${r.status()} ${r.url()}`); });
const settle = () => page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .loading')).then(() => page.waitForTimeout(250));

/** Visible Thai text outside data the user typed: text nodes and labelled attributes, excluding translate="no". */
const visibleThai = (root = 'body') => page.evaluate((sel) => {
  const out = new Set();
  const T = /[฀-๿]/;
  const skip = (el) => el.closest('[translate="no"], script, style, textarea, code, pre');
  const w = document.createTreeWalker(document.querySelector(sel), NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const v = n.data.replace(/\s+/g, ' ').trim();
    if (v && T.test(v) && n.parentElement && !skip(n.parentElement) && n.parentElement.getClientRects().length) out.add(v);
  }
  for (const el of document.querySelector(sel).querySelectorAll('[placeholder], [title], [aria-label]')) {
    if (skip(el)) continue;
    for (const a of ['placeholder', 'title', 'aria-label']) { const v = el.getAttribute(a); if (v && T.test(v)) out.add(`@${a}: ${v}`); }
  }
  return [...out];
}, root);

async function pickerAudit(where) {
  await page.click('.lang-btn');
  await page.waitForSelector('#lang-picker .lang-dialog');
  const p = await page.evaluate(() => ({
    search: !!document.querySelector('#lang-picker input.lang-search'),
    close: !!document.querySelector('#lang-picker button.lang-close'),
    cards: [...document.querySelectorAll('#lang-picker .lang-card')].map((c) => ({ lang: c.dataset.lang, name: c.querySelector('.lang-name')?.textContent, flag: !!c.querySelector('svg.flag'), pressed: c.getAttribute('aria-pressed') })),
  }));
  check(`${where}: picker has search, close and 3 flag cards (ไทย / English / 中文)`, p.search && p.close && p.cards.length === 3 && p.cards.map((c) => c.name).join('|') === 'ไทย|English|中文' && p.cards.every((c) => c.flag), JSON.stringify(p.cards));
  await page.fill('#lang-picker input.lang-search', 'chin');
  const shown = await page.$$eval('#lang-picker .lang-card:not([hidden])', (x) => x.map((c) => c.dataset.lang));
  check(`${where}: search "chin" leaves only 中文`, shown.join() === 'zh', shown.join());
  await page.fill('#lang-picker input.lang-search', 'zzzz');
  check(`${where}: no match shows the empty note`, await page.isVisible('#lang-picker .lang-empty'));
  await page.fill('#lang-picker input.lang-search', '');
  return p;
}
async function choose(lang) {
  await page.click('.lang-btn');
  await page.waitForSelector('#lang-picker .lang-dialog');
  await Promise.all([page.waitForEvent('load'), page.click(`#lang-picker .lang-card[data-lang="${lang}"]`)]);
}

try {
  // ---- sign-in page (Thai) + picker -------------------------------------------------------------------------------
  await page.goto(BASE + '/');
  await page.waitForSelector('input[name=username]');
  check('sign-in: default language is Thai (html lang=th, Thai title)', (await page.getAttribute('html', 'lang')) === 'th' && THAI.test(await page.textContent('.auth-title')));
  await pickerAudit('sign-in');
  await page.screenshot({ path: join(SHOTS, 'picker-signin-th.png') });
  await page.click('#lang-picker button.lang-close');
  check('sign-in: × closes the picker', (await page.$('#lang-picker')) === null);
  await page.click('.lang-btn');
  await page.keyboard.press('Escape');
  check('sign-in: Escape closes the picker', (await page.$('#lang-picker')) === null);

  // ---- sign-in page in English and Chinese --------------------------------------------------------------------------
  for (const [lang, word] of [['en', 'Sign in'], ['zh', '登录']]) {
    await choose(lang);
    await page.waitForSelector('input[name=username]');
    const title = await page.textContent('.auth-submit');
    const thai = await visibleThai();
    check(`sign-in ${lang}: html lang, submit button "${word}", no Thai text left`, (await page.getAttribute('html', 'lang')).startsWith(lang) && title.trim() === word && thai.length === 0, thai.slice(0, 5).join(' | '));
    await page.screenshot({ path: join(SHOTS, `signin-${lang}.png`) });
  }
  await choose('th');
  await page.waitForSelector('input[name=username]');
  check('sign-in: back to Thai restores the Thai text', (await page.textContent('.auth-submit')).trim() === 'เข้าสู่ระบบ');

  // ---- sign in (Thai: MFA setup), then the header picker ------------------------------------------------------------
  await page.fill('input[name=username]', USER);
  await page.fill('input[name=password]', PW);
  await page.click('button.auth-submit');
  await page.waitForSelector('nav.sidebar, button:has-text("เริ่มตั้งค่า MFA")');
  if (await page.$('button:has-text("เริ่มตั้งค่า MFA")')) {
    await page.click('button:has-text("เริ่มตั้งค่า MFA")');
    const secret = (await page.textContent('code.secret')).trim();
    await page.fill('.mfa-setup input', totp(secret));
    await page.click('text=ยืนยันและเปิดใช้');
  }
  await page.waitForSelector('nav.sidebar');
  await settle();
  await page.screenshot({ path: join(SHOTS, 'app-th.png') });
  await pickerAudit('header');
  await page.screenshot({ path: join(SHOTS, 'picker-header-th.png') });
  await page.keyboard.press('Escape');

  const menu = await page.$$eval('a.nav-item', (x) => x.map((a) => a.getAttribute('data-path')));
  check('signed in: the super admin sees the full menu', menu.length > 30, String(menu.length));

  for (const lang of ['en', 'zh']) {
    await choose(lang);
    await page.waitForSelector('nav.sidebar');
    await settle();
    const nav = await visibleThai('nav.sidebar');
    const head = await visibleThai('header.topbar');
    check(`${lang}: sidebar menu and header have no Thai text`, nav.length === 0 && head.length === 0, [...nav, ...head].slice(0, 8).join(' | '));
    check(`${lang}: language kept after reload`, (await page.reload(), await page.waitForSelector('nav.sidebar'), (await page.getAttribute('html', 'lang')).startsWith(lang)));
    await settle();
    await page.screenshot({ path: join(SHOTS, `app-${lang}.png`) });
    // every menu page: title translated; collect any Thai still visible (data excluded by review of the file)
    const left = new Map();
    let titlesThai = 0;
    for (const path of menu) {
      await page.goto(BASE + path);
      await page.waitForSelector('nav.sidebar');
      await settle().catch(() => {});
      await page.waitForTimeout(300);
      const t = (await page.textContent('#page-title')) ?? '';
      if (THAI.test(t)) titlesThai++;
      for (const s of await visibleThai('main')) left.set(s, (left.get(s) ?? '') + ' ' + path);
    }
    check(`${lang}: every page title is translated (${menu.length} pages)`, titlesThai === 0, String(titlesThai));
    writeFileSync(join(SHOTS, `untranslated-${lang}.txt`), [...left].map(([s, p]) => `${s}\t${p.trim()}`).join('\n'));
    console.log(`INFO  ${lang}: ${left.size} distinct Thai texts still visible in page content (names / data included) → untranslated-${lang}.txt`);
    for (const [path, name] of [['/payroll', 'payroll'], ['/employees', 'employees'], ['/attendance', 'attendance']]) {
      if (!menu.includes(path)) continue;
      await page.goto(BASE + path);
      await settle().catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(SHOTS, `${name}-${lang}.png`) });
    }
    await page.goto(BASE + menu[0]);
    await page.waitForSelector('nav.sidebar');
  }
  await choose('th');
  await page.waitForSelector('nav.sidebar');
  await settle();
  check('back to Thai: menu is Thai again', THAI.test(await page.textContent('nav.sidebar')) && (await page.getAttribute('html', 'lang')) === 'th');
  check('no console errors and no HTTP 5xx', errs.length === 0, errs.slice(0, 5).join(' | '));
} catch (e) {
  check('suite ran to the end', false, e instanceof Error ? e.stack : String(e));
} finally {
  await browser.close();
  stopServer(dev);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ' — FAILED: ' + failed.map((f) => f.name).join('; ') : ''}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
