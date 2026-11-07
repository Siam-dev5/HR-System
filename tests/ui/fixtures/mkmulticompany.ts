// Synthetic combined daily report (three companies told apart by the Group column) for ui-feishu-multicompany —
// zz_test data only. usage: node mkmulticompany.mjs <dir> <YYYY-MM-DD first of three past work dates>
import { writeFileSync } from 'node:fs';
import { writeWorkbook } from '../../../src/shared/xlsx';
import { dailySheet } from '../../fixtures/feishu-report';

const [dir, start] = process.argv.slice(2) as [string, string];
const REG = 'Regular(09:00),Regular(18:00)';
const sheet = dailySheet(start, [
  { code: 'ZQA01', group: 'Team A', cells: [REG, 'No record(-),No record(-)', REG] },
  { code: 'ZQA02', group: 'Team A', cells: ['No record(-),No record(-)', 'Regular(08:55),Regular(18:10)', REG] },
  { code: 'ZQA90', group: 'Team A', cells: [REG] }, // an employee of company B whose code looks like company A's
  { code: 'ZQB01', group: 'Team B', cells: [REG, 'Regular(21:58),Regular(07:01);Overtime(22:00-01:00)'] },
  { code: 'ZQC01', group: 'Team C', cells: ['Late in5min(09:05),Leave(13:00);Sick leave(4 hr,13:00-18:00)'] },
  { code: 'ZQC02', group: '', cells: [REG] },
  { code: 'ZQA01', group: 'Somewhere', cells: [REG] },
]);
writeFileSync(`${dir}/multi-company.xlsx`, writeWorkbook([sheet]));
process.stdout.write('multi-company fixture written\n');
