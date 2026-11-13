// Super Admin payroll period management — reopen closed / edit / soft delete / restore / forced recalculation,
// step-up MFA, archive integrity, duplicate requests, audit, and the MFA-session fix. Fresh local D1, synthetic data
// only (company ZZP, employees ZP*).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../../src/shared/totp';
import { hasPermission } from '../../src/shared/permissions';
import { Client, seedAccountingSignOff, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const admin = () => c.admin as Client;
const payroll = () => c.payroll as Client;
const hrAdmin = () => c.hrAdmin as Client;

// step-up codes are single-use per user (whatever the operation): a pool of synthetic Super Admins, each with its own
// TOTP secret, lets the suite run several step-up operations within one 30-second step. Key = admin + time step.
const SA_PASSWORD = 'Super-Admin-Pass-2026!';
const admins: Client[] = [];
const used = new Set<string>();
async function stepUp(only?: Client): Promise<{ who: Client; totp: string }> {
  for (;;) {
    const now = Math.floor(Date.now() / 30_000);
    for (const [i, who] of admins.entries()) {
      if (only && who !== only) continue;
      // the current or the next window only: a code of the previous window is accepted by the server only until the
      // next window boundary, so under load it can expire between generation and verification (403 mfa_invalid)
      for (const s of [0, 1]) {
        const key = `${i}:${now + s}`;
        if (!used.has(key)) {
          used.add(key);
          return { who, totp: await totpCode(who.totpSecret as string, (now + s) * 30_000 + 15_000) };
        }
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
/** One step-up request, sent as the next Super Admin that has an unused code. */
async function asAdmin<T>(send: (who: Client, totp: string) => Promise<T>): Promise<T> {
  const { who, totp } = await stepUp();
  return send(who, totp);
}
const one = (sql: string) => H.sql(sql)[0] as Record<string, any>;
const status = (id: number) => one(`SELECT status, reopened_from, calc_version, code, deleted_at FROM payroll_periods WHERE id = ${id}`);
const slipStats = (id: number) => one(`SELECT COUNT(*) AS n, COALESCE(SUM(published), 0) AS pub, ROUND(COALESCE(SUM(net), 0), 2) AS net FROM payslips WHERE period_id = ${id}`);
const archived = (id: number, reason?: string) => Number(one(`SELECT COUNT(*) AS n FROM payslip_archive WHERE period_id = ${id}${reason ? ` AND reason = '${reason}'` : ''}`).n);
const audits = (id: number, action: string) => H.sql(`SELECT user_id, details FROM audit_logs WHERE entity = 'payroll_periods' AND entity_id = '${id}' AND action = '${action}' ORDER BY id`) as Array<{ user_id: number; details: string }>;

beforeAll(async () => {
  H = await startHarness();
  for (const k of ['admin', 'payroll', 'staff', 'manager', 'employee', 'hrAdmin']) c[k] = new Client(H.baseUrl);
  await admin().login('it_admin', H.passwords.it_admin);
  await payroll().login('it_payroll', H.passwords.it_payroll);
  await c.staff!.login('it_staff', H.passwords.it_staff);
  await c.manager!.login('it_manager', H.passwords.it_manager);
  await c.employee!.login('it_employee', H.passwords.it_employee);
  // an HR Admin account (privileged role: MFA enrolment + first password change)
  const u = await admin().post('/api/admin/users', { username: 'it_hradmin', displayName: 'it_hradmin', roles: ['hr_admin'] });
  expect(u.status, u.text).toBe(201);
  await hrAdmin().login('it_hradmin', u.body.temporaryPassword);
  expect((await hrAdmin().post('/api/auth/change-password', { currentPassword: u.body.temporaryPassword, newPassword: 'Hr-Admin-Pass-2026!' })).status).toBe(200);
  expect((await hrAdmin().get('/api/meta')).status).toBe(200);
  // Super Admin pool for step-up codes (it_admin + it_sa2..it_sa12) and an employee login for ZP1
  admins.push(admin());
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    const sa = await admin().post('/api/admin/users', { username: `it_sa${n}`, displayName: `it_sa${n}`, roles: ['super_admin'] });
    expect(sa.status, sa.text).toBe(201);
    const who = new Client(H.baseUrl);
    await who.login(`it_sa${n}`, sa.body.temporaryPassword);
    expect((await who.post('/api/auth/change-password', { currentPassword: sa.body.temporaryPassword, newPassword: SA_PASSWORD })).status).toBe(200);
    admins.push(who);
  }
  const e = await admin().post('/api/admin/users', { username: 'it_zp1', displayName: 'it_zp1', roles: ['employee'] });
  expect(e.status, e.text).toBe(201);
  c.zp1 = new Client(H.baseUrl);
  await c.zp1.login('it_zp1', e.body.temporaryPassword);
  expect((await c.zp1.post('/api/auth/change-password', { currentPassword: e.body.temporaryPassword, newPassword: 'Zp1-Employee-Pass-2026!' })).status).toBe(200);
});
const zp1 = () => c.zp1 as Client;
const notified = () => Number(one("SELECT COUNT(*) AS n FROM notifications WHERE user_id = (SELECT id FROM users WHERE username = 'it_zp1') AND link LIKE '/my/payslips/%'").n);
afterAll(async () => {
  await H?.stop();
});

const ids: Record<string, number> = {};

describe('setup (synthetic company ZZP)', () => {
  it('company, employees and a published month', async () => {
    ids.co = (await admin().post('/api/m/companies', { code: 'ZZP', name: 'zz_test period admin', active: true })).body.id;
    const emp = (code: string, hire: string, x: Record<string, unknown> = {}) =>
      admin().post('/api/m/employees', { emp_code: code, first_name: 'zz_test', last_name: code, company_id: ids.co, hire_date: hire, employment_type: 'permanent', status: 'active', base_salary: 30000, ...x });
    expect((await emp('ZP1', '2020-01-01')).status).toBe(201);
    expect((await emp('ZP2', '2026-09-01', { employment_type: 'probation', status: 'probation' })).status).toBe(201);
    H.sql("UPDATE employees SET user_id = (SELECT id FROM users WHERE username = 'it_zp1') WHERE emp_code = 'ZP1'");
    const mk = async (code: string, kind: string, start: string, end: string, pay: string) => {
      const r = await payroll().post('/api/payroll/periods', { company_id: ids.co, code, name: `zz ${code}`, kind, start_date: start, end_date: end, pay_date: pay });
      expect(r.status, r.text).toBe(201);
      return r.body.id as number;
    };
    ids.a = await mk('ZP-2026-09', 'monthly', '2026-08-26', '2026-09-25', '2026-09-30');
    ids.mid = await mk('ZP-2026-10-M', 'mid_month', '2026-09-26', '2026-10-10', '2026-10-15');
    ids.b = await mk('ZP-2026-10', 'monthly', '2026-09-26', '2026-10-25', '2026-10-31');
    ids.d = await mk('ZP-2027-01', 'monthly', '2026-12-26', '2027-01-25', '2027-01-31');
    expect((await payroll().post(`/api/payroll/periods/${ids.a}/calculate`)).status).toBe(200);
    expect((await admin().post(`/api/payroll/periods/${ids.a}/approve`)).status).toBe(200);
    seedAccountingSignOff(H, ids.a!);
    expect((await payroll().post(`/api/payroll/periods/${ids.a}/publish`)).status).toBe(200);
    expect(status(ids.a!).status).toBe('published');
    expect(slipStats(ids.a!)).toMatchObject({ n: 2, pub: 2 });
    expect((await zp1().get('/api/my/payslips')).body.rows).toHaveLength(1);
    expect(notified()).toBe(1);
  });
});

describe('RBAC: explicit, Super Admin only', () => {
  it('three-part permissions are matched only by name or "*" (never by payroll.* / *.delete)', () => {
    expect(hasPermission(['payroll.*'], 'payroll.period.reopen')).toBe(false);
    expect(hasPermission(['*.delete', '*.update'], 'payroll.period.delete')).toBe(false);
    expect(hasPermission(['payroll.period.reopen'], 'payroll.period.reopen')).toBe(true);
    expect(hasPermission(['*'], 'payroll.period.force_recalculate')).toBe(true);
    expect(hasPermission(['payroll.*'], 'payroll.calculate')).toBe(true); // existing grants unchanged
  });

  it('the role editor cannot grant them; Super Admin holds them explicitly', async () => {
    const roles = (await admin().get('/api/admin/roles')).body;
    expect(roles.catalogue.some((p: string) => p.startsWith('payroll.period.'))).toBe(false);
    const sa = roles.roles.find((r: { code: string }) => r.code === 'super_admin');
    expect(sa.permissions).toEqual(expect.arrayContaining(['payroll.period.reopen', 'payroll.period.edit_closed', 'payroll.period.delete', 'payroll.period.force_recalculate']));
    const staffRole = roles.roles.find((r: { code: string }) => r.code === 'hr_staff');
    expect((await admin().put(`/api/admin/roles/${staffRole.id}`, { permissions: [...staffRole.permissions, 'payroll.period.reopen'] })).status).toBe(400);
  });

  it('HR Admin, Payroll Officer, HR Staff and anonymous are refused on every endpoint; nothing changes', async () => {
    const before = JSON.stringify([status(ids.a!), slipStats(ids.a!)]);
    const body = { reason: 'try to change', confirm_code: 'ZP-2026-09', totp: '000000', name: 'x' };
    for (const who of [hrAdmin(), payroll(), c.staff!, new Client(H.baseUrl)]) {
      const anon = !who.cookie;
      const expectDenied = (s: number) => expect(s).toBe(anon ? 401 : 403);
      expectDenied((await who.get(`/api/payroll/periods/${ids.a}/impact`)).status);
      expectDenied((await who.post(`/api/payroll/periods/${ids.a}/reopen-closed`, body)).status);
      expectDenied((await who.put(`/api/payroll/periods/${ids.a}`, body)).status);
      expectDenied((await who.post(`/api/payroll/periods/${ids.d}/delete`, { ...body, confirm_code: 'ZP-2027-01' })).status);
      expectDenied((await who.get('/api/payroll/deleted-periods')).status);
      expectDenied((await who.post(`/api/payroll/periods/${ids.d}/restore`, body)).status);
    }
    // the normal workflow cannot reopen a closed period either
    expect((await payroll().post(`/api/payroll/periods/${ids.a}/reopen`)).status).toBe(409);
    expect(JSON.stringify([status(ids.a!), slipStats(ids.a!)])).toBe(before);
  });
});

describe('reopen a closed (published) period', () => {
  it('requires reason, the exact period code and a valid step-up MFA code', async () => {
    const before = JSON.stringify([status(ids.a!), slipStats(ids.a!), archived(ids.a!)]);
    const url = `/api/payroll/periods/${ids.a}/reopen-closed`;
    expect((await asAdmin((who, totp) => who.post(url, { confirm_code: 'ZP-2026-09', totp }))).status).toBe(400); // no reason
    expect((await asAdmin((who, totp) => who.post(url, { reason: 'แก้ยอดผิด', confirm_code: 'ZP-2026-0', totp }))).status).toBe(400); // wrong code
    const noMfa = await admin().post(url, { reason: 'แก้ยอดผิด', confirm_code: 'ZP-2026-09' });
    expect([noMfa.status, noMfa.body.error.code]).toEqual([403, 'mfa_step_up_required']);
    const bad = await admin().post(url, { reason: 'แก้ยอดผิด', confirm_code: 'ZP-2026-09', totp: '123456' });
    expect([bad.status, bad.body.error.code]).toEqual([403, 'mfa_invalid']);
    expect(JSON.stringify([status(ids.a!), slipStats(ids.a!), archived(ids.a!)])).toBe(before);
  });

  it('archive integrity failure rolls the whole operation back', async () => {
    H.sql("CREATE TRIGGER zz_corrupt_archive AFTER INSERT ON payslip_archive BEGIN UPDATE payslip_archive SET net = net + 1 WHERE id = NEW.id; END;");
    const r = await asAdmin((who, totp) => who.post(`/api/payroll/periods/${ids.a}/reopen-closed`, { reason: 'ทดสอบ integrity', confirm_code: 'ZP-2026-09', totp }));
    H.sql('DROP TRIGGER zz_corrupt_archive;');
    expect(r.status).toBe(500);
    expect(status(ids.a!)).toMatchObject({ status: 'published', reopened_from: null });
    expect(slipStats(ids.a!)).toMatchObject({ n: 2, pub: 2 });
    expect(archived(ids.a!)).toBe(0);
    expect(audits(ids.a!, 'payroll.period_reopened_closed')).toHaveLength(0);
  });

  it('Super Admin reopens: published → calculated, payslips archived then unpublished (kept), nothing recalculated', async () => {
    const before = slipStats(ids.a!);
    const v = status(ids.a!).calc_version;
    const slipId = Number(one(`SELECT s.id FROM payslips s JOIN employees e ON e.id = s.employee_id WHERE s.period_id = ${ids.a} AND e.emp_code = 'ZP1'`).id);
    expect((await zp1().get(`/api/payslips/${slipId}`)).status).toBe(200);
    const { who, totp } = await stepUp();
    const r = await who.post(`/api/payroll/periods/${ids.a}/reopen-closed`, { reason: 'HR ขอแก้ไขยอด OT', confirm_code: 'ZP-2026-09', totp });
    expect(r.status, r.text).toBe(200);
    expect(status(ids.a!)).toMatchObject({ status: 'calculated', reopened_from: 'published', calc_version: v });
    expect(slipStats(ids.a!)).toMatchObject({ n: before.n, net: before.net, pub: 0 });
    const arch = H.sql(`SELECT reason, json_extract(row_json, '$.published') AS pub, op_token FROM payslip_archive WHERE period_id = ${ids.a}`) as Array<{ reason: string; pub: number; op_token: string }>;
    expect(arch).toHaveLength(2);
    expect(arch.every((x) => x.reason === 'reopen' && x.pub === 1 && x.op_token)).toBe(true); // the published evidence is preserved
    const [log] = audits(ids.a!, 'payroll.period_reopened_closed');
    const d = JSON.parse(log!.details);
    expect(d).toMatchObject({ from: 'published', to: 'calculated', reason: 'HR ขอแก้ไขยอด OT', archivedSlips: 2, unpublished: 2 });
    expect(log!.user_id).toBeGreaterThan(0);
    expect(audits(ids.a!, 'payroll.published')).toHaveLength(1); // history kept
    // the employee no longer sees the unpublished payslip, and YTD (HR view) leaves it out
    expect((await zp1().get('/api/my/payslips')).body.rows).toHaveLength(0);
    expect((await zp1().get(`/api/payslips/${slipId}`)).status).toBe(404);
    const ytd = (await payroll().get(`/api/payslips/${slipId}`)).body.ytd;
    expect(ytd).toMatchObject({ includesCurrent: false, employee: { slips: 0, gross: 0 } });
    // the same request again (same code) cannot act twice
    const again = await who.post(`/api/payroll/periods/${ids.a}/reopen-closed`, { reason: 'HR ขอแก้ไขยอด OT', confirm_code: 'ZP-2026-09', totp });
    expect(again.status).toBe(409);
    expect(archived(ids.a!)).toBe(2);
  }, 60_000); // several direct D1 reads (each one a wrangler process)

  it('a reopened period is recalculated / reverted only by Super Admin with reason + MFA (archive first)', async () => {
    expect((await payroll().post(`/api/payroll/periods/${ids.a}/calculate`)).status).toBe(403);
    expect((await payroll().post(`/api/payroll/periods/${ids.a}/reopen`)).status).toBe(403);
    expect((await admin().post(`/api/payroll/periods/${ids.a}/calculate`, { reason: 'คำนวณใหม่' })).status).toBe(403);
    const v = status(ids.a!).calc_version;
    const { who, totp } = await stepUp();
    const r = await who.post(`/api/payroll/periods/${ids.a}/calculate`, { reason: 'คำนวณใหม่หลังแก้ OT', totp });
    expect(r.status, r.text).toBe(200);
    expect(status(ids.a!)).toMatchObject({ status: 'calculated', reopened_from: 'published', calc_version: v + 1 });
    expect(archived(ids.a!, 'recalculate')).toBe(2);
    expect(JSON.parse(audits(ids.a!, 'payroll.calculated').at(-1)!.details)).toMatchObject({ forced: true, reopenedFrom: 'published', reason: 'คำนวณใหม่หลังแก้ OT', archivedSlips: 2 });
    // approval (normal workflow) closes the reopened state; the Super Admin who recalculated may approve only with an
    // approval note — without one it is refused and the period stays calculated
    expect((await who.post(`/api/payroll/periods/${ids.a}/approve`)).status).toBe(400);
    expect(status(ids.a!).status).toBe('calculated');
    expect((await payroll().post(`/api/payroll/periods/${ids.a}/approve`)).status).toBe(200);
    expect(status(ids.a!)).toMatchObject({ status: 'approved', reopened_from: null });
    // the sign-off of the previous version never covers the recalculated figures
    expect((await payroll().post(`/api/payroll/periods/${ids.a}/publish`)).status).toBe(409);
    seedAccountingSignOff(H, ids.a!);
    expect((await payroll().post(`/api/payroll/periods/${ids.a}/publish`)).status).toBe(200);
    expect((await payroll().post(`/api/payroll/periods/${ids.a}/publish`)).status).toBe(409); // duplicate publish
    // recalculated payslips are new: announced once more; visible again with YTD
    expect(notified()).toBe(2);
    expect((await zp1().get('/api/my/payslips')).body.rows).toHaveLength(1);
  });

  it('re-publishing an unchanged reopened period sends no duplicate notification', async () => {
    const r = await asAdmin((who, totp) => who.post(`/api/payroll/periods/${ids.a}/reopen-closed`, { reason: 'เปิดตรวจซ้ำ ไม่แก้ยอด', confirm_code: 'ZP-2026-09', totp }));
    expect(r.status, r.text).toBe(200);
    // the reopen superseded the ACC sign-off of this (unchanged) version: a fresh review / sign-off is required
    const v = status(ids.a!).calc_version;
    expect(H.sql(`SELECT status FROM payroll_accounting_reviews WHERE period_id = ${ids.a} AND calc_version = ${v}`)).toEqual([{ status: 'superseded' }]);
    expect(H.sql(`SELECT action FROM payroll_accounting_review_events WHERE period_id = ${ids.a} AND calc_version = ${v} ORDER BY id DESC LIMIT 1`)).toEqual([{ action: 'invalidated' }]);
    expect((await payroll().post(`/api/payroll/periods/${ids.a}/approve`)).status).toBe(200);
    expect((await payroll().post(`/api/payroll/periods/${ids.a}/publish`)).status).toBe(409);
    seedAccountingSignOff(H, ids.a!);
    expect((await payroll().post(`/api/payroll/periods/${ids.a}/publish`)).status).toBe(200);
    expect(notified()).toBe(2);
    expect(JSON.parse(audits(ids.a!, 'payroll.published').at(-1)!.details)).toMatchObject({ notified: 0 });
    expect(slipStats(ids.a!)).toMatchObject({ n: 2, pub: 2 });
    const [mine] = (await zp1().get('/api/my/payslips')).body.rows;
    expect((await zp1().get(`/api/payslips/${mine.id}`)).body.ytd).toMatchObject({ includesCurrent: true, employee: { slips: 1 } });
  });
});

describe('edit period information', () => {
  it('closed period: name / code only, payslips and snapshots untouched; calculation fields refused', async () => {
    const before = H.sql(`SELECT id, net, gross, calc_version, calc_json FROM payslips WHERE period_id = ${ids.a} ORDER BY id`);
    const r = await asAdmin((who, totp) => who.put(`/api/payroll/periods/${ids.a}`, { name: 'zz เงินเดือน ก.ย. (แก้ชื่อ)', code: 'ZP-2026-09A', reason: 'แก้ชื่องวดให้ตรงเอกสาร', totp }));
    expect(r.status, r.text).toBe(200);
    expect(status(ids.a!)).toMatchObject({ status: 'published', code: 'ZP-2026-09A' });
    expect(H.sql(`SELECT id, net, gross, calc_version, calc_json FROM payslips WHERE period_id = ${ids.a} ORDER BY id`)).toEqual(before);
    const d = JSON.parse(audits(ids.a!, 'payroll.period_edited')[0]!.details);
    expect(d.changes).toMatchObject({ code: { from: 'ZP-2026-09', to: 'ZP-2026-09A' } });
    const dates = await asAdmin((who, totp) => who.put(`/api/payroll/periods/${ids.a}`, { pay_date: '2026-09-29', reason: 'เลื่อนวันจ่าย', totp }));
    expect(dates.status).toBe(409);
    expect((await hrAdmin().put(`/api/payroll/periods/${ids.a}`, { name: 'x', reason: 'xxxxx' })).status).toBe(403);
  });

  it('empty draft: dates editable with the same overlap rules as creation', async () => {
    const ok = await asAdmin((who, totp) => who.put(`/api/payroll/periods/${ids.d}`, { start_date: '2026-12-27', reason: 'ปรับช่วงวันที่', totp }));
    expect(ok.status, ok.text).toBe(200);
    const overlap = await asAdmin((who, totp) => who.put(`/api/payroll/periods/${ids.d}`, { start_date: '2026-10-01', reason: 'ทดสอบซ้อน', totp }));
    expect(overlap.status).toBe(409);
  });
});

describe('advance dependencies (mid-month ↔ month-end)', () => {
  it('a month-end holding an approved advance round cannot be deleted or re-dated', async () => {
    expect((await payroll().post(`/api/payroll/periods/${ids.mid}/calculate`)).status).toBe(200);
    expect((await admin().post(`/api/payroll/periods/${ids.mid}/approve`)).status).toBe(200);
    const imp = (await admin().get(`/api/payroll/periods/${ids.b}/impact`)).body;
    expect(imp.dependencies).toEqual([expect.objectContaining({ code: 'ZP-2026-10-M', relation: 'mid_month_round', status: 'approved' })]);
    expect((await asAdmin((who, totp) => who.post(`/api/payroll/periods/${ids.b}/delete`, { reason: 'ลองลบ', confirm_code: 'ZP-2026-10', totp }))).status).toBe(409);
    expect((await asAdmin((who, totp) => who.put(`/api/payroll/periods/${ids.b}`, { end_date: '2026-10-20', reason: 'ลองย่อ', totp }))).status).toBe(409);
  });

  it('an advance round already deducted by a calculated month-end cannot be reopened', async () => {
    expect((await payroll().post(`/api/payroll/periods/${ids.b}/calculate`)).status).toBe(200);
    expect((await admin().post(`/api/payroll/periods/${ids.b}/approve`)).status).toBe(200);
    const r = await asAdmin((who, totp) => who.post(`/api/payroll/periods/${ids.mid}/reopen-closed`, { reason: 'ลองเปิดรอบกลางเดือน', confirm_code: 'ZP-2026-10-M', totp }));
    expect(r.status).toBe(409);
    expect(status(ids.mid!).status).toBe('approved');
  });

  it('concurrent duplicate reopen requests: exactly one acts, archive written once', async () => {
    const n = slipStats(ids.b!).n;
    const [s1, s2] = [await stepUp(), await stepUp()];
    const send = (s: { who: Client; totp: string }) => s.who.post(`/api/payroll/periods/${ids.b}/reopen-closed`, { reason: 'เปิดงวดสิ้นเดือน ต.ค.', confirm_code: 'ZP-2026-10', totp: s.totp });
    const rs = await Promise.all([send(s1), send(s2)]);
    expect(rs.map((x) => x.status).sort(), rs.map((x) => x.text).join(' | ')).toEqual([200, 409]);
    expect(archived(ids.b!, 'reopen')).toBe(n);
    expect(audits(ids.b!, 'payroll.period_reopened_closed')).toHaveLength(1);
    expect(status(ids.mid!).status).toBe('approved'); // the paid round is untouched
  });
});

describe('delete (soft, recoverable) and restore', () => {
  it('an eligible empty draft: reason, exact code and MFA; hidden, listed as deleted, code reusable', async () => {
    const url = `/api/payroll/periods/${ids.d}/delete`;
    expect((await asAdmin((who, totp) => who.post(url, { reason: 'สร้างผิด', confirm_code: 'zp-2027-01', totp }))).status).toBe(400);
    expect((await admin().post(url, { reason: 'สร้างผิด', confirm_code: 'ZP-2027-01' })).status).toBe(403);
    const { who, totp } = await stepUp();
    const r = await who.post(url, { reason: 'สร้างงวดผิดช่วง', confirm_code: 'ZP-2027-01', totp });
    expect(r.status, r.text).toBe(200);
    expect(status(ids.d!).deleted_at).toBeTruthy(); // row kept (soft delete)
    expect((await who.post(url, { reason: 'สร้างงวดผิดช่วง', confirm_code: 'ZP-2027-01', totp })).status).toBe(404); // duplicate
    expect((await admin().get('/api/payroll/periods')).body.some((p: { id: number }) => p.id === ids.d)).toBe(false);
    expect((await admin().get('/api/payroll/deleted-periods')).body).toEqual([expect.objectContaining({ id: ids.d, code: 'ZP-2027-01', delete_reason: 'สร้างงวดผิดช่วง' })]);
    expect(JSON.parse(audits(ids.d!, 'payroll.period_deleted')[0]!.details)).toMatchObject({ code: 'ZP-2027-01', reason: 'สร้างงวดผิดช่วง', softDelete: true });
    // the code is free again; restoring while it is taken is refused, then works once it is free
    const again = await payroll().post('/api/payroll/periods', { company_id: ids.co, code: 'ZP-2027-01', name: 'zz again', start_date: '2027-03-26', end_date: '2027-04-25', pay_date: '2027-04-30' });
    expect(again.status).toBe(201);
    expect((await asAdmin((who, totp) => who.post(`/api/payroll/periods/${ids.d}/restore`, { reason: 'กู้คืน', totp }))).status).toBe(409);
    expect((await asAdmin((who, totp) => who.post(`/api/payroll/periods/${again.body.id}/delete`, { reason: 'ซ้ำ ลบออก', confirm_code: 'ZP-2027-01', totp }))).status).toBe(200);
    const back = await asAdmin((who, totp) => who.post(`/api/payroll/periods/${ids.d}/restore`, { reason: 'กู้คืนงวดที่ลบผิด', totp }));
    expect(back.status, back.text).toBe(200);
    expect(status(ids.d!)).toMatchObject({ status: 'draft', code: 'ZP-2027-01', deleted_at: null }); // its state before the delete
    expect((await asAdmin((who, totp) => who.post(`/api/payroll/periods/${ids.d}/restore`, { reason: 'กู้คืนซ้ำ', totp }))).status).toBe(404); // duplicate
    expect(audits(ids.d!, 'payroll.period_restored')).toHaveLength(1);
  });

  it('published payroll evidence can never be deleted, even after reopening back to an empty draft', async () => {
    expect((await asAdmin((who, totp) => who.post(`/api/payroll/periods/${ids.a}/delete`, { reason: 'ลองลบ', confirm_code: 'ZP-2026-09A', totp }))).status).toBe(409);
    expect((await asAdmin((who, totp) => who.post(`/api/payroll/periods/${ids.a}/reopen-closed`, { reason: 'เปิดเพื่อทดสอบการลบ', confirm_code: 'ZP-2026-09A', totp }))).status).toBe(200);
    expect((await asAdmin((who, totp) => who.post(`/api/payroll/periods/${ids.a}/reopen`, { reason: 'กลับเป็นร่าง', totp }))).status).toBe(200);
    expect(slipStats(ids.a!).n).toBe(0);
    const archiveBefore = archived(ids.a!);
    const r = await asAdmin((who, totp) => who.post(`/api/payroll/periods/${ids.a}/delete`, { reason: 'ลองลบหลังเปิด', confirm_code: 'ZP-2026-09A', totp }));
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain('เคยเผยแพร่');
    expect(status(ids.a!).deleted_at).toBeNull();
    expect(archived(ids.a!)).toBe(archiveBefore);
  });

  it('linked attendance protects a period; employees / attendance rows are never deleted', async () => {
    H.sql(`INSERT INTO attendance_imports (company_id, payroll_period_id, version, file_name, file_sha256, format, layout, headers_json, mapping_json, summary_json, status)
           VALUES (${ids.co}, ${ids.d}, 1, 'zz.xlsx', 'zz', 'days', 'summary', '[]', '{}', '{}', 'active')`);
    const counts = () => one('SELECT (SELECT COUNT(*) FROM employees) e, (SELECT COUNT(*) FROM attendance_imports) a, (SELECT COUNT(*) FROM employee_salary_history) s, (SELECT COUNT(*) FROM payroll_periods) p');
    const before = counts();
    const r = await asAdmin((who, totp) => who.post(`/api/payroll/periods/${ids.d}/delete`, { reason: 'ลองลบ', confirm_code: 'ZP-2027-01', totp }));
    expect(r.status).toBe(409);
    expect(r.body.error.message).toContain('เวลาทำงาน');
    H.sql(`UPDATE attendance_imports SET status = 'rolled_back' WHERE payroll_period_id = ${ids.d}`);
    expect((await asAdmin((who, totp) => who.post(`/api/payroll/periods/${ids.d}/delete`, { reason: 'ลบหลัง rollback', confirm_code: 'ZP-2027-01', totp }))).status).toBe(200);
    expect(counts()).toEqual(before); // soft delete: no row of any table removed
    expect(H.sql('PRAGMA foreign_key_check')).toEqual([]);
  });
});

describe('MFA session security', () => {
  it('an existing session gains nothing from a promotion to Super Admin (session revoked; new login must enrol MFA)', async () => {
    const staff = c.staff!;
    expect((await staff.get('/api/auth/me')).status).toBe(200);
    const id = ((await admin().get('/api/admin/users')).body as Array<{ id: number; username: string }>).find((u) => u.username === 'it_staff')!.id;
    expect((await admin().put(`/api/admin/users/${id}`, { roles: ['super_admin'] })).status).toBe(200);
    expect((await staff.get('/api/admin/users')).status).toBe(401);
    expect((await staff.get(`/api/payroll/periods/${ids.b}/impact`)).status).toBe(401);
    const fresh = new Client(H.baseUrl);
    expect((await fresh.post('/api/auth/login', { username: 'it_staff', password: H.passwords.it_staff })).body.status).toBe('mfa_enroll_required');
    expect((await fresh.get('/api/admin/users')).status).toBe(403);
    expect((await fresh.get(`/api/payroll/periods/${ids.b}/impact`)).status).toBe(403);
    expect((await admin().put(`/api/admin/users/${id}`, { roles: ['hr_staff'] })).status).toBe(200);
  });

  it('privilege gained outside the user editor (role made privileged / direct grant) is checked per request', async () => {
    const mgr = c.manager!;
    expect((await mgr.get('/api/auth/me')).status).toBe(200);
    const role = (await admin().get('/api/admin/roles')).body.roles.find((r: { code: string }) => r.code === 'hr_manager');
    expect((await admin().put(`/api/admin/roles/${role.id}`, { permissions: role.permissions, privileged: true })).status).toBe(200);
    expect((await mgr.get('/api/auth/me')).status).toBe(401); // holders signed out
    expect((await admin().put(`/api/admin/roles/${role.id}`, { permissions: role.permissions, privileged: false })).status).toBe(200);
    // a grant written straight to the database (no API): the live session is restricted at once
    const emp = c.employee!;
    expect((await emp.get('/api/meta')).status).toBe(200);
    const uid = Number(one("SELECT id FROM users WHERE username = 'it_employee'").id);
    H.sql(`INSERT INTO user_roles (user_id, role_id) SELECT ${uid}, id FROM roles WHERE code = 'super_admin'`);
    const blocked = await emp.get('/api/admin/users');
    expect([blocked.status, blocked.body.error.code]).toEqual([403, 'mfa_enrollment_required']);
    expect((await emp.post(`/api/payroll/periods/${ids.b}/reopen-closed`, { reason: 'xxxxx', confirm_code: 'ZP-2026-10' })).status).toBe(403);
    H.sql(`DELETE FROM user_roles WHERE user_id = ${uid} AND role_id = (SELECT id FROM roles WHERE code = 'super_admin')`);
  });

  it('every operation is in the audit log; repeated wrong step-up codes are throttled', async () => {
    const actions = (H.sql("SELECT DISTINCT action FROM audit_logs WHERE action LIKE 'payroll.period_%' OR action = 'mfa.step_up_failed'") as Array<{ action: string }>).map((r) => r.action).sort();
    expect(actions).toEqual(['mfa.step_up_failed', 'payroll.period_created', 'payroll.period_deleted', 'payroll.period_edited', 'payroll.period_reopened_closed', 'payroll.period_restored']);
    let last = 0;
    for (let i = 0; i < 6 && last !== 429; i++) {
      last = (await admin().put(`/api/payroll/periods/${ids.b}`, { name: 'x', reason: 'brute force', totp: '000001' })).status;
    }
    expect(last).toBe(429);
  });
});

describe('step-up code = one-time authorisation', () => {
  const rename = (who: Client, id: number, name: string, totp: string) => who.put(`/api/payroll/periods/${id}`, { name, reason: 'ทดสอบรหัสใช้ครั้งเดียว', totp });
  const secondSession = async (n: number) => {
    const other = new Client(H.baseUrl);
    other.totpSecret = admins[n - 1]!.totpSecret;
    await other.login(`it_sa${n}`, SA_PASSWORD);
    expect((await other.get('/api/auth/me')).status).toBe(200);
    return other;
  };
  const stepUps = () => H.sql('SELECT COUNT(*) AS n FROM mfa_step_up')[0] as { n: number };

  it('one code authorises one operation: not twice, not another operation or period, not from another session', async () => {
    const sa = admins[1]!;
    const other = await secondSession(2);
    const { totp } = await stepUp(sa);
    expect((await rename(sa, ids.b!, 'zz ZP-2026-10 (1)', totp)).status).toBe(200);
    const replays = [
      await rename(sa, ids.b!, 'zz ZP-2026-10 (2)', totp), // same operation again
      await rename(sa, ids.mid!, 'zz ZP-2026-10-M (x)', totp), // another period
      await sa.post(`/api/payroll/periods/${ids.b}/calculate`, { reason: 'ใช้รหัสซ้ำ', totp }), // another action (forced recalculation)
      await rename(other, ids.b!, 'zz ZP-2026-10 (3)', totp), // another session of the same user
    ];
    for (const r of replays) expect([r.status, r.body.error?.code]).toEqual([409, 'mfa_code_used']);
    expect(one(`SELECT name FROM payroll_periods WHERE id = ${ids.b}`).name).toBe('zz ZP-2026-10 (1)');
    expect(one(`SELECT name FROM payroll_periods WHERE id = ${ids.mid}`).name).toBe('zz ZP-2026-10-M');
    expect(status(ids.b!).status).toBe('calculated');
  });

  it('a revoked session cannot use a code (and does not use it up)', async () => {
    const sa = admins[2]!;
    const other = await secondSession(3);
    const { totp } = await stepUp(sa);
    const stale = other.cookie;
    expect((await other.post('/api/auth/logout')).status).toBe(200);
    const ghost = new Client(H.baseUrl);
    ghost.cookie = stale;
    const before = stepUps().n;
    expect((await rename(ghost, ids.b!, 'zz revoked', totp)).status).toBe(401);
    expect(stepUps().n).toBe(before);
    expect((await rename(sa, ids.b!, 'zz ZP-2026-10 (4)', totp)).status).toBe(200); // still valid for the live session
  });

  it('concurrent requests with one code: exactly one is authorised', async () => {
    const sa = admins[3]!;
    const other = await secondSession(4);
    const { totp } = await stepUp(sa);
    const rs = await Promise.all([
      rename(sa, ids.b!, 'zz race 1', totp),
      rename(other, ids.mid!, 'zz race 2', totp),
      rename(sa, ids.a!, 'zz race 3', totp),
      other.post(`/api/payroll/periods/${ids.b}/calculate`, { reason: 'race recalculation', totp }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409, 409]);
    expect(rs.filter((r) => r.status === 409).every((r) => r.body.error.code === 'mfa_code_used')).toBe(true);
  });

  it('state-changing requests without the CSRF header or from another origin are refused', async () => {
    const sa = admins[0]!;
    const { totp } = await stepUp(sa);
    const body = { name: 'zz csrf', reason: 'csrf test', totp };
    expect((await sa.req('PUT', `/api/payroll/periods/${ids.b}`, body, { 'x-hr-requested': '0' })).status).toBe(403);
    expect((await sa.req('PUT', `/api/payroll/periods/${ids.b}`, body, { 'x-hr-requested': '1', origin: 'https://evil.example' })).status).toBe(403);
    expect(one(`SELECT name FROM payroll_periods WHERE id = ${ids.b}`).name).not.toBe('zz csrf');
  });
});
