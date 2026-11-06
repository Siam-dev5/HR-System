// Time-clock file import (XLSX / XLS / CSV from a scanner or another system): the system fields, header detection
// and column mapping, and parsing of one row into a work date and clock times. Checks that need the database
// (employee, company, duplicates, payroll periods, shift) run in the Worker: src/worker/lib/clock-import.ts.
import { excelDate, type Cell } from './xlsx';

export type ClockField = 'employee_code' | 'work_date' | 'clock_in' | 'clock_out' | 'device' | 'source' | 'remark';
export interface ClockFieldDef {
  key: ClockField;
  label: string;
  required: boolean;
  aliases: readonly string[];
}

export const CLOCK_FIELDS: readonly ClockFieldDef[] = [
  { key: 'employee_code', label: 'รหัสพนักงาน (Employee Code)', required: true, aliases: ['employee code', 'employee id', 'emp code', 'emp id', 'empcode', 'emp no', 'staff id', 'staff code', 'person id', 'user id', 'userid', 'ac no', 'acno', 'enroll no', 'รหัสพนักงาน', 'รหัส', 'เลขที่พนักงาน'] },
  { key: 'work_date', label: 'วันที่ทำงาน (Work Date)', required: true, aliases: ['work date', 'date', 'attendance date', 'วันที่', 'วันที่ทำงาน', 'วันทำงาน'] },
  { key: 'clock_in', label: 'เวลาเข้างาน (Clock In)', required: true, aliases: ['clock in', 'clockin', 'time in', 'in', 'check in', 'checkin', 'on duty', 'เวลาเข้า', 'เวลาเข้างาน', 'เข้างาน', 'สแกนเข้า'] },
  { key: 'clock_out', label: 'เวลาออกงาน (Clock Out)', required: false, aliases: ['clock out', 'clockout', 'time out', 'out', 'check out', 'checkout', 'off duty', 'เวลาออก', 'เวลาออกงาน', 'ออกงาน', 'สแกนออก'] },
  { key: 'device', label: 'เครื่องบันทึกเวลา (Check-in Device)', required: false, aliases: ['device', 'check in device', 'terminal', 'machine', 'device name', 'device id', 'เครื่อง', 'เครื่องบันทึกเวลา', 'เครื่องสแกน'] },
  { key: 'source', label: 'แหล่งข้อมูล (Source)', required: false, aliases: ['source', 'data source', 'แหล่งข้อมูล', 'ที่มา'] },
  { key: 'remark', label: 'หมายเหตุ (Remark)', required: false, aliases: ['remark', 'remarks', 'note', 'notes', 'comment', 'หมายเหตุ'] },
];

export type ClockMapping = Partial<Record<ClockField, number | null>>;
export const MAX_CLOCK_ROWS = 10_000;
export const MAX_CLOCK_FILE_BYTES = 15 * 1024 * 1024;
export const CLOCK_FILE_TYPES = ['xlsx', 'xls', 'csv'] as const;
export type ClockFileType = (typeof CLOCK_FILE_TYPES)[number];

export function normalizeLabel(v: unknown): string {
  return String(v ?? '')
    .toLowerCase()
    .replace(/[()[\]{}._:/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const ALIAS = new Map<string, ClockField>(CLOCK_FIELDS.flatMap((f) => f.aliases.map((a) => [normalizeLabel(a), f.key] as const)));

/** First row (of the first 20) that names at least two system fields; 0 when none does. */
export function findClockHeaderRow(grid: readonly Cell[][]): number {
  for (let r = 0; r < Math.min(grid.length, 20); r++) {
    const hits = new Set((grid[r] ?? []).map((c) => ALIAS.get(normalizeLabel(c))).filter(Boolean));
    if (hits.size >= 2) return r;
  }
  return 0;
}

export function headerLabels(grid: readonly Cell[][], headerRow: number): string[] {
  const row = grid[headerRow] ?? [];
  const width = Math.max(row.length, ...grid.slice(headerRow, headerRow + 50).map((r) => r.length));
  return Array.from({ length: width }, (_, i) => String(row[i] ?? '').trim());
}

/** Text that identifies a file layout (its normalised header row); the Worker stores its SHA-256. */
export function layoutSignature(headers: readonly string[]): string {
  return headers.map(normalizeLabel).join('|');
}

/** Columns matched by header name; a remembered mapping wins when it still fits the file. */
export function autoClockMapping(headers: readonly string[], remembered?: ClockMapping | null): ClockMapping {
  if (remembered && validMapping(remembered, headers.length).length === 0) return { ...remembered };
  const m: ClockMapping = {};
  headers.forEach((hd, i) => {
    const key = ALIAS.get(normalizeLabel(hd));
    if (key && m[key] === undefined) m[key] = i;
  });
  return m;
}

/** Problems with a mapping (required fields missing, a column used twice, out of range). */
export function validMapping(m: ClockMapping, width: number): string[] {
  const out: string[] = [];
  const used = new Map<number, ClockField>();
  for (const f of CLOCK_FIELDS) {
    const col = m[f.key];
    if (col === undefined || col === null) {
      if (f.required) out.push(`ยังไม่ได้เลือกคอลัมน์สำหรับ ${f.label}`);
      continue;
    }
    if (!Number.isInteger(col) || col < 0 || col >= width) out.push(`คอลัมน์ของ ${f.label} ไม่ถูกต้อง`);
    else if (used.has(col)) out.push(`${f.label} ใช้คอลัมน์เดียวกับ ${CLOCK_FIELDS.find((x) => x.key === used.get(col))!.label}`);
    else used.set(col, f.key);
  }
  return out;
}

// ---- cell parsing ------------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0');
function isoDate(y: number, m: number, d: number): string | null {
  if (y > 2400) y -= 543; // Buddhist year
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** A date cell: Excel serial, YYYY-MM-DD / YYYY/MM/DD, DD/MM/YYYY (Thai order, Buddhist years accepted), YYYYMMDD. */
export function parseDateCell(v: Cell): string | null {
  if (v === null || v === '' || typeof v === 'boolean') return null;
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 19000101 && v <= 29991231) return isoDate(Math.floor(v / 10000), Math.floor(v / 100) % 100, v % 100);
    return v >= 1 && v < 2958466 ? excelDate(Math.floor(v)) : null;
  }
  const s = v.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T].*)?$/.exec(s);
  if (m) return isoDate(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:[ T].*)?$/.exec(s);
  if (m) return isoDate(+m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m) return isoDate(+m[1]!, +m[2]!, +m[3]!);
  if (/^\d+(\.\d+)?$/.test(s)) return parseDateCell(Number(s));
  return null;
}

/**
 * A time cell: "HH:MM[:SS]", "H.MM", "8:05 PM", a fraction of a day, or a date-time ("2026-11-06 22:00", an Excel
 * date-time serial). Seconds are dropped. Returns the time and, for a date-time, its date. "24:00" is midnight of
 * the next day.
 */
export function parseTimeCell(v: Cell): { time: string; date: string | null } | null {
  if (v === null || v === '' || typeof v === 'boolean') return null;
  if (typeof v === 'number') {
    if (v < 0 || v >= 2958466) return null;
    const day = Math.floor(v);
    const mins = Math.floor(Math.round((v - day) * 86400) / 60);
    const t = `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
    return { time: t, date: day >= 1 ? excelDate(day) : null };
  }
  const s = v.trim();
  const dt = /^(\S+)[ T](\d{1,2}[:.]\d{2}(?:[:.]\d{2})?(?:\s*[ap]\.?m\.?)?)$/i.exec(s);
  if (dt) {
    const date = parseDateCell(dt[1]!);
    const t = parseTimeCell(dt[2]!);
    return date && t ? { time: t.time, date } : null;
  }
  const m = /^(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?\s*([ap])?\.?(m\.?)?$/i.exec(s);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ap = m[4]?.toLowerCase();
  if (ap) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (ap === 'p' ? 12 : 0);
  }
  if (h === 24 && min === 0) return { time: '24:00', date: null };
  if (h > 23 || min > 59) return null;
  return { time: `${pad(h)}:${pad(min)}`, date: null };
}

export type ClockIssueCode =
  | 'missing_employee' | 'missing_date' | 'bad_date' | 'missing_clock_in' | 'bad_clock_in' | 'bad_clock_out' | 'out_date_range'
  | 'future_date' | 'unknown_employee' | 'wrong_company' | 'not_employed' | 'period_locked' | 'out_before_in'
  | 'duplicate_in_file' | 'duplicate_existing'
  | 'missing_clock_out' | 'late' | 'early_leave' | 'clock_in_early' | 'clock_out_late' | 'long_day' | 'cross_midnight_unplanned'
  | 'no_shift' | 'day_off' | 'holiday' | 'on_leave' | 'same_file_imported';

export interface ClockIssue {
  code: ClockIssueCode;
  level: 'error' | 'warning' | 'info';
  message: string;
}

export interface ParsedClockRow {
  row_no: number;
  employee_code: string | null;
  work_date: string | null;
  clock_in: string | null;
  clock_out: string | null;
  /** the clock-out cell carried the next day's date (or was "24:00") */
  out_next_day: boolean;
  device: string | null;
  source: string | null;
  remark: string | null;
  raw: Cell[];
  issues: ClockIssue[];
}

const text = (v: Cell | undefined): string | null => {
  if (v === null || v === undefined) return null;
  const s = (typeof v === 'number' && Number.isInteger(v) ? String(v) : String(v)).trim();
  return s ? s.slice(0, 200) : null;
};
const cellOf = (row: readonly Cell[], col: number | null | undefined): Cell => (col === null || col === undefined ? null : (row[col] ?? null));

/** Parses the data rows under the header (blank rows skipped). Row numbers are 1-based rows of the sheet. */
export function parseClockRows(grid: readonly Cell[][], headerRow: number, m: ClockMapping): ParsedClockRow[] {
  const out: ParsedClockRow[] = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    if (row.every((c) => c === null || String(c).trim() === '')) continue;
    const issues: ClockIssue[] = [];
    const code = text(cellOf(row, m.employee_code));
    if (!code) issues.push({ code: 'missing_employee', level: 'error', message: 'ไม่มีรหัสพนักงาน' });
    const rawDate = cellOf(row, m.work_date);
    const tin = parseTimeCell(cellOf(row, m.clock_in));
    let date = parseDateCell(rawDate);
    // a date-time clock-in also gives the work date when the date column is empty
    if (!date && (rawDate === null || rawDate === '') && tin?.date) date = tin.date;
    if (!date) issues.push(rawDate === null || rawDate === '' ? { code: 'missing_date', level: 'error', message: 'ไม่มีวันที่ทำงาน' } : { code: 'bad_date', level: 'error', message: `วันที่ไม่ถูกต้อง: ${String(rawDate).slice(0, 40)}` });
    const rawIn = cellOf(row, m.clock_in);
    if (rawIn === null || rawIn === '') issues.push({ code: 'missing_clock_in', level: 'error', message: 'ไม่มีเวลาเข้างาน' });
    else if (!tin || tin.time === '24:00') issues.push({ code: 'bad_clock_in', level: 'error', message: `เวลาเข้างานไม่ถูกต้อง: ${String(rawIn).slice(0, 40)}` });
    const rawOut = cellOf(row, m.clock_out);
    const tout = rawOut === null || rawOut === '' ? null : parseTimeCell(rawOut);
    if (rawOut !== null && rawOut !== '' && !tout) issues.push({ code: 'bad_clock_out', level: 'error', message: `เวลาออกงานไม่ถูกต้อง: ${String(rawOut).slice(0, 40)}` });
    let outNextDay = false;
    let clockOut = tout?.time ?? null;
    if (tout && clockOut === '24:00') {
      clockOut = '00:00';
      outNextDay = true;
    }
    if (tout?.date && date) {
      const diff = Math.round((Date.parse(`${tout.date}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
      if (diff === 1) outNextDay = true;
      else if (diff !== 0) issues.push({ code: 'out_date_range', level: 'error', message: 'วันที่ของเวลาออกงานต้องเป็นวันเดียวกันหรือวันถัดไปของวันทำงาน' });
    }
    if (tin?.date && date && tin.date !== date) issues.push({ code: 'bad_clock_in', level: 'error', message: 'วันที่ของเวลาเข้างานไม่ตรงกับวันที่ทำงาน' });
    out.push({
      row_no: r + 1,
      employee_code: code,
      work_date: date,
      clock_in: tin && tin.time !== '24:00' ? tin.time : null,
      clock_out: clockOut,
      out_next_day: outNextDay,
      device: text(cellOf(row, m.device)),
      source: text(cellOf(row, m.source)),
      remark: text(cellOf(row, m.remark)),
      raw: row.slice(0, 60).map((c) => (typeof c === 'string' ? c.slice(0, 500) : c)),
      issues,
    });
  }
  return out;
}

export type ClockRowStatus = 'valid' | 'warning' | 'duplicate' | 'invalid';
export const CLOCK_STATUS_LABEL: Record<ClockRowStatus, string> = { valid: 'ผ่าน', warning: 'ผ่าน (มีคำเตือน)', duplicate: 'ซ้ำ', invalid: 'ไม่ถูกต้อง' };

/** Status of a row from its issues: any error → invalid, a duplicate → duplicate, any warning → warning. */
export function rowStatus(issues: readonly ClockIssue[]): ClockRowStatus {
  if (issues.some((i) => i.level === 'error')) return 'invalid';
  if (issues.some((i) => i.code === 'duplicate_in_file' || i.code === 'duplicate_existing')) return 'duplicate';
  if (issues.some((i) => i.level === 'warning')) return 'warning';
  return 'valid';
}

/** File type from the first bytes (the extension alone is not trusted). */
export function sniffFileType(bytes: Uint8Array): 'xlsx' | 'xls' | 'text' | 'unknown' {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'xlsx';
  if ([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => bytes[i] === b)) return 'xls';
  const head = bytes.subarray(0, 4096);
  // text: no NUL bytes outside a UTF-16 BOM file
  if (head.length && !head.some((b) => b === 0)) return 'text';
  return 'unknown';
}
