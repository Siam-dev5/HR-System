// HR attendance review before Calculate (management decision 2026-11-16, migration 0025, docs/HR-PAYROLL-POLICY.md §3.2).
// Built on the daily attendance of P2 (lib/attendance-daily.ts): the same load, validation, aggregation and version, cut
// per company, so a confirmation of one company is not undone by a change in another company of the same period.
//
// Lifecycle of a confirmation (payroll_attendance_reviews, one row per confirmation, never deleted):
//   HR confirms version V of company C           → 'confirmed' (a confirmation in force of C is 'superseded')
//   the attendance of C changes (version ≠ V)    → 'invalidated' as soon as the review is read or a calculation tried
// Calculate needs, for every company the period pays, a confirmation in force whose version equals the version now.
// Approval needs the confirmation the payslips were calculated after to be still in force and current.
// The confirmation checks data; it never changes an amount (the days actually worked never multiply the salary).
import {
  payrollDeductions, versionPayload, type DailyInput, type EmployeeAggregate, type PayrollDeduction,
} from '../../shared/attendance-daily';
import { wageSegments } from '../../shared/payroll';
import { attendanceVersion, type DailyPeriod, type DailyState } from './attendance-daily';
import { HttpError } from './http';
import { loadSettings, payrollConfig } from './settings';

export type ReviewStatus = 'pending' | 'confirmed' | 'changed';

export interface ReviewRow {
  id: number;
  period_id: number;
  company_id: number;
  attendance_version: string;
  judged_through: string;
  revision_watermark: number;
  summary_json: string;
  note: string | null;
  status: 'confirmed' | 'superseded' | 'invalidated';
  confirmed_by: number;
  confirmed_at: string;
  ended_at: string | null;
  ended_by: number | null;
  ended_reason: string | null;
}

/** The daily input of one company: its employees and everything about them (the period's other companies left out). */
export function companyInput(input: DailyInput, companyId: number): DailyInput {
  const ids = new Set(input.employees.filter((e) => e.company_id === companyId).map((e) => e.id));
  const recordIds = new Set(input.records.filter((r) => ids.has(r.employee_id)).map((r) => r.id));
  const of = (key: string) => ids.has(Number(key.split('|')[0]));
  return {
    ...input,
    employees: input.employees.filter((e) => ids.has(e.id)),
    schedule: new Map([...input.schedule].filter(([k]) => of(k))),
    calendars: new Map([...input.calendars].filter(([id]) => id === companyId)),
    records: input.records.filter((r) => ids.has(r.employee_id)),
    leaves: input.leaves.filter((l) => ids.has(l.employee_id)),
    exemptions: input.exemptions.filter((x) => ids.has(x.employee_id)),
    overtime: input.overtime.filter((o) => ids.has(o.employee_id)),
    confirmed: new Set([...input.confirmed].filter((k) => recordIds.has(Number(k.split(':')[0])))),
    ...(input.excused ? { excused: new Set([...input.excused].filter(of)) } : {}),
  };
}

/** Attendance version of one company in the period (v1 hash of its own inputs only). */
export async function companyVersion(state: DailyState, p: DailyPeriod, companyId: number): Promise<string> {
  return attendanceVersion(companyInput(state.input, companyId), { ...p, company_id: companyId });
}

/** Companies of the employees the period pays (from the daily load, i.e. the period's selection). */
export const periodCompanies = (state: DailyState): number[] => [...new Set(state.input.employees.map((e) => e.company_id))].sort((a, b) => a - b);

export interface ReviewEmployee {
  employee_id: number;
  emp_code: string;
  name: string;
  company_id: number;
  /** salary entitlement: days the wage pays on the 30-day base */
  entitlementDays: number;
  calendarEntitled: boolean | null;
  /** scheduled workdays in the employment inside the period (company calendar / schedule) */
  expectedWorkDays: number;
  /** days with a counted presence (display and control only: never a salary multiplier) */
  actualWorkDays: number;
  actualWorkHours: number;
  unpaidLeaveDays: number;
  absenceDays: number;
  payableDays: number;
  paidLeaveDays: number;
  /** anomalies: not deducted, listed for HR */
  missingAttendanceDays: number;
  unverifiedDays: number;
  pendingLeaveDays: number;
  unclassifiedLeaveDays: number;
  invalidRecords: number;
  pendingReviewRecords: number;
  deductions: PayrollDeduction['items'];
}

/** Per-employee review figures of the period (pure reads; the same rules as the payroll engine). */
export async function reviewEmployees(db: D1Database, p: DailyPeriod, state: DailyState): Promise<ReviewEmployee[]> {
  const ids = state.input.employees.map((e) => e.id);
  if (!ids.length) return [];
  const json = JSON.stringify(ids);
  const [emps, history, settings] = await Promise.all([
    db.prepare('SELECT id, emp_code, first_name, last_name, base_salary, hire_date, termination_date FROM employees WHERE id IN (SELECT value FROM json_each(?1))')
      .bind(json).all<{ id: number; emp_code: string; first_name: string; last_name: string; base_salary: number; hire_date: string; termination_date: string | null }>(),
    db.prepare('SELECT employee_id, effective_date, base_salary FROM employee_salary_history WHERE effective_date <= ?2 AND employee_id IN (SELECT value FROM json_each(?1))')
      .bind(json, p.end_date).all<{ employee_id: number; effective_date: string; base_salary: number }>(),
    loadSettings(db),
  ]);
  const cfg = payrollConfig(settings);
  const agg = new Map<number, EmployeeAggregate>(state.aggregates.map((a) => [a.employee_id, a]));
  const out: ReviewEmployee[] = [];
  for (const e of state.input.employees) {
    const row = emps.results.find((x) => x.id === e.id);
    if (!row) continue;
    const wage = wageSegments({
      periodStart: p.start_date, periodEnd: p.end_date, hireDate: row.hire_date, terminationDate: row.termination_date, baseSalary: row.base_salary,
      history: history.results.filter((h) => h.employee_id === e.id).map((h) => ({ from: h.effective_date, amount: h.base_salary })),
      mode: p.kind === 'mid_month' ? 'mid_month' : 'monthly', divisorDays: cfg.otDivisorDays,
    });
    const ded = wage.from && wage.to ? payrollDeductions(state.input, state.validation, e.id, wage.from, wage.to) : { unpaidLeaveDays: 0, absenceDays: 0, items: [] };
    const entitlementDays = wage.segments.reduce((a, s) => a + s.paidDays, 0);
    const a = agg.get(e.id);
    const records = state.validation.records.filter((v) => v.record.employee_id === e.id);
    out.push({
      employee_id: e.id, emp_code: row.emp_code, name: `${row.first_name} ${row.last_name}`, company_id: e.company_id,
      entitlementDays, calendarEntitled: wage.calendarEntitled ?? null,
      expectedWorkDays: a?.scheduledWorkDays ?? 0, actualWorkDays: a?.actualWorkDays ?? 0, actualWorkHours: Math.round(((a?.workedMinutes ?? 0) / 60) * 100) / 100,
      unpaidLeaveDays: ded.unpaidLeaveDays, absenceDays: ded.absenceDays,
      payableDays: Math.max(0, Math.round((entitlementDays - ded.unpaidLeaveDays - ded.absenceDays) * 100) / 100),
      paidLeaveDays: a?.paidLeaveDays ?? 0,
      missingAttendanceDays: a?.missingAttendanceDays ?? 0, unverifiedDays: a?.unverifiedDays ?? 0, pendingLeaveDays: a?.pendingLeaveDays ?? 0,
      unclassifiedLeaveDays: a?.unclassifiedLeaveDays ?? 0,
      invalidRecords: records.filter((v) => v.status === 'invalid').length,
      pendingReviewRecords: records.filter((v) => v.status === 'pending_review' && !v.confirmed).length,
      deductions: ded.items,
    });
  }
  return out.sort((x, y) => x.emp_code.localeCompare(y.emp_code));
}

export async function confirmedReview(db: D1Database, periodId: number, companyId: number): Promise<ReviewRow | null> {
  return db.prepare("SELECT * FROM payroll_attendance_reviews WHERE period_id = ? AND company_id = ? AND status = 'confirmed'").bind(periodId, companyId).first<ReviewRow>();
}

/** Ends a confirmation whose attendance changed (idempotent: only a confirmation still in force is written). */
export async function invalidateReview(db: D1Database, review: ReviewRow, actorId: number | null, version: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE payroll_attendance_reviews SET status = 'invalidated', ended_at = datetime('now'), ended_by = ?2, ended_reason = ?3 WHERE id = ?1 AND status = 'confirmed'")
    .bind(review.id, actorId, `attendance_changed: ${review.attendance_version} → ${version}`)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export interface CompanyReview {
  company_id: number;
  status: ReviewStatus;
  version: string;
  review: ReviewRow | null;
  /** a confirmation this read found stale and ended */
  invalidated: ReviewRow | null;
}

/** Review status of every company of the period, ending the confirmations whose attendance changed. */
export async function companyReviews(db: D1Database, p: DailyPeriod, state: DailyState, actorId: number | null, companies = periodCompanies(state)): Promise<CompanyReview[]> {
  const out: CompanyReview[] = [];
  for (const companyId of companies) {
    const version = await companyVersion(state, p, companyId);
    const review = await confirmedReview(db, p.id, companyId);
    if (review && review.attendance_version !== version) {
      await invalidateReview(db, review, actorId, version);
      out.push({ company_id: companyId, status: 'changed', version, review: null, invalidated: review });
    } else {
      out.push({ company_id: companyId, status: review ? 'confirmed' : 'pending', version, review, invalidated: null });
    }
  }
  return out;
}

/** Calculate gate: the refusal when a company the period pays has no current confirmation (null = every one has). */
export function reviewGateError(list: readonly CompanyReview[], code: string, names: ReadonlyMap<number, string> = new Map()): HttpError | null {
  const label = (xs: readonly CompanyReview[]) => xs.map((x) => names.get(x.company_id) ?? `#${x.company_id}`).join(', ');
  const changed = list.filter((x) => x.status === 'changed');
  if (changed.length) {
    return new HttpError(409, 'attendance_review_changed', `ข้อมูลเวลาทำงานเปลี่ยนหลังจาก HR ยืนยันการตรวจสอบ (${label(changed)}) การยืนยันเดิมถูกยกเลิกแล้ว ต้องตรวจสอบและยืนยันวันทำงานจริงใหม่ก่อนคำนวณงวด ${code}`);
  }
  const pending = list.filter((x) => x.status === 'pending');
  if (pending.length) {
    return new HttpError(409, 'attendance_review_required', `ยังคำนวณงวด ${code} ไม่ได้: HR ต้องตรวจสอบและยืนยันวันทำงานจริง (Attendance Review) ของ ${label(pending)} ก่อน`);
  }
  return null;
}

/** Company names for messages. */
export async function companyNames(db: D1Database, ids: readonly number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const { results } = await db.prepare('SELECT id, name FROM companies WHERE id IN (SELECT value FROM json_each(?1))').bind(JSON.stringify(ids)).all<{ id: number; name: string }>();
  return new Map(results.map((r) => [r.id, r.name]));
}

/** The review ids recorded on a payslip calc (attendance.review). */
export function reviewIdsOf(calcJson: string | null): number[] {
  if (!calcJson) return [];
  try {
    const c = JSON.parse(calcJson) as { attendance?: { review?: Array<{ id: number }> } };
    return (c.attendance?.review ?? []).map((r) => r.id).filter((id) => Number.isInteger(id));
  } catch {
    return [];
  }
}

/** Version payload text of one company (exported for tests). */
export const companyPayload = (input: DailyInput, p: DailyPeriod, companyId: number): string => versionPayload(companyInput(input, companyId), { ...p, company_id: companyId });
