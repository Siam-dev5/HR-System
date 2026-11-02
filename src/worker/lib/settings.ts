import type { EwfConfig, PayrollConfig } from '../../shared/payroll';
import { DEFAULT_PAYROLL_CONFIG } from '../../shared/payroll';
import type { AuthPolicy, SettingItem } from '../../shared/types';

export type Settings = Map<string, SettingItem>;

export async function loadSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare('SELECT key, value, type, description FROM settings').all<SettingItem>();
  return new Map(results.map((s) => [s.key, s]));
}

export function settingBool(s: Settings, key: string, fallback: boolean): boolean {
  const v = s.get(key)?.value;
  return v === undefined ? fallback : v === 'true';
}

export function settingNumber(s: Settings, key: string, fallback: number): number {
  const v = Number(s.get(key)?.value);
  return Number.isFinite(v) ? v : fallback;
}

export function settingText(s: Settings, key: string, fallback: string): string {
  return s.get(key)?.value ?? fallback;
}

export function authPolicy(s: Settings): AuthPolicy {
  return {
    mfaEnforcedForPrivileged: settingBool(s, 'security.mfa_enforce_privileged', true),
    lockoutThreshold: settingNumber(s, 'security.lockout_threshold', 5),
    lockoutMinutes: settingNumber(s, 'security.lockout_minutes', 15),
    passwordMinLength: settingNumber(s, 'security.password_min_length', 12),
    selfRegistration: settingBool(s, 'security.self_registration', false),
  };
}

export function payrollConfig(s: Settings): PayrollConfig {
  return {
    ...DEFAULT_PAYROLL_CONFIG,
    ssoRate: settingNumber(s, 'payroll.sso_rate', DEFAULT_PAYROLL_CONFIG.ssoRate),
    ssoMinWage: settingNumber(s, 'payroll.sso_min_wage', DEFAULT_PAYROLL_CONFIG.ssoMinWage),
    ssoMaxWage: settingNumber(s, 'payroll.sso_max_wage', DEFAULT_PAYROLL_CONFIG.ssoMaxWage),
    otDivisorDays: settingNumber(s, 'payroll.ot_divisor_days', DEFAULT_PAYROLL_CONFIG.otDivisorDays),
    hoursPerDay: settingNumber(s, 'payroll.hours_per_day', DEFAULT_PAYROLL_CONFIG.hoursPerDay),
  };
}

export function validatePassword(password: string, minLength: number): string | null {
  if (password.length < minLength) return `รหัสผ่านต้องยาวอย่างน้อย ${minLength} ตัวอักษร`;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) return 'รหัสผ่านต้องมีอย่างน้อย 3 ใน 4 ประเภท: ตัวพิมพ์เล็ก ตัวพิมพ์ใหญ่ ตัวเลข สัญลักษณ์';
  return null;
}

export function ewfConfig(s: Settings): EwfConfig {
  return {
    enabled: settingBool(s, 'payroll.ewf_enabled', false),
    effectiveDate: settingText(s, 'payroll.ewf_effective_date', ''),
    employeeRate: settingNumber(s, 'payroll.ewf_employee_rate', 0),
    employerRate: settingNumber(s, 'payroll.ewf_employer_rate', 0),
    nextRateDate: settingText(s, 'payroll.ewf_next_rate_date', ''),
    nextEmployeeRate: settingNumber(s, 'payroll.ewf_next_employee_rate', 0),
    nextEmployerRate: settingNumber(s, 'payroll.ewf_next_employer_rate', 0),
    wageCap: settingNumber(s, 'payroll.ewf_wage_cap', 0),
    minEmployeeCount: settingNumber(s, 'payroll.ewf_min_employee_count', 0),
    exemptProvidentFund: settingBool(s, 'payroll.ewf_exempt_provident_fund', true),
    providentFundComponent: settingText(s, 'payroll.ewf_provident_fund_component', 'PVD'),
    exemptEquivalentWelfare: settingBool(s, 'payroll.ewf_exempt_equivalent_welfare', true),
  };
}
