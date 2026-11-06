// Synthetic time-clock files for ui-attendance-shifts (zz_test employees only, no real personal data).
// usage: node mkclock.mjs <dir> <YYYY-MM-DD work date>
import { writeFileSync } from 'node:fs';
import { writeXlsx } from '../../../src/shared/xlsx';
import { writeXls } from './xls-writer';

const [dir, day] = process.argv.slice(2) as [string, string];
const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const head = ['รหัสพนักงาน', 'วันที่', 'เวลาเข้า', 'เวลาออก', 'เครื่องบันทึกเวลา', 'หมายเหตุ'];
const rows = [
  ['ZS01', day, '07:55', '17:02', 'HQ-01', ''],
  ['ZS02', day, '08:20', '', 'HQ-01', 'ลืมสแกนออก'],
  ['ZS03', day, '21:58', '07:01', 'HQ-02', 'กะดึก'],
  ['ZS04', day, '', '17:00', 'HQ-01', 'ลืมสแกนเข้า'],
  ['ZZ999', day, '08:00', '17:00', 'HQ-01', 'ไม่มีรหัสนี้'],
  ['ZS01', day, '08:00', '17:00', 'HQ-01', 'ซ้ำ'],
];
writeFileSync(`${dir}/clock.csv`, '﻿' + [head, ...rows].map((r) => r.join(',')).join('\r\n'));
writeFileSync(`${dir}/clock.xlsx`, writeXlsx('Attendance', [['รายงานเวลาทำงาน zz_test'], [], head, ...rows.slice(0, 2)]));
writeFileSync(`${dir}/clock.xls`, writeXls([{ name: 'Attendance', rows: [head, ['ZS05', day, '08:00', `${next} 01:00`, 'HQ-03', '']] }]));
writeFileSync(`${dir}/fake.xlsx`, 'this is not a workbook');
process.stdout.write('clock fixtures written\n');
