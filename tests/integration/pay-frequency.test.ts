// Pay frequency (P6, migration 0024) — isolated local D1, synthetic data only (companies ZFA / ZFB, employees ZF1–ZF3,
// ZF9). The cycle of docs/MID-MONTH-PAYROLL-WORKFLOW.md: mid-month round 26 Oct – 10 Nov (probation advance), month-end
// 26 Oct – 25 Nov. Covers: not configured = unchanged; company and employee frequency (override); monthly employees
// out of the mid-month round (blocked if selected); semi-monthly non-probation note; identical amounts; the month-end
// period pays everyone and deducts the advance once; permissions, scope, reason, races, history, audit.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const ids = {} as Record<'A' | 'B' | 'F1' | 'F2' | 'F3' | 'mid' | 'month', number>;
const WRANGLER = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const PASSWORD = 'Zz-Frequency-Pass-2026!';
const one = (sql: string) => H.sql(sql)[0] as Record<string, any>;
const slips = (p: number) => H.sql(`SELECT e.emp_code AS emp, s.base_salary AS base, s.net, s.advance FROM payslips s JOIN employees e ON e.id = s.employee_id WHERE s.period_id = ${p} ORDER BY e.emp_code`);
const R = 'zz ตั้งค่าตามนโยบายบริษัท';

async function period(code: string, kind: string, start: string, end: string, pay: string): Promise<number> {
  const r = await c.admin!.post('/api/payroll/periods', { code, name: code, kind, company_id: ids.A, start_date: start, end_date: end, pay_date: pay });
  expect(r.status, r.text).toBe(201);
  return r.body.id as number;
}

beforeAll(async () => {
  H = await startHarness();
  H.sql(`INSERT INTO companies (code, name, active) VALUES ('ZFA', 'ZZ Frequency A', 1), ('ZFB', 'ZZ Frequency B', 1);`);
  ids.A = Number(one("SELECT id FROM companies WHERE code = 'ZFA'").id);
  ids.B = Number(one("SELECT id FROM companies WHERE code = 'ZFB'").id);
  // ZF1 on probation (hired 20 Oct: 90 days run past the round); ZF2 and ZF3 passed probation long ago
  H.sql(`INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status, base_salary) VALUES
    ('ZF1', 'Zz', 'ZF1', ${ids.A}, '2026-10-20', 'probation', 'probation', 30000),
    ('ZF2', 'Zz', 'ZF2', ${ids.A}, '2025-01-01', 'permanent', 'active', 36000),
    ('ZF3', 'Zz', 'ZF3', ${ids.A}, '2025-01-01', 'permanent', 'active', 24000),
    ('ZF9', 'Zz', 'ZF9', ${ids.B}, '2025-01-01', 'permanent', 'active', 24000);`);
  for (const k of ['F1', 'F2', 'F3'] as const) ids[k] = Number(one(`SELECT id FROM employees WHERE emp_code = 'Z${k}'`).id);
  c.admin = new Client(H.baseUrl);
  await c.admin.login('it_admin', H.passwords.it_admin);
  c.payroll = new Client(H.baseUrl);
  await c.payroll.login('it_payroll', H.passwords.it_payroll);
  c.staff = new Client(H.baseUrl);
  await c.staff.login('it_staff', H.passwords.it_staff);
  H.sql(`INSERT INTO roles (code, name, description, privileged, system) VALUES ('zz_pf_b', 'ZZ frequency B', 'test', 0, 0);
    INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.value FROM roles r, json_each('["payroll.view","pay_frequency.manage"]') p WHERE r.code = 'zz_pf_b';`);
  const out = join(H.dir, 'zz_pf_b.sql');
  execFileSync(process.execPath, ['scripts/create-user.mjs', '--username', 'zz_pf_b', '--display', 'zz_pf_b', '--role', 'zz_pf_b', '--employee', 'ZF9', '--out', out, '--cred-file', join(H.dir, 'pf-cred.txt')], { env: { ...process.env, NEW_USER_PASSWORD: PASSWORD }, stdio: 'ignore' });
  execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', join(H.dir, 'state'), '--file', out], { env: { ...process.env, CI: '1' }, stdio: 'ignore' });
  c.scopedB = new Client(H.baseUrl);
  expect((await c.scopedB.login('zz_pf_b', PASSWORD)).status).toBe(200);
}, 300_000);
afterAll(async () => {
  await H?.stop();
});

let baseline: ReturnType<typeof slips>;

describe('configuration', () => {
  it('grants pay_frequency.manage to hr_admin and hr_payroll only', () => {
    expect(H.sql("SELECT r.code FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission = 'pay_frequency.manage' AND r.code NOT LIKE 'zz%' ORDER BY 1").map((x) => x.code)).toEqual(['hr_admin', 'hr_payroll']);
  });

  it('not configured: the mid-month round is exactly as before (the probation advance only)', async () => {
    ids.mid = await period('ZF-MID-2026-11', 'mid_month', '2026-10-26', '2026-11-10', '2026-11-15');
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.mid}/calculate`)).status).toBe(200);
    baseline = slips(ids.mid);
    // ZF1: probation days 26 Oct – 10 Nov; ZF2 / ZF3 are past probation: no advance (existing rule)
    expect(baseline.map((x) => x.emp)).toEqual(['ZF1']);
  });

  it('permissions, reason, value and scope', async () => {
    const put = (who: Client, b: Record<string, unknown>, path = `/api/pay-frequency/companies/${ids.A}`) => who.put(path, b);
    expect((await put(c.staff!, { pay_frequency: 'monthly', reason: R })).status).toBe(403);
    expect((await put(c.payroll!, { pay_frequency: 'monthly', reason: R })).status).toBe(403);
    expect((await c.payroll!.get('/api/pay-frequency/companies')).status).toBe(200);
    expect((await c.staff!.get('/api/pay-frequency/companies')).status).toBe(403);
    expect((await put(c.admin!, { pay_frequency: 'weekly', reason: R })).status).toBe(400);
    expect((await put(c.admin!, { pay_frequency: 'monthly', reason: 'zz' })).status).toBe(400);
    expect((await put(c.admin!, { reason: R })).status).toBe(400);
    expect((await put(c.scopedB!, { pay_frequency: 'monthly', reason: R })).status).toBe(404);
    expect((await put(c.scopedB!, { pay_frequency: 'monthly', reason: R }, `/api/pay-frequency/employees/${ids.F1}`)).status).toBe(404);
    expect((await c.scopedB!.get(`/api/pay-frequency/employees/${ids.F1}`)).status).toBe(404);
    expect(one(`SELECT pay_frequency FROM companies WHERE id = ${ids.A}`).pay_frequency).toBeNull();
  });

  it('concurrent changes of one company: each applied change has exactly one history row', async () => {
    const rs = await Promise.all(['monthly', 'semi_monthly'].map((v) => c.admin!.put(`/api/pay-frequency/companies/${ids.A}`, { pay_frequency: v, reason: R })));
    expect(rs.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    const applied = rs.filter((r) => r.status === 200 && !r.body.unchanged).length;
    expect(Number(one(`SELECT COUNT(*) AS n FROM pay_frequency_history WHERE entity = 'company' AND entity_id = ${ids.A}`).n)).toBe(applied);
    // settle on monthly for the next tests
    const now = one(`SELECT pay_frequency FROM companies WHERE id = ${ids.A}`).pay_frequency;
    if (now !== 'monthly') expect((await c.admin!.put(`/api/pay-frequency/companies/${ids.A}`, { pay_frequency: 'monthly', reason: R })).status).toBe(200);
  });
});

describe('mid-month round and month-end period', () => {
  it('a monthly company: its employees are out of the mid-month round; selected anyway → blocked', async () => {
    // one mid-month round per company and month (overlapping periods are refused): the same round, now monthly
    const list = (await c.payroll!.get(`/api/payroll-selection/periods/${ids.mid}`)).body;
    expect(list.summary.selected).toBe(0);
    const sel = await c.payroll!.post(`/api/payroll-selection/periods/${ids.mid}/select`, { employee_ids: [ids.F2], reason: 'zz ทดสอบรายเดือน' });
    expect(sel.body.results[0]).toMatchObject({ result: 'selected', eligibility: 'blocked', decision: 'block', reasons: ['monthly_pay_frequency'] });
    const calc = await c.payroll!.post(`/api/payroll/periods/${ids.mid}/calculate`);
    expect(calc.status).toBe(409);
    expect(calc.body.error.code).toBe('selection_not_ready');
    expect((await c.payroll!.post(`/api/payroll-selection/periods/${ids.mid}/deselect`, { employee_ids: [ids.F2], reason: 'zz นำออก รายเดือน' })).status).toBe(200);
  });

  it('employee override: the probation employee set semi-monthly is back in the round with the same amount', async () => {
    expect((await c.admin!.put(`/api/pay-frequency/employees/${ids.F1}`, { pay_frequency: 'semi_monthly', reason: R })).status).toBe(200);
    expect((await c.payroll!.get(`/api/pay-frequency/employees/${ids.F1}`)).body).toMatchObject({ pay_frequency: 'semi_monthly', company_frequency: 'monthly', effective: 'semi_monthly' });
    // a semi-monthly employee past probation: listed with the note, nothing paid in the round (no rule exists)
    expect((await c.admin!.put(`/api/pay-frequency/employees/${ids.F3}`, { pay_frequency: 'semi_monthly', reason: R })).status).toBe(200);
    const list = (await c.payroll!.get(`/api/payroll-selection/periods/${ids.mid}`)).body.selected;
    expect(list.find((x: { emp_code: string }) => x.emp_code === 'ZF3')).toMatchObject({ pay_frequency: 'semi_monthly', notes: ['no_mid_month_rule'] });
    expect(list.map((x: { emp_code: string }) => x.emp_code).sort()).toEqual(['ZF1', 'ZF3']);
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.mid}/calculate`)).status).toBe(200);
    expect(slips(ids.mid)).toEqual(baseline);
  });

  it('the month-end period pays every frequency and deducts the approved advance once', async () => {
    expect((await c.admin!.post(`/api/payroll/periods/${ids.mid}/approve`)).status).toBe(200);
    ids.month = await period('ZF-2026-11', 'monthly', '2026-10-26', '2026-11-25', '2026-11-30');
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.month}/calculate`);
    expect(r.status, r.text).toBe(200);
    const m = slips(ids.month);
    expect(m.map((x) => x.emp)).toEqual(['ZF1', 'ZF2', 'ZF3']);
    expect(Number(m.find((x) => x.emp === 'ZF1')!.advance)).toBe(Number(baseline[0]!.net));
    expect(m.filter((x) => x.emp !== 'ZF1').every((x) => Number(x.advance) === 0)).toBe(true);
    // recalculating never deducts twice
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.month}/calculate`)).status).toBe(200);
    expect(Number(slips(ids.month).find((x) => x.emp === 'ZF1')!.advance)).toBe(Number(baseline[0]!.net));
  });
});

describe('history and audit', () => {
  it('every change is in the append-only history and the audit log', async () => {
    const h = (await c.admin!.get('/api/pay-frequency/history')).body.history;
    expect(h.some((x: { entity: string; entity_id: number; after_value: string }) => x.entity === 'employee' && x.entity_id === ids.F1 && x.after_value === 'semi_monthly')).toBe(true);
    expect(H.sql("SELECT action FROM audit_logs WHERE action LIKE 'pay_frequency.%'").map((x) => x.action)).toEqual(expect.arrayContaining(['pay_frequency.company_changed', 'pay_frequency.employee_changed']));
    expect(() => H.sql("UPDATE pay_frequency_history SET reason = 'x'")).toThrow();
    expect(() => H.sql('DELETE FROM pay_frequency_history')).toThrow();
    // a company-B user sees no company A history
    expect((await c.scopedB!.get('/api/pay-frequency/history')).body.history).toEqual([]);
  });
});
