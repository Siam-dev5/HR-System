// HR Leader / HR Payroll roles, maker-checker and the Super Admin self-approval exception — isolated local D1 with
// synthetic data only (company ZRA, employees ZR1–ZR3, users created through the Admin API). Covers: HR Payroll
// prepares and calculates payroll but cannot approve; HR Leader approves payroll and manages the holiday calendar
// but cannot calculate or approve their own items; the HR Manager approves workflow requests of their reporting line
// only; nobody but a Super Admin approves their own record, and a Super Admin only with an approval note (no
// permission — HR Admin's wildcards included — inherits the exception); existing roles are unchanged; the audit log
// records the maker and the approver.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, seedAccountingSignOff, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const admin = () => c.admin as Client;
const leader = () => c.leader as Client;
const hrpay = () => c.hrpay as Client;
const manager = () => c.manager as Client;
const ids: Record<string, number> = {};
const one = (sql: string) => H.sql(sql)[0] as Record<string, any>;
const audit = (action: string, entity: string, id: number) => H.sql(`SELECT user_id, details FROM audit_logs WHERE action = '${action}' AND entity = '${entity}' AND entity_id = '${id}' ORDER BY id DESC LIMIT 1`)[0] as { user_id: number; details: string } | undefined;
const userId = (name: string) => Number(one(`SELECT id FROM users WHERE username = '${name}'`).id);
const Y = new Date().getUTCFullYear() + 1;

beforeAll(async () => {
  H = await startHarness();
  for (const k of ['admin', 'manager', 'employee', 'payroll', 'staff']) c[k] = new Client(H.baseUrl);
  await c.admin!.login('it_admin', H.passwords.it_admin);
  await c.manager!.login('it_manager', H.passwords.it_manager);
  await c.employee!.login('it_employee', H.passwords.it_employee);
  await c.payroll!.login('it_payroll', H.passwords.it_payroll);
  await c.staff!.login('it_staff', H.passwords.it_staff);
  // accounts with the new roles (and an HR Admin), created the way a Super Admin provisions them: temporary password,
  // change on first login, MFA for these privileged roles
  for (const [key, username, roles] of [['leader', 'it_leader', ['hr_leader']], ['leader2', 'it_leader2', ['hr_leader']], ['hrpay', 'it_hrpay', ['hr_payroll']], ['hradmin', 'it_hradmin', ['hr_admin']]] as const) {
    const r = await admin().post('/api/admin/users', { username, displayName: username, roles });
    expect(r.status, r.text).toBe(201);
    const who = new Client(H.baseUrl);
    await who.login(username, r.body.temporaryPassword);
    expect((await who.post('/api/auth/change-password', { currentPassword: r.body.temporaryPassword, newPassword: `Zr-${username}-Pass-2026!` })).status).toBe(200);
    c[key] = who;
  }
}, 240_000);
afterAll(async () => {
  await H?.stop();
});

describe('roles and permissions', () => {
  it('migration 0014 only adds the two roles and their grants (existing roles unchanged)', () => {
    const sql = readFileSync('migrations/0014_hr_leader_payroll_roles.sql', 'utf8').replace(/--.*$/gm, '');
    const statements = sql.split(';').map((x) => x.trim()).filter(Boolean);
    expect(statements.every((x) => /^INSERT INTO (roles|role_permissions)\b/.test(x))).toBe(true); // nothing updated, deleted or altered
    const targets = [...sql.matchAll(/WHERE r\.code = '([a-z_]+)'/g)].map((m) => m[1]);
    expect(targets).toEqual(['hr_leader', 'hr_payroll']);
    const roles = H.sql("SELECT code, privileged, system FROM roles WHERE code IN ('hr_leader', 'hr_payroll') ORDER BY code");
    expect(roles).toEqual([{ code: 'hr_leader', privileged: 1, system: 1 }, { code: 'hr_payroll', privileged: 1, system: 1 }]);
  });
  it('the permissions of every existing role are exactly those of a database built from migrations 0001–0013', () => {
    // a fresh local D1 with the migrations before 0014, compared grant by grant with the database under test
    const dir = join('.tmp', `roles-0013-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const files = readdirSync('migrations').filter((x) => /^\d{4}_.*\.sql$/.test(x) && x < '0014').sort();
    writeFileSync(join(dir, 'm.sql'), files.map((x) => readFileSync(join('migrations', x), 'utf8')).join('\n;\n'));
    const w = (args: string[]) => execFileSync(process.execPath, [join('node_modules', 'wrangler', 'bin', 'wrangler.js'), 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', join(dir, 's'), ...args], { env: { ...process.env, CI: '1' }, encoding: 'utf8' });
    w(['--file', join(dir, 'm.sql')]);
    const q = "SELECT r.code || ':' || rp.permission AS g FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code NOT IN ('hr_leader', 'hr_payroll', 'acc_staff', 'acc_manager') AND r.code NOT LIKE 'zz%' AND rp.permission NOT LIKE 'org_assignment.%' AND rp.permission NOT IN ('payroll_hold.resolve', 'attendance.correct', 'company_mapping.view', 'company_mapping.manage', 'employee_company.transfer', 'payroll_selection.view', 'payroll_selection.manage', 'payroll_selection.override', 'employee_contract.view', 'employee_contract.manage') ORDER BY 1"; // 0017 grants: tests/integration/cross-company.test.ts · 0019 grant: tests/integration/payroll-holds.test.ts · 0020 grant: tests/integration/attendance-daily.test.ts · 0021 grants: tests/integration/company-detection.test.ts · 0022 grants: tests/integration/payroll-selection.test.ts · 0023 grants: tests/integration/employee-contracts.test.ts
    const out = w(['--json', '--command', q]);
    const before = (JSON.parse(out.slice(out.indexOf('['))) as Array<{ results: Array<{ g: string }> }>)[0]!.results.map((x) => x.g);
    const now = H.sql(q).map((x) => String(x.g));
    expect(before.length).toBeGreaterThan(100);
    expect(now).toEqual(before);
  }, 180_000);
  it('the new roles hold exactly what they need: approve without calculate, calculate without approve', () => {
    const leaderPerms = H.sql("SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = 'hr_leader'").map((x) => String(x.permission));
    const payPerms = H.sql("SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = 'hr_payroll'").map((x) => String(x.permission));
    expect(leaderPerms).toContain('payroll.approve');
    expect(leaderPerms).not.toContain('payroll.calculate');
    expect(payPerms).toContain('payroll.calculate');
    expect(payPerms).not.toContain('payroll.approve');
    expect([...leaderPerms, ...payPerms].some((p) => p === '*' || p.startsWith('payroll.period.') || p === 'workflow.approve' || p === 'workflow.approve_any' || p === 'users.manage' || p === 'roles.manage')).toBe(false);
  });
  it('menus follow the roles: HR Leader sees payroll and the holiday calendar; HR Payroll sees payroll but no approval', async () => {
    const lm = (await leader().get('/api/meta')).body.menu.map((m: { key: string }) => m.key);
    expect(lm).toEqual(expect.arrayContaining(['payroll', 'holiday_calendar']));
    const pm = (await hrpay().get('/api/meta')).body.menu.map((m: { key: string }) => m.key);
    expect(pm).toEqual(expect.arrayContaining(['payroll', 'payroll_preview', 'attendance_import', 'ot_review']));
    expect((await hrpay().get('/api/admin/users')).status).toBe(403);
    expect((await leader().get('/api/admin/users')).status).toBe(403);
  });
});

describe('payroll: HR Payroll prepares, HR Leader approves', () => {
  it('setup: synthetic company ZRA with salaried employees', async () => {
    ids.co = (await admin().post('/api/m/companies', { code: 'ZRA', name: 'zz_test roles', active: true })).body.id;
    for (const code of ['ZR1', 'ZR2', 'ZR3']) {
      const r = await admin().post('/api/m/employees', { emp_code: code, first_name: 'zz_test', last_name: code, company_id: ids.co, hire_date: '2020-01-01', employment_type: 'permanent', status: 'active', base_salary: 30000 });
      expect(r.status, r.text).toBe(201);
      ids[code] = r.body.id;
    }
  });
  it('HR Payroll creates and calculates a period; it cannot approve it (no permission), even its own', async () => {
    const p = await hrpay().post('/api/payroll/periods', { company_id: ids.co, code: `ZR-${Y}-01`, name: 'zz roles', start_date: `${Y}-01-01`, end_date: `${Y}-01-31`, pay_date: `${Y}-01-31` });
    expect(p.status, p.text).toBe(201);
    ids.period = p.body.id;
    const calc = await hrpay().post(`/api/payroll/periods/${ids.period}/calculate`);
    expect(calc.status, calc.text).toBe(200);
    expect(calc.body.status).toBe('calculated');
    expect((await hrpay().post(`/api/payroll/periods/${ids.period}/approve`)).status).toBe(403);
    expect((await hrpay().post(`/api/payroll/periods/${ids.period}/approve`, { note: 'ขอข้ามขั้น' })).status).toBe(403);
    expect((await hrpay().post(`/api/payroll/periods/${ids.period}/publish`)).status).toBe(409); // not approved
  });
  it('HR Leader cannot calculate; approves the period; HR Payroll publishes; the audit names maker and approver', async () => {
    expect((await leader().post(`/api/payroll/periods/${ids.period}/calculate`)).status).toBe(403);
    expect((await leader().get('/api/payroll/periods')).status).toBe(200);
    const ok = await leader().post(`/api/payroll/periods/${ids.period}/approve`);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.status).toBe('approved');
    const row = one(`SELECT calculated_by, approved_by FROM payroll_periods WHERE id = ${ids.period}`);
    expect(row).toEqual({ calculated_by: userId('it_hrpay'), approved_by: userId('it_leader') });
    const a = audit('payroll.approved', 'payroll_periods', ids.period!)!;
    expect(a.user_id).toBe(userId('it_leader'));
    expect(JSON.parse(a.details)).toMatchObject({ calculated_by: userId('it_hrpay'), approved_by: userId('it_leader'), self_approved: false });
    // HR approval alone does not let HR Payroll publish: the ACC sign-off of this version comes first
    expect((await hrpay().post(`/api/payroll/periods/${ids.period}/publish`)).status).toBe(409);
    seedAccountingSignOff(H, ids.period!);
    expect((await hrpay().post(`/api/payroll/periods/${ids.period}/publish`)).status).toBe(200);
  });
  it('the existing rule stays: a Payroll Officer cannot approve a period they calculated', async () => {
    const p = await c.payroll!.post('/api/payroll/periods', { company_id: ids.co, code: `ZR-${Y}-02`, name: 'zz roles 2', start_date: `${Y}-02-01`, end_date: `${Y}-02-28`, pay_date: `${Y}-02-28` });
    expect(p.status, p.text).toBe(201);
    ids.p2 = p.body.id;
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.p2}/calculate`)).status).toBe(200);
    const self = await c.payroll!.post(`/api/payroll/periods/${ids.p2}/approve`, { note: 'ขออนุมัติเอง' });
    expect(self.status).toBe(403); // the note does not help anyone but a Super Admin
    expect(one(`SELECT status FROM payroll_periods WHERE id = ${ids.p2}`).status).toBe('calculated');
  });
  it('Super Admin approves a period they calculated only with an approval note, recorded as a self-approval', async () => {
    const p = await admin().post('/api/payroll/periods', { company_id: ids.co, code: `ZR-${Y}-03`, name: 'zz roles 3', start_date: `${Y}-03-01`, end_date: `${Y}-03-31`, pay_date: `${Y}-03-31` });
    ids.p3 = p.body.id;
    expect((await admin().post(`/api/payroll/periods/${ids.p3}/calculate`)).status).toBe(200);
    expect((await admin().post(`/api/payroll/periods/${ids.p3}/approve`)).status).toBe(400);
    const ok = await admin().post(`/api/payroll/periods/${ids.p3}/approve`, { note: 'zz_test ตรวจยอดแล้ว ไม่มีผู้อนุมัติอื่น' });
    expect(ok.status, ok.text).toBe(200);
    expect(JSON.parse(audit('payroll.approved', 'payroll_periods', ids.p3!)!.details)).toMatchObject({ calculated_by: userId('it_admin'), approved_by: userId('it_admin'), self_approved: true, note: 'zz_test ตรวจยอดแล้ว ไม่มีผู้อนุมัติอื่น' });
  });
});

describe('holiday calendar: HR Leader manages it; only a Super Admin approves their own entries', () => {
  const mk = (who: Client, md: string, name: string) => who.post('/api/holidays', { calendar_id: 1, holiday_date: `${Y}-${md}`, name, holiday_type: 'traditional', source_reference: 'zz_test ประกาศ' });
  it('HR Leader creates, verifies and approves holidays created by someone else; not their own', async () => {
    const byAdmin = await mk(admin(), '08-03', 'zz_test วันหยุด A');
    expect(byAdmin.status, byAdmin.text).toBe(201);
    expect((await leader().post(`/api/holidays/${byAdmin.body.id}/verify`)).status).toBe(200);
    const ok = await leader().post(`/api/holidays/${byAdmin.body.id}/approve`);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect(JSON.parse(audit('holiday.approved', 'holidays', byAdmin.body.id)!.details)).toMatchObject({ created_by: userId('it_admin'), approved_by: userId('it_leader'), self_approved: false });

    const own = await mk(leader(), '08-04', 'zz_test วันหยุด B');
    expect(own.status, own.text).toBe(201);
    ids.leaderHoliday = own.body.id;
    expect((await leader().post(`/api/holidays/${own.body.id}/verify`)).status).toBe(200);
    expect((await leader().post(`/api/holidays/${own.body.id}/approve`)).status).toBe(403);
    // the Super Admin exception cannot be borrowed: the same call with a note is still refused
    expect((await leader().post(`/api/holidays/${own.body.id}/approve`, { note: 'ขออนุมัติเองในฐานะหัวหน้า' })).status).toBe(403);
    expect(one(`SELECT status FROM holidays WHERE id = ${own.body.id}`).status).toBe('draft');
    // a second HR Leader approves it
    expect((await c.leader2!.post(`/api/holidays/${own.body.id}/approve`)).status).toBe(200);
  });
  it('the reported bug: a Super Admin approves a holiday they created (with a note), leaving Draft', async () => {
    const own = await mk(admin(), '08-05', 'zz_test วันหยุด C');
    expect((await admin().post(`/api/holidays/${own.body.id}/verify`)).status).toBe(200);
    const noNote = await admin().post(`/api/holidays/${own.body.id}/approve`);
    expect(noNote.status).toBe(400);
    expect(one(`SELECT status FROM holidays WHERE id = ${own.body.id}`).status).toBe('draft');
    const ok = await admin().post(`/api/holidays/${own.body.id}/approve`, { note: 'zz_test ตรวจกับประกาศราชกิจจาฯ แล้ว' });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body).toMatchObject({ status: 'approved', approved_by_name: 'it_admin' });
    const a = audit('holiday.approved', 'holidays', own.body.id)!;
    expect(a.user_id).toBe(userId('it_admin'));
    expect(JSON.parse(a.details)).toMatchObject({ created_by: userId('it_admin'), approved_by: userId('it_admin'), self_approved: true, note: 'zz_test ตรวจกับประกาศราชกิจจาฯ แล้ว' });
  });
  it('HR Admin (wildcard permissions) does not inherit the exception', async () => {
    const own = await mk(c.hradmin!, '08-06', 'zz_test วันหยุด D');
    expect(own.status, own.text).toBe(201);
    expect((await c.hradmin!.post(`/api/holidays/${own.body.id}/verify`)).status).toBe(200);
    expect((await c.hradmin!.post(`/api/holidays/${own.body.id}/approve`, { note: 'ขออนุมัติเอง' })).status).toBe(403);
  });
  it('other eligible requests: pay rules (Super Admin own with note; HR Leader own refused)', async () => {
    const rule = (who: Client, type: string) => who.post('/api/holidays/pay-rules', { company_id: ids.co, employment_type: type, holiday_pay_entitled: true, work_multiplier: 1, ot_multiplier: 3, effective_from: '2020-01-01', legal_basis: 'zz_test พ.ร.บ.คุ้มครองแรงงาน' });
    const mine = await rule(admin(), 'permanent');
    expect(mine.status, mine.text).toBe(201);
    expect((await admin().post(`/api/holidays/pay-rules/${mine.body.id}/approve`, { note: 'zz_test ตามกฎหมาย' })).status).toBe(200);
    expect(JSON.parse(audit('holiday.pay_rule_approved', 'holiday_pay_rules', mine.body.id)!.details)).toMatchObject({ self_approved: true, created_by: userId('it_admin') });
    const leaderRule = await rule(leader(), 'contract');
    expect(leaderRule.status, leaderRule.text).toBe(201);
    expect((await leader().post(`/api/holidays/pay-rules/${leaderRule.body.id}/approve`, { note: 'ขออนุมัติเอง' })).status).toBe(403);
    expect((await admin().post(`/api/holidays/pay-rules/${leaderRule.body.id}/approve`)).status).toBe(200);
  });
  it('HR Payroll views the calendar but cannot change or approve it', async () => {
    expect((await hrpay().get(`/api/holidays?year=${Y}`)).status).toBe(200);
    expect((await mk(hrpay(), '08-07', 'x')).status).toBe(403);
    expect((await hrpay().post(`/api/holidays/${ids.leaderHoliday}/approve`)).status).toBe(403);
  });
});

describe('workflow: the manager approves their reporting line; self-approval only for a Super Admin', () => {
  const leave = (who: Client, employeeId?: number) => who.post('/api/m/leave', { ...(employeeId ? { employee_id: employeeId } : {}), leave_type_id: 1, start_date: `${Y}-05-10`, end_date: `${Y}-05-10`, days: 1, reason: 'zz_test ลากิจ' });
  const requestOf = (leaveId: number) => Number(one(`SELECT id FROM workflow_requests WHERE ref_table = 'leave_requests' AND ref_id = ${leaveId}`).id);
  it('setup: ZR1 reports to the manager (E002), ZR3 to ZR1 (indirect), ZR2 to nobody', () => {
    H.sql(`UPDATE employees SET manager_id = (SELECT id FROM employees WHERE emp_code = 'E002') WHERE emp_code = 'ZR1';
           UPDATE employees SET manager_id = (SELECT id FROM employees WHERE emp_code = 'ZR1') WHERE emp_code = 'ZR3';`);
  });
  it('MANAGER approves requests of their team (direct and indirect) and not outside it', async () => {
    const [r1, r2, r3] = [await leave(admin(), ids.ZR1), await leave(admin(), ids.ZR2), await leave(admin(), ids.ZR3)];
    for (const r of [r1, r2, r3]) expect(r.status, r.text).toBe(201);
    const inbox = (await manager().get('/api/workflow/inbox')).body.toApprove.map((x: { refId: number }) => x.refId);
    expect(inbox).toEqual(expect.arrayContaining([r1.body.id, r3.body.id]));
    expect(inbox).not.toContain(r2.body.id);
    expect((await manager().post(`/api/workflow/${requestOf(r1.body.id)}/decide`, { decision: 'approved', comment: 'อนุมัติ' })).status).toBe(200);
    expect((await manager().post(`/api/workflow/${requestOf(r3.body.id)}/decide`, { decision: 'approved' })).status).toBe(200);
    const out = await manager().post(`/api/workflow/${requestOf(r2.body.id)}/decide`, { decision: 'approved' });
    expect(out.status).toBe(403);
    expect(out.body.error.message).toContain('ไม่ได้อยู่ในทีมของคุณ');
    // the audit names the requester and the approver
    const a = H.sql(`SELECT user_id, details FROM audit_logs WHERE action = 'workflow.approved' AND entity = 'leave' AND entity_id = '${r1.body.id}'`)[0] as { user_id: number; details: string };
    expect(a.user_id).toBe(userId('it_manager'));
    expect(JSON.parse(a.details)).toMatchObject({ requester: userId('it_admin'), approver: userId('it_manager'), self_approved: false });
    ids.outsideRequest = requestOf(r2.body.id);
  });
  it('a normal user cannot approve their own request, with or without a note', async () => {
    const own = await leave(manager(), Number(one("SELECT id FROM employees WHERE emp_code = 'E002'").id)); // the manager's own leave (E002)
    expect(own.status, own.text).toBe(201);
    const r = await manager().post(`/api/workflow/${requestOf(own.body.id)}/decide`, { decision: 'approved', comment: 'ขออนุมัติเอง' });
    expect(r.status).toBe(403);
    expect(r.body.error.message).toContain('ของตนเอง');
  });
  it('a Super Admin approves their own request only with a comment (self-approval recorded)', async () => {
    // the request for ZR2 was made by the Super Admin (requester = it_admin)
    expect((await admin().post(`/api/workflow/${ids.outsideRequest}/decide`, { decision: 'approved' })).status).toBe(400);
    const ok = await admin().post(`/api/workflow/${ids.outsideRequest}/decide`, { decision: 'approved', comment: 'zz_test อนุมัติในฐานะ Super Admin' });
    expect(ok.status, ok.text).toBe(200);
    const a = H.sql(`SELECT details FROM audit_logs WHERE action = 'workflow.approved' AND entity = 'leave' AND entity_id = '${one(`SELECT ref_id FROM workflow_requests WHERE id = ${ids.outsideRequest}`).ref_id}'`)[0] as { details: string };
    expect(JSON.parse(a.details)).toMatchObject({ requester: userId('it_admin'), approver: userId('it_admin'), self_approved: true });
  });
  it('the new roles cannot approve workflow requests (direct API calls refused)', async () => {
    const r = await leave(admin(), ids.ZR1);
    for (const who of [leader(), hrpay(), c.hradmin!]) expect((await who.post(`/api/workflow/${requestOf(r.body.id)}/decide`, { decision: 'approved', comment: 'ลองอนุมัติ' })).status).toBe(403);
  });
});

describe('hardening: payroll maker-checker always on (the old setting cannot switch it off)', () => {
  const make = async (who: Client, month: string) => {
    const p = await who.post('/api/payroll/periods', { company_id: ids.co, code: `ZH-${Y}-${month}`, name: `zz hardening ${month}`, start_date: `${Y}-${month}-01`, end_date: `${Y}-${month}-28`, pay_date: `${Y}-${month}-28` });
    expect(p.status, p.text).toBe(201);
    expect((await who.post(`/api/payroll/periods/${p.body.id}/calculate`)).status).toBe(200);
    return p.body.id as number;
  };
  it('setup: the old setting is off, as in some deployments', () => {
    H.sql("UPDATE settings SET value = 'false' WHERE key = 'payroll.require_separate_approver'");
    expect(one("SELECT value FROM settings WHERE key = 'payroll.require_separate_approver'").value).toBe('false');
  });
  it('a calculator cannot approve their own period, even with the setting off and with a note; another user can', async () => {
    const id = await make(c.payroll!, '05');
    expect((await c.payroll!.post(`/api/payroll/periods/${id}/approve`)).status).toBe(403);
    expect((await c.payroll!.post(`/api/payroll/periods/${id}/approve`, { note: 'ขออนุมัติเองเพราะค่าตั้งปิดอยู่' })).status).toBe(403);
    expect(one(`SELECT status FROM payroll_periods WHERE id = ${id}`).status).toBe('calculated');
    const ok = await leader().post(`/api/payroll/periods/${id}/approve`);
    expect(ok.status, ok.text).toBe(200);
    const a = JSON.parse(audit('payroll.approved', 'payroll_periods', id)!.details);
    expect(a).toMatchObject({ period_id: id, calculated_by: userId('it_payroll'), approved_by: userId('it_leader'), self_approved: false, note: null });
    expect(typeof a.approved_at).toBe('string');
    ids.h05 = id;
  });
  it('a Super Admin self-approval with the setting off still needs a note (at least 3 characters)', async () => {
    const id = await make(admin(), '06');
    expect((await admin().post(`/api/payroll/periods/${id}/approve`)).status).toBe(400);
    expect((await admin().post(`/api/payroll/periods/${id}/approve`, { note: 'ok' })).status).toBe(400);
    expect(one(`SELECT status FROM payroll_periods WHERE id = ${id}`).status).toBe('calculated');
    const ok = await admin().post(`/api/payroll/periods/${id}/approve`, { note: 'zz_test ไม่มีผู้อนุมัติอื่น' });
    expect(ok.status, ok.text).toBe(200);
    expect(JSON.parse(audit('payroll.approved', 'payroll_periods', id)!.details)).toMatchObject({ calculated_by: userId('it_admin'), approved_by: userId('it_admin'), self_approved: true, note: 'zz_test ไม่มีผู้อนุมัติอื่น' });
  });
  it('a role with wildcard permissions but not super_admin cannot approve payroll at all (HR Admin)', async () => {
    const id = await make(c.payroll!, '07');
    expect((await c.hradmin!.post(`/api/payroll/periods/${id}/approve`, { note: 'ขออนุมัติ' })).status).toBe(403);
  });
});

describe('hardening: publish only after approval; the audit links calculator, approver and publisher', () => {
  it('publish refuses draft and calculated periods', async () => {
    const draft = await hrpay().post('/api/payroll/periods', { company_id: ids.co, code: `ZH-${Y}-08`, name: 'zz draft', start_date: `${Y}-08-01`, end_date: `${Y}-08-28`, pay_date: `${Y}-08-28` });
    expect((await hrpay().post(`/api/payroll/periods/${draft.body.id}/publish`)).status).toBe(409);
    const calc = await hrpay().post('/api/payroll/periods', { company_id: ids.co, code: `ZH-${Y}-09`, name: 'zz calculated', start_date: `${Y}-09-01`, end_date: `${Y}-09-28`, pay_date: `${Y}-09-28` });
    expect((await hrpay().post(`/api/payroll/periods/${calc.body.id}/calculate`)).status).toBe(200);
    expect((await hrpay().post(`/api/payroll/periods/${calc.body.id}/publish`)).status).toBe(409);
    expect(one(`SELECT status FROM payroll_periods WHERE id = ${calc.body.id}`).status).toBe('calculated');
  });
  it('publishing an approved period records calculated_by, approved_by, published_by and the time', async () => {
    seedAccountingSignOff(H, ids.h05!);
    const ok = await hrpay().post(`/api/payroll/periods/${ids.h05}/publish`);
    expect(ok.status, ok.text).toBe(200);
    const row = one(`SELECT calculated_by, approved_by, published_by, published_at FROM payroll_periods WHERE id = ${ids.h05}`);
    expect(row).toMatchObject({ calculated_by: userId('it_payroll'), approved_by: userId('it_leader'), published_by: userId('it_hrpay') });
    const a = JSON.parse(audit('payroll.published', 'payroll_periods', ids.h05!)!.details);
    expect(a).toMatchObject({ period_id: ids.h05, calculated_by: userId('it_payroll'), approved_by: userId('it_leader'), published_by: userId('it_hrpay'), published_at: row.published_at });
    expect(typeof a.notified).toBe('number');
  });
});

describe('hardening: holiday content editor and holiday-work editor cannot approve their own changes', () => {
  const mk = (who: Client, md: string, name: string) => who.post('/api/holidays', { calendar_id: 1, holiday_date: `${Y}-${md}`, name, holiday_type: 'traditional', source_reference: 'zz_test ประกาศ' });
  it('a user who edited the content of a holiday made by someone else cannot approve it; a third user can', async () => {
    const h = await mk(c.hradmin!, '09-01', 'zz_test วันหยุด E');
    expect(h.status, h.text).toBe(201);
    const edit = await leader().put(`/api/holidays/${h.body.id}`, { name: 'zz_test วันหยุด E (แก้ชื่อ)' });
    expect(edit.status, edit.text).toBe(200);
    expect(one(`SELECT content_updated_by FROM holidays WHERE id = ${h.body.id}`).content_updated_by).toBe(userId('it_leader'));
    expect((await leader().post(`/api/holidays/${h.body.id}/verify`)).status).toBe(200);
    const self = await leader().post(`/api/holidays/${h.body.id}/approve`, { note: 'ขออนุมัติที่แก้เอง' });
    expect(self.status).toBe(403);
    expect(self.body.error.message).toContain('ผู้แก้ไข');
    expect((await c.hradmin!.post(`/api/holidays/${h.body.id}/approve`)).status).toBe(403); // the creator
    const ok = await c.leader2!.post(`/api/holidays/${h.body.id}/approve`);
    expect(ok.status, ok.text).toBe(200);
    expect(JSON.parse(audit('holiday.approved', 'holidays', h.body.id)!.details)).toMatchObject({ created_by: userId('it_hradmin'), content_updated_by: userId('it_leader'), approved_by: userId('it_leader2'), self_approved: false });
  });
  it('source verification does not make the verifier the content editor (the verifier may approve)', async () => {
    const h = await mk(c.hradmin!, '09-02', 'zz_test วันหยุด F');
    expect((await leader().post(`/api/holidays/${h.body.id}/verify`, { source_reference: 'zz_test ประกาศฉบับจริง' })).status).toBe(200);
    expect(one(`SELECT content_updated_by, verified_by FROM holidays WHERE id = ${h.body.id}`)).toEqual({ content_updated_by: null, verified_by: userId('it_leader') });
    expect((await leader().post(`/api/holidays/${h.body.id}/approve`)).status).toBe(200);
  });
  it('a holiday-work editor cannot approve the record they changed; the creator neither; a third user can', async () => {
    const hol = Number(one("SELECT id FROM holidays WHERE name = 'zz_test วันหยุด A'").id);
    const w = await c.hradmin!.post('/api/holidays/work', { employee_id: ids.ZR1, holiday_id: hol, normal_hours: 4, evidence_source: 'manual', evidence_ref: 'zz_test ใบสั่งงาน 1' });
    expect(w.status, w.text).toBe(201);
    const edit = await leader().put(`/api/holidays/work/${w.body.id}`, { normal_hours: 8, evidence_source: 'manual', evidence_ref: 'zz_test ใบสั่งงาน 1 (แก้)' });
    expect(edit.status, edit.text).toBe(200);
    expect(one(`SELECT content_updated_by FROM holiday_work_records WHERE id = ${w.body.id}`).content_updated_by).toBe(userId('it_leader'));
    expect((await leader().post(`/api/holidays/work/${w.body.id}/approve`, { excluded_from_regular_ot: true, note: 'ขออนุมัติที่แก้เอง' })).status).toBe(403);
    expect((await c.hradmin!.post(`/api/holidays/work/${w.body.id}/approve`, { excluded_from_regular_ot: true })).status).toBe(403);
    const ok = await c.leader2!.post(`/api/holidays/work/${w.body.id}/approve`, { excluded_from_regular_ot: true });
    expect(ok.status, ok.text).toBe(200);
    expect(JSON.parse(audit('holiday_work.approved', 'holiday_work_records', w.body.id)!.details)).toMatchObject({ created_by: userId('it_hradmin'), content_updated_by: userId('it_leader'), approved_by: userId('it_leader2') });
  });
});
