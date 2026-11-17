// Payroll policy decided by management on 2026-11-16 (docs/HR-PAYROLL-POLICY.md §3 and §3.1):
//  - mid-month calendar entitlement: a round starting in a Thai month ending in "คม", employee hired before its 26th,
//    pays its calendar days (16) on the 30-day base, even when probation ends inside the round
//  - mid-month: no SSO, tax or EWF
//  - deductions only from approved unpaid leave and HR-confirmed absence, day by day, never twice on one day
//  - one rounding to 2 decimals
//  - the days actually worked never multiply the salary
import { describe, expect, it } from 'vitest';
import {
  calculatePay, midMonthCalendarEntitled, round2, thaiMonthOf, wageSegments, DEFAULT_PAYROLL_CONFIG, type WageInput,
} from '../../src/shared/payroll';
import {
  aggregateDaily, payrollDeductions, validateDaily, versionPayload,
  type DailyInput, type DailyLeave, type DailyRecord,
} from '../../src/shared/attendance-daily';

const w = (x: Partial<WageInput>): WageInput => ({
  periodStart: '2026-10-26', periodEnd: '2026-11-10', hireDate: '2026-09-01', terminationDate: null, baseSalary: 23000, history: [], mode: 'mid_month', divisorDays: 30, ...x,
});
/** the round 26th of `ym` to the 10th of the next month */
const round = (ym: string) => {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { periodStart: `${ym}-26`, periodEnd: `${next}-10` };
};

describe('mid-month calendar entitlement: the month of the round ends in "คม"', () => {
  const months: Array<[string, string, boolean]> = [
    ['2027-01', 'มกราคม', true], ['2027-02', 'กุมภาพันธ์', false], ['2027-03', 'มีนาคม', true], ['2027-04', 'เมษายน', false],
    ['2027-05', 'พฤษภาคม', true], ['2027-06', 'มิถุนายน', false], ['2027-07', 'กรกฎาคม', true], ['2027-08', 'สิงหาคม', true],
    ['2027-09', 'กันยายน', false], ['2026-10', 'ตุลาคม', true], ['2026-11', 'พฤศจิกายน', false], ['2026-12', 'ธันวาคม', true],
  ];
  it.each(months)('round starting %s (%s): entitled = %s', (ym, name, entitled) => {
    const r = round(ym);
    expect(thaiMonthOf(r.periodStart)).toBe(name);
    expect(midMonthCalendarEntitled(r.periodStart, `${ym}-01`)).toBe(entitled);
    // an employee on probation through the whole round, hired before the 26th
    const res = wageSegments(w({ ...r, hireDate: `${ym}-01`, baseSalary: 30000 }));
    expect(res.calendarEntitled).toBe(entitled);
    if (entitled) {
      expect(res.eligibleDays).toBe(16); // 26–31 + 1–10
      expect(res.wage).toBe(16000);
    }
  });
  it('a "คม" month gives 16 calendar days, a 30-day month 15 and February 13 or 14 (probation days, unchanged rule)', () => {
    expect(wageSegments(w({ ...round('2027-01'), hireDate: '2027-01-01' })).eligibleDays).toBe(16);
    expect(wageSegments(w({ ...round('2027-04'), hireDate: '2027-04-01' })).eligibleDays).toBe(15);
    expect(wageSegments(w({ ...round('2027-02'), hireDate: '2027-02-01' })).eligibleDays).toBe(13);
    expect(wageSegments(w({ ...round('2028-02'), hireDate: '2028-02-01' })).eligibleDays).toBe(14);
  });
});

describe('mid-month calendar entitlement: hire date', () => {
  it('hired before the 26th of the month: entitled', () => {
    expect(midMonthCalendarEntitled('2026-10-26', '2026-10-25')).toBe(true);
    expect(midMonthCalendarEntitled('2026-10-26', '2026-08-03')).toBe(true);
  });
  it('hired on the 26th: not entitled (paid from the hire date by the earlier rule)', () => {
    expect(midMonthCalendarEntitled('2026-10-26', '2026-10-26')).toBe(false);
    const res = wageSegments(w({ hireDate: '2026-10-26' }));
    expect(res.calendarEntitled).toBe(false);
    expect(res.eligibleDays).toBe(16); // from the hire date: the probation days of the round
  });
  it('hired after the 26th: not entitled, paid from the hire date', () => {
    const res = wageSegments(w({ hireDate: '2026-11-02', baseSalary: 30000 }));
    expect(res.calendarEntitled).toBe(false);
    expect(res.eligibleDays).toBe(9); // 2–10 Nov
    expect(res.wage).toBe(9000);
  });
  it('an employee who passed probation before the round is not paid by it (unchanged)', () => {
    const res = wageSegments(w({ hireDate: '2026-07-01' })); // day 90 = 2026-09-28
    expect(res.calendarEntitled).toBe(false);
    expect(res.eligibleDays).toBe(0);
    expect(res.wage).toBe(0);
  });
  it('a long-serving employee: the month-end round is unchanged (full month)', () => {
    expect(wageSegments(w({ mode: 'monthly', periodStart: '2026-10-26', periodEnd: '2026-11-25', hireDate: '2020-01-01' })).wage).toBe(23000);
  });
});

describe('probation during an entitled round', () => {
  it('passes inside the round (ST69054-like: hired 2026-08-03, day 90 = 31 Oct): 16 days, not 6', () => {
    const res = wageSegments(w({ hireDate: '2026-08-03' }));
    expect(res.probationStatus).toBe('passed_in_period');
    expect(res.calendarEntitled).toBe(true);
    expect(res.segments.map((s) => [s.status, s.paidDays])).toEqual([['probation', 6], ['passed', 10]]);
    expect(res.eligibleDays).toBe(16);
    expect(res.wage).toBe(12266.67); // 23,000 / 30 × 16 = 12,266.666… (one rounding)
    expect(round2(res.segments.reduce((a, s) => a + s.amount, 0))).toBe(res.wage);
  });
  it('still on probation through the round: 16 days', () => {
    expect(wageSegments(w({ hireDate: '2026-09-01', baseSalary: 20000 })).wage).toBe(10666.67);
  });
  it('salary history: a raise effective when probation is passed pays the new rate from its effective date only', () => {
    const res = wageSegments(w({ hireDate: '2026-08-03', baseSalary: 23000, history: [{ from: '2026-11-01', amount: 26000 }] }));
    expect(res.segments.map((s) => [s.start, s.end, s.rate, s.paidDays])).toEqual([
      ['2026-10-26', '2026-10-31', 23000, 6], ['2026-11-01', '2026-11-10', 26000, 10],
    ]);
    expect(res.wage).toBe(round2(23000 / 30 * 6 + 26000 / 30 * 10)); // 4,600 + 8,666.67
    expect(round2(res.segments.reduce((a, s) => a + s.amount, 0))).toBe(res.wage);
  });
  it('no salary history: the base salary is used, never a rate from outside the data', () => {
    expect(wageSegments(w({ hireDate: '2026-08-03', history: [] })).segments.every((s) => s.rate === 23000)).toBe(true);
  });
  it('termination inside the round: the earlier proration rule still applies (to the termination date)', () => {
    const res = wageSegments(w({ hireDate: '2026-09-01', baseSalary: 30000, terminationDate: '2026-11-04' }));
    expect(res.eligibleDays).toBe(10);
    expect(res.wage).toBe(10000);
  });
});

describe('rounding: one rounding to 2 decimals', () => {
  it('split segments add up to the wage rounded once (no drift between the steps)', () => {
    // 3 segments of 10,001/30: rounding each would give 3 × 1,000.10 = 3,000.30 vs exact 3,000.30; 7 days at 10,001
    for (const salary of [10001, 17777, 23333, 18000, 15555.55]) {
      const res = wageSegments(w({ hireDate: '2026-08-03', baseSalary: salary, history: [{ from: '2026-11-05', amount: salary + 1 }] }));
      const exact = res.segments.reduce((a, s) => a + (s.rate / 30) * s.paidDays, 0);
      expect(res.wage).toBe(round2(exact));
      expect(round2(res.segments.reduce((a, s) => a + s.amount, 0))).toBe(res.wage);
    }
  });
  it('every amount on the payslip has at most 2 decimals', () => {
    const pay = calculatePay({ baseSalary: 17777, earnedWage: 9481.07, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 1.5, absenceDays: 1, advanceOnly: true });
    for (const v of [pay.gross, pay.net, pay.unpaidLeave, ...pay.lines.map((l) => l.amount)]) expect(round2(v)).toBe(v);
  });
});

describe('mid-month statutory deductions', () => {
  it('no SSO, tax or EWF in the mid-month round, even with EWF rates and a high wage', () => {
    const pay = calculatePay({ baseSalary: 90000, earnedWage: 48000, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 0, advanceOnly: true, ewf: { employeeRate: 0.25, employerRate: 0.25, wageCap: 0 } });
    expect([pay.sso, pay.tax, pay.ewfEmployee, pay.ewfEmployer]).toEqual([0, 0, 0, 0]);
    expect(pay.lines.map((l) => l.code)).toEqual(['BASE']);
    expect(pay.net).toBe(48000);
  });
  it('the month-end round keeps SSO and tax (unchanged)', () => {
    const pay = calculatePay({ baseSalary: 23000, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 0 });
    expect(pay.sso).toBe(750);
    expect(pay.lines.map((l) => l.code)).toEqual(['BASE', 'SSO', 'TAX']);
  });
});

describe('exact regression figures (business reference files, Nov 2026 round 1)', () => {
  it('23,000 / month, 16 entitlement days, no unpaid day: 12,266.67 (Excel shows 12,267 after its whole-baht rounding)', () => {
    const wage = wageSegments(w({ hireDate: '2026-08-03', baseSalary: 23000 }));
    const pay = calculatePay({ baseSalary: wage.rate, earnedWage: wage.wage, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 0, advanceOnly: true });
    expect(pay.net).toBe(12266.67);
  });
  it('18,000 / month, 16 entitlement days, one approved unpaid leave day: payable 15 days = 9,000', () => {
    const wage = wageSegments(w({ hireDate: '2026-08-06', baseSalary: 18000 }));
    expect(wage.eligibleDays).toBe(16);
    const pay = calculatePay({ baseSalary: wage.rate, earnedWage: wage.wage, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 1, advanceOnly: true });
    expect(pay.unpaidLeave).toBe(600);
    expect(pay.gross).toBe(9000);
    expect(pay.net).toBe(9000);
    expect(pay.lines.find((l) => l.code === 'UNPAID')?.amount).toBe(600);
  });
  it('unpaid leave and absence are separate payslip lines, together one rounding, capped at the wage', () => {
    const pay = calculatePay({ baseSalary: 17000, earnedWage: 9066.67, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 1, absenceDays: 2, advanceOnly: true });
    expect(pay.unpaidLeave).toBe(round2(17000 / 30 * 3));
    expect(pay.lines.filter((l) => l.kind === 'deduction').map((l) => [l.code, l.amount])).toEqual([['UNPAID', 566.67], ['ABSENCE', 1133.33]]);
    const capped = calculatePay({ baseSalary: 30000, earnedWage: 1000, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 1, absenceDays: 5, advanceOnly: true });
    expect(capped.unpaidLeave).toBe(1000);
    expect(capped.net).toBe(0);
  });
});

// ---- deductions from attendance (pure) -------------------------------------------------------------------------
// Round 26 Oct – 10 Nov 2026: Mon 26 … Sat 31 Oct, Sun 1 Nov, Mon 2 … Sat 7, Sun 8, Mon 9, Tue 10. Rest Sat/Sun.
const E = { id: 1, company_id: 10, hire_date: '2026-08-06', termination_date: null };
const input = (over: Partial<DailyInput> = {}): DailyInput => ({
  periodStart: '2026-10-26', periodEnd: '2026-11-10', today: '2026-11-16',
  employees: [E], schedule: new Map(), calendars: new Map([[10, { weeklyRest: [0, 6], holidays: new Set<string>() }]]),
  records: [], leaves: [], exemptions: [], overtime: [], confirmed: new Set(), ...over,
});
let seq = 0;
const rec = (d: string, over: Partial<DailyRecord> = {}): DailyRecord => ({
  id: ++seq, employee_id: 1, work_date: d, status: 'present', clock_in: '09:00', clock_out: '18:00', clock_out_next_day: 0, shift_id: null,
  late_minutes: 0, early_leave_minutes: 0, worked_minutes: 480, revision: 0, ...over,
});
const leave = (id: number, from: string, to: string, paid: boolean | null, over: Partial<DailyLeave> = {}): DailyLeave => ({ source: 'request', id, employee_id: 1, start_date: from, end_date: to, status: 'approved', paid, ...over });
const ded = (i: DailyInput, from = '2026-10-26', to = '2026-11-10') => payrollDeductions(i, validateDaily(i), 1, from, to);

describe('deductions from attendance and approved leave', () => {
  it('approved unpaid leave on a workday: 1 day, traceable to the leave request', () => {
    const r = ded(input({ leaves: [leave(7, '2026-10-30', '2026-10-30', false)] }));
    expect(r).toMatchObject({ unpaidLeaveDays: 1, absenceDays: 0, items: [{ date: '2026-10-30', kind: 'unpaid_leave', days: 1, leave: { source: 'request', id: 7 } }] });
  });
  it('approved unpaid leave on a Saturday (31 Oct, rest day): nothing deducted', () => {
    expect(ded(input({ leaves: [leave(7, '2026-10-31', '2026-10-31', false)] })).unpaidLeaveDays).toBe(0);
  });
  it('a company holiday is never deducted', () => {
    const cal = new Map([[10, { weeklyRest: [0, 6], holidays: new Set(['2026-10-30']) }]]);
    expect(ded(input({ calendars: cal, leaves: [leave(7, '2026-10-29', '2026-10-30', false)] })).unpaidLeaveDays).toBe(1);
  });
  it('a schedule that works Saturdays makes Saturday deductible', () => {
    const schedule = new Map([['1|2026-10-31', { kind: 'shift' as const, shiftId: 3 }]]);
    expect(ded(input({ schedule, leaves: [leave(7, '2026-10-31', '2026-10-31', false)] })).unpaidLeaveDays).toBe(1);
  });
  it('paid leave, Feishu leave of unknown type, pending and rejected leave: nothing deducted', () => {
    const r = ded(input({ leaves: [
      leave(1, '2026-10-26', '2026-10-26', true),
      leave(2, '2026-10-27', '2026-10-27', null, { source: 'import' }),
      leave(3, '2026-10-28', '2026-10-28', false, { status: 'pending' }),
      leave(4, '2026-10-29', '2026-10-29', false, { status: 'rejected' }),
    ] }));
    expect(r).toMatchObject({ unpaidLeaveDays: 0, absenceDays: 0, items: [] });
  });
  it('a half-day unpaid leave counts 0.5; a 2.5-day leave over 3 workdays counts 2.5', () => {
    expect(ded(input({ leaves: [leave(1, '2026-10-26', '2026-10-26', false, { days: 0.5 })] })).unpaidLeaveDays).toBe(0.5);
    expect(ded(input({ leaves: [leave(1, '2026-11-02', '2026-11-04', false, { days: 2.5 })] })).unpaidLeaveDays).toBe(2.5);
  });
  it('a multi-day unpaid leave over a weekend counts its workdays only', () => {
    expect(ded(input({ leaves: [leave(1, '2026-10-29', '2026-11-03', false)] })).unpaidLeaveDays).toBe(4); // Thu, Fri, Mon, Tue
  });
  it('an absence record (status absent, no clock times): 1 day, traceable to the record', () => {
    const a = rec('2026-11-04', { status: 'absent', clock_in: null, clock_out: null, worked_minutes: null });
    expect(ded(input({ records: [a] }))).toMatchObject({ absenceDays: 1, items: [{ date: '2026-11-04', kind: 'absence', record: a.id }] });
  });
  it('an absence HR excused (cleared absent hold): not deducted', () => {
    const a = rec('2026-11-04', { status: 'absent', clock_in: null, clock_out: null, worked_minutes: null });
    expect(ded(input({ records: [a], excused: new Set(['1|2026-11-04']) })).absenceDays).toBe(0);
  });
  it('an absence that is not verified (absent with clock times = pending review): not deducted', () => {
    const a = rec('2026-11-04', { status: 'absent', clock_in: '09:00', clock_out: '18:00' });
    expect(ded(input({ records: [a] })).absenceDays).toBe(0);
  });
  it('a workday without any record is never inferred as an absence', () => {
    expect(ded(input({ records: [] }))).toMatchObject({ unpaidLeaveDays: 0, absenceDays: 0 });
  });
  it('missing clock-out (26 Oct, ST69055-like) or missing clock-in: never deducted', () => {
    const r = ded(input({ records: [rec('2026-10-26', { clock_out: null, worked_minutes: null }), rec('2026-10-27', { clock_in: null })] }));
    expect(r).toMatchObject({ unpaidLeaveDays: 0, absenceDays: 0, items: [] });
  });
  it('unpaid leave and an absence record on the same day: deducted once (as leave)', () => {
    const a = rec('2026-10-30', { status: 'absent', clock_in: null, clock_out: null, worked_minutes: null });
    const r = ded(input({ records: [a], leaves: [leave(7, '2026-10-30', '2026-10-30', false), leave(8, '2026-10-30', '2026-10-30', false)] }));
    expect(r.items).toEqual([{ date: '2026-10-30', kind: 'unpaid_leave', days: 1, leave: { source: 'request', id: 7 } }]);
    expect(r.unpaidLeaveDays + r.absenceDays).toBe(1);
  });
  it('present on a day of approved unpaid leave: not deducted (the employee worked; the review shows the warning)', () => {
    expect(ded(input({ records: [rec('2026-10-30')], leaves: [leave(7, '2026-10-30', '2026-10-30', false)] })).unpaidLeaveDays).toBe(0);
  });
  it('an exempt day is not deducted', () => {
    const a = rec('2026-11-04', { status: 'absent', clock_in: null, clock_out: null, worked_minutes: null });
    expect(ded(input({ records: [a], exemptions: [{ employee_id: 1, effective_from: '2026-11-01', effective_to: null, revoked_at: null }] })).absenceDays).toBe(0);
  });
  it('only days inside the paid window are deducted', () => {
    const r = ded(input({ leaves: [leave(1, '2026-10-26', '2026-11-10', false)] }), '2026-10-26', '2026-10-30');
    expect(r.unpaidLeaveDays).toBe(5);
  });
  it('approved unpaid leave on days still to come is deducted; an absence only once the day is judged', () => {
    const early = input({ today: '2026-10-28', leaves: [leave(1, '2026-11-05', '2026-11-05', false)], records: [rec('2026-10-29', { status: 'absent', clock_in: null, clock_out: null, worked_minutes: null })] });
    expect(ded(early)).toMatchObject({ unpaidLeaveDays: 1, absenceDays: 0 });
  });
  it('actual worked days never reduce or raise the entitlement: 13 worked days or 5 worked days give the same deductions (none)', () => {
    const many = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-09'].map((d) => rec(d));
    const few = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30'].map((d) => rec(d));
    const a = input({ records: many });
    const b = input({ records: few });
    expect(aggregateDaily(a, validateDaily(a))[0]!.actualWorkDays).toBe(13);
    expect(aggregateDaily(b, validateDaily(b))[0]!.actualWorkDays).toBe(5);
    expect(ded(a)).toMatchObject({ unpaidLeaveDays: 0, absenceDays: 0 });
    expect(ded(b)).toMatchObject({ unpaidLeaveDays: 0, absenceDays: 0 });
  });
  it('company isolation: another company\'s calendar does not apply (company 20 works Saturdays)', () => {
    const two = input({
      employees: [E, { id: 2, company_id: 20, hire_date: '2026-08-06', termination_date: null }],
      calendars: new Map([[10, { weeklyRest: [0, 6], holidays: new Set<string>() }], [20, { weeklyRest: [0], holidays: new Set<string>() }]]),
      leaves: [leave(1, '2026-10-31', '2026-10-31', false), { ...leave(2, '2026-10-31', '2026-10-31', false), employee_id: 2 }],
    });
    const v = validateDaily(two);
    expect(payrollDeductions(two, v, 1, '2026-10-26', '2026-11-10').unpaidLeaveDays).toBe(0);
    expect(payrollDeductions(two, v, 2, '2026-10-26', '2026-11-10').unpaidLeaveDays).toBe(1);
  });
});

describe('attendance version covers the deduction inputs', () => {
  const P = { id: 1, kind: 'mid_month', company_id: 10 };
  it('unchanged data without unpaid leave or excused absences: same payload as before (no new keys)', () => {
    const text = versionPayload(input({ leaves: [leave(1, '2026-10-26', '2026-10-26', true)] }), P);
    expect(text).not.toContain('unpaidLeave');
    expect(text).not.toContain('excused');
  });
  it('a change of the requested days of an approved unpaid leave or an excused absence changes the version', () => {
    const a = versionPayload(input({ leaves: [leave(1, '2026-10-26', '2026-10-26', false, { days: 1 })] }), P);
    const b = versionPayload(input({ leaves: [leave(1, '2026-10-26', '2026-10-26', false, { days: 0.5 })] }), P);
    expect(a).not.toBe(b);
    expect(versionPayload(input(), P)).not.toBe(versionPayload(input({ excused: new Set(['1|2026-11-04']) }), P));
  });
  it('an unpaid leave approved for a day after the judged day still changes the version', () => {
    const base = input({ today: '2026-10-28' });
    expect(versionPayload(base, P)).not.toBe(versionPayload({ ...base, leaves: [leave(1, '2026-11-05', '2026-11-05', false)] }, P));
  });
  it('the config used for the figures is the default 30-day base', () => {
    expect(DEFAULT_PAYROLL_CONFIG.otDivisorDays).toBe(30);
  });
});
