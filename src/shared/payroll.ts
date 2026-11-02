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
  earnings: Array<{ code: string; name: string; amount: number; taxable: boolean }>;
  deductions: Array<{ code: string; name: string; amount: number }>;
  unpaidLeaveDays: number;
}

export interface PayLine {
  code: string;
  name: string;
  kind: 'earning' | 'deduction';
  amount: number;
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
  const dailyRate = base / cfg.otDivisorDays;
  const hourly = dailyRate / cfg.hoursPerDay;
  const otAmount = round2(input.overtime.reduce((s, o) => s + o.hours * o.rate * hourly, 0));
  const unpaidLeave = round2(Math.min(input.unpaidLeaveDays * dailyRate, base));
  const earnings = round2(input.earnings.reduce((s, e) => s + e.amount, 0));
  const taxableEarnings = input.earnings.filter((e) => e.taxable).reduce((s, e) => s + e.amount, 0);
  const gross = round2(base - unpaidLeave + otAmount + earnings);
  const sso = socialSecurity(base - unpaidLeave, cfg);
  const taxable = base - unpaidLeave + otAmount + taxableEarnings;
  const tax = monthlyWithholding(taxable, sso, cfg);
  const other = round2(input.deductions.reduce((s, d) => s + d.amount, 0));
  const deductions = round2(sso + tax + other);

  const lines: PayLine[] = [{ code: 'BASE', name: 'เงินเดือน', kind: 'earning', amount: base }];
  if (otAmount) lines.push({ code: 'OT', name: 'ค่าล่วงเวลา', kind: 'earning', amount: otAmount });
  for (const e of input.earnings) lines.push({ code: e.code, name: e.name, kind: 'earning', amount: round2(e.amount) });
  if (unpaidLeave) lines.push({ code: 'UNPAID', name: 'หักลาไม่รับค่าจ้าง', kind: 'deduction', amount: unpaidLeave });
  lines.push({ code: 'SSO', name: 'ประกันสังคม', kind: 'deduction', amount: sso });
  lines.push({ code: 'TAX', name: 'ภาษีหัก ณ ที่จ่าย', kind: 'deduction', amount: tax });
  for (const d of input.deductions) lines.push({ code: d.code, name: d.name, kind: 'deduction', amount: round2(d.amount) });

  return { baseSalary: base, otAmount, earnings, unpaidLeave, gross, sso, tax, deductions, net: round2(gross - deductions), lines };
}
