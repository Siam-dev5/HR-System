// App Management — isolated local D1, synthetic data only. Real sessions for every identity (Super Admin, HR Admin,
// HR Manager, Payroll Officer, HR Leader, HR Payroll, ACC Staff, ACC Manager, Employee, unauthenticated); privileged
// identities enrol MFA through the normal login flow. Covers the authorization matrix of every administrative
// endpoint, privilege escalation / IDOR / injection attempts, protected roles, company scope validation, audit
// before / after values and that no secret ever leaves the API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MetaResponse } from '../../src/shared/types';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const ids: Record<string, number> = {};
const one = (sql: string) => H.sql(sql)[0] as Record<string, any>;
const sa = () => c.superAdmin as Client;
const uid = (username: string) => Number(one(`SELECT id FROM users WHERE username = '${username}'`).id);
const tempPasswords: string[] = [];

/** Every administrative endpoint (method, path, body). Bodies are harmless for the Super Admin probe below. */
const ENDPOINTS = (): Array<[string, string, unknown?]> => [
  ['GET', '/api/admin/app/overview'],
  ['GET', '/api/admin/app/users'],
  ['GET', `/api/admin/app/users/${ids.target}`],
  ['POST', `/api/admin/app/users/${ids.target}/require-password-change`],
  ['GET', '/api/admin/app/company-scope'],
  ['PUT', `/api/admin/app/users/${ids.target}/company-scope`, { employeeId: null }],
  ['GET', '/api/admin/app/permissions'],
  ['GET', '/api/admin/app/security'],
  ['GET', '/api/admin/app/audit'],
  ['GET', '/api/admin/users'],
  ['POST', '/api/admin/users', { username: 'zz_escalate', displayName: 'x', roles: ['super_admin'] }],
  ['PUT', `/api/admin/users/${ids.target}`, { roles: ['super_admin'] }],
  ['POST', `/api/admin/users/${ids.target}/reset-password`],
  ['POST', `/api/admin/users/${ids.target}/unlock`],
  ['POST', `/api/admin/users/${ids.target}/reset-mfa`],
  ['POST', `/api/admin/users/${ids.target}/approve`, { roles: ['super_admin'] }],
  ['POST', `/api/admin/users/${ids.target}/reject`],
  ['GET', '/api/admin/roles'],
  ['POST', '/api/admin/roles', { code: 'zz_evil', name: 'x', permissions: ['employees.view'] }],
  ['PUT', `/api/admin/roles/${ids.employeeRole}`, { permissions: ['*.view', 'payroll.approve'] }],
  ['DELETE', `/api/admin/roles/${ids.customRole}`],
  ['GET', '/api/admin/settings'],
  ['PUT', '/api/admin/settings', { 'security.mfa_enforce_privileged': false }],
  ['GET', '/api/admin/jobs/probation'],
  ['POST', '/api/admin/jobs/probation/run', { dryRun: true }],
];

const DENIED = ['hrAdmin', 'hrManager', 'payrollOfficer', 'hrLeader', 'hrPayroll', 'accStaff', 'accManager', 'employee'] as const;

/** Creates an account through the Admin API as a Super Admin does, then signs it in (password change, MFA). */
async function provision(key: string, username: string, roles: string[]): Promise<void> {
  const r = await sa().post('/api/admin/users', { username, displayName: username, roles });
  expect(r.status, r.text).toBe(201);
  tempPasswords.push(r.body.temporaryPassword);
  const who = new Client(H.baseUrl);
  await who.login(username, r.body.temporaryPassword);
  const next = `Zz-${username}-Pass-2026!`;
  expect((await who.post('/api/auth/change-password', { currentPassword: r.body.temporaryPassword, newPassword: next })).status).toBe(200);
  c[key] = who;
}

/** Counts of everything an unauthorised call could have changed. */
const fingerprint = () => one(`SELECT
  (SELECT COUNT(*) FROM users) u, (SELECT group_concat(id || ':' || active || ':' || must_change_password || ':' || mfa_enabled || ':' || password_hash) FROM users) uh,
  (SELECT group_concat(user_id || ':' || role_id) FROM (SELECT * FROM user_roles ORDER BY 1, 2)) ur,
  (SELECT group_concat(role_id || ':' || permission) FROM (SELECT * FROM role_permissions ORDER BY 1, 2)) rp, (SELECT COUNT(*) FROM roles) r,
  (SELECT group_concat(key || '=' || value) FROM settings) s, (SELECT group_concat(id || ':' || COALESCE(user_id, '')) FROM employees) e,
  (SELECT COUNT(*) FROM payslips) ps, (SELECT COUNT(*) FROM payroll_periods) pp`);

beforeAll(async () => {
  H = await startHarness();
  const login = async (key: string, username: keyof Harness['passwords']) => {
    const x = new Client(H.baseUrl);
    await x.login(username, H.passwords[username]);
    c[key] = x;
  };
  await login('superAdmin', 'it_admin');
  await login('payrollOfficer', 'it_payroll');
  await login('hrManager', 'it_manager');
  await login('employee', 'it_employee');
  await provision('hrAdmin', 'zz_hradmin', ['hr_admin']);
  await provision('hrLeader', 'zz_leader', ['hr_leader']);
  await provision('hrPayroll', 'zz_hrpay', ['hr_payroll']);
  await provision('accStaff', 'zz_accstaff', ['acc_staff']);
  await provision('accManager', 'zz_accmgr', ['acc_manager']);
  await provision('superAdmin2', 'zz_admin2', ['super_admin']);
  // a target account (employee role, no link) and an unused custom role
  const t = await sa().post('/api/admin/users', { username: 'zz_target', displayName: 'zz target', roles: ['employee'] });
  expect(t.status, t.text).toBe(201);
  tempPasswords.push(t.body.temporaryPassword);
  ids.target = t.body.id;
  const role = await sa().post('/api/admin/roles', { code: 'zz_custom', name: 'zz custom', description: 'zz test', privileged: false, permissions: ['help.view'] });
  expect(role.status, role.text).toBe(201);
  ids.customRole = role.body.id;
  ids.employeeRole = Number(one("SELECT id FROM roles WHERE code = 'employee'").id);
  const co = await sa().post('/api/m/companies', { code: 'ZAM', name: 'zz_test app management', active: true });
  expect(co.status, co.text).toBe(201);
  ids.otherCompany = co.body.id;
  c.anon = new Client(H.baseUrl);
}, 300_000);
afterAll(async () => {
  await H?.stop();
});

describe('authorization matrix: every administrative endpoint', () => {
  it('unauthenticated requests get 401 (also with a forged session cookie)', async () => {
    for (const [method, path, body] of ENDPOINTS()) {
      const r = await c.anon!.req(method, path, body ?? (method === 'GET' || method === 'DELETE' ? undefined : {}));
      expect(r.status, `anon ${method} ${path}`).toBe(401);
    }
    const forged = new Client(H.baseUrl);
    forged.cookie = 'hr_session=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect((await forged.get('/api/admin/app/users')).status).toBe(401);
  });
  it('HR Admin, HR Manager, Payroll Officer, HR Leader, HR Payroll, ACC Staff, ACC Manager and Employee get 403 and change nothing', async () => {
    const before = fingerprint();
    for (const k of DENIED) {
      for (const [method, path, body] of ENDPOINTS()) {
        const r = await c[k]!.req(method, path, body ?? (method === 'GET' || method === 'DELETE' ? undefined : {}));
        expect(r.status, `${k} ${method} ${path}: ${r.text.slice(0, 120)}`).toBe(403);
        expect(r.text).not.toMatch(/password_hash|pbkdf2\$|mfa_secret/);
      }
    }
    expect(fingerprint()).toEqual(before);
  }, 240_000);
  it('Super Admin is authorized on every read endpoint', async () => {
    for (const [, path] of ENDPOINTS().filter(([m]) => m === 'GET')) {
      const r = await sa().get(path);
      expect(r.status, `${path}: ${r.text.slice(0, 200)}`).toBe(200);
    }
  });
  it('state-changing calls without the CSRF header are refused even for a Super Admin', async () => {
    const r = await sa().req('POST', `/api/admin/app/users/${ids.target}/require-password-change`, {}, { 'x-hr-requested': '0' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('csrf');
  });
});

describe('menu and direct navigation', () => {
  it('App Management is in the Super Admin menu only; the module is not allowed for anyone else', async () => {
    const m = (await sa().get<MetaResponse>('/api/meta')).body;
    expect(m.menu.find((x) => x.key === 'app_management')).toMatchObject({ path: '/admin/app-management' });
    for (const k of DENIED) {
      const meta = (await c[k]!.get<MetaResponse>('/api/meta')).body;
      expect(meta.menu.some((x) => x.key === 'app_management'), k).toBe(false);
      expect(meta.modules.find((x) => x.key === 'app_management'), k).toMatchObject({ allowed: false, perm: 'super_admin' });
    }
  });
  it('app_management.manage is reserved: not in the catalogue, not grantable, and a mis-granted pattern opens nothing', async () => {
    const d = (await sa().get('/api/admin/app/permissions')).body;
    expect(d.catalogue).not.toContain('app_management.manage');
    expect(d.reserved).toContain('app_management.manage');
    const hrm = d.roles.find((r: { code: string }) => r.code === 'hr_manager');
    expect((await sa().put(`/api/admin/roles/${hrm.id}`, { permissions: [...hrm.permissions, 'app_management.manage'] })).status).toBe(400);
    H.sql("INSERT INTO role_permissions (role_id, permission) SELECT id, 'app_management.manage' FROM roles WHERE code = 'hr_manager'");
    try {
      expect((await c.hrManager!.get('/api/admin/app/overview')).status).toBe(403);
      expect((await c.hrManager!.get<MetaResponse>('/api/meta')).body.menu.some((x) => x.key === 'app_management')).toBe(false);
    } finally {
      H.sql("DELETE FROM role_permissions WHERE permission = 'app_management.manage'");
    }
  });
});

describe('read models', () => {
  it('overview counts, users with roles / employee / company scope, filters, and no secret fields', async () => {
    const o = (await sa().get('/api/admin/app/overview')).body;
    expect(o.users.total).toBeGreaterThanOrEqual(12);
    expect(o.users.superAdmins).toBeGreaterThanOrEqual(2);
    expect(o.permissions.catalogue).toBeGreaterThan(100);
    const users = (await sa().get('/api/admin/app/users')).body;
    const acc = users.find((u: { username: string }) => u.username === 'zz_accstaff');
    expect(acc).toMatchObject({ roles: ['acc_staff'], privileged: true, scope: { scope: 'all', via: ['acc_staff'] } });
    const emp = users.find((u: { username: string }) => u.username === 'it_employee');
    expect(emp.scope.scope).toBe('own');
    expect(emp.employee.emp_code).toBe('E007');
    expect(users.find((u: { username: string }) => u.username === 'zz_target').scope.scope).toBe('none');
    const byRole = (await sa().get('/api/admin/app/users?role=acc_manager')).body;
    expect(byRole.map((u: { username: string }) => u.username)).toEqual(['zz_accmgr']);
    expect((await sa().get('/api/admin/app/users?q=zz_hrp')).body.map((u: { username: string }) => u.username)).toEqual(['zz_hrpay']);
    expect((await sa().get('/api/admin/app/users?status=bogus')).status).toBe(400);
    expect((await sa().get("/api/admin/app/users?role=x'%20OR%201=1--")).status).toBe(400);
    expect((await sa().get(`/api/admin/app/users?q=${encodeURIComponent("' OR '1'='1")}`)).body).toEqual([]);
    for (const path of ['/api/admin/app/users', `/api/admin/app/users/${uid('zz_accstaff')}`, '/api/admin/app/security', '/api/admin/app/company-scope', '/api/admin/users', '/api/admin/app/overview', '/api/admin/app/audit']) {
      const text = (await sa().get(path)).text;
      expect(text, path).not.toMatch(/password_hash|pbkdf2\$|mfa_secret|session_id|"token"/);
      for (const p of [...Object.values(H.passwords), ...tempPasswords]) expect(text, path).not.toContain(p);
    }
  });
  it('user detail: effective permissions of the ACC Manager (preview export, no payroll.export, no admin)', async () => {
    const d = (await sa().get(`/api/admin/app/users/${uid('zz_accmgr')}`)).body;
    expect(d.effective_permissions).toEqual(expect.arrayContaining(['employees.all', 'payroll.view', 'payroll_preview.export']));
    for (const p of ['payroll.export', 'payroll.approve', 'payroll.calculate', 'payroll.publish', 'employees.sensitive', 'users.manage', 'roles.manage', 'app_management.manage']) expect(d.effective_permissions).not.toContain(p);
    expect(d.mfa_enabled).toBe(1);
    expect((await sa().get('/api/admin/app/users/999999')).status).toBe(404);
    expect((await sa().get('/api/admin/app/users/abc')).status).toBe(400);
  });
  it('permission matrix lists only real permissions, grouped by module, with the nine action columns', async () => {
    const d = (await sa().get('/api/admin/app/permissions')).body;
    expect(d.actions).toEqual(['view', 'create', 'update', 'delete', 'export', 'approve', 'calculate', 'publish', 'manage']);
    const all = d.groups.flatMap((g: { rows: Array<{ cells: Record<string, string>; extras: string[] }> }) => g.rows.flatMap((r) => [...Object.values(r.cells), ...r.extras]));
    expect([...all].sort()).toEqual([...d.catalogue].sort());
    const payroll = d.groups.flatMap((g: { rows: unknown[] }) => g.rows).find((r: { resource: string }) => r.resource === 'payroll');
    expect(payroll.cells).toMatchObject({ view: 'payroll.view', approve: 'payroll.approve', calculate: 'payroll.calculate', publish: 'payroll.publish', export: 'payroll.export' });
    expect(payroll.reserved).toEqual(expect.arrayContaining(['payroll.period.reopen']));
  });
});

describe('privilege escalation and protected safeguards', () => {
  it('a Super Admin cannot change their own roles (no self-escalation, no self-demotion)', async () => {
    const me = uid('it_admin');
    expect((await sa().put(`/api/admin/users/${me}`, { roles: ['super_admin', 'hr_admin'] })).status).toBe(403);
    expect((await sa().put(`/api/admin/users/${me}`, { roles: ['hr_admin'] })).status).toBe(403);
    expect((await sa().put(`/api/admin/users/${me}`, { roles: ['super_admin'], displayName: 'it_admin' })).status).toBe(200); // unchanged roles are fine
    expect((await sa().put(`/api/admin/users/${me}`, { active: false })).status).toBe(403);
    expect(one(`SELECT group_concat(r.code) AS roles FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ${me}`).roles).toBe('super_admin');
  });
  it('non-Super Admins cannot assign Super Admin, change their own role or create administrator accounts', async () => {
    for (const k of ['hrAdmin', 'accStaff', 'accManager', 'hrLeader'] as const) {
      const self = uid({ hrAdmin: 'zz_hradmin', accStaff: 'zz_accstaff', accManager: 'zz_accmgr', hrLeader: 'zz_leader' }[k]);
      expect((await c[k]!.put(`/api/admin/users/${self}`, { roles: ['super_admin'] })).status).toBe(403);
      expect((await c[k]!.put(`/api/admin/users/${ids.target}`, { roles: ['super_admin'] })).status).toBe(403);
      expect((await c[k]!.post('/api/admin/users', { username: `zz_admin_${k}`, displayName: 'x', roles: ['super_admin'] })).status).toBe(403);
      expect((await c[k]!.put(`/api/admin/roles/${ids.employeeRole}`, { permissions: ['*.view', '*.update'] })).status).toBe(403);
    }
    expect(one("SELECT COUNT(*) n FROM users WHERE username GLOB 'zz_admin_*'").n).toBe(0);
    expect(one(`SELECT COUNT(*) n FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.code = 'super_admin'`).n).toBe(2);
  });
  it('unknown, reserved or wildcard-all permission keys are rejected by the role editor', async () => {
    const before = fingerprint();
    for (const bad of [['payroll.hack'], ['foo.bar'], ['employees.view', 'nope.view'], ['users.manage'], ['app_management.manage'], ['payroll.period.reopen'], ['*'], ['*.manage'], ['bad permission'], ["x'); DROP TABLE roles;--"]]) {
      const r = await sa().put(`/api/admin/roles/${ids.customRole}`, { permissions: bad });
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await sa().post('/api/admin/roles', { code: 'zz_inject', name: 'x', permissions: ['payroll.approvex'] })).status).toBe(400);
    expect((await sa().post('/api/admin/roles', { code: 'super_admin', name: 'x', permissions: [] })).status).toBe(409);
    expect(fingerprint()).toEqual(before);
  });
  it('protected roles: super_admin is not editable; built-in roles cannot be deleted; a role in use cannot be deleted', async () => {
    const roles = (await sa().get('/api/admin/app/permissions')).body.roles as Array<{ id: number; code: string }>;
    const id = (code: string) => (roles.find((r) => r.code === code) as { id: number }).id;
    expect((await sa().put(`/api/admin/roles/${id('super_admin')}`, { permissions: ['help.view'] })).status).toBe(403);
    for (const code of ['super_admin', 'acc_staff', 'hr_leader', 'employee']) expect((await sa().del(`/api/admin/roles/${id(code)}`)).status, code).toBe(403);
    expect((await sa().put(`/api/admin/users/${ids.target}`, { roles: ['employee', 'zz_custom'] })).status).toBe(200);
    expect((await sa().del(`/api/admin/roles/${ids.customRole}`)).status).toBe(409);
    expect((await sa().put(`/api/admin/users/${ids.target}`, { roles: ['employee'] })).status).toBe(200);
    expect((await sa().del('/api/admin/roles/999999')).status).toBe(404);
  });
});

describe('company scope', () => {
  it('links an employee (own-company scope) with server-side validation of employee and company', async () => {
    const e1 = Number(one("SELECT id FROM employees WHERE emp_code = 'E001'").id);
    const co = Number(one(`SELECT company_id FROM employees WHERE id = ${e1}`).company_id);
    const other = Number(one(`SELECT id FROM companies WHERE id <> ${co} ORDER BY id LIMIT 1`).id);
    const taken = Number(one("SELECT id FROM employees WHERE emp_code = 'E007'").id); // linked to it_employee
    const put = (body: unknown) => sa().put(`/api/admin/app/users/${ids.target}/company-scope`, body);
    expect((await put({ employeeId: taken })).status).toBe(409);
    expect((await put({ employeeId: e1, companyId: other })).status).toBe(400);
    expect((await put({ employeeId: 999999 })).status).toBe(400);
    expect((await put({ employeeId: 'abc' })).status).toBe(400);
    expect((await put({ employeeId: -1 })).status).toBe(400);
    expect((await put({ employeeId: null, companyId: co })).status).toBe(400);
    expect(one(`SELECT user_id FROM employees WHERE id = ${taken}`).user_id).toBe(uid('it_employee'));
    const ok = await put({ employeeId: e1, companyId: co });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.scope).toMatchObject({ scope: 'own', companyId: co });
    const a = one(`SELECT details FROM audit_logs WHERE action = 'user.company_scope_changed' AND entity_id = '${ids.target}' ORDER BY id DESC LIMIT 1`);
    expect(JSON.parse(a.details)).toMatchObject({ before: { scope: 'none', companyId: null }, after: { scope: 'own', companyId: co } });
    expect((await put({ employeeId: null })).body.scope.scope).toBe('none');
  });
  it('company scope cannot be widened through query parameters: own-scope users are refused other companies', async () => {
    const own = Number(one("SELECT company_id FROM employees WHERE emp_code = 'E007'").company_id);
    const other = Number(one(`SELECT id FROM companies WHERE id <> ${own} AND active = 1 ORDER BY id LIMIT 1`).id);
    expect((await c.employee!.get(`/api/m/employees?f.company_id=${other}`)).status).toBe(403);
    expect((await c.employee!.get(`/api/dashboard?company=${other}`)).status).toBe(403);
    const someoneElse = Number(one("SELECT id FROM employees WHERE emp_code = 'E001'").id);
    expect((await c.employee!.get(`/api/m/employees/${someoneElse}`)).status).toBe(404); // IDOR: another person's record
    expect((await c.employee!.get(`/api/admin/app/users/${uid('it_admin')}`)).status).toBe(403);
    expect((await c.accStaff!.get(`/api/admin/app/users/${uid('it_admin')}`)).status).toBe(403);
  });
});

describe('account actions and audit (actor, target, before / after, no secrets)', () => {
  it('role, activation and employee-link changes are audited with before / after values', async () => {
    const actor = ids.admin ?? uid('it_admin');
    expect((await sa().put(`/api/admin/users/${ids.target}`, { roles: ['employee', 'acc_staff'], displayName: 'zz target 2' })).status).toBe(200);
    expect((await sa().put(`/api/admin/users/${ids.target}`, { active: false })).status).toBe(200);
    expect((await sa().put(`/api/admin/users/${ids.target}`, { active: true, roles: ['employee'] })).status).toBe(200);
    const rows = H.sql(`SELECT action, user_id, username, details, at FROM audit_logs WHERE entity = 'user' AND entity_id = '${ids.target}' ORDER BY id`) as Array<{ action: string; user_id: number; username: string; details: string; at: string }>;
    const log = (action: string) => rows.filter((x) => x.action === action);
    const roles = log('user.roles_changed');
    expect(roles.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(roles.at(-2)!.details)).toMatchObject({ username: 'zz_target', before: ['employee'], after: ['acc_staff', 'employee'], added: ['acc_staff'], removed: [] });
    expect(JSON.parse(roles.at(-1)!.details)).toMatchObject({ added: [], removed: ['acc_staff'] });
    expect(roles.at(-1)).toMatchObject({ user_id: actor, username: 'it_admin' });
    expect(roles.at(-1)!.at).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(JSON.parse(log('user.deactivated').at(-1)!.details)).toMatchObject({ before: true, after: false });
    expect(JSON.parse(log('user.activated').at(-1)!.details)).toMatchObject({ before: false, after: true });
    const upd = JSON.parse(log('user.updated').find((x) => x.details.includes('zz target 2'))!.details);
    expect(upd.changes.display_name).toEqual({ before: 'zz target', after: 'zz target 2' });
    // acc_staff granted employees.all: the scope change itself is audited too
    expect(log('user.company_scope_changed').some((x) => JSON.parse(x.details).after.scope === 'all')).toBe(true);
  }, 120_000);
  it('a deactivated account is signed out at once; require-password-change restricts the next request', async () => {
    const who = new Client(H.baseUrl);
    const pw = 'Zz-Target-Pass-2026!';
    const temp = await sa().post(`/api/admin/users/${ids.target}/reset-password`);
    tempPasswords.push(temp.body.temporaryPassword);
    await who.login('zz_target', temp.body.temporaryPassword);
    expect((await who.post('/api/auth/change-password', { currentPassword: temp.body.temporaryPassword, newPassword: pw })).status).toBe(200);
    expect((await who.get('/api/ess')).status).not.toBe(403);
    const r = await sa().post(`/api/admin/app/users/${ids.target}/require-password-change`);
    expect(r.body).toEqual({ ok: true, changed: true });
    const blocked = await who.get('/api/ess');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('password_change_required');
    expect((await sa().post(`/api/admin/app/users/${uid('it_admin')}/require-password-change`)).status).toBe(409);
    expect((await sa().put(`/api/admin/users/${ids.target}`, { active: false })).status).toBe(200);
    expect((await who.get('/api/auth/me')).status).toBe(401);
    expect(JSON.parse(one(`SELECT details FROM audit_logs WHERE action = 'user.password_change_required' AND entity_id = '${ids.target}'`).details)).toMatchObject({ before: false, after: true });
  });
  it('role permission changes and custom-role deletion are audited with added / removed and before / after', async () => {
    const r = await sa().put(`/api/admin/roles/${ids.customRole}`, { name: 'zz custom 2', description: 'zz', privileged: true, permissions: ['help.view', 'reports.view'] });
    expect(r.status, r.text).toBe(200);
    const a = JSON.parse(one(`SELECT details FROM audit_logs WHERE action = 'role.updated' AND entity_id = '${ids.customRole}' ORDER BY id DESC LIMIT 1`).details);
    expect(a).toMatchObject({ added: ['reports.view'], removed: [], before: { name: 'zz custom', privileged: false, permissions: ['help.view'] }, after: { name: 'zz custom 2', privileged: true } });
    expect((await sa().del(`/api/admin/roles/${ids.customRole}`)).status).toBe(200);
    expect(one(`SELECT COUNT(*) n FROM roles WHERE id = ${ids.customRole}`).n).toBe(0);
    expect(JSON.parse(one(`SELECT details FROM audit_logs WHERE action = 'role.deleted' AND entity_id = '${ids.customRole}'`).details)).toMatchObject({ code: 'zz_custom', before: { permissions: ['help.view', 'reports.view'] } });
  });
  it('the security audit endpoint filters by user and action; no audit row holds a password', async () => {
    const d = (await sa().get(`/api/admin/app/audit?userId=${ids.target}&action=user.`)).body;
    expect(d.total).toBeGreaterThan(3);
    expect(d.rows.every((x: { action: string }) => x.action.startsWith('user.'))).toBe(true);
    expect((await sa().get('/api/admin/app/audit?action=x%27%20OR%201=1')).status).toBe(400);
    const details = H.sql('SELECT details FROM audit_logs WHERE details IS NOT NULL').map((x) => String(x.details)).join('\n');
    for (const p of [...Object.values(H.passwords), ...tempPasswords]) expect(details).not.toContain(p);
    expect(details).not.toMatch(/pbkdf2\$|mfa_secret/);
  });
});

describe('regression: ACC roles unchanged and still read-only', () => {
  it('ACC Staff / Manager keep their grants and cannot reach payroll write or admin paths', async () => {
    const perms = (code: string) => H.sql(`SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.code = '${code}' ORDER BY 1`).map((x) => String(x.permission));
    const staff = perms('acc_staff');
    expect(perms('acc_manager').filter((p) => !staff.includes(p))).toEqual(['payroll_preview.export']);
    for (const k of ['accStaff', 'accManager'] as const) {
      expect((await c[k]!.get('/api/payroll/periods')).status).toBe(200);
      expect((await c[k]!.post('/api/payroll/periods/1/approve')).status).toBe(403);
      expect((await c[k]!.get('/api/payroll/periods/1/export.csv')).status).toBe(403);
      expect((await c[k]!.get('/api/admin/app/overview')).status).toBe(403);
    }
  });
});
