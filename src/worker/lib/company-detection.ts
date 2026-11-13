// Company detection in D1 (P3): loads prefix mappings and company assignments for the pure rules of
// shared/company-detection.ts, and the payroll company gate (calculation, approval, Preview). Nothing here changes
// money or which company an employee belongs to.
import {
  PAYROLL_COMPANY_LABEL, matchMapping, payrollCompanyCheck,
  type CodeMapping, type CompanyAssignment, type PayrollCompanyError, type PayrollCompanyReason,
} from '../../shared/company-detection';
import { HttpError } from './http';
import { selectedIdsOrNull } from './payroll-selection';

export async function loadMappings(db: D1Database): Promise<CodeMapping[]> {
  const { results } = await db.prepare('SELECT id, company_id, prefix, priority, status, effective_from, effective_to FROM company_code_mappings ORDER BY id').all<CodeMapping>();
  return results;
}

export async function loadAssignments(db: D1Database, employeeIds: readonly number[]): Promise<CompanyAssignment[]> {
  if (!employeeIds.length) return [];
  const { results } = await db
    .prepare('SELECT id, employee_id, company_id, effective_from, effective_to, status, source FROM employee_company_assignments WHERE employee_id IN (SELECT value FROM json_each(?1)) ORDER BY employee_id, effective_from, id')
    .bind(JSON.stringify([...new Set(employeeIds)]))
    .all<CompanyAssignment>();
  return results;
}

export interface CompanyPeriod {
  id: number;
  start_date: string;
  end_date: string;
  company_id: number | null;
  status: string;
}

export interface PayrollCompanyIssue {
  employee_id: number;
  emp_code: string;
  /** the employee record's company (for scoping what is shown) */
  company_id: number;
  error: PayrollCompanyError;
  reason: PayrollCompanyReason;
}

interface Emp {
  id: number;
  emp_code: string;
  company_id: number;
  hire_date: string;
  termination_date: string | null;
}

/**
 * Employees a period would pay (the selection of computePeriod), employees who belonged to the period's company for
 * part of the period (moved out: they must not silently drop out of it), and — `payslips` — the employees of its
 * payslips: each must belong to one verified company, the period's, for every paid day; a payslip must still belong
 * to the company that owns it. A calculation replaces its payslips, so it checks without them.
 */
export async function payrollCompanyIssues(db: D1Database, p: CompanyPeriod, payslips = p.status !== 'draft'): Promise<PayrollCompanyIssue[]> {
  const chosen = await selectedIdsOrNull(db, p);
  const { results: selected } = chosen
    ? await db.prepare('SELECT e.id, e.emp_code, e.company_id, e.hire_date, e.termination_date FROM employees e WHERE e.id IN (SELECT value FROM json_each(?1)) ORDER BY e.emp_code').bind(JSON.stringify(chosen)).all<Emp>()
    : await db
    .prepare(
      `SELECT e.id, e.emp_code, e.company_id, e.hire_date, e.termination_date FROM employees e
       WHERE e.hire_date <= ?1 AND e.base_salary IS NOT NULL AND e.base_salary > 0
         AND (e.status IN ('active', 'probation') OR (e.status IN ('resigned', 'terminated') AND e.termination_date IS NOT NULL AND e.termination_date >= ?2))
         AND (?3 IS NULL OR e.company_id = ?3 OR EXISTS (
           SELECT 1 FROM employee_company_assignments a WHERE a.employee_id = e.id AND a.company_id = ?3 AND a.status <> 'cancelled'
             AND a.effective_from <= ?1 AND (a.effective_to IS NULL OR a.effective_to >= ?2)))
       ORDER BY e.emp_code`,
    )
    .bind(p.end_date, p.start_date, p.company_id)
    .all<Emp>();
  const { results: slips } = !payslips
    ? { results: [] as Array<Emp & { slip_company: number | null }> }
    : await db
        .prepare('SELECT e.id, e.emp_code, e.company_id, e.hire_date, e.termination_date, s.company_id AS slip_company FROM payslips s JOIN employees e ON e.id = s.employee_id WHERE s.period_id = ? ORDER BY e.emp_code')
        .bind(p.id)
        .all<Emp & { slip_company: number | null }>();
  const assignments = await loadAssignments(db, [...selected.map((e) => e.id), ...slips.map((e) => e.id)]);
  const out = new Map<number, PayrollCompanyIssue>();
  const range = (e: Emp): [string, string] | null => {
    const from = e.hire_date > p.start_date ? e.hire_date : p.start_date;
    const to = e.termination_date && e.termination_date < p.end_date ? e.termination_date : p.end_date;
    return from <= to ? [from, to] : null;
  };
  for (const e of selected) {
    const r = range(e);
    if (!r) continue;
    const check = payrollCompanyCheck(p, e, r[0], r[1], assignments);
    // belonged to the period's company for these days but has moved on since: the engine pays by the current company,
    // so this period cannot pay them any more (said plainly instead of "record differs")
    const reason = check.reason === 'record_differs' && p.company_id !== null && check.companyId === p.company_id ? 'moved_out' : check.reason;
    if (!check.ok) out.set(e.id, { employee_id: e.id, emp_code: e.emp_code, company_id: e.company_id, error: check.error!, reason: reason! });
  }
  for (const e of slips) {
    if (out.has(e.id)) continue;
    const r = range(e) ?? [p.start_date, p.end_date];
    const check = payrollCompanyCheck({ company_id: null }, e, r[0], r[1], assignments);
    if (!check.ok) out.set(e.id, { employee_id: e.id, emp_code: e.emp_code, company_id: e.company_id, error: check.error!, reason: check.reason! });
    else if (e.slip_company !== null && check.companyId !== e.slip_company) out.set(e.id, { employee_id: e.id, emp_code: e.emp_code, company_id: e.company_id, error: 'company_conflict', reason: 'payslip_company_differs' });
  }
  return [...out.values()].sort((a, b) => a.emp_code.localeCompare(b.emp_code));
}

/** The error code that sums up the issues (conflict before a transfer before unresolved). */
export function issueCode(issues: readonly PayrollCompanyIssue[]): PayrollCompanyError {
  if (issues.some((i) => i.error === 'company_conflict')) return 'company_conflict';
  if (issues.some((i) => i.error === 'company_transfer_in_period')) return 'company_transfer_in_period';
  return 'company_unresolved';
}

export function issueMessage(issues: readonly PayrollCompanyIssue[]): string {
  const byReason = new Map<PayrollCompanyReason, number>();
  for (const i of issues) byReason.set(i.reason, (byReason.get(i.reason) ?? 0) + 1);
  return `พนักงาน ${issues.length} คนยังไม่มีบริษัทที่ยืนยันแล้วตรงกับงวดนี้: ${[...byReason].map(([r, n]) => `${PAYROLL_COMPANY_LABEL[r]} ${n} คน`).join(' · ')}`;
}

/** Refuses (409) a calculation / approval while any paid employee's company is unresolved, in conflict or moved. */
export async function assertPayrollCompanies(db: D1Database, p: CompanyPeriod, payslips = p.status !== 'draft'): Promise<void> {
  const issues = await payrollCompanyIssues(db, p, payslips);
  if (!issues.length) return;
  throw new HttpError(409, issueCode(issues), issueMessage(issues), {
    employees: issues.slice(0, 50).map((i) => ({ emp_code: i.emp_code, error: i.error, reason: i.reason })),
    total: issues.length,
  });
}

/**
 * A new employee's first assignment is the company HR entered. When the prefix mappings point elsewhere (or conflict)
 * on the hire date, it is held for review (pending_review): payroll does not pay the employee until HR verifies the
 * company or moves them. Without a matching mapping the entered company stands (HR chose it; nothing is guessed).
 */
export async function holdIfMappingDiffers(db: D1Database, employeeId: number, actorId: number): Promise<{ held: boolean; mappingCompanyId: number | null }> {
  const e = await db.prepare('SELECT id, emp_code, company_id, hire_date FROM employees WHERE id = ?').bind(employeeId).first<{ id: number; emp_code: string; company_id: number; hire_date: string }>();
  if (!e) return { held: false, mappingCompanyId: null };
  const m = matchMapping(e.emp_code, e.hire_date, await loadMappings(db));
  const mappingCompanyId = m.winner?.company_id ?? null;
  if (!m.conflict.length && (mappingCompanyId === null || mappingCompanyId === e.company_id)) return { held: false, mappingCompanyId };
  const op = crypto.randomUUID();
  const reason = m.conflict.length ? 'รหัสพนักงานตรงกับการจับคู่ของหลายบริษัท' : 'บริษัทที่ระบุไม่ตรงกับการจับคู่รหัสพนักงาน';
  await db.batch([
    db.prepare("UPDATE employee_company_assignments SET status = 'pending_review', op_token = ?1, updated_at = datetime('now'), updated_by = ?2 WHERE employee_id = ?3 AND source = 'employee_record' AND status = 'verified'").bind(op, actorId, e.id),
    db.prepare(
      `INSERT INTO employee_company_assignment_history (assignment_id, employee_id, action, before_json, after_json, reason, actor_id, op_token)
       SELECT id, employee_id, 'held', '{"status":"verified"}', json_object('company_id', company_id, 'effective_from', effective_from, 'effective_to', effective_to, 'status', status, 'source', source, 'mapping_company_id', ?1), ?2, ?3, ?4
       FROM employee_company_assignments WHERE employee_id = ?5 AND op_token = ?4`,
    ).bind(mappingCompanyId, reason, actorId, op, e.id),
  ]);
  return { held: true, mappingCompanyId };
}
