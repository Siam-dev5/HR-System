// Attendance holds (P1) in D1: loads the inputs of detectHolds (shared/attendance-holds.ts) for a payroll period,
// and keeps payroll_attendance_holds in step with what a scan finds. Nothing here touches payslips or money.
//
// Lifecycle of one hold (period + employee + kind + date), each change recorded in payroll_attendance_hold_events:
//   found, no row                         → open      ('opened')
//   open, found again                     → open      (source refreshed, no event)
//   open, no longer found                 → resolved  ('resolved': the source data was corrected)
//   resolved, found again                 → open      ('reopened')
//   cleared by HR, found with the same source → stays cleared (a decision is not undone by an unchanged scan)
//   cleared by HR, found with another source  → open  ('reopened': something new happened that day)
// Every scan writes in one batch (a transaction). A change is claimed with the scan's op_token by a conditional
// update, so concurrent scans never open, resolve or record a change twice; the events of a scan are exactly the rows
// carrying its token.
import { detectHolds, holdKey, holdsApply, type DetectedHold, type HoldInput, type ScheduleKind } from '../../shared/attendance-holds';
import { applicable } from '../routes/holidays';
import { loadSettings, settingText } from './settings';
import { resolveDays } from './shift-resolver';
import { bangkokNow } from './time';

export interface HoldPeriod {
  id: number;
  kind: string;
  start_date: string;
  end_date: string;
  company_id: number | null;
}

export async function attendanceReviewFrom(db: D1Database): Promise<string> {
  return settingText(await loadSettings(db), 'payroll.attendance_review_from', '');
}

/** Whether attendance holds apply to this period (System Setting + monthly period). */
export async function holdsEnabled(db: D1Database, p: HoldPeriod): Promise<boolean> {
  return holdsApply(p, await attendanceReviewFrom(db));
}

/** Employees the period pays: the same selection as computePeriod (lib/payroll-engine). */
async function periodEmployees(db: D1Database, p: HoldPeriod): Promise<HoldInput['employees']> {
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

/** Everything detectHolds needs for the period, read from D1. */
export async function holdInput(db: D1Database, p: HoldPeriod, today = bangkokNow().date): Promise<HoldInput> {
  const employees = await periodEmployees(db, p);
  const ids = employees.map((e) => e.id);
  const from = p.start_date;
  const to = p.end_date;
  const empty: HoldInput = { periodStart: from, periodEnd: to, today, employees, schedule: new Map(), calendars: new Map(), attendance: [], leaves: [], exemptions: [] };
  if (!ids.length) return empty;
  const json = JSON.stringify(ids);
  const [days, attendance, requests, imports, exemptions] = await Promise.all([
    resolveDays(db, ids, from, to),
    db.prepare('SELECT id, employee_id, work_date, status, clock_in, clock_out FROM attendance_records WHERE employee_id IN (SELECT value FROM json_each(?1)) AND work_date BETWEEN ?2 AND ?3')
      .bind(json, from, to).all<HoldInput['attendance'][number]>(),
    db.prepare("SELECT id, employee_id, start_date, end_date, status FROM leave_requests WHERE employee_id IN (SELECT value FROM json_each(?1)) AND start_date <= ?3 AND end_date >= ?2 AND status IN ('approved', 'pending', 'rejected', 'cancelled')")
      .bind(json, from, to).all<{ id: number; employee_id: number; start_date: string; end_date: string; status: 'approved' | 'pending' | 'rejected' | 'cancelled' }>(),
    db.prepare(
      `SELECT id, employee_id, start_date, end_date, approval_status AS status FROM leave_import_records
       WHERE status IN ('valid', 'warning') AND employee_id IN (SELECT value FROM json_each(?1)) AND approval_status IN ('approved', 'pending', 'rejected', 'cancelled')
         AND start_date IS NOT NULL AND end_date IS NOT NULL AND start_date <= ?3 AND end_date >= ?2`,
    ).bind(json, from, to).all<{ id: number; employee_id: number; start_date: string; end_date: string; status: 'approved' | 'pending' | 'rejected' | 'cancelled' }>(),
    db.prepare('SELECT employee_id, effective_from, effective_to, revoked_at FROM employee_attendance_exemptions WHERE employee_id IN (SELECT value FROM json_each(?1)) AND effective_from <= ?3 AND (effective_to IS NULL OR effective_to >= ?2)')
      .bind(json, from, to).all<HoldInput['exemptions'][number]>(),
  ]);
  const schedule = new Map<string, ScheduleKind>();
  for (const [key, day] of days) schedule.set(key, day.kind);
  const calendars = new Map<number, { weeklyRest: number[]; holidays: Set<string> }>();
  for (const companyId of new Set(employees.map((e) => e.company_id))) {
    const a = await applicable(db, companyId, from, to);
    calendars.set(companyId, { weeklyRest: a.weeklyRest, holidays: new Set(a.holidays.map((h) => h.holiday_date)) });
  }
  return {
    ...empty,
    schedule,
    calendars,
    attendance: attendance.results,
    leaves: [...requests.results.map((l) => ({ ...l, source: 'request' as const })), ...imports.results.map((l) => ({ ...l, source: 'import' as const }))],
    exemptions: exemptions.results,
  };
}

export interface ScanResult {
  detected: number;
  opened: number;
  reopened: number;
  resolved: number;
  open: number;
  cleared: number;
}

const KEY = "employee_id || '|' || kind || '|' || IFNULL(work_date, '')";
const found = (param: number) => `(SELECT json_extract(j.value, '$.s') FROM json_each(?${param}) j WHERE json_extract(j.value, '$.k') = ${KEY})`;

/** Runs a scan of the period and brings its holds up to date (see the lifecycle above). */
export async function scanHolds(db: D1Database, p: HoldPeriod, actorId: number, today = bangkokNow().date): Promise<ScanResult> {
  const detected: DetectedHold[] = detectHolds(await holdInput(db, p, today));
  const items = JSON.stringify(detected.map((h) => ({ k: holdKey(h), e: h.employee_id, c: h.company_id, kind: h.kind, d: h.work_date, s: JSON.stringify(h.source) })));
  const op = crypto.randomUUID();
  await db.batch([
    // new holds
    db.prepare(
      `INSERT INTO payroll_attendance_holds (period_id, employee_id, company_id, kind, work_date, source_json, status, op_token, last_action)
       SELECT ?1, json_extract(j.value, '$.e'), json_extract(j.value, '$.c'), json_extract(j.value, '$.kind'), json_extract(j.value, '$.d'), json_extract(j.value, '$.s'), 'open', ?2, 'opened'
       FROM json_each(?3) j WHERE true
       ON CONFLICT DO NOTHING`,
    ).bind(p.id, op, items),
    // found again after it had been resolved, or found with another source after HR cleared it → open again
    db.prepare(
      `UPDATE payroll_attendance_holds SET status = 'open', source_json = ${found(3)}, last_detected_at = datetime('now'), resolved_at = NULL,
         decision_by = NULL, decision_at = NULL, decision_reason = NULL, op_token = ?2, last_action = 'reopened', updated_at = datetime('now')
       WHERE period_id = ?1 AND ${found(3)} IS NOT NULL AND (status = 'resolved' OR (status = 'cleared' AND source_json <> ${found(3)}))`,
    ).bind(p.id, op, items),
    // still open: refresh what was found (no status change, no event)
    db.prepare(`UPDATE payroll_attendance_holds SET source_json = ${found(2)}, last_detected_at = datetime('now'), updated_at = datetime('now') WHERE period_id = ?1 AND status = 'open' AND (op_token IS NOT ?3) AND ${found(2)} IS NOT NULL`)
      .bind(p.id, items, op),
    // open but no longer found → resolved
    db.prepare(
      `UPDATE payroll_attendance_holds SET status = 'resolved', resolved_at = datetime('now'), op_token = ?2, last_action = 'resolved', updated_at = datetime('now')
       WHERE period_id = ?1 AND status = 'open' AND ${found(3)} IS NULL`,
    ).bind(p.id, op, items),
    // history: one event per change claimed by this scan
    db.prepare(
      `INSERT INTO payroll_attendance_hold_events (hold_id, period_id, action, actor_id, reason, source_json)
       SELECT id, period_id, last_action, ?2, CASE last_action WHEN 'resolved' THEN 'ข้อมูลต้นทางถูกแก้ไขแล้ว (scan ไม่พบปัญหา)' ELSE NULL END, source_json
       FROM payroll_attendance_holds WHERE period_id = ?1 AND op_token = ?3`,
    ).bind(p.id, actorId, op),
  ]);
  const counts = await db
    .prepare(
      `SELECT COALESCE(SUM(last_action = 'opened' AND op_token = ?2), 0) AS opened, COALESCE(SUM(last_action = 'reopened' AND op_token = ?2), 0) AS reopened,
              COALESCE(SUM(last_action = 'resolved' AND op_token = ?2), 0) AS resolved, COALESCE(SUM(status = 'open'), 0) AS open, COALESCE(SUM(status = 'cleared'), 0) AS cleared
       FROM payroll_attendance_holds WHERE period_id = ?1`,
    )
    .bind(p.id, op)
    .first<Omit<ScanResult, 'detected'>>();
  return { detected: detected.length, opened: counts?.opened ?? 0, reopened: counts?.reopened ?? 0, resolved: counts?.resolved ?? 0, open: counts?.open ?? 0, cleared: counts?.cleared ?? 0 };
}

/** HR clears an open hold (no deduction). Returns false when the hold is not open any more (nothing written). */
export async function clearHold(db: D1Database, holdId: number, actorId: number, reason: string): Promise<boolean> {
  const op = crypto.randomUUID();
  const res = await db.batch([
    db.prepare(
      `UPDATE payroll_attendance_holds SET status = 'cleared', decision_by = ?2, decision_at = datetime('now'), decision_reason = ?3, op_token = ?4, last_action = 'cleared', updated_at = datetime('now')
       WHERE id = ?1 AND status = 'open'`,
    ).bind(holdId, actorId, reason, op),
    db.prepare(
      `INSERT INTO payroll_attendance_hold_events (hold_id, period_id, action, actor_id, reason, source_json)
       SELECT id, period_id, 'cleared', ?2, ?3, source_json FROM payroll_attendance_holds WHERE id = ?1 AND op_token = ?4`,
    ).bind(holdId, actorId, reason, op),
  ]);
  return (res[0]?.meta.changes ?? 0) > 0;
}
