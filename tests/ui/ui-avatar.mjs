// Employee photo in the employee form (local only; fresh local D1 + simulated R2; synthetic users; image fixtures from
// tests/fixtures/avatar): initials fallback, pick → preview → upload with progress → replace → remove with confirmation,
// client-side rejection of unsupported / unreadable files, controls hidden from users who may not change the photo,
// the org chart picking up the new photo, light / dark and 1440 / 768 / 375.
// usage: node tests/ui/ui-avatar.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('avatar');
mkdirSync(OUT, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const FIX = (f) => join(ROOT, 'tests', 'fixtures', 'avatar', f);

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `avatar-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
// non-privileged roles (no MFA): HR staff manages photos; an employee and a manager may only view
const USERS = { a_staff: ['hr_staff', null], a_emp: ['employee', 'E007'], a_mgr: ['hr_manager', 'E002'] };
const pw = {};
for (const [u, [role, empCode]] of Object.entries(USERS)) {
  pw[u] = `Av-${randomBytes(9).toString('base64url')}-7q`;
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
const openEmployee = async (page, code) => {
  await page.goto(BASE + `/employees?q=${code}`);
  await page.waitForSelector(`main tr:has-text("${code}")`);
  await page.click(`main tr:has-text("${code}")`);
  await page.waitForSelector('.modal .avatar-panel');
  await page.waitForFunction(() => !document.querySelector('.modal .avatar-status')?.textContent?.includes('กำลังโหลด'));
};
const panel = (page) => page.evaluate(() => {
  const p = document.querySelector('.modal .avatar-panel');
  const av = p.querySelector('.emp-avatar');
  const img = av.querySelector('img');
  return { mode: av.dataset.avatar, initials: av.querySelector('.emp-avatar-initials')?.textContent ?? null, src: img?.getAttribute('src') ?? null, loaded: img ? img.complete && img.naturalWidth > 0 : false,
    status: p.querySelector('.avatar-status').textContent, buttons: [...p.querySelectorAll('.avatar-actions button')].map((b) => b.textContent), msg: p.querySelector('.form-msg').textContent,
    focused: document.activeElement?.tagName + (document.activeElement?.getAttribute('type') ? `[${document.activeElement.getAttribute('type')}]` : '') };
});
const choose = async (page, files) => {
  const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('.modal .avatar-actions button:has-text("รูป…")')]);
  await fc.setFiles(files);
  await page.waitForFunction(() => { const p = document.querySelector('.modal .avatar-panel'); return p.querySelector('[data-avatar="preview"]') || p.querySelector('.form-msg').textContent; });
};
const api = (page, path) => page.evaluate(async (p) => (await fetch(p)).json(), path);

try {
  const { ctx, page } = await session('a_staff');
  const e007 = (await api(page, '/api/m/employees?q=E007')).rows[0].id;
  await openEmployee(page, 'E007');
  let p = await panel(page);
  check('form: photo panel shows initials when there is no photo', p.mode === 'initials' && p.initials === 'ธท' && p.status.includes('ยังไม่มีรูป') && p.buttons.join() === 'เลือกรูป…', JSON.stringify(p));
  check('form: the dialog still focuses the first form field (no hidden file input steals focus)', p.focused === 'INPUT[text]', p.focused);

  await choose(page, FIX('sample.png'));
  p = await panel(page);
  check('pick → preview before upload (data: URL, nothing stored yet)', p.mode === 'preview' && p.src?.startsWith('data:image/') && p.status.includes('ยังไม่บันทึก') && p.buttons.join() === 'บันทึกรูป,ยกเลิก');
  check('nothing was uploaded by picking', (await api(page, `/api/employees/${e007}/avatar/meta`)).avatar === null);
  await page.click('.modal .avatar-actions button:has-text("ยกเลิก")');
  check('cancel restores the initials', (await panel(page)).mode === 'initials');

  await choose(page, FIX('sample.png'));
  const progressSeen = page.evaluate(() => new Promise((res) => {
    const pr = document.querySelector('.modal .avatar-progress');
    const mo = new MutationObserver(() => { if (!pr.hidden) { mo.disconnect(); res(true); } });
    mo.observe(pr, { attributes: true });
    setTimeout(() => res(false), 8000);
  }));
  const [put] = await Promise.all([page.waitForResponse((r) => r.url().endsWith(`/api/employees/${e007}/avatar`) && r.request().method() === 'PUT'), page.click('.modal .avatar-save')]);
  check('save uploads the resized image (WebP, ≤ 512 px, CSRF header) and shows progress', put.status() === 200 && put.request().headers()['content-type'] === 'image/webp' && put.request().headers()['x-hr-requested'] === '1' && (await progressSeen), `${put.status()} ${put.request().headers()['content-type']}`);
  await page.waitForFunction(() => document.querySelector('.modal .emp-avatar')?.dataset.avatar === 'photo' && document.querySelector('.modal .emp-avatar img')?.complete);
  let meta = (await api(page, `/api/employees/${e007}/avatar/meta`)).avatar;
  p = await panel(page);
  check('after saving: the stored photo is shown, fetched with its new version (no stale cache)', p.loaded && p.src.endsWith(`/api/employees/${e007}/avatar?v=${meta.version}`) && p.buttons.join() === 'เปลี่ยนรูป…,ลบรูป' && meta.content_type === 'image/webp', JSON.stringify({ p, meta }));
  const dims = await page.evaluate(() => { const i = document.querySelector('.modal .emp-avatar img'); return [i.naturalWidth, i.naturalHeight]; });
  check('stored photo is the resized image (fixture 96 px stays ≤ 512 px)', dims[0] === 96 && dims[1] === 96, JSON.stringify(dims));
  await page.screenshot({ path: join(OUT, 'form-1440-light-photo.png') });

  const v1 = meta.version;
  await choose(page, FIX('sample.jpg'));
  await page.click('.modal .avatar-save');
  await page.waitForFunction((v) => { const s = document.querySelector('.modal .emp-avatar img')?.getAttribute('src') ?? ''; return s.includes('?v=') && !s.endsWith(v) && !s.startsWith('data:'); }, v1);
  meta = (await api(page, `/api/employees/${e007}/avatar/meta`)).avatar;
  check('replace: a new version is stored and shown', meta.version !== v1 && (await panel(page)).src.endsWith(meta.version));

  // client-side rejection
  writeFileSync(join(persist, 'not-an-image.png'), 'this is text, not a PNG');
  await choose(page, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  p = await panel(page);
  check('unsupported file type is refused before upload with a clear message', p.msg.includes('รองรับเฉพาะ') && p.mode === 'photo', p.msg);
  await choose(page, join(persist, 'not-an-image.png'));
  p = await panel(page);
  check('an unreadable "image" is refused with a clear message', p.msg.includes('อ่านไฟล์รูปไม่ได้') && p.mode === 'photo', p.msg);

  // org chart follows
  await page.keyboard.press('Escape');
  await page.goto(BASE + '/org-chart?company=1');
  await page.waitForSelector('.org-canvas [data-id]');
  const chartHref = await page.$eval(`.org-canvas [data-id="${e007}"] image`, (i) => i.getAttribute('href')).catch(() => null);
  check('org chart shows the new photo for the employee', chartHref?.endsWith(`?v=${meta.version}`), chartHref);

  // remove with confirmation
  await openEmployee(page, 'E007');
  await page.click('.modal .avatar-actions button:has-text("ลบรูป")');
  await page.waitForSelector('.modal:has-text("ต้องการลบรูปของ")');
  check('remove asks for confirmation first', (await api(page, `/api/employees/${e007}/avatar/meta`)).avatar !== null);
  await page.click('.modal:has-text("ต้องการลบรูปของ") button.danger');
  await page.waitForFunction(() => document.querySelector('.modal .emp-avatar')?.dataset.avatar === 'initials');
  check('after removing: initials again, nothing stored', (await panel(page)).initials === 'ธท' && (await api(page, `/api/employees/${e007}/avatar/meta`)).avatar === null);
  // a photo for the view-only checks below
  await choose(page, FIX('sample.webp'));
  await page.click('.modal .avatar-save');
  await page.waitForFunction(() => document.querySelector('.modal .emp-avatar')?.dataset.avatar === 'photo');
  await ctx.close();

  // view-only users
  for (const [user, code, label] of [['a_emp', 'E007', 'employee (own record)'], ['a_mgr', 'E007', 'manager (employees.view)']]) {
    const s = await session(user);
    await openEmployee(s.page, code);
    await s.page.waitForFunction(() => { const i = document.querySelector('.modal .emp-avatar img'); return i && i.complete; });
    const v = await panel(s.page);
    check(`${label}: sees the photo, no upload / remove controls`, v.loaded && v.buttons.length === 0, JSON.stringify(v));
    if (user === 'a_emp') {
      // same session cookies, outside the page (a deliberate 403 must not count as a page console error)
      const other = (await s.ctx.request.get(`${BASE}/api/employees/2/avatar`)).status();
      check('employee cannot fetch another employee\'s photo (403)', other === 403, String(other));
    }
    await s.ctx.close();
  }

  // themes and sizes
  for (const [vp, theme] of [[{ width: 1440, height: 900 }, 'dark'], [{ width: 768, height: 1024 }, 'light'], [{ width: 375, height: 740 }, 'dark']]) {
    const s = await session('a_staff', vp, theme);
    await openEmployee(s.page, 'E007');
    await s.page.waitForFunction(() => { const i = document.querySelector('.modal .emp-avatar img'); return i && i.complete && i.naturalWidth > 0; });
    const box = await s.page.evaluate(() => {
      const r = (e) => e.getBoundingClientRect();
      const m = r(document.querySelector('.modal')); const a = r(document.querySelector('.modal .emp-avatar'));
      return { inside: a.left >= m.left && a.right <= m.right, overflow: document.documentElement.scrollWidth - innerWidth, round: getComputedStyle(document.querySelector('.modal .emp-avatar')).borderRadius };
    });
    check(`${vp.width} ${theme}: photo panel fits the dialog, round, no page overflow`, box.inside && box.overflow <= 0 && box.round === '50%', JSON.stringify(box));
    await s.page.screenshot({ path: join(OUT, `form-${vp.width}-${theme}.png`) });
    await s.ctx.close();
  }
} finally {
  await browser.close();
  stopServer(dev);
}
check('no console errors / page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-avatar pass=${results.length - fail} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
