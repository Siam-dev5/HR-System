import { describe, expect, it } from 'vitest';
import {
  EMPLOYMENT_TYPES, MIN_TRADITIONAL_HOLIDAYS, WINDOW_YEARS, buddhistYear, classifyDay, exportGrid, holidayPay, holidayWindow, hourlyRate, inWindow, isIsoDate, isLeapYear, missingSubstitutes, parseWeeklyRest,
  priceHolidayWork, resolveRule, ruleProblems, thaiDate, traditionalCompliance, validateImport, weekday, type ApplicableHoliday, type ApplicableRule, type ComplianceHoliday, type HolidayWorkInput,
} from '../../src/shared/holidays';
import { calculatePay, salaryOn, wageSegments, DEFAULT_PAYROLL_CONFIG, type PayInput } from '../../src/shared/payroll';

describe('10-year holiday window', () => {
  it('is the current year and the next nine (2026 → 2035)', () => {
    expect(WINDOW_YEARS).toBe(10);
    expect(holidayWindow('2026-11-05')).toEqual({ from: 2026, to: 2035 });
    expect(inWindow('2026-01-01', { from: 2026, to: 2035 })).toBe(true);
    expect(inWindow('2035-12-31', { from: 2026, to: 2035 })).toBe(true);
    expect(inWindow('2036-01-01', { from: 2026, to: 2035 })).toBe(false);
    expect(inWindow('2025-12-31', { from: 2026, to: 2035 })).toBe(false);
  });
  it('rolls forward when the year changes', () => {
    expect(holidayWindow('2026-12-31')).toEqual({ from: 2026, to: 2035 });
    expect(holidayWindow('2027-01-01')).toEqual({ from: 2027, to: 2036 });
  });
});

describe('Thai Buddhist year display (dates stored Gregorian)', () => {
  it('adds 543 years and formats a Thai date', () => {
    expect(buddhistYear(2026)).toBe(2569);
    expect(buddhistYear(2035)).toBe(2578);
    expect(thaiDate('2026-05-01')).toBe('1 พ.ค. 2569');
    expect(thaiDate('2027-12-31')).toBe('31 ธ.ค. 2570');
  });
});

describe('dates and leap years', () => {
  it('accepts 29 February only in leap years', () => {
    expect(isLeapYear(2028)).toBe(true);
    expect(isLeapYear(2027)).toBe(false);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2027-02-29')).toBe(false);
    expect(isIsoDate('2026-04-31')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('26-05-01')).toBe(false);
  });
  it('weekday is timezone independent', () => {
    expect(weekday('2026-11-05')).toBe(4); // Thursday
    expect(weekday('2028-02-29')).toBe(2); // Tuesday
  });
  it('weekly rest days parse strictly', () => {
    expect(parseWeeklyRest('0,6')).toEqual([0, 6]);
    expect(parseWeeklyRest('6, 0')).toEqual([0, 6]);
    expect(parseWeeklyRest('0')).toEqual([0]);
    expect(parseWeeklyRest('7')).toBeNull();
    expect(parseWeeklyRest('0,0')).toBeNull();
  });
});

describe('day classification', () => {
  const central = (id: number, date: string, type: ApplicableHoliday['holiday_type'] = 'traditional'): ApplicableHoliday => ({ id, holiday_date: date, name: `C${id}`, holiday_type: type, company_id: null });
  const company = (id: number, date: string): ApplicableHoliday => ({ id, holiday_date: date, name: `K${id}`, holiday_type: 'company', company_id: 7 });
  it('workday, weekly rest day and holiday', () => {
    const hs = [central(1, '2027-05-03', 'national_labour')];
    expect(classifyDay('2027-05-04', hs, [0, 6]).kind).toBe('workday');
    expect(classifyDay('2027-05-08', hs, [0, 6])).toMatchObject({ kind: 'weekly_rest', holiday: null, weeklyRest: true });
    expect(classifyDay('2027-05-03', hs, [0, 6])).toMatchObject({ kind: 'holiday', holiday: { id: 1, type: 'national_labour', companyCalendar: false } });
  });
  it('a company holiday wins over a national one on the same day', () => {
    expect(classifyDay('2027-06-01', [central(1, '2027-06-01'), company(2, '2027-06-01')], [0, 6]).holiday).toMatchObject({ id: 2, companyCalendar: true });
  });
  it('a holiday on a weekly rest day is still a holiday, flagged as rest day too', () => {
    const d = classifyDay('2027-05-01', [central(1, '2027-05-01', 'national_labour')], [0, 6]); // Saturday
    expect(d).toMatchObject({ kind: 'holiday', weeklyRest: true });
  });
  it('flags traditional / labour holidays on a rest day that have no substitute day', () => {
    const hs = [
      { ...central(1, '2027-05-01', 'national_labour'), substituted: false }, // Saturday
      { ...central(2, '2027-04-10'), substituted: true }, // Saturday, substituted
      { ...central(3, '2027-04-13'), substituted: false }, // Tuesday
      { ...company(4, '2027-04-17'), substituted: false }, // Saturday, company holiday: no statutory substitute
    ];
    expect(missingSubstitutes(hs, [0, 6])).toEqual([1]);
  });
});

describe('holiday pay rules (statutory minimums) and amounts', () => {
  it('minimum multipliers depend on entitlement', () => {
    expect(ruleProblems({ entitled: true, workMultiplier: 1, otMultiplier: 3 })).toEqual([]);
    expect(ruleProblems({ entitled: false, workMultiplier: 2, otMultiplier: 3 })).toEqual([]);
    expect(ruleProblems({ entitled: true, workMultiplier: 0.5, otMultiplier: 3 })).toHaveLength(1);
    expect(ruleProblems({ entitled: false, workMultiplier: 1.5, otMultiplier: 3 })).toHaveLength(1);
    expect(ruleProblems({ entitled: true, workMultiplier: 1, otMultiplier: 2.5 })).toHaveLength(1);
    expect(ruleProblems({ entitled: true, workMultiplier: Number.NaN, otMultiplier: 3 }).length).toBeGreaterThan(0);
  });
  it('hourly wage follows the configured divisor and hours per day (no hard-coded 30 / 240)', () => {
    expect(hourlyRate({ monthlyRate: 30000, divisorDays: 30, hoursPerDay: 8 })).toBe(125);
    expect(hourlyRate({ monthlyRate: 30000, divisorDays: 26, hoursPerDay: 8 })).toBeCloseTo(144.2307, 3);
  });
  it('normal work and holiday OT for entitled and non-entitled employees', () => {
    const b = { monthlyRate: 30000, divisorDays: 30, hoursPerDay: 8 };
    expect(holidayPay(b, { entitled: true, workMultiplier: 1, otMultiplier: 3 }, 8, 2)).toEqual({ hourly: 125, workAmount: 1000, otAmount: 750 });
    expect(holidayPay(b, { entitled: false, workMultiplier: 2, otMultiplier: 3 }, 8, 0)).toEqual({ hourly: 125, workAmount: 2000, otAmount: 0 });
    expect(holidayPay({ monthlyRate: 16500, divisorDays: 30, hoursPerDay: 8 }, { entitled: true, workMultiplier: 1, otMultiplier: 3 }, 4.5, 0).workAmount).toBe(309.38);
  });
  it('resolves the rule by company, employment type and date', () => {
    const rules: ApplicableRule[] = [
      { id: 1, company_id: null, employment_type: 'permanent', holiday_pay_entitled: 1, work_multiplier: 1, ot_multiplier: 3, effective_from: '2026-01-01', effective_to: null },
      { id: 2, company_id: 7, employment_type: 'permanent', holiday_pay_entitled: 1, work_multiplier: 1.5, ot_multiplier: 3, effective_from: '2026-01-01', effective_to: '2027-12-31' },
      { id: 3, company_id: null, employment_type: 'contract', holiday_pay_entitled: 0, work_multiplier: 2, ot_multiplier: 3, effective_from: '2027-06-01', effective_to: null },
    ];
    expect(resolveRule(rules, 7, 'permanent', '2027-05-01')?.id).toBe(2);
    expect(resolveRule(rules, 7, 'permanent', '2028-05-01')?.id).toBe(1);
    expect(resolveRule(rules, 8, 'permanent', '2027-05-01')?.id).toBe(1);
    expect(resolveRule(rules, 7, 'contract', '2027-05-01')).toBeNull();
    expect(resolveRule(rules, 7, 'intern', '2027-07-01')).toBeNull();
  });
});

describe('Excel / CSV import validation', () => {
  const window = { from: 2026, to: 2035 };
  const head = ['date', 'name', 'type', 'source_reference'];
  it('reports duplicates in the file and against the calendar, invalid dates, types and out-of-window years', () => {
    const r = validateImport([head,
      ['2027-01-01', 'วันขึ้นปีใหม่', 'traditional', 'ประกาศ 1'],
      ['2027-01-01', 'ซ้ำ', 'traditional', 'ประกาศ 1'],
      ['2027-02-29', 'ไม่มีวันนี้', 'traditional', 'x'],
      ['2027-05-03', 'วันแรงงาน', 'labour', 'x'],
      ['2040-01-01', 'นอกช่วง', 'traditional', 'x'],
      ['2027-04-13', 'มีอยู่แล้ว', 'traditional', 'x'],
      ['01/05/2570', 'วันแรงงานแห่งชาติ', 'วันแรงงานแห่งชาติ', ''],
      [null, null, null, null],
    ], { window, existingDates: new Set(['2027-04-13']) });
    expect(r.missingColumns).toEqual([]);
    expect(r.rows).toHaveLength(7); // the empty row is skipped
    const errs = (n: number) => r.rows.find((x) => x.rowNo === n)!.issues.filter((i) => i.level === 'error').map((i) => i.message).join(' | ');
    expect(errs(2)).toBe('');
    expect(errs(3)).toMatch(/ซ้ำกับแถว 2/);
    expect(errs(4)).toMatch(/วันที่ไม่ถูกต้อง/);
    expect(errs(5)).toMatch(/ประเภทไม่ถูกต้อง/);
    expect(errs(6)).toMatch(/นอกช่วง/);
    expect(errs(7)).toMatch(/มีวันหยุดวันนี้ในปฏิทินอยู่แล้ว/);
    // Buddhist-era d/m/yyyy and a Thai type label are understood; a missing source is only a warning
    const labour = r.rows.find((x) => x.rowNo === 8)!;
    expect(labour).toMatchObject({ date: '2027-05-01', type: 'national_labour' });
    expect(labour.issues).toEqual([{ level: 'warning', message: expect.stringMatching(/แหล่งที่มา/) }]);
  });
  it('requires the date, name and type columns', () => {
    expect(validateImport([['date', 'name']], { window, existingDates: new Set() }).missingColumns).toHaveLength(1);
  });
  it('an export can be imported back (same headers)', () => {
    const grid = exportGrid([{ holiday_date: '2027-12-05', name: 'วันพ่อแห่งชาติ', holiday_type: 'traditional', name_en: null, source_reference: 'ประกาศ', source_url: null, region: null, note: null, status: 'approved', verification: 'verified' }]);
    const r = validateImport(grid, { window, existingDates: new Set() });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ date: '2027-12-05', name: 'วันพ่อแห่งชาติ', type: 'traditional', issues: [] });
  });
  it('Excel serial dates are converted', () => {
    const r = validateImport([head, [46143, 'serial', 'company', 'x']], { window, existingDates: new Set() });
    expect(r.rows[0]!.date).toBe('2026-05-01');
  });
});

describe('payroll regression: calculatePay without holiday work is unchanged', () => {
  const inputs: PayInput[] = [
    { baseSalary: 30000, overtime: [], earnings: [], deductions: [], unpaidLeaveDays: 0 },
    { baseSalary: 16500, overtime: [{ hours: 3, rate: 1.5 }], earnings: [{ code: 'MEAL', name: 'ค่าอาหาร', amount: 1000, taxable: true }], deductions: [{ code: 'LOAN', name: 'เงินกู้', amount: 500 }], unpaidLeaveDays: 1 },
    { baseSalary: 85000, earnedWage: 41234.56, overtime: [{ hours: 7.5, rate: 2 }], earnings: [], deductions: [], unpaidLeaveDays: 0.5, ewf: { employeeRate: 0.25, employerRate: 0.25, wageCap: 20000 }, advance: 1234.5 },
  ];
  it('no holidayPay and an empty / zero holidayPay give identical results', () => {
    for (const x of inputs) {
      const before = calculatePay(x, DEFAULT_PAYROLL_CONFIG);
      expect(before.holidayPay).toBe(0);
      expect(calculatePay({ ...x, holidayPay: [] }, DEFAULT_PAYROLL_CONFIG)).toEqual(before);
      expect(calculatePay({ ...x, holidayPay: [{ code: 'HOLIDAY_WORK', name: 'x', amount: 0 }, { code: 'HOLIDAY_OT', name: 'y', amount: 0 }] }, DEFAULT_PAYROLL_CONFIG)).toEqual(before);
    }
  });
  it('holiday pay is taxable gross outside the SSO / EWF wage, with its own payslip lines', () => {
    const base = inputs[0]!;
    const without = calculatePay(base);
    const withHoliday = calculatePay({ ...base, holidayPay: [{ code: 'HOLIDAY_WORK', name: 'ค่าทำงานในวันหยุด', amount: 1000 }, { code: 'HOLIDAY_OT', name: 'ค่าล่วงเวลาในวันหยุด', amount: 750 }] });
    expect(withHoliday.holidayPay).toBe(1750);
    expect(withHoliday.gross).toBe(without.gross + 1750);
    expect(withHoliday.sso).toBe(without.sso);
    expect(withHoliday.tax).toBeGreaterThanOrEqual(without.tax);
    expect(withHoliday.lines.map((l) => l.code)).toEqual(['BASE', 'HOLIDAY_WORK', 'HOLIDAY_OT', 'SSO', 'TAX']);
  });
});

describe('BLOCKER 1: holiday pay uses the salary in force on each work date', () => {
  const permanent: ApplicableRule = { id: 1, company_id: null, employment_type: 'permanent', holiday_pay_entitled: 1, work_multiplier: 1, ot_multiplier: 3, effective_from: '2020-01-01', effective_to: null };
  const ctx = (history: Array<{ from: string; amount: number }>, baseSalary = 30000) => ({ companyId: 7, employmentType: 'permanent', baseSalary, history, divisorDays: 30, hoursPerDay: 8, rules: [permanent] });
  const work = (id: number, date: string, normal = 8, ot = 0): HolidayWorkInput => ({ id, holiday_id: 100 + id, work_date: date, normal_hours: normal, ot_hours: ot, holiday_name: `H${id}`, holiday_type: 'traditional' });
  const raise = [{ from: '2027-05-16', amount: 36000 }];
  const priced = (w: HolidayWorkInput[], c: ReturnType<typeof ctx>) => {
    const r = priceHolidayWork(w, c);
    if (!r.ok) throw new Error(r.reason);
    return r.snapshot;
  };

  it('1. 30,000 for the whole period, 8 h on a holiday → 125/h × 8 = 1,000', () => {
    const s = priced([work(1, '2027-05-10')], ctx([]));
    expect(s.items[0]).toMatchObject({ monthlyRate: 30000, hourlyRate: 125, workAmount: 1000, otAmount: 0, employmentType: 'permanent' });
    expect(s).toMatchObject({ divisorDays: 30, hoursPerDay: 8, workAmount: 1000, otAmount: 0 });
  });
  it('2. raised to 36,000 on the 16th, holiday worked on the 10th → old rate (1,000)', () => {
    expect(priced([work(1, '2027-05-10')], ctx(raise)).items[0]).toMatchObject({ monthlyRate: 30000, hourlyRate: 125, workAmount: 1000 });
  });
  it('3. raised to 36,000 on the 16th, holiday worked on the 20th → new rate 150/h (1,200)', () => {
    expect(priced([work(1, '2027-05-20')], ctx(raise)).items[0]).toMatchObject({ monthlyRate: 36000, hourlyRate: 150, workAmount: 1200 });
  });
  it('3b. worked on the effective date itself → new rate', () => {
    expect(priced([work(1, '2027-05-16')], ctx(raise)).items[0]!.monthlyRate).toBe(36000);
  });
  it('4. holidays before and after the raise in the same period: each priced at its own rate, kept per item', () => {
    const s = priced([work(1, '2027-05-01', 8, 2), work(2, '2027-05-20', 8, 2)], ctx(raise));
    expect(s.items.map((x) => [x.date, x.monthlyRate, x.hourlyRate, x.workAmount, x.otAmount])).toEqual([
      ['2027-05-01', 30000, 125, 1000, 750],
      ['2027-05-20', 36000, 150, 1200, 900],
    ]);
    expect(s).toMatchObject({ workAmount: 2200, otAmount: 1650 });
  });
  it('5. several salary-history rows in any order resolve to the right rate per day', () => {
    const shuffled = [{ from: '2027-05-16', amount: 36000 }, { from: '2026-01-01', amount: 28000 }, { from: '2027-05-05', amount: 32000 }];
    const s = priced([work(1, '2027-05-03'), work(2, '2027-05-10'), work(3, '2027-05-20')], ctx(shuffled, 99999));
    expect(s.items.map((x) => x.monthlyRate)).toEqual([28000, 32000, 36000]);
    // before the first history row the employee's base salary applies
    expect(priced([work(1, '2025-12-31')], ctx(shuffled, 27000)).items[0]!.monthlyRate).toBe(27000);
  });
  it('salaryOn agrees with the wage-segment rates (same rule as the existing salary split)', () => {
    const history = [{ from: '2027-05-16', amount: 36000 }, { from: '2026-01-01', amount: 28000 }, { from: '2027-05-05', amount: 32000 }];
    const w = wageSegments({ periodStart: '2027-04-26', periodEnd: '2027-05-25', hireDate: '2020-01-01', terminationDate: null, baseSalary: 25000, history, mode: 'monthly', divisorDays: 30 });
    for (const seg of w.segments) {
      expect(salaryOn(25000, history, seg.start)).toBe(seg.rate);
      expect(salaryOn(25000, history, seg.end)).toBe(seg.rate);
    }
    expect(w.segments.map((x) => x.rate)).toEqual([28000, 32000, 36000]);
  });
  it('uses divisor days and hours per day from settings', () => {
    const s = priced([work(1, '2027-05-20')], { ...ctx(raise), divisorDays: 26, hoursPerDay: 7 });
    expect(s.items[0]!.workAmount).toBe(Math.round((36000 / 26 / 7) * 8 * 100) / 100);
  });
});

describe('BLOCKER 2: employment type → pay rule mapping', () => {
  const rule = (id: number, type: string, entitled: 0 | 1, work: number): ApplicableRule => ({ id, company_id: null, employment_type: type, holiday_pay_entitled: entitled, work_multiplier: work, ot_multiplier: 3, effective_from: '2020-01-01', effective_to: null });
  const rules = [rule(1, 'permanent', 1, 1), rule(2, 'contract', 0, 2), rule(3, 'probation', 1, 1.5), rule(4, 'intern', 0, 2.5)];
  it('the supported types are exactly the employee-form options', () => {
    expect([...EMPLOYMENT_TYPES]).toEqual(['permanent', 'contract', 'probation', 'intern']);
  });
  it('every supported type resolves to its own rule, never another type', () => {
    for (const [i, t] of EMPLOYMENT_TYPES.entries()) expect(resolveRule(rules, 7, t, '2027-05-01')?.id, t).toBe(i + 1);
  });
  it('no fallback: a type without a rule gets none (calculation is refused instead of using another rule)', () => {
    expect(resolveRule(rules.filter((r) => r.employment_type !== 'probation'), 7, 'probation', '2027-05-01')).toBeNull();
    const r = priceHolidayWork([{ id: 1, holiday_id: 1, work_date: '2027-05-01', normal_hours: 8, ot_hours: 0, holiday_name: 'x', holiday_type: 'traditional' }], { companyId: 7, employmentType: 'intern', baseSalary: 30000, history: [], divisorDays: 30, hoursPerDay: 8, rules: rules.slice(0, 3) });
    expect(r).toEqual({ ok: false, reason: 'no_rule', date: '2027-05-01' });
  });
  it('unknown or differently written values are never mapped', () => {
    for (const bad of ['Permanent', ' permanent', 'PERMANENT', 'full_time', 'พนักงานประจำ', '', 'active']) {
      expect(resolveRule(rules, 7, bad, '2027-05-01'), JSON.stringify(bad)).toBeNull();
      const r = priceHolidayWork([{ id: 1, holiday_id: 1, work_date: '2027-05-01', normal_hours: 8, ot_hours: 0, holiday_name: 'x', holiday_type: 'traditional' }], { companyId: 7, employmentType: bad, baseSalary: 30000, history: [], divisorDays: 30, hoursPerDay: 8, rules });
      expect(r).toMatchObject({ ok: false, reason: 'unknown_employment_type' });
    }
  });
  it('each type is priced with its own multiplier and recorded in the snapshot', () => {
    for (const t of EMPLOYMENT_TYPES) {
      const r = priceHolidayWork([{ id: 1, holiday_id: 1, work_date: '2027-05-01', normal_hours: 8, ot_hours: 0, holiday_name: 'x', holiday_type: 'traditional' }], { companyId: 7, employmentType: t, baseSalary: 30000, history: [], divisorDays: 30, hoursPerDay: 8, rules });
      if (!r.ok) throw new Error(t);
      const expected = rules.find((x) => x.employment_type === t)!;
      expect(r.snapshot.items[0]).toMatchObject({ employmentType: t, ruleId: expected.id, workMultiplier: expected.work_multiplier, workAmount: 1000 * expected.work_multiplier });
    }
  });
});

describe('traditional-holiday compliance (warning only)', () => {
  let n = 0;
  const hol = (date: string, type: ComplianceHoliday['holiday_type'], status: ComplianceHoliday['status'] = 'approved'): ComplianceHoliday => ({ id: ++n, holiday_date: date, name: `${type} ${date}`, holiday_type: type, status });
  const traditional = (count: number) => Array.from({ length: count }, (_, i) => hol(`2027-${String(i + 1).padStart(2, '0')}-0${i < 9 ? 2 : 3}`, 'traditional'));
  it('warns when fewer than 13 approved traditional holidays (labour day included) exist', () => {
    const c = traditionalCompliance([...traditional(11), hol('2027-05-01', 'national_labour')], 2027);
    expect(MIN_TRADITIONAL_HOLIDAYS).toBe(13);
    expect(c).toMatchObject({ counted: 12, required: 13, ok: false, labourDayIssue: null });
    expect(c.message).toMatch(/น้อยกว่าขั้นต่ำ 13/);
  });
  it('13 counted is fine; company, local and substitute days are reported but not counted; drafts are not counted', () => {
    const c = traditionalCompliance([
      ...traditional(12), hol('2027-05-01', 'national_labour'),
      hol('2027-06-15', 'company'), hol('2027-06-16', 'company'), hol('2027-07-01', 'local'), hol('2027-08-16', 'substitute'),
      hol('2027-12-31', 'traditional', 'draft'), hol('2027-12-30', 'traditional', 'inactive'), hol('2026-12-31', 'traditional'),
    ], 2027);
    expect(c).toMatchObject({ counted: 13, ok: true, notCounted: { company: 2, local: 1, substitute: 1 }, drafts: 1 });
    expect(c.countedHolidays.some((x) => x.type === 'company')).toBe(false);
  });
  it('labour day is shown separately and checked', () => {
    expect(traditionalCompliance(traditional(13), 2027).labourDayIssue).toMatch(/ยังไม่มี/);
    expect(traditionalCompliance([hol('2027-05-03', 'national_labour')], 2027).labourDayIssue).toMatch(/ไม่ใช่วันที่ 1 พฤษภาคม/);
    expect(traditionalCompliance([hol('2027-05-01', 'national_labour'), hol('2027-05-01', 'national_labour')], 2027).labourDayIssue).toMatch(/2 รายการ/);
    expect(traditionalCompliance([hol('2027-05-01', 'national_labour')], 2027).labourDay).toHaveLength(1);
  });
  it('the same day in the central and the company calendar counts once', () => {
    expect(traditionalCompliance([hol('2027-04-13', 'traditional'), hol('2027-04-13', 'traditional')], 2027).counted).toBe(1);
  });
});
