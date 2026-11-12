// ACC review and manager sign-off (migration 0018) end to end through the API — isolated local D1, synthetic data only
// (companies ZAC1 / ZAC2, employees ZC1–ZC3). Nothing here is seeded around the workflow: every step is a real request
// by a separate person — HR Payroll Officer calculates, HR Leader approves, ACC Staff reviews, ACC Manager signs off or
// returns to HR, the Payroll Officer publishes. Covers: order of steps (no skipping through the API), role gates,
// four-person separation of duties, return to HR (period back to calculated, approve refused until recalculated),
// invalidation of a review / sign-off by Super Admin reopen and by recalculation, the publish gate tied to calc_version,
// duplicate requests acting once, append-only events, audit entries, and company scope for a company-limited reviewer.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../../src/shared/totp';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const ids = {} as Record<'A' | 'B' | 'leader' | 'accStaff' | 'accMgr' | 'admin' | 'payroll' | 'sa2', number>;
const Y = new Date().getUTCFullYear() + 3;
const WRANGLER = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const one = (sql: string) => H.sql(sql)[0] as Record<string, any>;
const period = (id: number) => one(`SELECT status, calc_version, calculated_by, approved_by, published_by, reopened_from FROM payroll_periods WHERE id = ${id}`);
const review = (id: number) => H.sql(`SELECT calc_version, status, staff_reviewed_by, manager_signed_by FROM payroll_accounting_reviews WHERE period_id = ${id} ORDER BY calc_version`);
const events = (id: number) => H.sql(`SELECT calc_version, action, actor_id FROM payroll_accounting_review_events WHERE period_id = ${id} ORDER BY id`);
const audits = (id: number, action: string) => H.sql(`SELECT user_id, details FROM audit_logs WHERE entity = 'payroll_periods' AND entity_id = '${id}' AND action = '${action}' ORDER BY id`) as Array<{ user_id: number; details: string }>;
const PASSWORD = 'Zz-Acc-Signoff-Pass-2026!';

/** A user created by the Super Admin through the API (privileged roles: first password change + MFA enrolment). */
async function makeUser(username: string, roles: string[]): Promise<Client> {
  const u = await c.admin!.post('/api/admin/users', { username, displayName: username, roles });
  expect(u.status, u.text).toBe(201);
  const who = new Client(H.baseUrl);
  await who.login(username, u.body.temporaryPassword);
  expect((await who.post('/api/auth/change-password', { currentPassword: u.body.temporaryPassword, newPassword: PASSWORD })).status).toBe(200);
  expect((await who.get('/api/meta')).status).toBe(200);
  ids[username === 'zz_leader' ? 'leader' : username === 'zz_acc_staff' ? 'accStaff' : username === 'zz_acc_mgr' ? 'accMgr' : 'sa2'] = Number(one(`SELECT id FROM users WHERE username = '${username}'`).id);
  return who;
}

let month = 0;
/** A company A (or B) monthly period of its own month, calculated by `calc` (default: the Payroll Officer). */
async function calculated(company: 'A' | 'B' = 'A', calc: Client = c.payroll!): Promise<number> {
  month += 1;
  const m = String(month).padStart(2, '0');
  const last = new Date(Date.UTC(Y, month, 0)).getUTCDate();
  const r = await c.admin!.post('/api/payroll/periods', { code: `ZAC-${company}-${m}`, name: `zz acc ${m}`, kind: 'monthly', company_id: ids[company], start_date: `${Y}-${m}-01`, end_date: `${Y}-${m}-${last}`, pay_date: `${Y}-${m}-${last}` });
  expect(r.status, r.text).toBe(201);
  const k = await calc.post(`/api/payroll/periods/${r.body.id}/calculate`);
  expect(k.status, k.text).toBe(200);
  return r.body.id as number;
}
/** calculated by the Payroll Officer and approved by the HR Leader */
async function approved(company: 'A' | 'B' = 'A'): Promise<number> {
  const id = await calculated(company);
  const a = await c.leader!.post(`/api/payroll/periods/${id}/approve`);
  expect(a.status, a.text).toBe(200);
  return id;
}
const reviewBy = (who: Client, id: number, note = 'zz ตรวจยอดแล้ว') => who.post(`/api/payroll/periods/${id}/accounting-review`, { note });
const decide = (who: Client, id: number, decision: string, note?: string) => who.post(`/api/payroll/periods/${id}/accounting-signoff`, { decision, ...(note ? { note } : {}) });
const publish = (id: number) => c.payroll!.post(`/api/payroll/periods/${id}/publish`);

beforeAll(async () => {
  H = await startHarness();
  H.sql(`INSERT INTO companies (code, name, active) VALUES ('ZAC1', 'ZZ ACC A', 1), ('ZAC2', 'ZZ ACC B', 1);`);
  ids.A = Number(one("SELECT id FROM companies WHERE code = 'ZAC1'").id);
  ids.B = Number(one("SELECT id FROM companies WHERE code = 'ZAC2'").id);
  H.sql(`INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status, base_salary) VALUES
    ('ZC1', 'Zz', 'One', ${ids.A}, '${Y - 1}-01-01', 'permanent', 'active', 20000),
    ('ZC2', 'Zz', 'Two', ${ids.A}, '${Y - 1}-01-01', 'permanent', 'active', 26000),
    ('ZC3', 'Zz', 'Three', ${ids.B}, '${Y - 1}-01-01', 'permanent', 'active', 30000);`);
  c.admin = new Client(H.baseUrl);
  await c.admin.login('it_admin', H.passwords.it_admin);
  c.payroll = new Client(H.baseUrl);
  await c.payroll.login('it_payroll', H.passwords.it_payroll);
  ids.admin = Number(one("SELECT id FROM users WHERE username = 'it_admin'").id);
  ids.payroll = Number(one("SELECT id FROM users WHERE username = 'it_payroll'").id);
  c.leader = await makeUser('zz_leader', ['hr_leader']);
  c.accStaff = await makeUser('zz_acc_staff', ['acc_staff']);
  c.accMgr = await makeUser('zz_acc_mgr', ['acc_manager']);
  c.sa2 = await makeUser('zz_sa2', ['super_admin']);
}, 300_000);
afterAll(async () => {
  await H?.stop();
});

describe('the workflow cannot be skipped through the API', () => {
  it('before HR approval: no ACC review, no sign-off, no publish', async () => {
    const id = await calculated();
    expect((await reviewBy(c.accStaff!, id)).status).toBe(409);
    expect((await decide(c.accMgr!, id, 'signed_off')).status).toBe(409);
    expect((await publish(id)).status).toBe(409);
    expect(review(id)).toEqual([]);
    expect(events(id)).toEqual([]);
  });

  it('after HR approval: sign-off needs the ACC Staff review first; publish needs the sign-off', async () => {
    const id = await approved();
    expect((await decide(c.accMgr!, id, 'signed_off')).status).toBe(409);
    expect((await publish(id)).status).toBe(409);
    expect((await reviewBy(c.accStaff!, id)).status).toBe(201);
    expect((await publish(id)).status).toBe(409);
    expect(period(id).status).toBe('approved');
  });

  it('each role does only its own step', async () => {
    const id = await approved();
    expect((await reviewBy(c.accMgr!, id)).status).toBe(403); // ACC Manager never submits the review
    expect((await reviewBy(c.payroll!, id)).status).toBe(403);
    expect((await reviewBy(c.leader!, id)).status).toBe(403);
    expect((await reviewBy(c.accStaff!, id)).status).toBe(201);
    expect((await decide(c.accStaff!, id, 'signed_off')).status).toBe(403); // ACC Staff never signs off
    expect((await decide(c.payroll!, id, 'signed_off')).status).toBe(403);
    expect((await decide(c.leader!, id, 'signed_off')).status).toBe(403);
    expect((await c.accStaff!.post(`/api/payroll/periods/${id}/publish`)).status).toBe(403);
    expect((await c.accMgr!.post(`/api/payroll/periods/${id}/publish`)).status).toBe(403);
    expect((await decide(c.accMgr!, id, 'maybe')).status).toBe(400);
    expect(review(id)).toEqual([{ calc_version: 1, status: 'reviewed', staff_reviewed_by: ids.accStaff, manager_signed_by: null }]);
  });
});

describe('happy path: four different people, events and audit', () => {
  it('calculate → approve → review → sign-off → publish', async () => {
    const id = await approved();
    expect((await reviewBy(c.accStaff!, id, 'zz ยอดตรงกับรายงาน')).status).toBe(201);
    expect((await reviewBy(c.accStaff!, id)).status).toBe(409); // one review per version
    const s = await decide(c.accMgr!, id, 'signed_off', 'zz รับรอง');
    expect(s.status, s.text).toBe(200);
    expect(s.body).toMatchObject({ status: 'signed_off', calc_version: 1, period_status: 'approved' });
    expect((await decide(c.accMgr!, id, 'signed_off')).status).toBe(409); // decided already
    const p = await publish(id);
    expect(p.status, p.text).toBe(200);
    expect(period(id)).toMatchObject({ status: 'published', calculated_by: ids.payroll, approved_by: ids.leader, published_by: ids.payroll });
    expect(events(id)).toEqual([
      { calc_version: 1, action: 'staff_reviewed', actor_id: ids.accStaff },
      { calc_version: 1, action: 'manager_signed_off', actor_id: ids.accMgr },
    ]);
    expect(audits(id, 'payroll.accounting_reviewed').map((a) => a.user_id)).toEqual([ids.accStaff]);
    const signed = audits(id, 'payroll.accounting_signed_off');
    expect(signed.map((a) => a.user_id)).toEqual([ids.accMgr]);
    expect(JSON.parse(signed[0]!.details)).toMatchObject({ calc_version: 1, manager: ids.accMgr, reviewer: ids.accStaff, calculated_by: ids.payroll, approved_by: ids.leader });
    expect(audits(id, 'payroll.published')).toHaveLength(1);
    // a published period is never reviewed again
    expect((await reviewBy(c.accStaff!, id)).status).toBe(409);
  });

  it('the review / sign-off events are append-only', async () => {
    const [ev] = H.sql('SELECT id FROM payroll_accounting_review_events ORDER BY id LIMIT 1') as Array<{ id: number }>;
    expect(() => H.sql(`UPDATE payroll_accounting_review_events SET note = 'x' WHERE id = ${ev!.id}`)).toThrow();
    expect(() => H.sql(`DELETE FROM payroll_accounting_review_events WHERE id = ${ev!.id}`)).toThrow();
  });
});

describe('separation of duties (calculator, HR approver, ACC reviewer and ACC signer are four people)', () => {
  // the Super Admin holds every permission, so it is the one account that could otherwise take two roles
  it('the calculator cannot review or sign off', async () => {
    const id = await calculated('A', c.admin!);
    expect((await c.leader!.post(`/api/payroll/periods/${id}/approve`)).status).toBe(200);
    expect((await reviewBy(c.admin!, id)).status).toBe(403);
    expect((await reviewBy(c.accStaff!, id)).status).toBe(201);
    expect((await decide(c.admin!, id, 'signed_off')).status).toBe(403);
    expect(review(id)[0]).toMatchObject({ status: 'reviewed' });
  });

  it('the HR approver cannot review or sign off', async () => {
    const id = await calculated();
    expect((await c.admin!.post(`/api/payroll/periods/${id}/approve`)).status).toBe(200);
    expect((await reviewBy(c.admin!, id)).status).toBe(403);
    expect((await reviewBy(c.accStaff!, id)).status).toBe(201);
    expect((await decide(c.admin!, id, 'signed_off')).status).toBe(403);
  });

  it('the ACC reviewer cannot sign off', async () => {
    const id = await approved();
    expect((await reviewBy(c.admin!, id)).status).toBe(201);
    expect((await decide(c.admin!, id, 'signed_off')).status).toBe(403);
    expect((await decide(c.admin!, id, 'returned', 'zz ส่งกลับเอง')).status).toBe(403);
    expect((await decide(c.accMgr!, id, 'signed_off')).status).toBe(200);
    expect((await publish(id)).status).toBe(200);
  });
});

describe('return to HR', () => {
  it('needs a reason; puts the period back to calculated; HR must recalculate before approving again', async () => {
    const id = await approved();
    expect((await reviewBy(c.accStaff!, id)).status).toBe(201);
    expect((await decide(c.accMgr!, id, 'returned')).status).toBe(400);
    expect((await decide(c.accMgr!, id, 'returned', 'สั้น')).status).toBe(400);
    expect(period(id).status).toBe('approved');
    const r = await decide(c.accMgr!, id, 'returned', 'zz ยอด OT ไม่ตรงกับรายงาน Feishu');
    expect(r.status, r.text).toBe(200);
    expect(r.body).toMatchObject({ status: 'returned', period_status: 'calculated' });
    expect(period(id)).toMatchObject({ status: 'calculated', approved_by: null, calc_version: 1 });
    // HR sees why the period came back
    const listed = (await c.payroll!.get('/api/payroll/periods')).body.find((x: { id: number }) => x.id === id);
    expect(listed).toMatchObject({ status: 'calculated', accounting_status: 'returned', calc_version: 1 });
    expect(JSON.parse(audits(id, 'payroll.accounting_returned')[0]!.details)).toMatchObject({ calc_version: 1, note: 'zz ยอด OT ไม่ตรงกับรายงาน Feishu', periodStatus: { from: 'approved', to: 'calculated' } });
    // the returned figures cannot be approved, reviewed, signed or published
    expect((await c.leader!.post(`/api/payroll/periods/${id}/approve`)).status).toBe(409);
    expect((await reviewBy(c.accStaff!, id)).status).toBe(409);
    expect((await decide(c.accMgr!, id, 'signed_off')).status).toBe(409);
    expect((await publish(id)).status).toBe(409);
    // HR reopens and recalculates: a new version goes through the whole review again
    expect((await c.payroll!.post(`/api/payroll/periods/${id}/reopen`)).status).toBe(200);
    expect((await c.payroll!.post(`/api/payroll/periods/${id}/calculate`)).status).toBe(200);
    expect(period(id)).toMatchObject({ status: 'calculated', calc_version: 2 });
    expect((await c.leader!.post(`/api/payroll/periods/${id}/approve`)).status).toBe(200);
    expect((await publish(id)).status).toBe(409);
    expect((await reviewBy(c.accStaff!, id)).status).toBe(201);
    expect((await decide(c.accMgr!, id, 'signed_off')).status).toBe(200);
    expect((await publish(id)).status).toBe(200);
    expect(review(id)).toEqual([
      { calc_version: 1, status: 'returned', staff_reviewed_by: ids.accStaff, manager_signed_by: ids.accMgr },
      { calc_version: 2, status: 'signed_off', staff_reviewed_by: ids.accStaff, manager_signed_by: ids.accMgr },
    ]);
    expect(events(id).map((e) => `${e.calc_version}:${e.action}`)).toEqual(['1:staff_reviewed', '1:returned', '2:staff_reviewed', '2:manager_signed_off']);
  });
});

describe('a sign-off is never reused for other figures', () => {
  it('Super Admin reopen supersedes the sign-off; recalculation needs a new review and sign-off', async () => {
    const id = await approved();
    expect((await reviewBy(c.accStaff!, id)).status).toBe(201);
    expect((await decide(c.accMgr!, id, 'signed_off')).status).toBe(200);
    // Super Admin reopens the approved (signed-off, not yet published) period: step-up MFA, reason, period code
    const code = String(one(`SELECT code FROM payroll_periods WHERE id = ${id}`).code);
    const ro = await c.admin!.post(`/api/payroll/periods/${id}/reopen-closed`, { reason: 'zz แก้ไขยอดหลังลงนาม', confirm_code: code, totp: await totpCode(c.admin!.totpSecret as string) });
    expect(ro.status, ro.text).toBe(200);
    expect(review(id)).toEqual([{ calc_version: 1, status: 'superseded', staff_reviewed_by: ids.accStaff, manager_signed_by: ids.accMgr }]);
    expect(events(id).at(-1)).toEqual({ calc_version: 1, action: 'invalidated', actor_id: ids.admin });
    expect(JSON.parse(audits(id, 'payroll.period_reopened_closed')[0]!.details)).toMatchObject({ accountingSuperseded: 1 });
    // forced recalculation (a second Super Admin, its own step-up code): version 2
    const rc = await c.sa2!.post(`/api/payroll/periods/${id}/calculate`, { reason: 'zz คำนวณใหม่หลังเปิดงวด', totp: await totpCode(c.sa2!.totpSecret as string) });
    expect(rc.status, rc.text).toBe(200);
    expect(period(id)).toMatchObject({ status: 'calculated', calc_version: 2 });
    expect((await c.leader!.post(`/api/payroll/periods/${id}/approve`)).status).toBe(200);
    // the version-1 sign-off does not cover version 2
    expect((await publish(id)).status).toBe(409);
    expect((await reviewBy(c.accStaff!, id)).status).toBe(201);
    expect((await publish(id)).status).toBe(409);
    expect((await decide(c.accMgr!, id, 'signed_off')).status).toBe(200);
    expect((await publish(id)).status).toBe(200);
  });

  it('Super Admin reopen without recalculation: the same version is reviewed and signed again', async () => {
    const id = await approved();
    expect((await reviewBy(c.accStaff!, id)).status).toBe(201);
    expect((await decide(c.accMgr!, id, 'signed_off')).status).toBe(200);
    const code = String(one(`SELECT code FROM payroll_periods WHERE id = ${id}`).code);
    const ro = await c.sa2!.post(`/api/payroll/periods/${id}/reopen-closed`, { reason: 'zz ตรวจซ้ำ ไม่แก้ยอด', confirm_code: code, totp: await totpCode(c.sa2!.totpSecret as string, Date.now() + 30_000) });
    expect(ro.status, ro.text).toBe(200);
    expect((await c.leader!.post(`/api/payroll/periods/${id}/approve`)).status).toBe(200);
    expect(period(id).calc_version).toBe(1);
    expect((await publish(id)).status).toBe(409);
    expect((await reviewBy(c.accStaff!, id)).status).toBe(201);
    expect((await decide(c.accMgr!, id, 'signed_off')).status).toBe(200);
    expect((await publish(id)).status).toBe(200);
    expect(events(id).map((e) => e.action)).toEqual(['staff_reviewed', 'manager_signed_off', 'invalidated', 'staff_reviewed', 'manager_signed_off']);
  });
});

describe('duplicate requests act once', () => {
  it('concurrent reviews record one review; concurrent sign-offs record one decision', async () => {
    const id = await approved();
    const rs = await Promise.all([1, 2, 3].map(() => reviewBy(c.accStaff!, id)));
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    const ds = await Promise.all([1, 2, 3].map(() => decide(c.accMgr!, id, 'signed_off')));
    expect(ds.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    expect(events(id).map((e) => e.action)).toEqual(['staff_reviewed', 'manager_signed_off']);
    const ps = await Promise.all([1, 2].map(() => publish(id)));
    expect(ps.map((r) => r.status).sort()).toEqual([200, 409]);
  });
});

describe('company scope of a company-limited reviewer', () => {
  it('reviews its own company only: another company 404, an all-company period 403; nothing is written', async () => {
    H.sql(`INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status, base_salary) VALUES ('ZC9', 'Zz', 'Reviewer', ${ids.A}, '${Y - 1}-01-01', 'permanent', 'active', 15000);
      INSERT INTO roles (code, name, description, privileged, system) VALUES ('zz_acc_company', 'ZZ ACC (company)', 'test', 0, 0);
      INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.value FROM roles r, json_each('["payroll.view","payroll.accounting.review","payroll.accounting.review.submit"]') p WHERE r.code = 'zz_acc_company';`);
    const out = join(H.dir, 'zz_acc_a.sql');
    execFileSync(process.execPath, ['scripts/create-user.mjs', '--username', 'zz_acc_a', '--display', 'zz_acc_a', '--role', 'zz_acc_company', '--employee', 'ZC9', '--out', out, '--cred-file', join(H.dir, 'acc-cred.txt')], { env: { ...process.env, NEW_USER_PASSWORD: PASSWORD }, stdio: 'ignore' });
    execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', join(H.dir, 'state'), '--file', out], { env: { ...process.env, CI: '1' }, stdio: 'ignore' });
    const a = new Client(H.baseUrl);
    expect((await a.login('zz_acc_a', PASSWORD)).status).toBe(200);

    const b = await approved('B');
    expect((await reviewBy(a, b)).status).toBe(404);
    expect((await a.get(`/api/payroll/periods/${b}/accounting-review`)).status).toBe(404);
    const list = (await a.get('/api/payroll/accounting/periods')).body as Array<{ id: number; company_id: number | null }>;
    expect(list.some((x) => x.id === b)).toBe(false);
    expect(list.every((x) => x.company_id === null || x.company_id === ids.A)).toBe(true);
    // an all-company period also pays other companies: reviewing it needs organisation-wide scope
    month += 1;
    const m = String(month).padStart(2, '0');
    const all = await c.admin!.post('/api/payroll/periods', { code: `ZAC-ALL-${m}`, name: 'zz all', kind: 'monthly', company_id: null, start_date: `${Y}-${m}-01`, end_date: `${Y}-${m}-28`, pay_date: `${Y}-${m}-28` });
    expect((await c.payroll!.post(`/api/payroll/periods/${all.body.id}/calculate`)).status).toBe(200);
    expect((await c.leader!.post(`/api/payroll/periods/${all.body.id}/approve`)).status).toBe(200);
    expect((await reviewBy(a, all.body.id)).status).toBe(403);
    expect(review(b)).toEqual([]);
    expect(review(all.body.id)).toEqual([]);
    // its own company works
    const own = await approved('A');
    expect((await reviewBy(a, own)).status).toBe(201);
  });
});
