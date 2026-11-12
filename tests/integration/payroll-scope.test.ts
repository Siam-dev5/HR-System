// Payroll company scope (Phase B0) — isolated local D1 with synthetic data only (companies ZSA / ZSB, employees
// ZSA1–ZSA3, ZSB1–ZSB2). The company scope of a user is the system's existing rule (lib/companies): a role holding
// employees.all sees every company, any other user only the company of their linked employee. Built-in payroll roles
// all hold employees.all, so the company-limited payroll users here use custom roles, as a Super Admin can create in
// User & Role management. Covers: period list / totals, payslip list and payslip by id, CSV / preview export,
// calculate / reopen / approve / publish / create, request tampering (?company, ids), refusals that change nothing,
// organisation-wide roles unchanged, and a calculation by a scoped user equal to the engine's own figures.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startHarness, type Harness } from './harness';

let H: Harness;
const c: Record<string, Client> = {};
const ids = {} as Record<'A' | 'B' | 'PA1' | 'PB1' | 'PALL' | 'PA3' | 'PB3' | 'slipA' | 'slipB', number>;
const Y = new Date().getUTCFullYear() + 2;
const WRANGLER = join('node_modules', 'wrangler', 'bin', 'wrangler.js');
const one = (sql: string) => H.sql(sql)[0] as Record<string, any>;

function provision(username: string, role: string, password: string, employee?: string): void {
  const out = join(H.dir, `${username}.sql`);
  const args = ['scripts/create-user.mjs', '--username', username, '--display', username, '--role', role, '--out', out, '--cred-file', join(H.dir, 'scope-credentials.txt')];
  if (employee) args.push('--employee', employee);
  execFileSync(process.execPath, args, { env: { ...process.env, NEW_USER_PASSWORD: password }, stdio: 'ignore' });
  execFileSync(process.execPath, [WRANGLER, 'd1', 'execute', 'hr-system-db', '--local', '--persist-to', join(H.dir, 'state'), '--file', out], { env: { ...process.env, CI: '1' }, stdio: 'ignore' });
}

async function login(username: string, password: string): Promise<Client> {
  const x = new Client(H.baseUrl);
  const r = await x.login(username, password);
  if (r.status !== 200) throw new Error(`login ${username}: ${r.text}`);
  return x;
}

/** Everything a payroll write could touch for one period: payslips, the period row, the archive, the attendance lock. */
function state(periodId: number): string {
  return JSON.stringify(H.sqlEach(
    `SELECT id, employee_id, net, calc_version, published FROM payslips WHERE period_id = ${periodId} ORDER BY id;
     SELECT status, calc_version, calculated_by, approved_by, published_at, updated_at, company_id FROM payroll_periods WHERE id = ${periodId};
     SELECT COUNT(*) AS n FROM payslip_archive WHERE period_id = ${periodId};`,
  ));
}

async function createPeriod(code: string, month: string, companyId: number | null): Promise<number> {
  const last = new Date(Date.UTC(Y, Number(month), 0)).getUTCDate();
  const r = await c.admin!.post('/api/payroll/periods', { code, name: code, kind: 'monthly', company_id: companyId, start_date: `${Y}-${month}-01`, end_date: `${Y}-${month}-${last}`, pay_date: `${Y}-${month}-${last}` });
  if (r.status !== 201) throw new Error(`create ${code}: ${r.text}`);
  return r.body.id as number;
}

beforeAll(async () => {
  H = await startHarness();
  H.sql(`INSERT INTO companies (code, name, active) VALUES ('ZSA', 'ZZ Scope A', 1), ('ZSB', 'ZZ Scope B', 1);`);
  ids.A = Number(one("SELECT id FROM companies WHERE code = 'ZSA'").id);
  ids.B = Number(one("SELECT id FROM companies WHERE code = 'ZSB'").id);
  const emp = (code: string, company: number, salary: number) =>
    `('${code}', 'Zz', '${code}', ${company}, '${Y - 1}-01-01', 'permanent', 'active', ${salary}, 'ZZ Bank', '000-${code}')`;
  H.sql(`INSERT INTO employees (emp_code, first_name, last_name, company_id, hire_date, employment_type, status, base_salary, bank_name, bank_account) VALUES
    ${emp('ZSA1', ids.A, 20000)}, ${emp('ZSA2', ids.A, 25000)}, ${emp('ZSA3', ids.A, 22000)}, ${emp('ZSB1', ids.B, 30000)}, ${emp('ZSB2', ids.B, 18000)};`);
  // ZSB2 is the same person as ZSA1 after a transfer (YTD across companies)
  H.sql("UPDATE employees SET person_id = (SELECT id FROM employees WHERE emp_code = 'ZSA1') WHERE emp_code = 'ZSB2';");

  // company-limited payroll roles (no employees.all): a payroll officer of one company and a read-only viewer
  H.sql(`INSERT INTO roles (code, name, description, privileged, system) VALUES
    ('zz_payroll_company', 'ZZ Payroll (company)', 'test', 0, 0), ('zz_payroll_viewer', 'ZZ Payroll viewer (company)', 'test', 0, 0);
    INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.value FROM roles r, json_each('["payroll.view","payroll.calculate","payroll.approve","payroll.publish","payroll.export","payroll_preview.view","payroll_preview.export","payslip_ytd.view","payslip.own"]') p WHERE r.code = 'zz_payroll_company';
    INSERT INTO role_permissions (role_id, permission) SELECT r.id, p.value FROM roles r, json_each('["payroll.view","payroll_preview.view","payslip_ytd.view"]') p WHERE r.code = 'zz_payroll_viewer';`);

  const pw = (n: string) => `Zz-${n}-Scope-9a`;
  provision('zz_pay_a', 'zz_payroll_company', pw('a'), 'ZSA2');
  provision('zz_view_a', 'zz_payroll_viewer', pw('v'), 'ZSA3');
  provision('zz_pay_nolink', 'zz_payroll_company', pw('n'));
  c.admin = await login('it_admin', H.passwords.it_admin);
  c.officer = await login('it_payroll', H.passwords.it_payroll);
  c.staff = await login('it_staff', H.passwords.it_staff);
  c.employee = await login('it_employee', H.passwords.it_employee);
  c.payA = await login('zz_pay_a', pw('a'));
  c.viewA = await login('zz_view_a', pw('v'));
  c.noLink = await login('zz_pay_nolink', pw('n'));

  // month 1: closed periods of A and B (calculated by the Super Admin, approved by the payroll officer, published)
  // B first: YTD of a slip counts same-day slips of earlier period ids, so ZSB2's slip counts in ZSA1's YTD
  ids.PB1 = await createPeriod('ZS-B1', '01', ids.B);
  ids.PA1 = await createPeriod('ZS-A1', '01', ids.A);
  for (const p of [ids.PA1, ids.PB1]) {
    expect((await c.admin.post(`/api/payroll/periods/${p}/calculate`)).status).toBe(200);
    expect((await c.officer.post(`/api/payroll/periods/${p}/approve`)).status).toBe(200);
    expect((await c.admin.post(`/api/payroll/periods/${p}/publish`)).status).toBe(200);
  }
  // month 2: one all-company period, calculated
  ids.PALL = await createPeriod('ZS-ALL2', '02', null);
  expect((await c.admin.post(`/api/payroll/periods/${ids.PALL}/calculate`)).status).toBe(200);
  // month 3: drafts of A and B
  ids.PA3 = await createPeriod('ZS-A3', '03', ids.A);
  ids.PB3 = await createPeriod('ZS-B3', '03', ids.B);
  ids.slipA = Number(one(`SELECT s.id FROM payslips s JOIN employees e ON e.id = s.employee_id WHERE s.period_id = ${ids.PA1} AND e.emp_code = 'ZSA1'`).id);
  ids.slipB = Number(one(`SELECT s.id FROM payslips s JOIN employees e ON e.id = s.employee_id WHERE s.period_id = ${ids.PB1} AND e.emp_code = 'ZSB1'`).id);
}, 300_000);
afterAll(async () => {
  await H?.stop();
});

const codes = (rows: Array<{ code: string }>) => rows.map((r) => r.code);

describe('payroll periods follow the company scope', () => {
  it('a company-limited payroll user sees its own and all-company periods, never another company\'s', async () => {
    const r = await c.payA!.get('/api/payroll/periods');
    expect(r.status).toBe(200);
    expect(codes(r.body)).toEqual(expect.arrayContaining(['ZS-A1', 'ZS-A3', 'ZS-ALL2']));
    expect(codes(r.body)).not.toContain('ZS-B1');
    expect(codes(r.body)).not.toContain('ZS-B3');
  });

  it('totals of an all-company period only count the slips of companies in scope', async () => {
    const mine = (await c.payA!.get('/api/payroll/periods')).body.find((p: { code: string }) => p.code === 'ZS-ALL2');
    const expected = one(`SELECT COUNT(*) AS n, ROUND(SUM(net), 2) AS net FROM payslips WHERE period_id = ${ids.PALL} AND company_id = ${ids.A}`);
    expect(mine.employees).toBe(3);
    expect(mine.employees).toBe(Number(expected.n));
    expect(Math.round(mine.total_net * 100) / 100).toBe(Number(expected.net));
    const all = (await c.admin!.get('/api/payroll/periods')).body.find((p: { code: string }) => p.code === 'ZS-ALL2');
    expect(all.employees).toBe(Number(one(`SELECT COUNT(*) AS n FROM payslips WHERE period_id = ${ids.PALL}`).n));
    expect(all.employees).toBeGreaterThan(mine.employees);
  });

  it('a period of another company answers 404 (preview, payslip list, export, impact-free reads)', async () => {
    for (const path of [`/api/payroll/periods/${ids.PB1}/preview`, `/api/payroll/payslips?period_id=${ids.PB1}`, `/api/payroll/periods/${ids.PB1}/export.csv`, `/api/payroll/periods/${ids.PB1}/preview.csv`]) {
      const r = await c.payA!.get(path);
      expect(r.status, path).toBe(404);
      expect(r.text).not.toContain('ZSB1');
    }
  });

  it('a user with payroll permissions but no company is refused (403)', async () => {
    expect((await c.noLink!.get('/api/payroll/periods')).status).toBe(403);
    expect((await c.noLink!.get('/api/payroll/payslips')).status).toBe(403);
    expect((await c.noLink!.get(`/api/payroll/periods/${ids.PA1}/export.csv`)).status).toBe(403);
    const before = state(ids.PA3);
    expect((await c.noLink!.post(`/api/payroll/periods/${ids.PA3}/calculate`)).status).toBe(403);
    expect(state(ids.PA3)).toBe(before);
  });
});

describe('payslips follow the company scope', () => {
  it('the payslip list never contains another company\'s slips', async () => {
    const r = await c.payA!.get('/api/payroll/payslips');
    expect(r.status).toBe(200);
    const names: string[] = r.body.map((s: { employee: string }) => s.employee);
    expect(names.some((n) => n.startsWith('ZSA1'))).toBe(true);
    expect(names.some((n) => n.startsWith('ZSB'))).toBe(false);
    // every listed slip is a company A slip
    const listed = r.body.map((s: { id: number }) => s.id).join(',');
    expect(one(`SELECT COUNT(*) AS n FROM payslips WHERE id IN (${listed}) AND company_id <> ${ids.A}`).n).toBe(0);
  });

  it('a guessed payslip id of another company answers 404; an own-company one opens', async () => {
    const b = await c.payA!.get(`/api/payslips/${ids.slipB}`);
    expect(b.status).toBe(404);
    expect(b.text).not.toContain('ZSB1');
    const a = await c.payA!.get(`/api/payslips/${ids.slipA}`);
    expect(a.status).toBe(200);
    expect(a.body.employee).toContain('ZSA1');
    expect(a.body.ewf_employer).toBeDefined();
  });

  it('YTD shown to a company-limited user leaves out pay of the same person at another company', async () => {
    const a = await c.payA!.get(`/api/payslips/${ids.slipA}`);
    expect(a.body.ytd.byCompany.map((x: { company_id: number }) => x.company_id)).toEqual([ids.A]);
    expect(a.body.ytd.employee.companies).toBe(1);
    const all = await c.admin!.get(`/api/payslips/${ids.slipA}`);
    expect(all.body.ytd.byCompany.map((x: { company_id: number }) => x.company_id).sort()).toEqual([ids.A, ids.B].sort());
    expect(all.body.ytd.employee.gross).toBeGreaterThan(a.body.ytd.employee.gross);
  });

  it('an employee still opens only their own published payslip', async () => {
    expect((await c.employee!.get(`/api/payslips/${ids.slipA}`)).status).toBe(404);
    expect((await c.employee!.get('/api/payroll/periods')).status).toBe(403);
  });
});

describe('export follows the same scope as the report', () => {
  it('CSV of an all-company period only carries companies in scope', async () => {
    const r = await c.payA!.get(`/api/payroll/periods/${ids.PALL}/export.csv`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('ZSA1');
    expect(r.text).toContain('ZSA2');
    expect(r.text).not.toContain('ZSB');
    // the file holds exactly the company A slips (header + one line per slip)
    const lines = r.text.trim().split(/\r?\n/).length;
    expect(lines - 1).toBe(Number(one(`SELECT COUNT(*) AS n FROM payslips WHERE period_id = ${ids.PALL} AND company_id = ${ids.A}`).n));
  });

  it('?company of another company is refused (403); ?company inside the scope narrows', async () => {
    expect((await c.payA!.get(`/api/payroll/periods/${ids.PALL}/export.csv?company=${ids.B}`)).status).toBe(403);
    expect((await c.payA!.get(`/api/payroll/periods/${ids.PALL}/preview?company=${ids.B}`)).status).toBe(403);
    const own = await c.payA!.get(`/api/payroll/periods/${ids.PALL}/export.csv?company=${ids.A}`);
    expect(own.status).toBe(200);
    expect(own.text).not.toContain('ZSB');
  });

  it('organisation-wide roles keep exporting every company', async () => {
    for (const who of [c.admin!, c.officer!]) {
      const r = await who.get(`/api/payroll/periods/${ids.PALL}/export.csv`);
      expect(r.status).toBe(200);
      expect(r.text).toContain('ZSA1');
      expect(r.text).toContain('ZSB1');
    }
  });

  it('the audit entry of an export records the company scope used', async () => {
    const row = one(`SELECT details FROM audit_logs WHERE action = 'payroll.exported' AND entity_id = '${ids.PALL}' AND username = 'zz_pay_a' ORDER BY id DESC LIMIT 1`);
    expect(JSON.parse(String(row.details)).scope).toEqual([ids.A]);
  });
});

describe('changes to a period need the whole period in scope; refusals change nothing', () => {
  it('calculate of another company\'s period: 404, nothing deleted or written', async () => {
    const before = state(ids.PB3);
    const r = await c.payA!.post(`/api/payroll/periods/${ids.PB3}/calculate`);
    expect(r.status).toBe(404);
    expect(state(ids.PB3)).toBe(before);
  });

  it('calculate of an all-company period by a company-limited user: 403, nothing deleted or written', async () => {
    const before = state(ids.PALL);
    const r = await c.payA!.post(`/api/payroll/periods/${ids.PALL}/calculate`);
    expect(r.status).toBe(403);
    expect(state(ids.PALL)).toBe(before);
  });

  it('reopen / approve / publish of other companies\' periods are refused without changes', async () => {
    const b1 = state(ids.PB1);
    const all = state(ids.PALL);
    for (const action of ['reopen', 'approve', 'publish']) {
      expect((await c.payA!.post(`/api/payroll/periods/${ids.PB1}/${action}`)).status, action).toBe(404);
      expect((await c.payA!.post(`/api/payroll/periods/${ids.PALL}/${action}`)).status, action).toBe(403);
    }
    expect(state(ids.PB1)).toBe(b1);
    expect(state(ids.PALL)).toBe(all);
  });

  it('creating a period for another company or for every company is refused; no period is created', async () => {
    const count = () => Number(one('SELECT COUNT(*) AS n FROM payroll_periods').n);
    const n = count();
    const base = { kind: 'monthly', start_date: `${Y}-05-01`, end_date: `${Y}-05-31`, pay_date: `${Y}-05-31` };
    expect((await c.payA!.post('/api/payroll/periods', { ...base, code: 'ZS-X1', name: 'x', company_id: ids.B })).status).toBe(403);
    expect((await c.payA!.post('/api/payroll/periods', { ...base, code: 'ZS-X2', name: 'x', company_id: null })).status).toBe(403);
    expect(count()).toBe(n);
  });

  it('a company-limited payroll user calculates its own period exactly as the engine computes it', async () => {
    // live preview (the engine, read-only) before the calculation
    const live = await c.admin!.get(`/api/payroll/periods/${ids.PA3}/preview`);
    expect(live.status).toBe(200);
    expect(live.body.source).toBe('live');
    const r = await c.payA!.post(`/api/payroll/periods/${ids.PA3}/calculate`);
    expect(r.status).toBe(200);
    const slips = H.sql(`SELECT e.emp_code, s.net, s.gross, s.sso, s.tax FROM payslips s JOIN employees e ON e.id = s.employee_id WHERE s.period_id = ${ids.PA3} ORDER BY e.emp_code`);
    expect(slips.map((s) => s.emp_code)).toEqual(['ZSA1', 'ZSA2', 'ZSA3']);
    const byCode = new Map(live.body.rows.map((x: Record<string, unknown>) => [x.emp_code, x]));
    for (const s of slips) {
      const row = byCode.get(s.emp_code) as Record<string, number>;
      expect(s.net).toBe(row.net_pay);
      expect(s.gross).toBe(row.total_income);
      expect(s.sso).toBe(row.sso);
      expect(s.tax).toBe(row.tax);
    }
  });
});

describe('permissions', () => {
  it('HR Staff (no payroll permission) gets 403 on every payroll API', async () => {
    for (const path of ['/api/payroll/periods', '/api/payroll/payslips', `/api/payroll/periods/${ids.PA1}/preview`, `/api/payroll/periods/${ids.PA1}/export.csv`]) {
      expect((await c.staff!.get(path)).status, path).toBe(403);
    }
    expect((await c.staff!.get(`/api/payslips/${ids.slipA}`)).status).toBe(404);
    const before = state(ids.PB3);
    expect((await c.staff!.post(`/api/payroll/periods/${ids.PB3}/calculate`)).status).toBe(403);
    expect(state(ids.PB3)).toBe(before);
  });

  it('a company-limited read-only role reads its company but cannot calculate or export', async () => {
    const r = await c.viewA!.get('/api/payroll/periods');
    expect(r.status).toBe(200);
    expect(codes(r.body)).not.toContain('ZS-B1');
    expect((await c.viewA!.get(`/api/payroll/periods/${ids.PA1}/preview`)).status).toBe(200);
    expect((await c.viewA!.get(`/api/payroll/periods/${ids.PB1}/preview`)).status).toBe(404);
    expect((await c.viewA!.get(`/api/payroll/periods/${ids.PA1}/export.csv`)).status).toBe(403);
    const before = state(ids.PB3);
    expect((await c.viewA!.post(`/api/payroll/periods/${ids.PB3}/calculate`)).status).toBe(403);
    expect(state(ids.PB3)).toBe(before);
  });

  it('Super Admin and the payroll officer keep organisation-wide access', async () => {
    for (const who of [c.admin!, c.officer!]) {
      const r = await who.get('/api/payroll/periods');
      expect(r.status).toBe(200);
      expect(codes(r.body)).toEqual(expect.arrayContaining(['ZS-A1', 'ZS-B1', 'ZS-ALL2', 'ZS-A3', 'ZS-B3']));
      expect((await who.get(`/api/payslips/${ids.slipB}`)).status).toBe(200);
      expect((await who.get(`/api/payroll/periods/${ids.PB1}/preview`)).status).toBe(200);
    }
    // the officer still calculates another company's period
    expect((await c.officer!.post(`/api/payroll/periods/${ids.PB3}/calculate`)).status).toBe(200);
  });
});
