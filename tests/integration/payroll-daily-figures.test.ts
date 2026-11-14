// Working-day figures of a payroll calculation without a Feishu period report — isolated local D1 with synthetic data
// only (companies ZZF / ZZG, employees ZF* / ZG*). Reproduces the production case of a mid-month round 26/10–10/11
// whose attendance came from an ATT (daily clock) file: Payroll Preview showed "-" for Expected Work Days and Actual
// Working Hours because only a Feishu period report filled them. The figures now come from the daily attendance
// (P2) and never change an amount. Checks: ATT import, employee code mapping, expected days from the company
// calendar (weekly rest days, approved holidays), employment start / end, days and hours worked, missing attendance,
// duplicate imports, the figures of the calculation in force (stale attendance until recalculated), company isolation
// and amounts identical with and without attendance.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/shared/xlsx';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const admin = () => c.admin as Client;
const payroll = () => c.payroll as Client;
const ids: Record<string, number> = {};
let n = 0;
const sha = (s: string) => s.padEnd(64, '0').slice(0, 64);
const HEAD = ['รหัสพนักงาน', 'วันที่', 'เวลาเข้า', 'เวลาออก', 'เครื่อง', 'หมายเหตุ'];
const csv = (lines: string[]) => parseCsv([HEAD.join(','), ...lines].join('\r\n'));
const importAtt = async (company: string, lines: string[]) => {
  n += 1;
  const r = await admin().post('/api/attendance-files', { company_id: ids[company], file_name: `att-${n}.csv`, file_type: 'csv', file_size: 1000, sha256: sha(`f${n}`), grid: csv(lines), idempotency_key: `zz-daily-figures-${n}`, confirm: true });
  expect(r.status, r.text).toBe(201);
  return r.body as { id: number; imported_count: number; duplicate_count: number; invalid_count: number };
};
const day = (code: string, date: string, inT = '08:00', outT = '17:00') => `${code},${date},${inT},${outT},HQ-01,`;
type Row = { emp_code: string; work_days: number | null; expected_work_days: number | null; actual_work_hours: number | null; base_salary: number; net_pay?: number };
const preview = async (p: number) => {
  const r = await payroll().get(`/api/payroll/periods/${p}/preview`);
  expect(r.status, r.text).toBe(200);
  return new Map((r.body.rows as Row[]).map((x) => [x.emp_code, x]));
};
const money = (p: number) => JSON.stringify(H.sql(`SELECT employee_id, base_salary, ot_amount, earnings, unpaid_leave, gross, sso, tax, deductions, net, advance, lines_json FROM payslips WHERE period_id = ${p} ORDER BY employee_id`));
const calcAtt = (p: number, code: string) => JSON.parse(String(H.sql(`SELECT json_extract(ps.calc_json, '$.attendance') AS a FROM payslips ps JOIN employees e ON e.id = ps.employee_id WHERE ps.period_id = ${p} AND e.emp_code = '${code}'`)[0]!.a));
const workedHours = (code: string, from: string, to: string) =>
  Math.round((Number(H.sql(`SELECT COALESCE(SUM(a.worked_minutes), 0) AS m FROM attendance_records a JOIN employees e ON e.id = a.employee_id WHERE e.emp_code = '${code}' AND a.work_date BETWEEN '${from}' AND '${to}' AND a.status IN ('present', 'late') AND a.clock_in IS NOT NULL`)[0]!.m) / 60) * 100) / 100;

beforeAll(async () => {
  H = await startHarness();
  for (const k of ['admin', 'payroll']) c[k] = new Client(H.baseUrl);
  await c.admin!.login('it_admin', H.passwords.it_admin);
  await c.payroll!.login('it_payroll', H.passwords.it_payroll);
}, 180_000);
afterAll(async () => {
  await H?.stop();
});

let pf = 0; // ZZF mid-month round 2026-10-26 … 2026-11-10 (Mon … Tue)
let pg = 0; // ZZG mid-month round, same dates
let moneyBefore = '';

describe('setup (synthetic companies ZZF / ZZG)', () => {
  it('companies with their own calendars: ZZF rests Sat + Sun with an approved holiday on Wed 4/11, ZZG rests on Sunday only', async () => {
    for (const code of ['ZZF', 'ZZG']) ids[code] = (await admin().post('/api/m/companies', { code, name: `zz_test ${code}`, active: true })).body.id;
    H.sql(`INSERT INTO holiday_calendars (code, name, country_code, company_id, weekly_rest_days) VALUES ('ZZF-CAL', 'zz_test ZZF', 'TH', ${ids.ZZF}, '0,6'), ('ZZG-CAL', 'zz_test ZZG', 'TH', ${ids.ZZG}, '0');
      INSERT INTO holidays (calendar_id, holiday_date, year, name, holiday_type, status, verification, source_reference) SELECT id, '2026-11-04', 2026, 'zz_test company day', 'company', 'approved', 'verified', 'zz_test announcement' FROM holiday_calendars WHERE code = 'ZZF-CAL';
      INSERT INTO holidays (calendar_id, holiday_date, year, name, holiday_type, status) SELECT id, '2026-11-05', 2026, 'zz_test draft day', 'company', 'draft' FROM holiday_calendars WHERE code = 'ZZF-CAL'`);
    const emp = async (code: string, co: string, x: Record<string, unknown> = {}) => {
      const r = await admin().post('/api/m/employees', { emp_code: code, first_name: 'zz_test', last_name: code, company_id: ids[co], hire_date: '2026-09-01', employment_type: 'probation', status: 'probation', base_salary: 30000, ...x });
      expect(r.status, r.text).toBe(201);
      ids[code] = r.body.id;
    };
    await emp('ZF1', 'ZZF'); // every working day, plus Saturday 7/11 (rest day) and the holiday 4/11 off
    await emp('ZF2', 'ZZF'); // 26–29/10 only, nothing after (missing attendance)
    await emp('ZF3', 'ZZF', { hire_date: '2026-11-02' }); // starts inside the round
    await emp('ZF4', 'ZZF'); // no record at all
    await emp('ZF5', 'ZZF', { hire_date: '2026-11-09' }); // starts 9/11
    await emp('ZG1', 'ZZG'); // another company, Mon–Sat
    const mk = async (co: string) => {
      const r = await payroll().post('/api/payroll/periods', { company_id: ids[co], code: `${co}-2026-11-M`, name: `zz ${co} mid-month`, kind: 'mid_month', start_date: '2026-10-26', end_date: '2026-11-10', pay_date: '2026-11-15' });
      expect(r.status, r.text).toBe(201);
      return r.body.id as number;
    };
    pf = await mk('ZZF');
    pg = await mk('ZZG');
  });

  it('before any attendance: the schedule is known (expected days), nothing worked yet', async () => {
    expect((await payroll().post(`/api/payroll/periods/${pf}/calculate`)).status).toBe(200);
    moneyBefore = money(pf);
    const rows = await preview(pf);
    // no record yet: the schedule is known (expected days), nothing worked
    expect(rows.get('ZF1')).toMatchObject({ expected_work_days: 11, work_days: 0, actual_work_hours: 0 });
  });
});

describe('ATT import → daily attendance → calculation → Preview', () => {
  const weekdays = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-11-02', '2026-11-03', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10'];
  it('imports the clock file by employee code (unknown codes and another company are refused)', async () => {
    const r = await importAtt('ZZF', [
      ...weekdays.map((d) => day('ZF1', d)),
      day('ZF1', '2026-11-07', '08:00', '12:00'), // Saturday: rest-day work
      ...['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'].map((d) => day('ZF2', d)),
      ...['2026-11-02', '2026-11-03', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10'].map((d) => day('ZF3', d)),
      day('ZF3', '2026-10-30'), // before the hire date
      day('ZG1', '2026-10-26'), // another company's employee in ZZF's file
      day('ZZ999', '2026-10-26'), // unknown code
    ]);
    expect(r).toMatchObject({ imported_count: 11 + 1 + 4 + 6 });
    expect(r.invalid_count).toBe(3);
    expect(Number(H.sql(`SELECT COUNT(*) AS n FROM attendance_records WHERE employee_id = ${ids.ZF1} AND source = 'import'`)[0]!.n)).toBe(12);
    await importAtt('ZZG', ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'].map((d) => day('ZG1', d)));
  });

  it('a calculated period keeps the figures of its calculation until it is recalculated (stale attendance is not shown as current)', async () => {
    const rows = await preview(pf);
    expect(rows.get('ZF1')).toMatchObject({ expected_work_days: 11, work_days: 0, actual_work_hours: 0 });
  });

  it('recalculation: expected days follow the calendar and employment dates; days and hours come from the records', async () => {
    expect((await payroll().post(`/api/payroll/periods/${pf}/calculate`)).status).toBe(200);
    const rows = await preview(pf);
    // 12 weekdays in the round minus the approved holiday (a draft holiday does not count); Saturday is worked but not expected
    expect(rows.get('ZF1')).toMatchObject({ expected_work_days: 11, work_days: 12, actual_work_hours: workedHours('ZF1', '2026-10-26', '2026-11-10') });
    expect(rows.get('ZF1')!.actual_work_hours).toBeGreaterThan(0);
    // missing attendance stays missing: 4 days worked out of 11
    expect(rows.get('ZF2')).toMatchObject({ expected_work_days: 11, work_days: 4, actual_work_hours: workedHours('ZF2', '2026-10-26', '2026-11-10') });
    // employment from 2/11: 6 expected days (4/11 holiday), the row before the hire date was refused
    expect(rows.get('ZF3')).toMatchObject({ expected_work_days: 6, work_days: 6 });
    // no record at all: the schedule is known, nothing was worked (not hidden, not invented)
    expect(rows.get('ZF4')).toMatchObject({ expected_work_days: 11, work_days: 0, actual_work_hours: 0 });
    // starts 9/11: two expected days
    expect(rows.get('ZF5')).toMatchObject({ expected_work_days: 2, work_days: 0 });
    // another company's employee is never in this period
    expect(rows.has('ZG1')).toBe(false);
    // the snapshot says which daily attendance it read
    expect(calcAtt(pf, 'ZF1')).toMatchObject({ source: 'requests', importId: null, expectedWorkDays: 11, workDays: 12, daily: { version: expect.stringMatching(/^av1:/), judgedThrough: '2026-11-10' } });
  });

  it('amounts are identical with and without attendance (the figures are display only)', () => {
    expect(money(pf)).toBe(moneyBefore);
  });

  it('weekly rest days come from the company calendar: ZZG rests on Sunday only', async () => {
    expect((await payroll().post(`/api/payroll/periods/${pg}/calculate`)).status).toBe(200);
    const rows = await preview(pg);
    // 16 days minus 2 Sundays; Saturday 31/10 counts as a working day there
    expect(rows.get('ZG1')).toMatchObject({ expected_work_days: 14, work_days: 6, actual_work_hours: workedHours('ZG1', '2026-10-26', '2026-11-10') });
    expect([...rows.keys()]).toEqual(['ZG1']);
  });

  it('a duplicate import changes nothing; a new day is used only after recalculation, with a new attendance version', async () => {
    const version = calcAtt(pf, 'ZF1').daily.version as string;
    const dup = await importAtt('ZZF', weekdays.map((d) => day('ZF1', d)));
    expect(dup).toMatchObject({ imported_count: 0, duplicate_count: 11 });
    expect(Number(H.sql(`SELECT COUNT(*) AS n FROM attendance_records WHERE employee_id = ${ids.ZF1}`)[0]!.n)).toBe(12);
    await importAtt('ZZF', [day('ZF2', '2026-10-30')]);
    expect((await preview(pf)).get('ZF2')).toMatchObject({ work_days: 4 }); // calculation in force
    expect((await payroll().post(`/api/payroll/periods/${pf}/calculate`)).status).toBe(200);
    const rows = await preview(pf);
    expect(rows.get('ZF2')).toMatchObject({ expected_work_days: 11, work_days: 5, actual_work_hours: workedHours('ZF2', '2026-10-26', '2026-11-10') });
    expect(rows.get('ZF1')).toMatchObject({ expected_work_days: 11, work_days: 12 });
    expect(calcAtt(pf, 'ZF1').daily.version).not.toBe(version);
    expect(money(pf)).toBe(moneyBefore);
    expect(Number(H.sql(`SELECT COUNT(*) AS n FROM payslips WHERE period_id = ${pf}`)[0]!.n)).toBe(5);
  });
});
