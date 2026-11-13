// Daily attendance as the validated, versioned payroll source (P2, migration 0020) — isolated local D1, synthetic
// data only (companies ZDA / ZDB, employees ZD1–ZD4, ZD9). June 2026 (1 Jun = Monday, 22 weekdays); the attendance
// review starts 2026-06-01. Covers: revisions and the delete / lock / scope / permission rules of every write path
// (correction API, CRUD compatibility, Time Correction approval), validation holds (invalid / pending review), the
// attendance version and append-only snapshots per calc_version, the approval / ACC sign-off / publish gates, Preview
// warnings, reconciliation (amounts identical with and without the review), audit, and races.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const ids = {} as Record<'A' | 'B' | 'D1' | 'D2' | 'D3' | 'D4' | 'PJ' | 'PB' | 'staff' | 'manager' | 'admin' | 'unpaid' | 'paidType' | 'pending8', number>;
const WRANGLER = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const PASSWORD = 'Zz-Daily-Pass-2026!';
const one = (sql: string) => H.sql(sql)[0] as Record<string, any>;
const recId = (emp: number, d: string) => Number(one(`SELECT id FROM attendance_records WHERE employee_id = ${emp} AND work_date = '${d}'`).id);
const revisions = (record: number) => H.sql(`SELECT action, channel, before_json, after_json, reason, reference, reason_missing, actor_id, op_token FROM attendance_record_revisions WHERE record_id = ${record} ORDER BY id`) as Array<Record<string, any>>;
const holds = (periodId: number) =>
  H.sql(`SELECT e.emp_code AS emp, h.kind, h.work_date AS d, h.status FROM payroll_attendance_holds h JOIN employees e ON e.id = h.employee_id WHERE h.period_id = ${periodId} ORDER BY e.emp_code, h.work_date, h.kind`)
    .map((x) => `${x.emp}:${x.kind}:${x.d ?? '-'}:${x.status}`);
const holdId = (periodId: number, emp: number, kind: string) => Number(one(`SELECT id FROM payroll_attendance_holds WHERE period_id = ${periodId} AND employee_id = ${emp} AND kind = '${kind}'`).id);
const snapshots = (periodId: number) => H.sql(`SELECT calc_version, attendance_version, judged_through FROM payroll_attendance_snapshots WHERE period_id = ${periodId} ORDER BY calc_version`) as Array<{ calc_version: number; attendance_version: string; judged_through: string }>;
const calcVersion = (periodId: number) => Number(one(`SELECT calc_version FROM payroll_periods WHERE id = ${periodId}`).calc_version);
const nets = (periodId: number) => H.sql(`SELECT employee_id, net, gross, unpaid_leave, ot_amount FROM payslips WHERE period_id = ${periodId} ORDER BY employee_id`);
/** A write from another process while the Worker serves requests (an import landing at the same moment). */
const sqlAsync = (sql: string) =>
  promisify(execFile)(process.execPath, [WRANGLER, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', join(H.dir, 'state'), '--command', sql], { env: { ...process.env, CI: '1' } });
const REASON = { reason: 'zz แก้ไขตามใบแจ้ง HR', reference: 'ZZ-DOC-1' };

const weekdays = (() => {
  const out: string[] = [];
  for (let d = 1; d <= 30; d++) {
    const s = `2026-06-${String(d).padStart(2, '0')}`;
    const w = new Date(`${s}T00:00:00Z`).getUTCDay();
    if (w !== 0 && w !== 6) out.push(s);
  }
  return out;
})();
const attend = (emp: number, days: string[], out: string | null = '18:00') =>
  H.sql(`INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source, worked_minutes) VALUES ${days.map((d) => `(${emp}, '${d}', '09:00', ${out ? `'${out}'` : 'NULL'}, 'present', 'import', ${out ? 480 : 'NULL'})`).join(', ')};`);

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
  H.sql(`INSERT INTO companies (code, name, active) VALUES ('ZDA', 'ZZ Daily A', 1), ('ZDB', 'ZZ Daily B', 1);`);
  ids.A = Number(one("SELECT id FROM companies WHERE code = 'ZDA'").id);
  ids.B = Number(one("SELECT id FROM companies WHERE code = 'ZDB'").id);
  const emp = (code: string, co: number) => `('${code}', 'Zz', '${code}', ${co}, '2026-01-01', 'permanent', 'active', 30000)`;
  H.sql(`INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status, base_salary) VALUES
    ${emp('ZD1', ids.A)}, ${emp('ZD2', ids.A)}, ${emp('ZD3', ids.A)}, ${emp('ZD4', ids.B)}, ${emp('ZD9', ids.B)};`);
  for (const k of ['D1', 'D2', 'D3', 'D4'] as const) ids[k] = Number(one(`SELECT id FROM employees WHERE emp_code = 'Z${k}'`).id);
  H.sql(`INSERT INTO holiday_calendars (code, name, country_code, company_id, weekly_rest_days) VALUES ('ZZ-ZDA', 'zz daily A', 'TH', ${ids.A}, '0,6'), ('ZZ-ZDB', 'zz daily B', 'TH', ${ids.B}, '0,6');
    INSERT INTO leave_types (code, name, days_per_year, paid) VALUES ('ZZUNPAID', 'zz unpaid', 30, 0), ('ZZPAID', 'zz paid', 30, 1);`);
  ids.unpaid = Number(one("SELECT id FROM leave_types WHERE code = 'ZZUNPAID'").id);
  ids.paidType = Number(one("SELECT id FROM leave_types WHERE code = 'ZZPAID'").id);
  // ZD1 every weekday (+ an invalid Saturday record: clock-out before clock-in); ZD2 no clock-out on Wed 3, nothing on
  // Thu 4; ZD3 approved unpaid leave Fri 5 and a pending paid leave Mon 8; ZD4 (company B) every weekday
  attend(ids.D1, weekdays);
  H.sql(`INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source) VALUES (${ids.D1}, '2026-06-06', '18:00', '09:00', 'present', 'import');`);
  attend(ids.D2, weekdays.filter((d) => d !== '2026-06-03' && d !== '2026-06-04'));
  attend(ids.D2, ['2026-06-03'], null);
  attend(ids.D3, weekdays.filter((d) => d !== '2026-06-05' && d !== '2026-06-08'));
  attend(ids.D4, weekdays);
  attend(Number(one("SELECT id FROM employees WHERE emp_code = 'ZD9'").id), weekdays);
  H.sql(`INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status) VALUES
    (${ids.D3}, ${ids.unpaid}, '2026-06-05', '2026-06-05', 1, 'zz unpaid', 'approved'),
    (${ids.D3}, ${ids.paidType}, '2026-06-08', '2026-06-08', 1, 'zz pending', 'pending');`);
  ids.pending8 = Number(one(`SELECT id FROM leave_requests WHERE employee_id = ${ids.D3} AND status = 'pending'`).id);

  c.admin = new Client(H.baseUrl);
  await c.admin.login('it_admin', H.passwords.it_admin);
  c.payroll = new Client(H.baseUrl);
  await c.payroll.login('it_payroll', H.passwords.it_payroll);
  c.staff = new Client(H.baseUrl);
  await c.staff.login('it_staff', H.passwords.it_staff);
  c.employee = new Client(H.baseUrl);
  await c.employee.login('it_employee', H.passwords.it_employee);
  c.manager = new Client(H.baseUrl);
  await c.manager.login('it_manager', H.passwords.it_manager);
  ids.staff = Number(one("SELECT id FROM users WHERE username = 'it_staff'").id);
  ids.manager = Number(one("SELECT id FROM users WHERE username = 'it_manager'").id);
  ids.admin = Number(one("SELECT id FROM users WHERE username = 'it_admin'").id);
  // a company-limited HR user of company B (no employees.all) who may correct attendance and see payroll
  H.sql(`INSERT INTO roles (code, name, description, privileged, system) VALUES ('zz_daily_b', 'ZZ daily B', 'test', 0, 0);
    INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.value FROM roles r, json_each('["payroll.view","payroll_preview.view","attendance.view","attendance.all","attendance.update","attendance.correct"]') p WHERE r.code = 'zz_daily_b';`);
  const out = join(H.dir, 'zz_daily_b.sql');
  execFileSync(process.execPath, ['scripts/create-user.mjs', '--username', 'zz_daily_b', '--display', 'zz_daily_b', '--role', 'zz_daily_b', '--employee', 'ZD9', '--out', out, '--cred-file', join(H.dir, 'daily-cred.txt')], { env: { ...process.env, NEW_USER_PASSWORD: PASSWORD }, stdio: 'ignore' });
  execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', join(H.dir, 'state'), '--file', out], { env: { ...process.env, CI: '1' }, stdio: 'ignore' });
  c.scopedB = new Client(H.baseUrl);
  expect((await c.scopedB.login('zz_daily_b', PASSWORD)).status).toBe(200);
  c.accStaff = await makeUser('zz_daily_acc_staff', ['acc_staff']);
  c.accMgr = await makeUser('zz_daily_acc_mgr', ['acc_manager']);
}, 300_000);
afterAll(async () => {
  await H?.stop();
});

describe('migration 0020: history is kept', () => {
  it('grants attendance.correct exactly to the roles that update attendance', () => {
    const grants = (perm: string) => H.sql(`SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission = '${perm}' AND r.code NOT LIKE 'zz%' ORDER BY 1`).map((x) => x.code);
    expect(grants('attendance.correct')).toEqual(grants('attendance.update'));
    expect(grants('attendance.correct')).toContain('hr_staff');
  });

  it('every new record gets a "created" revision (imports: reason and batch reference filled in by the trigger)', () => {
    const r = revisions(recId(ids.D1, '2026-06-01'));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ action: 'created', channel: 'import', before_json: null });
    expect(JSON.parse(r[0]!.after_json)).toMatchObject({ clock_in: '09:00', clock_out: '18:00', status: 'present' });
  });

  it('attendance is never deleted: CRUD answers 409, the database refuses too; revisions are append-only', async () => {
    const id = recId(ids.D1, '2026-06-01');
    const del = await c.admin!.del(`/api/m/attendance/${id}`);
    expect(del.status).toBe(409);
    expect(del.body.error?.code).toBe('attendance_delete_forbidden');
    expect(() => H.sql(`DELETE FROM attendance_records WHERE id = ${id}`)).toThrow();
    expect(() => H.sql(`UPDATE attendance_record_revisions SET reason = 'x' WHERE record_id = ${id}`)).toThrow();
    expect(() => H.sql(`DELETE FROM attendance_record_revisions WHERE record_id = ${id}`)).toThrow();
    // a write that does not carry a new operation token cannot change attendance without a revision
    expect(() => H.sql(`UPDATE attendance_records SET clock_in = '08:00' WHERE id = ${id}`)).toThrow();
    expect(one(`SELECT clock_in FROM attendance_records WHERE id = ${id}`).clock_in).toBe('09:00');
  });

  it('19. duplicate import / insert of the same employee and day is refused (one record per day)', () => {
    expect(() => H.sql(`INSERT INTO attendance_records (employee_id, work_date, clock_in, status, source) VALUES (${ids.D1}, '2026-06-01', '10:00', 'present', 'import')`)).toThrow();
    expect(Number(one(`SELECT COUNT(*) AS n FROM attendance_records WHERE employee_id = ${ids.D1} AND work_date = '2026-06-01'`).n)).toBe(1);
  });
});

describe('corrections (D2)', () => {
  it('18. HR correction: original and corrected values, actor, reason, reference and op token in the revision; audit', async () => {
    const id = recId(ids.D2, '2026-06-03');
    const r = await c.staff!.post(`/api/attendance/records/${id}/correct`, { clock_out: '18:00', ...REASON });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ clock_in: '09:00', clock_out: '18:00', status: 'present' });
    const rev = revisions(id).at(-1)!;
    expect(rev).toMatchObject({ action: 'corrected', channel: 'correction', reason: REASON.reason, reference: REASON.reference, reason_missing: 0, actor_id: ids.staff });
    expect(JSON.parse(rev.before_json).clock_out).toBeNull();
    expect(JSON.parse(rev.after_json).clock_out).toBe('18:00');
    const a = JSON.parse(String(one(`SELECT details FROM audit_logs WHERE action = 'attendance.corrected' AND entity_id = '${id}' ORDER BY id DESC LIMIT 1`).details));
    expect(a).toMatchObject({ reason: REASON.reason, reference: REASON.reference, before: { clock_out: null }, after: { clock_out: '18:00' }, op: rev.op_token });
    // undo it (the pending-review case is exercised by the payroll tests below)
    expect((await c.staff!.post(`/api/attendance/records/${id}/correct`, { clock_out: null, ...REASON })).status).toBe(200);
    expect(revisions(id).filter((x) => x.action === 'corrected')).toHaveLength(2);
  });

  it('reason and reference are required; no change, bad times and absent-with-times are refused', async () => {
    const id = recId(ids.D1, '2026-06-02');
    for (const body of [{ clock_in: '08:30' }, { clock_in: '08:30', reason: 'zz', reference: 'X' }, { clock_in: '08:30', reason: 'zz long enough' }]) {
      const r = await c.staff!.post(`/api/attendance/records/${id}/correct`, body);
      expect(r.status).toBe(400);
      expect(r.body.error?.code).toBe('correction_reason_required');
    }
    expect((await c.staff!.post(`/api/attendance/records/${id}/correct`, { clock_in: '09:00', ...REASON })).status).toBe(400);
    expect((await c.staff!.post(`/api/attendance/records/${id}/correct`, { clock_in: '9am', ...REASON })).status).toBe(400);
    expect((await c.staff!.post(`/api/attendance/records/${id}/correct`, { status: 'absent', clock_in: '09:00', ...REASON })).status).toBe(400);
    expect(revisions(id)).toHaveLength(1);
  });

  it('20. historical correction / missing day: adds a record with a revision; duplicate, future and out-of-employment refused', async () => {
    const add = (b: Record<string, unknown>) => c.staff!.post('/api/attendance/records', { employee_id: ids.D2, ...REASON, ...b });
    expect((await add({ work_date: '2026-06-01', clock_in: '09:00', clock_out: '18:00' })).status).toBe(409);
    expect((await add({ work_date: '2099-01-05', clock_in: '09:00', clock_out: '18:00' })).status).toBe(400);
    expect((await add({ work_date: '2025-12-31', clock_in: '09:00', clock_out: '18:00' })).status).toBe(400);
    expect((await add({ work_date: '2026-06-04', clock_in: '09:00', clock_out: '18:00', reason: '' })).status).toBe(400);
    expect(H.sql(`SELECT 1 FROM attendance_records WHERE employee_id = ${ids.D2} AND work_date = '2026-06-04'`)).toHaveLength(0);
  });

  it('44. permission: an employee cannot correct or add attendance, nor read its history', async () => {
    const id = recId(ids.D1, '2026-06-02');
    expect((await c.employee!.post(`/api/attendance/records/${id}/correct`, { clock_in: '08:00', ...REASON })).status).toBe(403);
    expect((await c.employee!.post('/api/attendance/records', { employee_id: ids.D1, work_date: '2026-06-13', clock_in: '09:00', ...REASON })).status).toBe(403);
    expect((await c.employee!.get(`/api/attendance/records/${id}/revisions`)).status).toBe(403);
    expect(revisions(id)).toHaveLength(1);
  });

  it('43. company scope: a company-B user cannot correct, add, edit (CRUD) or read company A attendance', async () => {
    const id = recId(ids.D1, '2026-06-02');
    expect((await c.scopedB!.post(`/api/attendance/records/${id}/correct`, { clock_in: '08:00', ...REASON })).status).toBe(404);
    expect((await c.scopedB!.post('/api/attendance/records', { employee_id: ids.D1, work_date: '2026-06-13', clock_in: '09:00', ...REASON })).status).toBe(404);
    expect((await c.scopedB!.put(`/api/m/attendance/${id}`, { note: 'zz', correction_reason: REASON.reason, correction_reference: REASON.reference })).status).toBe(404);
    expect((await c.scopedB!.get(`/api/attendance/records/${id}/revisions`)).status).toBe(404);
    // their own company works
    const own = recId(ids.D4, '2026-06-02');
    expect((await c.scopedB!.get(`/api/attendance/records/${own}/revisions`)).status).toBe(200);
    expect(revisions(id)).toHaveLength(1);
  });

  it('46a. concurrent corrections of one record: no lost update — one revision per success, each starting from the previous one', async () => {
    const id = recId(ids.D4, '2026-06-03');
    const rs = await Promise.all(['08:50', '08:51', '08:52'].map((t) => c.staff!.post(`/api/attendance/records/${id}/correct`, { clock_in: t, ...REASON })));
    const ok = rs.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThanOrEqual(1);
    expect(rs.every((r) => r.status === 200 || (r.status === 409 && r.body.error?.code === 'conflict'))).toBe(true);
    const revs = revisions(id);
    expect(revs.filter((x) => x.action === 'corrected')).toHaveLength(ok);
    for (let i = 1; i < revs.length; i++) expect(JSON.parse(revs[i]!.before_json)).toEqual(JSON.parse(revs[i - 1]!.after_json));
    expect(one(`SELECT clock_in FROM attendance_records WHERE id = ${id}`).clock_in).toBe(JSON.parse(revs.at(-1)!.after_json).clock_in);
  });
});

describe('CRUD compatibility (D2: gate by the review date)', () => {
  it('outside the review dates the existing form keeps working; the revision is marked reason_missing', async () => {
    attend(ids.D1, ['2026-05-29']);
    const id = recId(ids.D1, '2026-05-29');
    const r = await c.staff!.put(`/api/m/attendance/${id}`, { note: 'zz form edit' });
    expect(r.status, r.text).toBe(200);
    expect(revisions(id).at(-1)).toMatchObject({ action: 'corrected', channel: 'crud', reason: null, reason_missing: 1, actor_id: ids.staff });
  });

  it('inside the review dates CRUD needs correction_reason + correction_reference (400 otherwise)', async () => {
    expect((await c.admin!.put('/api/admin/settings', { 'payroll.attendance_review_from': '2026-06-01' })).status).toBe(200);
    const id = recId(ids.D1, '2026-06-02');
    const bad = await c.staff!.put(`/api/m/attendance/${id}`, { note: 'zz' });
    expect(bad.status).toBe(400);
    expect(bad.body.error?.code).toBe('correction_reason_required');
    expect(revisions(id)).toHaveLength(1);
    const ok = await c.staff!.put(`/api/m/attendance/${id}`, { note: 'zz with reason', correction_reason: REASON.reason, correction_reference: REASON.reference });
    expect(ok.status, ok.text).toBe(200);
    expect(revisions(id).at(-1)).toMatchObject({ channel: 'crud', reason: REASON.reason, reference: REASON.reference, reason_missing: 0 });
    const created = await c.staff!.post('/api/m/attendance', { employee_id: ids.D1, work_date: '2026-06-13', clock_in: '09:00', clock_out: '12:00', status: 'present', source: 'manual' });
    expect(created.status).toBe(400);
  });
});

describe('payroll integration', () => {
  it('reconciliation: the review changes no amount (same payslips with and without it); the snapshot is stored per version', async () => {
    // calculated while the review does not apply to the period (June starts before a later review date)
    expect((await c.admin!.put('/api/admin/settings', { 'payroll.attendance_review_from': '2026-07-01' })).status).toBe(200);
    ids.PJ = await newPeriod('ZD-2026-06', ids.A, '2026-06-01', '2026-06-30');
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.PJ}/calculate`)).status).toBe(200);
    const before = nets(ids.PJ);
    expect(before).toHaveLength(3);
    expect(snapshots(ids.PJ)).toEqual([]);
    // the review applies from June: the same data gives the same money, now with a snapshot of version 2
    expect((await c.admin!.put('/api/admin/settings', { 'payroll.attendance_review_from': '2026-06-01' })).status).toBe(200);
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.PJ}/calculate`);
    expect(r.status, r.text).toBe(200);
    expect(nets(ids.PJ)).toEqual(before);
    const snaps = snapshots(ids.PJ);
    expect(snaps.map((s) => [s.calc_version, s.judged_through])).toEqual([[2, '2026-06-30']]);
    expect(snaps[0]!.attendance_version).toMatch(/^av1:[0-9a-f]{64}$/);
    const audit = JSON.parse(String(one(`SELECT details FROM audit_logs WHERE action = 'payroll.calculated' AND entity_id = '${ids.PJ}' ORDER BY id DESC LIMIT 1`).details));
    expect(audit.attendance).toMatchObject({ version: snaps[0]!.attendance_version, judgedThrough: '2026-06-30' });
  });

  it('34. the snapshot aggregates the daily records per employee (validated records only)', async () => {
    const r = await c.payroll!.get(`/api/payroll/periods/${ids.PJ}/attendance-snapshots/2`);
    expect(r.status, r.text).toBe(200);
    const by = new Map<number, Record<string, any>>(r.body.rows.map((x: { employee_id: number }) => [x.employee_id, x]));
    expect(by.get(ids.D1)).toMatchObject({ scheduledWorkDays: 22, presentDays: 22, actualWorkDays: 22, absentDays: 0, records: { invalid: 1 } });
    expect(by.get(ids.D2)).toMatchObject({ presentDays: 20, unverifiedDays: 1, absentDays: 1, missingAttendanceDays: 1, records: { pending_review: 1 } });
    expect(by.get(ids.D3)).toMatchObject({ presentDays: 20, unpaidLeaveDays: 1, pendingLeaveDays: 1, absentDays: 0 });
    expect(by.has(ids.D4)).toBe(false);
    expect((await c.payroll!.get(`/api/payroll/periods/${ids.PJ}/attendance-snapshots/1`)).status).toBe(404);
  });

  it('35–36. invalid and pending-review records are held next to the P1 holds; approval is refused', async () => {
    expect(holds(ids.PJ)).toEqual([
      'ZD1:invalid_record:2026-06-06:open',
      'ZD2:pending_review:2026-06-03:open',
      'ZD2:absent:2026-06-04:open',
      'ZD3:pending_leave:2026-06-08:open',
    ]);
    const a = await c.admin!.post(`/api/payroll/periods/${ids.PJ}/approve`);
    expect(a.status).toBe(409);
    expect(a.body.error?.code).toBe('attendance_holds_open');
    // an invalid record cannot be waved through: it must be corrected
    const clear = await c.payroll!.post(`/api/payroll/attendance-holds/${holdId(ids.PJ, ids.D1, 'invalid_record')}/clear`, { reason: 'zz ข้ามได้ไหม' });
    expect(clear.status).toBe(409);
    expect(clear.body.error?.code).toBe('attendance_invalid_correct_first');
  });

  it('preview: hold error, and a warning where the daily attendance differs from the money inputs (amounts unchanged)', async () => {
    const r = await c.payroll!.get(`/api/payroll/periods/${ids.PJ}/preview`);
    expect(r.status).toBe(200);
    const issues = Object.fromEntries(r.body.issues.map((i: { code: string; level: string; count: number }) => [i.code, `${i.level}:${i.count}`]));
    expect(issues).toMatchObject({ attendance_hold: 'error:4', attendance_absent_not_deducted: 'warning:1' });
    // the unpaid leave of ZD3 matches the engine (1 day): no difference warning
    expect(issues.attendance_unpaid_leave_differs).toBeUndefined();
    expect(r.body.exportable).toBe(false);
  });

  it('40. P1 regression + correction triggers a rescan: holds resolve when the source data is corrected', async () => {
    // invalid Saturday record corrected; missing clock-out confirmed by HR; missing Thursday added; pending leave approved
    const sat = recId(ids.D1, '2026-06-06');
    expect((await c.staff!.post(`/api/attendance/records/${sat}/correct`, { clock_in: '09:00', clock_out: '12:00', ...REASON })).status).toBe(200);
    expect((await c.payroll!.post(`/api/payroll/attendance-holds/${holdId(ids.PJ, ids.D2, 'pending_review')}/clear`, { reason: 'zz ยืนยันลืมสแกนออก' })).status).toBe(200);
    expect((await c.staff!.post('/api/attendance/records', { employee_id: ids.D2, work_date: '2026-06-04', clock_in: '09:00', clock_out: '18:00', ...REASON })).status).toBe(201);
    H.sql(`UPDATE leave_requests SET status = 'approved' WHERE id = ${ids.pending8}`);
    const scan = await c.payroll!.post(`/api/payroll/periods/${ids.PJ}/attendance-holds/scan`);
    expect(scan.status).toBe(200);
    expect(holds(ids.PJ)).toEqual([
      'ZD1:invalid_record:2026-06-06:resolved',
      'ZD2:pending_review:2026-06-03:cleared',
      'ZD2:absent:2026-06-04:resolved',
      'ZD3:pending_leave:2026-06-08:resolved',
    ]);
    // P1: a resolve after the calculation needs a recalculation
    const a = await c.admin!.post(`/api/payroll/periods/${ids.PJ}/approve`);
    expect(a.status).toBe(409);
    expect(a.body.error?.code).toBe('attendance_changed_recalculate');
  });

  it('37–39. a change that touches no hold still makes the calculation stale; recalculation adds a new version', async () => {
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.PJ}/calculate`)).status).toBe(200);
    const v = calcVersion(ids.PJ);
    expect(v).toBe(3);
    const v3 = snapshots(ids.PJ).find((s) => s.calc_version === 3)!;
    // the confirmed pending-review day now counts as present
    const agg = (await c.payroll!.get(`/api/payroll/periods/${ids.PJ}/attendance-snapshots/3`)).body.rows.find((x: { employee_id: number }) => x.employee_id === ids.D2);
    expect(agg).toMatchObject({ presentDays: 22, unverifiedDays: 0, absentDays: 0 });
    // a valid record corrected to another valid value: no hold opens or resolves
    const id = recId(ids.D1, '2026-06-10');
    expect((await c.staff!.post(`/api/attendance/records/${id}/correct`, { clock_in: '08:55', ...REASON })).status).toBe(200);
    const live = await c.payroll!.get(`/api/payroll/periods/${ids.PJ}/attendance`);
    expect(live.body.snapshot).toMatchObject({ calc_version: 3, current: false });
    const a = await c.admin!.post(`/api/payroll/periods/${ids.PJ}/approve`);
    expect(a.status).toBe(409);
    expect(a.body.error?.code).toBe('attendance_version_changed');
    const pv = await c.payroll!.get(`/api/payroll/periods/${ids.PJ}/preview`);
    expect(pv.body.issues.map((i: { code: string }) => i.code)).toContain('attendance_version_changed');
    expect(calcVersion(ids.PJ)).toBe(3);
    // recalculation: version 4 with its own snapshot; version 3's snapshot is kept unchanged
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.PJ}/calculate`)).status).toBe(200);
    const snaps = snapshots(ids.PJ);
    expect(snaps.map((s) => s.calc_version)).toEqual([2, 3, 4]);
    expect(snaps.find((s) => s.calc_version === 3)).toEqual(v3);
    expect(snaps.find((s) => s.calc_version === 4)!.attendance_version).not.toBe(v3.attendance_version);
    expect(() => H.sql(`UPDATE payroll_attendance_snapshots SET attendance_version = 'x' WHERE period_id = ${ids.PJ}`)).toThrow();
    expect(() => H.sql(`DELETE FROM payroll_attendance_snapshot_rows WHERE snapshot_id IN (SELECT id FROM payroll_attendance_snapshots WHERE period_id = ${ids.PJ})`)).toThrow();
    const ok = await c.admin!.post(`/api/payroll/periods/${ids.PJ}/approve`);
    expect(ok.status, ok.text).toBe(200);
  });

  it('payroll lock: no correction path can change a day of an approved period', async () => {
    const id = recId(ids.D1, '2026-06-11');
    const fix = await c.staff!.post(`/api/attendance/records/${id}/correct`, { clock_in: '08:40', ...REASON });
    expect(fix.status).toBe(409);
    expect(fix.body.error?.code).toBe('attendance_period_locked');
    expect((await c.staff!.post('/api/attendance/records', { employee_id: ids.D1, work_date: '2026-06-14', clock_in: '09:00', ...REASON })).status).toBe(409);
    expect((await c.staff!.put(`/api/m/attendance/${id}`, { note: 'zz', correction_reason: REASON.reason, correction_reference: REASON.reference })).status).toBe(409);
    expect(() => H.sql(`UPDATE attendance_records SET clock_in = '08:40', change_op = 'zz-lock' WHERE id = ${id}`)).toThrow();
    expect(one(`SELECT clock_in FROM attendance_records WHERE id = ${id}`).clock_in).toBe('09:00');
    // an import (a new record, no operation of a user) cannot land in a locked day either
    expect(() => H.sql(`INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source) VALUES (${ids.D1}, '2026-06-13', '09:00', '18:00', 'present', 'import')`)).toThrow();
    expect(H.sql(`SELECT 1 FROM attendance_records WHERE employee_id = ${ids.D1} AND work_date = '2026-06-13'`)).toHaveLength(0);
    // company B is not locked by company A's period
    expect((await c.staff!.post(`/api/attendance/records/${recId(ids.D4, '2026-06-11')}/correct`, { clock_in: '08:40', ...REASON })).status).toBe(200);
  });

  it('41–42. ACC sign-off and publish re-check the version of the approved calculation', async () => {
    expect((await c.accStaff!.post(`/api/payroll/periods/${ids.PJ}/accounting-review`, { note: 'zz checked' })).status).toBe(201);
    // a leave approved inside the covered days (leave is not an attendance record, so the lock does not stop it)
    const sneak = () => H.sql(`INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status) VALUES (${ids.D1}, ${ids.unpaid}, '2026-06-12', '2026-06-12', 1, 'zz late leave', 'approved')`);
    const unsneak = () => H.sql(`DELETE FROM leave_requests WHERE reason = 'zz late leave'`);
    sneak();
    const s1 = await c.accMgr!.post(`/api/payroll/periods/${ids.PJ}/accounting-signoff`, { decision: 'signed_off', note: 'zz ok' });
    expect(s1.status).toBe(409);
    expect(s1.body.error?.code).toBe('attendance_version_changed');
    unsneak();
    const s2 = await c.accMgr!.post(`/api/payroll/periods/${ids.PJ}/accounting-signoff`, { decision: 'signed_off', note: 'zz ok' });
    expect(s2.status, s2.text).toBe(200);
    sneak();
    const p1 = await c.payroll!.post(`/api/payroll/periods/${ids.PJ}/publish`);
    expect(p1.status).toBe(409);
    expect(p1.body.error?.code).toBe('attendance_version_changed');
    unsneak();
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.PJ}/publish`)).status).toBe(200);
  });

  it('43. scope: a company-B user cannot read company A attendance of payroll', async () => {
    expect((await c.scopedB!.get(`/api/payroll/periods/${ids.PJ}/attendance`)).status).toBe(404);
    expect((await c.scopedB!.get(`/api/payroll/periods/${ids.PJ}/attendance-snapshots/4`)).status).toBe(404);
    expect((await c.employee!.get(`/api/payroll/periods/${ids.PJ}/attendance`)).status).toBe(403);
  });

  it('46b. an import and a correction racing a calculation never leave an approvable stale snapshot', async () => {
    ids.PB = await newPeriod('ZD-B-2026-06', ids.B, '2026-06-01', '2026-06-30');
    const id = recId(ids.D4, '2026-06-15');
    const rounds: Array<[string, string]> = [['08:31', '2026-06-06'], ['08:32', '2026-06-13'], ['08:33', '2026-06-20']];
    for (const [t, saturday] of rounds) {
      const [calc, fix] = await Promise.all([
        c.payroll!.post(`/api/payroll/periods/${ids.PB}/calculate`),
        c.staff!.post(`/api/attendance/records/${id}/correct`, { clock_in: t, ...REASON }),
        sqlAsync(`INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source) VALUES (${ids.D4}, '${saturday}', '09:00', '12:00', 'present', 'import')`),
      ]);
      expect([200, 409]).toContain(calc.status);
      if (calc.status === 409) expect(['attendance_changed_during_calculation', 'conflict']).toContain(calc.body.error?.code);
      expect(fix.status).toBe(200);
    }
    if (calcVersion(ids.PB) === 0) expect((await c.payroll!.post(`/api/payroll/periods/${ids.PB}/calculate`)).status).toBe(200);
    // every stored snapshot is internally consistent: its version is the hash of what it aggregated, so the live
    // check of the current one decides; approval succeeds only when it matches the attendance as it is now
    const live = (await c.payroll!.get(`/api/payroll/periods/${ids.PB}/attendance`)).body;
    const approve = await c.admin!.post(`/api/payroll/periods/${ids.PB}/approve`);
    if (live.snapshot.current) expect(approve.status, approve.text).toBe(200);
    else expect(approve.body.error?.code).toBe('attendance_version_changed');
    // the imported Saturdays exist exactly once each, with their creation revision
    expect(Number(one(`SELECT COUNT(*) AS n FROM attendance_records WHERE employee_id = ${ids.D4} AND work_date IN ('2026-06-06', '2026-06-13', '2026-06-20')`).n)).toBe(3);
    expect(Number(one(`SELECT COUNT(*) AS n FROM attendance_record_revisions WHERE employee_id = ${ids.D4} AND work_date IN ('2026-06-06', '2026-06-13', '2026-06-20') AND action = 'created'`).n)).toBe(3);
  });
});

describe('Time Correction approval uses the same revision and lock rules', () => {
  // approver: the Super Admin (workflow.approve_any) — E007 is not in it_manager's reporting line in this data
  it('an approved request writes a revision (reason of the request, reference TC-<id>, the approver as actor)', async () => {
    const tc = await c.employee!.post('/api/m/time_corrections', { work_date: '2026-05-20', clock_in: '08:00', clock_out: '17:00', reason: 'zz ลืมสแกน' });
    expect(tc.status, tc.text).toBe(201);
    const inbox = (await c.admin!.get('/api/workflow/inbox')).body;
    const req = inbox.toApprove.find((x: { refId: number; type: string }) => x.type === 'time_correction' && x.refId === tc.body.id);
    expect(req, JSON.stringify(inbox).slice(0, 600)).toBeDefined();
    expect((await c.admin!.post(`/api/workflow/${req.id}/decide`, { decision: 'approved' })).status).toBe(200);
    const e7 = Number(one("SELECT id FROM employees WHERE emp_code = 'E007'").id);
    const rev = revisions(recId(e7, '2026-05-20')).at(-1)!;
    expect(rev).toMatchObject({ channel: 'time_correction', reason: 'zz ลืมสแกน', reference: `TC-${tc.body.id}`, actor_id: ids.admin, reason_missing: 0 });
  });

  it('web clock-in is locked too: no clock on a day of an approved period', async () => {
    const co = Number(one("SELECT company_id FROM employees WHERE emp_code = 'E007'").company_id);
    const today = String(one("SELECT date('now', '+7 hours') AS d").d);
    const [y, m] = today.split('-');
    const last = new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate();
    // fixture: an approved monthly period covering today for E007's company (the approval workflow is tested above)
    H.sql(`INSERT INTO payroll_periods (code, name, start_date, end_date, pay_date, status, kind, company_id) VALUES ('ZD-E7-NOW', 'zz now', '${y}-${m}-01', '${y}-${m}-${last}', '${y}-${m}-${last}', 'approved', 'monthly', ${co})`);
    const e7 = Number(one("SELECT id FROM employees WHERE emp_code = 'E007'").id);
    const before = H.sql(`SELECT clock_in FROM attendance_records WHERE employee_id = ${e7} AND work_date = '${today}'`);
    const r = await c.employee!.post('/api/ess/clock', { action: 'in' });
    expect(r.status).toBe(409);
    expect(r.body.error?.code).toBe('attendance_period_locked');
    expect(H.sql(`SELECT clock_in FROM attendance_records WHERE employee_id = ${e7} AND work_date = '${today}'`)).toEqual(before);
    H.sql("UPDATE payroll_periods SET status = 'draft' WHERE code = 'ZD-E7-NOW'");
  });

  it('a request for a day of an approved period cannot be approved (nothing is written)', async () => {
    const co = Number(one("SELECT company_id FROM employees WHERE emp_code = 'E007'").company_id);
    const p = await newPeriod('ZD-E7-2026-05', co, '2026-05-01', '2026-05-31');
    expect((await c.payroll!.post(`/api/payroll/periods/${p}/calculate`)).status).toBe(200);
    expect((await c.admin!.post(`/api/payroll/periods/${p}/approve`)).status).toBe(200);
    const tc = await c.employee!.post('/api/m/time_corrections', { work_date: '2026-05-21', clock_in: '08:00', clock_out: '17:00', reason: 'zz หลังอนุมัติ' });
    expect(tc.status).toBe(201);
    const req = (await c.admin!.get('/api/workflow/inbox')).body.toApprove.find((x: { refId: number; type: string }) => x.type === 'time_correction' && x.refId === tc.body.id);
    const d = await c.admin!.post(`/api/workflow/${req.id}/decide`, { decision: 'approved' });
    expect(d.status).toBe(409);
    expect(d.body.error?.code).toBe('attendance_period_locked');
    expect(one(`SELECT status FROM workflow_requests WHERE id = ${req.id}`).status).toBe('pending');
    const e7 = Number(one("SELECT id FROM employees WHERE emp_code = 'E007'").id);
    expect(H.sql(`SELECT 1 FROM attendance_records WHERE employee_id = ${e7} AND work_date = '2026-05-21' AND note LIKE 'แก้ไขเวลา TC-%'`)).toHaveLength(0);
  });
});
