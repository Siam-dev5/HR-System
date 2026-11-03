import { describe, expect, it } from 'vitest';
import { addDays, calculatePay, daysInclusive, probationEndDate, wageSegments, DEFAULT_PAYROLL_CONFIG, type WageInput } from '../../src/shared/payroll';
import { analyzeGrid, normalizeHeader, normalizeRows, departmentMatches, profileFromMapping } from '../../src/shared/feishu';
import { parseCsv, readXlsx, writeXlsx, excelDate, type Cell } from '../../src/shared/xlsx';
import { DEFAULT_LAYOUT, PREVIEW_KEYS, normalizeLayout } from '../../src/shared/payroll-columns';

const base = (x: Partial<WageInput>): WageInput => ({
  periodStart: '2026-10-26', periodEnd: '2026-11-25', hireDate: '2020-01-01', terminationDate: null, baseSalary: 30000, history: [], mode: 'monthly', divisorDays: 30, ...x,
});
const contiguous = (segs: Array<{ start: string; end: string }>) => segs.every((s, i) => i === 0 || s.start === addDays(segs[i - 1]!.end, 1));

describe('probation dates (90 calendar days, timezone independent)', () => {
  it('hire date is day 1, day 90 is the last probation day, day 91 is passed', () => {
    expect(probationEndDate('2026-01-01')).toBe('2026-03-31'); // day 90
    expect(daysInclusive('2026-01-01', '2026-03-31')).toBe(90);
    expect(addDays(probationEndDate('2026-01-01'), 1)).toBe('2026-04-01'); // day 91
    expect(probationEndDate('2024-01-01')).toBe('2024-03-30'); // leap year February
    expect(probationEndDate('2026-12-15')).toBe('2027-03-14'); // across the year end
  });
  it('day 89 / 90 / 91 of the period boundary', () => {
    const hire = '2026-08-01';
    const end = probationEndDate(hire); // 2026-10-29
    expect(end).toBe('2026-10-29');
    // period ending on day 89: still probation · on day 90: still probation · on day 91: passed inside the period
    expect(wageSegments(base({ hireDate: hire, periodStart: '2026-10-01', periodEnd: addDays(end, -1) })).probationStatus).toBe('probation');
    expect(wageSegments(base({ hireDate: hire, periodStart: '2026-10-01', periodEnd: end })).probationStatus).toBe('probation');
    expect(wageSegments(base({ hireDate: hire, periodStart: '2026-10-01', periodEnd: addDays(end, 1) })).probationStatus).toBe('passed_in_period');
    expect(wageSegments(base({ hireDate: hire, periodStart: addDays(end, 1), periodEnd: addDays(end, 30) })).probationStatus).toBe('passed');
  });
});

describe('earned wage on a 30-day base', () => {
  it('passed employee, full period → exactly the monthly salary in one segment', () => {
    const w = wageSegments(base({}));
    expect(w.fullPeriod).toBe(true);
    expect(w.segments).toHaveLength(1);
    expect(w.wage).toBe(30000);
    expect(w.probationStatus).toBe('passed');
  });

  it('hire date on the first day of the period: full pay, probation the whole period', () => {
    const w = wageSegments(base({ hireDate: '2026-10-26' }));
    expect(w.fullPeriod).toBe(true);
    expect(w.wage).toBe(30000);
    expect(w.segments[0]!.status).toBe('probation');
  });

  it('probation completed during the month-end period: split before / after, no double or missing day', () => {
    const hire = '2026-08-01'; // day 90 = 2026-10-29, day 91 = 2026-10-30
    const w = wageSegments(base({ hireDate: hire }));
    expect(w.probationStatus).toBe('passed_in_period');
    expect(w.segments.map((s) => [s.status, s.start, s.end, s.days])).toEqual([
      ['probation', '2026-10-26', '2026-10-29', 4],
      ['passed', '2026-10-30', '2026-11-25', 27],
    ]);
    expect(contiguous(w.segments)).toBe(true);
    expect(w.segments.reduce((a, s) => a + s.days, 0)).toBe(daysInclusive('2026-10-26', '2026-11-25'));
    expect(w.segments.map((s) => s.paidDays)).toEqual([4, 26]); // 30 paid days in total
    expect(w.segments[0]!.amount).toBe(4000);
    expect(w.wage).toBe(30000); // same rate → exactly one month, never 31/30
  });

  it('a new approved rate from day 91 prices each segment at its own rate', () => {
    const w = wageSegments(base({ hireDate: '2026-08-01', baseSalary: 25000, history: [{ from: '2026-08-01', amount: 25000 }, { from: '2026-10-30', amount: 30000 }] }));
    expect(w.segments.map((s) => s.rate)).toEqual([25000, 30000]);
    expect(w.segments[0]!.amount).toBe(3333.33); // 25,000 / 30 × 4
    expect(w.segments[1]!.amount).toBe(26000); // 30,000 / 30 × 26
    expect(w.wage).toBe(29333.33);
    expect(w.rate).toBe(30000);
  });

  it('passing probation does not change the rate when no approved new rate exists', () => {
    const w = wageSegments(base({ hireDate: '2026-08-01' }));
    expect(new Set(w.segments.map((s) => s.rate))).toEqual(new Set([30000]));
  });

  it('February (28 days) and 31-day periods both pay exactly one month when fully employed', () => {
    expect(wageSegments(base({ periodStart: '2027-02-01', periodEnd: '2027-02-28' })).wage).toBe(30000);
    expect(wageSegments(base({ periodStart: '2026-12-01', periodEnd: '2026-12-31', hireDate: '2026-10-01' })).wage).toBe(30000); // split at 2026-12-29
  });

  it('joiner during the period: calendar days on the 30-day base', () => {
    const w = wageSegments(base({ hireDate: '2026-11-11' }));
    expect(w.fullPeriod).toBe(false);
    expect(w.eligibleDays).toBe(15);
    expect(w.wage).toBe(15000);
  });

  it('leaver during the period: paid up to the termination date', () => {
    const w = wageSegments(base({ terminationDate: '2026-11-04' }));
    expect(w.eligibleDays).toBe(10);
    expect(w.wage).toBe(10000);
    expect(wageSegments(base({ terminationDate: '2026-10-20' })).wage).toBe(0); // left before the period
  });

  it('a 31-day partial period is capped at 30 paid days', () => {
    const w = wageSegments(base({ periodStart: '2026-12-01', periodEnd: '2026-12-31', hireDate: '2020-01-01', terminationDate: '2026-12-31', history: [{ from: '2026-12-31', amount: 30000 }] }));
    expect(w.segments.reduce((a, s) => a + s.paidDays, 0)).toBeLessThanOrEqual(30);
  });
});

describe('two-round payroll for employees on probation', () => {
  const mid = { periodStart: '2026-10-26', periodEnd: '2026-11-10', mode: 'mid_month' as const };

  it('mid-month round pays probation days only (base / 30 × eligible days)', () => {
    const w = wageSegments(base({ ...mid, hireDate: '2026-10-01' })); // probation until 2026-12-29
    expect(w.eligibleDays).toBe(16);
    expect(w.wage).toBe(16000);
  });

  it('probation completed during the mid-month round: only the days before day 91 are advanced', () => {
    const w = wageSegments(base({ ...mid, hireDate: '2026-08-05' })); // day 90 = 2026-11-02
    expect(w.segments).toHaveLength(1);
    expect(w.segments[0]!.end).toBe('2026-11-02');
    expect(w.eligibleDays).toBe(8);
    expect(w.wage).toBe(8000);
  });

  it('employees who already passed probation get no mid-month round', () => {
    expect(wageSegments(base({ ...mid, hireDate: '2020-01-01' })).eligibleDays).toBe(0);
  });

  it('mid-month advance + month-end net = one month (no double payment)', () => {
    const cfg = DEFAULT_PAYROLL_CONFIG;
    const advanceWage = wageSegments(base({ ...mid, hireDate: '2026-10-01' })).wage;
    const advance = calculatePay({ baseSalary: 30000, earnedWage: advanceWage, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 0, advanceOnly: true }, cfg);
    expect(advance.sso).toBe(0);
    expect(advance.tax).toBe(0);
    expect(advance.net).toBe(16000);
    const full = calculatePay({ baseSalary: 30000, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 0 }, cfg);
    const monthEnd = calculatePay({ baseSalary: 30000, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 0, advance: advance.net }, cfg);
    expect(monthEnd.advance).toBe(16000);
    expect(monthEnd.lines.at(-1)).toMatchObject({ code: 'ADV', kind: 'deduction', amount: 16000 });
    expect(monthEnd.gross).toBe(full.gross); // statutory deductions still on the full month
    expect(monthEnd.sso).toBe(full.sso);
    expect(monthEnd.tax).toBe(full.tax);
    expect(advance.net + monthEnd.net).toBe(full.net);
  });

  it('existing single-line payslips are unchanged (BASE / SSO / TAX order)', () => {
    const r = calculatePay({ baseSalary: 16500, overtime: [{ hours: 3, rate: 1.5 }], earnings: [{ code: 'MEAL', name: 'ค่าอาหาร', amount: 1000, taxable: true }], deductions: [], unpaidLeaveDays: 1 });
    expect(r.lines.map((l) => l.code)).toEqual(['BASE', 'OT', 'MEAL', 'UNPAID', 'SSO', 'TAX']);
    expect(r.gross).toBe(17259.38);
    expect(r.advance).toBe(0);
  });
});

// Header rows mirror the real Feishu exports (band row "Basic information" + English header row, "(hr)" units).
const BAND = ['Name', 'Basic information', '', '', '', '', 'Attendance metrics', '', '', '', '', '', '', '', ''];
const HEAD_A = ['Name', 'Employee ID', 'Department', 'Employment date', 'Contracting company', 'Group', 'Expected working days', 'Expected working hours(hr)', 'Workday attendance', 'Actual working hours(hr)', 'Absence days', 'Absence hours(hr)', 'Total overtime duration(hr)', 'Personal leave（Unpaid）(hr)', 'Unpaid Sick Leave(hr)'];
const rowA = (code: string, ot: string | number = '0', extra: Partial<Record<number, Cell>> = {}): Cell[] => {
  const r: Cell[] = ['Test Person', code, 'ฝ่ายทดสอบ', '2024-07-01', 'Co', 'A', '22', '176.0', '21', '168.0', '0', '0.5', ot, '8', '-'];
  for (const [i, v] of Object.entries(extra)) r[Number(i)] = v as Cell;
  return r;
};

describe('Feishu attendance analysis', () => {
  it('normalizes headers: full-width brackets, units, spacing', () => {
    expect(normalizeHeader('Personal leave（Unpaid）(hr)')).toEqual({ key: 'personal leave(unpaid)', unit: 'hours' });
    expect(normalizeHeader('Lactation break(min)')).toEqual({ key: 'lactation break', unit: 'minutes' });
    expect(normalizeHeader('Maternity leave(days)')).toEqual({ key: 'maternity leave', unit: 'days' });
    expect(normalizeHeader(' Employee  ID ')).toEqual({ key: 'employee id', unit: null });
  });

  it('Format A (Expected Working Days) — detects header row, mapping and file period', () => {
    const grid: Cell[][] = [BAND, HEAD_A, rowA('ST001', '2.5'), rowA('ST002')];
    const a = analyzeGrid(grid, 'For Payroll System_20261026_20261103.xlsx');
    expect(a.issues).toEqual([]);
    expect(a.headerRow).toBe(1);
    expect(a.format).toBe('days');
    expect(a.layout).toBe('summary');
    expect([a.sourceStart, a.sourceEnd]).toEqual(['2026-10-26', '2026-11-03']);
    expect(a.mapping.employee_code).toBe(1);
    expect(a.mapping.unpaid_personal_leave_hours).toBe(13);
    expect(a.mapping.unpaid_sick_leave_hours).toBe(14);
    const rows = normalizeRows(grid, a);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.values).toMatchObject({ employee_code: 'ST001', expected_work_days: 22, actual_work_hours: 168, feishu_overtime_hours: 2.5, absence_minutes: 30, unpaid_personal_leave_hours: 8, unpaid_sick_leave_hours: null, hire_date: '2024-07-01' });
    expect(rows[0]!.raw[1]).toBe('ST001'); // original cells kept
    expect(rows[0]!.issues).toEqual([]);
  });

  it('Format B (Expected Working Hours only)', () => {
    const head = ['Name', 'Employee ID', 'Department ID', 'Expected working hours(hr)', 'Actual working hours(hr)', 'Total overtime duration(min)'];
    const a = analyzeGrid([head, ['A', 'FF001', 'D-01', '96', '90.5', '90']], 'For Payroll System+A_20261103_20261103.xlsx');
    expect(a.format).toBe('hours');
    const r = normalizeRows([head, ['A', 'FF001', 'D-01', '96', '90.5', '90']], a)[0]!;
    expect(r.values).toMatchObject({ external_department_id: 'D-01', expected_work_hours: 96, feishu_overtime_hours: 1.5 }); // minutes → hours
  });

  it('invalid header is reported, nothing is guessed', () => {
    const a = analyzeGrid([['foo', 'bar'], ['1', '2']], 'x.xlsx');
    expect(a.issues.map((i) => i.code)).toEqual(['no_header']);
    expect(normalizeRows([['foo']], a)).toEqual([]);
    const b = analyzeGrid([['Employee ID', 'Name'], ['E1', 'A']], 'x.csv');
    expect(b.issues.map((i) => i.code)).toEqual(['missing_expected']);
  });

  it('duplicate employee, invalid number / date and negative values are row errors', () => {
    const grid: Cell[][] = [HEAD_A, rowA('ST001'), rowA('st001'), rowA('ST003', 'abc'), rowA('ST004', '1', { 3: '2026-02-30' }), rowA('ST005', '-3'), rowA('ST006', '0', { 1: null })];
    const a = analyzeGrid(grid, 'x.xlsx');
    const rows = normalizeRows(grid, a);
    const codes = (i: number) => rows[i]!.issues.map((x) => x.code);
    expect(codes(0)).toEqual([]);
    expect(codes(1)).toEqual(['duplicate_employee']);
    expect(codes(2)).toEqual(['invalid_number']);
    expect(codes(3)).toEqual(['invalid_date']);
    expect(codes(4)).toEqual(['negative_value']);
    expect(codes(5)).toEqual(['missing_employee_id']);
  });

  it('daily layout rows are aggregated per employee', () => {
    const head = ['', 'Employee ID', 'Date', 'Days of expected attendance', 'Expected working hours(hr)', 'Days of actual attendance', 'Actual working hours(hr)', 'Total overtime duration(hr)'];
    const grid: Cell[][] = [head, ['', 'E1', '2026-05-01', '1', '8', '1', '8', '1'], ['', 'E1', '2026-05-02', '1', '8', '0', '0', '0.5'], ['', 'E2', '2026-05-01', '1', '8', '1', '7.5', '-']];
    const a = analyzeGrid(grid, 'ST ATD.xlsx');
    expect(a.layout).toBe('daily');
    const rows = normalizeRows(grid, a);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.values).toMatchObject({ employee_code: 'E1', expected_work_days: 2, actual_work_days: 1, actual_work_hours: 8, feishu_overtime_hours: 1.5 });
    expect(rows[0]!.days).toBe(2);
  });

  it('explicit mapping overrides auto-detection and profiles survive column re-ordering', () => {
    const head = ['รหัส', 'วันที่ต้องทำงาน', 'OT ชั่วโมง'];
    const auto = analyzeGrid([head, ['E1', '20', '3']], 'x.csv');
    expect(auto.issues.map((i) => i.code)).toContain('no_header');
    const head2 = ['Employee ID', 'วันที่ต้องทำงาน', 'OT ชั่วโมง'];
    const mapped = analyzeGrid([head2, ['E1', '20', '3']], 'x.csv', { expected_work_days: 1, feishu_overtime_hours: 2 });
    expect(mapped.format).toBe('days');
    const profile = profileFromMapping(mapped.headers, mapped.mapping);
    const reordered = ['OT ชั่วโมง', 'Employee ID', 'วันที่ต้องทำงาน'];
    const again = analyzeGrid([reordered, ['3', 'E1', '20']], 'y.csv', null, profile);
    expect(again.mapping).toMatchObject({ employee_code: 1, expected_work_days: 2, feishu_overtime_hours: 0 });
  });

  it('department text from Feishu matches the master department by name or code', () => {
    expect(departmentMatches('璐妍希 | 【运营部】ฝ่ายปฏิบัติการ | 【设计部】ฝ่ายกราฟฟิค', { code: 'OPS', name: 'ฝ่ายปฏิบัติการ' })).toBe(true);
    expect(departmentMatches('IAM DP | OPS', { code: 'OPS', name: 'Operations' })).toBe(true);
    expect(departmentMatches('แผนกไลฟ์สด', { code: 'HR', name: 'ฝ่ายทรัพยากรบุคคล' })).toBe(false);
  });
});

describe('XLSX / CSV', () => {
  it('writes and reads back a workbook (Thai text, numbers, empty cells)', async () => {
    const rows: Cell[][] = [['Employee ID', 'ชื่อ', 'OT'], ['E001', 'สมชาย <&> "ทดสอบ"', 2.5], ['E002', null, 0]];
    const sheets = await readXlsx(writeXlsx('งวด 2026-11', rows));
    expect(sheets[0]!.name).toBe('งวด 2026-11');
    expect(sheets[0]!.rows).toEqual([['Employee ID', 'ชื่อ', 'OT'], ['E001', 'สมชาย <&> "ทดสอบ"', 2.5], ['E002', null, 0]]);
  });
  it('rejects a non-xlsx file', async () => {
    await expect(readXlsx(new TextEncoder().encode('not a zip'))).rejects.toThrow();
  });
  it('Excel date serials are timezone independent', () => {
    expect(excelDate(45658)).toBe('2025-01-01');
  });
  it('parses quoted CSV with embedded commas, quotes, new lines and a BOM', () => {
    expect(parseCsv('﻿Employee ID,Name\r\nE1,"Doe, ""J""\nline2"\r\nE2,\n')).toEqual([['Employee ID', 'Name'], ['E1', 'Doe, "J"\nline2'], ['E2', null]]);
  });
});

describe('payroll preview layout validation', () => {
  it('accepts a re-ordered layout and appends columns that were not sent', () => {
    const l = normalizeLayout([{ key: 'net_pay', visible: true }, { key: 'emp_code', visible: false }]);
    expect(l?.[0]).toEqual({ key: 'net_pay', visible: true });
    expect(l).toHaveLength(PREVIEW_KEYS.length);
    expect(new Set(l?.map((c) => c.key))).toEqual(new Set(PREVIEW_KEYS));
  });
  it('rejects unknown, duplicate, malformed or fully hidden layouts', () => {
    expect(normalizeLayout([{ key: 'password', visible: true }])).toBeNull();
    expect(normalizeLayout([{ key: 'net_pay', visible: true }, { key: 'net_pay', visible: true }])).toBeNull();
    expect(normalizeLayout('x')).toBeNull();
    expect(normalizeLayout(DEFAULT_LAYOUT.map((c) => ({ ...c, visible: false })))).toBeNull();
    expect(normalizeLayout([{ key: 'net_pay', visible: 'yes' }])).toBeNull();
  });
});
