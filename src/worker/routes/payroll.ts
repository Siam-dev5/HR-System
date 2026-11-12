import { Hono } from 'hono';
import { approvalBody, approvalNote, checkMakerChecker } from '../lib/approval';
import type { Context } from 'hono';
import type { AppEnv } from '../env';
import type { CompanyOption, DeletedPeriod, PayrollPeriod, PayrollPreviewResponse, PayslipCalc, PayslipDetail, PayslipSummary, PayslipYtd, PeriodImpact, PreviewIssue, YtdTotals } from '../../shared/types';
import { PERIOD_ADMIN } from '../../shared/permissions';
import { round2 } from '../../shared/payroll';
import { DEFAULT_LAYOUT, PREVIEW_COLUMNS, PROBATION_LABEL, normalizeLayout, type LayoutColumn } from '../../shared/payroll-columns';
import { isSuperAdmin } from '../../shared/modules';
import { writeXlsx, type Cell } from '../../shared/xlsx';
import { DATE_RE, HttpError, safeName, badRequest, conflict, csv, forbidden, intParam, notFound, readJson, str } from '../lib/http';
import { audit, notify } from '../lib/audit';
import { ewfConfig, loadSettings } from '../lib/settings';
import { companyScope, requireCompany } from '../lib/companies';
import { advancePeriods, assertCalculable, coveringMonthly, sameScope, computePeriod, type ComputedSlip } from '../lib/payroll-engine';
import { verifyStepUp } from '../lib/step-up';
import { clearHold, holdsEnabled, scanHolds, type ScanResult } from '../lib/attendance-holds';
import { HOLD_KIND_LABEL, type HoldKind } from '../../shared/attendance-holds';
import { can, currentUser, requireAuth, requirePerm, requirePeriodAdmin, requireSuperAdmin } from '../auth';

// ---- Company scope ------------------------------------------------------------------------------
// Payroll data follows the system's company scope (lib/companies): a role holding employees.all sees every company,
// any other user only the company of their linked employee record, a user without one sees nothing. The scope is
// always resolved on the server from the authenticated user; a company id in the request can only narrow it.

interface PayrollScope {
  /** organisation-wide (employees.all): every company, active or not */
  all: boolean;
  /** companies in scope when not organisation-wide (never empty) */
  ids: number[];
}

const ALL_SCOPE: PayrollScope = { all: true, ids: [] };

async function payrollScope(c: Context<AppEnv>): Promise<PayrollScope> {
  const s = await companyScope(c.env.DB, currentUser(c));
  if (s.scope === 'all') return { all: true, ids: [] };
  const ids = s.items.map((x) => x.id).filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) throw forbidden('บัญชีนี้ยังไม่ได้ผูกกับบริษัท จึงดูข้อมูลเงินเดือนไม่ได้');
  return { all: false, ids };
}

/** SQL condition limiting a company column to the scope (ids are integers read from D1, never request input). */
function scopeSql(column: string, scope: PayrollScope): string {
  return scope.all ? '1' : `${column} IN (${scope.ids.map((id) => String(Math.trunc(id))).join(', ')})`;
}

/** A period is visible when it pays a company in scope; an all-company period (NULL) is visible, its data scoped. */
function periodVisible(p: { company_id: number | null }, scope: PayrollScope): boolean {
  return scope.all || p.company_id === null || scope.ids.includes(p.company_id);
}

/**
 * Changing a period (create / calculate / reopen / approve / publish) touches every payslip in it, so the whole
 * period must be in scope: an all-company period (NULL) needs organisation-wide scope.
 */
function assertPeriodWritable(p: { code?: string; company_id: number | null }, scope: PayrollScope): void {
  if (scope.all) return;
  if (p.company_id === null || !scope.ids.includes(p.company_id)) {
    throw forbidden(p.company_id === null
      ? `งวด ${p.code ?? ''} เป็นงวดของทุกบริษัท ต้องมีสิทธิ์ทุกบริษัท (employees.all) จึงดำเนินการได้`
      : 'ไม่มีสิทธิ์ดำเนินการกับงวดเงินเดือนของบริษัทนี้');
  }
}

/** Period columns; payslip totals only count slips of companies in scope. */
const periodSelect = (scope: PayrollScope) => {
  const slips = `s.period_id = p.id AND ${scopeSql('s.company_id', scope)}`;
  return `SELECT p.id, p.code, p.name, p.start_date, p.end_date, p.pay_date, p.status, p.kind, p.company_id, (SELECT name FROM companies c WHERE c.id = p.company_id) AS company,
  p.calc_version, p.calculated_by, p.approved_by, p.calculated_at, p.approved_at, p.published_at, p.reopened_from, p.updated_at,
  (SELECT COUNT(*) FROM payslips s WHERE ${slips}) AS employees,
  (SELECT COALESCE(SUM(net), 0) FROM payslips s WHERE ${slips}) AS total_net,
  (SELECT COALESCE(SUM(ewf_employer), 0) FROM payslips s WHERE ${slips}) AS total_ewf_employer,
  (SELECT COUNT(*) FROM payslips s WHERE ${slips} AND s.calc_version = 0) AS legacy_slips,
  (SELECT r.status FROM payroll_accounting_reviews r WHERE r.period_id = p.id AND r.calc_version = p.calc_version) AS accounting_status,
  (SELECT COUNT(*) FROM payroll_attendance_holds h WHERE h.period_id = p.id AND h.status = 'open' AND ${scopeSql('h.company_id', scope)}) AS open_holds
  FROM payroll_periods p`;
};

const SLIP_SELECT = `SELECT s.id, p.code AS period_code, p.name AS period_name, p.pay_date, s.employee_id,
  e.emp_code || ' ' || e.first_name || ' ' || e.last_name AS employee, s.gross, s.deductions, s.net, s.published
  FROM payslips s JOIN payroll_periods p ON p.id = s.period_id JOIN employees e ON e.id = s.employee_id`;

type PeriodRow = PayrollPeriod & { calculated_by: number | null; approved_by: number | null; calculated_at: string | null; updated_at: string };

const SLIP_COLUMNS = ['id', 'period_id', 'employee_id', 'base_salary', 'ot_amount', 'earnings', 'unpaid_leave', 'gross', 'sso', 'tax', 'deductions', 'net', 'lines_json', 'published',
  'created_at', 'ewf_employee', 'ewf_employer', 'ewf_employee_rate', 'ewf_employer_rate', 'ewf_status', 'company_id', 'advance', 'calc_json', 'calc_version'];

/**
 * Copies the period's payslips (full rows) into payslip_archive before they are replaced, removed or unpublished,
 * followed by an integrity check inside the same batch (transaction): the rows archived by this operation must be
 * exactly the period's payslips (every id with the same net, same count and total), otherwise the batch fails and
 * nothing changes. `claimed`: only act when the batch's own status claim (op_token) succeeded (duplicate requests).
 */
function archiveSlips(db: D1Database, periodId: number, reason: 'recalculate' | 'reopen', userId: number, op: string, claimed = false): D1PreparedStatement[] {
  const mine = 'EXISTS (SELECT 1 FROM payroll_periods WHERE id = ?3 AND op_token = ?4)';
  return [
    db.prepare(
      `INSERT INTO payslip_archive (period_id, payslip_id, employee_id, calc_version, net, row_json, reason, archived_by, op_token)
       SELECT period_id, id, employee_id, calc_version, net, json_object(${SLIP_COLUMNS.map((k) => `'${k}', ${k}`).join(', ')}), ?1, ?2, ?4 FROM payslips
       WHERE period_id = ?3${claimed ? ` AND ${mine}` : ''}`,
    ).bind(reason, userId, periodId, op),
    db.prepare(
      `SELECT CASE WHEN ${claimed ? `NOT ${mine} OR ` : ''}(
         (SELECT COUNT(*) FROM payslip_archive WHERE op_token = ?4) = (SELECT COUNT(*) FROM payslips WHERE period_id = ?3)
         AND (SELECT ROUND(COALESCE(SUM(net), 0), 2) FROM payslip_archive WHERE op_token = ?4) = (SELECT ROUND(COALESCE(SUM(net), 0), 2) FROM payslips WHERE period_id = ?3)
         AND NOT EXISTS (SELECT 1 FROM payslips s WHERE s.period_id = ?3 AND NOT EXISTS (
           SELECT 1 FROM payslip_archive a WHERE a.op_token = ?4 AND a.payslip_id = s.id AND a.net = s.net AND a.calc_version = s.calc_version)))
       THEN 1 ELSE json('payslip archive integrity check failed') END AS ok`,
    ).bind(reason, userId, periodId, op),
  ];
}

/**
 * Statements that supersede the period's active ACC review / sign-off (status reviewed or signed_off) with an
 * 'invalidated' event, inside the caller's batch. `onlyIf`: SQL condition (with its bindings) the change depends on,
 * e.g. the batch's own status claim. Returned reviews stay as they are (history of a decision already acted on).
 */
function supersedeAccounting(db: D1Database, periodId: number, actorId: number, reason: string, onlyIf?: { sql: string; params: unknown[] }): D1PreparedStatement[] {
  const cond = onlyIf ? ` AND ${onlyIf.sql}` : '';
  const params = onlyIf?.params ?? [];
  return [
    db.prepare(
      `INSERT INTO payroll_accounting_review_events (period_id, calc_version, action, actor_id, note)
       SELECT period_id, calc_version, 'invalidated', ?, ? FROM payroll_accounting_reviews WHERE period_id = ? AND status IN ('reviewed', 'signed_off')${cond}`,
    ).bind(actorId, reason, periodId, ...params),
    db.prepare(`UPDATE payroll_accounting_reviews SET status = 'superseded', op_token = NULL, updated_at = datetime('now') WHERE period_id = ? AND status IN ('reviewed', 'signed_off')${cond}`)
      .bind(periodId, ...params),
  ];
}

/** Number of active ACC reviews / sign-offs of a period (for the audit entry of the change that supersedes them). */
async function activeAccounting(db: D1Database, periodId: number): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM payroll_accounting_reviews WHERE period_id = ? AND status IN ('reviewed', 'signed_off')").bind(periodId).first<{ n: number }>();
  return r?.n ?? 0;
}

/** A guard statement that fails the whole batch (a transaction) unless `sql` is true; mapped to 409 by runGuarded. */
const GUARD_FAILED = 'accounting state changed';
function guard(db: D1Database, sql: string, ...params: unknown[]): D1PreparedStatement {
  return db.prepare(`SELECT CASE WHEN ${sql} THEN 1 ELSE json('${GUARD_FAILED}') END AS ok`).bind(...params);
}
async function runGuarded(db: D1Database, stmts: D1PreparedStatement[], message: string): Promise<void> {
  try {
    await db.batch(stmts);
  } catch (e) {
    if (e instanceof Error && /malformed JSON|UNIQUE|PRIMARY KEY/i.test(`${e.message} ${String((e as { cause?: unknown }).cause ?? '')}`)) throw conflict(message);
    throw e;
  }
}

/** Legacy payslips (calculated before migration 0005) are only replaced or removed on explicit confirmation. */
async function legacyConfirmed(c: Context<AppEnv>): Promise<boolean> {
  if (!c.req.header('content-type')?.includes('application/json')) return false;
  const body = (await c.req.json().catch(() => ({}))) as { confirm_legacy_recalculation?: unknown };
  return body.confirm_legacy_recalculation === true;
}

/** A period the user may see (404 otherwise, so ids of other companies' periods reveal nothing). */
async function period(db: D1Database, id: number, scope: PayrollScope): Promise<PeriodRow> {
  const p = await db.prepare(`${periodSelect(scope)} WHERE p.id = ? AND p.deleted_at IS NULL`).bind(id).first<PeriodRow>();
  if (!p || !periodVisible(p, scope)) throw notFound('ไม่พบงวดเงินเดือน');
  return p;
}

/** A period the user may change: visible and entirely in scope. Checked before anything is read or written. */
async function writablePeriod(c: Context<AppEnv>, id: number): Promise<{ p: PeriodRow; scope: PayrollScope }> {
  const scope = await payrollScope(c);
  const p = await period(c.env.DB, id, scope);
  assertPeriodWritable(p, scope);
  return { p, scope };
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
  const scope = await payrollScope(c);
  const { results } = await c.env.DB.prepare(`${periodSelect(scope)} WHERE p.deleted_at IS NULL AND (p.company_id IS NULL OR ${scopeSql('p.company_id', scope)}) ORDER BY p.start_date DESC, p.kind`).all<PeriodRow>();
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
  const scope = await payrollScope(c);
  assertPeriodWritable({ code, company_id: companyId }, scope);
  // the same days can never be paid twice to the same employees by two periods of the same kind
  const overlap = await c.env.DB.prepare(`SELECT code FROM payroll_periods WHERE kind = ?1 AND deleted_at IS NULL AND start_date <= ?2 AND end_date >= ?3 AND ${sameScope(4)} LIMIT 1`)
    .bind(kind, end, start, companyId)
    .first<{ code: string }>();
  if (overlap) throw conflict(`ช่วงวันที่ซ้อนกับงวด ${overlap.code} (ป้องกันการจ่ายซ้ำ)`);
  const user = currentUser(c);
  try {
    const row = await c.env.DB.prepare('INSERT INTO payroll_periods (code, name, start_date, end_date, pay_date, kind, company_id, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(code, name, start, end, pay, kind, companyId, user.id, user.id)
      .first<{ id: number }>();
    await audit(c, 'payroll.period_created', 'payroll_periods', row?.id ?? null, { code, kind, company: companyId });
    return c.json(await period(c.env.DB, row?.id ?? 0, scope), 201);
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) throw conflict('รหัสงวดซ้ำ');
    throw e;
  }
});

payrollRoutes.post('/periods/:id/calculate', requirePerm('payroll.calculate'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const { p, scope } = await writablePeriod(c, intParam(c.req.param('id')));
  if (p.status !== 'draft' && p.status !== 'calculated') throw conflict('คำนวณใหม่ได้เฉพาะงวดที่ยังไม่อนุมัติ');
  // payslips produced by the engine before migration 0005 (calc_version 0) are never replaced silently:
  // the new rules (proration, probation split, Feishu OT) can change the amounts, so HR must confirm explicitly
  if (p.legacy_slips > 0 && !(await legacyConfirmed(c))) {
    throw new HttpError(409, 'legacy_recalculation', `งวด ${p.code} มีสลิป ${p.legacy_slips} รายการที่คำนวณด้วยเวอร์ชันก่อนหน้า (Legacy) การคำนวณใหม่ใช้กติกาปัจจุบันและยอดอาจเปลี่ยน ต้องยืนยันการคำนวณใหม่อย่างชัดเจน`);
  }
  await assertCalculable(db, p);
  const forced = p.reopened_from ? await requireForce(c, p, 'period.force_recalculate') : null;
  const slips = await computePeriod(db, p);
  const version = p.calc_version + 1;
  // attendance review (P1): scanned before the payslips are written, so a hold resolved by this scan is not newer than
  // the calculation; holds never change the figures (approval is what they block)
  const holds: ScanResult | null = (await holdsEnabled(db, p)) ? await scanHolds(db, p, user.id) : null;

  // the period must still be the one that was read (not approved / recalculated meanwhile): otherwise nothing is written,
  // so a recalculation can never replace payslips that were approved, reviewed or signed off in the meantime
  const stmts = [
    guard(db, "EXISTS (SELECT 1 FROM payroll_periods WHERE id = ? AND status IN ('draft', 'calculated') AND calc_version = ? AND deleted_at IS NULL)", p.id, p.calc_version),
    ...archiveSlips(db, p.id, 'recalculate', user.id, crypto.randomUUID()), db.prepare('DELETE FROM payslips WHERE period_id = ?').bind(p.id),
  ];
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
  // holiday work paid by these slips is locked to the period (released by "reopen"); the check fails the whole batch
  // when a record changed between the calculation and this write, so a slip never pays an unlocked record
  const holidayIds = JSON.stringify(slips.flatMap((s) => s.holidayRecordIds));
  stmts.push(
    db.prepare('UPDATE holiday_work_records SET payroll_period_id = NULL, paid_calc_version = NULL WHERE payroll_period_id = ?').bind(p.id),
    db.prepare("UPDATE holiday_work_records SET payroll_period_id = ?1, paid_calc_version = ?2 WHERE status = 'approved' AND payroll_period_id IS NULL AND id IN (SELECT value FROM json_each(?3))").bind(p.id, version, holidayIds),
    db.prepare("SELECT CASE WHEN (SELECT COUNT(*) FROM holiday_work_records WHERE payroll_period_id = ?1) = json_array_length(?2) THEN 1 ELSE json('holiday work changed during calculation') END AS ok").bind(p.id, holidayIds),
  );
  stmts.push(db.prepare("UPDATE payroll_periods SET status = 'calculated', calc_version = ?, calculated_by = ?, calculated_at = datetime('now'), updated_at = datetime('now'), updated_by = ? WHERE id = ?").bind(version, user.id, user.id, p.id));
  // attendance used by the calculation is locked: re-import / rollback / OT changes need the period reopened first
  stmts.push(db.prepare("UPDATE attendance_imports SET locked = 1, locked_at = datetime('now') WHERE payroll_period_id = ? AND status = 'active' AND locked = 0").bind(p.id));
  // new figures: any ACC review / sign-off of the previous version no longer applies
  const superseded = await activeAccounting(db, p.id);
  stmts.push(...supersedeAccounting(db, p.id, user.id, `recalculated: version ${p.calc_version} → ${version}`));
  await runGuarded(db, stmts, 'งวดนี้ถูกอนุมัติหรือคำนวณใหม่ระหว่างดำเนินการ กรุณาโหลดใหม่');
  await audit(c, 'payroll.calculated', 'payroll_periods', p.id, { employees: slips.length, version, kind: p.kind, archivedSlips: p.employees, archivedTotalNet: p.total_net, ...(superseded ? { accountingSuperseded: superseded } : {}), ...(holds ? { attendanceHolds: holds } : {}), ...(p.legacy_slips ? { replacedLegacySlips: p.legacy_slips, legacyTotalNet: p.total_net } : {}), ...(forced ? { forced: true, reopenedFrom: p.reopened_from, reason: forced } : {}) });
  return c.json({ ...(await period(db, p.id, scope)), totalNet: round2(totalNet) });
});

/** calculated → draft: drops the unapproved payslips and unlocks the period's attendance for correction. */
payrollRoutes.post('/periods/:id/reopen', requirePerm('payroll.calculate'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const { p, scope } = await writablePeriod(c, intParam(c.req.param('id')));
  if (p.status !== 'calculated') throw conflict('เปิดแก้ไขได้เฉพาะงวดที่คำนวณแล้วแต่ยังไม่อนุมัติ');
  if (p.legacy_slips > 0 && !(await legacyConfirmed(c))) {
    throw new HttpError(409, 'legacy_recalculation', `งวด ${p.code} มีสลิป ${p.legacy_slips} รายการที่คำนวณด้วยเวอร์ชันก่อนหน้า (Legacy) การเปิดแก้ไขจะนำสลิปเหล่านี้ออกจากงวด (เก็บสำเนาไว้ในประวัติ) ต้องยืนยันอย่างชัดเจน`);
  }
  if (p.kind === 'mid_month') await assertCalculable(db, p);
  const forced = p.reopened_from ? await requireForce(c, p, 'period.force_reopen') : null;
  const superseded = await activeAccounting(db, p.id);
  await db.batch([
    ...archiveSlips(db, p.id, 'reopen', user.id, crypto.randomUUID()),
    db.prepare('DELETE FROM payslips WHERE period_id = ?').bind(p.id),
    db.prepare("UPDATE payroll_periods SET status = 'draft', updated_at = datetime('now'), updated_by = ? WHERE id = ?").bind(user.id, p.id),
    db.prepare('UPDATE attendance_imports SET locked = 0, locked_at = NULL WHERE payroll_period_id = ?').bind(p.id),
    db.prepare('UPDATE holiday_work_records SET payroll_period_id = NULL, paid_calc_version = NULL WHERE payroll_period_id = ?').bind(p.id),
    ...supersedeAccounting(db, p.id, user.id, `reopened to draft (version ${p.calc_version})`),
  ]);
  await audit(c, 'payroll.reopened', 'payroll_periods', p.id, { version: p.calc_version, archivedSlips: p.employees, archivedTotalNet: p.total_net, legacy: p.legacy_slips, ...(superseded ? { accountingSuperseded: superseded } : {}), ...(forced ? { forced: true, reopenedFrom: p.reopened_from, reason: forced } : {}) });
  return c.json(await period(db, p.id, scope));
});

payrollRoutes.post('/periods/:id/approve', requirePerm('payroll.approve'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const { p, scope } = await writablePeriod(c, intParam(c.req.param('id')));
  if (p.status !== 'calculated') throw conflict('อนุมัติได้เฉพาะงวดที่คำนวณแล้ว');
  if (!p.employees) throw conflict('งวดนี้ไม่มีสลิปเงินเดือน');
  // maker-checker always: the calculator never approves, except a Super Admin with a note. The old setting
  // payroll.require_separate_approver is no longer read — it can no longer switch this check off.
  const ap = checkMakerChecker(user, [p.calculated_by], approvalNote(await approvalBody(c)), 'ผู้อนุมัติต้องไม่ใช่ผู้คำนวณงวดเงินเดือน (Segregation of duties)');
  const pending = await pendingOt(db, p.id);
  if (pending) throw conflict(`มี OT จาก Feishu รอ HR ตรวจสอบ ${pending} รายการ ต้องยืนยันหรือปฏิเสธก่อนอนุมัติ`);
  if (p.kind === 'mid_month') await assertCalculable(db, p);
  // attendance review (P1): a fresh scan; any open hold refuses approval, and a hold resolved after the calculation
  // (the source data changed, e.g. a leave was approved) needs a recalculation first, since the pay may differ
  if (await holdsEnabled(db, p)) {
    const holds = await scanHolds(db, p, user.id);
    if (holds.open) {
      throw new HttpError(409, 'attendance_holds_open', `มีรายการเวลาทำงานรอ HR ตรวจสอบ (Attendance Hold) ${holds.open} รายการ ต้องแก้ไขข้อมูลต้นทางหรือ HR ยืนยันก่อนอนุมัติ`);
    }
    const changed = await db
      .prepare("SELECT COUNT(*) AS n FROM payroll_attendance_holds WHERE period_id = ? AND status = 'resolved' AND resolved_at > ?")
      .bind(p.id, p.calculated_at ?? '')
      .first<{ n: number }>();
    if (changed?.n) {
      throw new HttpError(409, 'attendance_changed_recalculate', `ข้อมูลเวลาทำงาน/การลาเปลี่ยนหลังการคำนวณครั้งล่าสุด (${changed.n} รายการ) ต้องคำนวณงวดใหม่ก่อนอนุมัติ`);
    }
  }
  // figures ACC returned cannot be approved again unchanged: HR reopens and recalculates (a new calc_version)
  const returned = 'EXISTS (SELECT 1 FROM payroll_accounting_reviews r WHERE r.period_id = payroll_periods.id AND r.calc_version = payroll_periods.calc_version AND r.status = \'returned\')';
  if (await db.prepare(`SELECT 1 FROM payroll_periods WHERE id = ? AND ${returned}`).bind(p.id).first()) {
    throw conflict(`ฝ่ายบัญชี (ACC Manager) ส่งงวด ${p.code} กลับให้ HR แก้ไข: ต้องเปิดแก้ไขและคำนวณใหม่ก่อนอนุมัติอีกครั้ง`);
  }
  // approval covers exactly the version the approver saw: a recalculation in between makes this a no-op (409)
  const done = await db.prepare(`UPDATE payroll_periods SET status = 'approved', reopened_from = NULL, approved_by = ?, approved_at = datetime('now'), updated_at = datetime('now'), updated_by = ? WHERE id = ? AND status = 'calculated' AND calc_version = ? AND deleted_at IS NULL AND NOT ${returned}`).bind(user.id, user.id, p.id, p.calc_version).run();
  if (!done.meta.changes) throw conflict('งวดนี้ถูกอนุมัติหรือเปลี่ยนสถานะไปแล้ว');
  const approved = await period(db, p.id, scope);
  await audit(c, 'payroll.approved', 'payroll_periods', p.id, {
    period_id: p.id, calculated_by: p.calculated_by, approved_by: user.id, approved_at: approved.approved_at, self_approved: ap.selfApproved, note: ap.note,
    ...(p.reopened_from ? { reopenedFrom: p.reopened_from } : {}),
  });
  return c.json(approved);
});

// ---- Accounting review / manager sign-off ----------------------------------------------------
// HR calculates → HR approves → ACC Staff reviews → ACC Manager signs off or returns to HR → publish.
// Every decision is tied to (period, calc_version). Recalculate / reopen / Super Admin reopen supersede the active
// review explicitly (event 'invalidated'), so a sign-off can never be reused for other figures. Calculator, HR
// approver, ACC reviewer and ACC signer must be four different people.
payrollRoutes.get('/accounting/periods', requirePerm('payroll.accounting.review'), async (c) => {
  const scope = await payrollScope(c);
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.code, p.name, p.company_id, p.status AS period_status, p.calc_version, p.approved_at,
       r.status AS accounting_status, r.staff_reviewed_by, r.staff_reviewed_at, r.staff_note,
       r.manager_signed_by, r.manager_signed_at, r.manager_note,
       (SELECT COUNT(*) FROM payslips s WHERE s.period_id = p.id AND ${scopeSql('s.company_id', scope)}) AS employees,
       (SELECT ROUND(COALESCE(SUM(s.net),0),2) FROM payslips s WHERE s.period_id = p.id AND ${scopeSql('s.company_id', scope)}) AS total_net
     FROM payroll_periods p
     LEFT JOIN payroll_accounting_reviews r ON r.period_id = p.id AND r.calc_version = p.calc_version
     WHERE p.deleted_at IS NULL AND p.status IN ('approved','published')
       AND (p.company_id IS NULL OR ${scopeSql('p.company_id', scope)})
     ORDER BY p.start_date DESC`,
  ).all<Record<string, unknown>>();
  return c.json(results);
});

payrollRoutes.get('/periods/:id/accounting-review', requirePerm('payroll.accounting.review'), async (c) => {
  const { p } = await writablePeriod(c, intParam(c.req.param('id')));
  const review = await c.env.DB.prepare('SELECT * FROM payroll_accounting_reviews WHERE period_id = ? AND calc_version = ?')
    .bind(p.id, p.calc_version).first();
  const { results: events } = await c.env.DB.prepare(
    `SELECT e.id, e.calc_version, e.action, e.note, e.created_at, u.username AS actor
     FROM payroll_accounting_review_events e JOIN users u ON u.id = e.actor_id
     WHERE e.period_id = ? ORDER BY e.id DESC LIMIT 100`,
  ).bind(p.id).all();
  return c.json({ period: p, review, events });
});

payrollRoutes.post('/periods/:id/accounting-review', requirePerm('payroll.accounting.review.submit'), async (c) => {
  const user = currentUser(c);
  const { p } = await writablePeriod(c, intParam(c.req.param('id')));
  if (p.status !== 'approved') throw conflict('ฝ่ายบัญชีตรวจสอบได้หลัง HR อนุมัติงวดแล้วเท่านั้น');
  if (!p.employees || p.calc_version < 1) throw conflict('งวดนี้ไม่มีข้อมูลคำนวณที่ใช้ตรวจสอบ');
  if (p.approved_by === user.id) throw forbidden('ผู้อนุมัติฝั่ง HR ต้องไม่ใช่ผู้ตรวจสอบ ACC Staff');
  if (p.calculated_by === user.id) throw forbidden('ผู้คำนวณเงินเดือนต้องไม่ใช่ผู้ตรวจสอบ ACC Staff');
  const body = await readJson(c);
  const note = str(body, 'note', { max: 1000 }) ?? null;
  const db = c.env.DB;
  const exists = await db.prepare('SELECT status FROM payroll_accounting_reviews WHERE period_id = ? AND calc_version = ?')
    .bind(p.id, p.calc_version).first<{ status: string }>();
  if (exists && exists.status !== 'superseded') throw conflict(exists.status === 'returned' ? 'งวดนี้ถูกส่งกลับแล้ว ต้องให้ HR คำนวณใหม่ก่อนตรวจซ้ำ' : 'งวดนี้มีผลตรวจสอบสำหรับ Calculation Version นี้แล้ว');
  // a superseded review of the same version (after a Super Admin reopen without recalculation) starts over; any
  // other existing review makes the guard fail the whole batch, so duplicate requests record one review only
  const op = crypto.randomUUID();
  await runGuarded(db, [
    db.prepare(
      `INSERT INTO payroll_accounting_reviews (period_id, calc_version, status, staff_reviewed_by, staff_note, op_token)
       SELECT ?1, ?2, 'reviewed', ?3, ?4, ?5 FROM payroll_periods WHERE id = ?1 AND status = 'approved' AND calc_version = ?2 AND deleted_at IS NULL
       ON CONFLICT (period_id, calc_version) DO UPDATE SET status = 'reviewed', staff_reviewed_by = excluded.staff_reviewed_by, staff_reviewed_at = datetime('now'),
         staff_note = excluded.staff_note, manager_signed_by = NULL, manager_signed_at = NULL, manager_note = NULL, updated_at = datetime('now'), op_token = excluded.op_token
       WHERE payroll_accounting_reviews.status = 'superseded'`,
    ).bind(p.id, p.calc_version, user.id, note, op),
    guard(db, 'EXISTS (SELECT 1 FROM payroll_accounting_reviews WHERE period_id = ? AND calc_version = ? AND op_token = ?)', p.id, p.calc_version, op),
    db.prepare(`INSERT INTO payroll_accounting_review_events (period_id, calc_version, action, actor_id, note)
      VALUES (?, ?, 'staff_reviewed', ?, ?)`).bind(p.id, p.calc_version, user.id, note),
  ], 'งวดนี้มีผลตรวจสอบสำหรับ Calculation Version นี้แล้ว หรือสถานะงวดเปลี่ยนไป กรุณาโหลดใหม่');
  await audit(c, 'payroll.accounting_reviewed', 'payroll_periods', p.id, { calc_version: p.calc_version, reviewer: user.id, note });
  return c.json({ ok: true, calc_version: p.calc_version, status: 'reviewed' }, 201);
});

payrollRoutes.post('/periods/:id/accounting-signoff', requirePerm('payroll.accounting.signoff'), async (c) => {
  const user = currentUser(c);
  const { p } = await writablePeriod(c, intParam(c.req.param('id')));
  if (p.status !== 'approved') throw conflict('ลงนามได้เฉพาะงวดที่ HR อนุมัติแล้ว');
  const body = await readJson(c);
  const decision = str(body, 'decision', { required: true, max: 20 });
  if (decision !== 'signed_off' && decision !== 'returned') throw badRequest('decision ต้องเป็น signed_off หรือ returned');
  const note = str(body, 'note', { required: decision === 'returned', max: 1000 }) ?? null;
  if (decision === 'returned' && (!note || note.trim().length < 5)) throw badRequest('กรุณาระบุเหตุผลส่งกลับอย่างน้อย 5 ตัวอักษร');
  const db = c.env.DB;
  const review = await db.prepare('SELECT status, staff_reviewed_by FROM payroll_accounting_reviews WHERE period_id = ? AND calc_version = ?')
    .bind(p.id, p.calc_version).first<{ status: string; staff_reviewed_by: number }>();
  if (!review || review.status !== 'reviewed') throw conflict('ต้องให้ ACC Staff ตรวจสอบก่อน ACC Manager ลงนาม');
  if (review.staff_reviewed_by === user.id) throw forbidden('ผู้ตรวจสอบ ACC Staff ต้องไม่ใช่ผู้ลงนาม ACC Manager');
  if (p.approved_by === user.id) throw forbidden('ผู้อนุมัติฝั่ง HR ต้องไม่ใช่ผู้ลงนาม ACC Manager');
  if (p.calculated_by === user.id) throw forbidden('ผู้คำนวณเงินเดือนต้องไม่ใช่ผู้ลงนาม ACC Manager');
  const status = decision;
  // one transaction: the decision (only from 'reviewed', claimed with a token so a duplicate request acts once),
  // the event, and for a return the period back to HR (approved → calculated, approval cleared) so HR can reopen
  // and recalculate; approve refuses the returned version until then. Any guard failing rolls everything back.
  const op = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [
    db.prepare(
      `UPDATE payroll_accounting_reviews SET status = ?, manager_signed_by = ?, manager_signed_at = datetime('now'), manager_note = ?, updated_at = datetime('now'), op_token = ?
       WHERE period_id = ? AND calc_version = ? AND status = 'reviewed'
         AND EXISTS (SELECT 1 FROM payroll_periods WHERE id = ? AND status = 'approved' AND calc_version = ? AND deleted_at IS NULL)`,
    ).bind(status, user.id, note, op, p.id, p.calc_version, p.id, p.calc_version),
    guard(db, 'EXISTS (SELECT 1 FROM payroll_accounting_reviews WHERE period_id = ? AND calc_version = ? AND op_token = ?)', p.id, p.calc_version, op),
    db.prepare('INSERT INTO payroll_accounting_review_events (period_id, calc_version, action, actor_id, note) VALUES (?, ?, ?, ?, ?)')
      .bind(p.id, p.calc_version, decision === 'signed_off' ? 'manager_signed_off' : 'returned', user.id, note),
  ];
  if (decision === 'returned') {
    stmts.push(
      db.prepare("UPDATE payroll_periods SET status = 'calculated', approved_by = NULL, approved_at = NULL, updated_at = datetime('now'), updated_by = ? WHERE id = ? AND status = 'approved' AND calc_version = ?")
        .bind(user.id, p.id, p.calc_version),
      guard(db, "(SELECT status FROM payroll_periods WHERE id = ?) = 'calculated'", p.id),
    );
  }
  await runGuarded(db, stmts, 'รายการตรวจสอบหรือสถานะงวดถูกเปลี่ยนแล้ว กรุณาโหลดใหม่');
  await audit(c, decision === 'signed_off' ? 'payroll.accounting_signed_off' : 'payroll.accounting_returned', 'payroll_periods', p.id, {
    calc_version: p.calc_version, manager: user.id, reviewer: review.staff_reviewed_by, calculated_by: p.calculated_by, approved_by: p.approved_by, note,
    ...(decision === 'returned' ? { periodStatus: { from: 'approved', to: 'calculated' } } : {}),
  });
  return c.json({ ok: true, calc_version: p.calc_version, status, period_status: decision === 'returned' ? 'calculated' : 'approved' });
});

// ---- Attendance holds (P1) ---------------------------------------------------------------------
// Open holds block HR approval; HR clears a hold with a reason (no deduction) or the source data is corrected and the
// next scan resolves it. Every list / change is limited to the companies in the user's scope.

interface HoldRow {
  id: number;
  period_id: number;
  employee_id: number;
  company_id: number;
  kind: HoldKind;
  work_date: string | null;
  source_json: string;
  status: 'open' | 'cleared' | 'resolved';
  first_detected_at: string;
  last_detected_at: string;
  resolved_at: string | null;
  decision_by: number | null;
  decision_at: string | null;
  decision_reason: string | null;
}

payrollRoutes.get('/periods/:id/attendance-holds', async (c) => {
  const db = c.env.DB;
  const scope = await payrollScope(c);
  const p = await period(db, intParam(c.req.param('id')), scope);
  const status = c.req.query('status');
  if (status && !['open', 'cleared', 'resolved'].includes(status)) throw badRequest('สถานะไม่ถูกต้อง');
  const { results } = await db
    .prepare(
      `SELECT h.*, e.emp_code, e.first_name || ' ' || e.last_name AS employee, (SELECT username FROM users u WHERE u.id = h.decision_by) AS decided_by
       FROM payroll_attendance_holds h JOIN employees e ON e.id = h.employee_id
       WHERE h.period_id = ?1 AND ${scopeSql('h.company_id', scope)} AND (?2 IS NULL OR h.status = ?2)
       ORDER BY e.emp_code, h.work_date, h.kind`,
    )
    .bind(p.id, status ?? null)
    .all<HoldRow & { emp_code: string; employee: string; decided_by: string | null }>();
  const { results: events } = results.length
    ? await db
        .prepare(
          `SELECT ev.id, ev.hold_id, ev.action, ev.reason, ev.created_at, (SELECT username FROM users u WHERE u.id = ev.actor_id) AS actor
           FROM payroll_attendance_hold_events ev JOIN payroll_attendance_holds h ON h.id = ev.hold_id
           WHERE ev.period_id = ? AND ${scopeSql('h.company_id', scope)} ORDER BY ev.id`,
        )
        .bind(p.id)
        .all<{ id: number; hold_id: number; action: string; reason: string | null; created_at: string; actor: string | null }>()
    : { results: [] };
  return c.json({
    period: { id: p.id, code: p.code, status: p.status, kind: p.kind },
    enabled: await holdsEnabled(db, p),
    holds: results.map(({ source_json, ...h }) => ({ ...h, label: HOLD_KIND_LABEL[h.kind], source: JSON.parse(source_json) as unknown, events: events.filter((ev) => ev.hold_id === h.id) })),
  });
});

payrollRoutes.post('/periods/:id/attendance-holds/scan', requirePerm('payroll.calculate'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const { p } = await writablePeriod(c, intParam(c.req.param('id')));
  if (!(await holdsEnabled(db, p))) throw new HttpError(409, 'attendance_review_disabled', 'งวดนี้ไม่อยู่ในการตรวจสอบเวลาทำงาน (เฉพาะงวดรายเดือนที่เริ่มตั้งแต่วันที่ตั้งค่า payroll.attendance_review_from)');
  if (p.status !== 'draft' && p.status !== 'calculated') throw conflict('ตรวจสอบเวลาทำงานได้เฉพาะงวดที่ยังไม่อนุมัติ');
  const result = await scanHolds(db, p, user.id);
  await audit(c, 'payroll.attendance_holds_scanned', 'payroll_periods', p.id, { ...result });
  return c.json(result);
});

payrollRoutes.post('/attendance-holds/:holdId/clear', requirePerm('payroll_hold.resolve'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const scope = await payrollScope(c);
  const holdId = intParam(c.req.param('holdId'), 'holdId');
  const hold = await db.prepare('SELECT * FROM payroll_attendance_holds WHERE id = ?').bind(holdId).first<HoldRow>();
  // a hold of a company outside the scope answers like a missing one
  if (!hold || !(scope.all || scope.ids.includes(hold.company_id))) throw notFound('ไม่พบรายการ Attendance Hold');
  const p = await period(db, hold.period_id, scope);
  if (p.status !== 'draft' && p.status !== 'calculated') throw conflict('งวดนี้อนุมัติแล้ว จึงเปลี่ยนผลการตรวจสอบเวลาทำงานไม่ได้');
  const body = await readJson(c);
  const reason = str(body, 'reason', { required: true, max: 500 }) as string;
  if (reason.trim().length < 5) throw badRequest('กรุณาระบุเหตุผลอย่างน้อย 5 ตัวอักษร');
  if (!(await clearHold(db, hold.id, user.id, reason.trim()))) throw conflict('รายการนี้ไม่ได้อยู่ในสถานะรอตรวจสอบแล้ว (อาจถูกยืนยันหรือแก้ไขไปแล้ว)');
  await audit(c, 'payroll.attendance_hold_cleared', 'payroll_attendance_holds', hold.id, {
    period_id: hold.period_id, employee_id: hold.employee_id, company_id: hold.company_id, kind: hold.kind, work_date: hold.work_date, reason: reason.trim(),
  });
  return c.json({ ok: true, id: hold.id, status: 'cleared' });
});

payrollRoutes.post('/periods/:id/publish', requirePerm('payroll.publish'), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const { p, scope } = await writablePeriod(c, intParam(c.req.param('id')));
  if (p.status !== 'approved') throw conflict('เผยแพร่ได้เฉพาะงวดที่อนุมัติแล้ว');
  const accounting = await db.prepare("SELECT status FROM payroll_accounting_reviews WHERE period_id = ? AND calc_version = ?").bind(p.id, p.calc_version).first<{ status: string }>();
  if (accounting?.status !== 'signed_off') throw conflict('ยังเผยแพร่ไม่ได้: ต้องผ่านการตรวจสอบ ACC Staff และลงนาม ACC Manager สำหรับ Calculation Version ปัจจุบันก่อน');
  const res = await db.batch([
    db.prepare(`UPDATE payroll_periods SET status = 'published', published_by = ?, published_at = datetime('now'), updated_at = datetime('now'), updated_by = ? WHERE id = ? AND status = 'approved' AND deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM payroll_accounting_reviews ar WHERE ar.period_id = payroll_periods.id AND ar.calc_version = payroll_periods.calc_version AND ar.status = 'signed_off')`).bind(user.id, user.id, p.id),
    db.prepare("UPDATE payslips SET published = 1 WHERE period_id = ? AND EXISTS (SELECT 1 FROM payroll_periods WHERE id = ? AND status = 'published')").bind(p.id, p.id),
  ]);
  if (!res[0]?.meta.changes) throw conflict('งวดนี้ถูกเผยแพร่หรือเปลี่ยนสถานะไปแล้ว');
  const { results } = await db
    // re-publishing after a Super Admin reopen does not notify again for a payslip that was already published
    // unchanged (same row and calc version archived as published); a recalculated payslip is announced
    .prepare(
      `SELECT s.id, e.user_id FROM payslips s JOIN employees e ON e.id = s.employee_id
       WHERE s.period_id = ?1 AND e.user_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM payslip_archive a WHERE a.period_id = ?1 AND a.payslip_id = s.id AND a.calc_version = s.calc_version
                         AND json_extract(a.row_json, '$.published') = 1)`,
    )
    .bind(p.id)
    .all<{ id: number; user_id: number }>();
  for (const r of results) await notify(db, r.user_id, 'สลิปเงินเดือนพร้อมแล้ว', p.name, `/my/payslips/${r.id}`);
  const published = await period(db, p.id, scope);
  await audit(c, 'payroll.published', 'payroll_periods', p.id, {
    period_id: p.id, calculated_by: p.calculated_by, approved_by: p.approved_by, published_by: user.id, published_at: published.published_at ?? null, notified: results.length,
  });
  return c.json(published);
});

// ---- Super Admin period management (reopen closed / edit / delete / restore / forced recalculation) ----------
// Backend-enforced: super_admin role + explicit permission + MFA enrolled (requirePeriodAdmin), a fresh single-use
// TOTP per action (verifyStepUp), a written reason, the period code typed for destructive actions, conditional
// updates so a duplicate request cannot act twice, payslips archived (with integrity check) before any change.

function reasonOf(body: Record<string, unknown>): string {
  const reason = str(body, 'reason', { required: true, max: 500 }) as string;
  if (reason.length < 5) throw badRequest('กรุณาระบุเหตุผลอย่างน้อย 5 ตัวอักษร');
  return reason;
}

function confirmCode(body: Record<string, unknown>, p: PeriodRow): void {
  if (body.confirm_code !== p.code) throw badRequest(`กรุณาพิมพ์รหัสงวด "${p.code}" ให้ตรงเพื่อยืนยัน`);
}

/** Recalculating / reverting a period that a Super Admin reopened after closing: Super Admin + reason + step-up MFA. */
async function requireForce(c: Context<AppEnv>, p: PeriodRow, action: string): Promise<string> {
  const user = currentUser(c);
  if (!isSuperAdmin(user.roles) || !can(user, PERIOD_ADMIN.forceRecalculate)) {
    throw forbidden(`งวด ${p.code} ถูก Super Admin เปิดหลังปิดงวด (เดิม: ${p.reopened_from}) การคำนวณใหม่หรือเปิดแก้ไขต้องทำโดย Super Admin จนกว่าจะอนุมัติอีกครั้ง`);
  }
  if (!user.mfaEnabled) throw new HttpError(403, 'mfa_enrollment_required', 'ต้องเปิดใช้ MFA ก่อนดำเนินการ');
  const body = await readJson(c);
  const reason = reasonOf(body);
  await verifyStepUp(c, body.totp, action, p.id);
  return reason;
}

/** Company of an archived payslip (the full row is kept in row_json). */
const ARCHIVE_COMPANY = "json_extract(row_json, '$.company_id')";

/**
 * What a period change would affect. `scope` limits every figure to the companies in scope; the blockers of the
 * change endpoints are always computed organisation-wide (ALL_SCOPE) so a rule is never weakened by filtering.
 */
async function periodImpact(db: D1Database, p: PeriodRow, scope: PayrollScope = ALL_SCOPE): Promise<PeriodImpact> {
  const slips = await db
    .prepare(`SELECT COUNT(*) AS count, ROUND(COALESCE(SUM(gross), 0), 2) AS gross, ROUND(COALESCE(SUM(net), 0), 2) AS net, COALESCE(SUM(published), 0) AS published, COALESCE(SUM(advance > 0), 0) AS withAdvance, ROUND(COALESCE(SUM(advance), 0), 2) AS advance FROM payslips WHERE period_id = ? AND ${scopeSql('company_id', scope)}`)
    .bind(p.id)
    .first<PeriodImpact['payslips']>();
  const arch = await db
    .prepare(`SELECT COUNT(*) AS count, COUNT(DISTINCT calc_version) AS versions, MAX(archived_at) AS lastArchivedAt, COALESCE(SUM(json_extract(row_json, '$.published') = 1), 0) AS published FROM payslip_archive WHERE period_id = ? AND ${scopeSql(ARCHIVE_COMPANY, scope)}`)
    .bind(p.id)
    .first<PeriodImpact['archive'] & { published: number }>();
  const att = await db
    .prepare(`SELECT COALESCE(SUM(status = 'active'), 0) AS active, COALESCE(SUM(status = 'active' AND locked = 1), 0) AS locked, COUNT(*) AS total FROM attendance_imports WHERE payroll_period_id = ? AND ${scopeSql('company_id', scope)}`)
    .bind(p.id)
    .first<PeriodImpact['attendance']>();
  const publishedEver = await db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE entity = 'payroll_periods' AND entity_id = ? AND action = 'payroll.published'").bind(String(p.id)).first<{ n: number }>();
  const everPublished = p.status === 'published' || (slips?.published ?? 0) > 0 || (arch?.published ?? 0) > 0 || (publishedEver?.n ?? 0) > 0;

  const dependencies: PeriodImpact['dependencies'] = [];
  if (p.kind === 'monthly') {
    for (const m of await advancePeriods(db, p)) {
      const paid = await db.prepare(`SELECT ROUND(COALESCE(SUM(net), 0), 2) AS n FROM payslips WHERE period_id = ? AND ${scopeSql('company_id', scope)}`).bind(m.id).first<{ n: number }>();
      dependencies.push({ id: m.id, code: m.code, kind: 'mid_month', status: m.status as PayrollPeriod['status'], relation: 'mid_month_round', advance: paid?.n ?? 0 });
    }
  } else {
    const m = await coveringMonthly(db, p);
    if (m) {
      const deducted = await db
        .prepare(`SELECT ROUND(COALESCE(SUM(advance), 0), 2) AS n FROM payslips WHERE period_id = ? AND employee_id IN (SELECT employee_id FROM payslips WHERE period_id = ?) AND ${scopeSql('company_id', scope)}`)
        .bind(m.id, p.id)
        .first<{ n: number }>();
      dependencies.push({ id: m.id, code: m.code, kind: 'monthly', status: m.status as PayrollPeriod['status'], relation: 'month_end', advance: deducted?.n ?? 0 });
    }
  }
  const monthEnd = dependencies.find((d) => d.relation === 'month_end' && d.status !== 'draft');
  const roundsInUse = dependencies.filter((d) => d.relation === 'mid_month_round' && d.status !== 'draft');
  const closed = p.status === 'approved' || p.status === 'published';
  const count = slips?.count ?? 0;

  const reopen: string[] = [];
  if (!closed) reopen.push('งวดนี้ยังไม่ปิด (ไม่ได้อยู่ในสถานะอนุมัติ/เผยแพร่) ใช้ "เปิดแก้ไข" ตามขั้นตอนปกติ');
  if (monthEnd) reopen.push(`งวดสิ้นเดือน ${monthEnd.code} (${monthEnd.status}) ใช้ยอดจ่ายกลางเดือนรอบนี้แล้ว ต้องเปิดงวดสิ้นเดือนกลับเป็นร่างก่อน (ป้องกันการหักซ้ำ/หักไม่ตรง)`);

  const del: string[] = [];
  if (p.status !== 'draft' || count > 0) del.push(`ลบได้เฉพาะงวดร่างที่ไม่มีสลิป (ตอนนี้: ${p.status}, สลิป ${count} รายการ) — เปิดงวด/เปิดแก้ไขก่อน ระบบจะเก็บสลิปไว้ใน Archive`);
  if (everPublished) del.push('งวดนี้เคยเผยแพร่สลิปให้พนักงานแล้ว เป็นหลักฐานการจ่ายเงิน จึงลบไม่ได้');
  if ((att?.active ?? 0) > 0) del.push(`มีข้อมูลเวลาทำงาน (Feishu) ที่ใช้งานอยู่ผูกกับงวดนี้ ${att?.active} ชุด ต้อง Rollback ก่อน`);
  if (roundsInUse.length) del.push(`มีรอบจ่ายกลางเดือน ${roundsInUse.map((d) => `${d.code} (${d.status})`).join(', ')} ที่ต้องหักคืนในงวดนี้`);

  const editCalculation: string[] = [];
  if (p.status !== 'draft' || count > 0) editCalculation.push('งวดมีสลิปแล้ว: แก้ได้เฉพาะชื่อและรหัสงวด การเปลี่ยนวันที่/วันจ่าย/บริษัทต้องเปิดงวดกลับเป็นร่าง (สลิปเก็บใน Archive) แล้วคำนวณใหม่แยกต่างหาก');
  if ((att?.active ?? 0) > 0) editCalculation.push(`มีข้อมูลเวลาทำงานผูกกับงวดนี้ ${att?.active} ชุด`);
  if (roundsInUse.length) editCalculation.push(`มีรอบจ่ายกลางเดือน ${roundsInUse.map((d) => d.code).join(', ')} ที่คำนวณ/อนุมัติแล้วอยู่ในช่วงงวดนี้`);
  if (monthEnd) editCalculation.push(`งวดสิ้นเดือน ${monthEnd.code} คำนวณแล้ว`);

  return {
    period: p,
    payslips: { count, gross: slips?.gross ?? 0, net: slips?.net ?? 0, published: slips?.published ?? 0, withAdvance: slips?.withAdvance ?? 0, advance: slips?.advance ?? 0 },
    archive: { count: arch?.count ?? 0, versions: arch?.versions ?? 0, lastArchivedAt: arch?.lastArchivedAt ?? null },
    attendance: { active: att?.active ?? 0, locked: att?.locked ?? 0, total: att?.total ?? 0 },
    approval: { status: p.status, calculatedAt: p.calculated_at, approvedAt: p.approved_at ?? null, publishedAt: p.published_at ?? null, everPublished },
    dependencies,
    blockers: { reopen, delete: del, editCalculation },
  };
}

// Only for a period the user may change as a whole: a company-limited user gets 403 on an all-company period (its
// figures cover every company) and 404 on another company's period; the figures are also filtered by scope.
payrollRoutes.get('/periods/:id/impact', requirePeriodAdmin(...Object.values(PERIOD_ADMIN)), async (c) => {
  const { p, scope } = await writablePeriod(c, intParam(c.req.param('id')));
  return c.json(await periodImpact(c.env.DB, p, scope));
});

/** approved / published → calculated: payslips archived and unpublished (kept), nothing recalculated or published. */
payrollRoutes.post('/periods/:id/reopen-closed', requirePeriodAdmin(PERIOD_ADMIN.reopen), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const { p, scope } = await writablePeriod(c, intParam(c.req.param('id')));
  const body = await readJson(c);
  const reason = reasonOf(body);
  confirmCode(body, p);
  const impact = await periodImpact(db, p);
  if (impact.blockers.reopen.length) throw conflict(impact.blockers.reopen.join(' · '));
  await verifyStepUp(c, body.totp, 'period.reopen', p.id);
  const op = crypto.randomUUID();
  const superseded = await activeAccounting(db, p.id);
  const res = await db.batch([
    db.prepare(
      `UPDATE payroll_periods SET status = 'calculated', reopened_from = status, op_token = ?, approved_by = NULL, approved_at = NULL, published_by = NULL, published_at = NULL,
         updated_at = datetime('now'), updated_by = ? WHERE id = ? AND status = ? AND deleted_at IS NULL`,
    ).bind(op, user.id, p.id, p.status),
    ...archiveSlips(db, p.id, 'reopen', user.id, op, true),
    db.prepare('UPDATE payslips SET published = 0 WHERE period_id = ? AND EXISTS (SELECT 1 FROM payroll_periods WHERE id = ? AND op_token = ?)').bind(p.id, p.id, op),
    // a closed period re-opened by a Super Admin needs a fresh HR approval and a fresh ACC review / sign-off
    ...supersedeAccounting(db, p.id, user.id, `Super Admin reopened a closed period: ${reason}`.slice(0, 1000), { sql: 'EXISTS (SELECT 1 FROM payroll_periods WHERE id = ? AND op_token = ?)', params: [p.id, op] }),
  ]);
  if (!res[0]?.meta.changes) throw conflict('งวดนี้ถูกเปิดหรือเปลี่ยนสถานะไปแล้ว (ป้องกันการทำซ้ำ)');
  await audit(c, 'payroll.period_reopened_closed', 'payroll_periods', p.id, {
    code: p.code, from: p.status, to: 'calculated', reason, archivedSlips: impact.payslips.count, archivedTotalNet: impact.payslips.net, unpublished: impact.payslips.published,
    approvedBy: p.approved_by, approvedAt: p.approved_at ?? null, publishedAt: p.published_at ?? null, calcVersion: p.calc_version, op,
    ...(superseded ? { accountingSuperseded: superseded } : {}),
  });
  return c.json(await period(db, p.id, scope));
});

/** Metadata (name, code) in any status; dates / pay date / company only on an empty draft without dependencies. */
payrollRoutes.put('/periods/:id', requirePeriodAdmin(PERIOD_ADMIN.edit), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const { p, scope } = await writablePeriod(c, intParam(c.req.param('id')));
  const body = await readJson(c);
  const reason = reasonOf(body);
  const next: Record<string, string | number | null> = {};
  const name = str(body, 'name', { max: 100 });
  if (name !== null && name !== p.name) next.name = name;
  const code = str(body, 'code', { max: 20 });
  if (code !== null && code !== p.code) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(code)) throw badRequest('รหัสงวดใช้ได้เฉพาะ A-Z a-z 0-9 _ -');
    next.code = code;
  }
  for (const k of ['start_date', 'end_date', 'pay_date'] as const) {
    const v = str(body, k);
    if (v === null) continue;
    if (!DATE_RE.test(v)) throw badRequest('รูปแบบวันที่ต้องเป็น YYYY-MM-DD');
    if (v !== p[k]) next[k] = v;
  }
  if ('company_id' in body) {
    const companyId = body.company_id === null || body.company_id === '' ? null : intParam(String(body.company_id), 'company_id');
    if (companyId !== p.company_id) {
      if (companyId !== null && !(await db.prepare('SELECT id FROM companies WHERE id = ? AND active = 1').bind(companyId).first())) throw badRequest('ไม่พบบริษัท หรือบริษัทปิดใช้งาน');
      assertPeriodWritable({ code: p.code, company_id: companyId }, scope);
      next.company_id = companyId;
    }
  }
  if (!Object.keys(next).length) throw badRequest('ไม่มีข้อมูลที่เปลี่ยนแปลง');
  const calcFields = Object.keys(next).filter((k) => k !== 'name' && k !== 'code');
  if (calcFields.length) {
    const impact = await periodImpact(db, p);
    if (impact.blockers.editCalculation.length) throw conflict(`แก้ ${calcFields.join(', ')} ไม่ได้: ${impact.blockers.editCalculation.join(' · ')}`);
    const start = (next.start_date as string | undefined) ?? p.start_date;
    const end = (next.end_date as string | undefined) ?? p.end_date;
    const pay = (next.pay_date as string | undefined) ?? p.pay_date;
    const companyId = 'company_id' in next ? (next.company_id as number | null) : p.company_id;
    if (start > end) throw badRequest('วันสิ้นสุดงวดต้องไม่ก่อนวันเริ่มงวด');
    if (p.kind === 'mid_month' && (pay < end || pay.slice(0, 7) !== end.slice(0, 7) || Number(pay.slice(8, 10)) > 15)) {
      throw badRequest('รอบจ่ายกลางเดือนต้องกำหนดวันจ่ายหลังวันสิ้นสุดรอบ และไม่เกินวันที่ 15 ของเดือนนั้น');
    }
    const overlap = await db
      .prepare(`SELECT code FROM payroll_periods WHERE id <> ?5 AND kind = ?1 AND deleted_at IS NULL AND start_date <= ?2 AND end_date >= ?3 AND ${sameScope(4)} LIMIT 1`)
      .bind(p.kind, end, start, companyId, p.id)
      .first<{ code: string }>();
    if (overlap) throw conflict(`ช่วงวันที่ซ้อนกับงวด ${overlap.code} (ป้องกันการจ่ายซ้ำ)`);
    // the new range must not pick up / drop paid mid-month rounds or fall under a calculated month-end
    const moved = await periodImpact(db, { ...p, start_date: start, end_date: end, company_id: companyId });
    if (moved.blockers.editCalculation.length) throw conflict(moved.blockers.editCalculation.join(' · '));
  }
  await verifyStepUp(c, body.totp, 'period.edit', p.id);
  const keys = Object.keys(next);
  try {
    const res = await db
      .prepare(`UPDATE payroll_periods SET ${keys.map((k) => `${k} = ?`).join(', ')}, op_token = ?, updated_at = datetime('now'), updated_by = ? WHERE id = ? AND updated_at = ? AND status = ? AND deleted_at IS NULL`)
      .bind(...keys.map((k) => next[k]), crypto.randomUUID(), user.id, p.id, p.updated_at, p.status)
      .run();
    if (!res.meta.changes) throw conflict('งวดนี้ถูกแก้ไขหรือเปลี่ยนสถานะไปแล้ว กรุณาโหลดใหม่');
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) throw conflict('รหัสงวดซ้ำ');
    throw e;
  }
  await audit(c, 'payroll.period_edited', 'payroll_periods', p.id, { code: p.code, status: p.status, reason, changes: Object.fromEntries(keys.map((k) => [k, { from: p[k as keyof PeriodRow] ?? null, to: next[k] }])) });
  return c.json(await period(db, p.id, scope));
});

/** Soft delete (recoverable): only an empty, never-published draft without attendance or advance dependencies. */
payrollRoutes.post('/periods/:id/delete', requirePeriodAdmin(PERIOD_ADMIN.delete), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const { p } = await writablePeriod(c, intParam(c.req.param('id')));
  const body = await readJson(c);
  const reason = reasonOf(body);
  confirmCode(body, p);
  const impact = await periodImpact(db, p);
  if (impact.blockers.delete.length) throw conflict(impact.blockers.delete.join(' · '));
  await verifyStepUp(c, body.totp, 'period.delete', p.id);
  const res = await db
    .prepare(
      `UPDATE payroll_periods SET deleted_at = datetime('now'), deleted_by = ?1, deleted_code = code, code = code || '~deleted~' || id, delete_reason = ?2, op_token = ?3,
         updated_at = datetime('now'), updated_by = ?1
       WHERE id = ?4 AND status = 'draft' AND deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM payslips WHERE period_id = ?4)
         AND NOT EXISTS (SELECT 1 FROM attendance_imports WHERE payroll_period_id = ?4 AND status = 'active')
         AND NOT EXISTS (SELECT 1 FROM payroll_periods m WHERE ?5 = 'monthly' AND m.kind = 'mid_month' AND m.deleted_at IS NULL AND m.status <> 'draft'
                         AND m.start_date >= ?6 AND m.end_date <= ?7 AND (m.company_id IS NULL OR ?8 IS NULL OR m.company_id = ?8))`,
    )
    .bind(user.id, reason, crypto.randomUUID(), p.id, p.kind, p.start_date, p.end_date, p.company_id)
    .run();
  if (!res.meta.changes) throw conflict('งวดนี้ถูกลบหรือเปลี่ยนสถานะไปแล้ว (ป้องกันการทำซ้ำ)');
  await audit(c, 'payroll.period_deleted', 'payroll_periods', p.id, {
    code: p.code, name: p.name, kind: p.kind, status: p.status, reason, softDelete: true, archive: impact.archive.count, attendanceImports: impact.attendance.total,
  });
  return c.json({ ok: true, id: p.id, code: p.code });
});

// A company-limited user sees deleted periods of companies in scope only: a deleted all-company period can only be
// restored organisation-wide, and its archive covers every company. Archive counts are filtered by scope as well.
payrollRoutes.get('/deleted-periods', requirePeriodAdmin(PERIOD_ADMIN.delete), async (c) => {
  const scope = await payrollScope(c);
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.deleted_code AS code, p.name, p.kind, (SELECT name FROM companies c WHERE c.id = p.company_id) AS company, p.start_date, p.end_date, p.pay_date,
       p.deleted_at, (SELECT username FROM users u WHERE u.id = p.deleted_by) AS deleted_by, p.delete_reason,
       (SELECT COUNT(*) FROM payslip_archive a WHERE a.period_id = p.id AND ${scopeSql(`json_extract(a.row_json, '$.company_id')`, scope)}) AS archived
     FROM payroll_periods p WHERE p.deleted_at IS NOT NULL AND ${scopeSql('p.company_id', scope)} ORDER BY p.deleted_at DESC`,
  ).all<DeletedPeriod>();
  return c.json(results);
});

payrollRoutes.post('/periods/:id/restore', requirePeriodAdmin(PERIOD_ADMIN.delete), async (c) => {
  const user = currentUser(c);
  const db = c.env.DB;
  const id = intParam(c.req.param('id'));
  const row = await db
    .prepare('SELECT id, deleted_code, kind, start_date, end_date, company_id FROM payroll_periods WHERE id = ? AND deleted_at IS NOT NULL')
    .bind(id)
    .first<{ id: number; deleted_code: string; kind: string; start_date: string; end_date: string; company_id: number | null }>();
  const scope = await payrollScope(c);
  if (!row || !periodVisible(row, scope)) throw notFound('ไม่พบงวดที่ถูกลบ');
  assertPeriodWritable({ code: row.deleted_code, company_id: row.company_id }, scope);
  const body = await readJson(c);
  const reason = reasonOf(body);
  if (await db.prepare('SELECT id FROM payroll_periods WHERE code = ?').bind(row.deleted_code).first()) throw conflict(`มีงวดรหัส ${row.deleted_code} อยู่แล้ว จึงกู้คืนไม่ได้`);
  const overlap = await db
    .prepare(`SELECT code FROM payroll_periods WHERE kind = ?1 AND deleted_at IS NULL AND start_date <= ?2 AND end_date >= ?3 AND ${sameScope(4)} LIMIT 1`)
    .bind(row.kind, row.end_date, row.start_date, row.company_id)
    .first<{ code: string }>();
  if (overlap) throw conflict(`ช่วงวันที่ซ้อนกับงวด ${overlap.code} จึงกู้คืนไม่ได้`);
  await verifyStepUp(c, body.totp, 'period.restore', id);
  const res = await db
    .prepare(
      `UPDATE payroll_periods SET code = deleted_code, deleted_at = NULL, deleted_by = NULL, deleted_code = NULL, delete_reason = NULL, op_token = ?,
         updated_at = datetime('now'), updated_by = ? WHERE id = ? AND deleted_at IS NOT NULL`,
    )
    .bind(crypto.randomUUID(), user.id, id)
    .run();
  if (!res.meta.changes) throw conflict('งวดนี้ถูกกู้คืนไปแล้ว');
  await audit(c, 'payroll.period_restored', 'payroll_periods', id, { code: row.deleted_code, reason });
  return c.json(await period(db, id, scope));
});

/** Company a payslip belongs to: the company that paid it (set since migration 0005), else the employee's company. */
const SLIP_COMPANY = 'COALESCE(s.company_id, e.company_id)';

payrollRoutes.get('/payslips', async (c) => {
  const db = c.env.DB;
  const scope = await payrollScope(c);
  const pid = c.req.query('period_id');
  const inScope = scopeSql(SLIP_COMPANY, scope);
  if (pid) await period(db, intParam(pid, 'period_id'), scope);
  const { results } = pid
    ? await db.prepare(`${SLIP_SELECT} WHERE s.period_id = ? AND p.deleted_at IS NULL AND ${inScope} ORDER BY e.emp_code`).bind(intParam(pid, 'period_id')).all<PayslipSummary>()
    : await db.prepare(`${SLIP_SELECT} WHERE p.deleted_at IS NULL AND ${inScope} ORDER BY p.start_date DESC, e.emp_code LIMIT 500`).all<PayslipSummary>();
  return c.json(results);
});

payrollRoutes.get('/periods/:id/export.csv', requirePerm('payroll.export'), async (c) => {
  const scope = await payrollScope(c);
  const p = await period(c.env.DB, intParam(c.req.param('id')), scope);
  // same company filter as the Payroll Preview: an optional ?company inside the scope, otherwise the whole scope
  const company = await payrollCompany(c);
  const { results } = await c.env.DB.prepare(
    `SELECT e.emp_code, e.first_name || ' ' || e.last_name AS name, e.bank_name, e.bank_account, s.base_salary, s.ot_amount, s.earnings, s.unpaid_leave, s.gross, s.sso, s.ewf_employee, s.tax, s.deductions, s.net, s.ewf_employer
     FROM payslips s JOIN employees e ON e.id = s.employee_id
     WHERE s.period_id = ?1 AND ${scopeSql(SLIP_COMPANY, scope)} AND (?2 IS NULL OR ${SLIP_COMPANY} = ?2) ORDER BY e.emp_code`,
  )
    .bind(p.id, company?.id ?? null)
    .all<Record<string, string | number | null>>();
  const head = ['รหัส', 'ชื่อ', 'ธนาคาร', 'เลขบัญชี', 'เงินเดือน', 'OT', 'เงินได้อื่น', 'หักลาไม่รับค่าจ้าง', 'รวมเงินได้', 'ประกันสังคม', 'กองทุนสงเคราะห์ลูกจ้าง (พนักงาน)', 'ภาษี', 'รวมหัก', 'สุทธิ', 'กองทุนสงเคราะห์ลูกจ้าง (นายจ้างสมทบ)'];
  const keys = ['emp_code', 'name', 'bank_name', 'bank_account', 'base_salary', 'ot_amount', 'earnings', 'unpaid_leave', 'gross', 'sso', 'ewf_employee', 'tax', 'deductions', 'net', 'ewf_employer'];
  await audit(c, 'payroll.exported', 'payroll_periods', p.id, { rows: results.length, company: company?.id ?? null, scope: scope.all ? 'all' : scope.ids });
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
  const holiday = (l: SlipLike['lines'][number]) => l.kind === 'earning' && (l.code === 'HOLIDAY_WORK' || l.code === 'HOLIDAY_OT');
  const earning = (l: SlipLike['lines'][number]) => l.kind === 'earning' && !l.code.startsWith('BASE') && l.code !== 'OT' && !holiday(l);
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
    holiday_pay: sum(holiday),
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
  const p = await period(db, intParam(c.req.param('id')), await payrollScope(c));
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
  // attendance review (P1): open holds of the companies shown block approval and export
  const { results: held } = await db
    .prepare(`SELECT kind, COUNT(*) AS n FROM payroll_attendance_holds WHERE period_id = ?1 AND status = 'open' AND (?2 IS NULL OR company_id = ?2) AND ${scopeSql('company_id', await payrollScope(c))} GROUP BY kind ORDER BY kind`)
    .bind(p.id, companyId)
    .all<{ kind: HoldKind; n: number }>();
  const heldTotal = held.reduce((a, x) => a + x.n, 0);
  if (heldTotal) {
    issues.push({ level: 'error', code: 'attendance_hold', message: `มีรายการเวลาทำงานรอ HR ตรวจสอบ (Attendance Hold): ${held.map((x) => `${HOLD_KIND_LABEL[x.kind]} ${x.n}`).join(' · ')} — ต้องตรวจสอบก่อนอนุมัติและ Export`, count: heldTotal });
  }
  if (source === 'snapshot') {
    const changed = active.filter((a) => !usedImports.has(a.id)).length + [...usedImports].filter((id) => !active.some((a) => a.id === id)).length;
    if (changed) issues.push({ level: 'error', code: 'attendance_changed', message: 'ข้อมูลเวลาทำงานถูกนำเข้าใหม่หรือย้อนกลับหลังการคำนวณ ต้องคำนวณงวดใหม่', count: changed });
  }
  const negative = rows.filter((r) => typeof r.net_pay === 'number' && r.net_pay < 0).length;
  if (negative) issues.push({ level: 'error', code: 'net_negative', message: 'มีพนักงานที่เงินได้สุทธิติดลบ', count: negative });
  if (source === 'snapshot' && p.legacy_slips > 0) issues.push({ level: 'warning', code: 'legacy', message: 'สลิปงวดนี้คำนวณด้วยเวอร์ชันก่อนหน้า (Legacy, ก่อน Migration 0005) จึงไม่มีข้อมูลเวลาทำงาน/สถานะทดลองงานใน Preview ยอดเงินคงเดิมจนกว่าจะยืนยันคำนวณใหม่', count: p.legacy_slips });
  if (missingBank) issues.push({ level: 'warning', code: 'no_bank_account', message: 'พนักงานไม่มีเลขบัญชีธนาคาร', count: missingBank });
  if (!active.length) issues.push({ level: 'warning', code: 'no_attendance', message: 'ยังไม่มีข้อมูลเวลาทำงานจาก Feishu สำหรับงวดนี้: ใช้คำขอ OT / การลาที่อนุมัติในระบบแทน', count: 1 });
  if (p.kind === 'monthly') {
    const { results: mids } = await db.prepare(`SELECT code, status FROM payroll_periods WHERE kind = 'mid_month' AND deleted_at IS NULL AND start_date >= ?1 AND end_date <= ?2 AND ${sameScope(3)}`).bind(p.start_date, p.end_date, p.company_id).all<{ code: string; status: string }>();
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

/**
 * `onlyCompanies`: payroll staff limited to some companies see the YTD of those companies only (a transferred
 * employee's pay at another company is outside their scope). null = every company (organisation-wide staff, or the
 * employee viewing their own payslip).
 */
async function payslipYtd(db: D1Database, slip: { id: number; employee_id: number; period_id: number; pay_date: string; published: number; company_id: number | null }, onlyCompanies: number[] | null): Promise<PayslipYtd> {
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
    .all<YtdTotals & { company_id: number | null; company: string | null }>()
    .then((r) => (onlyCompanies ? { results: r.results.filter((x) => x.company_id !== null && onlyCompanies.includes(x.company_id)) } : r));
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
            (SELECT title FROM positions x WHERE x.id = e.position_id) AS position,
            COALESCE(s.company_id, e.company_id) AS slip_company
     FROM payslips s JOIN payroll_periods p ON p.id = s.period_id JOIN employees e ON e.id = s.employee_id WHERE s.id = ? AND p.deleted_at IS NULL`,
  )
    .bind(id)
    .first<Omit<PayslipDetail, 'lines' | 'ewf_employer' | 'ewf_employer_rate' | 'calc' | 'ytd'> & { lines_json: string; calc_json: string | null; ewf_employer: number; ewf_employer_rate: number | null; period_id: number; company_id: number | null; calc_version: number; slip_company: number | null }>();
  if (!row) throw notFound('ไม่พบสลิปเงินเดือน');
  const own = user.employeeId !== null && row.employee_id === user.employeeId && row.published === 1 && can(user, 'payslip.own');
  // payroll staff only reach payslips of companies in their scope; any other id answers 404 like a missing one
  const scope = can(user, 'payroll.view') ? await companyScope(c.env.DB, user) : null;
  const staffScope = scope && (scope.scope === 'all' ? 'all' : scope.items.map((x) => x.id));
  const staff = staffScope === 'all' || (Array.isArray(staffScope) && row.slip_company !== null && staffScope.includes(row.slip_company));
  if (!own && !staff) throw notFound('ไม่พบสลิปเงินเดือน');
  const { lines_json, calc_json, ewf_employer, ewf_employer_rate, slip_company: _company, ...rest } = row;
  // the employer contribution is company cost: only payroll staff see it, the employee's own view does not
  await audit(c, 'payslip.viewed', 'payslips', id, { own: !!own });
  const employer = staff ? { ewf_employer, ewf_employer_rate } : {};
  const calc = calc_json ? (JSON.parse(calc_json) as PayslipCalc) : null;
  const ytdScope = staff && Array.isArray(staffScope) && !own ? staffScope : null;
  const ytd = can(user, 'payslip_ytd.view') ? { ytd: await payslipYtd(c.env.DB, row, ytdScope) } : {};
  return c.json<PayslipDetail>({ ...rest, ...employer, ...ytd, calc, lines: JSON.parse(lines_json) as PayslipDetail['lines'] });
});


