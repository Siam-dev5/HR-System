// Leave (/api/leave-imports) and overtime (/api/overtime-imports) imports from Feishu approval exports: preview with
// row-by-row validation, confirmed import (every row kept with its result in leave_import_records /
// overtime_import_records, one imported record per company and Request ID (+ detail)), history and the error report.
// The browser sends one worksheet as a cell grid; every check runs again on confirmation.
//
// Nothing here writes leave_requests, overtime_requests, attendance or payroll: approval statuses are stored as read
// (a pending request stays pending) and no OT pay is calculated.
import { Hono, type Context } from 'hono';
import type { AppEnv, AuthUser } from '../env';
import type { CompanyOption } from '../../shared/types';
import { currentUser, requireAuth, requirePerm } from '../auth';
import { audit } from '../lib/audit';
import { companyScope, requireCompany } from '../lib/companies';
import { badRequest, conflict, csv, intParam, notFound, readJson, safeName, str } from '../lib/http';
import { CLOCK_FILE_TYPES, MAX_CLOCK_FILE_BYTES, MAX_CLOCK_ROWS, type ClockFileType } from '../../shared/clock-import';
import {
  APPROVAL_LABEL, REQUEST_FIELDS, REQUEST_TEMPLATES, autoRequestMapping, detectRequestSheet, parseRequestRows, requestHeaders, requestMappingProblems, requestRowStatus,
  type RequestImportType, type RequestIssue, type RequestMapping, type RequestRow, type RequestRowStatus,
} from '../../shared/feishu-requests';
import { detectSheet, wrongSheetMessage } from '../../shared/import-templates';
import { writeXlsx, type Cell } from '../../shared/xlsx';

const MAX_COLS = 120;
const MAX_CELL = 2000;
const KEY_RE = /^[A-Za-z0-9-]{8,64}$/;
const CHUNK = 100;
const chunks = <T>(a: readonly T[]): T[][] => Array.from({ length: Math.ceil(a.length / CHUNK) }, (_, i) => a.slice(i * CHUNK, (i + 1) * CHUNK));

async function sha256Hex(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Domain {
  type: RequestImportType;
  table: 'leave_import_records' | 'overtime_import_records';
  view: string;
  importPerm: string;
  /** audit action prefix */
  action: string;
  label: string;
}
const DOMAINS: Record<RequestImportType, Domain> = {
  leave: { type: 'leave', table: 'leave_import_records', view: 'leave_import.view', importPerm: 'leave_import.import', action: 'leave_import', label: 'ข้อมูลการลา' },
  overtime: { type: 'overtime', table: 'overtime_import_records', view: 'overtime_import.view', importPerm: 'overtime_import.import', action: 'overtime_import', label: 'ข้อมูล OT' },
};

interface FileInput {
  company: CompanyOption;
  fileName: string;
  fileType: ClockFileType;
  fileSize: number | null;
  sha256: string;
  sheetName: string | null;
  grid: Cell[][];
  headerRow: number | null;
  mapping: RequestMapping | null;
}

function readGrid(v: unknown): Cell[][] {
  if (!Array.isArray(v)) throw badRequest('ไม่พบข้อมูลในไฟล์');
  if (v.length > MAX_CLOCK_ROWS + 25) throw badRequest(`ไฟล์มีมากกว่า ${MAX_CLOCK_ROWS.toLocaleString()} แถว กรุณาแบ่งไฟล์`);
  return v.map((row) => {
    if (!Array.isArray(row)) throw badRequest('รูปแบบข้อมูลในไฟล์ไม่ถูกต้อง');
    return row.slice(0, MAX_COLS).map((cell) => {
      if (cell === null || typeof cell === 'boolean') return cell;
      if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null;
      if (typeof cell === 'string') return cell.slice(0, MAX_CELL);
      throw badRequest('รูปแบบข้อมูลในไฟล์ไม่ถูกต้อง');
    });
  });
}

function readMapping(d: Domain, v: unknown): RequestMapping | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest('การจับคู่คอลัมน์ไม่ถูกต้อง');
  const out: RequestMapping = {};
  for (const f of REQUEST_FIELDS[d.type]) {
    const col = (v as Record<string, unknown>)[f.key];
    if (col === null || col === undefined || col === '') continue;
    if (!Number.isInteger(col) || (col as number) < 0 || (col as number) >= MAX_COLS) throw badRequest(`คอลัมน์ของ ${f.label} ไม่ถูกต้อง`);
    out[f.key] = col as number;
  }
  return out;
}

async function readInput(c: Context<AppEnv>, d: Domain, body: Record<string, unknown>): Promise<FileInput> {
  const company = await requireCompany(c.env.DB, currentUser(c), body.company_id === undefined || body.company_id === null ? undefined : String(body.company_id));
  if (!company) throw badRequest('กรุณาเลือกบริษัท');
  const fileName = str(body, 'file_name', { required: true, max: 200 }) as string;
  const fileType = body.file_type;
  if (!CLOCK_FILE_TYPES.includes(fileType as ClockFileType)) throw badRequest('รองรับเฉพาะไฟล์ .xlsx .xls และ .csv');
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext !== fileType) throw badRequest('นามสกุลไฟล์ไม่ตรงกับชนิดไฟล์');
  const size = body.file_size === undefined || body.file_size === null ? null : Number(body.file_size);
  if (size !== null && (!Number.isInteger(size) || size < 0 || size > MAX_CLOCK_FILE_BYTES)) throw badRequest('ไฟล์ใหญ่เกิน 15 MB');
  const sha = str(body, 'sha256', { required: true, max: 64 }) as string;
  if (!/^[0-9a-f]{64}$/.test(sha)) throw badRequest('sha256 ไม่ถูกต้อง');
  const headerRow = body.header_row === undefined || body.header_row === null ? null : Number(body.header_row);
  if (headerRow !== null && (!Number.isInteger(headerRow) || headerRow < 0 || headerRow > 50)) throw badRequest('แถวหัวตารางไม่ถูกต้อง');
  const sheetName = str(body, 'sheet_name', { max: 100 });
  const grid = readGrid(body.grid);
  // one worksheet of this data domain only
  const wrong = wrongSheetMessage(d.type, detectSheet(grid), sheetName);
  if (wrong) throw badRequest(wrong);
  return { company, fileName, fileType: fileType as ClockFileType, fileSize: size, sha256: sha, sheetName, grid, headerRow, mapping: readMapping(d, body.mapping) };
}

export interface EvaluatedRequestRow extends RequestRow {
  employee_id: number | null;
  employee_display: string | null;
  status: RequestRowStatus;
}
interface Evaluation {
  headerRow: number;
  headers: string[];
  signature: string;
  mapping: RequestMapping;
  remembered: boolean;
  mappingProblems: string[];
  rows: EvaluatedRequestRow[];
  previous: Array<{ id: number; created_at: string; file_name: string }>;
}

const issue = (code: RequestIssue['code'], level: RequestIssue['level'], message: string): RequestIssue => ({ code, level, message });

async function evaluate(db: D1Database, d: Domain, user: AuthUser, input: FileInput): Promise<Evaluation> {
  const detected = detectRequestSheet(input.grid);
  const headerRow = input.headerRow ?? (detected.headerRow >= 0 ? detected.headerRow : 0);
  const headers = requestHeaders(input.grid, headerRow);
  const signature = await sha256Hex(headers.join('|'));
  const template = REQUEST_TEMPLATES[d.type];
  const saved = await db
    .prepare('SELECT mapping_json FROM import_mapping_templates WHERE company_id = ? AND import_type = ? AND template_code = ? AND header_signature = ?')
    .bind(input.company.id, d.type, template, signature)
    .first<{ mapping_json: string }>();
  const remembered = saved ? (JSON.parse(saved.mapping_json) as RequestMapping) : null;
  const mapping = input.mapping ?? autoRequestMapping(d.type, headers, remembered);
  const mappingProblems = requestMappingProblems(d.type, mapping, headers.length);
  const { results: previous } = await db
    .prepare("SELECT id, created_at, file_name FROM request_import_batches WHERE import_type = ? AND company_id = ? AND file_sha256 = ? AND COALESCE(sheet_name, '') = COALESCE(?, '') ORDER BY id DESC LIMIT 5")
    .bind(d.type, input.company.id, input.sha256, input.sheetName)
    .all<{ id: number; created_at: string; file_name: string }>();
  const base = { headerRow, headers, signature, mapping, remembered: !!remembered && !input.mapping, mappingProblems, previous };
  if (mappingProblems.length) return { ...base, rows: [] };
  const parsed = parseRequestRows(d.type, input.grid, headerRow, mapping);
  if (parsed.length > MAX_CLOCK_ROWS) throw badRequest(`ไฟล์มีมากกว่า ${MAX_CLOCK_ROWS.toLocaleString()} แถว กรุณาแบ่งไฟล์`);

  const scope = await companyScope(db, user);
  const codes = [...new Set(parsed.map((r) => r.employee_code?.toUpperCase()).filter((x): x is string => !!x))];
  const { results: emps } = codes.length
    ? await db
        .prepare("SELECT id, emp_code, first_name || ' ' || last_name AS name, company_id, hire_date, termination_date FROM employees WHERE upper(emp_code) IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(codes))
        .all<{ id: number; emp_code: string; name: string; company_id: number; hire_date: string | null; termination_date: string | null }>()
    : { results: [] };
  const byCode = new Map(emps.map((e) => [e.emp_code.toUpperCase(), e]));
  const requestNos = [...new Set(parsed.map((r) => r.request_no).filter((x): x is string => !!x))];
  const { results: existing } = requestNos.length
    ? await db
        .prepare(`SELECT request_no, ${d.type === 'overtime' ? 'detail_no' : '1 AS detail_no'}, approval_status FROM ${d.table} WHERE company_id = ?1 AND status IN ('valid', 'warning') AND request_no IN (SELECT value FROM json_each(?2))`)
        .bind(input.company.id, JSON.stringify(requestNos))
        .all<{ request_no: string; detail_no: number; approval_status: string | null }>()
    : { results: [] };
  const done = new Map(existing.map((x) => [`${x.request_no}#${x.detail_no}`, x.approval_status]));

  const rows = parsed.map((p): EvaluatedRequestRow => {
    const issues = [...p.issues];
    const out: EvaluatedRequestRow = { ...p, issues, employee_id: null, employee_display: null, status: 'valid' };
    const emp = p.employee_code ? byCode.get(p.employee_code.toUpperCase()) : undefined;
    if (p.employee_code && !emp) issues.push(issue('unknown_employee', 'error', `ไม่พบพนักงานรหัส ${p.employee_code}`));
    else if (emp && emp.company_id !== input.company.id) {
      // never matched by name or by a code of another company; a user limited to their company does not learn it exists
      const visible = scope.scope === 'all' || scope.items.some((x) => x.id === emp.company_id);
      issues.push(visible ? issue('wrong_company', 'error', `พนักงานรหัส ${p.employee_code} ไม่ได้อยู่ในบริษัท ${input.company.name}`) : issue('unknown_employee', 'error', `ไม่พบพนักงานรหัส ${p.employee_code}`));
    } else if (emp) {
      out.employee_id = emp.id;
      out.employee_display = emp.name;
      const day = d.type === 'leave' ? p.start_date : p.work_date;
      if (day && ((emp.hire_date && day < emp.hire_date) || (emp.termination_date && day > emp.termination_date))) issues.push(issue('not_employed', 'warning', 'วันที่อยู่นอกช่วงการจ้างงานของพนักงาน'));
    }
    const k = `${p.request_no}#${p.detail_no}`;
    if (p.request_no && !issues.some((i) => i.level === 'error' || i.code === 'duplicate_in_file') && done.has(k)) {
      const before = done.get(k);
      issues.push(issue('duplicate_existing', 'info', `เลขที่คำขอ ${p.request_no}${d.type === 'overtime' ? ` รายการย่อย ${p.detail_no}` : ''} นำเข้าไว้แล้ว${before && before !== p.approval_status ? ` (สถานะเดิม: ${APPROVAL_LABEL[before as keyof typeof APPROVAL_LABEL] ?? before} — ไม่เปลี่ยนแปลง)` : ''}`));
    }
    out.status = requestRowStatus(issues);
    return out;
  });
  return { ...base, rows };
}

function summarize(rows: readonly EvaluatedRequestRow[]) {
  const n = (s: RequestRowStatus) => rows.filter((r) => r.status === s).length;
  const valid = n('valid');
  const warning = n('warning');
  const ok = rows.filter((r) => r.status === 'valid' || r.status === 'warning');
  const by = (s: string) => ok.filter((r) => r.approval_status === s).length;
  return {
    total: rows.length, valid, warning, duplicate: n('duplicate'), invalid: n('invalid'), importable: valid + warning,
    approval: { approved: by('approved'), pending: by('pending'), rejected: by('rejected'), cancelled: by('cancelled') },
  };
}

const publicRow = (r: EvaluatedRequestRow) => ({
  row_no: r.row_no, request_no: r.request_no, detail_no: r.detail_no, employee_code: r.employee_code, employee_id: r.employee_id, employee_name: r.employee_display ?? r.employee_name,
  department: r.department, approval_status: r.approval_status, status_text: r.status_text, approver: r.approver, type_label: r.type_label, start_at: r.start_at, end_at: r.end_at,
  amount: r.amount, unit: r.unit, work_date: r.work_date, detail_hours: r.detail_hours, overnight: r.overnight, submitted_at: r.submitted_at, reason: r.reason,
  status: r.status, issues: r.issues,
});

const BATCH_SELECT = `SELECT b.id, b.import_type, b.company_id, c.name AS company, c.code AS company_code, b.template_code, b.template_version, b.file_name, b.file_type, b.file_size, b.sheet_name,
  b.total_rows, b.imported_count, b.duplicate_count, b.warning_count, b.invalid_count, b.status, b.created_at, b.created_by, u.username AS created_by_name
  FROM request_import_batches b JOIN companies c ON c.id = b.company_id LEFT JOIN users u ON u.id = b.created_by`;

interface BatchRow {
  id: number;
  company_id: number;
  [k: string]: unknown;
}

function recordStatements(db: D1Database, d: Domain, key: string, batchId: string, input: FileInput, rows: readonly EvaluatedRequestRow[]): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  // a row another import saved in the meantime becomes a duplicate (the unique index allows one imported row)
  const dupIssue = `json_insert(json_extract(value, '$.is'), '$[#]', json('{"code":"duplicate_existing","level":"info","message":"นำเข้าไว้แล้วโดยการนำเข้าอื่น"}'))`;
  const taken = d.type === 'overtime'
    ? `EXISTS (SELECT 1 FROM overtime_import_records x WHERE x.company_id = ?3 AND x.request_no = json_extract(value, '$.no') AND x.detail_no = json_extract(value, '$.dn') AND x.status IN ('valid', 'warning'))`
    : `EXISTS (SELECT 1 FROM leave_import_records x WHERE x.company_id = ?3 AND x.request_no = json_extract(value, '$.no') AND x.status IN ('valid', 'warning'))`;
  const ok = `json_extract(value, '$.st') IN ('valid', 'warning')`;
  for (const part of chunks(rows)) {
    const json = JSON.stringify(part.map((r) => ({
      r: r.row_no, no: r.request_no, dn: r.detail_no, c: r.employee_code, e: r.employee_id, n: r.employee_name, dep: r.department, t: r.type_label, s: r.start_at, en: r.end_at,
      sd: r.start_date, ed: r.end_date, a: r.amount, u: r.unit, wd: r.work_date, dh: r.detail_hours, on: r.overnight ? 1 : 0, dt: r.date_type, ap: r.approval_status, sx: r.status_text,
      apr: r.approver, rs: r.reason, sub: r.submitted_at, com: r.completed_at, raw: JSON.stringify(r.raw), st: r.status, is: JSON.stringify(r.issues),
    })));
    const status = `CASE WHEN ${ok} AND ${taken} THEN 'duplicate' ELSE json_extract(value, '$.st') END`;
    const issues = `CASE WHEN ${ok} AND ${taken} THEN ${dupIssue} ELSE json_extract(value, '$.is') END`;
    stmts.push(d.type === 'leave'
      ? db.prepare(`INSERT INTO leave_import_records (batch_id, row_no, company_id, request_no, employee_code, employee_id, employee_name, department, leave_type, start_at, end_at, start_date, end_date,
            duration, duration_unit, approval_status, status_text, approver, reason, submitted_at, completed_at, raw_json, status, issues_json)
          SELECT ${batchId}, json_extract(value, '$.r'), ?3, json_extract(value, '$.no'), json_extract(value, '$.c'), json_extract(value, '$.e'), json_extract(value, '$.n'), json_extract(value, '$.dep'),
            json_extract(value, '$.t'), json_extract(value, '$.s'), json_extract(value, '$.en'), json_extract(value, '$.sd'), json_extract(value, '$.ed'), json_extract(value, '$.a'), json_extract(value, '$.u'),
            json_extract(value, '$.ap'), json_extract(value, '$.sx'), json_extract(value, '$.apr'), json_extract(value, '$.rs'), json_extract(value, '$.sub'), json_extract(value, '$.com'), json_extract(value, '$.raw'),
            ${status}, ${issues}
          FROM json_each(?2)`).bind(key, json, input.company.id)
      : db.prepare(`INSERT INTO overtime_import_records (batch_id, row_no, company_id, request_no, detail_no, employee_code, employee_id, employee_name, department, work_date, ot_start_at, ot_end_at,
            request_hours, detail_hours, duration_unit, overnight, ot_type, date_type, approval_status, status_text, approver, reason, submitted_at, completed_at, raw_json, status, issues_json)
          SELECT ${batchId}, json_extract(value, '$.r'), ?3, json_extract(value, '$.no'), json_extract(value, '$.dn'), json_extract(value, '$.c'), json_extract(value, '$.e'), json_extract(value, '$.n'), json_extract(value, '$.dep'),
            json_extract(value, '$.wd'), json_extract(value, '$.s'), json_extract(value, '$.en'), json_extract(value, '$.a'), json_extract(value, '$.dh'), json_extract(value, '$.u'), json_extract(value, '$.on'),
            json_extract(value, '$.t'), json_extract(value, '$.dt'), json_extract(value, '$.ap'), json_extract(value, '$.sx'), json_extract(value, '$.apr'), json_extract(value, '$.rs'), json_extract(value, '$.sub'),
            json_extract(value, '$.com'), json_extract(value, '$.raw'), ${status}, ${issues}
          FROM json_each(?2)`).bind(key, json, input.company.id));
  }
  stmts.push(db.prepare(`UPDATE request_import_batches SET
      imported_count = (SELECT COUNT(*) FROM ${d.table} WHERE batch_id = request_import_batches.id AND status IN ('valid', 'warning')),
      warning_count = (SELECT COUNT(*) FROM ${d.table} WHERE batch_id = request_import_batches.id AND status = 'warning'),
      duplicate_count = (SELECT COUNT(*) FROM ${d.table} WHERE batch_id = request_import_batches.id AND status = 'duplicate'),
      invalid_count = (SELECT COUNT(*) FROM ${d.table} WHERE batch_id = request_import_batches.id AND status = 'invalid')
    WHERE idempotency_key = ?1`).bind(key));
  stmts.push(db.prepare(`UPDATE request_import_batches SET status = CASE WHEN imported_count = 0 THEN 'failed' WHEN imported_count = total_rows THEN 'completed' ELSE 'partial' END WHERE idempotency_key = ?1`).bind(key));
  return stmts;
}

export function requestImportRoutes(type: RequestImportType): Hono<AppEnv> {
  const d = DOMAINS[type];
  const template = REQUEST_TEMPLATES[type];
  const fields = REQUEST_FIELDS[type].map(({ key, label, required }) => ({ key, label, required }));
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  app.get('/fields', requirePerm(d.importPerm), (c) =>
    c.json({ import_type: type, template: { code: template, version: 1 }, fields, file_types: CLOCK_FILE_TYPES, max_rows: MAX_CLOCK_ROWS, max_bytes: MAX_CLOCK_FILE_BYTES }));

  app.post('/preview', requirePerm(d.importPerm), async (c) => {
    const input = await readInput(c, d, await readJson(c));
    const ev = await evaluate(c.env.DB, d, currentUser(c), input);
    return c.json({
      import_type: type, template, sheet_name: input.sheetName, company: input.company, header_row: ev.headerRow, headers: ev.headers, mapping: ev.mapping, remembered: ev.remembered,
      mapping_problems: ev.mappingProblems, fields, previous: ev.previous, summary: summarize(ev.rows), rows: ev.rows.map(publicRow),
    });
  });

  app.post('/', requirePerm(d.importPerm), async (c) => {
    const user = currentUser(c);
    const db = c.env.DB;
    const body = await readJson(c);
    if (body.confirm !== true) throw badRequest('กรุณายืนยันการนำเข้า');
    const key = str(body, 'idempotency_key', { required: true, max: 64 }) as string;
    if (!KEY_RE.test(key)) throw badRequest('idempotency_key ไม่ถูกต้อง');
    const again = await db.prepare(`${BATCH_SELECT} WHERE b.idempotency_key = ?`).bind(key).first<BatchRow>();
    if (again) {
      if (again.created_by !== user.id || again.import_type !== type) throw conflict('รหัสการนำเข้านี้ถูกใช้แล้ว');
      return c.json({ ...again, repeated: true });
    }
    const input = await readInput(c, d, body);
    const ev = await evaluate(db, d, user, input);
    if (ev.mappingProblems.length) throw badRequest(ev.mappingProblems.join(' · '));
    if (!ev.rows.length) throw badRequest('ไม่พบแถวข้อมูลในไฟล์');
    const s = summarize(ev.rows);
    const batchId = `(SELECT id FROM request_import_batches WHERE idempotency_key = ?1)`;
    const stmts: D1PreparedStatement[] = [
      db.prepare(`INSERT INTO request_import_batches (import_type, company_id, template_code, template_version, file_name, file_type, file_sha256, file_size, sheet_name, idempotency_key, mapping_json, total_rows, status, created_by)
                  VALUES (?2, ?3, ?4, 1, ?5, ?6, ?7, ?8, ?9, ?1, ?10, ?11, 'failed', ?12)`)
        .bind(key, type, input.company.id, template, input.fileName, input.fileType, input.sha256, input.fileSize, input.sheetName, JSON.stringify(ev.mapping), ev.rows.length, user.id),
      ...recordStatements(db, d, key, batchId, input, ev.rows),
      db.prepare(`INSERT INTO import_mapping_templates (company_id, import_type, template_code, template_version, header_signature, mapping_json, updated_by) VALUES (?1, ?2, ?3, 1, ?4, ?5, ?6)
        ON CONFLICT (company_id, import_type, template_code, header_signature) DO UPDATE SET mapping_json = excluded.mapping_json, updated_at = datetime('now'), updated_by = excluded.updated_by`)
        .bind(input.company.id, type, template, ev.signature, JSON.stringify(ev.mapping), user.id),
    ];
    try {
      await db.batch(stmts);
    } catch (e) {
      if (String(e).includes('UNIQUE') && String(e).includes('idempotency_key')) {
        const row = await db.prepare(`${BATCH_SELECT} WHERE b.idempotency_key = ?`).bind(key).first<BatchRow>();
        if (row) return c.json({ ...row, repeated: true });
      }
      throw e;
    }
    const batch = await db.prepare(`${BATCH_SELECT} WHERE b.idempotency_key = ?`).bind(key).first<BatchRow>();
    if (!batch) throw new Error('import batch missing after commit');
    await audit(c, `${d.action}.imported`, 'request_import_batches', batch.id, {
      import_type: type, template, company_id: input.company.id, file_name: input.fileName, sheet_name: input.sheetName, file_type: input.fileType,
      total: s.total, imported: batch.imported_count, duplicate: batch.duplicate_count, invalid: batch.invalid_count, warning: batch.warning_count, approval: s.approval,
    });
    return c.json({ ...batch, repeated: false }, 201);
  });

  async function visibleBatch(c: Context<AppEnv>, id: number): Promise<BatchRow> {
    const b = await c.env.DB.prepare(`${BATCH_SELECT} WHERE b.id = ? AND b.import_type = ?`).bind(id, type).first<BatchRow>();
    if (!b) throw notFound('ไม่พบประวัติการนำเข้า');
    const scope = await companyScope(c.env.DB, currentUser(c));
    if (scope.scope !== 'all' && !scope.items.some((x) => x.id === b.company_id)) throw notFound('ไม่พบประวัติการนำเข้า');
    return b;
  }

  app.get('/', requirePerm(d.view), async (c) => {
    const user = currentUser(c);
    const scope = await companyScope(c.env.DB, user);
    const company = await requireCompany(c.env.DB, user, c.req.query('company'));
    if (scope.scope === 'none') return c.json([]);
    const ids = company ? [company.id] : scope.scope === 'all' ? null : scope.items.map((x) => x.id);
    const { results } = await c.env.DB
      .prepare(`${BATCH_SELECT} WHERE b.import_type = ?2 AND (?1 IS NULL OR b.company_id IN (SELECT value FROM json_each(?1))) ORDER BY b.id DESC LIMIT 200`)
      .bind(ids ? JSON.stringify(ids) : null, type)
      .all();
    return c.json(results);
  });

  const rowSelect = type === 'leave'
    ? `SELECT r.row_no, r.request_no, 1 AS detail_no, r.employee_code, r.employee_id, COALESCE(e.first_name || ' ' || e.last_name, r.employee_name) AS employee_name, r.leave_type AS type_label,
         r.start_at, r.end_at, r.duration AS amount, r.duration_unit AS unit, NULL AS work_date, NULL AS detail_hours, 0 AS overnight, r.approval_status, r.status_text, r.approver, r.status, r.issues_json
       FROM leave_import_records r LEFT JOIN employees e ON e.id = r.employee_id`
    : `SELECT r.row_no, r.request_no, r.detail_no, r.employee_code, r.employee_id, COALESCE(e.first_name || ' ' || e.last_name, r.employee_name) AS employee_name, r.ot_type AS type_label,
         r.ot_start_at AS start_at, r.ot_end_at AS end_at, r.request_hours AS amount, r.duration_unit AS unit, r.work_date, r.detail_hours, r.overnight, r.approval_status, r.status_text, r.approver, r.status, r.issues_json
       FROM overtime_import_records r LEFT JOIN employees e ON e.id = r.employee_id`;

  app.get('/:id', requirePerm(d.view), async (c) => {
    const b = await visibleBatch(c, intParam(c.req.param('id')));
    const { results } = await c.env.DB.prepare(`${rowSelect} WHERE r.batch_id = ? ORDER BY r.row_no`).bind(b.id).all<Record<string, unknown>>();
    return c.json({ ...b, rows: results.map(({ issues_json, ...r }) => ({ ...r, issues: JSON.parse(String(issues_json)) })) });
  });

  /** Rows that were not imported cleanly (invalid, duplicate, warning) with their reasons, as CSV or XLSX. */
  app.get('/:id/report', requirePerm(d.view), async (c) => {
    const b = await visibleBatch(c, intParam(c.req.param('id')));
    const format = c.req.query('format') === 'xlsx' ? 'xlsx' : 'csv';
    const { results } = await c.env.DB.prepare(`${rowSelect} WHERE r.batch_id = ? AND r.status <> 'valid' ORDER BY r.row_no`).bind(b.id).all<Record<string, unknown>>();
    const label: Record<string, string> = { valid: 'ผ่าน', warning: 'ผ่าน (มีคำเตือน)', duplicate: 'ซ้ำ (ไม่นำเข้า)', invalid: 'ไม่ถูกต้อง (ไม่นำเข้า)' };
    const head = type === 'leave'
      ? ['แถวในไฟล์', 'เลขที่คำขอ', 'รหัสพนักงาน', 'ประเภทการลา', 'เริ่ม', 'สิ้นสุด', 'จำนวน', 'หน่วย', 'สถานะการอนุมัติ', 'ผลการตรวจสอบ', 'รายละเอียด']
      : ['แถวในไฟล์', 'เลขที่คำขอ', 'รายการย่อย', 'รหัสพนักงาน', 'วันที่ทำ OT', 'เริ่ม', 'สิ้นสุด', 'ชั่วโมงของคำขอ', 'ชั่วโมงของวัน', 'สถานะการอนุมัติ', 'ผลการตรวจสอบ', 'รายละเอียด'];
    const reasons = (r: Record<string, unknown>) => (JSON.parse(String(r.issues_json)) as RequestIssue[]).map((i) => i.message).join('; ');
    const appr = (r: Record<string, unknown>) => (r.approval_status ? APPROVAL_LABEL[r.approval_status as keyof typeof APPROVAL_LABEL] : ((r.status_text as string) ?? ''));
    const body = results.map((r) => type === 'leave'
      ? [r.row_no as number, (r.request_no as string) ?? '', (r.employee_code as string) ?? '', (r.type_label as string) ?? '', (r.start_at as string) ?? '', (r.end_at as string) ?? '',
          (r.amount as number) ?? '', (r.unit as string) ?? '', appr(r), label[String(r.status)] ?? String(r.status), reasons(r)]
      : [r.row_no as number, (r.request_no as string) ?? '', r.detail_no as number, (r.employee_code as string) ?? '', (r.work_date as string) ?? '', (r.start_at as string) ?? '', (r.end_at as string) ?? '',
          (r.amount as number) ?? '', (r.detail_hours as number) ?? '', appr(r), label[String(r.status)] ?? String(r.status), reasons(r)]) as Array<Array<string | number>>;
    const name = safeName(`${type}-import-${b.id}-errors`);
    await audit(c, `${d.action}.report_downloaded`, 'request_import_batches', b.id, { format, rows: body.length });
    if (format === 'csv') return c.body(csv([head, ...body]), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"`, 'cache-control': 'no-store' });
    return c.body(writeXlsx('Errors', [head, ...body] as Cell[][]) as unknown as ArrayBuffer, 200, {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': `attachment; filename="${name}.xlsx"`,
      'cache-control': 'no-store',
    });
  });

  return app;
}
