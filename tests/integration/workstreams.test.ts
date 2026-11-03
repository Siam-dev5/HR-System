// Feishu attendance import, OT review, probation two-round payroll, payroll preview / layouts / export,
// payslip YTD and organization design — against a fresh local D1 (wrangler dev), all roles.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readXlsx, parseCsv, type Cell } from '../../src/shared/xlsx';
import { PREVIEW_COLUMNS } from '../../src/shared/payroll-columns';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const admin = () => c.admin as Client;
const payroll = () => c.payroll as Client;
const staff = () => c.staff as Client;
const sha = (g: unknown) => createHash('sha256').update(JSON.stringify(g)).digest('hex');
const idOf = (code: string) => Number(H.sql(`SELECT id FROM employees WHERE emp_code = '${code}'`)[0]?.id);

beforeAll(async () => {
  H = await startHarness();
  for (const k of ['admin', 'payroll', 'manager', 'employee', 'staff']) c[k] = new Client(H.baseUrl);
  await c.admin!.login('it_admin', H.passwords.it_admin);
  await c.payroll!.login('it_payroll', H.passwords.it_payroll);
  await c.manager!.login('it_manager', H.passwords.it_manager);
  await c.employee!.login('it_employee', H.passwords.it_employee);
  await c.staff!.login('it_staff', H.passwords.it_staff);
});
afterAll(async () => {
  await H?.stop();
});

const ids: Record<string, number> = {};
const periods = {} as Record<string, number> & { y2025: number; oct: number; nov: number; mid: number; dec: number };
const BAND: Cell[] = ['Name', 'Basic information', '', '', '', 'Attendance metrics', '', '', '', '', '', '', ''];
const HEAD_A: Cell[] = ['Name', 'Employee ID', 'Department', 'Employment date', 'Expected working days', 'Expected working hours(hr)', 'Workday attendance', 'Actual working hours(hr)', 'Absence days', 'Absence hours(hr)', 'Total overtime duration(hr)', 'Personal leave（Unpaid）(hr)', 'Unpaid Sick Leave(hr)'];
const row = (code: string, x: Partial<{ dept: string; hire: string; ot: string; unpaid: string }> = {}): Cell[] =>
  ['T', code, x.dept ?? '-', x.hire ?? '-', '22', '176.0', '22', '176.0', '0', '0', x.ot ?? '0', x.unpaid ?? '0', '-'];
const GRID_A: Cell[][] = [BAND, HEAD_A,
  row('E007', { ot: '4', unpaid: '8', dept: 'แผนกผลิต', hire: '2023-02-01' }), row('E006'), row('E009'), row('E001'), row('E001'), row('ZZ999'), row('ZB1'), row('E005', { hire: '2026-13-45' })];
const FILE_A = 'For Payroll System_20261026_20261125.xlsx';

describe('setup: companies, employees, salary history, periods', () => {
  it('creates a second company, joiner / leaver / probation employees and a transferred record', async () => {
    ids.zzb = (await admin().post('/api/m/companies', { code: 'ZZB', name: 'บริษัท บี ทดสอบ จำกัด', active: true })).body.id;
    const emp = async (code: string, x: Record<string, unknown>) => {
      const r = await admin().post('/api/m/employees', { emp_code: code, first_name: 'ทดสอบ', last_name: code, company_id: 1, employment_type: 'permanent', status: 'active', ...x });
      expect(r.status, r.text).toBe(201);
      return r.body.id as number;
    };
    ids.e009 = await emp('E009', { hire_date: '2026-08-05', employment_type: 'probation', status: 'probation', base_salary: 30000, department_id: 5, position_id: 6, manager_id: 5 });
    ids.e010 = await emp('E010', { hire_date: '2026-11-11', employment_type: 'probation', status: 'probation', base_salary: 30000 });
    ids.e011 = await emp('E011', { hire_date: '2020-01-01', status: 'resigned', termination_date: '2026-11-04', base_salary: 30000 });
    ids.e007 = idOf('E007');
    ids.e007b = await emp('E007B', { company_id: ids.zzb, hire_date: '2023-02-01', base_salary: 20000, person_id: ids.e007 });
    ids.zb1 = await emp('ZB1', { company_id: ids.zzb, hire_date: '2020-01-01', base_salary: 10000 });
    ids.e099 = await emp('E099', { company_id: ids.zzb, first_name: 'ธนา', last_name: 'ทดสอบ', hire_date: '2023-02-01', base_salary: 16500 }); // same name as E007, different person
    // approved salary history: new rate from day 91
    expect((await payroll().post('/api/m/salary_history', { employee_id: ids.e009, effective_date: '2026-08-05', base_salary: 30000, reason: 'เริ่มงาน' })).status).toBe(201);
    expect((await payroll().post('/api/m/salary_history', { employee_id: ids.e009, effective_date: '2026-11-03', base_salary: 35000, reason: 'ผ่านทดลองงาน (อนุมัติ)' })).status).toBe(201);
    expect((await staff().get('/api/m/salary_history')).status).toBe(403);
    expect((await c.employee!.get('/api/m/salary_history')).status).toBe(403);
  });

  it('periods: kinds, mid-month pay-date rule and overlap guards', async () => {
    const mk = async (body: Record<string, unknown>) => payroll().post('/api/payroll/periods', body);
    periods.y2025 = (await mk({ code: '2025-12', name: 'ธ.ค. 68', start_date: '2025-11-26', end_date: '2025-12-25', pay_date: '2025-12-25' })).body.id;
    periods.oct = (await mk({ code: '2026-10', name: 'ต.ค. 69', start_date: '2026-09-26', end_date: '2026-10-25', pay_date: '2026-10-25' })).body.id;
    const nov = await mk({ code: '2026-11', name: 'พ.ย. 69', kind: 'monthly', start_date: '2026-10-26', end_date: '2026-11-25', pay_date: '2026-11-25' });
    expect(nov.status).toBe(201);
    expect(nov.body.kind).toBe('monthly');
    periods.nov = nov.body.id;
    expect((await mk({ code: 'X1', name: 'x', kind: 'mid_month', start_date: '2026-10-26', end_date: '2026-11-10', pay_date: '2026-11-20' })).status).toBe(400); // pay after the 15th
    const mid = await mk({ code: '2026-11-M', name: 'กลางเดือน พ.ย.', kind: 'mid_month', start_date: '2026-10-26', end_date: '2026-11-10', pay_date: '2026-11-15' });
    expect(mid.status).toBe(201);
    periods.mid = mid.body.id;
    expect((await mk({ code: 'X2', name: 'x', kind: 'mid_month', start_date: '2026-11-01', end_date: '2026-11-12', pay_date: '2026-11-15' })).status).toBe(409);
    expect((await mk({ code: 'X3', name: 'x', kind: 'monthly', start_date: '2026-11-20', end_date: '2026-12-20', pay_date: '2026-12-20' })).status).toBe(409);
    expect((await mk({ code: 'X4', name: 'x', kind: 'weekly', start_date: '2027-01-01', end_date: '2027-01-07', pay_date: '2027-01-07' })).status).toBe(400);
  });

  it('publishes a previous-year and a previous-month payroll (YTD history)', async () => {
    for (const p of [periods.y2025, periods.oct]) {
      expect((await payroll().post(`/api/payroll/periods/${p}/calculate`)).status).toBe(200);
      expect((await admin().post(`/api/payroll/periods/${p}/approve`)).status).toBe(200);
      expect((await admin().post(`/api/payroll/periods/${p}/publish`)).status).toBe(200);
    }
  });
});

describe('Feishu attendance import', () => {
  const body = (grid: Cell[][], extra: Record<string, unknown> = {}) => ({ company_id: 1, period_id: periods.nov, file_name: FILE_A, sha256: sha(grid), grid, ...extra });

  it('only roles with attendance_import permissions can import; payroll periods list is readable by HR Staff', async () => {
    expect((await staff().get('/api/attendance/periods')).status).toBe(200);
    expect((await c.manager!.post('/api/attendance/imports/analyze', body(GRID_A))).status).toBe(403);
    expect((await c.employee!.post('/api/attendance/imports/analyze', body(GRID_A))).status).toBe(403);
    expect((await c.employee!.get('/api/attendance/imports')).status).toBe(403);
    expect((await staff().post('/api/attendance/imports/analyze', body(GRID_A, { company_id: 999 }))).status).toBe(403);
  });

  it('Format A: detects format, validates every row and reconciles against the company', async () => {
    const a = (await staff().post('/api/attendance/imports/analyze', body(GRID_A))).body;
    expect(a.format).toBe('days');
    expect([a.sourceStart, a.sourceEnd]).toEqual(['2026-10-26', '2026-11-25']);
    expect(a.stats).toMatchObject({ total: 8, unknown: 1, wrongCompany: 1, duplicates: 1, invalidDates: 1, otPending: 1, errors: 4, importable: 4 });
    const byCode = (code: string) => a.rows.filter((r: { employee_code: string }) => r.employee_code === code);
    expect(byCode('E007')[0].issues.map((i: { code: string }) => i.code)).toEqual(['ot_pending']); // department text matches, hire date matches
    expect(byCode('ZB1')[0].issues.map((i: { code: string }) => i.code)).toEqual(['wrong_company']);
    expect(byCode('E001')[1].included).toBe(false);
    expect(a.reconciliation.missingInFile.map((m: { emp_code: string }) => m.emp_code)).toEqual(expect.arrayContaining(['E002', 'E010']));
    expect(a.reconciliation.totals.feishu_overtime_hours).toBe(4);
    expect(a.canImport).toBe(true);
    expect(a.nextVersion).toBe(1);
  });

  it('errors block the import unless HR explicitly imports only the valid rows', async () => {
    expect((await staff().post('/api/attendance/imports', body(GRID_A))).status).toBe(409);
    const r = await staff().post('/api/attendance/imports', body(GRID_A, { skip_invalid: true }));
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ version: 1, imported: 4, excluded: 4, otPending: 1 });
    ids.importV1 = r.body.id;
    const raw = H.sql(`SELECT raw_json, included, ot_status FROM attendance_import_rows WHERE import_id = ${ids.importV1} AND employee_code = 'E007'`)[0];
    expect(JSON.parse(String(raw?.raw_json))[1]).toBe('E007'); // original cells kept
    expect(raw?.ot_status).toBe('pending');
  });

  it('the same file cannot be imported twice into the same period', async () => {
    const a = (await staff().post('/api/attendance/imports/analyze', body(GRID_A))).body;
    expect(a.duplicateFile.version).toBe(1);
    expect(a.canImport).toBe(false);
    expect((await staff().post('/api/attendance/imports', body(GRID_A, { skip_invalid: true }))).status).toBe(409);
  });

  it('Format B re-import creates version 2; rollback restores version 1', async () => {
    const grid: Cell[][] = [['Employee ID', 'Name', 'Expected working hours(hr)', 'Actual working hours(hr)', 'Total overtime duration(hr)'], ['E007', 'x', '176', '170', '6'], ['E006', 'y', '176', '176', '0']];
    const a = (await staff().post('/api/attendance/imports/analyze', { ...body(grid), file_name: 'For Payroll System+A_20261103_20261103.csv' })).body;
    expect(a.format).toBe('hours');
    expect(a.reconciliation.previous.version).toBe(1);
    const r = await staff().post('/api/attendance/imports', { ...body(grid), file_name: 'For Payroll System+A_20261103_20261103.csv' });
    expect(r.body.version).toBe(2);
    const list = (await staff().get('/api/attendance/imports?company=1')).body;
    expect(list.find((i: { version: number }) => i.version === 1).status).toBe('superseded');
    expect((await staff().post(`/api/attendance/imports/${r.body.id}/rollback`, {})).status).toBe(400); // reason required
    const rb = await staff().post(`/api/attendance/imports/${r.body.id}/rollback`, { reason: 'ทดสอบย้อนกลับ' });
    expect(rb.body.restoredVersion).toBe(1);
    const after = (await staff().get('/api/attendance/imports?company=1')).body;
    expect(after.find((i: { version: number }) => i.version === 1).status).toBe('active');
    expect(after.find((i: { version: number }) => i.version === 2).status).toBe('rolled_back');
  });

  it('an invalid header is rejected with a clear file-level error', async () => {
    const grid: Cell[][] = [['foo', 'bar'], ['1', '2']];
    const a = (await staff().post('/api/attendance/imports/analyze', body(grid))).body;
    expect(a.fileIssues.map((i: { code: string }) => i.code)).toContain('no_header');
    expect(a.canImport).toBe(false);
    expect((await staff().post('/api/attendance/imports', body(grid, { skip_invalid: true }))).status).toBe(409);
  });

  it('mapping profiles are stored by header label', async () => {
    const r = await staff().post('/api/attendance/profiles', { name: 'Feishu For Payroll System', company_id: 1, mapping: { employee_code: 'Employee ID', expected_work_days: 'Expected working days' } });
    expect(r.status).toBe(201);
    expect((await staff().post('/api/attendance/profiles', { name: 'bad', mapping: { password: 'x' } })).status).toBe(400);
    const a = (await staff().post('/api/attendance/imports/analyze', body(GRID_A, { profile_id: r.body.id }))).body;
    expect(a.mapping.expected_work_days).toBe(4);
  });
});

describe('OT review (Feishu → Pending → HR review → Confirmed → payroll eligible)', () => {
  let rowId = 0;
  it('lists pending OT; managers may view but not decide', async () => {
    const list = (await c.manager!.get(`/api/attendance/ot?period_id=${periods.nov}&status=pending`)).body;
    expect(list).toHaveLength(1);
    rowId = list[0].id;
    expect(list[0]).toMatchObject({ employee_code: 'E007', feishu_overtime_hours: 4, ot_status: 'pending' });
    expect((await c.manager!.post(`/api/attendance/ot/${rowId}`, { action: 'confirm' })).status).toBe(403);
    expect((await c.employee!.get('/api/attendance/ot')).status).toBe(403);
  });

  it('revise needs hours and a reason; the Feishu value stays as the original; every change is audited', async () => {
    expect((await staff().post(`/api/attendance/ot/${rowId}`, { action: 'revise', hours: 3 })).status).toBe(400);
    expect((await staff().post(`/api/attendance/ot/${rowId}`, { action: 'reject' })).status).toBe(400);
    expect((await staff().post(`/api/attendance/ot/${rowId}`, { action: 'confirm', rate: 7 })).status).toBe(400);
    const r = await staff().post(`/api/attendance/ot/${rowId}`, { action: 'revise', hours: 3, rate: 1.5, reason: 'หักเวลาพักตามระเบียบ' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ot_status: 'revised', ot_confirmed_hours: 3, feishu_overtime_hours: 4, ot_rate: 1.5 });
    expect(r.body.reviewer).toBe('it_staff');
    const log = H.sql("SELECT details FROM audit_logs WHERE action = 'attendance.ot_revised' ORDER BY id DESC LIMIT 1")[0];
    expect(JSON.parse(String(log?.details))).toMatchObject({ original: 4, after: { status: 'revised', hours: 3 } });
  });
});

describe('probation payroll: mid-month advance and month-end', () => {
  const slips = async (p: number) => (await payroll().get(`/api/payroll/payslips?period_id=${p}`)).body as Array<{ id: number; employee: string; net: number; gross: number }>;
  const slip = async (p: number, code: string) => {
    const s = (await slips(p)).find((x) => x.employee.startsWith(`${code} `));
    return s ? (await payroll().get(`/api/payslips/${s.id}`)).body : null;
  };

  it('mid-month round pays employees on probation only, base / 30 × eligible days, no statutory deductions', async () => {
    expect((await payroll().post(`/api/payroll/periods/${periods.mid}/calculate`)).body.employees).toBe(2);
    const e6 = await slip(periods.mid, 'E006'); // probation until 2026-11-29: 16 days
    expect(e6.gross).toBe(7466.67);
    expect([e6.sso, e6.tax, e6.net]).toEqual([0, 0, 7466.67]);
    const e9 = await slip(periods.mid, 'E009'); // day 90 = 2026-11-02: 8 days
    expect(e9.net).toBe(8000);
    expect(e9.calc.segments).toHaveLength(1);
    expect(await slip(periods.mid, 'E010')).toBeNull(); // hired after the round
    expect(await slip(periods.mid, 'E001')).toBeNull(); // passed probation long ago
  });

  it('month-end cannot be calculated while the mid-month round is unapproved (double payment guard)', async () => {
    const r = await payroll().post(`/api/payroll/periods/${periods.nov}/calculate`);
    expect(r.status).toBe(409);
    expect((await admin().post(`/api/payroll/periods/${periods.mid}/approve`)).status).toBe(200);
  });

  it('month-end: full month, probation split, joiner / leaver proration, advance deducted once', async () => {
    const r = await payroll().post(`/api/payroll/periods/${periods.nov}/calculate`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.calc_version).toBe(1);
    const e6 = await slip(periods.nov, 'E006');
    expect(e6.lines.find((l: { code: string }) => l.code === 'BASE').amount).toBe(14000);
    expect(e6.advance).toBe(7466.67);
    expect(e6.lines.find((l: { code: string }) => l.code === 'ADV').amount).toBe(7466.67);
    expect(e6.net).toBe(Math.round((e6.gross - e6.deductions) * 100) / 100);

    const e9 = await slip(periods.nov, 'E009'); // 8 days @30,000 + 22 paid days @35,000 (approved rate from day 91)
    expect(e9.calc.probationStatus).toBe('passed_in_period');
    expect(e9.calc.segments.map((s: { status: string; days: number; paidDays: number; rate: number; amount: number }) => [s.status, s.days, s.paidDays, s.rate, s.amount])).toEqual([
      ['probation', 8, 8, 30000, 8000],
      ['passed', 23, 22, 35000, 25666.67],
    ]);
    expect(e9.lines.filter((l: { code: string }) => l.code.startsWith('BASE_')).map((l: { code: string }) => l.code)).toEqual(['BASE_PROB', 'BASE_PASS']);
    expect(e9.base_salary).toBe(33666.67);
    expect(e9.advance).toBe(8000);

    expect((await slip(periods.nov, 'E010')).base_salary).toBe(15000); // joiner 11-11 → 15 days
    expect((await slip(periods.nov, 'E011')).base_salary).toBe(10000); // leaver 11-04 → 10 days
    expect(await slip(periods.nov, 'E008')).toBeNull(); // resigned without a termination date in the period

    // E007: Feishu replaces requests — OT 3 h revised (not the 4 h from Feishu, not the 3 h request), unpaid 8 h = 1 day
    const e7 = await slip(periods.nov, 'E007');
    expect(e7.ot_amount).toBe(309.38);
    expect(e7.unpaid_leave).toBe(550);
    expect(e7.calc.attendance).toMatchObject({ source: 'feishu', otHours: 3, unpaidLeaveDays: 1, unpaidLeaveHours: 8, workDays: 22 });
    // ZZB has no attendance import → requests are used
    expect((await slip(periods.nov, 'E007B')).calc.attendance.source).toBe('requests');
  });

  it('attendance is locked once payroll uses it; reopen unlocks it', async () => {
    const imp = (await staff().get(`/api/attendance/imports?company=1&period_id=${periods.nov}`)).body.find((i: { status: string }) => i.status === 'active');
    expect(imp.locked).toBe(1);
    expect((await staff().post(`/api/attendance/imports/${imp.id}/rollback`, { reason: 'x' })).status).toBe(409);
    const ot = (await staff().get(`/api/attendance/ot?period_id=${periods.nov}&status=revised`)).body[0];
    expect((await staff().post(`/api/attendance/ot/${ot.id}`, { action: 'confirm' })).status).toBe(409);
    const grid: Cell[][] = [HEAD_A, row('E007')];
    const a = (await staff().post('/api/attendance/imports/analyze', { company_id: 1, period_id: periods.nov, file_name: 'again.xlsx', sha256: sha(grid), grid })).body;
    expect(a.locked).toBe(true);
    expect(a.canImport).toBe(false);
    // mid-month cannot change any more once its month-end is calculated
    expect((await payroll().post(`/api/payroll/periods/${periods.mid}/calculate`)).status).toBe(409);
    expect((await payroll().post(`/api/payroll/periods/${periods.nov}/reopen`)).body.status).toBe('draft');
    expect((await staff().get(`/api/attendance/imports?period_id=${periods.nov}`)).body.find((i: { id: number }) => i.id === imp.id).locked).toBe(0);
    expect((await payroll().post(`/api/payroll/periods/${periods.nov}/calculate`)).body.calc_version).toBe(2);
  });

  it('a mid-month round cannot be added under a month-end that is already calculated', async () => {
    const dec = (await payroll().post('/api/payroll/periods', { code: '2026-12', name: 'ธ.ค.', start_date: '2026-11-26', end_date: '2026-12-25', pay_date: '2026-12-25' })).body.id;
    expect((await payroll().post(`/api/payroll/periods/${dec}/calculate`)).status).toBe(200);
    const mid = (await payroll().post('/api/payroll/periods', { code: '2026-12-M', name: 'กลาง ธ.ค.', kind: 'mid_month', start_date: '2026-11-26', end_date: '2026-12-10', pay_date: '2026-12-15' })).body.id;
    expect((await payroll().post(`/api/payroll/periods/${mid}/calculate`)).status).toBe(409);
    periods.dec = dec;
  });
});

describe('Payroll Preview, column layouts and export', () => {
  it('shows every required column from the payroll snapshot, with totals and validation', async () => {
    const d = (await payroll().get(`/api/payroll/periods/${periods.nov}/preview?company=1`)).body;
    expect(d.source).toBe('snapshot');
    expect(d.company.code).toBe('DEMO');
    expect(d.columns.map((x: { key: string }) => x.key)).toEqual(PREVIEW_COLUMNS.map((x) => x.key));
    const e9 = d.rows.find((r: { emp_code: string }) => r.emp_code === 'E009');
    expect(e9).toMatchObject({ probation_status: 'ผ่านทดลองงานระหว่างงวด', base_salary: 33666.67, mid_month_advance: 8000, company: 'บริษัท เดโม่ เอชอาร์ จำกัด' });
    const e7 = d.rows.find((r: { emp_code: string }) => r.emp_code === 'E007');
    expect(e7).toMatchObject({ work_days: 22, expected_work_days: 22, actual_work_hours: 176, ot_hours: 3, unpaid_leave_days: 1, unpaid_leave_hours: 8, unpaid_leave_amount: -550, allowance: 1000 });
    for (const r of d.rows) {
      expect(r.total_income).toBe(Math.round((r.base_salary + r.unpaid_leave_amount + r.ot_pay + r.allowance + r.commission + r.bonus + r.other_income) * 100) / 100);
      expect(r.total_deduction).toBe(Math.round((r.sso + r.tax + r.ewf_employee + r.provident_fund + r.mid_month_advance + r.other_deduction) * 100) / 100);
      expect(r.net_pay).toBe(Math.round((r.total_income - r.total_deduction) * 100) / 100);
      expect(Object.values(r)).not.toContain(undefined);
    }
    expect(d.totals.net_pay).toBe(Math.round(d.rows.reduce((a: number, r: { net_pay: number }) => a + r.net_pay, 0) * 100) / 100);
    expect(d.rows.every((r: { company: string }) => r.company === 'บริษัท เดโม่ เอชอาร์ จำกัด')).toBe(true);
    expect(d.exportable).toBe(true);
    expect(d.canManageLayout).toBe(false); // payroll officer
  });

  it('a draft period is previewed live but cannot be exported', async () => {
    const p = (await payroll().post('/api/payroll/periods', { code: '2027-01', name: 'ม.ค. 70', start_date: '2026-12-26', end_date: '2027-01-25', pay_date: '2027-01-25' })).body.id;
    const d = (await payroll().get(`/api/payroll/periods/${p}/preview`)).body;
    expect(d.source).toBe('live');
    expect(d.rows.length).toBeGreaterThan(0);
    expect(d.exportable).toBe(false);
    expect((await payroll().get(`/api/payroll/periods/${p}/preview.csv`)).status).toBe(409);
    expect(H.sql(`SELECT COUNT(*) AS n FROM payslips WHERE period_id = ${p}`)[0]?.n).toBe(0); // preview never writes
  });

  it('only roles with payroll preview permission can see it', async () => {
    for (const k of ['manager', 'staff', 'employee']) expect((await c[k]!.get(`/api/payroll/periods/${periods.nov}/preview`)).status, k).toBe(403);
    expect((await payroll().get(`/api/payroll/periods/${periods.nov}/preview?company=999`)).status).toBe(403);
  });

  it('column layouts are per company and Super Admin only (UI and API)', async () => {
    const layout = [{ key: 'net_pay', visible: true }, { key: 'emp_code', visible: true }, { key: 'employee_name', visible: true }, { key: 'tax', visible: false }];
    expect((await payroll().put('/api/payroll/layouts/1', { columns: layout })).status).toBe(403);
    expect((await payroll().del('/api/payroll/layouts/1')).status).toBe(403);
    expect((await staff().put('/api/payroll/layouts/1', { columns: layout })).status).toBe(403);
    // a permission granted by SQL is still not enough: the role itself is checked
    H.sql("INSERT INTO role_permissions (role_id, permission) SELECT id, 'payroll_layout.manage' FROM roles WHERE code = 'payroll_officer'");
    expect((await payroll().put('/api/payroll/layouts/1', { columns: layout })).status).toBe(403);
    H.sql("DELETE FROM role_permissions WHERE permission = 'payroll_layout.manage'");
    const cat = (await admin().get('/api/admin/roles')).body.catalogue as string[];
    expect(cat).not.toContain('payroll_layout.manage');
    expect(cat).toEqual(expect.arrayContaining(['attendance_import.create', 'ot_review.update', 'payroll_preview.export', 'org_chart.import', 'payslip_ytd.view']));

    expect((await admin().put('/api/payroll/layouts/1', { columns: [{ key: 'bank_account', visible: true }] })).status).toBe(400);
    expect((await admin().put('/api/payroll/layouts/999999', { columns: layout })).status).toBe(404);
    const saved = await admin().put('/api/payroll/layouts/1', { columns: layout });
    expect(saved.status).toBe(200);
    const d = (await admin().get(`/api/payroll/periods/${periods.nov}/preview?company=1`)).body;
    expect(d.layoutSaved).toBe(true);
    expect(d.canManageLayout).toBe(true);
    expect(d.layout.slice(0, 4)).toEqual(layout);
    const other = (await admin().get(`/api/payroll/periods/${periods.nov}/preview?company=${ids.zzb}`)).body;
    expect(other.layoutSaved).toBe(false); // other company keeps the default
    expect(other.layout[0].key).toBe('emp_code');
    expect(H.sql("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'payroll.layout_saved'")[0]?.n).toBe(1);
  });

  it('CSV and Excel exports match the previewed columns and rows exactly', async () => {
    const d = (await payroll().get(`/api/payroll/periods/${periods.nov}/preview?company=1`)).body;
    const labels = d.layout.filter((l: { visible: boolean }) => l.visible).map((l: { key: string }) => PREVIEW_COLUMNS.find((x) => x.key === l.key)!.label);
    expect(labels[0]).toBe('เงินได้สุทธิ');
    expect(labels).not.toContain('ภาษีหัก ณ ที่จ่าย'); // hidden in the company layout
    const csvRes = await payroll().get(`/api/payroll/periods/${periods.nov}/preview.csv?company=1`);
    expect(csvRes.status).toBe(200);
    const rows = parseCsv(csvRes.text);
    expect(rows[0]).toEqual(labels);
    expect(rows).toHaveLength(d.rows.length + 2);
    const res = await fetch(`${H.baseUrl}/api/payroll/periods/${periods.nov}/preview.xlsx?company=1`, { headers: { cookie: payroll().cookie } });
    expect(res.headers.get('content-type')).toContain('spreadsheetml');
    const sheet = (await readXlsx(new Uint8Array(await res.arrayBuffer())))[0]!;
    expect(sheet.rows[0]).toEqual(labels);
    expect(sheet.rows[1]?.[0]).toBe(d.rows[0].net_pay);
    expect(sheet.rows.at(-1)?.[0]).toBe(d.totals.net_pay);
    expect(H.sql("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'payroll.preview_exported'")[0]?.n).toBe(2);
    expect((await admin().del('/api/payroll/layouts/1')).body.saved).toBe(false);
  });
});

describe('payslip YTD', () => {
  it('month-end approval is blocked while Feishu OT is pending; publish then lock', async () => {
    expect((await admin().post(`/api/payroll/periods/${periods.nov}/approve`)).status).toBe(200);
    expect((await admin().post(`/api/payroll/periods/${periods.nov}/publish`)).status).toBe(200);
    expect((await payroll().post(`/api/payroll/periods/${periods.nov}/calculate`)).status).toBe(409);
    expect((await payroll().post(`/api/payroll/periods/${periods.nov}/reopen`)).status).toBe(409);
  });

  const ytdFor = async (client: Client, periodId: number, code: string) => {
    const list = (await payroll().get(`/api/payroll/payslips?period_id=${periodId}`)).body as Array<{ id: number; employee: string }>;
    return (await client.get(`/api/payslips/${list.find((x) => x.employee.startsWith(`${code} `))!.id}`)).body;
  };

  it('calendar year: published monthly slips from 1 January up to the slip; previous year excluded', async () => {
    const nov = await ytdFor(payroll(), periods.nov, 'E006');
    const oct = await ytdFor(payroll(), periods.oct, 'E006');
    expect(nov.ytd.year).toBe(2026);
    expect(nov.ytd.includesCurrent).toBe(true);
    expect(nov.ytd.employee.slips).toBe(2); // Oct + Nov 2026 (Dec 2025 is another year; the mid-month advance is not counted twice)
    expect(nov.ytd.employee.gross).toBe(Math.round((oct.gross + nov.gross) * 100) / 100);
    expect(nov.ytd.employee.sso).toBe(Math.round((oct.sso + nov.sso) * 100) / 100);
    expect(oct.ytd.employee.slips).toBe(1);
  });

  it('unpublished payroll is never counted', async () => {
    const dec = await ytdFor(payroll(), periods.dec, 'E006');
    expect(dec.published).toBe(0);
    expect(dec.ytd.includesCurrent).toBe(false);
    expect(dec.ytd.employee.slips).toBe(2);
  });

  it('employee transferred between companies: company YTD per paying company, employee YTD across companies', async () => {
    const own = (await c.employee!.get('/api/my/payslips')).body.rows.find((r: { period_code: string }) => r.period_code === '2026-11');
    const s = (await c.employee!.get(`/api/payslips/${own.id}`)).body;
    const z = await ytdFor(payroll(), periods.nov, 'E007B');
    const e7oct = await ytdFor(payroll(), periods.oct, 'E007');
    expect(s.ytd.company.company).toBe('บริษัท เดโม่ เอชอาร์ จำกัด');
    expect(s.ytd.company.slips).toBe(2);
    expect(s.ytd.company.gross).toBe(Math.round((e7oct.gross + s.gross) * 100) / 100);
    expect(s.ytd.byCompany).toHaveLength(2);
    expect(s.ytd.employee.companies).toBe(2);
    expect(s.ytd.employee.records).toBe(2);
    expect(s.ytd.employee.gross).toBe(Math.round((s.ytd.company.gross + z.ytd.company.gross) * 100) / 100);
    expect(z.ytd.employee.gross).toBe(s.ytd.employee.gross); // same person seen from the other record
    expect('ewf_employer' in s).toBe(false);
  });

  it('a different person is never merged, even with the same name', async () => {
    const other = await ytdFor(payroll(), periods.nov, 'E099');
    expect(other.ytd.employee.records).toBe(1);
    expect(other.ytd.employee.companies).toBe(1);
  });

  it('YTD needs payslip_ytd.view and never exposes other employees', async () => {
    H.sql("DELETE FROM role_permissions WHERE permission = 'payslip_ytd.view' AND role_id = (SELECT id FROM roles WHERE code = 'employee')");
    const own = (await c.employee!.get('/api/my/payslips')).body.rows[0];
    expect('ytd' in (await c.employee!.get(`/api/payslips/${own.id}`)).body).toBe(false);
    H.sql("INSERT INTO role_permissions (role_id, permission) SELECT id, 'payslip_ytd.view' FROM roles WHERE code = 'employee'");
    const list = (await payroll().get(`/api/payroll/payslips?period_id=${periods.nov}`)).body as Array<{ id: number; employee: string }>;
    expect((await c.employee!.get(`/api/payslips/${list.find((x) => x.employee.startsWith('E001 '))!.id}`)).status).toBe(404);
  });
});

describe('Organization Design', () => {
  it('uses the real master data: hierarchy levels, reports-to, approved / occupied / vacant / over', async () => {
    const d = (await admin().get('/api/org-design?company=1')).body;
    expect(d.company.code).toBe('DEMO');
    expect(d.employees.every((e: { company_id: number }) => e.company_id === 1)).toBe(true);
    expect(d.employees.map((e: { emp_code: string }) => e.emp_code)).not.toContain('E008'); // resigned
    expect(d.departments.find((x: { code: string }) => x.code === 'OPS-PRD').level).toBe(3);
    expect(d.stats.levels).toBeGreaterThanOrEqual(3);
    for (const p of d.positions) {
      expect(p.vacant).toBe(Math.max(0, p.approved - p.occupied));
      expect(p.over).toBe(Math.max(0, p.occupied - p.approved));
      expect(p.vacant).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.stringify(d)).not.toMatch(/base_salary|bank_account|tax_id/);
  });

  it('over headcount is reported separately, never as a negative vacancy', async () => {
    const md = (await admin().get('/api/org-design?company=1')).body.positions.find((p: { code: string }) => p.code === 'P-MD');
    expect((await admin().req('PATCH', `/api/org-design/employees/${idOf('E004')}`, { position_id: md.id })).status).toBe(200);
    const after = (await admin().get('/api/org-design?company=1')).body.positions.find((p: { code: string }) => p.code === 'P-MD');
    expect(after).toMatchObject({ approved: 1, occupied: 2, vacant: 0, over: 1 });
  });

  it('edits validate reports-to (no cycles, same company) and are audited', async () => {
    expect((await admin().req('PATCH', `/api/org-design/employees/${idOf('E001')}`, { manager_id: idOf('E002') })).status).toBe(400); // E002 reports to E001
    expect((await admin().req('PATCH', `/api/org-design/employees/${idOf('E003')}`, { manager_id: ids.zb1 })).status).toBe(400);
    expect((await admin().req('PATCH', `/api/org-design/employees/${idOf('E003')}`, { manager_id: idOf('E003') })).status).toBe(400);
    expect((await c.manager!.req('PATCH', `/api/org-design/employees/${idOf('E003')}`, { manager_id: idOf('E004') })).status).toBe(403);
    expect(H.sql("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'org.updated'")[0]?.n).toBe(1);
  });

  it('import: template → preview → apply only validated changes (never a wholesale replace)', async () => {
    const t = await fetch(`${H.baseUrl}/api/org-design/template.xlsx?company=1`, { headers: { cookie: admin().cookie } });
    const tpl = (await readXlsx(new Uint8Array(await t.arrayBuffer())))[0]!;
    expect(tpl.rows[0]?.[0]).toBe('Employee ID');
    const grid: Cell[][] = [tpl.rows[0] as Cell[], ['E003', 'E004', 'IT', 'P-DEV'], ['E005', 'E001', 'XXX', null], ['ZZ999', 'E001', null, null], ['E001', 'E003', null, null], ['E007', 'E005', 'OPS-PRD', 'P-OPR']];
    const p = (await admin().post('/api/org-design/import/preview', { company_id: 1, grid })).body;
    expect(p.stats).toMatchObject({ total: 5, changed: 1, unchanged: 1, errors: 3 });
    const errs = (code: string) => p.rows.find((r: { emp_code: string }) => r.emp_code === code).errors.join(' ');
    expect(errs('E005')).toContain('XXX');
    expect(errs('ZZ999')).toContain('ไม่พบพนักงาน');
    expect(errs('E001')).toContain('Circular');
    const before = H.sql("SELECT COUNT(*) AS n FROM employees")[0]?.n;
    expect((await admin().post('/api/org-design/import', { company_id: 1, grid })).status).toBe(409);
    const r = await admin().post('/api/org-design/import', { company_id: 1, grid, skip_invalid: true });
    expect(r.body).toEqual({ changed: 1, skipped: 3 });
    expect(H.sql("SELECT m.emp_code FROM employees e JOIN employees m ON m.id = e.manager_id WHERE e.emp_code = 'E003'")[0]?.emp_code).toBe('E004');
    expect(H.sql("SELECT COUNT(*) AS n FROM employees")[0]?.n).toBe(before);
    expect(H.sql("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'org.imported'")[0]?.n).toBe(1);
  });

  it('access control: view / export / import by permission', async () => {
    expect((await c.employee!.get('/api/org-design')).status).toBe(403);
    expect((await c.manager!.get('/api/org-design')).status).toBe(200);
    expect((await c.manager!.get('/api/org-design/export.csv')).status).toBe(403);
    expect((await c.manager!.post('/api/org-design/import/preview', { grid: [['Employee ID'], ['E1']] })).status).toBe(403);
    const csvRes = await staff().get('/api/org-design/export.csv?company=1');
    expect(csvRes.status).toBe(200);
    expect(csvRes.text).toContain('ว่าง (Vacant)');
    expect((await admin().get('/api/org-design/export.xlsx')).status).toBe(200);
    expect((await staff().post('/api/org-design/import/preview', { grid: [['Employee ID'], ['E1']] })).status).toBe(403);
  });
});

describe('company-scoped payroll periods', () => {
  it('a period can pay one company only; overlap is refused only where the same employees could be paid twice', async () => {
    const mk = (body: Record<string, unknown>) => payroll().post('/api/payroll/periods', { kind: 'monthly', pay_date: '2027-02-25', start_date: '2027-01-26', end_date: '2027-02-25', ...body });
    expect((await mk({ code: '2026-11-ZB', name: 'x', company_id: ids.zzb, start_date: '2026-10-26', end_date: '2026-11-25', pay_date: '2026-11-25' })).status).toBe(409); // all-company period already pays ZZB
    expect((await mk({ code: 'BAD', name: 'x', company_id: 999999 })).status).toBe(400);
    const zb = await mk({ code: '2027-02-ZB', name: 'ก.พ. ZZB', company_id: ids.zzb });
    const demo = await mk({ code: '2027-02-DM', name: 'ก.พ. DEMO', company_id: 1 });
    expect([zb.status, demo.status]).toEqual([201, 201]);
    expect(zb.body).toMatchObject({ company_id: ids.zzb, company: 'บริษัท บี ทดสอบ จำกัด' });
    expect((await mk({ code: '2027-02-ALL', name: 'x' })).status).toBe(409); // an all-company period would overlap both
    const calc = await payroll().post(`/api/payroll/periods/${zb.body.id}/calculate`);
    expect(calc.body.employees).toBe(3); // E007B, ZB1, E099 only
    const slips = (await payroll().get(`/api/payroll/payslips?period_id=${zb.body.id}`)).body as Array<{ employee: string }>;
    expect(slips.map((s) => s.employee.split(' ')[0]).sort()).toEqual(['E007B', 'E099', 'ZB1']);
    expect((await payroll().get(`/api/payroll/periods/${zb.body.id}/preview?company=1`)).body.rows).toEqual([]);
    const grid: Cell[][] = [HEAD_A, row('E007')];
    const a = (await staff().post('/api/attendance/imports/analyze', { company_id: 1, period_id: zb.body.id, file_name: 'x.xlsx', sha256: sha(grid), grid })).body;
    expect(a.fileIssues.map((i: { code: string }) => i.code)).toContain('period_company');
    expect(a.canImport).toBe(false);
  });
});

describe('database integrity after the workflow', () => {
  it('payroll history is consistent: one slip per employee per period, published slips unchanged', () => {
    expect(H.sql('SELECT COUNT(*) AS n FROM (SELECT period_id, employee_id FROM payslips GROUP BY 1, 2 HAVING COUNT(*) > 1)')[0]?.n).toBe(0);
    expect(H.sql("SELECT COUNT(*) AS n FROM attendance_imports WHERE status = 'active' GROUP BY company_id, payroll_period_id HAVING COUNT(*) > 1")).toEqual([]);
    expect(H.sql('SELECT COUNT(*) AS n FROM payslips WHERE company_id IS NULL')[0]?.n).toBe(0);
    expect(H.sql('PRAGMA foreign_key_check')).toEqual([]);
  });
});
