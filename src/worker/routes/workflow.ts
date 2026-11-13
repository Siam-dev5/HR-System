import { Hono } from 'hono';
import { assertNotLocked, attendanceDbError, changeValues, newChange } from '../lib/attendance-records';
import type { Context } from 'hono';
import type { AppEnv, AuthUser } from '../env';
import type { CrudModule } from '../../shared/modules';
import { crudModule, isSuperAdmin } from '../../shared/modules';
import type { WorkflowRequestRow } from '../../shared/types';
import { badRequest, conflict, forbidden, intParam, notFound, readJson, str } from '../lib/http';
import { audit, notify } from '../lib/audit';
import { can, currentUser, requireAuth, requirePerm } from '../auth';
import { shiftForDay, shiftTimes } from '../lib/shift-resolver';
import { loadSettings, settingText } from '../lib/settings';
import { checkClock } from '../../shared/shifts';

interface StepDef {
  step: number;
  name: string;
  role_code: string;
}

async function steps(db: D1Database, type: string): Promise<StepDef[]> {
  const { results } = await db
    .prepare('SELECT d.step, d.name, r.code AS role_code FROM workflow_definitions d JOIN roles r ON r.id = d.approver_role_id WHERE d.type = ? ORDER BY d.step')
    .bind(type)
    .all<StepDef>();
  return results;
}

async function notifyRole(db: D1Database, roleCode: string, exceptUserId: number, title: string, body: string): Promise<void> {
  const { results } = await db
    .prepare('SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users u ON u.id = ur.user_id WHERE r.code = ? AND u.active = 1 AND ur.user_id <> ?')
    .bind(roleCode, exceptUserId)
    .all<{ user_id: number }>();
  for (const r of results) await notify(db, r.user_id, title, body, '/workflow/inbox');
}

export async function startWorkflow(c: Context<AppEnv>, m: CrudModule, refId: number, values: Record<string, string | number | null>): Promise<void> {
  if (!m.workflow) return;
  const user = currentUser(c);
  const employeeId = typeof values.employee_id === 'number' ? values.employee_id : null;
  const emp = employeeId
    ? await c.env.DB.prepare("SELECT emp_code || ' ' || first_name || ' ' || last_name AS name FROM employees WHERE id = ?").bind(employeeId).first<{ name: string }>()
    : null;
  const when = values.start_date ? `${values.start_date}${values.end_date && values.end_date !== values.start_date ? ` ถึง ${values.end_date}` : ''}` : (values.work_date ?? '');
  const extra = values.days ? ` (${values.days} วัน)` : values.hours ? ` (${values.hours} ชม.)` : '';
  const summary = `${m.title} · ${emp?.name ?? '-'} · ${when}${extra}`;
  await c.env.DB.prepare('INSERT INTO workflow_requests (type, ref_table, ref_id, module_key, requester_user_id, employee_id, summary) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(m.workflow, m.table, refId, m.key, user.id, employeeId, summary)
    .run();
  const first = (await steps(c.env.DB, m.workflow))[0];
  if (first) await notifyRole(c.env.DB, first.role_code, user.id, 'มีคำขอรออนุมัติ', summary);
}

export async function cancelWorkflowFor(c: Context<AppEnv>, m: CrudModule, refId: number): Promise<void> {
  const user = currentUser(c);
  const req = await c.env.DB.prepare("SELECT id, current_step FROM workflow_requests WHERE ref_table = ? AND ref_id = ? AND status = 'pending'")
    .bind(m.table, refId)
    .first<{ id: number; current_step: number }>();
  const stmts = [c.env.DB.prepare(`UPDATE ${m.table} SET status = 'cancelled', updated_at = datetime('now'), updated_by = ? WHERE id = ?`).bind(user.id, refId)];
  if (req) {
    stmts.push(c.env.DB.prepare("UPDATE workflow_requests SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").bind(req.id));
    stmts.push(c.env.DB.prepare("INSERT INTO workflow_actions (request_id, step, actor_user_id, decision) VALUES (?, ?, ?, 'cancelled')").bind(req.id, req.current_step, user.id));
  }
  await c.env.DB.batch(stmts);
}

interface RequestRow {
  id: number;
  type: string;
  ref_table: string;
  ref_id: number;
  module_key: string;
  requester_user_id: number;
  employee_id: number | null;
  current_step: number;
  status: string;
  summary: string;
  created_at: string;
  requester: string;
}

/** The request is the approver's own (they asked for it, or it is about their own employee record). */
const ownRequest = (user: AuthUser, req: RequestRow) => req.requester_user_id === user.id || (req.employee_id !== null && req.employee_id === user.employeeId);

/**
 * Employees in the user's reporting line (direct and indirect reports through employees.manager_id). A role approver
 * such as the HR Manager approves only requests of these employees; a user without an employee record has no team.
 */
async function teamOf(db: D1Database, user: AuthUser): Promise<ReadonlySet<number>> {
  if (user.employeeId === null) return new Set();
  const { results } = await db
    .prepare(
      `WITH RECURSIVE team(id, depth) AS (
         SELECT id, 1 FROM employees WHERE manager_id = ?1
         UNION SELECT e.id, t.depth + 1 FROM employees e JOIN team t ON e.manager_id = t.id WHERE t.depth < 10
       ) SELECT DISTINCT id FROM team WHERE id <> ?1`,
    )
    .bind(user.employeeId)
    .all<{ id: number }>();
  return new Set(results.map((r) => r.id));
}

function canApproveStep(user: AuthUser, req: RequestRow, step: StepDef | undefined, team: ReadonlySet<number>): boolean {
  // no self-approval — except a Super Admin, the highest authority (by role, never inherited through a permission)
  if (ownRequest(user, req) && !isSuperAdmin(user.roles)) return false;
  if (can(user, 'workflow.approve_any')) return true;
  return !!step && can(user, 'workflow.approve') && user.roles.includes(step.role_code) && req.employee_id !== null && team.has(req.employee_id);
}

function toRow(r: RequestRow, stepDefs: Map<string, StepDef[]>): WorkflowRequestRow {
  const step = stepDefs.get(r.type)?.find((s) => s.step === r.current_step);
  const m = crudModule(r.module_key);
  return {
    id: r.id,
    type: r.type,
    refTable: r.ref_table,
    refId: r.ref_id,
    summary: r.summary,
    status: r.status,
    currentStep: r.current_step,
    stepName: step?.name ?? null,
    requester: r.requester,
    createdAt: r.created_at,
    href: m?.path ?? '/workflow/inbox',
  };
}

const REQUEST_SELECT = `SELECT w.*, u.display_name AS requester FROM workflow_requests w JOIN users u ON u.id = w.requester_user_id`;

export const workflowRoutes = new Hono<AppEnv>();
workflowRoutes.use('*', requireAuth, requirePerm('workflow.view'));

workflowRoutes.get('/inbox', async (c) => {
  const user = currentUser(c);
  const defs = new Map<string, StepDef[]>();
  for (const t of ['leave', 'overtime', 'time_correction']) defs.set(t, await steps(c.env.DB, t));
  const { results: pending } = await c.env.DB.prepare(`${REQUEST_SELECT} WHERE w.status = 'pending' ORDER BY w.created_at`).all<RequestRow>();
  const team = await teamOf(c.env.DB, user);
  const toApprove = pending.filter((r) => canApproveStep(user, r, defs.get(r.type)?.find((s) => s.step === r.current_step), team));
  const { results: mine } = await c.env.DB.prepare(`${REQUEST_SELECT} WHERE w.requester_user_id = ? ORDER BY w.created_at DESC LIMIT 100`).bind(user.id).all<RequestRow>();
  return c.json({ toApprove: toApprove.map((r) => toRow(r, defs)), mine: mine.map((r) => toRow(r, defs)) });
});

workflowRoutes.post('/:id/decide', async (c) => {
  const user = currentUser(c);
  const id = intParam(c.req.param('id'));
  const body = await readJson(c);
  const decision = body.decision;
  if (decision !== 'approved' && decision !== 'rejected') throw badRequest('decision ต้องเป็น approved หรือ rejected');
  const comment = str(body, 'comment', { max: 500 });
  const req = await c.env.DB.prepare(`${REQUEST_SELECT} WHERE w.id = ?`).bind(id).first<RequestRow>();
  if (!req) throw notFound('ไม่พบคำขอ');
  if (req.status !== 'pending') throw conflict('คำขอนี้ดำเนินการแล้ว');
  const defs = await steps(c.env.DB, req.type);
  const step = defs.find((s) => s.step === req.current_step);
  if (!canApproveStep(user, req, step, await teamOf(c.env.DB, user))) {
    throw forbidden(ownRequest(user, req) ? 'ไม่สามารถอนุมัติคำขอของตนเองได้' : 'คุณไม่ใช่ผู้อนุมัติของขั้นนี้ หรือผู้ขอไม่ได้อยู่ในทีมของคุณ');
  }
  // a Super Admin deciding their own request must leave a note (kept with the decision and in the audit)
  const selfDecided = ownRequest(user, req);
  if (selfDecided && (!comment || comment.trim().length < 3)) throw badRequest('Super Admin ดำเนินการคำขอของตนเอง ต้องระบุหมายเหตุ (อย่างน้อย 3 ตัวอักษร)');

  const next = defs.find((s) => s.step > req.current_step);
  const final = decision === 'rejected' || !next;
  const db = c.env.DB;
  const stmts = [db.prepare('INSERT INTO workflow_actions (request_id, step, actor_user_id, decision, comment) VALUES (?, ?, ?, ?, ?)').bind(id, req.current_step, user.id, decision, comment)];
  if (final) {
    stmts.push(db.prepare("UPDATE workflow_requests SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(decision, id));
    stmts.push(db.prepare(`UPDATE ${req.ref_table} SET status = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ?`).bind(decision, user.id, req.ref_id));
    if (decision === 'approved' && req.type === 'time_correction') {
      // Apply the approved correction to that day's attendance and re-evaluate lateness against the shift in force
      // that day (schedule entry, shift group, then the legacy assignment; default start time without a shift).
      const tc = await db.prepare('SELECT employee_id, work_date, clock_in, reason FROM time_corrections WHERE id = ?').bind(req.ref_id).first<{ employee_id: number; work_date: string; clock_in: string | null; reason: string | null }>();
      // P2: the same rules as an HR correction — the day must not be in an approved / published payroll period, and the
      // change is recorded as a revision (the request's reason, reference TC-<id>, the approver as actor)
      if (tc) {
        const emp = await db.prepare('SELECT company_id FROM employees WHERE id = ?').bind(tc.employee_id).first<{ company_id: number }>();
        if (emp) await assertNotLocked(db, emp.company_id, [tc.work_date]);
      }
      const change = newChange('time_correction', tc?.reason ?? null, `TC-${req.ref_id}`);
      let status = 'present';
      let shiftId: number | null = null;
      if (tc?.clock_in) {
        const day = await shiftForDay(db, tc.employee_id, tc.work_date);
        const shift = day.kind === 'shift' ? day.shift : null;
        shiftId = shift?.id ?? null;
        const defaultStart = settingText(await loadSettings(db), 'attendance.default_start_time', '09:00');
        status = checkClock(shift ? shiftTimes(shift) : null, tc.clock_in, null, { defaultStart }).status;
      }
      stmts.push(
        db.prepare(
          `INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source, note, shift_id, created_by, updated_by, change_op, change_channel, change_reason, change_reference)
           SELECT tc.employee_id, tc.work_date, tc.clock_in, tc.clock_out, ?, 'manual', 'แก้ไขเวลา TC-' || tc.id, ?, ?, ?, ?, ?, ?, ?
           FROM time_corrections tc WHERE tc.id = ?
           ON CONFLICT (employee_id, work_date) DO UPDATE SET
             clock_in = COALESCE(excluded.clock_in, attendance_records.clock_in),
             clock_out = COALESCE(excluded.clock_out, attendance_records.clock_out),
             status = CASE WHEN excluded.clock_in IS NULL THEN attendance_records.status ELSE excluded.status END,
             shift_id = CASE WHEN excluded.clock_in IS NULL THEN attendance_records.shift_id ELSE excluded.shift_id END,
             source = 'manual', note = excluded.note, updated_at = datetime('now'), updated_by = excluded.updated_by,
             change_op = excluded.change_op, change_channel = excluded.change_channel, change_reason = excluded.change_reason, change_reference = excluded.change_reference`,
        ).bind(status, shiftId, user.id, user.id, ...changeValues(change), req.ref_id),
      );
    }
  } else {
    stmts.push(db.prepare("UPDATE workflow_requests SET current_step = ?, updated_at = datetime('now') WHERE id = ?").bind(next.step, id));
  }
  try {
    await db.batch(stmts);
  } catch (e) {
    attendanceDbError(e);
    throw e;
  }

  const m = crudModule(req.module_key);
  if (final) {
    await notify(db, req.requester_user_id, decision === 'approved' ? 'คำขอได้รับการอนุมัติ' : 'คำขอไม่ได้รับการอนุมัติ', req.summary, m?.path ?? '/workflow/inbox');
  } else {
    await notifyRole(db, next.role_code, req.requester_user_id, 'มีคำขอรออนุมัติ', req.summary);
  }
  await audit(c, `workflow.${decision}`, req.module_key, req.ref_id, { requestId: id, step: req.current_step, final, requester: req.requester_user_id, approver: user.id, self_approved: selfDecided, comment });
  return c.json({ ok: true, status: final ? decision : 'pending', currentStep: final ? req.current_step : next.step });
});
