// Time-clock file import (XLSX / XLS / CSV): preview with row-by-row validation, confirmed import (raw rows kept as
// read in attendance_raw_records, valid rows added to attendance_records — never overwriting an existing day),
// import history and the error report. The browser parses the file into a cell grid; every check runs again here
// on confirmation, nothing from the preview is trusted. Payroll is not touched.
import { Hono, type Context } from 'hono';
import type { AppEnv, AuthUser } from '../env';
import type { CompanyOption } from '../../shared/types';
import { currentUser, requireAuth, requirePerm } from '../auth';
import { audit } from '../lib/audit';
import { companyScope, requireCompany } from '../lib/companies';
import { badRequest, conflict, csv, intParam, notFound, readJson, safeName, str } from '../lib/http';
import { loadSettings, settingText } from '../lib/settings';
import { bangkokNow } from '../lib/time';
import { lockedPeriods, resolveDays, shiftTimes } from '../lib/shift-resolver';
import { applicable } from './holidays';
import {
  CLOCK_FIELDS, CLOCK_FILE_TYPES, MAX_CLOCK_FILE_BYTES, MAX_CLOCK_ROWS, autoClockMapping, findClockHeaderRow, headerLabels, layoutSignature, parseClockRows, rowStatus, validMapping,
  type ClockFileType, type ClockIssue, type ClockMapping, type ClockRowStatus, type ParsedClockRow,
} from '../../shared/clock-import';
import { CLOCK_WARNING_LABEL, checkClock, formatDuration } from '../../shared/shifts';
import { writeXlsx, type Cell } from '../../shared/xlsx';

export const attendanceFileRoutes = new Hono<AppEnv>();
attendanceFileRoutes.use('*', requireAuth);

const MAX_COLS = 60;
const MAX_CELL = 2000;
const KEY_RE = /^[A-Za-z0-9-]{8,64}$/;

async function sha256Hex(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface FileInput {
  company: CompanyOption;
  fileName: string;
  fileType: ClockFileType;
  fileSize: number | null;
  sha256: string;
  sheetName: string | null;
  source: string | null;
  grid: Cell[][];
  headerRow: number | null;
  mapping: ClockMapping | null;
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

function readMapping(v: unknown): ClockMapping | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest('การจับคู่คอลัมน์ไม่ถูกต้อง');
  const out: ClockMapping = {};
  for (const f of CLOCK_FIELDS) {
    const col = (v as Record<string, unknown>)[f.key];
    if (col === null || col === undefined || col === '') continue;
    if (!Number.isInteger(col) || (col as number) < 0 || (col as number) >= MAX_COLS) throw badRequest(`คอลัมน์ของ ${f.label} ไม่ถูกต้อง`);
    out[f.key] = col as number;
  }
  return out;
}

async function readInput(c: Context<AppEnv>, body: Record<string, unknown>): Promise<FileInput> {
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
  return {
    company, fileName, fileType: fileType as ClockFileType, fileSize: size, sha256: sha,
    sheetName: str(body, 'sheet_name', { max: 100 }), source: str(body, 'source', { max: 100 }),
    grid: readGrid(body.grid), headerRow, mapping: readMapping(body.mapping),
  };
}

export interface EvaluatedRow extends ParsedClockRow {
  employee_id: number | null;
  employee_name: string | null;
  status: ClockRowStatus;
  attendance_status: 'present' | 'late' | null;
  shift_id: number | null;
  shift_label: string | null;
  late_minutes: number | null;
  early_leave_minutes: number | null;
  worked_minutes: number | null;
}

interface Evaluation {
  headerRow: number;
  headers: string[];
  signature: string;
  mapping: ClockMapping;
  remembered: boolean;
  mappingProblems: string[];
  rows: EvaluatedRow[];
  previous: Array<{ id: number; created_at: string; file_name: string }>;
}

const issue = (code: ClockIssue['code'], level: ClockIssue['level'], message: string): ClockIssue => ({ code, level, message });

async function evaluate(db: D1Database, user: AuthUser, input: FileInput): Promise<Evaluation> {
  const headerRow = input.headerRow ?? findClockHeaderRow(input.grid);
  const headers = headerLabels(input.grid, headerRow);
  const signature = await sha256Hex(layoutSignature(headers));
  const saved = await db.prepare('SELECT mapping_json FROM attendance_file_mappings WHERE company_id = ? AND header_signature = ?').bind(input.company.id, signature).first<{ mapping_json: string }>();
  const remembered = saved ? (JSON.parse(saved.mapping_json) as ClockMapping) : null;
  const mapping = input.mapping ?? autoClockMapping(headers, remembered);
  const mappingProblems = validMapping(mapping, headers.length);
  const { results: previous } = await db
    .prepare('SELECT id, created_at, file_name FROM attendance_file_imports WHERE company_id = ? AND file_sha256 = ? ORDER BY id DESC LIMIT 5')
    .bind(input.company.id, input.sha256)
    .all<{ id: number; created_at: string; file_name: string }>();
  const base = { headerRow, headers, signature, mapping, remembered: !!remembered && !input.mapping, mappingProblems, previous };
  if (mappingProblems.length) return { ...base, rows: [] };
  const parsed = parseClockRows(input.grid, headerRow, mapping);
  if (parsed.length > MAX_CLOCK_ROWS) throw badRequest(`ไฟล์มีมากกว่า ${MAX_CLOCK_ROWS.toLocaleString()} แถว กรุณาแบ่งไฟล์`);

  const scope = await companyScope(db, user);
  const today = bangkokNow().date;
  const codes = [...new Set(parsed.map((r) => r.employee_code?.toUpperCase()).filter((x): x is string => !!x))];
  const { results: emps } = codes.length
    ? await db
        .prepare("SELECT id, emp_code, first_name || ' ' || last_name AS name, company_id, hire_date, termination_date FROM employees WHERE upper(emp_code) IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(codes))
        .all<{ id: number; emp_code: string; name: string; company_id: number; hire_date: string | null; termination_date: string | null }>()
    : { results: [] };
  const byCode = new Map(emps.map((e) => [e.emp_code.toUpperCase(), e]));
  const dates = parsed.map((r) => r.work_date).filter((d): d is string => !!d).sort();
  const from = dates[0] ?? today;
  const to = dates[dates.length - 1] ?? today;
  const mine = emps.filter((e) => e.company_id === input.company.id).map((e) => e.id);
  const [locked, existing, resolved, holidays, leaves, settings] = await Promise.all([
    lockedPeriods(db, input.company.id, from, to),
    mine.length
      ? db.prepare('SELECT employee_id, work_date FROM attendance_records WHERE employee_id IN (SELECT value FROM json_each(?1)) AND work_date BETWEEN ?2 AND ?3').bind(JSON.stringify(mine), from, to).all<{ employee_id: number; work_date: string }>()
      : Promise.resolve({ results: [] as Array<{ employee_id: number; work_date: string }> }),
    resolveDays(db, mine, from, to > today ? today : to),
    applicable(db, input.company.id, from, to),
    mine.length
      ? db.prepare("SELECT employee_id, start_date, end_date FROM leave_requests WHERE status = 'approved' AND employee_id IN (SELECT value FROM json_each(?1)) AND start_date <= ?3 AND end_date >= ?2").bind(JSON.stringify(mine), from, to).all<{ employee_id: number; start_date: string; end_date: string }>()
      : Promise.resolve({ results: [] as Array<{ employee_id: number; start_date: string; end_date: string }> }),
    loadSettings(db),
  ]);
  const defaultStart = settingText(settings, 'attendance.default_start_time', '09:00');
  const existingKeys = new Set(existing.results.map((r) => `${r.employee_id}|${r.work_date}`));
  const holidayAt = new Map(holidays.holidays.map((h) => [h.holiday_date, h.name]));
  const seen = new Set<string>();

  const rows = parsed.map((p): EvaluatedRow => {
    const issues = [...p.issues];
    const out: EvaluatedRow = { ...p, issues, employee_id: null, employee_name: null, status: 'valid', attendance_status: null, shift_id: null, shift_label: null, late_minutes: null, early_leave_minutes: null, worked_minutes: null };
    const emp = p.employee_code ? byCode.get(p.employee_code.toUpperCase()) : undefined;
    if (p.employee_code && !emp) issues.push(issue('unknown_employee', 'error', `ไม่พบพนักงานรหัส ${p.employee_code}`));
    else if (emp && emp.company_id !== input.company.id) {
      // a user limited to their own company does not learn that the code exists elsewhere
      const visible = scope.scope === 'all' || scope.items.some((x) => x.id === emp.company_id);
      issues.push(visible ? issue('wrong_company', 'error', `พนักงานรหัส ${p.employee_code} ไม่ได้อยู่ในบริษัท ${input.company.name}`) : issue('unknown_employee', 'error', `ไม่พบพนักงานรหัส ${p.employee_code}`));
    } else if (emp) {
      out.employee_id = emp.id;
      out.employee_name = emp.name;
    }
    const d = p.work_date;
    if (d && d > today) issues.push(issue('future_date', 'error', 'วันที่ทำงานเป็นวันในอนาคต'));
    if (d && out.employee_id && emp && ((emp.hire_date && d < emp.hire_date) || (emp.termination_date && d > emp.termination_date))) issues.push(issue('not_employed', 'error', 'วันที่อยู่นอกช่วงการจ้างงานของพนักงาน'));
    const lock = d ? locked.find((l) => l.start_date <= d && l.end_date >= d) : undefined;
    if (lock) issues.push(issue('period_locked', 'error', `วันที่อยู่ในงวดเงินเดือน ${lock.code} ที่คำนวณแล้ว (${lock.status}) ต้องเปิดแก้ไขงวดก่อน`));
    if (issues.some((i) => i.level === 'error') || !out.employee_id || !d || !p.clock_in) {
      out.status = rowStatus(issues);
      return out;
    }
    const key = `${out.employee_id}|${d}`;
    if (seen.has(key)) issues.push(issue('duplicate_in_file', 'info', 'ซ้ำกับแถวก่อนหน้าในไฟล์นี้ (พนักงานและวันที่เดียวกัน)'));
    else if (existingKeys.has(key)) issues.push(issue('duplicate_existing', 'info', 'มีบันทึกเวลาของพนักงานในวันนี้อยู่แล้ว (ไม่เขียนทับ)'));
    seen.add(key);
    const day = resolved.get(key);
    const shift = day?.kind === 'shift' && day.shift ? day.shift : null;
    const check = checkClock(shift ? shiftTimes(shift) : null, p.clock_in, p.clock_out, { outNextDay: p.out_next_day, defaultStart });
    if (check.error) issues.push(issue('out_before_in', 'error', 'เวลาออกงานห่างจากเวลาเข้างานเกิน 24 ชั่วโมง'));
    else {
      out.attendance_status = check.status;
      out.late_minutes = check.lateMinutes;
      out.early_leave_minutes = check.earlyLeaveMinutes;
      out.worked_minutes = check.workedMinutes;
      out.out_next_day = check.outNextDay;
      out.shift_id = shift?.id ?? null;
      out.shift_label = shift ? `${shift.name} ${shift.start_time}–${shift.end_time}` : null;
      for (const w of check.warnings) issues.push(issue(w, 'warning', CLOCK_WARNING_LABEL[w]));
      if (check.status === 'late') issues.push(issue('late', 'info', `มาสาย ${formatDuration(check.lateMinutes)}`));
      if (day?.kind === 'day_off') issues.push(issue('day_off', 'warning', 'ตามตารางกะเป็นวันหยุดของพนักงาน'));
      if (day?.kind === 'holiday' || holidayAt.has(d)) issues.push(issue('holiday', 'warning', `วันหยุด${holidayAt.has(d) ? ` (${holidayAt.get(d)})` : 'ตามตารางกะ'}`));
      if (!shift && day?.groupId && day.kind === 'none') issues.push(issue('no_shift', 'warning', 'ยังไม่ได้จัดกะของวันนี้ ใช้เวลาเข้างานเริ่มต้นของระบบ'));
      if (leaves.results.some((l) => l.employee_id === out.employee_id && l.start_date <= d && l.end_date >= d)) issues.push(issue('on_leave', 'warning', 'มีใบลาที่อนุมัติแล้วในวันนี้'));
    }
    out.status = rowStatus(issues);
    return out;
  });
  return { ...base, rows };
}

function summarize(rows: readonly EvaluatedRow[]) {
  const n = (s: ClockRowStatus) => rows.filter((r) => r.status === s).length;
  const valid = n('valid');
  const warning = n('warning');
  return { total: rows.length, valid, warning, duplicate: n('duplicate'), invalid: n('invalid'), importable: valid + warning };
}

const publicRow = (r: EvaluatedRow) => ({
  row_no: r.row_no, employee_code: r.employee_code, employee_id: r.employee_id, employee_name: r.employee_name, work_date: r.work_date, clock_in: r.clock_in, clock_out: r.clock_out,
  out_next_day: r.out_next_day, device: r.device, source: r.source, remark: r.remark, status: r.status, issues: r.issues, attendance_status: r.attendance_status,
  shift_label: r.shift_label, late_minutes: r.late_minutes, early_leave_minutes: r.early_leave_minutes, worked_minutes: r.worked_minutes,
});

/** Fields, accepted file types and limits of the import wizard. */
attendanceFileRoutes.get('/fields', requirePerm('attendance_file.import'), (c) =>
  c.json({ fields: CLOCK_FIELDS.map(({ key, label, required }) => ({ key, label, required })), file_types: CLOCK_FILE_TYPES, max_rows: MAX_CLOCK_ROWS, max_bytes: MAX_CLOCK_FILE_BYTES }));

attendanceFileRoutes.post('/preview', requirePerm('attendance_file.import'), async (c) => {
  const input = await readInput(c, await readJson(c));
  const ev = await evaluate(c.env.DB, currentUser(c), input);
  return c.json({
    company: input.company, header_row: ev.headerRow, headers: ev.headers, mapping: ev.mapping, remembered: ev.remembered, mapping_problems: ev.mappingProblems,
    fields: CLOCK_FIELDS.map(({ key, label, required }) => ({ key, label, required })), previous: ev.previous, summary: summarize(ev.rows), rows: ev.rows.map(publicRow),
  });
});

const BATCH_SELECT = `SELECT b.id, b.company_id, c.name AS company, c.code AS company_code, b.file_name, b.file_type, b.file_size, b.sheet_name, b.source, b.total_rows, b.imported_count, b.duplicate_count,
  b.warning_count, b.invalid_count, b.status, b.created_at, b.created_by, u.username AS created_by_name
  FROM attendance_file_imports b JOIN companies c ON c.id = b.company_id LEFT JOIN users u ON u.id = b.created_by`;

interface BatchRow {
  id: number;
  company_id: number;
  [k: string]: unknown;
}

const CHUNK = 100;
const chunks = <T>(a: readonly T[]): T[][] => Array.from({ length: Math.ceil(a.length / CHUNK) }, (_, i) => a.slice(i * CHUNK, (i + 1) * CHUNK));

attendanceFileRoutes.post('/', requirePerm('attendance_file.import'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const body = await readJson(c);
  if (body.confirm !== true) throw badRequest('กรุณายืนยันการนำเข้า');
  const key = str(body, 'idempotency_key', { required: true, max: 64 }) as string;
  if (!KEY_RE.test(key)) throw badRequest('idempotency_key ไม่ถูกต้อง');
  const again = await db.prepare(`${BATCH_SELECT} WHERE b.idempotency_key = ?`).bind(key).first<BatchRow>();
  if (again) {
    if (again.created_by !== user.id) throw conflict('รหัสการนำเข้านี้ถูกใช้แล้ว');
    return c.json({ ...again, repeated: true });
  }
  const input = await readInput(c, body);
  const ev = await evaluate(db, user, input);
  if (ev.mappingProblems.length) throw badRequest(ev.mappingProblems.join(' · '));
  if (!ev.rows.length) throw badRequest('ไม่พบแถวข้อมูลในไฟล์');
  const s = summarize(ev.rows);
  const batchId = `(SELECT id FROM attendance_file_imports WHERE idempotency_key = ?1)`;
  const stmts: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO attendance_file_imports (company_id, file_name, file_type, file_sha256, file_size, sheet_name, source, idempotency_key, mapping_json, total_rows, status, created_by)
                VALUES (?2, ?3, ?4, ?5, ?6, ?7, ?8, ?1, ?9, ?10, 'failed', ?11)`)
      .bind(key, input.company.id, input.fileName, input.fileType, input.sha256, input.fileSize, input.sheetName, input.source, JSON.stringify(ev.mapping), ev.rows.length, user.id),
  ];
  for (const part of chunks(ev.rows)) {
    const json = JSON.stringify(part.map((r) => ({
      r: r.row_no, c: r.employee_code, e: r.employee_id, d: r.work_date, i: r.clock_in, o: r.clock_out, n: r.out_next_day ? 1 : 0, v: r.device, s: r.source ?? input.source, k: r.remark,
      raw: JSON.stringify(r.raw), st: r.status, is: JSON.stringify(r.issues),
    })));
    stmts.push(db.prepare(`INSERT INTO attendance_raw_records (batch_id, row_no, employee_code, employee_id, work_date, clock_in, clock_out, clock_out_next_day, device, source, remark, raw_json, status, issues_json)
      SELECT ${batchId}, json_extract(value, '$.r'), json_extract(value, '$.c'), json_extract(value, '$.e'), json_extract(value, '$.d'), json_extract(value, '$.i'), json_extract(value, '$.o'), json_extract(value, '$.n'),
             json_extract(value, '$.v'), json_extract(value, '$.s'), json_extract(value, '$.k'), json_extract(value, '$.raw'), json_extract(value, '$.st'), json_extract(value, '$.is')
      FROM json_each(?2)`).bind(key, json));
  }
  const importable = ev.rows.filter((r) => r.status === 'valid' || r.status === 'warning');
  for (const part of chunks(importable)) {
    const json = JSON.stringify(part.map((r) => ({
      e: r.employee_id, d: r.work_date, i: r.clock_in, o: r.clock_out, st: r.attendance_status, n: r.out_next_day ? 1 : 0, v: r.device, sh: r.shift_id, l: r.late_minutes, x: r.early_leave_minutes, w: r.worked_minutes,
      note: (r.remark ? `${r.remark} · ` : '') + `นำเข้าไฟล์ ${input.fileName} แถว ${r.row_no}`,
    })));
    stmts.push(db.prepare(`INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source, note, created_by, updated_by, import_batch_id, device, shift_id, clock_out_next_day, late_minutes, early_leave_minutes, worked_minutes)
      SELECT json_extract(value, '$.e'), json_extract(value, '$.d'), json_extract(value, '$.i'), json_extract(value, '$.o'), json_extract(value, '$.st'), 'import', substr(json_extract(value, '$.note'), 1, 500), ?3, ?3, ${batchId},
             json_extract(value, '$.v'), json_extract(value, '$.sh'), json_extract(value, '$.n'), json_extract(value, '$.l'), json_extract(value, '$.x'), json_extract(value, '$.w')
      FROM json_each(?2) WHERE true
      ON CONFLICT (employee_id, work_date) DO NOTHING`).bind(key, json, user.id));
  }
  // link raw rows to the record they created; a day another import or user saved in the meantime becomes a duplicate
  stmts.push(db.prepare(`UPDATE attendance_raw_records SET attendance_record_id = (SELECT a.id FROM attendance_records a WHERE a.employee_id = attendance_raw_records.employee_id AND a.work_date = attendance_raw_records.work_date AND a.import_batch_id = attendance_raw_records.batch_id)
    WHERE batch_id = ${batchId} AND status IN ('valid', 'warning')`).bind(key));
  stmts.push(db.prepare(`UPDATE attendance_raw_records SET status = 'duplicate' WHERE batch_id = ${batchId} AND status IN ('valid', 'warning') AND attendance_record_id IS NULL`).bind(key));
  stmts.push(db.prepare(`UPDATE attendance_file_imports SET
      imported_count = (SELECT COUNT(*) FROM attendance_raw_records WHERE batch_id = attendance_file_imports.id AND attendance_record_id IS NOT NULL),
      warning_count = (SELECT COUNT(*) FROM attendance_raw_records WHERE batch_id = attendance_file_imports.id AND status = 'warning' AND attendance_record_id IS NOT NULL),
      duplicate_count = (SELECT COUNT(*) FROM attendance_raw_records WHERE batch_id = attendance_file_imports.id AND status = 'duplicate'),
      invalid_count = (SELECT COUNT(*) FROM attendance_raw_records WHERE batch_id = attendance_file_imports.id AND status = 'invalid')
    WHERE idempotency_key = ?1`).bind(key));
  stmts.push(db.prepare(`UPDATE attendance_file_imports SET status = CASE WHEN imported_count = 0 THEN 'failed' WHEN imported_count = total_rows THEN 'completed' ELSE 'partial' END WHERE idempotency_key = ?1`).bind(key));
  stmts.push(db.prepare(`INSERT INTO attendance_file_mappings (company_id, header_signature, mapping_json, updated_by) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT (company_id, header_signature) DO UPDATE SET mapping_json = excluded.mapping_json, updated_at = datetime('now'), updated_by = excluded.updated_by`).bind(input.company.id, ev.signature, JSON.stringify(ev.mapping), user.id));
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
  await audit(c, 'attendance_file.imported', 'attendance_file_imports', batch.id, {
    company_id: input.company.id, file_name: input.fileName, file_type: input.fileType, total: s.total, imported: batch.imported_count, duplicate: batch.duplicate_count, invalid: batch.invalid_count, warning: batch.warning_count,
  });
  return c.json({ ...batch, repeated: false }, 201);
});

async function visibleBatch(c: Context<AppEnv>, id: number): Promise<BatchRow> {
  const b = await c.env.DB.prepare(`${BATCH_SELECT} WHERE b.id = ?`).bind(id).first<BatchRow>();
  if (!b) throw notFound('ไม่พบประวัติการนำเข้า');
  const scope = await companyScope(c.env.DB, currentUser(c));
  if (scope.scope !== 'all' && !scope.items.some((x) => x.id === b.company_id)) throw notFound('ไม่พบประวัติการนำเข้า');
  return b;
}

attendanceFileRoutes.get('/', requirePerm('attendance_file.view'), async (c) => {
  const user = currentUser(c);
  const scope = await companyScope(c.env.DB, user);
  const company = await requireCompany(c.env.DB, user, c.req.query('company'));
  if (scope.scope === 'none') return c.json([]);
  const ids = company ? [company.id] : scope.scope === 'all' ? null : scope.items.map((x) => x.id);
  const { results } = await c.env.DB
    .prepare(`${BATCH_SELECT} WHERE (?1 IS NULL OR b.company_id IN (SELECT value FROM json_each(?1))) ORDER BY b.id DESC LIMIT 200`)
    .bind(ids ? JSON.stringify(ids) : null)
    .all();
  return c.json(results);
});

const ROW_SELECT = `SELECT r.row_no, r.employee_code, r.employee_id, e.first_name || ' ' || e.last_name AS employee_name, r.work_date, r.clock_in, r.clock_out, r.clock_out_next_day, r.device, r.source, r.remark,
  r.status, r.issues_json, r.attendance_record_id FROM attendance_raw_records r LEFT JOIN employees e ON e.id = r.employee_id`;

attendanceFileRoutes.get('/:id', requirePerm('attendance_file.view'), async (c) => {
  const b = await visibleBatch(c, intParam(c.req.param('id')));
  const { results } = await c.env.DB.prepare(`${ROW_SELECT} WHERE r.batch_id = ? ORDER BY r.row_no`).bind(b.id).all<Record<string, unknown>>();
  return c.json({ ...b, rows: results.map(({ issues_json, ...r }) => ({ ...r, issues: JSON.parse(String(issues_json)) })) });
});

/** Rows that were not imported cleanly (invalid, duplicate, warning) with their reasons, as CSV or XLSX. */
attendanceFileRoutes.get('/:id/report', requirePerm('attendance_file.view'), async (c) => {
  const b = await visibleBatch(c, intParam(c.req.param('id')));
  const format = c.req.query('format') === 'xlsx' ? 'xlsx' : 'csv';
  const { results } = await c.env.DB.prepare(`${ROW_SELECT} WHERE r.batch_id = ? AND (r.status <> 'valid' OR r.attendance_record_id IS NULL) ORDER BY r.row_no`).bind(b.id).all<Record<string, unknown>>();
  const label: Record<string, string> = { valid: 'ผ่าน', warning: 'ผ่าน (มีคำเตือน)', duplicate: 'ซ้ำ (ไม่นำเข้า)', invalid: 'ไม่ถูกต้อง (ไม่นำเข้า)' };
  const head = ['แถวในไฟล์', 'รหัสพนักงาน', 'วันที่ทำงาน', 'เวลาเข้า', 'เวลาออก', 'ผลการตรวจสอบ', 'นำเข้าแล้ว', 'รายละเอียด'];
  const body = results.map((r) => [
    r.row_no as number, (r.employee_code as string) ?? '', (r.work_date as string) ?? '', (r.clock_in as string) ?? '', r.clock_out ? `${r.clock_out}${r.clock_out_next_day ? ' (+1 วัน)' : ''}` : '',
    label[String(r.status)] ?? String(r.status), r.attendance_record_id ? 'ใช่' : 'ไม่', (JSON.parse(String(r.issues_json)) as ClockIssue[]).map((i) => i.message).join('; '),
  ]);
  const name = safeName(`attendance-import-${b.id}-errors`);
  await audit(c, 'attendance_file.report_downloaded', 'attendance_file_imports', b.id, { format, rows: body.length });
  if (format === 'csv') return c.body(csv([head, ...body]), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"`, 'cache-control': 'no-store' });
  return c.body(writeXlsx('Errors', [head, ...body] as Cell[][]) as unknown as ArrayBuffer, 200, {
    'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename="${name}.xlsx"`,
    'cache-control': 'no-store',
  });
});
