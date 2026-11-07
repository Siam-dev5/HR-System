import { describe, expect, it } from 'vitest';
import { columnValues, companyKey, matchEmployee, readCompanyRule, rowCompany, suggestCompany, type CompanyRule } from '../../src/shared/company-rules';
import { coversDate, exemptIssues, exemptionState, overlaps } from '../../src/shared/exemptions';
import { autoDailyMapping, findDailyHeaderRow, parseDailyRows } from '../../src/shared/feishu-daily';
import { addDays, dailySheet } from '../fixtures/feishu-report';

const COMPANIES = [
  { id: 3, code: 'ST001', name: 'STARLIVE ONLINE CO.,LTD' },
  { id: 4, code: 'DP001', name: 'IAMDP CO.,LTD.' },
  { id: 6, code: 'FF001', name: 'FLYING FISH E-COMMERCE (THAILAND) CO., LTD.' },
];
const START = '2026-09-26';
// a combined file: the Group column identifies the company (explicit rule); codes deliberately do not follow the company
const sheet = dailySheet(START, [
  { code: 'ZT001', group: 'Team Star', cells: ['Regular(09:00),Regular(18:00)', 'No record(-),No record(-)'] },
  { code: 'ZT002', group: 'Team IAMDP', cells: ['Late in5min(09:05),Regular(18:00)', 'Regular(21:58),Regular(07:01);Overtime(22:00-01:00)'] },
  { code: 'ZT003', group: 'FlyingFish', cells: ['Regular(08:58),Leave(13:00);Sick leave(4 hr,13:00-18:00)', '-'] },
  { code: 'ZT004', group: '', cells: ['Regular(09:00),Regular(18:00)', '-'] },
  { code: 'ZT005', group: 'Unknown team', cells: ['Regular(09:00),Regular(18:00)', '-'] },
]);
const hr = findDailyHeaderRow(sheet.rows);
const groupCol = (sheet.rows[hr] as string[]).indexOf('Group');
const rule: CompanyRule = { column: groupCol, values: { [companyKey('Team Star')]: 3, [companyKey('Team IAMDP')]: 4, [companyKey('FlyingFish')]: 6, [companyKey('Unknown team')]: null } };

describe('company of a row: combined file (three companies)', () => {
  const rows = sheet.rows.slice(hr + 1);
  it('each row gets the company of its rule value; empty and unmatched values have none', () => {
    expect(rows.map((r) => rowCompany('combined', null, rule, r))).toEqual([
      { state: 'ok', companyId: 3, value: 'Team Star' },
      { state: 'ok', companyId: 4, value: 'Team IAMDP' },
      { state: 'ok', companyId: 6, value: 'FlyingFish' },
      { state: 'missing', value: null },
      { state: 'unmatched', value: 'Unknown team' },
    ]);
  });
  it('without a rule column every row of a combined file is missing its company (never the selected company)', () => {
    expect(rowCompany('combined', 3, { column: null, values: {} }, rows[0]!)).toEqual({ state: 'missing', value: null });
    expect(rowCompany('combined', 3, null, rows[0]!)).toEqual({ state: 'missing', value: null });
  });
  it('the distinct values of the rule column with their row counts, in file order', () => {
    expect(columnValues(sheet.rows, hr, groupCol).map((v) => [v.value, v.rows])).toEqual([['Team Star', 1], ['Team IAMDP', 1], ['FlyingFish', 1], ['', 1], ['Unknown team', 1]]);
  });
  it('the parsed daily rows keep their source row, so every day of a person gets that person\'s company', () => {
    const parsed = parseDailyRows(sheet.rows, hr, autoDailyMapping(sheet.rows[hr]!)).rows;
    const companyOf = (code: string) => [...new Set(parsed.filter((p) => p.employee_code === code).map((p) => rowCompany('combined', null, rule, sheet.rows[p.source_row]!).state === 'ok' ? (rowCompany('combined', null, rule, sheet.rows[p.source_row]!) as { companyId: number }).companyId : null))];
    expect([companyOf('ZT001'), companyOf('ZT002'), companyOf('ZT003'), companyOf('ZT004')]).toEqual([[3], [4], [6], [null]]);
    // multiple daily statuses and overnight records are untouched by the company step
    const night = parsed.find((p) => p.employee_code === 'ZT002' && p.work_date === addDays(START, 1))!;
    expect(night).toMatchObject({ clock_in: '21:58', clock_out: '07:01', out_next_day: true });
    expect(night.day.events[0]).toMatchObject({ kind: 'overtime', overnight: true });
  });
});

describe('company of a row: separate file per company', () => {
  const rows = sheet.rows.slice(hr + 1);
  for (const chosen of [3, 4, 6]) {
    it(`company ${chosen} chosen: rows naming it are fine, rows naming another company conflict, unmatched values are refused`, () => {
      const got = rows.map((r) => rowCompany('single', chosen, rule, r).state);
      const expected = ['ok', 'ok', 'ok', 'ok', 'unmatched'].map((s, i) => (i < 3 ? ([3, 4, 6][i] === chosen ? 'ok' : 'conflict') : s));
      expect(got).toEqual(expected);
    });
  }
  it('without a company column every row belongs to the chosen company', () => {
    expect(rows.map((r) => rowCompany('single', 4, null, r))).toEqual(rows.map(() => ({ state: 'ok', companyId: 4, value: null })));
  });
});

describe('employee resolution by company + code', () => {
  const emps = [
    { id: 1, emp_code: 'ST63002', company_id: 3 },
    { id: 2, emp_code: 'ST65021', company_id: 4 }, // an IAMDP employee whose code starts with ST
    { id: 3, emp_code: 'X100', company_id: 3 },
    { id: 4, emp_code: 'X100', company_id: 6 }, // the same code in another company
  ];
  it('finds the employee only inside the row company', () => {
    expect(matchEmployee(emps, 3, 'st63002')).toEqual({ employee: emps[0] });
    expect(matchEmployee(emps, 4, 'ST65021')).toEqual({ employee: emps[1] });
  });
  it('the same code under different companies resolves to each company\'s own employee', () => {
    expect(matchEmployee(emps, 3, 'X100')).toEqual({ employee: emps[2] });
    expect(matchEmployee(emps, 6, 'X100')).toEqual({ employee: emps[3] });
  });
  it('a code of another company is a conflict (never cross-matched); an unknown code is nowhere', () => {
    expect(matchEmployee(emps, 3, 'ST65021')).toEqual({ elsewhere: [4] });
    expect(matchEmployee(emps, 4, 'ZZ-NOPE')).toEqual({ elsewhere: [] });
  });
});

describe('company suggestions are exact, never by prefix', () => {
  it('matches a company id, code or name exactly (case and spacing ignored)', () => {
    expect(suggestCompany(' st001 ', COMPANIES)).toEqual({ id: 3, ambiguous: false });
    expect(suggestCompany('IAMDP CO.,LTD.', COMPANIES)).toEqual({ id: 4, ambiguous: false });
    expect(suggestCompany('6', COMPANIES)).toEqual({ id: 6, ambiguous: false });
  });
  it('a prefix, a partial name or an employee code is not a company', () => {
    for (const v of ['ST', 'ST63002', 'Starlive', 'FlyingFish', 'DP', '']) expect(suggestCompany(v, COMPANIES).id).toBeNull();
  });
  it('a value naming two companies is ambiguous', () => {
    expect(suggestCompany('X', [{ id: 1, code: 'X', name: 'A' }, { id: 2, code: 'Y', name: 'x' }])).toEqual({ id: null, ambiguous: true });
  });
  it('rules from the browser are validated', () => {
    expect(readCompanyRule({ column: 6, values: [{ value: ' Team A ', company_id: 3 }, { value: 'B', company_id: null }] }, 120)).toEqual({ column: 6, values: { 'team a': 3, b: null } });
    expect(() => readCompanyRule({ column: 500, values: [] }, 120)).toThrow();
    expect(() => readCompanyRule({ column: 1, values: [{ value: 'A', company_id: 'x' }] }, 120)).toThrow();
    expect(readCompanyRule(null, 120)).toBeNull();
  });
});

describe('attendance exemption periods', () => {
  const today = '2026-10-15';
  it('active / future / expired / revoked', () => {
    expect(exemptionState({ effective_from: '2026-10-01', effective_to: null }, today)).toBe('active');
    expect(exemptionState({ effective_from: '2026-10-15', effective_to: '2026-10-15' }, today)).toBe('active');
    expect(exemptionState({ effective_from: '2026-11-01', effective_to: null }, today)).toBe('future');
    expect(exemptionState({ effective_from: '2026-01-01', effective_to: '2026-10-14' }, today)).toBe('expired');
    expect(exemptionState({ effective_from: '2026-01-01', effective_to: null, revoked_at: '2026-10-01 10:00:00' }, today)).toBe('revoked');
  });
  it('covers a date only inside its range and only when not revoked (inactive)', () => {
    const p = { effective_from: '2026-10-01', effective_to: '2026-10-31' };
    expect(['2026-09-30', '2026-10-01', '2026-10-31', '2026-11-01'].map((d) => coversDate(p, d))).toEqual([false, true, true, false]);
    expect(coversDate({ ...p, revoked_at: '2026-10-02' }, '2026-10-15')).toBe(false);
    expect(coversDate({ effective_from: '2026-10-01', effective_to: null }, '2030-01-01')).toBe(true);
  });
  it('overlapping periods (open ends are unbounded)', () => {
    expect(overlaps({ effective_from: '2026-01-01', effective_to: '2026-06-30' }, { effective_from: '2026-06-30', effective_to: null })).toBe(true);
    expect(overlaps({ effective_from: '2026-01-01', effective_to: '2026-06-29' }, { effective_from: '2026-06-30', effective_to: null })).toBe(false);
    expect(overlaps({ effective_from: '2026-01-01', effective_to: null }, { effective_from: '2030-01-01', effective_to: '2030-12-31' })).toBe(true);
  });
  const info = (removed: number) => ({ code: 'attendance_exempt', level: 'info', message: `removed ${removed}` });
  it('exempt employee with no punches: missing-punch warnings are dropped, nothing else', () => {
    const issues = [
      { code: 'no_record_in', level: 'warning', message: '' }, { code: 'no_record_out', level: 'warning', message: '' },
      { code: 'no_record_time_kept', level: 'info', message: '' }, { code: 'leave', level: 'info', message: '' },
    ];
    expect(exemptIssues(issues, info).map((i) => i.code)).toEqual(['no_record_time_kept', 'leave', 'attendance_exempt']);
    expect(exemptIssues(issues, info).at(-1)!.message).toBe('removed 2');
  });
  it('exempt employee with actual punches: issues kept (punches processed normally); errors are never removed', () => {
    const punched = [{ code: 'late', level: 'info', message: '' }, { code: 'early_leave', level: 'info', message: '' }];
    expect(exemptIssues(punched, info).map((i) => i.code)).toEqual(['late', 'early_leave', 'attendance_exempt']);
    const errors = [{ code: 'company_conflict', level: 'error', message: '' }, { code: 'unknown_employee', level: 'error', message: '' }, { code: 'pending_out', level: 'warning', message: '' }];
    expect(exemptIssues(errors, info).map((i) => i.code)).toEqual(['company_conflict', 'unknown_employee', 'attendance_exempt']);
  });
});
