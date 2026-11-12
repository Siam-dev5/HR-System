// Attendance holds (P1, migration 0019) — isolated local D1, synthetic data only (companies ZHA / ZHB, employees
// ZH1–ZH6). October 2026 (1 Oct = Thursday); company ZHA has its own calendar (rest Sat/Sun) with an approved company
// holiday on Wed 14 Oct. Covers: the setting (validation, off by default, periods before the date unchanged), what a
// scan holds (absent, pending leave, missing attendance; never present / approved leave / holiday / rest day /
// exempt days), the lifecycle (open → cleared, unchanged scan keeps cleared, changed source reopens, corrected data
// resolves), the approval gate (open holds, recalculation after a resolve, calc_version), Preview / export block,
// company scope, permissions, append-only history, audit, concurrent scans, and the ACC sign-off gate afterwards.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, seedAccountingSignOff, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const ids = {} as Record<'A' | 'B' | 'P0' | 'PA' | 'PB' | 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'leave3' | 'payroll' | 'admin', number>;
const WRANGLER = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const PASSWORD = 'Zz-Holds-Pass-2026!';
const one = (sql: string) => H.sql(sql)[0] as Record<string, any>;
const holds = (periodId: number) =>
  H.sql(`SELECT e.emp_code AS emp, h.kind, h.work_date AS d, h.status FROM payroll_attendance_holds h JOIN employees e ON e.id = h.employee_id WHERE h.period_id = ${periodId} ORDER BY e.emp_code, h.work_date, h.kind`)
    .map((x) => `${x.emp}:${x.kind}:${x.d ?? '-'}:${x.status}`);
const events = (periodId: number, emp: string) =>
  H.sql(`SELECT ev.action FROM payroll_attendance_hold_events ev JOIN payroll_attendance_holds h ON h.id = ev.hold_id JOIN employees e ON e.id = h.employee_id WHERE ev.period_id = ${periodId} AND e.emp_code = '${emp}' ORDER BY ev.id`).map((x) => String(x.action));
const holdId = (periodId: number, emp: string, kind: string) => Number(one(`SELECT h.id FROM payroll_attendance_holds h JOIN employees e ON e.id = h.employee_id WHERE h.period_id = ${periodId} AND e.emp_code = '${emp}' AND h.kind = '${kind}'`).id);

/** Weekdays of October 2026 (Mon–Fri). */
const weekdays = (() => {
  const out: string[] = [];
  for (let d = 1; d <= 31; d++) {
    const s = `2026-10-${String(d).padStart(2, '0')}`;
    const w = new Date(`${s}T00:00:00Z`).getUTCDay();
    if (w !== 0 && w !== 6) out.push(s);
  }
  return out;
})();
const attend = (emp: number, days: string[]) => (days.length ? H.sql(`INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source) VALUES ${days.map((d) => `(${emp}, '${d}', '09:00', '18:00', 'present', 'import')`).join(', ')};`) : undefined);

async function period(code: string, companyId: number, start: string, end: string): Promise<number> {
  const r = await c.admin!.post('/api/payroll/periods', { code, name: code, kind: 'monthly', company_id: companyId, start_date: start, end_date: end, pay_date: end });
  expect(r.status, r.text).toBe(201);
  return r.body.id as number;
}

beforeAll(async () => {
  H = await startHarness();
  H.sql(`INSERT INTO companies (code, name, active) VALUES ('ZHA', 'ZZ Holds A', 1), ('ZHB', 'ZZ Holds B', 1);`);
  ids.A = Number(one("SELECT id FROM companies WHERE code = 'ZHA'").id);
  ids.B = Number(one("SELECT id FROM companies WHERE code = 'ZHB'").id);
  const emp = (code: string, co: number) => `('${code}', 'Zz', '${code}', ${co}, '2026-01-01', 'permanent', 'active', 30000)`;
  H.sql(`INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status, base_salary) VALUES
    ${emp('ZH1', ids.A)}, ${emp('ZH2', ids.A)}, ${emp('ZH3', ids.A)}, ${emp('ZH4', ids.A)}, ${emp('ZH6', ids.A)}, ${emp('ZH5', ids.B)}, ('ZH9', 'Zz', 'ZH9', ${ids.B}, '2026-01-01', 'permanent', 'active', 15000);`);
  for (const k of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6'] as const) ids[k] = Number(one(`SELECT id FROM employees WHERE emp_code = 'Z${k}'`).id);
  // company A calendar: rest Sat/Sun, approved company holiday Wed 14 Oct
  H.sql(`INSERT INTO holiday_calendars (code, name, country_code, company_id, weekly_rest_days) VALUES ('ZZ-ZHA', 'zz holds A', 'TH', ${ids.A}, '0,6');
    INSERT INTO holidays (calendar_id, holiday_date, year, name, holiday_type, status, verification, source_reference)
    SELECT id, '2026-10-14', 2026, 'zz company day', 'company', 'approved', 'verified', 'zz test' FROM holiday_calendars WHERE code = 'ZZ-ZHA';`);
  // ZH1 every weekday; ZH2 absent Wed 7 Oct (and away on the holiday); ZH3 pending sick leave Thu 8 Oct;
  // ZH4 nothing at all; ZH6 nothing but exempt all month; ZH5 (company B) absent Fri 9 Oct
  attend(ids.H1, weekdays);
  attend(ids.H2, weekdays.filter((d) => d !== '2026-10-07' && d !== '2026-10-14'));
  attend(ids.H3, weekdays.filter((d) => d !== '2026-10-08'));
  attend(ids.H5, weekdays.filter((d) => d !== '2026-10-09'));
  attend(Number(one("SELECT id FROM employees WHERE emp_code = 'ZH9'").id), weekdays);
  H.sql(`INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status) SELECT ${ids.H3}, id, '2026-10-08', '2026-10-08', 1, 'zz sick', 'pending' FROM leave_types ORDER BY id LIMIT 1;
    INSERT INTO employee_attendance_exemptions (employee_id, effective_from, effective_to, reason) VALUES (${ids.H6}, '2026-01-01', NULL, 'zz exempt');`);
  ids.leave3 = Number(one(`SELECT id FROM leave_requests WHERE employee_id = ${ids.H3}`).id);

  c.admin = new Client(H.baseUrl);
  await c.admin.login('it_admin', H.passwords.it_admin);
  c.payroll = new Client(H.baseUrl);
  await c.payroll.login('it_payroll', H.passwords.it_payroll);
  c.staff = new Client(H.baseUrl);
  await c.staff.login('it_staff', H.passwords.it_staff);
  ids.payroll = Number(one("SELECT id FROM users WHERE username = 'it_payroll'").id);
  ids.admin = Number(one("SELECT id FROM users WHERE username = 'it_admin'").id);
  // a company-limited payroll user of company B (no employees.all)
  H.sql(`INSERT INTO roles (code, name, description, privileged, system) VALUES ('zz_hold_b', 'ZZ holds B', 'test', 0, 0);
    INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.value FROM roles r, json_each('["payroll.view","payroll.calculate","payroll_preview.view","payroll_hold.resolve"]') p WHERE r.code = 'zz_hold_b';`);
  const out = join(H.dir, 'zz_hold_b.sql');
  execFileSync(process.execPath, ['scripts/create-user.mjs', '--username', 'zz_hold_b', '--display', 'zz_hold_b', '--role', 'zz_hold_b', '--employee', 'ZH9', '--out', out, '--cred-file', join(H.dir, 'holds-cred.txt')], { env: { ...process.env, NEW_USER_PASSWORD: PASSWORD }, stdio: 'ignore' });
  execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', join(H.dir, 'state'), '--file', out], { env: { ...process.env, CI: '1' }, stdio: 'ignore' });
  c.scopedB = new Client(H.baseUrl);
  expect((await c.scopedB.login('zz_hold_b', PASSWORD)).status).toBe(200);
}, 300_000);
afterAll(async () => {
  await H?.stop();
});

describe('migration 0019 and the setting', () => {
  it('adds the setting (empty = off) and grants payroll_hold.resolve to payroll_officer and hr_payroll only', () => {
    expect(one("SELECT value, type FROM settings WHERE key = 'payroll.attendance_review_from'")).toEqual({ value: '', type: 'text' });
    expect(H.sql("SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission = 'payroll_hold.resolve' AND r.code NOT LIKE 'zz%' ORDER BY 1").map((x) => x.code)).toEqual(['hr_payroll', 'payroll_officer']);
  });

  it('off by default: a period is calculated and approved exactly as before, with no hold', async () => {
    ids.P0 = await period('ZH-2026-09', ids.A, '2026-09-01', '2026-09-30');
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.P0}/calculate`)).status).toBe(200);
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.P0}/attendance-holds/scan`)).status).toBe(409);
    expect((await c.admin!.post(`/api/payroll/periods/${ids.P0}/approve`)).status).toBe(200);
    expect(holds(ids.P0)).toEqual([]);
  });

  it('only a valid date (or empty) is accepted; periods starting before it stay unchanged', async () => {
    expect((await c.admin!.put('/api/admin/settings', { 'payroll.attendance_review_from': '2026-13-45' })).status).toBe(400);
    expect((await c.admin!.put('/api/admin/settings', { 'payroll.attendance_review_from': 'soon' })).status).toBe(400);
    expect((await c.admin!.put('/api/admin/settings', { 'payroll.attendance_review_from': '2026-10-01' })).status).toBe(200);
    expect(one("SELECT value FROM settings WHERE key = 'payroll.attendance_review_from'").value).toBe('2026-10-01');
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.P0}/attendance-holds/scan`)).status).toBe(409);
  });
});

describe('scan: what is held', () => {
  it('calculation scans: absent, pending leave, missing attendance; never present, holiday, rest day or exempt days', async () => {
    ids.PA = await period('ZH-2026-10', ids.A, '2026-10-01', '2026-10-31');
    const before = Number(one('SELECT COUNT(*) AS n FROM payslips').n);
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.PA}/calculate`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.open_holds).toBe(3);
    expect(holds(ids.PA)).toEqual([
      'ZH2:absent:2026-10-07:open',
      'ZH3:pending_leave:2026-10-08:open',
      'ZH4:missing_attendance:-:open',
    ]);
    // payslips are still produced for everyone, with the unchanged engine (holds never change figures)
    expect(Number(one('SELECT COUNT(*) AS n FROM payslips').n) - before).toBe(5);
    const audit = JSON.parse(String(one(`SELECT details FROM audit_logs WHERE action = 'payroll.calculated' AND entity_id = '${ids.PA}' ORDER BY id DESC LIMIT 1`).details));
    expect(audit.attendanceHolds).toMatchObject({ detected: 3, opened: 3, open: 3 });
    expect(events(ids.PA, 'ZH2')).toEqual(['opened']);
  });

  it('the hold list carries the kind, the reason and the source references', async () => {
    const r = await c.payroll!.get(`/api/payroll/periods/${ids.PA}/attendance-holds`);
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    const h3 = r.body.holds.find((h: { emp_code: string }) => h.emp_code === 'ZH3');
    expect(h3).toMatchObject({ kind: 'pending_leave', work_date: '2026-10-08', status: 'open', label: 'ใบลารออนุมัติ' });
    expect(h3.source.leaves).toEqual([{ source: 'request', id: ids.leave3, status: 'pending' }]);
    expect(h3.events.map((e: { action: string }) => e.action)).toEqual(['opened']);
    expect(r.body.holds.find((h: { emp_code: string }) => h.emp_code === 'ZH4').source.workdays).toBeGreaterThan(15);
    expect((await c.payroll!.get(`/api/payroll/periods/${ids.PA}/attendance-holds?status=bogus`)).status).toBe(400);
  });
});

describe('approval gate and Preview', () => {
  it('open holds refuse HR approval; the Preview shows them and export is blocked', async () => {
    const a = await c.admin!.post(`/api/payroll/periods/${ids.PA}/approve`);
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe('attendance_holds_open');
    expect(one(`SELECT status FROM payroll_periods WHERE id = ${ids.PA}`).status).toBe('calculated');
    const pv = await c.payroll!.get(`/api/payroll/periods/${ids.PA}/preview`);
    const issue = pv.body.issues.find((i: { code: string }) => i.code === 'attendance_hold');
    expect(issue).toMatchObject({ level: 'error', count: 3 });
    expect(issue.message).toContain('ใบลารออนุมัติ 1');
    expect(pv.body.exportable).toBe(false);
    expect((await c.payroll!.get(`/api/payroll/periods/${ids.PA}/preview.csv`)).status).toBe(409);
  });
});

describe('lifecycle', () => {
  it('HR clears with a reason (who, when, why); no deduction is created', async () => {
    const id = holdId(ids.PA, 'ZH2', 'absent');
    const net = Number(one(`SELECT net FROM payslips WHERE period_id = ${ids.PA} AND employee_id = ${ids.H2}`).net);
    expect((await c.payroll!.post(`/api/payroll/attendance-holds/${id}/clear`, { reason: 'สั้น' })).status).toBe(400);
    expect((await c.payroll!.post(`/api/payroll/attendance-holds/${id}/clear`, {})).status).toBe(400);
    const r = await c.payroll!.post(`/api/payroll/attendance-holds/${id}/clear`, { reason: 'zz ไปพบลูกค้านอกสถานที่ หัวหน้ายืนยันแล้ว' });
    expect(r.status, r.text).toBe(200);
    expect(one(`SELECT status, decision_by, decision_reason FROM payroll_attendance_holds WHERE id = ${id}`)).toEqual({ status: 'cleared', decision_by: ids.payroll, decision_reason: 'zz ไปพบลูกค้านอกสถานที่ หัวหน้ายืนยันแล้ว' });
    expect((await c.payroll!.post(`/api/payroll/attendance-holds/${id}/clear`, { reason: 'zz ซ้ำอีกครั้ง' })).status).toBe(409);
    expect(events(ids.PA, 'ZH2')).toEqual(['opened', 'cleared']);
    expect(JSON.parse(String(one(`SELECT details FROM audit_logs WHERE action = 'payroll.attendance_hold_cleared' AND entity_id = '${id}'`).details))).toMatchObject({ kind: 'absent', work_date: '2026-10-07', reason: 'zz ไปพบลูกค้านอกสถานที่ หัวหน้ายืนยันแล้ว' });
    // the payslip is untouched by the decision
    expect(Number(one(`SELECT net FROM payslips WHERE period_id = ${ids.PA} AND employee_id = ${ids.H2}`).net)).toBe(net);
  });

  it('a scan with unchanged data keeps the cleared hold cleared', async () => {
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.PA}/attendance-holds/scan`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ opened: 0, reopened: 0, resolved: 0, open: 2, cleared: 1 });
    expect(events(ids.PA, 'ZH2')).toEqual(['opened', 'cleared']);
  });

  it('a changed source reopens a cleared hold (a rejected leave now covers the day)', async () => {
    H.sql(`INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status) SELECT ${ids.H2}, id, '2026-10-07', '2026-10-07', 1, 'zz', 'rejected' FROM leave_types ORDER BY id LIMIT 1;`);
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.PA}/attendance-holds/scan`);
    expect(r.body).toMatchObject({ reopened: 1, open: 3, cleared: 0 });
    expect(holds(ids.PA)).toContain('ZH2:absent:2026-10-07:open');
    expect(one(`SELECT decision_by FROM payroll_attendance_holds WHERE id = ${holdId(ids.PA, 'ZH2', 'absent')}`).decision_by).toBeNull();
    expect(events(ids.PA, 'ZH2')).toEqual(['opened', 'cleared', 'reopened']);
    expect((await c.payroll!.post(`/api/payroll/attendance-holds/${holdId(ids.PA, 'ZH2', 'absent')}/clear`, { reason: 'zz ใบลาถูกปฏิเสธ HR ยืนยันไม่หักเงิน' })).status).toBe(200);
  });

  it('corrected source data resolves the hold (the pending leave is approved)', async () => {
    H.sql(`UPDATE leave_requests SET status = 'approved' WHERE id = ${ids.leave3};`);
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.PA}/attendance-holds/scan`);
    expect(r.body).toMatchObject({ resolved: 1 });
    expect(holds(ids.PA)).toContain('ZH3:pending_leave:2026-10-08:resolved');
    expect(events(ids.PA, 'ZH3')).toEqual(['opened', 'resolved']);
  });

  it('the hold history is append-only and holds are never deleted', () => {
    const [ev] = H.sql('SELECT id FROM payroll_attendance_hold_events ORDER BY id LIMIT 1') as Array<{ id: number }>;
    expect(() => H.sql(`UPDATE payroll_attendance_hold_events SET reason = 'x' WHERE id = ${ev!.id}`)).toThrow();
    expect(() => H.sql(`DELETE FROM payroll_attendance_hold_events WHERE id = ${ev!.id}`)).toThrow();
    expect(() => H.sql(`DELETE FROM payroll_attendance_holds WHERE period_id = ${ids.PA}`)).toThrow();
  });
});

describe('approval after review', () => {
  it('a hold resolved after the calculation requires a recalculation; then approval and the ACC gate proceed', async () => {
    expect((await c.payroll!.post(`/api/payroll/attendance-holds/${holdId(ids.PA, 'ZH4', 'missing_attendance')}/clear`, { reason: 'zz พนักงานทำงานนอกสถานที่ทั้งเดือน (ไม่มีเครื่องสแกน)' })).status).toBe(200);
    const a = await c.admin!.post(`/api/payroll/periods/${ids.PA}/approve`);
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe('attendance_changed_recalculate');
    const v = Number(one(`SELECT calc_version FROM payroll_periods WHERE id = ${ids.PA}`).calc_version);
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.PA}/calculate`)).status).toBe(200);
    expect(Number(one(`SELECT calc_version FROM payroll_periods WHERE id = ${ids.PA}`).calc_version)).toBe(v + 1);
    const ok = await c.admin!.post(`/api/payroll/periods/${ids.PA}/approve`);
    expect(ok.status, ok.text).toBe(200);
    expect(ok.body.status).toBe('approved');
    // an approved period's holds cannot be changed any more
    expect((await c.payroll!.post(`/api/payroll/attendance-holds/${holdId(ids.PA, 'ZH2', 'absent')}/clear`, { reason: 'zz หลังอนุมัติ' })).status).toBe(409);
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.PA}/attendance-holds/scan`)).status).toBe(409);
    // PR #24 regression: publishing still needs the ACC sign-off of this version
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.PA}/publish`)).status).toBe(409);
    seedAccountingSignOff(H, ids.PA);
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.PA}/publish`)).status).toBe(200);
  });
});

describe('calculation version', () => {
  it('approval racing a recalculation: never both succeed; an approved period is never older than its calculation', async () => {
    // August (before the review date: no holds) so only the version guards decide
    const id = await period('ZH-2026-08', ids.A, '2026-08-01', '2026-08-31');
    for (let round = 0; round < 3; round++) {
      if (one(`SELECT status FROM payroll_periods WHERE id = ${id}`).status === 'approved') break;
      expect((await c.payroll!.post(`/api/payroll/periods/${id}/calculate`)).status).toBe(200);
      const [approve, recalc] = await Promise.all([c.admin!.post(`/api/payroll/periods/${id}/approve`), c.payroll!.post(`/api/payroll/periods/${id}/calculate`)]);
      expect([approve.status, recalc.status].sort()).not.toEqual([200, 200]);
      expect([200, 409]).toContain(approve.status);
      expect([200, 409]).toContain(recalc.status);
      const p = one(`SELECT status, calc_version, calculated_at, approved_at FROM payroll_periods WHERE id = ${id}`);
      if (p.status === 'approved') expect(String(p.approved_at) >= String(p.calculated_at)).toBe(true);
      // every payslip belongs to the current version
      expect(H.sql(`SELECT DISTINCT calc_version FROM payslips WHERE period_id = ${id}`).map((x) => Number(x.calc_version))).toEqual([Number(p.calc_version)]);
    }
  });
});

describe('company scope and permissions', () => {
  beforeAll(async () => {
    ids.PB = await period('ZH-B-2026-10', ids.B, '2026-10-01', '2026-10-31');
    expect((await c.admin!.post(`/api/payroll/periods/${ids.PB}/calculate`)).status).toBe(200);
  });

  it('a company-limited user sees and clears only its company: another company answers 404', async () => {
    expect((await c.scopedB!.get(`/api/payroll/periods/${ids.PA}/attendance-holds`)).status).toBe(404);
    expect((await c.scopedB!.post(`/api/payroll/periods/${ids.PA}/attendance-holds/scan`)).status).toBe(404);
    const a2 = holdId(ids.PA, 'ZH2', 'absent');
    expect((await c.scopedB!.post(`/api/payroll/attendance-holds/${a2}/clear`, { reason: 'zz ข้ามบริษัท' })).status).toBe(404);
    const mine = await c.scopedB!.get(`/api/payroll/periods/${ids.PB}/attendance-holds`);
    expect(mine.status).toBe(200);
    expect(mine.body.holds.map((h: { emp_code: string; kind: string; work_date: string }) => `${h.emp_code}:${h.kind}:${h.work_date}`)).toEqual(['ZH5:absent:2026-10-09']);
    const listed = (await c.scopedB!.get('/api/payroll/periods')).body.find((p: { id: number }) => p.id === ids.PB);
    expect(listed.open_holds).toBe(1);
  });

  it('without payroll permissions: 403 everywhere, nothing written', async () => {
    const n = Number(one('SELECT COUNT(*) AS n FROM payroll_attendance_hold_events').n);
    const id = holdId(ids.PB, 'ZH5', 'absent');
    expect((await c.staff!.get(`/api/payroll/periods/${ids.PB}/attendance-holds`)).status).toBe(403);
    expect((await c.staff!.post(`/api/payroll/periods/${ids.PB}/attendance-holds/scan`)).status).toBe(403);
    expect((await c.staff!.post(`/api/payroll/attendance-holds/${id}/clear`, { reason: 'zz ไม่มีสิทธิ์' })).status).toBe(403);
    expect(Number(one('SELECT COUNT(*) AS n FROM payroll_attendance_hold_events').n)).toBe(n);
    expect(one(`SELECT status FROM payroll_attendance_holds WHERE id = ${id}`).status).toBe('open');
  });

  it('concurrent scans never open, resolve or record a change twice', async () => {
    // a new absence for ZH5 on Mon 12 Oct and the old one corrected: one opened + one resolved, recorded once
    H.sql(`DELETE FROM attendance_records WHERE employee_id = ${ids.H5} AND work_date = '2026-10-12'; INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source) VALUES (${ids.H5}, '2026-10-09', '09:00', '18:00', 'present', 'manual');`);
    const rs = await Promise.all([1, 2, 3].map(() => c.admin!.post(`/api/payroll/periods/${ids.PB}/attendance-holds/scan`)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(holds(ids.PB)).toEqual(['ZH5:absent:2026-10-09:resolved', 'ZH5:absent:2026-10-12:open']);
    expect(H.sql(`SELECT h.work_date AS d, ev.action FROM payroll_attendance_hold_events ev JOIN payroll_attendance_holds h ON h.id = ev.hold_id WHERE ev.period_id = ${ids.PB} ORDER BY ev.id`)).toEqual([
      { d: '2026-10-09', action: 'opened' },
      { d: '2026-10-09', action: 'resolved' },
      { d: '2026-10-12', action: 'opened' },
    ]);
  });
});
