import { describe, expect, it } from 'vitest';
import { addMonths, formatTenure, inMidMonthRound, probationActions, probationTimeline, tenure, tenureEnd, thaiDate } from '../../src/shared/probation';
import { calculatePay, socialSecurity, wageSegments, DEFAULT_PAYROLL_CONFIG, type WageInput } from '../../src/shared/payroll';

const t = (from: string, to: string) => formatTenure(tenure(from, to));

describe('tenure (calendar years / months / days, no 30- or 365-day approximation)', () => {
  it('hire date itself is 0 ปี 0 เดือน 0 วัน; the day before the hire date has no tenure', () => {
    expect(t('2026-01-15', '2026-01-15')).toBe('0 ปี 0 เดือน 0 วัน');
    expect(t('2026-01-15', '2026-01-16')).toBe('0 ปี 0 เดือน 1 วัน');
    expect(tenure('2026-01-15', '2026-01-14')).toBeNull();
    expect(formatTenure(null)).toBe('-');
  });
  it('whole months and years', () => {
    expect(t('2026-01-15', '2026-02-15')).toBe('0 ปี 1 เดือน 0 วัน');
    expect(t('2020-03-10', '2026-11-06')).toBe('6 ปี 7 เดือน 27 วัน');
    expect(t('2018-01-02', '2026-01-02')).toBe('8 ปี 0 เดือน 0 วัน');
  });
  it('month boundary: a missing day of the month counts as its last day', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(t('2026-01-31', '2026-02-28')).toBe('0 ปี 1 เดือน 0 วัน');
    expect(t('2026-01-31', '2026-02-27')).toBe('0 ปี 0 เดือน 27 วัน');
    expect(t('2026-01-31', '2026-03-01')).toBe('0 ปี 1 เดือน 1 วัน');
    expect(t('2026-03-31', '2026-04-30')).toBe('0 ปี 1 เดือน 0 วัน');
  });
  it('leap years: 29 February', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(t('2024-02-29', '2025-02-28')).toBe('1 ปี 0 เดือน 0 วัน');
    expect(t('2024-02-29', '2028-02-29')).toBe('4 ปี 0 เดือน 0 วัน');
    expect(t('2024-02-28', '2024-03-01')).toBe('0 ปี 0 เดือน 2 วัน'); // 29 Feb exists in 2024
    expect(t('2025-02-28', '2025-03-01')).toBe('0 ปี 0 เดือน 1 วัน');
  });
  it('year boundary', () => {
    expect(t('2025-12-31', '2026-01-01')).toBe('0 ปี 0 เดือน 1 วัน');
    expect(t('2025-11-15', '2026-01-14')).toBe('0 ปี 1 เดือน 30 วัน');
    expect(addMonths('2025-11-30', 3)).toBe('2026-02-28');
  });
  it('a leaver is counted up to the last working day, everyone else up to today', () => {
    expect(tenureEnd('2026-11-06', '2026-06-30')).toBe('2026-06-30');
    expect(tenureEnd('2026-11-06', '2026-12-31')).toBe('2026-11-06');
    expect(tenureEnd('2026-11-06', null)).toBe('2026-11-06');
  });
  it('Thai date text for notifications (Buddhist year)', () => {
    expect(thaiDate('2026-11-29')).toBe('29 พ.ย. 2569');
    expect(thaiDate('2027-01-05')).toBe('5 ม.ค. 2570');
  });
});

describe('probation timeline (hire date = day 1, UTC date-only)', () => {
  const hire = '2026-01-01';
  it('day 1, 90, 91 and 120', () => {
    expect(probationTimeline(hire, '2026-01-01')).toEqual({ day: 1, day90: '2026-03-31', day91: '2026-04-01', day120: '2026-04-30' });
    expect(probationTimeline(hire, '2026-03-31').day).toBe(90);
    expect(probationTimeline(hire, '2026-04-01').day).toBe(91);
    expect(probationTimeline(hire, '2026-04-30').day).toBe(120);
    expect(probationTimeline(hire, '2025-12-31').day).toBe(0);
  });
  it('leap year, month and year boundaries', () => {
    expect(probationTimeline('2024-01-01', '2024-01-01')).toMatchObject({ day90: '2024-03-30', day120: '2024-04-29' }); // 29 Feb counted
    expect(probationTimeline('2026-11-15', '2026-11-15')).toMatchObject({ day90: '2027-02-12', day91: '2027-02-13', day120: '2027-03-14' });
    expect(probationTimeline('2026-10-31', '2026-10-31')).toMatchObject({ day90: '2027-01-28', day120: '2027-02-27' });
  });
  it('does not depend on the process timezone', () => {
    const before = process.env.TZ;
    for (const tz of ['UTC', 'Asia/Bangkok', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      expect(probationTimeline('2026-03-08', '2026-06-05')).toEqual({ day: 90, day90: '2026-06-05', day91: '2026-06-06', day120: '2026-07-05' });
      expect(t('2024-02-29', '2025-02-28')).toBe('1 ปี 0 เดือน 0 วัน');
    }
    process.env.TZ = before;
  });
});

describe('probation actions of the daily job', () => {
  const emp = (status: string, probation_end: string | null = null) => ({ hire_date: '2026-01-01', status, probation_end });
  // the date of day N for a hire date of 1 January 2026
  const at = (day: number) => new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);

  it('nothing before day 90', () => {
    expect(probationActions(emp('probation'), at(1), 7)).toEqual([]);
    expect(probationActions(emp('probation'), at(89), 7)).toEqual([]);
  });
  it('day 90: the review notice, due on day 90', () => {
    expect(probationActions(emp('probation'), at(90), 7)).toEqual([{ kind: 'day90_notice', due: '2026-03-31' }]);
  });
  it('days 91–119: reminders every 7 days after day 90, the latest due one only (no spam when runs were missed)', () => {
    expect(probationActions(emp('probation'), at(96), 7)).toEqual([{ kind: 'day90_notice', due: '2026-03-31' }]);
    expect(probationActions(emp('probation'), at(97), 7)).toEqual([{ kind: 'day90_notice', due: '2026-03-31' }, { kind: 'reminder', due: '2026-04-07' }]);
    expect(probationActions(emp('probation'), at(103), 7)[1]).toEqual({ kind: 'reminder', due: '2026-04-07' });
    expect(probationActions(emp('probation'), at(119), 7)[1]).toEqual({ kind: 'reminder', due: '2026-04-28' }); // day 118
  });
  it('the reminder cadence is a setting; 0 switches reminders off', () => {
    expect(probationActions(emp('probation'), at(100), 3)[1]).toEqual({ kind: 'reminder', due: '2026-04-09' }); // day 99
    expect(probationActions(emp('probation'), at(119), 0)).toEqual([{ kind: 'day90_notice', due: '2026-03-31' }]);
  });
  it('day 120 and later: status change, due on day 120', () => {
    expect(probationActions(emp('probation'), at(120), 7)).toEqual([{ kind: 'activate', due: '2026-04-30' }]);
    expect(probationActions(emp('probation'), at(200), 7)).toEqual([{ kind: 'activate', due: '2026-04-30' }]);
  });
  it('only status "probation" is ever acted on (resigned / terminated / active untouched)', () => {
    for (const s of ['active', 'resigned', 'terminated']) {
      expect(probationActions(emp(s), at(90), 7)).toEqual([]);
      expect(probationActions(emp(s), at(120), 7)).toEqual([]);
    }
  });
  it('a probation end recorded after day 120 (an extension) is never activated automatically', () => {
    expect(probationActions(emp('probation', '2026-06-30'), at(120), 7)).toEqual([{ kind: 'extended', due: '2026-06-30' }]);
    // the usual record (probation end = day 90) does not block it
    expect(probationActions(emp('probation', '2026-03-31'), at(120), 7)).toEqual([{ kind: 'activate', due: '2026-04-30' }]);
  });
});

// Payroll cycle: the engine decides the mid-month round from the hire date (wageSegments), never from the status.
// Rounds as configured in production: mid-month 26th–10th (paid by the 15th), month-end 26th–25th.
describe('payroll cycle: two rounds until day 90, one round from the next month', () => {
  const w = (x: Partial<WageInput>): WageInput => ({ periodStart: '', periodEnd: '', hireDate: '', terminationDate: null, baseSalary: 15000, history: [], mode: 'mid_month', divisorDays: 30, ...x });
  const round = (start: string, end: string, hireDate: string) => wageSegments(w({ periodStart: start, periodEnd: end, hireDate }));

  it('up to 90 days: the mid-month round pays (two rounds)', () => {
    const hire = '2026-10-01'; // day 90 = 2026-12-29
    expect(inMidMonthRound(hire, '2026-10-26', '2026-11-10')).toBe(true);
    expect(round('2026-10-26', '2026-11-10', hire).eligibleDays).toBe(16);
    expect(round('2026-11-26', '2026-12-10', hire).eligibleDays).toBe(15);
  });
  it('day 90 between the mid-month and the month-end round: both rounds stay for that month', () => {
    const hire = '2026-08-15'; // day 90 = 2026-11-12, after the 26 Oct – 10 Nov round, before month-end 25 Nov
    expect(probationTimeline(hire, hire).day90).toBe('2026-11-12');
    const mid = round('2026-10-26', '2026-11-10', hire);
    expect(mid.eligibleDays).toBe(16); // the whole round: nothing changes in the middle of the month
    expect(inMidMonthRound(hire, '2026-10-26', '2026-11-10')).toBe(true);
    // month-end of the same month pays the full month (the advance is deducted there)
    const monthEnd = wageSegments(w({ periodStart: '2026-10-26', periodEnd: '2026-11-25', hireDate: hire, mode: 'monthly' }));
    expect(monthEnd.wage).toBe(15000);
    expect(monthEnd.probationStatus).toBe('passed_in_period');
  });
  it('the next month: one round (the mid-month round starting after day 90 excludes the employee)', () => {
    const hire = '2026-08-15';
    expect(inMidMonthRound(hire, '2026-11-26', '2026-12-10')).toBe(false);
    expect(round('2026-11-26', '2026-12-10', hire).eligibleDays).toBe(0);
    expect(wageSegments(w({ periodStart: '2026-11-26', periodEnd: '2026-12-25', hireDate: hire, mode: 'monthly' })).wage).toBe(15000);
  });
  it('inMidMonthRound agrees with the engine for every hire date over a year (joiners mid-month included)', () => {
    const rounds = [['2026-10-26', '2026-11-10'], ['2026-11-26', '2026-12-10'], ['2026-12-26', '2027-01-10'], ['2027-02-26', '2027-03-10']] as const;
    for (let d = Date.UTC(2026, 4, 1); d <= Date.UTC(2027, 2, 10); d += 86_400_000) {
      const hire = new Date(d).toISOString().slice(0, 10);
      for (const [s, e] of rounds) expect(round(s, e, hire).eligibleDays > 0, `${hire} ${s}`).toBe(inMidMonthRound(hire, s, e));
    }
  });
});

// Social security as the engine calculates it today (policy item 3: the mid-month round is an advance without
// statutory deductions; month-end deducts the whole month once). Locked here so a change is a deliberate decision.
describe('social security in a two-round month (current rule, unchanged)', () => {
  it('salary 15,000: mid-month deducts 0, month-end deducts 750, the month totals 750', () => {
    const advance = calculatePay({ baseSalary: 15000, earnedWage: 7500, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 0, advanceOnly: true });
    const monthEnd = calculatePay({ baseSalary: 15000, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 0, advance: advance.net });
    expect(advance.sso).toBe(0);
    expect(monthEnd.sso).toBe(750);
    expect(advance.sso + monthEnd.sso).toBe(socialSecurity(15000));
    expect(advance.net + monthEnd.net).toBe(calculatePay({ baseSalary: 15000, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 0 }).net);
  });
  it('base and ceiling come from the configuration (no hard-coded ceiling)', () => {
    expect(socialSecurity(20000, { ...DEFAULT_PAYROLL_CONFIG, ssoMaxWage: 17500 })).toBe(875);
    expect(socialSecurity(20000, DEFAULT_PAYROLL_CONFIG)).toBe(750);
    expect(socialSecurity(1000, DEFAULT_PAYROLL_CONFIG)).toBe(82.5); // minimum base 1,650
  });
});
