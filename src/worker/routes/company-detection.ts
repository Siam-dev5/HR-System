// Company detection (P3): employee-code prefix mappings HR maintains, company detection, the dry run over existing
// employees, and dated company assignments (transfer, verify). Every read is limited to the companies in the user's
// scope (a company outside it answers like a missing one); every write needs its permission, is audited and keeps an
// append-only history. Nothing here assigns a company from a mapping or changes payroll money.
import { Hono, type Context } from 'hono';
import type { AppEnv, AuthUser } from '../env';
import { currentUser, requireAuth, requirePerm } from '../auth';
import { audit } from '../lib/audit';
import { companyScope } from '../lib/companies';
import { badRequest, conflict, HttpError, intParam, notFound, readJson } from '../lib/http';
import { bangkokNow } from '../lib/time';
import { loadAssignments, loadMappings } from '../lib/company-detection';
import { DETECTION_LABEL, PREFIX_RE, classifyEmployee, detectCompany, normalizeCode, type Classification } from '../../shared/company-detection';

export const companyDetectionRoutes = new Hono<AppEnv>();
companyDetectionRoutes.use('*', requireAuth);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface Scope {
  all: boolean;
  ids: number[];
}
async function scopeOf(db: D1Database, user: AuthUser): Promise<Scope> {
  const s = await companyScope(db, user);
  return { all: s.scope === 'all', ids: s.items.map((x) => x.id) };
}
const inScope = (s: Scope, companyId: number) => s.all || s.ids.includes(companyId);

/** An active company the user may work with (404 for a company outside the scope, 400 for an inactive one). */
async function scopedCompany(db: D1Database, s: Scope, raw: unknown): Promise<{ id: number; code: string; name: string }> {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('ต้องระบุบริษัท');
  const c = await db.prepare('SELECT id, code, name, active FROM companies WHERE id = ?').bind(id).first<{ id: number; code: string; name: string; active: number }>();
  if (!c || !inScope(s, c.id)) throw notFound('ไม่พบบริษัท');
  if (!c.active) throw badRequest('บริษัทนี้ปิดใช้งานแล้ว');
  return c;
}

function dbError(e: unknown): never {
  const text = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  if (text.includes('company_mapping_overlap')) throw new HttpError(409, 'company_mapping_overlap', 'รหัสนำหน้านี้มีการจับคู่ที่ใช้งานอยู่ในช่วงวันที่ซ้อนกันแล้ว');
  if (text.includes('company_assignment_overlap')) throw new HttpError(409, 'company_assignment_overlap', 'ช่วงวันที่ของการกำหนดบริษัทซ้อนกับรายการเดิม');
  if (text.includes('employee_company_needs_transfer')) throw new HttpError(409, 'employee_company_needs_transfer', 'การเปลี่ยนบริษัทของพนักงานต้องทำผ่านการย้ายบริษัท');
  throw e;
}

// ---- Mappings --------------------------------------------------------------------------------------------------

interface MappingRow {
  id: number;
  company_id: number;
  prefix: string;
  priority: number;
  status: 'active' | 'inactive';
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  version: number;
  created_at: string;
  created_by: number | null;
  updated_at: string;
  updated_by: number | null;
  deactivated_at: string | null;
  deactivated_by: number | null;
  deactivate_reason: string | null;
}
const MAPPING_JSON = "json_object('company_id', company_id, 'prefix', prefix, 'priority', priority, 'status', status, 'effective_from', effective_from, 'effective_to', effective_to, 'note', note, 'version', version)";

async function mappingIn(db: D1Database, s: Scope, id: number): Promise<MappingRow> {
  const m = await db.prepare('SELECT * FROM company_code_mappings WHERE id = ?').bind(id).first<MappingRow>();
  if (!m || !inScope(s, m.company_id)) throw notFound('ไม่พบการจับคู่');
  return m;
}

function readPriority(v: unknown, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 1000) throw badRequest('priority ต้องเป็นจำนวนเต็ม 0–1000');
  return n;
}
function readNote(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.length > 500) throw badRequest('หมายเหตุยาวเกิน 500 ตัวอักษร');
  return v.trim() || null;
}

companyDetectionRoutes.get('/mappings', requirePerm('company_mapping.view'), async (c) => {
  const db = c.env.DB;
  const s = await scopeOf(db, currentUser(c));
  const { results } = await db
    .prepare(
      `SELECT m.*, co.code AS company_code, co.name AS company_name FROM company_code_mappings m JOIN companies co ON co.id = m.company_id
       WHERE (?1 = 1 OR m.company_id IN (SELECT value FROM json_each(?2))) ORDER BY m.prefix, m.effective_from, m.id`,
    )
    .bind(s.all ? 1 : 0, JSON.stringify(s.ids))
    .all<MappingRow & { company_code: string; company_name: string }>();
  return c.json({ mappings: results });
});

companyDetectionRoutes.post('/mappings', requirePerm('company_mapping.manage'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const s = await scopeOf(db, user);
  const body = await readJson(c);
  const company = await scopedCompany(db, s, body.company_id);
  const prefix = normalizeCode(typeof body.prefix === 'string' ? body.prefix : '');
  if (!PREFIX_RE.test(prefix)) throw badRequest('รหัสนำหน้าต้องเป็นตัวอักษร A–Z หรือตัวเลข 1–10 ตัว');
  const from = body.effective_from === undefined ? bangkokNow().date : body.effective_from;
  const to = body.effective_to === undefined || body.effective_to === null || body.effective_to === '' ? null : body.effective_to;
  if (!isDate(from) || (to !== null && !isDate(to))) throw badRequest('วันที่มีผลต้องเป็น YYYY-MM-DD');
  if (to !== null && to < from) throw badRequest('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  const priority = readPriority(body.priority, 100);
  const note = readNote(body.note);
  let id = 0;
  try {
    // one statement: the overlap check and the insert cannot be split by a concurrent request (the trigger also refuses)
    const row = await db
      .prepare(
        `INSERT INTO company_code_mappings (company_id, prefix, priority, status, effective_from, effective_to, note, created_by, updated_by)
         SELECT ?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, ?7
         WHERE NOT EXISTS (SELECT 1 FROM company_code_mappings m WHERE m.status = 'active' AND m.prefix = ?2 AND m.effective_from <= IFNULL(?5, '9999-12-31') AND IFNULL(m.effective_to, '9999-12-31') >= ?4)
         RETURNING id`,
      )
      .bind(company.id, prefix, priority, from, to, note, user.id)
      .first<{ id: number }>();
    id = row?.id ?? 0;
  } catch (e) {
    dbError(e);
  }
  if (!id) throw new HttpError(409, 'company_mapping_overlap', 'รหัสนำหน้านี้มีการจับคู่ที่ใช้งานอยู่ในช่วงวันที่ซ้อนกันแล้ว');
  await db.prepare(`INSERT INTO company_code_mapping_history (mapping_id, action, after_json, actor_id) SELECT id, 'created', ${MAPPING_JSON}, ? FROM company_code_mappings WHERE id = ?`).bind(user.id, id).run();
  await audit(c, 'company_mapping.created', 'company_code_mappings', id, { company_id: company.id, prefix, priority, effective_from: from, effective_to: to });
  return c.json(await mappingIn(db, s, id), 201);
});

/** Change priority / dates / note of a mapping; `version` must be the one read (a concurrent change answers 409). */
companyDetectionRoutes.put('/mappings/:id', requirePerm('company_mapping.manage'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const s = await scopeOf(db, user);
  const m = await mappingIn(db, s, intParam(c.req.param('id')));
  const body = await readJson(c);
  const version = Number(body.version);
  if (!Number.isInteger(version)) throw badRequest('ต้องระบุ version ที่อ่านมา');
  if ('company_id' in body && Number(body.company_id) !== m.company_id) throw badRequest('เปลี่ยนบริษัทของการจับคู่ไม่ได้: ปิดใช้งานรายการนี้แล้วสร้างการจับคู่ใหม่');
  if ('prefix' in body && normalizeCode(String(body.prefix)) !== m.prefix) throw badRequest('เปลี่ยนรหัสนำหน้าไม่ได้: ปิดใช้งานรายการนี้แล้วสร้างการจับคู่ใหม่');
  const from = body.effective_from === undefined ? m.effective_from : body.effective_from;
  const to = body.effective_to === undefined ? m.effective_to : body.effective_to === null || body.effective_to === '' ? null : body.effective_to;
  if (!isDate(from) || (to !== null && !isDate(to))) throw badRequest('วันที่มีผลต้องเป็น YYYY-MM-DD');
  if (to !== null && to < from) throw badRequest('วันสิ้นสุดต้องไม่ก่อนวันเริ่ม');
  const priority = readPriority(body.priority, m.priority);
  const note = body.note === undefined ? m.note : readNote(body.note);
  let changed = 0;
  const op = crypto.randomUUID();
  try {
    const res = await db.batch([
      db.prepare(
        `UPDATE company_code_mappings SET priority = ?1, effective_from = ?2, effective_to = ?3, note = ?4, version = version + 1, op_token = ?8, updated_at = datetime('now'), updated_by = ?5
         WHERE id = ?6 AND version = ?7`,
      ).bind(priority, from, to, note, user.id, m.id, version, op),
      // history only for the change this request made (a request that lost the race writes nothing)
      db.prepare(`INSERT INTO company_code_mapping_history (mapping_id, action, before_json, after_json, actor_id) SELECT id, 'updated', ?1, ${MAPPING_JSON}, ?2 FROM company_code_mappings WHERE id = ?3 AND op_token = ?4`)
        .bind(JSON.stringify({ company_id: m.company_id, prefix: m.prefix, priority: m.priority, status: m.status, effective_from: m.effective_from, effective_to: m.effective_to, note: m.note, version: m.version }), user.id, m.id, op),
    ]);
    changed = res[0]?.meta.changes ?? 0;
  } catch (e) {
    dbError(e);
  }
  if (!changed) throw new HttpError(409, 'company_mapping_changed', 'การจับคู่นี้ถูกแก้ไขระหว่างดำเนินการ กรุณาโหลดใหม่');
  await audit(c, 'company_mapping.updated', 'company_code_mappings', m.id, { before: { priority: m.priority, effective_from: m.effective_from, effective_to: m.effective_to, note: m.note }, after: { priority, effective_from: from, effective_to: to, note } });
  return c.json(await mappingIn(db, s, m.id));
});

async function setStatus(c: Context<AppEnv>, status: 'active' | 'inactive') {
  const user = currentUser(c);
  const db = c.env.DB;
  const s = await scopeOf(db, user);
  const m = await mappingIn(db, s, intParam(c.req.param('id')));
  const body = await readJson(c);
  const version = Number(body.version);
  if (!Number.isInteger(version)) throw badRequest('ต้องระบุ version ที่อ่านมา');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (status === 'inactive' && (reason.length < 5 || reason.length > 500)) throw badRequest('ต้องระบุเหตุผลการปิดใช้งาน (5–500 ตัวอักษร)');
  if (m.status === status) throw conflict(status === 'active' ? 'การจับคู่นี้ใช้งานอยู่แล้ว' : 'การจับคู่นี้ปิดใช้งานแล้ว');
  let changed = 0;
  const op = crypto.randomUUID();
  try {
    const res = await db.batch([
      db.prepare(
        status === 'inactive'
          ? "UPDATE company_code_mappings SET status = 'inactive', deactivated_at = datetime('now'), deactivated_by = ?1, deactivate_reason = ?2, version = version + 1, op_token = ?5, updated_at = datetime('now'), updated_by = ?1 WHERE id = ?3 AND version = ?4"
          : "UPDATE company_code_mappings SET status = 'active', deactivated_at = NULL, deactivated_by = NULL, deactivate_reason = NULL, version = version + 1, op_token = ?5, updated_at = datetime('now'), updated_by = ?1 WHERE id = ?3 AND version = ?4 AND ?2 IS NULL",
      ).bind(user.id, status === 'inactive' ? reason : null, m.id, version, op),
      db.prepare(`INSERT INTO company_code_mapping_history (mapping_id, action, before_json, after_json, reason, actor_id) SELECT id, ?1, ?2, ${MAPPING_JSON}, ?3, ?4 FROM company_code_mappings WHERE id = ?5 AND op_token = ?6`)
        .bind(status === 'inactive' ? 'deactivated' : 'activated', JSON.stringify({ status: m.status, version: m.version }), reason || null, user.id, m.id, op),
    ]);
    changed = res[0]?.meta.changes ?? 0;
  } catch (e) {
    dbError(e);
  }
  if (!changed) throw new HttpError(409, 'company_mapping_changed', 'การจับคู่นี้ถูกแก้ไขระหว่างดำเนินการ กรุณาโหลดใหม่');
  await audit(c, status === 'inactive' ? 'company_mapping.deactivated' : 'company_mapping.activated', 'company_code_mappings', m.id, { prefix: m.prefix, company_id: m.company_id, reason: reason || null });
  return c.json(await mappingIn(db, s, m.id));
}
companyDetectionRoutes.post('/mappings/:id/deactivate', requirePerm('company_mapping.manage'), (c) => setStatus(c, 'inactive'));
companyDetectionRoutes.post('/mappings/:id/activate', requirePerm('company_mapping.manage'), (c) => setStatus(c, 'active'));

companyDetectionRoutes.get('/mappings/:id/history', requirePerm('company_mapping.view'), async (c) => {
  const db = c.env.DB;
  const m = await mappingIn(db, await scopeOf(db, currentUser(c)), intParam(c.req.param('id')));
  const { results } = await db
    .prepare('SELECT h.id, h.action, h.before_json, h.after_json, h.reason, h.created_at, u.username AS actor FROM company_code_mapping_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.mapping_id = ? ORDER BY h.id')
    .bind(m.id)
    .all<{ before_json: string | null; after_json: string } & Record<string, unknown>>();
  return c.json({ mapping: m, history: results.map(({ before_json, after_json, ...h }) => ({ ...h, before: before_json ? JSON.parse(before_json) : null, after: JSON.parse(after_json) })) });
});

// ---- Detection and dry run --------------------------------------------------------------------------------------

/** Detection for a code on a date (an existing employee of the scope uses their assignments; others only mappings). */
companyDetectionRoutes.post('/detect', requirePerm('company_mapping.view'), async (c) => {
  const db = c.env.DB;
  const s = await scopeOf(db, currentUser(c));
  const body = await readJson(c);
  const code = typeof body.emp_code === 'string' ? body.emp_code : '';
  const date = body.date === undefined ? bangkokNow().date : body.date;
  if (!isDate(date)) throw badRequest('วันที่ต้องเป็น YYYY-MM-DD');
  const emp = normalizeCode(code)
    ? await db.prepare('SELECT id, company_id FROM employees WHERE upper(emp_code) = ?').bind(normalizeCode(code)).first<{ id: number; company_id: number }>()
    : null;
  // an employee of another company is not revealed: only the mappings decide then
  const mine = emp && inScope(s, emp.company_id) ? await loadAssignments(db, [emp.id]) : [];
  // every mapping takes part (a conflict with another company's mapping must show); companies outside the scope are
  // masked in the answer below
  const mappings = await loadMappings(db);
  const d = detectCompany({ code, date, mappings, assignments: mine });
  // a company outside the scope is never named
  const visible = (id: number | null) => (id !== null && inScope(s, id) ? id : null);
  return c.json({ ...d, companyId: visible(d.companyId), mappingCompanyId: visible(d.mappingCompanyId), message: d.error ? DETECTION_LABEL[d.error] : null, date });
});

/** Read-only report of existing employees of the scope: nothing is assigned or changed. */
companyDetectionRoutes.get('/dry-run', requirePerm('company_mapping.view'), async (c) => {
  const db = c.env.DB;
  const s = await scopeOf(db, currentUser(c));
  const date = c.req.query('date') ?? bangkokNow().date;
  if (!isDate(date)) throw badRequest('วันที่ต้องเป็น YYYY-MM-DD');
  const { results: emps } = await db
    .prepare(`SELECT id, emp_code, company_id FROM employees WHERE status IN ('active', 'probation', 'resigned', 'terminated') AND (?1 = 1 OR company_id IN (SELECT value FROM json_each(?2))) ORDER BY emp_code`)
    .bind(s.all ? 1 : 0, JSON.stringify(s.ids))
    .all<{ id: number; emp_code: string; company_id: number }>();
  const mappings = await loadMappings(db);
  const assignments = await loadAssignments(db, emps.map((e) => e.id));
  const rows = emps.map((e) => classifyEmployee(e, date, mappings, assignments));
  const counts: Record<Classification | 'total' | 'historical_transfer', number> = {
    total: rows.length, already_assigned: 0, assigned_mapping_differs: 0, mapping_matched: 0, unresolved: 0, conflict: 0, inactive_mapping: 0, historical_transfer: 0,
  };
  for (const r of rows) {
    counts[r.classification] += 1;
    if (r.historicalTransfer) counts.historical_transfer += 1;
  }
  const needReview = rows.filter((r) => r.classification !== 'already_assigned');
  return c.json({
    date,
    counts,
    // codes only (no names): what HR has to look at, the company on the record kept as it is
    review: needReview.slice(0, 200).map((r) => ({ employee_id: r.employee_id, emp_code: r.emp_code, record_company_id: r.record_company_id, classification: r.classification, mapping_company_id: r.detection.mappingCompanyId !== null && inScope(s, r.detection.mappingCompanyId) ? r.detection.mappingCompanyId : null, error: r.detection.error })),
    unmatchedSamples: rows.filter((r) => r.detection.mappingCompanyId === null).slice(0, 20).map((r) => r.emp_code),
  });
});

// ---- Assignments --------------------------------------------------------------------------------------------------

interface AssignmentRow {
  id: number;
  employee_id: number;
  company_id: number;
  effective_from: string;
  effective_to: string | null;
  status: 'verified' | 'pending_review' | 'cancelled';
  source: string;
}
const ASSIGNMENT_JSON = "json_object('company_id', company_id, 'effective_from', effective_from, 'effective_to', effective_to, 'status', status, 'source', source)";

async function scopedEmployee(db: D1Database, s: Scope, id: number) {
  const e = await db.prepare('SELECT id, emp_code, company_id, hire_date, termination_date FROM employees WHERE id = ?').bind(id).first<{ id: number; emp_code: string; company_id: number; hire_date: string; termination_date: string | null }>();
  if (!e || !inScope(s, e.company_id)) throw notFound('ไม่พบพนักงาน');
  return e;
}

companyDetectionRoutes.get('/employees/:id/assignments', requirePerm('company_mapping.view'), async (c) => {
  const db = c.env.DB;
  const e = await scopedEmployee(db, await scopeOf(db, currentUser(c)), intParam(c.req.param('id')));
  const { results: assignments } = await db.prepare('SELECT * FROM employee_company_assignments WHERE employee_id = ? ORDER BY effective_from, id').bind(e.id).all();
  const { results: history } = await db
    .prepare('SELECT h.id, h.assignment_id, h.action, h.before_json, h.after_json, h.reason, h.reference, h.created_at, u.username AS actor FROM employee_company_assignment_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.employee_id = ? ORDER BY h.id')
    .bind(e.id)
    .all<{ before_json: string | null; after_json: string } & Record<string, unknown>>();
  return c.json({ employee: { id: e.id, emp_code: e.emp_code, company_id: e.company_id }, assignments, history: history.map(({ before_json, after_json, ...h }) => ({ ...h, before: before_json ? JSON.parse(before_json) : null, after: JSON.parse(after_json) })) });
});

/** Approved / published payroll periods of these companies covering a day from `from` on (their days are closed). */
async function lockedPeriod(db: D1Database, companies: readonly number[], from: string): Promise<{ code: string; status: string } | null> {
  return db
    .prepare("SELECT code, status FROM payroll_periods WHERE deleted_at IS NULL AND status IN ('approved', 'published') AND end_date >= ?1 AND (company_id IS NULL OR company_id IN (SELECT value FROM json_each(?2))) ORDER BY start_date LIMIT 1")
    .bind(from, JSON.stringify(companies))
    .first<{ code: string; status: string }>();
}

const REASON_MIN = 5;
function reasonAndReference(body: Record<string, unknown>): { reason: string; reference: string } {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
  if (reason.length < REASON_MIN || reason.length > 500) throw new HttpError(400, 'reason_required', `ต้องระบุเหตุผล (${REASON_MIN}–500 ตัวอักษร)`);
  if (!reference || reference.length > 200) throw new HttpError(400, 'reason_required', 'ต้องระบุเอกสารอ้างอิง (ไม่เกิน 200 ตัวอักษร)');
  return { reason, reference };
}

/**
 * Move an employee to another company from a date (today or earlier): the open assignment ends the day before, a new
 * verified one starts, employees.company_id follows — one transaction. Refused when an approved / published period of
 * either company covers a moved day (the paid past is never rewritten) or when the user's scope lacks either company.
 */
companyDetectionRoutes.post('/employees/:id/transfer', requirePerm('employee_company.transfer'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const s = await scopeOf(db, user);
  const e = await scopedEmployee(db, s, intParam(c.req.param('id')));
  const body = await readJson(c);
  const target = await scopedCompany(db, s, body.company_id);
  const { reason, reference } = reasonAndReference(body);
  const from = body.effective_from;
  if (!isDate(from)) throw badRequest('effective_from ต้องเป็น YYYY-MM-DD');
  if (from > bangkokNow().date) throw badRequest('ยังไม่รองรับการย้ายบริษัทล่วงหน้า (วันที่มีผลต้องไม่เกินวันนี้)');
  if (from <= e.hire_date) throw badRequest('วันที่ย้ายต้องอยู่หลังวันเริ่มงาน');
  if (target.id === e.company_id) throw badRequest('พนักงานอยู่ในบริษัทนี้แล้ว');
  const open = await db.prepare("SELECT * FROM employee_company_assignments WHERE employee_id = ? AND status <> 'cancelled' AND effective_to IS NULL").bind(e.id).first<AssignmentRow>();
  if (!open || open.status !== 'verified' || open.company_id !== e.company_id) throw new HttpError(409, 'company_conflict', 'การกำหนดบริษัทปัจจุบันของพนักงานยังไม่ได้รับการยืนยัน ต้องตรวจสอบก่อนย้าย');
  if (from <= open.effective_from) throw badRequest('วันที่ย้ายต้องอยู่หลังวันเริ่มของการกำหนดบริษัทปัจจุบัน');
  // the employee's days in the old company before the move must be paid by a period that is already approved: the
  // engine pays by the current company, so an open earlier period could no longer pay them after the move
  const open_ = await db
    .prepare("SELECT code, status FROM payroll_periods WHERE deleted_at IS NULL AND status IN ('draft', 'calculated') AND start_date < ?1 AND end_date >= ?2 AND start_date <= ?3 AND (company_id IS NULL OR company_id = ?4) ORDER BY start_date LIMIT 1")
    .bind(from, open.effective_from, addDays(from, -1), e.company_id)
    .first<{ code: string; status: string }>();
  if (open_) throw new HttpError(409, 'company_period_open', `งวดเงินเดือน ${open_.code} ของบริษัทเดิมครอบคลุมวันก่อนย้ายแต่ยังไม่อนุมัติ ต้องอนุมัติงวดนั้นก่อนย้ายบริษัท`);
  const locked = await lockedPeriod(db, [e.company_id, target.id], from);
  if (locked) throw new HttpError(409, 'company_period_locked', `งวดเงินเดือน ${locked.code} (${locked.status === 'published' ? 'เผยแพร่' : 'อนุมัติ'}แล้ว) ครอบคลุมวันที่ย้าย ย้ายย้อนหลังไม่ได้ ต้องเปิดงวดตามขั้นตอนที่ได้รับอนุญาตก่อน`);
  const op = crypto.randomUUID();
  const end = addDays(from, -1);
  try {
    const res = await db.batch([
      // the open assignment read above must still be the open one (a concurrent transfer makes this a no-op → 409)
      db.prepare("UPDATE employee_company_assignments SET effective_to = ?1, op_token = ?2, updated_at = datetime('now'), updated_by = ?3 WHERE id = ?4 AND effective_to IS NULL AND status = 'verified'").bind(end, op, user.id, open.id),
      db.prepare(`SELECT CASE WHEN EXISTS (SELECT 1 FROM employee_company_assignments WHERE id = ?1 AND op_token = ?2) THEN 1 ELSE json('company assignment changed') END AS ok`).bind(open.id, op),
      db.prepare(
        `INSERT INTO employee_company_assignments (employee_id, company_id, effective_from, status, source, reason, reference, op_token, created_by, updated_by, verified_at, verified_by)
         VALUES (?1, ?2, ?3, 'verified', 'transfer', ?4, ?5, ?6, ?7, ?7, datetime('now'), ?7)`,
      ).bind(e.id, target.id, from, reason, reference, op, user.id),
      db.prepare("UPDATE employees SET company_id = ?1, updated_at = datetime('now'), updated_by = ?2 WHERE id = ?3 AND company_id = ?4").bind(target.id, user.id, e.id, e.company_id),
      db.prepare(`INSERT INTO employee_company_assignment_history (assignment_id, employee_id, action, before_json, after_json, reason, reference, actor_id, op_token)
                  SELECT id, employee_id, 'ended', ?1, ${ASSIGNMENT_JSON}, ?2, ?3, ?4, ?5 FROM employee_company_assignments WHERE id = ?6`)
        .bind(JSON.stringify({ company_id: open.company_id, effective_from: open.effective_from, effective_to: null, status: open.status, source: open.source }), reason, reference, user.id, op, open.id),
      db.prepare(`INSERT INTO employee_company_assignment_history (assignment_id, employee_id, action, after_json, reason, reference, actor_id, op_token)
                  SELECT id, employee_id, 'created', ${ASSIGNMENT_JSON}, ?1, ?2, ?3, ?4 FROM employee_company_assignments WHERE op_token = ?4 AND source = 'transfer' AND employee_id = ?5`)
        .bind(reason, reference, user.id, op, e.id),
    ]);
    if (!res[3]?.meta.changes) throw conflict('ข้อมูลพนักงานถูกแก้ไขระหว่างดำเนินการ กรุณาโหลดใหม่');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (/malformed JSON/i.test(`${(err as Error).message} ${String((err as { cause?: unknown }).cause ?? '')}`)) throw new HttpError(409, 'company_assignment_changed', 'การกำหนดบริษัทของพนักงานถูกแก้ไขระหว่างดำเนินการ กรุณาโหลดใหม่');
    dbError(err);
  }
  await audit(c, 'employee_company.transferred', 'employees', e.id, { from_company_id: e.company_id, to_company_id: target.id, effective_from: from, reason, reference, op });
  return c.json({ ok: true, employee_id: e.id, company_id: target.id, effective_from: from, op });
});

/** HR confirms an assignment held for review (e.g. the entered company differs from the prefix mapping). */
companyDetectionRoutes.post('/assignments/:id/verify', requirePerm('employee_company.transfer'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const s = await scopeOf(db, user);
  const a = await db.prepare('SELECT * FROM employee_company_assignments WHERE id = ?').bind(intParam(c.req.param('id'))).first<AssignmentRow>();
  if (!a || !inScope(s, a.company_id)) throw notFound('ไม่พบการกำหนดบริษัท');
  await scopedEmployee(db, s, a.employee_id);
  const { reason, reference } = reasonAndReference(await readJson(c));
  const op = crypto.randomUUID();
  const res = await db.batch([
    db.prepare("UPDATE employee_company_assignments SET status = 'verified', verified_at = datetime('now'), verified_by = ?1, op_token = ?2, updated_at = datetime('now'), updated_by = ?1 WHERE id = ?3 AND status = 'pending_review'").bind(user.id, op, a.id),
    db.prepare(`INSERT INTO employee_company_assignment_history (assignment_id, employee_id, action, before_json, after_json, reason, reference, actor_id, op_token)
                SELECT id, employee_id, 'verified', ?1, ${ASSIGNMENT_JSON}, ?2, ?3, ?4, ?5 FROM employee_company_assignments WHERE id = ?6 AND op_token = ?5`)
      .bind(JSON.stringify({ status: a.status }), reason, reference, user.id, op, a.id),
  ]);
  if (!res[0]?.meta.changes) throw conflict('การกำหนดบริษัทนี้ไม่ได้อยู่ในสถานะรอยืนยัน');
  await audit(c, 'employee_company.verified', 'employee_company_assignments', a.id, { employee_id: a.employee_id, company_id: a.company_id, reason, reference });
  return c.json({ ok: true, id: a.id, status: 'verified' });
});
