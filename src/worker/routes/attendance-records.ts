// HR corrections of daily attendance (P2): correct a record, add a missing day, read a record's history. Each write
// requires a reason and a reference, respects the company scope and the payroll period lock, and appends an immutable
// revision (original and corrected values) through the triggers of migration 0020. Nothing here touches payroll money;
// a correction inside a calculated period makes its attendance version stale (recalculation before approval).
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { currentUser, requireAuth, requirePerm } from '../auth';
import { audit } from '../lib/audit';
import { badRequest, conflict, HttpError, intParam, notFound, readJson } from '../lib/http';
import { loadSettings, settingText } from '../lib/settings';
import { shiftForDay, shiftTimes } from '../lib/shift-resolver';
import { bangkokNow } from '../lib/time';
import { checkClock } from '../../shared/shifts';
import { CHANGE_SET, assertNotLocked, changeValues, correctionText, newChange, scopedEmployee, timeOrNull, translateAttendanceError, type AttendanceEmployee } from '../lib/attendance-records';

export const attendanceRecordRoutes = new Hono<AppEnv>();
attendanceRecordRoutes.use('*', requireAuth);

const STATUSES = new Set(['present', 'late', 'absent', 'leave']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Rec {
  id: number;
  employee_id: number;
  work_date: string;
  clock_in: string | null;
  clock_out: string | null;
  clock_out_next_day: number;
  status: string;
  shift_id: number | null;
  late_minutes: number | null;
  early_leave_minutes: number | null;
  worked_minutes: number | null;
  note: string | null;
  change_op: string | null;
}
const REC_COLUMNS = 'id, employee_id, work_date, clock_in, clock_out, clock_out_next_day, status, shift_id, late_minutes, early_leave_minutes, worked_minutes, note, change_op';

interface Day {
  clock_in: string | null;
  clock_out: string | null;
  clock_out_next_day: number;
  status: string;
  shift_id: number | null;
  late_minutes: number | null;
  early_leave_minutes: number | null;
  worked_minutes: number | null;
}

/**
 * The values of a day after the change: times checked against the shift in force that day (as the import and web
 * clock-in do). A day with a clock-in is present / late by that check; absent / leave have no clock times.
 */
async function evaluate(db: D1Database, e: AttendanceEmployee, date: string, clockIn: string | null, clockOut: string | null, nextDay: boolean, status: string | null): Promise<Day> {
  if (status !== null && !STATUSES.has(status)) throw badRequest('status ต้องเป็น present, late, absent หรือ leave');
  if (status === 'absent' || status === 'leave') {
    if (clockIn || clockOut) throw badRequest('สถานะขาดงาน/ลา ต้องไม่มีเวลาเข้า-ออก (ล้างเวลาก่อน)');
    return { clock_in: null, clock_out: null, clock_out_next_day: 0, status, shift_id: null, late_minutes: null, early_leave_minutes: null, worked_minutes: null };
  }
  if (!clockIn) throw badRequest('ต้องระบุเวลาเข้างาน (หรือกำหนดสถานะเป็นขาดงาน/ลา)');
  const day = await shiftForDay(db, e.id, date);
  const shift = day.kind === 'shift' ? day.shift : null;
  const defaultStart = settingText(await loadSettings(db), 'attendance.default_start_time', '09:00');
  const check = checkClock(shift ? shiftTimes(shift) : null, clockIn, clockOut, { outNextDay: nextDay, defaultStart });
  if (check.error) throw badRequest('เวลาออกงานห่างจากเวลาเข้างานเกิน 24 ชั่วโมง');
  return {
    clock_in: clockIn,
    clock_out: clockOut,
    clock_out_next_day: clockOut && check.outNextDay ? 1 : 0,
    status: check.status,
    shift_id: shift?.id ?? null,
    late_minutes: check.lateMinutes,
    early_leave_minutes: clockOut && shift ? check.earlyLeaveMinutes : null,
    worked_minutes: check.workedMinutes,
  };
}

function inEmployment(e: AttendanceEmployee, date: string): void {
  if (date < e.hire_date || (e.termination_date && date > e.termination_date)) throw badRequest('วันที่อยู่นอกช่วงการจ้างงานของพนักงาน');
  if (date > bangkokNow().date) throw badRequest('บันทึกเวลาของวันในอนาคตไม่ได้');
}

const view = (r: Rec | Day) => ({ clock_in: r.clock_in, clock_out: r.clock_out, clock_out_next_day: r.clock_out_next_day, status: r.status, shift_id: r.shift_id, late_minutes: r.late_minutes, early_leave_minutes: r.early_leave_minutes, worked_minutes: r.worked_minutes });

/** Correct one record: new times and / or status, with a reason and a reference. */
attendanceRecordRoutes.post('/:id/correct', requirePerm('attendance.correct'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const id = intParam(c.req.param('id'));
  const body = await readJson(c);
  const { reason, reference } = correctionText(body);
  const rec = await db.prepare(`SELECT ${REC_COLUMNS} FROM attendance_records WHERE id = ?`).bind(id).first<Rec>();
  if (!rec) throw notFound('ไม่พบบันทึกเวลา');
  const e = await scopedEmployee(db, user, rec.employee_id);
  const clockIn = timeOrNull(body, 'clock_in');
  const clockOut = timeOrNull(body, 'clock_out');
  const status = typeof body.status === 'string' ? body.status : null;
  if (clockIn === undefined && clockOut === undefined && status === null && !('clock_out_next_day' in body)) throw badRequest('ไม่มีข้อมูลที่จะแก้ไข');
  const nextDay = 'clock_out_next_day' in body ? body.clock_out_next_day === true || body.clock_out_next_day === 1 : rec.clock_out_next_day === 1;
  const keepTimes = status !== 'absent' && status !== 'leave';
  // absent / leave with clock times is contradictory: refused (never silently drop what the user sent)
  if (!keepTimes && (clockIn || clockOut)) throw badRequest('สถานะขาดงาน/ลา ต้องไม่มีเวลาเข้า-ออก (ล้างเวลาก่อน)');
  const after = await evaluate(db, e, rec.work_date, keepTimes ? (clockIn === undefined ? rec.clock_in : clockIn) : null, keepTimes ? (clockOut === undefined ? rec.clock_out : clockOut) : null, nextDay, status === 'present' || status === 'late' ? null : status);
  // nothing the user gives changes (times, next-day flag, an explicit absent / leave): not a correction
  if (after.clock_in === rec.clock_in && after.clock_out === rec.clock_out && after.clock_out_next_day === rec.clock_out_next_day && (keepTimes || after.status === rec.status)) {
    throw badRequest('ค่าที่แก้ไขเหมือนค่าเดิม');
  }
  await assertNotLocked(db, e.company_id, [rec.work_date]);
  const change = newChange('correction', reason, reference);
  // optimistic: the record must still be the one that was read (another correction in between → 409, nothing written)
  let changed = 0;
  try {
    const res = await db
      .prepare(
        `UPDATE attendance_records SET clock_in = ?, clock_out = ?, clock_out_next_day = ?, status = ?, shift_id = ?, late_minutes = ?, early_leave_minutes = ?, worked_minutes = ?,
           source = 'manual', ${CHANGE_SET}, updated_at = datetime('now'), updated_by = ? WHERE id = ? AND change_op IS ?`,
      )
      .bind(after.clock_in, after.clock_out, after.clock_out_next_day, after.status, after.shift_id, after.late_minutes, after.early_leave_minutes, after.worked_minutes, ...changeValues(change), user.id, id, rec.change_op)
      .run();
    changed = res.meta.changes ?? 0;
  } catch (err) {
    translateAttendanceError(err);
  }
  if (!changed) throw conflict('บันทึกเวลานี้ถูกแก้ไขระหว่างดำเนินการ กรุณาโหลดใหม่');
  const revision = await db.prepare('SELECT id FROM attendance_record_revisions WHERE op_token = ?').bind(change.op).first<{ id: number }>();
  await audit(c, 'attendance.corrected', 'attendance_records', id, { employee_id: rec.employee_id, work_date: rec.work_date, before: view(rec), after: view(after), reason, reference, revision: revision?.id ?? null, op: change.op });
  return c.json({ ok: true, id, revision: revision?.id ?? null, ...view(after) });
});

/** Add the attendance of a day that has no record (a missing day), with a reason and a reference. */
attendanceRecordRoutes.post('/', requirePerm('attendance.correct'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const body = await readJson(c);
  const { reason, reference } = correctionText(body);
  const employeeId = Number(body.employee_id);
  if (!Number.isInteger(employeeId) || employeeId <= 0) throw badRequest('ต้องระบุพนักงาน');
  const date = typeof body.work_date === 'string' && DATE_RE.test(body.work_date) ? body.work_date : null;
  if (!date) throw badRequest('work_date ต้องเป็นวันที่ YYYY-MM-DD');
  const e = await scopedEmployee(db, user, employeeId);
  inEmployment(e, date);
  const status = typeof body.status === 'string' ? body.status : null;
  const after = await evaluate(db, e, date, timeOrNull(body, 'clock_in') ?? null, timeOrNull(body, 'clock_out') ?? null, body.clock_out_next_day === true || body.clock_out_next_day === 1, status === 'present' || status === 'late' ? null : status);
  await assertNotLocked(db, e.company_id, [date]);
  const change = newChange('correction', reason, reference);
  let id = 0;
  try {
    const row = await db
      .prepare(
        `INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, clock_out_next_day, status, shift_id, late_minutes, early_leave_minutes, worked_minutes, source,
           change_op, change_channel, change_reason, change_reference, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(e.id, date, after.clock_in, after.clock_out, after.clock_out_next_day, after.status, after.shift_id, after.late_minutes, after.early_leave_minutes, after.worked_minutes, ...changeValues(change), user.id, user.id)
      .first<{ id: number }>();
    id = row?.id ?? 0;
  } catch (err) {
    translateAttendanceError(err);
  }
  if (!id) throw new HttpError(500, 'insert_failed', 'บันทึกไม่สำเร็จ');
  const revision = await db.prepare('SELECT id FROM attendance_record_revisions WHERE op_token = ?').bind(change.op).first<{ id: number }>();
  await audit(c, 'attendance.added', 'attendance_records', id, { employee_id: e.id, work_date: date, after: view(after), reason, reference, revision: revision?.id ?? null, op: change.op });
  return c.json({ ok: true, id, revision: revision?.id ?? null, ...view(after) }, 201);
});

/** History of one record: every revision with its original and corrected values (append-only). */
attendanceRecordRoutes.get('/:id/revisions', requirePerm('attendance.all'), async (c) => {
  const db = c.env.DB;
  const id = intParam(c.req.param('id'));
  const rec = await db.prepare('SELECT employee_id FROM attendance_records WHERE id = ?').bind(id).first<{ employee_id: number }>();
  if (!rec) throw notFound('ไม่พบบันทึกเวลา');
  await scopedEmployee(db, currentUser(c), rec.employee_id);
  const { results } = await db
    .prepare(
      `SELECT v.id, v.action, v.channel, v.work_date, v.prev_work_date, v.before_json, v.after_json, v.reason, v.reference, v.reason_missing, v.op_token, v.created_at, u.username AS actor
       FROM attendance_record_revisions v LEFT JOIN users u ON u.id = v.actor_id WHERE v.record_id = ? ORDER BY v.id`,
    )
    .bind(id)
    .all<{ before_json: string | null; after_json: string } & Record<string, unknown>>();
  return c.json({
    id,
    revisions: results.map(({ before_json, after_json, ...r }) => ({ ...r, before: before_json ? JSON.parse(before_json) : null, after: JSON.parse(after_json) })),
  });
});
