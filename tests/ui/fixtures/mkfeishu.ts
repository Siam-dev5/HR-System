// Synthetic Feishu Daily Report workbook (Sheet1 / Leave / Overtime) for ui-feishu-imports — zz_test data only.
// usage: node mkfeishu.mjs <dir> <YYYY-MM-DD first of seven past work dates>
import { writeFileSync } from 'node:fs';
import { writeWorkbook } from '../../../src/shared/xlsx';
import { feishuReport } from '../../fixtures/feishu-report';

const [dir, start] = process.argv.slice(2) as [string, string];
const sheets = feishuReport({ start, a: ['ZFA01', 'ZFA02', 'ZFA03'], other: 'ZFB01', unknown: 'ZZ-NOPE', prefix: '7200' });
writeFileSync(`${dir}/feishu-report.xlsx`, writeWorkbook(sheets));
process.stdout.write(`feishu fixture written (${sheets.map((s) => `${s.name}:${s.rows.length}`).join(', ')})\n`);
