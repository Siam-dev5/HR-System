// Synthetic Feishu "Daily Report" workbook with the three worksheets of the real export (Sheet1 = daily attendance,
// Leave, Overtime): the same header rows, column order and cell grammar as Starlive+Dairy+Report_20260926_20261026.xlsx
// (checked structure-only; the real file holds personal data and is not in the repository). Every value here is made
// up: zz_test employee codes, names and request numbers. Each row exercises one case of the import rules.
import type { Cell, Sheet } from '../../src/shared/xlsx';

export interface FeishuFixtureOptions {
  /** first of seven consecutive work dates (all in the past) */
  start: string;
  /** three employee codes of the import company */
  a: [string, string, string];
  /** an employee code of another company */
  other: string;
  /** a code that exists nowhere */
  unknown: string;
  /** request-number prefix, so separate test runs never collide */
  prefix: string;
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const dayHead = (d: string) => `${d} ${WEEKDAY[new Date(`${d}T00:00:00Z`).getUTCDay()]}`;
/** Feishu writes request times as "Oct 01 2026 09:00" */
export const feishuTime = (d: string, t?: string) => `${MONTH[Number(d.slice(5, 7)) - 1]} ${d.slice(8, 10)} ${d.slice(0, 4)}${t ? ` ${t}` : ''}`;
/** Excel serial of a date-time (Submitted at / Completed at are numbers in the export) */
const serial = (d: string, t = '10:00') => (Date.parse(`${d}T${t}:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000;

export const DAILY_IDENTITY = ['Name', 'Employee ID', 'Department', 'Job', 'Employment status', 'Employment date', 'Group', 'Shift'];
export const LEAVE_SUMMARY = ['Personal leave(hr)', 'Personal leave（Unpaid）(hr)', 'Sick leave(hr)', 'Annual leave(hr)'];
export const OT_SUMMARY = ['Overtime on working days - Overtime pay(hr)', 'Overtime on non-working days - Overtime pay(hr)', 'Overtime on holidays - Overtime pay(hr)'];
export const REQUEST_HEAD = ['Request No.', 'Title', 'Status', 'Submitted at', 'Completed at', "Requester's Employee No.", "Requester's User ID", "Requester's name", 'Initiator department',
  'Initiator Department ID', 'Department supervisor', 'Previous approver(s)', 'Previous handlers', 'Approval records', 'Current assignee', 'Approval steps', 'Number of approvers', 'Time spent'];
export const LEAVE_HEAD = [...REQUEST_HEAD, 'Leave type', 'Start time', 'End time', 'Duration', 'Reason for leave', 'Leave unit', 'Late for Work (mins)', 'Leave Early (min)', 'Daily Rest (hours)',
  'Supporting documents', 'Accepted Pre-pregnancy Checkup or Not', 'Fetuses', 'Dystocia or Not', 'Accepted Pre-marital Checkup or Not', 'Months of Pregnancy', 'Relationship', 'Leave of Absence Certificate', 'Remarks'];
export const OT_HEAD = [...REQUEST_HEAD, 'Overtime type', 'Start time', 'End time', 'Overtime hours', 'Reason for overtime', 'Duration Unit', 'Overtime Rule', 'Overtime Details', 'Overtime Type',
  'Start Time', 'End Time', 'Overtime Duration', 'Date Type', 'Overtime Person', 'Overtime certificate', 'Remarks'];

/** Daily cells per employee row (index = day 0..6), each one a case of the attendance rules. */
export function dailyCells(): { a0: string[]; a1: string[]; dupA0: string[]; a2: string[] } {
  return {
    a0: [
      'Regular(08:58),Regular(18:03)', // regular
      'Late in9min(09:09),Regular(18:01);Overtime(18:00-20:00)', // late in + overtime on the same day
      'Regular(08:55),Leave(13:00);Sick leave(4 hr,13:00-18:00)', // regular + leave
      'Leave(-),Leave(-);Annual leave(8 hr,09:00-12:00,13:00-18:00)', // full-day leave, no clock time
      'No record(-),No record(-)', // no record (never an absence)
      'Break(-,-)', // rest day
      '-', // no data
    ],
    a1: [
      'No record(10:27),Regular(18:00)', // missing clock-in: the time under No record is not used
      'Regular(09:00),Pending(-)', // clock-out still pending
      'Late in5min(09:05),Leave(13:01);ลาป่วย(4 hr,13:00-18:00)', // late in + leave
      'Regular(21:58),Regular(07:01);Overtime(22:00-01:00)', // overnight work + overnight overtime
      'Regular(09:00),Early leave30min(17:30)', // early leave
      'Clock in/out for breaks(12:00,13:00)', // break punches only
      'Out-of-office(08:03),Regular(18:00);Out-of-office(08:00-12:00)', // out of office
    ],
    // the same employee again in another row: day 0 duplicates a0's day 0
    dupA0: ['Regular(09:00),Regular(18:00)', '-', '-', '-', '-', '-', '-'],
    a2: ['this cell cannot be read', '-', '-', '-', '-', '-', '-'],
  };
}

export function feishuReport(o: FeishuFixtureOptions): Sheet[] {
  const days = Array.from({ length: 7 }, (_, i) => addDays(o.start, i));
  const width = DAILY_IDENTITY.length + days.length + LEAVE_SUMMARY.length + OT_SUMMARY.length;
  const group1: Cell[] = [null, 'Name', ...Array<string>(DAILY_IDENTITY.length - 1 + days.length).fill('Basic information'), ...LEAVE_SUMMARY.map(() => 'Leave summary'), ...OT_SUMMARY.map(() => 'Overtime summary')];
  const group2: Cell[] = [null, ...DAILY_IDENTITY, ...days.map(() => 'Daily attendance result'), ...LEAVE_SUMMARY, ...OT_SUMMARY];
  const head: Cell[] = [null, ...DAILY_IDENTITY, ...days.map(dayHead), ...LEAVE_SUMMARY, ...OT_SUMMARY];
  const cells = dailyCells();
  const person = (code: string, name: string, cols: string[]): Cell[] =>
    [null, name, code, 'zz_test ฝ่ายทดสอบ', 'zz_test เจ้าหน้าที่', 'Active', '2024-01-01', 'ทีม A ', 'วันทำงาน 09:00-18:00', ...cols, ...LEAVE_SUMMARY.map(() => '0'), ...OT_SUMMARY.map(() => '0')];
  const attendance: Cell[][] = [
    group1, group2, head,
    person(o.a[0], 'zz_test หนึ่ง', cells.a0),
    person(o.a[1], 'zz_test สอง', cells.a1),
    person(o.a[0], 'zz_test หนึ่ง (แถวซ้ำ)', cells.dupA0),
    person(o.a[2], 'zz_test สาม', cells.a2),
    person(o.unknown, 'zz_test ไม่มีในระบบ', ['Regular(09:00),Regular(18:00)', '-', '-', '-', '-', '-', '-']),
    person(o.other, 'zz_test บริษัทอื่น', ['Regular(09:00),Regular(18:00)', '-', '-', '-', '-', '-', '-']),
  ].map((r) => (r.length < width + 1 ? [...r, ...Array<Cell>(width + 1 - r.length).fill(null)] : r));

  const [d0, d1, d2, d3, d4] = days as [string, string, string, string, string];
  const req = (no: string, status: string, code: string, name: string, extra: Cell[]): Cell[] =>
    [`${o.prefix}${no}`, `zz_test request ${no}`, status, serial(d0), serial(d0, '11:00'), code, `u_${no}`, name, 'zz_test ฝ่ายทดสอบ', 'od-zz', 'zz_test หัวหน้า', 'zz_test ผู้อนุมัติ', '', 'zz_test approval record', '', '1', 1, '1h', ...extra];
  const leave = (type: string, from: string, to: string, dur: number | string, unit = 'hour'): Cell[] => [type, from, to, dur, 'zz_test เหตุผล', unit];
  const leaveRows: Cell[][] = [
    req('L01', 'Approved', o.a[0], 'zz_test หนึ่ง', leave('Sick leave', feishuTime(d2, '13:00'), feishuTime(d2, '18:00'), 4)),
    req('L02', 'Pending', o.a[1], 'zz_test สอง', leave('ลาพักร้อน', feishuTime(d3, '09:00'), feishuTime(d4, '18:00'), 16)),
    req('L03', 'Rejected', o.a[0], 'zz_test หนึ่ง', leave('Personal leave', feishuTime(d4, '09:00'), feishuTime(d4, '12:00'), 3)),
    req('L04', 'Cancelled', o.a[1], 'zz_test สอง', leave('Personal leave（Unpaid）', feishuTime(d1, '09:00'), feishuTime(d1, '18:00'), 8)),
    req('L01', 'Approved', o.a[0], 'zz_test หนึ่ง', leave('Sick leave', feishuTime(d2, '13:00'), feishuTime(d2, '18:00'), 4)), // duplicate Request ID
    req('L06', 'Approved', o.other, 'zz_test บริษัทอื่น', leave('Sick leave', feishuTime(d1, '09:00'), feishuTime(d1, '18:00'), 8)), // other company
    req('L07', 'Approved', o.a[1], 'zz_test สอง', leave('Sick leave', feishuTime(d3, '18:00'), feishuTime(d3, '09:00'), 8)), // end before start
    req('L08', 'Weird', o.a[0], 'zz_test หนึ่ง', leave('Sick leave', feishuTime(d0, '09:00'), feishuTime(d0, '12:00'), 3)), // unknown status
    req('L09', 'Approved', o.a[2], 'zz_test สาม', leave('病假 / ลาป่วย', feishuTime(d0, '09:00'), feishuTime(d0, '18:00'), 1, 'day')), // Chinese / Thai type, days
  ];
  const ot = (from: string, to: string, hours: number, detail: number, dFrom: string, dTo: string, dHours: number): Cell[] =>
    ['', from, to, hours, 'zz_test งานด่วน', 'hour', '7672703032745430295', `Overtime Details${detail}`, 'Overtime Pay', dFrom, dTo, dHours, 'Workday', 'zz_test', '', ''];
  const otRows: Cell[][] = [
    req('O01', 'Approved', o.a[0], 'zz_test หนึ่ง', ot(feishuTime(d1, '18:00'), feishuTime(d1, '20:00'), 2, 1, feishuTime(d1, '00:00'), feishuTime(d1, '00:00'), 2)),
    req('O02', 'Pending', o.a[1], 'zz_test สอง', ot(feishuTime(d2, '18:00'), feishuTime(d2, '19:00'), 1, 1, feishuTime(d2, '00:00'), feishuTime(d2, '00:00'), 1)),
    req('O03', 'Rejected', o.a[0], 'zz_test หนึ่ง', ot(feishuTime(d2, '18:00'), feishuTime(d2, '21:00'), 3, 1, feishuTime(d2), feishuTime(d2), 3)),
    req('O04', 'Cancelled', o.a[1], 'zz_test สอง', ot(feishuTime(d4, '18:00'), feishuTime(d4, '20:00'), 2, 1, feishuTime(d4), feishuTime(d4), 2)),
    // overnight request 22:00–01:00 split over two days (two detail rows of one request)
    req('O05', 'Approved', o.a[1], 'zz_test สอง', ot(feishuTime(d3, '22:00'), feishuTime(d4, '01:00'), 3, 1, feishuTime(d3, '00:00'), feishuTime(d3, '00:00'), 2)),
    req('O05', 'Approved', o.a[1], 'zz_test สอง', ot(feishuTime(d3, '22:00'), feishuTime(d4, '01:00'), 3, 2, feishuTime(d4, '00:00'), feishuTime(d4, '00:00'), 1)),
    req('O01', 'Approved', o.a[0], 'zz_test หนึ่ง', ot(feishuTime(d1, '18:00'), feishuTime(d1, '20:00'), 2, 1, feishuTime(d1, '00:00'), feishuTime(d1, '00:00'), 2)), // duplicate
    req('O08', 'Approved', o.a[0], 'zz_test หนึ่ง', ot(feishuTime(d0, '18:00'), feishuTime(d0, '19:00'), 5, 1, feishuTime(d0), feishuTime(d0), 5)), // 5 h in a 1 h span
    req('O09', 'Approved', o.other, 'zz_test บริษัทอื่น', ot(feishuTime(d0, '18:00'), feishuTime(d0, '20:00'), 2, 1, feishuTime(d0), feishuTime(d0), 2)), // other company
    req('O10', 'Approved', o.a[2], 'zz_test สาม', ot(feishuTime(d0, '18:00'), feishuTime(d0, '20:00'), 0, 1, feishuTime(d0), feishuTime(d0), 0)), // zero hours
  ];
  const filter = (type: string, n: number) => [`Filter: Start time: ${days[0]} to ${days[6]} Type: ${type} Application Status: All Total: ${n}  request(s) (Requests with the same ID are counted as one.)`];
  return [
    { name: 'Sheet1', rows: attendance },
    { name: 'Leave', rows: [filter('Leave', leaveRows.length), LEAVE_HEAD, ...leaveRows] },
    { name: 'Overtime', rows: [filter('Overtime', otRows.length), OT_HEAD, ...otRows] },
  ];
}
