// Synthetic Feishu-style fixtures (same header structure as the real exports, no real personal data).
import { writeFileSync } from 'node:fs';
import { writeXlsx } from '../../../src/shared/xlsx';

const dir = process.argv[2] as string;
const band = ['Name', 'Basic information', '', '', '', 'Attendance metrics', '', '', '', '', '', '', ''];
const head = ['Name', 'Employee ID', 'Department', 'Employment date', 'Expected working days', 'Expected working hours(hr)', 'Workday attendance', 'Actual working hours(hr)', 'Absence days', 'Absence hours(hr)', 'Total overtime duration(hr)', 'Personal leave（Unpaid）(hr)', 'Unpaid Sick Leave(hr)'];
const row = (code: string, ot = '0', unpaid = '0') => ['ทดสอบ', code, '-', '-', '22', '176.0', '22', '176.0', '0', '0', ot, unpaid, '-'];
writeFileSync(`${dir}/For Payroll System_20261026_20261125.xlsx`, writeXlsx('Sheet1', [band, head, row('E007', '2', '8'), row('E006'), row('E001'), row('E001'), row('ZZ999')]));
const csv = [['Employee ID', 'Name', 'Expected working hours(hr)', 'Actual working hours(hr)', 'Total overtime duration(hr)'], ['E007', 'x', '176', '170', '3'], ['E006', 'y', '176', '176', '0']];
writeFileSync(`${dir}/For Payroll System+A_20261103_20261103.csv`, '\uFEFF' + csv.map((r) => r.join(',')).join('\r\n'));
process.stdout.write('fixtures written\n');
