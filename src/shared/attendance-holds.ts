// Attendance holds (P1): days of a payroll period whose attendance cannot be paid or deducted automatically because it
// is not confirmed — an absent workday, a day covered only by a leave still pending approval, or an employee without
// any attendance at all. Pure function: the worker loads the inputs from D1 (lib/attendance-holds.ts).
//
// Nothing here calculates money. A hold only stops HR approval of the period until HR clears it (with a reason) or the
// source data is corrected (e.g. the leave is approved; an unpaid leave is then deducted by the existing engine rule).
//
// Precedence for one employee on one workday (first match wins):
//   1. covered by an attendance exemption           → not checked
//   2. present (status present / late, or a clock)   → OK, even when a leave of any status covers the day
//   3. covered by an approved leave                  → OK
//   4. covered by a pending leave                    → hold 'pending_leave'
//   5. otherwise                                     → hold 'absent' (rejected / cancelled leave and manual
//                                                      'absent' / 'leave' rows are kept as references)
// A day that is not a workday (weekly rest day, approved holiday, day off / holiday in the shift schedule) is never a
// hold. An employee with no attendance and no leave of any status on any judged workday gets one 'missing_attendance'
// hold for the period instead of one 'absent' hold per day. Days after `today` are never judged.

// invalid_record / pending_review come from the daily attendance validation (P2, shared/attendance-daily.ts); they
// share the lifecycle, the approval gate and the history of the holds detected here
export type HoldKind = 'absent' | 'pending_leave' | 'missing_attendance' | 'invalid_record' | 'pending_review';
export const HOLD_KINDS: readonly HoldKind[] = ['absent', 'pending_leave', 'missing_attendance', 'invalid_record', 'pending_review'];
export const HOLD_KIND_LABEL: Record<HoldKind, string> = {
  absent: 'ขาดงาน (ไม่มีเวลาเข้างานและไม่มีใบลาที่อนุมัติ)',
  pending_leave: 'ใบลารออนุมัติ',
  missing_attendance: 'ไม่มีข้อมูลเวลาทำงานทั้งงวด',
  invalid_record: 'บันทึกเวลาไม่ถูกต้อง (ต้องแก้ไขบันทึก)',
  pending_review: 'บันทึกเวลาไม่ครบหรือขัดแย้ง (รอ HR ยืนยัน)',
};
/** Kinds HR may clear with a reason; an invalid record must be corrected instead. */
export const CLEARABLE_KINDS: ReadonlySet<HoldKind> = new Set(['absent', 'pending_leave', 'missing_attendance', 'pending_review']);

export interface HoldEmployee {
  id: number;
  company_id: number;
  hire_date: string;
  termination_date: string | null;
}

/** Scheduled day kind from the shift schedule (resolveDays); 'none' = no schedule, the holiday calendar decides. */
export type ScheduleKind = 'shift' | 'day_off' | 'holiday' | 'none';

export interface HoldAttendance {
  id: number;
  employee_id: number;
  work_date: string;
  status: string;
  clock_in: string | null;
  clock_out: string | null;
}

export interface HoldLeave {
  /** 'request' = leave_requests.id, 'import' = leave_import_records.id */
  source: 'request' | 'import';
  id: number;
  employee_id: number;
  start_date: string;
  end_date: string;
  status: 'approved' | 'pending' | 'rejected' | 'cancelled';
}

export interface HoldExemption {
  employee_id: number;
  effective_from: string;
  effective_to: string | null;
  revoked_at: string | null;
}

export interface HoldInput {
  periodStart: string;
  periodEnd: string;
  /** last day that may be judged (Asia/Bangkok today) */
  today: string;
  employees: readonly HoldEmployee[];
  /** `${employeeId}|${date}` → kind; a missing key means 'none' */
  schedule: ReadonlyMap<string, ScheduleKind>;
  /** per company: weekly rest weekdays (0 = Sunday) and approved holiday dates */
  calendars: ReadonlyMap<number, { weeklyRest: readonly number[]; holidays: ReadonlySet<string> }>;
  attendance: readonly HoldAttendance[];
  leaves: readonly HoldLeave[];
  exemptions: readonly HoldExemption[];
}

export interface HoldSource {
  attendance?: number[];
  leaves?: Array<{ source: 'request' | 'import'; id: number; status: HoldLeave['status'] }>;
  /** missing_attendance: judged workdays of the employee in the period */
  workdays?: number;
}

export interface DetectedHold {
  employee_id: number;
  company_id: number;
  kind: HoldKind;
  /** null for missing_attendance (one per employee and period) */
  work_date: string | null;
  source: HoldSource;
}

const DAY = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(utc(d)).getUTCDay();

/** Identity of a hold inside a period (employee + kind + date); used for the unique key and the lifecycle. */
export const holdKey = (h: Pick<DetectedHold, 'employee_id' | 'kind' | 'work_date'>): string => `${h.employee_id}|${h.kind}|${h.work_date ?? ''}`;

const PRESENT = new Set(['present', 'late']);
const isPresent = (a: HoldAttendance) => PRESENT.has(a.status) || !!a.clock_in || !!a.clock_out;

export function detectHolds(input: HoldInput): DetectedHold[] {
  const out: DetectedHold[] = [];
  const lastDay = input.periodEnd < input.today ? input.periodEnd : input.today;
  for (const e of input.employees) {
    const from = e.hire_date > input.periodStart ? e.hire_date : input.periodStart;
    let to = lastDay;
    if (e.termination_date && e.termination_date < to) to = e.termination_date;
    if (from > to) continue;
    const cal = input.calendars.get(e.company_id) ?? { weeklyRest: [0, 6], holidays: new Set<string>() };
    const att = input.attendance.filter((a) => a.employee_id === e.id && a.work_date >= from && a.work_date <= to);
    const leaves = input.leaves.filter((l) => l.employee_id === e.id && l.start_date <= to && l.end_date >= from);
    const exempt = input.exemptions.filter((x) => x.employee_id === e.id && !x.revoked_at);

    const perDay: DetectedHold[] = [];
    let workdays = 0;
    let anyPresent = false;
    let anyLeave = false;
    for (let t = utc(from); t <= utc(to); t += DAY) {
      const d = iso(t);
      if (exempt.some((x) => x.effective_from <= d && (!x.effective_to || x.effective_to >= d))) continue;
      const kind = input.schedule.get(`${e.id}|${d}`) ?? 'none';
      const workday = kind === 'shift' ? !cal.holidays.has(d) : kind === 'none' ? !cal.weeklyRest.includes(weekday(d)) && !cal.holidays.has(d) : false;
      if (!workday) continue;
      workdays += 1;
      const rows = att.filter((a) => a.work_date === d);
      if (rows.some(isPresent)) {
        anyPresent = true;
        continue;
      }
      const covering = leaves.filter((l) => l.start_date <= d && l.end_date >= d);
      if (covering.length) anyLeave = true;
      if (covering.some((l) => l.status === 'approved')) continue;
      const leaveRefs = covering.map((l) => ({ source: l.source, id: l.id, status: l.status }));
      const source: HoldSource = { ...(rows.length ? { attendance: rows.map((r) => r.id) } : {}), ...(leaveRefs.length ? { leaves: leaveRefs } : {}) };
      perDay.push({ employee_id: e.id, company_id: e.company_id, kind: covering.some((l) => l.status === 'pending') ? 'pending_leave' : 'absent', work_date: d, source });
    }
    if (!workdays) continue;
    if (!anyPresent && !anyLeave) {
      out.push({ employee_id: e.id, company_id: e.company_id, kind: 'missing_attendance', work_date: null, source: { workdays } });
      continue;
    }
    out.push(...perDay);
  }
  return out;
}

/** Whether attendance review (holds) applies to a period: monthly, starting on or after the configured date. */
export function holdsApply(p: { kind: string; start_date: string }, reviewFrom: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(reviewFrom) && p.kind === 'monthly' && p.start_date >= reviewFrom;
}
