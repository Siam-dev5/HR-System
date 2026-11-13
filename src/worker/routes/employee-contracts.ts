// Contract periods of contract employees (P5): list, record, change the end date, cancel, history. Only employees whose
// employment_type is 'contract' get contract periods. Every request checks permission and company scope (another
// company's employee answers like a missing one); every change needs a reason, is versioned, keeps an append-only
// history and is audited. Nothing here pays or deducts: payroll eligibility reads the periods (review when the paid
// days are not covered); the pay formula is unchanged.
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { currentUser, requireAuth, requirePerm } from '../auth';
import { audit } from '../lib/audit';
import { companyScope } from '../lib/companies';
import { badRequest, conflict, HttpError, intParam, notFound, readJson } from '../lib/http';

export const employeeContractRoutes = new Hono<AppEnv>();
employeeContractRoutes.use('*', requireAuth);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

interface Emp {
  id: number;
  emp_code: string;
  company_id: number;
  employment_type: string;
  hire_date: string;
  termination_date: string | null;
}
interface ContractRow {
  id: number;
  employee_id: number;
  company_id: number;
  contract_no: string | null;
  start_date: string;
  end_date: string | null;
  status: 'active' | 'cancelled';
  reason: string | null;
  reference: string | null;
  version: number;
}
const CONTRACT_JSON = "json_object('contract_no', contract_no, 'start_date', start_date, 'end_date', end_date, 'status', status, 'version', version)";

/** The employee, when the user's company scope covers them (404 otherwise, like a missing one). */
async function scopedEmployee(c: Context<AppEnv>, id: number): Promise<Emp> {
  const db = c.env.DB;
  const e = await db.prepare('SELECT id, emp_code, company_id, employment_type, hire_date, termination_date FROM employees WHERE id = ?').bind(id).first<Emp>();
  const s = await companyScope(db, currentUser(c));
  if (!e || (s.scope !== 'all' && !s.items.some((x) => x.id === e.company_id))) throw notFound('ไม่พบพนักงาน');
  return e;
}

function reasonAndReference(body: Record<string, unknown>): { reason: string; reference: string | null } {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 5 || reason.length > 500) throw new HttpError(400, 'reason_required', 'ต้องระบุเหตุผล (5–500 ตัวอักษร)');
  const reference = typeof body.reference === 'string' && body.reference.trim() ? body.reference.trim().slice(0, 200) : null;
  return { reason, reference };
}

function dbError(e: unknown): never {
  const text = e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  if (text.includes('employee_contract_overlap')) throw new HttpError(409, 'employee_contract_overlap', 'ช่วงวันที่ของสัญญาซ้อนกับสัญญาที่ใช้งานอยู่');
  throw e;
}

employeeContractRoutes.get('/employees/:id', requirePerm('employee_contract.view'), async (c) => {
  const e = await scopedEmployee(c, intParam(c.req.param('id')));
  const db = c.env.DB;
  const { results: contracts } = await db.prepare('SELECT * FROM employee_contracts WHERE employee_id = ? ORDER BY start_date, id').bind(e.id).all<ContractRow>();
  const { results: history } = await db
    .prepare('SELECT h.id, h.contract_id, h.action, h.before_json, h.after_json, h.reason, h.reference, h.created_at, u.username AS actor FROM employee_contract_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.employee_id = ? ORDER BY h.id')
    .bind(e.id)
    .all<{ before_json: string | null; after_json: string } & Record<string, unknown>>();
  return c.json({
    employee: { id: e.id, emp_code: e.emp_code, company_id: e.company_id, employment_type: e.employment_type, hire_date: e.hire_date, termination_date: e.termination_date },
    contracts,
    history: history.map(({ before_json, after_json, ...h }) => ({ ...h, before: before_json ? JSON.parse(before_json) : null, after: JSON.parse(after_json) })),
  });
});

/** Record a contract period of a contract employee. */
employeeContractRoutes.post('/employees/:id', requirePerm('employee_contract.manage'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const e = await scopedEmployee(c, intParam(c.req.param('id')));
  if (e.employment_type !== 'contract') throw badRequest('บันทึกสัญญาได้เฉพาะพนักงานประเภทสัญญาจ้าง (employment_type = contract)');
  const body = await readJson(c);
  const { reason, reference } = reasonAndReference(body);
  const start = body.start_date;
  const end = body.end_date === undefined || body.end_date === null || body.end_date === '' ? null : body.end_date;
  if (!isDate(start) || (end !== null && !isDate(end))) throw badRequest('วันที่ต้องเป็น YYYY-MM-DD');
  if (end !== null && end < start) throw badRequest('วันสิ้นสุดสัญญาต้องไม่ก่อนวันเริ่ม');
  if (start < e.hire_date) throw badRequest('วันเริ่มสัญญาต้องไม่ก่อนวันเริ่มงาน');
  const contractNo = typeof body.contract_no === 'string' && body.contract_no.trim() ? body.contract_no.trim().slice(0, 100) : null;
  const op = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO employee_contracts (employee_id, company_id, contract_no, start_date, end_date, reason, reference, op_token, created_by, updated_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
      ).bind(e.id, e.company_id, contractNo, start, end, reason, reference, op, user.id),
      db.prepare(`INSERT INTO employee_contract_history (contract_id, employee_id, action, after_json, reason, reference, actor_id, op_token) SELECT id, employee_id, 'created', ${CONTRACT_JSON}, ?1, ?2, ?3, ?4 FROM employee_contracts WHERE op_token = ?4`)
        .bind(reason, reference, user.id, op),
    ]);
  } catch (err) {
    dbError(err);
  }
  const row = await db.prepare('SELECT * FROM employee_contracts WHERE op_token = ?').bind(op).first<ContractRow>();
  await audit(c, 'employee_contract.created', 'employee_contracts', row?.id ?? null, { employee_id: e.id, company_id: e.company_id, start_date: start, end_date: end, contract_no: contractNo, reason, reference });
  return c.json(row, 201);
});

async function scopedContract(c: Context<AppEnv>): Promise<ContractRow> {
  const row = await c.env.DB.prepare('SELECT * FROM employee_contracts WHERE id = ?').bind(intParam(c.req.param('contractId'), 'contractId')).first<ContractRow>();
  if (!row) throw notFound('ไม่พบสัญญา');
  await scopedEmployee(c, row.employee_id);
  return row;
}

/** Change the end date (renewal / early end) of an active contract; `version` must be the one read. */
employeeContractRoutes.put('/:contractId', requirePerm('employee_contract.manage'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const row = await scopedContract(c);
  if (row.status !== 'active') throw conflict('สัญญานี้ถูกยกเลิกแล้ว');
  const body = await readJson(c);
  const { reason, reference } = reasonAndReference(body);
  const version = Number(body.version);
  if (!Number.isInteger(version)) throw badRequest('ต้องระบุ version ที่อ่านมา');
  if (!('end_date' in body)) throw badRequest('ต้องระบุ end_date (null = ไม่มีกำหนด)');
  const end = body.end_date === null || body.end_date === '' ? null : body.end_date;
  if (end !== null && (!isDate(end) || end < row.start_date)) throw badRequest('วันสิ้นสุดสัญญาต้องเป็นวันที่ไม่ก่อนวันเริ่ม');
  const op = crypto.randomUUID();
  let changed = 0;
  try {
    const res = await db.batch([
      db.prepare("UPDATE employee_contracts SET end_date = ?1, reason = ?2, reference = ?3, version = version + 1, op_token = ?4, updated_at = datetime('now'), updated_by = ?5 WHERE id = ?6 AND version = ?7 AND status = 'active'")
        .bind(end, reason, reference, op, user.id, row.id, version),
      db.prepare(`INSERT INTO employee_contract_history (contract_id, employee_id, action, before_json, after_json, reason, reference, actor_id, op_token) SELECT id, employee_id, 'updated', ?1, ${CONTRACT_JSON}, ?2, ?3, ?4, ?5 FROM employee_contracts WHERE id = ?6 AND op_token = ?5`)
        .bind(JSON.stringify({ contract_no: row.contract_no, start_date: row.start_date, end_date: row.end_date, status: row.status, version: row.version }), reason, reference, user.id, op, row.id),
    ]);
    changed = res[0]?.meta.changes ?? 0;
  } catch (err) {
    dbError(err);
  }
  if (!changed) throw new HttpError(409, 'employee_contract_changed', 'สัญญานี้ถูกแก้ไขระหว่างดำเนินการ กรุณาโหลดใหม่');
  await audit(c, 'employee_contract.updated', 'employee_contracts', row.id, { employee_id: row.employee_id, before: { end_date: row.end_date }, after: { end_date: end }, reason, reference });
  return c.json(await db.prepare('SELECT * FROM employee_contracts WHERE id = ?').bind(row.id).first());
});

/** Cancel a contract period entered by mistake (kept for history, never used). */
employeeContractRoutes.post('/:contractId/cancel', requirePerm('employee_contract.manage'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const row = await scopedContract(c);
  const body = await readJson(c);
  const { reason, reference } = reasonAndReference(body);
  const version = Number(body.version);
  if (!Number.isInteger(version)) throw badRequest('ต้องระบุ version ที่อ่านมา');
  const op = crypto.randomUUID();
  const res = await db.batch([
    db.prepare("UPDATE employee_contracts SET status = 'cancelled', cancelled_at = datetime('now'), cancelled_by = ?1, cancel_reason = ?2, version = version + 1, op_token = ?3, updated_at = datetime('now'), updated_by = ?1 WHERE id = ?4 AND version = ?5 AND status = 'active'")
      .bind(user.id, reason, op, row.id, version),
    db.prepare(`INSERT INTO employee_contract_history (contract_id, employee_id, action, before_json, after_json, reason, reference, actor_id, op_token) SELECT id, employee_id, 'cancelled', ?1, ${CONTRACT_JSON}, ?2, ?3, ?4, ?5 FROM employee_contracts WHERE id = ?6 AND op_token = ?5`)
      .bind(JSON.stringify({ status: row.status, version: row.version }), reason, reference, user.id, op, row.id),
  ]);
  if (!res[0]?.meta.changes) throw new HttpError(409, 'employee_contract_changed', 'สัญญานี้ถูกยกเลิกหรือแก้ไขไปแล้ว กรุณาโหลดใหม่');
  await audit(c, 'employee_contract.cancelled', 'employee_contracts', row.id, { employee_id: row.employee_id, reason, reference });
  return c.json({ ok: true, id: row.id, status: 'cancelled' });
});
