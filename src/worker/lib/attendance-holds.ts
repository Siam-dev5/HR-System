// Attendance holds (P1) in D1: loads the inputs of detectHolds (shared/attendance-holds.ts) for a payroll period,
// and keeps payroll_attendance_holds in step with what a scan finds. Nothing here touches payslips or money.
//
// Kinds: absent / pending_leave / missing_attendance (P1, shared/attendance-holds.ts) and invalid_record /
// pending_review (P2 validation of the daily records, shared/attendance-daily.ts); all share this lifecycle.
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
import { validateDaily, validationHolds, type DailyInput } from '../../shared/attendance-daily';
import { loadDaily } from './attendance-daily';
import { loadSettings, settingText } from './settings';
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

/** Everything detectHolds needs for the period, read from D1 (the daily attendance load of P2, projected). */
export async function holdInput(db: D1Database, p: HoldPeriod, today = bangkokNow().date): Promise<HoldInput> {
  return toHoldInput((await loadDaily(db, p, today)).input);
}

/** The P1 view of the daily inputs: the same rows, without the P2 fields. */
export function toHoldInput(d: DailyInput): HoldInput {
  const schedule = new Map<string, ScheduleKind>();
  for (const [key, day] of d.schedule) schedule.set(key, day.kind);
  return {
    periodStart: d.periodStart,
    periodEnd: d.periodEnd,
    today: d.today,
    employees: d.employees,
    schedule,
    calendars: d.calendars,
    attendance: d.records.map((r) => ({ id: r.id, employee_id: r.employee_id, work_date: r.work_date, status: r.status, clock_in: r.clock_in, clock_out: r.clock_out })),
    leaves: d.leaves.map((l) => ({ source: l.source, id: l.id, employee_id: l.employee_id, start_date: l.start_date, end_date: l.end_date, status: l.status })),
    exemptions: d.exemptions,
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
  // P1 detection and the P2 validation of the daily records (invalid_record / pending_review) from one load
  const { input } = await loadDaily(db, p, today);
  const detected: DetectedHold[] = [...detectHolds(toHoldInput(input)), ...validationHolds(validateDaily(input))];
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
