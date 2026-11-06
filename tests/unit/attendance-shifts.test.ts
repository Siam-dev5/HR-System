import { describe, expect, it } from 'vitest';
import { checkClock, dateRange, monthEnd, netWorkMinutes, overlapsNextDay, parseWorkDays, rotate, shiftProblems, shiftSpan, totalBreakMinutes, type ShiftTimes } from '../../src/shared/shifts';
import { autoClockMapping, findClockHeaderRow, headerLabels, layoutSignature, parseClockRows, parseDateCell, parseTimeCell, rowStatus, sniffFileType, validMapping } from '../../src/shared/clock-import';
import { parseCsv, readXlsx, writeXlsx } from '../../src/shared/xlsx';
import { readXls } from '../../src/shared/xls';
import { writeXls } from '../ui/fixtures/xls-writer';

const shift = (start: string, end: string, breaks: Array<[string, string]> = [], x: Partial<ShiftTimes> = {}): ShiftTimes => ({ start_time: start, end_time: end, breaks: breaks.map(([s, e]) => ({ start: s, end: e })), ...x });

describe('shift definition', () => {
  it('net working time subtracts every break period', () => {
    const s = shift('08:00', '17:00', [['12:00', '13:00'], ['15:00', '15:15']]);
    expect(totalBreakMinutes(s)).toBe(75);
    expect(netWorkMinutes(s)).toBe(9 * 60 - 75);
  });
  it('cross-midnight shifts: 22:00–07:00 and 15:00–24:00', () => {
    const night = shift('22:00', '07:00', [['02:00', '03:00']]);
    expect(shiftSpan(night)).toEqual({ start: 1320, end: 1860, overnight: true });
    expect(netWorkMinutes(night)).toBe(8 * 60);
    const evening = shift('15:00', '24:00', [['19:00', '19:30']]);
    expect(shiftSpan(evening).overnight).toBe(false);
    expect(netWorkMinutes(evening)).toBe(9 * 60 - 30);
  });
  it('legacy break_minutes still counts when no break periods are recorded', () => {
    expect(netWorkMinutes({ start_time: '09:00', end_time: '18:00', breaks: [], break_minutes: 60 })).toBe(480);
  });
  it('rejects invalid definitions', () => {
    expect(shiftProblems({ start_time: '08:00', end_time: '08:00', breaks: [] })).not.toHaveLength(0);
    expect(shiftProblems({ start_time: '25:00', end_time: '17:00', breaks: [] })).not.toHaveLength(0);
    expect(shiftProblems({ start_time: '08:00', end_time: '17:00', breaks: [{ start: '18:00', end: '19:00' }] }).join()).toContain('นอกเวลากะ');
    expect(shiftProblems({ start_time: '08:00', end_time: '17:00', breaks: [{ start: '12:00', end: '13:00' }, { start: '12:30', end: '13:30' }] }).join()).toContain('ซ้อนกัน');
    expect(shiftProblems({ start_time: '08:00', end_time: '17:00', breaks: [], work_days: [] }).join()).toContain('วันทำงาน');
    expect(shiftProblems({ start_time: '22:00', end_time: '07:00', breaks: [{ start: '02:00', end: '03:00' }], work_days: '1,2,3' })).toEqual([]);
  });
  it('working days', () => {
    expect(parseWorkDays('1,2,3,4,5')).toEqual([1, 2, 3, 4, 5]);
    expect(parseWorkDays([6, 0, 6])).toEqual([0, 6]);
    expect(parseWorkDays('7')).toBeNull();
  });
});

describe('checking clock times against a shift', () => {
  const day = shift('08:00', '17:00', [['12:00', '13:00']]);
  it('keeps the existing rule without grace: late = after the start', () => {
    expect(checkClock(day, '08:00', '17:00').status).toBe('present');
    expect(checkClock(day, '08:01', '17:00')).toMatchObject({ status: 'late', lateMinutes: 1 });
    expect(checkClock(null, '09:01', null, { defaultStart: '09:00' }).status).toBe('late');
    expect(checkClock(null, '09:00', null, { defaultStart: '09:00' }).status).toBe('present');
  });
  it('grace minutes, early leave and worked time net of breaks', () => {
    const graced = { ...day, late_grace_minutes: 5, early_leave_grace_minutes: 10 };
    expect(checkClock(graced, '08:05', '17:00').status).toBe('present');
    expect(checkClock(graced, '08:06', '17:00')).toMatchObject({ status: 'late', lateMinutes: 6 });
    const r = checkClock(graced, '08:00', '16:30');
    expect(r.earlyLeaveMinutes).toBe(30);
    expect(r.warnings).toContain('early_leave');
    expect(r.workedMinutes).toBe(8 * 60 + 30 - 60);
    expect(checkClock(graced, '08:00', '16:55').warnings).not.toContain('early_leave');
  });
  it('cross-midnight: clock-out the next morning, clock-in after midnight', () => {
    const night = shift('22:00', '07:00', [['02:00', '03:00']]);
    const ok = checkClock(night, '21:55', '07:00');
    expect(ok).toMatchObject({ status: 'present', outNextDay: true, earlyLeaveMinutes: 0, workedMinutes: 9 * 60 + 5 - 60, error: null });
    expect(checkClock(night, '00:30', '07:00')).toMatchObject({ status: 'late', lateMinutes: 150, outNextDay: true });
    expect(checkClock(day, '08:00', '01:00').warnings).toContain('cross_midnight_unplanned');
  });
  it('missing clock-out, very long day, impossible times', () => {
    expect(checkClock(day, '08:00', null)).toMatchObject({ workedMinutes: null, warnings: ['missing_clock_out'] });
    expect(checkClock(day, '06:00', '23:30').warnings).toEqual(expect.arrayContaining(['clock_out_late', 'long_day']));
    expect(checkClock(day, '05:30', '17:00').warnings).toContain('clock_in_early');
    expect(checkClock(day, '08:00', '07:00', { outNextDay: true })).toMatchObject({ error: null, warnings: ['clock_out_late', 'cross_midnight_unplanned', 'long_day'] });
    expect(checkClock(day, '08:00', '09:00', { outNextDay: true }).error).toBe('out_before_in');
  });
  it('a night shift that overlaps the next day', () => {
    expect(overlapsNextDay(shift('22:00', '07:00'), shift('06:00', '15:00'))).toBe(true);
    expect(overlapsNextDay(shift('22:00', '07:00'), shift('08:00', '17:00'))).toBe(false);
    expect(overlapsNextDay(shift('08:00', '17:00'), shift('06:00', '15:00'))).toBe(false);
  });
  it('rotation and dates', () => {
    expect(rotate(['A', 'A', 'B', 'off'], 6)).toEqual(['A', 'A', 'B', 'off', 'A', 'A']);
    expect(rotate(['A', 'B'], 3, 1)).toEqual(['B', 'A', 'B']);
    expect(dateRange('2028-02-27', '2028-03-01')).toEqual(['2028-02-27', '2028-02-28', '2028-02-29', '2028-03-01']);
    expect(monthEnd('2027-02')).toBe('2027-02-28');
  });
});

describe('clock file parsing', () => {
  it('dates: serial, ISO, Thai DD/MM with Buddhist years, YYYYMMDD; invalid dates rejected', () => {
    expect(parseDateCell(46332)).toBe('2026-11-06');
    expect(parseDateCell('2026-11-06')).toBe('2026-11-06');
    expect(parseDateCell('06/11/2569')).toBe('2026-11-06');
    expect(parseDateCell('6/11/2026')).toBe('2026-11-06');
    expect(parseDateCell(20261106)).toBe('2026-11-06');
    expect(parseDateCell('31/02/2026')).toBeNull();
    expect(parseDateCell('ไม่ใช่วันที่')).toBeNull();
  });
  it('times: HH:MM[:SS], dots, AM/PM, fractions, date-times, 24:00', () => {
    expect(parseTimeCell('8:05')).toEqual({ time: '08:05', date: null });
    expect(parseTimeCell('08:05:59')).toEqual({ time: '08:05', date: null });
    expect(parseTimeCell('17.30')).toEqual({ time: '17:30', date: null });
    expect(parseTimeCell('5:30 PM')).toEqual({ time: '17:30', date: null });
    expect(parseTimeCell(0.5)).toEqual({ time: '12:00', date: null });
    expect(parseTimeCell(46332.75)).toEqual({ time: '18:00', date: '2026-11-06' });
    expect(parseTimeCell('2026-11-07 07:10')).toEqual({ time: '07:10', date: '2026-11-07' });
    expect(parseTimeCell('24:00')).toEqual({ time: '24:00', date: null });
    expect(parseTimeCell('25:00')).toBeNull();
  });
  it('detects the header row, maps columns by name and validates the mapping', () => {
    const grid = [['รายงานเวลาทำงาน'], [], ['รหัสพนักงาน', 'ชื่อ', 'วันที่', 'เวลาเข้า', 'เวลาออก', 'เครื่อง', 'หมายเหตุ']];
    expect(findClockHeaderRow(grid)).toBe(2);
    const headers = headerLabels(grid, 2);
    const m = autoClockMapping(headers);
    expect(m).toMatchObject({ employee_code: 0, work_date: 2, clock_in: 3, clock_out: 4, device: 5, remark: 6 });
    expect(validMapping(m, headers.length)).toEqual([]);
    expect(validMapping({ employee_code: 0, work_date: 0, clock_in: 1 }, 3).join()).toContain('ใช้คอลัมน์เดียวกับ');
    expect(validMapping({ employee_code: 0 }, 3).length).toBe(2);
    // a remembered mapping wins when it still fits
    expect(autoClockMapping(headers, { employee_code: 0, work_date: 2, clock_in: 4, clock_out: 3 })).toMatchObject({ clock_in: 4, clock_out: 3 });
    expect(layoutSignature(['Emp Code', 'Date'])).toBe(layoutSignature(['emp_code', ' DATE ']));
  });
  it('parses rows: next-day clock-out, row-level errors, blank rows skipped', () => {
    const grid = [
      ['Emp Code', 'Date', 'In', 'Out'],
      ['E001', '2026-11-02', '08:00', '17:00'],
      ['E002', '2026-11-02', '22:00', '2026-11-03 07:00'],
      [null, null, null, null],
      ['E003', '2026-13-01', '08:00', '17:00'],
      ['E004', '2026-11-02', null, '17:00'],
      ['E005', '2026-11-02', '08:00', '24:00'],
      ['E006', '2026-11-02', '08:00', '2026-11-05 07:00'],
    ];
    const rows = parseClockRows(grid, 0, autoClockMapping(headerLabels(grid, 0)));
    expect(rows.map((r) => r.row_no)).toEqual([2, 3, 5, 6, 7, 8]);
    expect(rows[0]).toMatchObject({ employee_code: 'E001', work_date: '2026-11-02', clock_in: '08:00', clock_out: '17:00', out_next_day: false, issues: [] });
    expect(rows[1]).toMatchObject({ clock_out: '07:00', out_next_day: true, issues: [] });
    expect(rows[2]!.issues.map((i) => i.code)).toEqual(['bad_date']);
    expect(rows[3]!.issues.map((i) => i.code)).toEqual(['missing_clock_in']);
    expect(rows[4]).toMatchObject({ clock_out: '00:00', out_next_day: true });
    expect(rows[5]!.issues.map((i) => i.code)).toEqual(['out_date_range']);
    expect(rowStatus(rows[2]!.issues)).toBe('invalid');
    expect(rowStatus([{ code: 'duplicate_existing', level: 'info', message: '' }])).toBe('duplicate');
    expect(rowStatus([{ code: 'missing_clock_out', level: 'warning', message: '' }])).toBe('warning');
    expect(rowStatus([{ code: 'late', level: 'info', message: '' }])).toBe('valid');
  });
});

describe('file readers (XLSX, XLS, CSV)', () => {
  const rows = [['รหัสพนักงาน', 'วันที่', 'เวลาเข้า', 'เวลาออก', 'หมายเหตุ'], ['E001', 46332, 0.3333333333333333, 0.7083333333333334, 'ทดสอบ'], ['E002', '06/11/2569', '08:15', '17:30', null], [1003, 46332, 0.375, 0.75, true]];
  it('reads a BIFF8 .xls workbook (regular stream): strings, RK integers, numbers, booleans', async () => {
    const bytes = writeXls([{ name: 'Attendance', rows }, { name: 'Other', rows: [['x']] }]);
    expect(sniffFileType(bytes)).toBe('xls');
    const sheets = await readXls(bytes);
    expect(sheets.map((s) => s.name)).toEqual(['Attendance', 'Other']);
    // like the XLSX reader, trailing empty cells are not part of a row
    expect(sheets[0]!.rows).toEqual(rows.map((r) => (r[r.length - 1] === null ? r.slice(0, -1) : r)));
  });
  it('reads a small .xls kept in the mini stream', async () => {
    const sheets = await readXls(writeXls([{ name: 'S', rows: [['Emp Code', 'Date'], ['E1', 46000]] }], { mini: true }));
    expect(sheets[0]!.rows).toEqual([['Emp Code', 'Date'], ['E1', 46000]]);
  });
  it('reads a shared string table split across CONTINUE records (Thai text, mid-string split)', async () => {
    const many = Array.from({ length: 900 }, (_, i) => [`พนักงานทดสอบหมายเลข ${i} ชื่อยาวสำหรับทดสอบ`]);
    const sheets = await readXls(writeXls([{ name: 'Big', rows: many }]));
    expect(sheets[0]!.rows.length).toBe(900);
    expect(sheets[0]!.rows[0]![0]).toBe(many[0]![0]);
    expect(sheets[0]!.rows[899]![0]).toBe(many[899]![0]);
  });
  it('rejects files that are not .xls', async () => {
    await expect(readXls(new TextEncoder().encode('Emp Code,Date\n'))).rejects.toThrow('.xls');
    const broken = writeXls([{ name: 'S', rows: [['a']] }]);
    broken[512 + 4] = 0x05; // BOF version byte → BIFF5
    await expect(readXls(broken)).rejects.toThrow();
  });
  it('XLSX and CSV round-trip, content sniffing', async () => {
    const x = writeXlsx('S', rows);
    expect(sniffFileType(x)).toBe('xlsx');
    expect((await readXlsx(x))[0]!.rows[1]![0]).toBe('E001');
    const csv = '﻿Emp Code,Date,In,Out\r\nE001,2026-11-02,08:00,17:00\r\n';
    expect(sniffFileType(new TextEncoder().encode(csv))).toBe('text');
    expect(parseCsv(csv)[1]).toEqual(['E001', '2026-11-02', '08:00', '17:00']);
    expect(sniffFileType(new Uint8Array([0, 1, 2, 0]))).toBe('unknown');
  });
});
