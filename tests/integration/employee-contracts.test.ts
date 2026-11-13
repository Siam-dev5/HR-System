// Contract employees (P5, migration 0023) — isolated local D1, synthetic data only (companies ZKA / ZKB, employees
// ZK1–ZK3, ZK9). Covers: contract periods (record, renew / end, cancel, overlap, dates, reason), permissions and company
// scope, the payroll effect (review when the paid days are not covered, payable after renewal or HR confirmation, a
// contract employee without a recorded contract paid as before with a note), unchanged amounts, races, history, audit.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const ids = {} as Record<'A' | 'B' | 'K1' | 'K2' | 'K3' | 'K9' | 'contract' | 'pJun' | 'pJul', number>;
const WRANGLER = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const PASSWORD = 'Zz-Contract-Pass-2026!';
const one = (sql: string) => H.sql(sql)[0] as Record<string, any>;
const slips = (p: number) => H.sql(`SELECT e.emp_code AS emp, s.base_salary AS base FROM payslips s JOIN employees e ON e.id = s.employee_id WHERE s.period_id = ${p} ORDER BY e.emp_code`).map((x) => `${x.emp}:${x.base}`);
const R = { reason: 'zz บันทึกตามสัญญาจ้าง', reference: 'ZZ-CT-1' };

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
  H.sql(`INSERT INTO companies (code, name, active) VALUES ('ZKA', 'ZZ Contract A', 1), ('ZKB', 'ZZ Contract B', 1);`);
  ids.A = Number(one("SELECT id FROM companies WHERE code = 'ZKA'").id);
  ids.B = Number(one("SELECT id FROM companies WHERE code = 'ZKB'").id);
  const row = (code: string, co: number, type: string) => `('${code}', 'Zz', '${code}', ${co}, '2026-01-01', '${type}', 'active', 30000)`;
  H.sql(`INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status, base_salary) VALUES
    ${row('ZK1', ids.A, 'contract')}, ${row('ZK2', ids.A, 'permanent')}, ${row('ZK3', ids.A, 'contract')}, ${row('ZK9', ids.B, 'contract')};`);
  for (const k of ['K1', 'K2', 'K3', 'K9'] as const) ids[k] = Number(one(`SELECT id FROM employees WHERE emp_code = 'Z${k}'`).id);
  c.admin = new Client(H.baseUrl);
  await c.admin.login('it_admin', H.passwords.it_admin);
  c.payroll = new Client(H.baseUrl);
  await c.payroll.login('it_payroll', H.passwords.it_payroll);
  c.staff = new Client(H.baseUrl);
  await c.staff.login('it_staff', H.passwords.it_staff);
  c.leader = await makeUser('zz_ct_leader', ['hr_leader']);
  H.sql(`INSERT INTO roles (code, name, description, privileged, system) VALUES ('zz_ct_b', 'ZZ contract B', 'test', 0, 0);
    INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.value FROM roles r, json_each('["employee_contract.view","employee_contract.manage"]') p WHERE r.code = 'zz_ct_b';`);
  const out = join(H.dir, 'zz_ct_b.sql');
  execFileSync(process.execPath, ['scripts/create-user.mjs', '--username', 'zz_ct_b', '--display', 'zz_ct_b', '--role', 'zz_ct_b', '--employee', 'ZK9', '--out', out, '--cred-file', join(H.dir, 'ct-cred.txt')], { env: { ...process.env, NEW_USER_PASSWORD: PASSWORD }, stdio: 'ignore' });
  execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', join(H.dir, 'state'), '--file', out], { env: { ...process.env, CI: '1' }, stdio: 'ignore' });
  c.scopedB = new Client(H.baseUrl);
  expect((await c.scopedB.login('zz_ct_b', PASSWORD)).status).toBe(200);
}, 300_000);
afterAll(async () => {
  await H?.stop();
});

describe('contract periods', () => {
  it('grants view / manage to hr_admin and hr_payroll, view to payroll_officer and hr_leader', () => {
    expect(H.sql("SELECT r.code || ':' || rp.permission AS g FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission LIKE 'employee_contract.%' AND r.code NOT LIKE 'zz%' ORDER BY 1").map((x) => x.g)).toEqual([
      'hr_admin:employee_contract.manage', 'hr_admin:employee_contract.view', 'hr_leader:employee_contract.view', 'hr_payroll:employee_contract.manage', 'hr_payroll:employee_contract.view', 'payroll_officer:employee_contract.view',
    ]);
  });

  it('permissions: no access without view; view cannot manage', async () => {
    expect((await c.staff!.get(`/api/employee-contracts/employees/${ids.K1}`)).status).toBe(403);
    expect((await c.payroll!.get(`/api/employee-contracts/employees/${ids.K1}`)).status).toBe(200);
    expect((await c.payroll!.post(`/api/employee-contracts/employees/${ids.K1}`, { start_date: '2026-01-01', ...R })).status).toBe(403);
  });

  it('records a contract of a contract employee only; dates, reason and overlap are checked', async () => {
    const add = (e: number, b: Record<string, unknown>) => c.admin!.post(`/api/employee-contracts/employees/${e}`, { ...R, ...b });
    expect((await add(ids.K2, { start_date: '2026-01-01' })).status).toBe(400); // permanent employee
    expect((await add(ids.K1, { start_date: '2025-12-31' })).status).toBe(400); // before the hire date
    expect((await add(ids.K1, { start_date: '2026-01-01', end_date: '2025-12-01' })).status).toBe(400);
    expect((await add(ids.K1, { start_date: '2026-01-01', reason: 'zz' })).status).toBe(400);
    const ok = await add(ids.K1, { start_date: '2026-01-01', end_date: '2026-06-15', contract_no: 'ZZ-C-001' });
    expect(ok.status, ok.text).toBe(201);
    expect(ok.body).toMatchObject({ employee_id: ids.K1, company_id: ids.A, start_date: '2026-01-01', end_date: '2026-06-15', status: 'active', version: 1 });
    ids.contract = ok.body.id;
    const dup = await add(ids.K1, { start_date: '2026-06-01' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('employee_contract_overlap');
  });

  it('company scope: a company-B user cannot see or change company A contracts', async () => {
    expect((await c.scopedB!.get(`/api/employee-contracts/employees/${ids.K1}`)).status).toBe(404);
    expect((await c.scopedB!.post(`/api/employee-contracts/employees/${ids.K1}`, { start_date: '2026-07-01', ...R })).status).toBe(404);
    expect((await c.scopedB!.put(`/api/employee-contracts/${ids.contract}`, { version: 1, end_date: null, ...R })).status).toBe(404);
    expect((await c.scopedB!.post(`/api/employee-contracts/employees/${ids.K9}`, { start_date: '2026-01-01', ...R })).status).toBe(201);
  });
});

describe('payroll', () => {
  it('a contract ending inside the period: review — calculation refused until HR confirms; amount unchanged', async () => {
    ids.pJun = await newPeriod('ZK-2026-06', ids.A, '2026-06-01', '2026-06-30');
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.pJun}/calculate`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('selection_not_ready');
    expect(r.body.error.details.employees).toEqual([expect.objectContaining({ emp_code: 'ZK1', status: 'review_required', reasons: ['contract_not_covering'] })]);
    const list = (await c.payroll!.get(`/api/payroll-selection/periods/${ids.pJun}`)).body.selected;
    expect(list.find((x: { emp_code: string }) => x.emp_code === 'ZK3')).toMatchObject({ decision: 'pay', notes: ['contract_unrecorded'] });
    expect((await c.leader!.post(`/api/payroll-selection/periods/${ids.pJun}/employees/${ids.K1}/confirm`, { reason: 'zz ต่อสัญญาแล้ว รอเอกสาร' })).status).toBe(200);
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.pJun}/calculate`)).status).toBe(200);
    // the formula is untouched: everyone is paid the full monthly base, as without contracts
    expect(slips(ids.pJun)).toEqual(['ZK1:30000', 'ZK2:30000', 'ZK3:30000']);
  });

  it('renewing the contract (end date changed, version checked; concurrent changes once) makes the next period payable', async () => {
    const rs = await Promise.all(['2026-12-31', '2027-06-30'].map((end) => c.admin!.put(`/api/employee-contracts/${ids.contract}`, { version: 1, end_date: end, reason: 'zz ต่อสัญญา', reference: 'ZZ-CT-2' })));
    expect(rs.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(Number(one(`SELECT version FROM employee_contracts WHERE id = ${ids.contract}`).version)).toBe(2);
    ids.pJul = await newPeriod('ZK-2026-07', ids.A, '2026-07-01', '2026-07-31');
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.pJul}/calculate`)).status).toBe(200);
    expect(slips(ids.pJul)).toEqual(['ZK1:30000', 'ZK2:30000', 'ZK3:30000']);
  });

  it('cancelling a contract entered by mistake: back to "no recorded contract" (paid, with a note)', async () => {
    const v = Number(one(`SELECT version FROM employee_contracts WHERE id = ${ids.contract}`).version);
    expect((await c.admin!.post(`/api/employee-contracts/${ids.contract}/cancel`, { version: v, reason: 'zz' })).status).toBe(400);
    expect((await c.admin!.post(`/api/employee-contracts/${ids.contract}/cancel`, { version: v, ...R })).status).toBe(200);
    expect((await c.admin!.post(`/api/employee-contracts/${ids.contract}/cancel`, { version: v + 1, ...R })).status).toBe(409);
    const list = (await c.payroll!.get(`/api/payroll-selection/periods/${ids.pJul}`)).body.selected;
    expect(list.find((x: { emp_code: string }) => x.emp_code === 'ZK1')).toMatchObject({ decision: 'pay', notes: ['contract_unrecorded'] });
  });
});

describe('history and audit', () => {
  it('every change is in the append-only history and the audit log; contracts are never deleted', async () => {
    const h = (await c.admin!.get(`/api/employee-contracts/employees/${ids.K1}`)).body;
    expect(h.history.map((x: { action: string }) => x.action)).toEqual(['created', 'updated', 'cancelled']);
    expect(h.history[1]).toMatchObject({ reason: 'zz ต่อสัญญา', reference: 'ZZ-CT-2', before: { end_date: '2026-06-15' } });
    const actions = H.sql("SELECT action FROM audit_logs WHERE action LIKE 'employee_contract.%'").map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(['employee_contract.created', 'employee_contract.updated', 'employee_contract.cancelled']));
    expect(() => H.sql('DELETE FROM employee_contracts')).toThrow();
    expect(() => H.sql("UPDATE employee_contract_history SET reason = 'x'")).toThrow();
    expect(() => H.sql('DELETE FROM employee_contract_history')).toThrow();
    expect(() => H.sql(`UPDATE employee_contracts SET start_date = '2026-02-01' WHERE id = ${ids.contract}`)).toThrow();
  });
});
