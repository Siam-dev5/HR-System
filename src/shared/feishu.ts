// Feishu (Lark) attendance report → normalized attendance rows. Pure functions shared by the SPA (preview) and the
// Worker (authoritative validation). Column names come from real Feishu exports ("Basic information" band +
// header row, English labels, hour values with "(hr)" units). Unknown layouts are handled by an explicit mapping.
import type { Cell } from './xlsx';
import { excelDate } from './xlsx';

export type FieldKind = 'text' | 'date' | 'number';
export interface AttendanceFieldDef {
  key: AttendanceField;
  label: string;
  kind: FieldKind;
  required?: boolean;
  /** hours fields convert other units to hours, absence_minutes converts to minutes */
  unit?: 'hours' | 'minutes' | 'days';
  synonyms: readonly string[];
}

export type AttendanceField =
  | 'employee_code' | 'employee_name' | 'external_department_id' | 'department_name' | 'company_name' | 'hire_date' | 'work_date'
  | 'expected_work_days' | 'expected_work_hours' | 'actual_work_days' | 'actual_work_hours' | 'feishu_overtime_hours'
  | 'absence_days' | 'absence_minutes' | 'unpaid_sick_leave_hours' | 'unpaid_personal_leave_hours';

export const ATTENDANCE_FIELDS: readonly AttendanceFieldDef[] = [
  { key: 'employee_code', label: 'Employee ID (รหัสพนักงาน)', kind: 'text', required: true, synonyms: ['employee id', 'employee no', '工号', 'รหัสพนักงาน', 'employee code'] },
  { key: 'employee_name', label: 'Name (ชื่อ)', kind: 'text', synonyms: ['name', '姓名', 'ชื่อ', 'employee name'] },
  { key: 'external_department_id', label: 'Department ID', kind: 'text', synonyms: ['department id', '部门id', '部门编号', 'department code'] },
  { key: 'department_name', label: 'Department (ชื่อหน่วยงาน)', kind: 'text', synonyms: ['department', '部门', 'หน่วยงาน'] },
  { key: 'company_name', label: 'Contracting company', kind: 'text', synonyms: ['contracting company', '合同公司', 'company'] },
  { key: 'hire_date', label: 'Employment date (วันเริ่มงาน)', kind: 'date', synonyms: ['employment date', '入职日期', 'hire date', 'วันเริ่มงาน'] },
  { key: 'work_date', label: 'Date (รายงานรายวัน)', kind: 'date', synonyms: ['date', '日期'] },
  { key: 'expected_work_days', label: 'Expected working days', kind: 'number', unit: 'days', synonyms: ['expected working days', 'days of expected attendance', '应出勤天数'] },
  { key: 'expected_work_hours', label: 'Expected working hours', kind: 'number', unit: 'hours', synonyms: ['expected working hours', '应出勤时长'] },
  { key: 'actual_work_days', label: 'Workday attendance (วันทำงาน)', kind: 'number', unit: 'days', synonyms: ['workday attendance', 'days of actual attendance', '实际出勤天数', 'actual working days'] },
  { key: 'actual_work_hours', label: 'Actual working hours', kind: 'number', unit: 'hours', synonyms: ['actual working hours', '实际工作时长'] },
  { key: 'feishu_overtime_hours', label: 'Total overtime duration (OT)', kind: 'number', unit: 'hours', synonyms: ['total overtime duration', '加班总时长'] },
  { key: 'absence_days', label: 'Absence days', kind: 'number', unit: 'days', synonyms: ['absence days', '旷工天数'] },
  { key: 'absence_minutes', label: 'Absence hours → นาที', kind: 'number', unit: 'minutes', synonyms: ['absence hours', 'absence duration', '旷工时长'] },
  { key: 'unpaid_sick_leave_hours', label: 'Unpaid sick leave (ชม.)', kind: 'number', unit: 'hours', synonyms: ['unpaid sick leave', 'sick leave(unpaid)', '病假(无薪)', 'ลาป่วยไม่รับค่าจ้าง'] },
  { key: 'unpaid_personal_leave_hours', label: 'Unpaid personal leave (ชม.)', kind: 'number', unit: 'hours', synonyms: ['unpaid personal leave', 'personal leave(unpaid)', '事假(无薪)', 'ลากิจไม่รับค่าจ้าง'] },
];

export const NUMERIC_FIELDS = ATTENDANCE_FIELDS.filter((f) => f.kind === 'number').map((f) => f.key);

/** Header label → comparable key: NFKC (full-width brackets), lower case, unit suffix removed, spacing normalized. */
export function normalizeHeader(label: unknown): { key: string; unit: 'hours' | 'minutes' | 'days' | null } {
  let s = String(label ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  let unit: 'hours' | 'minutes' | 'days' | null = null;
  const m = /\((hr|hrs|hour|hours|h|min|mins|minute|minutes|day|days|d|ชม\.?|นาที|วัน)\)$/.exec(s);
  if (m) {
    const u = m[1] as string;
    unit = /^(min|mins|minute|minutes|นาที)$/.test(u) ? 'minutes' : /^(day|days|d|วัน)$/.test(u) ? 'days' : 'hours';
    s = s.slice(0, m.index).trim();
  }
  s = s.replace(/\s*\(\s*/g, '(').replace(/\s*\)\s*/g, ')').replace(/\s*-\s*/g, ' - ');
  return { key: s, unit };
}

const SYNONYMS = new Map<string, AttendanceField>();
for (const f of ATTENDANCE_FIELDS) for (const s of f.synonyms) SYNONYMS.set(normalizeHeader(s).key, f.key);

export type Mapping = Partial<Record<AttendanceField, number | null>>;
/** Saved profiles map fields to header labels so they survive column re-ordering. */
export type ProfileMapping = Partial<Record<AttendanceField, string>>;

export interface FileIssue {
  code: 'no_header' | 'missing_employee_id' | 'missing_expected' | 'no_rows' | 'too_many_rows';
  message: string;
}

export interface GridAnalysis {
  headerRow: number;
  headers: string[];
  mapping: Mapping;
  format: 'days' | 'hours' | null;
  layout: 'summary' | 'daily';
  sourceStart: string | null;
  sourceEnd: string | null;
  issues: FileIssue[];
}

export const MAX_IMPORT_ROWS = 10_000;

/** Finds the header row (the row naming the employee id column) within the first rows of a sheet. */
export function findHeaderRow(grid: readonly Cell[][]): number {
  for (let i = 0; i < Math.min(grid.length, 15); i++) {
    if ((grid[i] ?? []).some((v) => SYNONYMS.get(normalizeHeader(v).key) === 'employee_code')) return i;
  }
  return -1;
}

export function autoMapping(headers: readonly string[], profile?: ProfileMapping | null): Mapping {
  const mapping: Mapping = {};
  headers.forEach((h, i) => {
    const f = SYNONYMS.get(normalizeHeader(h).key);
    if (f && mapping[f] === undefined) mapping[f] = i;
  });
  if (profile) {
    for (const [field, label] of Object.entries(profile) as Array<[AttendanceField, string]>) {
      const want = normalizeHeader(label).key;
      const idx = headers.findIndex((h) => normalizeHeader(h).key === want);
      if (idx >= 0) mapping[field] = idx;
    }
  }
  return mapping;
}

/** Converts a column mapping into a header-label profile (for saving). */
export function profileFromMapping(headers: readonly string[], mapping: Mapping): ProfileMapping {
  const out: ProfileMapping = {};
  for (const [field, idx] of Object.entries(mapping) as Array<[AttendanceField, number | null]>) {
    if (idx !== null && idx !== undefined && headers[idx]) out[field] = headers[idx];
  }
  return out;
}

const PERIOD_IN_NAME = /(20\d{2})(\d{2})(\d{2})_(20\d{2})(\d{2})(\d{2})/;
const DAY_COLUMN = /^(20\d{2}-\d{2}-\d{2})\b/;

export function analyzeGrid(grid: readonly Cell[][], fileName: string, override?: Mapping | null, profile?: ProfileMapping | null): GridAnalysis {
  const issues: FileIssue[] = [];
  const headerRow = findHeaderRow(grid);
  const headers = headerRow >= 0 ? (grid[headerRow] ?? []).map((v) => (v === null ? '' : String(v).trim())) : [];
  if (headerRow < 0) issues.push({ code: 'no_header', message: 'ไม่พบแถวหัวตารางที่มีคอลัมน์ Employee ID — ไฟล์ไม่ใช่รายงาน Attendance ที่รองรับ หรือหัวตารางผิดรูปแบบ' });
  const mapping: Mapping = { ...autoMapping(headers, profile) };
  if (override) {
    for (const [k, v] of Object.entries(override) as Array<[AttendanceField, number | null]>) {
      if (!ATTENDANCE_FIELDS.some((f) => f.key === k)) continue;
      if (v === null || (Number.isInteger(v) && v >= 0 && v < headers.length)) mapping[k] = v;
    }
  }
  if (headerRow >= 0 && (mapping.employee_code === undefined || mapping.employee_code === null)) {
    issues.push({ code: 'missing_employee_id', message: 'ต้องเลือกคอลัมน์ Employee ID' });
  }
  const has = (f: AttendanceField) => mapping[f] !== undefined && mapping[f] !== null;
  const format = has('expected_work_days') ? 'days' : has('expected_work_hours') ? 'hours' : null;
  if (headerRow >= 0 && !format) issues.push({ code: 'missing_expected', message: 'ไม่พบคอลัมน์ Expected Working Days หรือ Expected Working Hours — ไม่สามารถระบุรูปแบบไฟล์ได้' });

  let sourceStart: string | null = null;
  let sourceEnd: string | null = null;
  const nm = PERIOD_IN_NAME.exec(fileName);
  if (nm) {
    sourceStart = `${nm[1]}-${nm[2]}-${nm[3]}`;
    sourceEnd = `${nm[4]}-${nm[5]}-${nm[6]}`;
  } else {
    const days = headers.map((h) => DAY_COLUMN.exec(h)?.[1]).filter((d): d is string => !!d).sort();
    if (days.length) {
      sourceStart = days[0] as string;
      sourceEnd = days[days.length - 1] as string;
    }
  }
  const dataRows = headerRow >= 0 ? grid.length - headerRow - 1 : 0;
  if (headerRow >= 0 && dataRows <= 0) issues.push({ code: 'no_rows', message: 'ไฟล์ไม่มีข้อมูลพนักงาน' });
  if (dataRows > MAX_IMPORT_ROWS) issues.push({ code: 'too_many_rows', message: `ไฟล์มีมากกว่า ${MAX_IMPORT_ROWS.toLocaleString()} แถว` });
  return { headerRow, headers, mapping, format, layout: has('work_date') ? 'daily' : 'summary', sourceStart, sourceEnd, issues };
}

export type RowIssueCode =
  | 'missing_employee_id' | 'invalid_number' | 'invalid_date' | 'negative_value' | 'duplicate_employee'
  | 'unknown_employee' | 'wrong_company' | 'inactive_employee' | 'hire_date_mismatch' | 'department_mismatch'
  | 'ot_pending' | 'leave_abnormal' | 'outside_period';

export interface RowIssue {
  code: RowIssueCode;
  level: 'error' | 'warning';
  message: string;
}

export interface NormalizedRow {
  rowNo: number;
  values: Partial<Record<AttendanceField, string | number | null>>;
  /** original cells of the header row width, before normalization */
  raw: Cell[];
  issues: RowIssue[];
  /** daily layout: number of day rows aggregated into this row */
  days?: number;
}

function parseNumber(v: Cell): { value: number | null; ok: boolean } {
  if (v === null || v === undefined) return { value: null, ok: true };
  if (typeof v === 'number') return { value: v, ok: Number.isFinite(v) };
  if (typeof v === 'boolean') return { value: null, ok: false };
  const s = v.trim().replace(/,/g, '');
  if (s === '' || s === '-' || s === '--') return { value: null, ok: true };
  const n = Number(s);
  return Number.isFinite(n) ? { value: n, ok: true } : { value: null, ok: false };
}

const DATE_TEXT = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/;
function parseDate(v: Cell): { value: string | null; ok: boolean } {
  if (v === null || v === undefined) return { value: null, ok: true };
  if (typeof v === 'number') return v > 1000 && v < 100_000 ? { value: excelDate(v), ok: true } : { value: null, ok: false };
  const s = String(v).trim();
  if (s === '' || s === '-' || s === '--') return { value: null, ok: true };
  const m = DATE_TEXT.exec(s);
  if (!m) return { value: null, ok: false };
  const iso = `${m[1]}-${(m[2] as string).padStart(2, '0')}-${(m[3] as string).padStart(2, '0')}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? { value: iso, ok: true } : { value: null, ok: false };
}

const round = (n: number, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Normalizes data rows with the mapping: units converted (hours fields → hours, absence → minutes), dates to ISO,
 * "-" to null. Daily reports are aggregated to one row per employee. Format-level checks only; master-data checks
 * (employee / company / department) are done by the Worker.
 */
export function normalizeRows(grid: readonly Cell[][], a: GridAnalysis, hoursPerDay = 8): NormalizedRow[] {
  if (a.headerRow < 0) return [];
  const units = a.headers.map((h) => normalizeHeader(h).unit);
  const out: NormalizedRow[] = [];
  const byCode = new Map<string, NormalizedRow>();
  for (let r = a.headerRow + 1; r < grid.length && out.length <= MAX_IMPORT_ROWS; r++) {
    const cells = grid[r] ?? [];
    if (!cells.some((v) => v !== null && String(v).trim() !== '')) continue;
    const raw = a.headers.map((_, i) => cells[i] ?? null);
    const row: NormalizedRow = { rowNo: r + 1, values: {}, raw, issues: [] };
    for (const f of ATTENDANCE_FIELDS) {
      const idx = a.mapping[f.key];
      if (idx === undefined || idx === null) continue;
      const cell = cells[idx] ?? null;
      if (f.kind === 'text') {
        const t = cell === null ? null : String(cell).trim();
        row.values[f.key] = t === '' || t === '-' ? null : t;
      } else if (f.kind === 'date') {
        const d = parseDate(cell);
        row.values[f.key] = d.value;
        if (!d.ok) row.issues.push({ code: 'invalid_date', level: 'error', message: `${a.headers[idx]}: วันที่ "${String(cell)}" ไม่ถูกต้อง` });
      } else {
        const n = parseNumber(cell);
        if (!n.ok) {
          row.issues.push({ code: 'invalid_number', level: 'error', message: `${a.headers[idx]}: "${String(cell)}" ไม่ใช่ตัวเลข` });
          continue;
        }
        let v = n.value;
        if (v !== null && v < 0) row.issues.push({ code: 'negative_value', level: 'error', message: `${a.headers[idx]}: ค่าติดลบ (${v})` });
        const from = units[idx];
        if (v !== null && f.unit === 'hours') v = from === 'minutes' ? v / 60 : from === 'days' ? v * hoursPerDay : v;
        if (v !== null && f.unit === 'minutes') v = from === 'minutes' ? v : from === 'days' ? v * hoursPerDay * 60 : v * 60;
        row.values[f.key] = v === null ? null : round(v);
      }
    }
    const code = row.values.employee_code;
    if (!code) row.issues.push({ code: 'missing_employee_id', level: 'error', message: 'ไม่มี Employee ID' });
    if (a.layout === 'daily' && code) {
      const prev = byCode.get(String(code));
      if (prev) {
        for (const k of NUMERIC_FIELDS) {
          const add = row.values[k];
          if (typeof add === 'number') prev.values[k] = round((typeof prev.values[k] === 'number' ? (prev.values[k] as number) : 0) + add);
        }
        prev.issues.push(...row.issues);
        prev.days = (prev.days ?? 1) + 1;
        continue;
      }
      row.days = 1;
      byCode.set(String(code), row);
    }
    out.push(row);
  }
  if (a.layout === 'summary') {
    const seen = new Map<string, number>();
    for (const row of out) {
      const code = row.values.employee_code;
      if (!code) continue;
      const first = seen.get(String(code).toUpperCase());
      if (first !== undefined) row.issues.push({ code: 'duplicate_employee', level: 'error', message: `Employee ID ซ้ำกับแถวที่ ${first}` });
      else seen.set(String(code).toUpperCase(), row.rowNo);
    }
  }
  return out;
}

/** Department text from Feishu ("Org | 【运营部】ฝ่ายปฏิบัติการ | …") matches when it names the master department. */
export function departmentMatches(feishu: string | null | undefined, master: { code: string; name: string } | null): boolean {
  if (!feishu || !master) return true;
  const hay = feishu.normalize('NFKC').toLowerCase();
  return hay.includes(master.name.normalize('NFKC').toLowerCase()) || hay.split(/[|\n\r]/).some((p) => p.trim() === master.code.toLowerCase());
}
