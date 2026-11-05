// Pure payroll calculation (monthly). Thai statutory rules are parameterised through PayrollConfig
// so rate changes (e.g. the social-security wage ceiling) are a settings change, not a code change.

export interface PayrollConfig {
  ssoRate: number; // 0.05
  ssoMinWage: number; // 1650
  ssoMaxWage: number; // 15000
  otDivisorDays: number; // 30 (monthly salary / 30 / hours per day = hourly rate)
  hoursPerDay: number; // 8
  personalAllowance: number; // 60000 per year
  expenseRate: number; // 0.5
  expenseCap: number; // 100000 per year
}

export const DEFAULT_PAYROLL_CONFIG: PayrollConfig = {
  ssoRate: 0.05,
  ssoMinWage: 1650,
  ssoMaxWage: 15000,
  otDivisorDays: 30,
  hoursPerDay: 8,
  personalAllowance: 60000,
  expenseRate: 0.5,
  expenseCap: 100000,
};

/** Thai personal income tax brackets: [upper bound of bracket, rate]. */
export const TAX_BRACKETS: ReadonlyArray<readonly [number, number]> = [
  [150000, 0],
  [300000, 0.05],
  [500000, 0.1],
  [750000, 0.15],
  [1000000, 0.2],
  [2000000, 0.25],
  [5000000, 0.3],
  [Infinity, 0.35],
];

export interface PayInput {
  baseSalary: number;
  overtime: Array<{ hours: number; rate: number }>;
  earnings: Array<{ code: string; name: string; amount: number; taxable: boolean; category?: string }>;
  deductions: Array<{ code: string; name: string; amount: number; category?: string }>;
  unpaidLeaveDays: number;
  /** Employee Welfare Fund rates (%) resolved by resolveEwf(); null = not applicable */
  ewf?: { employeeRate: number; employerRate: number; wageCap: number } | null;
  /** wage actually earned in the period (prorated / split by wageSegments); defaults to baseSalary */
  earnedWage?: number;
  /** salary lines replacing the single BASE line (e.g. probation / passed segments) */
  wageLines?: Array<{ code: string; name: string; amount: number }>;
  /** mid-month advance already paid in this month: deducted from net pay */
  advance?: number;
  /** mid-month round: an advance of earned wage only, statutory deductions happen at month-end */
  advanceOnly?: boolean;
  /** pay for approved holiday work (HOLIDAY_WORK / HOLIDAY_OT): taxable, outside the SSO / EWF wage like OT */
  holidayPay?: Array<{ code: 'HOLIDAY_WORK' | 'HOLIDAY_OT'; name: string; amount: number }>;
}

export interface PayLine {
  code: string;
  name: string;
  kind: 'earning' | 'deduction';
  amount: number;
  /** payroll preview column group of a pay component (allowance, commission, bonus, provident_fund, other) */
  category?: string;
}

export interface PayResult {
  baseSalary: number;
  otAmount: number;
  earnings: number;
  unpaidLeave: number;
  gross: number;
  sso: number;
  tax: number;
  deductions: number;
  net: number;
  /** EWF deducted from the employee (part of deductions and a payslip line) */
  ewfEmployee: number;
  /** EWF employer contribution: recorded separately, never deducted from net pay */
  ewfEmployer: number;
  /** mid-month advance deducted (part of deductions) */
  advance: number;
  /** holiday work + holiday OT (part of gross; 0 when the employee did no approved holiday work) */
  holidayPay: number;
  lines: PayLine[];
}

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export function socialSecurity(wage: number, cfg: PayrollConfig = DEFAULT_PAYROLL_CONFIG): number {
  if (wage <= 0) return 0;
  const base = Math.min(Math.max(wage, cfg.ssoMinWage), cfg.ssoMaxWage);
  return round2(base * cfg.ssoRate);
}

export function annualTax(taxableIncome: number): number {
  let tax = 0;
  let lower = 0;
  for (const [upper, rate] of TAX_BRACKETS) {
    if (taxableIncome <= lower) break;
    tax += (Math.min(taxableIncome, upper) - lower) * rate;
    lower = upper;
  }
  return round2(tax);
}

/** Monthly withholding using the annualised method on the current month's taxable income. */
export function monthlyWithholding(monthlyTaxable: number, monthlySso: number, cfg: PayrollConfig = DEFAULT_PAYROLL_CONFIG): number {
  const annual = monthlyTaxable * 12;
  const expense = Math.min(annual * cfg.expenseRate, cfg.expenseCap);
  const net = annual - expense - cfg.personalAllowance - monthlySso * 12;
  return round2(annualTax(Math.max(net, 0)) / 12);
}

export function calculatePay(input: PayInput, cfg: PayrollConfig = DEFAULT_PAYROLL_CONFIG): PayResult {
  const base = round2(input.baseSalary);
  const wage = round2(input.earnedWage ?? base);
  const statutory = !input.advanceOnly;
  const dailyRate = base / cfg.otDivisorDays;
  const hourly = dailyRate / cfg.hoursPerDay;
  const otAmount = round2(input.overtime.reduce((s, o) => s + o.hours * o.rate * hourly, 0));
  const unpaidLeave = round2(Math.min(input.unpaidLeaveDays * dailyRate, wage));
  const earnings = round2(input.earnings.reduce((s, e) => s + e.amount, 0));
  const taxableEarnings = input.earnings.filter((e) => e.taxable).reduce((s, e) => s + e.amount, 0);
  const holiday = (input.holidayPay ?? []).filter((x) => x.amount > 0).map((x) => ({ ...x, amount: round2(x.amount) }));
  const holidayPay = round2(holiday.reduce((s, x) => s + x.amount, 0));
  const gross = round2(wage - unpaidLeave + otAmount + holidayPay + earnings);
  const sso = statutory ? socialSecurity(wage - unpaidLeave, cfg) : 0;
  const taxable = wage - unpaidLeave + otAmount + holidayPay + taxableEarnings;
  const tax = statutory ? monthlyWithholding(taxable, sso, cfg) : 0;
  const other = round2(input.deductions.reduce((s, d) => s + d.amount, 0));
  const ewfWage = input.ewf && statutory ? (input.ewf.wageCap > 0 ? Math.min(wage - unpaidLeave, input.ewf.wageCap) : wage - unpaidLeave) : 0;
  const ewfEmployee = input.ewf && statutory ? round2(Math.max(ewfWage, 0) * input.ewf.employeeRate / 100) : 0;
  const ewfEmployer = input.ewf && statutory ? round2(Math.max(ewfWage, 0) * input.ewf.employerRate / 100) : 0;
  const advance = round2(input.advance ?? 0);
  const deductions = round2(sso + tax + other + ewfEmployee + advance);

  const lines: PayLine[] = input.wageLines?.length
    ? input.wageLines.map((l) => ({ code: l.code, name: l.name, kind: 'earning' as const, amount: round2(l.amount) }))
    : [{ code: 'BASE', name: 'เงินเดือน', kind: 'earning', amount: wage }];
  if (otAmount) lines.push({ code: 'OT', name: 'ค่าล่วงเวลา', kind: 'earning', amount: otAmount });
  for (const x of holiday) lines.push({ code: x.code, name: x.name, kind: 'earning', amount: x.amount });
  for (const e of input.earnings) lines.push({ code: e.code, name: e.name, kind: 'earning', amount: round2(e.amount), ...(e.category ? { category: e.category } : {}) });
  if (unpaidLeave) lines.push({ code: 'UNPAID', name: 'หักลาไม่รับค่าจ้าง', kind: 'deduction', amount: unpaidLeave });
  if (statutory) lines.push({ code: 'SSO', name: 'ประกันสังคม', kind: 'deduction', amount: sso });
  if (ewfEmployee) lines.push({ code: 'EWF', name: 'เงินสะสมกองทุนสงเคราะห์ลูกจ้าง', kind: 'deduction', amount: ewfEmployee });
  if (statutory) lines.push({ code: 'TAX', name: 'ภาษีหัก ณ ที่จ่าย', kind: 'deduction', amount: tax });
  for (const d of input.deductions) lines.push({ code: d.code, name: d.name, kind: 'deduction', amount: round2(d.amount), ...(d.category ? { category: d.category } : {}) });
  if (advance) lines.push({ code: 'ADV', name: 'หักเงินจ่ายล่วงหน้ากลางเดือน (Mid-month Advance)', kind: 'deduction', amount: advance });

  return { baseSalary: base, otAmount, earnings, unpaidLeave, gross, sso, tax, deductions, net: round2(gross - deductions), ewfEmployee, ewfEmployer, advance, holidayPay, lines };
}

// ---- Dates (calendar days, timezone independent) ------------------------------------------------
function utc(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}
export function addDays(date: string, n: number): string {
  return new Date(utc(date) + n * 86_400_000).toISOString().slice(0, 10);
}
/** Inclusive number of calendar days from a to b (0 when b < a). */
export function daysInclusive(a: string, b: string): number {
  return b < a ? 0 : Math.round((utc(b) - utc(a)) / 86_400_000) + 1;
}

// ---- Probation and earned wage ------------------------------------------------------------------
// Probation lasts 90 calendar days: the hire date is day 1, day 90 is the last probation day, day 91 is "passed".
export const PROBATION_DAYS = 90;
export function probationEndDate(hireDate: string): string {
  return addDays(hireDate, PROBATION_DAYS - 1);
}

export type ProbationStatus = 'probation' | 'passed' | 'passed_in_period';

export interface WageSegment {
  status: 'probation' | 'passed';
  start: string;
  end: string;
  /** calendar days in the segment */
  days: number;
  /** days paid on the 30-day base (a full period is always 30 paid days) */
  paidDays: number;
  rate: number;
  amount: number;
}

export interface WageInput {
  periodStart: string;
  periodEnd: string;
  hireDate: string;
  terminationDate: string | null;
  /** rate used when no salary-history row applies */
  baseSalary: number;
  /** approved salary history, any order: the rate in force on a day is the latest row with from <= day */
  history: ReadonlyArray<{ from: string; amount: number }>;
  /** mid_month pays only the probation days of the round (an advance) */
  mode: 'monthly' | 'mid_month';
  divisorDays: number;
}

export interface WageResult {
  segments: WageSegment[];
  wage: number;
  /** calendar days employed (and, for mid_month, still on probation) in the period */
  eligibleDays: number;
  periodDays: number;
  fullPeriod: boolean;
  probationEnd: string;
  probationStatus: ProbationStatus;
  /** monthly rate in force on the last eligible day (OT / unpaid-leave daily rate) */
  rate: number;
}

/**
 * Monthly rate in force on a day: the latest approved salary-history row with from <= day (any input order),
 * else the employee's base salary. Same rule as the segment rates of wageSegments.
 */
export function salaryOn(baseSalary: number, history: ReadonlyArray<{ from: string; amount: number }>, day: string): number {
  let rate = baseSalary;
  let since: string | null = null;
  for (const x of history) {
    if (x.from <= day && (since === null || x.from >= since)) {
      rate = x.amount;
      since = x.from;
    }
  }
  return round2(rate);
}

/**
 * Splits a period into wage segments at the probation boundary and at salary changes, and prices each segment on a
 * 30-day base. A fully employed monthly period always pays exactly 30 days, so splitting never over- or under-pays:
 * the last segment receives the remaining paid days. Partial periods (joiner / leaver) pay calendar days, capped at 30.
 */
export function wageSegments(w: WageInput): WageResult {
  const history = [...w.history].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  const rateOn = (day: string) => {
    let r = w.baseSalary;
    for (const x of history) if (x.from <= day) r = x.amount;
    return round2(r);
  };
  const probationEnd = probationEndDate(w.hireDate);
  const probationStatus: ProbationStatus = probationEnd >= w.periodEnd ? 'probation' : probationEnd < w.periodStart ? 'passed' : 'passed_in_period';
  const periodDays = daysInclusive(w.periodStart, w.periodEnd);
  const start = w.hireDate > w.periodStart ? w.hireDate : w.periodStart;
  let end = w.terminationDate && w.terminationDate < w.periodEnd ? w.terminationDate : w.periodEnd;
  if (w.mode === 'mid_month' && probationEnd < end) end = probationEnd;
  if (start > end) return { segments: [], wage: 0, eligibleDays: 0, periodDays, fullPeriod: false, probationEnd, probationStatus, rate: rateOn(w.periodEnd) };

  const cuts = new Set<string>();
  const passed = addDays(probationEnd, 1);
  if (passed > start && passed <= end) cuts.add(passed);
  for (const x of history) if (x.from > start && x.from <= end) cuts.add(x.from);
  const starts = [start, ...[...cuts].sort()];
  const segments: WageSegment[] = starts.map((s, i) => {
    const e = i + 1 < starts.length ? addDays(starts[i + 1] as string, -1) : end;
    const days = daysInclusive(s, e);
    return { status: s <= probationEnd ? 'probation' : 'passed', start: s, end: e, days, paidDays: days, rate: rateOn(s), amount: 0 };
  });

  const D = w.divisorDays;
  const fullPeriod = w.mode === 'monthly' && start === w.periodStart && end === w.periodEnd;
  if (fullPeriod) {
    const before = segments.slice(0, -1).reduce((a, x) => a + x.paidDays, 0);
    (segments[segments.length - 1] as WageSegment).paidDays = Math.max(0, D - before);
  } else {
    let excess = segments.reduce((a, x) => a + x.paidDays, 0) - D;
    for (let i = segments.length - 1; i >= 0 && excess > 0; i--) {
      const seg = segments[i] as WageSegment;
      const cut = Math.min(seg.paidDays, excess);
      seg.paidDays -= cut;
      excess -= cut;
    }
  }
  for (const seg of segments) seg.amount = seg.paidDays === D ? seg.rate : round2((seg.rate / D) * seg.paidDays);
  return {
    segments,
    wage: round2(segments.reduce((a, x) => a + x.amount, 0)),
    eligibleDays: daysInclusive(start, end),
    periodDays,
    fullPeriod,
    probationEnd,
    probationStatus,
    rate: rateOn(end),
  };
}

// ---- Employee Welfare Fund (กองทุนสงเคราะห์ลูกจ้าง) -----------------------------------------------
// Every legal parameter comes from System Settings (EwfConfig); nothing statutory is hard-coded here.

export interface EwfConfig {
  enabled: boolean;
  effectiveDate: string; // YYYY-MM-DD, '' = not set
  employeeRate: number; // %
  employerRate: number; // %
  nextRateDate: string; // YYYY-MM-DD, '' = no scheduled change
  nextEmployeeRate: number; // %
  nextEmployerRate: number; // %
  wageCap: number; // 0 = no cap
  minEmployeeCount: number; // 0 = every company
  exemptProvidentFund: boolean;
  providentFundComponent: string;
  exemptEquivalentWelfare: boolean;
}

export type EwfStatus = 'applied' | 'disabled' | 'not_effective' | 'below_min_employees' | 'exempt_provident_fund' | 'exempt_equivalent_welfare';

export interface EwfEmployeeContext {
  /** reference date of the payroll period (its pay date) */
  date: string;
  companyEmployeeCount: number;
  providentFundMember: boolean;
  equivalentWelfare: boolean;
}

/** Decides whether EWF applies to one employee in one period and which rates are in force on that date. */
export function resolveEwf(cfg: EwfConfig, ctx: EwfEmployeeContext): { status: EwfStatus; rates: { employeeRate: number; employerRate: number; wageCap: number } | null } {
  if (!cfg.enabled) return { status: 'disabled', rates: null };
  if (!cfg.effectiveDate || ctx.date < cfg.effectiveDate) return { status: 'not_effective', rates: null };
  if (cfg.minEmployeeCount > 0 && ctx.companyEmployeeCount < cfg.minEmployeeCount) return { status: 'below_min_employees', rates: null };
  if (cfg.exemptProvidentFund && ctx.providentFundMember) return { status: 'exempt_provident_fund', rates: null };
  if (cfg.exemptEquivalentWelfare && ctx.equivalentWelfare) return { status: 'exempt_equivalent_welfare', rates: null };
  const next = !!cfg.nextRateDate && ctx.date >= cfg.nextRateDate;
  return {
    status: 'applied',
    rates: { employeeRate: next ? cfg.nextEmployeeRate : cfg.employeeRate, employerRate: next ? cfg.nextEmployerRate : cfg.employerRate, wageCap: cfg.wageCap },
  };
}
