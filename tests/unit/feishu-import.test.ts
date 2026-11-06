import { beforeAll, describe, expect, it } from 'vitest';
import { autoDailyMapping, clockTime, dailyMappingProblems, dayColumns, findDailyHeaderRow, parseDailyRows, parseDayCell, type DailyRow } from '../../src/shared/feishu-daily';
import { approvalStatus, autoRequestMapping, detectRequestSheet, parseDateTime, parseRequestRows, requestHeaders, requestMappingProblems, requestRowStatus, type RequestRow } from '../../src/shared/feishu-requests';
import { detectSheet, wrongSheetMessage } from '../../src/shared/import-templates';
import { readXlsx, writeWorkbook, type Sheet } from '../../src/shared/xlsx';
import { addDays, feishuReport } from '../fixtures/feishu-report';

const START = '2026-09-26';
const codes = { a: ['ZFA01', 'ZFA02', 'ZFA03'] as [string, string, string], other: 'ZFB01', unknown: 'ZZ-NOPE', prefix: '9000' };
let sheets: Sheet[];
const sheet = (name: string) => sheets.find((s) => s.name === name)!;
const codesOf = (issues: ReadonlyArray<{ code: string }>) => issues.map((i) => i.code);

beforeAll(async () => {
  // through a real workbook: write the three worksheets and read them back
  sheets = await readXlsx(writeWorkbook(feishuReport({ start: START, ...codes })));
});

describe('worksheets: one import = one worksheet = one data domain', () => {
  it('the workbook has the three worksheets of the Feishu export, each recognised as its own domain', () => {
    expect(sheets.map((s) => s.name)).toEqual(['Sheet1', 'Leave', 'Overtime']);
    expect(detectSheet(sheet('Sheet1').rows)).toEqual({ type: 'attendance', template: 'FEISHU_DAILY_ATTENDANCE_V1' });
    expect(detectSheet(sheet('Leave').rows)).toEqual({ type: 'leave', template: 'FEISHU_LEAVE_V1' });
    expect(detectSheet(sheet('Overtime').rows)).toEqual({ type: 'overtime', template: 'FEISHU_OVERTIME_V1' });
  });
  it('a worksheet of another domain is refused with the menu where it belongs', () => {
    expect(wrongSheetMessage('attendance', detectSheet(sheet('Leave').rows), 'Leave')).toContain('การลา › นำเข้าข้อมูลการลา');
    expect(wrongSheetMessage('leave', detectSheet(sheet('Overtime').rows), 'Overtime')).toContain('คำขอ OT › นำเข้าข้อมูล OT');
    expect(wrongSheetMessage('overtime', detectSheet(sheet('Sheet1').rows), 'Sheet1')).toContain('บันทึกเวลาทำงาน');
    expect(wrongSheetMessage('leave', detectSheet(sheet('Leave').rows), 'Leave')).toBeNull();
    expect(wrongSheetMessage('overtime', { type: null, template: null }, 'x')).toBeNull();
  });
  it('parsing one worksheet reads nothing of the others', () => {
    const daily = sheet('Sheet1');
    const dr = findDailyHeaderRow(daily.rows);
    const { rows } = parseDailyRows(daily.rows, dr, autoDailyMapping(daily.rows[dr]!));
    expect(new Set(rows.map((r) => r.employee_code))).toEqual(new Set(['ZFA01', 'ZFA02', 'ZFA03', 'ZZ-NOPE', 'ZFB01']));
    expect(rows.some((r) => /9000[LO]/.test(r.cell))).toBe(false);
    for (const [name, type] of [['Leave', 'leave'], ['Overtime', 'overtime']] as const) {
      const s = sheet(name);
      const { headerRow } = detectRequestSheet(s.rows);
      const rr = parseRequestRows(type, s.rows, headerRow, autoRequestMapping(type, requestHeaders(s.rows, headerRow)));
      expect(rr.every((r) => r.request_no?.startsWith(`9000${type === 'leave' ? 'L' : 'O'}`))).toBe(true);
    }
    // the daily parser finds no daily header in a request worksheet and vice versa
    expect(findDailyHeaderRow(sheet('Leave').rows)).toBe(-1);
    expect(detectRequestSheet(daily.rows).type).toBeNull();
  });
});

describe('FEISHU_DAILY_ATTENDANCE_V1: daily report → one row per employee and day', () => {
  let rows: DailyRow[];
  const day = (code: string, i: number, nth = 0) => rows.filter((r) => r.employee_code === code && r.work_date === addDays(START, i))[nth]!;
  let summary: { sourceRows: number; emptyDays: number };
  beforeAll(() => {
    const s = sheet('Sheet1');
    const hr = findDailyHeaderRow(s.rows);
    const m = autoDailyMapping(s.rows[hr]!);
    expect(dailyMappingProblems(m, s.rows[hr]!.length, dayColumns(s.rows[hr]!).map((d) => d.col))).toEqual([]);
    const out = parseDailyRows(s.rows, hr, m);
    rows = out.rows;
    summary = out;
  });

  it('three grouped header rows; the dates come from the day headers, never from Employment date', () => {
    const s = sheet('Sheet1');
    expect(findDailyHeaderRow(s.rows)).toBe(2);
    expect(dayColumns(s.rows[2]!).map((d) => d.date)).toEqual(Array.from({ length: 7 }, (_, i) => addDays(START, i)));
    expect(rows.every((r) => r.work_date >= START && r.work_date !== '2024-01-01')).toBe(true);
  });
  it('blank / "-" days are counted, not imported', () => {
    expect(summary.sourceRows).toBe(6);
    expect(summary.emptyDays).toBe(1 + 6 + 6 + 6 + 6);
    expect(rows).toHaveLength(6 * 7 - summary.emptyDays);
  });
  it('Regular: clock-in and clock-out', () => {
    expect(day('ZFA01', 0)).toMatchObject({ clock_in: '08:58', clock_out: '18:03', late_minutes: null, worked_minutes: 545 });
    expect(day('ZFA01', 0).issues.filter((i) => i.level !== 'info')).toEqual([]);
  });
  it('Late In with the minutes Feishu counted, and the overtime of the same day kept as an event', () => {
    const r = day('ZFA01', 1);
    expect(r).toMatchObject({ clock_in: '09:09', clock_out: '18:01', late_minutes: 9 });
    expect(r.day.events).toEqual([expect.objectContaining({ kind: 'overtime', ranges: ['18:00-20:00'], overnight: false })]);
  });
  it('Early Leave', () => {
    expect(day('ZFA02', 4)).toMatchObject({ clock_in: '09:00', clock_out: '17:30', early_leave_minutes: 30 });
    expect(codesOf(day('ZFA02', 4).issues)).toContain('early_leave');
  });
  it('Regular + Leave and Late In + Leave keep both the punches and the leave', () => {
    const a = day('ZFA01', 2);
    expect(a).toMatchObject({ clock_in: '08:55', clock_out: '13:00' });
    expect(a.day.events).toEqual([expect.objectContaining({ kind: 'leave', label: 'Sick leave', amount: 4, unit: 'hour', ranges: ['13:00-18:00'] })]);
    const b = day('ZFA02', 2);
    expect(b).toMatchObject({ clock_in: '09:05', late_minutes: 5, clock_out: '13:01' });
    expect(b.day.events[0]).toMatchObject({ kind: 'leave', label: 'ลาป่วย', amount: 4 });
  });
  it('a full-day leave has no clock time and is not an absence', () => {
    const r = day('ZFA01', 3);
    expect(r.clock_in).toBeNull();
    expect(r.clock_out).toBeNull();
    expect(r.day.events[0]).toMatchObject({ kind: 'leave', label: 'Annual leave', amount: 8, ranges: ['09:00-12:00', '13:00-18:00'] });
  });
  it('No Record is a warning, never an absence, and its time is never used as a clock time', () => {
    const r = day('ZFA01', 4);
    expect(r).toMatchObject({ clock_in: null, clock_out: null });
    expect(codesOf(r.issues)).toEqual(expect.arrayContaining(['no_record_in', 'no_record_out']));
    expect(JSON.stringify(r)).not.toMatch(/absent|absence/i);
    const kept = day('ZFA02', 0);
    expect(kept.day.clock_in).toMatchObject({ result: 'no_record', time: '10:27' });
    expect(kept.clock_in).toBeNull();
    expect(kept.clock_out).toBe('18:00');
    expect(codesOf(kept.issues)).toEqual(expect.arrayContaining(['no_record_in', 'no_record_time_kept']));
  });
  it('missing clock-out (Pending) is a warning; nothing is invented', () => {
    const r = day('ZFA02', 1);
    expect(r).toMatchObject({ clock_in: '09:00', clock_out: null, worked_minutes: null });
    expect(codesOf(r.issues)).toContain('pending_out');
  });
  it('overnight work and overnight overtime on one day', () => {
    const r = day('ZFA02', 3);
    expect(r).toMatchObject({ clock_in: '21:58', clock_out: '07:01', out_next_day: true, worked_minutes: 543 });
    expect(r.day.events[0]).toMatchObject({ kind: 'overtime', overnight: true });
  });
  it('rest day, break punches and out-of-office are kept', () => {
    expect(day('ZFA01', 5).day.kind).toBe('rest');
    expect(day('ZFA02', 5).day.events[0]).toMatchObject({ kind: 'break_punch' });
    expect(day('ZFA02', 6)).toMatchObject({ clock_in: '08:03', clock_out: '18:00' });
    expect(day('ZFA02', 6).day.events[0]).toMatchObject({ kind: 'out_of_office', ranges: ['08:00-12:00'] });
  });
  it('the same employee and date twice: both rows are returned for the duplicate check', () => {
    expect(rows.filter((r) => r.employee_code === 'ZFA01' && r.work_date === START)).toHaveLength(2);
  });
  it('an unreadable cell is an error, not silently dropped', () => {
    expect(codesOf(day('ZFA03', 0).issues)).toContain('unreadable_cell');
  });
  it('cell grammar: labels with brackets, full-width brackets, days, all-day leave', () => {
    const c = parseDayCell('Regular(09:00),Leave(13:00);ลากิจ (กำหนด)(4 hr,13:00-18:00);Personal leave（Unpaid）(1 days,all day long)');
    expect(c.events.map((e) => [e.label, e.amount, e.unit, e.all_day])).toEqual([['ลากิจ (กำหนด)', 4, 'hour', false], ['Personal leave（Unpaid）', 1, 'day', true]]);
    expect(clockTime(c.clock_out)).toBe('13:00');
    expect(parseDayCell('-').kind).toBe('empty');
    expect(parseDayCell('Break(-,-);Paternity leave(1 days,all day long)')).toMatchObject({ kind: 'rest', events: [expect.objectContaining({ kind: 'leave', all_day: true })] });
  });
});

describe('FEISHU_LEAVE_V1 / FEISHU_OVERTIME_V1', () => {
  const parse = (type: 'leave' | 'overtime') => {
    const s = sheet(type === 'leave' ? 'Leave' : 'Overtime');
    const { headerRow } = detectRequestSheet(s.rows);
    const headers = requestHeaders(s.rows, headerRow);
    const m = autoRequestMapping(type, headers);
    expect(requestMappingProblems(type, m, headers.length)).toEqual([]);
    return { rows: parseRequestRows(type, s.rows, headerRow, m), headers, m };
  };
  const byNo = (rows: RequestRow[], no: string, n = 0) => rows.filter((r) => r.request_no === `9000${no}`)[n]!;

  it('header row 2 under the filter line; request and detail columns that differ only in case are told apart', () => {
    const { headers, m } = parse('overtime');
    expect(detectRequestSheet(sheet('Overtime').rows).headerRow).toBe(1);
    expect(headers[m.start_at!]).toBe('Start time');
    expect(headers[m.work_date!]).toBe('Start Time');
    expect(headers[m.end_at!]).toBe('End time');
    expect(headers[m.ot_type!]).toBe('Overtime Type');
  });
  it('leave: Approved / Pending / Rejected / Cancelled are kept as written — pending stays pending', () => {
    const { rows } = parse('leave');
    expect(['L01', 'L02', 'L03', 'L04'].map((n) => byNo(rows, n).approval_status)).toEqual(['approved', 'pending', 'rejected', 'cancelled']);
    expect(byNo(rows, 'L02')).toMatchObject({ start_at: `${addDays(START, 3)} 09:00`, end_at: `${addDays(START, 4)} 18:00`, amount: 16, unit: 'hour' });
    expect(requestRowStatus(byNo(rows, 'L02').issues)).toBe('valid');
  });
  it('leave: duplicate Request ID, invalid date range, unknown status, day unit and a Chinese / Thai type', () => {
    const { rows } = parse('leave');
    expect(codesOf(byNo(rows, 'L01', 1).issues)).toContain('duplicate_in_file');
    expect(requestRowStatus(byNo(rows, 'L01', 1).issues)).toBe('duplicate');
    expect(codesOf(byNo(rows, 'L07').issues)).toContain('invalid_range');
    const weird = byNo(rows, 'L08');
    expect(weird.approval_status).toBeNull();
    expect(requestRowStatus(weird.issues)).toBe('invalid');
    expect(byNo(rows, 'L09')).toMatchObject({ type_label: '病假 / ลาป่วย', amount: 1, unit: 'day' });
    expect(byNo(rows, 'L01').submitted_at).toBe(`${START} 10:00`);
  });
  it('overtime: statuses, an overnight request in two details, duplicate and invalid durations', () => {
    const { rows } = parse('overtime');
    expect(['O01', 'O02', 'O03', 'O04'].map((n) => byNo(rows, n).approval_status)).toEqual(['approved', 'pending', 'rejected', 'cancelled']);
    const [first, second] = [byNo(rows, 'O05', 0), byNo(rows, 'O05', 1)];
    expect([first.detail_no, second.detail_no]).toEqual([1, 2]);
    expect([first.work_date, second.work_date]).toEqual([addDays(START, 3), addDays(START, 4)]);
    expect([first.detail_hours, second.detail_hours, first.amount]).toEqual([2, 1, 3]);
    expect(first.overnight && second.overnight).toBe(true);
    expect(requestRowStatus(first.issues)).toBe('valid');
    expect(requestRowStatus(byNo(rows, 'O01', 1).issues)).toBe('duplicate');
    expect(codesOf(byNo(rows, 'O08').issues)).toContain('invalid_duration');
    expect(codesOf(byNo(rows, 'O10').issues)).toContain('invalid_duration');
  });
  it('statuses in English, Thai and Chinese; anything else is not a status', () => {
    expect(['Approved', 'อนุมัติ', '已通过', 'Pending', '审批中', 'Rejected', 'ไม่อนุมัติ', 'Cancelled', 'Withdrawn', '已撤回'].map(approvalStatus))
      .toEqual(['approved', 'approved', 'approved', 'pending', 'pending', 'rejected', 'rejected', 'cancelled', 'cancelled', 'cancelled']);
    expect(approvalStatus('Approve?')).toBeNull();
    expect(approvalStatus('')).toBeNull();
  });
  it('date-time formats of the export', () => {
    expect(parseDateTime('Oct 01 2026 09:00')).toEqual({ date: '2026-10-01', time: '09:00' });
    expect(parseDateTime('Oct 10 2026')).toEqual({ date: '2026-10-10', time: null });
    expect(parseDateTime(46296.75)).toEqual({ date: '2026-10-01', time: '18:00' });
    expect(parseDateTime('2026-10-01 22:30')).toEqual({ date: '2026-10-01', time: '22:30' });
    expect(parseDateTime('01/10/2569 08:00')).toEqual({ date: '2026-10-01', time: '08:00' });
    expect(parseDateTime('Foo 01 2026')).toBeNull();
    expect(parseDateTime('2026-02-30')).toBeNull();
  });
});
