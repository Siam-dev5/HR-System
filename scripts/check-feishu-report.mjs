// Pre-import check of a Feishu "Daily Report" workbook (Sheet1 / Leave / Overtime) against the templates
// FEISHU_DAILY_ATTENDANCE_V1, FEISHU_LEAVE_V1 and FEISHU_OVERTIME_V1. Read-only: nothing is imported, written or
// uploaded. Prints only structure and counts — never names, employee codes, request numbers or other values — so the
// output can be shared safely.
//
// Usage: node scripts/check-feishu-report.mjs "<path to Starlive+Dairy+Report_YYYYMMDD_YYYYMMDD.xlsx>"
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  stdin: { contents: "export * from './src/shared/feishu-daily'; export * from './src/shared/feishu-requests'; export * from './src/shared/import-templates'; export { readXlsx } from './src/shared/xlsx';", resolveDir: root, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
});
const L = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/check-feishu-report.mjs <file.xlsx>');
  process.exit(2);
}
const tally = (a) => Object.entries(a.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {})).map(([k, n]) => `${k} ${n}`).join(' · ') || '-';
const sheets = await L.readXlsx(readFileSync(file));
console.log(`=== ${basename(file)} · ${sheets.length} worksheet(s)`);
let problems = 0;
for (const s of sheets) {
  const kind = L.detectSheet(s.rows);
  console.log(`\n--- worksheet "${s.name}": ${kind.template ?? 'not a known template'}`);
  if (kind.template === 'FEISHU_DAILY_ATTENDANCE_V1') {
    const hr = L.findDailyHeaderRow(s.rows);
    const m = L.autoDailyMapping(s.rows[hr]);
    const days = L.dayColumns(s.rows[hr]);
    const mp = L.dailyMappingProblems(m, s.rows[hr].length, days.map((d) => d.col));
    console.log(`header row ${hr + 1} · ${days.length} day columns ${days[0]?.date ?? '-'} → ${days.at(-1)?.date ?? '-'} · mapping problems: ${mp.join('; ') || 'none'}`);
    const { rows, sourceRows, emptyDays } = L.parseDailyRows(s.rows, hr, m);
    console.log(`employee rows ${sourceRows} → daily rows ${rows.length} (blank / "-" days ${emptyDays}) · duplicate employee+date ${rows.length - new Set(rows.map((r) => `${r.employee_code}|${r.work_date}`)).size}`);
    console.log(`clock-in results: ${tally(rows.map((r) => r.day.clock_in?.result ?? (r.day.kind === 'rest' ? 'rest' : 'none')))}`);
    console.log(`clock-out results: ${tally(rows.map((r) => r.day.clock_out?.result ?? (r.day.kind === 'rest' ? 'rest' : 'none')))}`);
    console.log(`events: ${tally(rows.flatMap((r) => r.day.events.map((e) => e.kind + (e.overnight ? ' (overnight)' : ''))))}`);
    console.log(`days with clock times ${rows.filter((r) => r.clock_in || r.clock_out).length} · unreadable cells ${rows.filter((r) => r.day.unreadable.length).length}`);
    problems += mp.length + rows.filter((r) => r.day.unreadable.length).length;
  } else if (kind.type === 'leave' || kind.type === 'overtime') {
    const { headerRow } = L.detectRequestSheet(s.rows);
    const headers = L.requestHeaders(s.rows, headerRow);
    const m = L.autoRequestMapping(kind.type, headers);
    const mp = L.requestMappingProblems(kind.type, m, headers.length);
    console.log(`header row ${headerRow + 1} · mapping: ${L.REQUEST_FIELDS[kind.type].map((f) => `${f.key}${m[f.key] === undefined || m[f.key] === null ? ' ✗' : ''}`).join(', ')}`);
    console.log(`mapping problems: ${mp.join('; ') || 'none'}`);
    const rows = mp.length ? [] : L.parseRequestRows(kind.type, s.rows, headerRow, m);
    console.log(`rows ${rows.length} · result ${tally(rows.map((r) => L.requestRowStatus(r.issues)))} · approval ${tally(rows.map((r) => r.approval_status ?? 'unknown'))} · unit ${tally(rows.map((r) => r.unit ?? 'none'))}`);
    console.log(`issues: ${tally(rows.flatMap((r) => r.issues.map((i) => i.code)))}`);
    if (kind.type === 'overtime') console.log(`details per request: ${tally(rows.map((r) => `detail ${r.detail_no}`))} · overnight rows ${rows.filter((r) => r.overnight).length}`);
    problems += mp.length + rows.filter((r) => L.requestRowStatus(r.issues) === 'invalid').length;
  }
}
console.log(problems ? `\nRESULT: ${problems} problem(s) — see above (rows marked invalid are refused by the import)` : '\nRESULT: structure OK — import each worksheet in its own menu');
process.exit(problems ? 1 : 0);
