// Company detection (P3, migration 0021) — isolated local D1, synthetic data only. Companies ZCA / ZCB / ZCC are
// test companies; the prefix → company mappings below are test configuration (no real company is assumed for any
// prefix). Covers: baseline assignments, mappings (create / update / deactivate, overlap, scope, permissions, races),
// detection and the dry run, transfers (history, lock by approved / signed-off / published payroll, races), a new
// employee held when the entered company differs from the mapping, and the payroll company gate (selection,
// unresolved / conflict / transfer-in-period blocks, payslip ownership, attendance / salary / export scope), audit.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, seedAccountingSignOff, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const ids = {} as Record<'A' | 'B' | 'C' | 'A1' | 'A2' | 'A3' | 'B1' | 'F1' | 'mST' | 'mDP' | 'mFF' | 'pJul' | 'pSep' | 'pOct' | 'pOctB' | 'pAug', number>;
const WRANGLER = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const PASSWORD = 'Zz-Company-Pass-2026!';
const one = (sql: string) => H.sql(sql)[0] as Record<string, any>;
const REASON = { reason: 'zz ย้ายตามคำสั่ง HR', reference: 'ZZ-HR-001' };
const company = (emp: number) => Number(one(`SELECT company_id FROM employees WHERE id = ${emp}`).company_id);
const assignments = (emp: number) => H.sql(`SELECT company_id, effective_from, effective_to, status, source FROM employee_company_assignments WHERE employee_id = ${emp} ORDER BY effective_from, id`);
const slips = (period: number) => H.sql(`SELECT e.emp_code AS emp, s.company_id FROM payslips s JOIN employees e ON e.id = s.employee_id WHERE s.period_id = ${period} ORDER BY e.emp_code`).map((x) => `${x.emp}:${x.company_id}`);

async function makeUser(username: string, roles: string[]): Promise<Client> {
  const u = await c.admin!.post('/api/admin/users', { username, displayName: username, roles });
  expect(u.status, u.text).toBe(201);
  const who = new Client(H.baseUrl);
  await who.login(username, u.body.temporaryPassword);
  expect((await who.post('/api/auth/change-password', { currentPassword: u.body.temporaryPassword, newPassword: PASSWORD })).status).toBe(200);
  expect((await who.get('/api/meta')).status).toBe(200);
  return who;
}
async function newPeriod(code: string, companyId: number, start: string, end: string): Promise<number> {
  const r = await c.admin!.post('/api/payroll/periods', { code, name: code, kind: 'monthly', company_id: companyId, start_date: start, end_date: end, pay_date: end });
  expect(r.status, r.text).toBe(201);
  return r.body.id as number;
}

beforeAll(async () => {
  H = await startHarness();
  H.sql(`INSERT INTO companies (code, name, active) VALUES ('ZCA', 'ZZ Company A', 1), ('ZCB', 'ZZ Company B', 1), ('ZCC', 'ZZ Company C', 1);`);
  for (const k of ['A', 'B', 'C'] as const) ids[k] = Number(one(`SELECT id FROM companies WHERE code = 'ZC${k}'`).id);
  const emp = (code: string, co: number) => `('${code}', 'Zz', '${code}', ${co}, '2026-01-01', 'permanent', 'active', 30000)`;
  // ST7002 moves later; DP7009 carries a DP code but belongs to company A (the "code of another company" case)
  H.sql(`INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status, base_salary) VALUES
    ${emp('ST7001', ids.A)}, ${emp('ST7002', ids.A)}, ${emp('DP7009', ids.A)}, ${emp('DP7001', ids.B)}, ${emp('DP7999', ids.B)};`);
  ids.A1 = Number(one("SELECT id FROM employees WHERE emp_code = 'ST7001'").id);
  ids.A2 = Number(one("SELECT id FROM employees WHERE emp_code = 'ST7002'").id);
  ids.A3 = Number(one("SELECT id FROM employees WHERE emp_code = 'DP7009'").id);
  ids.B1 = Number(one("SELECT id FROM employees WHERE emp_code = 'DP7001'").id);
  H.sql(`INSERT INTO employee_salary_history (employee_id, effective_date, base_salary, reason) VALUES (${ids.A2}, '2026-09-01', 32000, 'zz raise');`);

  c.admin = new Client(H.baseUrl);
  await c.admin.login('it_admin', H.passwords.it_admin);
  c.payroll = new Client(H.baseUrl);
  await c.payroll.login('it_payroll', H.passwords.it_payroll);
  c.staff = new Client(H.baseUrl);
  await c.staff.login('it_staff', H.passwords.it_staff);
  c.employee = new Client(H.baseUrl);
  await c.employee.login('it_employee', H.passwords.it_employee);
  c.hr = await makeUser('zz_comp_hr', ['hr_admin']);
  // a company-B-only user who may manage mappings, move employees and export payroll of their company
  H.sql(`INSERT INTO roles (code, name, description, privileged, system) VALUES ('zz_comp_b', 'ZZ company B', 'test', 0, 0);
    INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.value FROM roles r, json_each('["company_mapping.view","company_mapping.manage","employee_company.transfer","employees.view","payroll.view","payroll.export","payroll_preview.view"]') p WHERE r.code = 'zz_comp_b';`);
  const out = join(H.dir, 'zz_comp_b.sql');
  execFileSync(process.execPath, ['scripts/create-user.mjs', '--username', 'zz_comp_b', '--display', 'zz_comp_b', '--role', 'zz_comp_b', '--employee', 'DP7999', '--out', out, '--cred-file', join(H.dir, 'comp-cred.txt')], { env: { ...process.env, NEW_USER_PASSWORD: PASSWORD }, stdio: 'ignore' });
  execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', join(H.dir, 'state'), '--file', out], { env: { ...process.env, CI: '1' }, stdio: 'ignore' });
  c.scopedB = new Client(H.baseUrl);
  expect((await c.scopedB.login('zz_comp_b', PASSWORD)).status).toBe(200);
}, 300_000);
afterAll(async () => {
  await H?.stop();
});

describe('migration 0021', () => {
  it('grants the three permissions to hr_admin only (super_admin holds *)', () => {
    expect(H.sql("SELECT r.code || ':' || rp.permission AS g FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission IN ('company_mapping.view', 'company_mapping.manage', 'employee_company.transfer') AND r.code NOT LIKE 'zz%' ORDER BY 1").map((x) => x.g))
      .toEqual(['hr_admin:company_mapping.manage', 'hr_admin:company_mapping.view', 'hr_admin:employee_company.transfer']);
  });

  it('13. every employee has a verified assignment equal to their company (no company was changed)', () => {
    expect(Number(one("SELECT COUNT(*) AS n FROM employees e WHERE NOT EXISTS (SELECT 1 FROM employee_company_assignments a WHERE a.employee_id = e.id AND a.status = 'verified' AND a.company_id = e.company_id AND a.effective_to IS NULL)").n)).toBe(0);
    expect(assignments(ids.A3)).toEqual([{ company_id: ids.A, effective_from: '2026-01-01', effective_to: null, status: 'verified', source: 'employee_record' }]);
  });
});

describe('mappings', () => {
  it('31. view and manage need their permission', async () => {
    for (const who of [c.staff!, c.employee!, c.payroll!]) {
      expect((await who.get('/api/company-detection/mappings')).status).toBe(403);
      expect((await who.post('/api/company-detection/mappings', { company_id: ids.A, prefix: 'ST', effective_from: '2026-01-01' })).status).toBe(403);
    }
  });

  it('1–3. HR maps ST / DP / FF to companies (configuration, not code); bad input is refused', async () => {
    const add = (b: Record<string, unknown>) => c.hr!.post('/api/company-detection/mappings', { effective_from: '2026-01-01', ...b });
    const st = await add({ company_id: ids.A, prefix: 'st', priority: 100 });
    expect(st.status, st.text).toBe(201);
    expect(st.body).toMatchObject({ prefix: 'ST', company_id: ids.A, status: 'active', version: 1, effective_to: null });
    ids.mST = st.body.id;
    ids.mDP = (await add({ company_id: ids.B, prefix: 'DP' })).body.id;
    ids.mFF = (await add({ company_id: ids.C, prefix: 'FF' })).body.id;
    expect((await add({ company_id: 999999, prefix: 'QQ' })).status).toBe(404);
    expect((await add({ company_id: ids.A, prefix: 'A-1' })).status).toBe(400);
    expect((await add({ company_id: ids.A, prefix: 'QQ', effective_from: '2026-02-30' })).status).toBe(400);
    expect((await add({ company_id: ids.A, prefix: 'QQ', effective_to: '2025-12-31' })).status).toBe(400);
  });

  it('9–10. the same prefix twice on overlapping dates is refused (any company); a later period is accepted', async () => {
    const dup = await c.hr!.post('/api/company-detection/mappings', { company_id: ids.C, prefix: 'ST', effective_from: '2026-06-01' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('company_mapping_overlap');
    const later = await c.hr!.post('/api/company-detection/mappings', { company_id: ids.C, prefix: 'ZQ', effective_from: '2027-01-01' });
    expect(later.status).toBe(201);
    expect((await c.hr!.post('/api/company-detection/mappings', { company_id: ids.B, prefix: 'ZQ', effective_from: '2026-01-01', effective_to: '2026-12-31' })).status).toBe(201);
    expect((await c.hr!.post('/api/company-detection/mappings', { company_id: ids.B, prefix: 'ZQ', effective_from: '2026-12-31' })).status).toBe(409);
  });

  it('32, 35. an update needs the version read: concurrent updates — exactly one wins, one history row each', async () => {
    expect((await c.staff!.put(`/api/company-detection/mappings/${ids.mFF}`, { version: 1, priority: 5 })).status).toBe(403);
    const rs = await Promise.all([10, 20, 30].map((p) => c.hr!.put(`/api/company-detection/mappings/${ids.mFF}`, { version: 1, priority: p })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(rs.filter((r) => r.status === 409).every((r) => r.body.error.code === 'company_mapping_changed')).toBe(true);
    expect(one(`SELECT version FROM company_code_mappings WHERE id = ${ids.mFF}`).version).toBe(2);
    expect(H.sql(`SELECT action FROM company_code_mapping_history WHERE mapping_id = ${ids.mFF} ORDER BY id`).map((x) => x.action)).toEqual(['created', 'updated']);
    // the company or prefix of a mapping never changes (deactivate and create a new one)
    expect((await c.hr!.put(`/api/company-detection/mappings/${ids.mFF}`, { version: 2, company_id: ids.A })).status).toBe(400);
  });

  it('6. deactivate needs a reason; an inactive mapping is not used; activate checks the overlap again', async () => {
    const zq = Number(one("SELECT id FROM company_code_mappings WHERE prefix = 'ZQ' AND company_id = " + ids.B).id);
    expect((await c.hr!.post(`/api/company-detection/mappings/${zq}/deactivate`, { version: 1 })).status).toBe(400);
    const off = await c.hr!.post(`/api/company-detection/mappings/${zq}/deactivate`, { version: 1, reason: 'zz เลิกใช้รหัสนี้' });
    expect(off.status, off.text).toBe(200);
    expect(off.body).toMatchObject({ status: 'inactive', deactivate_reason: 'zz เลิกใช้รหัสนี้' });
    const d = await c.hr!.post('/api/company-detection/detect', { emp_code: 'ZQ100', date: '2026-06-01' });
    expect(d.body).toMatchObject({ status: 'company_unresolved', error: 'inactive_mapping', companyId: null });
    // re-activating is checked against the other ZQ mapping (2027 on): no overlap, accepted
    expect((await c.hr!.post(`/api/company-detection/mappings/${zq}/activate`, { version: 2 })).status).toBe(200);
  });

  it('33. company scope: a company-B user sees and manages only company B mappings', async () => {
    const list = await c.scopedB!.get('/api/company-detection/mappings');
    expect(list.status).toBe(200);
    expect(new Set(list.body.mappings.map((m: { company_id: number }) => m.company_id))).toEqual(new Set([ids.B]));
    expect((await c.scopedB!.put(`/api/company-detection/mappings/${ids.mST}`, { version: 1, priority: 1 })).status).toBe(404);
    expect((await c.scopedB!.post(`/api/company-detection/mappings/${ids.mST}/deactivate`, { version: 1, reason: 'zz ไม่ใช่ของเรา' })).status).toBe(404);
    expect((await c.scopedB!.get(`/api/company-detection/mappings/${ids.mST}/history`)).status).toBe(404);
    expect((await c.scopedB!.post('/api/company-detection/mappings', { company_id: ids.A, prefix: 'KK', effective_from: '2026-01-01' })).status).toBe(404);
    expect((await c.scopedB!.post('/api/company-detection/mappings', { company_id: ids.B, prefix: 'KK', effective_from: '2026-01-01' })).status).toBe(201);
    expect(one(`SELECT priority FROM company_code_mappings WHERE id = ${ids.mST}`).priority).toBe(100);
  });
});

describe('detection and dry run', () => {
  it('4–5, 36. detect: mapped, unknown and empty codes; an assignment wins; other companies are not revealed', async () => {
    const d = (b: Record<string, unknown>, who = c.hr!) => who.post('/api/company-detection/detect', { date: '2026-06-15', ...b });
    expect((await d({ emp_code: 'ST9999' })).body).toMatchObject({ status: 'mapped', companyId: ids.A, mappingId: ids.mST });
    expect((await d({ emp_code: 'XX9999' })).body).toMatchObject({ status: 'company_unresolved', error: 'no_mapping', companyId: null });
    expect((await d({ emp_code: '' })).body).toMatchObject({ status: 'company_unresolved', error: 'empty_code' });
    // DP7009 is an employee of company A: the assignment decides, the DP mapping (company B) is only reported
    expect((await d({ emp_code: 'DP7009' })).body).toMatchObject({ status: 'assigned', companyId: ids.A, mappingCompanyId: ids.B });
    // the company-B user is not told that DP7009 exists in company A
    const b = (await d({ emp_code: 'DP7009' }, c.scopedB!)).body;
    expect(b).toMatchObject({ status: 'mapped', assignmentId: null, companyId: ids.B });
    expect((await d({ emp_code: 'ST9999' }, c.scopedB!)).body).toMatchObject({ status: 'mapped', companyId: null, mappingCompanyId: null });
  });

  it('dry run: classifies existing employees and changes nothing', async () => {
    const before = H.sql('SELECT id, company_id FROM employees ORDER BY id');
    const beforeA = Number(one('SELECT COUNT(*) AS n FROM employee_company_assignments').n);
    // fixture: an employee whose only assignment was cancelled (e.g. entered by mistake) — detection falls back to mappings
    H.sql(`INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status) VALUES ('FF7100', 'Zz', 'FF7100', ${ids.C}, '2026-01-01', 'permanent', 'active'), ('XQ7100', 'Zz', 'XQ7100', ${ids.C}, '2026-01-01', 'permanent', 'active');
      UPDATE employee_company_assignments SET status = 'cancelled' WHERE employee_id IN (SELECT id FROM employees WHERE emp_code IN ('FF7100', 'XQ7100'));`);
    const r = await c.hr!.get('/api/company-detection/dry-run?date=2026-06-15');
    expect(r.status, r.text).toBe(200);
    const by = new Map<string, string>(r.body.review.map((x: { emp_code: string; classification: string }) => [x.emp_code, x.classification]));
    expect(by.get('DP7009')).toBe('assigned_mapping_differs');
    expect(by.get('FF7100')).toBe('mapping_matched');
    expect(by.get('XQ7100')).toBe('unresolved');
    expect(by.has('ST7001')).toBe(false);
    expect(r.body.counts.total).toBe(r.body.counts.already_assigned + r.body.counts.assigned_mapping_differs + r.body.counts.mapping_matched + r.body.counts.unresolved + r.body.counts.conflict + r.body.counts.inactive_mapping);
    expect(r.body.unmatchedSamples).toContain('XQ7100');
    expect(JSON.stringify(r.body)).not.toMatch(/first_name|last_name|Zz /);
    // read-only
    expect(H.sql('SELECT id, company_id FROM employees WHERE emp_code NOT IN (\'FF7100\', \'XQ7100\') ORDER BY id')).toEqual(before);
    expect(Number(one('SELECT COUNT(*) AS n FROM employee_company_assignments').n)).toBe(beforeA + 2);
    // a company-B user sees only company B employees
    const rb = await c.scopedB!.get('/api/company-detection/dry-run?date=2026-06-15');
    expect(rb.body.review.map((x: { emp_code: string }) => x.emp_code)).not.toContain('DP7009');
    expect((await c.staff!.get('/api/company-detection/dry-run')).status).toBe(403);
  });
});

describe('payroll integration', () => {
  it('23. correct company selection: a company A period pays exactly the verified company A employees', async () => {
    ids.pJul = await newPeriod('ZC-A-2026-07', ids.A, '2026-07-01', '2026-07-31');
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.pJul}/calculate`)).status).toBe(200);
    expect(slips(ids.pJul)).toEqual([`DP7009:${ids.A}`, `ST7001:${ids.A}`, `ST7002:${ids.A}`]);
    expect((await c.admin!.post(`/api/payroll/periods/${ids.pJul}/approve`)).status).toBe(200);
    ids.pSep = await newPeriod('ZC-A-2026-09', ids.A, '2026-09-01', '2026-09-30');
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.pSep}/calculate`)).status).toBe(200);
    expect((await c.admin!.post(`/api/payroll/periods/${ids.pSep}/approve`)).status).toBe(200);
  });

  it('14, 25. a new employee whose entered company differs from the mapping is held; payroll is blocked until HR verifies', async () => {
    const r = await c.admin!.post('/api/m/employees', { emp_code: 'FF7001', first_name: 'zz_test', last_name: 'FF7001', company_id: ids.A, hire_date: '2026-01-01', employment_type: 'permanent', status: 'active', base_salary: 30000 });
    expect(r.status, r.text).toBe(201);
    ids.F1 = r.body.id;
    expect(company(ids.F1)).toBe(ids.A);
    expect(assignments(ids.F1)).toEqual([{ company_id: ids.A, effective_from: '2026-01-01', effective_to: null, status: 'pending_review', source: 'employee_record' }]);
    ids.pAug = await newPeriod('ZC-A-2026-08', ids.A, '2026-08-01', '2026-08-31');
    const blocked = await c.payroll!.post(`/api/payroll/periods/${ids.pAug}/calculate`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('company_conflict');
    expect(blocked.body.error.details.employees).toEqual([{ emp_code: 'FF7001', error: 'company_conflict', reason: 'assignment_pending_review' }]);
    const a = Number(one(`SELECT id FROM employee_company_assignments WHERE employee_id = ${ids.F1}`).id);
    expect((await c.staff!.post(`/api/company-detection/assignments/${a}/verify`, REASON)).status).toBe(403);
    expect((await c.hr!.post(`/api/company-detection/assignments/${a}/verify`, { reason: 'zz' })).status).toBe(400);
    expect((await c.hr!.post(`/api/company-detection/assignments/${a}/verify`, { reason: 'zz ยืนยันตามสัญญาจ้าง', reference: 'ZZ-CONTRACT-1' })).status).toBe(200);
    expect((await c.hr!.post(`/api/company-detection/assignments/${a}/verify`, { reason: 'zz ซ้ำ', reference: 'X' })).status).toBe(409);
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.pAug}/calculate`)).status).toBe(200);
    expect(slips(ids.pAug)).toContain(`FF7001:${ids.A}`);
  });

  it('24. unresolved (no verified assignment for the paid days) blocks the calculation', async () => {
    H.sql(`UPDATE employee_company_assignments SET status = 'cancelled' WHERE employee_id = ${ids.A3}`);
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.pAug}/calculate`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('company_unresolved');
    expect(r.body.error.details.employees).toEqual([{ emp_code: 'DP7009', error: 'company_unresolved', reason: 'no_assignment' }]);
    H.sql(`UPDATE employee_company_assignments SET status = 'verified' WHERE employee_id = ${ids.A3}`);
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.pAug}/calculate`)).status).toBe(200);
    // August is approved before anybody moves (the open-period rule of the transfer)
    expect((await c.admin!.post(`/api/payroll/periods/${ids.pAug}/approve`)).status).toBe(200);
  });

  it('20–22. no move into the days of an approved, signed-off or published period', async () => {
    const move = () => c.hr!.post(`/api/company-detection/employees/${ids.A2}/transfer`, { company_id: ids.B, effective_from: '2026-07-15', ...REASON });
    const approved = await move();
    expect(approved.status).toBe(409);
    expect(approved.body.error.code).toBe('company_period_locked');
    seedAccountingSignOff(H, ids.pJul);
    expect((await move()).body.error.code).toBe('company_period_locked');
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.pJul}/publish`)).status).toBe(200);
    expect((await move()).body.error.code).toBe('company_period_locked');
    expect(company(ids.A2)).toBe(ids.A);
    expect(assignments(ids.A2)).toHaveLength(1);
  });

  it('15, 19, 17–18. transfer: permission, scope, reason, dates, company; the move keeps the history', async () => {
    const t = (who: Client, b: Record<string, unknown>) => who.post(`/api/company-detection/employees/${ids.A2}/transfer`, { company_id: ids.B, effective_from: '2026-10-01', ...REASON, ...b });
    expect((await t(c.staff!, {})).status).toBe(403);
    expect((await t(c.scopedB!, {})).status).toBe(404);
    expect((await t(c.hr!, { reason: '' })).status).toBe(400);
    expect((await t(c.hr!, { reference: '' })).status).toBe(400);
    expect((await t(c.hr!, { company_id: 999999 })).status).toBe(404);
    expect((await t(c.hr!, { company_id: ids.A })).status).toBe(400);
    expect((await t(c.hr!, { effective_from: '2099-01-01' })).status).toBe(400);
    expect((await t(c.hr!, { effective_from: '2025-12-31' })).status).toBe(400);
    expect(assignments(ids.A2)).toHaveLength(1);
    // a calculated (not yet approved) October of company A includes the employee before the move
    ids.pOct = await newPeriod('ZC-A-2026-10', ids.A, '2026-10-01', '2026-10-31');
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.pOct}/calculate`)).status).toBe(200);
    expect(slips(ids.pOct)).toContain(`ST7002:${ids.A}`);
    const ok = await t(c.hr!, {});
    expect(ok.status, ok.text).toBe(200);
    expect(company(ids.A2)).toBe(ids.B);
    expect(assignments(ids.A2)).toEqual([
      { company_id: ids.A, effective_from: '2026-01-01', effective_to: '2026-09-30', status: 'verified', source: 'employee_record' },
      { company_id: ids.B, effective_from: '2026-10-01', effective_to: null, status: 'verified', source: 'transfer' },
    ]);
    expect(H.sql(`SELECT action, reason, reference FROM employee_company_assignment_history WHERE employee_id = ${ids.A2} ORDER BY id`).map((x) => `${x.action}:${x.reason ?? ''}:${x.reference ?? ''}`))
      .toEqual(['created:บริษัทที่ระบุในทะเบียนพนักงาน:', `ended:${REASON.reason}:${REASON.reference}`, `created:${REASON.reason}:${REASON.reference}`]);
    // 16. history: the date decides
    expect((await c.hr!.post('/api/company-detection/detect', { emp_code: 'ST7002', date: '2026-09-30' })).body).toMatchObject({ status: 'assigned', companyId: ids.A });
    expect((await c.hr!.post('/api/company-detection/detect', { emp_code: 'ST7002', date: '2026-10-01' })).body).toMatchObject({ status: 'assigned', companyId: ids.B });
    // 17. a second move starting before the current assignment is refused
    expect((await c.hr!.post(`/api/company-detection/employees/${ids.A2}/transfer`, { company_id: ids.C, effective_from: '2026-09-15', ...REASON })).status).toBe(400);
  });

  it('29. the approved payslip keeps its company; the calculated one moved away is not approved through (recalculate)', async () => {
    expect(slips(ids.pSep)).toContain(`ST7002:${ids.A}`);
    expect(slips(ids.pJul)).toContain(`ST7002:${ids.A}`);
    const a = await c.admin!.post(`/api/payroll/periods/${ids.pOct}/approve`);
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe('company_conflict');
    expect(a.body.error.details.employees).toEqual([{ emp_code: 'ST7002', error: 'company_conflict', reason: 'payslip_company_differs' }]);
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.pOct}/calculate`)).status).toBe(200);
    expect(slips(ids.pOct)).not.toContain(`ST7002:${ids.A}`);
    expect((await c.admin!.post(`/api/payroll/periods/${ids.pOct}/approve`)).status).toBe(200);
  });

  it('27–28. the moved employee is paid by company B, with their salary history, and aggregated in B only', async () => {
    ids.pOctB = await newPeriod('ZC-B-2026-10', ids.B, '2026-10-01', '2026-10-31');
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.pOctB}/calculate`)).status).toBe(200);
    expect(slips(ids.pOctB)).toEqual([`DP7001:${ids.B}`, `DP7999:${ids.B}`, `ST7002:${ids.B}`]);
    expect(Number(one(`SELECT base_salary FROM payslips WHERE period_id = ${ids.pOctB} AND employee_id = ${ids.A2}`).base_salary)).toBe(32000);
    const agg = async (p: number) => (await c.payroll!.get(`/api/payroll/periods/${p}/attendance`)).body.aggregates.map((x: { employee_id: number }) => x.employee_id);
    expect(await agg(ids.pOctB)).toContain(ids.A2);
    expect(await agg(ids.pOct)).not.toContain(ids.A2);
    expect((await c.admin!.post(`/api/payroll/periods/${ids.pOctB}/approve`)).status).toBe(200);
  });

  it('a move is refused while an earlier period of the old company is still open; a period calculated later says "moved out"', async () => {
    const pDec = await newPeriod('ZC-A-2026-12', ids.A, '2026-12-01', '2026-12-31');
    // a period of the old company covering days before the move and not approved yet
    const pNovA = await newPeriod('ZC-A-2026-11-OPEN', ids.A, '2026-11-01', '2026-11-30');
    const r = await c.hr!.post(`/api/company-detection/employees/${ids.A3}/transfer`, { company_id: ids.C, effective_from: '2026-11-05', ...REASON });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('company_period_open');
    expect(company(ids.A3)).toBe(ids.A);
    // an earlier period of company A calculated only after ST7002 moved to B cannot pay them any more: said plainly
    const pJun = await newPeriod('ZC-A-2026-06', ids.A, '2026-06-01', '2026-06-30');
    const late = await c.payroll!.post(`/api/payroll/periods/${pJun}/calculate`);
    expect(late.status).toBe(409);
    expect(late.body.error.details.employees).toEqual([{ emp_code: 'ST7002', error: 'company_conflict', reason: 'moved_out' }]);
    // the draft periods are removed again (soft delete in the fixture; the Super Admin flow is tested elsewhere)
    H.sql(`UPDATE payroll_periods SET deleted_at = datetime('now') WHERE id IN (${pDec}, ${pNovA}, ${pJun})`);
  });

  it('26. a move inside a period blocks both companies (pay is never split or doubled)', async () => {
    expect((await c.hr!.post(`/api/company-detection/employees/${ids.A1}/transfer`, { company_id: ids.B, effective_from: '2026-11-10', ...REASON })).status).toBe(200);
    for (const [code, co] of [['ZC-A-2026-11', ids.A], ['ZC-B-2026-11', ids.B]] as const) {
      const p = await newPeriod(code, co, '2026-11-01', '2026-11-30');
      const r = await c.payroll!.post(`/api/payroll/periods/${p}/calculate`);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('company_transfer_in_period');
      expect(r.body.error.details.employees).toEqual([{ emp_code: 'ST7001', error: 'company_transfer_in_period', reason: 'transfer_in_period' }]);
      expect(H.sql(`SELECT 1 FROM payslips WHERE period_id = ${p}`)).toHaveLength(0);
      const pv = await c.payroll!.get(`/api/payroll/periods/${p}/preview`);
      expect(pv.body.issues.map((i: { code: string }) => i.code)).toContain('company_transfer_in_period');
      // blocked drafts are removed again (soft delete in the fixture) so they do not hold later moves open
      H.sql(`UPDATE payroll_periods SET deleted_at = datetime('now') WHERE id = ${p}`);
    }
  });

  it('30. export never leaks another company: a company-B user cannot export company A', async () => {
    expect((await c.scopedB!.get(`/api/payroll/periods/${ids.pOct}/export.csv`)).status).toBe(404);
    const own = await c.scopedB!.get(`/api/payroll/periods/${ids.pOctB}/export.csv`);
    expect(own.status).toBe(200);
    expect(own.text).toContain('ST7002');
    expect(own.text).not.toContain('ST7001');
  });

  it('the employee form cannot change a company directly (the transfer is the only way)', async () => {
    const r = await c.admin!.put(`/api/m/employees/${ids.B1}`, { company_id: ids.A });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('employee_company_needs_transfer');
    expect(company(ids.B1)).toBe(ids.B);
    // other fields still save
    expect((await c.admin!.put(`/api/m/employees/${ids.B1}`, { phone: '0000000000' })).status).toBe(200);
  });

  it('concurrent transfers of one employee: exactly one moves them', async () => {
    const rs = await Promise.all([ids.A, ids.C, ids.A].map((co) => c.hr!.post(`/api/company-detection/employees/${ids.B1}/transfer`, { company_id: co, effective_from: '2026-11-12', ...REASON })));
    expect(rs.filter((r) => r.status === 200), JSON.stringify(rs.map((r) => [r.status, r.body.error?.code, r.body.error?.message]))).toHaveLength(1);
    // the others lost the race (409) or, served after it, find the employee already moved (400)
    expect(rs.filter((r) => r.status !== 200).every((r) => r.status === 409 || r.status === 400)).toBe(true);
    expect(H.sql(`SELECT 1 FROM employee_company_assignments WHERE employee_id = ${ids.B1} AND status <> 'cancelled' AND effective_to IS NULL`)).toHaveLength(1);
    expect(H.sql(`SELECT 1 FROM employee_company_assignments WHERE employee_id = ${ids.B1} AND source = 'transfer'`)).toHaveLength(1);
  });
});

describe('audit', () => {
  it('34. every change is audited, histories are append-only, assignments are never deleted', () => {
    const actions = H.sql("SELECT action FROM audit_logs WHERE action LIKE 'company_mapping.%' OR action LIKE 'employee_company.%'").map((x) => x.action);
    for (const a of ['company_mapping.created', 'company_mapping.updated', 'company_mapping.deactivated', 'company_mapping.activated', 'employee_company.transferred', 'employee_company.verified']) expect(actions).toContain(a);
    const t = JSON.parse(String(one(`SELECT details FROM audit_logs WHERE action = 'employee_company.transferred' AND entity_id = '${ids.A2}'`).details));
    expect(t).toMatchObject({ from_company_id: ids.A, to_company_id: ids.B, effective_from: '2026-10-01', ...REASON });
    expect(() => H.sql('UPDATE company_code_mapping_history SET reason = \'x\'')).toThrow();
    expect(() => H.sql('DELETE FROM company_code_mapping_history')).toThrow();
    expect(() => H.sql('DELETE FROM company_code_mappings')).toThrow();
    expect(() => H.sql('UPDATE employee_company_assignment_history SET reason = \'x\'')).toThrow();
    expect(() => H.sql(`DELETE FROM employee_company_assignments WHERE employee_id = ${ids.A2}`)).toThrow();
    expect(() => H.sql(`UPDATE employee_company_assignments SET company_id = ${ids.C} WHERE employee_id = ${ids.A2}`)).toThrow();
  });
});
