// Employee selection and payroll eligibility (P4, migration 0022) — isolated local D1, synthetic data only (companies
// ZSA / ZSB, employees ZS1–ZS8, ZB1, ZS9). September 2026. Covers: the standard list unchanged without selection rows,
// reconciliation (same amounts for the same eligible employees), list / available / search within the scope,
// select / deselect (single, bulk, partial failure, idempotent, concurrent), eligibility (hire / termination / status /
// salary / company), the calculation and approval gates, HR confirmation of review cases (permission, lapse), the
// selection version, P1 / P2 / P3 integration, duplicate payslips, append-only history and audit.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, seedAccountingSignOff, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const ids = {} as Record<'A' | 'B' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7' | 'S8' | 'B1' | 'pSep' | 'pOct' | 'pB', number>;
const WRANGLER = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const PASSWORD = 'Zz-Selection-Pass-2026!';
const one = (sql: string) => H.sql(sql)[0] as Record<string, any>;
const emp = (code: string) => Number(one(`SELECT id FROM employees WHERE emp_code = '${code}'`).id);
const slips = (p: number) => H.sql(`SELECT e.emp_code AS emp FROM payslips s JOIN employees e ON e.id = s.employee_id WHERE s.period_id = ${p} ORDER BY e.emp_code`).map((x) => String(x.emp));
const amounts = (p: number, codes: string[]) => H.sql(`SELECT e.emp_code AS emp, s.base_salary, s.gross, s.sso, s.tax, s.net FROM payslips s JOIN employees e ON e.id = s.employee_id WHERE s.period_id = ${p} AND e.emp_code IN (${codes.map((x) => `'${x}'`).join(',')}) ORDER BY e.emp_code`);
const events = (p: number) => H.sql(`SELECT e.emp_code AS emp, ev.action, ev.previous_status AS prev, ev.new_status AS now FROM payroll_period_selection_events ev JOIN employees e ON e.id = ev.employee_id WHERE ev.period_id = ${p} ORDER BY ev.id`).map((x) => `${x.emp}:${x.action}:${x.prev}>${x.now}`);
const REASON = 'zz ตรวจสอบตามเอกสาร HR';

async function makeUser(username: string, roles: string[]): Promise<Client> {
  const u = await c.admin!.post('/api/admin/users', { username, displayName: username, roles });
  expect(u.status, u.text).toBe(201);
  const who = new Client(H.baseUrl);
  await who.login(username, u.body.temporaryPassword);
  expect((await who.post('/api/auth/change-password', { currentPassword: u.body.temporaryPassword, newPassword: PASSWORD })).status).toBe(200);
  expect((await who.get('/api/meta')).status).toBe(200);
  return who;
}
async function newPeriod(code: string, companyId: number, start: string, end: string): Promise<number> {
  const r = await c.admin!.post('/api/payroll/periods', { code, name: code, kind: 'monthly', company_id: companyId, start_date: start, end_date: end, pay_date: end });
  expect(r.status, r.text).toBe(201);
  return r.body.id as number;
}
const S = (p: number, path = '') => `/api/payroll-selection/periods/${p}${path}`;

beforeAll(async () => {
  H = await startHarness();
  H.sql(`INSERT INTO companies (code, name, active) VALUES ('ZSA', 'ZZ Selection A', 1), ('ZSB', 'ZZ Selection B', 1);`);
  ids.A = Number(one("SELECT id FROM companies WHERE code = 'ZSA'").id);
  ids.B = Number(one("SELECT id FROM companies WHERE code = 'ZSB'").id);
  const row = (code: string, co: number, hire: string, status: string, term: string | null, base: number | null) => `('${code}', 'Zz', '${code}', ${co}, '${hire}', 'permanent', '${status}', ${term ? `'${term}'` : 'NULL'}, ${base === null ? 'NULL' : base})`;
  H.sql(`INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status, termination_date, base_salary) VALUES
    ${row('ZS1', ids.A, '2026-01-01', 'active', null, 30000)},
    ${row('ZS2', ids.A, '2026-09-15', 'probation', null, 24000)},
    ${row('ZS3', ids.A, '2026-01-01', 'resigned', '2026-09-10', 28000)},
    ${row('ZS4', ids.A, '2026-01-01', 'terminated', '2026-08-31', 26000)},
    ${row('ZS5', ids.A, '2026-01-01', 'suspended', null, 27000)},
    ${row('ZS6', ids.A, '2026-01-01', 'active', null, null)},
    ${row('ZS7', ids.A, '2026-01-01', 'resigned', null, 25000)},
    ${row('ZS8', ids.A, '2026-01-01', 'active', null, 31000)},
    ${row('ZB1', ids.B, '2026-01-01', 'active', null, 30000)},
    ${row('ZS9', ids.B, '2026-01-01', 'active', null, 30000)};`);
  for (const k of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'] as const) ids[k] = emp(`Z${k}`);
  ids.B1 = emp('ZB1');

  c.admin = new Client(H.baseUrl);
  await c.admin.login('it_admin', H.passwords.it_admin);
  c.payroll = new Client(H.baseUrl);
  await c.payroll.login('it_payroll', H.passwords.it_payroll);
  c.staff = new Client(H.baseUrl);
  await c.staff.login('it_staff', H.passwords.it_staff);
  c.leader = await makeUser('zz_sel_leader', ['hr_leader']);
  // a company-B-only user who may view / manage / confirm selections of company B
  H.sql(`INSERT INTO roles (code, name, description, privileged, system) VALUES ('zz_sel_b', 'ZZ selection B', 'test', 0, 0);
    INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.value FROM roles r, json_each('["payroll.view","payroll_selection.view","payroll_selection.manage","payroll_selection.override"]') p WHERE r.code = 'zz_sel_b';`);
  const out = join(H.dir, 'zz_sel_b.sql');
  execFileSync(process.execPath, ['scripts/create-user.mjs', '--username', 'zz_sel_b', '--display', 'zz_sel_b', '--role', 'zz_sel_b', '--employee', 'ZS9', '--out', out, '--cred-file', join(H.dir, 'sel-cred.txt')], { env: { ...process.env, NEW_USER_PASSWORD: PASSWORD }, stdio: 'ignore' });
  execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', join(H.dir, 'state'), '--file', out], { env: { ...process.env, CI: '1' }, stdio: 'ignore' });
  c.scopedB = new Client(H.baseUrl);
  expect((await c.scopedB.login('zz_sel_b', PASSWORD)).status).toBe(200);
}, 300_000);
afterAll(async () => {
  await H?.stop();
});

let before: ReturnType<typeof amounts>;

describe('migration 0022 and the standard list', () => {
  it('grants view / manage to payroll roles and view / override to hr_leader and hr_payroll', () => {
    expect(H.sql("SELECT r.code || ':' || rp.permission AS g FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE rp.permission LIKE 'payroll_selection.%' AND r.code NOT LIKE 'zz%' ORDER BY 1").map((x) => x.g)).toEqual([
      'hr_leader:payroll_selection.override', 'hr_leader:payroll_selection.view', 'hr_payroll:payroll_selection.manage', 'hr_payroll:payroll_selection.override', 'hr_payroll:payroll_selection.view',
      'payroll_officer:payroll_selection.manage', 'payroll_officer:payroll_selection.view',
    ]);
  });

  it('25. without selection rows a period pays exactly its standard list (unchanged engine), recorded per calc version', async () => {
    ids.pSep = await newPeriod('ZS-2026-09', ids.A, '2026-09-01', '2026-09-30');
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.pSep}/calculate`);
    expect(r.status, r.text).toBe(200);
    expect(slips(ids.pSep)).toEqual(['ZS1', 'ZS2', 'ZS3', 'ZS8']);
    before = amounts(ids.pSep, ['ZS1', 'ZS2', 'ZS3']);
    expect(H.sql(`SELECT e.emp_code AS emp, r.selection, r.eligibility, r.calculated FROM payroll_selection_results r JOIN employees e ON e.id = r.employee_id WHERE r.period_id = ${ids.pSep} AND r.calc_version = 1 ORDER BY e.emp_code`).map((x) => `${x.emp}:${x.selection}:${x.eligibility}:${x.calculated}`))
      .toEqual(['ZS1:standard:eligible:1', 'ZS2:standard:eligible_prorated:1', 'ZS3:standard:eligible_prorated:1', 'ZS8:standard:eligible:1']);
  });
});

describe('list, search and scope', () => {
  it('lists the selection with eligibility and a summary; employees outside the list with the reason', async () => {
    const l = await c.payroll!.get(S(ids.pSep));
    expect(l.status, l.text).toBe(200);
    expect(l.body.summary).toMatchObject({ selected: 4, added: 0, deselected: 0, eligible: 2, eligible_prorated: 2, review_required: 0, blocked: 0, payable: 4 });
    expect(l.body.selected.find((x: { emp_code: string }) => x.emp_code === 'ZS2')).toMatchObject({ eligibility: 'eligible_prorated', reasons: ['starts_in_period'], paid_from: '2026-09-15' });
    const a = await c.payroll!.get(S(ids.pSep, '/available'));
    const by = Object.fromEntries(a.body.employees.map((x: { emp_code: string; outside: string; eligibility: string }) => [x.emp_code, `${x.outside}:${x.eligibility}`]));
    expect(by).toMatchObject({ ZS4: 'resigned_terminated:not_employed', ZS5: 'status_other:review_required', ZS6: 'no_salary:missing_salary', ZS7: 'resigned_terminated:employment_period_mismatch' });
    // 7. another company's employees never appear
    expect(Object.keys(by)).not.toContain('ZB1');
    expect((await c.payroll!.get(S(ids.pSep, '/available?q=zs5'))).body.employees.map((x: { emp_code: string }) => x.emp_code)).toEqual(['ZS5']);
  });

  it('34, 36. permission and scope: no access without permission; a company-B user sees nothing of company A', async () => {
    expect((await c.staff!.get(S(ids.pSep))).status).toBe(403);
    expect((await c.staff!.post(S(ids.pSep, '/select'), { employee_ids: [ids.S5] })).status).toBe(403);
    expect((await c.scopedB!.get(S(ids.pSep))).status).toBe(404);
    expect((await c.scopedB!.post(S(ids.pSep, '/select'), { employee_ids: [ids.S5] })).status).toBe(404);
    ids.pB = await newPeriod('ZS-B-2026-09', ids.B, '2026-09-01', '2026-09-30');
    // 8. a company-A employee selected into company B's period: not revealed to the company-B user
    const r = await c.scopedB!.post(S(ids.pB, '/select'), { employee_ids: [ids.S1] });
    expect(r.status).toBe(200);
    expect(r.body.results).toEqual([{ employee_id: ids.S1, result: 'not_found', previous: null }]);
    const av = await c.scopedB!.get(S(ids.pB, '/available'));
    expect(av.body.employees.map((x: { emp_code: string }) => x.emp_code)).not.toContain('ZS1');
  });
});

describe('select / deselect', () => {
  it('4–6, 8. bulk select: per-employee results (selected, unchanged, cross-company, not found) with eligibility', async () => {
    const r = await c.payroll!.post(S(ids.pSep, '/select'), { employee_ids: [ids.S4, ids.S5, ids.S6, ids.S7, ids.B1, 999999, ids.S1], reason: REASON });
    expect(r.status, r.text).toBe(200);
    const by = Object.fromEntries(r.body.results.map((x: { employee_id: number; result: string; eligibility?: string; decision?: string }) => [x.employee_id, `${x.result}${x.eligibility ? `:${x.eligibility}:${x.decision}` : ''}`]));
    expect(by).toEqual({
      [ids.S4]: 'selected:not_employed:block',
      [ids.S5]: 'selected:review_required:review',
      [ids.S6]: 'selected:missing_salary:block',
      [ids.S7]: 'selected:employment_period_mismatch:review',
      [ids.B1]: 'cross_company',
      999999: 'not_found',
      [ids.S1]: 'unchanged:eligible:pay',
    });
    expect(r.body.counts).toEqual({ selected: 4, cross_company: 1, not_found: 1, unchanged: 1 });
    // 3. selecting again is idempotent: unchanged, no new event
    const n = events(ids.pSep).length;
    expect((await c.payroll!.post(S(ids.pSep, '/select'), { employee_ids: [ids.S5] })).body.results[0].result).toBe('unchanged');
    expect(events(ids.pSep)).toHaveLength(n);
    expect(events(ids.pSep)).toEqual(['ZS4:selected:not_selected>selected', 'ZS5:selected:not_selected>selected', 'ZS6:selected:not_selected>selected', 'ZS7:selected:not_selected>selected']);
    expect((await c.payroll!.post(S(ids.pSep, '/select'), { employee_ids: [] })).status).toBe(400);
  });

  it('26–27. review and blocked employees stop the calculation, with each employee and reason', async () => {
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.pSep}/calculate`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('selection_not_ready');
    expect(r.body.error.details.employees.map((x: { emp_code: string; status: string; decision: string }) => `${x.emp_code}:${x.status}:${x.decision}`).sort()).toEqual([
      'ZS4:not_employed:block', 'ZS5:review_required:review', 'ZS6:missing_salary:block', 'ZS7:employment_period_mismatch:review',
    ]);
    expect(Number(one(`SELECT calc_version FROM payroll_periods WHERE id = ${ids.pSep}`).calc_version)).toBe(1);
    const pv = await c.payroll!.get(`/api/payroll/periods/${ids.pSep}/preview`);
    expect(pv.body.issues.map((i: { code: string }) => i.code)).toEqual(expect.arrayContaining(['selection_not_ready', 'selection_changed_recalculate']));
  });

  it('35. confirming a review case needs the override permission and a reason; blocked cases can never be confirmed', async () => {
    const confirm = (who: Client, e: number, reason = REASON) => who.post(S(ids.pSep, `/employees/${e}/confirm`), { reason });
    expect((await confirm(c.payroll!, ids.S5)).status).toBe(403);
    expect((await confirm(c.staff!, ids.S5)).status).toBe(403);
    expect((await confirm(c.leader!, ids.S5, 'zz')).status).toBe(400);
    for (const blocked of [ids.S4, ids.S6]) {
      const r = await confirm(c.leader!, blocked);
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('not_reviewable');
    }
    expect((await confirm(c.leader!, ids.S1)).status).toBe(409); // already payable
    expect((await confirm(c.leader!, ids.S5)).status).toBe(200);
    expect((await confirm(c.leader!, ids.S5)).status).toBe(409); // already confirmed
    expect((await confirm(c.leader!, ids.S7)).status).toBe(200);
  });

  it('2. deselect needs a reason; blocked employees and a standard one are taken out', async () => {
    expect((await c.payroll!.post(S(ids.pSep, '/deselect'), { employee_ids: [ids.S4] })).status).toBe(400);
    const r = await c.payroll!.post(S(ids.pSep, '/deselect'), { employee_ids: [ids.S4, ids.S6, ids.S8], reason: 'zz ไม่จ่ายงวดนี้ตามคำสั่ง HR' });
    expect(r.status).toBe(200);
    expect(r.body.counts).toEqual({ deselected: 3 });
    const l = (await c.payroll!.get(S(ids.pSep))).body;
    expect(l.summary).toMatchObject({ selected: 5, added: 2, deselected: 3, review_required: 0, review_confirmed: 2, blocked: 0, payable: 5 });
  });

  it('25, 29, reconciliation: the calculation pays exactly the payable selection; the same employees keep the same amounts', async () => {
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.pSep}/calculate`);
    expect(r.status, r.text).toBe(200);
    expect(slips(ids.pSep)).toEqual(['ZS1', 'ZS2', 'ZS3', 'ZS5', 'ZS7']);
    expect(amounts(ids.pSep, ['ZS1', 'ZS2', 'ZS3'])).toEqual(before);
    // ZS7: resigned without an end date, confirmed by HR — paid as the engine always did without a termination date
    expect(Number(one(`SELECT base_salary FROM payslips WHERE period_id = ${ids.pSep} AND employee_id = ${ids.S7}`).base_salary)).toBe(25000);
    expect(Number(one(`SELECT calc_version FROM payroll_periods WHERE id = ${ids.pSep}`).calc_version)).toBe(2);
    const res = H.sql(`SELECT e.emp_code AS emp, r.selection, r.decision, r.review_confirmed AS k, r.calculated AS paid FROM payroll_selection_results r JOIN employees e ON e.id = r.employee_id WHERE r.period_id = ${ids.pSep} AND r.calc_version = 2 ORDER BY e.emp_code`)
      .map((x) => `${x.emp}:${x.selection}:${x.decision}:${x.k}:${x.paid}`);
    expect(res).toEqual(['ZS1:standard:pay:0:1', 'ZS2:standard:pay:0:1', 'ZS3:standard:pay:0:1', 'ZS4:deselected:not_selected:0:0', 'ZS5:added:review:1:1', 'ZS6:deselected:not_selected:0:0', 'ZS7:added:review:1:1', 'ZS8:deselected:not_selected:0:0']);
    // version 1's result is kept as it was
    expect(Number(one(`SELECT COUNT(*) AS n FROM payroll_selection_results WHERE period_id = ${ids.pSep} AND calc_version = 1`).n)).toBe(4);
  });

  it('a selection change after the calculation must be recalculated before approval; then approval and the ACC gate work', async () => {
    expect((await c.payroll!.post(S(ids.pSep, '/deselect'), { employee_ids: [ids.S7], reason: 'zz รอเอกสารวันสิ้นสุด' })).status).toBe(200);
    const a = await c.admin!.post(`/api/payroll/periods/${ids.pSep}/approve`);
    expect(a.status).toBe(409);
    expect(a.body.error.code).toBe('selection_changed_recalculate');
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.pSep}/calculate`)).status).toBe(200);
    expect(slips(ids.pSep)).toEqual(['ZS1', 'ZS2', 'ZS3', 'ZS5']);
    expect((await c.admin!.post(`/api/payroll/periods/${ids.pSep}/approve`)).status).toBe(200);
    // an approved period's selection cannot change
    const locked = await c.payroll!.post(S(ids.pSep, '/select'), { employee_ids: [ids.S7] });
    expect(locked.status).toBe(409);
    expect(locked.body.error.code).toBe('period_locked');
    // 33. PR #24: publishing still needs the ACC sign-off of this version
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.pSep}/publish`)).status).toBe(409);
    seedAccountingSignOff(H, ids.pSep);
    expect((await c.payroll!.post(`/api/payroll/periods/${ids.pSep}/publish`)).status).toBe(200);
  });

  it('28. no duplicate payslip: one per employee and period, also after recalculations', () => {
    expect(Number(one(`SELECT COUNT(*) AS n FROM (SELECT employee_id FROM payslips WHERE period_id = ${ids.pSep} GROUP BY employee_id HAVING COUNT(*) > 1)`).n)).toBe(0);
    expect(() => H.sql(`INSERT INTO payslips (period_id, employee_id, base_salary, gross, net) VALUES (${ids.pSep}, ${ids.S1}, 1, 1, 1)`)).toThrow();
  });
});

describe('lapse, races and P1 / P2 / P3', () => {
  it('a confirmation lapses when the reasons change; 38. concurrent selection changes once', async () => {
    ids.pOct = await newPeriod('ZS-2026-10', ids.A, '2026-10-01', '2026-10-31');
    const rs = await Promise.all([1, 2, 3].map(() => c.payroll!.post(S(ids.pOct, '/select'), { employee_ids: [ids.S5], reason: REASON })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.map((r) => r.body.results[0].result).sort()).toEqual(['selected', 'unchanged', 'unchanged']);
    expect(events(ids.pOct)).toEqual(['ZS5:selected:not_selected>selected']);
    expect(Number(one(`SELECT version FROM payroll_period_selection_versions WHERE period_id = ${ids.pOct}`).version)).toBe(1);
    expect((await c.leader!.post(S(ids.pOct, `/employees/${ids.S5}/confirm`), { reason: REASON })).status).toBe(200);
    // the employee's situation changes: resigned without an end date — the old confirmation does not cover it
    H.sql(`UPDATE employees SET status = 'resigned' WHERE id = ${ids.S5}`);
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.pOct}/calculate`);
    expect(r.status).toBe(409);
    expect(r.body.error.details.employees).toEqual([expect.objectContaining({ emp_code: 'ZS5', status: 'employment_period_mismatch', decision: 'review' })]);
    H.sql(`UPDATE employees SET status = 'suspended' WHERE id = ${ids.S5}`);
  });

  it('32. P3: a deselected employee with a company problem no longer blocks; a selected one does', async () => {
    H.sql(`UPDATE employee_company_assignments SET status = 'pending_review' WHERE employee_id = ${ids.S8}`);
    const blocked = await c.payroll!.post(`/api/payroll/periods/${ids.pOct}/calculate`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('company_conflict');
    expect((await c.payroll!.post(S(ids.pOct, '/deselect'), { employee_ids: [ids.S8], reason: 'zz รอยืนยันบริษัท' })).status).toBe(200);
    const ok = await c.payroll!.post(`/api/payroll/periods/${ids.pOct}/calculate`);
    expect(ok.status, ok.text).toBe(200);
    // October: the standard list (ZS3 left on 10 Sep, ZS8 taken out) plus ZS5 added here (ZS7 was added to September only)
    expect(slips(ids.pOct)).toEqual(['ZS1', 'ZS2', 'ZS5']);
    H.sql(`UPDATE employee_company_assignments SET status = 'verified' WHERE employee_id = ${ids.S8}`);
  });

  it('31. P2: daily attendance follows the selection (added employees in, deselected out)', async () => {
    const agg = (await c.payroll!.get(`/api/payroll/periods/${ids.pOct}/attendance`)).body.aggregates.map((x: { employee_id: number }) => x.employee_id);
    expect(agg).toContain(ids.S5);
    expect(agg).not.toContain(ids.S8);
  });

  it('30. P1: holds are scanned for the selected employees only', async () => {
    expect((await c.admin!.put('/api/admin/settings', { 'payroll.attendance_review_from': '2026-10-01' })).status).toBe(200);
    const r = await c.payroll!.post(`/api/payroll/periods/${ids.pOct}/attendance-holds/scan`);
    expect(r.status, r.text).toBe(200);
    const held = H.sql(`SELECT DISTINCT e.emp_code AS emp FROM payroll_attendance_holds h JOIN employees e ON e.id = h.employee_id WHERE h.period_id = ${ids.pOct} ORDER BY 1`).map((x) => String(x.emp));
    expect(held).toContain('ZS5');
    expect(held).not.toContain('ZS8');
    expect((await c.admin!.put('/api/admin/settings', { 'payroll.attendance_review_from': '' })).status).toBe(200);
  });
});

describe('audit', () => {
  it('37. every select / deselect / confirmation is audited with actor, company, period, employees, statuses, reason; events are append-only', () => {
    const a = H.sql(`SELECT action, user_id, details FROM audit_logs WHERE action LIKE 'payroll_selection.%' AND entity_id = '${ids.pSep}' ORDER BY id`) as Array<{ action: string; user_id: number; details: string }>;
    expect(a.map((x) => x.action)).toEqual(expect.arrayContaining(['payroll_selection.selected', 'payroll_selection.deselected', 'payroll_selection.review_confirmed']));
    const sel = JSON.parse(a.find((x) => x.action === 'payroll_selection.selected')!.details);
    expect(sel).toMatchObject({ company_id: ids.A, reason: REASON, employees: expect.arrayContaining([{ employee_id: ids.S5, previous: 'not_selected', new: 'selected' }]) });
    const des = JSON.parse(a.find((x) => x.action === 'payroll_selection.deselected')!.details);
    expect(des.employees).toEqual(expect.arrayContaining([{ employee_id: ids.S8, previous: 'selected', new: 'deselected' }]));
    expect(JSON.parse(a.find((x) => x.action === 'payroll_selection.review_confirmed')!.details)).toMatchObject({ employee_id: ids.S5, reasons: ['unknown_status'], reason: REASON });
    expect(() => H.sql(`UPDATE payroll_period_selection_events SET reason = 'x' WHERE period_id = ${ids.pSep}`)).toThrow();
    expect(() => H.sql(`DELETE FROM payroll_period_selection_events WHERE period_id = ${ids.pSep}`)).toThrow();
    expect(() => H.sql(`DELETE FROM payroll_period_selections WHERE period_id = ${ids.pSep}`)).toThrow();
    expect(() => H.sql(`UPDATE payroll_selection_results SET calculated = 0 WHERE period_id = ${ids.pSep}`)).toThrow();
  });
});
