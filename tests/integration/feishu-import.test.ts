// Feishu import separation (attendance / leave / overtime, one worksheet per import) — isolated local D1 with synthetic
// data only (companies ZFA / ZFB, employees ZFA01–ZFA03 / ZFB01). The synthetic workbook has the three worksheets of the
// real export (tests/fixtures/feishu-report.ts); each import posts exactly one of them as a cell grid. Checks: the
// worksheet must match the import, the daily report becomes one row per employee and day, leave / OT statuses stay as
// written, duplicates and idempotency, read-only rows, company scope, permissions, CSRF, per-type history and reports,
// and that payroll, leave requests, OT requests and existing attendance are untouched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/shared/payroll';
import { bangkokNow } from '../../src/worker/lib/time';
import { readXlsx, writeWorkbook, type Cell, type Sheet } from '../../src/shared/xlsx';
import { feishuReport } from '../fixtures/feishu-report';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const admin = () => c.admin as Client;
const staff = () => c.staff as Client;
const today = bangkokNow().date;
const START = addDays(today, -20);
const D = (n: number) => addDays(START, n);
const ids: Record<string, number> = {};
const count = (sql: string) => Number(H.sql(sql)[0]!.n);
let sheets: Sheet[];
const grid = (name: string): Cell[][] => sheets.find((s) => s.name === name)!.rows;
let n = 0;
const body = (company: number, sheet: string, x: Record<string, unknown> = {}) =>
  ({ company_id: company, file_name: 'Starlive+Dairy+Report_zz_test.xlsx', file_type: 'xlsx', file_size: 30_000, sha256: 'f'.repeat(63) + String(++n % 10), sheet_name: sheet, grid: grid(sheet), ...x });
const key = () => `zzfeishu-${crypto.randomUUID()}`;
/** payroll, requests and attendance created outside these imports: must be identical before and after */
const fingerprint = () => JSON.stringify(H.sql(`SELECT (SELECT COUNT(*) FROM employees) AS emp, (SELECT COUNT(*) FROM payroll_periods) AS pp, (SELECT COALESCE(MAX(updated_at), '') FROM payroll_periods) AS pu,
  (SELECT COUNT(*) FROM payslips) AS ps, (SELECT COALESCE(SUM(net), 0) FROM payslips) AS net, (SELECT COUNT(*) FROM payslip_archive) AS pa, (SELECT COUNT(*) FROM attendance_imports) AS ai,
  (SELECT COUNT(*) FROM leave_requests) AS lr, (SELECT COUNT(*) FROM overtime_requests) AS orq, (SELECT COUNT(*) FROM employee_pay_items) AS pi,
  (SELECT group_concat(key || '=' || value, ';') FROM (SELECT key, value FROM settings WHERE key LIKE 'payroll.%' ORDER BY key)) AS ps_settings,
  (SELECT COUNT(*) FROM attendance_records WHERE source <> 'import') AS att_other, (SELECT COUNT(*) FROM attendance_records WHERE status = 'absent') AS absent`));
let before = '';

beforeAll(async () => {
  H = await startHarness();
  for (const k of ['admin', 'staff', 'employee', 'manager', 'payroll']) c[k] = new Client(H.baseUrl);
  await c.admin!.login('it_admin', H.passwords.it_admin);
  await c.staff!.login('it_staff', H.passwords.it_staff);
  await c.employee!.login('it_employee', H.passwords.it_employee);
  await c.manager!.login('it_manager', H.passwords.it_manager);
  await c.payroll!.login('it_payroll', H.passwords.it_payroll);
  sheets = await readXlsx(writeWorkbook(feishuReport({ start: START, a: ['ZFA01', 'ZFA02', 'ZFA03'], other: 'ZFB01', unknown: 'ZZ-NOPE', prefix: '7100' })));
}, 180_000);
afterAll(async () => {
  await H?.stop();
});

describe('setup (synthetic companies ZFA / ZFB)', () => {
  it('creates companies and employees; records the payroll fingerprint', async () => {
    for (const code of ['ZFA', 'ZFB']) ids[code] = (await admin().post('/api/m/companies', { code, name: `zz_test ${code}`, active: true })).body.id;
    for (const [code, co] of [['ZFA01', 'ZFA'], ['ZFA02', 'ZFA'], ['ZFA03', 'ZFA'], ['ZFB01', 'ZFB']] as const) {
      const r = await admin().post('/api/m/employees', { emp_code: code, first_name: 'zz_test', last_name: code, company_id: ids[co], hire_date: addDays(today, -400), employment_type: 'permanent', status: 'active', base_salary: 20000 });
      expect(r.status, r.text).toBe(201);
      ids[code] = r.body.id;
    }
    // own-company user (DEMO) with the import permissions: must never see ZFA / ZFB
    H.sql(`INSERT INTO roles (code, name, description, privileged, system) VALUES ('zz_test_imp', 'zz_test import', 'zz_test', 0, 0);
      INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.value FROM roles r, json_each('["attendance_file.view","attendance_file.import","leave_import.view","leave_import.import","overtime_import.view","overtime_import.import"]') p WHERE r.code = 'zz_test_imp';
      INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.username = 'it_employee' AND r.code = 'zz_test_imp'`);
    before = fingerprint();
  });
});

describe('one import = one worksheet = one data domain', () => {
  it('a leave or overtime worksheet is refused by the attendance import, and the other way round', async () => {
    const a = await staff().post('/api/attendance-files/preview', body(ids.ZFA!, 'Leave', { template: 'FEISHU_DAILY_ATTENDANCE_V1' }));
    expect(a.status).toBe(400);
    expect(a.body.error.message).toContain('การลา › นำเข้าข้อมูลการลา');
    expect((await staff().post('/api/attendance-files/preview', body(ids.ZFA!, 'Overtime'))).body.error.message).toContain('คำขอ OT');
    const l = await staff().post('/api/leave-imports/preview', body(ids.ZFA!, 'Overtime'));
    expect(l.status).toBe(400);
    expect(l.body.error.message).toContain('ข้อมูล OT ไม่ใช่ข้อมูลการลา');
    expect((await staff().post('/api/leave-imports/preview', body(ids.ZFA!, 'Sheet1'))).status).toBe(400);
    expect((await staff().post('/api/overtime-imports/preview', body(ids.ZFA!, 'Leave'))).status).toBe(400);
    expect((await staff().post('/api/overtime-imports/preview', body(ids.ZFA!, 'Sheet1'))).status).toBe(400);
  });
  it('the template must fit the worksheet', async () => {
    const r = await staff().post('/api/attendance-files/preview', body(ids.ZFA!, 'Sheet1')); // template defaults to the time-clock file
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain('FEISHU_DAILY_ATTENDANCE_V1');
    expect((await staff().post('/api/attendance-files/preview', body(ids.ZFA!, 'Sheet1', { template: 'NOPE' }))).status).toBe(400);
  });
});

describe('attendance: FEISHU_DAILY_ATTENDANCE_V1', () => {
  const T = { template: 'FEISHU_DAILY_ATTENDANCE_V1' };
  let batch = 0;
  it('preview: one row per employee and day, every case validated', async () => {
    const r = await staff().post('/api/attendance-files/preview', body(ids.ZFA!, 'Sheet1', T));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ template: 'FEISHU_DAILY_ATTENDANCE_V1', sheet_name: 'Sheet1', header_row: 2, mapping_problems: [] });
    expect(r.body.day_columns).toHaveLength(7);
    expect(r.body.summary).toMatchObject({ source_rows: 6, empty_days: 25, total: 17, invalid: 3, duplicate: 1, importable: 13, with_clock: 9, events: 7 });
    const row = (code: string, d: number, nth = 0) => r.body.rows.filter((x: { employee_code: string; work_date: string }) => x.employee_code === code && x.work_date === D(d))[nth];
    expect(row('ZFA01', 0, 1).issues.map((i: { code: string }) => i.code)).toContain('duplicate_in_file');
    expect(row('ZZ-NOPE', 0).issues.map((i: { code: string }) => i.code)).toContain('unknown_employee');
    expect(row('ZFB01', 0).issues.map((i: { code: string }) => i.code)).toContain('wrong_company');
    expect(row('ZFA03', 0).issues.map((i: { code: string }) => i.code)).toContain('unreadable_cell');
    expect(row('ZFA01', 4)).toMatchObject({ clock_in: null, clock_out: null, status: 'warning', attendance_status: null });
    expect(row('ZFA02', 0)).toMatchObject({ clock_in: null, clock_out: '18:00', in_result: { result: 'no_record', time: '10:27' } });
  });
  it('confirm: raw rows, processed attendance for days with clock times, events kept, nothing else created', async () => {
    const r = await staff().post('/api/attendance-files', { ...body(ids.ZFA!, 'Sheet1', T), confirm: true, idempotency_key: key() });
    expect(r.status, r.text).toBe(201);
    batch = r.body.id;
    expect(r.body).toMatchObject({ template_code: 'FEISHU_DAILY_ATTENDANCE_V1', sheet_name: 'Sheet1', source_rows: 6, total_rows: 17, imported_count: 13, record_count: 9, duplicate_count: 1, invalid_count: 3, status: 'partial' });
    // one wrangler call for every check (each call takes seconds)
    const [counts, late, night, early, noRecord, leave, ot] = H.sqlEach(`
      SELECT (SELECT COUNT(*) FROM attendance_raw_records WHERE batch_id = ${batch}) AS raw, (SELECT COUNT(*) FROM attendance_records WHERE import_batch_id = ${batch}) AS records,
             (SELECT COUNT(*) FROM attendance_day_events WHERE batch_id = ${batch}) AS events,
             (SELECT COUNT(*) FROM attendance_records WHERE employee_id = ${ids.ZFA01} AND work_date IN ('${D(3)}', '${D(4)}')) AS no_clock_days,
             (SELECT COUNT(*) FROM leave_import_records) + (SELECT COUNT(*) FROM overtime_import_records) AS requests,
             (SELECT COUNT(*) FROM audit_logs WHERE action = 'attendance_file.imported' AND entity_id = '${batch}') AS audits,
             (SELECT COUNT(*) FROM import_mapping_templates WHERE company_id = ${ids.ZFA} AND import_type = 'attendance' AND template_code = 'FEISHU_DAILY_ATTENDANCE_V1') AS mappings;
      SELECT status, clock_in, clock_out, late_minutes FROM attendance_records WHERE employee_id = ${ids.ZFA01} AND work_date = '${D(1)}';
      SELECT clock_out_next_day, worked_minutes FROM attendance_records WHERE employee_id = ${ids.ZFA02} AND work_date = '${D(3)}';
      SELECT early_leave_minutes FROM attendance_records WHERE employee_id = ${ids.ZFA02} AND work_date = '${D(4)}';
      SELECT in_result, out_result, status FROM attendance_raw_records WHERE batch_id = ${batch} AND employee_id = ${ids.ZFA01} AND work_date = '${D(4)}';
      SELECT kind, label, amount, unit FROM attendance_day_events WHERE employee_id = ${ids.ZFA01} AND work_date = '${D(2)}';
      SELECT overnight FROM attendance_day_events WHERE employee_id = ${ids.ZFA02} AND work_date = '${D(3)}' AND kind = 'overtime';`);
    // no record / full-day leave days: raw row and events only, no attendance record; attendance import writes no leave / OT records
    expect(counts![0]).toEqual({ raw: 17, records: 9, events: 7, no_clock_days: 0, requests: 0, audits: 1, mappings: 1 });
    expect(late![0]).toMatchObject({ status: 'late', clock_in: '09:09', clock_out: '18:01', late_minutes: 9 });
    expect(night![0]).toMatchObject({ clock_out_next_day: 1, worked_minutes: 543 });
    expect(early![0]).toMatchObject({ early_leave_minutes: 30 });
    expect(noRecord![0]).toMatchObject({ in_result: 'No record', out_result: 'No record', status: 'warning' });
    expect(leave).toEqual([{ kind: 'leave', label: 'Sick leave', amount: 4, unit: 'hour' }]);
    expect(ot![0]).toMatchObject({ overnight: 1 });
  });
  it('raw rows and events cannot be edited or deleted', () => {
    expect(() => H.sql(`UPDATE attendance_raw_records SET in_result = 'Regular' WHERE batch_id = ${batch}`)).toThrow();
    expect(() => H.sql(`DELETE FROM attendance_day_events WHERE batch_id = ${batch}`)).toThrow();
    expect(() => H.sql(`UPDATE attendance_day_events SET amount = 0 WHERE batch_id = ${batch}`)).toThrow();
  });
  it('importing the same worksheet again adds nothing (duplicates); the same confirmation returns the same batch', async () => {
    const k = key();
    const again = await staff().post('/api/attendance-files', { ...body(ids.ZFA!, 'Sheet1', T), confirm: true, idempotency_key: k });
    expect(again.status, again.text).toBe(201);
    expect(again.body).toMatchObject({ imported_count: 0, record_count: 0, duplicate_count: 14 });
    expect(count(`SELECT COUNT(*) AS n FROM attendance_day_events WHERE batch_id = ${again.body.id}`)).toBe(0);
    const repeat = await staff().post('/api/attendance-files', { ...body(ids.ZFA!, 'Sheet1', T), confirm: true, idempotency_key: k });
    expect(repeat.body).toMatchObject({ id: again.body.id, repeated: true });
    const previewAgain = await staff().post('/api/attendance-files/preview', body(ids.ZFA!, 'Sheet1', T));
    expect(previewAgain.body.remembered).toBe(true);
  });
  it('history, batch detail with events and the error report', async () => {
    const list = await staff().get('/api/attendance-files');
    expect(list.body.find((b: { id: number }) => b.id === batch)).toMatchObject({ template_code: 'FEISHU_DAILY_ATTENDANCE_V1', sheet_name: 'Sheet1' });
    const d = await staff().get(`/api/attendance-files/${batch}`);
    const row = d.body.rows.find((x: { employee_code: string; work_date: string }) => x.employee_code === 'ZFA02' && x.work_date === D(3));
    expect(row).toMatchObject({ source_ref: expect.stringMatching(/^[A-Z]+5$/), in_result: 'Regular', events: [expect.objectContaining({ kind: 'overtime', overnight: 1 })] });
    const rep = await staff().get(`/api/attendance-files/${batch}/report?format=csv`);
    expect(rep.status).toBe(200);
    expect(rep.text).toContain('ช่องในไฟล์');
    expect(rep.text).toContain('ไม่พบพนักงานรหัส ZZ-NOPE');
    expect(rep.text).not.toContain('วันหยุดตามกะ (Break)'); // valid rest days are not errors
  });
});

describe('leave: FEISHU_LEAVE_V1', () => {
  let batch = 0;
  it('preview: statuses as written, duplicates, invalid rows', async () => {
    const r = await staff().post('/api/leave-imports/preview', body(ids.ZFA!, 'Leave'));
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ import_type: 'leave', template: 'FEISHU_LEAVE_V1', header_row: 1, mapping_problems: [] });
    expect(r.body.summary).toMatchObject({ total: 9, importable: 5, duplicate: 1, invalid: 3, approval: { approved: 2, pending: 1, rejected: 1, cancelled: 1 } });
    const row = (no: string) => r.body.rows.find((x: { request_no: string }) => x.request_no === `7100${no}`);
    expect(row('L06').issues.map((i: { code: string }) => i.code)).toContain('wrong_company');
    expect(row('L07').issues.map((i: { code: string }) => i.code)).toContain('invalid_range');
    expect(row('L08')).toMatchObject({ approval_status: null, status: 'invalid' });
  });
  it('confirm: one record per Request ID with its status unchanged; no leave request, attendance or payroll change', async () => {
    const attendance = count('SELECT COUNT(*) AS n FROM attendance_records');
    const r = await staff().post('/api/leave-imports', { ...body(ids.ZFA!, 'Leave'), confirm: true, idempotency_key: key() });
    expect(r.status, r.text).toBe(201);
    batch = r.body.id;
    expect(r.body).toMatchObject({ import_type: 'leave', template_code: 'FEISHU_LEAVE_V1', sheet_name: 'Leave', total_rows: 9, imported_count: 5, duplicate_count: 1, invalid_count: 3 });
    expect(H.sql(`SELECT request_no, approval_status FROM leave_import_records WHERE batch_id = ${batch} AND status IN ('valid', 'warning') ORDER BY request_no`)).toEqual([
      { request_no: '7100L01', approval_status: 'approved' }, { request_no: '7100L02', approval_status: 'pending' }, { request_no: '7100L03', approval_status: 'rejected' },
      { request_no: '7100L04', approval_status: 'cancelled' }, { request_no: '7100L09', approval_status: 'approved' },
    ]);
    expect(count(`SELECT COUNT(*) AS n FROM leave_import_records WHERE batch_id = ${batch}`)).toBe(9); // every row kept
    expect(H.sql(`SELECT start_at, end_at, duration, duration_unit FROM leave_import_records WHERE request_no = '7100L02'`)[0]).toMatchObject({ start_at: `${D(3)} 09:00`, end_at: `${D(4)} 18:00`, duration: 16, duration_unit: 'hour' });
    expect(count('SELECT COUNT(*) AS n FROM attendance_records')).toBe(attendance);
    expect(count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'leave_import.imported' AND entity_id = '${batch}'`)).toBe(1);
  });
  it('rows are read-only: an imported status cannot be changed to approved', () => {
    expect(() => H.sql("UPDATE leave_import_records SET approval_status = 'approved' WHERE request_no = '7100L02'")).toThrow();
    expect(() => H.sql(`DELETE FROM leave_import_records WHERE batch_id = ${batch}`)).toThrow();
  });
  it('duplicate import by Request ID adds nothing; mapping template saved per company and type', async () => {
    const r = await staff().post('/api/leave-imports', { ...body(ids.ZFA!, 'Leave'), confirm: true, idempotency_key: key() });
    expect(r.body).toMatchObject({ imported_count: 0, duplicate_count: 6, status: 'failed' });
    expect(count("SELECT COUNT(*) AS n FROM leave_import_records WHERE request_no = '7100L01' AND status IN ('valid', 'warning')")).toBe(1);
    expect(H.sql(`SELECT import_type, template_code FROM import_mapping_templates WHERE company_id = ${ids.ZFA} ORDER BY import_type`)).toEqual([
      { import_type: 'attendance', template_code: 'FEISHU_DAILY_ATTENDANCE_V1' }, { import_type: 'leave', template_code: 'FEISHU_LEAVE_V1' },
    ]);
  });
  it('history and report are per type: a leave batch is not an overtime batch', async () => {
    const list = await staff().get('/api/leave-imports');
    expect(list.body.map((b: { import_type: string }) => b.import_type)).toEqual(['leave', 'leave']);
    expect((await staff().get('/api/overtime-imports')).body).toEqual([]);
    expect((await staff().get(`/api/overtime-imports/${batch}`)).status).toBe(404);
    const d = await staff().get(`/api/leave-imports/${batch}`);
    expect(d.body.rows).toHaveLength(9);
    const rep = await staff().get(`/api/leave-imports/${batch}/report?format=xlsx`);
    expect(rep.status).toBe(200);
    expect(rep.headers.get('content-type')).toContain('spreadsheetml');
    expect(count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'leave_import.report_downloaded' AND entity_id = '${batch}'`)).toBe(1);
  });
});

describe('overtime: FEISHU_OVERTIME_V1', () => {
  let batch = 0;
  it('preview: overnight request in two details, statuses, duplicate and invalid durations', async () => {
    const r = await staff().post('/api/overtime-imports/preview', body(ids.ZFA!, 'Overtime'));
    expect(r.status, r.text).toBe(200);
    expect(r.body.summary).toMatchObject({ total: 10, importable: 6, duplicate: 1, invalid: 3, approval: { approved: 3, pending: 1, rejected: 1, cancelled: 1 } });
  });
  it('confirm: rows per request detail, no OT request, no OT pay, no payroll item', async () => {
    const k = key();
    const r = await staff().post('/api/overtime-imports', { ...body(ids.ZFA!, 'Overtime'), confirm: true, idempotency_key: k });
    expect(r.status, r.text).toBe(201);
    batch = r.body.id;
    expect(r.body).toMatchObject({ import_type: 'overtime', template_code: 'FEISHU_OVERTIME_V1', imported_count: 6, duplicate_count: 1, invalid_count: 3 });
    expect(H.sql(`SELECT detail_no, work_date, request_hours, detail_hours, overnight, ot_start_at, ot_end_at FROM overtime_import_records WHERE request_no = '7100O05' AND status = 'valid' ORDER BY detail_no`)).toEqual([
      { detail_no: 1, work_date: D(3), request_hours: 3, detail_hours: 2, overnight: 1, ot_start_at: `${D(3)} 22:00`, ot_end_at: `${D(4)} 01:00` },
      { detail_no: 2, work_date: D(4), request_hours: 3, detail_hours: 1, overnight: 1, ot_start_at: `${D(3)} 22:00`, ot_end_at: `${D(4)} 01:00` },
    ]);
    const repeat = await staff().post('/api/overtime-imports', { ...body(ids.ZFA!, 'Overtime'), confirm: true, idempotency_key: k });
    expect(repeat.body).toMatchObject({ id: batch, repeated: true });
    expect(() => H.sql(`UPDATE overtime_import_records SET detail_hours = 9 WHERE batch_id = ${batch}`)).toThrow();
  });
});

describe('security: company scope, permissions, CSRF', () => {
  it('an own-company user cannot import into another company, and codes of other companies read as unknown', async () => {
    const other = await c.employee!.post('/api/leave-imports/preview', body(ids.ZFA!, 'Leave'));
    expect([403, 404]).toContain(other.status);
    const own = await c.employee!.post('/api/leave-imports/preview', body(Number(H.sql("SELECT id FROM companies WHERE code = 'DEMO'")[0]!.id), 'Leave'));
    expect(own.status, own.text).toBe(200);
    const codes = own.body.rows.flatMap((r: { issues: Array<{ code: string }> }) => r.issues.map((i) => i.code));
    expect(codes).toContain('unknown_employee');
    expect(codes).not.toContain('wrong_company');
    expect((await c.employee!.get('/api/leave-imports')).body).toEqual([]);
    expect((await c.employee!.get(`/api/attendance-files`)).body.some((b: { company_id: number }) => b.company_id === ids.ZFA)).toBe(false);
  });
  it('permissions: manager has none; payroll officer may view history but not import', async () => {
    for (const p of ['/api/leave-imports', '/api/overtime-imports', '/api/leave-imports/fields']) expect((await c.manager!.get(p)).status).toBe(403);
    expect((await c.manager!.post('/api/overtime-imports/preview', body(ids.ZFA!, 'Overtime'))).status).toBe(403);
    expect((await c.payroll!.get('/api/leave-imports')).status).toBe(200);
    expect((await c.payroll!.get('/api/overtime-imports')).status).toBe(200);
    expect((await c.payroll!.post('/api/leave-imports/preview', body(ids.ZFA!, 'Leave'))).status).toBe(403);
    expect((await new Client(H.baseUrl).get('/api/leave-imports')).status).toBe(401);
  });
  it('CSRF: a confirmation without the request header is refused', async () => {
    const r = await staff().req('POST', '/api/overtime-imports', { ...body(ids.ZFA!, 'Overtime'), confirm: true, idempotency_key: key() }, { 'x-hr-requested': '0' });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('csrf');
  });
});

describe('payroll protection', () => {
  it('payroll, leave requests, OT requests, settings and other attendance are unchanged', () => {
    expect(fingerprint()).toBe(before);
    expect(count("SELECT COUNT(*) AS n FROM attendance_records WHERE status = 'absent'")).toBe(0);
  });
});
