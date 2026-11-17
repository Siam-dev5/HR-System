// HR attendance review before Calculate (migration 0025) and the payroll policy of 2026-11-16 — isolated local D1,
// synthetic data only (companies ZRA / ZRB, employees ZR1–ZR4, ZR9). Round 26 Oct – 10 Nov 2026 (Mon 26 Oct … Tue
// 10 Nov; rest Sat/Sun). Covers: the migration (table, append-only triggers, grants), Calculate refused before a
// confirmation, the review figures (expected / actual days, unpaid leave, absence, anomalies), confirmation (stale
// version, invalid records, superseding, audit), Calculate after it (16-day entitlement, deductions from attendance, no
// SSO / tax / EWF, review ids on the payslips), attendance changed after the confirmation (invalidated, Calculate and
// approval refused), company scope, permissions, and the month-end round behind the same gate.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const ids = {} as Record<'A' | 'B' | 'R1' | 'R2' | 'R3' | 'R4' | 'R9' | 'mid' | 'month' | 'all' | 'absentRec' | 'r1Rec', number>;
const WRANGLER = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const PASSWORD = 'Zz-Review-Pass-2026!';
const one = (sql: string) => H.sql(sql)[0] as Record<string, any>;
const slip = (period: number, emp: number) => one(`SELECT net, gross, sso, tax, ewf_employee, unpaid_leave, lines_json, calc_json FROM payslips WHERE period_id = ${period} AND employee_id = ${emp}`);
const reviews = (period: number) => H.sql(`SELECT id, company_id, status, ended_reason FROM payroll_attendance_reviews WHERE period_id = ${period} ORDER BY id`);
const lastAudit = (action: string) => one(`SELECT entity_id, details FROM audit_logs WHERE action = '${action}' ORDER BY id DESC LIMIT 1`);

const days = (from: string, to: string) => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};
const weekdays = (from: string, to: string) => days(from, to).filter((d) => ![0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()));
const ROUND = weekdays('2026-10-26', '2026-11-10'); // 12 weekdays
const attend = (emp: number, list: string[]) => H.sql(`INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source, worked_minutes) VALUES ${list.map((d) => `(${emp}, '${d}', '09:00', '18:00', 'present', 'import', 480)`).join(', ')};`);

beforeAll(async () => {
  H = await startHarness();
  H.sql(`INSERT INTO companies (code, name, active) VALUES ('ZRA', 'ZZ Review A', 1), ('ZRB', 'ZZ Review B', 1);`);
  ids.A = Number(one("SELECT id FROM companies WHERE code = 'ZRA'").id);
  ids.B = Number(one("SELECT id FROM companies WHERE code = 'ZRB'").id);
  const emp = (code: string, co: number, hire: string, salary: number) => `('${code}', 'Zz', '${code}', ${co}, '${hire}', 'probation', 'probation', ${salary})`;
  H.sql(`INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status, base_salary) VALUES
    ${emp('ZR1', ids.A, '2026-08-03', 23000)}, ${emp('ZR2', ids.A, '2026-08-06', 18000)}, ${emp('ZR3', ids.A, '2026-09-01', 20000)},
    ${emp('ZR4', ids.A, '2026-10-28', 30000)}, ${emp('ZR9', ids.B, '2026-09-01', 15000)};`);
  for (const k of ['R1', 'R2', 'R3', 'R4', 'R9'] as const) ids[k] = Number(one(`SELECT id FROM employees WHERE emp_code = 'Z${k}'`).id);
  // ZR1 every weekday (and Saturday 31 Oct): 13 days worked, salary entitlement stays 16 days
  attend(ids.R1, [...ROUND, '2026-10-31']);
  ids.r1Rec = Number(one(`SELECT id FROM attendance_records WHERE employee_id = ${ids.R1} AND work_date = '2026-11-09'`).id);
  // ZR2: approved unpaid leave Fri 30 Oct (deducted) and Sat 31 Oct (rest day: not deducted)
  attend(ids.R2, ROUND.filter((d) => d !== '2026-10-30'));
  H.sql(`INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status)
    SELECT ${ids.R2}, id, '2026-10-30', '2026-10-30', 1, 'zz unpaid', 'approved' FROM leave_types WHERE code = 'UNPAID';
    INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status)
    SELECT ${ids.R2}, id, '2026-10-31', '2026-10-31', 1, 'zz unpaid saturday', 'approved' FROM leave_types WHERE code = 'UNPAID';`);
  // ZR3: missing clock-out Mon 26 Oct (HR review, never deducted), absence record Wed 4 Nov (deducted once
  // confirmed), approved paid annual leave Thu 5 Nov (not deducted), present otherwise
  attend(ids.R3, ROUND.filter((d) => !['2026-10-26', '2026-11-04', '2026-11-05'].includes(d)));
  H.sql(`INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source) VALUES (${ids.R3}, '2026-10-26', '08:42', NULL, 'present', 'import'), (${ids.R3}, '2026-11-04', NULL, NULL, 'absent', 'import');
    INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, days, reason, status)
    SELECT ${ids.R3}, id, '2026-11-05', '2026-11-05', 1, 'zz annual', 'approved' FROM leave_types WHERE code = 'ANNUAL';`);
  ids.absentRec = Number(one(`SELECT id FROM attendance_records WHERE employee_id = ${ids.R3} AND work_date = '2026-11-04'`).id);
  // ZR4 joins 28 Oct (after the 26th) and has no attendance at all: never inferred as absence
  attend(ids.R9, ROUND);

  c.admin = new Client(H.baseUrl);
  await c.admin.login('it_admin', H.passwords.it_admin);
  c.payroll = new Client(H.baseUrl);
  await c.payroll.login('it_payroll', H.passwords.it_payroll);
  c.staff = new Client(H.baseUrl);
  await c.staff.login('it_staff', H.passwords.it_staff);
  for (const k of ['admin', 'payroll', 'staff']) c[k]!.autoReview = false;
  // a company-limited payroll user of company B
  H.sql(`INSERT INTO roles (code, name, description, privileged, system) VALUES ('zz_rev_b', 'ZZ review B', 'test', 0, 0);
    INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.value FROM roles r, json_each('["payroll.view","payroll.calculate","payroll_preview.view","payroll_attendance.confirm"]') p WHERE r.code = 'zz_rev_b';`);
  const out = join(H.dir, 'zz_rev_b.sql');
  execFileSync(process.execPath, ['scripts/create-user.mjs', '--username', 'zz_rev_b', '--display', 'zz_rev_b', '--role', 'zz_rev_b', '--employee', 'ZR9', '--out', out, '--cred-file', join(H.dir, 'review-cred.txt')], { env: { ...process.env, NEW_USER_PASSWORD: PASSWORD }, stdio: 'ignore' });
  execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', join(H.dir, 'state'), '--file', out], { env: { ...process.env, CI: '1' }, stdio: 'ignore' });
  c.scopedB = new Client(H.baseUrl);
  expect((await c.scopedB.login('zz_rev_b', PASSWORD)).status).toBe(200);
  c.scopedB.autoReview = false;

  const mk = async (b: Record<string, unknown>) => {
    const r = await c.admin!.post('/api/payroll/periods', b);
    expect(r.status, r.text).toBe(201);
    return r.body.id as number;
  };
  ids.mid = await mk({ code: 'ZR-2026-11-M', name: 'zz mid', kind: 'mid_month', company_id: ids.A, start_date: '2026-10-26', end_date: '2026-11-10', pay_date: '2026-11-15' });
  ids.month = await mk({ code: 'ZR-2026-11', name: 'zz month', kind: 'monthly', company_id: ids.A, start_date: '2026-10-26', end_date: '2026-11-25', pay_date: '2026-11-30' });
}, 300_000);
afterAll(async () => {
  await H?.stop();
});

describe('migration 0025', () => {
  it('creates the append-only review table and grants payroll_attendance.confirm to payroll_officer and hr_payroll only', () => {
    expect(H.sql("SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission = 'payroll_attendance.confirm' AND r.code NOT LIKE 'zz%' ORDER BY 1").map((x) => x.code)).toEqual(['hr_payroll', 'payroll_officer']);
    expect(H.sql("SELECT name FROM sqlite_master WHERE name LIKE '%payroll_attendance_reviews%' ORDER BY name").map((x) => x.name)).toEqual([
      'idx_payroll_attendance_reviews_period', 'payroll_attendance_reviews', 'trg_payroll_attendance_reviews_end_only', 'trg_payroll_attendance_reviews_nodelete', 'uq_payroll_attendance_reviews_confirmed',
    ]);
  });
});

describe('Calculate is refused before HR confirms the attendance', () => {
  it('mid-month round: 409 attendance_review_required, nothing written', async () => {
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.mid}/calculate`);
    expect(r.status, r.text).toBe(409);
    expect(r.body.error.code).toBe('attendance_review_required');
    expect(r.body.error.message).toContain('ZZ Review A');
    expect(one(`SELECT COUNT(*) AS n FROM payslips WHERE period_id = ${ids.mid}`).n).toBe(0);
    expect(one(`SELECT status, calc_version FROM payroll_periods WHERE id = ${ids.mid}`)).toEqual({ status: 'draft', calc_version: 0 });
  });
});

describe('the review shows what HR must verify', () => {
  it('per employee: entitlement, expected and actual days, hours, unpaid leave, absence, payable days, anomalies', async () => {
    const r = await c.payroll!.get(`/api/payroll/periods/${ids.mid}/attendance-review`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.canConfirm).toBe(true);
    expect(r.body.companies).toEqual([expect.objectContaining({ company_id: ids.A, company: 'ZZ Review A', status: 'pending', employees: 4, review: null })]);
    const e = Object.fromEntries((r.body.employees as Array<Record<string, any>>).map((x) => [x.emp_code, x]));
    expect(e.ZR1).toMatchObject({ entitlementDays: 16, calendarEntitled: true, expectedWorkDays: 12, actualWorkDays: 13, actualWorkHours: 104, unpaidLeaveDays: 0, absenceDays: 0, payableDays: 16 });
    expect(e.ZR2).toMatchObject({ entitlementDays: 16, unpaidLeaveDays: 1, absenceDays: 0, payableDays: 15, deductions: [{ date: '2026-10-30', kind: 'unpaid_leave', days: 1 }] });
    expect(e.ZR3).toMatchObject({ entitlementDays: 16, unpaidLeaveDays: 0, absenceDays: 1, payableDays: 15, paidLeaveDays: 1, pendingReviewRecords: 1, unverifiedDays: 1 });
    expect(e.ZR3.deductions).toEqual([{ date: '2026-11-04', kind: 'absence', days: 1, record: ids.absentRec }]);
    expect(e.ZR4).toMatchObject({ entitlementDays: 14, calendarEntitled: false, actualWorkDays: 0, absenceDays: 0, unpaidLeaveDays: 0, payableDays: 14, missingAttendanceDays: 10 });
    // the missing clock-out is listed for review, never deducted
    expect(r.body.records).toEqual([expect.objectContaining({ employee_id: ids.R3, work_date: '2026-10-26', status: 'pending_review', clock_out: null })]);
  });

  it('company scope: a company-B user cannot see a company-A period; staff without the permission cannot confirm', async () => {
    expect((await c.scopedB!.get(`/api/payroll/periods/${ids.mid}/attendance-review`)).status).toBe(404);
    expect((await c.scopedB!.post(`/api/payroll/periods/${ids.mid}/attendance-review/confirm`, { company_id: ids.A, version: 'x' })).status).toBe(404);
    expect((await c.staff!.post(`/api/payroll/periods/${ids.mid}/attendance-review/confirm`, { company_id: ids.A, version: 'x' })).status).toBe(403);
  });
});

describe('confirmation', () => {
  it('refuses a version that is not the current one (data changed while HR was reviewing)', async () => {
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.mid}/attendance-review/confirm`, { company_id: ids.A, version: 'av1:stale' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('attendance_review_stale');
    expect(reviews(ids.mid)).toEqual([]);
  });

  it('refuses a company that is not in the period', async () => {
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.mid}/attendance-review/confirm`, { company_id: ids.B, version: 'x' });
    expect(r.status).toBe(404);
  });

  it('records reviewer, time, company, period and attendance version; audit trail', async () => {
    const v = (await c.payroll!.get(`/api/payroll/periods/${ids.mid}/attendance-review`)).body.companies[0].version as string;
    expect(v).toMatch(/^av1:[0-9a-f]{64}$/);
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.mid}/attendance-review/confirm`, { company_id: ids.A, version: v, note: 'zz checked against Feishu' });
    expect(r.status, r.text).toBe(200);
    const row = one(`SELECT * FROM payroll_attendance_reviews WHERE id = ${r.body.id}`);
    expect(row).toMatchObject({ period_id: ids.mid, company_id: ids.A, attendance_version: v, judged_through: '2026-11-10', status: 'confirmed', note: 'zz checked against Feishu', confirmed_by: Number(one("SELECT id FROM users WHERE username = 'it_payroll'").id) });
    expect(row.confirmed_at).toMatch(/^\d{4}-\d{2}-\d{2} /);
    expect(JSON.parse(row.summary_json).totals).toMatchObject({ employees: 4, unpaidLeaveDays: 1, absenceDays: 1, pendingReviewRecords: 1 });
    const a = lastAudit('payroll.attendance_review_confirmed');
    expect(Number(a.entity_id)).toBe(r.body.id);
    expect(JSON.parse(a.details)).toMatchObject({ period_id: ids.mid, company_id: ids.A, attendance_version: v, judged_through: '2026-11-10', employees: 4 });
    expect((await c.payroll!.get(`/api/payroll/periods/${ids.mid}/attendance-review`)).body.companies[0]).toMatchObject({ status: 'confirmed', review: { id: r.body.id, confirmed_by: 'it_payroll' } });
  });

  it('a second confirmation supersedes the first (one confirmation in force)', async () => {
    const v = (await c.payroll!.get(`/api/payroll/periods/${ids.mid}/attendance-review`)).body.companies[0].version as string;
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.mid}/attendance-review/confirm`, { company_id: ids.A, version: v });
    expect(r.status, r.text).toBe(200);
    expect(reviews(ids.mid).map((x) => [x.status, x.ended_reason])).toEqual([['superseded', 'superseded'], ['confirmed', null]]);
  });

  it('history is append-only: no delete, no change of what was confirmed', () => {
    expect(() => H.sql(`DELETE FROM payroll_attendance_reviews WHERE period_id = ${ids.mid}`)).toThrow();
    expect(() => H.sql(`UPDATE payroll_attendance_reviews SET attendance_version = 'av1:forged' WHERE period_id = ${ids.mid} AND status = 'confirmed'`)).toThrow();
    expect(() => H.sql(`UPDATE payroll_attendance_reviews SET status = 'confirmed', ended_at = NULL, ended_reason = NULL WHERE period_id = ${ids.mid} AND status = 'superseded'`)).toThrow();
    expect(reviews(ids.mid)).toHaveLength(2);
  });
});

describe('Calculate after the confirmation (policy of 2026-11-16)', () => {
  it('pays the 16-day entitlement, deducts unpaid leave and confirmed absence, no SSO / tax / EWF', async () => {
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.mid}/calculate`);
    expect(r.status, r.text).toBe(200);
    const s1 = slip(ids.mid, ids.R1);
    expect(s1.net).toBe(12266.67); // 23,000 / 30 × 16 — probation ends 31 Oct inside a round starting in ตุลาคม
    const s2 = slip(ids.mid, ids.R2);
    expect([s2.gross, s2.unpaid_leave, s2.net]).toEqual([9000, 600, 9000]); // 18,000 / 30 × (16 − 1)
    expect(JSON.parse(s2.lines_json).filter((l: { kind: string }) => l.kind === 'deduction')).toEqual([{ code: 'UNPAID', name: 'หักลาไม่รับค่าจ้าง', kind: 'deduction', amount: 600 }]);
    const s3 = slip(ids.mid, ids.R3);
    expect([s3.unpaid_leave, s3.net]).toEqual([666.67, 10000]); // 20,000 / 30 × 16 − one confirmed absence
    expect(JSON.parse(s3.lines_json).filter((l: { kind: string }) => l.kind === 'deduction').map((l: { code: string }) => l.code)).toEqual(['ABSENCE']);
    expect(slip(ids.mid, ids.R4).net).toBe(14000); // joined 28 Oct: from the hire date, nothing inferred from missing attendance
    for (const e of [ids.R1, ids.R2, ids.R3, ids.R4]) {
      const s = slip(ids.mid, e);
      expect([s.sso, s.tax, s.ewf_employee]).toEqual([0, 0, 0]);
    }
    const calc = JSON.parse(s3.calc_json);
    expect(calc.attendance).toMatchObject({ unpaidLeaveDays: 0, absenceDays: 1, entitlementDays: 16, payableDays: 15, deductions: [{ date: '2026-11-04', kind: 'absence', record: ids.absentRec }] });
    expect(calc.attendance.review).toEqual([{ id: reviews(ids.mid)[1]!.id, company_id: ids.A, version: expect.stringMatching(/^av1:/) }]);
    expect(JSON.parse(s1.calc_json)).toMatchObject({ calendarEntitled: true, attendance: { workDays: 13, expectedWorkDays: 12 } });
    expect(JSON.parse(lastAudit('payroll.calculated').details).attendanceReviews).toEqual([expect.objectContaining({ id: reviews(ids.mid)[1]!.id, company_id: ids.A })]);
  });
});

describe('attendance changed after the confirmation', () => {
  it('Calculate ends the confirmation (invalidated, audited) and is refused', async () => {
    const fix = await c.admin!.post(`/api/attendance/records/${ids.r1Rec}/correct`, { clock_out: '17:00', reason: 'zz left early', reference: 'zz-ticket-1' });
    expect(fix.status, fix.text).toBe(200);
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.mid}/calculate`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('attendance_review_changed');
    expect(reviews(ids.mid).map((x) => x.status)).toEqual(['superseded', 'invalidated']);
    expect(String(reviews(ids.mid)[1]!.ended_reason)).toMatch(/^attendance_changed: av1:/);
    expect(JSON.parse(lastAudit('payroll.attendance_review_invalidated').details)).toMatchObject({ period_id: ids.mid, company_id: ids.A, reason: 'attendance_changed' });
    // the calculated payslips stay as they were (calc_version unchanged)
    expect(slip(ids.mid, ids.R1).net).toBe(12266.67);
    expect((await c.payroll!.get(`/api/payroll/periods/${ids.mid}/attendance-review`)).body.companies[0].status).toBe('pending');
  });

  it('approval is refused while the payslips rest on an ended confirmation, even after a new confirmation', async () => {
    expect((await c.admin!.post(`/api/payroll/periods/${ids.mid}/approve`)).body.error.code).toBe('attendance_review_changed');
    await c.payroll!.confirmAttendance(ids.mid);
    const r = await c.admin!.post(`/api/payroll/periods/${ids.mid}/approve`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('attendance_review_changed');
  });

  it('after a recalculation from the new confirmation, approval succeeds; actual days never changed the salary', async () => {
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.mid}/calculate`)).status).toBe(200);
    expect(slip(ids.mid, ids.R1).net).toBe(12266.67); // fewer hours worked: same salary
    const r = await c.admin!.post(`/api/payroll/periods/${ids.mid}/approve`);
    expect(r.status, r.text).toBe(200);
  });
});

describe('company scope across companies (all-company period)', () => {
  it('a company-B user sees and confirms only company B; Calculate still needs every company', async () => {
    const p = await c.admin!.post('/api/payroll/periods', { code: 'ZR-ALL-2027-01', name: 'zz all', kind: 'monthly', company_id: null, start_date: '2027-01-01', end_date: '2027-01-31', pay_date: '2027-01-31' });
    expect(p.status, p.text).toBe(201);
    ids.all = p.body.id;
    const b = await c.scopedB!.get(`/api/payroll/periods/${ids.all}/attendance-review`);
    expect(b.status, b.text).toBe(200);
    expect(b.body.companies.map((x: { company_id: number }) => x.company_id)).toEqual([ids.B]);
    expect(new Set(b.body.employees.map((x: { company_id: number }) => x.company_id))).toEqual(new Set([ids.B]));
    expect((await c.scopedB!.post(`/api/payroll/periods/${ids.all}/attendance-review/confirm`, { company_id: ids.A, version: 'x' })).status).toBe(404);
    expect((await c.scopedB!.post(`/api/payroll/periods/${ids.all}/attendance-review/confirm`, { company_id: ids.B, version: b.body.companies[0].version })).status).toBe(200);
    // the B user cannot calculate an all-company period, and the payroll officer is still refused for the other companies
    expect((await c.scopedB!.post(`/api/payroll/periods/${ids.all}/calculate`)).status).toBe(403);
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.all}/calculate`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('attendance_review_required');
    expect(r.body.error.message).not.toContain('ZZ Review B');
    expect(r.body.error.message).toContain('ZZ Review A');
  });
});

describe('month-end round behind the same gate', () => {
  it('refused before the confirmation; afterwards the month keeps SSO / tax and deducts the advance and the unpaid day', async () => {
    const before = await c.payroll!.post(`/api/payroll/periods/${ids.month}/calculate`);
    expect(before.status).toBe(409);
    expect(before.body.error.code).toBe('attendance_review_required');
    await c.payroll!.confirmAttendance(ids.month);
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.month}/calculate`);
    expect(r.status, r.text).toBe(200);
    const s2 = slip(ids.month, ids.R2);
    expect(s2.unpaid_leave).toBe(600); // the same approved unpaid day, once
    expect(s2.sso).toBe(round(Math.min(Math.max(18000 - 600, 1650), 15000) * 0.05));
    const lines = JSON.parse(s2.lines_json) as Array<{ code: string; amount: number }>;
    expect(lines.find((l) => l.code === 'ADV')?.amount).toBe(9000);
    expect(lines.filter((l) => l.code === 'UNPAID')).toHaveLength(1);
  });
});

const round = (n: number) => Math.round(n * 100) / 100;
