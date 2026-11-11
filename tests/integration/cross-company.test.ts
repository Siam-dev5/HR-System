// Cross Company Manager Assignment (migration 0017, /api/org-assignments, /api/org-design crossCompany) — isolated
// local D1 with synthetic data only (companies ZXA / ZXB / ZXC). Covers create / update / status / cancel, validation
// (invalid employee / manager, same company, department of another company, dates, duplicate, loop), expired and
// scheduled assignments, history and audit, the organization chart payload (global / single company views, no
// duplicate identity, headcount unchanged), primary manager (manager_id) never changed, rows never deleted, and
// permissions (no permission, view only, own-company scope with masking and 403 / 404).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const id: Record<string, number> = {};
const one = (sql: string) => H.sql(sql)[0] as Record<string, any>;
const WRANGLER = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const shift = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
let managersBefore = '';
const managers = () => JSON.stringify(H.sql("SELECT id, manager_id, company_id, department_id FROM employees ORDER BY id"));

beforeAll(async () => {
  H = await startHarness();
  const people = [
    // code, company, dept, manager, title
    ['ZXA01', 'ZXA', 'ZXA-MGT', null, 'Manager Director'],
    ['ZXA02', 'ZXA', 'ZXA-MGT', 'ZXA01', 'Asst. Managing Director'],
    ['ZXA03', 'ZXA', 'ZXA-OPS', 'ZXA02', 'Operations Manager'],
    ['ZXA04', 'ZXA', 'ZXA-OPS', 'ZXA03', 'Operations Officer'],
    ['ZXB01', 'ZXB', 'ZXB-MGT', null, 'Manager Director'],
    ['ZXB02', 'ZXB', 'ZXB-CON', 'ZXB01', 'Operations Leader'],
    ['ZXB03', 'ZXB', 'ZXB-CON', 'ZXB02', 'Operations Officer'],
    ['ZXB04', 'ZXB', 'ZXB-LIV', 'ZXB01', 'LiveStreaming'],
    ['ZXB05', 'ZXB', 'ZXB-LIV', 'ZXB01', 'LiveStreaming'],
    ['ZXC01', 'ZXC', 'ZXC-MGT', null, 'Manager Director'],
  ];
  const sql = [
    "INSERT INTO companies (code, name, active) VALUES ('ZXA', 'ทดสอบ ZXA', 1), ('ZXB', 'ทดสอบ ZXB', 1), ('ZXC', 'ทดสอบ ZXC', 1);",
    ...[['ZXA-MGT', 'ZXA', 'Management'], ['ZXA-OPS', 'ZXA', 'Operations'], ['ZXB-MGT', 'ZXB', 'Management'], ['ZXB-CON', 'ZXB', 'Content'], ['ZXB-LIV', 'ZXB', 'Live'], ['ZXC-MGT', 'ZXC', 'Management']]
      .map(([code, co, name]) => `INSERT INTO departments (code, name, company_id, active) VALUES ('${code}', '${name}', (SELECT id FROM companies WHERE code = '${co}'), 1);`),
    "INSERT INTO departments (code, name, company_id, active) VALUES ('ZXB-OLD', 'Closed', (SELECT id FROM companies WHERE code = 'ZXB'), 0);",
    ...[...new Set(people.map((x) => x[4] as string))].map((t, i) => `INSERT INTO positions (code, title, active) VALUES ('ZX-P${i}', '${t}', 1);`),
    ...people.map(([code, co, dep, , title]) => `INSERT INTO employees (emp_code, first_name, last_name, company_id, department_id, position_id, hire_date, employment_type, status) VALUES ('${code}', 'ทดสอบ${code}', 'ข้ามบริษัท', (SELECT id FROM companies WHERE code = '${co}'), (SELECT id FROM departments WHERE code = '${dep}'), (SELECT id FROM positions WHERE title = '${title}' AND code LIKE 'ZX-P%'), '2024-01-02', 'permanent', 'active');`),
    "INSERT INTO employees (emp_code, first_name, last_name, company_id, department_id, hire_date, employment_type, status) VALUES ('ZXB09', 'ลาออก', 'ข้ามบริษัท', (SELECT id FROM companies WHERE code = 'ZXB'), (SELECT id FROM departments WHERE code = 'ZXB-CON'), '2024-01-02', 'permanent', 'terminated');",
    ...people.filter((p) => p[3]).map(([code, , , mgr]) => `UPDATE employees SET manager_id = (SELECT id FROM employees WHERE emp_code = '${mgr}') WHERE emp_code = '${code}';`),
    // an own-company HR role (no employees.all) for the scope tests
    "INSERT INTO roles (code, name, description, privileged, system) VALUES ('zx_org_hr', 'ZX Org HR', 'test', 0, 0);",
    "INSERT INTO role_permissions (role_id, permission) SELECT id, 'org_assignment.view' FROM roles WHERE code = 'zx_org_hr';",
    "INSERT INTO role_permissions (role_id, permission) SELECT id, 'org_assignment.manage' FROM roles WHERE code = 'zx_org_hr';",
    "INSERT INTO role_permissions (role_id, permission) SELECT id, 'org_chart.view' FROM roles WHERE code = 'zx_org_hr';",
  ].join('\n');
  H.sql(sql);
  for (const r of H.sql("SELECT id, emp_code FROM employees WHERE emp_code LIKE 'ZX%'")) id[String(r.emp_code)] = Number(r.id);
  for (const r of H.sql("SELECT id, code FROM companies WHERE code LIKE 'ZX%'")) id[String(r.code)] = Number(r.id);
  for (const r of H.sql("SELECT id, code FROM departments WHERE code LIKE 'ZX%'")) id[String(r.code)] = Number(r.id);
  // own-company account linked to ZXA02 (created the Production way)
  const out = join(H.dir, 'zx.sql');
  execFileSync(process.execPath, ['scripts/create-user.mjs', '--username', 'zx_hr', '--display', 'zx_hr', '--role', 'zx_org_hr', '--employee', 'ZXA02', '--out', out, '--cred-file', join(H.dir, 'zx-cred.txt')], { env: { ...process.env, NEW_USER_PASSWORD: 'Zx-Test-Password-91a' }, stdio: 'ignore' });
  execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', join(H.dir, 'state'), '--file', out], { env: { ...process.env, CI: '1' }, stdio: 'ignore' });
  managersBefore = managers();
  for (const [k, u, pw] of [['admin', 'it_admin', H.passwords.it_admin], ['staff', 'it_staff', H.passwords.it_staff], ['employee', 'it_employee', H.passwords.it_employee], ['zx', 'zx_hr', 'Zx-Test-Password-91a']] as const) {
    const cl = new Client(H.baseUrl);
    await cl.login(u, pw);
    c[k] = cl;
  }
}, 240_000);
afterAll(async () => {
  await H?.stop();
});

const A = () => c.admin as Client;
const base = () => ({ manager_employee_id: id.ZXA02, target_company_id: id.ZXB, target_department_id: id['ZXB-CON'], team_name: 'Content Team', employee_id: null, relationship_type: 'team_lead', responsibility: 'ดูแลงาน Content', effective_from: today, effective_to: null });
const chart = async (cl: Client, company?: number) => (await cl.get(`/api/org-design${company ? `?company=${company}` : ''}`)).body;

describe('migration 0017', () => {
  it('only creates the two tables (indexes, no-delete triggers) and grants the two new permissions', () => {
    const sql = readFileSync('migrations/0017_cross_company_assignments.sql', 'utf8').replace(/--.*$/gm, '');
    for (const st of sql.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) {
      expect(/^(CREATE (TABLE|INDEX|TRIGGER) |INSERT OR IGNORE INTO role_permissions\b|BEGIN|SELECT RAISE|END)/.test(st), st.slice(0, 60)).toBe(true);
    }
    expect(sql).not.toMatch(/UPDATE\s+employees|ALTER TABLE|DELETE FROM/i);
    expect(H.sql("SELECT r.code, rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission LIKE 'org_assignment.%' AND r.system = 1 ORDER BY 1, 2")).toEqual([
      { code: 'hr_admin', permission: 'org_assignment.manage' },
      { code: 'hr_admin', permission: 'org_assignment.view' },
      { code: 'hr_staff', permission: 'org_assignment.view' },
    ]);
  });
});

describe('create / chart / update / status / cancel', () => {
  it('HR creates a team assignment across companies; history + audit are written', async () => {
    const before = await chart(A());
    const r = await A().post('/api/org-assignments', base());
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ manager_employee_id: id.ZXA02, target_company_id: id.ZXB, state: 'active', manager_company_code: 'ZXA', target_department_name: 'Content', team_name: 'Content Team', manager_masked: false });
    id.team = r.body.id;
    expect(one(`SELECT manager_company_id, employee_id, status FROM cross_company_assignments WHERE id = ${id.team}`)).toEqual({ manager_company_id: id.ZXA, employee_id: null, status: 'active' });
    const hst = await A().get(`/api/org-assignments/${id.team}/history`);
    expect(hst.body.items.map((x: any) => x.action)).toEqual(['created']);
    expect(hst.body.names.employees[String(id.ZXA02)]).toContain('ZXA02');
    expect(one(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'org_assignment.created' AND entity_id = '${id.team}'`).n).toBe(1);
    // the chart shows it right away; no person is duplicated and the headcount does not change
    const after = await chart(A());
    expect(after.stats).toEqual(before.stats);
    expect(after.employees.length).toBe(before.employees.length);
    expect(new Set(after.employees.map((e: any) => e.id)).size).toBe(after.employees.length);
    const link = after.crossCompany.links.find((l: any) => l.id === id.team);
    expect(link).toMatchObject({ type: 'team_lead', manager_id: id.ZXA02, employee_id: null, target_company_id: id.ZXB, target_company_code: 'ZXB', target_department_name: 'Content', team_name: 'Content Team' });
    expect(after.crossCompany.people.find((p: any) => p.id === id.ZXA02)).toMatchObject({ masked: false, emp_code: 'ZXA02', company_code: 'ZXA', level: 2 });
  });
  it('a second, employee-specific assignment and a second team of the same person (multiple departments) are allowed', async () => {
    const r1 = await A().post('/api/org-assignments', { ...base(), employee_id: id.ZXB03, relationship_type: 'functional_manager' });
    expect(r1.status, r1.text).toBe(201);
    id.functional = r1.body.id;
    const r2 = await A().post('/api/org-assignments', { ...base(), target_department_id: id['ZXB-LIV'], team_name: 'Live Team', manager_employee_id: id.ZXA03 });
    expect(r2.status, r2.text).toBe(201);
    id.live = r2.body.id;
    const r3 = await A().post('/api/org-assignments', { ...base(), target_company_id: id.ZXC, target_department_id: id['ZXC-MGT'], team_name: null });
    expect(r3.status, r3.text).toBe(201);
    id.multiCompany = r3.body.id;
  });
  it('single company views: the target and the manager company see the link, an uninvolved company does not', async () => {
    const ids = (d: any) => d.crossCompany.links.map((l: any) => l.id).sort((a: number, b: number) => a - b);
    expect(ids(await chart(A(), id.ZXB))).toEqual(([id.team, id.functional, id.live] as number[]).sort((x, y) => x - y));
    expect(ids(await chart(A(), id.ZXA))).toEqual(([id.team, id.functional, id.live, id.multiCompany] as number[]).sort((x, y) => x - y));
    expect(ids(await chart(A(), id.ZXC))).toEqual([id.multiCompany]);
    // a person of another company is listed for the link, but never added to the employees (no duplicate identity)
    const b = await chart(A(), id.ZXB);
    expect(b.employees.some((e: any) => e.id === id.ZXA02)).toBe(false);
    expect(b.crossCompany.people.find((p: any) => p.id === id.ZXA02)).toMatchObject({ masked: false, company_code: 'ZXA' });
  });
  it('validation: invalid employee / manager, same company, department of another company, dates, duplicate, loop', async () => {
    const bad = async (body: Record<string, unknown>, text: string) => {
      const r = await A().post('/api/org-assignments', { ...base(), ...body });
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(r.body.error.message).toContain(text);
    };
    await bad({ manager_employee_id: 999999 }, 'ไม่พบผู้รับผิดชอบ');
    await bad({ manager_employee_id: null }, 'กรุณาระบุผู้รับผิดชอบ');
    await bad({ employee_id: 999999 }, 'ไม่พบพนักงาน');
    await bad({ employee_id: id.ZXB09 }, 'พ้นสภาพ');
    await bad({ employee_id: id.ZXA02 }, 'คนละคน');
    await bad({ employee_id: id.ZXA04 }, 'ต้องสังกัดบริษัทปลายทาง');
    await bad({ manager_employee_id: id.ZXB01 }, 'บริษัทเดียวกับบริษัทปลายทาง');
    await bad({ target_department_id: id['ZXA-OPS'] }, 'ไม่ได้อยู่ในบริษัทปลายทาง');
    await bad({ target_department_id: id['ZXB-OLD'] }, 'ปิดใช้งาน');
    await bad({ effective_to: shift(-1) }, 'ไม่ก่อนวันที่เริ่มมีผล');
    await bad({ effective_from: '2026-13-01' }, 'วันที่เริ่มมีผลไม่ถูกต้อง');
    await bad({ relationship_type: 'boss' }, 'ประเภท');
    await bad({ team_name: 'content team ' }, 'มีความสัมพันธ์เดียวกันอยู่แล้ว');
    // ZXB02 responsible for ZXA-MGT (where ZXA02 works) would loop with ZXA02 → Content (ZXB02's team)
    await bad({ manager_employee_id: id.ZXB02, target_company_id: id.ZXA, target_department_id: id['ZXA-MGT'], team_name: null }, 'Relationship Loop');
    // a company outside the scope / no record: nothing was written
    expect(one('SELECT COUNT(*) AS n FROM cross_company_assignments').n).toBe(4);
  });
  it('update: change team, dates and type; history keeps before / after; an unchanged save is refused', async () => {
    const r = await A().put(`/api/org-assignments/${id.live}`, { team_name: 'Live Studio', effective_to: shift(90), reason: 'ปรับชื่อทีม' });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ team_name: 'Live Studio', effective_to: shift(90), state: 'active' });
    const hst = (await A().get(`/api/org-assignments/${id.live}/history`)).body.items;
    expect(hst.map((x: any) => x.action)).toEqual(['created', 'updated']);
    expect(hst[1]).toMatchObject({ reason: 'ปรับชื่อทีม', before: { team_name: 'Live Team', effective_to: null }, after: { team_name: 'Live Studio', effective_to: shift(90) } });
    // change the responsible person (same rules apply)
    const m = await A().put(`/api/org-assignments/${id.live}`, { manager_employee_id: id.ZXA01 });
    expect(m.status, m.text).toBe(200);
    expect(m.body.manager_code).toBe('ZXA01');
    expect((await A().put(`/api/org-assignments/${id.live}`, { manager_employee_id: id.ZXA01 })).status).toBe(400);
    expect((await A().put(`/api/org-assignments/${id.live}`, { effective_to: shift(-400) })).status).toBe(400);
  });
  it('inactive is kept but not drawn; active again is drawn', async () => {
    const off = await A().post(`/api/org-assignments/${id.live}/status`, { status: 'inactive', reason: 'พักงาน' });
    expect(off.body.state).toBe('inactive');
    expect((await chart(A())).crossCompany.links.some((l: any) => l.id === id.live)).toBe(false);
    const on = await A().post(`/api/org-assignments/${id.live}/status`, { status: 'active' });
    expect(on.body.state).toBe('active');
    expect((await chart(A())).crossCompany.links.some((l: any) => l.id === id.live)).toBe(true);
  });
  it('expired and scheduled assignments are never shown as active (nor drawn)', async () => {
    const ex = await A().post('/api/org-assignments', { ...base(), team_name: 'Old', effective_from: shift(-60), effective_to: shift(-1) });
    expect(ex.status, ex.text).toBe(201);
    expect(ex.body.state).toBe('expired');
    const fu = await A().post('/api/org-assignments', { ...base(), team_name: 'Next', effective_from: shift(10) });
    expect(fu.body.state).toBe('scheduled');
    const links = (await chart(A())).crossCompany.links.map((l: any) => l.id);
    expect(links).not.toContain(ex.body.id);
    expect(links).not.toContain(fu.body.id);
    const list = (await A().get('/api/org-assignments?state=expired')).body.items;
    expect(list.map((x: any) => x.id)).toEqual([ex.body.id]);
  });
  it('cancel needs a reason, keeps the row and the history, and removes it from the chart; rows can never be deleted', async () => {
    expect((await A().post(`/api/org-assignments/${id.functional}/cancel`, { reason: '' })).status).toBe(400);
    const r = await A().post(`/api/org-assignments/${id.functional}/cancel`, { reason: 'จบโครงการ' });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ status: 'cancelled', state: 'cancelled', cancel_reason: 'จบโครงการ' });
    expect((await A().put(`/api/org-assignments/${id.functional}`, { team_name: 'x' })).status).toBe(409);
    expect((await A().post(`/api/org-assignments/${id.functional}/cancel`, { reason: 'อีกครั้ง' })).status).toBe(409);
    expect((await chart(A())).crossCompany.links.some((l: any) => l.id === id.functional)).toBe(false);
    expect((await A().get(`/api/org-assignments/${id.functional}/history`)).body.items.map((x: any) => x.action)).toEqual(['created', 'cancelled']);
    expect(() => H.sql(`DELETE FROM cross_company_assignments WHERE id = ${id.functional}`)).toThrow();
    expect(() => H.sql('DELETE FROM cross_company_assignment_history')).toThrow();
    expect(() => H.sql("UPDATE cross_company_assignment_history SET reason = 'x'")).toThrow();
    expect(one(`SELECT COUNT(*) AS n FROM cross_company_assignments WHERE id = ${id.functional}`).n).toBe(1);
  });
  it('a person who left is not drawn even if the assignment is still active', async () => {
    H.sql(`UPDATE employees SET status = 'terminated' WHERE emp_code = 'ZXC01'`);
    const r = await A().post('/api/org-assignments', { ...base(), manager_employee_id: id.ZXA03, target_company_id: id.ZXC, target_department_id: id['ZXC-MGT'], team_name: 'T' });
    expect(r.status).toBe(201);
    H.sql(`UPDATE employees SET status = 'terminated' WHERE emp_code = 'ZXA03'`);
    expect((await chart(A())).crossCompany.links.some((l: any) => l.id === r.body.id)).toBe(false);
    H.sql(`UPDATE employees SET status = 'active' WHERE emp_code IN ('ZXA03', 'ZXC01')`);
  });
  it('the primary reporting line (manager_id), companies and departments of every employee are unchanged', () => {
    H.sql(`UPDATE employees SET status = 'active' WHERE emp_code IN ('ZXA03', 'ZXC01')`);
    expect(managers()).toBe(managersBefore);
  });
});

describe('search, list, permissions and scope', () => {
  it('people search: eligible managers across companies (excluding the target company) and employees of one company', async () => {
    const m = (await A().get(`/api/org-assignments/people?q=zx&exclude_company=${id.ZXB}`)).body.items.map((x: any) => x.emp_code);
    expect(m).toContain('ZXA02');
    expect(m).toContain('ZXC01');
    expect(m.some((x: string) => x.startsWith('ZXB'))).toBe(false);
    const e = (await A().get(`/api/org-assignments/people?q=zxb&company=${id.ZXB}`)).body.items.map((x: any) => x.emp_code);
    expect(e).toEqual(['ZXB01', 'ZXB02', 'ZXB03', 'ZXB04', 'ZXB05']); // the terminated ZXB09 is not eligible
  });
  it('list: search and filters', async () => {
    const all = (await A().get('/api/org-assignments')).body.items;
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect((await A().get('/api/org-assignments?q=Live%20Studio')).body.items.map((x: any) => x.id)).toEqual([id.live]);
    expect((await A().get(`/api/org-assignments?company=${id.ZXC}&state=active`)).body.items.map((x: any) => x.id)).toContain(id.multiCompany);
    expect((await A().get('/api/org-assignments?type=functional_manager')).body.items.map((x: any) => x.id)).toEqual([id.functional]);
  });
  it('no permission → 403; view only (HR Staff) can list but not change', async () => {
    const e = c.employee as Client;
    expect((await e.get('/api/org-assignments')).status).toBe(403);
    expect((await e.post('/api/org-assignments', base())).status).toBe(403);
    const s = c.staff as Client;
    expect((await s.get('/api/org-assignments')).status).toBe(200);
    expect((await s.get('/api/org-assignments/meta')).body.canManage).toBe(false);
    expect((await s.post('/api/org-assignments', { ...base(), team_name: 'Staff' })).status).toBe(403);
    expect((await s.post(`/api/org-assignments/${id.team}/cancel`, { reason: 'ไม่มีสิทธิ์' })).status).toBe(403);
  });
  it('own-company scope: sees rows involving its company with other-company people masked; cannot manage across companies', async () => {
    const z = c.zx as Client;
    const meta = (await z.get('/api/org-assignments/meta')).body;
    expect(meta.companies.map((x: any) => x.code)).toEqual(['ZXA']);
    const items = (await z.get('/api/org-assignments')).body.items;
    expect(items.length).toBeGreaterThan(0);
    for (const x of items) expect([x.manager_live_company, x.target_company_id, x.employee_live_company].includes(id.ZXA)).toBe(true);
    // ZXA → ZXB team: the ZXA manager is visible; a ZXB employee is masked
    const team = items.find((x: any) => x.id === id.team);
    expect(team).toMatchObject({ manager_masked: false, manager_code: 'ZXA02' });
    const fn = items.find((x: any) => x.id === id.functional);
    expect(fn).toMatchObject({ employee_masked: true, employee_code: null, employee_name: null });
    // a row of another company only (none involve ZXA? the ZXC one involves ZXA through its manager): not found when nothing is in scope
    H.sql(`INSERT INTO cross_company_assignments (manager_employee_id, manager_company_id, target_company_id, target_department_id, relationship_type, effective_from, status) VALUES (${id.ZXB02}, ${id.ZXB}, ${id.ZXC}, ${id['ZXC-MGT']}, 'team_lead', '${today}', 'active')`);
    const other = Number(one('SELECT MAX(id) AS id FROM cross_company_assignments').id);
    expect((await z.get(`/api/org-assignments/${other}`)).status).toBe(404);
    expect((await z.get('/api/org-assignments')).body.items.some((x: any) => x.id === other)).toBe(false);
    // managing needs every involved company in scope
    expect((await z.post('/api/org-assignments', { ...base(), team_name: 'Scope' })).status).toBe(403);
    expect((await z.post(`/api/org-assignments/${id.team}/cancel`, { reason: 'นอกขอบเขต' })).status).toBe(403);
    // people search stays inside the scope
    const ppl = (await z.get('/api/org-assignments/people?q=zx')).body.items.map((x: any) => x.emp_code);
    expect(ppl.every((x: string) => x.startsWith('ZXA'))).toBe(true);
    // the chart of the own company: the link is there, the other-company person masked (company only)
    // a ZXB person responsible for a ZXA team (created by the all-company HR)
    const sup = await A().post('/api/org-assignments', { ...base(), manager_employee_id: id.ZXB04, target_company_id: id.ZXA, target_department_id: id['ZXA-OPS'], team_name: null, relationship_type: 'operational_supervisor' });
    expect(sup.status, sup.text).toBe(201);
    const d = await chart(z);
    expect(d.crossCompany.links.some((l: any) => l.id === id.team)).toBe(true);
    expect(d.crossCompany.links.some((l: any) => l.id === sup.body.id)).toBe(true);
    expect(d.crossCompany.links.some((l: any) => l.id === other)).toBe(false);
    expect(d.crossCompany.people.find((p: any) => p.id === id.ZXB04)).toEqual(expect.objectContaining({ masked: true, name: null, emp_code: null, position_title: null, department_name: null, avatar: null, company_code: 'ZXB' }));
    expect(d.crossCompany.people.find((p: any) => p.id === id.ZXA02)).toMatchObject({ masked: false, emp_code: 'ZXA02' });
    // the same row in the list: the ZXB manager is masked for the ZXA user
    expect((await z.get(`/api/org-assignments/${sup.body.id}`)).body).toMatchObject({ manager_masked: true, manager_code: null, manager_name: null, manager_position: null });
    expect(d.employees.every((e: any) => e.company_id === id.ZXA)).toBe(true);
    // asking for another company's chart stays forbidden
    expect((await z.get(`/api/org-design?company=${id.ZXB}`)).status).toBe(403);
  });
});
