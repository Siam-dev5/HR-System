// Feishu "Daily Report" attendance worksheet (template FEISHU_DAILY_ATTENDANCE_V1): one row per employee, one column
// per day, grouped headers over up to three rows ("Basic information" / "Daily attendance result" / "2026-09-26
// Saturday"). Each day cell is turned into one vertical row (employee + work date) without dropping any part of it:
//
//   "Regular(08:58),Regular(18:03)"                                clock-in result(time), clock-out result(time)
//   "Late in9min(09:09),Regular(18:01);Overtime(18:00-20:00)"      ; then the day's events
//   "Leave(-),Leave(-);Sick leave(8 hr,09:00-12:00,13:00-18:00)"   a leave event (amount, unit, time ranges)
//   "Break(-,-)"                                                    rest day
//   "-"                                                             no data for that day (not counted as a row)
//
// A time in brackets is what Feishu recorded for that punch slot. Only "Regular", "Late in", "Early leave", "Leave" and
// "Out-of-office" times become clock times; a "No record(10:27)" keeps its time in the raw data but is not used as a
// clock time, and "No record" is never turned into an absence. Nothing is invented when the file has no time.
import type { Cell } from './xlsx';

export const FEISHU_DAILY_TEMPLATE = 'FEISHU_DAILY_ATTENDANCE_V1';

export type DailyField = 'employee_code' | 'employee_name' | 'department' | 'position' | 'employment_status' | 'group' | 'shift';
export interface DailyFieldDef {
  key: DailyField;
  label: string;
  required: boolean;
  aliases: readonly string[];
}
/** Identity columns of the worksheet (the day columns are found from their "YYYY-MM-DD" headers). */
export const DAILY_FIELDS: readonly DailyFieldDef[] = [
  { key: 'employee_code', label: 'รหัสพนักงาน (Employee ID)', required: true, aliases: ['Employee ID', 'Employee No.', 'รหัสพนักงาน', '工号'] },
  { key: 'employee_name', label: 'ชื่อพนักงาน (Employee Name)', required: false, aliases: ['Name', 'Employee Name', 'ชื่อ', '姓名'] },
  { key: 'department', label: 'หน่วยงาน (Department)', required: false, aliases: ['Department', 'หน่วยงาน', '部门'] },
  { key: 'position', label: 'ตำแหน่ง (Position)', required: false, aliases: ['Job', 'Position', 'ตำแหน่ง', '职务'] },
  { key: 'employment_status', label: 'สถานะการจ้าง (Employment status)', required: false, aliases: ['Employment status', 'สถานะการจ้าง'] },
  { key: 'group', label: 'กลุ่มลงเวลา (Group)', required: false, aliases: ['Group', 'Attendance group', 'กลุ่ม'] },
  { key: 'shift', label: 'กะ (Shift)', required: false, aliases: ['Shift', 'กะ', '班次'] },
];
export type DailyMapping = Partial<Record<DailyField, number | null>>;

const DATE_HEAD = /^(\d{4})-(\d{2})-(\d{2})\b/;
const clean = (v: Cell | undefined) => String(v ?? '').trim();

/** Row of the header that names the days (the last header row); -1 when the worksheet is not a Feishu daily report. */
export function findDailyHeaderRow(grid: readonly Cell[][]): number {
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const row = grid[r] ?? [];
    if (row.some((c) => clean(c) === 'Employee ID') && row.filter((c) => DATE_HEAD.test(clean(c))).length >= 1) return r;
  }
  return -1;
}

/** The day columns of the header row: column index and ISO date. */
export function dayColumns(header: readonly Cell[]): Array<{ col: number; date: string }> {
  const out: Array<{ col: number; date: string }> = [];
  header.forEach((c, col) => {
    const m = DATE_HEAD.exec(clean(c));
    if (m) out.push({ col, date: `${m[1]}-${m[2]}-${m[3]}` });
  });
  return out;
}

/** Identity columns by header name (exact text first, then case-insensitive); a remembered mapping wins when it fits. */
export function autoDailyMapping(header: readonly Cell[], remembered?: DailyMapping | null): DailyMapping {
  if (remembered && dailyMappingProblems(remembered, header.length, dayColumns(header).map((d) => d.col)).length === 0) return { ...remembered };
  const labels = header.map(clean);
  const m: DailyMapping = {};
  const used = new Set<number>();
  for (const pass of [(a: string, l: string) => a === l, (a: string, l: string) => a.toLowerCase() === l.toLowerCase()]) {
    for (const f of DAILY_FIELDS) {
      if (m[f.key] !== undefined) continue;
      const i = labels.findIndex((l, idx) => !used.has(idx) && f.aliases.some((a) => pass(a, l)));
      if (i >= 0) { m[f.key] = i; used.add(i); }
    }
  }
  return m;
}

export function dailyMappingProblems(m: DailyMapping, width: number, dayCols: readonly number[]): string[] {
  const out: string[] = [];
  const used = new Map<number, string>();
  for (const f of DAILY_FIELDS) {
    const col = m[f.key];
    if (col === undefined || col === null) {
      if (f.required) out.push(`ยังไม่ได้เลือกคอลัมน์สำหรับ ${f.label}`);
      continue;
    }
    if (!Number.isInteger(col) || col < 0 || col >= width) out.push(`คอลัมน์ของ ${f.label} ไม่ถูกต้อง`);
    else if (dayCols.includes(col)) out.push(`${f.label} ใช้คอลัมน์ของวันที่`);
    else if (used.has(col)) out.push(`${f.label} ใช้คอลัมน์เดียวกับ ${used.get(col)}`);
    else used.set(col, f.label);
  }
  if (!dayCols.length) out.push('ไม่พบคอลัมน์วันที่ (หัวตารางรูปแบบ YYYY-MM-DD)');
  return out;
}

// ---- one day cell ------------------------------------------------------------------------------
export type PunchResult = 'regular' | 'late_in' | 'early_leave' | 'no_record' | 'leave' | 'out_of_office' | 'pending' | 'break' | 'other';
export const PUNCH_LABEL: Record<PunchResult, string> = {
  regular: 'ปกติ', late_in: 'มาสาย', early_leave: 'ออกก่อน', no_record: 'ไม่มีบันทึก (No record)', leave: 'ลา', out_of_office: 'ปฏิบัติงานนอกสถานที่',
  pending: 'รอผล (Pending)', break: 'วันหยุด', other: 'อื่น ๆ',
};
export interface Punch {
  result: PunchResult;
  /** the label as written in the file, e.g. "Late in9min" */
  label: string;
  /** the time in brackets, when there is one */
  time: string | null;
  /** minutes from "Late inNmin" / "Early leaveNmin" */
  minutes: number | null;
}
export type DayEventKind = 'leave' | 'overtime' | 'out_of_office' | 'break_punch' | 'other';
export interface DayEvent {
  kind: DayEventKind;
  label: string;
  amount: number | null;
  unit: 'hour' | 'day' | 'minute' | null;
  /** "09:00-12:00" ranges as written */
  ranges: string[];
  all_day: boolean;
  /** an overtime / out-of-office range that ends on the next day */
  overnight: boolean;
  raw: string;
}
export type DayKind = 'work' | 'rest' | 'empty';
export interface ParsedDay {
  kind: DayKind;
  clock_in: Punch | null;
  clock_out: Punch | null;
  events: DayEvent[];
  /** parts of the cell that could not be read (kept so nothing is silently dropped) */
  unreadable: string[];
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const RANGE = /^([01]?\d|2[0-3]):([0-5]\d)-([01]?\d|2[0-4]):([0-5]\d)$/;
/** clock times are used only from these results */
export const CLOCK_RESULTS: ReadonlySet<PunchResult> = new Set(['regular', 'late_in', 'early_leave', 'leave', 'out_of_office']);

/** Splits on a separator outside brackets (ASCII or full-width). */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '（') depth++;
    else if ((ch === ')' || ch === '）') && depth > 0) depth--;
    if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x !== '');
}

/** "Label(details)" with the details in the last ASCII bracket pair at the end ("ลากิจ (กำหนด)(4 hr,13:00-18:00)"). */
function labelled(s: string): { label: string; details: string } | null {
  if (!s.endsWith(')')) return null;
  const open = s.lastIndexOf('(');
  if (open <= 0) return null;
  return { label: s.slice(0, open).trim(), details: s.slice(open + 1, -1).trim() };
}

function punchResult(label: string): { result: PunchResult; minutes: number | null } {
  const l = label.trim();
  if (/^regular$/i.test(l)) return { result: 'regular', minutes: null };
  let m = /^late in\s*(\d+)\s*min/i.exec(l);
  if (m) return { result: 'late_in', minutes: Number(m[1]) };
  m = /^(?:early leave|leave early|early out)\s*(\d+)\s*min/i.exec(l);
  if (m) return { result: 'early_leave', minutes: Number(m[1]) };
  if (/^no record$/i.test(l)) return { result: 'no_record', minutes: null };
  if (/^leave$/i.test(l)) return { result: 'leave', minutes: null };
  if (/^out-of-office$/i.test(l)) return { result: 'out_of_office', minutes: null };
  if (/^pending$/i.test(l)) return { result: 'pending', minutes: null };
  if (/^break$/i.test(l)) return { result: 'break', minutes: null };
  return { result: 'other', minutes: null };
}

function punch(part: string): Punch | null {
  const x = labelled(part);
  if (!x) return null;
  const { result, minutes } = punchResult(x.label);
  const t = TIME.exec(x.details);
  return { result, label: x.label, time: t ? `${t[1]!.padStart(2, '0')}:${t[2]}` : null, minutes };
}

const overnightRange = (r: string) => {
  const m = RANGE.exec(r);
  return !!m && Number(m[3]) * 60 + Number(m[4]) < Number(m[1]) * 60 + Number(m[2]);
};

function event(part: string): DayEvent | null {
  const x = labelled(part);
  if (!x) return null;
  const tokens = splitTop(x.details, ',');
  let amount: number | null = null;
  let unit: DayEvent['unit'] = null;
  const ranges: string[] = [];
  let allDay = false;
  for (const t of tokens) {
    const a = /^(\d+(?:\.\d+)?)\s*(hr|hrs|hour|hours|h|day|days|min|mins|minutes)$/i.exec(t);
    if (a && amount === null) {
      amount = Number(a[1]);
      unit = /^d/i.test(a[2]!) ? 'day' : /^m/i.test(a[2]!) ? 'minute' : 'hour';
    } else if (RANGE.test(t)) ranges.push(t);
    else if (/^all day/i.test(t)) allDay = true;
  }
  const label = x.label;
  const kind: DayEventKind = /^overtime$/i.test(label) ? 'overtime'
    : /^out-of-office$/i.test(label) ? 'out_of_office'
    : /^clock in\/out for breaks$/i.test(label) ? 'break_punch'
    : amount !== null || allDay ? 'leave' : 'other';
  return { kind, label, amount, unit, ranges, all_day: allDay, overnight: (kind === 'overtime' || kind === 'out_of_office') && ranges.some(overnightRange), raw: part };
}

/** Reads one day cell of the worksheet. */
export function parseDayCell(v: Cell): ParsedDay {
  const s = clean(v);
  const day: ParsedDay = { kind: 'empty', clock_in: null, clock_out: null, events: [], unreadable: [] };
  if (s === '' || s === '-') return day;
  const [first = '', ...rest] = splitTop(s, ';');
  const head = splitTop(first, ',');
  const one = head.length === 1 ? labelled(head[0]!) : null;
  if (one && /^break$/i.test(one.label)) day.kind = 'rest';
  else if (one && /^clock in\/out for breaks$/i.test(one.label)) {
    day.kind = 'work';
    const e = event(head[0]!);
    if (e) day.events.push(e);
  } else if (head.length === 2) {
    day.kind = 'work';
    day.clock_in = punch(head[0]!);
    day.clock_out = punch(head[1]!);
    if (!day.clock_in) day.unreadable.push(head[0]!);
    if (!day.clock_out) day.unreadable.push(head[1]!);
  } else {
    // the first part is an event on its own (no punch pair)
    rest.unshift(first);
    day.kind = 'work';
  }
  for (const part of rest) {
    const e = event(part);
    if (e) day.events.push(e);
    else day.unreadable.push(part);
  }
  return day;
}

/** The clock time a punch contributes to processed attendance (null for No record / Pending / Break / unknown). */
export const clockTime = (p: Punch | null): string | null => (p && CLOCK_RESULTS.has(p.result) ? p.time : null);

// ---- rows --------------------------------------------------------------------------------------
export type DailyIssueCode =
  | 'missing_employee' | 'unreadable_cell' | 'unknown_result' | 'no_record_in' | 'no_record_out' | 'no_record_time_kept' | 'pending_out'
  | 'missing_clock_in' | 'missing_clock_out' | 'late' | 'early_leave' | 'leave' | 'overtime' | 'out_of_office' | 'rest_day'
  | 'unknown_employee' | 'wrong_company' | 'missing_company' | 'company_unmatched' | 'company_conflict' | 'attendance_exempt' | 'future_date' | 'not_employed' | 'period_locked' | 'duplicate_in_file' | 'duplicate_existing';
export interface DailyIssue {
  code: DailyIssueCode;
  level: 'error' | 'warning' | 'info';
  message: string;
}
export interface DailyRow {
  /** 1-based sequence of the vertical rows (unique per import) */
  row_no: number;
  /** sheet cell the day came from, e.g. "J5" */
  source_ref: string;
  /** 0-based row of the worksheet the day came from */
  source_row: number;
  employee_code: string | null;
  employee_name: string | null;
  department: string | null;
  position: string | null;
  employment_status: string | null;
  group: string | null;
  shift: string | null;
  work_date: string;
  cell: string;
  day: ParsedDay;
  clock_in: string | null;
  clock_out: string | null;
  out_next_day: boolean;
  late_minutes: number | null;
  early_leave_minutes: number | null;
  worked_minutes: number | null;
  issues: DailyIssue[];
}

const colName = (i: number): string => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};
const text = (v: Cell | undefined): string | null => {
  const s = clean(v);
  return s ? s.slice(0, 200) : null;
};
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fmtMin = (n: number) => (n >= 60 ? `${Math.floor(n / 60)} ชม. ${n % 60 ? `${n % 60} นาที` : ''}`.trim() : `${n} นาที`);

/** Turns the worksheet into one row per employee and day; empty days ("-" or blank) are counted, not returned. */
export function parseDailyRows(grid: readonly Cell[][], headerRow: number, m: DailyMapping): { rows: DailyRow[]; sourceRows: number; emptyDays: number } {
  const header = grid[headerRow] ?? [];
  const days = dayColumns(header);
  const rows: DailyRow[] = [];
  let sourceRows = 0;
  let emptyDays = 0;
  const at = (row: readonly Cell[], col: number | null | undefined) => (col === null || col === undefined ? null : text(row[col]));
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    if (row.every((c) => c === null || clean(c) === '')) continue;
    sourceRows++;
    const code = at(row, m.employee_code);
    const base = {
      employee_code: code, employee_name: at(row, m.employee_name), department: at(row, m.department), position: at(row, m.position),
      employment_status: at(row, m.employment_status), group: at(row, m.group), shift: at(row, m.shift),
    };
    for (const { col, date } of days) {
      const cell = clean(row[col]).slice(0, 1000);
      const day = parseDayCell(cell);
      if (day.kind === 'empty') { emptyDays++; continue; }
      const issues: DailyIssue[] = [];
      if (!code) issues.push({ code: 'missing_employee', level: 'error', message: 'ไม่มีรหัสพนักงาน' });
      for (const u of day.unreadable) issues.push({ code: 'unreadable_cell', level: 'error', message: `อ่านข้อมูลไม่ได้: ${u.slice(0, 80)}` });
      const cin = clockTime(day.clock_in);
      const cout = clockTime(day.clock_out);
      for (const [p, side] of [[day.clock_in, 'เข้า'], [day.clock_out, 'ออก']] as const) {
        if (!p) continue;
        if (p.result === 'other') issues.push({ code: 'unknown_result', level: 'warning', message: `ผลการลงเวลา${side}ที่ระบบไม่รู้จัก: ${p.label}` });
        if (p.result === 'no_record') {
          issues.push({ code: side === 'เข้า' ? 'no_record_in' : 'no_record_out', level: 'warning', message: `ไม่มีบันทึกเวลา${side} (No record) — ไม่ถือเป็นขาดงาน` });
          if (p.time) issues.push({ code: 'no_record_time_kept', level: 'info', message: `Feishu แสดงเวลา ${p.time} แต่ไม่นับเป็นเวลา${side} (เก็บไว้ในข้อมูลต้นฉบับ)` });
        }
        if (p.result === 'pending') issues.push({ code: 'pending_out', level: 'warning', message: `เวลา${side}ยังรอผล (Pending)` });
      }
      if (day.kind === 'work' && day.clock_in && !cin && day.clock_in.result !== 'no_record' && cout) issues.push({ code: 'missing_clock_in', level: 'warning', message: 'ไม่มีเวลาเข้างาน' });
      if (day.kind === 'work' && cin && !cout && day.clock_out?.result !== 'no_record' && day.clock_out?.result !== 'pending') issues.push({ code: 'missing_clock_out', level: 'warning', message: 'ไม่มีเวลาออกงาน' });
      const late = day.clock_in?.result === 'late_in' ? day.clock_in.minutes : null;
      const early = day.clock_out?.result === 'early_leave' ? day.clock_out.minutes : null;
      if (late) issues.push({ code: 'late', level: 'info', message: `มาสาย ${fmtMin(late)} (ตาม Feishu)` });
      if (early) issues.push({ code: 'early_leave', level: 'info', message: `ออกก่อน ${fmtMin(early)} (ตาม Feishu)` });
      for (const e of day.events) {
        if (e.kind === 'leave') issues.push({ code: 'leave', level: 'info', message: `${e.label}${e.amount !== null ? ` ${e.amount} ${e.unit === 'day' ? 'วัน' : e.unit === 'minute' ? 'นาที' : 'ชม.'}` : ''}${e.all_day ? ' ทั้งวัน' : ''}${e.ranges.length ? ` (${e.ranges.join(', ')})` : ''}` });
        if (e.kind === 'overtime') issues.push({ code: 'overtime', level: 'info', message: `OT ${e.ranges.join(', ')}${e.overnight ? ' (ข้ามวัน)' : ''} — ข้อมูลประกอบ ไม่คำนวณเงิน` });
        if (e.kind === 'out_of_office') issues.push({ code: 'out_of_office', level: 'info', message: `ปฏิบัติงานนอกสถานที่ ${e.ranges.join(', ')}` });
      }
      if (day.kind === 'rest') issues.push({ code: 'rest_day', level: 'info', message: 'วันหยุดตามกะ (Break)' });
      let worked: number | null = null;
      let next = false;
      if (cin && cout) {
        let span = minutesOf(cout) - minutesOf(cin);
        if (span < 0) { span += 1440; next = true; }
        worked = span;
      }
      rows.push({
        row_no: rows.length + 1, source_ref: `${colName(col)}${r + 1}`, source_row: r, ...base, work_date: date, cell, day,
        clock_in: cin, clock_out: cout, out_next_day: next, late_minutes: late, early_leave_minutes: early, worked_minutes: worked, issues,
      });
    }
  }
  return { rows, sourceRows, emptyDays };
}
