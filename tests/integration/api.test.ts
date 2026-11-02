import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CRUD_MODULES, MODULES } from '../../src/shared/modules';
import type { LookupOption, MetaResponse } from '../../src/shared/types';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const admin = () => clients.admin as Client;
const clients: Record<string, Client> = {};

beforeAll(async () => {
  H = await startHarness();
  for (const k of ['admin', 'payroll', 'manager', 'employee', 'anon', 'locktest', 'staff']) clients[k] = new Client(H.baseUrl);
});
afterAll(async () => {
  await H?.stop();
});

describe('D1 database', () => {
  it('health endpoint queries D1', async () => {
    const r = await clients.anon!.get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, database: 'd1' });
    expect(r.body.tables).toBeGreaterThanOrEqual(50);
  });

  it('schema contains every table and column declared in the module registry (no API/DB drift)', () => {
    const perTable = H.sqlEach(CRUD_MODULES.map((m) => `PRAGMA table_info(${m.table});`).join('\n'));
    expect(perTable).toHaveLength(CRUD_MODULES.length);
    CRUD_MODULES.forEach((m, i) => {
      const cols = new Set((perTable[i] ?? []).map((r) => r.name));
      for (const c of ['id', 'created_at', 'updated_at', 'created_by', 'updated_by', ...m.fields.map((f) => f.name)]) {
        expect(cols.has(c), `${m.table}.${c}`).toBe(true);
      }
    });
  });
});

describe('authentication', () => {
  it('rejects anonymous API access and keeps public policy readable', async () => {
    expect((await clients.anon!.get('/api/meta')).status).toBe(401);
    expect((await clients.anon!.get('/api/auth/session')).body).toEqual({ me: null });
    const p = await clients.anon!.get('/api/auth/policy');
    expect(p.status).toBe(200);
    expect(p.body).toEqual({ mfaEnforcedForPrivileged: true, lockoutThreshold: 5, lockoutMinutes: 15, passwordMinLength: 12, selfRegistration: true });
  });

  it('enforces the CSRF header on state-changing requests', async () => {
    const r = await clients.anon!.req('POST', '/api/auth/login', { username: 'x', password: 'y' }, { 'x-hr-requested': '0' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('csrf');
    const o = await clients.anon!.req('POST', '/api/auth/login', { username: 'x', password: 'y' }, { origin: 'https://evil.example' });
    expect(o.status).toBe(403);
  });

  it('returns a generic error for bad credentials and validates JSON', async () => {
    const r = await clients.anon!.post('/api/auth/login', { username: 'it_admin', password: 'wrong-password' });
    expect(r.status).toBe(401);
    expect(r.body.error.message).toBe('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
    const u = await clients.anon!.post('/api/auth/login', { username: 'nobody', password: 'x' });
    expect(u.status).toBe(401);
    expect(u.body.error.message).toBe(r.body.error.message);
    const bad = await clients.anon!.req('POST', '/api/auth/login', undefined, { 'content-type': 'application/json' });
    expect(bad.status).toBe(400);
  });

  it('locks the account after the configured number of failures', async () => {
    const c = clients.locktest!;
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await c.post('/api/auth/login', { username: 'it_locktest', password: 'nope' })).status);
    expect(statuses).toEqual([401, 401, 401, 401, 423]);
    const right = await c.post('/api/auth/login', { username: 'it_locktest', password: H.passwords.it_locktest });
    expect(right.status).toBe(423);
  });

  it('privileged users must enrol MFA before using the system (matches the policy text)', async () => {
    const c = admin();
    const r = await c.post('/api/auth/login', { username: 'it_admin', password: H.passwords.it_admin });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('mfa_enroll_required');
    const blocked = await c.get('/api/meta');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('mfa_enrollment_required');
    // finish enrolment via the client helper (setup + TOTP)
    const setup = await c.post('/api/security/mfa/setup');
    expect(setup.status).toBe(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    c.totpSecret = setup.body.secret;
    const { totpCode } = await import('../../src/shared/totp');
    expect((await c.post('/api/security/mfa/enable', { code: '000000' })).status).toBe(400);
    expect((await c.post('/api/security/mfa/enable', { code: await totpCode(c.totpSecret as string) })).status).toBe(200);
    expect((await c.get('/api/meta')).status).toBe(200);
    // a privileged user cannot switch MFA off while the policy enforces it
    expect((await c.post('/api/security/mfa/disable', { password: H.passwords.it_admin })).status).toBe(409);
  });

  it('second login requires the TOTP code', async () => {
    const c = admin();
    await c.post('/api/auth/logout');
    expect((await c.get('/api/auth/me')).status).toBe(401);
    const step1 = await c.post('/api/auth/login', { username: 'it_admin', password: H.passwords.it_admin });
    expect(step1.body).toEqual({ status: 'mfa_required' });
    expect((await c.get('/api/auth/me')).status).toBe(401);
    const bad = await c.post('/api/auth/login', { username: 'it_admin', password: H.passwords.it_admin, totp: '123456' });
    expect(bad.status).toBe(401);
    const ok = await c.login('it_admin', H.passwords.it_admin);
    expect(ok.body.status).toBe('ok');
    expect((await c.get('/api/auth/me')).body.roles).toEqual(['super_admin']);
  });

  it('logs in the other test users (payroll officer enrols MFA, non-privileged users do not)', async () => {
    const p = await clients.payroll!.login('it_payroll', H.passwords.it_payroll);
    expect(p.body.status).toBe('mfa_enroll_required');
    const m = await clients.manager!.login('it_manager', H.passwords.it_manager);
    expect(m.body.status).toBe('ok');
    expect((await clients.staff!.login('it_staff', H.passwords.it_staff)).body.status).toBe('ok'); // hr_staff is not privileged
    const e = await clients.employee!.login('it_employee', H.passwords.it_employee);
    expect(e.body.status).toBe('ok');
    expect(e.body.me.employeeId).toBe(7);
    for (const k of ['payroll', 'manager', 'employee', 'staff']) expect((await clients[k]!.get('/api/meta')).status).toBe(200);
  });
});

describe('navigation, routes and permissions are consistent', () => {
  it('Super Admin sees every module and every menu route answers 200', async () => {
    const meta = (await admin().get<MetaResponse>('/api/meta')).body;
    const visible = MODULES.filter((m) => !(m.kind === 'page' && m.hidden));
    expect(meta.menu.map((m) => m.key).sort()).toEqual(visible.map((m) => m.key).sort());
    for (const item of meta.menu) {
      const mod = MODULES.find((m) => m.key === item.key);
      const api = mod?.kind === 'crud' ? `/api/m/${mod.key}` : mod?.api;
      const r = await admin().get(api as string);
      expect(r.status, `${item.path} → ${api}: ${r.text.slice(0, 200)}`).toBe(200);
    }
  });

  it('every menu entry shown to each role is reachable by that role, and hidden ones are refused', async () => {
    for (const k of ['payroll', 'manager', 'employee', 'staff']) {
      const c = clients[k]!;
      const meta = (await c.get<MetaResponse>('/api/meta')).body;
      for (const mod of MODULES) {
        const api = mod.kind === 'crud' ? `/api/m/${mod.key}` : mod.api;
        const r = await c.get(api);
        const inMenu = meta.menu.some((m) => m.key === mod.key);
        if (inMenu) expect(r.status, `${k} ${api}`).toBe(200);
        else expect([401, 403], `${k} ${api} should be refused (got ${r.status})`).toContain(r.status);
      }
    }
  });

  it('employee menu has self-service only', async () => {
    const meta = (await clients.employee!.get<MetaResponse>('/api/meta')).body;
    const keys = meta.menu.map((m) => m.key);
    expect(keys).toEqual(expect.arrayContaining(['dashboard', 'ess', 'my_payslips', 'leave', 'overtime', 'time_corrections', 'help', 'security']));
    expect(keys).not.toContain('payroll');
    expect(keys).not.toContain('talent');
    expect(keys).not.toContain('users');
  });

  it('dashboard only links to pages the viewer can open (Talent 9-Box regression)', async () => {
    const a = (await admin().get('/api/dashboard')).body;
    expect(a.nineBox).toHaveLength(9);
    for (const b of a.nineBox) expect(b.href).toMatch(/^\/talent\?box=\d$/);
    expect((await admin().get('/api/talent/ninebox')).status).toBe(200);

    const e = (await clients.employee!.get('/api/dashboard')).body;
    expect(e.nineBox).toBeNull();
    const meta = (await clients.employee!.get<MetaResponse>('/api/meta')).body;
    for (const k of e.kpis) if (k.href) expect(meta.menu.some((m) => m.path === k.href.split('?')[0]), k.href).toBe(true);
  });

  it('unknown API routes return JSON 404 and SPA routes serve the app shell', async () => {
    const r = await admin().get('/api/does-not-exist');
    expect([401, 404]).toContain(r.status);
    const spa = await clients.anon!.get('/talent');
    expect(spa.status).toBe(200);
    expect(spa.text).toContain('<div id="app">');
  });
});

describe('lookups (department dropdown regression)', () => {
  it('department options always have a real label and parents come before children', async () => {
    const r = await admin().get<LookupOption[]>('/api/lookup/departments');
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(5);
    for (const o of r.body) {
      expect(typeof o.label).toBe('string');
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.label).not.toContain('undefined');
      expect(Number.isInteger(o.value)).toBe(true);
    }
    const index = new Map(r.body.map((o, i) => [o.value, i]));
    for (const o of r.body) if (o.parentId) expect(index.get(o.parentId)!).toBeLessThan(index.get(o.value)!);
    expect(r.body.find((o) => o.code === 'OPS-PRD')?.depth).toBe(2);
  });

  it('analytics returns the same department contract and filters by sub-tree', async () => {
    const all = (await admin().get('/api/analytics?from=2026-01-01&to=2026-12-31')).body;
    for (const d of all.departments) expect(d.label).not.toContain('undefined');
    const ops = all.departments.find((d: LookupOption) => d.code === 'OPS');
    const sub = (await admin().get(`/api/analytics?from=2026-01-01&to=2026-12-31&department_id=${ops.value}`)).body;
    expect(sub.metrics.headcount).toBe(3); // E005, E006, E007 sit in OPS-PRD under OPS
    expect((await admin().get('/api/analytics?from=2026-12-31&to=2026-01-01')).status).toBe(400);
  });
});

describe('notification links', () => {
  it('absolute URLs stay external, internal paths are permission-checked, unsafe links are dropped', async () => {
    H.sql(`INSERT INTO notifications (user_id, title, link) SELECT id, 'external', 'https://example.co.th/notifications/1' FROM users WHERE username IN ('it_admin','it_employee');
           INSERT INTO notifications (user_id, title, link) SELECT id, 'internal', '/talent' FROM users WHERE username IN ('it_admin','it_employee');
           INSERT INTO notifications (user_id, title, link) SELECT id, 'unsafe', 'javascript:alert(1)' FROM users WHERE username = 'it_admin';`);
    const a = (await admin().get('/api/notifications')).body.items as Array<{ title: string; href: string | null; external: boolean }>;
    expect(a.find((n) => n.title === 'external')).toMatchObject({ href: 'https://example.co.th/notifications/1', external: true });
    expect(a.find((n) => n.title === 'internal')).toMatchObject({ href: '/talent', external: false });
    expect(a.find((n) => n.title === 'unsafe')?.href).toBeNull();
    const e = (await clients.employee!.get('/api/notifications')).body.items as Array<{ title: string; href: string | null }>;
    expect(e.find((n) => n.title === 'internal')?.href).toBeNull(); // employee cannot open Talent → no dead link
    expect(e.find((n) => n.title === 'external')?.href).toBe('https://example.co.th/notifications/1');
  });
});

describe('generic CRUD', () => {
  let deptId = 0;
  let empId = 0;
  it('creates, reads, searches and updates records with validation', async () => {
    const d = await admin().post('/api/m/departments', { code: 'QA', name: 'ฝ่ายประกันคุณภาพ', company_id: 1, parent_id: 1, active: true });
    expect(d.status).toBe(201);
    expect(d.body.parent_id__label).toBe('สำนักกรรมการผู้จัดการ (EXE)');
    deptId = d.body.id;
    const dup = await admin().post('/api/m/departments', { code: 'QA', name: 'ซ้ำ', company_id: 1 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe('รหัส ซ้ำกับรายการที่มีอยู่แล้ว');
    const missing = await admin().post('/api/m/departments', { code: 'X1' });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.field).toBe('name');

    const e = await admin().post('/api/m/employees', {
      emp_code: 'E900', first_name: 'ทดสอบ', last_name: 'ระบบ', email: 'e900@example.com', company_id: 1, department_id: deptId,
      hire_date: '2026-11-01', employment_type: 'probation', status: 'probation', base_salary: 25000, bank_account: '111-2-33333-4',
    });
    expect(e.status).toBe(201);
    empId = e.body.id;
    expect(e.body.base_salary).toBe(25000);
    expect((await admin().post('/api/m/employees', { emp_code: 'E901', first_name: 'a', last_name: 'b', company_id: 1, hire_date: '2026-13-45', employment_type: 'permanent', status: 'active' })).status).toBe(400);
    expect((await admin().post('/api/m/employees', { emp_code: 'E902', first_name: 'a', last_name: 'b', company_id: 1, hire_date: '2026-01-01', employment_type: 'boss', status: 'active' })).status).toBe(400);

    const list = await admin().get('/api/m/employees?q=E900');
    expect(list.body.total).toBe(1);
    expect(list.body.rows[0].department_id__label).toBe('ฝ่ายประกันคุณภาพ (QA)');
    const filtered = await admin().get('/api/m/employees?f.status=probation');
    expect(filtered.body.rows.every((r: { status: string }) => r.status === 'probation')).toBe(true);

    const up = await admin().put(`/api/m/employees/${empId}`, { status: 'active', employment_type: 'permanent' });
    expect(up.status).toBe(200);
    expect(up.body.status).toBe('active');
  });

  it('blocks deleting records that are still referenced, then deletes when free', async () => {
    expect((await admin().del(`/api/m/departments/${deptId}`)).status).toBe(409);
    expect((await admin().put(`/api/m/employees/${empId}`, { department_id: null })).status).toBe(200);
    expect((await admin().del(`/api/m/employees/${empId}`)).status).toBe(200);
    expect((await admin().del(`/api/m/departments/${deptId}`)).status).toBe(200);
    expect((await admin().get(`/api/m/departments/${deptId}`)).status).toBe(404);
  });

  it('masks sensitive fields for users without the sensitive permission', async () => {
    const m = await clients.manager!.get('/api/m/employees?q=E007');
    expect(m.body.rows[0].base_salary).toBe('••••••');
    expect(m.body.rows[0].bank_account).toBe('••••••');
    const p = await clients.payroll!.get('/api/m/employees?q=E007');
    expect(p.body.rows[0].base_salary).toBe(16500);
  });

  it('owner-scoped modules only expose the employee’s own records', async () => {
    const own = await clients.employee!.get('/api/m/employees');
    expect(own.body.total).toBe(1);
    expect(own.body.rows[0].emp_code).toBe('E007');
    const leaves = await clients.employee!.get('/api/m/leave');
    expect(leaves.body.rows.every((r: { employee_id: number }) => r.employee_id === 7)).toBe(true);
    const others = await admin().get('/api/m/leave?f.employee_id=3');
    expect((await clients.employee!.get(`/api/m/leave/${others.body.rows[0].id}`)).status).toBe(404);
    expect((await clients.employee!.post('/api/m/departments', { code: 'NOPE', name: 'x', company_id: 1 })).status).toBe(403);
  });

  it('exports CSV with BOM and records the export in the audit log', async () => {
    // read raw bytes: TextDecoder (fetch().text()) silently strips the BOM
    const res = await fetch(`${H.baseUrl}/api/m/positions/export.csv?columns=code,title,department_id`, { headers: { cookie: admin().cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = new TextDecoder().decode(bytes).trim().split(/\r?\n/);
    expect(lines[0]).toBe('ID,รหัสตำแหน่ง,ชื่อตำแหน่ง,หน่วยงาน');
    expect(lines).toHaveLength(7);
    expect(lines[1]).toBe('4,P-DEV,นักพัฒนาซอฟต์แวร์,ฝ่ายเทคโนโลยีสารสนเทศ (IT)'); // sorted by code; refs exported as labels, not ids
    expect((await clients.employee!.get('/api/m/positions/export.csv')).status).toBe(403);
  });
});

describe('workflow approvals', () => {
  let leaveId = 0;
  it('employee request goes to the approver inbox and is applied on approval', async () => {
    const r = await clients.employee!.post('/api/m/leave', { employee_id: 1, leave_type_id: 1, start_date: '2026-11-10', end_date: '2026-11-11', days: 2, reason: 'ธุระครอบครัว' });
    expect(r.status).toBe(201);
    expect(r.body.employee_id).toBe(7); // forced to the requester's own employee record
    expect(r.body.status).toBe('pending');
    leaveId = r.body.id;
    expect((await clients.employee!.post('/api/m/leave', { leave_type_id: 1, start_date: '2026-11-12', end_date: '2026-11-10', days: 1 })).status).toBe(400);

    const inbox = (await clients.manager!.get('/api/workflow/inbox')).body;
    const req = inbox.toApprove.find((x: { refId: number; type: string }) => x.type === 'leave' && x.refId === leaveId);
    expect(req).toBeTruthy();
    expect(req.href).toBe('/leave');
    const notif = (await clients.manager!.get('/api/notifications')).body.items;
    expect(notif.some((n: { href: string }) => n.href === '/workflow/inbox')).toBe(true);

    expect((await clients.employee!.post(`/api/workflow/${req.id}/decide`, { decision: 'approved' })).status).toBe(403);
    const ok = await clients.manager!.post(`/api/workflow/${req.id}/decide`, { decision: 'approved', comment: 'อนุมัติ' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect((await clients.employee!.get(`/api/m/leave/${leaveId}`)).body.status).toBe('approved');
    expect((await clients.manager!.post(`/api/workflow/${req.id}/decide`, { decision: 'approved' })).status).toBe(409);
    expect((await clients.employee!.put(`/api/m/leave/${leaveId}`, { reason: 'แก้' })).status).toBe(403);
    const en = (await clients.employee!.get('/api/notifications')).body.items;
    expect(en.some((n: { title: string; href: string }) => n.title === 'คำขอได้รับการอนุมัติ' && n.href === '/leave')).toBe(true);
  });

  it('requesters cannot approve their own requests, even as Super Admin', async () => {
    const ot = await admin().post('/api/m/overtime', { employee_id: 4, work_date: '2026-10-29', hours: 2, rate: '1.5', reason: 'ปิดงบ' });
    expect(ot.status).toBe(201);
    const inbox = (await admin().get('/api/workflow/inbox')).body;
    expect(inbox.toApprove.some((x: { refId: number; type: string }) => x.type === 'overtime' && x.refId === ot.body.id)).toBe(false);
    const mine = inbox.mine.find((x: { refId: number; type: string }) => x.type === 'overtime' && x.refId === ot.body.id);
    expect((await admin().post(`/api/workflow/${mine.id}/decide`, { decision: 'approved' })).status).toBe(403);
    expect((await clients.manager!.post(`/api/workflow/${mine.id}/decide`, { decision: 'rejected', comment: 'ไม่จำเป็น' })).body.status).toBe('rejected');
  });

  it('approved time corrections update attendance; pending requests can be cancelled by the requester', async () => {
    const tc = await clients.employee!.post('/api/m/time_corrections', { work_date: '2026-10-30', clock_in: '07:00', clock_out: '19:00', reason: 'ลืมสแกน' });
    expect(tc.status).toBe(201);
    const inbox = (await clients.manager!.get('/api/workflow/inbox')).body;
    const req = inbox.toApprove.find((x: { refId: number; type: string }) => x.type === 'time_correction' && x.refId === tc.body.id);
    await clients.manager!.post(`/api/workflow/${req.id}/decide`, { decision: 'approved' });
    const att = (await clients.employee!.get('/api/m/attendance?f.work_date=2026-10-30')).body.rows[0];
    expect(att).toMatchObject({ clock_in: '07:00', clock_out: '19:00', status: 'present', source: 'manual' });

    const ot = await clients.employee!.post('/api/m/overtime', { work_date: '2026-10-31', hours: 1, rate: '1.5', reason: 'x' });
    const cancel = await clients.employee!.del(`/api/m/overtime/${ot.body.id}`);
    expect(cancel.body).toEqual({ ok: true, cancelled: true });
    expect((await clients.employee!.get(`/api/m/overtime/${ot.body.id}`)).body.status).toBe('cancelled');
  });
});

describe('ESS', () => {
  it('shows profile, leave balance and lets the employee clock in once', async () => {
    const ess = (await clients.employee!.get('/api/ess')).body;
    expect(ess.linked).toBe(true);
    expect(ess.employee.emp_code).toBe('E007');
    expect(ess.leaveBalances.find((b: { name: string }) => b.name === 'ลาพักร้อน').used).toBe(2);
    const inRes = await clients.employee!.post('/api/ess/clock', { action: 'in' });
    expect(inRes.status).toBe(200);
    expect((await clients.employee!.post('/api/ess/clock', { action: 'in' })).status).toBe(409);
    expect((await clients.employee!.post('/api/ess/clock', { action: 'out' })).status).toBe(200);
    expect((await admin().post('/api/ess/clock', { action: 'in' })).status).toBe(403); // admin is not linked to an employee
    expect((await admin().get('/api/ess')).body.linked).toBe(false);
  });
});

describe('payroll and payslips', () => {
  let periodId = 0;
  it('payroll officer creates and calculates a period', async () => {
    const p = await clients.payroll!.post('/api/payroll/periods', { code: '2026-10', name: 'เงินเดือน ต.ค. 2569', start_date: '2026-10-01', end_date: '2026-10-31', pay_date: '2026-10-31' });
    expect(p.status).toBe(201);
    periodId = p.body.id;
    expect((await clients.payroll!.post('/api/payroll/periods', { code: '2026-10', name: 'dup', start_date: '2026-10-01', end_date: '2026-10-31', pay_date: '2026-10-31' })).status).toBe(409);
    const calc = await clients.payroll!.post(`/api/payroll/periods/${periodId}/calculate`);
    expect(calc.status).toBe(200);
    expect(calc.body.status).toBe('calculated');
    expect(calc.body.employees).toBe(7); // active + probation employees with a salary (E008 resigned)
    const slips = (await clients.payroll!.get(`/api/payroll/payslips?period_id=${periodId}`)).body;
    const e7 = slips.find((s: { employee: string }) => s.employee.startsWith('E007'));
    // 16,500 base − 550 unpaid leave + 309.38 OT + 1,000 meal = 17,259.38; − 750 SSO
    expect(e7.gross).toBe(17259.38);
    expect(e7.net).toBe(16509.38);
  });

  it('enforces segregation of duties and the status sequence', async () => {
    expect((await clients.payroll!.post(`/api/payroll/periods/${periodId}/approve`)).status).toBe(403);
    expect((await admin().post(`/api/payroll/periods/${periodId}/publish`)).status).toBe(409);
    expect((await admin().post(`/api/payroll/periods/${periodId}/approve`)).body.status).toBe('approved');
    expect((await clients.payroll!.post(`/api/payroll/periods/${periodId}/calculate`)).status).toBe(409);
    expect((await clients.manager!.post(`/api/payroll/periods/${periodId}/publish`)).status).toBe(403);
    expect((await admin().post(`/api/payroll/periods/${periodId}/publish`)).body.status).toBe('published');
  });

  it('employees receive and open only their own published payslip', async () => {
    const n = (await clients.employee!.get('/api/notifications')).body.items.find((x: { title: string }) => x.title === 'สลิปเงินเดือนพร้อมแล้ว');
    expect(n.href).toMatch(/^\/my\/payslips\/\d+$/);
    const mine = (await clients.employee!.get('/api/my/payslips')).body;
    expect(mine.linked).toBe(true);
    expect(mine.rows).toHaveLength(1);
    const slip = await clients.employee!.get(`/api/payslips/${mine.rows[0].id}`);
    expect(slip.status).toBe(200);
    expect(slip.body.net).toBe(16509.38);
    expect(slip.body.lines.map((l: { code: string }) => l.code)).toEqual(['BASE', 'OT', 'MEAL', 'UNPAID', 'SSO', 'TAX']);
    const all = (await admin().get(`/api/payroll/payslips?period_id=${periodId}`)).body;
    const other = all.find((s: { employee: string }) => s.employee.startsWith('E001'));
    expect((await clients.employee!.get(`/api/payslips/${other.id}`)).status).toBe(404);
    expect((await clients.employee!.get('/api/payroll/periods')).status).toBe(403);
    expect((await admin().get('/api/my/payslips')).body).toEqual({ linked: false, rows: [] });
  });

  it('exports the bank file CSV for payroll', async () => {
    const r = await clients.payroll!.get(`/api/payroll/periods/${periodId}/export.csv`);
    expect(r.status).toBe(200);
    expect(r.text.trim().split(/\r?\n/)).toHaveLength(8);
  });
});

describe('administration', () => {
  it('creates a user with a one-time temporary password that must be changed', async () => {
    const r = await admin().post('/api/admin/users', { username: 'it_new', displayName: 'ผู้ใช้ใหม่', roles: ['employee'], employeeId: 4 });
    expect(r.status).toBe(201);
    const temp = r.body.temporaryPassword as string;
    expect(temp).toHaveLength(16);
    expect((await admin().post('/api/admin/users', { username: 'it_new2', displayName: 'x', roles: ['employee'], employeeId: 4 })).status).toBe(409);
    const list = (await admin().get('/api/admin/users')).body;
    expect(JSON.stringify(list)).not.toContain(temp);
    expect(list.find((u: { username: string }) => u.username === 'it_new2')).toBeUndefined();

    const c = new Client(H.baseUrl);
    expect((await c.login('it_new', temp)).body.status).toBe('ok');
    const blocked = await c.get('/api/meta');
    expect(blocked.body.error.code).toBe('password_change_required');
    expect((await c.post('/api/auth/change-password', { currentPassword: temp, newPassword: 'short' })).status).toBe(400);
    expect((await c.post('/api/auth/change-password', { currentPassword: temp, newPassword: 'New-Secure-Pass-2026' })).status).toBe(200);
    expect((await c.get('/api/meta')).status).toBe(200);
    expect((await c.get('/api/ess')).body.employee.emp_code).toBe('E004');
  });

  it('protects the last Super Admin and the super_admin role', async () => {
    const users = (await admin().get('/api/admin/users')).body;
    const me = users.find((u: { username: string }) => u.username === 'it_admin');
    expect((await admin().put(`/api/admin/users/${me.id}`, { roles: ['hr_admin'] })).status).toBe(409);
    expect((await admin().put(`/api/admin/users/${me.id}`, { active: false })).status).toBe(403);
    const roles = (await admin().get('/api/admin/roles')).body.roles;
    const sa = roles.find((r: { code: string }) => r.code === 'super_admin');
    expect((await admin().put(`/api/admin/roles/${sa.id}`, { permissions: ['help.view'] })).status).toBe(403);
    const emp = roles.find((r: { code: string }) => r.code === 'employee');
    expect((await admin().put(`/api/admin/roles/${emp.id}`, { permissions: ['bad permission'] })).status).toBe(400);
  });

  it('settings drive behaviour and the login policy text', async () => {
    expect((await admin().put('/api/admin/settings', { 'security.mfa_enforce_privileged': false })).body.changed).toBe(1);
    expect((await clients.anon!.get('/api/auth/policy')).body.mfaEnforcedForPrivileged).toBe(false);
    expect((await admin().put('/api/admin/settings', { 'security.mfa_enforce_privileged': true })).status).toBe(200);
    expect((await clients.anon!.get('/api/auth/policy')).body.mfaEnforcedForPrivileged).toBe(true);
    expect((await admin().put('/api/admin/settings', { 'unknown.key': 1 })).status).toBe(400);
    expect((await clients.manager!.put('/api/admin/settings', { 'security.lockout_threshold': 1 })).status).toBe(403);
  });

  it('audit log records the important actions', async () => {
    const r = await admin().get('/api/audit?q=');
    expect(r.status).toBe(200);
    const actions = new Set(H.sql('SELECT DISTINCT action FROM audit_logs').map((x) => x.action));
    for (const a of ['auth.login', 'auth.login_failed', 'auth.account_locked', 'mfa.enabled', 'data.create', 'data.update', 'data.delete', 'data.export', 'workflow.approved', 'workflow.rejected', 'payroll.calculated', 'payroll.approved', 'payroll.published', 'payslip.viewed', 'user.created', 'auth.password_changed', 'settings.updated']) {
      expect(actions.has(a), a).toBe(true);
    }
    const details = H.sql("SELECT details FROM audit_logs WHERE details IS NOT NULL").map((x) => String(x.details)).join('\n');
    for (const secret of Object.values(H.passwords)) expect(details).not.toContain(secret);
  });
});

describe('user / role / permission management is Super Admin only', () => {
  const denied = ['manager', 'staff', 'employee', 'payroll'];
  const endpoints: Array<[string, string, unknown?]> = [
    ['GET', '/api/admin/users'],
    ['POST', '/api/admin/users', { username: 'escalate_me', displayName: 'x', roles: ['super_admin'] }],
    ['PUT', '/api/admin/users/1', { roles: ['super_admin'] }],
    ['POST', '/api/admin/users/1/reset-password'],
    ['POST', '/api/admin/users/1/reset-mfa'],
    ['POST', '/api/admin/users/1/approve', { roles: ['super_admin'] }],
    ['POST', '/api/admin/users/1/reject'],
    ['GET', '/api/admin/roles'],
    ['POST', '/api/admin/roles', { code: 'evil_role', name: 'x', permissions: ['employees.view'] }],
    ['PUT', '/api/admin/roles/3', { permissions: ['*.view'] }],
  ];

  it('Manager, HR Staff, Employee and Payroll Officer get 403 on every management API', async () => {
    for (const k of denied) {
      for (const [method, path, body] of endpoints) {
        const r = await clients[k]!.req(method, path, body ?? (method === 'GET' ? undefined : {}));
        expect(r.status, `${k} ${method} ${path}`).toBe(403);
      }
      const meta = (await clients[k]!.get<MetaResponse>('/api/meta')).body;
      expect(meta.menu.some((m) => m.key === 'users' || m.key === 'roles'), k).toBe(false);
      expect(meta.modules.find((m) => m.key === 'users')).toMatchObject({ allowed: false });
    }
    expect(H.sql("SELECT COUNT(*) AS n FROM users WHERE username = 'escalate_me'")[0]?.n).toBe(0);
    expect(H.sql("SELECT COUNT(*) AS n FROM roles WHERE code = 'evil_role'")[0]?.n).toBe(0);
  });

  it('a mis-granted users.manage permission still does not open management (role check, not permission)', async () => {
    H.sql("INSERT INTO role_permissions (role_id, permission) SELECT id, 'users.manage' FROM roles WHERE code = 'hr_manager'; INSERT INTO role_permissions (role_id, permission) SELECT id, 'roles.manage' FROM roles WHERE code = 'hr_manager';");
    try {
      expect((await clients.manager!.get('/api/admin/users')).status).toBe(403);
      expect((await clients.manager!.get('/api/admin/roles')).status).toBe(403);
      expect((await clients.manager!.get<MetaResponse>('/api/meta')).body.menu.some((m) => m.key === 'users')).toBe(false);
    } finally {
      H.sql("DELETE FROM role_permissions WHERE permission IN ('users.manage', 'roles.manage');");
    }
  });

  it('the role editor refuses to grant user/role management to any role', async () => {
    const roles = (await admin().get('/api/admin/roles')).body;
    const mgr = roles.roles.find((r: { code: string }) => r.code === 'hr_manager');
    for (const p of ['users.manage', 'roles.manage', 'users.*', '*.manage']) {
      const r = await admin().put(`/api/admin/roles/${mgr.id}`, { permissions: [...mgr.permissions, p] });
      expect(r.status, p).toBe(400);
    }
    expect(roles.catalogue).not.toContain('users.manage');
    expect((await admin().post('/api/admin/roles', { code: 'sneaky', name: 'x', permissions: ['*.manage'] })).status).toBe(400);
  });

  it('Super Admin can manage users and roles', async () => {
    expect((await admin().get('/api/admin/users')).status).toBe(200);
    expect((await admin().get('/api/admin/roles')).body.roles.map((r: { code: string }) => r.code)).toEqual(expect.arrayContaining(['super_admin', 'hr_manager', 'hr_staff', 'employee']));
    const meta = (await admin().get<MetaResponse>('/api/meta')).body;
    expect(meta.menu.map((m) => m.key)).toEqual(expect.arrayContaining(['users', 'roles', 'settings']));
  });
});

describe('HR Staff role', () => {
  it('can run HR operations but not payroll, sensitive data, settings or deletion of employees', async () => {
    const s = clients.staff!;
    expect((await s.get('/api/m/employees')).status).toBe(200);
    expect((await s.get('/api/m/employees?q=E007')).body.rows[0].base_salary).toBe('••••••');
    expect((await s.get('/api/m/requisitions')).status).toBe(200);
    expect((await s.get('/api/payroll/periods')).status).toBe(403);
    expect((await s.get('/api/admin/settings')).status).toBe(403);
    expect((await s.get('/api/audit')).status).toBe(403);
    const emp = (await s.get('/api/m/employees?q=E006')).body.rows[0];
    expect((await s.del(`/api/m/employees/${emp.id}`)).status).toBe(403);
  });
});

describe('self-registration', () => {
  const strong = 'Reg-Strong-Pass-2026';

  it('validates input and never trusts role fields sent by the client', async () => {
    const anon = new Client(H.baseUrl);
    const base = { username: 'reg_user1', displayName: 'ผู้สมัคร หนึ่ง', email: 'reg1@example.com', employeeCode: 'E006', password: strong, confirmPassword: strong };
    expect((await anon.post('/api/auth/register', { ...base, password: 'short', confirmPassword: 'short' })).body.error.details.field).toBe('password');
    expect((await anon.post('/api/auth/register', { ...base, confirmPassword: 'Different-Pass-2026' })).body.error.details.field).toBe('confirmPassword');
    expect((await anon.post('/api/auth/register', { ...base, username: 'bad name!' })).body.error.details.field).toBe('username');
    expect((await anon.post('/api/auth/register', { ...base, email: 'not-an-email' })).body.error.details.field).toBe('email');
    expect((await anon.post('/api/auth/register', { ...base, password: 'reg_user1-Pass-99', confirmPassword: 'reg_user1-Pass-99' })).body.error.details.field).toBe('password');
    expect((await anon.req('POST', '/api/auth/register', base, { 'x-hr-requested': '0' })).status).toBe(403); // CSRF

    const r = await anon.post('/api/auth/register', { ...base, roles: ['super_admin'], role: 'super_admin', approval_status: 'approved', active: 1, is_admin: true });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ status: 'pending' });
    expect(r.headers.get('set-cookie')).toBeNull(); // no session is created
    const row = H.sql("SELECT u.approval_status, u.must_change_password, u.requested_employee_code, (SELECT COUNT(*) FROM user_roles ur WHERE ur.user_id = u.id) AS roles FROM users u WHERE username = 'reg_user1'")[0];
    expect(row).toEqual({ approval_status: 'pending', must_change_password: 0, requested_employee_code: 'E006', roles: 0 });
    expect((await anon.post('/api/auth/register', base)).status).toBe(409);
  });

  it('pending accounts cannot sign in; Super Admins are notified', async () => {
    const c = new Client(H.baseUrl);
    const r = await c.post('/api/auth/login', { username: 'reg_user1', password: strong });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('account_pending');
    expect(c.cookie).toBe('');
    const wrong = await c.post('/api/auth/login', { username: 'reg_user1', password: 'Wrong-Pass-2026' });
    expect(wrong.status).toBe(401); // pending state is only revealed after a correct password
    const n = (await admin().get('/api/notifications')).body.items;
    expect(n.some((x: { title: string; href: string }) => x.title === 'มีคำขอลงทะเบียนใหม่รออนุมัติ' && x.href === '/admin/users')).toBe(true);
    const mn = (await clients.manager!.get('/api/notifications')).body.items;
    expect(mn.some((x: { title: string }) => x.title === 'มีคำขอลงทะเบียนใหม่รออนุมัติ')).toBe(false);
  });

  it('only a Super Admin can approve, and the approved account gets exactly the chosen role', async () => {
    const list = (await admin().get('/api/admin/users')).body;
    const u = list.find((x: { username: string }) => x.username === 'reg_user1');
    expect(u.approval_status).toBe('pending');
    expect((await clients.manager!.post(`/api/admin/users/${u.id}/approve`, { roles: ['employee'] })).status).toBe(403);
    expect((await admin().post(`/api/admin/users/${u.id}/approve`, { roles: [] })).status).toBe(400);
    const emp6 = H.sql("SELECT id FROM employees WHERE emp_code = 'E006'")[0]?.id;
    expect((await admin().post(`/api/admin/users/${u.id}/approve`, { roles: ['employee'], employeeId: emp6 })).status).toBe(200);
    const c = new Client(H.baseUrl);
    expect((await c.login('reg_user1', strong)).body.status).toBe('ok');
    const me = (await c.get('/api/auth/me')).body;
    expect(me.roles).toEqual(['employee']);
    expect(me.employeeId).toBe(emp6);
    expect((await c.get('/api/admin/users')).status).toBe(403);
    expect((await admin().post(`/api/admin/users/${u.id}/approve`, { roles: ['employee'] })).status).toBe(404); // no longer pending
  });

  it('rejected registrations cannot sign in', async () => {
    const anon = new Client(H.baseUrl);
    expect((await anon.post('/api/auth/register', { username: 'reg_user2', displayName: 'ผู้สมัคร สอง', password: strong, confirmPassword: strong })).status).toBe(201);
    const u = (await admin().get('/api/admin/users')).body.find((x: { username: string }) => x.username === 'reg_user2');
    expect((await admin().post(`/api/admin/users/${u.id}/reject`)).status).toBe(200);
    expect((await anon.post('/api/auth/login', { username: 'reg_user2', password: strong })).status).toBe(401);
  });

  it('is rate limited and can be switched off by settings', async () => {
    const anon = new Client(H.baseUrl);
    await admin().put('/api/admin/settings', { 'security.registration_limit_per_hour': 1 });
    expect((await anon.post('/api/auth/register', { username: 'reg_user3', displayName: 'x', password: strong, confirmPassword: strong })).status).toBe(429);
    await admin().put('/api/admin/settings', { 'security.registration_limit_per_hour': 5, 'security.self_registration': false });
    expect((await anon.get('/api/auth/policy')).body.selfRegistration).toBe(false);
    expect((await anon.post('/api/auth/register', { username: 'reg_user3', displayName: 'x', password: strong, confirmPassword: strong })).status).toBe(403);
    await admin().put('/api/admin/settings', { 'security.self_registration': true });
    expect((await anon.get('/api/auth/policy')).body.selfRegistration).toBe(true);
  });
});
