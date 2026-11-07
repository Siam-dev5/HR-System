// Feishu import V1.1 — one daily report for several companies, and attendance exemptions — isolated local D1 with
// synthetic data only (companies ZMA / ZMB / ZMC). The Group column of the file identifies the company through an
// explicit rule. Checks: no cross-company employee matching (an employee code of company B that looks like company A's
// codes is refused under A), rows without a company are kept apart and never imported, preview is read-only, one batch
// per company with its own audit, idempotency, the exemption API (permissions, overlap, revoke, company scope), the
// exemption effect on warnings only, and payroll / leave / OT untouched.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/shared/payroll';
import { bangkokNow } from '../../src/worker/lib/time';
import type { Cell } from '../../src/shared/xlsx';
import { dailySheet } from '../fixtures/feishu-report';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const admin = () => c.admin as Client;
const staff = () => c.staff as Client;
const today = bangkokNow().date;
const START = addDays(today, -15);
const D = (n: number) => addDays(START, n);
const ids: Record<string, number> = {};
const key = () => `zzmulti-${crypto.randomUUID()}`;
const REG = 'Regular(09:00),Regular(18:00)';
const grid: Cell[][] = dailySheet(START, [
  { code: 'ZMA01', group: 'Team A', cells: [REG, 'No record(-),No record(-)', REG] },
  { code: 'ZMA02', group: 'Team A', cells: ['No record(-),No record(-)', 'Regular(08:55),Regular(18:10)', 'Regular(09:00),Pending(-)'] }, // exempt from D(0)
  { code: 'ZMA90', group: 'Team A', cells: [REG] }, // a company B employee whose code looks like company A's
  { code: 'ZMB01', group: 'Team B', cells: [REG, 'Regular(21:58),Regular(07:01);Overtime(22:00-01:00)'] },
  { code: 'ZMC01', group: 'Team C', cells: ['Late in5min(09:05),Leave(13:00);Sick leave(4 hr,13:00-18:00)'] },
  { code: 'ZMC02', group: '', cells: [REG] }, // no company identity
  { code: 'ZMA01', group: 'Somewhere', cells: [REG] }, // a value nobody matched
  { code: 'ZZ-NOPE', group: 'Team B', cells: [REG] }, // unknown employee
]).rows;
let n = 0;
const rule = () => ({ column: 6, values: [{ value: 'Team A', company_id: ids.ZMA }, { value: 'Team B', company_id: ids.ZMB }, { value: 'Team C', company_id: ids.ZMC }, { value: 'Somewhere', company_id: null }] });
const combined = (x: Record<string, unknown> = {}) => ({
  company_mode: 'combined', company_rule: rule(), template: 'FEISHU_DAILY_ATTENDANCE_V1', file_name: 'Starlive+Dairy+Report_zz_multi.xlsx', file_type: 'xlsx', file_size: 20_000,
  sha256: 'e'.repeat(63) + String(++n % 10), sheet_name: 'Sheet1', grid, ...x,
});
const counts = () => H.sql(`SELECT (SELECT COUNT(*) FROM attendance_records) ar, (SELECT COUNT(*) FROM attendance_raw_records) raw, (SELECT COUNT(*) FROM attendance_file_imports) b,
  (SELECT COUNT(*) FROM import_groups) g, (SELECT COUNT(*) FROM import_group_unassigned_rows) u, (SELECT COUNT(*) FROM import_company_rules) cr, (SELECT COUNT(*) FROM import_mapping_templates) mt,
  (SELECT COUNT(*) FROM audit_logs) au`)[0];
const fingerprint = () => JSON.stringify(H.sql(`SELECT (SELECT COUNT(*) FROM payroll_periods) pp, (SELECT COUNT(*) FROM payslips) ps, (SELECT COALESCE(SUM(net), 0) FROM payslips) net, (SELECT COUNT(*) FROM payslip_archive) pa,
  (SELECT COUNT(*) FROM leave_requests) lr, (SELECT COUNT(*) FROM overtime_requests) orq, (SELECT COUNT(*) FROM employee_pay_items) pi, (SELECT COUNT(*) FROM attendance_imports) ai,
  (SELECT group_concat(key || '=' || value, ';') FROM (SELECT key, value FROM settings WHERE key LIKE 'payroll.%' ORDER BY key)) s`));
let before = '';

beforeAll(async () => {
  H = await startHarness();
  for (const k of ['admin', 'staff', 'employee', 'manager']) c[k] = new Client(H.baseUrl);
  await c.admin!.login('it_admin', H.passwords.it_admin);
  await c.staff!.login('it_staff', H.passwords.it_staff);
  await c.employee!.login('it_employee', H.passwords.it_employee);
  await c.manager!.login('it_manager', H.passwords.it_manager);
}, 180_000);
afterAll(async () => {
  await H?.stop();
});

describe('setup (synthetic companies ZMA / ZMB / ZMC)', () => {
  it('creates companies and employees', async () => {
    for (const code of ['ZMA', 'ZMB', 'ZMC']) ids[code] = (await admin().post('/api/m/companies', { code, name: `zz_test ${code}`, active: true })).body.id;
    for (const [code, co] of [['ZMA01', 'ZMA'], ['ZMA02', 'ZMA'], ['ZMA90', 'ZMB'], ['ZMB01', 'ZMB'], ['ZMC01', 'ZMC'], ['ZMC02', 'ZMC']] as const) {
      const r = await admin().post('/api/m/employees', { emp_code: code, first_name: 'zz_test', last_name: code, company_id: ids[co], hire_date: addDays(today, -400), employment_type: 'permanent', status: 'active', base_salary: 20000 });
      expect(r.status, r.text).toBe(201);
      ids[code] = r.body.id;
    }
    // own-company user (DEMO) allowed to import and manage exemptions: must never reach ZMA / ZMB / ZMC
    H.sql(`INSERT INTO roles (code, name, description, privileged, system) VALUES ('zz_test_multi', 'zz_test multi', 'zz_test', 0, 0);
      INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.value FROM roles r, json_each('["attendance_file.view","attendance_file.import","attendance_exemption.view","attendance_exemption.manage"]') p WHERE r.code = 'zz_test_multi';
      INSERT INTO user_roles (user_id, role_id) SELECT u.id, r.id FROM users u, roles r WHERE u.username = 'it_employee' AND r.code = 'zz_test_multi'`);
    before = fingerprint();
  });
});

describe('attendance exemption API', () => {
  let period = 0;
  it('HR admin (manage) creates a period; HR staff can view only; manager has no access', async () => {
    const r = await admin().post('/api/attendance-exemptions', { employee_id: ids.ZMA02, effective_from: D(0), effective_to: null, reason: 'zz_test ผู้บริหารตามข้อตกลง' });
    expect(r.status, r.text).toBe(201);
    period = r.body.id;
    expect(r.body).toMatchObject({ effective_from: D(0), effective_to: null, revoked_at: null });
    const view = await staff().get(`/api/attendance-exemptions?employee_id=${ids.ZMA02}`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ active: true, items: [expect.objectContaining({ id: period, state: 'active' })] });
    expect((await staff().post('/api/attendance-exemptions', { employee_id: ids.ZMA01, effective_from: D(0), reason: 'zz_test' })).status).toBe(403);
    expect((await c.manager!.get(`/api/attendance-exemptions?employee_id=${ids.ZMA02}`)).status).toBe(403);
  });
  it('validation: overlapping periods, end before start, short reason', async () => {
    expect((await admin().post('/api/attendance-exemptions', { employee_id: ids.ZMA02, effective_from: D(5), effective_to: D(6), reason: 'zz_test ซ้อน' })).status).toBe(409);
    expect((await admin().post('/api/attendance-exemptions', { employee_id: ids.ZMA01, effective_from: D(5), effective_to: D(1), reason: 'zz_test' })).status).toBe(400);
    expect((await admin().post('/api/attendance-exemptions', { employee_id: ids.ZMA01, effective_from: D(1), reason: 'x' })).status).toBe(400);
  });
  it('company scope: an own-company manager cannot read or change exemptions of another company', async () => {
    expect((await c.employee!.get(`/api/attendance-exemptions?employee_id=${ids.ZMA02}`)).status).toBe(404);
    expect((await c.employee!.post('/api/attendance-exemptions', { employee_id: ids.ZMA01, effective_from: D(0), reason: 'zz_test scope' })).status).toBe(404);
    expect((await c.employee!.post(`/api/attendance-exemptions/${period}/revoke`, { reason: 'zz_test scope' })).status).toBe(404);
  });
  it('end-dating, revoking (kept for history) and the audit trail; rows cannot be deleted', async () => {
    const other = await admin().post('/api/attendance-exemptions', { employee_id: ids.ZMC01, effective_from: D(-30), effective_to: D(-20), reason: 'zz_test ช่วงเก่า' });
    expect(other.status, other.text).toBe(201);
    const future = await admin().post('/api/attendance-exemptions', { employee_id: ids.ZMC01, effective_from: addDays(today, 30), reason: 'zz_test อนาคต' });
    const list = await admin().get(`/api/attendance-exemptions?employee_id=${ids.ZMC01}`);
    expect(list.body.items.map((p: { state: string }) => p.state).sort()).toEqual(['expired', 'future']);
    expect(list.body.active).toBe(false);
    const end = await admin().put(`/api/attendance-exemptions/${future.body.id}`, { effective_to: addDays(today, 60) });
    expect(end.status, end.text).toBe(200);
    const rv = await admin().post(`/api/attendance-exemptions/${future.body.id}/revoke`, { reason: 'zz_test ไม่ใช้แล้ว' });
    expect(rv.body).toMatchObject({ revoke_reason: 'zz_test ไม่ใช้แล้ว' });
    expect((await admin().post(`/api/attendance-exemptions/${future.body.id}/revoke`, { reason: 'zz_test again' })).status).toBe(409);
    expect((await admin().put(`/api/attendance-exemptions/${future.body.id}`, { effective_to: null })).status).toBe(409);
    const [audits] = H.sqlEach(`SELECT action, COUNT(*) AS n FROM audit_logs WHERE action LIKE 'attendance_exemption.%' GROUP BY action ORDER BY action`);
    expect(audits).toEqual([{ action: 'attendance_exemption.created', n: 3 }, { action: 'attendance_exemption.revoked', n: 1 }, { action: 'attendance_exemption.updated', n: 1 }]);
    expect(() => H.sql(`DELETE FROM employee_attendance_exemptions WHERE id = ${future.body.id}`)).toThrow();
  });
});

describe('combined file: company per row from an explicit rule', () => {
  let preview: { body: any } = { body: null };
  it('preview: per-company counts, rows without a company, no cross-company matching — and nothing written', async () => {
    const bef = counts();
    preview = await staff().post('/api/attendance-files/preview', combined());
    expect(preview.body.error, JSON.stringify(preview.body).slice(0, 300)).toBeUndefined();
    const after = counts();
    expect(after).toEqual(bef); // read-only: no batch, row, rule, mapping or audit
    const p = preview.body;
    expect(p).toMatchObject({ company_mode: 'combined', company: null, mapping_problems: [] });
    const by = Object.fromEntries(p.companies.map((x: { id: number }) => [x.id, x]));
    expect(by[ids.ZMA!]).toMatchObject({ total: 7, invalid: 1 }); // ZMA90 (company B) under Team A is refused
    expect(by[ids.ZMB!]).toMatchObject({ total: 3, invalid: 1 }); // unknown employee
    expect(by[ids.ZMC!]).toMatchObject({ total: 1, invalid: 0 });
    expect(p.summary).toMatchObject({ unassigned: 2 });
    const row = (code: string, d: number, group?: string) => p.rows.find((r: { employee_code: string; work_date: string; company_value: string | null }) => r.employee_code === code && r.work_date === D(d) && (group === undefined || r.company_value === group));
    expect(row('ZMA90', 0).issues.map((i: { code: string }) => i.code)).toContain('wrong_company'); // employee of another company: never cross-matched
    expect(row('ZMA90', 0).employee_id).toBeNull();
    expect(row('ZMC02', 0)).toMatchObject({ company_id: null, status: 'invalid' });
    expect(row('ZMC02', 0).issues.map((i: { code: string }) => i.code)).toContain('missing_company');
    expect(row('ZMA01', 0, 'Somewhere').issues.map((i: { code: string }) => i.code)).toContain('company_unmatched');
    expect(row('ZZ-NOPE', 0).issues.map((i: { code: string }) => i.code)).toContain('unknown_employee');
  });
  it('exemption: no missing-punch warning for an exempt day, punches processed as usual; others still warned', () => {
    const r = (code: string, d: number) => preview.body.rows.find((x: { employee_code: string; work_date: string; company_value: string | null }) => x.employee_code === code && x.work_date === D(d) && x.company_value !== 'Somewhere');
    const noPunch = r('ZMA02', 0);
    expect(noPunch).toMatchObject({ exempt: true, status: 'valid', clock_in: null, clock_out: null });
    expect(noPunch.issues.map((i: { code: string }) => i.code)).toEqual(['attendance_exempt']);
    expect(r('ZMA02', 1)).toMatchObject({ exempt: true, clock_in: '08:55', clock_out: '18:10', attendance_status: 'present' });
    expect(r('ZMA02', 2).issues.map((i: { code: string }) => i.code)).not.toContain('pending_out');
    expect(r('ZMA01', 1)).toMatchObject({ exempt: false, status: 'warning' });
    expect(r('ZMA01', 1).issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['no_record_in', 'no_record_out']));
    expect(preview.body.summary.exempt_days).toBe(3);
  });
  it('a rule naming a company outside the user\'s scope is refused; a combined file needs a rule column', async () => {
    const demo = Number(H.sql("SELECT id FROM companies WHERE code = 'DEMO'")[0]!.id);
    const r = await c.employee!.post('/api/attendance-files/preview', combined({ company_rule: { column: 6, values: [{ value: 'Team A', company_id: ids.ZMA }, { value: 'Team B', company_id: demo }] } }));
    expect(r.status).toBe(403);
    const noRule = await staff().post('/api/attendance-files/preview', combined({ company_rule: null }));
    expect(noRule.body.mapping_problems.join()).toContain('ต้องเลือกคอลัมน์ที่ใช้ระบุบริษัท');
    expect((await staff().post('/api/attendance-files/preview', combined({ company_rule: { column: 1, values: [] } }))).body.mapping_problems.join()).toContain('ไม่ใช่คอลัมน์รหัสพนักงาน');
  });
  let group = 0;
  const k = key();
  it('confirm: one group, one batch per company, unassigned rows kept apart, invalid rows create nothing', async () => {
    const r = await staff().post('/api/attendance-files', { ...combined(), confirm: true, idempotency_key: k });
    expect(r.status, r.text).toBe(201);
    group = r.body.id;
    expect(r.body).toMatchObject({ company_mode: 'combined', company_count: 3, unassigned_count: 2, total_rows: 13 });
    expect(r.body.batches.map((b: { company_id: number; total_rows: number }) => [b.company_id, b.total_rows]).sort()).toEqual([[ids.ZMA, 7], [ids.ZMB, 3], [ids.ZMC, 1]].sort());
    const [batches, records, unassigned, wrong, audits, rules] = H.sqlEach(`
      SELECT b.company_id, b.imported_count, b.invalid_count, (SELECT COUNT(*) FROM attendance_raw_records r WHERE r.batch_id = b.id) raw FROM attendance_file_imports b WHERE b.group_id = ${group} ORDER BY b.company_id;
      SELECT e.emp_code, a.work_date, b.company_id FROM attendance_records a JOIN employees e ON e.id = a.employee_id JOIN attendance_file_imports b ON b.id = a.import_batch_id WHERE b.group_id = ${group} ORDER BY e.emp_code, a.work_date;
      SELECT employee_code, company_value FROM import_group_unassigned_rows WHERE group_id = ${group} ORDER BY row_no;
      SELECT COUNT(*) AS n FROM attendance_records a JOIN employees e ON e.id = a.employee_id WHERE e.emp_code IN ('ZMA90', 'ZMC02') AND a.work_date >= '${D(0)}';
      SELECT action, COUNT(*) AS n FROM audit_logs WHERE (action = 'attendance_file.imported' AND entity_id IN (SELECT CAST(id AS TEXT) FROM attendance_file_imports WHERE group_id = ${group})) OR (action = 'attendance_file.group_imported' AND entity_id = '${group}') GROUP BY action ORDER BY action;
      SELECT COUNT(*) AS n FROM import_company_rules;`);
    expect(batches!.map((b) => [b.company_id, b.raw])).toEqual([[ids.ZMA, 7], [ids.ZMB, 3], [ids.ZMC, 1]].sort((a, b) => a[0]! - b[0]!));
    // every attendance record sits in its own company's batch
    for (const rec of records!) expect(rec.company_id).toBe(ids[String(rec.emp_code).slice(0, 3)]);
    expect(records!.some((x) => x.emp_code === 'ZMA90')).toBe(false);
    expect(unassigned).toEqual([{ employee_code: 'ZMC02', company_value: null }, { employee_code: 'ZMA01', company_value: 'Somewhere' }]);
    expect(wrong![0]!.n).toBe(0);
    expect(audits).toEqual([{ action: 'attendance_file.group_imported', n: 1 }, { action: 'attendance_file.imported', n: 3 }]);
    expect(rules![0]!.n).toBe(1);
    expect(() => H.sql(`DELETE FROM import_group_unassigned_rows WHERE group_id = ${group}`)).toThrow();
  });
  it('idempotency: the same confirmation returns the same group; a new import of the same file adds nothing', async () => {
    const again = await staff().post('/api/attendance-files', { ...combined(), confirm: true, idempotency_key: k });
    expect(again.body).toMatchObject({ id: group, repeated: true });
    const second = await staff().post('/api/attendance-files', { ...combined(), confirm: true, idempotency_key: key() });
    expect(second.status, second.text).toBe(201);
    expect(second.body.batches.reduce((s: number, b: { imported_count: number; record_count: number }) => s + b.imported_count + b.record_count, 0)).toBe(0);
  });
  it('group view: batches per company; an own-company user sees neither the batches nor the unassigned rows', async () => {
    const g = await staff().get(`/api/attendance-files/groups/${group}`);
    expect(g.body.batches).toHaveLength(3);
    expect(g.body.unassigned_rows).toHaveLength(2);
    expect((await c.employee!.get(`/api/attendance-files/groups/${group}`)).status).toBe(404);
    const batchOfA = g.body.batches.find((b: { company_id: number }) => b.company_id === ids.ZMA).id;
    expect((await c.employee!.get(`/api/attendance-files/${batchOfA}`)).status).toBe(404);
  });
});

describe('separate file per company', () => {
  const single = (company: number, x: Record<string, unknown> = {}) => combined({ company_mode: 'single', company_id: company, company_rule: null, ...x });
  it('company B chosen: employees of other companies are refused, never cross-matched', async () => {
    const p = await staff().post('/api/attendance-files/preview', single(ids.ZMB!));
    expect(p.status, p.text).toBe(200);
    expect(p.body).toMatchObject({ company_mode: 'single', company: { id: ids.ZMB } });
    const byCode = (code: string) => p.body.rows.filter((r: { employee_code: string }) => r.employee_code === code);
    for (const code of ['ZMA01', 'ZMA02', 'ZMC01']) expect(byCode(code).every((r: { status: string; issues: Array<{ code: string }> }) => r.status === 'invalid' && r.issues.some((i) => i.code === 'wrong_company'))).toBe(true);
    expect(byCode('ZMA90').every((r: { employee_id: number | null }) => r.employee_id === ids.ZMA90)).toBe(true); // a company B employee, whatever the code looks like
  });
  it('a conflicting company column marks the row invalid', async () => {
    const p = await staff().post('/api/attendance-files/preview', single(ids.ZMA!, { company_rule: rule() }));
    const r = (code: string) => p.body.rows.find((x: { employee_code: string }) => x.employee_code === code);
    expect(r('ZMB01').issues.map((i: { code: string }) => i.code)).toContain('company_conflict'); // Team B in a company A file
    expect(r('ZMA01').issues.map((i: { code: string }) => i.code)).not.toContain('company_conflict');
    // no value: the row belongs to the chosen company (A) — then refused only because ZMC02 is a company C employee
    const zmc02 = r('ZMC02').issues.map((i: { message: string }) => i.message).join(' ');
    expect(zmc02).not.toContain('ข้อมูลบริษัทในไฟล์');
    expect(zmc02).toContain('อยู่ในบริษัทอื่น');
  });
  it('an own-company user cannot import into another company', async () => {
    expect((await c.employee!.post('/api/attendance-files/preview', single(ids.ZMA!))).status).toBe(403);
  });
});

describe('payroll protection', () => {
  it('payroll, leave requests, OT requests, pay items and payroll settings are unchanged', () => {
    expect(fingerprint()).toBe(before);
  });
});
