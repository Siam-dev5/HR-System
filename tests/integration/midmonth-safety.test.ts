// Mid-month advance safety — isolated local D1 with synthetic data only (company ZZM, employees ZM*).
// Eligibility, advance amount, month-end deduction exactly once, duplicate requests, period locking,
// recalculation / reopen (rollback) with archive, and what happens when an advance cannot be recovered.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const admin = () => c.admin as Client;
const payroll = () => c.payroll as Client;

beforeAll(async () => {
  H = await startHarness();
  for (const k of ['admin', 'payroll']) c[k] = new Client(H.baseUrl);
  await c.admin!.login('it_admin', H.passwords.it_admin);
  await c.payroll!.login('it_payroll', H.passwords.it_payroll);
});
afterAll(async () => {
  await H?.stop();
});

const ids: Record<string, number> = {};
let co = 0;
let mid = 0;
let monthEnd = 0;
type Slip = { employee_id: number; net: number; gross: number; sso: number; tax: number; deductions: number; advance: number };
const slips = (p: number) => H.sql(`SELECT employee_id, net, gross, sso, tax, deductions, advance FROM payslips WHERE period_id = ${p} ORDER BY employee_id`) as unknown as Slip[];
const by = (p: number) => new Map(slips(p).map((s) => [s.employee_id, s]));
const status = (p: number) => H.sql(`SELECT status, calc_version FROM payroll_periods WHERE id = ${p}`)[0] as { status: string; calc_version: number };
const archived = (p: number, reason: string) => Number(H.sql(`SELECT COUNT(*) AS n FROM payslip_archive WHERE period_id = ${p} AND reason = '${reason}'`)[0]!.n);
const r2 = (n: number) => Math.round(n * 100) / 100;

describe('setup (synthetic company ZZM)', () => {
  it('creates employees covering every eligibility case', async () => {
    co = (await admin().post('/api/m/companies', { code: 'ZZM', name: 'zz_test mid-month', active: true })).body.id;
    const emp = async (code: string, hire: string, x: Record<string, unknown> = {}) => {
      const r = await admin().post('/api/m/employees', { emp_code: code, first_name: 'zz_test', last_name: code, company_id: co, hire_date: hire, employment_type: 'probation', status: 'probation', base_salary: 30000, ...x });
      expect(r.status, r.text).toBe(201);
      ids[code] = r.body.id;
    };
    await emp('ZM1', '2026-09-01'); // probation all month (day 90 = 11-29): 16 days in 26/10–10/11
    await emp('ZM2', '2026-08-05'); // day 90 = 11-02: 8 days
    await emp('ZM3', '2020-01-01', { employment_type: 'permanent', status: 'active' }); // passed long ago: not eligible
    await emp('ZM4', '2026-11-05'); // joins inside the round: 6 days
    await emp('ZM5', '2026-11-12'); // joins after the round: not eligible
    await emp('ZM6', '2026-10-01'); // later marked resigned WITHOUT a termination date
    await emp('ZM7', '2026-10-01'); // later terminated on 11-05 (month-end pays only 11 days)
  });

  it('periods: duplicate / overlapping / invalid definitions are refused', async () => {
    const mk = (b: Record<string, unknown>) => payroll().post('/api/payroll/periods', { company_id: co, ...b });
    const m = await mk({ code: 'ZM-2026-11', name: 'zz month-end', kind: 'monthly', start_date: '2026-10-26', end_date: '2026-11-25', pay_date: '2026-11-30' });
    expect(m.status, m.text).toBe(201);
    monthEnd = m.body.id;
    const r = await mk({ code: 'ZM-2026-11-M', name: 'zz mid-month', kind: 'mid_month', start_date: '2026-10-26', end_date: '2026-11-10', pay_date: '2026-11-15' });
    expect(r.status, r.text).toBe(201);
    mid = r.body.id;
    expect((await mk({ code: 'ZM-2026-11-M', name: 'dup', kind: 'mid_month', start_date: '2026-12-26', end_date: '2027-01-10', pay_date: '2027-01-15' })).status).toBe(409); // same code
    expect((await mk({ code: 'ZM-X1', name: 'overlap', kind: 'mid_month', start_date: '2026-11-01', end_date: '2026-11-10', pay_date: '2026-11-15' })).status).toBe(409);
    expect((await payroll().post('/api/payroll/periods', { code: 'ZM-X2', name: 'all companies', kind: 'mid_month', start_date: '2026-10-26', end_date: '2026-11-10', pay_date: '2026-11-15' })).status).toBe(409); // all-company scope overlaps too
    expect((await mk({ code: 'ZM-X3', name: 'late pay', kind: 'mid_month', start_date: '2026-11-26', end_date: '2026-12-10', pay_date: '2026-12-16' })).status).toBe(400); // pay after the 15th
    const both = await Promise.all([1, 2].map((i) => mk({ code: `ZM-R${i}`, name: 'race', kind: 'mid_month', start_date: '2027-01-26', end_date: '2027-02-10', pay_date: '2027-02-15' })));
    expect(both.map((x) => x.status).sort()).toEqual([201, 409]); // concurrent creation: only one survives
    H.sql(`DELETE FROM payroll_periods WHERE code IN ('ZM-R1','ZM-R2')`);
  });
});

describe('mid-month round', () => {
  it('preview of the draft round is read-only', async () => {
    expect((await payroll().get(`/api/payroll/periods/${mid}/preview`)).status).toBe(200);
    expect(slips(mid)).toHaveLength(0);
    expect(status(mid).status).toBe('draft');
  });

  it('eligible employees and advance amounts (base ÷ 30 × probation days in the round, no statutory deductions)', async () => {
    const r = await payroll().post(`/api/payroll/periods/${mid}/calculate`);
    expect(r.status, r.text).toBe(200);
    const s = by(mid);
    expect([...s.keys()].sort()).toEqual([ids.ZM1, ids.ZM2, ids.ZM4, ids.ZM6, ids.ZM7].sort());
    expect(s.get(ids.ZM1!)!.net).toBe(16000);
    expect(s.get(ids.ZM2!)!.net).toBe(8000);
    expect(s.get(ids.ZM4!)!.net).toBe(6000);
    for (const x of s.values()) expect([x.sso, x.tax, x.gross - x.net]).toEqual([0, 0, 0]);
  });

  it('duplicate calculate requests (concurrent) never duplicate payslips', async () => {
    const rs = await Promise.all([1, 2, 3].map(() => payroll().post(`/api/payroll/periods/${mid}/calculate`)));
    expect(rs.every((x) => x.status === 200 || x.status === 409)).toBe(true);
    expect(slips(mid)).toHaveLength(5);
    expect(H.sql(`SELECT COUNT(DISTINCT employee_id) AS n FROM payslips WHERE period_id = ${mid}`)[0]!.n).toBe(5);
    expect(r2(slips(mid).reduce((a, x) => a + x.net, 0))).toBe(62000);
  });

  it('month-end is blocked while the round is calculated but not approved', async () => {
    expect((await payroll().post(`/api/payroll/periods/${monthEnd}/calculate`)).status).toBe(409);
    expect(slips(monthEnd)).toHaveLength(0);
    expect(status(monthEnd).status).toBe('draft');
  });

  it('rollback: reopen archives the round, recalculation restores identical amounts', async () => {
    const before = JSON.stringify(slips(mid).map((s) => [s.employee_id, s.net]));
    const v = status(mid).calc_version;
    const r = await payroll().post(`/api/payroll/periods/${mid}/reopen`);
    expect(r.status, r.text).toBe(200);
    expect(status(mid).status).toBe('draft');
    expect(slips(mid)).toHaveLength(0);
    expect(archived(mid, 'reopen')).toBe(5);
    expect((await payroll().post(`/api/payroll/periods/${mid}/calculate`)).status).toBe(200);
    expect(status(mid).calc_version).toBe(v + 1);
    expect(JSON.stringify(slips(mid).map((s) => [s.employee_id, s.net]))).toBe(before);
  });

  it('approval: once only; then the round is frozen', async () => {
    expect((await admin().post(`/api/payroll/periods/${mid}/approve`)).status).toBe(200);
    expect((await admin().post(`/api/payroll/periods/${mid}/approve`)).status).toBe(409);
    expect((await payroll().post(`/api/payroll/periods/${mid}/calculate`)).status).toBe(409);
    expect((await payroll().post(`/api/payroll/periods/${mid}/reopen`)).status).toBe(409);
  });
});

describe('month-end deduction', () => {
  it('cases that make an advance unrecoverable are set up after the round was approved', async () => {
    expect((await admin().put(`/api/m/employees/${ids.ZM6}`, { status: 'resigned' })).status).toBe(200);
    expect((await admin().put(`/api/m/employees/${ids.ZM7}`, { status: 'resigned', termination_date: '2026-11-05' })).status).toBe(200);
  });

  it('deducts each approved advance exactly once', async () => {
    const r = await payroll().post(`/api/payroll/periods/${monthEnd}/calculate`);
    expect(r.status, r.text).toBe(200);
    const m = by(monthEnd);
    const a = by(mid);
    expect(m.get(ids.ZM1!)!.advance).toBe(16000);
    expect(m.get(ids.ZM2!)!.advance).toBe(8000);
    expect(m.get(ids.ZM4!)!.advance).toBe(6000);
    expect(m.get(ids.ZM3!)!.advance).toBe(0);
    for (const [emp, s] of m) {
      expect(s.advance).toBe(a.get(emp)?.net ?? 0);
      expect(s.net).toBe(r2(s.gross - s.deductions));
    }
  });

  it('recalculating month-end (repeated and concurrent) never deducts twice', async () => {
    expect((await payroll().post(`/api/payroll/periods/${monthEnd}/calculate`)).status).toBe(200);
    await Promise.all([1, 2].map(() => payroll().post(`/api/payroll/periods/${monthEnd}/calculate`)));
    const m = slips(monthEnd);
    expect(new Set(m.map((s) => s.employee_id)).size).toBe(m.length);
    const adv = new Map(m.map((s) => [s.employee_id, s.advance]));
    expect([adv.get(ids.ZM1!), adv.get(ids.ZM2!), adv.get(ids.ZM4!)]).toEqual([16000, 8000, 6000]);
  });

  it('locking: no mid-month round can be calculated under a calculated month-end', async () => {
    const late = await payroll().post('/api/payroll/periods', { company_id: co, code: 'ZM-X4', name: 'late round', kind: 'mid_month', start_date: '2026-11-11', end_date: '2026-11-12', pay_date: '2026-11-15' });
    expect(late.status).toBe(201); // the definition may exist, but it can never be calculated / paid
    expect((await payroll().post(`/api/payroll/periods/${late.body.id}/calculate`)).status).toBe(409);
    expect((await payroll().post(`/api/payroll/periods/${mid}/calculate`)).status).toBe(409);
    expect(slips(late.body.id)).toHaveLength(0);
    H.sql(`DELETE FROM payroll_periods WHERE id = ${late.body.id}`);
  });

  it('rollback of month-end: reopen archives, recalculation gives the same single deduction', async () => {
    const before = JSON.stringify(slips(monthEnd).map((s) => [s.employee_id, s.net, s.advance]));
    expect((await payroll().post(`/api/payroll/periods/${monthEnd}/reopen`)).status).toBe(200);
    expect(slips(monthEnd)).toHaveLength(0);
    expect(archived(monthEnd, 'reopen')).toBeGreaterThan(0);
    expect(status(mid).status).toBe('approved'); // the paid round is untouched by the month-end rollback
    expect((await payroll().post(`/api/payroll/periods/${monthEnd}/calculate`)).status).toBe(200);
    expect(JSON.stringify(slips(monthEnd).map((s) => [s.employee_id, s.net, s.advance]))).toBe(before);
  });

  it('FINDING — advances that month-end cannot recover are reported here (current behaviour, not changed)', async () => {
    const m = by(monthEnd);
    const a = by(mid);
    const zm6 = m.get(ids.ZM6!);
    const zm7 = m.get(ids.ZM7!);
    console.warn('FINDING ZM6 (resigned, no termination date): month-end slip', zm6 ? `advance ${zm6.advance}` : 'ABSENT', '| advance paid', a.get(ids.ZM6!)?.net);
    console.warn('FINDING ZM7 (terminated 11-05): month-end gross', zm7?.gross, 'advance', zm7?.advance, 'net', zm7?.net);
    const paid = r2(slips(mid).reduce((x, s) => x + s.net, 0));
    const deducted = r2(slips(monthEnd).reduce((x, s) => x + s.advance, 0));
    console.warn('FINDING advance paid', paid, 'advance deducted at month-end', deducted, 'not recovered', r2(paid - deducted));
    // current behaviour, recorded so a policy change is noticed: no slip for ZM6, negative net for ZM7
    expect(zm6).toBeUndefined();
    expect(zm7!.net).toBeLessThan(0);
    expect(r2(paid - deducted)).toBe(a.get(ids.ZM6!)!.net);
  });
});
