// Probation automation and the employee list — isolated local D1 with synthetic data only (company ZZP, employees ZP*).
// Day 90 notice, reminders without spam, day 120 status change (only status; idempotent; audited), the scheduled
// handler, the company filter / page size of the employee list, and the payroll round decided by the hire date.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays } from '../../src/shared/payroll';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const admin = () => c.admin as Client;

beforeAll(async () => {
  H = await startHarness();
  for (const k of ['admin', 'staff', 'employee', 'payroll']) c[k] = new Client(H.baseUrl);
  await c.admin!.login('it_admin', H.passwords.it_admin);
  await c.staff!.login('it_staff', H.passwords.it_staff);
  await c.employee!.login('it_employee', H.passwords.it_employee);
  await c.payroll!.login('it_payroll', H.passwords.it_payroll);
}, 180_000);
afterAll(async () => {
  await H?.stop();
});

let today = '';
let co = 0;
const ids: Record<string, number> = {};
/** hire date that makes `today` day N (hire date = day 1) */
const hireForDay = (n: number) => addDays(today, -(n - 1));
/** date of day `n` for an employee who is on day `current` today */
const dayOf = (current: number, n: number) => addDays(today, n - current);
type Emp = { status: string; employment_type: string; base_salary: number; hire_date: string; probation_end: string | null; updated_by: number | null };
const emp = (code: string) => H.sql(`SELECT status, employment_type, base_salary, hire_date, probation_end, updated_by FROM employees WHERE id = ${ids[code]}`)[0] as unknown as Emp;
const events = (code: string) => H.sql(`SELECT kind, due_date, notified FROM probation_events WHERE employee_id = ${ids[code]} ORDER BY id`) as Array<{ kind: string; due_date: string; notified: number }>;
const staffUserId = () => Number(H.sql("SELECT id FROM users WHERE username = 'it_staff'")[0]!.id);
const noticesFor = (userId: number, code: string) => H.sql(`SELECT title, body, link FROM notifications WHERE user_id = ${userId} AND title LIKE '%${code} %' ORDER BY id`) as Array<{ title: string; body: string; link: string }>;
const count = (sql: string) => Number(H.sql(sql)[0]!.n);
const run = (dryRun = false) => admin().post('/api/admin/jobs/probation/run', { dryRun });

describe('setup (synthetic company ZZP)', () => {
  it('creates employees for every probation case, relative to the server date', async () => {
    const jobs = await admin().get('/api/admin/jobs/probation');
    expect(jobs.status, jobs.text).toBe(200);
    today = jobs.body.today;
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    co = (await admin().post('/api/m/companies', { code: 'ZZP', name: 'zz_test probation', active: true })).body.id;
    const mk = async (code: string, day: number, x: Record<string, unknown> = {}) => {
      const r = await admin().post('/api/m/employees', { emp_code: code, first_name: 'zz_test', last_name: code, company_id: co, hire_date: hireForDay(day), employment_type: 'probation', status: 'probation', base_salary: 15000, ...x });
      expect(r.status, r.text).toBe(201);
      ids[code] = r.body.id;
    };
    await mk('ZP060', 60); // nothing yet
    await mk('ZP090', 90); // day-90 notice
    await mk('ZP097', 97); // first run after day 90: the notice only (the day-97 reminder is suppressed)
    await mk('ZP104', 104);
    await mk('ZP120', 120); // day 120: status change, employment_type stays "probation"
    await mk('ZP150', 150, { employment_type: 'contract' });
    await mk('ZP120R', 120, { status: 'resigned', termination_date: hireForDay(100) });
    await mk('ZP120T', 120, { status: 'terminated', termination_date: hireForDay(110) });
    await mk('ZP120X', 120, { probation_end: dayOf(120, 150) }); // extended probation
    await mk('ZP090A', 90, { status: 'active' }); // already active: nothing
  });
});

describe('probation job', () => {
  it('only a Super Admin can run or inspect it', async () => {
    expect((await c.staff!.post('/api/admin/jobs/probation/run', { dryRun: true })).status).toBe(403);
    expect((await c.employee!.get('/api/admin/jobs/probation')).status).toBe(403);
  });

  it('dry run lists the actions and writes nothing', async () => {
    const before = [count('SELECT COUNT(*) AS n FROM job_runs'), count('SELECT COUNT(*) AS n FROM probation_events'), count('SELECT COUNT(*) AS n FROM notifications')];
    const r = await run(true);
    expect(r.status, r.text).toBe(200);
    expect(r.body.runId).toBeNull();
    const mine = (code: string) => (r.body.items as Array<{ employeeId: number; kind: string; result: string }>).filter((i) => i.employeeId === ids[code]).map((i) => `${i.kind}:${i.result}`);
    expect(mine('ZP060')).toEqual([]);
    expect(mine('ZP090')).toEqual(['day90_notice:would_do']);
    expect(mine('ZP097')).toEqual(['day90_notice:would_do', 'reminder:suppressed']);
    expect(mine('ZP120')).toEqual(['activate_due:would_do']); // automatic change is off by default
    expect(mine('ZP120X')).toEqual(['extended:would_do']);
    for (const k of ['ZP120R', 'ZP120T', 'ZP090A']) expect(mine(k)).toEqual([]);
    expect([count('SELECT COUNT(*) AS n FROM job_runs'), count('SELECT COUNT(*) AS n FROM probation_events'), count('SELECT COUNT(*) AS n FROM notifications')]).toEqual(before);
  }, 120_000); // several direct D1 reads (each one a wrangler process)

  it('day 90: HR is notified once with code, name, company, dates and a link to the employee', async () => {
    const r = await run();
    expect(r.status, r.text).toBe(200);
    expect(r.body.status).toBe('ok');
    const hr = staffUserId();
    const n = noticesFor(hr, 'ZP090');
    expect(n).toHaveLength(1);
    expect(n[0]!.title).toBe('ครบทดลองงาน 90 วัน: ZP090 zz_test ZP090');
    expect(n[0]!.body).toContain('บริษัท zz_test probation');
    expect(n[0]!.body).toContain('เริ่มงาน');
    expect(n[0]!.body).toContain('ครบทดลองงาน 90 วัน');
    expect(n[0]!.link).toBe(`/employees?open=${ids.ZP090}`);
    // an employee without HR permissions is not a recipient
    const empUser = Number(H.sql("SELECT id FROM users WHERE username = 'it_employee'")[0]!.id);
    expect(noticesFor(empUser, 'ZP090')).toHaveLength(0);
    // the notice keeps the timeline and the payroll-cycle note
    const d = JSON.parse(String(H.sql(`SELECT details FROM probation_events WHERE employee_id = ${ids.ZP090}`)[0]!.details));
    expect(d).toMatchObject({ day: 90, day90: today, day91: addDays(today, 1), payrollCycle: { twoRoundsThrough: today } });
  }, 120_000); // several direct D1 reads (each one a wrangler process)

  it('days 91–119: catch-up sends the notice only; the reminder slot is recorded without a notification', async () => {
    expect(events('ZP097')).toEqual([{ kind: 'day90_notice', due_date: dayOf(97, 90), notified: expect.any(Number) }, { kind: 'reminder', due_date: today, notified: 0 }]);
    expect(noticesFor(staffUserId(), 'ZP097').map((x) => x.title)).toEqual(['ครบทดลองงาน 90 วัน: ZP097 zz_test ZP097']);
    // day 104 is the second reminder day (90 + 2 × 7); a first run records it without a second notification
    expect(events('ZP104').map((e) => `${e.kind}:${e.due_date}`)).toEqual([`day90_notice:${dayOf(104, 90)}`, `reminder:${today}`]);
    expect(events('ZP060')).toEqual([]);
  }, 120_000); // several direct D1 reads (each one a wrangler process)

  it('day 120 with the automatic change off: HR is asked, the status is not changed', () => {
    expect(emp('ZP120').status).toBe('probation');
    expect(events('ZP120').map((e) => e.kind)).toEqual(['activate_due']);
    expect(noticesFor(staffUserId(), 'ZP120')[0]!.title).toBe('ครบ 120 วัน รอเปลี่ยนสถานะ: ZP120 zz_test ZP120');
  });

  it('day 120 with the automatic change on: probation → active, nothing else changes', async () => {
    const before = { ZP120: emp('ZP120'), ZP150: emp('ZP150'), ZP120R: emp('ZP120R'), ZP120T: emp('ZP120T'), ZP120X: emp('ZP120X') };
    const s = await admin().put('/api/admin/settings', { 'probation.auto_activate': true });
    expect(s.status, s.text).toBe(200);
    const r = await run();
    expect(r.status, r.text).toBe(200);
    expect(emp('ZP120')).toEqual({ ...before.ZP120, status: 'active', updated_by: null });
    expect(emp('ZP150')).toEqual({ ...before.ZP150, status: 'active', updated_by: null });
    expect(emp('ZP120').employment_type).toBe('probation'); // employment_type kept exactly
    expect(emp('ZP150').employment_type).toBe('contract');
    expect(emp('ZP120R')).toEqual(before.ZP120R); // resigned untouched
    expect(emp('ZP120T')).toEqual(before.ZP120T); // terminated untouched
    expect(emp('ZP120X')).toEqual(before.ZP120X); // extended probation untouched
    expect(events('ZP120X').map((e) => e.kind)).toEqual(['extended']);
    expect(emp('ZP060').status).toBe('probation');
  }, 120_000); // several direct D1 reads (each one a wrangler process)

  it('audit log: employee, previous / new status, effective date, trigger, system actor, timestamp', () => {
    const rows = H.sql(`SELECT user_id, username, action, entity, entity_id, details, at FROM audit_logs WHERE action = 'employee.status_auto_changed' AND entity_id = '${ids.ZP120}'`);
    expect(rows).toHaveLength(1);
    const a = rows[0]!;
    expect(a).toMatchObject({ user_id: null, username: 'system:probation-job', entity: 'employees', entity_id: String(ids.ZP120) });
    expect(a.at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(JSON.parse(String(a.details))).toMatchObject({ employeeId: ids.ZP120, previousStatus: 'probation', newStatus: 'active', effectiveDate: today, trigger: 'manual', actor: 'system:probation-job', requestedBy: 'it_admin', employmentType: 'probation' });
    expect(count(`SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'job.manual_run'`)).toBe(2);
  });

  it('idempotent: repeated and concurrent runs change nothing more', async () => {
    const snapshot = () => [count('SELECT COUNT(*) AS n FROM probation_events'), count('SELECT COUNT(*) AS n FROM notifications'), count("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'employee.status_auto_changed'")];
    const before = snapshot();
    const again = await run();
    expect(again.body.summary).toMatchObject({ failed: 0 });
    expect(again.body.items.filter((i: { result: string; employeeId: number }) => Object.values(ids).includes(i.employeeId) && i.result === 'done')).toEqual([]);
    const all = await Promise.all([run(), run(), run()]);
    for (const x of all) expect(x.status, x.text).toBe(200);
    expect(snapshot()).toEqual(before);
    // HR changing an activated employee back to probation is respected: the same day-120 event never runs twice
    H.sql(`UPDATE employees SET status = 'probation' WHERE id = ${ids.ZP150}`);
    await run();
    expect(emp('ZP150').status).toBe('probation');
  }, 120_000); // several direct D1 reads (each one a wrangler process)

  it('every run is logged with its date, trigger, status and counts', async () => {
    const r = await admin().get('/api/admin/jobs/probation');
    expect(r.status).toBe(200);
    expect(r.body.runs.length).toBeGreaterThanOrEqual(6);
    expect(r.body.runs[0]).toMatchObject({ run_date: today, trigger: 'manual', status: 'ok', error: null });
    expect(r.body.runs[0].summary).toMatchObject({ failed: 0 });
  });

  it('the scheduled handler runs the same job (trigger "scheduled")', async () => {
    const res = await fetch(`${H.baseUrl}/cdn-cgi/handler/scheduled?cron=${encodeURIComponent('5 17 * * *')}`, { headers: { connection: 'close' } });
    expect(res.status, await res.text()).toBe(200);
    let row: Record<string, unknown> | undefined;
    for (let i = 0; i < 20 && !(row && row.status !== 'running'); i++) {
      await new Promise((r) => setTimeout(r, 300));
      row = H.sql("SELECT run_date, status FROM job_runs WHERE trigger = 'scheduled' ORDER BY id DESC LIMIT 1")[0];
    }
    expect(row).toMatchObject({ run_date: today, status: 'ok' });
  });
});

describe('employee list: company filter and page size', () => {
  it('filters by company on the server, with the right total', async () => {
    const r = await c.staff!.get(`/api/m/employees?f.company_id=${co}&pageSize=25`);
    expect(r.status, r.text).toBe(200);
    expect(r.body.total).toBe(10);
    expect(r.body.rows.every((x: { company_id: number }) => x.company_id === co)).toBe(true);
    expect(r.body.asOf).toBe(today);
    const all = await c.staff!.get('/api/m/employees?pageSize=100');
    expect(all.body.total).toBeGreaterThan(10);
  });

  it('page size 25 / 50 / 100 with search and filter together', async () => {
    const rows = Array.from({ length: 46 }, (_, i) => `('ZQ${String(i).padStart(3, '0')}', 'zz_page', 'p${i}', ${co}, '2025-01-01', 'permanent', 'active')`);
    H.sql(`INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status) VALUES ${rows.join(', ')}`);
    const page = (size: number, p = 1, q = '') => c.staff!.get(`/api/m/employees?f.company_id=${co}&pageSize=${size}&page=${p}${q ? `&q=${q}` : ''}`);
    const p25 = await page(25);
    expect([p25.body.total, p25.body.rows.length, p25.body.pageSize]).toEqual([56, 25, 25]);
    expect((await page(25, 3)).body.rows.length).toBe(6);
    expect((await page(50)).body.rows.length).toBe(50);
    expect((await page(100)).body.rows.length).toBe(56);
    const searched = await page(25, 1, 'zz_page');
    expect([searched.body.total, searched.body.rows.length]).toEqual([46, 25]);
  });

  it('a company outside the user\'s scope is refused (403), not silently widened', async () => {
    const r = await c.employee!.get(`/api/m/employees?f.company_id=${co}`);
    expect(r.status).toBe(403);
    expect((await c.employee!.get(`/api/m/employees/export.csv?f.company_id=${co}`)).status).toBe(403);
    expect((await c.staff!.get('/api/m/employees?f.company_id=999999')).status).toBe(403);
    // own scope without a company filter still lists the user's own record only
    const own = await c.employee!.get('/api/m/employees');
    expect(own.status).toBe(200);
    expect(own.body.total).toBe(1);
  });
});

describe('payroll round follows the hire date, not the status', () => {
  it('mid-month round: an "active" employee within 90 days is paid, a "probation" one past 90 days is not', async () => {
    const mk = async (code: string, hire: string, status: string) => {
      const r = await admin().post('/api/m/employees', { emp_code: code, first_name: 'zz_test', last_name: code, company_id: co, hire_date: hire, employment_type: 'probation', status, base_salary: 30000, probation_end: '2099-12-31' });
      expect(r.status, r.text).toBe(201);
      ids[code] = r.body.id;
    };
    await mk('ZPPAY1', '2026-10-01', 'active'); // day 90 = 2026-12-29: inside the round although "active"
    await mk('ZPPAY2', '2026-07-01', 'probation'); // day 90 = 2026-09-28: outside the round although "probation"
    const p = await c.payroll!.post('/api/payroll/periods', { company_id: co, code: 'ZP-2026-11-M', name: 'zz mid-month', kind: 'mid_month', start_date: '2026-10-26', end_date: '2026-11-10', pay_date: '2026-11-15' });
    expect(p.status, p.text).toBe(201);
    const calc = await c.payroll!.post(`/api/payroll/periods/${p.body.id}/calculate`);
    expect(calc.status, calc.text).toBe(200);
    const paid = H.sql(`SELECT employee_id, net, sso FROM payslips WHERE period_id = ${p.body.id}`) as Array<{ employee_id: number; net: number; sso: number }>;
    expect(paid.find((x) => x.employee_id === ids.ZPPAY1)).toMatchObject({ net: 16000, sso: 0 });
    expect(paid.find((x) => x.employee_id === ids.ZPPAY2)).toBeUndefined();
    // the employment type is never changed by payroll either
    expect(emp('ZPPAY1').employment_type).toBe('probation');
  });
});
