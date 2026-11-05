// Holiday calendar rules shared by the API, the payroll engine and the SPA (pure functions, no I/O).
// Dates are Gregorian YYYY-MM-DD everywhere; the Thai Buddhist year (พ.ศ.) is a display concern only.
// Statutory holiday-pay minimums are validated here, but whether an employee is entitled to holiday pay and the
// multipliers actually used come from approved holiday_pay_rules rows, never from code.
import type { Cell } from './xlsx';
import type { HolidayPaySnapshot } from './types';
import { round2, salaryOn } from './payroll';

export const HOLIDAY_TYPES = ['traditional', 'national_labour', 'company', 'substitute', 'local'] as const;
export type HolidayType = (typeof HOLIDAY_TYPES)[number];
export const HOLIDAY_TYPE_LABEL: Record<HolidayType, string> = {
  traditional: 'วันหยุดตามประเพณี',
  national_labour: 'วันแรงงานแห่งชาติ',
  company: 'วันหยุดตามประกาศบริษัท',
  substitute: 'วันหยุดชดเชย',
  local: 'วันหยุดท้องถิ่น',
};

export type HolidayStatus = 'draft' | 'approved' | 'inactive';
export type HolidayVerification = 'unverified' | 'verified';
export const EMPLOYMENT_TYPES = ['permanent', 'contract', 'probation', 'intern'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** Number of calendar years kept open for entry: the current year and the next nine. */
export const WINDOW_YEARS = 10;
export const DEFAULT_COUNTRY = 'TH';

export interface HolidayRow {
  id: number;
  calendar_id: number;
  calendar_code: string;
  country_code: string;
  company_id: number | null;
  company: string | null;
  holiday_date: string;
  year: number;
  name: string;
  name_en: string | null;
  holiday_type: HolidayType;
  status: HolidayStatus;
  origin: 'manual' | 'import';
  verification: HolidayVerification;
  source_reference: string | null;
  source_url: string | null;
  region: string | null;
  note: string | null;
  substitute_for: number | null;
  /** holiday work records referencing the holiday / of which already used by a payroll calculation */
  work_records: number;
  payroll_locked: number;
  /** a traditional / labour holiday on a weekly rest day without a substitute day yet */
  needs_substitute?: boolean;
  created_by: number | null;
  approved_by_name: string | null;
  approved_at: string | null;
}

export interface HolidayCalendarRow {
  id: number;
  code: string;
  name: string;
  country_code: string;
  company_id: number | null;
  company: string | null;
  weekly_rest_days: string;
  active: number;
}

export interface HolidayPayRuleRow {
  id: number;
  company_id: number | null;
  company: string | null;
  employment_type: EmploymentType;
  holiday_pay_entitled: number;
  work_multiplier: number;
  ot_multiplier: number;
  effective_from: string;
  effective_to: string | null;
  legal_basis: string;
  status: HolidayStatus;
  created_by: number | null;
  approved_by_name: string | null;
  approved_at: string | null;
}

export interface HolidayWorkRow {
  id: number;
  employee_id: number;
  emp_code: string;
  employee: string;
  company_id: number;
  employment_type: string;
  holiday_id: number;
  holiday_name: string;
  holiday_type: HolidayType;
  work_date: string;
  normal_hours: number;
  ot_hours: number;
  evidence_source: 'attendance' | 'feishu' | 'manual';
  attendance_record_id: number | null;
  attendance_import_row_id: number | null;
  evidence_ref: string | null;
  excluded_from_regular_ot: number;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  note: string | null;
  review_reason: string | null;
  reviewer: string | null;
  reviewed_at: string | null;
  payroll_period_id: number | null;
  payroll_period: string | null;
  created_by: number | null;
}

export interface HolidayListResponse {
  window: { from: number; to: number };
  calendars: HolidayCalendarRow[];
  holidays: HolidayRow[];
  /** traditional-holiday count of the selected year, per company context (warning only) */
  compliance: Array<HolidayCompliance & { company_id: number | null; company: string | null; country_code: string }>;
  can: { create: boolean; update: boolean; delete: boolean; approve: boolean; import: boolean; export: boolean; allCompanies: boolean };
}

// ---- Dates -------------------------------------------------------------------------------------
export function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** A real calendar date in YYYY-MM-DD form (2027-02-29 and 2026-04-31 are rejected). */
export function isIsoDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  if (m < 1 || m > 12 || d < 1) return false;
  const days = [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] as number;
  return d <= days;
}

/** 0 = Sunday … 6 = Saturday (calendar date, timezone independent). */
export function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const buddhistYear = (gregorianYear: number): number => gregorianYear + 543;

const THAI_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
export const THAI_MONTHS_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
export const THAI_WEEKDAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];

/** "1 พ.ค. 2569" — Thai display of a stored Gregorian date. */
export function thaiDate(date: string): string {
  if (!isIsoDate(date)) return date;
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d} ${THAI_MONTHS[m - 1]} ${buddhistYear(y)}`;
}

/** The rolling window of years open for entry, from today's (Asia/Bangkok) date. */
export function holidayWindow(today: string): { from: number; to: number } {
  const y = Number(today.slice(0, 4));
  return { from: y, to: y + WINDOW_YEARS - 1 };
}

export function inWindow(date: string, window: { from: number; to: number }): boolean {
  const y = Number(date.slice(0, 4));
  return y >= window.from && y <= window.to;
}

/** "0,6" → [0, 6]; null when the value is not a list of distinct weekdays 0–6. */
export function parseWeeklyRest(raw: string): number[] | null {
  if (raw.trim() === '') return [];
  const days = raw.split(',').map((s) => Number(s.trim()));
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(days).size !== days.length) return null;
  return days.sort((a, b) => a - b);
}

// ---- Day classification (attendance) -----------------------------------------------------------
export type DayKind = 'workday' | 'weekly_rest' | 'holiday';

export interface DayType {
  date: string;
  kind: DayKind;
  /** set when kind = holiday: the approved holiday that applies (company calendar first, then central) */
  holiday: { id: number; name: string; type: HolidayType; companyCalendar: boolean } | null;
  /** the date is also a weekly rest day (a traditional holiday on a rest day needs a substitute day) */
  weeklyRest: boolean;
}

export interface ApplicableHoliday {
  id: number;
  holiday_date: string;
  name: string;
  holiday_type: HolidayType;
  company_id: number | null;
}

/**
 * Classifies one date for one company. Only approved holidays may be passed in; a company-calendar holiday wins over
 * a central one on the same date. Nothing here says the employee worked: that needs verified attendance evidence.
 */
export function classifyDay(date: string, holidays: readonly ApplicableHoliday[], weeklyRest: readonly number[]): DayType {
  const rest = weeklyRest.includes(weekday(date));
  const onDay = holidays.filter((x) => x.holiday_date === date).sort((a, b) => (b.company_id === null ? 0 : 1) - (a.company_id === null ? 0 : 1) || a.id - b.id);
  const hit = onDay[0];
  if (hit) return { date, kind: 'holiday', holiday: { id: hit.id, name: hit.name, type: hit.holiday_type, companyCalendar: hit.company_id !== null }, weeklyRest: rest };
  return { date, kind: rest ? 'weekly_rest' : 'workday', holiday: null, weeklyRest: rest };
}

/** Holidays that fall on a weekly rest day and have no substitute day yet (types that require one). */
export function missingSubstitutes(holidays: ReadonlyArray<ApplicableHoliday & { substituted: boolean }>, weeklyRest: readonly number[]): number[] {
  return holidays.filter((x) => (x.holiday_type === 'traditional' || x.holiday_type === 'national_labour') && !x.substituted && weeklyRest.includes(weekday(x.holiday_date))).map((x) => x.id);
}

// ---- Holiday pay -------------------------------------------------------------------------------
export interface HolidayRuleInput {
  entitled: boolean;
  workMultiplier: number;
  otMultiplier: number;
}

/** Statutory minimums (Labour Protection Act s.62–63): returns the problems, empty when the rule is lawful. */
export function ruleProblems(r: HolidayRuleInput): string[] {
  const out: string[] = [];
  const minWork = r.entitled ? 1 : 2;
  if (!Number.isFinite(r.workMultiplier) || r.workMultiplier < minWork) out.push(`อัตราทำงานในวันหยุด (เวลาปกติ) ต้องไม่น้อยกว่า ${minWork} เท่า สำหรับผู้${r.entitled ? '' : 'ไม่'}มีสิทธิได้รับค่าจ้างในวันหยุด`);
  if (!Number.isFinite(r.otMultiplier) || r.otMultiplier < 3) out.push('อัตราล่วงเวลาในวันหยุดต้องไม่น้อยกว่า 3 เท่า');
  if (r.workMultiplier > 10 || r.otMultiplier > 10) out.push('อัตราคูณต้องไม่เกิน 10 เท่า');
  return out;
}

export interface HolidayPayBasis {
  /** monthly rate in force (the same base as normal OT) */
  monthlyRate: number;
  divisorDays: number;
  hoursPerDay: number;
}

/** Hourly wage = monthly rate ÷ divisor days ÷ hours per day (both from System Settings, as for normal OT). */
export function hourlyRate(b: HolidayPayBasis): number {
  return b.monthlyRate / b.divisorDays / b.hoursPerDay;
}

export interface HolidayPayItem {
  recordId: number;
  holidayId: number;
  holidayName: string;
  holidayType: HolidayType;
  date: string;
  normalHours: number;
  otHours: number;
  entitled: boolean;
  workMultiplier: number;
  otMultiplier: number;
  ruleId: number;
  workAmount: number;
  otAmount: number;
}

/**
 * Additional pay for one approved holiday-work record. The monthly salary already pays the holiday itself for an
 * entitled employee (entitlement A), so only work done on the day is added:
 *   B. normal hours × hourly × workMultiplier   (HOLIDAY_WORK)
 *   C. OT hours     × hourly × otMultiplier     (HOLIDAY_OT)
 */
export function holidayPay(basis: HolidayPayBasis, rule: HolidayRuleInput, normalHours: number, otHours: number): { hourly: number; workAmount: number; otAmount: number } {
  const hourly = hourlyRate(basis);
  return { hourly: round2(hourly), workAmount: round2(normalHours * hourly * rule.workMultiplier), otAmount: round2(otHours * hourly * rule.otMultiplier) };
}

export interface ApplicableRule {
  id: number;
  company_id: number | null;
  employment_type: string;
  holiday_pay_entitled: number;
  work_multiplier: number;
  ot_multiplier: number;
  effective_from: string;
  effective_to: string | null;
}

export const isEmploymentType = (v: unknown): v is EmploymentType => typeof v === 'string' && (EMPLOYMENT_TYPES as readonly string[]).includes(v);

/**
 * The approved rule for an employee on a date: a company rule wins over the all-company rule; latest start wins.
 * The employment type must match exactly (employees.employment_type, not the probation STATUS): there is no fallback
 * from one type to another, so an employee is never paid under another type's rule.
 */
export function resolveRule(rules: readonly ApplicableRule[], companyId: number, employmentType: string, date: string): ApplicableRule | null {
  if (!isEmploymentType(employmentType)) return null;
  const fits = rules.filter((r) => r.employment_type === employmentType && r.effective_from <= date && (r.effective_to === null || r.effective_to >= date) && (r.company_id === null || r.company_id === companyId));
  fits.sort((a, b) => (b.company_id === null ? 0 : 1) - (a.company_id === null ? 0 : 1) || (a.effective_from < b.effective_from ? 1 : a.effective_from > b.effective_from ? -1 : 0));
  return fits[0] ?? null;
}

export interface HolidayWorkInput {
  id: number;
  holiday_id: number;
  work_date: string;
  normal_hours: number;
  ot_hours: number;
  holiday_name: string;
  holiday_type: HolidayType;
}

export interface HolidayPricingContext {
  companyId: number;
  employmentType: string;
  /** employees.base_salary: the rate when no salary-history row applies */
  baseSalary: number;
  /** approved salary history (any order) */
  history: ReadonlyArray<{ from: string; amount: number }>;
  divisorDays: number;
  hoursPerDay: number;
  rules: readonly ApplicableRule[];
}

export type HolidayPricing =
  | { ok: true; snapshot: HolidayPaySnapshot }
  | { ok: false; reason: 'unknown_employment_type' | 'no_rule'; date: string };

/**
 * Prices an employee's approved holiday work. Each record uses the salary in force ON ITS WORK DATE (a raise inside the
 * period only applies from its effective date) and the approved rule for the employee's exact employment type.
 */
export function priceHolidayWork(work: readonly HolidayWorkInput[], ctx: HolidayPricingContext): HolidayPricing {
  const items: HolidayPaySnapshot['items'] = [];
  for (const w of work) {
    if (!isEmploymentType(ctx.employmentType)) return { ok: false, reason: 'unknown_employment_type', date: w.work_date };
    const rule = resolveRule(ctx.rules, ctx.companyId, ctx.employmentType, w.work_date);
    if (!rule) return { ok: false, reason: 'no_rule', date: w.work_date };
    const r = { entitled: rule.holiday_pay_entitled === 1, workMultiplier: rule.work_multiplier, otMultiplier: rule.ot_multiplier };
    const monthlyRate = salaryOn(ctx.baseSalary, ctx.history, w.work_date);
    const pay = holidayPay({ monthlyRate, divisorDays: ctx.divisorDays, hoursPerDay: ctx.hoursPerDay }, r, w.normal_hours, w.ot_hours);
    items.push({
      monthlyRate, hourlyRate: pay.hourly, employmentType: ctx.employmentType,
      recordId: w.id, holidayId: w.holiday_id, holidayName: w.holiday_name, holidayType: w.holiday_type, date: w.work_date, normalHours: w.normal_hours, otHours: w.ot_hours,
      ruleId: rule.id, ...r, workAmount: pay.workAmount, otAmount: pay.otAmount,
    });
  }
  return {
    ok: true,
    snapshot: {
      divisorDays: ctx.divisorDays,
      hoursPerDay: ctx.hoursPerDay,
      items,
      workAmount: round2(items.reduce((a, x) => a + x.workAmount, 0)),
      otAmount: round2(items.reduce((a, x) => a + x.otAmount, 0)),
    },
  };
}

// ---- Traditional-holiday count (Labour Protection Act s.29) ------------------------------------
/** At least this many traditional holidays a year, National Labour Day included. */
export const MIN_TRADITIONAL_HOLIDAYS = 13;

export interface ComplianceHoliday {
  id: number;
  holiday_date: string;
  name: string;
  holiday_type: HolidayType;
  status: HolidayStatus;
}

export interface HolidayCompliance {
  year: number;
  required: number;
  /** approved traditional + national labour holidays (counted towards the minimum) */
  counted: number;
  countedHolidays: Array<{ id: number; date: string; name: string; type: HolidayType }>;
  /** approved National Labour Day rows, shown separately for review (normally exactly one, on 1 May) */
  labourDay: Array<{ id: number; date: string; name: string }>;
  labourDayIssue: string | null;
  /** approved holidays that do NOT count: company announcements, local holidays and substitute days */
  notCounted: { company: number; local: number; substitute: number };
  /** traditional / labour holidays still draft (not counted until HR approves them) */
  drafts: number;
  ok: boolean;
  /** never auto-corrected: HR checks the official announcement and approves */
  message: string;
}

/** Counts a year's approved holidays for one company context (central calendar + the company's own calendar). */
export function traditionalCompliance(holidays: readonly ComplianceHoliday[], year: number): HolidayCompliance {
  const inYear = holidays.filter((h) => h.holiday_date.startsWith(`${year}-`));
  const approved = inYear.filter((h) => h.status === 'approved');
  // the same day in two calendars (central + company) counts once
  const byDate = new Map<string, ComplianceHoliday>();
  for (const h of approved) if ((h.holiday_type === 'traditional' || h.holiday_type === 'national_labour') && !byDate.has(h.holiday_date)) byDate.set(h.holiday_date, h);
  const counted = [...byDate.values()].sort((a, b) => (a.holiday_date < b.holiday_date ? -1 : 1));
  const labour = approved.filter((h) => h.holiday_type === 'national_labour');
  const labourDayIssue = labour.length === 0 ? 'ยังไม่มีวันแรงงานแห่งชาติที่อนุมัติแล้ว'
    : labour.length > 1 ? `มีวันแรงงานแห่งชาติ ${labour.length} รายการ ต้องตรวจสอบ`
      : labour[0]!.holiday_date.slice(5) !== '05-01' ? `วันแรงงานแห่งชาติไม่ใช่วันที่ 1 พฤษภาคม (${labour[0]!.holiday_date}) ต้องตรวจสอบกับประกาศ` : null;
  const ok = counted.length >= MIN_TRADITIONAL_HOLIDAYS;
  return {
    year,
    required: MIN_TRADITIONAL_HOLIDAYS,
    counted: counted.length,
    countedHolidays: counted.map((h) => ({ id: h.id, date: h.holiday_date, name: h.name, type: h.holiday_type })),
    labourDay: labour.map((h) => ({ id: h.id, date: h.holiday_date, name: h.name })),
    labourDayIssue,
    notCounted: {
      company: approved.filter((h) => h.holiday_type === 'company').length,
      local: approved.filter((h) => h.holiday_type === 'local').length,
      substitute: approved.filter((h) => h.holiday_type === 'substitute').length,
    },
    drafts: inYear.filter((h) => h.status === 'draft' && (h.holiday_type === 'traditional' || h.holiday_type === 'national_labour')).length,
    ok,
    message: ok
      ? `วันหยุดตามประเพณีที่อนุมัติแล้ว ${counted.length} วัน (ขั้นต่ำ ${MIN_TRADITIONAL_HOLIDAYS} วัน รวมวันแรงงานแห่งชาติ)`
      : `วันหยุดตามประเพณีที่อนุมัติแล้วมี ${counted.length} วัน น้อยกว่าขั้นต่ำ ${MIN_TRADITIONAL_HOLIDAYS} วัน — HR ต้องตรวจสอบประกาศอย่างเป็นทางการและอนุมัติให้ครบ (ระบบไม่สร้างหรืออนุมัติแทน)`,
  };
}

// ---- Import (Excel / CSV) ----------------------------------------------------------------------
export const IMPORT_COLUMNS = ['date', 'name', 'type', 'name_en', 'source_reference', 'source_url', 'region', 'note'] as const;
export const IMPORT_HEADERS: Record<(typeof IMPORT_COLUMNS)[number], string> = {
  date: 'วันที่ (YYYY-MM-DD)',
  name: 'ชื่อวันหยุด',
  type: 'ประเภท',
  name_en: 'ชื่อภาษาอังกฤษ',
  source_reference: 'แหล่งที่มา / เลขที่ประกาศ',
  source_url: 'ลิงก์ประกาศ',
  region: 'พื้นที่ (วันหยุดท้องถิ่น)',
  note: 'หมายเหตุ',
};

export interface ImportRow {
  rowNo: number;
  date: string | null;
  name: string | null;
  type: HolidayType | null;
  name_en: string | null;
  source_reference: string | null;
  source_url: string | null;
  region: string | null;
  note: string | null;
  issues: Array<{ level: 'error' | 'warning'; message: string }>;
}

const cellText = (v: Cell | undefined): string => (v === null || v === undefined ? '' : String(v).trim());

function cellDate(v: Cell | undefined): string | null {
  if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000).toISOString().slice(0, 10);
  const s = cellText(v);
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s) ?? null;
  if (m) return `${m[1]}-${(m[2] as string).padStart(2, '0')}-${(m[3] as string).padStart(2, '0')}`;
  const t = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (t) {
    let y = Number(t[3]);
    if (y > 2400) y -= 543; // a Buddhist-era year typed by hand
    return `${y}-${(t[2] as string).padStart(2, '0')}-${(t[1] as string).padStart(2, '0')}`;
  }
  return s || null;
}

function typeOf(raw: string): HolidayType | null {
  const s = raw.trim().toLowerCase();
  if ((HOLIDAY_TYPES as readonly string[]).includes(s)) return s as HolidayType;
  const byLabel = (Object.entries(HOLIDAY_TYPE_LABEL) as Array<[HolidayType, string]>).find(([, l]) => l === raw.trim());
  return byLabel ? byLabel[0] : null;
}

/**
 * Validates an uploaded grid (first row = headers, matched by key or Thai header). Every row is reported; rows with
 * an error are never imported. Imported rows always start as unverified drafts.
 */
export function validateImport(grid: Cell[][], opts: { window: { from: number; to: number }; existingDates: ReadonlySet<string> }): { rows: ImportRow[]; missingColumns: string[] } {
  const head = (grid[0] ?? []).map((c) => cellText(c).toLowerCase());
  const col = Object.fromEntries(IMPORT_COLUMNS.map((k) => [k, head.findIndex((x) => x === k || x === IMPORT_HEADERS[k].toLowerCase())])) as Record<(typeof IMPORT_COLUMNS)[number], number>;
  const missingColumns = (['date', 'name', 'type'] as const).filter((k) => col[k] < 0).map((k) => IMPORT_HEADERS[k]);
  if (missingColumns.length) return { rows: [], missingColumns };
  const seen = new Map<string, number>();
  const rows: ImportRow[] = [];
  grid.slice(1).forEach((r, i) => {
    if (r.every((c) => cellText(c) === '')) return;
    const get = (k: (typeof IMPORT_COLUMNS)[number]) => (col[k] >= 0 ? cellText(r[col[k]]) || null : null);
    const date = cellDate(r[col.date]);
    const rawType = get('type') ?? '';
    const row: ImportRow = {
      rowNo: i + 2,
      date,
      name: get('name'),
      type: typeOf(rawType),
      name_en: get('name_en'),
      source_reference: get('source_reference'),
      source_url: get('source_url'),
      region: get('region'),
      note: get('note'),
      issues: [],
    };
    const err = (message: string) => row.issues.push({ level: 'error', message });
    if (!date || !isIsoDate(date)) err(`วันที่ไม่ถูกต้อง: "${cellText(r[col.date])}" (ต้องเป็นวันที่จริง รูปแบบ YYYY-MM-DD)`);
    else if (!inWindow(date, opts.window)) err(`ปี ${date.slice(0, 4)} อยู่นอกช่วงที่เปิดรับ ${opts.window.from}–${opts.window.to}`);
    if (!row.name) err('ไม่มีชื่อวันหยุด');
    else if (row.name.length > 200) err('ชื่อวันหยุดยาวเกิน 200 ตัวอักษร');
    if (!row.type) err(`ประเภทไม่ถูกต้อง: "${rawType}" (ใช้ ${HOLIDAY_TYPES.join(', ')})`);
    if (row.source_url && !/^https:\/\//i.test(row.source_url)) err('ลิงก์ประกาศต้องขึ้นต้นด้วย https://');
    for (const k of ['name_en', 'source_reference', 'region', 'note'] as const) if ((row[k]?.length ?? 0) > 500) err(`${IMPORT_HEADERS[k]} ยาวเกิน 500 ตัวอักษร`);
    if (date && isIsoDate(date)) {
      const dup = seen.get(date);
      if (dup !== undefined) err(`วันที่ซ้ำกับแถว ${dup} ในไฟล์`);
      else seen.set(date, row.rowNo);
      if (opts.existingDates.has(date)) err('มีวันหยุดวันนี้ในปฏิทินอยู่แล้ว');
    }
    if (!row.source_reference) row.issues.push({ level: 'warning', message: 'ยังไม่มีแหล่งที่มา ต้องระบุก่อนตรวจสอบและอนุมัติ' });
    rows.push(row);
  });
  return { rows, missingColumns };
}

/** Export / template rows (header + data) — the same columns the import reads back. */
export function exportGrid(rows: ReadonlyArray<Pick<HolidayRow, 'holiday_date' | 'name' | 'holiday_type' | 'name_en' | 'source_reference' | 'source_url' | 'region' | 'note' | 'status' | 'verification'>>): Cell[][] {
  return [
    [...IMPORT_COLUMNS.map((k) => IMPORT_HEADERS[k]), 'วันที่ (พ.ศ.)', 'สถานะ', 'การตรวจสอบแหล่งที่มา'],
    ...rows.map((r) => [r.holiday_date, r.name, r.holiday_type, r.name_en, r.source_reference, r.source_url, r.region, r.note, thaiDate(r.holiday_date), r.status, r.verification]),
  ];
}
