// Organization chart master-template layout in the browser (local only; fresh local D1 + seeds/demo.sql + a synthetic company
// "ZZL" written by SQL with the approved production position titles — no production data). Checks: every employee
// once, level bands L1–L5 top-down with the label rail aligned (also after zoom / pan), tidy tree (manager centred over
// its teams), department border colours + legend (follows the filter), Staff / Admin in 1–3 columns under their own
// manager with the last row centred, no
// card overlap, every line drawn from the real manager_id, L5 with reports stays L5, "ไม่มีสายบังคับบัญชา" block,
// "Unmapped Level" marker, company groups without cross-company lines, search, fit / zoom, detail, table view,
// desktop 1440 / 1920 and laptop 1366 / 1280, no write request, no console errors.
// usage: node tests/ui/ui-org-layout.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('org-layout');
mkdirSync(OUT, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `org-layout-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);

// ---- synthetic company ZZL (local test DB only) ----
const CO = "(SELECT id FROM companies WHERE code = 'ZZL')";
const dep = (code) => `(SELECT id FROM departments WHERE code = '${code}')`;
const posId = (title) => `(SELECT id FROM positions WHERE code = 'ZZL-${title.replace(/[^A-Za-z]/g, '').slice(0, 24)}')`;
const people = [
  ['L01', 'Manager Director', null, 'ZL-MGT'],
  ['L02', 'Asst. Managing Director', 'L01', 'ZL-MGT'],
  ['L03', 'Operations Manager', 'L02', 'ZL-OPS'],
  ['L04', 'Human Resources Manager', 'L02', 'ZL-HR'],
  ['L05', 'Operations Leader', 'L03', 'ZL-OPS'],
  ['L06', 'Customer Service Leader', 'L03', 'ZL-OPS'],
  ['L07', 'HR Leader (Payroll & Admin)', 'L04', 'ZL-HR'],
  ['L08', 'Business Development', 'L02', 'ZL-MGT'],
  ['L09', 'Business Development', 'L02', 'ZL-MGT'],
  ...Array.from({ length: 8 }, (_, i) => [`S1${i}`, 'Operations Officer', 'L05', 'ZL-OPS']),
  ...Array.from({ length: 2 }, (_, i) => [`S2${i}`, 'Customer Service Officer', 'L06', 'ZL-OPS']),
  ...Array.from({ length: 5 }, (_, i) => [`S3${i}`, 'HR Officer (Recruit & Training)', 'L07', 'ZL-HR']),
  ...Array.from({ length: 2 }, (_, i) => [`S4${i}`, 'Administration Officer', 'L04', 'ZL-HR']),
  ...Array.from({ length: 4 }, (_, i) => [`S5${i}`, 'Sales Executive', 'L08', 'ZL-MGT']),
  ['S60', 'Chief Happiness Officer', 'L04', 'ZL-HR'], // not in the approved mapping → Unmapped Level
  ['N01', 'LiveStreaming', null, 'ZL-OPS'],
  ['N02', 'LiveStreaming', null, 'ZL-OPS'],
  ['N03', 'Quality Control Officer', null, 'ZL-OPS'],
];
const titles = [...new Set(people.map((p) => p[1]))];
const fixture = join(persist, 'org-layout-fixture.sql');
writeFileSync(fixture, [
  "INSERT INTO companies (code, name, active) VALUES ('ZZL', 'บริษัท ทดสอบ เลย์เอาต์ จำกัด', 1);",
  `INSERT INTO departments (code, name, company_id, parent_id, active) VALUES ('ZL-MGT', 'Management', ${CO}, NULL, 1), ('ZL-OPS', 'Operations', ${CO}, NULL, 1), ('ZL-HR', 'Human Resources', ${CO}, NULL, 1);`,
  ...titles.map((t) => `INSERT INTO positions (code, title, department_id, job_grade, headcount, active) VALUES ('ZZL-${t.replace(/[^A-Za-z]/g, '').slice(0, 24)}', '${t}', NULL, NULL, 10, 1);`),
  ...people.map(([code, title, , d]) => `INSERT INTO employees (emp_code, first_name, last_name, company_id, department_id, position_id, hire_date, employment_type, status) VALUES ('ZL${code}', 'ทดสอบ${code}', 'เลย์เอาต์', ${CO}, ${dep(d)}, ${posId(title)}, '2024-01-02', 'permanent', 'active');`),
  ...people.filter((p) => p[2]).map(([code, , mgr]) => `UPDATE employees SET manager_id = (SELECT id FROM employees WHERE emp_code = 'ZL${mgr}') WHERE emp_code = 'ZL${code}';`),
].join('\n'));
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', fixture]);

const pw = `Ol-${randomBytes(9).toString('base64url')}-7q`;
const uf = join(persist, 'u.sql');
run(['scripts/create-user.mjs', '--username', 'ol_admin', '--display', 'ทดสอบ ol_admin', '--out', uf, '--cred-file', join(persist, 'c.txt'), '--role', 'super_admin'], { NEW_USER_PASSWORD: pw });
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', uf]);
const port = await freePort();
const dev = spawn(process.execPath, [W, 'dev', '--local', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist, '--var', `MFA_ENCRYPTION_KEY:${randomBytes(32).toString('base64')}`, '--show-interactive-dev-session=false'], SERVER_SPAWN);
const BASE = `http://127.0.0.1:${port}`;
for (let i = 0; i < 240; i++) { try { if ((await fetch(BASE + '/api/health')).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 500)); }

const b32 = (s) => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; for (const c of s.replace(/\s/g, '')) bits += A.indexOf(c).toString(2).padStart(5, '0'); return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2))); };
let lastStep = 0;
async function totp(secret) {
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

async function session(viewport) {
  const ctx = await browser.newContext({ viewport, locale: 'th-TH' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${viewport.width}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${viewport.width}: ${m.text()}`); });
  await page.goto(BASE + '/login'); await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', 'ol_admin'); await page.fill('input[name=password]', pw); await page.click('button.auth-submit');
  await page.waitForSelector('nav.sidebar, button:has-text("เริ่มตั้งค่า MFA"), input[name=totp]:visible');
  if (await page.$('button:has-text("เริ่มตั้งค่า MFA")')) {
    await page.click('button:has-text("เริ่มตั้งค่า MFA")');
    secret = (await page.textContent('code.secret')).trim();
    await page.fill('.mfa-setup input', await totp(secret)); await page.click('text=ยืนยันและเปิดใช้');
  } else { await page.fill('input[name=totp]', await totp(secret)); await page.click('button.auth-submit'); }
  await page.waitForSelector('nav.sidebar');
  page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes('/api/org-design')) writes.push(`${r.method()} ${r.url()}`); });
  return { ctx, page };
}
const open = async (page, query) => {
  await page.goto(`${BASE}/org-chart${query}`);
  await page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .loading') && document.querySelector('.org-canvas'));
  await page.waitForTimeout(350);
};
const api = (page, query) => page.evaluate(async (q) => (await fetch(`/api/org-design${q}`)).json(), query);
// chart geometry in SVG units (independent of zoom): card position, level, edges
const chart = (page) => page.evaluate(() => {
  const nodes = [...document.querySelectorAll('.org-canvas .org-node')].map((g) => {
    const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform'));
    return { id: Number(g.dataset.id), level: Number(g.dataset.level), x: Number(m[1]), y: Number(m[2]), unmapped: g.classList.contains('is-unmapped'), badge: !!g.querySelector('.org-unmapped-badge'), orphan: g.dataset.orphan === '1', gridLower: Number(g.dataset.gridRow || 0) > 0, dept: g.dataset.dept, color: g.dataset.color, stroke: g.querySelector('.org-card').getAttribute('stroke') };
  });
  const edges = [...document.querySelectorAll('.org-canvas .org-edge')].map((p) => ({ from: Number(p.dataset.from), to: Number(p.dataset.to) }));
  const bands = [...document.querySelectorAll('.org-canvas .org-band-label')].map((t) => t.textContent);
  const bandRows = [...document.querySelectorAll('.org-canvas .org-band-label')].map((t) => ({ level: Number(t.dataset.level), y: Number(t.dataset.y) }));
  const orphans = [...document.querySelectorAll('.org-canvas .org-orphans-title')].map((t) => t.textContent);
  const groups = [...document.querySelectorAll('.org-canvas .org-group')].map((g) => { const r = g.querySelector('rect'); return { company: Number(g.dataset.company), x: Number(r.getAttribute('x')), w: Number(r.getAttribute('width')), title: g.querySelector('text').textContent }; });
  const legend = [...document.querySelectorAll('.org-legend .org-legend-item')].map((x) => ({ dept: x.dataset.dept, color: x.dataset.color, text: x.textContent }));
  return { nodes, edges, bands, bandRows, orphans, groups, legend };
});
const CW = 210; const CH = 66;
// level rail (screen px): each pill against the first-row cards of its level; nothing covers it
const rail = (page) => page.evaluate(() => {
  const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
  const cv = r(document.querySelector('.org-canvas')); const zb = r(document.querySelector('.org-zoombar'));
  const railEl = document.querySelector('.org-level-rail');
  const pills = [...railEl.querySelectorAll('.org-level-pill')].map((p) => ({ level: Number(p.dataset.level), text: p.textContent, ...r(p), visible: !railEl.hidden && getComputedStyle(railEl).display !== 'none' && r(p).r > r(p).l }));
  const cards = [...document.querySelectorAll('.org-canvas .org-node:not([data-grid-row]):not([data-orphan]):not([data-external])')].map((n) => ({ level: Number(n.dataset.level), ...r(n.querySelector('.org-card')) }));
  // a band's first-row cards share one line; the pill of that level sits on it
  const aligned = pills.every((p) => { const c = cards.filter((x) => x.level === p.level); const mid = (p.t + p.b) / 2; return !c.length || c.some((x) => Math.abs((x.t + x.b) / 2 - mid) < 2); });
  const z = Number(getComputedStyle(railEl).zIndex);
  return { pills, aligned, above: z >= 1 && getComputedStyle(railEl).position === 'absolute', leftOfToolbar: pills.every((p) => p.r < zb.l), insideLeft: pills.every((p) => p.l >= cv.l - 1 && p.r <= cv.l + 120) };
});
const overlapping = (ns) => { const out = []; for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) { const a = ns[i]; const b = ns[j]; if (a.x < b.x + CW && b.x < a.x + CW && a.y < b.y + CH && b.y < a.y + CH) out.push(`${a.id}/${b.id}`); } return out; };

try {
  const { ctx, page } = await session({ width: 1440, height: 900 });
  const all = await api(page, '');
  const zzl = all.companies.find((c) => c.code === 'ZZL');
  await open(page, `?company=${zzl.id}`);
  const d = await api(page, `?company=${zzl.id}`);
  const byCode = new Map(d.employees.map((e) => [e.emp_code, e]));
  const id = (code) => byCode.get(`ZL${code}`).id;
  let c = await chart(page);
  const ids = c.nodes.map((n) => n.id);
  check('every active employee of the company appears exactly once', ids.length === d.employees.length && new Set(ids).size === ids.length && d.employees.length === people.length, `${ids.length} / ${d.employees.length}`);
  check('no two cards overlap', overlapping(c.nodes).length === 0, overlapping(c.nodes).slice(0, 5).join());
  const at = (code) => c.nodes.find((n) => n.id === id(code));
  check('levels run top-down: MD → AMD → Manager → Leader → Staff', at('L01').y < at('L02').y && at('L02').y < at('L03').y && at('L03').y < at('L05').y && at('L05').y < at('S10').y);
  check('both department managers sit at L3 below the AMD, their leaders below them', [at('L03'), at('L04')].every((m) => m.level === 3 && m.y > at('L02').y) && at('L05').y > at('L03').y && at('L07').y > at('L04').y);
  check('export level labels: L1 → L5 exactly once each', JSON.stringify(c.bands) === JSON.stringify(['L1 · MD', 'L2 · AMD', 'L3 · Manager', 'L4 · Head / Leader', 'L5 · Staff / Admin']), JSON.stringify(c.bands));
  check('every band holds only cards of that level (first rows)', c.bandRows.every((b) => c.nodes.filter((n) => n.y === b.y && !n.orphan && !n.gridLower).every((n) => n.level === b.level)), JSON.stringify(c.bandRows));
  let rl = await rail(page);
  check('level rail: L1–L5 pills on the left edge, each on the line of its cards, above the chart, never under the toolbar', rl.pills.map((p) => p.level).join() === '1,2,3,4,5' && rl.pills.every((p) => p.visible) && rl.aligned && rl.above && rl.leftOfToolbar && rl.insideLeft, JSON.stringify(rl.pills.map((p) => [p.level, Math.round(p.t)])));
  // master template: tidy tree — MD centred over the AMD, the AMD between its managers, each manager over its leaders
  const ctr = (code) => at(code).x + CW / 2;
  check('master template: MD centred above the AMD', Math.abs(ctr('L01') - ctr('L02')) < 0.5);
  check('master template: managers spread left / right of the AMD, each centred over its leaders', Math.min(ctr('L03'), ctr('L04')) < ctr('L02') && Math.max(ctr('L03'), ctr('L04')) > ctr('L02') && Math.abs(ctr('L03') - (ctr('L05') + ctr('L06')) / 2) < 0.5);
  // department colours: card border = department colour, one colour per department, legend = departments on screen
  const deptColor = new Map();
  const colourOk = c.nodes.every((n) => { if (n.stroke !== n.color) return false; if (deptColor.has(n.dept) && deptColor.get(n.dept) !== n.color) return false; deptColor.set(n.dept, n.color); return true; });
  check('department colours: border = department colour, same department = same colour, departments differ', colourOk && new Set(deptColor.values()).size === deptColor.size, JSON.stringify([...deptColor]));
  check('legend: exactly the departments on screen, with their colours and names', c.legend.length === deptColor.size && c.legend.every((l) => deptColor.get(l.dept) === l.color) && ['Management', 'Operations', 'Human Resources'].every((n) => c.legend.some((l) => l.text.includes(n))), JSON.stringify(c.legend));
  // staff grids: per manager, rows of ≤ 3, last row centred
  const grid = (mgr, prefix) => {
    const cards = c.nodes.filter((n) => d.employees.find((e) => e.id === n.id).emp_code.startsWith(`ZL${prefix}`));
    const rows = new Map();
    for (const n of cards) rows.set(n.y, [...(rows.get(n.y) ?? []), n]);
    const list = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r);
    const centre = (r) => r.reduce((a, n) => a + n.x, 0) / r.length;
    return { sizes: list.map((r) => r.length), centred: list.every((r) => Math.abs(centre(r) - centre(list[0])) < 0.5), mgr };
  };
  const g8 = grid('L05', 'S1');
  check('8 staff under one leader: 3 + 3 + 2, last row centred', JSON.stringify(g8.sizes) === '[3,3,2]' && g8.centred, JSON.stringify(g8));
  const g5 = grid('L07', 'S3');
  check('5 staff under one leader: 2 + 2 + 1, centred', JSON.stringify(g5.sizes) === '[2,2,1]' && g5.centred, JSON.stringify(g5));
  const g2 = grid('L06', 'S2');
  check('2 staff: stacked in one column (as in the template)', JSON.stringify(g2.sizes) === '[1,1]' && g2.centred, JSON.stringify(g2));
  check('no staff row anywhere is wider than 3 cards', (() => { const rows = new Map(); for (const n of c.nodes.filter((x) => x.level === 5)) { const e = d.employees.find((x) => x.id === n.id); const k = `${e.manager_id}|${n.y}`; rows.set(k, (rows.get(k) ?? 0) + 1); } return [...rows.values()].every((v) => v <= 3); })());
  const mgrOf = new Map(d.employees.map((e) => [e.id, e.manager_id]));
  const linked = c.nodes.filter((n) => mgrOf.get(n.id) && ids.includes(mgrOf.get(n.id)));
  check('every line is drawn from the real manager_id (one per report, none invented)', c.edges.length === linked.length && c.edges.every((e) => mgrOf.get(e.to) === e.from), `${c.edges.length} edges / ${linked.length} reports`);
  check('Business Development with reports stays L5; its reports sit below it', at('L08').level === 5 && at('L08').y > at('L02').y && at('S50').y > at('L08').y && c.edges.filter((e) => e.from === id('L08')).length === 4);
  check('"ไม่มีสายบังคับบัญชา" block holds the 3 people without a manager, right of the tree on the L5 band', c.orphans.length === 1 && c.orphans[0] === 'ไม่มีสายบังคับบัญชา · 3 คน' && ['N01', 'N02', 'N03'].every((k) => at(k).orphan && at(k).x > Math.max(...c.nodes.filter((n) => !n.orphan).map((n) => n.x))) && at('N01').y === c.bandRows.find((b) => b.level === 5).y);
  check('unmapped title: marker on that card only, note above the chart', at('S60').unmapped && at('S60').badge && c.nodes.filter((n) => n.badge).length === 1
    && (await page.textContent('.org-unmapped-note')).includes('Chief Happiness Officer'));
  await page.click('.org-zoombar [data-act="fit"]');
  const fit1440 = await page.$eval('.org-canvas svg', (s) => Number(s.dataset.scale));
  const namePx = await page.$eval('.org-canvas .org-t1', (t) => t.getBoundingClientRect().height);
  console.log(`INFO  1440×900 Fit-to-Screen scale = ${Math.round(fit1440 * 100)}% (name text box ${namePx.toFixed(1)}px high on screen)`);
  await page.screenshot({ path: join(OUT, 'zzl-1440.png') });
  await page.locator('.org-canvas').screenshot({ path: join(OUT, 'zzl-1440-fit-canvas.png') });
  // close-up evidence: the staff grids at 100 % around the 8-person team
  await page.click('.org-zoombar [data-act="reset"]');
  await page.evaluate((target) => { const svg = document.querySelector('.org-canvas svg'); const n = document.querySelector(`.org-canvas [data-id="${target}"]`); const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(n.getAttribute('transform')); const vb = svg.getAttribute('viewBox').split(' ').map(Number); svg.setAttribute('viewBox', `${Number(m[1]) - 260} ${Number(m[2]) - 280} ${vb[2]} ${vb[3]}`); }, id('S11'));
  await page.locator('.org-canvas').screenshot({ path: join(OUT, 'zzl-1440-100pct.png') });

  // fit / zoom / detail / search keep working
  await page.click('.org-zoombar [data-act="fit"]');
  const inView = await page.evaluate(() => { const cv = document.querySelector('.org-canvas').getBoundingClientRect(); return [...document.querySelectorAll('.org-canvas .org-card')].every((r) => { const b = r.getBoundingClientRect(); return b.left >= cv.left - 1 && b.right <= cv.right + 1 && b.top >= cv.top - 1 && b.bottom <= cv.bottom + 1; }); });
  check('fit: the whole chart is inside the canvas', inView);
  const s0 = await page.$eval('.org-canvas svg', (s) => Number(s.dataset.scale));
  await page.click('.org-zoombar [data-act="zoom-in"]');
  check('zoom in still works', (await page.$eval('.org-canvas svg', (s) => Number(s.dataset.scale))) > s0);
  let railOk = true;
  for (const act of ['zoom-in', 'zoom-in', 'zoom-out', 'zoom-out', 'zoom-out', 'zoom-out']) {
    await page.click(`.org-zoombar [data-act="${act}"]`);
    rl = await rail(page);
    railOk &&= rl.pills.length === 5 && rl.pills.every((p) => p.visible) && rl.aligned && rl.leftOfToolbar;
  }
  check('level rail stays visible and aligned through zoom in / out', railOk, JSON.stringify(rl.pills.map((p) => [p.level, Math.round(p.t)])));
  const box0 = await page.locator('.org-canvas').boundingBox();
  const vb0 = await page.$eval('.org-canvas svg', (x) => x.getAttribute('viewBox'));
  await page.mouse.move(box0.x + box0.width / 2, box0.y + box0.height / 2); await page.mouse.down(); await page.mouse.move(box0.x + box0.width / 2 + 140, box0.y + box0.height / 2 + 60, { steps: 6 }); await page.mouse.up();
  rl = await rail(page);
  check('pan moves the chart; the rail follows the bands', (await page.$eval('.org-canvas svg', (x) => x.getAttribute('viewBox'))) !== vb0 && rl.aligned && rl.pills.length === 5);
  await page.click(`.org-canvas [data-id="${id('L03')}"] .org-card`);
  check('card detail shows the level', (await page.innerText('.org-side')).includes('L3 · Manager'));
  await page.click('.org-side [data-act="close-detail"]');
  await page.click(`.org-canvas [data-id="${id('S60')}"] .org-card`);
  check('unmapped card detail explains the marker', (await page.innerText('.org-side')).includes('Unmapped Level'));
  await page.click('.org-side [data-act="close-detail"]');
  await page.fill('input[type=search]', 'ZLS17');
  await page.waitForTimeout(250);
  check('search finds and highlights a staff card', (await page.textContent('.org-search-count')) === 'พบ 1 คน' && (await page.$$('.org-canvas .org-node.is-hit')).length === 1);
  await page.fill('input[type=search]', '');
  await page.click('.org-zoombar [data-act="collapse-all"]');
  const roots = d.employees.filter((e) => !e.manager_id || !d.employees.some((x) => x.id === e.manager_id)).length;
  check('collapse all leaves the tree tops + the no-reporting-line block', (await page.$$('.org-canvas .org-node')).length === roots, String(roots));
  await page.click('.org-zoombar [data-act="expand-all"]');
  c = await chart(page);
  check('expand all: everyone back, still no overlap', c.nodes.length === d.employees.length && overlapping(c.nodes).length === 0);

  // all companies: one frame per company, no line across companies
  await open(page, '?company=');
  const dAll = await api(page, '');
  c = await chart(page);
  const comp = new Map(dAll.employees.map((e) => [e.id, e.company_id]));
  const withPeople = new Set(dAll.employees.map((e) => e.company_id));
  check('all companies: every employee once', c.nodes.length === dAll.employees.length && new Set(c.nodes.map((n) => n.id)).size === c.nodes.length);
  check('all companies: one titled frame per company with employees', c.groups.length === withPeople.size && c.groups.every((g) => g.title.includes('คน')), JSON.stringify(c.groups.map((g) => g.title)));
  check('all companies: every card inside its own company frame', c.nodes.every((n) => { const g = c.groups.find((x) => x.company === comp.get(n.id)); return g && n.x >= g.x && n.x + CW <= g.x + g.w; }));
  check('all companies: no line across companies', c.edges.every((e) => comp.get(e.from) === comp.get(e.to)));
  check('all companies: no overlap', overlapping(c.nodes).length === 0);
  check('demo company titles are not in the mapping → marked, not guessed', c.nodes.filter((n) => comp.get(n.id) === 1).every((n) => n.unmapped && n.level === 5));
  await page.screenshot({ path: join(OUT, 'all-1440.png') });

  // switch back to one company through the selector
  await page.selectOption('main select[aria-label="บริษัท"]', String(zzl.id));
  await page.waitForFunction(() => !document.querySelector('main .loading') && document.querySelector('.org-canvas svg'));
  await page.waitForTimeout(300);
  c = await chart(page);
  check('company selector switches to that company only', c.nodes.length === people.length && c.groups.length === 0);

  // table view keeps working and shows the level
  await page.goto(`${BASE}/org-chart?company=${zzl.id}&view=table`);
  await page.waitForSelector('main table thead th');
  const head = await page.$$eval('main table thead th', (x) => x.map((t) => t.textContent));
  check('table view: level column', head.includes('ระดับในผัง') && (await page.textContent('main table tbody')).includes('L2 · AMD'));
  await ctx.close();

  // desktop / laptop widths: no page overflow, chart fits, nothing overlaps
  // ======= acceptance: Readable Fit / Whole Chart Fit / detail drawer at desktop and laptop widths =======
  const vbOf = (pg) => pg.$eval('.org-canvas svg', (x) => x.getAttribute('viewBox'));
  const scaleOf = (pg) => pg.$eval('.org-canvas svg', (x) => Number(x.dataset.scale));
  const geo = (pg, ids) => pg.evaluate((want) => {
    const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
    const cv = r(document.querySelector('.org-canvas')); const zb = r(document.querySelector('.org-zoombar'));
    const cards = [...document.querySelectorAll('.org-canvas .org-node')].map((n) => ({ id: Number(n.dataset.id), ...r(n.querySelector('.org-card')) }));
    const inside = (b) => b.l >= cv.l - 1 && b.r <= cv.r + 1 && b.t >= cv.t - 1 && b.b <= cv.b + 1;
    const under = (b) => b.l < zb.r && zb.l < b.r && b.t < zb.b && zb.t < b.b;
    return { cv, zb, overflow: document.documentElement.scrollWidth - innerWidth, allInside: cards.every(inside), underBar: cards.filter(under).length,
      wantVisible: want.every((wid) => { const c = cards.find((x) => x.id === wid); return c && inside(c) && !under(c); }), nameH: document.querySelector('.org-canvas .org-t1').getBoundingClientRect().height };
  }, ids);
  for (const vp of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }, { width: 1366, height: 768 }, { width: 1280, height: 800 }]) {
    const tag = `${vp.width}×${vp.height}`;
    const s = await session(vp);
    const pg = s.page;
    await open(pg, `?company=${zzl.id}`);
    // Whole Chart Fit: everything in view
    await pg.click('.org-zoombar [data-act="fit"]');
    const whole = await scaleOf(pg);
    const gw = await geo(pg, []);
    check(`${tag}: Whole Chart Fit shows the complete chart (all ${people.length} cards inside the canvas, none under the toolbar)`, gw.allInside && gw.underBar === 0 && (await pg.$$('.org-canvas .org-node')).length === people.length, JSON.stringify({ whole }));
    if (vp.width === 1440) {
      await pg.screenshot({ path: join(OUT, 'accept-1440-whole-fit.png') });
      await pg.locator('.org-canvas').screenshot({ path: join(OUT, 'accept-1440-whole-fit-canvas.png') });
    }
    // Readable Fit: ≥ 70 % when the whole chart would be smaller; MD / AMD in view
    await pg.click('.org-zoombar [data-act="readable-fit"]');
    const readable = await scaleOf(pg);
    const gr = await geo(pg, [id('L01'), id('L02')]);
    check(`${tag}: Readable Fit uses ≥ 70% when Whole Chart Fit is below 70%`, whole >= 0.7 ? Math.abs(readable - whole) < 0.001 : readable >= 0.7 - 1e-9, `whole ${Math.round(whole * 100)}% → readable ${Math.round(readable * 100)}%`);
    check(`${tag}: MD / AMD visible at the Readable Fit start (not under the toolbar)`, gr.wantVisible);
    check(`${tag}: no horizontal page overflow`, gr.overflow <= 0, String(gr.overflow));
    console.log(`INFO  ${tag}: Whole Chart Fit ${Math.round(whole * 100)}% · Readable Fit ${Math.round(readable * 100)}% (name text ${gr.nameH.toFixed(1)}px high)`);
    if (vp.width === 1440 || vp.width === 1920) {
      await pg.screenshot({ path: join(OUT, `accept-${vp.width}-readable-fit.png`) });
      await pg.locator('.org-canvas').screenshot({ path: join(OUT, `accept-${vp.width}-readable-fit-canvas.png`) });
    }
    // the chart opens readable: a fresh load starts at Readable Fit
    await open(pg, `?company=${zzl.id}`);
    check(`${tag}: the page opens at Readable Fit`, Math.abs((await scaleOf(pg)) - readable) < 0.001);
    // every employee stays reachable: all cards exist in the chart (pan / zoom away), none removed
    check(`${tag}: every employee is in the chart at Readable Fit`, (await pg.$$('.org-canvas .org-node')).length === people.length);
    // detail drawer: opening and closing keep zoom and pan; the toolbar stays usable beside it
    const before = await vbOf(pg);
    await pg.click(`.org-canvas [data-id="${id('L02')}"] .org-card`);
    await pg.waitForSelector('.org-stage.has-drawer .org-side');
    const dg = await pg.evaluate(() => {
      const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom }; };
      const dr = r(document.querySelector('.org-side')); const zb = r(document.querySelector('.org-zoombar')); const cv = r(document.querySelector('.org-canvas'));
      return { dr, zb, cv, overlap: dr.l < zb.r && zb.l < dr.r && dr.t < zb.b && zb.t < dr.b };
    });
    const opened = await vbOf(pg);
    const drawerText = await pg.innerText('.org-side');
    check(`${tag}: drawer opens on card click with the employee details`, drawerText.includes('L2 · AMD') && drawerText.includes('หัวหน้า (Reports To)'));
    check(`${tag}: opening the drawer keeps zoom and pan`, opened === before, `${before} → ${opened}`);
    check(`${tag}: the drawer never covers the zoom toolbar; the canvas keeps its full width`, !dg.overlap && dg.zb.r <= dg.dr.l && Math.abs((dg.cv.r - dg.cv.l) - (gw.cv.r - gw.cv.l)) < 1, JSON.stringify(dg));
    if (vp.width === 1440) await pg.screenshot({ path: join(OUT, 'accept-1440-drawer-open.png') });
    await pg.click('.org-zoombar [data-act="zoom-in"]');
    const zoomed = await vbOf(pg);
    check(`${tag}: zoom works with the drawer open`, zoomed !== opened);
    await pg.click('.org-side [data-act="close-detail"]');
    check(`${tag}: closing the drawer keeps zoom and pan`, (await vbOf(pg)) === zoomed && !(await pg.$('.org-stage.has-drawer')));
    await pg.click(`.org-canvas [data-id="${id('L02')}"] .org-card`);
    await pg.keyboard.press('Escape');
    check(`${tag}: Escape closes the drawer, view unchanged`, !(await pg.$('.org-stage.has-drawer')) && (await vbOf(pg)) === zoomed);
    // search and department filter still work
    await pg.fill('input[type=search]', 'ZLS16');
    await pg.waitForTimeout(250);
    const hit = await geo(pg, [id('S16')]);
    check(`${tag}: search finds a card and brings it into view`, (await pg.textContent('.org-search-count')) === 'พบ 1 คน' && hit.wantVisible);
    await pg.fill('input[type=search]', '');
    const ops = d.departments.find((x) => x.code === 'ZL-OPS');
    await pg.click(`.org-chip[data-dept="${ops.id}"]`);
    await pg.waitForTimeout(250);
    const opsMembers = d.employees.filter((e) => e.department_id === ops.id).length;
    const shown = await pg.$$eval('.org-canvas .org-node:not(.is-context)', (x) => x.length);
    check(`${tag}: department filter shows that department (${opsMembers} members)`, shown === opsMembers, `${shown}`);
    const lg = await pg.$$eval('.org-legend .org-legend-item', (x) => x.map((i) => ({ dept: i.dataset.dept, ctx: i.classList.contains('is-context') })));
    check(`${tag}: legend follows the department filter (that department + context managers only)`, lg.some((l) => l.dept === String(ops.id) && !l.ctx) && lg.every((l) => l.dept === String(ops.id) || l.ctx), JSON.stringify(lg));
    await pg.click('.org-chip[data-dept=""]');
    await pg.waitForTimeout(250);
    const cc = await chart(pg);
    check(`${tag}: all ${people.length} cards back, no overlap, lines from real managers`, cc.nodes.length === people.length && overlapping(cc.nodes).length === 0 && cc.edges.every((e) => mgrOf.get(e.to) === e.from));
    await s.ctx.close();
  }
} finally {
  await browser.close();
  stopServer(dev);
}
check('the chart sent no write request to /api/org-design', writes.length === 0, writes.join(' | '));
check('no console errors / page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-org-layout pass=${results.length - fail} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
