// Cross Company Manager Assignment in the browser (local only; fresh local D1 + seeds/demo.sql + two synthetic companies
// "ZQA" / "ZQB" written by SQL with the approved production titles — no production data). Checks the assignment screen
// (list, search manager across companies, search employee, create with confirmation, edit, history, pause, cancel,
// search / filter) and the organization chart (global / single company / department views): reference card in the
// target team with a dashed violet line to the real card and to the named employee, never across a card; level bands,
// card positions, department colours and the headcount unchanged; relationship legend next to the department legend;
// detail drawer; search; SVG export; table column; an own-company user sees the other company masked; 1920 / 1440 /
// 1366 / 768 / 375 in light and dark; before / after screenshots; no console errors.
// usage: node tests/ui/ui-cross-company.mjs [--out <dir>]
import { chromium } from 'playwright-core';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { ROOT, EXE, SERVER_SPAWN, arg, outDir, freePort, stopServer } from './lib/env.mjs';

const W = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const OUT = arg('out') || outDir('cross-company');
mkdirSync(OUT, { recursive: true });
const run = (args, env = {}) => execFileSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, CI: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

run(['scripts/build-web.mjs']);
const persist = join('.tmp', `cross-company-${Date.now()}`);
run([W, 'd1', 'migrations', 'apply', 'hr-system-db', '--local', '--persist-to', persist]);
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', 'seeds/demo.sql']);

// ---- synthetic companies ZQA (responsible people) and ZQB (target teams) ----
const people = [
  ['A01', 'ZQA', 'ZQA-MGT', null, 'Manager Director'],
  ['A02', 'ZQA', 'ZQA-MGT', 'A01', 'Asst. Managing Director'],
  ['A03', 'ZQA', 'ZQA-OPS', 'A02', 'Operations Manager'],
  ['A04', 'ZQA', 'ZQA-HR', 'A02', 'Human Resources Manager'],
  ...Array.from({ length: 5 }, (_, i) => [`A1${i}`, 'ZQA', 'ZQA-OPS', 'A03', 'Operations Officer']),
  ...Array.from({ length: 2 }, (_, i) => [`A2${i}`, 'ZQA', 'ZQA-HR', 'A04', 'HR Officer (Recruit & Training)']),
  ['B01', 'ZQB', 'ZQB-MGT', null, 'Manager Director'],
  ['B02', 'ZQB', 'ZQB-MGT', 'B01', 'Operations Manager'],
  ['B03', 'ZQB', 'ZQB-CON', 'B02', 'Operations Leader'],
  ['B04', 'ZQB', 'ZQB-LIV', 'B02', 'Customer Service Leader'],
  ...Array.from({ length: 4 }, (_, i) => [`B1${i}`, 'ZQB', 'ZQB-CON', 'B03', 'Operations Officer']),
  ...Array.from({ length: 3 }, (_, i) => [`B2${i}`, 'ZQB', 'ZQB-LIV', 'B04', 'LiveStreaming']),
];
const titles = [...new Set(people.map((p) => p[4]))];
const fixture = join(persist, 'cross-fixture.sql');
writeFileSync(fixture, [
  "INSERT INTO companies (code, name, active) VALUES ('ZQA', 'บริษัท ทดสอบ ต้นทาง จำกัด', 1), ('ZQB', 'บริษัท ทดสอบ ปลายทาง จำกัด', 1);",
  ...[['ZQA-MGT', 'ZQA', 'Management'], ['ZQA-OPS', 'ZQA', 'Operations'], ['ZQA-HR', 'ZQA', 'Human Resources'], ['ZQB-MGT', 'ZQB', 'Management'], ['ZQB-CON', 'ZQB', 'Content'], ['ZQB-LIV', 'ZQB', 'Live']]
    .map(([code, co, name]) => `INSERT INTO departments (code, name, company_id, active) VALUES ('${code}', '${name}', (SELECT id FROM companies WHERE code = '${co}'), 1);`),
  ...titles.map((t, i) => `INSERT INTO positions (code, title, active, headcount) VALUES ('ZQ-P${i}', '${t}', 1, 10);`),
  ...people.map(([code, co, dep, , title]) => `INSERT INTO employees (emp_code, first_name, last_name, company_id, department_id, position_id, hire_date, employment_type, status) VALUES ('ZQ${code}', 'ทดสอบ${code}', 'ข้ามบริษัท', (SELECT id FROM companies WHERE code = '${co}'), (SELECT id FROM departments WHERE code = '${dep}'), (SELECT id FROM positions WHERE code = 'ZQ-P${titles.indexOf(title)}'), '2024-01-02', 'permanent', 'active');`),
  ...people.filter((p) => p[3]).map(([code, , , mgr]) => `UPDATE employees SET manager_id = (SELECT id FROM employees WHERE emp_code = 'ZQ${mgr}') WHERE emp_code = 'ZQ${code}';`),
  // an own-company viewer of ZQB (org chart only, no employees.all, not privileged)
  "INSERT INTO roles (code, name, description, privileged, system) VALUES ('zq_viewer', 'ZQ Viewer', 'test', 0, 0);",
  "INSERT INTO role_permissions (role_id, permission) SELECT id, 'org_chart.view' FROM roles WHERE code = 'zq_viewer';",
].join('\n'));
run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', fixture]);

const pw = `Cc-${randomBytes(9).toString('base64url')}-7q`;
for (const [user, role, emp] of [['cc_admin', 'super_admin', null], ['cc_viewer', 'zq_viewer', 'ZQB03']]) {
  const uf = join(persist, `${user}.sql`);
  run(['scripts/create-user.mjs', '--username', user, '--display', `ทดสอบ ${user}`, '--out', uf, '--cred-file', join(persist, 'c.txt'), '--role', role, ...(emp ? ['--employee', emp] : [])], { NEW_USER_PASSWORD: pw });
  run([W, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', persist, '--file', uf]);
}
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
const browser = await chromium.launch({ executablePath: EXE });
let secret = null;

async function session(viewport, theme = 'light', user = 'cc_admin', extra = {}) {
  const ctx = await browser.newContext({ viewport, colorScheme: theme, locale: 'th-TH', acceptDownloads: true, ...extra });
  await ctx.addInitScript((t) => { try { localStorage.setItem('hr.theme', t); } catch { /* none */ } }, theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${theme} ${viewport.width}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${theme} ${viewport.width}: ${m.text()}`); });
  await page.goto(BASE + '/login'); await page.waitForSelector('input[name=username]');
  await page.fill('input[name=username]', user); await page.fill('input[name=password]', pw); await page.click('button.auth-submit');
  await page.waitForSelector('nav.sidebar, button:has-text("เริ่มตั้งค่า MFA"), input[name=totp]:visible');
  if (await page.$('button:has-text("เริ่มตั้งค่า MFA")')) {
    await page.click('button:has-text("เริ่มตั้งค่า MFA")');
    secret = (await page.textContent('code.secret')).trim();
    await page.fill('.mfa-setup input', await totp(secret)); await page.click('text=ยืนยันและเปิดใช้');
  } else if (await page.$('input[name=totp]:visible')) { await page.fill('input[name=totp]', await totp(secret)); await page.click('button.auth-submit'); }
  await page.waitForSelector('nav.sidebar');
  return { ctx, page };
}
const openChart = async (page, query = '') => {
  await page.goto(`${BASE}/org-chart${query}`);
  await page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .loading') && document.querySelector('.org-canvas svg'));
  await page.waitForTimeout(400);
};
const openList = async (page, query = '') => {
  await page.goto(`${BASE}/org-chart/assignments${query}`);
  await page.waitForFunction(() => document.querySelector('main') && !document.querySelector('main .loading') && (document.querySelector('.cca-table') || document.querySelector('main .empty')));
};
// chart geometry in SVG units: real cards, reference cards, dashed lines (as segments), frames, bands, legend
const chart = (page) => page.evaluate(() => {
  const tr = (g) => { const m = /translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform')); return [Number(m[1]), Number(m[2])]; };
  const nodes = [...document.querySelectorAll('.org-canvas .org-node')].map((g) => { const [x, y] = tr(g); return { id: Number(g.dataset.id), x, y, level: Number(g.dataset.level), color: g.dataset.color, badge: g.querySelector('.org-cross-badge text')?.textContent ?? null }; });
  const refs = [...document.querySelectorAll('.org-canvas .org-ref')].map((g) => { const [x, y] = tr(g); return { key: g.dataset.ref, person: Number(g.dataset.person), target: Number(g.dataset.targetCompany), dept: Number(g.dataset.dept), x, y, text: g.textContent, masked: g.classList.contains('is-masked'), hit: g.classList.contains('is-hit'), dash: g.querySelector('.org-ref-card').getAttribute('stroke-dasharray') }; });
  const links = [...document.querySelectorAll('.org-canvas .org-link')].map((g) => {
    const path = g.querySelector('path');
    const pts = path.getAttribute('d').split(/(?=[ML])/).map((s) => s.slice(1).split(',').map(Number));
    return { ref: g.dataset.ref, to: Number(g.dataset.to), kind: g.dataset.kind, dash: path.getAttribute('stroke-dasharray'), stroke: getComputedStyle(path).stroke, pts };
  });
  const frames = [...document.querySelectorAll('.org-canvas .org-ref-frame')].map((g) => ({ company: Number(g.dataset.company), dept: Number(g.dataset.dept), title: g.querySelector('text').textContent }));
  const edges = [...document.querySelectorAll('.org-canvas .org-edge')].map((p) => ({ from: Number(p.dataset.from), to: Number(p.dataset.to), dash: p.getAttribute('stroke-dasharray') }));
  const bands = [...document.querySelectorAll('.org-canvas .org-band-label')].map((t) => ({ level: Number(t.dataset.level), y: Number(t.dataset.y) }));
  const legendDept = [...document.querySelectorAll('.org-legend .org-legend-item')].map((x) => x.dataset.dept);
  const legendRel = [...document.querySelectorAll('.org-legend .org-legend-rel-item')].map((x) => x.dataset.rel);
  const rail = [...document.querySelectorAll('.org-level-rail .org-level-pill')].filter((p) => p.offsetParent !== null).length;
  const kpi = document.querySelector('.kpis .kpi .kpi-value')?.textContent;
  return { nodes, refs, links, frames, edges, bands, legendDept, legendRel, rail, kpi, hscroll: document.documentElement.scrollWidth > innerWidth + 1 };
});
const CW = 210, CH = 66;
const hits = (a, b, r) => { const x0 = Math.min(a[0], b[0]), x1 = Math.max(a[0], b[0]), y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1]); return x1 > r.x + 1 && x0 < r.x + CW - 1 && y1 > r.y + 1 && y0 < r.y + CH - 1; };
const crossings = (c) => { const cards = [...c.nodes, ...c.refs]; let n = 0; for (const l of c.links) for (let i = 1; i < l.pts.length; i++) for (const r of cards) if (hits(l.pts[i - 1], l.pts[i], r)) n++; return n; };
const overlapsOf = (c) => { const cards = [...c.nodes, ...c.refs]; let n = 0; for (let i = 0; i < cards.length; i++) for (let j = i + 1; j < cards.length; j++) { const a = cards[i], b = cards[j]; if (a.x < b.x + CW && b.x < a.x + CW && a.y < b.y + CH && b.y < a.y + CH) n++; } return n; };

let ids = {};
try {
  const s = await session({ width: 1440, height: 900 });
  const pg = s.page;
  const d0 = await pg.evaluate(async () => (await fetch('/api/org-design')).json());
  ids = Object.fromEntries(d0.employees.map((e) => [e.emp_code, e.id]));
  const co = Object.fromEntries(d0.companies.map((c) => [c.code, c.id]));
  const dep = Object.fromEntries(d0.departments.map((x) => [x.code, x.id]));

  // ======================= before =======================
  await openChart(pg, `?company=${co.ZQB}`);
  await pg.screenshot({ path: join(OUT, 'before-1440-company-ZQB.png') });
  const beforeB = await chart(pg);
  await openChart(pg, '?company=');
  await pg.click('.org-zoombar [data-act="fit"]');
  await pg.screenshot({ path: join(OUT, 'before-1440-global.png') });
  const before = await chart(pg);
  check('before: no reference card, no dashed relationship line', before.refs.length === 0 && before.links.length === 0);
  check('before: relationship legend shows the two line kinds next to the department legend', before.legendRel.join() === 'primary,cross' && before.legendDept.length > 0, before.legendRel.join());

  // ======================= assignment screen =======================
  await openList(pg);
  check('assignment list: empty state and create button', !!(await pg.$('main .empty')) && !!(await pg.$('[data-act="create"]')));
  const create = async ({ manager, company, dept, team, type, employee, resp }) => {
    await pg.click('[data-act="create"]');
    await pg.waitForSelector('.modal input[name=manager_search]');
    await pg.fill('.modal input[name=manager_search]', manager);
    await pg.waitForSelector(`.modal .cca-result[data-code="${manager}"]`);
    await pg.click(`.modal .cca-result[data-code="${manager}"]`);
    await pg.selectOption('.modal select[name=target_company_id]', String(company));
    await pg.selectOption('.modal select[name=target_department_id]', String(dept));
    if (team) await pg.fill('.modal input[name=team_name]', team);
    await pg.selectOption('.modal select[name=relationship_type]', type);
    if (resp) await pg.fill('.modal textarea[name=responsibility]', resp);
    if (employee) {
      await pg.fill('.modal input[name=employee_search]', employee);
      await pg.waitForSelector(`.modal .cca-result[data-code="${employee}"]`);
      await pg.click(`.modal .cca-result[data-code="${employee}"]`);
    }
    const summary = await pg.textContent('.modal .cca-sentence');
    await pg.click('.modal [data-act="save"]');
    await pg.waitForSelector('.modal .cca-sentence[data-saved]');
    const saved = await pg.textContent('.modal .cca-sentence[data-saved]');
    await pg.click('.modal .modal-actions button.primary');
    await pg.waitForFunction(() => !document.querySelector('.modal'));
    return { summary, saved };
  };
  // manager search across companies: the picker offers the other company's people, not the target company's
  await pg.click('[data-act="create"]');
  await pg.selectOption('.modal select[name=target_company_id]', String(co.ZQB));
  await Promise.all([pg.waitForResponse((r) => r.url().includes('/api/org-assignments/people') && r.url().includes(`exclude_company=${co.ZQB}`) && r.url().includes('q=ZQ')), pg.fill('.modal input[name=manager_search]', 'ZQ')]);
  await pg.waitForTimeout(150);
  const offered = await pg.$$eval('.modal .cca-result[data-code]', (x) => x.map((b) => b.dataset.code));
  check('search manager across companies: other companies offered, none of the target company', offered.some((c) => c.startsWith('ZQA')) && !offered.some((c) => c.startsWith('ZQB')), offered.join(','));
  await pg.screenshot({ path: join(OUT, 'assign-1440-create-form.png') });
  await pg.click('.modal .modal-head .icon-btn');
  const c1 = await create({ manager: 'ZQA02', company: co.ZQB, dept: dep['ZQB-CON'], team: 'Content Team', type: 'team_lead', resp: 'ดูแลงานผลิต Content' });
  check('create: the summary says who, which team, which company and from when', /ZQA02.*ZQA.*Team Lead.*Content \/ Content Team.*ZQB.*ทั้งทีม.*ตั้งแต่/.test(c1.summary), c1.summary);
  check('create: confirmation after save', c1.saved.includes('ZQA02') && c1.saved.includes('Content Team'));
  const c2 = await create({ manager: 'ZQA03', company: co.ZQB, dept: dep['ZQB-LIV'], team: 'Live Team', type: 'functional_manager', employee: 'ZQB20' });
  check('create with a named employee (search employee in the target company)', c2.saved.includes('ดูแล ZQB20'), c2.saved);
  await create({ manager: 'ZQA04', company: co.ZQB, dept: dep['ZQB-CON'], team: 'Project X', type: 'project_lead' });
  let rows = await pg.$$eval('.cca-table tbody tr', (x) => x.map((r) => ({ id: Number(r.dataset.id), state: r.dataset.state, text: r.textContent })));
  check('assignment list shows the three rows with manager, companies, team, type, dates, status, updated by', rows.length === 3 && rows.every((r) => r.state === 'active') && rows.some((r) => r.text.includes('ZQA02') && r.text.includes('Content / Content Team') && r.text.includes('cc_admin')), JSON.stringify(rows.map((r) => r.text.slice(0, 80))));
  await pg.screenshot({ path: join(OUT, 'assign-1440-list.png') });
  // edit
  const live = rows.find((r) => r.text.includes('Live Team'));
  await pg.click(`.cca-table tr[data-id="${live.id}"] [data-act="edit"]`);
  await pg.waitForSelector('.modal input[name=team_name]');
  await pg.fill('.modal input[name=team_name]', 'Live Studio');
  await pg.fill('.modal input[name=reason]', 'เปลี่ยนชื่อทีม');
  await pg.click('.modal [data-act="save"]');
  await pg.waitForSelector('.modal .cca-sentence[data-saved]');
  await pg.click('.modal .modal-actions button.primary');
  await pg.waitForFunction(() => !document.querySelector('.modal'));
  check('edit: the list shows the new team name', (await pg.textContent(`.cca-table tr[data-id="${live.id}"]`)).includes('Live Studio'));
  // history
  await pg.click(`.cca-table tr[data-id="${live.id}"] [data-act="detail"]`);
  await pg.waitForSelector('.modal .cca-history');
  const hist = await pg.$$eval('.modal .cca-history > li', (x) => x.map((l) => ({ a: l.dataset.action, t: l.textContent })));
  check('history: created and updated, with the reason and before → after', hist.map((x) => x.a).join() === 'created,updated' && hist[1].t.includes('เปลี่ยนชื่อทีม') && hist[1].t.includes('Live Team → Live Studio'), JSON.stringify(hist));
  await pg.screenshot({ path: join(OUT, 'assign-1440-history.png') });
  await pg.click('.modal .modal-actions button.primary');
  // cancel
  const px = rows.find((r) => r.text.includes('Project X'));
  await pg.click(`.cca-table tr[data-id="${px.id}"] [data-act="cancel"]`);
  await pg.waitForSelector('.modal textarea');
  await pg.fill('.modal textarea', 'โครงการยุติ');
  await pg.click('.modal button:has-text("ยืนยันยกเลิก")');
  await pg.waitForFunction((rid) => document.querySelector(`.cca-table tr[data-id="${rid}"]`)?.dataset.state === 'cancelled', px.id);
  check('cancel: kept in the list as cancelled, no more actions', !(await pg.$(`.cca-table tr[data-id="${px.id}"] [data-act="edit"]`)));
  // search / filter
  await pg.fill('main input[name=q]', 'Studio');
  await pg.waitForFunction(() => document.querySelectorAll('.cca-table tbody tr').length === 1);
  check('list search', (await pg.textContent('.cca-table tbody')).includes('Live Studio'));
  await pg.fill('main input[name=q]', '');
  await pg.waitForFunction(() => document.querySelectorAll('.cca-table tbody tr').length === 3);
  await pg.selectOption('main select[name=state]', 'cancelled');
  await pg.waitForFunction(() => document.querySelectorAll('.cca-table tbody tr').length === 1 && document.querySelector('.cca-table tbody').textContent.includes('Project X'));
  check('list status filter', (await pg.textContent('.cca-table tbody')).includes('Project X'));

  // ======================= organization chart: global view =======================
  await openChart(pg, '?company=');
  await pg.click('.org-zoombar [data-act="fit"]');
  const g = await chart(pg);
  const refA02 = g.refs.find((r) => r.person === ids.ZQA02);
  const refA03 = g.refs.find((r) => r.person === ids.ZQA03);
  check('global: one reference card per active assignment (cancelled one not drawn), in the target company', g.refs.length === 2 && !!refA02 && !!refA03 && g.refs.every((r) => r.target === co.ZQB && r.dash), JSON.stringify(g.refs.map((r) => r.key)));
  check('global: the reference cards are marked "อ้างอิงข้ามบริษัท" with the source company', g.refs.every((r) => r.text.includes('อ้างอิงข้ามบริษัท') && r.text.includes('จาก ZQA')));
  check('global: frames name the target department / team', g.frames.length === 2 && g.frames.some((f) => f.title.includes('Content / Content Team')) && g.frames.some((f) => f.title.includes('Live / Live Studio')), JSON.stringify(g.frames));
  const lk = (ref, to) => g.links.find((l) => l.ref === ref.key && l.to === to);
  check('global: dashed line from each reference card to the real person’s card', !!lk(refA02, ids.ZQA02) && !!lk(refA03, ids.ZQA03) && lk(refA02, ids.ZQA02).kind === 'person');
  check('global: dashed line to the named employee in the target team', !!lk(refA03, ids.ZQB20) && lk(refA03, ids.ZQB20).kind === 'employee' && !g.links.some((l) => l.to === ids.ZQB21));
  check('global: cross company lines are dashed violet, primary lines solid grey', g.links.every((l) => l.dash === '7 5' && l.stroke === 'rgb(124, 58, 237)') && g.edges.every((e) => !e.dash), JSON.stringify(g.links.map((l) => [l.dash, l.stroke])));
  check('global: no dashed line crosses a card', crossings(g) === 0, String(crossings(g)));
  check('global: no card overlaps (cards and reference cards)', overlapsOf(g) === 0);
  check('global: no duplicate employee and headcount unchanged', g.nodes.length === before.nodes.length && new Set(g.nodes.map((n) => n.id)).size === g.nodes.length && g.kpi === before.kpi, `${g.kpi} / ${before.kpi}`);
  const bys = (c) => Object.fromEntries(c.nodes.map((n) => [n.id, n.y]));
  const bY = bys(before);
  check('global: L1–L5 unchanged (bands and every card’s band row)', JSON.stringify(g.bands) === JSON.stringify(before.bands) && g.nodes.every((n) => bY[n.id] === n.y) && g.rail === 5);
  const bC = Object.fromEntries(before.nodes.map((n) => [n.id, n.color]));
  check('global: department colours unchanged', g.nodes.every((n) => bC[n.id] === n.color));
  check('global: primary reporting lines unchanged', JSON.stringify(g.edges.map((e) => `${e.from}>${e.to}`).sort()) === JSON.stringify(before.edges.map((e) => `${e.from}>${e.to}`).sort()));
  check('global: reference card on the band of the person’s level (AMD → L2, Manager → L3)', refA02.y === g.bands.find((b) => b.level === 2).y && refA03.y === g.bands.find((b) => b.level === 3).y);
  check('global: legend has the departments and the relationship kinds (incl. reference card)', g.legendDept.length === before.legendDept.length && g.legendRel.join() === 'primary,cross,ref', g.legendRel.join());
  check('global: the responsible person’s card carries a "ข้ามบริษัท" badge', g.nodes.find((n) => n.id === ids.ZQA02).badge === 'ข้ามบริษัท 1' && g.nodes.find((n) => n.id === ids.ZQB20).badge === 'ข้ามบริษัท 1');
  await pg.screenshot({ path: join(OUT, 'after-1440-global.png') });
  // reference → real person in the drawer
  await pg.click('.org-zoombar [data-act="readable-fit"]');
  await pg.evaluate((k) => document.querySelector(`.org-canvas .org-ref[data-ref="${k}"]`).dispatchEvent(new window.MouseEvent('click', { bubbles: true })), refA02.key);
  await pg.waitForSelector('.org-side .org-cross-detail');
  const drawer = await pg.textContent('.org-side');
  check('employee detail drawer: clicking the reference opens the real person with the cross company responsibility', drawer.includes('ทดสอบA02') && drawer.includes('ความรับผิดชอบข้ามบริษัท') && drawer.includes('Content / Content Team · ZQB'), drawer.slice(0, 200));
  await pg.screenshot({ path: join(OUT, 'after-1440-global-drawer.png') });
  await pg.click('.org-side [data-act="close-detail"]');
  // search marks the card and its reference
  await pg.fill('.org-toolbar input[type=search]', 'ZQA02');
  await pg.waitForTimeout(300);
  const sr = await chart(pg);
  check('search: the person and their reference card are highlighted', (await pg.textContent('.org-search-count')) === 'พบ 1 คน' && sr.refs.find((r) => r.person === ids.ZQA02).hit);
  await pg.fill('.org-toolbar input[type=search]', '');
  // SVG export carries the relationship lines and reference cards
  await pg.click('.org-toolbar summary:has-text("Export")');
  const [dl] = await Promise.all([pg.waitForEvent('download'), pg.click('.menu-pop button:has-text("SVG")')]);
  const svgText = readFileSync(await dl.path(), 'utf8');
  check('export (SVG): dashed lines and reference cards included', svgText.includes('org-link') && svgText.includes('org-ref') && svgText.includes('อ้างอิงข้ามบริษัท'));
  // table view column
  await pg.goto(`${BASE}/org-chart?company=&view=table`);
  await pg.waitForSelector('main table thead th');
  const head = await pg.$$eval('main table thead th', (x) => x.map((t) => t.textContent));
  check('table view: cross company column', head.includes('ความรับผิดชอบข้ามบริษัท') && (await pg.textContent('main table tbody')).includes('Team Lead → Content / Content Team (ZQB)'));

  // ======================= single company + department views =======================
  await openChart(pg, `?company=${co.ZQB}`);
  const b = await chart(pg);
  check('company view (target): reference cards in the target teams, line to the named employee, no line out of the company', b.refs.length === 2 && b.links.length === 1 && b.links[0].to === ids.ZQB20 && crossings(b) === 0 && overlapsOf(b) === 0);
  check('company view (target): cards, bands and colours unchanged; headcount unchanged', b.nodes.length === beforeB.nodes.length && b.kpi === beforeB.kpi && b.nodes.every((n) => beforeB.nodes.find((x) => x.id === n.id)?.y === n.y && beforeB.nodes.find((x) => x.id === n.id)?.color === n.color));
  await pg.screenshot({ path: join(OUT, 'after-1440-company-ZQB.png') });
  await pg.evaluate((k) => document.querySelector(`.org-canvas .org-ref[data-ref="${k}"]`).dispatchEvent(new window.MouseEvent('click', { bubbles: true })), refA02.key);
  await pg.waitForSelector('.org-side .org-context-note.is-cross');
  const refDrawer = await pg.textContent('.org-side');
  check('company view: the reference detail names the person, the source company and says it is not headcount', refDrawer.includes('ทดสอบA02') && refDrawer.includes('ZQA') && refDrawer.includes('ไม่นับรวม Headcount'));
  await pg.click('.org-side [data-act="close-detail"]');
  await openChart(pg, `?company=${co.ZQA}`);
  const a = await chart(pg);
  check('company view (source): no reference (target not on this chart); badges on the responsible people', a.refs.length === 0 && a.links.length === 0 && a.nodes.find((n) => n.id === ids.ZQA02).badge === 'ข้ามบริษัท 1');
  await openChart(pg, `?company=${co.ZQB}&dept=${dep['ZQB-CON']}`);
  const dc = await chart(pg);
  check('department view (Content): only the Content reference', dc.refs.length === 1 && dc.refs[0].person === ids.ZQA02 && overlapsOf(dc) === 0);
  await openChart(pg, `?company=${co.ZQB}&dept=${dep['ZQB-LIV']}`);
  const dl2 = await chart(pg);
  check('department view (Live): the Live reference and its line to the named employee', dl2.refs.length === 1 && dl2.refs[0].person === ids.ZQA03 && dl2.links.length === 1 && crossings(dl2) === 0);
  await s.ctx.close();

  // ======================= own-company viewer: other company masked =======================
  const v = await session({ width: 1440, height: 900 }, 'light', 'cc_viewer');
  await openChart(v.page, '');
  const vc = await chart(v.page);
  const body = await v.page.textContent('main');
  check('own-company viewer: reference cards shown masked ("ผู้รับผิดชอบจากต่างบริษัท", company only), no name of the other company', vc.refs.length === 2 && vc.refs.every((r) => r.masked && r.text.includes('ผู้รับผิดชอบจากต่างบริษัท') && r.text.includes('ZQA')) && !body.includes('ทดสอบA02') && !body.includes('ทดสอบA03'));
  await v.page.screenshot({ path: join(OUT, 'after-1440-viewer-masked.png') });
  await v.ctx.close();

  // ======================= responsive + themes =======================
  for (const [vp, theme] of [[{ width: 1920, height: 1080 }, 'light'], [{ width: 1440, height: 900 }, 'dark'], [{ width: 1366, height: 768 }, 'light'], [{ width: 1366, height: 768 }, 'dark'], [{ width: 768, height: 1024 }, 'dark'], [{ width: 768, height: 1024 }, 'light'], [{ width: 375, height: 812 }, 'light'], [{ width: 375, height: 812 }, 'dark']]) {
    const r = await session(vp, theme, 'cc_admin', vp.width < 800 ? { hasTouch: true, isMobile: vp.width < 600 } : {});
    const tag = `${vp.width}×${vp.height} ${theme}`;
    for (const [view, q] of [['global', '?company='], ['company', `?company=${co.ZQB}`]]) {
      await openChart(r.page, q);
      await r.page.click('.org-zoombar [data-act="fit"]');
      await r.page.waitForTimeout(200);
      const c = await chart(r.page);
      const want = theme === 'dark' ? 'rgb(167, 139, 250)' : 'rgb(124, 58, 237)';
      check(`${tag} ${view}: references, dashed lines (${theme} colour), legend, 5-level rail, no overlap / crossing / page scroll`,
        c.refs.length === 2 && c.links.length >= 1 && c.links.every((l) => l.stroke === want) && c.legendRel.includes('cross') && c.rail === 5 && overlapsOf(c) === 0 && crossings(c) === 0 && !c.hscroll,
        JSON.stringify({ refs: c.refs.length, links: c.links.length, stroke: c.links[0]?.stroke, rail: c.rail, hs: c.hscroll }));
      await r.page.screenshot({ path: join(OUT, `after-${vp.width}x${vp.height}-${theme}-${view}.png`) });
    }
    await openList(r.page);
    const list = await r.page.evaluate(() => ({ rows: document.querySelectorAll('.cca-table tbody tr').length, hs: document.documentElement.scrollWidth > innerWidth + 1 }));
    check(`${tag}: assignment list renders (table scrolls inside its frame, not the page)`, list.rows === 3 && !list.hs, JSON.stringify(list));
    if (vp.width === 375 || vp.width === 1920) await r.page.screenshot({ path: join(OUT, `assign-${vp.width}-${theme}-list.png`) });
    await r.ctx.close();
  }
} finally {
  await browser.close();
  stopServer(dev);
}
check('no console errors / page errors', errors.length === 0, errors.slice(0, 5).join(' | '));
const fail = results.filter((r) => !r.ok).length;
console.log(`ui-cross-company pass=${results.length - fail} fail=${fail}  (screenshots: ${OUT})`);
process.exitCode = fail ? 1 : 0;
