// Feishu approval exports for leave (FEISHU_LEAVE_V1) and overtime (FEISHU_OVERTIME_V1) worksheets: a filter line in
// row 1, the header in row 2, one request per row. An overtime request split over several days has one row per
// detail ("Overtime Details1", "Overtime Details2") that repeats the request columns; a row is identified by the
// Request No. and the detail number. Request-level and detail-level columns differ only in case ("Start time" /
// "Start Time"), so header names are matched exactly before any case-insensitive match.
//
// The approval status is read, never decided: an unknown status is an error, a pending request stays pending.
import { excelDate, type Cell } from './xlsx';

export type RequestImportType = 'leave' | 'overtime';
export const REQUEST_TEMPLATES: Record<RequestImportType, string> = { leave: 'FEISHU_LEAVE_V1', overtime: 'FEISHU_OVERTIME_V1' };
export const REQUEST_TYPE_LABEL: Record<RequestImportType, string> = { leave: 'ข้อมูลการลา', overtime: 'ข้อมูล OT' };

export interface RequestFieldDef {
  key: string;
  label: string;
  required: boolean;
  /** header names as Feishu writes them (matched exactly first, then ignoring case) */
  aliases: readonly string[];
}

const COMMON: readonly RequestFieldDef[] = [
  { key: 'request_no', label: 'เลขที่คำขอ (Request ID)', required: true, aliases: ['Request No.', 'Request ID', 'Request No', 'Approval No.', 'เลขที่คำขอ', '审批编号'] },
  { key: 'employee_code', label: 'รหัสพนักงาน (Employee ID)', required: true, aliases: ["Requester's Employee No.", 'Employee No.', 'Employee ID', 'รหัสพนักงาน', '工号'] },
  { key: 'employee_name', label: 'ชื่อพนักงาน (Employee Name)', required: false, aliases: ["Requester's name", 'Employee Name', 'Name', 'ชื่อพนักงาน', '姓名'] },
  { key: 'department', label: 'หน่วยงาน (Department)', required: false, aliases: ['Initiator department', 'Department', 'หน่วยงาน', '部门'] },
  { key: 'approval_status', label: 'สถานะการอนุมัติ (Approval Status)', required: true, aliases: ['Status', 'Approval Status', 'สถานะ', '审批状态'] },
  { key: 'approver', label: 'ผู้อนุมัติ (Approver)', required: false, aliases: ['Previous approver(s)', 'Approver', 'ผู้อนุมัติ', '审批人'] },
  { key: 'submitted_at', label: 'วันที่สร้างคำขอ (Created Date)', required: false, aliases: ['Submitted at', 'Created Date', 'Created at', 'วันที่สร้าง', '提交时间'] },
  { key: 'completed_at', label: 'วันที่อนุมัติเสร็จ (Completed at)', required: false, aliases: ['Completed at', 'วันที่เสร็จสิ้น', '完成时间'] },
];

export const LEAVE_FIELDS: readonly RequestFieldDef[] = [
  ...COMMON,
  { key: 'leave_type', label: 'ประเภทการลา (Leave Type)', required: true, aliases: ['Leave type', 'Leave Type', 'ประเภทการลา', '假期类型'] },
  { key: 'start_at', label: 'วันเวลาเริ่ม (Start Date / Time)', required: true, aliases: ['Start time', 'Start Time', 'Start Date', 'เริ่ม', '开始时间'] },
  { key: 'end_at', label: 'วันเวลาสิ้นสุด (End Date / Time)', required: true, aliases: ['End time', 'End Time', 'End Date', 'สิ้นสุด', '结束时间'] },
  { key: 'duration', label: 'จำนวนวัน / ชั่วโมงที่ลา (Leave Days / Hours)', required: true, aliases: ['Duration', 'Leave Duration', 'จำนวน', '时长'] },
  { key: 'unit', label: 'หน่วย (Leave unit)', required: false, aliases: ['Leave unit', 'Unit', 'หน่วย', '请假单位'] },
  { key: 'reason', label: 'เหตุผล (Reason)', required: false, aliases: ['Reason for leave', 'Reason', 'เหตุผล', '请假事由'] },
];

export const OVERTIME_FIELDS: readonly RequestFieldDef[] = [
  ...COMMON,
  { key: 'start_at', label: 'เวลาเริ่ม OT (OT Start)', required: true, aliases: ['Start time', 'OT Start', 'เวลาเริ่ม', '开始时间'] },
  { key: 'end_at', label: 'เวลาสิ้นสุด OT (OT End)', required: true, aliases: ['End time', 'OT End', 'เวลาสิ้นสุด', '结束时间'] },
  { key: 'hours', label: 'ชั่วโมง OT ของคำขอ (OT Hours)', required: true, aliases: ['Overtime hours', 'OT Hours', 'ชั่วโมง OT', '加班时长'] },
  { key: 'unit', label: 'หน่วย (Duration Unit)', required: false, aliases: ['Duration Unit', 'Unit', 'หน่วย'] },
  { key: 'reason', label: 'เหตุผล (Reason)', required: false, aliases: ['Reason for overtime', 'Reason', 'เหตุผล', '加班事由'] },
  { key: 'detail_label', label: 'รายการย่อย (Overtime Details)', required: false, aliases: ['Overtime Details'] },
  { key: 'work_date', label: 'วันที่ทำ OT (Work Date)', required: false, aliases: ['Start Time', 'Work Date', 'วันที่ทำงาน'] },
  { key: 'detail_hours', label: 'ชั่วโมง OT ของวันนั้น (Overtime Duration)', required: false, aliases: ['Overtime Duration'] },
  { key: 'ot_type', label: 'ประเภท OT (Overtime Type)', required: false, aliases: ['Overtime Type'] },
  { key: 'date_type', label: 'ประเภทวัน (Date Type)', required: false, aliases: ['Date Type'] },
];

export const REQUEST_FIELDS: Record<RequestImportType, readonly RequestFieldDef[]> = { leave: LEAVE_FIELDS, overtime: OVERTIME_FIELDS };
export type RequestMapping = Record<string, number | null>;

const clean = (v: Cell | undefined) => String(v ?? '').trim();

/** What a worksheet looks like: which approval export (if any) and where its header is. */
export function detectRequestSheet(grid: readonly Cell[][]): { type: RequestImportType | null; headerRow: number } {
  for (let r = 0; r < Math.min(grid.length, 10); r++) {
    const labels = (grid[r] ?? []).map(clean);
    if (!labels.includes('Request No.') && !labels.includes('Request ID')) continue;
    if (labels.includes('Leave type') || labels.includes('Leave Type')) return { type: 'leave', headerRow: r };
    if (labels.includes('Overtime hours') || labels.includes('Overtime Details')) return { type: 'overtime', headerRow: r };
    return { type: null, headerRow: r };
  }
  return { type: null, headerRow: -1 };
}

export function requestHeaders(grid: readonly Cell[][], headerRow: number): string[] {
  const row = grid[headerRow] ?? [];
  const width = Math.max(row.length, ...grid.slice(headerRow, headerRow + 50).map((r) => r.length));
  return Array.from({ length: width }, (_, i) => clean(row[i]));
}

export function autoRequestMapping(type: RequestImportType, headers: readonly string[], remembered?: RequestMapping | null): RequestMapping {
  if (remembered && requestMappingProblems(type, remembered, headers.length).length === 0) return { ...remembered };
  const m: RequestMapping = {};
  const used = new Set<number>();
  for (const pass of [(a: string, l: string) => a === l, (a: string, l: string) => a.toLowerCase() === l.toLowerCase()]) {
    for (const f of REQUEST_FIELDS[type]) {
      if (m[f.key] !== undefined) continue;
      for (const a of f.aliases) {
        const i = headers.findIndex((l, idx) => !used.has(idx) && pass(a, l));
        if (i >= 0) { m[f.key] = i; used.add(i); break; }
      }
    }
  }
  return m;
}

export function requestMappingProblems(type: RequestImportType, m: RequestMapping, width: number): string[] {
  const out: string[] = [];
  const used = new Map<number, string>();
  for (const f of REQUEST_FIELDS[type]) {
    const col = m[f.key];
    if (col === undefined || col === null) {
      if (f.required) out.push(`ยังไม่ได้เลือกคอลัมน์สำหรับ ${f.label}`);
      continue;
    }
    if (!Number.isInteger(col) || col < 0 || col >= width) out.push(`คอลัมน์ของ ${f.label} ไม่ถูกต้อง`);
    else if (used.has(col)) out.push(`${f.label} ใช้คอลัมน์เดียวกับ ${used.get(col)}`);
    else used.set(col, f.label);
  }
  return out;
}

// ---- values ------------------------------------------------------------------------------------
export type ApprovalStatus = 'approved' | 'pending' | 'rejected' | 'cancelled';
export const APPROVAL_LABEL: Record<ApprovalStatus, string> = { approved: 'อนุมัติ', pending: 'รออนุมัติ', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิก' };
const STATUS_WORDS: Record<ApprovalStatus, readonly string[]> = {
  approved: ['approved', 'อนุมัติ', 'อนุมัติแล้ว', '已通过', '通过'],
  pending: ['pending', 'in review', 'under review', 'in progress', 'รออนุมัติ', 'รอการอนุมัติ', '审批中', '待审批'],
  rejected: ['rejected', 'declined', 'ไม่อนุมัติ', 'ปฏิเสธ', '已拒绝', '拒绝'],
  cancelled: ['cancelled', 'canceled', 'withdrawn', 'revoked', 'ยกเลิก', '已撤回', '已撤销', '已取消'],
};
/** The approval status written in the file, or null when it is not one of the known words. */
export function approvalStatus(v: Cell): ApprovalStatus | null {
  const s = clean(v).toLowerCase();
  for (const [k, words] of Object.entries(STATUS_WORDS) as Array<[ApprovalStatus, readonly string[]]>) if (words.includes(s)) return k;
  return null;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n: number) => String(n).padStart(2, '0');
function iso(y: number, mo: number, d: number): string | null {
  if (y > 2400) y -= 543;
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d ? `${y}-${pad(mo)}-${pad(d)}` : null;
}
function hm(h: string | undefined, m: string | undefined): string | null {
  if (h === undefined) return null;
  const H = Number(h);
  const M = Number(m ?? 0);
  return H <= 23 && M <= 59 ? `${pad(H)}:${pad(M)}` : null;
}

/**
 * A date with an optional time: "Oct 01 2026 09:00" (Feishu), "Oct 01 2026", "2026-10-01 09:00", "01/10/2026 09:00"
 * (day first, Buddhist years accepted) or an Excel date-time serial. Returns null when it cannot be read.
 */
export function parseDateTime(v: Cell): { date: string; time: string | null } | null {
  if (v === null || v === '' || typeof v === 'boolean') return null;
  if (typeof v === 'number') {
    if (!(v >= 1 && v < 2958466)) return null;
    const day = Math.floor(v);
    const frac = v - day;
    const mins = Math.round(frac * 1440);
    return { date: excelDate(day), time: frac > 0 ? `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}` : null };
  }
  const s = v.trim();
  let m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})(?: (\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(s);
  if (m) {
    const date = MONTHS[m[1]!.toLowerCase()] ? iso(+m[3]!, MONTHS[m[1]!.toLowerCase()]!, +m[2]!) : null;
    const time = m[4] !== undefined ? hm(m[4], m[5]) : null;
    return date && (m[4] === undefined || time) ? { date, time } : null;
  }
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(s);
  if (m) {
    const date = iso(+m[1]!, +m[2]!, +m[3]!);
    const time = m[4] !== undefined ? hm(m[4], m[5]) : null;
    return date && (m[4] === undefined || time) ? { date, time } : null;
  }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?: (\d{1,2}):(\d{2})(?::\d{2})?)?$/.exec(s);
  if (m) {
    const date = iso(+m[3]!, +m[2]!, +m[1]!);
    const time = m[4] !== undefined ? hm(m[4], m[5]) : null;
    return date && (m[4] === undefined || time) ? { date, time } : null;
  }
  if (/^\d+(\.\d+)?$/.test(s)) return parseDateTime(Number(s));
  return null;
}

const stamp = (x: { date: string; time: string | null }) => (x.time ? `${x.date} ${x.time}` : x.date);
const minutesBetween = (a: { date: string; time: string | null }, b: { date: string; time: string | null }) =>
  (Date.parse(`${b.date}T${b.time ?? '00:00'}:00Z`) - Date.parse(`${a.date}T${a.time ?? '00:00'}:00Z`)) / 60_000;

export type DurationUnit = 'hour' | 'day' | 'minute';
export function durationUnit(v: Cell): DurationUnit | null {
  const s = clean(v).toLowerCase();
  if (['hour', 'hours', 'hr', 'hrs', 'h', 'ชั่วโมง', 'ชม.', '小时'].includes(s)) return 'hour';
  if (['day', 'days', 'd', 'วัน', '天'].includes(s)) return 'day';
  if (['minute', 'minutes', 'min', 'mins', 'นาที', '分钟'].includes(s)) return 'minute';
  return null;
}

function num(v: Cell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = clean(v).replace(/,/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}
/** Request numbers are long digit strings; a numeric cell is written back without exponent or decimals. */
function idText(v: Cell): string | null {
  if (typeof v === 'number') return Number.isFinite(v) ? (Number.isInteger(v) ? BigInt(v).toString() : String(v)) : null;
  const s = clean(v);
  return s ? s.slice(0, 64) : null;
}
const text = (v: Cell | undefined, max = 500): string | null => {
  const s = clean(v);
  return s ? s.slice(0, max) : null;
};

export type RequestIssueCode =
  | 'missing_required' | 'bad_status' | 'bad_date' | 'invalid_range' | 'invalid_duration' | 'bad_unit' | 'detail_mismatch'
  | 'overnight' | 'not_approved' | 'unknown_employee' | 'wrong_company' | 'not_employed' | 'duplicate_in_file' | 'duplicate_existing';
export interface RequestIssue {
  code: RequestIssueCode;
  level: 'error' | 'warning' | 'info';
  message: string;
}

export interface RequestRow {
  row_no: number;
  request_no: string | null;
  /** 1 for a single-row request; N for "Overtime DetailsN" */
  detail_no: number;
  employee_code: string | null;
  employee_name: string | null;
  department: string | null;
  approval_status: ApprovalStatus | null;
  status_text: string | null;
  approver: string | null;
  submitted_at: string | null;
  completed_at: string | null;
  reason: string | null;
  /** leave: type as written; overtime: Overtime Type */
  type_label: string | null;
  start_at: string | null;
  end_at: string | null;
  start_date: string | null;
  end_date: string | null;
  /** leave: Duration; overtime: request hours */
  amount: number | null;
  unit: DurationUnit | null;
  /** overtime: the day of this detail and its hours */
  work_date: string | null;
  detail_hours: number | null;
  date_type: string | null;
  overnight: boolean;
  raw: Cell[];
  issues: RequestIssue[];
}

/** Parses the rows under the header; checks that need only the file (dates, durations, statuses, duplicates in it). */
export function parseRequestRows(type: RequestImportType, grid: readonly Cell[][], headerRow: number, m: RequestMapping): RequestRow[] {
  const out: RequestRow[] = [];
  const cell = (row: readonly Cell[], key: string): Cell => {
    const col = m[key];
    return col === null || col === undefined ? null : (row[col] ?? null);
  };
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    if (row.every((c) => c === null || clean(c) === '')) continue;
    const issues: RequestIssue[] = [];
    const err = (code: RequestIssueCode, message: string) => issues.push({ code, level: 'error', message });
    for (const f of REQUEST_FIELDS[type]) if (f.required && clean(cell(row, f.key)) === '') err('missing_required', `ไม่มี${f.label}`);
    const statusText = text(cell(row, 'approval_status'), 50);
    const status = approvalStatus(cell(row, 'approval_status'));
    if (statusText && !status) err('bad_status', `สถานะการอนุมัติที่ระบบไม่รู้จัก: ${statusText} (ไม่ถือว่าอนุมัติ)`);
    if (status && status !== 'approved') issues.push({ code: 'not_approved', level: 'info', message: `สถานะ: ${APPROVAL_LABEL[status]}` });
    const start = parseDateTime(cell(row, 'start_at'));
    const end = parseDateTime(cell(row, 'end_at'));
    if (clean(cell(row, 'start_at')) && !start) err('bad_date', `วันเวลาเริ่มไม่ถูกต้อง: ${clean(cell(row, 'start_at')).slice(0, 40)}`);
    if (clean(cell(row, 'end_at')) && !end) err('bad_date', `วันเวลาสิ้นสุดไม่ถูกต้อง: ${clean(cell(row, 'end_at')).slice(0, 40)}`);
    const submitted = parseDateTime(cell(row, 'submitted_at'));
    const completed = parseDateTime(cell(row, 'completed_at'));
    const span = start && end ? minutesBetween(start, end) : null;
    const amountCell = cell(row, type === 'leave' ? 'duration' : 'hours');
    const amount = num(amountCell);
    if (clean(amountCell) && amount === null) err('invalid_duration', `จำนวนไม่ถูกต้อง: ${clean(amountCell).slice(0, 20)}`);
    const unitCell = cell(row, 'unit');
    const unit = clean(unitCell) ? durationUnit(unitCell) : type === 'overtime' ? 'hour' : null;
    if (clean(unitCell) && !unit) issues.push({ code: 'bad_unit', level: 'warning', message: `หน่วยที่ระบบไม่รู้จัก: ${clean(unitCell).slice(0, 20)} (เก็บตามไฟล์)` });
    const rec: RequestRow = {
      row_no: r + 1, request_no: idText(cell(row, 'request_no')), detail_no: 1, employee_code: text(cell(row, 'employee_code'), 50), employee_name: text(cell(row, 'employee_name'), 200),
      department: text(cell(row, 'department'), 200), approval_status: status, status_text: statusText, approver: text(cell(row, 'approver'), 500),
      submitted_at: submitted ? stamp(submitted) : null, completed_at: completed ? stamp(completed) : null, reason: text(cell(row, 'reason'), 1000),
      type_label: text(cell(row, type === 'leave' ? 'leave_type' : 'ot_type'), 100), start_at: start ? stamp(start) : null, end_at: end ? stamp(end) : null,
      start_date: start?.date ?? null, end_date: end?.date ?? null, amount, unit, work_date: null, detail_hours: null, date_type: text(cell(row, 'date_type'), 50),
      overnight: false, raw: row.slice(0, 60).map((c) => (typeof c === 'string' ? c.slice(0, 1000) : c)), issues,
    };
    if (span !== null && span <= 0) err('invalid_range', 'วันเวลาสิ้นสุดต้องอยู่หลังวันเวลาเริ่ม');
    if (type === 'leave') {
      if (amount !== null && amount <= 0) err('invalid_duration', 'จำนวนวัน / ชั่วโมงที่ลาต้องมากกว่า 0');
    } else {
      const d = /(\d+)\s*$/.exec(clean(cell(row, 'detail_label')));
      if (d) rec.detail_no = Number(d[1]);
      const wd = parseDateTime(cell(row, 'work_date'));
      if (clean(cell(row, 'work_date')) && !wd) err('bad_date', `วันที่ทำ OT ไม่ถูกต้อง: ${clean(cell(row, 'work_date')).slice(0, 40)}`);
      rec.work_date = wd?.date ?? start?.date ?? null;
      const dh = cell(row, 'detail_hours');
      rec.detail_hours = clean(dh) ? num(dh) : amount;
      if (clean(dh) && rec.detail_hours === null) err('invalid_duration', `ชั่วโมง OT ของวันไม่ถูกต้อง: ${clean(dh).slice(0, 20)}`);
      const hours = amount === null ? null : unit === 'minute' ? amount / 60 : unit === 'day' ? null : amount;
      if (amount !== null && (amount <= 0 || (hours !== null && hours > 24))) err('invalid_duration', 'ชั่วโมง OT ต้องมากกว่า 0 และไม่เกิน 24 ชั่วโมง');
      else if (hours !== null && span !== null && span > 0 && hours * 60 > span + 0.5) err('invalid_duration', `ชั่วโมง OT (${amount}) มากกว่าช่วงเวลาที่ขอ`);
      if (rec.detail_hours !== null && (rec.detail_hours <= 0 || (amount !== null && rec.detail_hours > amount + 1e-9))) err('invalid_duration', 'ชั่วโมง OT ของวันต้องมากกว่า 0 และไม่เกินชั่วโมงของคำขอ');
      rec.overnight = !!(start && end && end.date > start.date);
      if (rec.overnight && span !== null && span > 0) issues.push({ code: 'overnight', level: 'info', message: 'OT ข้ามวัน' });
    }
    out.push(rec);
  }
  // duplicates inside the file: same request (and detail)
  const seen = new Set<string>();
  for (const r of out) {
    if (!r.request_no) continue;
    const k = `${r.request_no}#${r.detail_no}`;
    if (seen.has(k)) r.issues.push({ code: 'duplicate_in_file', level: 'info', message: `เลขที่คำขอ ${r.request_no}${type === 'overtime' ? ` รายการย่อย ${r.detail_no}` : ''} ซ้ำกับแถวก่อนหน้าในไฟล์นี้` });
    seen.add(k);
  }
  if (type === 'overtime') {
    // the details of one request add up to its hours
    const groups = new Map<string, RequestRow[]>();
    for (const r of out) if (r.request_no && !r.issues.some((i) => i.code === 'duplicate_in_file')) groups.set(r.request_no, [...(groups.get(r.request_no) ?? []), r]);
    for (const rows of groups.values()) {
      if (rows.length < 2 || rows[0]!.amount === null) continue;
      const sum = rows.reduce((s, r) => s + (r.detail_hours ?? 0), 0);
      if (Math.abs(sum - rows[0]!.amount!) > 0.01) for (const r of rows) r.issues.push({ code: 'detail_mismatch', level: 'warning', message: `ชั่วโมงรายการย่อยรวม ${sum} ไม่เท่ากับชั่วโมงของคำขอ ${rows[0]!.amount}` });
    }
  }
  return out;
}

export type RequestRowStatus = 'valid' | 'warning' | 'duplicate' | 'invalid';
export function requestRowStatus(issues: readonly RequestIssue[]): RequestRowStatus {
  if (issues.some((i) => i.level === 'error')) return 'invalid';
  if (issues.some((i) => i.code === 'duplicate_in_file' || i.code === 'duplicate_existing')) return 'duplicate';
  if (issues.some((i) => i.level === 'warning')) return 'warning';
  return 'valid';
}
