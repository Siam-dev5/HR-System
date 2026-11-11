// ACC Staff / ACC Manager (migration 0016) — isolated local D1 with synthetic data only (companies ZAA / ZAB,
// employees ZA1–ZA3). Accounts are provisioned exactly as in Production: scripts/create-user.mjs --create-only
// --must-change with the initial password from NEW_USER_PASSWORD and the employee linked by code. Covers: first login
// is restricted until the password is changed and MFA is enrolled; both roles see every company read-only (employees,
// payroll periods, preview, payslips, pay items, salary history, attendance summaries); bank account and tax ID stay
// masked; calculate / approve / publish / export with bank data / any write / Super Admin areas are refused; other
// roles keep their company scope; existing roles are unchanged.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasPermission } from '../../src/shared/permissions';
import { RESERVED_PERMISSIONS, permissionCatalogue } from '../../src/shared/modules';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const admin = new Map<string, Client>();
const c: Record<string, Client> = {};
const ids: Record<string, number> = {};
const one = (sql: string) => H.sql(sql)[0] as Record<string, any>;
const Y = new Date().getUTCFullYear() + 2;
const WRANGLER = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const MASK = '••••••';

// what ACC must never hold, whatever pattern grants it
const DENIED = [
  'payroll.calculate', 'payroll.approve', 'payroll.publish', 'payroll.export', 'payroll.period.reopen', 'payroll.period.edit_closed', 'payroll.period.delete',
  'payroll.period.force_recalculate', 'employees.create', 'employees.update', 'employees.delete', 'employees.sensitive', 'employee_pay_items.create',
  'employee_pay_items.update', 'employee_pay_items.delete', 'salary_history.create', 'salary_history.update', 'attendance_import.create', 'attendance_import.update',
  'ot_review.update', 'attendance.create', 'attendance.update', 'leave.create', 'overtime.create', 'workflow.approve', 'workflow.approve_any',
  'holiday_calendar.approve', 'holiday_calendar.update', 'attendance_exemption.manage', 'attendance_file.import', 'users.manage', 'roles.manage',
  'settings.manage', 'payroll_layout.manage', 'audit.view', 'pay_components.update',
];

const permCache = new Map<string, string[]>();
function perms(code: string): string[] {
  if (!permCache.has(code)) permCache.set(code, H.sql(`SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = '${code}' ORDER BY 1`).map((x) => String(x.permission)));
  return permCache.get(code) as string[];
}

/** Provisions an account the Production way: create-user.mjs --create-only --must-change, then wrangler d1 execute. */
function provision(username: string, role: string, password: string, employee?: string): void {
  const out = join(H.dir, `${username}.sql`);
  const args = ['scripts/create-user.mjs', '--username', username, '--display', username, '--role', role, '--must-change', '--create-only', '--out', out, '--cred-file', join(H.dir, 'acc-credentials.txt')];
  if (employee) args.push('--employee', employee);
  execFileSync(process.execPath, args, { env: { ...process.env, NEW_USER_PASSWORD: password }, stdio: 'ignore' });
  execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', join(H.dir, 'state'), '--file', out], { env: { ...process.env, CI: '1' }, stdio: 'ignore' });
}

beforeAll(async () => {
  H = await startHarness();
  const a = new Client(H.baseUrl);
  await a.login('it_admin', H.passwords.it_admin);
  admin.set('a', a);
  const p = new Client(H.baseUrl);
  await p.login('it_payroll', H.passwords.it_payroll);
  c.payroll = p;
  const e = new Client(H.baseUrl);
  await e.login('it_employee', H.passwords.it_employee);
  c.employee = e;
  const s = new Client(H.baseUrl);
  await s.login('it_staff', H.passwords.it_staff);
  c.staff = s;
}, 240_000);
afterAll(async () => {
  await H?.stop();
});
const adm = () => admin.get('a') as Client;

describe('migration 0016', () => {
  it('only adds the two ACC roles and their grants; both privileged (MFA)', () => {
    const sql = readFileSync('migrations/0016_acc_readonly_roles.sql', 'utf8').replace(/--.*$/gm, '');
    const statements = sql.split(';').map((x) => x.trim()).filter(Boolean);
    expect(statements.every((x) => /^INSERT INTO (roles|role_permissions)\b/.test(x))).toBe(true);
    expect([...sql.matchAll(/WHERE r\.code = '([a-z_]+)'/g)].map((m) => m[1])).toEqual(['acc_staff', 'acc_manager']);
    expect(H.sql("SELECT code, privileged, system FROM roles WHERE code LIKE 'acc_%' ORDER BY code")).toEqual([
      { code: 'acc_manager', privileged: 1, system: 1 },
      { code: 'acc_staff', privileged: 1, system: 1 },
    ]);
  });
  it('grants only catalogue permissions, no wildcard, nothing that writes, approves, publishes or unmasks bank / ID data', () => {
    const cat = permissionCatalogue();
    for (const code of ['acc_staff', 'acc_manager']) {
      const p = perms(code);
      expect(p.length).toBeGreaterThan(20);
      for (const x of p) {
        expect(x.includes('*'), `${code} ${x}`).toBe(false);
        expect(cat, `${code} ${x}`).toContain(x);
      }
      for (const d of [...DENIED, ...RESERVED_PERMISSIONS]) expect(hasPermission(p, d), `${code} must not hold ${d}`).toBe(false);
      for (const need of ['employees.view', 'employees.all', 'payroll.view', 'payroll_preview.view', 'reports.view', 'attendance_import.view']) expect(p).toContain(need);
    }
    // the only difference: ACC Manager may export the Payroll Preview (no bank / ID columns)
    const staff = perms('acc_staff');
    expect(perms('acc_manager').filter((x) => !staff.includes(x))).toEqual(['payroll_preview.export']);
    expect(staff.filter((x) => !perms('acc_manager').includes(x))).toEqual([]);
  });
  it('the permissions of every other role are exactly those of a database built from migrations 0001–0015', () => {
    const dir = join('.tmp', `roles-0015-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const files = readdirSync('migrations').filter((x) => /^\d{4}_.*\.sql$/.test(x) && x < '0016').sort();
    writeFileSync(join(dir, 'm.sql'), files.map((x) => readFileSync(join('migrations', x), 'utf8')).join('\n;\n'));
    const w = (args: string[]) => execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', join(dir, 's'), ...args], { env: { ...process.env, CI: '1' }, encoding: 'utf8' });
    w(['--file', join(dir, 'm.sql')]);
    const q = "SELECT r.code || ':' || r.privileged || ':' || rp.permission AS g FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code NOT IN ('acc_staff', 'acc_manager') AND r.code NOT LIKE 'zz%' AND rp.permission NOT LIKE 'org_assignment.%' ORDER BY 1"; // 0017 grants: tests/integration/cross-company.test.ts
    const out = w(['--json', '--command', q]);
    const before = (JSON.parse(out.slice(out.indexOf('['))) as Array<{ results: Array<{ g: string }> }>)[0]!.results.map((x) => x.g);
    expect(before.some((g) => g.startsWith('hr_leader:1:payroll.approve'))).toBe(true);
    expect(H.sql(q).map((x) => String(x.g))).toEqual(before);
  }, 180_000);
  it('the rollback script removes exactly the ACC roles', () => {
    const sql = readFileSync('scripts/rollback/0016_acc_readonly_roles.down.sql', 'utf8').replace(/--.*$/gm, '');
    expect(sql).toContain("code IN ('acc_staff', 'acc_manager')");
    expect(sql).not.toMatch(/hr_leader|hr_payroll|super_admin|DROP|payslips|payroll_periods|employees/);
  });
});

describe('setup: synthetic companies, employees and a calculated period', () => {
  it('two companies, salaried employees with bank and tax data, pay items and salary history', async () => {
    for (const code of ['ZAA', 'ZAB']) {
      const r = await adm().post('/api/m/companies', { code, name: `zz_test acc ${code}`, active: true });
      expect(r.status, r.text).toBe(201);
      ids[code] = r.body.id;
    }
    for (const [code, co] of [['ZA1', 'ZAA'], ['ZA2', 'ZAA'], ['ZA3', 'ZAB']] as const) {
      const r = await adm().post('/api/m/employees', {
        emp_code: code, first_name: 'zz_test', last_name: code, company_id: ids[co], hire_date: '2020-01-01', employment_type: 'permanent', status: 'active',
        base_salary: 30000, bank_name: 'zz bank', bank_account: `000-0-${code}`, tax_id: `000000000${code.slice(-1)}`,
      });
      expect(r.status, r.text).toBe(201);
      ids[code] = r.body.id;
    }
    const comp = await adm().get('/api/lookup/pay_components');
    expect(comp.status, comp.text).toBe(200);
    expect((await adm().post('/api/m/employee_pay_items', { employee_id: ids.ZA1, component_id: comp.body[0].value, amount: 1234, start_date: '2020-01-01' })).status).toBe(201);
    expect((await adm().post('/api/m/salary_history', { employee_id: ids.ZA3, effective_date: '2020-01-01', base_salary: 30000, reason: 'zz_test' })).status).toBe(201);
  });
  it('a Payroll Officer creates and calculates a ZAA period; a ZAB period stays draft', async () => {
    const p = await c.payroll!.post('/api/payroll/periods', { company_id: ids.ZAA, code: `ZA-${Y}-01`, name: 'zz acc', start_date: `${Y}-01-01`, end_date: `${Y}-01-31`, pay_date: `${Y}-01-31` });
    expect(p.status, p.text).toBe(201);
    ids.period = p.body.id;
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.period}/calculate`)).status).toBe(200);
    const d = await c.payroll!.post('/api/payroll/periods', { company_id: ids.ZAB, code: `ZB-${Y}-01`, name: 'zz acc draft', start_date: `${Y}-01-01`, end_date: `${Y}-01-31`, pay_date: `${Y}-01-31` });
    expect(d.status, d.text).toBe(201);
    ids.draft = d.body.id;
    ids.slip = Number(one(`SELECT id FROM payslips WHERE period_id = ${ids.period} AND employee_id = ${ids.ZA1}`).id);
  });
});

describe('provisioning: script, employee link, first login', () => {
  it('creates the accounts with the initial password, must-change set, employee linked by code (none for an unlinked account)', () => {
    provision('zz_acc_staff', 'acc_staff', 'zzInitial01@123', 'ZA1');
    provision('zz_acc_staff2', 'acc_staff', 'zzInitial02@123');
    provision('zz_acc_mgr', 'acc_manager', 'zzInitialM@123', 'ZA3');
    const rows = H.sql(`SELECT u.username, u.active, u.approval_status, u.must_change_password, u.mfa_enabled,
      (SELECT group_concat(r.code) FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id) AS roles,
      (SELECT e.emp_code FROM employees e WHERE e.user_id = u.id) AS emp FROM users u WHERE u.username LIKE 'zz_acc%' ORDER BY u.username`);
    expect(rows).toEqual([
      { username: 'zz_acc_mgr', active: 1, approval_status: 'approved', must_change_password: 1, mfa_enabled: 0, roles: 'acc_manager', emp: 'ZA3' },
      { username: 'zz_acc_staff', active: 1, approval_status: 'approved', must_change_password: 1, mfa_enabled: 0, roles: 'acc_staff', emp: 'ZA1' },
      { username: 'zz_acc_staff2', active: 1, approval_status: 'approved', must_change_password: 1, mfa_enabled: 0, roles: 'acc_staff', emp: null },
    ]);
  });
  it('--create-only never touches an existing account and never re-links an employee already linked', () => {
    const before = one("SELECT password_hash FROM users WHERE username = 'zz_acc_staff'");
    provision('zz_acc_staff', 'acc_manager', 'zzOther99@1234', 'ZA2');
    expect(one("SELECT password_hash FROM users WHERE username = 'zz_acc_staff'")).toEqual(before);
    expect(one("SELECT group_concat(r.code) AS roles FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id WHERE u.username = 'zz_acc_staff'").roles).toBe('acc_staff');
    expect(one(`SELECT user_id FROM employees WHERE id = ${ids.ZA2}`).user_id).toBeNull();
    provision('zz_acc_other', 'acc_staff', 'zzOther98@1234', 'ZA1'); // ZA1 already belongs to zz_acc_staff
    expect(one(`SELECT u.username FROM employees e JOIN users u ON u.id = e.user_id WHERE e.id = ${ids.ZA1}`).username).toBe('zz_acc_staff');
    H.sql("DELETE FROM user_roles WHERE user_id = (SELECT id FROM users WHERE username = 'zz_acc_other'); DELETE FROM users WHERE username = 'zz_acc_other';");
  });
  it('first login: the initial password works, then everything but password change and MFA enrolment is refused', async () => {
    for (const [key, username, initial] of [['accStaff', 'zz_acc_staff', 'zzInitial01@123'], ['accStaff2', 'zz_acc_staff2', 'zzInitial02@123'], ['accMgr', 'zz_acc_mgr', 'zzInitialM@123']] as const) {
      const who = new Client(H.baseUrl);
      const r = await who.post('/api/auth/login', { username, password: initial });
      expect(r.status, r.text).toBe(200);
      expect(r.body.status).toBe('mfa_enroll_required'); // privileged role: MFA enrolment is enforced
      expect((await who.get('/api/payroll/periods')).status).toBe(403);
      expect((await who.get('/api/m/employees')).status).toBe(403);
      const setup = await who.post('/api/security/mfa/setup');
      expect(setup.status, setup.text).toBe(200);
      who.totpSecret = setup.body.secret;
      const { totpCode } = await import('../../src/shared/totp');
      expect((await who.post('/api/security/mfa/enable', { code: await totpCode(who.totpSecret as string) })).status).toBe(200);
      const blocked = await who.get('/api/payroll/periods');
      expect(blocked.status).toBe(403);
      expect(blocked.body.code ?? blocked.text).toMatch(/password_change_required|mfa/);
      expect((await who.post('/api/auth/change-password', { currentPassword: initial, newPassword: initial })).status).toBe(400); // must differ
      expect((await who.post('/api/auth/change-password', { currentPassword: initial, newPassword: `Zz-${username}-New-2026!` })).status).toBe(200);
      const fresh = new Client(H.baseUrl);
      fresh.totpSecret = who.totpSecret;
      const again = await fresh.login(username, `Zz-${username}-New-2026!`);
      expect(again.status, again.text).toBe(200);
      expect((await fresh.get('/api/payroll/periods')).status).toBe(200);
      c[key] = fresh;
    }
    expect(H.sql("SELECT COUNT(*) AS n FROM users WHERE username LIKE 'zz_acc%' AND (must_change_password = 1 OR mfa_enabled = 0)")[0]?.n).toBe(0);
  });
});

describe('ACC reads every company', () => {
  const accs = () => [c.accStaff as Client, c.accStaff2 as Client, c.accMgr as Client];
  it('company scope is "all" (from the companies table), including an account with no employee link', async () => {
    for (const a of accs()) {
      const m = (await a.get('/api/meta')).body;
      expect(m.companies.scope).toBe('all');
      const codes = m.companies.items.map((x: { code: string }) => x.code);
      expect(codes).toEqual(expect.arrayContaining(['ZAA', 'ZAB']));
      const menu = m.menu.map((x: { key: string }) => x.key);
      expect(menu).toEqual(expect.arrayContaining(['dashboard', 'employees', 'payroll', 'payroll_preview', 'payslips', 'reports', 'attendance_import', 'ot_review']));
      for (const k of ['users', 'roles', 'settings', 'audit']) expect(menu).not.toContain(k);
    }
  });
  it('employee directory of both companies; bank account, tax ID and base salary on the record stay masked', async () => {
    for (const a of accs()) {
      for (const co of ['ZAA', 'ZAB']) {
        const r = await a.get(`/api/m/employees?f.company_id=${ids[co]}`);
        expect(r.status, r.text).toBe(200);
        expect(r.body.rows.length).toBeGreaterThan(0);
      }
      const e = await a.get(`/api/m/employees/${ids.ZA3}`);
      expect(e.status).toBe(200);
      expect(e.body.first_name).toBe('zz_test');
      for (const f of ['bank_account', 'bank_name', 'tax_id', 'base_salary']) expect(e.body[f], f).toBe(MASK);
      expect(e.body.password_hash).toBeUndefined();
      expect((await a.get(`/api/m/employees/export.csv?f.company_id=${ids.ZAA}`)).status).toBe(403);
    }
  });
  it('payroll periods, payslips, payslip detail, preview (calculated and draft) of every company', async () => {
    const slips = () => one(`SELECT COUNT(*) AS n, COALESCE(SUM(net), 0) AS net FROM payslips`);
    const before = slips();
    for (const a of accs()) {
      const periods = (await a.get('/api/payroll/periods')).body.map((p: { id: number }) => p.id);
      expect(periods).toEqual(expect.arrayContaining([ids.period, ids.draft]));
      expect((await a.get(`/api/payroll/payslips?period_id=${ids.period}`)).body.length).toBeGreaterThan(0);
      const slip = await a.get(`/api/payslips/${ids.slip}`);
      expect(slip.status, slip.text).toBe(200);
      expect(slip.body.net).toBeGreaterThan(0);
      for (const [pid, co] of [[ids.period, 'ZAA'], [ids.draft, 'ZAB']] as const) {
        const pv = await a.get(`/api/payroll/periods/${pid}/preview?company=${ids[co]}`);
        expect(pv.status, pv.text).toBe(200);
        expect(JSON.stringify(pv.body)).not.toContain('000-0-ZA');
      }
    }
    expect(slips()).toEqual(before); // previewing a draft period computes in memory only
  });
  it('pay items and salary history amounts are readable (payroll data), not editable', async () => {
    for (const a of accs()) {
      const items = await a.get('/api/m/employee_pay_items');
      expect(items.status).toBe(200);
      expect(items.body.rows.some((r: { amount: unknown }) => r.amount === 1234)).toBe(true);
      const hist = await a.get('/api/m/salary_history');
      expect(hist.status).toBe(200);
      expect(hist.body.rows.some((r: { base_salary: unknown }) => r.base_salary === 30000)).toBe(true);
    }
  });
  it('dashboard, reports and attendance summaries open', async () => {
    for (const a of accs()) {
      for (const path of ['/api/dashboard', '/api/reports/datasets', '/api/attendance/imports', '/api/attendance/ot', '/api/m/attendance', '/api/m/leave', '/api/m/overtime', '/api/leave-imports', '/api/overtime-imports', '/api/attendance-files', `/api/attendance-exemptions?employee_id=${ids.ZA3}`, '/api/holidays']) {
        const r = await a.get(path);
        expect(r.status, `${path} ${r.text}`).toBe(200);
      }
    }
  });
});

describe('ACC changes nothing', () => {
  const accs = () => [c.accStaff as Client, c.accStaff2 as Client, c.accMgr as Client];
  it('cannot create, calculate, reopen, approve, publish or export payroll with bank data; period admin is refused', async () => {
    const before = one(`SELECT status, calculated_by, approved_by FROM payroll_periods WHERE id = ${ids.period}`);
    for (const a of accs()) {
      expect((await a.post('/api/payroll/periods', { company_id: ids.ZAA, code: `ZX-${Y}`, name: 'x', start_date: `${Y}-02-01`, end_date: `${Y}-02-28`, pay_date: `${Y}-02-28` })).status).toBe(403);
      expect((await a.post(`/api/payroll/periods/${ids.draft}/calculate`)).status).toBe(403);
      expect((await a.post(`/api/payroll/periods/${ids.period}/reopen`)).status).toBe(403);
      expect((await a.post(`/api/payroll/periods/${ids.period}/approve`)).status).toBe(403);
      expect((await a.post(`/api/payroll/periods/${ids.period}/approve`, { note: 'zz ขออนุมัติ' })).status).toBe(403);
      expect((await a.post(`/api/payroll/periods/${ids.period}/publish`)).status).toBe(403);
      expect((await a.get(`/api/payroll/periods/${ids.period}/export.csv`)).status).toBe(403);
      expect((await a.post(`/api/payroll/periods/${ids.period}/reopen-closed`, { reason: 'zz' })).status).toBe(403);
      expect((await a.post(`/api/payroll/periods/${ids.period}/delete`, { reason: 'zz' })).status).toBe(403);
      expect((await a.put(`/api/payroll/layouts/${ids.ZAA}`, { columns: [] })).status).toBe(403);
    }
    expect(one(`SELECT status, calculated_by, approved_by FROM payroll_periods WHERE id = ${ids.period}`)).toEqual(before);
    expect(before.status).toBe('calculated');
  });
  it('Payroll Preview export: ACC Manager only', async () => {
    expect((await c.accStaff!.get(`/api/payroll/periods/${ids.period}/preview.csv?company=${ids.ZAA}`)).status).toBe(403);
    const ok = await c.accMgr!.get(`/api/payroll/periods/${ids.period}/preview.csv?company=${ids.ZAA}`);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.text).not.toContain('000-0-ZA');
  });
  it('cannot change employees, pay items, salary history, attendance imports or OT review', async () => {
    const snapshot = () => one(`SELECT (SELECT group_concat(first_name || base_salary || COALESCE(user_id, '')) FROM employees) e, (SELECT COUNT(*) || SUM(amount) FROM employee_pay_items) pi, (SELECT COUNT(*) FROM employee_salary_history) sh, (SELECT COUNT(*) FROM attendance_imports) ai`);
    const before = snapshot();
    for (const a of accs()) {
      expect((await a.put(`/api/m/employees/${ids.ZA2}`, { first_name: 'hacked' })).status).toBe(403);
      expect((await a.post('/api/m/employees', { emp_code: 'ZAX', first_name: 'x', last_name: 'x', company_id: ids.ZAA, hire_date: '2020-01-01', employment_type: 'permanent', status: 'active' })).status).toBe(403);
      expect((await a.del(`/api/m/employees/${ids.ZA2}`)).status).toBe(403);
      expect((await a.post('/api/m/employee_pay_items', { employee_id: ids.ZA2, component_id: 1, amount: 1, start_date: '2020-01-01' })).status).toBe(403);
      expect((await a.post('/api/m/salary_history', { employee_id: ids.ZA2, effective_date: '2021-01-01', base_salary: 1, reason: 'x' })).status).toBe(403);
      expect((await a.post('/api/attendance/imports', {})).status).toBe(403);
      expect((await a.post('/api/attendance/ot/confirm-all', {})).status).toBe(403);
      expect((await a.post('/api/m/leave', { employee_id: ids.ZA2 })).status).toBe(403);
    }
    expect(snapshot()).toEqual(before);
  });
  it('Super Admin areas and the audit log are refused', async () => {
    for (const a of accs()) {
      for (const path of ['/api/admin/users', '/api/admin/roles', '/api/admin/settings', '/api/admin/jobs/probation', '/api/audit', '/api/payroll/deleted-periods']) {
        expect((await a.get(path)).status, path).toBe(403);
      }
      expect((await a.post('/api/admin/users', { username: 'zz_evil', displayName: 'x', roles: ['super_admin'] })).status).toBe(403);
      expect((await a.put('/api/admin/settings', { 'security.mfa_enforce_privileged': false })).status).toBe(403);
    }
  });
});

describe('no regression for other roles', () => {
  it('an employee and HR Staff keep their scope; a Payroll Officer still calculates', async () => {
    expect((await c.employee!.get('/api/meta')).body.companies.scope).toBe('own');
    expect((await c.employee!.get('/api/payroll/periods')).status).toBe(403);
    expect((await c.employee!.get(`/api/m/employees?f.company_id=${ids.ZAB}`)).status).toBe(403);
    expect((await c.staff!.get('/api/payroll/periods')).status).toBe(403);
    expect((await c.payroll!.get('/api/payroll/periods')).status).toBe(200);
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.draft}/calculate`)).status).toBe(200);
  });
});
