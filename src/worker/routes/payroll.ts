import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import type { CompanyOption, PayrollPeriod, PayrollPreviewResponse, PayslipCalc, PayslipDetail, PayslipSummary, PayslipYtd, PreviewIssue, YtdTotals } from '../../shared/types';
import { round2 } from '../../shared/payroll';
import { DEFAULT_LAYOUT, PREVIEW_COLUMNS, PROBATION_LABEL, normalizeLayout, type LayoutColumn } from '../../shared/payroll-columns';
import { isSuperAdmin } from '../../shared/modules';
import { writeXlsx, type Cell } from '../../shared/xlsx';
import { DATE_RE, safeName, badRequest, conflict, csv, forbidden, intParam, notFound, readJson, str } from '../lib/http';
import { audit, notify } from '../lib/audit';
import { ewfConfig, loadSettings, settingBool } from '../lib/settings';
import { companyScope, requireCompany } from '../lib/companies';
import { assertCalculable, sameScope, computePeriod, type ComputedSlip } from '../lib/payroll-engine';
import { can, currentUser, requireAuth, requirePerm, requireSuperAdmin } from '../auth';

const PERIOD_SELECT = `SELECT p.id, p.code, p.name, p.start_date, p.end_date, p.pay_date, p.status, p.kind, p.company_id, (SELECT name FROM companies c WHERE c.id = p.company_id) AS company,
  p.calc_version, p.calculated_by, p.approved_by, p.calculated_at,
  (SELECT COUNT(*) FROM payslips s WHERE s.period_id = p.id) AS employees,
  (SELECT COALESCE(SUM(net), 0) FROM payslips s WHERE s.period_id = p.id) AS total_net,
  (SELECT COALESCE(SUM(ewf_employer), 0) FROM payslips s WHERE s.period_id = p.id) AS total_ewf_employer
  FROM payroll_periods p`;

const SLIP_SELECT = `SELECT s.id, p.code AS period_code, p.name AS period_name, p.pay_date, s.employee_id,
  e.emp_code || ' ' || e.first_name || ' ' || e.last_name AS employee, s.gross, s.deductions, s.net, s.published
  FROM payslips s JOIN payroll_periods p ON p.id = s.period_id JOIN employees e ON e.id = s.employee_id`;

type PeriodRow = PayrollPeriod & { calculated_by: number | null; approved_by: number | null; calculated_at: string | null };

async function period(db: D1Database, id: number): Promise<PeriodRow> {
  const p = await db.prepare(`${PERIOD_SELECT} WHERE p.id = ?`).bind(id).first<PeriodRow>();
  if (!p) throw notFound('ไม่พบงวดเงินเดือน');
  return p;
}

/** Feishu OT rows of the period still waiting for HR review (they are excluded from pay until confirmed). */
async function pendingOt(db: D1Database, periodId: number, companyId: number | null = null): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM attendance_import_rows r JOIN attendance_imports i ON i.id = r.import_id WHERE i.payroll_period_id = ?1 AND i.status = 'active' AND r.included = 1 AND r.ot_status = 'pending' AND (?2 IS NULL OR i.company_id = ?2)")
    .bind(periodId, companyId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export const payrollRoutes = new Hono<AppEnv>();
payrollRoutes.use('*', requireAuth, requirePerm('payroll.view'));

payrollRoutes.get('/periods', async (c) => {
  const { results } = await c.env.DB.prepare(`${PERIOD_SELECT} ORDER BY p.start_date DESC, p.kind`).all<PeriodRow>();
  return c.json(results);
});

payrollRoutes.post('/periods', requirePerm('payroll.calculate'), async (c) => {
  const body = await readJson(c);
  const code = str(body, 'code', { required: true, max: 20 }) as string;
  const name = str(body, 'name', { required: true, max: 100 }) as string;
  const kind = (str(body, 'kind') ?? 'monthly') as string;
  if (kind !== 'monthly' && kind !== 'mid_month') throw badRequest('ประเภทงวดไม่ถูกต้อง');
  const [start, end, pay] = ['start_date', 'end_date', 'pay_date'].map((k) => str(body, k, { required: true }) as string) as [string, string, string];
  if (![start, end, pay].every((d) => DATE_RE.test(d ?? ''))) throw badRequest('รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
  if (start > end) throw badRequest('วันสิ้นสุดงวดต้องไม่ก่อนวันเริ่มงวด');
  if (kind === 'mid_month' && (pay < end || pay.slice(0, 7) !== end.slice(0, 7) || Number(pay.slice(8, 10)) > 15)) {
    throw badRequest('รอบจ่ายกลางเดือนต้องกำหนดวันจ่ายหลังวันสิ้นสุดรอบ และไม่เกินวันที่ 15 ของเดือนนั้น');
  }
  let companyId: number | null = null;
  if (body.company_id !== undefined && body.company_id !== null && body.company_id !== '') {
    companyId = intParam(String(body.company_id), 'company_id');
    if (!(await c.env.DB.prepare('SELECT id FROM companies WHERE id = ? AND active = 1').bind(companyId).first())) throw badRequest('ไม่พบบริษัท หรือบริษัทปิดใช้งาน');
  }
  // the same days can never be paid twice to the same employees by two periods of the same kind
  const overlap = await c.env.DB.prepare(`SELECT code FROM payroll_periods WHERE kind = ?1 AND start_date <= ?2 AND end_date >= ?3 AND ${sameScope(4)} LIMIT 1`)
    .bind(kind, end, start, companyId)
    .first<{ code: string }>();
  if (overlap) throw conflict(`ช่วงวันที่ซ้อนกับงวด ${overlap.code} (ป้องกันการจ่ายซ้ำ)`);
  const user = currentUser(c);
  try {
    const row = await c.env.DB.prepare('INSERT INTO payroll_periods (code, name, start_date, end_date, pay_date, kind, company_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(code, name, start, end, pay, kind, companyId, user.id, user.id)
      .first<{ id: number }>();
    await audit(c, 'payroll.period_created', 'payroll_periods', row?.id ?? null, { code, kind, company: companyId });
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
  await assertCalculable(db, p);
  const slips = await computePeriod(db, p);
  const version = p.calc_version + 1;

  const stmts = [db.prepare('DELETE FROM payslips WHERE period_id = ?').bind(p.id)];
  let totalNet = 0;
  for (const s of slips) {
    const r = s.pay;
    totalNet += r.net;
    stmts.push(
      db.prepare(
        `INSERT INTO payslips (period_id, employee_id, base_salary, ot_amount, earnings, unpaid_leave, gross, sso, tax, deductions, net, lines_json,
           ewf_employee, ewf_employer, ewf_employee_rate, ewf_employer_rate, ewf_status, company_id, advance, calc_json, calc_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(p.id, s.employee.id, s.wage.wage, r.otAmount, r.earnings, r.unpaidLeave, r.gross, r.sso, r.tax, r.deductions, r.net, JSON.stringify(r.lines),
        r.ewfEmployee, r.ewfEmployer, s.ewf.employeeRate, s.ewf.employerRate, s.ewf.status, s.employee.company_id, r.advance, JSON.stringify(s.calc), version),
    );
  }
  stmts.push(db.prepare("UPDATE payroll_periods SET status = 'calculated', calc_version = ?, calculated_by = ?, calculated_at = datetime('now'), updated_at = datetime('now'), updated_by = ? WHERE id = ?").bind(version, user.id, user.id, p.id));
  // attendance used by the calculation is locked: re-import / rollback / OT changes need the period reopened first
  stmts.push(db.prepare("UPDATE attendance_imports SET locked = 1, locked_at = datetime('now') WHERE payroll_period_id = ? AND status = 'active' AND locked = 0").bind(p.id));
  await db.batch(stmts);
  await audit(c, 'payroll.calculated', 'payroll_periods', p.id, { employees: slips.length, version, kind: p.kind });
  return c.json({ ...(await period(db, p.id)), totalNet: round2(totalNet) });
});

/** calculated → draft: drops the unapproved payslips and unlocks the period's attendance for correction. */
payrollRoutes.post('/periods/:id/reopen', requirePerm('payroll.calculate'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const p = await period(db, intParam(c.req.param('id')));
  if (p.status !== 'calculated') throw conflict('เปิดแก้ไขได้เฉพาะงวดที่คำนวณแล้วแต่ยังไม่อนุมัติ');
  if (p.kind === 'mid_month') await assertCalculable(db, p);
  await db.batch([
    db.prepare('DELETE FROM payslips WHERE period_id = ?').bind(p.id),
    db.prepare("UPDATE payroll_periods SET status = 'draft', updated_at = datetime('now'), updated_by = ? WHERE id = ?").bind(user.id, p.id),
    db.prepare('UPDATE attendance_imports SET locked = 0, locked_at = NULL WHERE payroll_period_id = ?').bind(p.id),
  ]);
  await audit(c, 'payroll.reopened', 'payroll_periods', p.id, { version: p.calc_version });
  return c.json(await period(db, p.id));
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
  const pending = await pendingOt(db, p.id);
  if (pending) throw conflict(`มี OT จาก Feishu รอ HR ตรวจสอบ ${pending} รายการ ต้องยืนยันหรือปฏิเสธก่อนอนุมัติ`);
  if (p.kind === 'mid_month') await assertCalculable(db, p);
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
    `SELECT e.emp_code, e.first_name || ' ' || e.last_name AS name, e.bank_name, e.bank_account, s.base_salary, s.ot_amount, s.earnings, s.unpaid_leave, s.gross, s.sso, s.ewf_employee, s.tax, s.deductions, s.net, s.ewf_employer
     FROM payslips s JOIN employees e ON e.id = s.employee_id WHERE s.period_id = ? ORDER BY e.emp_code`,
  )
    .bind(p.id)
    .all<Record<string, string | number | null>>();
  const head = ['รหัส', 'ชื่อ', 'ธนาคาร', 'เลขบัญชี', 'เงินเดือน', 'OT', 'เงินได้อื่น', 'หักลาไม่รับค่าจ้าง', 'รวมเงินได้', 'ประกันสังคม', 'กองทุนสงเคราะห์ลูกจ้าง (พนักงาน)', 'ภาษี', 'รวมหัก', 'สุทธิ', 'กองทุนสงเคราะห์ลูกจ้าง (นายจ้างสมทบ)'];
  const keys = ['emp_code', 'name', 'bank_name', 'bank_account', 'base_salary', 'ot_amount', 'earnings', 'unpaid_leave', 'gross', 'sso', 'ewf_employee', 'tax', 'deductions', 'net', 'ewf_employer'];
  await audit(c, 'payroll.exported', 'payroll_periods', p.id, { rows: results.length });
  return c.body(csv([head, ...results.map((r) => keys.map((k) => r[k] ?? null))]), 200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="${safeName(`payroll-${p.code}`)}.csv"`,
    'cache-control': 'no-store',
  });
});

// ---- Payroll Preview ------------------------------------------------------------------------
interface SlipLike {
  lines: Array<{ code: string; kind: string; amount: number; category?: string }>;
  gross: number;
  sso: number;
  tax: number;
  ewf_employee: number;
  ewf_employer: number;
  deductions: number;
  net: number;
  advance: number;
  unpaid_leave: number;
  ot_amount: number;
}
interface EmpLike {
  emp_code: string;
  name: string;
  company: string | null;
  department: string | null;
  position: string | null;
  hire_date: string;
  bank_account: string | null;
}

const STATUTORY = new Set(['SSO', 'TAX', 'EWF', 'ADV', 'UNPAID']);

function previewRow(e: EmpLike, s: SlipLike, calc: PayslipCalc | null, pvdCode: string): Record<string, string | number | null> {
  const sum = (f: (l: SlipLike['lines'][number]) => boolean) => round2(s.lines.filter(f).reduce((a, l) => a + l.amount, 0));
  const earning = (l: SlipLike['lines'][number]) => l.kind === 'earning' && !l.code.startsWith('BASE') && l.code !== 'OT';
  const isPvd = (l: SlipLike['lines'][number]) => l.category === 'provident_fund' || (!l.category && l.code === pvdCode);
  const other = (l: SlipLike['lines'][number]) => l.kind === 'deduction' && !STATUTORY.has(l.code) && !isPvd(l);
  return {
    emp_code: e.emp_code,
    employee_name: e.name,
    company: e.company,
    department: calc?.department ?? e.department,
    position: calc?.position ?? e.position,
    hire_date: e.hire_date,
    probation_status: calc ? (PROBATION_LABEL[calc.probationStatus] ?? calc.probationStatus) : null,
    work_days: calc?.attendance.workDays ?? null,
    expected_work_days: calc?.attendance.expectedWorkDays ?? null,
    actual_work_hours: calc?.attendance.actualWorkHours ?? null,
    ot_hours: calc?.attendance.otHours ?? null,
    unpaid_leave_days: calc?.attendance.unpaidLeaveDays ?? null,
    unpaid_leave_hours: calc?.attendance.unpaidLeaveHours ?? null,
    base_salary: sum((l) => l.kind === 'earning' && l.code.startsWith('BASE')),
    unpaid_leave_amount: s.unpaid_leave ? -s.unpaid_leave : 0,
    ot_pay: s.ot_amount,
    allowance: sum((l) => earning(l) && l.category === 'allowance'),
    commission: sum((l) => earning(l) && l.category === 'commission'),
    bonus: sum((l) => earning(l) && l.category === 'bonus'),
    other_income: sum((l) => earning(l) && !['allowance', 'commission', 'bonus'].includes(l.category ?? '')),
    total_income: s.gross,
    sso: s.sso,
    tax: s.tax,
    ewf_employee: s.ewf_employee,
    provident_fund: sum((l) => l.kind === 'deduction' && isPvd(l)),
    mid_month_advance: s.advance,
    other_deduction: sum(other),
    total_deduction: s.deductions,
    ewf_employer: s.ewf_employer,
    net_pay: s.net,
  };
}

async function layoutFor(db: D1Database, companyId: number | null): Promise<{ layout: LayoutColumn[]; saved: boolean }> {
  if (companyId === null) return { layout: [...DEFAULT_LAYOUT], saved: false };
  const row = await db.prepare('SELECT columns_json FROM payroll_column_layouts WHERE company_id = ?').bind(companyId).first<{ columns_json: string }>();
  const parsed = row ? normalizeLayout(JSON.parse(row.columns_json)) : null;
  return parsed ? { layout: parsed, saved: true } : { layout: [...DEFAULT_LAYOUT], saved: false };
}

/** Company filter for payroll data: organisation-wide users may see all, everyone else only their own company. */
async function payrollCompany(c: Context<AppEnv>): Promise<CompanyOption | null> {
  const user = currentUser(c);
  const company = await requireCompany(c.env.DB, user, c.req.query('company'));
  if (company) return company;
  const scope = await companyScope(c.env.DB, user);
  if (scope.scope === 'all') return null;
  const own = scope.items[0];
  if (!own) throw forbidden('บัญชีนี้ยังไม่ได้ผูกกับบริษัท จึงดูข้อมูลเงินเดือนไม่ได้');
  return own;
}

async function buildPreview(c: Context<AppEnv>): Promise<PayrollPreviewResponse> {
  const db = c.env.DB;
  const user = currentUser(c);
  const p = await period(db, intParam(c.req.param('id')));
  const company = await payrollCompany(c);
  const companyId = company?.id ?? null;
  const pvdCode = ewfConfig(await loadSettings(db)).providentFundComponent;
  const issues: PreviewIssue[] = [];
  let rows: Array<Record<string, string | number | null>>;
  let source: 'snapshot' | 'live';
  const usedImports = new Set<number>();
  let missingBank: number;

  if (p.status === 'draft') {
    source = 'live';
    const slips: ComputedSlip[] = await computePeriod(db, p, companyId);
    rows = slips.map((s) => previewRow(s.employee, { ...s.pay, ewf_employee: s.pay.ewfEmployee, ewf_employer: s.pay.ewfEmployer, unpaid_leave: s.pay.unpaidLeave, ot_amount: s.pay.otAmount }, s.calc, pvdCode));
    missingBank = slips.filter((s) => !s.employee.bank_account).length;
    issues.push({ level: 'error', code: 'not_calculated', message: 'งวดยังไม่ได้คำนวณ: ตัวเลขเป็นการคำนวณชั่วคราว (ยังไม่บันทึก) ต้องคำนวณงวดก่อน Export', count: 1 });
  } else {
    source = 'snapshot';
    const { results } = await db
      .prepare(
        `SELECT s.*, e.emp_code, e.first_name || ' ' || e.last_name AS name, e.hire_date, e.bank_account, c.name AS company,
                (SELECT name FROM departments d WHERE d.id = e.department_id) AS department, (SELECT title FROM positions x WHERE x.id = e.position_id) AS position
         FROM payslips s JOIN employees e ON e.id = s.employee_id LEFT JOIN companies c ON c.id = COALESCE(s.company_id, e.company_id)
         WHERE s.period_id = ?1 AND (?2 IS NULL OR COALESCE(s.company_id, e.company_id) = ?2) ORDER BY e.emp_code`,
      )
      .bind(p.id, companyId)
      .all<SlipLike & EmpLike & { lines_json: string; calc_json: string | null }>();
    rows = results.map((r) => {
      const calc = r.calc_json ? (JSON.parse(r.calc_json) as PayslipCalc) : null;
      if (calc?.attendance.importId) usedImports.add(calc.attendance.importId);
      return previewRow(r, { ...r, lines: JSON.parse(r.lines_json) as SlipLike['lines'] }, calc, pvdCode);
    });
    missingBank = results.filter((r) => !r.bank_account).length;
  }

  const { results: active } = await db
    .prepare("SELECT id, company_id FROM attendance_imports WHERE payroll_period_id = ?1 AND status = 'active' AND (?2 IS NULL OR company_id = ?2)")
    .bind(p.id, companyId)
    .all<{ id: number; company_id: number }>();
  const ot = await pendingOt(db, p.id, companyId);
  if (ot) issues.push({ level: 'error', code: 'ot_pending', message: 'มี OT จาก Feishu ที่ยังไม่ยืนยัน (ไม่ถูกนำไปคำนวณ) ต้องตรวจสอบก่อน Export', count: ot });
  if (source === 'snapshot') {
    const changed = active.filter((a) => !usedImports.has(a.id)).length + [...usedImports].filter((id) => !active.some((a) => a.id === id)).length;
    if (changed) issues.push({ level: 'error', code: 'attendance_changed', message: 'ข้อมูลเวลาทำงานถูกนำเข้าใหม่หรือย้อนกลับหลังการคำนวณ ต้องคำนวณงวดใหม่', count: changed });
  }
  const negative = rows.filter((r) => typeof r.net_pay === 'number' && r.net_pay < 0).length;
  if (negative) issues.push({ level: 'error', code: 'net_negative', message: 'มีพนักงานที่เงินได้สุทธิติดลบ', count: negative });
  if (missingBank) issues.push({ level: 'warning', code: 'no_bank_account', message: 'พนักงานไม่มีเลขบัญชีธนาคาร', count: missingBank });
  if (!active.length) issues.push({ level: 'warning', code: 'no_attendance', message: 'ยังไม่มีข้อมูลเวลาทำงานจาก Feishu สำหรับงวดนี้: ใช้คำขอ OT / การลาที่อนุมัติในระบบแทน', count: 1 });
  if (p.kind === 'monthly') {
    const { results: mids } = await db.prepare(`SELECT code, status FROM payroll_periods WHERE kind = 'mid_month' AND start_date >= ?1 AND end_date <= ?2 AND ${sameScope(3)}`).bind(p.start_date, p.end_date, p.company_id).all<{ code: string; status: string }>();
    const notPaid = mids.filter((m) => m.status === 'draft' || m.status === 'calculated');
    if (notPaid.length) issues.push({ level: 'warning', code: 'mid_month_open', message: `รอบจ่ายกลางเดือน ${notPaid.map((m) => m.code).join(', ')} ยังไม่อนุมัติ จึงยังไม่ถูกหักเป็นเงินจ่ายล่วงหน้า`, count: notPaid.length });
  }

  const totals: Record<string, number> = {};
  for (const col of PREVIEW_COLUMNS) {
    if (col.type !== 'money' && col.type !== 'number') continue;
    totals[col.key] = round2(rows.reduce((a, r) => a + (typeof r[col.key] === 'number' ? (r[col.key] as number) : 0), 0));
  }
  const { layout, saved } = await layoutFor(db, companyId);
  return {
    period: p,
    company,
    source,
    columns: PREVIEW_COLUMNS.map((x) => ({ ...x })),
    layout,
    layoutSaved: saved,
    canManageLayout: isSuperAdmin(user.roles) && companyId !== null,
    rows,
    totals,
    issues,
    exportable: source === 'snapshot' && !issues.some((i) => i.level === 'error'),
  };
}

payrollRoutes.get('/periods/:id/preview', requirePerm('payroll_preview.view'), async (c) => c.json(await buildPreview(c)));

const exportPreview = (ext: 'csv' | 'xlsx') => async (c: Context<AppEnv>) => {
  const pv = await buildPreview(c);
  if (!pv.exportable) throw conflict(`ยังไม่สามารถ Export ได้: ${pv.issues.filter((i) => i.level === 'error').map((i) => i.message).join(' · ')}`);
  const cols = pv.layout.filter((l) => l.visible).map((l) => PREVIEW_COLUMNS.find((x) => x.key === l.key)).filter((x): x is (typeof PREVIEW_COLUMNS)[number] => !!x);
  const head = cols.map((x) => x.label);
  const body = pv.rows.map((r) => cols.map((x) => r[x.key] ?? null));
  const numeric = (x: (typeof cols)[number]) => x.type === 'money' || x.type === 'number';
  const labelAt = cols.findIndex((x) => !numeric(x));
  const total = cols.map((x, i) => (numeric(x) ? (pv.totals[x.key] ?? null) : i === labelAt ? 'รวม' : null));
  const name = safeName(`payroll-preview-${pv.period.code}${pv.company ? `-${pv.company.code}` : ''}`);
  await audit(c, 'payroll.preview_exported', 'payroll_periods', pv.period.id, { rows: pv.rows.length, format: ext, company: pv.company?.id ?? null, columns: cols.length });
  if (ext === 'csv') {
    return c.body(csv([head, ...body, total]), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}.csv"`, 'cache-control': 'no-store' });
  }
  const bytes = writeXlsx(pv.period.code, [head, ...body, total] as Cell[][]);
  return c.body(bytes as unknown as ArrayBuffer, 200, {
    'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'content-disposition': `attachment; filename="${name}.xlsx"`,
    'cache-control': 'no-store',
  });
};
payrollRoutes.get('/periods/:id/preview.csv', requirePerm('payroll_preview.export'), exportPreview('csv'));
payrollRoutes.get('/periods/:id/preview.xlsx', requirePerm('payroll_preview.export'), exportPreview('xlsx'));

// ---- Column layouts (Super Admin only) ------------------------------------------------------
async function layoutCompany(c: Context<AppEnv>): Promise<number> {
  const id = intParam(c.req.param('companyId'), 'companyId');
  const row = await c.env.DB.prepare('SELECT id FROM companies WHERE id = ?').bind(id).first<{ id: number }>();
  if (!row) throw notFound('ไม่พบบริษัท');
  return id;
}

payrollRoutes.get('/layouts/:companyId', requirePerm('payroll_preview.view'), async (c) => {
  const user = currentUser(c);
  const company = await requireCompany(c.env.DB, user, c.req.param('companyId'));
  const { layout, saved } = await layoutFor(c.env.DB, company?.id ?? null);
  return c.json({ layout, saved, canManage: isSuperAdmin(user.roles) });
});

payrollRoutes.put('/layouts/:companyId', requireSuperAdmin, async (c) => {
  const companyId = await layoutCompany(c);
  const body = await readJson<{ columns?: unknown }>(c);
  const layout = normalizeLayout(body.columns);
  if (!layout) throw badRequest('รูปแบบคอลัมน์ไม่ถูกต้อง (ต้องเป็นคอลัมน์ที่ระบบรู้จักและแสดงอย่างน้อย 1 คอลัมน์)');
  const user = currentUser(c);
  await c.env.DB.prepare(
    `INSERT INTO payroll_column_layouts (company_id, columns_json, updated_at, updated_by) VALUES (?, ?, datetime('now'), ?)
     ON CONFLICT(company_id) DO UPDATE SET columns_json = excluded.columns_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  )
    .bind(companyId, JSON.stringify(layout), user.id)
    .run();
  await audit(c, 'payroll.layout_saved', 'payroll_column_layouts', companyId, { visible: layout.filter((l) => l.visible).length });
  return c.json({ layout, saved: true });
});

payrollRoutes.delete('/layouts/:companyId', requireSuperAdmin, async (c) => {
  const companyId = await layoutCompany(c);
  await c.env.DB.prepare('DELETE FROM payroll_column_layouts WHERE company_id = ?').bind(companyId).run();
  await audit(c, 'payroll.layout_reset', 'payroll_column_layouts', companyId);
  return c.json({ layout: DEFAULT_LAYOUT, saved: false });
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

/** Every employee record of the same person (transfers between companies link records through person_id). */
async function personRecords(db: D1Database, employeeId: number): Promise<number[]> {
  const { results } = await db
    .prepare(
      `WITH RECURSIVE up(id, pid) AS (SELECT id, person_id FROM employees WHERE id = ?1
         UNION SELECT e.id, e.person_id FROM employees e JOIN up ON e.id = up.pid),
       grp(id) AS (SELECT id FROM up WHERE pid IS NULL UNION SELECT e.id FROM employees e JOIN grp ON e.person_id = grp.id)
       SELECT id FROM grp`,
    )
    .bind(employeeId)
    .all<{ id: number }>();
  const ids = results.map((r) => r.id);
  return ids.includes(employeeId) ? ids : [employeeId];
}

async function payslipYtd(db: D1Database, slip: { id: number; employee_id: number; period_id: number; pay_date: string; published: number; company_id: number | null }): Promise<PayslipYtd> {
  const year = Number(slip.pay_date.slice(0, 4));
  const ids = await personRecords(db, slip.employee_id);
  // published monthly payslips only: mid-month advances are already part of the month-end gross
  const { results } = await db
    .prepare(
      `SELECT s.company_id, c.name AS company, ROUND(SUM(s.gross), 2) AS gross, ROUND(SUM(s.sso), 2) AS sso, ROUND(SUM(s.tax), 2) AS tax,
              ROUND(SUM(s.ewf_employee), 2) AS ewf_employee, COUNT(*) AS slips
       FROM payslips s JOIN payroll_periods p ON p.id = s.period_id LEFT JOIN companies c ON c.id = s.company_id
       WHERE s.employee_id IN (${ids.map(() => '?').join(',')}) AND s.published = 1 AND p.kind = 'monthly'
         AND p.pay_date >= ? AND (p.pay_date < ? OR (p.pay_date = ? AND p.id <= ?))
       GROUP BY s.company_id ORDER BY MIN(p.pay_date)`,
    )
    .bind(...ids, `${year}-01-01`, slip.pay_date, slip.pay_date, slip.period_id)
    .all<YtdTotals & { company_id: number | null; company: string | null }>();
  const zero: YtdTotals = { gross: 0, sso: 0, tax: 0, ewf_employee: 0, slips: 0 };
  const own = results.find((r) => r.company_id === slip.company_id);
  const companyName = own?.company ?? (slip.company_id ? (await db.prepare('SELECT name FROM companies WHERE id = ?').bind(slip.company_id).first<{ name: string }>())?.name ?? null : null);
  const total = results.reduce((a, r) => ({ gross: a.gross + r.gross, sso: a.sso + r.sso, tax: a.tax + r.tax, ewf_employee: a.ewf_employee + r.ewf_employee, slips: a.slips + r.slips }), zero);
  return {
    year,
    includesCurrent: slip.published === 1,
    company: { ...(own ?? zero), company_id: slip.company_id, company: companyName },
    employee: { gross: round2(total.gross), sso: round2(total.sso), tax: round2(total.tax), ewf_employee: round2(total.ewf_employee), slips: total.slips, companies: results.length, records: ids.length },
    byCompany: results,
  };
}

payslipRoutes.get('/payslips/:id', async (c) => {
  const user = currentUser(c);
  const id = intParam(c.req.param('id'));
  const row = await c.env.DB.prepare(
    `SELECT s.*, p.code AS period_code, p.name AS period_name, p.pay_date, p.kind AS period_kind,
            e.emp_code || ' ' || e.first_name || ' ' || e.last_name AS employee,
            (SELECT name FROM companies x WHERE x.id = COALESCE(s.company_id, e.company_id)) AS company,
            (SELECT name FROM departments d WHERE d.id = e.department_id) AS department,
            (SELECT title FROM positions x WHERE x.id = e.position_id) AS position
     FROM payslips s JOIN payroll_periods p ON p.id = s.period_id JOIN employees e ON e.id = s.employee_id WHERE s.id = ?`,
  )
    .bind(id)
    .first<Omit<PayslipDetail, 'lines' | 'ewf_employer' | 'ewf_employer_rate' | 'calc' | 'ytd'> & { lines_json: string; calc_json: string | null; ewf_employer: number; ewf_employer_rate: number | null; period_id: number; company_id: number | null; calc_version: number }>();
  const own = row && user.employeeId !== null && row.employee_id === user.employeeId && row.published === 1 && can(user, 'payslip.own');
  if (!row || (!own && !can(user, 'payroll.view'))) throw notFound('ไม่พบสลิปเงินเดือน');
  const { lines_json, calc_json, ewf_employer, ewf_employer_rate, ...rest } = row;
  // the employer contribution is company cost: only payroll staff see it, the employee's own view does not
  await audit(c, 'payslip.viewed', 'payslips', id, { own: !!own });
  const employer = can(user, 'payroll.view') ? { ewf_employer, ewf_employer_rate } : {};
  const calc = calc_json ? (JSON.parse(calc_json) as PayslipCalc) : null;
  const ytd = can(user, 'payslip_ytd.view') ? { ytd: await payslipYtd(c.env.DB, row) } : {};
  return c.json<PayslipDetail>({ ...rest, ...employer, ...ytd, calc, lines: JSON.parse(lines_json) as PayslipDetail['lines'] });
});


