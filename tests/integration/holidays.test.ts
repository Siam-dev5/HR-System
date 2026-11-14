// Holiday calendar & holiday pay — isolated local D1 with synthetic data only (company ZZH, employees ZH*).
// Permissions and company scope, draft → verified → approved (maker-checker), import / export, substitutes, day types,
// holiday-work evidence, pay rules, payroll amounts and snapshots, locking, recalculation and regression for
// employees without holiday work.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const admin = () => c.admin as Client;
const staff = () => c.staff as Client;
const payroll = () => c.payroll as Client;
const employee = () => c.employee as Client;

beforeAll(async () => {
  H = await startHarness();
  for (const k of ['admin', 'staff', 'payroll', 'employee', 'anon']) c[k] = new Client(H.baseUrl);
  await c.admin!.login('it_admin', H.passwords.it_admin);
  await c.staff!.login('it_staff', H.passwords.it_staff);
  await c.payroll!.login('it_payroll', H.passwords.it_payroll);
  await c.employee!.login('it_employee', H.passwords.it_employee);
});
afterAll(async () => {
  await H?.stop();
});

// next calendar year: always inside the 10-year window and never covered by demo payroll periods
const Y = new Date().getUTCFullYear() + 1;
const d = (md: string) => `${Y}-${md}`;
const firstWeekday = (month: number, wd: number) => {
  for (let day = 1; day <= 7; day++) {
    const s = `${Y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (new Date(`${s}T00:00:00Z`).getUTCDay() === wd) return s;
  }
  throw new Error('unreachable');
};
const ids: Record<string, number> = {};
const hol: Record<string, number> = {};
let co = 0;
let zzhCal = 0;
let period = 0;
type Slip = { employee_id: number; net: number; gross: number; sso: number; tax: number; lines_json: string; calc_json: string };
const slips = () => new Map((H.sql(`SELECT employee_id, net, gross, sso, tax, lines_json, calc_json FROM payslips WHERE period_id = ${period}`) as unknown as Slip[]).map((s) => [s.employee_id, s]));
const audits = (action: string) => Number(H.sql(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = '${action}'`)[0]!.n);

describe('setup (synthetic company ZZH)', () => {
  it('company, employees and the central Thai calendar from the migration', async () => {
    co = (await admin().post('/api/m/companies', { code: 'ZZH', name: 'zz_test holidays', active: true })).body.id;
    const emp = async (code: string, type: string, status = 'active') => {
      const r = await admin().post('/api/m/employees', { emp_code: code, first_name: 'zz_test', last_name: code, company_id: co, hire_date: '2020-01-01', employment_type: type, status, base_salary: 30000 });
      expect(r.status, r.text).toBe(201);
      ids[code] = r.body.id;
    };
    await emp('ZH1', 'permanent'); // attendance evidence, normal + OT
    await emp('ZH2', 'contract'); // not entitled to holiday pay: 2x
    await emp('ZH3', 'permanent'); // no holiday work (regression)
    await emp('ZH4', 'permanent'); // approved OT request on the holiday (double payment guard)
    await emp('ZH5', 'intern'); // no approved pay rule for interns
    await emp('ZH6', 'permanent'); // salary raised to 36,000 on the 16th: holiday work before and after the raise
    await emp('ZH7', 'probation', 'probation'); // employment TYPE probation: its own rule
    await emp('ZH8', 'permanent', 'probation'); // a permanent hire whose STATUS is probation: the permanent rule
    await emp('ZH9', 'permanent'); // legacy employment_type written outside the API (below): never mapped
    H.sql(`UPDATE employees SET employment_type = 'Permanent ' WHERE id = ${ids.ZH9}`);
    // salary history entered out of date order (the engine must not depend on insertion order)
    for (const [date, amount] of [[d('05-16'), 36000], ['2020-01-01', 30000], [`${Y - 1}-01-01`, 30000]] as const) {
      const h = await admin().post('/api/m/salary_history', { employee_id: ids.ZH6, effective_date: date, base_salary: amount, reason: 'zz test raise' });
      expect(h.status, h.text).toBe(201);
    }
    const r = await staff().get('/api/holidays');
    expect(r.status).toBe(200);
    expect(r.body.calendars.find((x: { code: string }) => x.code === 'TH')).toMatchObject({ country_code: 'TH', company_id: null });
    expect(r.body.window).toEqual({ from: Y - 1, to: Y + 8 });
  });
});

describe('permissions and company scope', () => {
  it('signed out 401, CSRF header required, employees may view but not change', async () => {
    expect((await c.anon!.get('/api/holidays')).status).toBe(401);
    expect((await staff().req('POST', '/api/holidays', { calendar_id: 1 }, { 'x-hr-requested': '0' })).status).toBe(403);
    expect((await employee().get('/api/holidays')).status).toBe(200);
    expect((await employee().post('/api/holidays', { calendar_id: 1, holiday_date: d('05-01'), name: 'x', holiday_type: 'traditional' })).status).toBe(403);
    expect((await employee().get('/api/holidays/export.xlsx')).status).toBe(403);
    expect((await employee().post('/api/holidays/import/preview', { calendar_id: 1, grid: [] })).status).toBe(403);
    expect((await employee().post('/api/holidays/pay-rules', {})).status).toBe(403);
    expect((await staff().post('/api/holidays/1/approve')).status).toBe(403); // hr_staff has no approve permission
  });

  it('company calendar: created once per company', async () => {
    const r = await staff().post('/api/holidays/calendars', { company_id: co, weekly_rest_days: '0,6' });
    expect(r.status, r.text).toBe(201);
    zzhCal = r.body.id;
    expect(r.body).toMatchObject({ code: 'TH-ZZH', company_id: co });
    expect((await staff().post('/api/holidays/calendars', { company_id: co })).status).toBe(409);
    expect((await staff().post('/api/holidays/calendars', { company_id: co, weekly_rest_days: '7' })).status).toBe(400);
  });

  it('cross-company access is denied for a user limited to their own company', async () => {
    // it_employee (company DEMO, no organisation-wide access) is given holiday create rights for this test only
    H.sql(`INSERT INTO roles (code, name, privileged, system) VALUES ('zz_hol_local', 'zz holiday local', 0, 0);
      INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.value FROM roles r, json_each('["holiday_calendar.view","holiday_calendar.create","holiday_calendar.update","holiday_calendar.export"]') p WHERE r.code = 'zz_hol_local';
      INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.username = 'it_employee' AND r.code = 'zz_hol_local';`);
    const own = await staff().post('/api/holidays', { calendar_id: zzhCal, holiday_date: d('06-15'), name: 'zz company day', holiday_type: 'company', source_reference: 'ZZH notice 1' });
    expect(own.status, own.text).toBe(201);
    hol.company = own.body.id;
    expect((await employee().post('/api/holidays', { calendar_id: zzhCal, holiday_date: d('06-16'), name: 'x', holiday_type: 'company', source_reference: 'x' })).status).toBe(404);
    expect((await employee().post('/api/holidays', { calendar_id: 1, holiday_date: d('06-16'), name: 'x', holiday_type: 'traditional', source_reference: 'x' })).status).toBe(403); // central needs org-wide scope
    expect((await employee().get(`/api/holidays/${hol.company}`)).status).toBe(404);
    expect((await employee().get(`/api/holidays?company=${co}`)).status).toBe(403);
    expect((await employee().get(`/api/holidays/day-types?company=${co}&from=${d('06-01')}&to=${d('06-30')}`)).status).toBe(403);
    const list = await employee().get(`/api/holidays?year=${Y}`);
    expect(list.body.calendars.some((x: { company_id: number | null }) => x.company_id === co)).toBe(false);
    expect(list.body.holidays.some((x: { id: number }) => x.id === hol.company)).toBe(false);
    expect((await employee().get(`/api/holidays/export.xlsx?company=${co}`)).status).toBe(403);
    H.sql(`DELETE FROM user_roles WHERE role_id = (SELECT id FROM roles WHERE code = 'zz_hol_local'); DELETE FROM role_permissions WHERE role_id = (SELECT id FROM roles WHERE code = 'zz_hol_local'); DELETE FROM roles WHERE code = 'zz_hol_local';`);
  });
});

describe('holidays: draft → verified → approved', () => {
  it('validates dates (window, leap year), types and duplicates', async () => {
    const mk = (b: Record<string, unknown>) => staff().post('/api/holidays', { calendar_id: 1, holiday_type: 'traditional', name: 'zz', source_reference: 'ประกาศ', ...b });
    const labour = await mk({ holiday_date: d('05-01'), name: 'วันแรงงานแห่งชาติ', holiday_type: 'national_labour', source_reference: 'พ.ร.บ.คุ้มครองแรงงาน / ประกาศกระทรวงแรงงาน' });
    expect(labour.status, labour.text).toBe(201);
    expect(labour.body).toMatchObject({ status: 'draft', verification: 'unverified', origin: 'manual', year: Y });
    hol.labour = labour.body.id;
    expect((await mk({ holiday_date: d('05-01') })).status).toBe(409); // duplicate day in the same calendar
    expect((await mk({ holiday_date: `${Y + 9}-01-01` })).status).toBe(400); // outside the 10-year window
    expect((await mk({ holiday_date: `${Y - 2}-12-31` })).status).toBe(400);
    expect((await mk({ holiday_date: d('02-30') })).status).toBe(400);
    expect((await mk({ holiday_date: d('03-01'), holiday_type: 'company' })).status).toBe(400); // company holidays belong to a company calendar
    expect((await mk({ holiday_date: d('03-02'), holiday_type: 'substitute' })).status).toBe(400);
    expect((await mk({ holiday_date: d('03-03'), source_url: 'http://insecure.example' })).status).toBe(400);
    const leapYear = [Y, Y + 1, Y + 2, Y + 3].find((y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)!;
    const leap = await mk({ holiday_date: `${leapYear}-02-29`, name: 'zz leap' });
    expect(leap.status, leap.text).toBe(201);
    expect((await mk({ holiday_date: `${leapYear + 1}-02-29` })).status).toBe(400);
    // the same day may exist in a company calendar too (company and national holidays are separate)
    const both = await staff().post('/api/holidays', { calendar_id: zzhCal, holiday_date: d('05-01'), name: 'zz company labour', holiday_type: 'company', source_reference: 'ZZH notice 2' });
    expect(both.status, both.text).toBe(201);
    expect((await staff().del(`/api/holidays/${both.body.id}`)).status).toBe(403); // hr_staff has no delete permission
    expect((await admin().del(`/api/holidays/${both.body.id}`)).status).toBe(200); // an unreferenced draft can be deleted
    expect((await admin().del(`/api/holidays/${leap.body.id}`)).status).toBe(200);
  });

  it('approval needs a verified source and a second person', async () => {
    expect((await admin().post(`/api/holidays/${hol.labour}/approve`)).status).toBe(409); // not verified
    const v = await admin().post(`/api/holidays/${hol.labour}/verify`, { source_url: 'https://www.mol.go.th/' });
    expect(v.status, v.text).toBe(200);
    expect(v.body.verification).toBe('verified');
    const a = await admin().post(`/api/holidays/${hol.labour}/approve`);
    expect(a.status, a.text).toBe(200);
    expect(a.body).toMatchObject({ status: 'approved', approved_by_name: 'it_admin' });
    expect((await admin().post(`/api/holidays/${hol.labour}/approve`)).status).toBe(409);
    // maker-checker: the creator approves their own holiday only as Super Admin and only with an approval note
    // (roles-approval.test.ts covers the other roles, which are refused with 403)
    const own = await admin().post('/api/holidays', { calendar_id: 1, holiday_date: d('07-28'), name: 'zz own', holiday_type: 'traditional', source_reference: 'ประกาศ' });
    expect((await admin().post(`/api/holidays/${own.body.id}/verify`)).status).toBe(200);
    const noNote = await admin().post(`/api/holidays/${own.body.id}/approve`);
    expect(noNote.status).toBe(400);
    expect(noNote.body.error.message).toContain('บันทึกการอนุมัติ');
    expect((await admin().post(`/api/holidays/${own.body.id}/deactivate`, { reason: 'zz test entry' })).status).toBe(200);
    // company holiday approved by another person
    expect((await admin().post(`/api/holidays/${hol.company}/verify`)).status).toBe(200);
    expect((await admin().post(`/api/holidays/${hol.company}/approve`)).status).toBe(200);
  });

  it('a holiday on a weekly rest day is flagged until a substitute working day is set', async () => {
    const sat = firstWeekday(8, 6);
    const r = await staff().post('/api/holidays', { calendar_id: 1, holiday_date: sat, name: 'zz Saturday holiday', holiday_type: 'traditional', source_reference: 'ประกาศ' });
    hol.saturday = r.body.id;
    await admin().post(`/api/holidays/${hol.saturday}/verify`);
    await admin().post(`/api/holidays/${hol.saturday}/approve`);
    const flagged = (await staff().get(`/api/holidays?year=${Y}`)).body.holidays.find((x: { id: number }) => x.id === hol.saturday);
    expect(flagged.needs_substitute).toBe(true);
    expect((await staff().get(`/api/holidays/${hol.saturday}`)).body.on_weekly_rest).toBe(true);
    const sunday = new Date(Date.parse(`${sat}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect((await staff().post(`/api/holidays/${hol.saturday}/substitute`, { holiday_date: sunday })).status).toBe(400); // must be a working day
    const monday = new Date(Date.parse(`${sat}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
    const s = await staff().post(`/api/holidays/${hol.saturday}/substitute`, { holiday_date: monday, reason: 'ตรงกับวันเสาร์' });
    expect(s.status, s.text).toBe(201);
    expect(s.body).toMatchObject({ holiday_type: 'substitute', status: 'draft', substitute_for: hol.saturday, holiday_date: monday });
    expect((await staff().post(`/api/holidays/${hol.saturday}/substitute`, { holiday_date: monday })).status).toBe(409);
    const after = (await staff().get(`/api/holidays?year=${Y}`)).body.holidays.find((x: { id: number }) => x.id === hol.saturday);
    expect(after.needs_substitute).toBe(false);
  });

  it('day types for attendance: company holiday, national holiday, weekly rest, workday', async () => {
    const r = await staff().get(`/api/holidays/day-types?company=${co}&from=${d('06-13')}&to=${d('06-16')}`);
    expect(r.status, r.text).toBe(200);
    const day = (x: string) => r.body.days.find((y: { date: string }) => y.date === x);
    expect(day(d('06-15'))).toMatchObject({ kind: 'holiday', holiday: { id: hol.company, type: 'company', companyCalendar: true } });
    const labour = (await staff().get(`/api/holidays/day-types?company=${co}&from=${d('05-01')}&to=${d('05-01')}`)).body.days[0];
    expect(labour).toMatchObject({ kind: 'holiday', holiday: { id: hol.labour, type: 'national_labour', companyCalendar: false } });
    for (const x of r.body.days) if (x.date !== d('06-15')) expect(x.kind).toBe(new Date(`${x.date}T00:00:00Z`).getUTCDay() % 6 === 0 ? 'weekly_rest' : 'workday');
    // a draft holiday is not a holiday for attendance
    const draft = await staff().post('/api/holidays', { calendar_id: zzhCal, holiday_date: d('06-17'), name: 'zz draft', holiday_type: 'company', source_reference: 'x' });
    expect((await staff().get(`/api/holidays/day-types?company=${co}&from=${d('06-17')}&to=${d('06-17')}`)).body.days[0].kind).not.toBe('holiday');
    hol.draft = draft.body.id;
  });
});

describe('import (preview, drafts only) and export', () => {
  const grid = () => [
    ['date', 'name', 'type', 'source_reference'],
    [d('12-05'), 'zz วันพ่อแห่งชาติ', 'traditional', 'ประกาศสำนักนายกฯ'],
    [d('12-10'), 'zz วันรัฐธรรมนูญ', 'traditional', ''],
    [d('12-10'), 'zz ซ้ำในไฟล์', 'traditional', 'x'],
    [d('05-01'), 'zz มีอยู่แล้ว', 'national_labour', 'x'],
    [d('02-30'), 'zz วันที่ผิด', 'traditional', 'x'],
    [`${Y + 9}-01-01`, 'zz นอกช่วง', 'traditional', 'x'],
    [d('12-31'), 'zz ประเภทผิด', 'holiday', 'x'],
  ];
  it('preview validates every row and changes nothing', async () => {
    const before = Number(H.sql('SELECT COUNT(*) AS n FROM holidays')[0]!.n);
    const r = await staff().post('/api/holidays/import/preview', { calendar_id: 1, grid: grid() });
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ importable: 2, errors: 5 });
    expect(Number(H.sql('SELECT COUNT(*) AS n FROM holidays')[0]!.n)).toBe(before);
  });
  it('import refuses a file with errors unless only valid rows are taken; rows start as unverified drafts', async () => {
    expect((await staff().post('/api/holidays/import', { calendar_id: 1, grid: grid() })).status).toBe(409);
    const r = await staff().post('/api/holidays/import', { calendar_id: 1, grid: grid(), skip_invalid: true, file_name: 'zz.xlsx' });
    expect(r.status, r.text).toBe(201);
    expect(r.body).toMatchObject({ imported: 2, skipped: 5 });
    const rows = H.sql(`SELECT status, origin, verification FROM holidays WHERE import_batch = '${r.body.batch}'`);
    expect(rows).toHaveLength(2);
    for (const x of rows) expect(x).toEqual({ status: 'draft', origin: 'import', verification: 'unverified' });
    // the same file again: every row is now a duplicate
    expect((await staff().post('/api/holidays/import/preview', { calendar_id: 1, grid: grid() })).body.importable).toBe(0);
    expect(audits('holiday.imported')).toBe(1);
  });
  it('export is an Excel file, audited', async () => {
    const r = await payroll().get(`/api/holidays/export.xlsx?year=${Y}`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('spreadsheetml');
    expect(r.headers.get('cache-control')).toContain('no-store');
    expect(audits('holiday.exported')).toBeGreaterThanOrEqual(1);
  });
  it('filters: type, status, search, company', async () => {
    const q = async (s: string) => (await staff().get(`/api/holidays?year=${Y}&${s}`)).body.holidays as Array<{ id: number; holiday_type: string; status: string }>;
    expect((await q('type=national_labour')).every((x) => x.holiday_type === 'national_labour')).toBe(true);
    expect((await q('status=draft')).every((x) => x.status === 'draft')).toBe(true);
    expect((await q(`q=${encodeURIComponent('วันพ่อ')}`)).length).toBe(1);
    expect((await q(`company=${co}`)).some((x) => x.id === hol.company)).toBe(true);
  });
});

describe('holiday pay rules', () => {
  it('statutory minimums are enforced; approval needs a second person', async () => {
    const mk = (b: Record<string, unknown>) => staff().post('/api/holidays/pay-rules', { employment_type: 'permanent', holiday_pay_entitled: true, work_multiplier: 1, ot_multiplier: 3, effective_from: '2020-01-01', legal_basis: 'พ.ร.บ.คุ้มครองแรงงาน ม.62, 63 (zz test)', ...b });
    expect((await mk({ holiday_pay_entitled: false, work_multiplier: 1.5 })).status).toBe(400);
    expect((await mk({ work_multiplier: 0.5 })).status).toBe(400);
    expect((await mk({ ot_multiplier: 2.5 })).status).toBe(400);
    expect((await mk({ holiday_pay_entitled: 'yes' })).status).toBe(400);
    const perm = await mk({});
    expect(perm.status, perm.text).toBe(201);
    const contract = await mk({ employment_type: 'contract', holiday_pay_entitled: false, work_multiplier: 2 });
    expect(contract.status, contract.text).toBe(201);
    expect((await staff().post(`/api/holidays/pay-rules/${perm.body.id}/approve`)).status).toBe(403);
    expect((await admin().post(`/api/holidays/pay-rules/${perm.body.id}/approve`)).status).toBe(200);
    expect((await admin().post(`/api/holidays/pay-rules/${contract.body.id}/approve`)).status).toBe(200);
    // an overlapping second rule for the same scope cannot be approved
    const dup = await mk({ effective_from: '2021-01-01', work_multiplier: 1.5 });
    expect((await admin().post(`/api/holidays/pay-rules/${dup.body.id}/approve`)).status).toBe(409);
    // the creator cannot approve their own rule without the Super Admin approval note (it stays a draft)
    const mine = await admin().post('/api/holidays/pay-rules', { company_id: co, employment_type: 'probation', holiday_pay_entitled: true, work_multiplier: 1, ot_multiplier: 3, effective_from: '2020-01-01', legal_basis: 'zz' });
    expect((await admin().post(`/api/holidays/pay-rules/${mine.body.id}/approve`)).status).toBe(400);
    // employment type probation has its own rule (1.5x), so a wrong mapping to the permanent rule (1x) would show
    const probation = await mk({ employment_type: 'probation', work_multiplier: 1.5 });
    expect((await admin().post(`/api/holidays/pay-rules/${probation.body.id}/approve`)).status).toBe(200);
    ids.rulePermanent = perm.body.id;
    ids.ruleProbation = probation.body.id;
    expect(audits('holiday.pay_rule_approved')).toBe(3);
  });
});

let baseline: Map<number, Slip>;

describe('payroll baseline without holiday work', () => {
  it('a month-end period of ZZH covering the labour day', async () => {
    const r = await payroll().post('/api/payroll/periods', { company_id: co, code: `ZH-${Y}-05`, name: 'zz holiday month', kind: 'monthly', start_date: d('04-26'), end_date: d('05-25'), pay_date: d('05-28') });
    expect(r.status, r.text).toBe(201);
    period = r.body.id;
    const calc = await payroll().post(`/api/payroll/periods/${period}/calculate`);
    expect(calc.status, calc.text).toBe(200);
    baseline = slips();
    expect(baseline.size).toBe(9);
    for (const s of baseline.values()) {
      expect(JSON.parse(s.lines_json).some((l: { code: string }) => l.code.startsWith('HOLIDAY'))).toBe(false);
      expect(JSON.parse(s.calc_json).holiday).toBeUndefined();
    }
  });
  it('holiday work cannot be recorded into a calculated period', async () => {
    const r = await staff().post('/api/holidays/work', { employee_id: ids.ZH3, holiday_id: hol.labour, normal_hours: 8, evidence_source: 'manual', evidence_ref: 'zz approval 0' });
    expect(r.status).toBe(409);
    expect((await payroll().post(`/api/payroll/periods/${period}/reopen`)).status).toBe(200);
  });
});

describe('holiday work records (verified evidence)', () => {
  it('attendance evidence must match the employee, day and clock times', async () => {
    const att = async (emp: number, inT: string, outT: string) => (await admin().post('/api/m/attendance', { employee_id: emp, work_date: d('05-01'), clock_in: inT, clock_out: outT, status: 'present', source: 'manual' })).body.id as number;
    const a1 = await att(ids.ZH1!, '08:00', '19:00'); // 11 h span
    const a2 = await att(ids.ZH2!, '09:00', '12:00'); // 3 h span
    const w = (b: Record<string, unknown>) => staff().post('/api/holidays/work', { holiday_id: hol.labour, evidence_source: 'attendance', ...b });
    expect((await w({ employee_id: ids.ZH2, normal_hours: 8, attendance_record_id: a2 })).status).toBe(400); // more hours than clocked
    expect((await w({ employee_id: ids.ZH1, normal_hours: 8, attendance_record_id: a2 })).status).toBe(400); // someone else's record
    expect((await w({ employee_id: ids.ZH1, normal_hours: 6, ot_hours: 2, attendance_record_id: a1 })).status).toBe(400); // OT before normal hours are complete
    expect((await w({ employee_id: ids.ZH1, normal_hours: 9, attendance_record_id: a1 })).status).toBe(400); // normal hours capped by hours_per_day
    expect((await w({ employee_id: ids.ZH1, holiday_id: hol.draft, normal_hours: 8, attendance_record_id: a1 })).status).toBe(409); // draft holiday
    const ok = await w({ employee_id: ids.ZH1, normal_hours: 8, ot_hours: 2, attendance_record_id: a1 });
    expect(ok.status, ok.text).toBe(201);
    ids.w1 = ok.body.id;
    expect(ok.body).toMatchObject({ status: 'pending', work_date: d('05-01'), normal_hours: 8, ot_hours: 2 });
    // duplicate attendance rows: the same employee-day cannot be recorded twice
    expect((await w({ employee_id: ids.ZH1, normal_hours: 8, attendance_record_id: a1 })).status).toBe(409);
    expect((await staff().post('/api/holidays/work', { employee_id: ids.ZH1, holiday_id: hol.labour, normal_hours: 4, evidence_source: 'manual', evidence_ref: 'zz duplicate' })).status).toBe(409);
  });

  it('manual evidence needs a reference; a company holiday of another company is refused', async () => {
    const w = (b: Record<string, unknown>) => staff().post('/api/holidays/work', { holiday_id: hol.labour, normal_hours: 8, evidence_source: 'manual', ...b });
    expect((await w({ employee_id: ids.ZH2 })).status).toBe(400);
    const r2 = await w({ employee_id: ids.ZH2, evidence_ref: 'zz holiday work approval 2' });
    expect(r2.status, r2.text).toBe(201);
    ids.w2 = r2.body.id;
    const demo = Number(H.sql("SELECT id FROM employees WHERE emp_code = 'E007'")[0]!.id);
    expect((await w({ employee_id: demo, holiday_id: hol.company, evidence_ref: 'zz other company' })).status).toBe(400);
    ids.w4 = (await w({ employee_id: ids.ZH4, evidence_ref: 'zz approval 4' })).body.id;
    ids.w5 = (await w({ employee_id: ids.ZH5, evidence_ref: 'zz approval 5' })).body.id;
    for (const k of ['ZH7', 'ZH8', 'ZH9']) ids[`w${k.slice(2)}`] = (await w({ employee_id: ids[k], evidence_ref: `zz approval ${k}` })).body.id;
  });

  it('holiday work before and after a salary raise in the same period', async () => {
    const after = await staff().post('/api/holidays', { calendar_id: 1, holiday_date: d('05-20'), name: 'zz วันหยุดหลังปรับเงินเดือน', holiday_type: 'traditional', source_reference: 'ประกาศ zz' });
    expect(after.status, after.text).toBe(201);
    hol.after = after.body.id;
    expect((await admin().post(`/api/holidays/${hol.after}/verify`)).status).toBe(200);
    expect((await admin().post(`/api/holidays/${hol.after}/approve`)).status).toBe(200);
    const w = (holiday: number) => staff().post('/api/holidays/work', { employee_id: ids.ZH6, holiday_id: holiday, normal_hours: 8, evidence_source: 'manual', evidence_ref: 'zz approval 6' });
    const before = await w(hol.labour!);
    const later = await w(hol.after!);
    expect([before.status, later.status], before.text + later.text).toEqual([201, 201]);
    ids.w6a = before.body.id;
    ids.w6b = later.body.id;
  });

  it('approval: approve permission, a second person, and the no-double-OT confirmation', async () => {
    expect((await staff().post(`/api/holidays/work/${ids.w1}/approve`, { excluded_from_regular_ot: true })).status).toBe(403);
    expect((await admin().post(`/api/holidays/work/${ids.w1}/approve`, {})).status).toBe(400);
    const a = await admin().post(`/api/holidays/work/${ids.w1}/approve`, { excluded_from_regular_ot: true });
    expect(a.status, a.text).toBe(200);
    expect(a.body).toMatchObject({ status: 'approved', excluded_from_regular_ot: 1, reviewer: 'it_admin' });
    expect((await admin().post(`/api/holidays/work/${ids.w2}/approve`, { excluded_from_regular_ot: true })).status).toBe(200);
    expect((await admin().post(`/api/holidays/work/${ids.w5}/approve`, { excluded_from_regular_ot: true })).status).toBe(200);
    // an approved OT request on the same day would pay the same hours twice
    const ot = await admin().post('/api/m/overtime', { employee_id: ids.ZH4, work_date: d('05-01'), hours: 3, rate: '3', reason: 'zz holiday OT request' });
    expect(ot.status, ot.text).toBe(201);
    H.sql(`UPDATE overtime_requests SET status = 'approved' WHERE id = ${ot.body.id}`);
    expect((await admin().post(`/api/holidays/work/${ids.w4}/approve`, { excluded_from_regular_ot: true })).status).toBe(409);
    expect((await admin().post(`/api/holidays/work/${ids.w4}/reject`, { reason: 'zz paid as normal OT request' })).status).toBe(200);
    for (const k of ['w6a', 'w6b', 'w7', 'w8', 'w9']) expect((await admin().post(`/api/holidays/work/${ids[k]}/approve`, { excluded_from_regular_ot: true })).status, k).toBe(200);
    expect(audits('holiday_work.approved')).toBe(8);
  });

  it('employees only see their own holiday work', async () => {
    const r = await employee().get('/api/holidays/work');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});

describe('traditional-holiday compliance (warning only)', () => {
  it('counts approved traditional + labour holidays, lists the excluded ones and never creates or approves holidays', async () => {
    const before = H.sql("SELECT COUNT(*) AS n, SUM(status = 'approved') AS approved FROM holidays")[0];
    const r = await staff().get(`/api/holidays?year=${Y}&company=${co}`);
    expect(r.status).toBe(200);
    expect(r.body.compliance).toHaveLength(1);
    const x = r.body.compliance[0];
    // approved: labour day (05-01), the Saturday holiday and 05-20 · drafts: the two imported traditional days
    expect(x).toMatchObject({ company_id: co, year: Y, required: 13, counted: 3, ok: false, drafts: 2, labourDayIssue: null, notCounted: { company: 1, local: 0, substitute: 0 } });
    expect(x.labourDay).toEqual([expect.objectContaining({ id: hol.labour, date: d('05-01') })]);
    expect(x.countedHolidays.map((h: { type: string }) => h.type).sort()).toEqual(['national_labour', 'traditional', 'traditional']);
    expect(x.message).toMatch(/น้อยกว่าขั้นต่ำ 13/);
    // without a company: the central calendar and the ZZH calendar are both reported
    const all = await staff().get(`/api/holidays?year=${Y}`);
    expect(all.body.compliance.map((c: { company_id: number | null }) => c.company_id)).toEqual([null, co]);
    expect(all.body.compliance[0]).toMatchObject({ counted: 3, notCounted: { company: 0 } });
    expect(H.sql("SELECT COUNT(*) AS n, SUM(status = 'approved') AS approved FROM holidays")[0]).toEqual(before);
  });
});

describe('payroll with holiday work', () => {
  it('refuses to calculate while an employee with approved holiday work has no approved pay rule', async () => {
    const r = await payroll().post(`/api/payroll/periods/${period}/calculate`);
    expect(r.status).toBe(409);
    expect(r.text).toMatch(/ZH5/);
    expect(H.sql(`SELECT COUNT(*) AS n FROM payslips WHERE period_id = ${period}`)[0]!.n).toBe(0);
    expect((await staff().post(`/api/holidays/work/${ids.w5}/cancel`, { reason: 'zz intern rule not decided' })).status).toBe(200);
  });

  it('refuses an employment type the system does not know instead of mapping it to another rule', async () => {
    const r = await payroll().post(`/api/payroll/periods/${period}/calculate`);
    expect(r.status).toBe(409);
    expect(r.text).toMatch(/ZH9/);
    expect(r.text).toMatch(/ไม่รู้จัก/);
    expect((await staff().post(`/api/holidays/work/${ids.w9}/cancel`, { reason: 'zz legacy employment type' })).status).toBe(200);
  });

  it('pays HOLIDAY_WORK / HOLIDAY_OT at the rule multiples of the configured hourly wage, with a snapshot', async () => {
    const r = await payroll().post(`/api/payroll/periods/${period}/calculate`);
    expect(r.status, r.text).toBe(200);
    const s = slips();
    // 30,000 ÷ 30 ÷ 8 = 125/h · ZH1 entitled: 8 h × 1 + 2 h OT × 3 · ZH2 not entitled: 8 h × 2
    const z1 = s.get(ids.ZH1!)!;
    const lines1 = JSON.parse(z1.lines_json) as Array<{ code: string; amount: number }>;
    expect(lines1.filter((l) => l.code.startsWith('HOLIDAY'))).toEqual([
      expect.objectContaining({ code: 'HOLIDAY_WORK', amount: 1000 }),
      expect.objectContaining({ code: 'HOLIDAY_OT', amount: 750 }),
    ]);
    expect(z1.gross).toBe(baseline.get(ids.ZH1!)!.gross + 1750);
    expect(z1.sso).toBe(baseline.get(ids.ZH1!)!.sso); // outside the SSO wage, like OT
    const snap = JSON.parse(z1.calc_json).holiday;
    expect(snap).toMatchObject({ divisorDays: 30, hoursPerDay: 8, workAmount: 1000, otAmount: 750 });
    expect(snap.monthlyRate).toBeUndefined(); // rates are per item (salary on the work date)
    expect(snap.items).toEqual([expect.objectContaining({ monthlyRate: 30000, hourlyRate: 125, employmentType: 'permanent', recordId: ids.w1, holidayId: hol.labour, holidayName: 'วันแรงงานแห่งชาติ', date: d('05-01'), normalHours: 8, otHours: 2, entitled: true, workMultiplier: 1, otMultiplier: 3 })]);
    const z2 = s.get(ids.ZH2!)!;
    expect(JSON.parse(z2.calc_json).holiday).toMatchObject({ workAmount: 2000, otAmount: 0, items: [expect.objectContaining({ entitled: false, workMultiplier: 2 })] });
    expect(z2.gross).toBe(baseline.get(ids.ZH2!)!.gross + 2000);
    const locked = ['w1', 'w2', 'w6a', 'w6b', 'w7', 'w8'].map((k) => ids[k]!).sort((a, b) => a - b);
    expect(H.sql(`SELECT id, payroll_period_id FROM holiday_work_records WHERE payroll_period_id IS NOT NULL ORDER BY id`)).toEqual(locked.map((id) => ({ id, payroll_period_id: period })));
  });

  it('BLOCKER 1: each holiday is paid at the salary in force on its work date (30,000 before the 16th, 36,000 from it)', async () => {
    const z6 = slips().get(ids.ZH6!)!;
    const snap = JSON.parse(z6.calc_json).holiday;
    expect(snap.items.map((x: Record<string, unknown>) => [x.date, x.monthlyRate, x.hourlyRate, x.workAmount])).toEqual([
      [d('05-01'), 30000, 125, 1000],
      [d('05-20'), 36000, 150, 1200],
    ]);
    expect(snap.workAmount).toBe(2200);
    expect(JSON.parse(z6.lines_json).find((l: { code: string }) => l.code === 'HOLIDAY_WORK').amount).toBe(2200);
    expect(z6.gross).toBe(Math.round((baseline.get(ids.ZH6!)!.gross + 2200) * 100) / 100);
    // the period's existing salary split is unchanged by the holiday work
    const base = (x: Slip) => JSON.stringify((JSON.parse(x.lines_json) as Array<{ code: string }>).filter((l) => l.code.startsWith('BASE')));
    expect(base(z6)).toBe(base(baseline.get(ids.ZH6!)!));
  });

  it('BLOCKER 2: the rule follows employees.employment_type exactly (not the probation status)', async () => {
    const s = slips();
    const item = (code: string) => JSON.parse(s.get(ids[code]!)!.calc_json).holiday.items[0];
    expect(item('ZH7')).toMatchObject({ employmentType: 'probation', ruleId: ids.ruleProbation, workMultiplier: 1.5, workAmount: 1500 });
    expect(item('ZH8')).toMatchObject({ employmentType: 'permanent', ruleId: ids.rulePermanent, workMultiplier: 1, workAmount: 1000 });
  });

  it('REGRESSION: employees without holiday work get exactly the baseline payslip', async () => {
    const s = slips();
    // ZH3: nothing changed · ZH5 / ZH9: holiday work recorded, approved and then cancelled before payroll
    // The calculation snapshot is identical except the working-day figures of the daily attendance, which follow the
    // company calendar: the holiday approved after the baseline (d('05-20'), a weekday of the period) is one expected
    // working day less, with a new attendance version. Amounts and lines are byte-identical.
    const withoutDaily = (calc: string) => {
      const x = JSON.parse(calc);
      const { expectedWorkDays, daily, ...rest } = x.attendance;
      return { calc: { ...x, attendance: rest }, expectedWorkDays: expectedWorkDays as number, version: daily.version as string };
    };
    for (const code of ['ZH3', 'ZH5', 'ZH9']) {
      const a = baseline.get(ids[code]!)!;
      const b = s.get(ids[code]!)!;
      expect({ net: b.net, gross: b.gross, sso: b.sso, tax: b.tax, lines: b.lines_json }, code).toEqual({ net: a.net, gross: a.gross, sso: a.sso, tax: a.tax, lines: a.lines_json });
      const [da, db] = [withoutDaily(a.calc_json), withoutDaily(b.calc_json)];
      expect(db.calc, code).toEqual(da.calc);
      expect(db.expectedWorkDays, code).toBe(da.expectedWorkDays - 1);
      expect(db.version, code).not.toBe(da.version);
    }
    // ZH4: the rejected holiday-work record pays nothing; the approved OT request is paid once as normal OT (3 h × 3 × 125)
    const z4 = JSON.parse(s.get(ids.ZH4!)!.lines_json) as Array<{ code: string; amount: number }>;
    expect(z4.filter((l) => l.code.startsWith('HOLIDAY'))).toEqual([]);
    expect(z4.find((l) => l.code === 'OT')?.amount).toBe(1125);
    expect(s.get(ids.ZH4!)!.gross).toBe(baseline.get(ids.ZH4!)!.gross + 1125);
  });

  it('recalculation (repeated and concurrent) gives identical amounts and never pays a record twice', async () => {
    const before = JSON.stringify([...slips()].sort((a, b) => a[0] - b[0]).map(([e, x]) => [e, x.net, x.lines_json]));
    expect((await payroll().post(`/api/payroll/periods/${period}/calculate`)).status).toBe(200);
    await Promise.all([1, 2].map(() => payroll().post(`/api/payroll/periods/${period}/calculate`)));
    const after = slips();
    expect(JSON.stringify([...after].sort((a, b) => a[0] - b[0]).map(([e, x]) => [e, x.net, x.lines_json]))).toBe(before);
    const holidayLines = [...after.values()].flatMap((x) => JSON.parse(x.lines_json) as Array<{ code: string }>).filter((l) => l.code.startsWith('HOLIDAY'));
    expect(holidayLines).toHaveLength(6); // ZH1 work + OT, ZH2, ZH6 (one line for both days), ZH7, ZH8 work
  });

  it('payslip archive keeps the replaced versions unchanged (baseline amounts are archived, not altered)', async () => {
    const archived = H.sql(`SELECT employee_id, net FROM payslip_archive WHERE period_id = ${period} AND reason = 'reopen' ORDER BY employee_id`) as Array<{ employee_id: number; net: number }>;
    expect(archived).toEqual([...baseline.values()].sort((a, b) => a.employee_id - b.employee_id).map((x) => ({ employee_id: x.employee_id, net: x.net })));
  });
});

describe('after calculation: history is protected', () => {
  it('locked holiday work cannot be cancelled; the holiday cannot be moved, deactivated or deleted', async () => {
    expect((await staff().post(`/api/holidays/work/${ids.w1}/cancel`, { reason: 'zz try after payroll' })).status).toBe(409);
    expect((await staff().put(`/api/holidays/${hol.labour}`, { holiday_date: d('05-02') })).status).toBe(409);
    expect((await staff().put(`/api/holidays/${hol.labour}`, { holiday_type: 'traditional' })).status).toBe(409);
    expect((await staff().put(`/api/holidays/${hol.labour}`, { source_reference: 'changed' })).status).toBe(409);
    expect((await admin().post(`/api/holidays/${hol.labour}/deactivate`, { reason: 'zz try after payroll' })).status).toBe(409);
    expect((await admin().del(`/api/holidays/${hol.labour}`)).status).toBe(409);
    // the database itself refuses to delete a referenced holiday
    expect(() => H.sql(`DELETE FROM holidays WHERE id = ${hol.labour}`)).toThrow();
  });

  it('editing the holiday name afterwards does not change the issued payslip snapshot', async () => {
    const before = slips().get(ids.ZH1!)!;
    const r = await staff().put(`/api/holidays/${hol.labour}`, { name: 'วันแรงงานแห่งชาติ (แก้ชื่อ)' });
    expect(r.status, r.text).toBe(200);
    expect(r.body.status).toBe('approved'); // a name change keeps the approval
    const after = slips().get(ids.ZH1!)!;
    expect(after.calc_json).toBe(before.calc_json);
    expect(JSON.parse(after.calc_json).holiday.items[0].holidayName).toBe('วันแรงงานแห่งชาติ');
    expect(after.net).toBe(before.net);
  });

  it('approving the period keeps the records locked; audit trail is complete', async () => {
    expect((await admin().post(`/api/payroll/periods/${period}/approve`)).status).toBe(200);
    expect((await payroll().post(`/api/payroll/periods/${period}/reopen`)).status).toBe(409);
    expect(Number(H.sql(`SELECT COUNT(*) AS n FROM holiday_work_records WHERE payroll_period_id = ${period}`)[0]!.n)).toBe(6);
    // one query (each H.sql spawns wrangler, slow when every test file runs in parallel)
    const counts = new Map((H.sql("SELECT action, COUNT(*) AS n FROM audit_logs WHERE action LIKE 'holiday%' GROUP BY action") as Array<{ action: string; n: number }>).map((r) => [r.action, r.n]));
    for (const a of ['holiday.created', 'holiday.verified', 'holiday.approved', 'holiday.updated', 'holiday.deactivated', 'holiday.deleted', 'holiday.substitute_created', 'holiday.calendar_created', 'holiday_work.created', 'holiday_work.rejected', 'holiday_work.cancelled', 'holiday.pay_rule_created']) {
      expect(counts.get(a) ?? 0, a).toBeGreaterThan(0);
    }
  });
});
