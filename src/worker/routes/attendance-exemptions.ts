// Attendance exemptions of an employee (/api/attendance-exemptions): periods in which the employee does not have to
// record time. View: attendance_exemption.view; create / change / revoke: attendance_exemption.manage. The employee
// must be in a company of the user's scope. Periods never overlap, are revoked rather than deleted, and every change
// is audited with its before / after values. An exemption only changes the warnings of an attendance import; it is
// not read by payroll, leave or overtime.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { currentUser, requireAuth, requirePerm } from '../auth';
import { audit } from '../lib/audit';
import { companyScope } from '../lib/companies';
import { badRequest, conflict, intParam, notFound, readJson } from '../lib/http';
import { bangkokNow } from '../lib/time';
import { exemptionState, overlaps, type ExemptionPeriod } from '../../shared/exemptions';

export const attendanceExemptionRoutes = new Hono<AppEnv>();
attendanceExemptionRoutes.use('*', requireAuth);

interface Row extends ExemptionPeriod {
  id: number;
  employee_id: number;
  reason: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

const SELECT = `SELECT x.id, x.employee_id, x.effective_from, x.effective_to, x.reason, x.created_at, cu.username AS created_by_name, x.updated_at, uu.username AS updated_by_name,
  x.revoked_at, ru.username AS revoked_by_name, x.revoke_reason
  FROM employee_attendance_exemptions x LEFT JOIN users cu ON cu.id = x.created_by LEFT JOIN users uu ON uu.id = x.updated_by LEFT JOIN users ru ON ru.id = x.revoked_by`;

function isoDate(v: unknown, label: string, required: boolean): string | null {
  if (v === null || v === undefined || v === '') {
    if (required) throw badRequest(`กรุณาระบุ${label}`);
    return null;
  }
  const s = String(v);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw badRequest(`${label}ไม่ถูกต้อง`);
  return s;
}
function reasonOf(v: unknown): string {
  const s = String(v ?? '').trim();
  if (s.length < 3) throw badRequest('กรุณาระบุเหตุผล (อย่างน้อย 3 ตัวอักษร)');
  if (s.length > 500) throw badRequest('เหตุผลยาวเกิน 500 ตัวอักษร');
  return s;
}

/** The employee, if the user may see their company (404 otherwise, so other companies' employees are not revealed). */
async function visibleEmployee(c: Context<AppEnv>, id: number) {
  const e = await c.env.DB.prepare("SELECT id, emp_code, first_name || ' ' || last_name AS name, company_id FROM employees WHERE id = ?").bind(id).first<{ id: number; emp_code: string; name: string; company_id: number }>();
  const scope = await companyScope(c.env.DB, currentUser(c));
  if (!e || !scope.items.some((x) => x.id === e.company_id)) throw notFound('ไม่พบพนักงาน');
  return e;
}

async function periodsOf(db: D1Database, employeeId: number): Promise<Row[]> {
  return (await db.prepare(`${SELECT} WHERE x.employee_id = ? ORDER BY x.effective_from DESC, x.id DESC`).bind(employeeId).all<Row>()).results;
}

function assertNoOverlap(list: readonly Row[], next: ExemptionPeriod, exceptId?: number) {
  const hit = list.find((p) => p.id !== exceptId && !p.revoked_at && overlaps(p, next));
  if (hit) throw conflict(`ช่วงวันที่ซ้อนกับช่วงยกเว้นที่มีอยู่ (${hit.effective_from} – ${hit.effective_to ?? 'ไม่กำหนด'})`);
}

attendanceExemptionRoutes.get('/', requirePerm('attendance_exemption.view'), async (c) => {
  const e = await visibleEmployee(c, intParam(c.req.query('employee_id') ?? ''));
  const today = bangkokNow().date;
  const list = await periodsOf(c.env.DB, e.id);
  const items = list.map((p) => ({ ...p, state: exemptionState(p, today) }));
  return c.json({ employee: e, today, active: items.some((p) => p.state === 'active'), items });
});

attendanceExemptionRoutes.post('/', requirePerm('attendance_exemption.manage'), async (c) => {
  const body = await readJson(c);
  const e = await visibleEmployee(c, intParam(String(body.employee_id ?? '')));
  const from = isoDate(body.effective_from, 'วันที่เริ่มมีผล', true)!;
  const to = isoDate(body.effective_to, 'วันที่สิ้นสุด', false);
  if (to && to < from) throw badRequest('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มมีผล');
  const reason = reasonOf(body.reason);
  const db = c.env.DB;
  assertNoOverlap(await periodsOf(db, e.id), { effective_from: from, effective_to: to });
  const user = currentUser(c);
  const r = await db.prepare('INSERT INTO employee_attendance_exemptions (employee_id, effective_from, effective_to, reason, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(e.id, from, to, reason, user.id, user.id).first<{ id: number }>();
  await audit(c, 'attendance_exemption.created', 'employee_attendance_exemptions', r!.id, { employee_id: e.id, company_id: e.company_id, effective_from: from, effective_to: to, reason });
  return c.json((await periodsOf(db, e.id)).find((p) => p.id === r!.id), 201);
});

async function ownedPeriod(c: Context<AppEnv>, id: number) {
  const p = await c.env.DB.prepare(`${SELECT} WHERE x.id = ?`).bind(id).first<Row>();
  if (!p) throw notFound('ไม่พบช่วงการยกเว้น');
  await visibleEmployee(c, p.employee_id);
  return p;
}

/** Change the dates or the reason of a period that is not revoked (e.g. end it on a date). */
attendanceExemptionRoutes.put('/:id', requirePerm('attendance_exemption.manage'), async (c) => {
  const p = await ownedPeriod(c, intParam(c.req.param('id')));
  if (p.revoked_at) throw conflict('ช่วงการยกเว้นนี้ถูกยกเลิกแล้ว แก้ไขไม่ได้');
  const body = await readJson(c);
  const from = body.effective_from === undefined ? p.effective_from : isoDate(body.effective_from, 'วันที่เริ่มมีผล', true)!;
  const to = body.effective_to === undefined ? p.effective_to : isoDate(body.effective_to, 'วันที่สิ้นสุด', false);
  if (to && to < from) throw badRequest('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่มมีผล');
  const reason = body.reason === undefined ? p.reason : reasonOf(body.reason);
  const db = c.env.DB;
  assertNoOverlap(await periodsOf(db, p.employee_id), { effective_from: from, effective_to: to }, p.id);
  await db.prepare("UPDATE employee_attendance_exemptions SET effective_from = ?, effective_to = ?, reason = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(from, to, reason, currentUser(c).id, p.id).run();
  await audit(c, 'attendance_exemption.updated', 'employee_attendance_exemptions', p.id, {
    employee_id: p.employee_id, before: { effective_from: p.effective_from, effective_to: p.effective_to, reason: p.reason }, after: { effective_from: from, effective_to: to, reason },
  });
  return c.json((await periodsOf(db, p.employee_id)).find((x) => x.id === p.id));
});

/** Revoke a period (kept for the history; it no longer exempts any day). */
attendanceExemptionRoutes.post('/:id/revoke', requirePerm('attendance_exemption.manage'), async (c) => {
  const p = await ownedPeriod(c, intParam(c.req.param('id')));
  if (p.revoked_at) throw conflict('ช่วงการยกเว้นนี้ถูกยกเลิกแล้ว');
  const reason = reasonOf((await readJson(c)).reason);
  const user = currentUser(c);
  await c.env.DB.prepare("UPDATE employee_attendance_exemptions SET revoked_at = datetime('now'), revoked_by = ?, revoke_reason = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(user.id, reason, user.id, p.id).run();
  await audit(c, 'attendance_exemption.revoked', 'employee_attendance_exemptions', p.id, { employee_id: p.employee_id, effective_from: p.effective_from, effective_to: p.effective_to, reason });
  return c.json((await periodsOf(c.env.DB, p.employee_id)).find((x) => x.id === p.id));
});
