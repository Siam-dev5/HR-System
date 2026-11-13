// Daily attendance of a payroll period in D1 (P2): loads the inputs of the validation / aggregation
// (shared/attendance-daily.ts), computes the attendance version (SHA-256 of the canonical inputs) and keeps one
// append-only snapshot per Calculation Version. Nothing here touches payslips or money.
//
// Consistency of a calculation: the revision watermark (highest attendance revision inside the period's dates) is read
// before anything else; the calculation batch only commits when the watermark is unchanged (guard), and the version is
// computed a second time just before the batch. A change that still lands afterwards (leave, schedule…) is caught by
// the version check before approval, sign-off and publish, which compares the stored snapshot with a fresh load.
import {
  aggregateDaily, aggregateTotals, judgedThrough, todayFor, validateDaily, versionPayload,
  type AggregateTotals, type DailyInput, type DailyLeave, type DailyOvertime, type DailyRecord, type EmployeeAggregate, type Validation,
} from '../../shared/attendance-daily';
import type { HoldExemption, ScheduleKind } from '../../shared/attendance-holds';
import { applicable } from '../routes/holidays';
import { selectedIdsOrNull } from './payroll-selection';
import { HttpError } from './http';
import { resolveDays } from './shift-resolver';
import { bangkokNow } from './time';

export interface DailyPeriod {
  id: number;
  kind: string;
  start_date: string;
  end_date: string;
  company_id: number | null;
}

/** Employees the period pays: the same selection as computePeriod (lib/payroll-engine), or HR's selection (P4). */
async function periodEmployees(db: D1Database, p: DailyPeriod): Promise<DailyInput['employees']> {
  const selected = await selectedIdsOrNull(db, p);
  if (selected) {
    const { results } = await db
      .prepare('SELECT e.id, e.company_id, e.hire_date, e.termination_date FROM employees e WHERE e.id IN (SELECT value FROM json_each(?1)) ORDER BY e.id')
      .bind(JSON.stringify(selected))
      .all<{ id: number; company_id: number; hire_date: string; termination_date: string | null }>();
    return results;
  }
  const { results } = await db
    .prepare(
      `SELECT e.id, e.company_id, e.hire_date, e.termination_date FROM employees e
       WHERE e.hire_date <= ?1 AND e.base_salary IS NOT NULL AND e.base_salary > 0
         AND (e.status IN ('active', 'probation') OR (e.status IN ('resigned', 'terminated') AND e.termination_date IS NOT NULL AND e.termination_date >= ?2))
         AND (?3 IS NULL OR e.company_id = ?3)
       ORDER BY e.id`,
    )
    .bind(p.end_date, p.start_date, p.company_id)
    .all<{ id: number; company_id: number; hire_date: string; termination_date: string | null }>();
  return results;
}

/** Highest attendance revision id touching the period's dates (a record created, corrected or moved in or out). */
export function watermarkSql(param: number): string {
  return `(SELECT IFNULL(MAX(id), 0) FROM attendance_record_revisions WHERE work_date BETWEEN ?${param} AND ?${param + 1} OR prev_work_date BETWEEN ?${param} AND ?${param + 1})`;
}

export async function revisionWatermark(db: D1Database, p: DailyPeriod): Promise<number> {
  const row = await db.prepare(`SELECT ${watermarkSql(1)} AS w`).bind(p.start_date, p.end_date).first<{ w: number }>();
  return row?.w ?? 0;
}

/** Everything the validation, the aggregation and the version need for the period, read from D1. */
export async function loadDaily(db: D1Database, p: DailyPeriod, today = bangkokNow().date): Promise<{ input: DailyInput; watermark: number }> {
  const watermark = await revisionWatermark(db, p);
  const employees = await periodEmployees(db, p);
  const from = p.start_date;
  const to = p.end_date;
  const input: DailyInput = { periodStart: from, periodEnd: to, today, employees, schedule: new Map(), calendars: new Map(), records: [], leaves: [], exemptions: [], overtime: [], confirmed: new Set() };
  if (!employees.length) return { input, watermark };
  const json = JSON.stringify(employees.map((e) => e.id));
  const [days, records, requests, imports, exemptions, overtime, confirmed] = await Promise.all([
    resolveDays(db, employees.map((e) => e.id), from, to),
    db.prepare(
      `SELECT a.id, a.employee_id, a.work_date, a.status, a.clock_in, a.clock_out, a.clock_out_next_day, a.shift_id, a.late_minutes, a.early_leave_minutes, a.worked_minutes,
              (SELECT IFNULL(MAX(v.id), 0) FROM attendance_record_revisions v WHERE v.record_id = a.id) AS revision
       FROM attendance_records a WHERE a.employee_id IN (SELECT value FROM json_each(?1)) AND a.work_date BETWEEN ?2 AND ?3`,
    ).bind(json, from, to).all<DailyRecord>(),
    db.prepare(
      `SELECT l.id, l.employee_id, l.start_date, l.end_date, l.status, t.paid FROM leave_requests l LEFT JOIN leave_types t ON t.id = l.leave_type_id
       WHERE l.employee_id IN (SELECT value FROM json_each(?1)) AND l.start_date <= ?3 AND l.end_date >= ?2 AND l.status IN ('approved', 'pending', 'rejected', 'cancelled')`,
    ).bind(json, from, to).all<{ id: number; employee_id: number; start_date: string; end_date: string; status: DailyLeave['status']; paid: number | null }>(),
    db.prepare(
      `SELECT id, employee_id, start_date, end_date, approval_status AS status FROM leave_import_records
       WHERE status IN ('valid', 'warning') AND employee_id IN (SELECT value FROM json_each(?1)) AND approval_status IN ('approved', 'pending', 'rejected', 'cancelled')
         AND start_date IS NOT NULL AND end_date IS NOT NULL AND start_date <= ?3 AND end_date >= ?2`,
    ).bind(json, from, to).all<{ id: number; employee_id: number; start_date: string; end_date: string; status: DailyLeave['status'] }>(),
    db.prepare('SELECT employee_id, effective_from, effective_to, revoked_at FROM employee_attendance_exemptions WHERE employee_id IN (SELECT value FROM json_each(?1)) AND effective_from <= ?3 AND (effective_to IS NULL OR effective_to >= ?2)')
      .bind(json, from, to).all<HoldExemption>(),
    db.prepare("SELECT id, employee_id, work_date, hours, rate FROM overtime_requests WHERE status = 'approved' AND employee_id IN (SELECT value FROM json_each(?1)) AND work_date BETWEEN ?2 AND ?3")
      .bind(json, from, to).all<DailyOvertime>(),
    db.prepare("SELECT source_json FROM payroll_attendance_holds WHERE period_id = ? AND kind = 'pending_review' AND status = 'cleared'").bind(p.id).all<{ source_json: string }>(),
  ]);
  const schedule = new Map<string, { kind: ScheduleKind; shiftId: number | null }>();
  for (const [key, day] of days) schedule.set(key, { kind: day.kind, shiftId: day.kind === 'shift' ? (day.shift?.id ?? null) : null });
  const calendars = new Map<number, { weeklyRest: number[]; holidays: Set<string> }>();
  for (const companyId of new Set(employees.map((e) => e.company_id))) {
    const a = await applicable(db, companyId, from, to);
    calendars.set(companyId, { weeklyRest: a.weeklyRest, holidays: new Set(a.holidays.map((h) => h.holiday_date)) });
  }
  const ok = new Set<string>();
  for (const r of confirmed.results) {
    const s = JSON.parse(r.source_json) as { record?: number; revision?: number };
    if (typeof s.record === 'number' && typeof s.revision === 'number') ok.add(`${s.record}:${s.revision}`);
  }
  return {
    watermark,
    input: {
      ...input,
      schedule,
      calendars,
      records: records.results,
      leaves: [
        ...requests.results.map((l) => ({ source: 'request' as const, id: l.id, employee_id: l.employee_id, start_date: l.start_date, end_date: l.end_date, status: l.status, paid: l.paid === null ? null : l.paid === 1 })),
        ...imports.results.map((l) => ({ ...l, source: 'import' as const, paid: null })),
      ],
      exemptions: exemptions.results,
      overtime: overtime.results,
      confirmed: ok,
    },
  };
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const attendanceVersion = async (input: DailyInput, p: DailyPeriod): Promise<string> => `av1:${await sha256(versionPayload(input, p))}`;

export interface DailyState {
  input: DailyInput;
  watermark: number;
  version: string;
  judgedThrough: string;
  validation: Validation;
  aggregates: EmployeeAggregate[];
  totals: AggregateTotals;
}

/** Load, validate, aggregate and version the period's daily attendance (one consistent read). */
export async function dailyState(db: D1Database, p: DailyPeriod, today = bangkokNow().date): Promise<DailyState> {
  const { input, watermark } = await loadDaily(db, p, today);
  const validation = validateDaily(input);
  const aggregates = aggregateDaily(input, validation);
  return { input, watermark, version: await attendanceVersion(input, p), judgedThrough: judgedThrough(input), validation, aggregates, totals: aggregateTotals(aggregates) };
}

/** The snapshot of a calculation: written in the calculation batch, append-only (one per period and calc_version). */
export function snapshotStatements(db: D1Database, periodId: number, calcVersion: number, s: DailyState, actorId: number): D1PreparedStatement[] {
  const rows = JSON.stringify(s.aggregates.map((a) => ({ e: a.employee_id, c: a.company_id, a: JSON.stringify(a) })));
  return [
    db.prepare('INSERT INTO payroll_attendance_snapshots (period_id, calc_version, attendance_version, judged_through, revision_watermark, totals_json, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(periodId, calcVersion, s.version, s.judgedThrough, s.watermark, JSON.stringify({ ...s.totals, validation: s.validation.counts, dayIssues: s.validation.days.length }), actorId),
    db.prepare(
      `INSERT INTO payroll_attendance_snapshot_rows (snapshot_id, employee_id, company_id, aggregate_json)
       SELECT (SELECT id FROM payroll_attendance_snapshots WHERE period_id = ?1 AND calc_version = ?2), json_extract(j.value, '$.e'), json_extract(j.value, '$.c'), json_extract(j.value, '$.a')
       FROM json_each(?3) j`,
    ).bind(periodId, calcVersion, rows),
  ];
}

export interface SnapshotRow {
  id: number;
  period_id: number;
  calc_version: number;
  attendance_version: string;
  judged_through: string;
  revision_watermark: number;
  totals_json: string;
  created_at: string;
  created_by: number | null;
}

export async function snapshotOf(db: D1Database, periodId: number, calcVersion: number): Promise<SnapshotRow | null> {
  return db.prepare('SELECT * FROM payroll_attendance_snapshots WHERE period_id = ? AND calc_version = ?').bind(periodId, calcVersion).first<SnapshotRow>();
}

/**
 * The calculation in force must have been made from the attendance as it is now. Refuses (409) when there is no
 * snapshot for the current calc_version (calculated before the review applied) or when any input changed since.
 *   'approval'  HR approves figures that must cover every completed day up to now: a calculation judged through an
 *               earlier day is stale too
 *   'coverage'  ACC sign-off and publish: nothing changed inside the days the approved calculation judged (days that
 *               were still to come when HR approved early are not part of it)
 */
export async function assertAttendanceCurrent(db: D1Database, p: DailyPeriod & { calc_version: number }, mode: 'approval' | 'coverage', today = bangkokNow().date): Promise<void> {
  const snap = await snapshotOf(db, p.id, p.calc_version);
  if (!snap) {
    throw new HttpError(409, 'attendance_snapshot_missing', 'การคำนวณครั้งนี้ไม่มีข้อมูลเวลาทำงานรายวันที่ใช้ (คำนวณก่อนเปิดการตรวจสอบเวลาทำงาน) ต้องคำนวณงวดใหม่');
  }
  const { input } = await loadDaily(db, p, mode === 'coverage' ? todayFor(snap.judged_through) : today);
  if ((await attendanceVersion(input, p)) !== snap.attendance_version) {
    throw new HttpError(409, 'attendance_version_changed', mode === 'approval' && judgedThrough(input) !== snap.judged_through
      ? `การคำนวณครั้งนี้ใช้เวลาทำงานถึงวันที่ ${snap.judged_through} แต่มีวันทำงานที่ผ่านไปเพิ่มเติมแล้ว ต้องคำนวณงวดใหม่ก่อนอนุมัติ`
      : 'ข้อมูลเวลาทำงานรายวัน (บันทึกเวลา การแก้ไข ใบลา ตารางกะ หรือการยืนยันของ HR) เปลี่ยนหลังการคำนวณ ต้องคำนวณงวดใหม่');
  }
}
