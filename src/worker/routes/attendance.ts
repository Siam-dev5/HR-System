// Feishu attendance import (analyze → preview → confirm, versioned, rollback before payroll uses it) and OT review.
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv, AuthUser } from '../env';
import type { AttendanceAnalysis, AttendanceImportSummary, AttendancePreviewRow, CompanyOption, OtReviewRow } from '../../shared/types';
import { ATTENDANCE_FIELDS, NUMERIC_FIELDS, analyzeGrid, departmentMatches, normalizeRows, type Mapping, type NormalizedRow, type ProfileMapping, type RowIssue } from '../../shared/feishu';
import type { Cell } from '../../shared/xlsx';
import { badRequest, conflict, intParam, notFound, readJson, str } from '../lib/http';
import { audit } from '../lib/audit';
import { loadSettings, payrollConfig } from '../lib/settings';
import { companyScope, requireCompany } from '../lib/companies';
import { currentUser, requireAuth, requirePerm } from '../auth';

export const attendanceRoutes = new Hono<AppEnv>();
attendanceRoutes.use('*', requireAuth);

const MAX_COLS = 400;
const MAX_CELL = 4000;
const OT_RATES = [1, 1.5, 2, 3];

/** Company ids the user may work with (null = every company). */
async function scopeIds(db: D1Database, user: AuthUser): Promise<number[] | null> {
  const s = await companyScope(db, user);
  return s.scope === 'all' ? null : s.items.map((c) => c.id);
}

async function scopedCompany(c: Context<AppEnv>, raw: unknown): Promise<CompanyOption> {
  const company = await requireCompany(c.env.DB, currentUser(c), raw === undefined || raw === null ? '' : String(raw));
  if (!company) throw badRequest('กรุณาเลือกบริษัท');
  return company;
}

function readGrid(v: unknown): Cell[][] {
  if (!Array.isArray(v) || v.length === 0) throw badRequest('ไม่มีข้อมูลในไฟล์');
  if (v.length > 10_100) throw badRequest('ไฟล์มีจำนวนแถวมากเกินไป');
  return v.map((row) => {
    if (!Array.isArray(row) || row.length > MAX_COLS) throw badRequest('รูปแบบข้อมูลตารางไม่ถูกต้อง');
    return row.map((cell) => {
      if (cell === null || typeof cell === 'number' || typeof cell === 'boolean') return cell as Cell;
      if (typeof cell === 'string') return cell.length > MAX_CELL ? cell.slice(0, MAX_CELL) : cell;
      throw badRequest('รูปแบบข้อมูลในเซลล์ไม่ถูกต้อง');
    });
  });
}

function readMapping(v: unknown): Mapping | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw badRequest('mapping ไม่ถูกต้อง');
  const out: Mapping = {};
  for (const [k, idx] of Object.entries(v as Record<string, unknown>)) {
    if (!ATTENDANCE_FIELDS.some((f) => f.key === k)) throw badRequest(`ไม่รู้จักฟิลด์ ${k}`);
    if (idx !== null && !(Number.isInteger(idx) && (idx as number) >= 0 && (idx as number) < MAX_COLS)) throw badRequest(`คอลัมน์ของ ${k} ไม่ถูกต้อง`);
    out[k as keyof Mapping] = idx as number | null;
  }
  return out;
}

interface PeriodLite {
  id: number;
  company_id: number | null;
  code: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
}

interface Prepared {
  analysis: AttendanceAnalysis;
  rows: NormalizedRow[];
  employeeIds: Map<number, number | null>;
  company: CompanyOption;
  period: PeriodLite;
}

interface EmpLite {
  id: number;
  emp_code: string;
  company_id: number;
  status: string;
  hire_date: string;
  termination_date: string | null;
  first_name: string;
  last_name: string;
  dept_code: string | null;
  dept_name: string | null;
}

/** Server-side analysis: the browser only sends the cell grid, every check is repeated here against D1. */
async function prepare(c: Context<AppEnv>, body: Record<string, unknown>): Promise<Prepared> {
  const db = c.env.DB;
  const company = await scopedCompany(c, body.company_id);
  const period = await db.prepare('SELECT id, code, name, start_date, end_date, status, company_id FROM payroll_periods WHERE id = ? AND deleted_at IS NULL').bind(intParam(String(body.period_id ?? ''), 'period_id')).first<PeriodLite>();
  if (!period) throw notFound('ไม่พบงวดเงินเดือน');
  const fileName = str(body, 'file_name', { required: true, max: 255 }) as string;
  const sha256 = str(body, 'sha256', { required: true, max: 64 }) as string;
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw badRequest('sha256 ไม่ถูกต้อง');
  const grid = readGrid(body.grid);
  let profile: ProfileMapping | null = null;
  if (body.profile_id !== undefined && body.profile_id !== null && body.profile_id !== '') {
    const p = await db.prepare('SELECT mapping_json FROM attendance_mapping_profiles WHERE id = ?').bind(intParam(String(body.profile_id), 'profile_id')).first<{ mapping_json: string }>();
    if (!p) throw notFound('ไม่พบ Mapping Profile');
    profile = JSON.parse(p.mapping_json) as ProfileMapping;
  }
  const hoursPerDay = payrollConfig(await loadSettings(db)).hoursPerDay;
  const ga = analyzeGrid(grid, fileName, readMapping(body.mapping), profile);
  const rows = normalizeRows(grid, ga, hoursPerDay);

  const { results: emps } = await db
    .prepare(
      `SELECT e.id, e.emp_code, e.company_id, e.status, e.hire_date, e.termination_date, e.first_name, e.last_name, d.code AS dept_code, d.name AS dept_name
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id`,
    )
    .all<EmpLite>();
  const byCode = new Map(emps.map((e) => [e.emp_code.trim().toUpperCase(), e]));
  const employeeIds = new Map<number, number | null>();
  const fileIssues: AttendanceAnalysis['fileIssues'] = ga.issues.map((i) => ({ ...i, level: 'error' as const }));
  if (period.company_id !== null && period.company_id !== company.id) fileIssues.push({ code: 'period_company', level: 'error', message: `งวด ${period.code} เป็นงวดของบริษัทอื่น` });
  if (ga.sourceStart && ga.sourceEnd && (ga.sourceEnd < period.start_date || ga.sourceStart > period.end_date)) {
    fileIssues.push({ code: 'outside_period', level: 'warning', message: `ช่วงวันที่ในไฟล์ (${ga.sourceStart} – ${ga.sourceEnd}) ไม่ทับซ้อนกับงวด ${period.code} (${period.start_date} – ${period.end_date})` });
  }

  const add = (r: NormalizedRow, i: RowIssue) => r.issues.push(i);
  for (const r of rows) {
    const code = r.values.employee_code ? String(r.values.employee_code).trim().toUpperCase() : null;
    const e = code ? byCode.get(code) : undefined;
    employeeIds.set(r.rowNo, e && e.company_id === company.id ? e.id : null);
    if (code && !e) add(r, { code: 'unknown_employee', level: 'error', message: `ไม่พบรหัสพนักงาน ${r.values.employee_code} ในระบบ` });
    if (e && e.company_id !== company.id) add(r, { code: 'wrong_company', level: 'error', message: `พนักงาน ${e.emp_code} สังกัดบริษัทอื่น` });
    if (e && e.company_id === company.id) {
      if ((e.status === 'resigned' || e.status === 'terminated') && (!e.termination_date || e.termination_date < period.start_date)) {
        add(r, { code: 'inactive_employee', level: 'warning', message: `พนักงานพ้นสภาพแล้ว (${e.status})` });
      }
      const hd = r.values.hire_date;
      if (typeof hd === 'string' && hd !== e.hire_date) add(r, { code: 'hire_date_mismatch', level: 'warning', message: `วันเริ่มงานในไฟล์ ${hd} ไม่ตรงกับระบบ ${e.hire_date}` });
      const dept = r.values.department_name;
      if (typeof dept === 'string' && !departmentMatches(dept, e.dept_code && e.dept_name ? { code: e.dept_code, name: e.dept_name } : null)) {
        add(r, { code: 'department_mismatch', level: 'warning', message: `หน่วยงานในไฟล์ไม่ตรงกับหน่วยงานในระบบ (${e.dept_name})` });
      }
    }
    const num = (k: string) => (typeof r.values[k as keyof NormalizedRow['values']] === 'number' ? (r.values[k as keyof NormalizedRow['values']] as number) : null);
    const ot = num('feishu_overtime_hours');
    if (ot && ot > 0) add(r, { code: 'ot_pending', level: 'warning', message: `OT ${ot} ชม. รอ HR ยืนยันก่อนเข้า Payroll` });
    const unpaid = (num('unpaid_sick_leave_hours') ?? 0) + (num('unpaid_personal_leave_hours') ?? 0);
    const expectedHours = num('expected_work_hours') ?? (num('expected_work_days') !== null ? (num('expected_work_days') as number) * hoursPerDay : null);
    const expectedDays = num('expected_work_days');
    const absence = num('absence_days');
    if ((expectedHours !== null && unpaid > expectedHours + 1e-6) || (expectedDays !== null && absence !== null && absence > expectedDays + 1e-6)) {
      add(r, { code: 'leave_abnormal', level: 'warning', message: 'ชั่วโมงลา/ขาดงานมากกว่าเวลาทำงานที่กำหนด' });
    }
  }

  const has = (r: NormalizedRow, code: string) => r.issues.some((i) => i.code === code);
  const errorsOf = (r: NormalizedRow) => r.issues.some((i) => i.level === 'error');
  const importable = rows.filter((r) => !errorsOf(r));
  const totals: Record<string, number> = {};
  for (const k of NUMERIC_FIELDS) totals[k] = Math.round(importable.reduce((a, r) => a + (typeof r.values[k] === 'number' ? (r.values[k] as number) : 0), 0) * 100) / 100;

  const { results: active } = await db
    .prepare("SELECT id, emp_code, first_name || ' ' || last_name AS name FROM employees WHERE company_id = ? AND status IN ('active', 'probation') AND hire_date <= ? ORDER BY emp_code")
    .bind(company.id, period.end_date)
    .all<{ id: number; emp_code: string; name: string }>();
  const inFile = new Set([...employeeIds.values()].filter((x): x is number => x !== null));
  const prev = await db
    .prepare("SELECT id, version, imported_count AS rows, summary_json, locked FROM attendance_imports WHERE company_id = ? AND payroll_period_id = ? AND status = 'active'")
    .bind(company.id, period.id)
    .first<{ id: number; version: number; rows: number; summary_json: string; locked: number }>();
  const maxVersion = await db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM attendance_imports WHERE company_id = ? AND payroll_period_id = ?').bind(company.id, period.id).first<{ v: number }>();
  const dup = await db
    .prepare(
      `SELECT i.id, i.version, i.status, i.company_id, i.payroll_period_id, c.name AS company, p.code AS period FROM attendance_imports i
       JOIN companies c ON c.id = i.company_id JOIN payroll_periods p ON p.id = i.payroll_period_id WHERE i.file_sha256 = ? AND i.status != 'rolled_back' ORDER BY i.id DESC LIMIT 1`,
    )
    .bind(sha256)
    .first<{ id: number; version: number; status: string; company_id: number; payroll_period_id: number; company: string; period: string }>();
  if (dup) {
    const same = dup.company_id === company.id && dup.payroll_period_id === period.id && dup.status === 'active';
    fileIssues.push({
      code: 'duplicate_file',
      level: same ? 'error' : 'warning',
      message: same ? `ไฟล์นี้ถูกนำเข้าแล้ว (เวอร์ชัน ${dup.version} ของงวดนี้)` : `ไฟล์นี้เคยนำเข้าแล้ว: ${dup.company} งวด ${dup.period} เวอร์ชัน ${dup.version}`,
    });
  }
  const locked = !!prev?.locked || period.status === 'approved' || period.status === 'published';
  if (locked) fileIssues.push({ code: 'locked', level: 'error', message: `งวด ${period.code} นำข้อมูลเวลาทำงานไปคำนวณแล้ว (ล็อก) — ต้องเปิดงวดกลับเป็นร่างก่อน หรือเลือกงวดอื่น` });

  const previewRows: AttendancePreviewRow[] = rows.map((r) => ({
    rowNo: r.rowNo,
    employee_code: (r.values.employee_code as string | null) ?? null,
    employee_name: (r.values.employee_name as string | null) ?? null,
    employee_id: employeeIds.get(r.rowNo) ?? null,
    values: { ...r.values },
    issues: r.issues,
    included: !errorsOf(r),
  }));
  const stat = (code: string) => rows.filter((r) => has(r, code)).length;
  const analysis: AttendanceAnalysis = {
    fileName,
    sha256,
    format: ga.format,
    layout: ga.layout,
    headerRow: ga.headerRow,
    headers: ga.headers,
    mapping: ga.mapping as Record<string, number | null>,
    sourceStart: ga.sourceStart,
    sourceEnd: ga.sourceEnd,
    fileIssues,
    rows: previewRows,
    stats: {
      total: rows.length,
      matched: inFile.size,
      unknown: stat('unknown_employee'),
      wrongCompany: stat('wrong_company'),
      duplicates: stat('duplicate_employee'),
      invalidDates: stat('invalid_date'),
      invalidNumbers: stat('invalid_number') + stat('negative_value'),
      otPending: stat('ot_pending'),
      leaveAbnormal: stat('leave_abnormal'),
      errors: rows.filter(errorsOf).length,
      warnings: rows.filter((r) => r.issues.some((i) => i.level === 'warning')).length,
      importable: importable.length,
    },
    reconciliation: {
      activeEmployees: active.length,
      inFile: inFile.size,
      missingInFile: active.filter((e) => !inFile.has(e.id)).slice(0, 300),
      totals,
      previous: prev ? { id: prev.id, version: prev.version, rows: prev.rows, totals: (JSON.parse(prev.summary_json) as { totals?: Record<string, number> }).totals ?? {} } : null,
    },
    duplicateFile: dup ? { id: dup.id, version: dup.version, company: dup.company, period: dup.period, status: dup.status } : null,
    canImport: !fileIssues.some((i) => i.level === 'error') && importable.length > 0,
    nextVersion: (maxVersion?.v ?? 0) + 1,
    locked,
  };
  return { analysis, rows, employeeIds, company, period };
}

/** Payroll periods to attach attendance to (read-only list; HR Staff do not hold payroll.view). */
attendanceRoutes.get('/periods', requirePerm('attendance_import.view', 'ot_review.view'), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, code, name, start_date, end_date, status, kind, company_id FROM payroll_periods WHERE deleted_at IS NULL ORDER BY start_date DESC, kind LIMIT 120').all();
  return c.json(results);
});

attendanceRoutes.post('/imports/analyze', requirePerm('attendance_import.create'), async (c) => {
  const { analysis } = await prepare(c, await readJson(c));
  return c.json(analysis);
});

attendanceRoutes.post('/imports', requirePerm('attendance_import.create'), async (c) => {
  const db = c.env.DB;
  const user = currentUser(c);
  const body = await readJson(c);
  const { analysis: a, rows, employeeIds, company, period } = await prepare(c, body);
  if (!a.canImport) throw conflict(`นำเข้าไม่ได้: ${a.fileIssues.filter((i) => i.level === 'error').map((i) => i.message).join(' · ') || 'ไม่มีรายการที่ถูกต้อง'}`);
  if (a.stats.errors > 0 && body.skip_invalid !== true) throw conflict(`มีรายการผิดพลาด ${a.stats.errors} แถว — ยืนยัน "นำเข้าเฉพาะรายการที่ถูกต้อง" หรือแก้ไขไฟล์ก่อน`);
  if (!a.format) throw conflict('ไม่สามารถระบุรูปแบบไฟล์ได้');

  const version = a.nextVersion;
  const summary = { stats: a.stats, totals: a.reconciliation.totals, missingInFile: a.reconciliation.missingInFile.length, fileIssues: a.fileIssues };
  const importIdSql = '(SELECT id FROM attendance_imports WHERE company_id = ? AND payroll_period_id = ? AND version = ?)';
  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE attendance_imports SET status = 'superseded' WHERE company_id = ? AND payroll_period_id = ? AND status = 'active' AND locked = 0").bind(company.id, period.id),
    db.prepare(
      `INSERT INTO attendance_imports (company_id, payroll_period_id, version, file_name, file_sha256, format, layout, source_start, source_end, headers_json, mapping_json, summary_json, row_count, imported_count, excluded_count, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(company.id, period.id, version, a.fileName, a.sha256, a.format, a.layout, a.sourceStart, a.sourceEnd, JSON.stringify(a.headers), JSON.stringify(a.mapping), JSON.stringify(summary), a.stats.total, a.stats.importable, a.stats.total - a.stats.importable, user.id),
  ];
  // rows go in as JSON chunks (one bound parameter per chunk) inside the same batch / transaction
  const payload = rows.map((r) => {
    const v = r.values;
    const included = !r.issues.some((i) => i.level === 'error');
    const ot = typeof v.feishu_overtime_hours === 'number' ? v.feishu_overtime_hours : null;
    return {
      row_no: r.rowNo,
      employee_id: employeeIds.get(r.rowNo) ?? null,
      employee_code: String(v.employee_code ?? '').slice(0, 64) || '(ไม่มีรหัส)',
      employee_name: v.employee_name ?? null,
      external_department_id: v.external_department_id ?? null,
      department_name: typeof v.department_name === 'string' ? v.department_name.slice(0, 1000) : null,
      company_name: v.company_name ?? null,
      hire_date: v.hire_date ?? null,
      ...Object.fromEntries(NUMERIC_FIELDS.map((k) => [k, typeof v[k] === 'number' ? v[k] : null])),
      included: included ? 1 : 0,
      issues_json: JSON.stringify(r.issues),
      raw_json: JSON.stringify(r.raw),
      ot_status: included && ot && ot > 0 ? 'pending' : 'none',
    };
  });
  const cols = ['row_no', 'employee_id', 'employee_code', 'employee_name', 'external_department_id', 'department_name', 'company_name', 'hire_date', ...NUMERIC_FIELDS, 'included', 'issues_json', 'raw_json', 'ot_status'];
  for (let i = 0; i < payload.length; i += 100) {
    stmts.push(
      db.prepare(`INSERT INTO attendance_import_rows (import_id, ${cols.join(', ')}) SELECT ${importIdSql}, ${cols.map((k) => `json_extract(j.value, '$.${k}')`).join(', ')} FROM json_each(?) j`)
        .bind(company.id, period.id, version, JSON.stringify(payload.slice(i, i + 100))),
    );
  }
  await db.batch(stmts);
  const created = await db.prepare('SELECT id FROM attendance_imports WHERE company_id = ? AND payroll_period_id = ? AND version = ?').bind(company.id, period.id, version).first<{ id: number }>();
  await audit(c, 'attendance.imported', 'attendance_imports', created?.id ?? null, { company: company.id, period: period.id, version, rows: a.stats.total, imported: a.stats.importable, excluded: a.stats.total - a.stats.importable, format: a.format, sha256: a.sha256 });
  return c.json({ id: created?.id ?? null, version, imported: a.stats.importable, excluded: a.stats.total - a.stats.importable, otPending: payload.filter((p) => p.ot_status === 'pending').length }, 201);
});

const IMPORT_SELECT = `SELECT i.id, i.company_id, c.name AS company, i.payroll_period_id, p.code AS period, i.version, i.file_name, i.format, i.layout, i.source_start, i.source_end,
  i.row_count, i.imported_count, i.excluded_count, i.status, i.locked, i.created_at, u.display_name AS created_by_name, i.rollback_reason,
  (SELECT COUNT(*) FROM attendance_import_rows r WHERE r.import_id = i.id AND r.ot_status = 'pending') AS ot_pending
  FROM attendance_imports i JOIN companies c ON c.id = i.company_id JOIN payroll_periods p ON p.id = i.payroll_period_id LEFT JOIN users u ON u.id = i.created_by`;

attendanceRoutes.get('/imports', requirePerm('attendance_import.view'), async (c) => {
  const db = c.env.DB;
  const user = currentUser(c);
  const company = await requireCompany(db, user, c.req.query('company'));
  const ids = company ? [company.id] : await scopeIds(db, user);
  if (ids && !ids.length) return c.json([]);
  const pid = c.req.query('period_id');
  const where: string[] = [];
  const args: unknown[] = [];
  if (ids) {
    where.push(`i.company_id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  if (pid) {
    where.push('i.payroll_period_id = ?');
    args.push(intParam(pid, 'period_id'));
  }
  const { results } = await db.prepare(`${IMPORT_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY i.id DESC LIMIT 200`).bind(...args).all<AttendanceImportSummary>();
  return c.json(results);
});

async function loadImport(c: Context<AppEnv>, id: number): Promise<AttendanceImportSummary> {
  const row = await c.env.DB.prepare(`${IMPORT_SELECT} WHERE i.id = ?`).bind(id).first<AttendanceImportSummary>();
  if (!row) throw notFound('ไม่พบประวัติการนำเข้า');
  await requireCompany(c.env.DB, currentUser(c), String(row.company_id));
  return row;
}

attendanceRoutes.get('/imports/:id', requirePerm('attendance_import.view'), async (c) => {
  const imp = await loadImport(c, intParam(c.req.param('id')));
  const { results } = await c.env.DB.prepare(
    `SELECT id, row_no, employee_id, employee_code, employee_name, department_name, hire_date, expected_work_days, expected_work_hours, actual_work_days, actual_work_hours,
            feishu_overtime_hours, absence_days, absence_minutes, unpaid_sick_leave_hours, unpaid_personal_leave_hours, included, issues_json, ot_status, ot_confirmed_hours
     FROM attendance_import_rows WHERE import_id = ? ORDER BY row_no`,
  )
    .bind(imp.id)
    .all<Record<string, unknown> & { issues_json: string }>();
  return c.json({ import: imp, rows: results.map(({ issues_json, ...r }) => ({ ...r, issues: JSON.parse(issues_json) as RowIssue[] })) });
});

attendanceRoutes.post('/imports/:id/rollback', requirePerm('attendance_import.update'), async (c) => {
  const db = c.env.DB;
  const user = currentUser(c);
  const imp = await loadImport(c, intParam(c.req.param('id')));
  const reason = str(await readJson(c), 'reason', { required: true, max: 500 }) as string;
  if (imp.status !== 'active') throw conflict('ย้อนกลับได้เฉพาะเวอร์ชันที่ใช้งานอยู่');
  if (imp.locked) throw conflict('ข้อมูลนี้ถูกนำไปคำนวณเงินเดือนแล้ว (ล็อก) — ต้องเปิดงวดกลับเป็นร่างก่อน');
  const prev = await db
    .prepare("SELECT id, version FROM attendance_imports WHERE company_id = ? AND payroll_period_id = ? AND status = 'superseded' AND version < ? ORDER BY version DESC LIMIT 1")
    .bind(imp.company_id, imp.payroll_period_id, imp.version)
    .first<{ id: number; version: number }>();
  const stmts = [db.prepare("UPDATE attendance_imports SET status = 'rolled_back', rolled_back_at = datetime('now'), rolled_back_by = ?, rollback_reason = ? WHERE id = ? AND status = 'active' AND locked = 0").bind(user.id, reason, imp.id)];
  if (prev) stmts.push(db.prepare("UPDATE attendance_imports SET status = 'active' WHERE id = ?").bind(prev.id));
  await db.batch(stmts);
  await audit(c, 'attendance.rolled_back', 'attendance_imports', imp.id, { version: imp.version, restored: prev?.version ?? null, reason });
  return c.json({ ok: true, restoredVersion: prev?.version ?? null });
});

// ---- Mapping profiles -----------------------------------------------------------------------
attendanceRoutes.get('/profiles', requirePerm('attendance_import.view'), async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, company_id, mapping_json, updated_at FROM attendance_mapping_profiles ORDER BY name').all<{ id: number; name: string; company_id: number | null; mapping_json: string; updated_at: string }>();
  return c.json(results.map(({ mapping_json, ...r }) => ({ ...r, mapping: JSON.parse(mapping_json) as ProfileMapping })));
});

attendanceRoutes.post('/profiles', requirePerm('attendance_import.create'), async (c) => {
  const body = await readJson(c);
  const name = str(body, 'name', { required: true, max: 100 }) as string;
  const companyId = body.company_id === undefined || body.company_id === null || body.company_id === '' ? null : (await scopedCompany(c, body.company_id)).id;
  const m = body.mapping;
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw badRequest('mapping ไม่ถูกต้อง');
  const mapping: ProfileMapping = {};
  for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
    if (!ATTENDANCE_FIELDS.some((f) => f.key === k)) throw badRequest(`ไม่รู้จักฟิลด์ ${k}`);
    if (typeof v !== 'string' || !v.trim() || v.length > 200) throw badRequest(`ชื่อคอลัมน์ของ ${k} ไม่ถูกต้อง`);
    mapping[k as keyof ProfileMapping] = v.trim();
  }
  if (!mapping.employee_code) throw badRequest('Mapping Profile ต้องระบุคอลัมน์ Employee ID');
  const user = currentUser(c);
  const row = await c.env.DB.prepare(
    `INSERT INTO attendance_mapping_profiles (name, company_id, mapping_json, created_by, updated_by) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET company_id = excluded.company_id, mapping_json = excluded.mapping_json, updated_at = datetime('now'), updated_by = excluded.updated_by RETURNING id`,
  )
    .bind(name, companyId, JSON.stringify(mapping), user.id, user.id)
    .first<{ id: number }>();
  await audit(c, 'attendance.profile_saved', 'attendance_mapping_profiles', row?.id ?? null, { name, fields: Object.keys(mapping).length });
  return c.json({ id: row?.id, name, company_id: companyId, mapping }, 201);
});

attendanceRoutes.delete('/profiles/:id', requirePerm('attendance_import.update'), async (c) => {
  const id = intParam(c.req.param('id'));
  const r = await c.env.DB.prepare('DELETE FROM attendance_mapping_profiles WHERE id = ?').bind(id).run();
  if (!r.meta.changes) throw notFound('ไม่พบ Mapping Profile');
  await audit(c, 'attendance.profile_deleted', 'attendance_mapping_profiles', id);
  return c.json({ ok: true });
});

// ---- OT review ------------------------------------------------------------------------------
const OT_SELECT = `SELECT r.id, r.import_id, i.version, c.name AS company, p.code AS period, r.employee_id, r.employee_code, r.employee_name, r.feishu_overtime_hours,
  r.ot_status, r.ot_confirmed_hours, r.ot_rate, r.ot_reason, u.display_name AS reviewer, r.ot_reviewed_at, i.locked, i.company_id
  FROM attendance_import_rows r JOIN attendance_imports i ON i.id = r.import_id JOIN companies c ON c.id = i.company_id
  JOIN payroll_periods p ON p.id = i.payroll_period_id LEFT JOIN users u ON u.id = r.ot_reviewed_by`;

attendanceRoutes.get('/ot', requirePerm('ot_review.view'), async (c) => {
  const db = c.env.DB;
  const user = currentUser(c);
  const company = await requireCompany(db, user, c.req.query('company'));
  const ids = company ? [company.id] : await scopeIds(db, user);
  if (ids && !ids.length) return c.json([]);
  const where = ["i.status = 'active'", "r.ot_status != 'none'", 'r.included = 1'];
  const args: unknown[] = [];
  if (ids) {
    where.push(`i.company_id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  const pid = c.req.query('period_id');
  if (pid) {
    where.push('i.payroll_period_id = ?');
    args.push(intParam(pid, 'period_id'));
  }
  const status = c.req.query('status');
  if (status) {
    if (!['pending', 'confirmed', 'rejected', 'revised'].includes(status)) throw badRequest('สถานะไม่ถูกต้อง');
    where.push('r.ot_status = ?');
    args.push(status);
  }
  const { results } = await db.prepare(`${OT_SELECT} WHERE ${where.join(' AND ')} ORDER BY p.start_date DESC, r.employee_code LIMIT 2000`).bind(...args).all<OtReviewRow>();
  return c.json(results);
});

attendanceRoutes.post('/ot/confirm-all', requirePerm('ot_review.update'), async (c) => {
  const db = c.env.DB;
  const user = currentUser(c);
  const body = await readJson(c);
  const imp = await loadImport(c, intParam(String(body.import_id ?? ''), 'import_id'));
  if (imp.status !== 'active') throw conflict('ยืนยันได้เฉพาะเวอร์ชันที่ใช้งานอยู่');
  if (imp.locked) throw conflict('OT ของงวดนี้ถูกนำไปคำนวณเงินเดือนแล้ว (ล็อก)');
  const r = await db
    .prepare("UPDATE attendance_import_rows SET ot_status = 'confirmed', ot_confirmed_hours = feishu_overtime_hours, ot_rate = 1.5, ot_reviewed_by = ?, ot_reviewed_at = datetime('now') WHERE import_id = ? AND ot_status = 'pending'")
    .bind(user.id, imp.id)
    .run();
  await audit(c, 'attendance.ot_confirmed_all', 'attendance_imports', imp.id, { rows: r.meta.changes, rate: 1.5 });
  return c.json({ confirmed: r.meta.changes });
});

attendanceRoutes.post('/ot/:id', requirePerm('ot_review.update'), async (c) => {
  const db = c.env.DB;
  const user = currentUser(c);
  const id = intParam(c.req.param('id'));
  const row = await db.prepare(`${OT_SELECT} WHERE r.id = ? AND i.status = 'active'`).bind(id).first<OtReviewRow & { company_id: number }>();
  if (!row || row.ot_status === ('none' as string)) throw notFound('ไม่พบรายการ OT ที่รอตรวจสอบ');
  await requireCompany(db, user, String(row.company_id));
  if (row.locked) throw conflict('OT ของงวดนี้ถูกนำไปคำนวณเงินเดือนแล้ว (ล็อก)');
  const body = await readJson(c);
  const action = body.action;
  const reason = str(body, 'reason', { max: 500 });
  const rate = body.rate === undefined || body.rate === null ? (row.ot_rate ?? 1.5) : Number(body.rate);
  if (!OT_RATES.includes(rate)) throw badRequest('อัตรา OT ต้องเป็น 1, 1.5, 2 หรือ 3 เท่า');
  let status: OtReviewRow['ot_status'];
  let hours: number | null;
  if (action === 'confirm') {
    status = 'confirmed';
    hours = row.feishu_overtime_hours ?? 0;
  } else if (action === 'revise') {
    hours = Number(body.hours);
    if (!Number.isFinite(hours) || hours < 0 || hours > 400) throw badRequest('จำนวนชั่วโมง OT ต้องอยู่ระหว่าง 0 – 400');
    hours = Math.round(hours * 100) / 100;
    if (!reason) throw badRequest('กรุณาระบุเหตุผลการปรับชั่วโมง OT');
    status = 'revised';
  } else if (action === 'reject') {
    if (!reason) throw badRequest('กรุณาระบุเหตุผลการปฏิเสธ OT');
    status = 'rejected';
    hours = null;
  } else throw badRequest('action ต้องเป็น confirm, revise หรือ reject');
  await db.prepare("UPDATE attendance_import_rows SET ot_status = ?, ot_confirmed_hours = ?, ot_rate = ?, ot_reason = ?, ot_reviewed_by = ?, ot_reviewed_at = datetime('now') WHERE id = ?")
    .bind(status, hours, status === 'rejected' ? null : rate, reason, user.id, id)
    .run();
  await audit(c, `attendance.ot_${status}`, 'attendance_import_rows', id, {
    employee: row.employee_code, original: row.feishu_overtime_hours, before: { status: row.ot_status, hours: row.ot_confirmed_hours, rate: row.ot_rate }, after: { status, hours, rate: status === 'rejected' ? null : rate }, reason,
  });
  return c.json(await db.prepare(`${OT_SELECT} WHERE r.id = ?`).bind(id).first<OtReviewRow>());
});
