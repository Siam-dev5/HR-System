// Writing daily attendance (P2): every change of attendance_records carries an operation token, a channel, a reason
// and a reference; triggers of migration 0020 turn that into an immutable revision (original and corrected values),
// refuse deletes, and refuse changes inside an approved / published monthly period. The helpers here give the same
// checks a readable answer before writing (company scope, period lock, reason) — the triggers stay the guarantee.
import type { AuthUser } from '../env';
import { companyScope } from './companies';
import { badRequest, conflict, HttpError, notFound } from './http';
import { attendanceReviewFrom } from './attendance-holds';

export type ChangeChannel = 'correction' | 'crud' | 'time_correction' | 'web';

export interface ChangeMeta {
  op: string;
  channel: ChangeChannel;
  reason: string | null;
  reference: string | null;
}

export const newChange = (channel: ChangeChannel, reason: string | null, reference: string | null): ChangeMeta => ({ op: crypto.randomUUID(), channel, reason, reference });

/** SET fragment + values of a change (append to an UPDATE of attendance_records). */
export const CHANGE_SET = 'change_op = ?, change_channel = ?, change_reason = ?, change_reference = ?';
export const changeValues = (m: ChangeMeta): Array<string | null> => [m.op, m.channel, m.reason, m.reference];

export interface AttendanceEmployee {
  id: number;
  company_id: number;
  hire_date: string;
  termination_date: string | null;
}

/** The employee of an attendance record, when the user's company scope covers them (404 otherwise, like a missing row). */
export async function scopedEmployee(db: D1Database, user: AuthUser, employeeId: number): Promise<AttendanceEmployee> {
  const e = await db.prepare('SELECT id, company_id, hire_date, termination_date FROM employees WHERE id = ?').bind(employeeId).first<AttendanceEmployee>();
  if (!e) throw notFound('ไม่พบพนักงาน');
  const scope = await companyScope(db, user);
  if (scope.scope !== 'all' && !scope.items.some((x) => x.id === e.company_id)) throw notFound('ไม่พบพนักงาน');
  return e;
}

/** Approved / published monthly period of the employee's company covering one of the dates (its days are locked). */
export async function attendanceLock(db: D1Database, companyId: number, dates: readonly string[]): Promise<{ code: string; status: string; date: string } | null> {
  for (const d of [...new Set(dates)]) {
    const p = await db
      .prepare("SELECT code, status FROM payroll_periods WHERE kind = 'monthly' AND deleted_at IS NULL AND status IN ('approved', 'published') AND start_date <= ?1 AND end_date >= ?1 AND (company_id IS NULL OR company_id = ?2) LIMIT 1")
      .bind(d, companyId)
      .first<{ code: string; status: string }>();
    if (p) return { ...p, date: d };
  }
  return null;
}

export const lockedMessage = (l: { code: string; status: string; date: string }) =>
  `วันที่ ${l.date} อยู่ในงวดเงินเดือน ${l.code} ที่${l.status === 'published' ? 'เผยแพร่' : 'อนุมัติ'}แล้ว แก้ไขเวลาทำงานไม่ได้ ต้องเปิดงวดใหม่ตามขั้นตอนที่ได้รับอนุญาตก่อน`;

export async function assertNotLocked(db: D1Database, companyId: number, dates: readonly string[]): Promise<void> {
  const l = await attendanceLock(db, companyId, dates);
  if (l) throw new HttpError(409, 'attendance_period_locked', lockedMessage(l));
}

/** Throws the HTTP answer of a database error raised by the attendance triggers; returns for any other error. */
export function attendanceDbError(e: unknown): void {
  const text = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  if (text.includes('attendance_period_locked')) throw new HttpError(409, 'attendance_period_locked', 'วันที่นี้อยู่ในงวดเงินเดือนที่อนุมัติหรือเผยแพร่แล้ว บันทึกหรือแก้ไขเวลาทำงานไม่ได้ (ติดต่อ HR)');
  if (text.includes('never deleted')) throw new HttpError(409, 'attendance_delete_forbidden', 'ลบบันทึกเวลาทำงานไม่ได้ ใช้การแก้ไขพร้อมเหตุผลแทน (ประวัติการแก้ไขถูกเก็บไว้)');
}

/** A database error of an attendance write, as an HTTP answer (rethrows anything else). */
export function translateAttendanceError(e: unknown): never {
  attendanceDbError(e);
  const text = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  if (/UNIQUE constraint failed: attendance_records/i.test(text)) throw conflict('มีบันทึกเวลาของพนักงานในวันนี้อยู่แล้ว ให้แก้ไขบันทึกเดิมแทน');
  throw e;
}

/**
 * Generic CRUD (/api/m/attendance) keeps working (D2 option A) with the same checks as a correction: company scope of
 * the employee before and after, the period lock of both dates, and a revision for every write. Inside the attendance
 * review dates (payroll.attendance_review_from) the body must carry correction_reason + correction_reference
 * (400 correction_reason_required otherwise — use POST /api/attendance/records/:id/correct); outside them a missing
 * reason is allowed for compatibility and recorded as reason_missing = 1 on the revision.
 */
export async function crudChange(
  db: D1Database,
  user: AuthUser,
  body: Record<string, unknown>,
  existing: { employee_id: number; work_date: string } | null,
  values: Record<string, unknown>,
): Promise<ChangeMeta> {
  const employees = [...new Set([existing?.employee_id, (values.employee_id as number | undefined) ?? existing?.employee_id].filter((x): x is number => typeof x === 'number'))];
  const dates = [...new Set([existing?.work_date, (values.work_date as string | undefined) ?? existing?.work_date].filter((x): x is string => typeof x === 'string'))];
  for (const id of employees) {
    const e = await scopedEmployee(db, user, id);
    await assertNotLocked(db, e.company_id, dates);
  }
  const given = typeof body.correction_reason === 'string' && body.correction_reason.trim() !== '';
  if (given || (await underReview(db, dates))) {
    const { reason, reference } = correctionText(body, 'correction_reason', 'correction_reference');
    return newChange('crud', reason, reference);
  }
  return newChange('crud', null, null);
}

/** Whether a date is inside the attendance review (System Setting payroll.attendance_review_from, empty = off). */
export async function underReview(db: D1Database, dates: readonly string[]): Promise<boolean> {
  const from = await attendanceReviewFrom(db);
  return /^\d{4}-\d{2}-\d{2}$/.test(from) && dates.some((d) => d >= from);
}

export const MIN_REASON = 5;

/** Reason and reference of a correction (both required). */
export function correctionText(body: Record<string, unknown>, reasonKey = 'reason', referenceKey = 'reference'): { reason: string; reference: string } {
  const reason = typeof body[reasonKey] === 'string' ? (body[reasonKey] as string).trim() : '';
  const reference = typeof body[referenceKey] === 'string' ? (body[referenceKey] as string).trim() : '';
  if (reason.length < MIN_REASON || reason.length > 500) throw new HttpError(400, 'correction_reason_required', `ต้องระบุเหตุผลการแก้ไข (${MIN_REASON}–500 ตัวอักษร)`);
  if (!reference || reference.length > 200) throw new HttpError(400, 'correction_reason_required', 'ต้องระบุเอกสารอ้างอิงของการแก้ไข (ไม่เกิน 200 ตัวอักษร)');
  return { reason, reference };
}

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export function timeOrNull(body: Record<string, unknown>, key: string): string | null | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || !TIME_RE.test(v)) throw badRequest(`${key} ต้องเป็นเวลา HH:MM`);
  return v;
}
