// Cross Company Manager Assignment API (/api/org-assignments). View: org_assignment.view; create / edit / activate /
// deactivate / cancel: org_assignment.manage AND every company the assignment involves (the responsible person's,
// the target company, the named employee's) inside the user's company scope. Lists mask people outside the scope.
// Rows are never deleted; every change writes a history row (before / after) and an audit_logs entry.
// employees.manager_id (the primary reporting line) is never changed here.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { can, currentUser, requireAuth, requirePerm } from '../auth';
import { audit } from '../lib/audit';
import { companyScope } from '../lib/companies';
import { badRequest, conflict, forbidden, intParam, notFound, readJson } from '../lib/http';
import { bangkokNow } from '../lib/time';
import { assignmentRows, involved, maskRow, scopeCompanyIds, type AssignmentRow } from '../lib/cross-company';
import {
  ASSIGNMENT_STATE_LABEL, ASSIGNMENT_TYPES, ASSIGNMENT_TYPE_LABEL, assignmentLoop, assignmentState, periodsOverlap, validateAssignment,
  type AssignmentDraft, type AssignmentState, type ExistingAssignment,
} from '../../shared/cross-company';

export const crossCompanyRoutes = new Hono<AppEnv>();
crossCompanyRoutes.use('*', requireAuth);

const ACTIVE_SQL = "status IN ('active', 'probation')";
const TEXT_MAX = { team_name: 120, responsibility: 1000, reason: 500 };

function text(v: unknown, label: string, max: number): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string') throw badRequest(`${label}ต้องเป็นข้อความ`);
  const t = v.trim();
  if (t.length > max) throw badRequest(`${label}ยาวเกิน ${max} ตัวอักษร`);
  return t || null;
}
function idOrNull(v: unknown, label: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`${label}ไม่ถูกต้อง`);
  return n;
}
const dateOrNull = (v: unknown): string | null => (v === undefined || v === null || v === '' ? null : String(v));

/** the stored columns of a row (history snapshot) */
const snapshot = (r: Pick<AssignmentRow, 'manager_employee_id' | 'manager_company_id' | 'target_company_id' | 'target_department_id' | 'team_name' | 'employee_id' | 'employee_company_id' | 'relationship_type' | 'responsibility' | 'effective_from' | 'effective_to' | 'status'>) => ({
  manager_employee_id: r.manager_employee_id, manager_company_id: r.manager_company_id, target_company_id: r.target_company_id, target_department_id: r.target_department_id,
  team_name: r.team_name, employee_id: r.employee_id, employee_company_id: r.employee_company_id, relationship_type: r.relationship_type, responsibility: r.responsibility,
  effective_from: r.effective_from, effective_to: r.effective_to, status: r.status,
});

async function people(db: D1Database) {
  return (await db.prepare(`SELECT id, company_id, department_id, manager_id, ${ACTIVE_SQL} AS active FROM employees`).all<{ id: number; company_id: number; department_id: number | null; manager_id: number | null; active: number }>()).results;
}

/** Validates a draft against the live data; throws 400 with every problem, 403 when a company is outside the scope. */
async function checkDraft(c: Context<AppEnv>, d: AssignmentDraft, exceptId?: number) {
  const db = c.env.DB;
  const user = currentUser(c);
  const scope = await scopeCompanyIds(db, user);
  const all = await people(db);
  const byId = new Map(all.map((p) => [p.id, p]));
  const { results: deps } = await db.prepare('SELECT id, company_id, active FROM departments').all<{ id: number; company_id: number; active: number }>();
  const { results: cos } = await db.prepare('SELECT id FROM companies WHERE active = 1').all<{ id: number }>();
  const { results: existing } = await db.prepare('SELECT id, manager_employee_id, target_department_id, team_name, employee_id, relationship_type, status, effective_from, effective_to FROM cross_company_assignments').all<ExistingAssignment>();
  const activeEmployees = all.filter((p) => p.active === 1);
  const errors = validateAssignment(d, {
    person: (id) => {
      const p = byId.get(id);
      return p ? { id: p.id, company_id: p.company_id, active: p.active === 1 } : undefined;
    },
    department: (id) => {
      const x = deps.find((y) => y.id === id);
      return x ? { id: x.id, company_id: x.company_id, active: x.active === 1 } : undefined;
    },
    companyExists: (id) => cos.some((x) => x.id === id),
    existing,
    exceptId,
    // only assignments that can be in effect at the same time as the draft take part in the loop check
    loop: (draft) => assignmentLoop(draft, activeEmployees, existing.filter((x) => x.id !== exceptId && x.status === 'active' && periodsOverlap(x, draft))),
  });
  // scope before details: a company outside the user's scope is refused without saying more about it
  const companies = [d.target_company_id, byId.get(d.manager_employee_id)?.company_id, d.employee_id !== null ? byId.get(d.employee_id)?.company_id : undefined].filter((x): x is number => x !== undefined);
  if (companies.some((x) => !scope.has(x))) throw forbidden('ไม่มีสิทธิ์จัดการความสัมพันธ์ของบริษัทที่อยู่นอกขอบเขตของคุณ');
  if (errors.length) throw badRequest(errors.join(' · '), { errors });
  return { managerCompany: byId.get(d.manager_employee_id)?.company_id as number, employeeCompany: d.employee_id !== null ? (byId.get(d.employee_id)?.company_id as number) : null };
}

function draftOf(body: Record<string, unknown>, base?: AssignmentDraft): AssignmentDraft {
  const pick = <K extends keyof AssignmentDraft>(k: K, read: (v: unknown) => AssignmentDraft[K]): AssignmentDraft[K] => (k in body ? read(body[k]) : base ? base[k] : read(undefined));
  const required = (label: string) => (v: unknown) => {
    const n = idOrNull(v, label);
    if (n === null) throw badRequest(`กรุณาระบุ${label}`);
    return n;
  };
  return {
    manager_employee_id: pick('manager_employee_id', required('ผู้รับผิดชอบ (หัวหน้างาน)')),
    target_company_id: pick('target_company_id', required('บริษัทปลายทาง')),
    target_department_id: pick('target_department_id', required('หน่วยงาน / ทีมปลายทาง')),
    team_name: pick('team_name', (v) => text(v, 'ชื่อทีม', TEXT_MAX.team_name)),
    employee_id: pick('employee_id', (v) => idOrNull(v, 'พนักงาน')),
    relationship_type: pick('relationship_type', (v) => {
      if (v === undefined || v === null || v === '') throw badRequest('กรุณาเลือกประเภทความสัมพันธ์');
      return String(v);
    }),
    responsibility: pick('responsibility', (v) => text(v, 'รายละเอียดหน้าที่', TEXT_MAX.responsibility)),
    effective_from: pick('effective_from', (v) => {
      const s = dateOrNull(v);
      if (!s) throw badRequest('กรุณาระบุวันที่เริ่มมีผล');
      return s;
    }),
    effective_to: pick('effective_to', dateOrNull),
  };
}

async function rowById(c: Context<AppEnv>, id: number): Promise<AssignmentRow> {
  const r = (await assignmentRows(c.env.DB, 'WHERE a.id = ?', id))[0];
  const scope = await scopeCompanyIds(c.env.DB, currentUser(c));
  // outside the scope = not found (another company's assignment is not revealed)
  if (!r || !involved(r).some((x) => scope.has(x))) throw notFound('ไม่พบความสัมพันธ์ข้ามบริษัท');
  return r;
}
/** a row the user may change: every company it involves is inside the scope */
async function manageable(c: Context<AppEnv>, id: number): Promise<AssignmentRow> {
  const r = await rowById(c, id);
  const scope = await scopeCompanyIds(c.env.DB, currentUser(c));
  if (!involved(r).every((x) => scope.has(x))) throw forbidden('ไม่มีสิทธิ์จัดการความสัมพันธ์ของบริษัทที่อยู่นอกขอบเขตของคุณ');
  return r;
}

async function present(c: Context<AppEnv>, r: AssignmentRow) {
  const scope = await scopeCompanyIds(c.env.DB, currentUser(c));
  const today = bangkokNow().date;
  const state = assignmentState(r, today);
  return { ...maskRow(r, scope), state, state_label: ASSIGNMENT_STATE_LABEL[state], type_label: ASSIGNMENT_TYPE_LABEL[r.relationship_type], can_manage: can(currentUser(c), 'org_assignment.manage') && involved(r).every((x) => scope.has(x)) };
}

async function history(db: D1Database, id: number, action: string, before: unknown, after: unknown, userId: number, reason: string | null = null) {
  await db.prepare('INSERT INTO cross_company_assignment_history (assignment_id, action, before_json, after_json, reason, by_user_id) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, action, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), reason, userId).run();
}

// ---- reference data for the screen -------------------------------------------------------------------------------
crossCompanyRoutes.get('/meta', requirePerm('org_assignment.view'), async (c) => {
  const db = c.env.DB;
  const user = currentUser(c);
  const scope = await companyScope(db, user);
  const ids = scope.items.map((x) => x.id);
  const { results: departments } = await db.prepare('SELECT id, code, name, company_id FROM departments WHERE active = 1 AND company_id IN (SELECT value FROM json_each(?)) ORDER BY company_id, code')
    .bind(JSON.stringify(ids)).all<{ id: number; code: string; name: string; company_id: number }>();
  return c.json({
    today: bangkokNow().date,
    companies: scope.items,
    departments,
    types: ASSIGNMENT_TYPES.map((value) => ({ value, label: ASSIGNMENT_TYPE_LABEL[value] })),
    states: (Object.keys(ASSIGNMENT_STATE_LABEL) as AssignmentState[]).map((value) => ({ value, label: ASSIGNMENT_STATE_LABEL[value] })),
    canManage: can(user, 'org_assignment.manage'),
  });
});

/**
 * Employees for the pickers (active / probation, inside the user's scope, max 20).
 * ?q= code or name · ?company= only this company · ?exclude_company= every company but this one (eligible managers)
 */
crossCompanyRoutes.get('/people', requirePerm('org_assignment.view'), async (c) => {
  const db = c.env.DB;
  const scope = [...(await scopeCompanyIds(db, currentUser(c)))];
  const q = (c.req.query('q') ?? '').trim().toLowerCase().slice(0, 60);
  const only = idOrNull(c.req.query('company'), 'company');
  const except = idOrNull(c.req.query('exclude_company'), 'exclude_company');
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { results } = await db.prepare(
    `SELECT e.id, e.emp_code, e.first_name || ' ' || e.last_name AS name, e.company_id, c.code AS company_code, c.name AS company_name, e.department_id, d.name AS department_name, x.title AS position_title
     FROM employees e JOIN companies c ON c.id = e.company_id LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN positions x ON x.id = e.position_id
     WHERE e.${ACTIVE_SQL} AND e.company_id IN (SELECT value FROM json_each(?1)) AND (?2 IS NULL OR e.company_id = ?2) AND (?3 IS NULL OR e.company_id <> ?3)
       AND (?4 = '' OR lower(e.emp_code) LIKE ?5 ESCAPE '\\' OR lower(e.first_name || ' ' || e.last_name) LIKE ?5 ESCAPE '\\')
     ORDER BY e.emp_code LIMIT 20`,
  ).bind(JSON.stringify(scope), only, except, q, like).all();
  return c.json({ items: results });
});

// ---- list / detail / history ---------------------------------------------------------------------------------------
crossCompanyRoutes.get('/', requirePerm('org_assignment.view'), async (c) => {
  const db = c.env.DB;
  const user = currentUser(c);
  const scope = await scopeCompanyIds(db, user);
  const today = bangkokNow().date;
  const q = (c.req.query('q') ?? '').trim().toLowerCase();
  const state = c.req.query('state') ?? '';
  const type = c.req.query('type') ?? '';
  const company = idOrNull(c.req.query('company'), 'company');
  const manage = can(user, 'org_assignment.manage');
  const items = (await assignmentRows(db))
    .filter((r) => involved(r).some((x) => scope.has(x)))
    .map((r) => {
      const st = assignmentState(r, today);
      return { ...maskRow(r, scope), state: st, state_label: ASSIGNMENT_STATE_LABEL[st], type_label: ASSIGNMENT_TYPE_LABEL[r.relationship_type], can_manage: manage && involved(r).every((x) => scope.has(x)) };
    })
    .filter((r) => (!state || r.state === state) && (!type || r.relationship_type === type) && (company === null || involved(r).includes(company)))
    .filter((r) => !q || [r.manager_code, r.manager_name, r.employee_code, r.employee_name, r.target_department_name, r.team_name, r.target_company_code, r.manager_company_code, r.responsibility]
      .some((v) => v && v.toLowerCase().includes(q)));
  return c.json({ today, items });
});

crossCompanyRoutes.get('/:id', requirePerm('org_assignment.view'), async (c) => c.json(await present(c, await rowById(c, intParam(c.req.param('id'))))));

crossCompanyRoutes.get('/:id/history', requirePerm('org_assignment.view'), async (c) => {
  const r = await rowById(c, intParam(c.req.param('id')));
  const { results } = await c.env.DB.prepare('SELECT h.id, h.action, h.before_json, h.after_json, h.reason, h.at, u.username AS by_name FROM cross_company_assignment_history h LEFT JOIN users u ON u.id = h.by_user_id WHERE h.assignment_id = ? ORDER BY h.id')
    .bind(r.id).all<{ id: number; action: string; before_json: string | null; after_json: string | null; reason: string | null; at: string; by_name: string | null }>();
  const items = results.map(({ before_json, after_json, ...h }) => ({ ...h, before: before_json ? (JSON.parse(before_json) as Record<string, unknown>) : null, after: after_json ? (JSON.parse(after_json) as Record<string, unknown>) : null }));
  // names of the people / departments / companies the snapshots refer to (people outside the scope stay masked)
  const db = c.env.DB;
  const scope = await scopeCompanyIds(db, currentUser(c));
  const pick = (keys: string[]) => [...new Set(items.flatMap((x) => [x.before, x.after]).flatMap((o) => (o ? keys.map((k) => o[k]) : [])).filter((v): v is number => typeof v === 'number'))];
  const emps = (await db.prepare("SELECT e.id, e.emp_code, e.first_name || ' ' || e.last_name AS name, e.company_id, c.code AS company_code FROM employees e JOIN companies c ON c.id = e.company_id WHERE e.id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(pick(['manager_employee_id', 'employee_id']))).all<{ id: number; emp_code: string; name: string; company_id: number; company_code: string }>()).results;
  const deps = (await db.prepare('SELECT id, name FROM departments WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(pick(['target_department_id']))).all<{ id: number; name: string }>()).results;
  const cos = (await db.prepare('SELECT id, code FROM companies WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(pick(['target_company_id', 'manager_company_id', 'employee_company_id']))).all<{ id: number; code: string }>()).results;
  return c.json({
    id: r.id,
    items,
    names: {
      employees: Object.fromEntries(emps.map((e) => [e.id, scope.has(e.company_id) ? `${e.emp_code} ${e.name}` : `ผู้รับผิดชอบจากต่างบริษัท (${e.company_code})`])),
      departments: Object.fromEntries(deps.map((x) => [x.id, x.name])),
      companies: Object.fromEntries(cos.map((x) => [x.id, x.code])),
    },
  });
});

// ---- create / update / status / cancel -----------------------------------------------------------------------------
crossCompanyRoutes.post('/', requirePerm('org_assignment.manage'), async (c) => {
  const body = await readJson(c);
  const d = draftOf(body);
  const { managerCompany, employeeCompany } = await checkDraft(c, d);
  const user = currentUser(c);
  const db = c.env.DB;
  const r = await db.prepare(
    `INSERT INTO cross_company_assignments (manager_employee_id, manager_company_id, target_company_id, target_department_id, team_name, employee_id, employee_company_id, relationship_type, responsibility, effective_from, effective_to, status, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?) RETURNING id`,
  ).bind(d.manager_employee_id, managerCompany, d.target_company_id, d.target_department_id, d.team_name, d.employee_id, employeeCompany, d.relationship_type, d.responsibility, d.effective_from, d.effective_to, user.id, user.id).first<{ id: number }>();
  const id = r!.id;
  const after = { ...d, manager_company_id: managerCompany, employee_company_id: employeeCompany, status: 'active' };
  await history(db, id, 'created', null, after, user.id);
  await audit(c, 'org_assignment.created', 'cross_company_assignments', id, after);
  return c.json(await present(c, await rowById(c, id)), 201);
});

crossCompanyRoutes.put('/:id', requirePerm('org_assignment.manage'), async (c) => {
  const cur = await manageable(c, intParam(c.req.param('id')));
  if (cur.status === 'cancelled') throw conflict('ความสัมพันธ์นี้ถูกยกเลิกแล้ว แก้ไขไม่ได้');
  const body = await readJson(c);
  const d = draftOf(body, { ...snapshot(cur) });
  const { managerCompany, employeeCompany } = await checkDraft(c, d, cur.id);
  const user = currentUser(c);
  const db = c.env.DB;
  const before = snapshot(cur);
  const after = snapshot({ ...cur, ...d, relationship_type: d.relationship_type as AssignmentRow['relationship_type'], manager_company_id: managerCompany, employee_company_id: employeeCompany });
  if (JSON.stringify(before) === JSON.stringify(after)) throw badRequest('ไม่มีข้อมูลที่เปลี่ยนแปลง');
  await db.prepare(
    `UPDATE cross_company_assignments SET manager_employee_id = ?, manager_company_id = ?, target_company_id = ?, target_department_id = ?, team_name = ?, employee_id = ?, employee_company_id = ?,
       relationship_type = ?, responsibility = ?, effective_from = ?, effective_to = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ? AND status <> 'cancelled'`,
  ).bind(d.manager_employee_id, managerCompany, d.target_company_id, d.target_department_id, d.team_name, d.employee_id, employeeCompany, d.relationship_type, d.responsibility, d.effective_from, d.effective_to, user.id, cur.id).run();
  await history(db, cur.id, 'updated', before, after, user.id, text(body.reason, 'เหตุผล', TEXT_MAX.reason));
  await audit(c, 'org_assignment.updated', 'cross_company_assignments', cur.id, { before, after });
  return c.json(await present(c, await rowById(c, cur.id)));
});

/** active ↔ inactive (a paused assignment is kept and can be re-activated; the loop / duplicate rules apply again) */
crossCompanyRoutes.post('/:id/status', requirePerm('org_assignment.manage'), async (c) => {
  const cur = await manageable(c, intParam(c.req.param('id')));
  if (cur.status === 'cancelled') throw conflict('ความสัมพันธ์นี้ถูกยกเลิกแล้ว');
  const body = await readJson(c);
  const next = body.status;
  if (next !== 'active' && next !== 'inactive') throw badRequest('สถานะต้องเป็น active หรือ inactive');
  if (next === cur.status) throw conflict(next === 'active' ? 'ความสัมพันธ์นี้ใช้งานอยู่แล้ว' : 'ความสัมพันธ์นี้ระงับอยู่แล้ว');
  if (next === 'active') await checkDraft(c, snapshot(cur), cur.id);
  const reason = text(body.reason, 'เหตุผล', TEXT_MAX.reason);
  const user = currentUser(c);
  await c.env.DB.prepare("UPDATE cross_company_assignments SET status = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ? AND status <> 'cancelled'").bind(next, user.id, cur.id).run();
  await history(c.env.DB, cur.id, next === 'active' ? 'activated' : 'deactivated', { status: cur.status }, { status: next }, user.id, reason);
  await audit(c, next === 'active' ? 'org_assignment.activated' : 'org_assignment.deactivated', 'cross_company_assignments', cur.id, { from: cur.status, to: next, reason });
  return c.json(await present(c, await rowById(c, cur.id)));
});

/** cancel (final): the row and its history stay; it is no longer shown in the organization chart */
crossCompanyRoutes.post('/:id/cancel', requirePerm('org_assignment.manage'), async (c) => {
  const cur = await manageable(c, intParam(c.req.param('id')));
  if (cur.status === 'cancelled') throw conflict('ความสัมพันธ์นี้ถูกยกเลิกแล้ว');
  const reason = text((await readJson(c)).reason, 'เหตุผล', TEXT_MAX.reason);
  if (!reason || reason.length < 3) throw badRequest('กรุณาระบุเหตุผลที่ยกเลิก (อย่างน้อย 3 ตัวอักษร)');
  const user = currentUser(c);
  await c.env.DB.prepare("UPDATE cross_company_assignments SET status = 'cancelled', cancel_reason = ?, cancelled_at = datetime('now'), cancelled_by = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ? AND status <> 'cancelled'")
    .bind(reason, user.id, user.id, cur.id).run();
  await history(c.env.DB, cur.id, 'cancelled', { status: cur.status }, { status: 'cancelled' }, user.id, reason);
  await audit(c, 'org_assignment.cancelled', 'cross_company_assignments', cur.id, { from: cur.status, reason });
  return c.json(await present(c, await rowById(c, cur.id)));
});
