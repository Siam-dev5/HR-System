// Pre-import check of a Feishu attendance export (.xlsx / .csv). Read-only: nothing is imported, written or uploaded.
// Prints only structure and counts (header row, detected format, column mapping, numeric/date problems) —
// never names or individual values — so the output can be shared safely.
//
// Usage: node scripts/check-feishu-file.mjs "<path to For Payroll System_YYYYMMDD_YYYYMMDD.xlsx>" [more files…]
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  stdin: { contents: "export * from './src/shared/feishu'; export { readXlsx, parseCsv } from './src/shared/xlsx';", resolveDir: root, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
});
const lib = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const { ATTENDANCE_FIELDS, analyzeGrid, findHeaderRow, normalizeHeader, normalizeRows, readXlsx, parseCsv } = lib;

const files = process.argv.slice(2);
if (!files.length) {
  console.error('usage: node scripts/check-feishu-file.mjs <file.xlsx|file.csv> [...]');
  process.exit(2);
}
let failed = false;
for (const file of files) {
  console.log(`\n=== ${basename(file)}`);
  const buf = readFileSync(file);
  let grid;
  let sheet = '(csv)';
  if (/\.csv$/i.test(file)) {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-874').decode(buf); }
    grid = parseCsv(text);
  } else {
    const sheets = await readXlsx(buf);
    const s = sheets.find((x) => findHeaderRow(x.rows) >= 0) ?? sheets[0];
    grid = s?.rows ?? [];
    sheet = `${s?.name} (of ${sheets.length} sheet(s))`;
  }
  const a = analyzeGrid(grid, basename(file));
  const rows = normalizeRows(grid, a);
  console.log(`sheet: ${sheet}`);
  console.log(`header row: ${a.headerRow >= 0 ? a.headerRow + 1 : 'NOT FOUND'} · data rows: ${rows.length} · layout: ${a.layout}`);
  console.log(`format: ${a.format === 'days' ? 'A (Expected Working Days)' : a.format === 'hours' ? 'B (Expected Working Hours)' : 'NOT DETECTED'}`);
  console.log(`period in file name / columns: ${a.sourceStart ?? '-'} → ${a.sourceEnd ?? '-'}`);
  for (const i of a.issues) console.log(`FILE ISSUE: ${i.message}`);
  console.log('mapping (HR field ← Feishu column):');
  for (const f of ATTENDANCE_FIELDS) {
    const idx = a.mapping[f.key];
    const h = idx === undefined || idx === null ? null : a.headers[idx];
    const unit = h ? normalizeHeader(h).unit : null;
    const filled = h ? rows.filter((r) => r.values[f.key] !== null && r.values[f.key] !== undefined).length : 0;
    console.log(`  ${h ? '✓' : '·'} ${f.key.padEnd(28)} ${h ? `← "${h}"${unit ? ` [${unit}]` : ''} · ${filled}/${rows.length} filled` : '(not in file)'}`);
  }
  const unmapped = a.headers.filter((h, i) => h && !Object.values(a.mapping).includes(i) && !/^\d{4}-\d{2}-\d{2}\b/.test(h));
  console.log(`columns not used (${unmapped.length}): ${unmapped.join(' | ')}`);
  const leaveCols = a.headers.filter((h) => /leave|假|ลา/i.test(h));
  console.log(`leave columns present: ${leaveCols.join(' | ') || '-'}`);
  const count = (code) => rows.filter((r) => r.issues.some((i) => i.code === code)).length;
  console.log(`checks: missing Employee ID ${count('missing_employee_id')} · duplicate ID ${count('duplicate_employee')} · invalid number ${count('invalid_number')} · negative ${count('negative_value')} · invalid date ${count('invalid_date')}`);
  console.log(`OT > 0 rows: ${rows.filter((r) => (r.values.feishu_overtime_hours ?? 0) > 0).length} · unpaid leave > 0 rows: ${rows.filter((r) => (r.values.unpaid_sick_leave_hours ?? 0) + (r.values.unpaid_personal_leave_hours ?? 0) > 0).length}`);
  if (a.issues.length || !a.format) failed = true;
}
console.log(failed ? '\nRESULT: needs attention before import (see FILE ISSUE / NOT DETECTED above)' : '\nRESULT: structure OK — continue with the import wizard (Analyze → Preview → Confirm)');
process.exit(failed ? 1 : 0);
