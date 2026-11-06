// Feishu daily attendance report (FEISHU_DAILY_ATTENDANCE_V1) in the attendance file import: the worksheet becomes
// one row per employee and day. Every row is kept in attendance_raw_records (with the cell, the punch results and the
// cell reference); the day's leave / overtime / out-of-office events go to attendance_day_events; a day with a usable
// clock time becomes processed attendance in attendance_records without overwriting an existing day. Leave and
// overtime events are information only: no leave request, OT request or payroll item is created.
import type { AuthUser } from '../env';
import type { CompanyOption } from '../../shared/types';
import { companyScope } from './companies';
import { bangkokNow } from './time';
import { badRequest } from './http';
import { lockedPeriods } from './shift-resolver';
import {
  DAILY_FIELDS, FEISHU_DAILY_TEMPLATE, autoDailyMapping, dailyMappingProblems, dayColumns, findDailyHeaderRow, parseDailyRows,
  type DailyIssue, type DailyMapping, type DailyRow,
} from '../../shared/feishu-daily';
import { MAX_CLOCK_ROWS } from '../../shared/clock-import';
import type { Cell } from '../../shared/xlsx';

export type DailyRowStatus = 'valid' | 'warning' | 'duplicate' | 'invalid';
export interface EvaluatedDailyRow extends DailyRow {
  employee_id: number | null;
  employee_display: string | null;
  status: DailyRowStatus;
  attendance_status: 'present' | 'late' | null;
}
export interface DailyEvaluation {
  headerRow: number;
  headers: string[];
  signature: string;
  mapping: DailyMapping;
  remembered: boolean;
  mappingProblems: string[];
  dayColumns: Array<{ col: number; date: string }>;
  sourceRows: number;
  emptyDays: number;
  rows: EvaluatedDailyRow[];
}
export interface DailyInput {
  company: CompanyOption;
  grid: Cell[][];
  headerRow: number | null;
  mapping: DailyMapping | null;
}

export function dailyRowStatus(issues: readonly DailyIssue[]): DailyRowStatus {
  if (issues.some((i) => i.level === 'error')) return 'invalid';
  if (issues.some((i) => i.code === 'duplicate_in_file' || i.code === 'duplicate_existing')) return 'duplicate';
  if (issues.some((i) => i.level === 'warning')) return 'warning';
  return 'valid';
}

export function readDailyMapping(v: unknown, maxCols: number): DailyMapping | null {
  if (v === null || v === undefined || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: DailyMapping = {};
  for (const f of DAILY_FIELDS) {
    const col = (v as Record<string, unknown>)[f.key];
    if (col === null || col === undefined || col === '') continue;
    if (Number.isInteger(col) && (col as number) >= 0 && (col as number) < maxCols) out[f.key] = col as number;
  }
  return out;
}

const issue = (code: DailyIssue['code'], level: DailyIssue['level'], message: string): DailyIssue => ({ code, level, message });
export const hasPunch = (r: { clock_in: string | null; clock_out: string | null }) => !!(r.clock_in || r.clock_out);

export async function evaluateDaily(db: D1Database, user: AuthUser, input: DailyInput, signatureOf: (s: string) => Promise<string>): Promise<DailyEvaluation> {
  const found = findDailyHeaderRow(input.grid);
  const headerRow = input.headerRow ?? (found >= 0 ? found : 0);
  const header = input.grid[headerRow] ?? [];
  const width = Math.max(header.length, ...input.grid.slice(headerRow, headerRow + 50).map((r) => r.length));
  const headers = Array.from({ length: width }, (_, i) => String(header[i] ?? '').trim());
  const days = dayColumns(header);
  const signature = await signatureOf(headers.map((h) => (/^\d{4}-\d{2}-\d{2}\b/.test(h) ? '<date>' : h)).join('|'));
  const saved = await db
    .prepare('SELECT mapping_json FROM import_mapping_templates WHERE company_id = ? AND import_type = ? AND template_code = ? AND header_signature = ?')
    .bind(input.company.id, 'attendance', FEISHU_DAILY_TEMPLATE, signature)
    .first<{ mapping_json: string }>();
  const remembered = saved ? (JSON.parse(saved.mapping_json) as DailyMapping) : null;
  const mapping = input.mapping ?? autoDailyMapping(header, remembered);
  const mappingProblems = dailyMappingProblems(mapping, width, days.map((d) => d.col));
  const base = { headerRow, headers, signature, mapping, remembered: !!remembered && !input.mapping, mappingProblems, dayColumns: days };
  if (mappingProblems.length) return { ...base, sourceRows: 0, emptyDays: 0, rows: [] };
  const parsed = parseDailyRows(input.grid, headerRow, mapping);
  if (parsed.rows.length > MAX_CLOCK_ROWS) throw badRequest(`ไฟล์มีมากกว่า ${MAX_CLOCK_ROWS.toLocaleString()} รายการ (พนักงาน × วัน) กรุณาแบ่งไฟล์`);

  const scope = await companyScope(db, user);
  const today = bangkokNow().date;
  const codes = [...new Set(parsed.rows.map((r) => r.employee_code?.toUpperCase()).filter((x): x is string => !!x))];
  const { results: emps } = codes.length
    ? await db
        .prepare("SELECT id, emp_code, first_name || ' ' || last_name AS name, company_id, hire_date, termination_date FROM employees WHERE upper(emp_code) IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(codes))
        .all<{ id: number; emp_code: string; name: string; company_id: number; hire_date: string | null; termination_date: string | null }>()
    : { results: [] };
  const byCode = new Map(emps.map((e) => [e.emp_code.toUpperCase(), e]));
  const dates = parsed.rows.map((r) => r.work_date).sort();
  const from = dates[0] ?? today;
  const to = dates[dates.length - 1] ?? today;
  const mine = emps.filter((e) => e.company_id === input.company.id).map((e) => e.id);
  const [locked, existing, accepted] = await Promise.all([
    lockedPeriods(db, input.company.id, from, to),
    mine.length
      ? db.prepare('SELECT employee_id, work_date FROM attendance_records WHERE employee_id IN (SELECT value FROM json_each(?1)) AND work_date BETWEEN ?2 AND ?3').bind(JSON.stringify(mine), from, to).all<{ employee_id: number; work_date: string }>()
      : Promise.resolve({ results: [] as Array<{ employee_id: number; work_date: string }> }),
    // days already imported from a Feishu daily report (a day without clock times has no attendance record)
    mine.length
      ? db.prepare(`SELECT r.employee_id, r.work_date FROM attendance_raw_records r JOIN attendance_file_imports b ON b.id = r.batch_id
                    WHERE b.template_code = ?4 AND r.status IN ('valid', 'warning') AND r.employee_id IN (SELECT value FROM json_each(?1)) AND r.work_date BETWEEN ?2 AND ?3`)
          .bind(JSON.stringify(mine), from, to, FEISHU_DAILY_TEMPLATE).all<{ employee_id: number; work_date: string }>()
      : Promise.resolve({ results: [] as Array<{ employee_id: number; work_date: string }> }),
  ]);
  const recordKeys = new Set(existing.results.map((r) => `${r.employee_id}|${r.work_date}`));
  const acceptedKeys = new Set(accepted.results.map((r) => `${r.employee_id}|${r.work_date}`));
  const seen = new Set<string>();

  const rows = parsed.rows.map((p): EvaluatedDailyRow => {
    const issues = [...p.issues];
    const out: EvaluatedDailyRow = { ...p, issues, employee_id: null, employee_display: null, status: 'valid', attendance_status: null };
    const emp = p.employee_code ? byCode.get(p.employee_code.toUpperCase()) : undefined;
    if (p.employee_code && !emp) issues.push(issue('unknown_employee', 'error', `ไม่พบพนักงานรหัส ${p.employee_code}`));
    else if (emp && emp.company_id !== input.company.id) {
      const visible = scope.scope === 'all' || scope.items.some((x) => x.id === emp.company_id);
      issues.push(visible ? issue('wrong_company', 'error', `พนักงานรหัส ${p.employee_code} ไม่ได้อยู่ในบริษัท ${input.company.name}`) : issue('unknown_employee', 'error', `ไม่พบพนักงานรหัส ${p.employee_code}`));
    } else if (emp) {
      out.employee_id = emp.id;
      out.employee_display = emp.name;
    }
    const d = p.work_date;
    if (d > today) issues.push(issue('future_date', 'error', 'วันที่ทำงานเป็นวันในอนาคต'));
    if (emp && out.employee_id && ((emp.hire_date && d < emp.hire_date) || (emp.termination_date && d > emp.termination_date))) issues.push(issue('not_employed', 'error', 'วันที่อยู่นอกช่วงการจ้างงานของพนักงาน'));
    const lock = locked.find((l) => l.start_date <= d && l.end_date >= d);
    if (lock) issues.push(issue('period_locked', 'error', `วันที่อยู่ในงวดเงินเดือน ${lock.code} ที่คำนวณแล้ว (${lock.status}) ต้องเปิดแก้ไขงวดก่อน`));
    if (!issues.some((i) => i.level === 'error') && out.employee_id) {
      const key = `${out.employee_id}|${d}`;
      if (seen.has(key)) issues.push(issue('duplicate_in_file', 'info', 'ซ้ำกับแถวก่อนหน้าในไฟล์นี้ (พนักงานและวันที่เดียวกัน)'));
      else if (acceptedKeys.has(key)) issues.push(issue('duplicate_existing', 'info', 'วันนี้ของพนักงานเคยนำเข้าจาก Feishu แล้ว'));
      else if (hasPunch(p) && recordKeys.has(key)) issues.push(issue('duplicate_existing', 'info', 'มีบันทึกเวลาของพนักงานในวันนี้อยู่แล้ว (ไม่เขียนทับ)'));
      seen.add(key);
      if (hasPunch(p)) out.attendance_status = p.day.clock_in?.result === 'late_in' ? 'late' : 'present';
    }
    out.status = dailyRowStatus(issues);
    return out;
  });
  return { ...base, sourceRows: parsed.sourceRows, emptyDays: parsed.emptyDays, rows };
}

const CHUNK = 100;
const chunks = <T>(a: readonly T[]): T[][] => Array.from({ length: Math.ceil(a.length / CHUNK) }, (_, i) => a.slice(i * CHUNK, (i + 1) * CHUNK));

/** Statements after the batch row: raw rows, processed attendance, links, events, counts, status and the mapping. */
export function dailyStatements(db: D1Database, key: string, batchId: string, ev: DailyEvaluation, ctx: { companyId: number; fileName: string; userId: number }): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const part of chunks(ev.rows)) {
    const json = JSON.stringify(part.map((r) => ({
      r: r.row_no, c: r.employee_code, e: r.employee_id, d: r.work_date, i: r.clock_in, o: r.clock_out, n: r.out_next_day ? 1 : 0,
      raw: JSON.stringify({
        cell: r.cell, name: r.employee_name, department: r.department, position: r.position, employment_status: r.employment_status, group: r.group, shift: r.shift,
        in: r.day.clock_in, out: r.day.clock_out,
      }),
      st: r.status, is: JSON.stringify(r.issues), ref: r.source_ref, ir: r.day.clock_in?.label ?? (r.day.kind === 'rest' ? 'Break' : null), or: r.day.clock_out?.label ?? (r.day.kind === 'rest' ? 'Break' : null),
    })));
    stmts.push(db.prepare(`INSERT INTO attendance_raw_records (batch_id, row_no, employee_code, employee_id, work_date, clock_in, clock_out, clock_out_next_day, source, raw_json, status, issues_json, source_ref, in_result, out_result)
      SELECT ${batchId}, json_extract(value, '$.r'), json_extract(value, '$.c'), json_extract(value, '$.e'), json_extract(value, '$.d'), json_extract(value, '$.i'), json_extract(value, '$.o'), json_extract(value, '$.n'),
             'Feishu', json_extract(value, '$.raw'), json_extract(value, '$.st'), json_extract(value, '$.is'), json_extract(value, '$.ref'), json_extract(value, '$.ir'), json_extract(value, '$.or')
      FROM json_each(?2)`).bind(key, json));
  }
  const withClock = ev.rows.filter((r) => (r.status === 'valid' || r.status === 'warning') && hasPunch(r));
  for (const part of chunks(withClock)) {
    const json = JSON.stringify(part.map((r) => ({
      e: r.employee_id, d: r.work_date, i: r.clock_in, o: r.clock_out, st: r.attendance_status, n: r.out_next_day ? 1 : 0, l: r.late_minutes, x: r.early_leave_minutes, w: r.worked_minutes,
      note: `นำเข้า Feishu ${ctx.fileName} ช่อง ${r.source_ref}`,
    })));
    stmts.push(db.prepare(`INSERT INTO attendance_records (employee_id, work_date, clock_in, clock_out, status, source, note, created_by, updated_by, import_batch_id, clock_out_next_day, late_minutes, early_leave_minutes, worked_minutes)
      SELECT json_extract(value, '$.e'), json_extract(value, '$.d'), json_extract(value, '$.i'), json_extract(value, '$.o'), json_extract(value, '$.st'), 'import', substr(json_extract(value, '$.note'), 1, 500), ?3, ?3, ${batchId},
             json_extract(value, '$.n'), json_extract(value, '$.l'), json_extract(value, '$.x'), json_extract(value, '$.w')
      FROM json_each(?2) WHERE true
      ON CONFLICT (employee_id, work_date) DO NOTHING`).bind(key, json, ctx.userId));
  }
  // link the rows that created a record; a day saved by someone else in the meantime becomes a duplicate
  stmts.push(db.prepare(`UPDATE attendance_raw_records SET attendance_record_id = (SELECT a.id FROM attendance_records a WHERE a.employee_id = attendance_raw_records.employee_id AND a.work_date = attendance_raw_records.work_date AND a.import_batch_id = attendance_raw_records.batch_id)
    WHERE batch_id = ${batchId} AND status IN ('valid', 'warning') AND (clock_in IS NOT NULL OR clock_out IS NOT NULL)`).bind(key));
  stmts.push(db.prepare(`UPDATE attendance_raw_records SET status = 'duplicate' WHERE batch_id = ${batchId} AND status IN ('valid', 'warning') AND (clock_in IS NOT NULL OR clock_out IS NOT NULL) AND attendance_record_id IS NULL`).bind(key));
  const events = ev.rows.filter((r) => (r.status === 'valid' || r.status === 'warning') && r.day.events.length).flatMap((r) => r.day.events.map((e, i) => ({ r: r.row_no, e: r.employee_id, d: r.work_date, q: i + 1, ev: e })));
  for (const part of chunks(events)) {
    const json = JSON.stringify(part.map((x) => ({ r: x.r, e: x.e, d: x.d, q: x.q, k: x.ev.kind, l: x.ev.label.slice(0, 200), a: x.ev.amount, u: x.ev.unit, g: x.ev.ranges.join(',') || null, ad: x.ev.all_day ? 1 : 0, on: x.ev.overnight ? 1 : 0, raw: x.ev.raw.slice(0, 500) })));
    stmts.push(db.prepare(`INSERT INTO attendance_day_events (batch_id, raw_record_id, employee_id, work_date, seq, kind, label, amount, unit, ranges, all_day, overnight, raw_text)
      SELECT ${batchId}, r.id, json_extract(j.value, '$.e'), json_extract(j.value, '$.d'), json_extract(j.value, '$.q'), json_extract(j.value, '$.k'), json_extract(j.value, '$.l'), json_extract(j.value, '$.a'),
             json_extract(j.value, '$.u'), json_extract(j.value, '$.g'), json_extract(j.value, '$.ad'), json_extract(j.value, '$.on'), json_extract(j.value, '$.raw')
      FROM json_each(?2) j JOIN attendance_raw_records r ON r.batch_id = ${batchId} AND r.row_no = json_extract(j.value, '$.r') AND r.status IN ('valid', 'warning')`).bind(key, json));
  }
  stmts.push(db.prepare(`UPDATE attendance_file_imports SET
      imported_count = (SELECT COUNT(*) FROM attendance_raw_records WHERE batch_id = attendance_file_imports.id AND status IN ('valid', 'warning')),
      warning_count = (SELECT COUNT(*) FROM attendance_raw_records WHERE batch_id = attendance_file_imports.id AND status = 'warning'),
      duplicate_count = (SELECT COUNT(*) FROM attendance_raw_records WHERE batch_id = attendance_file_imports.id AND status = 'duplicate'),
      invalid_count = (SELECT COUNT(*) FROM attendance_raw_records WHERE batch_id = attendance_file_imports.id AND status = 'invalid')
    WHERE idempotency_key = ?1`).bind(key));
  stmts.push(db.prepare(`UPDATE attendance_file_imports SET status = CASE WHEN imported_count = 0 THEN 'failed' WHEN imported_count = total_rows THEN 'completed' ELSE 'partial' END WHERE idempotency_key = ?1`).bind(key));
  stmts.push(db.prepare(`INSERT INTO import_mapping_templates (company_id, import_type, template_code, template_version, header_signature, mapping_json, updated_by) VALUES (?1, 'attendance', ?2, 1, ?3, ?4, ?5)
    ON CONFLICT (company_id, import_type, template_code, header_signature) DO UPDATE SET mapping_json = excluded.mapping_json, updated_at = datetime('now'), updated_by = excluded.updated_by`)
    .bind(ctx.companyId, FEISHU_DAILY_TEMPLATE, ev.signature, JSON.stringify(ev.mapping), ctx.userId));
  return stmts;
}
