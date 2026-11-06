// Attendance file import, shift settings, shift groups and the group schedule — isolated local D1 with synthetic data
// only (companies ZZA / ZZB, employees ZA* / ZB*). Files are parsed with the same readers the browser uses (XLSX,
// XLS, CSV) and posted as cell grids. Checks: validation per row, duplicates and idempotency, raw rows kept read-only,
// existing attendance and payroll untouched, company scope, permissions, effective-dated defaults, schedule conflicts,
// copy, historical protection and the shift used for lateness.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/shared/payroll';
import { bangkokNow } from '../../src/worker/lib/time';
import { parseCsv, readXlsx, writeXlsx, type Cell } from '../../src/shared/xlsx';
import { readXls } from '../../src/shared/xls';
import { weekday } from '../../src/shared/holidays';
import { monthEnd } from '../../src/shared/shifts';
import { writeXls } from '../ui/fixtures/xls-writer';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const admin = () => c.admin as Client;
const staff = () => c.staff as Client;
const today = bangkokNow().date;
const D = (n: number) => addDays(today, n);
const ids: Record<string, number> = {};
const count = (sql: string) => Number(H.sql(sql)[0]!.n);
const sha = (s: string) => s.padEnd(64, '0').slice(0, 64);
let n = 0;
const fileBody = (company: number, grid: Cell[][], x: Record<string, unknown> = {}) => ({ company_id: company, file_name: 'clock.csv', file_type: 'csv', file_size: 1000, sha256: sha(`a${++n}`), grid, ...x });
const payroll = () => JSON.stringify(H.sql(`SELECT (SELECT COUNT(*) FROM payslips) AS p, (SELECT COALESCE(SUM(net), 0) FROM payslips) AS net, (SELECT COUNT(*) FROM attendance_imports) AS ai, (SELECT COUNT(*) FROM attendance_import_rows) AS ar, (SELECT COUNT(*) FROM payroll_periods WHERE code <> 'ZZA-LOCK') AS pp, (SELECT COALESCE(MAX(updated_at), '') FROM payroll_periods WHERE code <> 'ZZA-LOCK') AS pu, (SELECT COUNT(*) FROM payslip_archive) AS pa`));
let payrollBefore = '';

beforeAll(async () => {
  H = await startHarness();
  for (const k of ['admin', 'staff', 'employee', 'manager']) c[k] = new Client(H.baseUrl);
  await c.admin!.login('it_admin', H.passwords.it_admin);
  await c.staff!.login('it_staff', H.passwords.it_staff);
  await c.employee!.login('it_employee', H.passwords.it_employee);
  await c.manager!.login('it_manager', H.passwords.it_manager);
}, 180_000);
afterAll(async () => {
  await H?.stop();
});

describe('setup (synthetic companies ZZA / ZZB)', () => {
  it('creates companies, departments, employees', async () => {
    payrollBefore = payroll();
    for (const code of ['ZZA', 'ZZB']) ids[code] = (await admin().post('/api/m/companies', { code, name: `zz_test ${code}`, active: true })).body.id;
    for (const [code, co] of [['ZZA-OPS', 'ZZA'], ['ZZA-WH', 'ZZA']] as const) {
      const r = await admin().post('/api/m/departments', { code, name: `zz_test ${code}`, company_id: ids[co], active: true });
      expect(r.status, r.text).toBe(201);
      ids[code] = r.body.id;
    }
    const mk = async (code: string, co: string, dept: string | null, x: Record<string, unknown> = {}) => {
      const r = await admin().post('/api/m/employees', { emp_code: code, first_name: 'zz_test', last_name: code, company_id: ids[co], department_id: dept ? ids[dept] : null, hire_date: D(-400), employment_type: 'permanent', status: 'active', base_salary: 20000, ...x });
      expect(r.status, r.text).toBe(201);
      ids[code] = r.body.id;
    };
    for (let i = 1; i <= 8; i++) await mk(`ZA00${i}`, 'ZZA', i <= 5 ? 'ZZA-OPS' : 'ZZA-WH');
    await mk('ZA009', 'ZZA', 'ZZA-OPS', { hire_date: D(-5) }); // hired 5 days ago
    await mk('ZB001', 'ZZB', null);
    // a non-privileged role with the new permissions but no employees.all (own-company scope: DEMO of it_employee)
    H.sql(`INSERT INTO roles (code, name, description, privileged, system) VALUES ('zz_test_shift', 'zz_test shift', 'zz_test', 0, 0);
      INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.value FROM roles r, json_each('["attendance_file.view","attendance_file.import","shifts.view","shift_groups.view","shift_groups.manage","shift_schedule.view","shift_schedule.manage"]') p WHERE r.code = 'zz_test_shift';
      INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.username = 'it_employee' AND r.code = 'zz_test_shift'`);
  });
});

describe('shift settings', () => {
  it('creates a day shift with two breaks, a night shift and a 15:00–24:00 shift', async () => {
    const day = await staff().post('/api/shifts/settings', { code: 'ZDAY', name: 'zz_test กะเช้า', company_id: ids.ZZA, shift_type: 'fixed', start_time: '08:00', end_time: '17:00', breaks: [{ start: '12:00', end: '13:00' }, { start: '15:00', end: '15:15' }], work_days: [0, 1, 2, 3, 4, 5, 6], color: '#2563eb', late_grace_minutes: 5 });
    expect(day.status, day.text).toBe(201);
    expect(day.body).toMatchObject({ net_minutes: 465, breaks: [{ start: '12:00', end: '13:00' }, { start: '15:00', end: '15:15' }], work_day_list: [0, 1, 2, 3, 4, 5, 6] });
    expect(H.sql(`SELECT break_minutes FROM shifts WHERE id = ${day.body.id}`)[0]!.break_minutes).toBe(75);
    ids.ZDAY = day.body.id;
    const night = await staff().post('/api/shifts/settings', { code: 'ZNIGHT', name: 'zz_test กะดึก', company_id: ids.ZZA, shift_type: 'scheduled', start_time: '22:00', end_time: '07:00', breaks: [{ start: '02:00', end: '03:00' }], work_days: [0, 1, 2, 3, 4, 5, 6] });
    expect(night.status, night.text).toBe(201);
    expect(night.body.net_minutes).toBe(480);
    ids.ZNIGHT = night.body.id;
    const eve = await staff().post('/api/shifts/settings', { code: 'ZEVE', name: 'zz_test กะบ่าย', company_id: ids.ZZA, start_time: '15:00', end_time: '24:00', breaks: [], work_days: [0, 1, 2, 3, 4, 5, 6] });
    expect(eve.status, eve.text).toBe(201);
    ids.ZEVE = eve.body.id;
    const early = await staff().post('/api/shifts/settings', { code: 'ZEARLY', name: 'zz_test กะเช้ามืด', company_id: ids.ZZA, start_time: '06:00', end_time: '15:00', breaks: [{ start: '10:00', end: '11:00' }], work_days: '1,2,3,4,5' });
    expect(early.status, early.text).toBe(201);
    ids.ZEARLY = early.body.id;
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'shift.created'")).toBe(4);
  });
  it('edits a shift (audited) and rejects invalid breaks or duplicate codes', async () => {
    const r = await staff().put(`/api/shifts/settings/${ids.ZEARLY}`, { code: 'ZEARLY', name: 'zz_test กะเช้ามืด', company_id: ids.ZZA, start_time: '06:00', end_time: '15:00', breaks: [{ start: '10:00', end: '10:30' }], work_days: [1, 2, 3, 4, 5] });
    expect(r.status, r.text).toBe(200);
    expect(r.body.net_minutes).toBe(510);
    expect(count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'shift.updated' AND entity_id = '${ids.ZEARLY}'`)).toBe(1);
    expect((await staff().post('/api/shifts/settings', { code: 'ZBAD', name: 'x', company_id: ids.ZZA, start_time: '08:00', end_time: '17:00', breaks: [{ start: '12:00', end: '13:00' }, { start: '12:30', end: '13:30' }] })).status).toBe(400);
    expect((await staff().post('/api/shifts/settings', { code: 'ZDAY', name: 'x', company_id: ids.ZZA, start_time: '08:00', end_time: '17:00', breaks: [] })).status).toBe(409);
  });
  it('permissions: manager views only, employee without permission is refused, own-scope users cannot create global shifts', async () => {
    expect((await c.manager!.get('/api/shifts/settings')).status).toBe(200);
    expect((await c.manager!.post('/api/shifts/settings', { code: 'ZM', name: 'x', start_time: '08:00', end_time: '17:00', breaks: [] })).status).toBe(403);
    const list = await c.employee!.get('/api/shifts/settings');
    expect(list.status).toBe(200);
    expect(list.body.some((s: { code: string }) => s.code === 'ZDAY')).toBe(false); // ZZA shift hidden from a DEMO-only user
  });
});

describe('shift groups and members', () => {
  it('creates a fixed group (default shift), a scheduled group and a department group', async () => {
    const fixed = await staff().post('/api/shifts/groups', { code: 'ZGF', name: 'zz_test fixed', company_id: ids.ZZA, membership: 'manual', shift_type: 'fixed', default_shift_id: ids.ZDAY, default_effective_date: D(-60) });
    expect(fixed.status, fixed.text).toBe(201);
    expect(fixed.body).toMatchObject({ default_shift_id: ids.ZDAY, members: 0 });
    ids.ZGF = fixed.body.id;
    const sched = await staff().post('/api/shifts/groups', { code: 'ZGS', name: 'zz_test scheduled', company_id: ids.ZZA, membership: 'manual', shift_type: 'scheduled' });
    expect(sched.status, sched.text).toBe(201);
    ids.ZGS = sched.body.id;
    const dept = await staff().post('/api/shifts/groups', { code: 'ZGD', name: 'zz_test warehouse', company_id: ids.ZZA, membership: 'department', department_id: ids['ZZA-WH'], shift_type: 'fixed', default_shift_id: ids.ZEARLY, default_effective_date: D(-60) });
    expect(dept.status, dept.text).toBe(201);
    ids.ZGD = dept.body.id;
    expect((await staff().post('/api/shifts/groups', { code: 'ZGX', name: 'x', company_id: ids.ZZA, shift_type: 'fixed' })).status).toBe(400); // fixed without default
    expect((await staff().post('/api/shifts/groups', { code: 'ZGY', name: 'x', company_id: ids.ZZA, shift_type: 'fixed', default_shift_id: ids.ZDAY, department_id: 999999 })).status).toBe(400);
  });
  it('manual membership: bulk add, conflict with another group, cross-company refused', async () => {
    const r = await staff().post(`/api/shifts/groups/${ids.ZGF}/members`, { employee_ids: [ids.ZA001, ids.ZA002, ids.ZB001], start_date: D(-30), reason: 'zz_test ตั้งค่าเริ่มต้น' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.add.map((x: { emp_code: string }) => x.emp_code)).toEqual(['ZA001', 'ZA002']);
    expect(r.body.conflicts).toHaveLength(1); // ZB001 belongs to another company
    const s = await staff().post(`/api/shifts/groups/${ids.ZGS}/members`, { employee_ids: [ids.ZA003, ids.ZA004, ids.ZA005], start_date: D(-30), reason: 'zz_test ตั้งค่าเริ่มต้น' });
    expect(s.body.add).toHaveLength(3);
    const dup = await staff().post(`/api/shifts/groups/${ids.ZGS}/members`, { employee_ids: [ids.ZA001], start_date: D(1) });
    expect(dup.status).toBe(409);
    expect(dup.text).toContain('ZGF');
    expect((await staff().post(`/api/shifts/groups/${ids.ZGF}/members`, { employee_ids: [ids.ZA006], start_date: D(-3) })).status).toBe(400); // past without a reason
    expect(count(`SELECT COUNT(*) AS n FROM shift_group_members WHERE end_date IS NULL`)).toBe(5);
  });
  it('department membership: dry run, then sync adds the department\'s employees', async () => {
    const dry = await staff().post(`/api/shifts/groups/${ids.ZGD}/sync`, { start_date: D(-30), reason: 'zz_test sync', dry_run: true });
    expect(dry.status, dry.text).toBe(200);
    expect(dry.body.add.map((x: { emp_code: string }) => x.emp_code).sort()).toEqual(['ZA006', 'ZA007', 'ZA008']);
    expect(count(`SELECT COUNT(*) AS n FROM shift_group_members WHERE group_id = ${ids.ZGD}`)).toBe(0);
    const ok = await staff().post(`/api/shifts/groups/${ids.ZGD}/sync`, { start_date: D(-30), reason: 'zz_test sync' });
    expect(ok.body.applied).toBe(true);
    // ZA008 moves to the OPS department: the next sync ends the membership
    H.sql(`UPDATE employees SET department_id = ${ids['ZZA-OPS']} WHERE id = ${ids.ZA008}`);
    const again = await staff().post(`/api/shifts/groups/${ids.ZGD}/sync`, { start_date: D(1) });
    expect(again.body.remove.map((x: { emp_code: string }) => x.emp_code)).toEqual(['ZA008']);
    expect(H.sql(`SELECT end_date FROM shift_group_members WHERE group_id = ${ids.ZGD} AND employee_id = ${ids.ZA008}`)[0]!.end_date).toBe(today);
  });
  it('company membership: a company group adds everyone not already in a group', async () => {
    const g = await staff().post('/api/shifts/groups', { code: 'ZGC', name: 'zz_test all', company_id: ids.ZZA, membership: 'company', shift_type: 'fixed', default_shift_id: ids.ZDAY, default_effective_date: D(1) });
    ids.ZGC = g.body.id;
    const dry = await staff().post(`/api/shifts/groups/${ids.ZGC}/sync`, { start_date: D(2), dry_run: true });
    expect(dry.body.add.map((x: { emp_code: string }) => x.emp_code).sort()).toEqual(['ZA008', 'ZA009']); // ZA008 left the warehouse group today
    expect(dry.body.conflicts.length).toBe(7); // ZA001–ZA007 are in other groups
  });
  it('transfer: impact preview, then the move ends the old membership and removes the old group\'s entries', async () => {
    // a scheduled entry of ZA005 in ZGS from D(5) (group origin) and an individual override at D(6)
    const sv = await staff().post('/api/shifts/schedule/changes', { company_id: ids.ZZA, group_id: ids.ZGS, change_token: 'zz-test-transfer-1', changes: [{ employee_id: ids.ZA005, date: D(5), kind: 'shift', shift_id: ids.ZEVE }] });
    expect(sv.body.applied, sv.text).toBe(true);
    await staff().post('/api/shifts/schedule/changes', { company_id: ids.ZZA, change_token: 'zz-test-transfer-2', changes: [{ employee_id: ids.ZA005, date: D(6), kind: 'shift', shift_id: ids.ZEVE }] });
    const dry = await staff().post(`/api/shifts/groups/${ids.ZGF}/transfer`, { employee_ids: [ids.ZA005], date: D(4), dry_run: true });
    expect(dry.body.moves).toEqual([expect.objectContaining({ emp_code: 'ZA005', from_group: 'ZGS', group_entries: 1, overrides: 1 })]);
    const ok = await staff().post(`/api/shifts/groups/${ids.ZGF}/transfer`, { employee_ids: [ids.ZA005], date: D(4) });
    expect(ok.body.applied, ok.text).toBe(true);
    expect(H.sql(`SELECT group_id, start_date, end_date, method FROM shift_group_members WHERE employee_id = ${ids.ZA005} ORDER BY id`)).toEqual([
      { group_id: ids.ZGS, start_date: D(-30), end_date: D(3), method: 'manual' },
      { group_id: ids.ZGF, start_date: D(4), end_date: null, method: 'transfer' },
    ]);
    expect(H.sql(`SELECT work_date, origin FROM shift_schedules WHERE employee_id = ${ids.ZA005} ORDER BY work_date`)).toEqual([{ work_date: D(6), origin: 'individual' }]);
    expect(count(`SELECT COUNT(*) AS n FROM shift_schedule_revisions WHERE employee_id = ${ids.ZA005} AND after_json IS NULL`)).toBe(1);
  });
  it('remove member and member history', async () => {
    const r = await staff().post(`/api/shifts/groups/${ids.ZGS}/members/remove`, { employee_ids: [ids.ZA004], end_date: D(20) });
    expect(r.status, r.text).toBe(200);
    const d = await staff().get(`/api/shifts/groups/${ids.ZGS}`);
    expect(d.body.members.find((m: { emp_code: string }) => m.emp_code === 'ZA004').end_date).toBe(D(20));
    expect(d.body.history.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['shift_group.created', 'shift_group.members_added', 'shift_group.members_removed']));
  });
  it('default shift changes take effect from a date (no retroactive change)', async () => {
    expect((await staff().post(`/api/shifts/groups/${ids.ZGF}/default`, { shift_id: ids.ZEVE, effective_date: D(-1) })).status).toBe(400);
    const r = await staff().post(`/api/shifts/groups/${ids.ZGF}/default`, { shift_id: ids.ZEVE, effective_date: D(10) });
    expect(r.status, r.text).toBe(200);
    const s = await staff().get(`/api/shifts/schedule?company=${ids.ZZA}&group=${ids.ZGF}&from=${D(8)}&to=${D(11)}`);
    const cells = s.body.cells[ids.ZA001!];
    expect(cells[D(9)]).toMatchObject({ kind: 'shift', shift_id: ids.ZDAY, source: 'group_default' });
    expect(cells[D(10)]).toMatchObject({ kind: 'shift', shift_id: ids.ZEVE, source: 'group_default' });
  });
  it('permissions and company scope', async () => {
    expect((await c.manager!.get('/api/shifts/groups')).status).toBe(200);
    expect((await c.manager!.post(`/api/shifts/groups/${ids.ZGF}/members`, { employee_ids: [ids.ZA006], start_date: D(1) })).status).toBe(403);
    // own-scope user (DEMO only) cannot see or change ZZA groups
    expect((await c.employee!.get(`/api/shifts/groups/${ids.ZGF}`)).status).toBe(404);
    expect((await c.employee!.post(`/api/shifts/groups/${ids.ZGF}/members`, { employee_ids: [ids.ZA006], start_date: D(1) })).status).toBe(404);
    expect((await c.employee!.post('/api/shifts/groups', { code: 'ZGE', name: 'x', company_id: ids.ZZA, shift_type: 'scheduled' })).status).toBe(403);
    expect((await c.employee!.get(`/api/shifts/schedule?company=${ids.ZZA}&from=${D(1)}&to=${D(2)}`)).status).toBe(403);
    expect((await c.employee!.get(`/api/shifts/people?company=${ids.ZZA}`)).status).toBe(403);
  });
});

describe('group schedule', () => {
  it('monthly calendar: members, fixed defaults (Mon–Fri shift → weekend day off), holidays and leave shown', async () => {
    const from = `${D(30).slice(0, 7)}-01`;
    const to = monthEnd(from);
    const r = await staff().get(`/api/shifts/schedule?company=${ids.ZZA}&group=${ids.ZGD}&from=${from}&to=${to}`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.employees.map((e: { emp_code: string }) => e.emp_code)).toEqual(['ZA006', 'ZA007']); // ZA008 left the group today
    const sat = Object.keys(r.body.cells[ids.ZA006!]).find((d) => weekday(d) === 6) as string;
    const mon = Object.keys(r.body.cells[ids.ZA006!]).find((d) => weekday(d) === 1) as string;
    expect(r.body.cells[ids.ZA006!][sat]).toMatchObject({ kind: 'day_off', source: 'group_default' });
    expect(r.body.cells[ids.ZA006!][mon]).toMatchObject({ kind: 'shift', shift_id: ids.ZEARLY, source: 'group_default' });
    expect((await staff().get(`/api/shifts/schedule?company=${ids.ZZA}&from=${D(0)}&to=${D(80)}`)).status).toBe(400); // more than 62 days
  });
  it('daily, bulk, day off and holiday assignment in a scheduled group (group origin) with revisions', async () => {
    const changes = [
      ...[1, 2, 3].map((i) => ({ employee_id: ids.ZA003, date: D(i), kind: 'shift', shift_id: ids.ZNIGHT })),
      ...[1, 2, 3].map((i) => ({ employee_id: ids.ZA004, date: D(i), kind: 'shift', shift_id: ids.ZDAY })),
      { employee_id: ids.ZA003, date: D(4), kind: 'day_off' }, { employee_id: ids.ZA004, date: D(4), kind: 'holiday' },
    ];
    const dry = await staff().post('/api/shifts/schedule/changes', { company_id: ids.ZZA, group_id: ids.ZGS, changes, dry_run: true });
    expect(dry.body).toMatchObject({ applied: false, errors: [], summary: { changes: 8, shift: 6, day_off: 1, holiday: 1 } });
    expect(count('SELECT COUNT(*) AS n FROM shift_schedules WHERE employee_id IN (' + [ids.ZA003, ids.ZA004].join() + ')')).toBe(0);
    const ok = await staff().post('/api/shifts/schedule/changes', { company_id: ids.ZZA, group_id: ids.ZGS, changes, change_token: 'zz-test-bulk-0001' });
    expect(ok.body.applied, ok.text).toBe(true);
    expect(H.sql(`SELECT kind, origin, group_id FROM shift_schedules WHERE employee_id = ${ids.ZA003} AND work_date = '${D(1)}'`)[0]).toEqual({ kind: 'shift', origin: 'group', group_id: ids.ZGS });
    expect(count("SELECT COUNT(*) AS n FROM shift_schedule_revisions WHERE change_token = 'zz-test-bulk-0001'")).toBe(8);
    // the same save again (same token) changes nothing
    const again = await staff().post('/api/shifts/schedule/changes', { company_id: ids.ZZA, group_id: ids.ZGS, changes: [{ employee_id: ids.ZA003, date: D(1), kind: 'clear' }], change_token: 'zz-test-bulk-0001' });
    expect(again.body).toMatchObject({ applied: true, repeated: true });
    expect(count(`SELECT COUNT(*) AS n FROM shift_schedules WHERE employee_id = ${ids.ZA003} AND work_date = '${D(1)}'`)).toBe(1);
  });
  it('individual override on a fixed-group member is shown as an override', async () => {
    const r = await staff().post('/api/shifts/schedule/changes', { company_id: ids.ZZA, change_token: 'zz-test-override-1', changes: [{ employee_id: ids.ZA001, date: D(2), kind: 'shift', shift_id: ids.ZEVE }] });
    expect(r.body.applied, r.text).toBe(true);
    const s = await staff().get(`/api/shifts/schedule?company=${ids.ZZA}&group=${ids.ZGF}&from=${D(1)}&to=${D(3)}`);
    expect(s.body.cells[ids.ZA001!][D(1)]).toMatchObject({ source: 'group_default', shift_id: ids.ZDAY });
    expect(s.body.cells[ids.ZA001!][D(2)]).toMatchObject({ source: 'individual', shift_id: ids.ZEVE });
  });
  it('conflicts: night shift followed by an early shift, not a member of the group, leave needs confirmation', async () => {
    const bad = await staff().post('/api/shifts/schedule/changes', { company_id: ids.ZZA, group_id: ids.ZGS, change_token: 'zz-test-conflict-1', changes: [{ employee_id: ids.ZA003, date: D(2), kind: 'shift', shift_id: ids.ZEARLY }] });
    expect(bad.body.applied).toBe(false);
    expect(bad.body.errors[0].message).toContain('กะข้ามวัน');
    const notMember = await staff().post('/api/shifts/schedule/changes', { company_id: ids.ZZA, group_id: ids.ZGS, change_token: 'zz-test-conflict-2', changes: [{ employee_id: ids.ZA001, date: D(7), kind: 'day_off' }] });
    expect(notMember.body.errors[0].message).toContain('ไม่ได้เป็นสมาชิก');
    H.sql(`INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status) VALUES (${ids.ZA003}, (SELECT id FROM leave_types ORDER BY id LIMIT 1), '${D(8)}', '${D(8)}', 1, 'zz_test', 'approved')`);
    const leave = { company_id: ids.ZZA, group_id: ids.ZGS, changes: [{ employee_id: ids.ZA003, date: D(8), kind: 'shift', shift_id: ids.ZDAY }], change_token: 'zz-test-leave-0001' };
    const warn = await staff().post('/api/shifts/schedule/changes', leave);
    expect(warn.body).toMatchObject({ applied: false, errors: [] });
    expect(warn.body.warnings[0].message).toContain('ใบลา');
    expect((await staff().post('/api/shifts/schedule/changes', { ...leave, accept_warnings: true })).body.applied).toBe(true);
    const cal = await staff().get(`/api/shifts/schedule?company=${ids.ZZA}&group=${ids.ZGS}&from=${D(8)}&to=${D(8)}`);
    expect(cal.body.leaves).toEqual([expect.objectContaining({ employee_id: ids.ZA003, start_date: D(8) })]);
  });
  it('copy: previous week to this week, previous month to this month (days without an entry are cleared)', async () => {
    const wk = await staff().post('/api/shifts/schedule/copy', { company_id: ids.ZZA, group_id: ids.ZGS, employee_ids: [ids.ZA003], from_start: D(1), from_end: D(7), to_start: D(15), change_token: 'zz-test-copy-week1' });
    expect(wk.body.applied, wk.text).toBe(true);
    expect(H.sql(`SELECT work_date, kind, shift_id FROM shift_schedules WHERE employee_id = ${ids.ZA003} AND work_date BETWEEN '${D(15)}' AND '${D(21)}' ORDER BY work_date`)).toEqual([
      { work_date: D(15), kind: 'shift', shift_id: ids.ZNIGHT }, { work_date: D(16), kind: 'shift', shift_id: ids.ZNIGHT }, { work_date: D(17), kind: 'shift', shift_id: ids.ZNIGHT }, { work_date: D(18), kind: 'day_off', shift_id: null },
    ]);
    const monthStart = `${D(40).slice(0, 7)}-01`;
    const prevStart = `${addDays(monthStart, -1).slice(0, 7)}-01`;
    const m = await staff().post('/api/shifts/schedule/copy', { company_id: ids.ZZA, group_id: ids.ZGS, employee_ids: [ids.ZA003], from_start: prevStart, from_end: addDays(monthStart, -1), to_start: monthStart, to_end: addDays(`${D(70).slice(0, 7)}-01`, -1), mode: 'month', dry_run: true });
    expect(m.status, m.text).toBe(200);
    expect(m.body.summary.changes).toBeGreaterThanOrEqual(28);
  });
  it('historical protection: past days need a reason, days in a calculated payroll period are refused', async () => {
    const past = { company_id: ids.ZZA, group_id: ids.ZGS, changes: [{ employee_id: ids.ZA003, date: D(-2), kind: 'shift', shift_id: ids.ZDAY }], change_token: 'zz-test-past-0001' };
    const r1 = await staff().post('/api/shifts/schedule/changes', past);
    expect(r1.body.errors[0].message).toContain('เหตุผล');
    expect((await staff().post('/api/shifts/schedule/changes', { ...past, reason: 'zz_test แก้ไขตามเอกสาร' })).body.applied).toBe(true);
    expect(H.sql(`SELECT reason FROM shift_schedule_revisions WHERE change_token = 'zz-test-past-0001'`)[0]!.reason).toBe('zz_test แก้ไขตามเอกสาร');
    H.sql(`INSERT INTO payroll_periods (code, name, start_date, end_date, pay_date, status, kind, company_id) VALUES ('ZZA-LOCK', 'zz_test locked', '${D(-60)}', '${D(-40)}', '${D(-39)}', 'approved', 'monthly', ${ids.ZZA})`);
    const locked = await staff().post('/api/shifts/schedule/changes', { company_id: ids.ZZA, group_id: ids.ZGS, reason: 'zz_test', changes: [{ employee_id: ids.ZA003, date: D(-50), kind: 'day_off' }], change_token: 'zz-test-lock-0001' });
    expect(locked.body.errors[0].message).toContain('ZZA-LOCK');
    expect((await staff().post(`/api/shifts/groups/${ids.ZGS}/members`, { employee_ids: [ids.ZA006], start_date: D(-50), reason: 'zz_test' })).status).toBe(409);
    const hist = await staff().get(`/api/shifts/schedule/history?employee=${ids.ZA003}&from=${D(-5)}&to=${D(30)}`);
    expect(hist.body.length).toBeGreaterThanOrEqual(5);
  });
});

describe('attendance file import', () => {
  const head = ['รหัสพนักงาน', 'วันที่', 'เวลาเข้า', 'เวลาออก', 'เครื่อง', 'หมายเหตุ'];
  it('CSV: preview validates each row (valid, warning, invalid, wrong company, unknown, future, before hire, cross-midnight)', async () => {
    // ZA004 (scheduled group) works the night shift on D(-3)
    await staff().post('/api/shifts/schedule/changes', { company_id: ids.ZZA, group_id: ids.ZGS, reason: 'zz_test เตรียมข้อมูล', change_token: 'zz-test-night-imp1', changes: [{ employee_id: ids.ZA004, date: D(-3), kind: 'shift', shift_id: ids.ZNIGHT }] });
    const csv = [
      head.join(','),
      `ZA001,${D(-3)},07:58,17:05,HQ-01,`, // fixed ZDAY: on time
      `ZA002,${D(-3)},08:12,16:30,HQ-01,`, // late 12 (grace 5), early leave
      `ZA004,${D(-3)},21:55,07:02,HQ-02,กะดึก`, // night shift: clock-out next morning
      `ZA006,${D(-3)},06:00,,HQ-02,`, // missing clock-out → warning
      `ZA007,${D(-3)},,15:00,HQ-02,`, // missing clock-in → invalid
      `ZA007,31/02/2026,06:00,15:00,HQ-02,`, // invalid date
      `ZB001,${D(-3)},08:00,17:00,HQ-01,`, // another company
      `ZZ999,${D(-3)},08:00,17:00,HQ-01,`, // unknown
      `ZA001,${D(2)},08:00,17:00,HQ-01,`, // future
      `ZA009,${D(-10)},08:00,17:00,HQ-01,`, // before hire date
      `ZA001,${D(-3)},08:00,17:00,HQ-01,`, // same employee and day again → duplicate in file
    ].join('\r\n');
    const r = await staff().post('/api/attendance-files/preview', fileBody(ids.ZZA!, parseCsv(csv)));
    expect(r.status, r.text).toBe(200);
    expect(r.body.mapping).toMatchObject({ employee_code: 0, work_date: 1, clock_in: 2, clock_out: 3, device: 4, remark: 5 });
    expect(r.body.summary).toEqual({ total: 11, valid: 2, warning: 2, duplicate: 1, invalid: 6, importable: 4 });
    const byRow = new Map(r.body.rows.map((x: { row_no: number }) => [x.row_no, x]));
    expect(byRow.get(2)).toMatchObject({ status: 'valid', attendance_status: 'present', shift_label: expect.stringContaining('08:00–17:00') });
    expect(byRow.get(3)).toMatchObject({ status: 'warning', attendance_status: 'late', late_minutes: 12, early_leave_minutes: 30 });
    expect(byRow.get(4)).toMatchObject({ status: 'valid', attendance_status: 'present', out_next_day: true, worked_minutes: 487 });
    expect(byRow.get(5)).toMatchObject({ status: 'warning' });
    const codes = (row: number) => (byRow.get(row) as { issues: Array<{ code: string }> }).issues.map((i) => i.code);
    expect(codes(6)).toContain('missing_clock_in');
    expect(codes(7)).toContain('bad_date');
    expect(codes(8)).toContain('wrong_company');
    expect(codes(9)).toContain('unknown_employee');
    expect(codes(10)).toContain('future_date');
    expect(codes(11)).toContain('not_employed');
    expect(codes(12)).toContain('duplicate_in_file');
    expect(count('SELECT COUNT(*) AS n FROM attendance_raw_records')).toBe(0); // preview writes nothing
  });
  it('confirm: partial import, raw rows kept, existing day not overwritten, mapping remembered, audited, idempotent', async () => {
    // an existing manual record must not be overwritten by the file
    H.sql(`INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source, note) VALUES (${ids.ZA008}, '${D(-4)}', '09:00', '18:00', 'present', 'manual', 'zz_test เดิม')`);
    const csv = [head.join(','), `ZA001,${D(-4)},08:00,17:00,HQ-01,`, `ZA008,${D(-4)},06:00,15:00,HQ-02,`, `ZZ999,${D(-4)},08:00,17:00,HQ-01,`].join('\r\n');
    const body = { ...fileBody(ids.ZZA!, parseCsv(csv), { file_name: 'partial.csv' }), idempotency_key: 'zz-test-import-0001', confirm: true };
    expect((await staff().post('/api/attendance-files', { ...body, confirm: false })).status).toBe(400);
    const r = await staff().post('/api/attendance-files', body);
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ total_rows: 3, imported_count: 1, duplicate_count: 1, invalid_count: 1, status: 'partial', file_name: 'partial.csv', created_by_name: 'it_staff' });
    expect(H.sql(`SELECT clock_in, clock_out, source, note FROM attendance_records WHERE employee_id = ${ids.ZA008} AND work_date = '${D(-4)}'`)[0]).toEqual({ clock_in: '09:00', clock_out: '18:00', source: 'manual', note: 'zz_test เดิม' });
    expect(H.sql(`SELECT status, source, shift_id, import_batch_id, device FROM attendance_records WHERE employee_id = ${ids.ZA001} AND work_date = '${D(-4)}'`)[0]).toEqual({ status: 'present', source: 'import', shift_id: ids.ZDAY, import_batch_id: r.body.id, device: 'HQ-01' });
    expect(count(`SELECT COUNT(*) AS n FROM attendance_raw_records WHERE batch_id = ${r.body.id}`)).toBe(3);
    expect(count(`SELECT COUNT(*) AS n FROM attendance_records WHERE employee_id IN (SELECT id FROM employees WHERE emp_code = 'ZZ999')`)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'attendance_file.imported'")).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM attendance_file_mappings WHERE company_id = ${ids.ZZA}`)).toBe(1);
    // the same confirmation again returns the same batch
    const again = await staff().post('/api/attendance-files', body);
    expect(again.body).toMatchObject({ id: r.body.id, repeated: true });
    expect(count('SELECT COUNT(*) AS n FROM attendance_file_imports')).toBe(1);
    // raw rows are read-only
    expect(() => H.sql(`UPDATE attendance_raw_records SET clock_in = '07:00' WHERE batch_id = ${r.body.id}`)).toThrow();
    expect(() => H.sql(`DELETE FROM attendance_raw_records WHERE batch_id = ${r.body.id}`)).toThrow();
  });
  it('importing the same file again creates no duplicate attendance', async () => {
    const csv = [head.join(','), `ZA001,${D(-4)},08:00,17:00,HQ-01,`, `ZA008,${D(-4)},06:00,15:00,HQ-02,`].join('\r\n');
    const before = count('SELECT COUNT(*) AS n FROM attendance_records');
    const pre = await staff().post('/api/attendance-files/preview', fileBody(ids.ZZA!, parseCsv(csv), { sha256: sha('a1') }));
    expect(pre.body.summary).toMatchObject({ duplicate: 2, importable: 0 });
    const r = await staff().post('/api/attendance-files', { ...fileBody(ids.ZZA!, parseCsv(csv)), idempotency_key: 'zz-test-import-0002', confirm: true });
    expect(r.body).toMatchObject({ imported_count: 0, duplicate_count: 2, status: 'failed' });
    expect(count('SELECT COUNT(*) AS n FROM attendance_records')).toBe(before);
  });
  it('XLSX and XLS files (parsed like the browser does) with a remembered mapping and a cross-midnight shift', async () => {
    const rows: Cell[][] = [['Emp Code', 'Work Date', 'Time In', 'Time Out', 'Device'], ['ZA004', D(-5), '22:05', `${D(-4)} 07:00`, 'HQ-02'], ['ZA002', D(-5), 0.3333333333333333, 0.7083333333333334, 'HQ-01']];
    await staff().post('/api/shifts/schedule/changes', { company_id: ids.ZZA, group_id: ids.ZGS, reason: 'zz_test เตรียมข้อมูล', change_token: 'zz-test-night-imp2', changes: [{ employee_id: ids.ZA004, date: D(-5), kind: 'shift', shift_id: ids.ZNIGHT }] });
    const xlsxGrid = (await readXlsx(writeXlsx('Sheet1', rows)))[0]!.rows;
    const x = await staff().post('/api/attendance-files', { ...fileBody(ids.ZZA!, xlsxGrid, { file_name: 'clock.xlsx', file_type: 'xlsx' }), idempotency_key: 'zz-test-import-xlsx', confirm: true });
    expect(x.body, x.text).toMatchObject({ imported_count: 2, status: 'completed' });
    expect(H.sql(`SELECT clock_in, clock_out, clock_out_next_day, status, late_minutes FROM attendance_records WHERE employee_id = ${ids.ZA004} AND work_date = '${D(-5)}'`)[0]).toEqual({ clock_in: '22:05', clock_out: '07:00', clock_out_next_day: 1, status: 'late', late_minutes: 5 });
    const xlsGrid = (await readXls(writeXls([{ name: 'Sheet1', rows: [rows[0]!, ['ZA001', D(-6), '08:00', '17:00', 'HQ-01'], ['ZA006', D(-6), '06:00', '15:00', 'HQ-02']] }])))[0]!.rows;
    const pre = await staff().post('/api/attendance-files/preview', fileBody(ids.ZZA!, xlsGrid, { file_name: 'clock.xls', file_type: 'xls' }));
    expect(pre.body.remembered).toBe(true);
    const ok = await staff().post('/api/attendance-files', { ...fileBody(ids.ZZA!, xlsGrid, { file_name: 'clock.xls', file_type: 'xls' }), idempotency_key: 'zz-test-import-xls1', confirm: true });
    expect(ok.body).toMatchObject({ imported_count: 2, status: 'completed' });
  });
  it('invalid files and mappings are refused', async () => {
    expect((await staff().post('/api/attendance-files/preview', fileBody(ids.ZZA!, [['a']], { file_name: 'x.pdf', file_type: 'pdf' }))).status).toBe(400);
    expect((await staff().post('/api/attendance-files/preview', fileBody(ids.ZZA!, [['a']], { file_name: 'x.csv', file_type: 'xlsx' }))).status).toBe(400);
    expect((await staff().post('/api/attendance-files/preview', fileBody(ids.ZZA!, 'not a grid' as unknown as Cell[][]))).status).toBe(400);
    expect((await staff().post('/api/attendance-files/preview', fileBody(ids.ZZA!, [['a', 'b']], { sha256: 'x' }))).status).toBe(400);
    const nomap = await staff().post('/api/attendance-files/preview', fileBody(ids.ZZA!, [['foo', 'bar'], ['1', '2']]));
    expect(nomap.body.mapping_problems.length).toBeGreaterThan(0);
    const big = Array.from({ length: 10_100 }, (_, i) => [`ZA001`, D(-1), '08:00', String(i)]);
    expect((await staff().post('/api/attendance-files/preview', fileBody(ids.ZZA!, [['รหัสพนักงาน', 'วันที่', 'เวลาเข้า', 'เวลาออก'], ...big]))).status).toBe(400);
  });
  it('rows inside a calculated payroll period are invalid', async () => {
    const csv = [head.join(','), `ZA001,${D(-50)},08:00,17:00,HQ-01,`].join('\r\n');
    const r = await staff().post('/api/attendance-files/preview', fileBody(ids.ZZA!, parseCsv(csv)));
    expect(r.body.rows[0].issues.map((i: { code: string }) => i.code)).toContain('period_locked');
  });
  it('history, detail and the error report (CSV / XLSX)', async () => {
    const list = await staff().get(`/api/attendance-files?company=${ids.ZZA}`);
    expect(list.body.length).toBe(4);
    expect(list.body[list.body.length - 1]).toMatchObject({ file_name: 'partial.csv', total_rows: 3, imported_count: 1, duplicate_count: 1, invalid_count: 1, company_code: 'ZZA' });
    const id = list.body[list.body.length - 1].id;
    const d = await staff().get(`/api/attendance-files/${id}`);
    expect(d.body.rows.map((r: { status: string }) => r.status)).toEqual(['valid', 'duplicate', 'invalid']);
    const rep = await staff().bytes('GET', `/api/attendance-files/${id}/report?format=csv`);
    expect(rep.headers.get('content-type')).toContain('text/csv');
    expect(rep.text).toContain('ZZ999');
    expect(rep.text).toContain('ไม่พบพนักงานรหัส ZZ999');
    expect(rep.text).not.toContain(`ZA001,${D(-4)}`);
    const xl = await staff().bytes('GET', `/api/attendance-files/${id}/report?format=xlsx`);
    expect((await readXlsx(xl.raw))[0]!.rows.length).toBe(3); // header + duplicate + invalid
    expect(count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'attendance_file.report_downloaded'")).toBe(2);
  });
  it('permissions and company scope', async () => {
    expect((await c.manager!.post('/api/attendance-files/preview', fileBody(ids.ZZA!, [['a']]))).status).toBe(403);
    expect((await c.manager!.get('/api/attendance-files')).status).toBe(403);
    const own = await c.employee!.get('/api/attendance-files');
    expect(own.status).toBe(200);
    expect(own.body).toEqual([]); // ZZA imports are not visible to a DEMO-only user
    expect((await c.employee!.get(`/api/attendance-files/${ids.ZZA}`)).status).toBe(404);
    expect((await c.employee!.post('/api/attendance-files/preview', fileBody(ids.ZZA!, [['a']]))).status).toBe(403);
    // a ZZA employee code in a DEMO import reads as unknown (no cross-company disclosure)
    const demo = Number(H.sql("SELECT id FROM companies WHERE code = 'DEMO'")[0]!.id);
    const r = await c.employee!.post('/api/attendance-files/preview', fileBody(demo, parseCsv([head.join(','), `ZA001,${D(-3)},08:00,17:00,,`].join('\n'))));
    expect(r.status, r.text).toBe(200);
    expect(r.body.rows[0].issues[0]).toMatchObject({ code: 'unknown_employee' });
  });
  it('attendance summary of the existing system counts the imported late day; payroll untouched', async () => {
    expect(count(`SELECT COUNT(*) AS n FROM attendance_records WHERE status = 'late' AND source = 'import'`)).toBeGreaterThanOrEqual(1);
    expect(payroll()).toBe(payrollBefore);
  });
});
