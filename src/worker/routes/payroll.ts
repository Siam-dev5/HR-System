import { Hono } from 'hono';
import type { AppEnv } from '../env';
import type { PayrollPeriod, PayslipDetail, PayslipSummary } from '../../shared/types';
import { calculatePay } from '../../shared/payroll';
import { DATE_RE, badRequest, conflict, csv, forbidden, intParam, notFound, readJson, str } from '../lib/http';
import { audit, notify } from '../lib/audit';
import { loadSettings, payrollConfig, settingBool } from '../lib/settings';
import { can, currentUser, requireAuth, requirePerm } from '../auth';

const PERIOD_SELECT = `SELECT p.id, p.code, p.name, p.start_date, p.end_date, p.pay_date, p.status, p.calculated_by, p.approved_by,
  (SELECT COUNT(*) FROM payslips s WHERE s.period_id = p.id) AS employees,
  (SELECT COALESCE(SUM(net), 0) FROM payslips s WHERE s.period_id = p.id) AS total_net
  FROM payroll_periods p`;

const SLIP_SELECT = `SELECT s.id, p.code AS period_code, p.name AS period_name, p.pay_date, s.employee_id,
  e.emp_code || ' ' || e.first_name || ' ' || e.last_name AS employee, s.gross, s.deductions, s.net, s.published
  FROM payslips s JOIN payroll_periods p ON p.id = s.period_id JOIN employees e ON e.id = s.employee_id`;

type PeriodRow = PayrollPeriod & { calculated_by: number | null; approved_by: number | null };

async function period(db: D1Database, id: number): Promise<PeriodRow> {
  const p = await db.prepare(`${PERIOD_SELECT} WHERE p.id = ?`).bind(id).first<PeriodRow>();
  if (!p) throw notFound('ไม่พบงวดเงินเดือน');
  return p;
}

export const payrollRoutes = new Hono<AppEnv>();
payrollRoutes.use('*', requireAuth, requirePerm('payroll.view'));

payrollRoutes.get('/periods', async (c) => {
  const { results } = await c.env.DB.prepare(`${PERIOD_SELECT} ORDER BY p.start_date DESC`).all<PeriodRow>();
  return c.json(results);
});

payrollRoutes.post('/periods', requirePerm('payroll.calculate'), async (c) => {
  const body = await readJson(c);
  const code = str(body, 'code', { required: true, max: 20 }) as string;
  const name = str(body, 'name', { required: true, max: 100 }) as string;
  const [start, end, pay] = ['start_date', 'end_date', 'pay_date'].map((k) => str(body, k, { required: true }) as string);
  if (![start, end, pay].every((d) => DATE_RE.test(d ?? ''))) throw badRequest('รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
  if ((start as string) > (end as string)) throw badRequest('วันสิ้นสุดงวดต้องไม่ก่อนวันเริ่มงวด');
  const user = currentUser(c);
  try {
    const row = await c.env.DB.prepare('INSERT INTO payroll_periods (code, name, start_date, end_date, pay_date, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(code, name, start, end, pay, user.id, user.id)
      .first<{ id: number }>();
    await audit(c, 'payroll.period_created', 'payroll_periods', row?.id ?? null, { code });
    return c.json(await period(c.env.DB, row?.id ?? 0), 201);
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) throw conflict('รหัสงวดซ้ำ');
    throw e;
  }
});

payrollRoutes.post('/periods/:id/calculate', requirePerm('payroll.calculate'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const p = await period(db, intParam(c.req.param('id')));
  if (p.status !== 'draft' && p.status !== 'calculated') throw conflict('คำนวณใหม่ได้เฉพาะงวดที่ยังไม่อนุมัติ');
  const cfg = payrollConfig(await loadSettings(db));

  const { results: emps } = await db
    .prepare("SELECT id, base_salary FROM employees WHERE status IN ('active', 'probation') AND hire_date <= ? AND base_salary IS NOT NULL AND base_salary > 0 ORDER BY emp_code")
    .bind(p.end_date)
    .all<{ id: number; base_salary: number }>();
  const { results: ot } = await db
    .prepare("SELECT employee_id, hours, rate FROM overtime_requests WHERE status = 'approved' AND work_date BETWEEN ? AND ?")
    .bind(p.start_date, p.end_date)
    .all<{ employee_id: number; hours: number; rate: string }>();
  const { results: items } = await db
    .prepare(
      `SELECT i.employee_id, i.amount, c.code, c.name, c.kind, c.taxable FROM employee_pay_items i JOIN pay_components c ON c.id = i.component_id
       WHERE c.active = 1 AND (i.start_date IS NULL OR i.start_date <= ?) AND (i.end_date IS NULL OR i.end_date >= ?)`,
    )
    .bind(p.end_date, p.start_date)
    .all<{ employee_id: number; amount: number; code: string; name: string; kind: string; taxable: number }>();
  const { results: unpaid } = await db
    .prepare("SELECT l.employee_id, SUM(l.days) AS days FROM leave_requests l JOIN leave_types t ON t.id = l.leave_type_id WHERE l.status = 'approved' AND t.paid = 0 AND l.start_date BETWEEN ? AND ? GROUP BY l.employee_id")
    .bind(p.start_date, p.end_date)
    .all<{ employee_id: number; days: number }>();

  const stmts = [db.prepare('DELETE FROM payslips WHERE period_id = ?').bind(p.id)];
  let totalNet = 0;
  for (const e of emps) {
    const mine = items.filter((i) => i.employee_id === e.id);
    const r = calculatePay(
      {
        baseSalary: e.base_salary,
        overtime: ot.filter((o) => o.employee_id === e.id).map((o) => ({ hours: o.hours, rate: Number(o.rate) })),
        earnings: mine.filter((i) => i.kind === 'earning').map((i) => ({ code: i.code, name: i.name, amount: i.amount, taxable: i.taxable === 1 })),
        deductions: mine.filter((i) => i.kind === 'deduction').map((i) => ({ code: i.code, name: i.name, amount: i.amount })),
        unpaidLeaveDays: unpaid.find((u) => u.employee_id === e.id)?.days ?? 0,
      },
      cfg,
    );
    totalNet += r.net;
    stmts.push(
      db.prepare(
        'INSERT INTO payslips (period_id, employee_id, base_salary, ot_amount, earnings, unpaid_leave, gross, sso, tax, deductions, net, lines_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(p.id, e.id, r.baseSalary, r.otAmount, r.earnings, r.unpaidLeave, r.gross, r.sso, r.tax, r.deductions, r.net, JSON.stringify(r.lines)),
    );
  }
  stmts.push(db.prepare("UPDATE payroll_periods SET status = 'calculated', calculated_by = ?, calculated_at = datetime('now'), updated_at = datetime('now'), updated_by = ? WHERE id = ?").bind(user.id, user.id, p.id));
  await db.batch(stmts);
  await audit(c, 'payroll.calculated', 'payroll_periods', p.id, { employees: emps.length });
  return c.json({ ...(await period(db, p.id)), totalNet: Math.round(totalNet * 100) / 100 });
});

payrollRoutes.post('/periods/:id/approve', requirePerm('payroll.approve'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const p = await period(db, intParam(c.req.param('id')));
  if (p.status !== 'calculated') throw conflict('อนุมัติได้เฉพาะงวดที่คำนวณแล้ว');
  if (!p.employees) throw conflict('งวดนี้ไม่มีสลิปเงินเดือน');
  if (settingBool(await loadSettings(db), 'payroll.require_separate_approver', true) && p.calculated_by === user.id) {
    throw forbidden('ผู้อนุมัติต้องไม่ใช่ผู้คำนวณงวดเงินเดือน (Segregation of duties)');
  }
  await db.prepare("UPDATE payroll_periods SET status = 'approved', approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now'), updated_by = ? WHERE id = ?").bind(user.id, user.id, p.id).run();
  await audit(c, 'payroll.approved', 'payroll_periods', p.id);
  return c.json(await period(db, p.id));
});

payrollRoutes.post('/periods/:id/publish', requirePerm('payroll.publish'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const p = await period(db, intParam(c.req.param('id')));
  if (p.status !== 'approved') throw conflict('เผยแพร่ได้เฉพาะงวดที่อนุมัติแล้ว');
  await db.batch([
    db.prepare('UPDATE payslips SET published = 1 WHERE period_id = ?').bind(p.id),
    db.prepare("UPDATE payroll_periods SET status = 'published', published_by = ?, published_at = datetime('now'), updated_at = datetime('now'), updated_by = ? WHERE id = ?").bind(user.id, user.id, p.id),
  ]);
  const { results } = await db
    .prepare('SELECT s.id, e.user_id FROM payslips s JOIN employees e ON e.id = s.employee_id WHERE s.period_id = ? AND e.user_id IS NOT NULL')
    .bind(p.id)
    .all<{ id: number; user_id: number }>();
  for (const r of results) await notify(db, r.user_id, 'สลิปเงินเดือนพร้อมแล้ว', p.name, `/my/payslips/${r.id}`);
  await audit(c, 'payroll.published', 'payroll_periods', p.id, { notified: results.length });
  return c.json(await period(db, p.id));
});

payrollRoutes.get('/payslips', async (c) => {
  const pid = c.req.query('period_id');
  const { results } = pid
    ? await c.env.DB.prepare(`${SLIP_SELECT} WHERE s.period_id = ? ORDER BY e.emp_code`).bind(intParam(pid, 'period_id')).all<PayslipSummary>()
    : await c.env.DB.prepare(`${SLIP_SELECT} ORDER BY p.start_date DESC, e.emp_code LIMIT 500`).all<PayslipSummary>();
  return c.json(results);
});

payrollRoutes.get('/periods/:id/export.csv', requirePerm('payroll.export'), async (c) => {
  const p = await period(c.env.DB, intParam(c.req.param('id')));
  const { results } = await c.env.DB.prepare(
    `SELECT e.emp_code, e.first_name || ' ' || e.last_name AS name, e.bank_name, e.bank_account, s.base_salary, s.ot_amount, s.earnings, s.unpaid_leave, s.gross, s.sso, s.tax, s.deductions, s.net
     FROM payslips s JOIN employees e ON e.id = s.employee_id WHERE s.period_id = ? ORDER BY e.emp_code`,
  )
    .bind(p.id)
    .all<Record<string, string | number | null>>();
  const head = ['รหัส', 'ชื่อ', 'ธนาคาร', 'เลขบัญชี', 'เงินเดือน', 'OT', 'เงินได้อื่น', 'หักลาไม่รับค่าจ้าง', 'รวมเงินได้', 'ประกันสังคม', 'ภาษี', 'รวมหัก', 'สุทธิ'];
  const keys = ['emp_code', 'name', 'bank_name', 'bank_account', 'base_salary', 'ot_amount', 'earnings', 'unpaid_leave', 'gross', 'sso', 'tax', 'deductions', 'net'];
  await audit(c, 'payroll.exported', 'payroll_periods', p.id, { rows: results.length });
  return c.body(csv([head, ...results.map((r) => keys.map((k) => r[k] ?? null))]), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="payroll-${p.code}.csv"`,
    'cache-control': 'no-store',
  });
});

// ---- Payslip access (HR and employee self-service) ------------------------------------------
export const payslipRoutes = new Hono<AppEnv>();
payslipRoutes.use('*', requireAuth);

payslipRoutes.get('/my/payslips', requirePerm('payslip.own'), async (c) => {
  const user = currentUser(c);
  if (user.employeeId === null) return c.json({ linked: false, rows: [] as PayslipSummary[] });
  const { results } = await c.env.DB.prepare(`${SLIP_SELECT} WHERE s.employee_id = ? AND s.published = 1 ORDER BY p.start_date DESC`).bind(user.employeeId).all<PayslipSummary>();
  return c.json({ linked: true, rows: results });
});

payslipRoutes.get('/payslips/:id', async (c) => {
  const user = currentUser(c);
  const id = intParam(c.req.param('id'));
  const row = await c.env.DB.prepare(
    `SELECT s.*, p.code AS period_code, p.name AS period_name, p.pay_date,
            e.emp_code || ' ' || e.first_name || ' ' || e.last_name AS employee,
            (SELECT name FROM departments d WHERE d.id = e.department_id) AS department,
            (SELECT title FROM positions x WHERE x.id = e.position_id) AS position
     FROM payslips s JOIN payroll_periods p ON p.id = s.period_id JOIN employees e ON e.id = s.employee_id WHERE s.id = ?`,
  )
    .bind(id)
    .first<Omit<PayslipDetail, 'lines'> & { lines_json: string }>();
  const own = row && user.employeeId !== null && row.employee_id === user.employeeId && row.published === 1 && can(user, 'payslip.own');
  if (!row || (!own && !can(user, 'payroll.view'))) throw notFound('ไม่พบสลิปเงินเดือน');
  const { lines_json, ...rest } = row;
  await audit(c, 'payslip.viewed', 'payslips', id, { own: !!own });
  return c.json<PayslipDetail>({ ...rest, lines: JSON.parse(lines_json) as PayslipDetail['lines'] });
});
