import { Hono } from 'hono';
import { holdIfMappingDiffers } from '../lib/company-detection';
import { CHANGE_SET, attendanceDbError, changeValues, crudChange } from '../lib/attendance-records';
import type { Context } from 'hono';
import type { AppEnv, AuthUser } from '../env';
import type { CrudModule, FieldDef } from '../../shared/modules';
import { crudModule, isSuperAdmin } from '../../shared/modules';
import type { ListResponse, LookupOption, ModulePerms, Row } from '../../shared/types';
import { resolveLink } from '../../shared/links';
import { DATE_RE, HttpError, badRequest, conflict, csv, forbidden, intParam, notFound, readJson } from '../lib/http';
import { audit } from '../lib/audit';
import { requireCompany } from '../lib/companies';
import { bangkokNow } from '../lib/time';
import { can, currentUser, requireAuth } from '../auth';
import { cancelWorkflowFor, startWorkflow } from './workflow';

export function modulePerms(user: AuthUser, m: CrudModule): ModulePerms {
  const p = (a: string) => can(user, `${m.key}.${a}`);
  return { view: p('view'), create: p('create'), update: p('update'), delete: p('delete'), export: p('export'), all: !m.ownerField || p('all'), sensitive: p('sensitive') };
}

function moduleOr404(key: string | undefined): CrudModule {
  const m = key ? crudModule(key) : undefined;
  if (!m) throw notFound('ไม่พบโมดูล');
  return m;
}

function need(user: AuthUser, m: CrudModule, action: keyof ModulePerms): void {
  if (!modulePerms(user, m)[action]) throw forbidden(`ต้องมีสิทธิ์ ${m.key}.${action}`);
}

/** Row-level visibility for owner-scoped modules. */
function scopeSql(user: AuthUser, m: CrudModule): { sql: string; params: unknown[] } {
  if (!m.ownerField || can(user, `${m.key}.all`)) return { sql: '1', params: [] };
  const own = user.employeeId === null ? { sql: '0', params: [] as unknown[] } : { sql: `t.${m.ownerField} = ?`, params: [user.employeeId] as unknown[] };
  if (!m.publicWhere) return own;
  return { sql: `(${own.sql} OR (${m.publicWhere}))`, params: own.params };
}

function refTarget(f: FieldDef): { table: string; label: string } {
  if (f.ref === 'roles') return { table: 'roles', label: 'name' };
  const target = f.ref ? crudModule(f.ref) : undefined;
  if (!target) throw new Error(`Unknown ref target ${f.ref}`);
  return { table: target.table, label: target.labelExpr };
}

function selectColumns(m: CrudModule): string {
  const cols = ['t.id', ...m.fields.map((f) => `t.${f.name}`), 't.created_at', 't.updated_at'];
  for (const c of m.computed ?? []) cols.push(`(${c.expr}) AS ${c.name}`);
  for (const f of m.fields) {
    if (f.type !== 'ref') continue;
    const r = refTarget(f);
    cols.push(`(SELECT ${r.label} FROM ${r.table} r WHERE r.id = t.${f.name}) AS ${f.name}__label`);
  }
  return cols.join(', ');
}

const MASK = '••••••';

function maskRow(user: AuthUser, m: CrudModule, row: Row): Row {
  if (modulePerms(user, m).sensitive) return row;
  const out = { ...row };
  for (const f of m.fields) if (f.sensitive && out[f.name] !== null && out[f.name] !== undefined) out[f.name] = MASK;
  return out;
}

interface ListQuery {
  where: string;
  params: unknown[];
  order: string;
}

/**
 * Employee lists filtered by company: the company must be in the user's company scope (403 otherwise), exactly as on
 * the other company-scoped pages. The row scope below still applies, so this never widens what a user can see.
 */
async function checkCompanyFilter(c: Context<AppEnv>, user: AuthUser, m: CrudModule): Promise<void> {
  if (m.key === 'employees') await requireCompany(c.env.DB, user, c.req.query('f.company_id'));
}

function buildListQuery(c: Context<AppEnv>, user: AuthUser, m: CrudModule): ListQuery {
  const scope = scopeSql(user, m);
  const where = [scope.sql];
  const params = [...scope.params];
  const q = (c.req.query('q') ?? '').trim();
  if (q && m.searchFields.length) {
    where.push(`(${m.searchFields.map((f) => `t.${f} LIKE ?`).join(' OR ')})`);
    for (let i = 0; i < m.searchFields.length; i++) params.push(`%${q}%`);
  }
  for (const f of m.fields) {
    const v = c.req.query(`f.${f.name}`);
    if (v === undefined || v === '' || !['select', 'ref', 'bool', 'date', 'number'].includes(f.type)) continue;
    where.push(`t.${f.name} = ?`);
    params.push(f.type === 'ref' || f.type === 'bool' || f.type === 'number' ? Number(v) : v);
  }
  const sortable = new Set([...m.fields.map((f) => f.name), 'id', 'created_at', 'updated_at']);
  const sort = c.req.query('sort');
  const dir = c.req.query('dir') === 'asc' ? 'ASC' : 'DESC';
  const order = sort && sortable.has(sort) ? `t.${sort} ${dir}, t.id DESC` : m.defaultSort;
  return { where: where.join(' AND '), params, order };
}

const TEXT_MAX: Partial<Record<FieldDef['type'], number>> = { text: 300, email: 200, url: 1000, textarea: 10000 };

/** Validates and coerces one client value according to the registry field definition. */
export function coerceField(f: FieldDef, raw: unknown): string | number | null {
  if (raw === undefined || raw === null || raw === '') {
    if (f.type === 'bool') return 0;
    if (f.required) throw badRequest(`กรุณาระบุ ${f.label}`, { field: f.name });
    return null;
  }
  const fail = (msg: string) => badRequest(`${f.label}: ${msg}`, { field: f.name });
  switch (f.type) {
    case 'bool':
      if (raw === true || raw === 1 || raw === '1' || raw === 'true') return 1;
      if (raw === false || raw === 0 || raw === '0' || raw === 'false') return 0;
      throw fail('ต้องเป็นใช่/ไม่ใช่');
    case 'number':
    case 'money': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
      if (!Number.isFinite(n)) throw fail('ต้องเป็นตัวเลข');
      if (f.min !== undefined && n < f.min) throw fail(`ต้องไม่น้อยกว่า ${f.min}`);
      if (f.max !== undefined && n > f.max) throw fail(`ต้องไม่เกิน ${f.max}`);
      return f.type === 'money' ? Math.round(n * 100) / 100 : n;
    }
    case 'ref': {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) throw fail('ค่าอ้างอิงไม่ถูกต้อง');
      return n;
    }
    case 'date': {
      const s = String(raw);
      if (!DATE_RE.test(s) || Number.isNaN(Date.parse(s))) throw fail('รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
      return s;
    }
    case 'time': {
      const s = String(raw);
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw fail('รูปแบบเวลาต้องเป็น HH:MM');
      return s;
    }
    case 'select': {
      const s = String(raw);
      if (!f.options?.includes(s)) throw fail('ค่าไม่อยู่ในตัวเลือก');
      return s;
    }
    default: {
      if (typeof raw !== 'string') throw fail('ต้องเป็นข้อความ');
      const s = raw.trim();
      if (!s) {
        if (f.required) throw badRequest(`กรุณาระบุ ${f.label}`, { field: f.name });
        return null;
      }
      const max = TEXT_MAX[f.type] ?? 300;
      if (s.length > max) throw fail(`ยาวเกิน ${max} ตัวอักษร`);
      if (f.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw fail('รูปแบบอีเมลไม่ถูกต้อง');
      if (f.type === 'url' && !resolveLink(s)?.external) throw fail('ต้องเป็นลิงก์ http(s)');
      return s;
    }
  }
}

function crossValidate(values: Record<string, unknown>): void {
  const pairs: Array<[string, string]> = [['start_date', 'end_date'], ['open_date', 'close_date'], ['opened_date', 'close_date']];
  for (const [a, b] of pairs) {
    const va = values[a];
    const vb = values[b];
    if (typeof va === 'string' && typeof vb === 'string' && va > vb) throw badRequest('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม', { field: b });
  }
}

function translateDbError(e: unknown, m: CrudModule): never {
  const msg = e instanceof Error ? e.message : String(e);
  if (/UNIQUE constraint failed/i.test(msg)) {
    // local: "UNIQUE constraint failed: t.code"; remote D1 appends ": SQLITE_CONSTRAINT (extended: ...)"
    const col = /UNIQUE constraint failed: \w+\.(\w+)/i.exec(msg)?.[1];
    const f = m.fields.find((x) => x.name === col);
    throw conflict(`${f?.label ?? 'ข้อมูล'} ซ้ำกับรายการที่มีอยู่แล้ว`);
  }
  if (/FOREIGN KEY constraint failed/i.test(msg)) throw conflict('ข้อมูลอ้างอิงไม่ถูกต้อง หรือรายการนี้ถูกใช้งานอยู่ในข้อมูลอื่น');
  if (/NOT NULL constraint failed/i.test(msg)) throw badRequest('ข้อมูลที่จำเป็นไม่ครบ');
  throw e;
}

async function loadVisible(c: Context<AppEnv>, user: AuthUser, m: CrudModule, id: number): Promise<Row> {
  const scope = scopeSql(user, m);
  const row = await c.env.DB.prepare(`SELECT ${selectColumns(m)} FROM ${m.table} t WHERE t.id = ? AND ${scope.sql}`)
    .bind(id, ...scope.params)
    .first<Row>();
  if (!row) throw notFound();
  return row;
}

export const crudRoutes = new Hono<AppEnv>();
crudRoutes.use('*', requireAuth);

crudRoutes.get('/:key', async (c) => {
  const user = currentUser(c);
  const m = moduleOr404(c.req.param('key'));
  need(user, m, 'view');
  await checkCompanyFilter(c, user, m);
  const { where, params, order } = buildListQuery(c, user, m);
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(c.req.query('pageSize')) || 50));
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${m.table} t WHERE ${where}`).bind(...params).first<{ n: number }>();
  const { results } = await c.env.DB.prepare(`SELECT ${selectColumns(m)} FROM ${m.table} t WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...params, pageSize, (page - 1) * pageSize)
    .all<Row>();
  return c.json<ListResponse>({ rows: results.map((r) => maskRow(user, m, r)), total: total?.n ?? 0, page, pageSize, asOf: bangkokNow().date });
});

crudRoutes.get('/:key/export.csv', async (c) => {
  const user = currentUser(c);
  const m = moduleOr404(c.req.param('key'));
  need(user, m, 'view');
  need(user, m, 'export');
  await checkCompanyFilter(c, user, m);
  const { where, params, order } = buildListQuery(c, user, m);
  const { results } = await c.env.DB.prepare(`SELECT ${selectColumns(m)} FROM ${m.table} t WHERE ${where} ORDER BY ${order} LIMIT 10000`).bind(...params).all<Row>();
  const available = [
    ...m.fields.map((f) => ({ name: f.name, label: f.label, ref: f.type === 'ref' })),
    ...(m.computed ?? []).map((x) => ({ name: x.name, label: x.label, ref: false })),
  ];
  const requested = (c.req.query('columns') ?? '').split(',').filter(Boolean);
  const cols = requested.length ? available.filter((a) => requested.includes(a.name)) : available;
  if (!cols.length) throw badRequest('ไม่มีคอลัมน์ที่เลือก');
  const rows = results.map((r) => maskRow(user, m, r));
  const body = csv([['ID', ...cols.map((x) => x.label)], ...rows.map((r) => [r.id ?? null, ...cols.map((x) => (x.ref ? (r[`${x.name}__label`] ?? r[x.name] ?? null) : (r[x.name] ?? null)))])]);
  await audit(c, 'data.export', m.key, null, { rows: rows.length, columns: cols.map((x) => x.name) });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return c.body(body, 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${m.key}-${stamp}.csv"`,
    'cache-control': 'no-store',
  });
});

crudRoutes.get('/:key/:id', async (c) => {
  const user = currentUser(c);
  const m = moduleOr404(c.req.param('key'));
  need(user, m, 'view');
  return c.json(maskRow(user, m, await loadVisible(c, user, m, intParam(c.req.param('id')))));
});

crudRoutes.post('/:key', async (c) => {
  const user = currentUser(c);
  const m = moduleOr404(c.req.param('key'));
  need(user, m, 'create');
  const body = await readJson(c);
  const perms = modulePerms(user, m);
  const values: Record<string, string | number | null> = {};
  const forceOwner = !!m.ownerField && m.ownerField !== 'id' && !perms.all;
  for (const f of m.fields) {
    if (f.readonly) continue;
    if (f.sensitive && !perms.sensitive) continue;
    if (forceOwner && f.name === m.ownerField) continue; // filled in below; the form does not send it
    values[f.name] = coerceField(f, body[f.name]);
  }
  if (forceOwner && m.ownerField) {
    if (user.employeeId === null) throw forbidden('บัญชีนี้ไม่ได้ผูกกับข้อมูลพนักงาน จึงยื่นรายการของตนเองไม่ได้');
    values[m.ownerField] = user.employeeId;
  }
  crossValidate(values);
  const cols = Object.keys(values);
  // attendance (P2): scope, period lock and a revision for the new record (with the reason when one is required)
  const change = m.table === 'attendance_records' ? await crudChange(c.env.DB, user, body, null, values) : null;
  const extra = change ? ['change_op', 'change_channel', 'change_reason', 'change_reference'] : [];
  const insert = c.env.DB.prepare(
    `INSERT INTO ${m.table} (${[...cols, ...extra, 'created_by', 'updated_by'].join(', ')}) VALUES (${[...cols, ...extra, 'a', 'b'].map(() => '?').join(', ')}) RETURNING id`,
  ).bind(...cols.map((k) => values[k] ?? null), ...(change ? changeValues(change) : []), user.id, user.id);
  let id: number;
  try {
    const row = await insert.first<{ id: number }>();
    if (!row) throw new HttpError(500, 'insert_failed', 'บันทึกไม่สำเร็จ');
    id = row.id;
  } catch (e) {
    if (change) attendanceDbError(e);
    translateDbError(e, m);
  }
  if (m.workflow) await startWorkflow(c, m, id, values);
  // P3: the entered company is the employee's first assignment; held for HR review when the prefix mapping differs
  const companyHold = m.table === 'employees' ? await holdIfMappingDiffers(c.env.DB, id, user.id) : null;
  await audit(c, 'data.create', m.key, id, { fields: cols, ...(change ? { change: { op: change.op, reason: change.reason, reference: change.reference } } : {}), ...(companyHold?.held ? { companyHeld: companyHold } : {}) });
  return c.json(maskRow(user, m, await loadVisible(c, user, m, id)), 201);
});

crudRoutes.put('/:key/:id', async (c) => {
  const user = currentUser(c);
  const m = moduleOr404(c.req.param('key'));
  need(user, m, 'update');
  const id = intParam(c.req.param('id'));
  const existing = await loadVisible(c, user, m, id);
  if (m.workflow && existing.status !== 'pending') throw conflict('คำขอที่ดำเนินการแล้วแก้ไขไม่ได้');
  const body = await readJson(c);
  const perms = modulePerms(user, m);
  const values: Record<string, string | number | null> = {};
  for (const f of m.fields) {
    if (!(f.name in body) || f.readonly) continue;
    if (f.sensitive && !perms.sensitive) continue;
    if (f.name === m.ownerField && !perms.all) continue;
    values[f.name] = coerceField(f, body[f.name]);
  }
  const cols = Object.keys(values);
  if (!cols.length) throw badRequest('ไม่มีข้อมูลที่จะแก้ไข');
  crossValidate({ ...existing, ...values });
  const change = m.table === 'attendance_records' ? await crudChange(c.env.DB, user, body, existing as { employee_id: number; work_date: string }, values) : null;
  try {
    await c.env.DB.prepare(`UPDATE ${m.table} SET ${cols.map((k) => `${k} = ?`).join(', ')}${change ? `, ${CHANGE_SET}` : ''}, updated_at = datetime('now'), updated_by = ? WHERE id = ?`)
      .bind(...cols.map((k) => values[k] ?? null), ...(change ? changeValues(change) : []), user.id, id)
      .run();
  } catch (e) {
    if (change) attendanceDbError(e);
    // P3: the company of an employee changes only through the transfer (history, reason, payroll lock)
    if (m.table === 'employees' && /employee_company_needs_transfer/.test(`${e instanceof Error ? e.message : String(e)} ${String((e as { cause?: unknown })?.cause ?? '')}`)) {
      throw new HttpError(409, 'employee_company_needs_transfer', 'การเปลี่ยนบริษัทของพนักงานต้องทำผ่านการย้ายบริษัท (POST /api/company-detection/employees/:id/transfer) พร้อมเหตุผลและวันที่มีผล');
    }
    translateDbError(e, m);
  }
  const changed = cols.filter((k) => String(existing[k] ?? '') !== String(values[k] ?? ''));
  // attendance: the original and corrected values are in attendance_record_revisions (op_token = change.op)
  await audit(c, 'data.update', m.key, id, { fields: changed, ...(change ? { change: { op: change.op, reason: change.reason, reference: change.reference } } : {}) });
  return c.json(maskRow(user, m, await loadVisible(c, user, m, id)));
});

crudRoutes.delete('/:key/:id', async (c) => {
  const user = currentUser(c);
  const m = moduleOr404(c.req.param('key'));
  const id = intParam(c.req.param('id'));
  const existing = await loadVisible(c, user, m, id);
  if (m.workflow) {
    // Requests are never hard-deleted: the requester (create permission) or a deleter may cancel while pending.
    const own = m.ownerField !== undefined && existing[m.ownerField] === user.employeeId;
    if (!modulePerms(user, m).delete && !(own && modulePerms(user, m).create)) throw forbidden(`ต้องมีสิทธิ์ ${m.key}.delete`);
    if (existing.status !== 'pending') throw conflict('ยกเลิกได้เฉพาะคำขอที่รออนุมัติ');
    await cancelWorkflowFor(c, m, id);
    await audit(c, 'data.cancel', m.key, id);
    return c.json({ ok: true, cancelled: true });
  }
  need(user, m, 'delete');
  // attendance history is corrected, never deleted (P2; the database refuses it too)
  if (m.table === 'attendance_records') throw new HttpError(409, 'attendance_delete_forbidden', 'ลบบันทึกเวลาทำงานไม่ได้ ใช้การแก้ไขพร้อมเหตุผลแทน (ประวัติการแก้ไขถูกเก็บไว้)');
  try {
    await c.env.DB.prepare(`DELETE FROM ${m.table} WHERE id = ?`).bind(id).run();
  } catch (e) {
    translateDbError(e, m);
  }
  await audit(c, 'data.delete', m.key, id);
  return c.json({ ok: true });
});

// ---- Lookups (dropdown options) ------------------------------------------------------------
// Options any signed-in user may need in their own forms (e.g. leave type when requesting leave).
const PUBLIC_LOOKUPS = new Set(['leave_types', 'departments', 'positions', 'shifts', 'companies', 'branches', 'courses', 'skills', 'competencies', 'performance_cycles', 'training', 'surveys']);

export const lookupRoutes = new Hono<AppEnv>();
lookupRoutes.use('*', requireAuth);

lookupRoutes.get('/:key', async (c) => {
  const user = currentUser(c);
  const key = c.req.param('key');
  if (key === 'roles') {
    if (!isSuperAdmin(user.roles) && !can(user, 'workflow_definitions.view')) throw forbidden();
    const { results } = await c.env.DB.prepare('SELECT id, code, name FROM roles ORDER BY id').all<{ id: number; code: string; name: string }>();
    return c.json<LookupOption[]>(results.map((r) => ({ value: r.id, label: `${r.name} (${r.code})`, code: r.code, parentId: null, depth: 0 })));
  }
  const m = moduleOr404(key);
  if (!modulePerms(user, m).view && !PUBLIC_LOOKUPS.has(m.key)) throw forbidden(`ต้องมีสิทธิ์ ${m.key}.view`);
  const scope = PUBLIC_LOOKUPS.has(m.key) ? { sql: '1', params: [] } : scopeSql(user, m);
  const activeOnly = m.fields.some((f) => f.name === 'active') && c.req.query('all') !== '1' ? 'AND t.active = 1' : '';
  const code = m.codeField ? `t.${m.codeField}` : 'NULL';
  const parent = m.tree ? `t.${m.tree.parentField}` : 'NULL';
  const { results } = await c.env.DB.prepare(
    `SELECT t.id AS value, COALESCE(NULLIF(TRIM(${m.labelExpr}), ''), '#' || t.id) AS label, ${code} AS code, ${parent} AS parentId
     FROM ${m.table} t WHERE ${scope.sql} ${activeOnly} ORDER BY ${m.codeField ? `t.${m.codeField}` : 't.id'} LIMIT 2000`,
  )
    .bind(...scope.params)
    .all<{ value: number; label: string; code: string | null; parentId: number | null }>();
  return c.json<LookupOption[]>(m.tree ? treeOrder(results) : results.map((r) => ({ ...r, label: String(r.label), depth: 0 })));
});

/** Depth-first ordering with depth, so hierarchical dropdowns render parents before children. */
export function treeOrder(rows: Array<{ value: number; label: string; code: string | null; parentId: number | null }>): LookupOption[] {
  const ids = new Set(rows.map((r) => r.value));
  const children = new Map<number | null, typeof rows>();
  for (const r of rows) {
    const p = r.parentId !== null && ids.has(r.parentId) ? r.parentId : null;
    children.set(p, [...(children.get(p) ?? []), r]);
  }
  const out: LookupOption[] = [];
  const seen = new Set<number>();
  const walk = (parent: number | null, depth: number) => {
    for (const r of children.get(parent) ?? []) {
      if (seen.has(r.value)) continue;
      seen.add(r.value);
      out.push({ value: r.value, label: String(r.label), code: r.code, parentId: r.parentId, depth });
      walk(r.value, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

