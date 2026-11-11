// Organization chart UX (local only; fresh local D1 with seeds/demo.sql + a synthetic second company written by SQL):
// floating zoom toolbar (zoom in / out, wheel, drag-pan, fit, reset, expand / collapse all), node expand / collapse,
// department chips from the API (counts, selection, reporting context across departments, no double counting),
// search + filter, reports-to loop (no hang, no duplicates, flagged), multi-company chips, responsive 1440 / 1024 /
// 768 / 375 (toolbar never over a node), light / dark, keyboard. The suite only reads: it fails if the page sends any
// non-GET request to /api/org-design.
// usage: node tests/ui/ui-org.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('org');
mkdirSync(OUT, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `org-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);
// synthetic second company (local test DB only): cross-department reporting and a reports-to loop
const fixture = join(persist, 'org-fixture.sql');
const C2 = "(SELECT id FROM companies WHERE code = 'ZZ2')";
const dep = (code) => `(SELECT id FROM departments WHERE code = '${code}')`;
const emp = (code) => `(SELECT id FROM employees WHERE emp_code = '${code}')`;
writeFileSync(fixture, [
  "INSERT INTO companies (code, name, active) VALUES ('ZZ2', 'บริษัท ทดสอบ ซีซี จำกัด', 1);",
  `INSERT INTO departments (code, name, company_id, parent_id, active) VALUES ('ZZ-MGT', 'Management', ${C2}, NULL, 1), ('ZZ-MKT', 'Marketing', ${C2}, NULL, 1), ('ZZ-ACC', 'Accounting', ${C2}, NULL, 1), ('ZZ-EMPTY', 'Legal', ${C2}, NULL, 1);`,
  ...[['ZZ01', 'ซีอีโอ', 'ZZ-MGT'], ['ZZ02', 'หัวหน้าการตลาด', 'ZZ-MKT'], ['ZZ03', 'พนักงานการตลาด', 'ZZ-MKT'], ['ZZ11', 'วงจรหนึ่ง', 'ZZ-ACC'], ['ZZ12', 'วงจรสอง', 'ZZ-ACC'], ['ZZ13', 'วงจรสาม', 'ZZ-ACC']]
    .map(([code, first, d]) => `INSERT INTO employees (emp_code, first_name, last_name, company_id, department_id, hire_date, employment_type, status) VALUES ('${code}', '${first}', 'ทดสอบ', ${C2}, ${dep(d)}, '2024-01-02', 'permanent', 'active');`),
  `UPDATE employees SET manager_id = ${emp('ZZ01')} WHERE emp_code = 'ZZ02';`,
  `UPDATE employees SET manager_id = ${emp('ZZ02')} WHERE emp_code = 'ZZ03';`,
  `UPDATE employees SET manager_id = ${emp('ZZ12')} WHERE emp_code = 'ZZ11';`,
  `UPDATE employees SET manager_id = ${emp('ZZ11')} WHERE emp_code = 'ZZ12';`,
  `UPDATE employees SET manager_id = ${emp('ZZ12')} WHERE emp_code = 'ZZ13';`,
].join('\n'));
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', fixture]);
// photo fixtures straight into the local storage (no app API): E001 has a real photo, E005's metadata points at an
// object that does not exist (the chart must fall back to initials)
const PHOTO_KEY = 'employees/1/uitest/avatar/uitest-e001.webp';
run([W, 'r2', 'object', 'put', `hr-system-employee-assets/${PHOTO_KEY}`, '--file', join('tests', 'fixtures', 'avatar', 'sample.webp'), '--content-type', 'image/webp', '--local', '--persist-to', persist]);
const avatarSql = join(persist, 'org-avatars.sql');
writeFileSync(avatarSql, `INSERT INTO employee_avatars (employee_id, object_key, content_type, size_bytes) VALUES (${emp('E001')}, '${PHOTO_KEY}', 'image/webp', 338), (${emp('E005')}, 'employees/1/uitest/avatar/uitest-missing.webp', 'image/webp', 338);`);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', avatarSql]);
const pw = `Og-${randomBytes(9).toString('base64url')}-7q`;
const uf = join(persist, 'u.sql');
run(['scripts/create-user.mjs', '--username', 'o_admin', '--display', 'ทดสอบ o_admin', '--out', uf, '--cred-file', join(persist, 'c.txt'), '--role', 'super_admin'], { NEW_USER_PASSWORD: pw });
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', uf]);
const port = await freePort();
const dev = spawn(process.execPath, [W, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', `MFA_ENCRYPTION_KEY:${randomBytes(32).toString('base64')}`, '--show-interactive-dev-session=false'], SERVER_SPAWN);
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

const b32 = (s) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of s.replace(/\s/g, '')) bits += A.indexOf(c).toString(2).padStart(5, '0'); return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2))); };
let lastStep = 0;
async function totp(secret) {   // each 30 s step is single-use: wait for a fresh one
  let step = Math.floor(Date.now() / 30000);
  while (step <= lastStep) { await new Promise((r) => setTimeout(r, 1000)); step = Math.floor(Date.now() / 30000); }
  lastStep = step;
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', b32(secret)).update(msg).digest(); const o = mac[19] & 15;
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); };
const errors = [];
const writes = [];
const browser = await chromium.launch({ executablePath: EXE });
let secret = null;

async function session(viewport, theme, extra = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, locale: 'th-TH', ...extra });
  await ctx.addInitScript((t) => { try { localStorage.setItem('hr.theme', t); } catch { /* none */ } }, theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${theme} ${viewport.width}: ${e.message}`));
  // the only expected error: the deliberately missing photo fixture (fallback test)
  page.on('console', (m) => { if (m.type() === 'error' && !m.location().url.includes('uitest-missing')) errors.push(`${theme} ${viewport.width}: ${m.text()}`); });
  await page.goto(BASE + '/login'); await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', 'o_admin'); await page.fill('input[name=password]', pw); await page.click('button.auth-submit');
  await page.waitForSelector('nav.sidebar, button:has-text("เริ่มตั้งค่า MFA"), input[name=totp]:visible');
  if (await page.$('button:has-text("เริ่มตั้งค่า MFA")')) {
    await page.click('button:has-text("เริ่มตั้งค่า MFA")');
    secret = (await page.textContent('code.secret')).trim();
    await page.fill('.mfa-setup input', await totp(secret)); await page.click('text=ยืนยันและเปิดใช้');
  } else { await page.fill('input[name=totp]', await totp(secret)); await page.click('button.auth-submit'); }
  await page.waitForSelector('nav.sidebar');
  // from here on the chart must only read
  page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/org-design')) writes.push(`${r.method()} ${r.url()}`); });
  return { ctx, page };
}
const open = async (page, query) => {
  await page.goto(`${BASE}/org-chart${query}`);
  await page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .loading') && document.querySelector('.org-canvas'));
  await page.waitForTimeout(350);
};
const api = (page, query) => page.evaluate(async (q) => (await fetch(`/api/org-design${q}`)).json(), query);
const nodeIds = (page) => page.$$eval('.org-canvas [data-id]', (x) => x.map((e) => Number(e.getAttribute('data-id'))));
const scale = (page) => page.$eval('.org-canvas svg', (s) => Number(s.dataset.scale));
const viewBox = (page) => page.$eval('.org-canvas svg', (s) => s.getAttribute('viewBox').split(' ').map(Number));
const geometry = (page) => page.evaluate(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, w: b.width, h: b.height }; };
  const zb = document.querySelector('.org-zoombar'); const cv = document.querySelector('.org-canvas');
  return { zb: r(zb), cv: r(cv), zbPos: getComputedStyle(zb).position, nodes: [...document.querySelectorAll('.org-canvas [data-id]')].map((n) => ({ id: n.getAttribute('data-id'), ...r(n.querySelector('.org-card')) })),
    buttons: [...zb.querySelectorAll('button')].map((b) => ({ label: b.getAttribute('aria-label'), title: b.title, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height) })),
    overflow: document.documentElement.scrollWidth - innerWidth };
});
const overlaps = (a, b) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const zbtn = (page, act) => page.click(`.org-zoombar [data-act="${act}"]`);

try {
  // ======================= desktop 1440, light, company 1 =======================
  const { ctx, page } = await session({ width: 1440, height: 900 }, 'light');
  await open(page, '?company=1');
  const d1 = await api(page, '?company=1');
  let g = await geometry(page);
  const labels = g.buttons.map((b) => b.label);
  check('toolbar: seven controls with labels and tooltips (Readable Fit + Whole Chart Fit)', ['ซูมเข้า', 'ซูมออก', 'Readable Fit · พอดีจอแบบอ่านได้ (≥ 70%)', 'Whole Chart Fit · พอดีจอทั้งผัง', 'รีเซ็ตมุมมอง (กึ่งกลางผัง 100%)', 'ขยายทั้งหมด', 'ย่อทั้งหมด'].every((l) => labels.includes(l)) && g.buttons.every((b) => b.title === b.label), labels.join(' | '));
  check('toolbar: floating, vertical, on the right inside the chart', g.zbPos === 'absolute' && g.zb.r <= g.cv.r && g.zb.l > g.cv.l + g.cv.w / 2 && g.zb.h > g.zb.w, JSON.stringify({ zb: g.zb, cv: g.cv }));
  check('fit on open: no node under the toolbar, every node inside the chart', g.nodes.length > 0 && g.nodes.every((n) => !overlaps(n, g.zb) && n.l >= g.cv.l - 1 && n.r <= g.cv.r + 1 && n.t >= g.cv.t - 1 && n.b <= g.cv.b + 1));
  let ids = await nodeIds(page);
  check('nodes = active employees of the company, each exactly once', ids.length === d1.employees.length && new Set(ids).size === ids.length, `${ids.length} nodes, ${d1.employees.length} employees`);
  check('no horizontal page overflow; chart has no scrollbars', g.overflow <= 0 && (await page.$eval('.org-canvas', (c) => getComputedStyle(c).overflow)) === 'hidden');
  check('toolbar stays at the top of the chart', g.zb.t - g.cv.t >= 0 && g.zb.t - g.cv.t <= 20, `${g.zb.t - g.cv.t}px from the top`);

  // photos: real photo for E001 (through the authenticated API), initials for everyone else, broken photo → initials
  const e001 = d1.employees.find((e) => e.emp_code === 'E001');
  const e005 = d1.employees.find((e) => e.emp_code === 'E005');
  await page.waitForTimeout(500);
  const av = await page.evaluate(async ({ a, b }) => {
    const one = (id) => { const g = document.querySelector(`.org-canvas [data-id="${id}"] .org-avatar`); const img = g?.querySelector('image'); return { photo: g?.classList.contains('has-photo'), href: img?.getAttribute('href') ?? null, initials: g?.querySelector('.org-avatar-initials')?.textContent }; };
    const p = one(a);
    const served = p.href ? await fetch(p.href).then((r) => ({ status: r.status, type: r.headers.get('content-type'), cache: r.headers.get('cache-control') })) : null;
    const circles = [...document.querySelectorAll('.org-canvas .org-avatar')].length;
    const card = document.querySelector('.org-canvas .org-card');
    return { a: p, b: one(b), served, circles, nodes: document.querySelectorAll('.org-canvas [data-id]').length, card: [card.getAttribute('width'), card.getAttribute('height')] };
  }, { a: e001.id, b: e005.id });
  check('org chart: every card has a round photo / initials area, card size unchanged (210×66)', av.circles === av.nodes && av.card.join() === '210,66', JSON.stringify(av.card));
  check('org chart: real photo through the private API (no-store), clipped to a circle', av.a.photo && /^\/api\/employees\/\d+\/avatar\?v=uitest-e001$/.test(av.a.href) && av.served?.status === 200 && av.served.type === 'image/webp' && av.served.cache === 'private, no-store', JSON.stringify(av));
  check('org chart: a photo that cannot load falls back to initials without breaking the SVG', av.b.photo === false && av.b.href === null && av.b.initials === 'ปท', JSON.stringify(av.b));
  const noPhoto = await page.$$eval('.org-canvas .org-avatar:not(.has-photo) .org-avatar-initials', (x) => x.map((t) => t.textContent));
  check('org chart: employees without a photo show their initials', noPhoto.length === d1.employees.length - 1 && noPhoto.every((t) => t && t.length >= 1 && t.length <= 2), JSON.stringify(noPhoto));
  await page.click('summary:has-text("Export")');
  const [svgDl] = await Promise.all([page.waitForEvent('download'), page.click('.menu-pop button:has-text("SVG")')]);
  const exported = readFileSync(await svgDl.path(), 'utf8');
  check('SVG export is self-contained: photo inlined, no API links, broken photo left as initials', exported.includes('href="data:image/webp;base64,') && !exported.includes('/api/employees') && exported.includes('>ปท<'));
  check('org chart: initials keep ≥ 4.5:1 contrast on the department colour', await page.evaluate(() => {
    const lum = (c) => { const v = c.match(/\d+/g).slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
    return [...document.querySelectorAll('.org-canvas .org-node:not(.is-context) .org-avatar-bg')].every((c) => (1.05 / (lum(getComputedStyle(c).fill) + 0.05)) >= 4.5);
  }));

  const s0 = await scale(page);
  await zbtn(page, 'zoom-in');
  const s1 = await scale(page);
  await zbtn(page, 'zoom-out'); await zbtn(page, 'zoom-out');
  const s2 = await scale(page);
  check('zoom in / out change the scale', s1 > s0 && s2 < s1, `${s0} → ${s1} → ${s2}`);
  check('zoom readout follows the scale', (await page.textContent('.org-zoom-level')) === `${Math.round(s2 * 100)}%`);
  // re-measure: the toolbar clicks may have scrolled the page
  const c = (await geometry(page)).cv;
  await page.mouse.move(c.l + c.w / 3, Math.min(Math.max(c.t, 0) + 80, c.b - 20));
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(150);
  const s3 = await scale(page);
  check('mouse wheel zooms in', s3 > s2, `${s2} → ${s3}`);
  const vb0 = await viewBox(page);
  await page.mouse.move(c.l + 60, c.t + 60); await page.mouse.down(); await page.mouse.move(c.l + 180, c.t + 120, { steps: 6 }); await page.mouse.up();
  const vb1 = await viewBox(page);
  check('drag pans the chart (viewBox moves opposite to the drag)', Math.abs((vb0[0] - vb1[0]) - 120 / s3) < 2 && Math.abs((vb0[1] - vb1[1]) - 60 / s3) < 2, `${vb0.slice(0, 2)} → ${vb1.slice(0, 2)} @${s3}`);
  check('a drag does not open the employee panel', (await page.innerText('.org-side')).includes('เลือกพนักงานในผัง'));
  await zbtn(page, 'reset');
  check('reset view = 100%', (await scale(page)) === 1);
  await zbtn(page, 'fit');
  g = await geometry(page);
  check('fit: whole chart visible and clear of the toolbar', g.nodes.every((n) => !overlaps(n, g.zb) && n.l >= g.cv.l - 1 && n.r <= g.cv.r + 1 && n.t >= g.cv.t - 1 && n.b <= g.cv.b + 1));
  const box = await page.$eval('.org-canvas svg', (s) => [s.getBoundingClientRect().width, s.getBoundingClientRect().height]);
  check('SVG keeps filling the chart at any zoom (vector, no bitmap scaling)', Math.abs(box[0] - g.cv.w) < 3 && Math.abs(box[1] - g.cv.h) < 3);

  // expand / collapse one node
  const tog = await page.$eval('.org-canvas [data-toggle]', (t) => Number(t.getAttribute('data-toggle')));
  const before = (await nodeIds(page)).length;
  await page.click(`.org-canvas [data-toggle="${tog}"]`);
  const afterCollapse = await nodeIds(page);
  const badge = await page.$eval(`.org-canvas [data-toggle="${tog}"] text`, (t) => t.textContent);
  const direct = d1.employees.filter((e) => e.manager_id === tog).length;
  check('collapse a node: its team hides and the toggle shows +N direct reports', afterCollapse.length < before && badge === `+${direct}` && (await page.getAttribute(`.org-canvas [data-id="${tog}"]`, 'aria-expanded')) === 'false', `${before} → ${afterCollapse.length}, ${badge}`);
  await page.click(`.org-canvas [data-toggle="${tog}"]`);
  check('expand the node again restores the team', (await nodeIds(page)).length === before);
  await zbtn(page, 'collapse-all');
  const roots = d1.employees.filter((e) => !e.manager_id || !d1.employees.some((x) => x.id === e.manager_id)).length;
  check('collapse all leaves only the top of each tree', (await nodeIds(page)).length === roots, `${(await nodeIds(page)).length} vs ${roots}`);
  await zbtn(page, 'expand-all');
  check('expand all shows everyone again', (await nodeIds(page)).length === d1.employees.length);

  // keyboard
  await page.focus(`.org-canvas [data-id="${tog}"]`);
  await page.keyboard.press('ArrowLeft');
  const kbClosed = await page.getAttribute(`.org-canvas [data-id="${tog}"]`, 'aria-expanded');
  await page.keyboard.press('ArrowRight');
  check('keyboard: ArrowLeft / ArrowRight collapse and expand the focused node', kbClosed === 'false' && (await page.getAttribute(`.org-canvas [data-id="${tog}"]`, 'aria-expanded')) === 'true');

  // department chips
  const chips = await page.$$eval('.org-chip', (x) => x.map((b) => ({ dept: b.dataset.dept, label: b.querySelector('.org-chip-label').textContent, count: Number(b.querySelector('.org-chip-count').textContent), pressed: b.getAttribute('aria-pressed') })));
  const unassigned = d1.employees.filter((e) => e.department_id === null).length;
  check('chips: "ทั้งหมด" + one per department of the API master, real counts', chips.length === d1.departments.length + 1 + (unassigned ? 1 : 0)
    && chips[0].label === 'ทั้งหมด' && chips[0].count === d1.employees.length && chips[0].pressed === 'true'
    && d1.departments.every((x) => chips.some((ch) => ch.dept === String(x.id) && ch.label === x.name && ch.count === x.employees)), JSON.stringify(chips.map((ch) => `${ch.label}:${ch.count}`)));
  const hr = d1.departments.find((x) => x.code === 'HR');
  await page.click(`.org-chip[data-dept="${hr.id}"]`);
  await page.waitForTimeout(200);
  const hrMembers = d1.employees.filter((e) => e.department_id === hr.id);
  const ctxExpected = [...new Set(hrMembers.map((e) => e.manager_id).filter((m) => m && !hrMembers.some((x) => x.id === m)))];
  const shown = await page.$$eval('.org-canvas [data-id]', (x) => x.map((n) => ({ id: Number(n.getAttribute('data-id')), context: n.classList.contains('is-context') })));
  check('HR chip: selected state and URL', (await page.getAttribute(`.org-chip[data-dept="${hr.id}"]`, 'aria-pressed')) === 'true' && (await page.getAttribute('.org-chip[data-dept=""]', 'aria-pressed')) === 'false' && new URL(page.url()).searchParams.get('dept') === String(hr.id));
  check('HR chip: shows exactly the HR members plus their out-of-department managers as context',
    shown.filter((n) => !n.context).map((n) => n.id).sort().join() === hrMembers.map((e) => e.id).sort().join() && shown.filter((n) => n.context).map((n) => n.id).sort().join() === ctxExpected.sort().join() && ctxExpected.length > 0,
    JSON.stringify(shown));
  check('context managers are not counted (note, chip count)', (await page.textContent('.org-filter-note')).includes(`แสดง ${hrMembers.length} คน`) && (await page.textContent(`.org-chip[data-dept="${hr.id}"] .org-chip-count`)) === String(hr.employees) && hr.employees === hrMembers.length,
    await page.textContent('.org-filter-note'));
  check('cross-department reporting line is drawn (dashed edge from the context manager)', (await page.$$('.org-canvas .org-edge.is-context')).length >= 1);
  await page.click(`.org-canvas [data-id="${ctxExpected[0]}"] .org-card`);
  check('context manager detail explains it is from another department', (await page.innerText('.org-side')).includes('หัวหน้าจากหน่วยงานอื่น'));
  await page.screenshot({ path: join(OUT, 'org-1440-light-filter-hr.png') });

  // search + filter
  await zbtn(page, 'collapse-all');
  const target = hrMembers.find((e) => e.manager_id && hrMembers.some((x) => x.id === e.manager_id)) ?? hrMembers[0];
  await page.fill('.org-toolbar input[type=search]', target.emp_code);
  await page.waitForTimeout(300);
  g = await geometry(page);
  const hitIds = await page.$$eval('.org-canvas .org-node.is-hit', (x) => x.map((n) => Number(n.getAttribute('data-id'))));
  const tn = g.nodes.find((n) => Number(n.id) === target.id);
  check('search inside the filter: expands collapsed ancestors, highlights only the match', JSON.stringify(hitIds) === JSON.stringify([target.id]) && !!tn, JSON.stringify(hitIds));
  check('search moves the chart to the match (node fully in view, not under the toolbar)', !!tn && tn.l >= g.cv.l && tn.r <= g.cv.r && tn.t >= g.cv.t && tn.b <= g.cv.b && !overlaps(tn, g.zb));
  check('search result count is announced', (await page.textContent('.org-search-count')) === 'พบ 1 คน');
  const outside = d1.employees.find((e) => e.department_id !== hr.id && !ctxExpected.includes(e.id));
  await page.fill('.org-toolbar input[type=search]', outside.emp_code);
  await page.waitForTimeout(300);
  check('search respects the department filter (outside → not found)', (await page.textContent('.org-search-count')) === 'ไม่พบ' && (await page.$$('.org-canvas .org-node.is-hit')).length === 0);
  await page.fill('.org-toolbar input[type=search]', '');
  await page.click('.org-chip[data-dept=""]');
  await page.waitForTimeout(200);
  check('"ทั้งหมด" restores the full chart and clears the URL filter', (await nodeIds(page)).length === d1.employees.length && !new URL(page.url()).searchParams.has('dept'));
  check('the detail panel follows the filter (no stale "other department" note)', !(await page.innerText('.org-side')).includes('หัวหน้าจากหน่วยงานอื่น'));
  await zbtn(page, 'fit');
  await page.screenshot({ path: join(OUT, 'org-1440-light.png') });

  // ======================= all companies: multi-company chips + reports-to loop =======================
  await open(page, '?company=');
  const dAll = await api(page, '');
  ids = await nodeIds(page);
  check('all companies: every employee exactly once despite the reports-to loop', ids.length === dAll.employees.length && new Set(ids).size === ids.length, `${ids.length} / ${dAll.employees.length}`);
  const loop = ['ZZ11', 'ZZ12', 'ZZ13'].map((code) => dAll.employees.find((e) => e.emp_code === code).id);
  const cyc = await page.$$eval('.org-canvas .org-node.is-cycle', (x) => x.map((n) => Number(n.getAttribute('data-id'))));
  check('loop: all three people shown, the cut point flagged "วนลูป"', loop.every((id) => ids.includes(id)) && cyc.length === 1 && loop.includes(cyc[0]) && (await page.$$('.org-canvas .org-cycle-badge')).length === 1, JSON.stringify(cyc));
  const chipLabels = await page.$$eval('.org-chip-label', (x) => x.map((e) => e.textContent));
  check('multi-company chips carry the company code', chipLabels.includes('Marketing · ZZ2') && chipLabels.some((l) => l.endsWith(' · DEMO')), JSON.stringify(chipLabels));
  const legal = dAll.departments.find((x) => x.code === 'ZZ-EMPTY');
  check('a department with no one is shown with 0 (from the master data)', (await page.textContent(`.org-chip[data-dept="${legal.id}"] .org-chip-count`)) === '0');
  const mkt = dAll.departments.find((x) => x.code === 'ZZ-MKT');
  await page.click(`.org-chip[data-dept="${mkt.id}"]`);
  await page.waitForTimeout(200);
  const mktShown = await page.$$eval('.org-canvas [data-id]', (x) => x.map((n) => ({ id: Number(n.getAttribute('data-id')), context: n.classList.contains('is-context') })));
  const ceo = dAll.employees.find((e) => e.emp_code === 'ZZ01').id;
  check('Marketing (ZZ2): 2 members + Management head as context', mktShown.filter((n) => !n.context).length === 2 && mktShown.filter((n) => n.context).map((n) => n.id).join() === String(ceo));
  const acc = dAll.departments.find((x) => x.code === 'ZZ-ACC');
  await page.click(`.org-chip[data-dept="${acc.id}"]`);
  await page.waitForTimeout(200);
  const accIds = await nodeIds(page);
  check('Accounting (the loop) filtered: 3 members, no duplicates, finite', accIds.length === 3 && new Set(accIds).size === 3);
  await page.click(`.org-chip[data-dept="${legal.id}"]`);
  check('empty department: clear empty state', (await page.textContent('.org-canvas')).includes('ไม่มีพนักงานในหน่วยงานนี้'));
  await page.click('.org-chip[data-dept=""]');
  await zbtn(page, 'fit');
  await page.screenshot({ path: join(OUT, 'org-1440-light-all-companies.png') });
  await ctx.close();

  // ======================= responsive + themes =======================
  for (const [label, vp, theme, touch] of [['1024', { width: 1024, height: 768 }, 'light', true], ['768', { width: 768, height: 1024 }, 'dark', true], ['375', { width: 375, height: 740 }, 'light', true], ['375', { width: 375, height: 740 }, 'dark', true], ['1440', { width: 1440, height: 900 }, 'dark', false]]) {
    const s = await session(vp, theme, touch ? { hasTouch: true, isMobile: vp.width < 600 } : {});
    await open(s.page, '?company=1');
    const gg = await geometry(s.page);
    const tag = `${label} ${theme}`;
    check(`${tag}: no page overflow, toolbar visible with ${gg.buttons.length} controls`, gg.overflow <= 0 && gg.buttons.length === 7 && gg.zb.w > 0 && gg.zb.h > 0);
    if (vp.width <= 600) check(`${tag}: toolbar above the chart (never over a node), one row`, gg.zbPos === 'static' && gg.zb.b <= gg.cv.t + 1 && gg.zb.w > gg.zb.h);
    else check(`${tag}: floating toolbar on the right, no node under it after fit`, gg.zbPos === 'absolute' && gg.zb.l > gg.cv.l + gg.cv.w / 2 && gg.nodes.every((n) => !overlaps(n, gg.zb)));
    if (vp.width <= 1024) check(`${tag}: toolbar buttons are ≥ 40px touch targets`, gg.buttons.every((b) => b.w >= 40 && b.h >= 40), JSON.stringify(gg.buttons.map((b) => `${b.w}x${b.h}`)));
    const fill = await s.page.$eval('.org-canvas .org-node:not(.is-context) .org-card', (r) => getComputedStyle(r).fill);
    const t1 = await s.page.$eval('.org-canvas .org-t1', (t) => getComputedStyle(t).fill);
    check(`${tag}: node colours follow the theme`, theme === 'dark' ? fill === 'rgb(17, 24, 39)' && t1 === 'rgb(229, 237, 247)' : fill === 'rgb(255, 255, 255)' && t1 === 'rgb(15, 23, 42)', `${fill} / ${t1}`);
    const look = await s.page.evaluate(() => {
      const rgb = (hex) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
      const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      const cv = r(document.querySelector('.org-canvas')); const zb = r(document.querySelector('.org-zoombar'));
      const pills = [...document.querySelectorAll('.org-level-rail .org-level-pill')].map(r);
      const nodes = [...document.querySelectorAll('.org-canvas .org-node')];
      return {
        pills: pills.length, inLeft: pills.every((p) => p.l >= cv.l - 1 && p.r <= cv.l + (cv.r - cv.l) / 2), clearOfBar: pills.every((p) => !(p.l < zb.r && zb.l < p.r && p.t < zb.b && zb.t < p.b)),
        borders: nodes.every((n) => getComputedStyle(n.querySelector('.org-card')).stroke === rgb(n.dataset.color)),
        legend: document.querySelectorAll('.org-legend .org-legend-item').length,
      };
    });
    check(`${tag}: level rail L1–L5 on the left of the chart, clear of the toolbar; borders keep the department colour; legend shown`, look.pills === 5 && look.inLeft && look.clearOfBar && look.borders && look.legend > 0, JSON.stringify(look));
    if (touch) {
      const tg = await s.page.$eval('.org-canvas [data-toggle]', (t) => Number(t.getAttribute('data-toggle')));
      const n0 = (await nodeIds(s.page)).length;
      await s.page.tap(`.org-canvas [data-toggle="${tg}"] .org-toggle-dot`);
      const n1 = (await nodeIds(s.page)).length;
      await s.page.tap('.org-zoombar [data-act="zoom-in"]');
      check(`${tag}: touch — tap collapses a team and taps the toolbar`, n1 < n0 && (await scale(s.page)) > 0);
    }
    await s.page.locator('.org-zoombar [data-act="fit"]').click();
    await s.page.screenshot({ path: join(OUT, `org-${label}-${theme}.png`) });
    await s.ctx.close();
  }
} finally {
  await browser.close();
  stopServer(dev);
}
check('the chart sent no write request to /api/org-design', writes.length === 0, writes.join(' | '));
check('no console errors / page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-org pass=${results.length - fail} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
