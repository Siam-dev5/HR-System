// Daily attendance (P2): validation of the daily records of a payroll period, their aggregation per employee and the
// canonical payload of the attendance version. Pure functions: the worker loads the inputs from D1
// (lib/attendance-daily.ts). Nothing here calculates money — the payroll engine keeps its own inputs; the aggregation is
// recorded with each Calculation Version and compared with those inputs (Preview warnings).
//
// Workday rule (the same as the attendance holds of P1): a day with a shift in the schedule is a workday unless it is
// an approved holiday; a day without a schedule entry follows the company calendar (weekly rest days and approved
// holidays); a day off / holiday in the schedule is never a workday. Only days of the employment inside the period are
// counted. Only completed days are judged by the aggregation and the version: up to yesterday (Asia/Bangkok), or the
// period end — today's clocks are still being written, so they cannot make a calculation stale.
//
// Record status (worst issue wins): invalid > pending_review > warning > valid.
//   invalid         cannot be used at all: it must be corrected (hold 'invalid_record')
//   pending_review  incomplete or contradictory: counted only after HR confirms it (hold 'pending_review' cleared)
//   warning / valid counted
import type { HoldEmployee, HoldExemption, HoldLeave, HoldSource, ScheduleKind } from './attendance-holds';
import { MAX_WORKED_MINUTES } from './shifts';

export type RecordStatus = 'valid' | 'warning' | 'pending_review' | 'invalid';
const RANK: Record<RecordStatus, number> = { valid: 0, warning: 1, pending_review: 2, invalid: 3 };

export type ValidationCode =
  | 'future_date' | 'not_employed' | 'unknown_status' | 'out_before_in'
  | 'missing_clock_in' | 'missing_clock_out' | 'status_conflict'
  | 'long_day' | 'non_workday' | 'shift_changed' | 'present_on_leave' | 'exempt_day'
  | 'ot_without_attendance';

export const VALIDATION_RULES: Record<ValidationCode, { level: RecordStatus; message: string }> = {
  future_date: { level: 'invalid', message: 'วันที่ของบันทึกเวลาเป็นวันในอนาคต' },
  not_employed: { level: 'invalid', message: 'วันที่อยู่นอกช่วงการจ้างงานของพนักงาน' },
  unknown_status: { level: 'invalid', message: 'สถานะการมาทำงานไม่ถูกต้อง (ต้องเป็น present / late / absent / leave)' },
  out_before_in: { level: 'invalid', message: 'เวลาออกงานไม่อยู่หลังเวลาเข้างาน (และไม่ได้ระบุว่าออกงานวันถัดไป)' },
  missing_clock_in: { level: 'pending_review', message: 'ไม่มีเวลาเข้างาน ต้องให้ HR ตรวจสอบ' },
  missing_clock_out: { level: 'pending_review', message: 'ไม่มีเวลาออกงาน ต้องให้ HR ตรวจสอบ' },
  status_conflict: { level: 'pending_review', message: 'สถานะเป็นขาดงาน/ลา แต่มีเวลาเข้า-ออก (ข้อมูลขัดแย้ง)' },
  long_day: { level: 'warning', message: `เวลาทำงานเกิน ${MAX_WORKED_MINUTES / 60} ชั่วโมงในวันเดียว` },
  non_workday: { level: 'warning', message: 'มาทำงานในวันหยุด (ค่าทำงานวันหยุดจ่ายตามบันทึกทำงานวันหยุดที่อนุมัติเท่านั้น)' },
  shift_changed: { level: 'warning', message: 'กะที่ใช้ตรวจเวลาไม่ตรงกับกะปัจจุบันของวันนั้น (ตารางกะถูกเปลี่ยนหลังบันทึกเวลา)' },
  present_on_leave: { level: 'warning', message: 'มีเวลาทำงานในวันที่มีใบลาที่อนุมัติแล้ว' },
  exempt_day: { level: 'valid', message: 'พนักงานได้รับยกเว้นการบันทึกเวลาในวันนี้' },
  ot_without_attendance: { level: 'warning', message: 'มี OT ที่อนุมัติแล้วในวันที่ไม่มีเวลาทำงานที่ใช้ได้' },
};

export interface DailyRecord {
  id: number;
  employee_id: number;
  work_date: string;
  status: string;
  clock_in: string | null;
  clock_out: string | null;
  clock_out_next_day: number;
  shift_id: number | null;
  late_minutes: number | null;
  early_leave_minutes: number | null;
  worked_minutes: number | null;
  /** last revision of the record (0 = none since 0020) */
  revision: number;
}

export interface DailyLeave extends HoldLeave {
  /** leave type paid (requests); null = unknown (Feishu imports carry the type as text only) */
  paid: boolean | null;
}

export interface DailyOvertime {
  id: number;
  employee_id: number;
  work_date: string;
  hours: number;
  rate: string;
}

export interface DailyInput {
  periodStart: string;
  periodEnd: string;
  today: string;
  employees: readonly HoldEmployee[];
  /** `${employeeId}|${date}` → scheduled kind and shift (missing key = 'none') */
  schedule: ReadonlyMap<string, { kind: ScheduleKind; shiftId: number | null }>;
  calendars: ReadonlyMap<number, { weeklyRest: readonly number[]; holidays: ReadonlySet<string> }>;
  records: readonly DailyRecord[];
  leaves: readonly DailyLeave[];
  exemptions: readonly HoldExemption[];
  /** approved OT requests of the period */
  overtime: readonly DailyOvertime[];
  /** `${recordId}:${revision}` HR confirmed (a cleared 'pending_review' hold for exactly that revision) */
  confirmed: ReadonlySet<string>;
}

export interface Issue {
  code: ValidationCode;
  level: RecordStatus;
  message: string;
}

export interface ValidatedRecord {
  record: DailyRecord;
  company_id: number;
  status: RecordStatus;
  issues: Issue[];
  /** HR confirmed this revision of a pending_review record */
  confirmed: boolean;
  /** used by the aggregation (valid / warning, or pending_review confirmed by HR) */
  counted: boolean;
}

export interface DayIssue extends Issue {
  employee_id: number;
  company_id: number;
  work_date: string;
}

export interface Validation {
  records: ValidatedRecord[];
  days: DayIssue[];
  counts: Record<RecordStatus, number>;
}

const DAY = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(utc(d)).getUTCDay();
const issue = (code: ValidationCode): Issue => ({ code, level: VALIDATION_RULES[code].level, message: VALIDATION_RULES[code].message });
const STATUSES = new Set(['present', 'late', 'absent', 'leave']);
const DEFAULT_CAL = { weeklyRest: [0, 6] as readonly number[], holidays: new Set<string>() as ReadonlySet<string> };

/** Last day judged: the period end, or yesterday while the period is still running (today is not complete yet). */
export const judgedThrough = (input: Pick<DailyInput, 'periodEnd' | 'today'>): string => {
  const yesterday = iso(utc(input.today) - DAY);
  return input.periodEnd < yesterday ? input.periodEnd : yesterday;
};

/** The `today` that makes judgedThrough() return `through` (recheck a calculation over exactly the days it judged). */
export const todayFor = (through: string): string => iso(utc(through) + DAY);

export interface DayKind {
  workday: boolean;
  /** an approved holiday (calendar) or a holiday in the schedule */
  holiday: boolean;
  scheduleKind: ScheduleKind;
  shiftId: number | null;
}

export function dayKind(input: Pick<DailyInput, 'schedule' | 'calendars'>, e: HoldEmployee, d: string): DayKind {
  const cal = input.calendars.get(e.company_id) ?? DEFAULT_CAL;
  const s = input.schedule.get(`${e.id}|${d}`);
  const kind = s?.kind ?? 'none';
  const calendarHoliday = cal.holidays.has(d);
  const workday = kind === 'shift' ? !calendarHoliday : kind === 'none' ? !cal.weeklyRest.includes(weekday(d)) && !calendarHoliday : false;
  return { workday, holiday: calendarHoliday || kind === 'holiday', scheduleKind: kind, shiftId: s?.shiftId ?? null };
}

const exemptOn = (input: DailyInput, employeeId: number, d: string) =>
  input.exemptions.some((x) => x.employee_id === employeeId && !x.revoked_at && x.effective_from <= d && (!x.effective_to || x.effective_to >= d));

const approvedLeaveOn = (input: DailyInput, employeeId: number, d: string): DailyLeave | undefined =>
  input.leaves
    .filter((l) => l.employee_id === employeeId && l.status === 'approved' && l.start_date <= d && l.end_date >= d)
    .sort((a, b) => (a.source === b.source ? a.id - b.id : a.source === 'request' ? -1 : 1))[0];

/** Validates every daily record of the period's employees inside the period, plus day-level checks. */
export function validateDaily(input: DailyInput): Validation {
  const byId = new Map(input.employees.map((e) => [e.id, e]));
  const records: ValidatedRecord[] = [];
  for (const r of [...input.records].sort((a, b) => a.employee_id - b.employee_id || a.work_date.localeCompare(b.work_date) || a.id - b.id)) {
    const e = byId.get(r.employee_id);
    if (!e || r.work_date < input.periodStart || r.work_date > input.periodEnd) continue;
    const issues: Issue[] = [];
    if (r.work_date > input.today) issues.push(issue('future_date'));
    if (r.work_date < e.hire_date || (e.termination_date && r.work_date > e.termination_date)) issues.push(issue('not_employed'));
    if (!STATUSES.has(r.status)) issues.push(issue('unknown_status'));
    const timed = !!r.clock_in || !!r.clock_out;
    if (r.clock_in && r.clock_out && !r.clock_out_next_day && r.clock_out <= r.clock_in) issues.push(issue('out_before_in'));
    if ((r.status === 'present' || r.status === 'late' || r.clock_out) && !r.clock_in) issues.push(issue('missing_clock_in'));
    if (r.clock_in && !r.clock_out && r.work_date < input.today) issues.push(issue('missing_clock_out'));
    if ((r.status === 'absent' || r.status === 'leave') && timed) issues.push(issue('status_conflict'));
    if ((r.worked_minutes ?? 0) > MAX_WORKED_MINUTES) issues.push(issue('long_day'));
    const day = dayKind(input, e, r.work_date);
    const present = (r.status === 'present' || r.status === 'late') && !!r.clock_in;
    if (present && !day.workday) issues.push(issue('non_workday'));
    if (present && r.shift_id !== null && day.shiftId !== null && r.shift_id !== day.shiftId) issues.push(issue('shift_changed'));
    if (present && approvedLeaveOn(input, e.id, r.work_date)) issues.push(issue('present_on_leave'));
    if (exemptOn(input, e.id, r.work_date)) issues.push(issue('exempt_day'));
    const status = issues.reduce<RecordStatus>((w, i) => (RANK[i.level] > RANK[w] ? i.level : w), 'valid');
    const confirmed = status === 'pending_review' && input.confirmed.has(`${r.id}:${r.revision}`);
    records.push({ record: r, company_id: e.company_id, status, issues, confirmed, counted: status === 'valid' || status === 'warning' || confirmed });
  }
  const days: DayIssue[] = [];
  const presentAt = new Set(records.filter((v) => v.counted && isPresent(v.record)).map((v) => `${v.record.employee_id}|${v.record.work_date}`));
  for (const o of [...input.overtime].sort((a, b) => a.employee_id - b.employee_id || a.work_date.localeCompare(b.work_date) || a.id - b.id)) {
    const e = byId.get(o.employee_id);
    if (!e || o.work_date < input.periodStart || o.work_date > judgedThrough(input)) continue;
    if (!presentAt.has(`${o.employee_id}|${o.work_date}`) && !exemptOn(input, e.id, o.work_date)) days.push({ ...issue('ot_without_attendance'), employee_id: e.id, company_id: e.company_id, work_date: o.work_date });
  }
  const counts: Record<RecordStatus, number> = { valid: 0, warning: 0, pending_review: 0, invalid: 0 };
  for (const v of records) counts[v.status] += 1;
  return { records, days, counts };
}

const isPresent = (r: DailyRecord) => (r.status === 'present' || r.status === 'late') && !!r.clock_in;

/** Holds raised by the validation (P1 lifecycle): one per invalid record, one per unconfirmed-or-confirmed pending one. */
export interface ValidationHold {
  employee_id: number;
  company_id: number;
  kind: 'invalid_record' | 'pending_review';
  work_date: string;
  source: HoldSource & { record: number; revision: number; codes: ValidationCode[] };
}

export function validationHolds(v: Validation): ValidationHold[] {
  return v.records
    .filter((x) => x.status === 'invalid' || x.status === 'pending_review')
    .map((x) => ({
      employee_id: x.record.employee_id,
      company_id: x.company_id,
      kind: x.status === 'invalid' ? ('invalid_record' as const) : ('pending_review' as const),
      work_date: x.record.work_date,
      // the revision is part of the source: a correction of the record reopens a hold HR had cleared
      source: { attendance: [x.record.id], record: x.record.id, revision: x.record.revision, codes: x.issues.filter((i) => i.level === x.status).map((i) => i.code) },
    }));
}

export interface EmployeeAggregate {
  employee_id: number;
  company_id: number;
  /** first and last day of the employment inside the period */
  from: string;
  to: string;
  scheduledWorkDays: number;
  judgedWorkDays: number;
  presentDays: number;
  actualWorkDays: number;
  absentDays: number;
  missingAttendanceDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  /** approved leave whose paid / unpaid type is unknown (Feishu import) */
  unclassifiedLeaveDays: number;
  pendingLeaveDays: number;
  exemptDays: number;
  /** workdays whose only record is invalid or awaits HR review */
  unverifiedDays: number;
  holidayWorkDays: number;
  restDayWorkDays: number;
  lateDays: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  workedMinutes: number;
  otHours: number;
  records: Record<RecordStatus, number>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Aggregates the validated records per employee (pure; the same input always gives the same result). */
export function aggregateDaily(input: DailyInput, v: Validation): EmployeeAggregate[] {
  const last = judgedThrough(input);
  const out: EmployeeAggregate[] = [];
  for (const e of [...input.employees].sort((a, b) => a.id - b.id)) {
    const from = e.hire_date > input.periodStart ? e.hire_date : input.periodStart;
    const to = e.termination_date && e.termination_date < input.periodEnd ? e.termination_date : input.periodEnd;
    if (from > to) continue;
    const mine = v.records.filter((x) => x.record.employee_id === e.id && x.record.work_date >= from && x.record.work_date <= to);
    const a: EmployeeAggregate = {
      employee_id: e.id, company_id: e.company_id, from, to,
      scheduledWorkDays: 0, judgedWorkDays: 0, presentDays: 0, actualWorkDays: 0, absentDays: 0, missingAttendanceDays: 0,
      paidLeaveDays: 0, unpaidLeaveDays: 0, unclassifiedLeaveDays: 0, pendingLeaveDays: 0, exemptDays: 0, unverifiedDays: 0,
      holidayWorkDays: 0, restDayWorkDays: 0, lateDays: 0, lateMinutes: 0, earlyLeaveMinutes: 0, workedMinutes: 0, otHours: 0,
      records: { valid: 0, warning: 0, pending_review: 0, invalid: 0 },
    };
    for (const x of mine) a.records[x.status] += 1;
    for (let t = utc(from); t <= utc(to); t += DAY) {
      const d = iso(t);
      const day = dayKind(input, e, d);
      if (day.workday) a.scheduledWorkDays += 1;
      if (d > last) continue;
      const rows = mine.filter((x) => x.record.work_date === d);
      const counted = rows.filter((x) => x.counted);
      const present = counted.some((x) => isPresent(x.record));
      if (present) {
        a.actualWorkDays += 1;
        if (day.holiday) a.holidayWorkDays += 1;
        else if (!day.workday) a.restDayWorkDays += 1;
      }
      for (const x of counted) {
        if (!isPresent(x.record)) continue;
        if ((x.record.late_minutes ?? 0) > 0) a.lateDays += 1;
        a.lateMinutes += x.record.late_minutes ?? 0;
        a.earlyLeaveMinutes += x.record.early_leave_minutes ?? 0;
        a.workedMinutes += x.record.worked_minutes ?? 0;
      }
      if (!day.workday) continue;
      a.judgedWorkDays += 1;
      if (exemptOn(input, e.id, d)) {
        a.exemptDays += 1;
        continue;
      }
      if (present) {
        a.presentDays += 1;
        continue;
      }
      const leave = approvedLeaveOn(input, e.id, d);
      if (leave) {
        if (leave.paid === true) a.paidLeaveDays += 1;
        else if (leave.paid === false) a.unpaidLeaveDays += 1;
        else a.unclassifiedLeaveDays += 1;
        continue;
      }
      if (input.leaves.some((l) => l.employee_id === e.id && l.status === 'pending' && l.start_date <= d && l.end_date >= d)) {
        a.pendingLeaveDays += 1;
        continue;
      }
      if (rows.some((x) => !x.counted)) {
        a.unverifiedDays += 1;
        continue;
      }
      a.absentDays += 1;
      if (!rows.length) a.missingAttendanceDays += 1;
    }
    a.otHours = r2(input.overtime.filter((o) => o.employee_id === e.id && o.work_date >= from && o.work_date <= to).reduce((s, o) => s + o.hours, 0));
    out.push(a);
  }
  return out;
}

export type AggregateTotals = Omit<EmployeeAggregate, 'employee_id' | 'company_id' | 'from' | 'to'> & { employees: number };

export function aggregateTotals(rows: readonly EmployeeAggregate[]): AggregateTotals {
  const t: AggregateTotals = {
    employees: rows.length, scheduledWorkDays: 0, judgedWorkDays: 0, presentDays: 0, actualWorkDays: 0, absentDays: 0, missingAttendanceDays: 0,
    paidLeaveDays: 0, unpaidLeaveDays: 0, unclassifiedLeaveDays: 0, pendingLeaveDays: 0, exemptDays: 0, unverifiedDays: 0,
    holidayWorkDays: 0, restDayWorkDays: 0, lateDays: 0, lateMinutes: 0, earlyLeaveMinutes: 0, workedMinutes: 0, otHours: 0,
    records: { valid: 0, warning: 0, pending_review: 0, invalid: 0 },
  };
  for (const r of rows) {
    for (const k of Object.keys(t) as Array<keyof AggregateTotals>) {
      if (k === 'employees' || k === 'records') continue;
      t[k] += r[k];
    }
    for (const s of Object.keys(t.records) as RecordStatus[]) t.records[s] += r.records[s];
  }
  t.otHours = r2(t.otHours);
  return t;
}

/**
 * Canonical text of every attendance input of the period (sorted, no Map / Set): its hash is the attendance version.
 * Two loads of unchanged data give the same text; any change of a judged record (or its revision), the schedule, the
 * calendar, a leave, an exemption, an approved OT request, an HR confirmation or the last judged day changes it.
 * Records, OT and leave of days after the last judged day are left out (they cannot change the aggregation).
 */
export function versionPayload(input: DailyInput, period: { id: number; kind: string; company_id: number | null }): string {
  const sortBy = <T>(xs: readonly T[], key: (x: T) => string) => [...xs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const pad = (n: number) => String(n).padStart(12, '0');
  const jt = judgedThrough(input);
  return JSON.stringify({
    v: 1,
    period: [period.id, period.kind, period.company_id, input.periodStart, input.periodEnd],
    judgedThrough: jt,
    employees: sortBy(input.employees, (e) => pad(e.id)).map((e) => [e.id, e.company_id, e.hire_date, e.termination_date]),
    schedule: sortBy([...input.schedule.entries()].filter(([, s]) => s.kind !== 'none' || s.shiftId !== null), ([k]) => k).map(([k, s]) => [k, s.kind, s.shiftId]),
    calendars: sortBy([...input.calendars.entries()], ([id]) => pad(id)).map(([id, c]) => [id, [...c.weeklyRest].sort(), [...c.holidays].sort()]),
    records: sortBy(input.records.filter((r) => r.work_date <= jt), (r) => pad(r.id)).map((r) => [r.id, r.employee_id, r.work_date, r.status, r.clock_in, r.clock_out, r.clock_out_next_day, r.shift_id, r.late_minutes, r.early_leave_minutes, r.worked_minutes, r.revision]),
    leaves: sortBy(input.leaves.filter((l) => l.start_date <= jt), (l) => `${l.source}|${pad(l.id)}`).map((l) => [l.source, l.id, l.employee_id, l.start_date, l.end_date, l.status, l.paid]),
    exemptions: sortBy(input.exemptions, (x) => `${pad(x.employee_id)}|${x.effective_from}`).map((x) => [x.employee_id, x.effective_from, x.effective_to, x.revoked_at]),
    overtime: sortBy(input.overtime.filter((o) => o.work_date <= jt), (o) => pad(o.id)).map((o) => [o.id, o.employee_id, o.work_date, o.hours, o.rate]),
    confirmed: [...input.confirmed].sort(),
  });
}

/** What the payroll engine used for one employee (from the payslip calc). */
export interface PaySide {
  source: 'feishu' | 'requests';
  otHours: number;
  unpaidLeaveDays: number;
  workDays: number | null;
}

export type DifferenceCode = 'unpaid_leave_differs' | 'ot_differs' | 'work_days_differ' | 'absent_not_deducted' | 'unclassified_leave';

/** Differences between the daily aggregation and the money inputs of the engine (warnings only; no amount changes). */
export function payDifferences(a: EmployeeAggregate, pay: PaySide): DifferenceCode[] {
  const out: DifferenceCode[] = [];
  if (Math.abs(a.unpaidLeaveDays - pay.unpaidLeaveDays) > 0.001) out.push('unpaid_leave_differs');
  if (pay.source === 'feishu' && Math.abs(a.otHours - pay.otHours) > 0.001) out.push('ot_differs');
  if (pay.workDays !== null && Math.abs(a.presentDays - pay.workDays) > 0.001) out.push('work_days_differ');
  if (a.absentDays > 0) out.push('absent_not_deducted');
  if (a.unclassifiedLeaveDays > 0) out.push('unclassified_leave');
  return out;
}

export const DIFFERENCE_LABEL: Record<DifferenceCode, string> = {
  unpaid_leave_differs: 'วันลาไม่รับค่าจ้างจากเวลาทำงานรายวันไม่ตรงกับที่ใช้คำนวณเงินเดือน',
  ot_differs: 'ชั่วโมง OT ที่อนุมัติในระบบไม่ตรงกับ OT ที่ใช้คำนวณ (Feishu)',
  work_days_differ: 'วันมาทำงานจากเวลาทำงานรายวันไม่ตรงกับวันทำงานในไฟล์สรุป Feishu',
  absent_not_deducted: 'มีวันขาดงานตามเวลาทำงานรายวัน (สูตรปัจจุบันไม่หักเงินวันขาดงาน)',
  unclassified_leave: 'มีวันลาจาก Feishu ที่ไม่ทราบว่าได้รับค่าจ้างหรือไม่ (ไม่ถูกนำไปคำนวณ)',
};
